package com.yourorg.imagegallerypreview.ui

import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.wm.WindowManager
import javafx.application.Platform
import javafx.collections.FXCollections
import javafx.embed.swing.JFXPanel
import javafx.geometry.Insets
import javafx.geometry.Pos
import javafx.scene.Scene
import javafx.scene.control.Button
import javafx.scene.control.ComboBox
import javafx.scene.control.Label
import javafx.scene.control.Slider
import javafx.scene.layout.BorderPane
import javafx.scene.layout.HBox
import javafx.scene.layout.StackPane
import javafx.scene.media.Media
import javafx.scene.media.MediaPlayer
import javafx.scene.media.MediaView
import javafx.util.Duration
import java.awt.BorderLayout
import java.awt.Desktop
import java.awt.Dialog
import java.awt.Dimension
import java.awt.event.WindowAdapter
import java.awt.event.WindowEvent
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import javax.swing.JDialog
import javax.swing.SwingUtilities

internal object NativeMediaPlayerDialog {
    private val fxInitialized = AtomicBoolean(false)

    fun open(project: Project, absPath: String, mediaType: String) {
        val file = File(absPath)
        if (!file.exists() || !file.isFile) {
            Messages.showErrorDialog(project, "文件不存在：$absPath", "无法播放")
            return
        }

        try {
            ensureFxInitialized()
        } catch (error: Throwable) {
            showUnsupported(project, file, "JavaFX 媒体运行时不可用：${error.message.orEmpty()}")
            return
        }

        val parent = WindowManager.getInstance().suggestParentWindow(project)
        val dialog = JDialog(parent, file.name, Dialog.ModalityType.MODELESS)
        val panel = JFXPanel()
        val playerRef = AtomicReference<MediaPlayer?>()

        dialog.defaultCloseOperation = JDialog.DISPOSE_ON_CLOSE
        dialog.layout = BorderLayout()
        dialog.add(panel, BorderLayout.CENTER)
        dialog.minimumSize = if (mediaType == "video") Dimension(760, 460) else Dimension(480, 180)
        dialog.setSize(if (mediaType == "video") 960 else 560, if (mediaType == "video") 620 else 220)
        dialog.setLocationRelativeTo(parent)
        dialog.addWindowListener(object : WindowAdapter() {
            override fun windowClosed(event: WindowEvent?) {
                Platform.runLater {
                    playerRef.getAndSet(null)?.dispose()
                }
            }
        })
        dialog.isVisible = true

        Platform.runLater {
            try {
                val media = Media(file.toURI().toString())
                val player = MediaPlayer(media)
                playerRef.set(player)
                panel.scene = createScene(project, file, mediaType, player, dialog)
                player.setOnError {
                    val message = player.error?.message ?: media.error?.message ?: "当前格式或编码不受内置播放器支持"
                    SwingUtilities.invokeLater {
                        dialog.dispose()
                        showUnsupported(project, file, message)
                    }
                }
                media.setOnError {
                    val message = media.error?.message ?: "当前格式或编码不受内置播放器支持"
                    SwingUtilities.invokeLater {
                        dialog.dispose()
                        showUnsupported(project, file, message)
                    }
                }
                player.setOnReady {
                    player.play()
                }
            } catch (error: Throwable) {
                SwingUtilities.invokeLater {
                    dialog.dispose()
                    showUnsupported(project, file, error.message ?: "当前格式或编码不受内置播放器支持")
                }
            }
        }
    }

    private fun ensureFxInitialized() {
        if (fxInitialized.compareAndSet(false, true)) {
            JFXPanel()
            Platform.setImplicitExit(false)
        }
    }

