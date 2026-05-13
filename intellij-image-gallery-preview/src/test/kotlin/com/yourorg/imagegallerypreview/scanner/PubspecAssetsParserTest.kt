package com.yourorg.imagegallerypreview.scanner

import com.yourorg.imagegallerypreview.util.PubspecAssetsParser
import java.io.File
import kotlin.io.path.createTempDirectory
import kotlin.test.Test
import kotlin.test.assertEquals

class PubspecAssetsParserTest {

    @Test
    fun `parse assets list under flutter section`() {
        val root = createTempDirectory("igp-test-pubspec").toFile()
        val pubspec = File(root, "pubspec.yaml")
        pubspec.writeText(
            """
            name: app
            description: demo

            flutter:
              uses-material-design: true
              assets:
                - assets/images/
                - "assets/icons/logo.png"

            dev_dependencies:
              flutter_test:
                sdk: flutter
            """.trimIndent()
        )

        val entries = PubspecAssetsParser.parseAssetEntries(pubspec)
        assertEquals(listOf("assets/images/", "assets/icons/logo.png"), entries)
    }

    @Test
    fun `parse project name`() {
        val root = createTempDirectory("igp-test-pubspec-name").toFile()
        val pubspec = File(root, "pubspec.yaml")
        pubspec.writeText(
            """
            name: feature_module
            flutter:
              assets:
                - assets/
            """.trimIndent()
        )

        assertEquals("feature_module", PubspecAssetsParser.parseProjectName(pubspec))
    }
}
