package com.yourorg.imagegallerypreview.ui

import com.google.gson.Gson
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.intellij.ide.BrowserUtil
import com.intellij.ide.actions.RevealFileAction
import com.intellij.codeInsight.daemon.DaemonCodeAnalyzer
import com.intellij.ide.projectView.ProjectView
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.ide.CopyPasteManager
import com.intellij.openapi.options.ShowSettingsUtil
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.wm.WindowManager
import com.intellij.psi.PsiManager
import com.intellij.ui.JBColor
import com.intellij.ui.components.JBLabel
import com.intellij.ui.jcef.JBCefApp
import com.intellij.ui.jcef.JBCefBrowser
import com.intellij.ui.jcef.JBCefJSQuery
import com.intellij.util.ui.JBUI
import com.yourorg.imagegallerypreview.metadata.MediaMetadataExtractor
import com.yourorg.imagegallerypreview.model.GalleryAssetItem
import com.yourorg.imagegallerypreview.navigation.GalleryResourceLinkPresentationService
import com.yourorg.imagegallerypreview.service.GalleryIndexService
import com.yourorg.imagegallerypreview.service.GallerySettingsService
import com.yourorg.imagegallerypreview.util.AssetFileUtil
import java.awt.BorderLayout
import java.awt.CardLayout
import java.awt.Desktop
import java.awt.Font
import java.awt.datatransfer.StringSelection
import java.io.File
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong
import javax.swing.JPanel
import javax.swing.SwingConstants

class JcefImageGalleryPanel(private val project: Project) : JPanel(BorderLayout()), Disposable {
    private val logger = Logger.getInstance(JcefImageGalleryPanel::class.java)
    private val gson = Gson()
    private val service = GalleryIndexService.getInstance(project)
    private val settings = GallerySettingsService.getInstance(project)
    private val contentLayout = CardLayout()
    private val contentPanel = JPanel(contentLayout)
    private val hostLoadingLabel = JBLabel("Loading Image Gallery...", SwingConstants.CENTER)
    private val browser: JBCefBrowser?
    private val messageQuery: JBCefJSQuery?
    private val mediaServer: LocalMediaStreamServer?
    private val videoThumbnailProvider: VideoThumbnailProvider?
    private val latestItems = mutableListOf<GalleryAssetItem>()
    private val loadingSeq = AtomicLong(0)
    private val assetSeq = AtomicLong(0)
    private val assetSendLock = Any()
    private val assetSessions = ConcurrentHashMap<Long, AssetSendSession>()

    private data class AssetSendRequest(
        val items: List<GalleryAssetItem>,
        val hideLoadingPayload: Map<String, Any?>?
    )

    private data class AssetSendSession(
        val chunks: List<List<GalleryWebAssetItem>>,
        val completeOnEnd: Boolean,
        val doneMessage: String
    )

    @Volatile
    private var browserReady = false

    @Volatile
    private var assetSendRunning = false

    private var pendingAssetSend: AssetSendRequest? = null

    private val itemsListener: (List<GalleryAssetItem>) -> Unit = { items ->
        latestItems.clear()
        latestItems.addAll(items)
        sendAssetsIfReady()
    }

    private val statusListener: (GalleryIndexService.IndexStatus) -> Unit = { status ->
        sendLoadingStateIfReady(status)
    }

