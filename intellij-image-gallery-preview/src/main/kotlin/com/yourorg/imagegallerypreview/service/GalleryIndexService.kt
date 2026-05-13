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
import com.yourorg.imagegallerypreview.model.GalleryAssetItem
import com.yourorg.imagegallerypreview.scanner.ProjectAssetScanner
import com.yourorg.imagegallerypreview.util.AssetFileUtil
import java.io.File
import java.util.Locale
import java.util.concurrent.CopyOnWriteArrayList
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

    init {
        val connection = project.messageBus.connect(this)
        connection.subscribe(VirtualFileManager.VFS_CHANGES, object : BulkFileListener {
            override fun after(events: List<com.intellij.openapi.vfs.newvfs.events.VFileEvent>) {
                val createdFiles = events.filterIsInstance<VFileCreateEvent>()
                    .map { event -> event.path.replace('\\', '/') }
                    .filter { path -> isInterestingPath(path) }
                    .distinct()

                val relevant = events.any { event ->
                    (event is VFileCreateEvent || event is VFileDeleteEvent || event is VFileContentChangeEvent) &&
                        isInterestingPath(event.path)
                }

                if (!relevant) return

                refreshAsync {
                    createdFiles.forEach { createdPath ->
                        handleCreatedFileDuplicateCheck(createdPath)
                    }
                }
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

    fun refreshAsync(afterRefresh: (() -> Unit)? = null) {
        if (!refreshRunning.compareAndSet(false, true)) {
            refreshPending.set(true)
            return
        }
        runRefresh(listOfNotNull(afterRefresh))
    }

    override fun dispose() {
        listeners.clear()
        statusListeners.clear()
    }

    private fun runRefresh(afterRefreshCallbacks: List<() -> Unit>) {
        publishStatus(IndexStatus(IndexState.INDEXING, "Indexing..."))

        ApplicationManager.getApplication().executeOnPooledThread {
            val started = System.currentTimeMillis()
            val callbackQueue = afterRefreshCallbacks.toMutableList()

            try {
                val items = scanner.scan()
                cache = items
                duplicateIndex = buildDuplicateIndex(items)

                publishItems(items)
                val elapsed = System.currentTimeMillis() - started
                publishStatus(IndexStatus(IndexState.SUCCESS, "Updated at ${timestampLabel()} (${items.size} items, ${elapsed}ms)"))
                callbackQueue.forEach { invokeOnEdt(it) }
            } catch (error: Throwable) {
                publishStatus(IndexStatus(IndexState.FAILED, "Failed", error = error))
            } finally {
                refreshRunning.set(false)
                if (refreshPending.compareAndSet(true, false)) {
                    if (refreshRunning.compareAndSet(false, true)) {
                        runRefresh(emptyList())
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
            .groupBy { it.platform }
            .mapValues { (_, platformItems) ->
                platformItems.groupBy { it.md5 }
            }
    }

    private fun handleCreatedFileDuplicateCheck(path: String) {
        val absPath = AssetFileUtil.normalizePath(path)
        val file = File(absPath)
        if (!file.exists() || !file.isFile) return

        val formatFamily = AssetFileUtil.detectFormatFamily(file, preferVectorXml = true)
        if (!AssetFileUtil.isSupportedFamily(formatFamily)) return

        val platform = detectPlatformByPath(absPath) ?: return
        val md5 = AssetFileUtil.md5Hex(file)
        if (md5.isBlank()) return

        val duplicates = duplicateIndex[platform]
            ?.get(md5)
            ?.filter { item -> AssetFileUtil.normalizePath(item.absPath) != absPath }
            .orEmpty()

        if (duplicates.isEmpty()) return

        showDuplicateDialogAndHandle(file, platform, duplicates)
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
        refreshAsync()
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

    private fun detectPlatformByPath(path: String): String? {
        val lower = path.lowercase(Locale.ROOT)

        if (lower.contains("/src/") && (lower.contains("/res/drawable") || lower.contains("/res/mipmap"))) {
            return "android"
        }

        if (lower.contains("/ios/")) {
            return "ios"
        }

        if (lower.contains("/assets/") || lower.contains("/res/")) {
            return "flutter"
        }

        return null
    }

    private fun isInterestingPath(path: String): Boolean {
        val normalizedPath = path.replace('\\', '/').lowercase(Locale.ROOT)

        if (normalizedPath.endsWith("/pubspec.yaml")) return true

        if (normalizedPath.contains("/ios/")) {
            return normalizedPath.endsWith("contents.json") || isImageLikePath(normalizedPath) || normalizedPath.endsWith(".json")
        }

        if (normalizedPath.contains("/res/drawable") || normalizedPath.contains("/res/mipmap")) {
            return isImageLikePath(normalizedPath) || normalizedPath.endsWith(".xml")
        }

        if (normalizedPath.contains("/assets/") || normalizedPath.contains("/res/")) {
            return isImageLikePath(normalizedPath) || normalizedPath.endsWith(".json") || normalizedPath.endsWith(".svg")
        }

        return false
    }

    private fun isImageLikePath(path: String): Boolean {
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
            path.endsWith(".json") ||
            path.endsWith(".xml")
    }

    companion object {
        fun getInstance(project: Project): GalleryIndexService = project.getService(GalleryIndexService::class.java)
    }
}

