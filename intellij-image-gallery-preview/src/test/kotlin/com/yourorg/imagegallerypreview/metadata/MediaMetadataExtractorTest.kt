package com.yourorg.imagegallerypreview.metadata

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class MediaMetadataExtractorTest {

    @Test
    fun `prefers MEDIAINFO_PATH when configured`() {
        val found = MediaMetadataExtractor.findMediaInfoExecutable(
            env = mapOf(
                "MEDIAINFO_CLI_PATH" to "D:/Tools/MediaInfo/MediaInfo.exe",
                "PATH" to "C:/Windows/System32"
            ),
            pathExists = { it == "D:/Tools/MediaInfo/MediaInfo.exe" },
            pathExecutable = { true },
            osName = "Windows 11",
            isConsoleExecutable = { true },
            commandRunner = { "MediaInfoLib - v25.04" }
        )

        assertEquals("D:/Tools/MediaInfo/MediaInfo.exe", found)
    }

    @Test
    fun `finds MediaInfo from PATH on Windows`() {
        val found = MediaMetadataExtractor.findMediaInfoExecutable(
            env = mapOf("PATH" to "C:/Tools;D:/Media"),
            pathExists = { it.replace('\\', '/') == "D:/Media/MediaInfo.exe" },
            pathExecutable = { true },
            osName = "Windows 11",
            isConsoleExecutable = { true },
            commandRunner = { "MediaInfoLib - v25.04" }
        )

        assertEquals("D:\\Media\\MediaInfo.exe".replace('\\', java.io.File.separatorChar), found?.replace('/', java.io.File.separatorChar))
    }

    @Test
    fun `falls back to Windows common install path`() {
        val common = "C:\\Program Files\\MediaInfo CLI\\MediaInfo.exe"
        val found = MediaMetadataExtractor.findMediaInfoExecutable(
            env = emptyMap(),
            pathExists = { it == common },
            pathExecutable = { false },
            osName = "Windows 11",
            isConsoleExecutable = { true },
            commandRunner = { "MediaInfoLib - v25.04" }
        )

        assertEquals(common, found)
    }

    @Test
    fun `ignores MediaInfo GUI candidate that does not answer as CLI`() {
        val gui = "D:\\Program Files\\MediaInfo\\MediaInfo.exe"
        val found = MediaMetadataExtractor.findMediaInfoExecutable(
            env = mapOf("MEDIAINFO_PATH" to gui),
            pathExists = { it == gui },
            pathExecutable = { true },
            osName = "Windows 11",
            isConsoleExecutable = { false },
            commandRunner = { error("GUI executable must not be launched for CLI validation") }
        )

        assertEquals(null, found)
    }

    @Test
    fun `prefers cmd shell MediaInfo probe before direct executable on Windows`() {
        val commands = MediaMetadataExtractor.mediaInfoProbeCommands(
            absPath = "C:/demo/assets/video/intro.mp4",
            osName = "Windows 11",
            configuredExecutable = "D:/Tools/MediaInfo/MediaInfo.exe"
        )

        assertEquals(listOf("cmd", "/c", "mediaInfo", "--output=json", "C:/demo/assets/video/intro.mp4"), commands.first())
        assertEquals(listOf("cmd", "/c", "mediaInfo", "output=JSON", "C:/demo/assets/video/intro.mp4"), commands[1])
        assertEquals(listOf("D:/Tools/MediaInfo/MediaInfo.exe", "--output=json", "C:/demo/assets/video/intro.mp4"), commands[5])
    }

    @Test
    fun `tries Mac MediaInfo output argument before GNU style output flag`() {
        val commands = MediaMetadataExtractor.mediaInfoProbeCommands(
            absPath = "/Users/demo/project/assets/video/intro.mp4",
            osName = "Mac OS X",
            configuredExecutable = "/opt/homebrew/bin/mediainfo"
        )

        assertEquals(listOf("/opt/homebrew/bin/mediainfo", "output=JSON", "/Users/demo/project/assets/video/intro.mp4"), commands[0])
        assertEquals(listOf("/opt/homebrew/bin/mediainfo", "output=json", "/Users/demo/project/assets/video/intro.mp4"), commands[1])
        assertEquals(listOf("/opt/homebrew/bin/mediainfo", "--Output=JSON", "/Users/demo/project/assets/video/intro.mp4"), commands[2])
        assertEquals(listOf("/opt/homebrew/bin/mediainfo", "--output=json", "/Users/demo/project/assets/video/intro.mp4"), commands[3])
        assertEquals(listOf("/opt/homebrew/bin/mediainfo", "/Users/demo/project/assets/video/intro.mp4"), commands[4])
    }

    @Test
    fun `finds MediaInfo from common macOS Homebrew path`() {
        val found = MediaMetadataExtractor.findMediaInfoExecutable(
            env = emptyMap(),
            pathExists = { it == "/opt/homebrew/bin/mediainfo" },
            pathExecutable = { true },
            osName = "Mac OS X",
            commandRunner = { "MediaInfoLib - v25.04" }
        )

        assertEquals("/opt/homebrew/bin/mediainfo", found)
    }

    @Test
    fun `extracts duration millis from metadata rows`() {
        val info = MediaMetadataInfo(
            mediaType = "video",
            source = "MediaInfo",
            sections = listOf(
                MetadataSection(
                    title = "General",
                    rows = listOf(
                        MetadataRow("Duration", "1 min 2 s"),
                        MetadataRow("Format", "MPEG-4")
                    )
                )
            )
        )

        assertEquals(62_000L, MediaMetadataExtractor.durationMillisFrom(info))
    }

    @Test
    fun `maps every primitive MediaInfo track field without truncation`() {
        val json = buildString {
            append("""{"media":{"track":[{"@type":"General"""")
            for (index in 0 until 120) {
                append(""","Field_$index":"value-$index"""")
            }
            append("}]}}")
        }

        val info = MediaMetadataExtractor.parseMediaInfoJson(json, "video")

        assertEquals("MediaInfo", info?.source)
        assertEquals(120, info?.sections?.first()?.rows?.size)
        assertEquals("value-119", info?.sections?.first()?.rows?.last()?.value)
    }

    @Test
    fun `parses MediaInfo text output when lowercase json flag returns default text`() {
        val output = """
            General
            Complete name                            : E:\Work\Project\FlutterProject\shanjian\res\audio\countdown.mp3
            Format                                   : MPEG Audio
            File size                                : 85.8 KiB
            Duration                                 : 5 s 59 ms
            Overall bit rate mode                    : Constant
            Overall bit rate                         : 128 kb/s
            Genre                                    : Blues
            Recorded date                            : 2024-05-09 11:15
            Writing library                          : LAME3.100

            Audio
            Format                                   : MPEG Audio
            Format version                           : Version 1
            Format profile                           : Layer 3
            Duration                                 : 5 s 60 ms
            Bit rate                                 : 128 kb/s
            Channel(s)                               : 2 channels
            Sampling rate                            : 44.1 kHz
            Compression mode                         : Lossy
            Stream size                              : 79.1 KiB (92%)
        """.trimIndent()

        val info = MediaMetadataExtractor.parseMediaInfoOutput(output, "audio")

        assertEquals("MediaInfo", info?.source)
        assertEquals("85.8 KiB", info?.sections?.first { it.title == "General" }?.rows?.first { it.label == "File size" }?.value)
        assertEquals("44.1 kHz", info?.sections?.first { it.title == "Audio" }?.rows?.first { it.label == "Sampling rate" }?.value)
    }

    @Test
    fun `exposes cache controls for forced refresh`() {
        MediaMetadataExtractor.clearCache()
    }

    @Test
    fun `caches MediaInfo executable discovery per resolver session`() {
        var probes = 0
        val resolver = MediaMetadataExtractor.createMediaInfoExecutableResolver {
            probes += 1
            "D:/Tools/MediaInfo/MediaInfo.exe"
        }

        assertEquals("D:/Tools/MediaInfo/MediaInfo.exe", resolver())
        assertEquals("D:/Tools/MediaInfo/MediaInfo.exe", resolver())
        assertEquals(1, probes)
    }

    @Test
    fun `classifies MediaInfo failure reasons for diagnostics`() {
        val info = MediaMetadataInfo(
            mediaType = "audio",
            source = "MediaInfo (parse-empty)",
            sections = emptyList()
        )

        assertTrue(MediaMetadataExtractor.isRetryableFallback(info))
        assertEquals("parse-empty", MediaMetadataExtractor.failureReason(info))
    }

    @Test
    fun `creates timeout fallback metadata for unresolved media item`() {
        val item = com.yourorg.imagegallerypreview.model.GalleryAssetItem(
            sourceType = com.yourorg.imagegallerypreview.model.SourceType.FLUTTER_ASSET,
            platform = "flutter",
            workspaceKind = "flutter",
            projectName = "demo",
            projectPath = "C:/demo",
            projectRelPath = ".",
            isPrimaryProject = true,
            moduleName = "demo",
            modulePath = "C:/demo",
            moduleRelPath = ".",
            isPrimaryModule = true,
            groupPath = "assets/audio",
            copyToken = "assets/audio/stuck.mp3",
            md5 = "",
            formatFamily = "mp3",
            isAnimated = false,
            mediaType = "audio",
            durationMillis = null,
            resourceRootPath = "C:/demo/assets/audio",
            absPath = "C:/demo/assets/audio/stuck.mp3",
            relPath = "assets/audio/stuck.mp3",
            format = "mp3",
            width = null,
            height = null,
            qualifier = "",
            mtime = 1L,
            kind = com.yourorg.imagegallerypreview.model.AssetKind.fromFormatFamily("mp3")
        )

        val result = MediaMetadataExtractor.timeoutFallbackFor(item)

        assertTrue(MediaMetadataExtractor.isTimeoutFallback(result.info))
        assertEquals("audio", result.info.mediaType)
    }
}
