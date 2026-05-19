package com.yourorg.imagegallerypreview.navigation

import com.intellij.openapi.project.Project
import com.intellij.openapi.util.TextRange
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.psi.PsiElement
import com.intellij.psi.PsiFile
import com.intellij.psi.PsiManager
import com.yourorg.imagegallerypreview.model.GalleryAssetItem
import com.yourorg.imagegallerypreview.service.GalleryIndexService
import com.yourorg.imagegallerypreview.service.GallerySettingsService
import com.yourorg.imagegallerypreview.util.AssetFileUtil
import java.io.File

object GalleryResourceNavigationSupport {
    data class Match(
        val item: GalleryAssetItem,
        val contentRange: TextRange
    )

    fun matchAt(project: Project, psiFile: PsiFile, offset: Int): Match? {
        if (!GallerySettingsService.getInstance(project).resourceStringLinksEnabled) return null
        val literal = findLiteralAt(psiFile, offset) ?: return null
        val item = GalleryResourceReferenceResolver.resolve(
            GalleryIndexService.getInstance(project).currentItems(),
            literal.value,
            AssetFileUtil.normalizePath(psiFile.virtualFile?.path.orEmpty())
        ) ?: return null
        return Match(item, literal.contentRange)
    }

    fun targetPsiElement(project: Project, item: GalleryAssetItem): PsiElement? {
        val virtualFile = LocalFileSystem.getInstance().refreshAndFindFileByIoFile(File(item.absPath)) ?: return null
        return PsiManager.getInstance(project).findFile(virtualFile)
    }

    private fun findLiteralAt(psiFile: PsiFile, offset: Int): LiteralAtOffset? {
        var cursor: PsiElement? = psiFile.findElementAt(offset.coerceIn(0, psiFile.textLength.coerceAtLeast(1) - 1))
        repeat(MAX_PARENT_WALK) {
            val element = cursor ?: return null
            if (element.textLength <= MAX_LITERAL_TEXT_LENGTH) {
                val parsed = GalleryResourceReferenceResolver.parseStaticStringLiteral(element.text)
                if (parsed != null) {
                    val start = element.textRange.startOffset + parsed.contentStart
                    val end = element.textRange.startOffset + parsed.contentEnd
                    if (offset in start until end) {
                        return LiteralAtOffset(parsed.value, TextRange(start, end))
                    }
                }
            }
            cursor = element.parent
        }
        return null
    }

    private data class LiteralAtOffset(
        val value: String,
        val contentRange: TextRange
    )

    private const val MAX_PARENT_WALK = 8
    private const val MAX_LITERAL_TEXT_LENGTH = 512
}
