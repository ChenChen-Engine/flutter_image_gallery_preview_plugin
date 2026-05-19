package com.yourorg.imagegallerypreview.startup

import com.intellij.openapi.project.Project
import com.intellij.openapi.startup.StartupActivity
import com.yourorg.imagegallerypreview.navigation.GalleryResourceLinkPresentationService
import com.yourorg.imagegallerypreview.service.GalleryIndexService

class GalleryStartupActivity : StartupActivity.DumbAware {
    override fun runActivity(project: Project) {
        GalleryResourceLinkPresentationService.getInstance(project).start()
        GalleryIndexService.getInstance(project).syncAsync()
    }
}
