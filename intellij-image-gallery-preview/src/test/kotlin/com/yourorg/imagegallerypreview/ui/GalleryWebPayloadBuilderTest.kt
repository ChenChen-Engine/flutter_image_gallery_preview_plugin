package com.yourorg.imagegallerypreview.ui

import com.yourorg.imagegallerypreview.model.AssetKind
import com.yourorg.imagegallerypreview.model.GalleryAssetItem
import com.yourorg.imagegallerypreview.model.SourceType
import kotlin.test.Test
import kotlin.test.assertEquals

class GalleryWebPayloadBuilderTest {

    @Test
    fun `maps browser render kind from asset type`() {
        val image = asset("png", "C:/demo/assets/icon.png")
        val lottie = asset("lottie", "C:/demo/assets/like.json")
        val vector = asset("vector_xml", "C:/demo/app/src/main/res/drawable/ic.xml")

        assertEquals("image", GalleryWebPayloadBuilder.toWebAsset(image, "file:///icon.png").renderKind)
        assertEquals("lottie", GalleryWebPayloadBuilder.toWebAsset(lottie, "file:///like.json").renderKind)
        assertEquals("placeholder", GalleryWebPayloadBuilder.toWebAsset(vector, "file:///ic.xml").renderKind)
    }

    @Test
    fun `keeps host computed copy token and grouping fields`() {
        val item = asset("png", "C:/demo/app/src/main/res/drawable/icon.png")

        val webItem = GalleryWebPayloadBuilder.toWebAsset(item, "file:///icon.png")

        assertEquals("R.drawable.icon", webItem.copyToken)
        assertEquals("android", webItem.platform)
        assertEquals("demo", webItem.projectName)
        assertEquals("app", webItem.moduleName)
        assertEquals("res/drawable", webItem.groupPath)
    }

    private fun asset(formatFamily: String, absPath: String): GalleryAssetItem {
        return GalleryAssetItem(
            sourceType = SourceType.ANDROID_RES,
            platform = "android",
            projectName = "demo",
            moduleName = "app",
            groupPath = "res/drawable",
            copyToken = "R.drawable.icon",
            md5 = "abc123",
            formatFamily = formatFamily,
            absPath = absPath,
            relPath = "app/src/main/res/drawable/icon.png",
            format = formatFamily,
            width = 24,
            height = 24,
            qualifier = "",
            mtime = 1L,
            kind = AssetKind.fromFormatFamily(formatFamily)
        )
    }
}
