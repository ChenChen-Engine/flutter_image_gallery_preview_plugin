package com.yourorg.imagegallerypreview.ui

import com.google.gson.Gson
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.intellij.ide.BrowserUtil
import com.intellij.ide.actions.RevealFileAction
import com.intellij.ide.projectView.ProjectView
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.ide.CopyPasteManager
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
import com.yourorg.imagegallerypreview.service.GalleryIndexService
import com.yourorg.imagegallerypreview.util.AssetFileUtil
import java.awt.BorderLayout
import java.awt.Desktop
import java.awt.Font
import java.awt.datatransfer.StringSelection
import java.io.File
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import javax.swing.JButton
import javax.swing.JPanel
import javax.swing.SwingConstants

class JcefImageGalleryPanel(private val project: Project) : JPanel(BorderLayout()), Disposable {
    private val logger = Logger.getInstance(JcefImageGalleryPanel::class.java)
    private val gson = Gson()
    private val service = GalleryIndexService.getInstance(project)
    private val browser: JBCefBrowser?
    private val messageQuery: JBCefJSQuery?
    private val mediaServer: LocalMediaStreamServer?
    private val latestItems = mutableListOf<GalleryAssetItem>()

    @Volatile
    private var browserReady = false

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
            add(createUnsupportedPanel(), BorderLayout.CENTER)
        } else {
            browser = JBCefBrowser()
            messageQuery = JBCefJSQuery.create(browser)
            mediaServer = LocalMediaStreamServer(logger)
            Disposer.register(this, browser)
            Disposer.register(this, messageQuery)
            Disposer.register(this, mediaServer)
            messageQuery.addHandler { rawMessage ->
                handleWebMessage(rawMessage)
                null
            }

            add(browser.component, BorderLayout.CENTER)
            browser.loadURL(prepareWebUi(messageQuery).toUri().toString())
        }

        service.addListener(itemsListener)
        service.addStatusListener(statusListener)
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
                sendLoadingStateIfReady(service.currentStatus())
                sendAssetsIfReady()
            }

            "refresh" -> service.refreshAsync()
            "copy" -> ApplicationManager.getApplication().invokeLater {
                copyText(message.string("value").orEmpty(), message.string("label").orEmpty())
            }
            "open" -> message.string("absPath")?.let { absPath ->
                ApplicationManager.getApplication().invokeLater { openAssetInProject(absPath) }
            }
            "reveal" -> message.string("absPath")?.let { absPath ->
                ApplicationManager.getApplication().invokeLater { openAssetInProject(absPath) }
            }
            "showInSystem" -> message.string("absPath")?.let { absPath ->
                ApplicationManager.getApplication().invokeLater { RevealFileAction.openFile(File(absPath)) }
            }
            "requestImageInfo", "requestMediaInfo" -> message.string("absPath")?.let(::sendMediaInfo)
            "openWithDefaultApp" -> message.string("absPath")?.let { absPath ->
                ApplicationManager.getApplication().executeOnPooledThread { openWithDefaultApp(absPath) }
            }
            "openWithChooser" -> message.string("absPath")?.let { absPath ->
                ApplicationManager.getApplication().executeOnPooledThread { openWithChooser(absPath) }
            }
            "openExternal" -> message.string("url")?.let { url ->
                ApplicationManager.getApplication().invokeLater { BrowserUtil.browse(url) }
            }
        }

        return null
    }

    private fun sendAssetsIfReady() {
        if (!browserReady) return

        val snapshot = latestItems.toList()
        ApplicationManager.getApplication().executeOnPooledThread {
            val assets = snapshot.map { item ->
                val normalizedPath = AssetFileUtil.normalizePath(item.absPath)
                val file = File(normalizedPath)
                val previewSrc = if (item.mediaType == "audio" || item.mediaType == "video") {
                    mediaServer?.urlFor(file)
                } else {
                    file.toURI().toASCIIString()
                }
                val lottieJson = if (item.formatFamily == "lottie") readSmallTextFile(normalizedPath) else null
                GalleryWebPayloadBuilder.toWebAsset(item, previewSrc, lottieJson)
            }

            sendToWeb(mapOf("type" to "assets", "items" to assets))
        }
    }

    private fun sendLoadingStateIfReady(status: GalleryIndexService.IndexStatus) {
        if (!browserReady) return
        sendToWeb(
            mapOf(
                "type" to "loadingState",
                "loading" to (status.state == GalleryIndexService.IndexState.INDEXING),
                "message" to status.message
            )
        )
    }

    private fun sendMediaInfo(absPath: String) {
        val normalized = AssetFileUtil.normalizePath(absPath)
        val item = latestItems.firstOrNull { AssetFileUtil.normalizePath(it.absPath) == normalized }
            ?: return

        ApplicationManager.getApplication().executeOnPooledThread {
            val info = MediaMetadataExtractor.infoFor(item)
            sendToWeb(
                mapOf(
                    "type" to "imageInfo",
                    "absPath" to normalized,
                    "info" to info
                )
            )
        }
    }

    private fun sendToWeb(payload: Any) {
        val targetBrowser = browser ?: return
        val json = gson.toJson(payload)
        ApplicationManager.getApplication().invokeLater {
            if (!isDisplayable) return@invokeLater
            targetBrowser.cefBrowser.executeJavaScript(
                "window.galleryHostReceive && window.galleryHostReceive($json);",
                targetBrowser.cefBrowser.url,
                0
            )
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

    private fun openWithChooser(absPath: String) {
        val file = File(absPath)
        if (!file.exists()) return
        try {
            if (isWindows()) {
                ProcessBuilder("rundll32.exe", "shell32.dll,OpenAs_RunDLL", file.absolutePath).start()
            } else {
                openWithDefaultApp(absPath)
            }
        } catch (error: Throwable) {
            logger.warn("Failed to open media chooser: $absPath", error)
            openWithDefaultApp(absPath)
        }
    }

    private fun isWindows(): Boolean {
        return System.getProperty("os.name").orEmpty().lowercase().contains("win")
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

    private fun createUnsupportedPanel(): JPanel {
        val panel = JPanel(BorderLayout()).apply {
            border = JBUI.Borders.empty(28)
            background = JBColor.PanelBackground
        }
        val label = JBLabel(
            "<html><div style='text-align:center;'>JCEF is not available in this IDE runtime.<br/>Image Gallery Preview requires JCEF Web UI support.</div></html>",
            SwingConstants.CENTER
        ).apply {
            font = font.deriveFont(Font.BOLD, 15f)
        }
        val refresh = JButton("Refresh Index").apply {
            addActionListener { refreshNow() }
        }
        panel.add(label, BorderLayout.CENTER)
        panel.add(refresh, BorderLayout.SOUTH)
        return panel
    }

    private fun JsonObject.string(name: String): String? {
        return if (has(name) && !get(name).isJsonNull) get(name).asString else null
    }

    companion object {
        private const val MAX_INLINE_LOTTIE_BYTES = 2L * 1024L * 1024L
    }
}
