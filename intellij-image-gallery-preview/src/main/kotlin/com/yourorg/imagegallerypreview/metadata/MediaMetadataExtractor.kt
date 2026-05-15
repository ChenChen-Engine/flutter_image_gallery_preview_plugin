package com.yourorg.imagegallerypreview.metadata

import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.yourorg.imagegallerypreview.model.GalleryAssetItem
import com.yourorg.imagegallerypreview.util.AssetFileUtil
import java.io.File
import java.util.LinkedHashMap
import java.util.Locale
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import javafx.application.Platform
import javafx.embed.swing.JFXPanel
import javafx.scene.media.Media
import javafx.scene.media.MediaPlayer
import javafx.util.Duration

data class MediaMetadataResult(
    val info: MediaMetadataInfo,
    val durationMillis: Long? = null,
    val imageInfo: ImageMetadataInfo? = null
)

object MediaMetadataExtractor {
    private const val MEDIAINFO_DOWNLOAD_URL = "https://mediaarea.net/en/MediaInfo/Download/Windows"
    private const val UNKNOWN = "Unknown"
    private const val TIMEOUT_FALLBACK_SOURCE = "Timed out fallback"

    private val cache = ConcurrentHashMap<String, MediaMetadataResult>()
    private val fxInitialized = AtomicBoolean(false)
    private var mediaInfoExecutableResolver: () -> String? = createMediaInfoExecutableResolver()

    fun infoFor(item: GalleryAssetItem, force: Boolean = false): MediaMetadataInfo = extractFor(item, force).info

    fun isTimeoutFallback(info: MediaMetadataInfo?): Boolean {
        return isRetryableFallback(info)
    }

    fun isRetryableFallback(info: MediaMetadataInfo?): Boolean {
        val source = info?.source?.lowercase(Locale.ROOT) ?: return false
        return source.startsWith(TIMEOUT_FALLBACK_SOURCE.lowercase(Locale.ROOT)) ||
            source.contains("timeout") ||
            source.contains("parse-empty") ||
            source.contains("command-failed") ||
            source.contains("fallback")
    }

    fun failureReason(info: MediaMetadataInfo?): String? {
        val source = info?.source?.lowercase(Locale.ROOT) ?: return null
        return when {
            source.startsWith(TIMEOUT_FALLBACK_SOURCE.lowercase(Locale.ROOT)) || source.contains("timed out") || source.contains("timeout") -> "timeout"
            source.contains("parse-empty") -> "parse-empty"
            source.contains("command-failed") -> "command-failed"
            source.contains("fallback") -> "fallback"
            else -> null
        }
    }

    fun clearCache() {
        cache.clear()
    }

    internal fun createMediaInfoExecutableResolver(
        finder: () -> String? = { findMediaInfoExecutable() }
    ): () -> String? {
        var resolved = false
        var cached: String? = null
        return {
            if (!resolved) {
                cached = finder()
                resolved = true
            }
            cached
        }
    }

    internal fun resolveMediaInfoExecutable(): String? = mediaInfoExecutableResolver()

    internal fun clearMediaInfoExecutableCache() {
        mediaInfoExecutableResolver = createMediaInfoExecutableResolver()
    }

    fun extractFor(item: GalleryAssetItem, force: Boolean = false): MediaMetadataResult {
        val file = File(item.absPath)
        val key = "${item.absPath}|${item.mtime}|${file.length()}|${item.mediaType}"
        if (force) {
            cache.remove(key)
            val result = extract(item, file)
            cache[key] = result
            return result
        }
        return cache.computeIfAbsent(key) {
            extract(item, file)
        }
    }