    init {
        border = JBUI.Borders.empty()

        if (!JBCefApp.isSupported()) {
            browser = null
            messageQuery = null
            mediaServer = null
            videoThumbnailProvider = null
            add(createJcefUnavailablePanel(), BorderLayout.CENTER)
        } else {
            browser = JBCefBrowser()
            messageQuery = JBCefJSQuery.create(browser)
            val server = LocalMediaStreamServer(logger)
            val thumbnails = VideoThumbnailProvider(logger)
            mediaServer = server
            videoThumbnailProvider = thumbnails
            Disposer.register(this, browser)
            Disposer.register(this, messageQuery)
            Disposer.register(this, server)
            Disposer.register(this, thumbnails)
            messageQuery.addHandler { rawMessage ->
                handleWebMessage(rawMessage)
                null
            }

            contentPanel.add(createHostLoadingPanel(), "loading")
            contentPanel.add(browser.component, "browser")
            add(contentPanel, BorderLayout.CENTER)
            contentLayout.show(contentPanel, "loading")
            try {
                browser.loadURL(prepareWebUi(messageQuery).toUri().toString())
            } catch (error: Throwable) {
                logger.warn("Failed to load gallery web UI", error)
                hostLoadingLabel.text = "Failed to load Image Gallery UI: ${error.message ?: error.javaClass.simpleName}"
            }
        }

        if (browser != null) {
            service.addListener(itemsListener)
            service.addStatusListener(statusListener)
        }
    }

    fun refreshNow() {
        service.refreshAsync()
    }

    fun disposePanel() {
        dispose()
    }

    override fun dispose() {
        service.removeListener(itemsListener)
        service.removeStatusListener(statusListener)
        assetSessions.clear()
    }

    private fun handleWebMessage(rawMessage: String): JBCefJSQuery.Response? {
        val message = try {
            JsonParser.parseString(rawMessage).asJsonObject
        } catch (error: Throwable) {
            logger.warn("Invalid gallery web message: $rawMessage", error)
            return null
        }

        when (message.string("type")) {
            "ready" -> {
                browserReady = true
                if (browser != null) {
                    contentLayout.show(contentPanel, "browser")
                }
                sendSettingsState()
                val status = service.currentStatus()
                if (status.state == GalleryIndexService.IndexState.SUCCESS && latestItems.isNotEmpty()) {
                    sendRenderingState()
                    sendAssetsIfReady(hideLoadingAfterSend = true)
                } else {
                    sendLoadingStateIfReady(status)
                    sendAssetsIfReady()
                }
            }

            "openSettings" -> ApplicationManager.getApplication().invokeLater {
                ShowSettingsUtil.getInstance().showSettingsDialog(project, "Image Gallery Preview")
            }
            "requestSettings" -> sendSettingsState()
            "updateSettings" -> {
                val enabled = message.get("resourceStringLinksEnabled")?.asBoolean == true
                settings.resourceStringLinksEnabled = enabled
                ApplicationManager.getApplication().invokeLater {
                    if (!enabled) GalleryResourceLinkPresentationService.getInstance(project).clearPresentation()
                    DaemonCodeAnalyzer.getInstance(project).restart()
                }
                sendSettingsState()
            }
            "sync" -> service.syncAsync()
            "refresh" -> service.refreshAsync(forceReindex = message.get("force")?.asBoolean ?: true)
            "copy" -> ApplicationManager.getApplication().invokeLater {
                copyText(message.string("value").orEmpty(), message.string("label").orEmpty())
            }
            "reveal" -> message.string("absPath")?.let { absPath ->
                ApplicationManager.getApplication().invokeLater { openAssetInProject(absPath) }
            }
            "showInSystem" -> message.string("absPath")?.let { absPath ->
                ApplicationManager.getApplication().invokeLater { RevealFileAction.openFile(File(absPath)) }
            }
            "requestImageInfo", "requestMediaInfo" -> message.string("absPath")?.let { absPath ->
                sendMediaInfo(absPath, message.get("force")?.asBoolean == true)
            }
            "requestAssetsChunk" -> {
                val seq = message.get("assetSeq")?.asLong ?: return null
                val chunkIndex = message.get("chunkIndex")?.asInt ?: 0
                sendAssetChunk(seq, chunkIndex)
            }
            "openWithDefaultApp" -> message.string("absPath")?.let { absPath ->
                ApplicationManager.getApplication().executeOnPooledThread { openWithDefaultApp(absPath) }
            }
            "openExternal" -> message.string("url")?.let { url ->
                ApplicationManager.getApplication().invokeLater { BrowserUtil.browse(url) }
            }
        }

        return null
    }

