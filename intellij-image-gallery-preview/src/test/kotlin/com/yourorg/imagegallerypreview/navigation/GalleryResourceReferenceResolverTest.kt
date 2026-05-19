package com.yourorg.imagegallerypreview.navigation

import com.yourorg.imagegallerypreview.model.AssetKind
import com.yourorg.imagegallerypreview.model.GalleryAssetItem
import com.yourorg.imagegallerypreview.model.SourceType
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class GalleryResourceReferenceResolverTest {
    @Test
    fun `matches copy token and relative path literals`() {
        val logo = asset(
            absPath = "C:/demo/assets/images/logo.png",
            copyToken = "assets/images/logo.png",
            relPath = "assets/images/logo.png"
        )
        val icon = asset(
            absPath = "C:/demo/app/src/main/res/drawable/icon.png",
            copyToken = "R.drawable.icon",
            relPath = "app/src/main/res/drawable/icon.png"
        )
        val index = GalleryResourceReferenceResolver.buildIndex(listOf(logo, icon))

        assertEquals(logo.absPath, GalleryResourceReferenceResolver.resolve(index, "assets/images/logo.png", "C:/demo/lib/main.dart")?.absPath)
        assertEquals(icon.absPath, GalleryResourceReferenceResolver.resolve(index, "R.drawable.icon", "C:/demo/app/src/main/java/Main.kt")?.absPath)
        assertNull(GalleryResourceReferenceResolver.resolve(index, "logo.png", "C:/demo/lib/main.dart"))
    }

    @Test
    fun `parses only complete static string literals`() {
        val normal = GalleryResourceReferenceResolver.parseStaticStringLiteral("'assets/images/logo.png'")
        val raw = GalleryResourceReferenceResolver.parseStaticStringLiteral("r'res/images/logo.png'")

        assertEquals("assets/images/logo.png", normal?.value)
        assertEquals(1, normal?.contentStart)
        assertEquals("res/images/logo.png", raw?.value)
        assertEquals(2, raw?.contentStart)
        assertNull(GalleryResourceReferenceResolver.parseStaticStringLiteral("'assets/\$name.png'"))
        assertNull(GalleryResourceReferenceResolver.parseStaticStringLiteral("'assets/' + name"))
        assertNull(GalleryResourceReferenceResolver.parseStaticStringLiteral("`assets/images/logo.png`"))
    }

    @Test
    fun `sorts duplicate references by module project primary flags then path`() {
        val app = asset(
            absPath = "C:/demo/app/assets/logo.png",
            copyToken = "assets/logo.png",
            relPath = "app/assets/logo.png",
            projectPath = "C:/demo",
            modulePath = "C:/demo/app",
            isPrimaryProject = true,
            isPrimaryModule = true
        )
        val feature = asset(
            absPath = "C:/demo/packages/feature/assets/logo.png",
            copyToken = "assets/logo.png",
            relPath = "packages/feature/assets/logo.png",
            projectPath = "C:/demo",
            modulePath = "C:/demo/packages/feature",
            isPrimaryProject = false,
            isPrimaryModule = false
        )
        val index = GalleryResourceReferenceResolver.buildIndex(listOf(app, feature))

        assertEquals(
            feature.absPath,
            GalleryResourceReferenceResolver.resolve(index, "assets/logo.png", "C:/demo/packages/feature/lib/page.dart")?.absPath
        )
        assertEquals(
            app.absPath,
            GalleryResourceReferenceResolver.resolve(index, "assets/logo.png", "C:/demo/other/lib/page.dart")?.absPath
        )
    }

    private fun asset(
        absPath: String,
        copyToken: String,
        relPath: String,
        projectPath: String = "C:/demo",
        modulePath: String = "C:/demo",
        isPrimaryProject: Boolean = true,
        isPrimaryModule: Boolean = true
    ): GalleryAssetItem {
        return GalleryAssetItem(
            sourceType = SourceType.FLUTTER_ASSET,
            platform = "flutter",
            workspaceKind = "flutter",
            projectName = "demo",
            projectPath = projectPath,
            projectRelPath = ".",
            isPrimaryProject = isPrimaryProject,
            moduleName = "app",
            modulePath = modulePath,
            moduleRelPath = ".",
            isPrimaryModule = isPrimaryModule,
            groupPath = "assets",
            copyToken = copyToken,
            md5 = "abc123",
            formatFamily = "png",
            isAnimated = false,
            mediaType = "image",
            durationMillis = null,
            resourceRootPath = "C:/demo/assets",
            absPath = absPath,
            relPath = relPath,
            format = "png",
            width = 24,
            height = 24,
            qualifier = "",
            mtime = 1L,
            kind = AssetKind.PNG
        )
    }
}