    fun timeoutFallbackFor(item: GalleryAssetItem, reason: String = "metadata extraction timed out"): MediaMetadataResult {
        val file = File(item.absPath)
        val durationMillis = item.durationMillis
        if (item.mediaType == "image") {
            val fileSize = if (file.exists()) file.length() else -1L
            val imageInfo = ImageMetadataInfo(
                width = item.width?.toString() ?: UNKNOWN,
                height = item.height?.toString() ?: UNKNOWN,
                colorSpace = UNKNOWN,
                chromaSubsampling = UNKNOWN,
                bitDepth = UNKNOWN,
                compressionMode = UNKNOWN,
                streamSize = ImageMetadataInfo.readableBytes(fileSize),
                fileSize = ImageMetadataInfo.readableBytes(fileSize),
                format = item.format.uppercase(Locale.ROOT),
                absPath = AssetFileUtil.normalizePath(item.absPath)
            )
            return MediaMetadataResult(
                info = imageInfo.toMediaInfo(source = timeoutFallbackSource(reason)),
                imageInfo = imageInfo
            )
        }

        return MediaMetadataResult(
            info = fallbackInfo(file, item, durationMillis).copy(
                source = timeoutFallbackSource(reason),
                installHint = null
            ),
            durationMillis = durationMillis
        )
    }

    private fun timeoutFallbackSource(reason: String): String {
        val label = if (reason.contains("timed out", ignoreCase = true)) "timeout" else "fallback"
        return "MediaInfo ($label: $reason; click i to retry)"
    }

    internal fun mediaInfoProbeCommands(
        absPath: String,
        osName: String = System.getProperty("os.name").orEmpty(),
        configuredExecutable: String? = resolveMediaInfoExecutable()
    ): List<List<String>> {
        val commands = mutableListOf<List<String>>()
        val isWindows = osName.lowercase(Locale.ROOT).contains("win")
        if (isWindows) {
            commands += listOf("cmd", "/c", "mediaInfo", "--output=json", absPath)
        }

        configuredExecutable
            ?.takeIf { it.isNotBlank() }
            ?.let { executable ->
                val direct = listOf(executable, "--output=json", absPath)
                if (direct !in commands) commands += direct
            }

        if (!isWindows && commands.isEmpty()) {
            commands += listOf("mediainfo", "--output=json", absPath)
        }
        return commands
    }

    internal fun durationMillisFrom(info: MediaMetadataInfo?): Long? {
        val rows = info?.sections.orEmpty().flatMap { it.rows }
        val exact = rows.firstOrNull { it.label.trim().equals("duration", ignoreCase = true) }?.value
        val fuzzy = rows.firstOrNull { it.label.trim().lowercase(Locale.ROOT).startsWith("duration") }?.value
        return parseDurationMillis(exact ?: fuzzy)
    }

    private fun extract(item: GalleryAssetItem, file: File): MediaMetadataResult {
        return if (item.mediaType == "image") {
            extractImage(item, file)
        } else {
            extractPlayableMedia(item, file)
        }
    }

    private fun extractImage(item: GalleryAssetItem, file: File): MediaMetadataResult {
        val imageInfo = ImageMetadataExtractor.infoFor(item)
        val builtInInfo = imageInfo.toMediaInfo()
        val mediaInfo = tryMediaInfo(file, item.mediaType)
        val merged = mergeInfos(item.mediaType, listOf(mediaInfo, builtInInfo))
        return MediaMetadataResult(
            info = merged ?: builtInInfo,
            durationMillis = null,
            imageInfo = imageInfo
        )
    }

    private fun extractPlayableMedia(item: GalleryAssetItem, file: File): MediaMetadataResult {
        val mediaInfo = tryMediaInfo(file, item.mediaType)
        val javaFxInfo = tryJavaFx(file, item.mediaType)
        val ffprobeInfo = tryFfprobe(file, item.mediaType)
        val merged = mergeInfos(
            item.mediaType,
            listOf(
                mediaInfo,
                javaFxInfo?.info,
                ffprobeInfo
            )
        )

        val durationMillis = durationMillisFrom(merged)
            ?: javaFxInfo?.durationMillis
            ?: durationMillisFrom(ffprobeInfo)
            ?: item.durationMillis

        val fallback = fallbackInfo(file, item, durationMillis)
        return MediaMetadataResult(
            info = merged ?: fallback,
            durationMillis = durationMillis
        )
    }

