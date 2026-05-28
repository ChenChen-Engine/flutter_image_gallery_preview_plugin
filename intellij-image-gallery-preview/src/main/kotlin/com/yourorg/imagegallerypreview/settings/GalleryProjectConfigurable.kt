package com.yourorg.imagegallerypreview.settings

import com.intellij.codeInsight.daemon.DaemonCodeAnalyzer
import com.intellij.openapi.options.Configurable
import com.intellij.openapi.project.Project
import com.intellij.util.ui.JBUI
import com.yourorg.imagegallerypreview.navigation.GalleryResourceLinkPresentationService
import com.yourorg.imagegallerypreview.service.GallerySettingsService
import java.awt.BorderLayout
import javax.swing.BoxLayout
import javax.swing.JCheckBox
import javax.swing.JComponent
import javax.swing.JPanel

class GalleryProjectConfigurable(private val project: Project) : Configurable {
    private val settings = GallerySettingsService.getInstance(project)
    private var resourceLinksCheckbox: JCheckBox? = null
    private var duplicateDetectionCheckbox: JCheckBox? = null

    override fun getDisplayName(): String = "Image Gallery Preview"

    override fun createComponent(): JComponent {
        val panel = JPanel(BorderLayout()).apply {
            border = JBUI.Borders.empty(12)
        }
        val content = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.Y_AXIS)
        }
        resourceLinksCheckbox = JCheckBox("启用资源字符串跳转").apply {
            toolTipText = "开启后，完整匹配索引资源路径的静态字符串可通过 Ctrl+Click 或 Ctrl+B 跳转到资源文件。"
        }
        duplicateDetectionCheckbox = JCheckBox("启用重复资源检测").apply {
            toolTipText = "开启后，手动新增或修改资源文件时会按 MD5 检测同平台重复资源并弹出处理提示。"
        }
        content.add(resourceLinksCheckbox)
        content.add(duplicateDetectionCheckbox)
        panel.add(content, BorderLayout.NORTH)
        reset()
        return panel
    }

    override fun isModified(): Boolean {
        return resourceLinksCheckbox?.isSelected != settings.resourceStringLinksEnabled ||
            duplicateDetectionCheckbox?.isSelected != settings.duplicateResourceDetectionEnabled
    }

    override fun apply() {
        val resourceLinksSelected = resourceLinksCheckbox?.isSelected ?: false
        val duplicateDetectionSelected = duplicateDetectionCheckbox?.isSelected ?: false
        val resourceLinksChanged = settings.resourceStringLinksEnabled != resourceLinksSelected

        settings.resourceStringLinksEnabled = resourceLinksSelected
        settings.duplicateResourceDetectionEnabled = duplicateDetectionSelected

        if (resourceLinksChanged) {
            if (!resourceLinksSelected) GalleryResourceLinkPresentationService.getInstance(project).clearPresentation()
            DaemonCodeAnalyzer.getInstance(project).restart()
        }
    }

    override fun reset() {
        resourceLinksCheckbox?.isSelected = settings.resourceStringLinksEnabled
        duplicateDetectionCheckbox?.isSelected = settings.duplicateResourceDetectionEnabled
    }

    override fun disposeUIResources() {
        resourceLinksCheckbox = null
        duplicateDetectionCheckbox = null
    }
}
