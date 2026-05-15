package com.yourorg.imagegallerypreview.service

import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VfsUtil
import com.intellij.openapi.vfs.VirtualFileManager
import com.intellij.openapi.vfs.newvfs.BulkFileListener
import com.intellij.openapi.vfs.newvfs.events.VFileContentChangeEvent
import com.intellij.openapi.vfs.newvfs.events.VFileCreateEvent
import com.intellij.openapi.vfs.newvfs.events.VFileDeleteEvent
import com.yourorg.imagegallerypreview.metadata.MediaMetadataExtractor
import com.yourorg.imagegallerypreview.model.GalleryAssetItem
import com.yourorg.imagegallerypreview.scanner.ProjectAssetScanner
import com.yourorg.imagegallerypreview.util.AssetFileUtil
import java.io.File
import java.util.Locale
import java.util.concurrent.Callable
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.ExecutorCompletionService
import java.util.concurrent.Executors
import java.util.concurrent.Future
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

@Service(Service.Level.PROJECT)
class GalleryIndexService(private val project: Project) : Disposable {

    enum class IndexState {
        IDLE,
        INDEXING,
        SUCCESS,
        FAILED
    }

    data class IndexStatus(
        val state: IndexState,
        val message: String,
        val phase: String = "idle",
        val indexedCount: Int = 0,
        val metadataCount: Int = 0,
        val currentPath: String? = null,
        val fallbackSource: String? = null,
        val elapsedMillis: Long = 0L,
        val workerStatus: String? = null,
        val diagnostic: String? = null,
        val timestampMillis: Long = System.currentTimeMillis(),
        val error: Throwable? = null
    )

    private val scanner = ProjectAssetScanner(project)
    private val listeners = CopyOnWriteArrayList<(List<GalleryAssetItem>) -> Unit>()
    private val statusListeners = CopyOnWriteArrayList<(IndexStatus) -> Unit>()

    @Volatile
    private var cache: List<GalleryAssetItem> = emptyList()

    @Volatile
    private var duplicateIndex: Map<String, Map<String, List<GalleryAssetItem>>> = emptyMap()

    @Volatile
    private var lastStatus: IndexStatus = IndexStatus(IndexState.IDLE, "Idle")

    private val refreshRunning = AtomicBoolean(false)
    private val refreshPending = AtomicBoolean(false)
    private val refreshPendingForce = AtomicBoolean(false)

    init {
        val connection = project.messageBus.connect(this)
        connection.subscribe(VirtualFileManager.VFS_CHANGES, object : BulkFileListener {
            override fun after(events: List<com.intellij.openapi.vfs.newvfs.events.VFileEvent>) {
                val relevant = events.any { event ->
                    (event is VFileCreateEvent || event is VFileDeleteEvent || event is VFileContentChangeEvent) &&
                        isInterestingPath(event.path)
                }

                if (!relevant) return

                syncAsync()
            }
        })
    }

    fun currentItems(): List<GalleryAssetItem> = cache

    fun currentStatus(): IndexStatus = lastStatus

    fun addListener(listener: (List<GalleryAssetItem>) -> Unit) {
        listeners += listener
        listener(cache)
    }

    fun removeListener(listener: (List<GalleryAssetItem>) -> Unit) {
        listeners -= listener
    }

    fun addStatusListener(listener: (IndexStatus) -> Unit) {
        statusListeners += listener
        listener(lastStatus)
    }

    fun removeStatusListener(listener: (IndexStatus) -> Unit) {
        statusListeners -= listener
    }

    fun syncAsync(afterRefresh: (() -> Unit)? = null) {
        startRefresh(forceReindex = false, afterRefresh = afterRefresh)
    }

    fun refreshAsync(forceReindex: Boolean = true, afterRefresh: (() -> Unit)? = null) {
        startRefresh(forceReindex = forceReindex, afterRefresh = afterRefresh)
    }

