package com.yourorg.imagegallerypreview.metadata

data class MetadataRow(
    val label: String,
    val value: String
)

data class MetadataSection(
    val title: String,
    val rows: List<MetadataRow>
)

data class InstallHint(
    val text: String,
    val actionLabel: String,
    val url: String
)

data class MediaMetadataInfo(
    val mediaType: String,
    val source: String,
    val sections: List<MetadataSection>,
    val installHint: InstallHint? = null
)
