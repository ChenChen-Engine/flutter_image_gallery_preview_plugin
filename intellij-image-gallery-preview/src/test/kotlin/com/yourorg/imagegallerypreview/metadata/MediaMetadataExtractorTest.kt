package com.yourorg.imagegallerypreview.metadata

import kotlin.test.Test
import kotlin.test.assertEquals

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
}