    private fun sendAssetsIfReady(hideLoadingAfterSend: Boolean = false) {
        if (!browserReady) return

        val request = AssetSendRequest(
            items = latestItems.toList(),
            hideLoadingPayload = if (hideLoadingAfterSend) loadingPayload(service.currentStatus(), loading = false) else null
        )
        var shouldStartWorker = false
        synchronized(assetSendLock) {
            val previous = pendingAssetSend
            pendingAssetSend = request.copy(
                hideLoadingPayload = request.hideLoadingPayload ?: previous?.hideLoadingPayload
            )
            if (!assetSendRunning) {
                assetSendRunning = true
                shouldStartWorker = true
            }
        }

        if (shouldStartWorker) {
            ApplicationManager.getApplication().executeOnPooledThread {
                drainAssetSendQueue()
            }
        }
    }

    private fun drainAssetSendQueue() {
        while (true) {
            val request = synchronized(assetSendLock) {
                val next = pendingAssetSend
                if (next == null) {
                    assetSendRunning = false
                }
                pendingAssetSend = null
                next
            } ?: return

            sendAssetSnapshot(request)
        }
    }

    private fun sendAssetSnapshot(request: AssetSendRequest) {
        val snapshot = request.items
        val assets = snapshot.map { item ->
            val normalizedPath = AssetFileUtil.normalizePath(item.absPath)
            val file = File(normalizedPath)
            val previewSrc = previewSrcFor(item, file)
            val lottieJson = if (item.formatFamily == "lottie") readSmallTextFile(normalizedPath) else null
            GalleryWebPayloadBuilder.toWebAsset(item, previewSrc, lottieJson)
        }

        val seq = assetSeq.incrementAndGet()
        val chunks = assets.chunked(ASSET_PAYLOAD_CHUNK_SIZE)
        val doneMessage = request.hideLoadingPayload?.get("message") as? String ?: "Updated"
        assetSessions[seq] = AssetSendSession(
            chunks = chunks,
            completeOnEnd = request.hideLoadingPayload != null,
            doneMessage = doneMessage
        )
        sendToWeb(
            mapOf(
                "type" to "assetsStart",
                "assetSeq" to seq,
                "total" to assets.size,
                "chunkCount" to chunks.size,
                "completeOnEnd" to (request.hideLoadingPayload != null),
                "doneMessage" to doneMessage
            )
        )
    }

    private fun sendAssetChunk(seq: Long, chunkIndex: Int) {
        val session = assetSessions[seq] ?: return
        val chunk = session.chunks.getOrNull(chunkIndex) ?: return
        val done = chunkIndex >= session.chunks.lastIndex
        sendToWeb(
            mapOf(
                "type" to "assetsChunk",
                "assetSeq" to seq,
                "chunkIndex" to chunkIndex,
                "items" to chunk,
                "done" to done,
                "total" to session.chunks.sumOf { it.size }
            )
        )
        if (done) {
            assetSessions.remove(seq)
        }
    }

    private fun sendLoadingStateIfReady(status: GalleryIndexService.IndexStatus) {
        updateHostLoading(status)
        if (!browserReady) return
        if (status.state == GalleryIndexService.IndexState.SUCCESS && latestItems.isNotEmpty()) {
            sendRenderingState()
            sendAssetsIfReady(hideLoadingAfterSend = true)
            return
        }
        sendToWeb(loadingPayload(status, loading = status.state == GalleryIndexService.IndexState.INDEXING))
    }

    private fun sendSettingsState() {
        sendToWeb(
            mapOf(
                "type" to "settingsState",
                "resourceStringLinksEnabled" to settings.resourceStringLinksEnabled
            )
        )
    }

    private fun sendRenderingState() {
        sendToWeb(
            mapOf(
                "type" to "loadingState",
                "loading" to true,
                "loadingSeq" to loadingSeq.incrementAndGet(),
                "message" to "Rendering assets...",
                "phase" to "rendering",
                "indexedCount" to latestItems.size,
                "metadataCount" to latestItems.size,
                "workerStatus" to "rendering"
            )
        )
    }

