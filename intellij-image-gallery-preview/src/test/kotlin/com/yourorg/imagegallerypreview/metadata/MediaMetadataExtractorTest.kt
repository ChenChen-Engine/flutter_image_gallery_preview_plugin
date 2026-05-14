package com.yourorg.imagegallerypreview.metadata

import kotlin.test.Test
import kotlin.test.assertEquals

class MediaMetadataExtractorTest {

    @Test
    fun `prefers MEDIAINFO_PATH when configured`() {
        val found = MediaMetadataExtractor.findMediaInfoExecutable(
            env = mapOf(
                "MEDIAINFO_PATH" to "D:/Tools/MediaInfo/MediaInfo.exe",
                "PATH" to "C:/Windows/System32"
            ),
            pathExists = { it == "D:/Tools/MediaInfo/MediaInfo.exe" },
            pathExecutable = { true },
            osName = "Windows 11"
        )

        assertEquals("D:/Tools/MediaInfo/MediaInfo.exe", found)
    }

    @Test
    fun `finds MediaInfo from PATH on Windows`() {
        val found = MediaMetadataExtractor.findMediaInfoExecutable(
            env = mapOf("PATH" to "C:/Tools;D:/Media"),
            pathExists = { it.replace('\\', '/') == "D:/Media/MediaInfo.exe" },
            pathExecutable = { true },
            osName = "Windows 11"
        )

        assertEquals("D:\\Media\\MediaInfo.exe".replace('\\', java.io.File.separatorChar), found?.replace('/', java.io.File.separatorChar))
    }

    @Test
    fun `falls back to Windows common install path`() {
        val common = "C:\\Program Files\\MediaInfo\\MediaInfo.exe"
        val found = MediaMetadataExtractor.findMediaInfoExecutable(
            env = emptyMap(),
            pathExists = { it == common },
            pathExecutable = { false },
            osName = "Windows 11"
        )

        assertEquals(common, found)
    }
}
