package com.yourorg.imagegallerypreview.ui

import com.yourorg.imagegallerypreview.metadata.ImageMetadataInfo
import com.yourorg.imagegallerypreview.model.AssetKind
import com.yourorg.imagegallerypreview.model.GalleryAssetItem
import com.yourorg.imagegallerypreview.model.SourceType
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class GalleryPresentationModelTest {

    @Test
    fun `paginate keeps non-empty page and row model`() {
        val items = listOf(
            asset("android", "demo", "app", "res/drawable", "banner.png"),
            asset("android", "demo", "app", "res/drawable", "icon.png"),
            asset("flutter", "root_app", "root_app", "assets/images", "hero.png")
        )

        val sorted = GalleryPresentationModel.sortItems(items)
        val page = GalleryPresentationModel.paginate(sorted, requestedPageIndex = 0, requestedPageSize = 2)
        val layout = GalleryPresentationModel.buildRows(page.items, columns = 2)

        assertEquals(2, page.items.size)
        assertTrue(layout.rows.isNotEmpty())
        assertTrue(layout.rows.any { it is GalleryPresentationModel.HeaderRow })
        assertTrue(layout.rows.any { it is GalleryPresentationModel.CardsRow })
        assertEquals(2, layout.renderedCardCount)
    }

    @Test
    fun `paginate clamps out of range page index`() {
        val items = (1..5).map { index ->
            asset("android", "demo", "app", "res/drawable", "asset_$index.png")
        }

        val page = GalleryPresentationModel.paginate(items, requestedPageIndex = 9, requestedPageSize = 2)
        assertEquals(2, page.pageIndex)
        assertEquals(3, page.totalPages)
        assertEquals(1, page.items.size)
    }

    private fun asset(
        platform: String,
        projectName: String,
        moduleName: String,
        groupPath: String,
        fileName: String
    ): GalleryAssetItem {
        return GalleryAssetItem(
            sourceType = when (platform) {
                "android" -> SourceType.ANDROID_RES
                "flutter" -> SourceType.FLUTTER_ASSET
                else -> SourceType.IOS_ASSET
            },
            platform = platform,
            projectName = projectName,
            moduleName = moduleName,
            groupPath = groupPath,
            copyToken = fileName,
            md5 = fileName,
            formatFamily = "png",
            absPath = "C:/$groupPath/$fileName",
            relPath = "$groupPath/$fileName",
            format = "png",
            width = 32,
            height = 32,
            qualifier = "",
            mtime = 1L,
            kind = AssetKind.PNG,
            imageInfo = ImageMetadataInfo(
                width = "32",
                height = "32",
                colorSpace = "sRGB",
                chromaSubsampling = "Unknown",
                bitDepth = "8",
                compressionMode = "Unknown",
                streamSize = "1 KB",
                fileSize = "1 KB",
                format = "PNG",
                absPath = "C:/$groupPath/$fileName"
            )
        )
    }
}
