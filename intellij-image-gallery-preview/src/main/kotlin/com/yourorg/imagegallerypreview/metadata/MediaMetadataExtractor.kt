package com.yourorg.imagegallerypreview.metadata

import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.yourorg.imagegallerypreview.model.GalleryAssetItem
import com.yourorg.imagegallerypreview.util.AssetFileUtil
import java.io.File
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit

object MediaMetadataExtractor {
    private const val MEDIAINFO_DOWNLOAD_URL = "https://mediaarea.net/en/MediaInfo/Download"
    private val cache = ConcurrentHashMap<String, MediaMetadataInfo>()

    fun infoFor(item: GalleryAssetItem): MediaMetadataInfo {
        val file = File(item.absPath)
        val key = "${item.absPath}|${item.mtime}|${file.length()}|${item.mediaType}"
        return cache.computeIfAbsent(key) {
            extract(item, file)
        }
    }

    private fun extract(item: GalleryAssetItem, file: File): MediaMetadataInfo {
        if (item.mediaType == "image") {
            return ImageMetadataExtractor.infoFor(item).toMediaInfo()
        }

        tryMediaInfo(file, item.mediaType)?.let { return it }
        tryFfprobe(file, item.mediaType)?.let { return it }
        return fallbackInfo(file, item)
    }

    private fun ImageMetadataInfo.toMediaInfo(): MediaMetadataInfo {
        return MediaMetadataInfo(
            mediaType = "image",
            source = "Built-in",
            sections = listOf(
                MetadataSection(
                    title = "Image",
                    rows = listOf(
                        MetadataRow("width", width),
                        MetadataRow("height", height),
                        MetadataRow("color Space", colorSpace),
                        MetadataRow("chroma subsampling", chromaSubsampling),
                        MetadataRow("bit depth", bitDepth),
                        MetadataRow("compression mode", compressionMode),
                        MetadataRow("stream size", streamSize),
                        MetadataRow("file size", fileSize),
                        MetadataRow("format", format),
                        MetadataRow("abs path", absPath)
                    )
                )
            )
        )
    }

    private fun tryMediaInfo(file: File, mediaType: String): MediaMetadataInfo? {
        val executable = findMediaInfoExecutable() ?: return null
        val output = runCommand(listOf(executable, "--Output=JSON", file.absolutePath)) ?: return null
        val root = runCatching { JsonParser.parseString(output).asJsonObject }.getOrNull() ?: return null
        val tracks = root.getAsJsonObject("media")?.getAsJsonArray("track") ?: return null
        val sections = tracks.mapNotNull { element ->
            val track = element as? JsonObject ?: return@mapNotNull null
            val title = track.get("@type")?.asString ?: "General"
            val rows = track.entrySet()
                .asSequence()
                .filter { !it.key.startsWith("@") && it.value.isJsonPrimitive }
                .take(80)
                .map { MetadataRow(humanizeKey(it.key), it.value.asString.ifBlank { "Unknown" }) }
                .toList()
            if (rows.isEmpty()) null else MetadataSection(title, rows)
        }
        return if (sections.isEmpty()) null else MediaMetadataInfo(mediaType, "MediaInfo ($executable)", sections)
    }

    private fun tryFfprobe(file: File, mediaType: String): MediaMetadataInfo? {
        val output = runCommand(
            listOf(
                "ffprobe",
                "-v",
                "quiet",
                "-print_format",
                "json",
                "-show_format",
                "-show_streams",
                file.absolutePath
            )
        ) ?: return null
        val root = runCatching { JsonParser.parseString(output).asJsonObject }.getOrNull() ?: return null
        val sections = mutableListOf<MetadataSection>()

        root.getAsJsonObject("format")?.let { format ->
            sections += MetadataSection(
                "General",
                listOf(
                    MetadataRow("Complete name", AssetFileUtil.normalizePath(file.absolutePath)),
                    MetadataRow("Format", stringValue(format, "format_long_name", "format_name")),
                    MetadataRow("File size", format.get("size")?.asLongOrNull()?.let(ImageMetadataInfo::readableBytes) ?: "Unknown"),
                    MetadataRow("Duration", formatSeconds(format.get("duration")?.asString)),
                    MetadataRow("Overall bit rate", format.get("bit_rate")?.asLongOrNull()?.let { "${it / 1000} kb/s" } ?: "Unknown")
                )
            )
        }

        root.getAsJsonArray("streams")?.forEach { element ->
            val stream = element as? JsonObject ?: return@forEach
            val title = when (stream.get("codec_type")?.asString) {
                "audio" -> "Audio"
                "video" -> "Video"
                else -> return@forEach
            }
            sections += MetadataSection(
                title,
                listOf(
                    MetadataRow("Format", stringValue(stream, "codec_long_name", "codec_name")),
                    MetadataRow("Codec ID", stringValue(stream, "codec_tag_string")),
                    MetadataRow("Duration", formatSeconds(stream.get("duration")?.asString)),
                    MetadataRow("Bit rate", stream.get("bit_rate")?.asLongOrNull()?.let { "${it / 1000} kb/s" } ?: "Unknown"),
                    MetadataRow("Width", stream.get("width")?.asIntOrNull()?.let { "$it pixels" } ?: "Unknown"),
                    MetadataRow("Height", stream.get("height")?.asIntOrNull()?.let { "$it pixels" } ?: "Unknown"),
                    MetadataRow("Frame rate", stringValue(stream, "avg_frame_rate")),
                    MetadataRow("Channel(s)", stream.get("channels")?.asIntOrNull()?.let { "$it channels" } ?: "Unknown"),
                    MetadataRow("Sampling rate", stream.get("sample_rate")?.asString?.toDoubleOrNull()?.let { "${it / 1000.0} kHz" } ?: "Unknown"),
                    MetadataRow("Color space", stringValue(stream, "color_space")),
                    MetadataRow("Chroma subsampling", stringValue(stream, "chroma_location")),
                    MetadataRow("Bit depth", stringValue(stream, "bits_per_raw_sample", "bits_per_sample"))
                )
            )
        }

        return if (sections.isEmpty()) null else MediaMetadataInfo(mediaType, "ffprobe", sections)
    }

