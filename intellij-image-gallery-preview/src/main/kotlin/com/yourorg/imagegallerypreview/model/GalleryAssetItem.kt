package com.yourorg.imagegallerypreview.model

import com.yourorg.imagegallerypreview.metadata.ImageMetadataInfo
import java.util.Locale

data class GalleryAssetItem(
    val sourceType: SourceType,
    val platform: String,
    val workspaceKind: String = "unknown",
    val projectName: String,
    val projectPath: String = "",
    val projectRelPath: String = ".",
    val isPrimaryProject: Boolean = false,
    val moduleName: String,
    val modulePath: String = "",
    val moduleRelPath: String = ".",
    val isPrimaryModule: Boolean = false,
    val groupPath: String,
    val copyToken: String,
    val md5: String,
    val formatFamily: String,
    val isAnimated: Boolean = false,
    val mediaType: String = "image",
    val durationMillis: Long? = null,
    val resourceRootPath: String = "",
    val absPath: String,
    val relPath: String,
    val format: String,
    val width: Int?,
    val height: Int?,
    val qualifier: String,
    val mtime: Long,
    val kind: AssetKind,
    val imageInfo: ImageMetadataInfo? = null
) {
    val fileName: String
        get() = absPath.substringAfterLast('\\').substringAfterLast('/')

    val dimensionLabel: String
        get() = if (width != null && height != null) "${width}x${height}" else "-"

    val searchText: String
        get() = "${fileName.lowercase(Locale.ROOT)} ${relPath.lowercase(Locale.ROOT)} ${md5.lowercase(Locale.ROOT)}"
}

