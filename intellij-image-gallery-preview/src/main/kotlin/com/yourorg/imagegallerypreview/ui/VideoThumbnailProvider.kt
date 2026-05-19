package com.yourorg.imagegallerypreview.ui

import com.intellij.openapi.Disposable
import com.intellij.openapi.diagnostic.Logger
import javafx.animation.PauseTransition
import javafx.application.Platform
import javafx.embed.swing.JFXPanel
import javafx.embed.swing.SwingFXUtils
import javafx.scene.Scene
import javafx.scene.SnapshotParameters
import javafx.scene.image.WritableImage
import javafx.scene.layout.StackPane
import javafx.scene.media.Media
import javafx.scene.media.MediaPlayer
import javafx.scene.media.MediaView
import javafx.scene.paint.Color
import javafx.util.Duration
import java.io.File
import java.nio.file.Files
import java.nio.file.Path
import java.security.MessageDigest
import java.util.Base64
import java.util.Comparator
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import javax.imageio.ImageIO

internal class VideoThumbnailProvider(private val logger: Logger) : Disposable {
    private val cache = ConcurrentHashMap<String, Path>()
    private val tempDir = Files.createTempDirectory("image-gallery-video-thumbs")

    fun posterUriFor(file: File): String? {
        return posterFileFor(file)?.toURI()?.toASCIIString()?.plus("#gallery-poster")
    }

    fun posterFileFor(file: File): File? {
        if (!file.exists() || !file.isFile || file.length() <= 0L) return null

        val key = "${file.absoluteFile.normalize().path}|${file.lastModified()}|${file.length()}"
        cache[key]?.let { return it.toFile() }

        val poster = createPoster(file, key) ?: return null
        cache[key] = poster
        return poster.toFile()
    }

    override fun dispose() {
        cache.clear()
        runCatching {
            Files.walk(tempDir).use { stream ->
                stream.sorted(Comparator.reverseOrder()).forEach { path ->
                    runCatching { Files.deleteIfExists(path) }
                }
            }
        }
    }

    private fun createPoster(file: File, key: String): Path? {
        return try {
            ensureFxInitialized()

            val latch = CountDownLatch(1)
            val result = AtomicReference<Path?>()
            val failed = AtomicReference<Throwable?>()

            Platform.runLater {
                var player: MediaPlayer? = null
                try {
                    val media = Media(file.toURI().toString())
                    player = MediaPlayer(media)
                    val view = MediaView(player)
                    view.isPreserveRatio = true
                    view.fitWidth = THUMB_SIZE.toDouble()
                    view.fitHeight = THUMB_SIZE.toDouble()

                    val root = StackPane(view)
                    root.style = "-fx-background-color: #0a0c10;"
                    val scene = Scene(root, THUMB_SIZE.toDouble(), THUMB_SIZE.toDouble(), Color.web("#0a0c10"))
                    root.applyCss()
                    root.layout()

                    val completed = AtomicBoolean(false)
                    fun finish(value: Path?, error: Throwable? = null) {
                        if (!completed.compareAndSet(false, true)) return
                        if (error != null) failed.set(error)
                        result.set(value)
                        runCatching { player?.dispose() }
                        latch.countDown()
                    }

                    fun capture() {
                        try {
                            val image = WritableImage(THUMB_SIZE, THUMB_SIZE)
                            scene.root.snapshot(SnapshotParameters(), image)
                            val output = tempDir.resolve("${digestKey(key)}.png")
                            ImageIO.write(SwingFXUtils.fromFXImage(image, null), "png", output.toFile())
                            finish(output)
                        } catch (error: Throwable) {
                            finish(null, error)
                        }
                    }

                    val timeout = PauseTransition(Duration.millis(THUMB_TIMEOUT_MS.toDouble()))
                    timeout.setOnFinished { finish(null) }

                    media.setOnError {
                        finish(null, media.error)
                    }
                    player?.setOnError {
                        finish(null, player?.error)
                    }
                    player?.setOnReady {
                        val total = player?.totalDuration
                        val target = if (total != null && !total.isUnknown && total.toMillis() > 1_000) {
                            Duration.millis(kotlin.math.min(1_000.0, total.toMillis() * 0.1))
                        } else {
                            Duration.millis(50.0)
                        }

                        player?.seek(target)
                        player?.play()
                        PauseTransition(Duration.millis(450.0)).apply {
                            setOnFinished {
                                player?.pause()
                                capture()
                            }
                            play()
                        }
                    }

                    timeout.play()
                } catch (error: Throwable) {
                    runCatching { player?.dispose() }
                    failed.set(error)
                    latch.countDown()
                }
            }

            if (!latch.await(THUMB_TIMEOUT_MS + 1_000L, TimeUnit.MILLISECONDS)) {
                logger.warn("Timed out creating video thumbnail: ${file.absolutePath}")
                null
            } else {
                failed.get()?.let { logger.warn("Failed to create video thumbnail: ${file.absolutePath}", it) }
                result.get()
            }
        } catch (error: Throwable) {
            logger.warn("Video thumbnail provider unavailable", error)
            null
        }
    }

    private fun ensureFxInitialized() {
        if (fxInitialized.compareAndSet(false, true)) {
            JFXPanel()
            Platform.setImplicitExit(false)
        }
    }

    private fun digestKey(value: String): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(value.toByteArray(Charsets.UTF_8))
        return Base64.getUrlEncoder().withoutPadding().encodeToString(digest)
    }

    private companion object {
        private val fxInitialized = AtomicBoolean(false)
        private const val THUMB_SIZE = 480
        private const val THUMB_TIMEOUT_MS = 4_000L
    }
}