    private fun fallbackInfo(file: File, item: GalleryAssetItem): MediaMetadataInfo {
        val fileSize = if (file.exists()) ImageMetadataInfo.readableBytes(file.length()) else "Unknown"
        val format = file.extension.uppercase(Locale.ROOT).ifBlank { "Unknown" }
        val streamTitle = if (item.mediaType == "video") "Video" else "Audio"
        return MediaMetadataInfo(
            mediaType = item.mediaType,
            source = "Built-in",
            sections = listOf(
                MetadataSection(
                    "General",
                    listOf(
                        MetadataRow("Complete name", AssetFileUtil.normalizePath(file.absolutePath)),
                        MetadataRow("Format", format),
                        MetadataRow("File size", fileSize),
                        MetadataRow("Duration", formatMillis(item.durationMillis)),
                        MetadataRow("Overall bit rate", "Unknown")
                    )
                ),
                MetadataSection(
                    streamTitle,
                    listOf(
                        MetadataRow("Format", format),
                        MetadataRow("Duration", formatMillis(item.durationMillis)),
                        MetadataRow("Bit rate", "Unknown"),
                        MetadataRow("Compression mode", "Unknown"),
                        MetadataRow("Stream size", fileSize)
                    )
                )
            ),
            installHint = InstallHint(
                text = "安装 MediaInfo 可解析更多数据",
                actionLabel = "去下载",
                url = MEDIAINFO_DOWNLOAD_URL
            )
        )
    }

    private fun runCommand(command: List<String>): String? {
        return try {
            val process = ProcessBuilder(command)
                .redirectErrorStream(true)
                .start()
            if (!process.waitFor(8, TimeUnit.SECONDS)) {
                process.destroyForcibly()
                return null
            }
            if (process.exitValue() != 0) return null
            process.inputStream.bufferedReader().readText().takeIf { it.isNotBlank() }
        } catch (_: Throwable) {
            null
        }
    }

    internal fun findMediaInfoExecutable(
        env: Map<String, String> = System.getenv(),
        pathExists: (String) -> Boolean = { candidate -> File(candidate).exists() },
        pathExecutable: (String) -> Boolean = { candidate -> File(candidate).canExecute() },
        osName: String = System.getProperty("os.name").orEmpty()
    ): String? {
        env["MEDIAINFO_PATH"]
            ?.trim()
            ?.takeIf { it.isNotBlank() }
            ?.let { configured ->
                if (pathExists(configured)) return configured
            }

        val pathSeparator = File.pathSeparatorChar
        val pathExts = if (osName.lowercase(Locale.ROOT).contains("win")) {
            listOf("", ".exe", ".cmd", ".bat")
        } else {
            listOf("")
        }
        val commandNames = listOf("MediaInfo", "MediaInfo.exe", "mediainfo")
        val pathDirs = env["PATH"].orEmpty().split(pathSeparator).filter { it.isNotBlank() }
        for (dir in pathDirs) {
            for (name in commandNames) {
                val candidates = if (name.contains('.')) listOf(name) else pathExts.map { "$name$it" }
                for (candidateName in candidates) {
                    val candidate = File(dir, candidateName).absolutePath
                    if (pathExists(candidate) && pathExecutable(candidate)) return candidate
                }
            }
        }

        if (osName.lowercase(Locale.ROOT).contains("win")) {
            val commonPaths = listOf(
                "C:\\Program Files\\MediaInfo\\MediaInfo.exe",
                "C:\\Program Files (x86)\\MediaInfo\\MediaInfo.exe"
            )
            return commonPaths.firstOrNull { pathExists(it) }
        }

        return null
    }

    private fun stringValue(json: JsonObject, vararg keys: String): String {
        return keys.firstNotNullOfOrNull { key ->
            json.get(key)?.takeIf { !it.isJsonNull }?.asString?.takeIf { it.isNotBlank() }
        } ?: "Unknown"
    }

    private fun formatMillis(value: Long?): String {
        if (value == null || value <= 0L) return "Unknown"
        return formatSeconds((value / 1000.0).toString())
    }

    private fun formatSeconds(raw: String?): String {
        val secondsValue = raw?.toDoubleOrNull() ?: return "Unknown"
        if (secondsValue <= 0.0) return "Unknown"
        val totalMillis = (secondsValue * 1000.0).toLong()
        val totalSeconds = totalMillis / 1000L
        val hours = totalSeconds / 3600L
        val minutes = (totalSeconds % 3600L) / 60L
        val seconds = totalSeconds % 60L
        val millis = totalMillis % 1000L
        val base = when {
            hours > 0 -> "$hours h $minutes min $seconds s"
            minutes > 0 -> "$minutes min $seconds s"
            else -> "$seconds s"
        }
        return if (millis > 0) "$base $millis ms" else base
    }

    private fun humanizeKey(key: String): String {
        return key
            .replace(Regex("_String\\d*$", RegexOption.IGNORE_CASE), "")
            .replace('_', ' ')
            .replace(Regex("([a-z])([A-Z])"), "$1 $2")
            .trim()
    }
}

private fun com.google.gson.JsonElement.asLongOrNull(): Long? = runCatching { asLong }.getOrNull()

private fun com.google.gson.JsonElement.asIntOrNull(): Int? = runCatching { asInt }.getOrNull()
