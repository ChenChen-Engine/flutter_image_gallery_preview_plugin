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
        val appRaw = File(root, "app/src/main/res/raw")
        val featureDrawable = File(root, "feature_chat/src/debug/res/drawable-xxhdpi")
        appDrawable.mkdirs()
        appMipmap.mkdirs()
        appRaw.mkdirs()
        featureDrawable.mkdirs()

        createPng(File(appDrawable, "icon.png"), 24, 24)
        File(appRaw, "intro.mp3").writeBytes(byteArrayOf(0x49, 0x44, 0x33, 0x03, 0x00))
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

        assertEquals(4, items.size)
        assertTrue(items.any {
            it.workspaceKind == "android" &&
                it.projectName == "app" &&
                it.moduleName == "app" &&
                it.isPrimaryProject &&
                it.isPrimaryModule &&
                it.copyToken == "R.drawable.icon" &&
                it.mediaType == "image" &&
                it.resourceRootPath.endsWith("/app/src/main/res/drawable")
        })
        assertTrue(items.any { it.moduleName == "feature_chat" && it.qualifier == "xxhdpi" })
        assertTrue(items.any { it.copyToken == "R.mipmap.ic_launcher" && it.formatFamily == "vector_xml" })
        assertTrue(items.any { it.copyToken == "R.raw.intro" && it.mediaType == "audio" && it.formatFamily == "mp3" })
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
        assertTrue(items.any {
            it.workspaceKind == "flutter" &&
                it.projectName == "root_app" &&
                it.moduleName == root.name &&
                it.isPrimaryProject &&
                it.isPrimaryModule &&
                it.relPath.endsWith("assets/images/a.png") &&
                it.mediaType == "image" &&
                it.resourceRootPath.endsWith("/assets/images")
        })
        assertTrue(items.any {
            it.projectName == "feature_feed" &&
                it.moduleName == "feature_feed" &&
                !it.isPrimaryProject &&
                it.relPath.endsWith("modules/feature_feed/res/images/b.webp") &&
                it.copyToken.endsWith("res/images/b.webp")
        })
    }

    @Test
    fun `scan flutter fallback assets and keep duplicate project names separate by path`() {
        val root = createTempDirectory("igp-test-flutter-adapted-libs").toFile()
        File(root, "pubspec.yaml").writeText("name: root_app\nflutter:\n  assets:\n    - assets/images/\n")

        val firstPlugin = File(root, "adapted_libs/app_shortcuts")
        val secondPlugin = File(root, "adapted_libs/group/app_shortcuts")
        File(firstPlugin, "pubspec.yaml").apply {
            parentFile.mkdirs()
            writeText("name: app_shortcuts\ndependencies:\n  flutter:\n    sdk: flutter\n")
        }
        File(secondPlugin, "pubspec.yaml").apply {
            parentFile.mkdirs()
            writeText("name: app_shortcuts\ndependencies:\n  flutter:\n    sdk: flutter\n")
        }

        createPng(File(firstPlugin, "assets/icon.png"), 10, 10)
        createPng(File(secondPlugin, "res/icon.png"), 12, 12)

        val items = FileSystemAssetScanner(root).scan()
            .filter { it.sourceType == SourceType.FLUTTER_ASSET && it.projectName == "app_shortcuts" }

        assertEquals(2, items.size)
        assertEquals(
            setOf("./adapted_libs/app_shortcuts", "./adapted_libs/group/app_shortcuts"),
            items.map { it.projectRelPath }.toSet()
        )
        assertEquals(items.map { it.projectPath }.toSet().size, items.size)
        assertTrue(items.all { it.modulePath == it.projectPath })
        assertTrue(items.any { it.copyToken == "assets/icon.png" })
        assertTrue(items.any { it.copyToken == "res/icon.png" })
    }

    @Test
    fun `scan flutter media only from valid flutter projects and resource roots`() {
        val root = createTempDirectory("igp-test-flutter-media-boundary").toFile()
        File(root, "pubspec.yaml").writeText("name: root_app\nflutter:\n  assets:\n    - assets/images/\n")
        createPng(File(root, "assets/images/declared.png"), 10, 10)
        File(root, "assets/audio/click.mp3").apply {
            parentFile.mkdirs()
            writeBytes(byteArrayOf(0x49, 0x44, 0x33, 0x03, 0x00))
        }
        File(root, "docs/temp.png").apply {
            parentFile.mkdirs()
            writeBytes(byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47))
        }

        val invalidPubspec = File(root, "adapted_libs/plain_dart/pubspec.yaml").apply {
            parentFile.mkdirs()
            writeText("name: plain_dart\n")
        }
        createPng(File(invalidPubspec.parentFile, "assets/ignored.png"), 8, 8)

        val pluginRoot = File(root, "adapted_libs/audio_plugin")
        File(pluginRoot, "pubspec.yaml").apply {
            parentFile.mkdirs()
            writeText(
                """
                name: audio_plugin
                dependencies:
                  flutter:
                    sdk: flutter
                """.trimIndent()
            )
        }
        File(pluginRoot, "res/video/intro.mp4").apply {
            parentFile.mkdirs()
            writeBytes(ByteArray(32) { it.toByte() })
        }

        val items = FileSystemAssetScanner(root).scan().filter { it.sourceType == SourceType.FLUTTER_ASSET }

        assertTrue(items.any { it.copyToken == "assets/images/declared.png" && it.mediaType == "image" })
        assertTrue(items.any { it.copyToken == "assets/audio/click.mp3" && it.mediaType == "audio" })
        assertTrue(items.any { it.projectName == "audio_plugin" && it.copyToken == "res/video/intro.mp4" && it.mediaType == "video" })
        assertTrue(items.none { it.relPath.contains("docs/temp.png") })
        assertTrue(items.none { it.projectName == "plain_dart" })
    }

    @Test
    fun `scan flutter workspace android and ios resources from root and nested projects`() {
        val root = createTempDirectory("igp-test-flutter-platforms").toFile()

        File(root, "pubspec.yaml").writeText("name: root_app\nflutter:\n  assets:\n    - assets/images/\n")
        createPng(File(root, "android/app/src/main/res/drawable/root_icon.png"), 16, 16)
        createPng(File(root, "ios/Runner/Assets.xcassets/Root.imageset/root.png"), 16, 16)
        File(root, "ios/Runner/Assets.xcassets/Root.imageset/Contents.json").writeText(
            """{"images":[{"filename":"root.png"}]}"""
        )

        val featureRoot = File(root, "packages/feature_one")
        File(featureRoot, "pubspec.yaml").apply {
            parentFile.mkdirs()
            writeText("name: feature_one\nflutter:\n  assets:\n    - assets/\n")
        }
        createPng(File(featureRoot, "android/app/src/main/res/drawable/feature_icon.png"), 18, 18)
        createPng(File(featureRoot, "ios/Runner/Assets.xcassets/Feature.imageset/feature.png"), 18, 18)
        File(featureRoot, "ios/Runner/Assets.xcassets/Feature.imageset/Contents.json").writeText(
            """{"images":[{"filename":"feature.png"}]}"""
        )

        val items = FileSystemAssetScanner(root).scan()

        val androidItems = items.filter { it.sourceType == SourceType.ANDROID_RES }
        val iosItems = items.filter { it.sourceType == SourceType.IOS_ASSET }

        assertTrue(androidItems.any { it.projectName == "root_app" && it.isPrimaryProject && it.moduleName == "app" && it.isPrimaryModule })
        assertTrue(androidItems.any { it.projectName == "feature_one" && !it.isPrimaryProject && it.moduleName == "app" && it.isPrimaryModule })
        assertTrue(iosItems.any { it.projectName == "root_app" && it.isPrimaryProject && it.relPath.endsWith("root.png") })
        assertTrue(iosItems.any { it.projectName == "feature_one" && !it.isPrimaryProject && it.relPath.endsWith("feature.png") })
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
        File(appRoot, "Sources/Debug/debug.png").apply {
            parentFile.mkdirs()
            writeBytes(byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47))
        }
        File(root, "ios/build/generated.png").apply {
            parentFile.mkdirs()
            writeBytes(byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47))
        }
        File(regularDir, "intro.mov").writeBytes(ByteArray(32) { it.toByte() })

        val items = FileSystemAssetScanner(root).scan().filter { it.sourceType == SourceType.IOS_ASSET }

        assertEquals(3, items.size)
        val avatar = items.find { it.relPath.endsWith("avatar.png") }
        assertNotNull(avatar)
        assertTrue(avatar.copyToken.contains("Assets.xcassets/Avatar.imageset/avatar.png"))

        val banner = items.find { it.relPath.endsWith("Resources/banner.png") }
        assertNotNull(banner)
        assertEquals("Runner", banner.moduleName)
        assertEquals(root.name, banner.projectName)
        assertEquals("ios", banner.workspaceKind)
        assertTrue(items.any { it.relPath.endsWith("Resources/intro.mov") && it.mediaType == "video" })
        assertTrue(items.none { it.relPath.contains("Sources/Debug") })
        assertTrue(items.none { it.relPath.contains("build/generated") })
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
        assertTrue(items.first().isAnimated)
    }

    private fun createPng(file: File, width: Int, height: Int) {
        file.parentFile?.mkdirs()
        val isJpeg = file.extension.equals("jpg", ignoreCase = true) || file.extension.equals("jpeg", ignoreCase = true)
        val image = BufferedImage(width, height, if (isJpeg) BufferedImage.TYPE_INT_RGB else BufferedImage.TYPE_INT_ARGB)
        val format = if (isJpeg) "jpg" else "png"
        ImageIO.write(image, format, file)
    }
}


