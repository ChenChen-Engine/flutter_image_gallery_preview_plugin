package com.yourorg.imagegallerypreview.scanner

import com.intellij.openapi.project.Project
import com.yourorg.imagegallerypreview.model.GalleryAssetItem
import java.io.File

class ProjectAssetScanner(project: Project) : AssetScanner {
    private val delegate: AssetScanner? = project.basePath?.let { FileSystemAssetScanner(File(it)) }

    override fun scan(): List<GalleryAssetItem> = delegate?.scan() ?: emptyList()
}