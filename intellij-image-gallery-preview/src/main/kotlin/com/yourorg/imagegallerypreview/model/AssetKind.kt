package com.yourorg.imagegallerypreview.model

import java.util.Locale

enum class AssetKind(val id: String, val label: String) {
    PNG("png", "PNG"),
    JPG("jpg", "JPG"),
    JPEG("jpeg", "JPEG"),
    WEBP("webp", "WEBP"),
    GIF("gif", "GIF"),
    BMP("bmp", "BMP"),
    SVG("svg", "SVG"),
    LOTTIE("lottie", "Lottie"),
    VECTOR_XML("vector_xml", "Vector XML"),
    PDF("pdf", "PDF"),
    HEIC("heic", "HEIC"),
    HEIF("heif", "HEIF"),
    APNG("apng", "APNG"),
    AVIF("avif", "AVIF"),
    ICO("ico", "ICO"),
    XML("xml", "XML"),
    OTHER("other", "Other");

    companion object {
        fun fromFormatFamily(family: String): AssetKind {
            val normalized = family.lowercase(Locale.ROOT)
            return entries.firstOrNull { it.id == normalized } ?: OTHER
        }
    }
}

