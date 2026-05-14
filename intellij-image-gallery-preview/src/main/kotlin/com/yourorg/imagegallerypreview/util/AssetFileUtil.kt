package com.yourorg.imagegallerypreview.util

import com.yourorg.imagegallerypreview.model.AssetKind
import java.awt.image.BufferedImage
import java.io.File
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.security.MessageDigest
import java.util.Locale
import javax.imageio.ImageIO

object AssetFileUtil {
    private val imageFamilies = setOf("png", "jpg", "jpeg", "webp", "gif", "bmp", "svg", "pdf",
        "heic", "heif", "apng", "avif", "ico"
    )
    private val audioFamilies = setOf("mp3", "m4a", "aac", "wav", "ogg", "opus", "flac", "amr", "mid", "midi", "caf")
    private val videoFamilies = setOf("mp4", "m4v", "mov", "webm", "mkv", "avi", "3gp", "3gpp")
    private val directFamilies = imageFamilies + audioFamilies + videoFamilies

    fun normalizePath(path: String): String = path.replace('\\', '/')

    fun fileExtension(file: File): String = file.extension.lowercase(Locale.ROOT)

    fun fileStem(file: File): String = file.nameWithoutExtension.lowercase(Locale.ROOT)

    fun detectFormatFamily(file: File, preferVectorXml: Boolean = false): String {
        val extension = fileExtension(file)
        if (extension == "json" && looksLikeLottie(file)) {
            return "lottie"
        }
        if (extension == "xml" && preferVectorXml && looksLikeVectorDrawable(file)) {
            return "vector_xml"
        }
        return if (extension in directFamilies) extension else "other"
    }

    fun assetKind(formatFamily: String): AssetKind = AssetKind.fromFormatFamily(formatFamily)

    fun isSupportedFamily(formatFamily: String): Boolean = formatFamily != "other"

    fun mediaType(formatFamily: String): String {
        return when (formatFamily.lowercase(Locale.ROOT)) {
            in audioFamilies -> "audio"
            in videoFamilies -> "video"
            else -> "image"
        }
    }

    fun isAnimated(file: File, formatFamily: String): Boolean {
        return when (formatFamily) {
            "gif", "apng", "lottie" -> true
            "webp" -> isAnimatedWebp(file)
            else -> false
        }
    }

    fun readImageSize(file: File, formatFamily: String): Pair<Int, Int>? {
        if (mediaType(formatFamily) != "image") return null
        return when (formatFamily) {
            "svg" -> readSvgSize(file)
            "vector_xml" -> readVectorDrawableSize(file)
            "lottie" -> readLottieSize(file)
            else -> readBinaryImageSize(file)
        }
    }

    fun md5Hex(file: File): String {
        return try {
            val bytes = Files.readAllBytes(file.toPath())
            MessageDigest.getInstance("MD5")
                .digest(bytes)
                .joinToString(separator = "") { "%02x".format(it) }
        } catch (_: Throwable) {
            ""
        }
    }

    fun relativePath(root: File, file: File): String {
        return normalizePath(root.toPath().relativize(file.toPath()).toString())
    }

    fun relativePath(moduleRoot: File, file: File, fallbackRoot: File): String {
        return try {
            normalizePath(moduleRoot.toPath().relativize(file.toPath()).toString())
        } catch (_: Throwable) {
            relativePath(fallbackRoot, file)
        }
    }

    fun androidCopyToken(resourceFolder: String, file: File): String {
        val prefix = when {
            resourceFolder.startsWith("mipmap") -> "R.mipmap"
            resourceFolder.startsWith("raw") -> "R.raw"
            else -> "R.drawable"
        }
        val resourceName = fileStem(file)
            .replace(Regex("[^a-z0-9_]"), "_")
            .trim('_')
            .ifBlank { "asset" }
        return "$prefix.$resourceName"
    }

    fun flutterCopyToken(moduleRoot: File, file: File): String {
        val absolute = normalizePath(file.absolutePath)
        val segments = absolute.split('/')

        for (index in segments.indices.reversed()) {
            if (segments[index].equals("res", ignoreCase = true)) {
                return segments.subList(index, segments.size).joinToString("/")
            }
        }

        for (index in segments.indices.reversed()) {
            if (segments[index].equals("assets", ignoreCase = true)) {
                return segments.subList(index, segments.size).joinToString("/")
            }
        }

        return relativePath(moduleRoot, file, moduleRoot)
    }

    fun iosCopyToken(moduleRoot: File, file: File): String {
        val absolute = normalizePath(file.absolutePath)
        val segments = absolute.split('/')

        for (index in segments.indices.reversed()) {
            if (segments[index].endsWith(".xcassets", ignoreCase = true)) {
                return segments.subList(index, segments.size).joinToString("/")
            }
        }

        return relativePath(moduleRoot, file, moduleRoot)
    }