    private fun startRefresh(forceReindex: Boolean, afterRefresh: (() -> Unit)? = null) {
        if (!refreshRunning.compareAndSet(false, true)) {
            refreshPending.set(true)
            if (forceReindex) refreshPendingForce.set(true)
            return
        }
        runRefresh(forceReindex, listOfNotNull(afterRefresh))
    }

    override fun dispose() {
        listeners.clear()
        statusListeners.clear()
    }

    private fun runRefresh(forceReindex: Boolean, afterRefreshCallbacks: List<() -> Unit>) {
        publishStatus(
            IndexStatus(
                state = IndexState.INDEXING,
                message = if (forceReindex) "Reindexing assets..." else "Discovering assets...",
                phase = "discovering",
                workerStatus = if (forceReindex) "forced_refresh" else "sync"
            )
        )

        ApplicationManager.getApplication().executeOnPooledThread {
            val started = System.currentTimeMillis()
            val callbackQueue = afterRefreshCallbacks.toMutableList()

            try {
                if (forceReindex) {
                    MediaMetadataExtractor.clearCache()
                }
                val previousItems = cache
                val discoveredItems = scanner.scan()
                val items = enrichItems(discoveredItems, forceReindex, started)
                val duplicateAlerts = duplicateAlertsFor(previousItems, items)
                cache = items
                duplicateIndex = buildDuplicateIndex(items)

                publishItems(items)
                val elapsed = System.currentTimeMillis() - started
                publishStatus(
                    IndexStatus(
                        state = IndexState.SUCCESS,
                        message = "Updated at ${timestampLabel()} (${items.size} items, ${elapsed}ms)",
                        phase = "complete",
                        indexedCount = items.size,
                        metadataCount = items.size,
                        elapsedMillis = elapsed,
                        workerStatus = "complete"
                    )
                )
                callbackQueue.forEach { invokeOnEdt(it) }
                duplicateAlerts.forEach { alert ->
                    invokeOnEdt {
                        showDuplicateDialogAndHandle(File(alert.newItem.absPath), alert.newItem.platform, alert.duplicates)
                    }
                }
            } catch (error: Throwable) {
                publishStatus(
                    IndexStatus(
                        state = IndexState.FAILED,
                        message = "Failed: ${error.message ?: error.javaClass.simpleName}",
                        phase = "failed",
                        elapsedMillis = System.currentTimeMillis() - started,
                        workerStatus = "failed",
                        diagnostic = error.javaClass.simpleName,
                        error = error
                    )
                )
            } finally {
                refreshRunning.set(false)
                if (refreshPending.compareAndSet(true, false)) {
                    if (refreshRunning.compareAndSet(false, true)) {
                        val pendingForce = refreshPendingForce.getAndSet(false)
                        runRefresh(pendingForce, emptyList())
                    }
                }
            }
        }
    }

    private fun publishItems(items: List<GalleryAssetItem>) {
        listeners.forEach { listener ->
            invokeOnEdt {
                listener(items)
            }
        }
    }