    private fun createScene(
        project: Project,
        file: File,
        mediaType: String,
        player: MediaPlayer,
        dialog: JDialog
    ): Scene {
        val root = BorderPane()
        root.style = "-fx-background-color: #111827;"

        val playButton = Button("⏸")
        val timeLabel = Label("00:00 / 00:00")
        val slider = Slider(0.0, 1.0, 0.0)
        val rateBox = ComboBox(FXCollections.observableArrayList(0.1, 0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 2.5, 3.0))
        rateBox.value = 1.0
        rateBox.prefWidth = 88.0

        val center = if (mediaType == "video") {
            val mediaView = MediaView(player)
            mediaView.isPreserveRatio = true
            val stack = StackPane(mediaView)
            stack.style = "-fx-background-color: black;"
            mediaView.fitWidthProperty().bind(stack.widthProperty())
            mediaView.fitHeightProperty().bind(stack.heightProperty())
            stack.setOnMouseClicked { toggle(player, playButton) }
            stack
        } else {
            val label = Label("♪\n${file.name}")
            label.alignment = Pos.CENTER
            label.style = "-fx-font-size: 22px; -fx-text-fill: #dbeafe;"
            StackPane(label).apply {
                style = "-fx-background-color: linear-gradient(to bottom right, #1e3a8a, #312e81);"
            }
        }
        root.center = center

        slider.prefWidth = 420.0
        slider.valueChangingProperty().addListener { _, _, changing ->
            if (!changing) player.seek(Duration.millis(slider.value))
        }
        slider.setOnMouseReleased {
            player.seek(Duration.millis(slider.value))
        }

        rateBox.valueProperty().addListener { _, _, rate ->
            player.rate = rate ?: 1.0
        }

        playButton.setOnAction { toggle(player, playButton) }
        player.currentTimeProperty().addListener { _, _, current ->
            val total = player.totalDuration
            if (total != null && !total.isUnknown && total.toMillis() > 0) {
                slider.max = total.toMillis()
                if (!slider.isValueChanging) slider.value = current.toMillis()
            }
            timeLabel.text = "${format(current)} / ${format(total)}"
        }
        player.setOnPaused { playButton.text = "▶" }
        player.setOnPlaying { playButton.text = "⏸" }
        player.setOnEndOfMedia {
            playButton.text = "▶"
            player.pause()
        }

        val openExternal = Button("系统播放器")
        openExternal.setOnAction {
            runCatching { Desktop.getDesktop().open(file) }
        }
        val close = Button("关闭")
        close.setOnAction {
            player.dispose()
            dialog.dispose()
        }

        val controls = HBox(10.0, playButton, timeLabel, slider, rateBox, openExternal, close)
        controls.alignment = Pos.CENTER
        controls.padding = Insets(10.0)
        controls.style = "-fx-background-color: rgba(17, 24, 39, 0.95); -fx-text-fill: white;"
        timeLabel.style = "-fx-text-fill: #e5e7eb;"
        root.bottom = controls

        return Scene(root)
    }

    private fun toggle(player: MediaPlayer, playButton: Button) {
        if (player.status == MediaPlayer.Status.PLAYING) {
            player.pause()
            playButton.text = "▶"
        } else {
            player.play()
            playButton.text = "⏸"
        }
    }

    private fun format(duration: Duration?): String {
        if (duration == null || duration.isUnknown || duration.isIndefinite || duration.toMillis() < 0) return "00:00"
        val totalSeconds = (duration.toMillis() / 1000.0).toLong()
        val hours = totalSeconds / 3600
        val minutes = (totalSeconds % 3600) / 60
        val seconds = totalSeconds % 60
        return if (hours > 0) {
            "%02d:%02d:%02d".format(hours, minutes, seconds)
        } else {
            "%02d:%02d".format(minutes, seconds)
        }
    }

    private fun showUnsupported(project: Project, file: File, reason: String) {
        val result = Messages.showDialog(
            project,
            "暂不支持在插件内播放该格式或编码。\n\n$reason",
            "暂不支持播放",
            arrayOf("用系统默认应用打开", "取消"),
            0,
            Messages.getWarningIcon()
        )
        if (result == 0) {
            runCatching { Desktop.getDesktop().open(file) }
        }
    }
}
