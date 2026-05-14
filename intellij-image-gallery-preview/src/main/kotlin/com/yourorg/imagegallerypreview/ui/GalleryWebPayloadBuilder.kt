package com.yourorg.imagegallerypreview.ui

import com.yourorg.imagegallerypreview.metadata.ImageMetadataInfo
import com.yourorg.imagegallerypreview.model.GalleryAssetItem

internal data class GalleryWebAssetItem(
    val sourceType: String,
    val platform: String,
    val workspaceKind: String,
    val projectName: String,
    val projectPath: String,
    val isPrimaryProject: Boolean,
    val moduleName: String,
    val isPrimaryModule: Boolean,
    val groupPath: String,
    val copyToken: String,
    val md5: String,
    val formatFamily: String,
    val isAnimated: Boolean,
    val absPath: String,
    val relPath: String,
    val format: String,
    val width: Int?,
    val height: Int?,
    val qualifier: String,
    val mtime: Long,
    val kind: String,
    val fileName: String,
    val previewSrc: String?,
    val renderKind: String,
    val lottieJson: String? = null,
    val imageInfo: ImageMetadataInfo? = null
)

internal object GalleryWebPayloadBuilder {
    private val browserImageFamilies = setOf(
        "png",
        "jpg",
        "jpeg",
        "webp",
        "gif",
        "bmp",
        "svg",
        "apng",
        "avif",
        "ico"
    )

    fun toWebAsset(item: GalleryAssetItem, previewSrc: String?, lottieJson: String? = null): GalleryWebAssetItem {
        val renderKind = when {
            item.formatFamily == "lottie" -> "lottie"
            item.formatFamily in browserImageFamilies && previewSrc != null -> "image"
            else -> "placeholder"
        }

        return GalleryWebAssetItem(
            sourceType = item.sourceType.name.lowercase(),
            platform = item.platform,
            workspaceKind = item.workspaceKind,
            projectName = item.projectName,
            projectPath = item.projectPath.replace('\\', '/'),
            isPrimaryProject = item.isPrimaryProject,
            moduleName = item.moduleName,
            isPrimaryModule = item.isPrimaryModule,
            groupPath = item.groupPath,
            copyToken = item.copyToken,
            md5 = item.md5,
            formatFamily = item.formatFamily,
            isAnimated = item.isAnimated,
            absPath = item.absPath.replace('\\', '/'),
            relPath = item.relPath.replace('\\', '/'),
            format = item.format,
            width = item.width,
            height = item.height,
            qualifier = item.qualifier,
            mtime = item.mtime,
            kind = item.kind.id,
            fileName = item.fileName,
            previewSrc = previewSrc,
            renderKind = renderKind,
            lottieJson = lottieJson,
            imageInfo = item.imageInfo
        )
    }
}
