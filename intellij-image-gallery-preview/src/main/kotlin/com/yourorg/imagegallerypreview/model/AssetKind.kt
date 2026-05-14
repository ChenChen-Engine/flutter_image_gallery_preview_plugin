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
    MP3("mp3", "MP3"),
    M4A("m4a", "M4A"),
    AAC("aac", "AAC"),
    WAV("wav", "WAV"),
    OGG("ogg", "OGG"),
    OPUS("opus", "OPUS"),
    FLAC("flac", "FLAC"),
    AMR("amr", "AMR"),
    MID("mid", "MID"),
    MIDI("midi", "MIDI"),
    CAF("caf", "CAF"),
    MP4("mp4", "MP4"),
    M4V("m4v", "M4V"),
    MOV("mov", "MOV"),
    WEBM("webm", "WEBM"),
    MKV("mkv", "MKV"),
    AVI("avi", "AVI"),
    THREE_GP("3gp", "3GP"),
    THREE_GPP("3gpp", "3GPP"),
    XML("xml", "XML"),
    OTHER("other", "Other");

    companion object {
        fun fromFormatFamily(family: String): AssetKind {
            val normalized = family.lowercase(Locale.ROOT)
            return entries.firstOrNull { it.id == normalized } ?: OTHER
        }
    }
}