    private fun enrichItems(
        items: List<GalleryAssetItem>,
        forceReindex: Boolean,
        startedMillis: Long
    ): List<GalleryAssetItem> {
        if (items.isEmpty()) {
            publishStatus(
                IndexStatus(
                    state = IndexState.SUCCESS,
                    message = "Updated at ${timestampLabel()} (0 items)",
                    phase = "complete",
                    elapsedMillis = System.currentTimeMillis() - startedMillis,
                    workerStatus = "complete"
                )
            )
            return emptyList()
        }

        publishStatus(
            IndexStatus(
                state = IndexState.INDEXING,
                message = "Resolving metadata...",
                phase = "resolving_metadata",
                indexedCount = items.size,
                metadataCount = 0,
                elapsedMillis = System.currentTimeMillis() - startedMillis,
                workerStatus = "metadata_parallel_$MAX_METADATA_PARALLELISM"
            )
        )

        val executor = Executors.newFixedThreadPool(minOf(MAX_METADATA_PARALLELISM, items.size))
        val completion = ExecutorCompletionService<Pair<Int, GalleryAssetItem>>(executor)
        val ordered = arrayOfNulls<GalleryAssetItem>(items.size)
        val pending = mutableMapOf<Future<Pair<Int, GalleryAssetItem>>, Pair<Int, Long>>()

        try {
            items.forEachIndexed { index, item ->
                val future = completion.submit(Callable {
                    index to enrichItem(item, forceReindex)
                })
                pending[future] = index to System.currentTimeMillis()
            }

            var processed = 0
            while (pending.isNotEmpty()) {
                val completed = completion.poll(500, TimeUnit.MILLISECONDS)
                if (completed != null) {
                    val fallbackIndex = pending.remove(completed)?.first ?: continue
                    val (index, item) = try {
                        completed.get()
                    } catch (error: Throwable) {
                        fallbackIndex to timeoutFallbackItem(items[fallbackIndex], "metadata extraction failed: ${error.javaClass.simpleName}")
                    }
                    ordered[index] = item
                    processed += 1
                    publishMetadataProgress(items, item, processed, startedMillis)
                    continue
                }

                val now = System.currentTimeMillis()
                val timedOut = pending.filterValues { (_, submittedAt) ->
                    now - submittedAt >= METADATA_ITEM_TIMEOUT_MS
                }
                for ((future, value) in timedOut) {
                    val index = value.first
                    if (pending.remove(future) == null) continue
                    future.cancel(true)
                    val item = timeoutFallbackItem(items[index], "timed out after ${METADATA_ITEM_TIMEOUT_MS / 1000}s")
                    ordered[index] = item
                    processed += 1
                    publishMetadataProgress(items, item, processed, startedMillis)
                }
            }
        } finally {
            executor.shutdownNow()
        }

        return ordered.map { it ?: error("Missing enriched metadata result") }
    }

    private fun enrichItem(item: GalleryAssetItem, forceReindex: Boolean): GalleryAssetItem {
        val metadata = MediaMetadataExtractor.extractFor(item, force = forceReindex)
        return item.copy(
            durationMillis = metadata.durationMillis ?: item.durationMillis,
            imageInfo = metadata.imageInfo ?: item.imageInfo,
            mediaInfo = metadata.info
        )
    }

    private fun timeoutFallbackItem(item: GalleryAssetItem, reason: String): GalleryAssetItem {
        val metadata = MediaMetadataExtractor.timeoutFallbackFor(item, reason)
        return item.copy(
            durationMillis = metadata.durationMillis ?: item.durationMillis,
            imageInfo = metadata.imageInfo ?: item.imageInfo,
            mediaInfo = metadata.info
        )
    }

    private fun publishMetadataProgress(
        allItems: List<GalleryAssetItem>,
        item: GalleryAssetItem,
        processed: Int,
        startedMillis: Long
    ) {
        val failureReason = MediaMetadataExtractor.failureReason(item.mediaInfo)
        val fallbackSource = item.mediaInfo?.source?.takeIf { source ->
            failureReason != null || !source.contains("MediaInfo", ignoreCase = true)
        }
        val diagnostic = when {
            failureReason != null -> "MediaInfo $failureReason; click i or Refresh Info to retry."
            fallbackSource != null -> "MediaInfo unavailable; used $fallbackSource"
            else -> null
        }

        if (processed == 1 || processed == allItems.size || processed % 10 == 0 || diagnostic != null) {
            publishStatus(
                IndexStatus(
                    state = IndexState.INDEXING,
                    message = "Resolving metadata...",
                    phase = "resolving_metadata",
                    indexedCount = allItems.size,
                    metadataCount = processed,
                    currentPath = AssetFileUtil.normalizePath(item.absPath),
                    fallbackSource = fallbackSource,
                    elapsedMillis = System.currentTimeMillis() - startedMillis,
                    workerStatus = "metadata_parallel_$MAX_METADATA_PARALLELISM",
                    diagnostic = diagnostic
                )
            )
        }
    }

