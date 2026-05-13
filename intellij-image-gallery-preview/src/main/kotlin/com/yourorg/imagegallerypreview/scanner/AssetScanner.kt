package com.yourorg.imagegallerypreview.scanner

import com.yourorg.imagegallerypreview.model.GalleryAssetItem

interface AssetScanner {
    fun scan(): List<GalleryAssetItem>
}