    private fun loadingPayload(status: GalleryIndexService.IndexStatus, loading: Boolean): Map<String, Any?> {
        return mapOf(
            "type" to "loadingState",
            "loading" to loading,
            "loadingSeq" to loadingSeq.incrementAndGet(),
            "message" to status.message,
            "phase" to status.phase,
            "indexedCount" to status.indexedCount,
            "metadataCount" to status.metadataCount,
            "currentPath" to status.currentPath,
            "fallbackSource" to status.fallbackSource,
            "elapsedMillis" to status.elapsedMillis,
            "workerStatus" to status.workerStatus,
            "diagnostic" to status.diagnostic
        )
    }

    private fun updateHostLoading(status: GalleryIndexService.IndexStatus) {
        if (browserReady) return
        hostLoadingLabel.text = when (status.state) {
            GalleryIndexService.IndexState.FAILED -> "Image Gallery failed to load: ${status.message}"
            GalleryIndexService.IndexState.INDEXING -> status.message
            else -> "Loading Image Gallery..."
        }
    }

    private fun sendMediaInfo(absPath: String, force: Boolean = false) {
        val normalized = AssetFileUtil.normalizePath(absPath)
        val item = latestItems.firstOrNull { AssetFileUtil.normalizePath(it.absPath) == normalized }
            ?: return

        ApplicationManager.getApplication().executeOnPooledThread {
            val info = if (force || MediaMetadataExtractor.isRetryableFallback(item.mediaInfo)) {
                MediaMetadataExtractor.infoFor(item, force = true)
            } else {
                item.mediaInfo ?: MediaMetadataExtractor.infoFor(item)
            }
            sendToWeb(
                mapOf(
                    "type" to "imageInfo",
                    "absPath" to normalized,
                    "info" to info
                )
            )
            if (force) {
                sendToWeb(mapOf("type" to "toast", "message" to "媒体信息已刷新"))
            }
        }
    }

    private fun sendToWeb(payload: Any) {
        sendToWeb(listOf(payload))
    }

    private fun sendToWeb(payloads: List<Any>) {
        if (payloads.isEmpty()) return
        val script = payloads.joinToString(separator = "\n") { payload ->
            val json = gson.toJson(payload)
            """
                try {
                  window.galleryHostReceive && window.galleryHostReceive($json);
                } catch (error) {
                  console.error('[image-gallery-preview] host message failed', error);
                }
            """.trimIndent()
        }
        val targetBrowser = browser ?: return
        ApplicationManager.getApplication().invokeLater {
            if (!isDisplayable) return@invokeLater
            targetBrowser.cefBrowser.executeJavaScript(
                script,
                targetBrowser.cefBrowser.url,
                0
            )
        }
    }

    private fun previewSrcFor(item: GalleryAssetItem, file: File): String? {
        return when {
            item.mediaType == "video" -> videoThumbnailProvider?.posterUriFor(file)
                ?: mediaServer?.urlFor(file)
                ?: file.toURI().toASCIIString()
            item.mediaType == "image" || item.formatFamily == "lottie" -> file.toURI().toASCIIString()
            else -> null
        }
    }

    private fun copyText(value: String, label: String) {
        if (value.isBlank()) return
        CopyPasteManager.getInstance().setContents(StringSelection(value))
        WindowManager.getInstance().getStatusBar(project)?.info = "已复制${label.ifBlank { "内容" }}: $value"
    }

    private fun openAssetInProject(absPath: String) {
        val ioFile = File(absPath)
        val virtualFile = LocalFileSystem.getInstance().refreshAndFindFileByIoFile(ioFile) ?: return

        FileEditorManager.getInstance(project).openFile(virtualFile, true)
        PsiManager.getInstance(project).findFile(virtualFile)?.let {
            ProjectView.getInstance(project).select(virtualFile, virtualFile, false)
        }
    }