    private fun publishStatus(status: IndexStatus) {
        lastStatus = status
        statusListeners.forEach { listener ->
            invokeOnEdt {
                listener(status)
            }
        }
    }

    private fun invokeOnEdt(block: () -> Unit) {
        ApplicationManager.getApplication().invokeLater(block)
    }

    private fun timestampLabel(): String {
        return try {
            java.time.LocalDateTime.now().format(java.time.format.DateTimeFormatter.ofPattern("HH:mm:ss"))
        } catch (_: Throwable) {
            "--:--:--"
        }
    }

    private fun buildDuplicateIndex(items: List<GalleryAssetItem>): Map<String, Map<String, List<GalleryAssetItem>>> {
        return items
            .filter { it.mediaType == "image" && it.md5.isNotBlank() }
            .groupBy { it.platform }
            .mapValues { (_, platformItems) ->
                platformItems.groupBy { it.md5 }
            }
    }

    private data class DuplicateAlert(
        val newItem: GalleryAssetItem,
        val duplicates: List<GalleryAssetItem>
    )

    private fun duplicateAlertsFor(
        previousItems: List<GalleryAssetItem>,
        currentItems: List<GalleryAssetItem>
    ): List<DuplicateAlert> {
        if (previousItems.isEmpty()) return emptyList()
        val previousByPath = previousItems.associateBy { AssetFileUtil.normalizePath(it.absPath) }
        val currentIndex = buildDuplicateIndex(currentItems)

        return currentItems.mapNotNull { item ->
            if (item.mediaType != "image" || item.resourceRootPath.isBlank() || item.md5.isBlank()) return@mapNotNull null
            val normalizedPath = AssetFileUtil.normalizePath(item.absPath)
            val previous = previousByPath[normalizedPath]
            val isNewOrChanged = previous == null || previous.md5 != item.md5
            if (!isNewOrChanged) return@mapNotNull null

            val duplicates = currentIndex[item.platform]
                ?.get(item.md5)
                ?.filter { candidate -> AssetFileUtil.normalizePath(candidate.absPath) != normalizedPath }
                .orEmpty()
            if (duplicates.isEmpty()) null else DuplicateAlert(item, duplicates)
        }
    }

    private fun showDuplicateDialogAndHandle(newFile: File, platform: String, duplicates: List<GalleryAssetItem>) {
        val normalizedNewPath = AssetFileUtil.normalizePath(newFile.absolutePath)
        val selectedDuplicate = selectDuplicateForOpen(duplicates)

        val message = buildString {
            appendLine("检测到重复图片（同平台）：$platform")
            appendLine("新图：$normalizedNewPath")
            appendLine()
            appendLine("命中路径：")
            appendLine(selectedDuplicate.absPath)
            if (duplicates.size > 1) {
                appendLine("（共 ${duplicates.size} 个重复项，已按选择定位）")
            }
        }

        val result = Messages.showDialog(
            project,
            message,
            "图片重复提示",
            arrayOf("强制添加新图", "删除新图并定位旧图"),
            0,
            Messages.getWarningIcon()
        )

        if (result != 1) return

        val deleted = try {
            VfsUtil.findFileByIoFile(newFile, true)?.let { virtualFile ->
                ApplicationManager.getApplication().runWriteAction {
                    virtualFile.delete(this)
                }
                true
            } ?: newFile.delete()
        } catch (_: Throwable) {
            false
        }

        if (!deleted) {
            Messages.showErrorDialog(project, "无法删除新图片，请手动处理：$normalizedNewPath", "删除失败")
            return
        }

        openAssetInEditor(selectedDuplicate.absPath)
        syncAsync()
    }

