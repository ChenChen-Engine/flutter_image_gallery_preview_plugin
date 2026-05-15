package com.yourorg.imagegallerypreview.metadata

import com.google.gson.JsonArray
import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.yourorg.imagegallerypreview.model.GalleryAssetItem
import java.io.File
import java.security.MessageDigest
import java.util.Base64
import java.util.Locale
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit

object VideoThumbnailProvider {
    private const val TIMEOUT_SECONDS = 8L

    private val cacheDir: File by lazy {
        File(System.getProperty("java.io.tmpdir"), "image-gallery-video-thumbs").apply {
            mkdirs()
            deleteOnExit()
        }
    }

    fun thumbnailFor(item: GalleryAssetItem): File? {
        if (item.mediaType != "video") return null
        val source = File(item.absPath)
        if (!source.isFile) return null

        val key = cacheKey(source)
        existingThumbnail(key)?.let { return it }

        extractEmbeddedCover(source, key)?.let { return it }
        return extractFrameWithFfmpeg(source, File(cacheDir, "$key.png"))
    }

    private fun existingThumbnail(key: String): File? {
        return listOf("png", "jpg", "webp")
            .map { extension -> File(cacheDir, "$key.$extension") }
            .firstOrNull { it.isFile && it.length() > 0L }
    }

    private fun extractEmbeddedCover(source: File, key: String): File? {
        for (command in mediaInfoCoverCommands(source.absolutePath)) {
            val text = runCommand(command) ?: continue
            val bytes = coverBytesFromMediaInfo(text) ?: continue
            if (bytes.isEmpty()) continue
            val output = File(cacheDir, "$key.${imageExtension(bytes)}")
            output.writeBytes(bytes)
            if (output.isFile && output.length() > 0L) return output
        }
        return null
    }

    private fun mediaInfoCoverCommands(absPath: String): List<List<String>> {
        val commands = mutableListOf<List<String>>()
        val isWindows = System.getProperty("os.name").orEmpty().lowercase(Locale.ROOT).contains("win")
        if (isWindows) {
            commands += listOf("cmd", "/c", "mediaInfo", "--Output=JSON", "--Cover_Data=base64", absPath)
        }
        MediaMetadataExtractor.resolveMediaInfoExecutable()
            ?.takeIf { it.isNotBlank() }
            ?.let { executable ->
                val direct = listOf(executable, "--Output=JSON", "--Cover_Data=base64", absPath)
                if (direct !in commands) commands += direct
            }
        if (!isWindows && commands.isEmpty()) {
            commands += listOf("mediainfo", "--Output=JSON", "--Cover_Data=base64", absPath)
        }
        return commands
    }

    private fun coverBytesFromMediaInfo(output: String): ByteArray? {
        val parsed = runCatching { JsonParser.parseString(output) }.getOrNull()
        val encoded = parsed?.let(::findCoverData)
            ?: output.lineSequence()
                .firstOrNull { it.contains("Cover", ignoreCase = true) && it.contains(":") }
                ?.substringAfter(':')
                ?.trim()
        if (encoded.isNullOrBlank()) return null

        return runCatching {
            Base64.getMimeDecoder().decode(encoded)
        }.getOrNull()
    }

    private fun findCoverData(element: JsonElement?): String? {
        return when {
            element == null || element.isJsonNull -> null
            element is JsonObject -> {
                element.entrySet().firstNotNullOfOrNull { (key, value) ->
                    if (key.equals("Cover_Data", ignoreCase = true) || key.equals("Cover data", ignoreCase = true)) {
                        value.takeIf { it.isJsonPrimitive }?.asString
                    } else {
                        findCoverData(value)
                    }
                }
            }
            element is JsonArray -> element.firstNotNullOfOrNull(::findCoverData)
            else -> null
        }
    }

    private fun extractFrameWithFfmpeg(source: File, output: File): File? {
        val attempts = listOf("00:00:01", "00:00:00")
        for (timestamp in attempts) {
            output.delete()
            val ok = runCommand(
                listOf(
                    "ffmpeg",
                    "-y",
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-ss",
                    timestamp,
                    "-i",
                    source.absolutePath,
                    "-frames:v",
                    "1",
                    "-vf",
                    "scale=360:-1",
                    output.absolutePath
                )
            ) != null
            if (ok && output.isFile && output.length() > 0L) return output
        }
        return null
    }

    private fun runCommand(command: List<String>): String? {
        return try {
            val process = ProcessBuilder(command)
                .redirectErrorStream(true)
                .start()
            val output = CompletableFuture.supplyAsync {
                process.inputStream.bufferedReader().readText()
            }
            val completed = process.waitFor(TIMEOUT_SECONDS, TimeUnit.SECONDS)
            if (!completed) {
                process.destroyForcibly()
                return null
            }
            if (process.exitValue() == 0) output.get(1, TimeUnit.SECONDS) else null
        } catch (_: Throwable) {
            null
        }
    }

    private fun imageExtension(bytes: ByteArray): String {
        return when {
            bytes.size >= 3 &&
                bytes[0] == 0xFF.toByte() &&
                bytes[1] == 0xD8.toByte() &&
                bytes[2] == 0xFF.toByte() -> "jpg"
            bytes.size >= 12 &&
                bytes[0] == 'R'.code.toByte() &&
                bytes[1] == 'I'.code.toByte() &&
                bytes[2] == 'F'.code.toByte() &&
                bytes[8] == 'W'.code.toByte() &&
                bytes[9] == 'E'.code.toByte() &&
                bytes[10] == 'B'.code.toByte() &&
                bytes[11] == 'P'.code.toByte() -> "webp"
            else -> "png"
        }
    }

    private fun cacheKey(file: File): String {
        val value = "${file.absolutePath}|${file.lastModified()}|${file.length()}"
        val digest = MessageDigest.getInstance("SHA-1").digest(value.toByteArray(Charsets.UTF_8))
        return digest.joinToString("") { "%02x".format(it) }
    }
}
