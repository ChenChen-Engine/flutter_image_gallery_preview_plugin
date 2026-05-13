package com.yourorg.imagegallerypreview.metadata

data class ImageMetadataInfo(
    val width: String,
    val height: String,
    val colorSpace: String,
    val chromaSubsampling: String,
    val bitDepth: String,
    val compressionMode: String,
    val streamSize: String,
    val fileSize: String,
    val format: String,
    val absPath: String
) {
    companion object {
        fun unknown(format: String, absPath: String, fileSize: Long): ImageMetadataInfo {
            return ImageMetadataInfo(
                width = "Unknown",
                height = "Unknown",
                colorSpace = "Unknown",
                chromaSubsampling = "Unknown",
                bitDepth = "Unknown",
                compressionMode = "Unknown",
                streamSize = readableBytes(fileSize),
                fileSize = readableBytes(fileSize),
                format = format,
                absPath = absPath
            )
        }

        fun readableBytes(bytes: Long): String {
            if (bytes < 0L) return "Unknown"
            if (bytes < 1024L) return "${bytes} B"
            val units = arrayOf("KB", "MB", "GB", "TB")
            var value = bytes.toDouble()
            var unitIndex = -1
            while (value >= 1024.0 && unitIndex < units.lastIndex) {
                value /= 1024.0
                unitIndex += 1
            }
            return String.format("%.2f %s", value, units[unitIndex])
        }
    }
}