    private fun selectDuplicateForOpen(duplicates: List<GalleryAssetItem>): GalleryAssetItem {
        if (duplicates.size == 1) return duplicates.first()

        val options = duplicates.map { it.absPath }.toTypedArray()
        val selectedIndex = Messages.showChooseDialog(
            project,
            "检测到多个重复图片，请选择要定位的旧图：",
            "选择重复图片",
            null,
            options,
            options.first()
        )

        if (selectedIndex in duplicates.indices) {
            return duplicates[selectedIndex]
        }

        return duplicates.first()
    }

    private fun openAssetInEditor(absPath: String) {
        val ioFile = File(absPath)
        val virtualFile = LocalFileSystem.getInstance().refreshAndFindFileByIoFile(ioFile) ?: return
        FileEditorManager.getInstance(project).openFile(virtualFile, true)
    }

    private fun isInterestingPath(path: String): Boolean {
        val normalizedPath = path.replace('\\', '/').lowercase(Locale.ROOT)
        if (hasIgnoredSegment(normalizedPath)) return false

        if (normalizedPath.endsWith("/pubspec.yaml")) return true

        if (normalizedPath.contains("/ios/")) {
            return normalizedPath.endsWith("contents.json") || isMediaLikePath(normalizedPath)
        }

        if (normalizedPath.contains("/res/drawable") || normalizedPath.contains("/res/mipmap") || normalizedPath.contains("/res/raw")) {
            return isMediaLikePath(normalizedPath) || normalizedPath.endsWith(".xml")
        }

        if (normalizedPath.contains("/assets/") || normalizedPath.contains("/res/")) {
            return isMediaLikePath(normalizedPath) || normalizedPath.endsWith(".json") || normalizedPath.endsWith(".svg")
        }

        return false
    }

    private fun hasIgnoredSegment(path: String): Boolean {
        return path.split('/').any { segment ->
            segment in setOf("build", "out", "output", "dist", "node_modules", ".dart_tool", "pods", "deriveddata")
        }
    }

    private fun isMediaLikePath(path: String): Boolean {
        return path.endsWith(".png") ||
            path.endsWith(".jpg") ||
            path.endsWith(".jpeg") ||
            path.endsWith(".webp") ||
            path.endsWith(".gif") ||
            path.endsWith(".bmp") ||
            path.endsWith(".svg") ||
            path.endsWith(".pdf") ||
            path.endsWith(".heic") ||
            path.endsWith(".heif") ||
            path.endsWith(".apng") ||
            path.endsWith(".avif") ||
            path.endsWith(".ico") ||
            path.endsWith(".mp3") ||
            path.endsWith(".m4a") ||
            path.endsWith(".aac") ||
            path.endsWith(".wav") ||
            path.endsWith(".ogg") ||
            path.endsWith(".opus") ||
            path.endsWith(".flac") ||
            path.endsWith(".amr") ||
            path.endsWith(".mid") ||
            path.endsWith(".midi") ||
            path.endsWith(".caf") ||
            path.endsWith(".wma") ||
            path.endsWith(".aiff") ||
            path.endsWith(".aif") ||
            path.endsWith(".alac") ||
            path.endsWith(".mka") ||
            path.endsWith(".mp4") ||
            path.endsWith(".m4v") ||
            path.endsWith(".mov") ||
            path.endsWith(".webm") ||
            path.endsWith(".mkv") ||
            path.endsWith(".avi") ||
            path.endsWith(".3gp") ||
            path.endsWith(".3gpp") ||
            path.endsWith(".mpeg") ||
            path.endsWith(".mpg") ||
            path.endsWith(".ts") ||
            path.endsWith(".m2ts") ||
            path.endsWith(".wmv") ||
            path.endsWith(".flv") ||
            path.endsWith(".json") ||
            path.endsWith(".xml")
    }

    companion object {
        private val MAX_METADATA_PARALLELISM = minOf(6, maxOf(2, Runtime.getRuntime().availableProcessors()))
        private const val METADATA_ITEM_TIMEOUT_MS = 15_000L

        fun getInstance(project: Project): GalleryIndexService = project.getService(GalleryIndexService::class.java)
    }
}

