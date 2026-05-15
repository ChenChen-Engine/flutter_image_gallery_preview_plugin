package com.yourorg.imagegallerypreview.ui

import com.yourorg.imagegallerypreview.metadata.ImageMetadataInfo
import com.yourorg.imagegallerypreview.metadata.MediaMetadataInfo
import com.yourorg.imagegallerypreview.model.GalleryAssetItem

internal data class GalleryWebAssetItem(
    val sourceType: String,
    val platform: String,
    val workspaceKind: String,
    val projectName: String,
    val projectPath: String,
    val projectRelPath: String,
    val isPrimaryProject: Boolean,
    val moduleName: String,
    val modulePath: String,
    val moduleRelPath: String,
    val isPrimaryModule: Boolean,
    val groupPath: String,
    val copyToken: String,
    val md5: String,
    val formatFamily: String,
    val isAnimated: Boolean,
    val mediaType: String,
    val durationMillis: Long?,
    val durationLabel: String,
    val resourceRootPath: String,
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
    val imageInfo: ImageMetadataInfo? = null,
    val mediaInfo: MediaMetadataInfo? = null
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
            item.mediaType == "audio" -> "audio"
            item.mediaType == "video" -> "video"
            item.formatFamily in browserImageFamilies && previewSrc != null -> "image"
            else -> "placeholder"
        }

        return GalleryWebAssetItem(
            sourceType = item.sourceType.name.lowercase(),
            platform = item.platform,
            workspaceKind = item.workspaceKind,
            projectName = item.projectName,
            projectPath = item.projectPath.replace('\\', '/'),
            projectRelPath = item.projectRelPath,
            isPrimaryProject = item.isPrimaryProject,
            moduleName = item.moduleName,
            modulePath = item.modulePath.replace('\\', '/'),
            moduleRelPath = item.moduleRelPath,
            isPrimaryModule = item.isPrimaryModule,
            groupPath = item.groupPath,
            copyToken = item.copyToken,
            md5 = item.md5,
            formatFamily = item.formatFamily,
            isAnimated = item.isAnimated,
            mediaType = item.mediaType,
            durationMillis = item.durationMillis,
            durationLabel = durationLabel(item.durationMillis),
            resourceRootPath = item.resourceRootPath.replace('\\', '/'),
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
            imageInfo = item.imageInfo,
            mediaInfo = item.mediaInfo
        )
    }

    private fun durationLabel(durationMillis: Long?): String {
        val millis = durationMillis ?: return ""
        if (millis <= 0L) return ""
        val totalSeconds = millis / 1000L
        val hours = totalSeconds / 3600L
        val minutes = (totalSeconds % 3600L) / 60L
        val seconds = totalSeconds % 60L
        return if (hours > 0L) {
            "%d:%02d:%02d".format(hours, minutes, seconds)
        } else {
            "%d:%02d".format(minutes, seconds)
        }
    }
}
