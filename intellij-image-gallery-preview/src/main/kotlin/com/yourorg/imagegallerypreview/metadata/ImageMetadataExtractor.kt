package com.yourorg.imagegallerypreview.metadata

import com.drew.imaging.ImageMetadataReader
import com.drew.metadata.Directory
import com.drew.metadata.Tag
import com.drew.metadata.file.FileSystemDirectory
import com.yourorg.imagegallerypreview.model.GalleryAssetItem
import com.yourorg.imagegallerypreview.util.AssetFileUtil
import java.io.File
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap

object ImageMetadataExtractor {
    private val cache = ConcurrentHashMap<String, ImageMetadataInfo>()

    fun infoFor(item: GalleryAssetItem): ImageMetadataInfo {
        val file = File(item.absPath)
        val key = "${item.absPath}|${item.mtime}|${file.length()}"
        return cache.computeIfAbsent(key) {
            extract(item, file)
        }
    }

    private fun extract(item: GalleryAssetItem, file: File): ImageMetadataInfo {
        if (!file.exists() || !file.isFile) {
            return ImageMetadataInfo.unknown(item.format.uppercase(Locale.ROOT), item.absPath, -1L)
        }

        val fallback = ImageMetadataInfo.unknown(item.format.uppercase(Locale.ROOT), item.absPath, file.length())

        return try {
            val metadata = ImageMetadataReader.readMetadata(file)
            val tags = metadata.directories
                .flatMap { directory -> directory.tags.map { tag -> directory to tag } }

            val streamBytes = firstTagValue(tags, "Stream Size")?.let(::parseBytes)
            val fileBytes = file.length()

            val width = firstTagValue(tags, "Image Width")
                ?: firstTagValue(tags, "Width")
                ?: item.width?.toString()
                ?: "Unknown"

            val height = firstTagValue(tags, "Image Height")
                ?: firstTagValue(tags, "Height")
                ?: item.height?.toString()
                ?: "Unknown"

            val colorSpace = firstTagValue(tags, "Color Space")
                ?: firstTagValue(tags, "ICC Profile Name")
                ?: firstTagValue(tags, "Color Type")
                ?: "Unknown"

            val chromaSubsampling = firstTagValue(tags, "Y Cb Cr Sub-Sampling")
                ?: firstTagValue(tags, "Subsampling")
                ?: "Unknown"

            val bitDepth = firstTagValue(tags, "Bits Per Sample")
                ?: firstTagValue(tags, "Bit Depth")
                ?: "Unknown"

            val compressionMode = firstTagValue(tags, "Compression Type")
                ?: firstTagValue(tags, "Compression")
                ?: firstTagValue(tags, "Compression Method")
                ?: "Unknown"

            val streamSizeValue = streamBytes ?: fileBytes

            ImageMetadataInfo(
                width = width,
                height = height,
                colorSpace = colorSpace,
                chromaSubsampling = chromaSubsampling,
                bitDepth = bitDepth,
                compressionMode = compressionMode,
                streamSize = ImageMetadataInfo.readableBytes(streamSizeValue),
                fileSize = ImageMetadataInfo.readableBytes(fileBytes),
                format = item.format.uppercase(Locale.ROOT),
                absPath = AssetFileUtil.normalizePath(item.absPath)
            )
        } catch (_: Throwable) {
            fallback
        }
    }

    private fun firstTagValue(entries: List<Pair<Directory, Tag>>, tagName: String): String? {
        return entries.firstOrNull { (_, tag) -> tag.tagName.equals(tagName, ignoreCase = true) }
            ?.second
            ?.description
            ?.trim()
            ?.takeIf { it.isNotBlank() }
    }

    private fun parseBytes(text: String): Long? {
        val digits = text.filter { it.isDigit() }
        return digits.toLongOrNull()
    }
}
