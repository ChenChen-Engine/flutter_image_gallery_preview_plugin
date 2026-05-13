package com.yourorg.imagegallerypreview.actions

import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.project.DumbAwareAction
import com.yourorg.imagegallerypreview.service.GalleryIndexService

class RefreshGalleryAction : DumbAwareAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val service = GalleryIndexService.getInstance(project)
        if (service.currentStatus().state == GalleryIndexService.IndexState.INDEXING) {
            Messages.showInfoMessage(project, "Image indexing is in progress.", "Image Gallery Preview")
            return
        }
        service.refreshAsync()
    }
}