    private fun readBinaryImageSize(file: File): Pair<Int, Int>? {
        return try {
            ImageIO.read(file)?.let { it.width to it.height }
        } catch (_: Throwable) {
            null
        }
    }

    private fun readSvgSize(file: File): Pair<Int, Int>? {
        return try {
            val text = readUtf8(file)
            val width = extractDimension(text, "width")
            val height = extractDimension(text, "height")
            if (width != null && height != null) return width to height

            val viewBox = Regex("""viewBox\s*=\s*[\"']\s*[-+]?\d+(?:\.\d+)?\s+[-+]?\d+(?:\.\d+)?\s+([-+]?\d+(?:\.\d+)?)\s+([-+]?\d+(?:\.\d+)?)[\"']""")
                .find(text)
            if (viewBox != null) {
                val vw = viewBox.groupValues[1].toDoubleOrNull()?.toInt()
                val vh = viewBox.groupValues[2].toDoubleOrNull()?.toInt()
                if (vw != null && vh != null && vw > 0 && vh > 0) return vw to vh
            }
            null
        } catch (_: Throwable) {
            null
        }
    }

    private fun extractDimension(text: String, attr: String): Int? {
        val pattern = Regex("""$attr\s*=\s*[\"']\s*([-+]?\d+(?:\.\d+)?)(?:px|pt|pc|cm|mm|in)?\s*[\"']""")
        return pattern.find(text)
            ?.groupValues
            ?.getOrNull(1)
            ?.toDoubleOrNull()
            ?.toInt()
            ?.takeIf { it > 0 }
    }

    private fun readVectorDrawableSize(file: File): Pair<Int, Int>? {
        return try {
            val text = readUtf8(file)
            val viewportW = Regex("""viewportWidth\s*=\s*[\"']\s*([-+]?\d+(?:\.\d+)?)\s*[\"']""")
                .find(text)
                ?.groupValues
                ?.getOrNull(1)
                ?.toDoubleOrNull()
                ?.toInt()
            val viewportH = Regex("""viewportHeight\s*=\s*[\"']\s*([-+]?\d+(?:\.\d+)?)\s*[\"']""")
                .find(text)
                ?.groupValues
                ?.getOrNull(1)
                ?.toDoubleOrNull()
                ?.toInt()
            if (viewportW != null && viewportH != null && viewportW > 0 && viewportH > 0) {
                return viewportW to viewportH
            }

            val width = Regex("""android:width\s*=\s*[\"']\s*([-+]?\d+(?:\.\d+)?)(?:dp|dip|px)?\s*[\"']""")
                .find(text)
                ?.groupValues
                ?.getOrNull(1)
                ?.toDoubleOrNull()
                ?.toInt()
            val height = Regex("""android:height\s*=\s*[\"']\s*([-+]?\d+(?:\.\d+)?)(?:dp|dip|px)?\s*[\"']""")
                .find(text)
                ?.groupValues
                ?.getOrNull(1)
                ?.toDoubleOrNull()
                ?.toInt()

            if (width != null && height != null && width > 0 && height > 0) width to height else null
        } catch (_: Throwable) {
            null
        }
    }

    private fun readLottieSize(file: File): Pair<Int, Int>? {
        return try {
            val text = readUtf8(file)
            val width = Regex("""\"w\"\s*:\s*(\d{1,6})""")
                .find(text)
                ?.groupValues
                ?.getOrNull(1)
                ?.toIntOrNull()
            val height = Regex("""\"h\"\s*:\s*(\d{1,6})""")
                .find(text)
                ?.groupValues
                ?.getOrNull(1)
                ?.toIntOrNull()
            if (width != null && height != null && width > 0 && height > 0) width to height else null
        } catch (_: Throwable) {
            null
        }
    }

    fun readUtf8(file: File): String = Files.readString(file.toPath(), StandardCharsets.UTF_8)

    private fun looksLikeVectorDrawable(file: File): Boolean {
        return try {
            val content = readUtf8(file)
            content.contains("<vector") && content.contains("http://schemas.android.com/apk/res/android")
        } catch (_: Throwable) {
            false
        }
    }

    fun looksLikeLottie(file: File): Boolean {
        return try {
            if (fileExtension(file) != "json") return false
            val text = readUtf8(file)
            text.contains("\"layers\"") && text.contains("\"v\"") && text.contains("\"w\"") && text.contains("\"h\"")
        } catch (_: Throwable) {
            false
        }
    }

    private fun isAnimatedWebp(file: File): Boolean {
        return try {
            val bytes = Files.readAllBytes(file.toPath())
            val text = bytes.toString(StandardCharsets.ISO_8859_1)
            text.contains("ANMF")
        } catch (_: Throwable) {
            false
        }
    }
}


