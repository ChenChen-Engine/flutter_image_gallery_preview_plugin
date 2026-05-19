package com.yourorg.imagegallerypreview.navigation

import com.intellij.codeInsight.navigation.actions.GotoDeclarationHandler
import com.intellij.openapi.editor.Editor
import com.intellij.psi.PsiElement

class GalleryResourceGotoDeclarationHandler : GotoDeclarationHandler {
    override fun getGotoDeclarationTargets(
        sourceElement: PsiElement?,
        offset: Int,
        editor: Editor
    ): Array<PsiElement>? {
        val element = sourceElement ?: return null
        val project = element.project
        val containingFile = element.containingFile ?: return null
        val match = GalleryResourceNavigationSupport.matchAt(project, containingFile, offset) ?: return null
        val psiFile = GalleryResourceNavigationSupport.targetPsiElement(project, match.item) ?: return null
        return arrayOf(psiFile)
    }

    override fun getActionText(context: com.intellij.openapi.actionSystem.DataContext): String {
        return "Go to Gallery Resource"
    }

}
