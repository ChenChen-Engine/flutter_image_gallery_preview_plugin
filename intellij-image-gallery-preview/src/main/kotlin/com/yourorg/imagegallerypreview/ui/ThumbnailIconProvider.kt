package com.yourorg.imagegallerypreview.ui

import com.intellij.icons.AllIcons
import com.intellij.openapi.application.ApplicationManager
import com.intellij.ui.JBColor
import com.yourorg.imagegallerypreview.model.AssetKind
import com.yourorg.imagegallerypreview.model.GalleryAssetItem
import java.awt.BasicStroke
import java.awt.Color
import java.awt.Font
import java.awt.Image
import java.awt.RenderingHints
import java.awt.image.BufferedImage
import java.io.File
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap
import javax.imageio.ImageIO
import javax.swing.Icon
import javax.swing.ImageIcon

object ThumbnailIconProvider {
    private val cache = ConcurrentHashMap<String, Icon>()
    private val failedKeys = ConcurrentHashMap.newKeySet<String>()
    private val loadingKeys = ConcurrentHashMap.newKeySet<String>()

    fun placeholderFor(item: GalleryAssetItem, size: Int): Icon {
        val key = cacheKey(item, size)
        cache[key]?.let { return it }
        return when (item.kind) {
            AssetKind.PNG,
            AssetKind.JPG,
            AssetKind.JPEG,
            AssetKind.WEBP,
            AssetKind.GIF,
            AssetKind.BMP,
            AssetKind.APNG,
            AssetKind.AVIF,
            AssetKind.HEIC,
            AssetKind.HEIF,
            AssetKind.ICO -> createLoadingPlaceholder(size)

            AssetKind.SVG,
            AssetKind.LOTTIE,
            AssetKind.VECTOR_XML,
            AssetKind.PDF,
            AssetKind.XML,
            AssetKind.MP3,
            AssetKind.M4A,
            AssetKind.AAC,
            AssetKind.WAV,
            AssetKind.OGG,
            AssetKind.OPUS,
            AssetKind.FLAC,
            AssetKind.AMR,
            AssetKind.MID,
            AssetKind.MIDI,
            AssetKind.CAF,
            AssetKind.WMA,
            AssetKind.AIFF,
            AssetKind.AIF,
            AssetKind.ALAC,
            AssetKind.MKA,
            AssetKind.MP4,
            AssetKind.M4V,
            AssetKind.MOV,
            AssetKind.WEBM,
            AssetKind.MKV,
            AssetKind.AVI,
            AssetKind.THREE_GP,
            AssetKind.THREE_GPP,
            AssetKind.MPEG,
            AssetKind.MPG,
            AssetKind.TS,
            AssetKind.M2TS,
            AssetKind.WMV,
            AssetKind.FLV -> createTypePlaceholder(item.formatFamily, size)

            AssetKind.OTHER -> AllIcons.FileTypes.Any_type
        }
    }

    fun loadInto(item: GalleryAssetItem, size: Int, onReady: (Icon, Boolean) -> Unit) {
        val key = cacheKey(item, size)
        cache[key]?.let {
            onReady(it, failedKeys.contains(key))
            return
        }

        if (!isRasterKind(item.kind)) {
            val icon = placeholderFor(item, size)
            cache.putIfAbsent(key, icon)
            onReady(cache[key] ?: icon, false)
            return
        }

        if (!loadingKeys.add(key)) {
            return
        }

        ApplicationManager.getApplication().executeOnPooledThread {
            val loaded = createRasterIcon(item.absPath, size)
            val failed = loaded == null
            val resolved = if (failed) {
                failedKeys += key
                createFailedPlaceholder(size)
            } else {
                failedKeys -= key
                loaded
            } ?: createFailedPlaceholder(size)

            cache[key] = resolved
            loadingKeys.remove(key)

            ApplicationManager.getApplication().invokeLater {
                onReady(resolved, failed)
            }
        }
    }

    fun isLoadFailed(item: GalleryAssetItem, size: Int): Boolean {
        return failedKeys.contains(cacheKey(item, size))
    }

    private fun cacheKey(item: GalleryAssetItem, size: Int): String {
        return "${item.absPath}|${item.mtime}|$size"
    }

    private fun createRasterIcon(path: String, size: Int): Icon? {
        return try {
            val image = ImageIO.read(File(path)) ?: return null
            val scaled = scaleToBox(image, size, size)
            ImageIcon(scaled)
        } catch (_: Throwable) {
            null
        }
    }

    private fun scaleToBox(image: BufferedImage, boxW: Int, boxH: Int): BufferedImage {
        val ratio = minOf(boxW.toDouble() / image.width.toDouble(), boxH.toDouble() / image.height.toDouble())
        val targetW = maxOf(1, (image.width * ratio).toInt())
        val targetH = maxOf(1, (image.height * ratio).toInt())
        val scaledImage = image.getScaledInstance(targetW, targetH, Image.SCALE_SMOOTH)

        val output = BufferedImage(boxW, boxH, BufferedImage.TYPE_INT_ARGB)
        val g = output.createGraphics()
        g.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BILINEAR)
        g.color = JBColor(Color(245, 245, 245), Color(55, 55, 55))
        g.fillRect(0, 0, boxW, boxH)