    private fun openWithDefaultApp(absPath: String) {
        val file = File(absPath)
        if (!file.exists()) return
        try {
            if (Desktop.isDesktopSupported()) {
                Desktop.getDesktop().open(file)
            } else {
                RevealFileAction.openFile(file)
            }
        } catch (error: Throwable) {
            logger.warn("Failed to open media with default app: $absPath", error)
            ApplicationManager.getApplication().invokeLater { RevealFileAction.openFile(file) }
        }
    }

    private fun prepareWebUi(query: JBCefJSQuery): Path {
        val outputDir = Files.createTempDirectory("image-gallery-preview-web")
        outputDir.toFile().deleteOnExit()

        copyResource("gallery.css", outputDir.resolve("gallery.css"))
        copyResource("gallery.js", outputDir.resolve("gallery.js"))
        copyResource("lottie-light.min.js", outputDir.resolve("lottie-light.min.js"))

        val indexHtml = resourceText("index.html")
        val bridgeScript = """
            <script>
              window.intellijPostMessage = function(message) {
                ${query.inject("JSON.stringify(message)")}
              };
            </script>
        """.trimIndent()

        Files.writeString(
            outputDir.resolve("index.html"),
            indexHtml.replace("</head>", "$bridgeScript\n</head>"),
            StandardCharsets.UTF_8
        )
        outputDir.resolve("index.html").toFile().deleteOnExit()
        return outputDir.resolve("index.html")
    }

    private fun copyResource(name: String, target: Path) {
        javaClass.classLoader.getResourceAsStream("gallery-web/$name").use { input ->
            val stream = requireNotNull(input) { "Missing gallery web resource: $name" }
            Files.copy(stream, target)
        }
        target.toFile().deleteOnExit()
    }

    private fun resourceText(name: String): String {
        return javaClass.classLoader.getResourceAsStream("gallery-web/$name").use { input ->
            val stream = requireNotNull(input) { "Missing gallery web resource: $name" }
            stream.readBytes().toString(StandardCharsets.UTF_8)
        }
    }

    private fun readSmallTextFile(absPath: String): String? {
        val file = File(absPath)
        if (!file.exists() || !file.isFile || file.length() > MAX_INLINE_LOTTIE_BYTES) return null
        return try {
            file.readText(StandardCharsets.UTF_8)
        } catch (_: Throwable) {
            null
        }
    }

    private fun createHostLoadingPanel(): JPanel {
        val panel = JPanel(BorderLayout()).apply {
            border = JBUI.Borders.empty(28)
            background = JBColor.PanelBackground
        }
        hostLoadingLabel.font = hostLoadingLabel.font.deriveFont(Font.BOLD, 15f)
        panel.add(hostLoadingLabel, BorderLayout.CENTER)
        return panel
    }

    private fun createJcefUnavailablePanel(): JPanel {
        val panel = JPanel(BorderLayout()).apply {
            border = JBUI.Borders.empty(28)
            background = JBColor.PanelBackground
        }
        val label = JBLabel(
            """
            <html>
              <div style='text-align:center;font-size:24px;line-height:1.55;'>
                当前 IDE 运行时不支持 JCEF。<br/>
                Image Gallery Preview 需要带 JCEF 的 JetBrains Runtime。<br/>
                请在 Help &gt; Find Action 中搜索 Choose Boot Runtime，选择与 Mac 架构匹配且包含 JCEF 的 JetBrains Runtime。
              </div>
            </html>
            """.trimIndent(),
            SwingConstants.CENTER
        ).apply {
            font = font.deriveFont(Font.BOLD, 24f)
        }
        panel.add(label, BorderLayout.CENTER)
        return panel
    }

    private fun JsonObject.string(name: String): String? {
        return if (has(name) && !get(name).isJsonNull) get(name).asString else null
    }

    companion object {
        private const val MAX_INLINE_LOTTIE_BYTES = 2L * 1024L * 1024L
        private const val ASSET_PAYLOAD_CHUNK_SIZE = 50
    }
}
