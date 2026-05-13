package com.yourorg.imagegallerypreview.ui

import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.content.ContentFactory

class ImageGalleryToolWindowFactory : ToolWindowFactory, DumbAware {
    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val panel = JcefImageGalleryPanel(project)
        val content = ContentFactory.getInstance().createContent(panel, "Gallery", false)
        content.setDisposer { panel.disposePanel() }
        toolWindow.contentManager.addContent(content)
    }
}
