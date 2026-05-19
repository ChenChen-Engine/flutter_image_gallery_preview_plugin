package com.yourorg.imagegallerypreview.settings

import com.intellij.codeInsight.daemon.DaemonCodeAnalyzer
import com.intellij.openapi.options.Configurable
import com.intellij.openapi.project.Project
import com.intellij.util.ui.JBUI
import com.yourorg.imagegallerypreview.navigation.GalleryResourceLinkPresentationService
import com.yourorg.imagegallerypreview.service.GallerySettingsService
import java.awt.BorderLayout
import javax.swing.JCheckBox
import javax.swing.JComponent
import javax.swing.JPanel

class GalleryProjectConfigurable(private val project: Project) : Configurable {
    private val settings = GallerySettingsService.getInstance(project)
    private var checkbox: JCheckBox? = null

    override fun getDisplayName(): String = "Image Gallery Preview"

    override fun createComponent(): JComponent {
        val panel = JPanel(BorderLayout()).apply {
            border = JBUI.Borders.empty(12)
        }
        checkbox = JCheckBox("启用资源字符串跳转").apply {
            toolTipText = "开启后，完整匹配索引资源路径的静态字符串可通过 Ctrl+Click 或 Ctrl+B 跳转到资源文件。"
        }
        panel.add(checkbox, BorderLayout.NORTH)
        reset()
        return panel
    }

    override fun isModified(): Boolean {
        return checkbox?.isSelected != settings.resourceStringLinksEnabled
    }

    override fun apply() {
        val selected = checkbox?.isSelected ?: false
        if (settings.resourceStringLinksEnabled == selected) return
        settings.resourceStringLinksEnabled = selected
        if (!selected) GalleryResourceLinkPresentationService.getInstance(project).clearPresentation()
        DaemonCodeAnalyzer.getInstance(project).restart()
    }

    override fun reset() {
        checkbox?.isSelected = settings.resourceStringLinksEnabled
    }

    override fun disposeUIResources() {
        checkbox = null
    }
}
