package com.yourorg.imagegallerypreview.scanner

import com.yourorg.imagegallerypreview.model.SourceType
import java.awt.image.BufferedImage
import java.io.File
import javax.imageio.ImageIO
import kotlin.io.path.createTempDirectory
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

class FileSystemAssetScannerTest {

    @Test
    fun `scan android multi module and qualifiers`() {
        val root = createTempDirectory("igp-test-android").toFile()

        val appDrawable = File(root, "app/src/main/res/drawable")
        val appMipmap = File(root, "app/src/main/res/mipmap-anydpi-v26")
        val featureDrawable = File(root, "feature_chat/src/debug/res/drawable-xxhdpi")
        appDrawable.mkdirs()
        appMipmap.mkdirs()
        featureDrawable.mkdirs()

        createPng(File(appDrawable, "icon.png"), 24, 24)
        createPng(File(featureDrawable, "hero.jpg"), 100, 50)
        File(appMipmap, "ic_launcher.xml").writeText(
            """
            <vector xmlns:android="http://schemas.android.com/apk/res/android"
                android:width="24dp"
                android:height="24dp"
                android:viewportWidth="24"
                android:viewportHeight="24">
                <path android:fillColor="#FF0000" android:pathData="M0,0h24v24h-24z" />
            </vector>
            """.trimIndent()
        )

        val items = FileSystemAssetScanner(root).scan().filter { it.sourceType == SourceType.ANDROID_RES }

        assertEquals(3, items.size)
        assertTrue(items.any { it.projectName == root.name && it.moduleName == "app" && it.copyToken == "R.drawable.icon" })
        assertTrue(items.any { it.moduleName == "feature_chat" && it.qualifier == "xxhdpi" })
        assertTrue(items.any { it.copyToken == "R.mipmap.ic_launcher" && it.formatFamily == "vector_xml" })
    }

    @Test
    fun `scan flutter assets from multiple pubspec files`() {
        val root = createTempDirectory("igp-test-flutter").toFile()

        File(root, "assets/images").mkdirs()
        createPng(File(root, "assets/images/a.png"), 12, 34)

        val featureRoot = File(root, "modules/feature_feed")
        File(featureRoot, "res/images").mkdirs()
        createPng(File(featureRoot, "res/images/b.webp"), 18, 20)

        File(root, "pubspec.yaml").writeText(
            """
            name: root_app
            flutter:
              assets:
                - assets/images/
            """.trimIndent()
        )

        File(featureRoot, "pubspec.yaml").writeText(
            """
            name: feature_feed
            flutter:
              assets:
                - res/images/
            """.trimIndent()
        )

        val items = FileSystemAssetScanner(root).scan().filter { it.sourceType == SourceType.FLUTTER_ASSET }

        assertEquals(2, items.size)
        assertTrue(items.any { it.projectName == "root_app" && it.moduleName == root.name && it.relPath.endsWith("assets/images/a.png") })
        assertTrue(items.any {
            it.projectName == "feature_feed" &&
                it.moduleName == "feature_feed" &&
                it.relPath.endsWith("modules/feature_feed/res/images/b.webp") &&
                it.copyToken.endsWith("res/images/b.webp")
        })
    }

    @Test
    fun `scan ios xcassets and regular images without duplicates`() {
        val root = createTempDirectory("igp-test-ios").toFile()
        val appRoot = File(root, "ios/Runner")
        appRoot.mkdirs()
        File(appRoot, "Runner.xcodeproj").writeText("project")

        val imageSet = File(appRoot, "Assets.xcassets/Avatar.imageset")
        imageSet.mkdirs()
        createPng(File(imageSet, "avatar.png"), 40, 40)
        File(imageSet, "Contents.json").writeText(
            """
            {
              "images": [{ "idiom": "universal", "filename": "avatar.png", "scale": "1x" }],
              "info": { "version": 1, "author": "xcode" }
            }
            """.trimIndent()
        )

        val regularDir = File(appRoot, "Resources")
        regularDir.mkdirs()
        createPng(File(regularDir, "banner.png"), 64, 32)

        val items = FileSystemAssetScanner(root).scan().filter { it.sourceType == SourceType.IOS_ASSET }

        assertEquals(2, items.size)
        val avatar = items.find { it.relPath.endsWith("avatar.png") }
        assertNotNull(avatar)
        assertTrue(avatar.copyToken.contains("Assets.xcassets/Avatar.imageset/avatar.png"))

        val banner = items.find { it.relPath.endsWith("Resources/banner.png") }
        assertNotNull(banner)
        assertEquals("Runner", banner.moduleName)
        assertEquals(root.name, banner.projectName)
    }

    @Test
    fun `detect lottie json with structural keys`() {
        val root = createTempDirectory("igp-test-lottie").toFile()
        File(root, "assets/anim").mkdirs()

        File(root, "assets/anim/like.json").writeText(
            """
            {
              "v": "5.8.1",
              "w": 200,
              "h": 200,
              "layers": [{"nm":"layer1"}]
            }
            """.trimIndent()
        )

        File(root, "assets/anim/not_lottie.json").writeText("{ \"name\": \"foo\" }")

        File(root, "pubspec.yaml").writeText(
            """
            name: app
            flutter:
              assets:
                - assets/anim/
            """.trimIndent()
        )

        val items = FileSystemAssetScanner(root).scan().filter { it.sourceType == SourceType.FLUTTER_ASSET }

        assertEquals(1, items.size)
        assertEquals("lottie", items.first().formatFamily)
    }

    private fun createPng(file: File, width: Int, height: Int) {
        file.parentFile?.mkdirs()
        val isJpeg = file.extension.equals("jpg", ignoreCase = true) || file.extension.equals("jpeg", ignoreCase = true)
        val image = BufferedImage(width, height, if (isJpeg) BufferedImage.TYPE_INT_RGB else BufferedImage.TYPE_INT_ARGB)
        val format = if (isJpeg) "jpg" else "png"
        ImageIO.write(image, format, file)
    }
}