        val x = (boxW - targetW) / 2
        val y = (boxH - targetH) / 2
        g.drawImage(scaledImage, x, y, null)
        g.dispose()
        return output
    }

    private fun createTypePlaceholder(typeText: String, size: Int): Icon {
        val img = BufferedImage(size, size, BufferedImage.TYPE_INT_ARGB)
        val g = img.createGraphics()
        g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON)
        g.color = JBColor(Color(235, 245, 255), Color(45, 60, 78))
        g.fillRoundRect(0, 0, size - 1, size - 1, 12, 12)
        g.color = JBColor(Color(90, 120, 190), Color(165, 190, 255))
        g.stroke = BasicStroke(2f)
        g.drawRoundRect(1, 1, size - 3, size - 3, 12, 12)

        val label = typeText.uppercase(Locale.ROOT).take(6)
        g.font = Font(Font.SANS_SERIF, Font.BOLD, maxOf(10, size / 7))
        val fm = g.fontMetrics
        val tx = (size - fm.stringWidth(label)) / 2
        val ty = (size - fm.height) / 2 + fm.ascent
        g.drawString(label, tx, ty)

        g.dispose()
        return ImageIcon(img)
    }

    private fun createFailedPlaceholder(size: Int): Icon {
        val img = BufferedImage(size, size, BufferedImage.TYPE_INT_ARGB)
        val g = img.createGraphics()
        g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON)
        g.color = JBColor(Color(255, 238, 238), Color(88, 40, 40))
        g.fillRoundRect(0, 0, size - 1, size - 1, 12, 12)
        g.color = JBColor(Color(210, 70, 70), Color(255, 140, 140))
        g.stroke = BasicStroke(2f)
        g.drawRoundRect(1, 1, size - 3, size - 3, 12, 12)
        g.drawLine(8, 8, size - 8, size - 8)
        g.drawLine(size - 8, 8, 8, size - 8)
        g.dispose()
        return ImageIcon(img)
    }

    private fun createLoadingPlaceholder(size: Int): Icon {
        val img = BufferedImage(size, size, BufferedImage.TYPE_INT_ARGB)
        val g = img.createGraphics()
        g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON)
        g.color = JBColor(Color(242, 245, 249), Color(52, 57, 64))
        g.fillRoundRect(0, 0, size - 1, size - 1, 12, 12)
        g.color = JBColor(Color(124, 136, 150), Color(190, 198, 210))
        g.stroke = BasicStroke(2f)
        g.drawRoundRect(1, 1, size - 3, size - 3, 12, 12)

        val label = "IMG"
        g.font = Font(Font.SANS_SERIF, Font.BOLD, maxOf(10, size / 7))
        val fm = g.fontMetrics
        val tx = (size - fm.stringWidth(label)) / 2
        val ty = (size - fm.height) / 2 + fm.ascent
        g.drawString(label, tx, ty)
        g.dispose()
        return ImageIcon(img)
    }

    private fun isRasterKind(kind: AssetKind): Boolean {
        return when (kind) {
            AssetKind.PNG,
            AssetKind.JPG,
            AssetKind.JPEG,
            AssetKind.WEBP,
            AssetKind.GIF,
            AssetKind.BMP,
            AssetKind.APNG,
            AssetKind.AVIF,
            AssetKind.HEIC,
            AssetKind.HEIF,
            AssetKind.ICO -> true

            AssetKind.SVG,
            AssetKind.LOTTIE,
            AssetKind.VECTOR_XML,
            AssetKind.PDF,
            AssetKind.XML,
            AssetKind.MP3,
            AssetKind.M4A,
            AssetKind.AAC,
            AssetKind.WAV,
            AssetKind.OGG,
            AssetKind.OPUS,
            AssetKind.FLAC,
            AssetKind.AMR,
            AssetKind.MID,
            AssetKind.MIDI,
            AssetKind.CAF,
            AssetKind.WMA,
            AssetKind.AIFF,
            AssetKind.AIF,
            AssetKind.ALAC,
            AssetKind.MKA,
            AssetKind.MP4,
            AssetKind.M4V,
            AssetKind.MOV,
            AssetKind.WEBM,
            AssetKind.MKV,
            AssetKind.AVI,
            AssetKind.THREE_GP,
            AssetKind.THREE_GPP,
            AssetKind.MPEG,
            AssetKind.MPG,
            AssetKind.TS,
            AssetKind.M2TS,
            AssetKind.WMV,
            AssetKind.FLV,
            AssetKind.OTHER -> false
        }
    }
}