    private fun ImageMetadataInfo.toMediaInfo(source: String = "Built-in"): MediaMetadataInfo {
        return MediaMetadataInfo(
            mediaType = "image",
            source = source,
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
        val commands = mediaInfoProbeCommands(file.absolutePath)
        var bestFailure: MediaInfoFailure? = if (commands.isEmpty()) {
            MediaInfoFailure(MediaInfoFailureReason.COMMAND_FAILED)
        } else {
            null
        }
        for (command in commands) {
            when (val result = runMediaInfoCommand(command)) {
                is MediaInfoCommandResult.Success -> {
                    val info = parseMediaInfoOutput(result.output, mediaType)
                    if (info != null) return info
                    bestFailure = preferMediaInfoFailure(bestFailure, MediaInfoFailure(MediaInfoFailureReason.PARSE_EMPTY))
                }

                is MediaInfoCommandResult.Failed -> {
                    bestFailure = preferMediaInfoFailure(bestFailure, MediaInfoFailure(result.reason))
                }
            }
        }
        return mediaInfoFailureInfo(mediaType, bestFailure?.reason ?: MediaInfoFailureReason.FALLBACK)
    }

    private enum class MediaInfoFailureReason(val label: String, val priority: Int) {
        TIMEOUT("timeout", 4),
        PARSE_EMPTY("parse-empty", 3),
        COMMAND_FAILED("command-failed", 2),
        FALLBACK("fallback", 1)
    }

    private data class MediaInfoFailure(val reason: MediaInfoFailureReason)

    private sealed class MediaInfoCommandResult {
        data class Success(val output: String) : MediaInfoCommandResult()
        data class Failed(val reason: MediaInfoFailureReason) : MediaInfoCommandResult()
    }

    private fun preferMediaInfoFailure(current: MediaInfoFailure?, next: MediaInfoFailure): MediaInfoFailure {
        return if (current == null || next.reason.priority > current.reason.priority) next else current
    }

    private fun mediaInfoFailureInfo(mediaType: String, reason: MediaInfoFailureReason): MediaMetadataInfo {
        return MediaMetadataInfo(
            mediaType = mediaType,
            source = "MediaInfo (${reason.label})",
            sections = emptyList(),
            installHint = InstallHint(
                text = "Install MediaInfo CLI for richer metadata.",
                actionLabel = "Download CLI",
                url = MEDIAINFO_DOWNLOAD_URL
            )
        )
    }

    internal fun parseMediaInfoOutput(output: String, mediaType: String): MediaMetadataInfo? {
        return parseMediaInfoJson(output, mediaType) ?: parseMediaInfoText(output, mediaType)
    }

    internal fun parseMediaInfoJson(output: String, mediaType: String): MediaMetadataInfo? {
        val root = runCatching { JsonParser.parseString(output).asJsonObject }.getOrNull() ?: return null
        val tracks = root.getAsJsonObject("media")?.getAsJsonArray("track") ?: return null
        val sections = tracks.mapNotNull { element ->
            val track = element as? JsonObject ?: return@mapNotNull null
            val title = track.get("@type")?.asString ?: "General"
            val rows = track.entrySet()
                .asSequence()
                .filter { !it.key.startsWith("@") && it.value.isJsonPrimitive }
                .map { MetadataRow(humanizeKey(it.key), it.value.asString.ifBlank { UNKNOWN }) }
                .toList()
            if (rows.isEmpty()) null else MetadataSection(title, rows)
        }
        return if (sections.isEmpty()) null else MediaMetadataInfo(mediaType, "MediaInfo", sections)
    }

    private fun parseMediaInfoText(output: String, mediaType: String): MediaMetadataInfo? {
        val sections = mutableListOf<MetadataSection>()
        var currentTitle: String? = null
        val rows = mutableListOf<MetadataRow>()

        fun flush() {
            val title = currentTitle?.takeIf { it.isNotBlank() } ?: return
            if (rows.isNotEmpty()) {
                sections += MetadataSection(title, rows.toList())
                rows.clear()
            }
        }

        output.lineSequence()
            .map { it.trim() }
            .forEach { line ->
                if (line.isBlank()) {
                    flush()
                    currentTitle = null
                    return@forEach
                }

                val separator = line.indexOf(':')
                if (separator <= 0) {
                    flush()
                    currentTitle = line
                    return@forEach
                }

                val label = line.substring(0, separator).trim()
                val value = line.substring(separator + 1).trim().ifBlank { UNKNOWN }
                if (label.isNotBlank()) {
                    if (currentTitle == null) currentTitle = "General"
                    rows += MetadataRow(label, value)
                }
            }
        flush()

        return if (sections.isEmpty()) null else MediaMetadataInfo(mediaType, "MediaInfo", sections)
    }

    private fun tryJavaFx(file: File, mediaType: String): MediaMetadataResult? {
        return try {
            ensureFxInitialized()
            val future = CompletableFuture<MediaMetadataResult?>()
            Platform.runLater {
                try {
                    val media = Media(file.toURI().toString())
                    val player = MediaPlayer(media)
                    val completed = AtomicBoolean(false)

                    fun finish(result: MediaMetadataResult?) {
                        if (completed.compareAndSet(false, true)) {
                            runCatching { player.dispose() }
                            future.complete(result)
                        }
                    }

                    player.setOnReady {
                        val durationMillis = player.totalDuration.toMillisOrNull()
                        val generalRows = mutableListOf(
                            MetadataRow("Complete name", AssetFileUtil.normalizePath(file.absolutePath)),
                            MetadataRow("Format", file.extension.uppercase(Locale.ROOT).ifBlank { UNKNOWN }),
                            MetadataRow("File size", ImageMetadataInfo.readableBytes(file.length()))
                        )
                        durationMillis?.let { generalRows += MetadataRow("Duration", formatDurationMillis(it)) }

                        val streamRows = mutableListOf<MetadataRow>()
                        durationMillis?.let { streamRows += MetadataRow("Duration", formatDurationMillis(it)) }
                        if (mediaType == "video") {
                            if (media.width > 0) streamRows += MetadataRow("Width", "${media.width} pixels")
                            if (media.height > 0) streamRows += MetadataRow("Height", "${media.height} pixels")
                        }

                        media.metadata.entries
                            .sortedBy { it.key.lowercase(Locale.ROOT) }
                            .forEach { (key, value) ->
                                val normalizedKey = humanizeKey(key)
                                val text = value?.toString()?.takeIf { it.isNotBlank() } ?: return@forEach
                                val target = if (
                                    normalizedKey.equals("artist", ignoreCase = true) ||
                                    normalizedKey.equals("album", ignoreCase = true) ||
                                    normalizedKey.equals("title", ignoreCase = true) ||
                                    normalizedKey.equals("genre", ignoreCase = true)
                                ) {
                                    streamRows
                                } else {
                                    generalRows
                                }
                                if (target.none { it.label.equals(normalizedKey, ignoreCase = true) }) {
                                    target += MetadataRow(normalizedKey, text)
                                }
                            }

                        val sections = mutableListOf(MetadataSection("General", generalRows))
                        if (streamRows.isNotEmpty()) {
                            sections += MetadataSection(if (mediaType == "video") "Video" else "Audio", streamRows)
                        }

                        finish(
                            MediaMetadataResult(
                                info = MediaMetadataInfo(mediaType, "JavaFX", sections),
                                durationMillis = durationMillis
                            )
                        )
                    }

                    val fail = { _: Throwable? -> finish(null) }
                    player.setOnError { fail(player.error) }
                    media.setOnError { fail(media.error) }
                } catch (_: Throwable) {
                    future.complete(null)
                }
            }
            future.get(5, TimeUnit.SECONDS)
        } catch (_: Throwable) {
            null
        }
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
                    MetadataRow("File size", format.get("size")?.asLongOrNull()?.let(ImageMetadataInfo::readableBytes) ?: UNKNOWN),
                    MetadataRow("Duration", formatSeconds(format.get("duration")?.asString)),
                    MetadataRow("Overall bit rate", format.get("bit_rate")?.asLongOrNull()?.let { "${it / 1000} kb/s" } ?: UNKNOWN)
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
                    MetadataRow("Bit rate", stream.get("bit_rate")?.asLongOrNull()?.let { "${it / 1000} kb/s" } ?: UNKNOWN),
                    MetadataRow("Width", stream.get("width")?.asIntOrNull()?.let { "$it pixels" } ?: UNKNOWN),
                    MetadataRow("Height", stream.get("height")?.asIntOrNull()?.let { "$it pixels" } ?: UNKNOWN),
                    MetadataRow("Frame rate", stringValue(stream, "avg_frame_rate")),
                    MetadataRow("Channel(s)", stream.get("channels")?.asIntOrNull()?.let { "$it channels" } ?: UNKNOWN),
                    MetadataRow("Sampling rate", stream.get("sample_rate")?.asString?.toDoubleOrNull()?.let { "${it / 1000.0} kHz" } ?: UNKNOWN),
                    MetadataRow("Color space", stringValue(stream, "color_space")),
                    MetadataRow("Chroma subsampling", stringValue(stream, "chroma_location")),
                    MetadataRow("Bit depth", stringValue(stream, "bits_per_raw_sample", "bits_per_sample"))
                )
            )
        }

        return if (sections.isEmpty()) null else MediaMetadataInfo(mediaType, "ffprobe", sections)
    }

    private fun fallbackInfo(file: File, item: GalleryAssetItem, durationMillis: Long?): MediaMetadataInfo {
        val fileSize = if (file.exists()) ImageMetadataInfo.readableBytes(file.length()) else UNKNOWN
        val format = file.extension.uppercase(Locale.ROOT).ifBlank { UNKNOWN }
        val streamTitle = if (item.mediaType == "video") "Video" else "Audio"
        return MediaMetadataInfo(
            mediaType = item.mediaType,
            source = "Built-in (fallback)",
            sections = listOf(
                MetadataSection(
                    "General",
                    listOf(
                        MetadataRow("Complete name", AssetFileUtil.normalizePath(file.absolutePath)),
                        MetadataRow("Format", format),
                        MetadataRow("File size", fileSize),
                        MetadataRow("Duration", durationMillis?.let(::formatDurationMillis) ?: UNKNOWN),
                        MetadataRow("Overall bit rate", UNKNOWN)
                    )
                ),
                MetadataSection(
                    streamTitle,
                    listOf(
                        MetadataRow("Format", format),
                        MetadataRow("Duration", durationMillis?.let(::formatDurationMillis) ?: UNKNOWN),
                        MetadataRow("Bit rate", UNKNOWN),
                        MetadataRow("Compression mode", UNKNOWN),
                        MetadataRow("Stream size", fileSize)
                    )
                )
            ),
            installHint = InstallHint(
                text = "Install MediaInfo CLI for richer metadata.",
                actionLabel = "Download CLI",
                url = MEDIAINFO_DOWNLOAD_URL
            )
        )
    }

    private fun mergeInfos(mediaType: String, inputs: List<MediaMetadataInfo?>): MediaMetadataInfo? {
        val infos = inputs.filterNotNull()
        if (infos.isEmpty()) return null

        val rowsBySection = LinkedHashMap<String, MutableList<MetadataRow>>()
        val indicesBySection = LinkedHashMap<String, MutableMap<String, Int>>()
        val sources = mutableListOf<String>()

        for (info in infos) {
            if (info.source !in sources) {
                sources += info.source
            }
            for (section in info.sections) {
                val title = section.title.ifBlank { if (mediaType == "video") "Video" else if (mediaType == "audio") "Audio" else "Image" }
                val rows = rowsBySection.getOrPut(title) { mutableListOf() }
                val indices = indicesBySection.getOrPut(title) { mutableMapOf() }
                for (row in section.rows) {
                    val labelKey = row.label.trim().lowercase(Locale.ROOT)
                    val existingIndex = indices[labelKey]
                    if (existingIndex == null) {
                        rows += row
                        indices[labelKey] = rows.lastIndex
                    } else if (rows[existingIndex].value.isUnknownValue() && row.value.isKnownValue()) {
                        rows[existingIndex] = row
                    }
                }
            }
        }

        val mergedSections = rowsBySection.map { (title, rows) -> MetadataSection(title, rows.toList()) }
        val mediaInfoPresent = sources.any { it.startsWith("MediaInfo", ignoreCase = true) }
        val installHint = infos.mapNotNull { it.installHint }.firstOrNull()
            ?: if (!mediaInfoPresent && mediaType != "image") {
                InstallHint(
                    text = "Install MediaInfo CLI for richer metadata.",
                    actionLabel = "Download CLI",
                    url = MEDIAINFO_DOWNLOAD_URL
                )
            } else {
                null
            }

        return MediaMetadataInfo(
            mediaType = mediaType,
            source = sources.joinToString(" + "),
            sections = mergedSections,
            installHint = installHint
        )
    }

    private fun runMediaInfoCommand(command: List<String>, timeoutSeconds: Long = 8): MediaInfoCommandResult {
        val result = runProcess(command, timeoutSeconds) ?: return MediaInfoCommandResult.Failed(MediaInfoFailureReason.COMMAND_FAILED)
        if (result.timedOut) return MediaInfoCommandResult.Failed(MediaInfoFailureReason.TIMEOUT)
        if (result.exitCode != 0) return MediaInfoCommandResult.Failed(MediaInfoFailureReason.COMMAND_FAILED)
        return result.output.takeIf { it.isNotBlank() }
            ?.let { MediaInfoCommandResult.Success(it) }
            ?: MediaInfoCommandResult.Failed(MediaInfoFailureReason.PARSE_EMPTY)
    }

    private fun runCommand(command: List<String>, timeoutSeconds: Long = 8): String? {
        val result = runProcess(command, timeoutSeconds) ?: return null
        if (result.timedOut || result.exitCode != 0) return null
        return result.output.takeIf { it.isNotBlank() }
    }

    private data class ProcessRunResult(
        val exitCode: Int,
        val output: String,
        val timedOut: Boolean
    )

    private fun runProcess(command: List<String>, timeoutSeconds: Long): ProcessRunResult? {
        return try {
            val process = ProcessBuilder(command)
                .redirectErrorStream(true)
                .start()
            val outputFuture = CompletableFuture.supplyAsync {
                process.inputStream.bufferedReader().use { it.readText() }
            }
            if (!process.waitFor(timeoutSeconds, TimeUnit.SECONDS)) {
                process.destroyForcibly()
                val output = outputFuture.getNow("")
                return ProcessRunResult(exitCode = -1, output = output, timedOut = true)
            }
            val output = runCatching { outputFuture.get(1, TimeUnit.SECONDS) }.getOrDefault("")
            ProcessRunResult(process.exitValue(), output, timedOut = false)
        } catch (_: Throwable) {
            null
        }
    }

    internal fun findMediaInfoExecutable(
        env: Map<String, String> = System.getenv(),
        pathExists: (String) -> Boolean = { candidate -> File(candidate).exists() },
        pathExecutable: (String) -> Boolean = { candidate -> File(candidate).canExecute() },
        osName: String = System.getProperty("os.name").orEmpty(),
        commandRunner: (List<String>) -> String? = { command -> runCommand(command, timeoutSeconds = 2) },
        isConsoleExecutable: (String) -> Boolean = { candidate -> isWindowsConsoleExecutable(candidate) }
    ): String? {
        val isWindows = osName.lowercase(Locale.ROOT).contains("win")

        listOf("MEDIAINFO_CLI_PATH", "MEDIAINFO_PATH").forEach { key ->
            env[key]
                ?.trim()
                ?.takeIf { it.isNotBlank() }
                ?.let { configured ->
                    if (isMediaInfoCli(configured, isWindows, pathExists, isConsoleExecutable, commandRunner)) return configured
                }
        }

        fun checkCandidate(candidate: String): String? {
            return candidate.takeIf {
                pathExists(it) &&
                    (!isWindows || pathExecutable(it) || it.endsWith(".exe", ignoreCase = true)) &&
                    isMediaInfoCli(it, isWindows, pathExists, isConsoleExecutable, commandRunner)
            }
        }

        val pathSeparator = File.pathSeparatorChar
        val pathExts = if (isWindows) listOf("", ".exe", ".cmd", ".bat") else listOf("")
        val commandNames = listOf("mediainfo", "mediainfo.exe", "MediaInfo", "MediaInfo.exe")
        val pathDirs = env["PATH"].orEmpty().split(pathSeparator).filter { it.isNotBlank() }
        for (dir in pathDirs) {
            for (name in commandNames) {
                val candidates = if (name.contains('.')) listOf(name) else pathExts.map { "$name$it" }
                for (candidateName in candidates) {
                    val candidate = File(dir, candidateName).absolutePath
                    checkCandidate(candidate)?.let { return it }
                }
            }
        }

        if (isWindows) {
            val commonPaths = File.listRoots().flatMap { root ->
                listOf(
                    File(root, "Program Files\\MediaInfo CLI\\MediaInfo.exe").absolutePath,
                    File(root, "Program Files (x86)\\MediaInfo CLI\\MediaInfo.exe").absolutePath,
                    File(root, "Program Files\\MediaInfo_CLI\\MediaInfo.exe").absolutePath,
                    File(root, "Program Files (x86)\\MediaInfo_CLI\\MediaInfo.exe").absolutePath,
                    File(root, "Program Files\\MediaInfo_Cli\\MediaInfo.exe").absolutePath,
                    File(root, "Program Files (x86)\\MediaInfo_Cli\\MediaInfo.exe").absolutePath
                )
            }
            commonPaths.forEach { candidate ->
                checkCandidate(candidate)?.let { return it }
            }
        }

        return null
    }

    private fun isMediaInfoCli(
        candidate: String,
        isWindows: Boolean,
        pathExists: (String) -> Boolean,
        isConsoleExecutable: (String) -> Boolean,
        commandRunner: (List<String>) -> String?
    ): Boolean {
        if (!pathExists(candidate)) return false
        if (isWindows && candidate.endsWith(".exe", ignoreCase = true) && !isConsoleExecutable(candidate)) {
            return false
        }
        val output = commandRunner(listOf(candidate, "--Version")) ?: return false
        return output.isNotBlank() && output.lowercase(Locale.ROOT).contains("mediainfo")
    }

    private fun isWindowsConsoleExecutable(candidate: String): Boolean {
        return runCatching {
            val bytes = File(candidate).readBytes()
            if (bytes.size < 0x40) return@runCatching false

            fun uShort(offset: Int): Int {
                if (offset + 1 >= bytes.size) return -1
                return (bytes[offset].toInt() and 0xff) or ((bytes[offset + 1].toInt() and 0xff) shl 8)
            }

            fun int(offset: Int): Int {
                if (offset + 3 >= bytes.size) return -1
                return (bytes[offset].toInt() and 0xff) or
                    ((bytes[offset + 1].toInt() and 0xff) shl 8) or
                    ((bytes[offset + 2].toInt() and 0xff) shl 16) or
                    ((bytes[offset + 3].toInt() and 0xff) shl 24)
            }

            if (uShort(0) != 0x5a4d) return@runCatching false
            val peOffset = int(0x3c)
            if (peOffset <= 0 || peOffset + 0x5f >= bytes.size) return@runCatching false
            if (int(peOffset) != 0x00004550) return@runCatching false
            val subsystem = uShort(peOffset + 4 + 20 + 68)
            subsystem == 3
        }.getOrDefault(false)
    }

    private fun ensureFxInitialized() {
        if (fxInitialized.compareAndSet(false, true)) {
            JFXPanel()
            Platform.setImplicitExit(false)
        }
    }

    private fun stringValue(json: JsonObject, vararg keys: String): String {
        return keys.firstNotNullOfOrNull { key ->
            json.get(key)?.takeIf { !it.isJsonNull }?.asString?.takeIf { it.isNotBlank() }
        } ?: UNKNOWN
    }

    private fun formatSeconds(raw: String?): String {
        val millis = parseDurationMillis(raw) ?: return UNKNOWN
        return formatDurationMillis(millis)
    }

    private fun formatDurationMillis(value: Long): String {
        if (value <= 0L) return UNKNOWN
        val totalSeconds = value / 1000L
        val hours = totalSeconds / 3600L
        val minutes = (totalSeconds % 3600L) / 60L
        val seconds = totalSeconds % 60L
        val millis = value % 1000L
        val base = when {
            hours > 0L -> "$hours h $minutes min $seconds s"
            minutes > 0L -> "$minutes min $seconds s"
            else -> "$seconds s"
        }
        return if (millis > 0L) "$base $millis ms" else base
    }

    private fun parseDurationMillis(raw: String?): Long? {
        val text = raw?.trim()?.takeIf { it.isNotBlank() } ?: return null

        Regex("""(?:(\d+):)?(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?""").matchEntire(text)?.let { match ->
            val hours = match.groupValues[1].toLongOrNull() ?: 0L
            val minutes = match.groupValues[2].toLongOrNull() ?: 0L
            val seconds = match.groupValues[3].toLongOrNull() ?: 0L
            val millis = match.groupValues[4].padEnd(3, '0').takeIf { it.isNotBlank() }?.toLongOrNull() ?: 0L
            return (((hours * 60L + minutes) * 60L) + seconds) * 1000L + millis
        }

        var matched = false
        var totalMillis = 0.0
        val unitPattern = Regex("""(\d+(?:\.\d+)?)\s*(ms|h|hr|hrs|hour|hours|min|mn|m|s)\b""", RegexOption.IGNORE_CASE)
        unitPattern.findAll(text).forEach { match ->
            matched = true
            val value = match.groupValues[1].toDoubleOrNull() ?: return@forEach
            val unit = match.groupValues[2].lowercase(Locale.ROOT)
            totalMillis += when (unit) {
                "ms" -> value
                "h", "hr", "hrs", "hour", "hours" -> value * 3_600_000.0
                "min", "mn", "m" -> value * 60_000.0
                "s" -> value * 1_000.0
                else -> 0.0
            }
        }
        if (matched && totalMillis > 0.0) return totalMillis.toLong()

        return text.toDoubleOrNull()
            ?.takeIf { it > 0.0 }
            ?.let { (it * 1000.0).toLong() }
    }

    private fun humanizeKey(key: String): String {
        return key
            .replace(Regex("_String\\d*$", RegexOption.IGNORE_CASE), "")
            .replace('_', ' ')
            .replace(Regex("([a-z])([A-Z])"), "$1 $2")
            .trim()
    }

    private fun String.isKnownValue(): Boolean {
        return isNotBlank() && !equals(UNKNOWN, ignoreCase = true) && !equals("N/A", ignoreCase = true)
    }

    private fun String.isUnknownValue(): Boolean = !isKnownValue()
}

private fun Duration?.toMillisOrNull(): Long? {
    val value = this ?: return null
    if (value.isUnknown || value.isIndefinite) return null
    val millis = value.toMillis()
    if (!millis.isFinite() || millis <= 0.0) return null
    return millis.toLong()
}

private fun com.google.gson.JsonElement.asLongOrNull(): Long? = runCatching { asLong }.getOrNull()

private fun com.google.gson.JsonElement.asIntOrNull(): Int? = runCatching { asInt }.getOrNull()
