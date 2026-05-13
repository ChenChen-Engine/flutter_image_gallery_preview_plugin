package com.yourorg.imagegallerypreview.model

enum class SourceType(val label: String, val platform: String) {
    ANDROID_RES("Android Res", "android"),
    FLUTTER_ASSET("Flutter Asset", "flutter"),
    IOS_ASSET("iOS Asset", "ios")
}