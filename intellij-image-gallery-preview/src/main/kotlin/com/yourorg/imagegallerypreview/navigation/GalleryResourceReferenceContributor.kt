package com.yourorg.imagegallerypreview.navigation

import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.patterns.PlatformPatterns
import com.intellij.psi.PsiElement
import com.intellij.psi.PsiManager
import com.intellij.psi.PsiReference
import com.intellij.psi.PsiReferenceBase
import com.intellij.psi.PsiReferenceContributor
import com.intellij.psi.PsiReferenceProvider
import com.intellij.psi.PsiReferenceRegistrar
import com.intellij.util.ProcessingContext
import com.intellij.openapi.util.TextRange
import com.yourorg.imagegallerypreview.service.GalleryIndexService
import com.yourorg.imagegallerypreview.service.GallerySettingsService
import com.yourorg.imagegallerypreview.util.AssetFileUtil
import java.io.File
import kotlin.math.max
import kotlin.math.min

class GalleryResourceReferenceContributor : PsiReferenceContributor() {
    override fun registerReferenceProviders(registrar: PsiReferenceRegistrar) {
        registrar.registerReferenceProvider(
            PlatformPatterns.psiElement(),
            object : PsiReferenceProvider() {
                override fun getReferencesByElement(element: PsiElement, context: ProcessingContext): Array<PsiReference> {
                    val project = element.project
                    if (!GallerySettingsService.getInstance(project).resourceStringLinksEnabled) return PsiReference.EMPTY_ARRAY

                    val candidate = referenceCandidate(element)
                        ?: return PsiReference.EMPTY_ARRAY

                    val item = GalleryResourceReferenceResolver.resolve(
                        GalleryIndexService.getInstance(project).currentItems(),
                        candidate.value,
                        AssetFileUtil.normalizePath(element.containingFile?.virtualFile?.path.orEmpty())
                    ) ?: return PsiReference.EMPTY_ARRAY

                    return arrayOf(
                        GalleryResourcePsiReference(
                            element = element,
                            range = candidate.rangeInElement,
                            targetPath = item.absPath
                        )
                    )
                }
            }
        )
    }

    private fun referenceCandidate(element: PsiElement): ReferenceCandidate? {
        if (element.textLength <= MAX_LITERAL_TEXT_LENGTH) {
            GalleryResourceReferenceResolver.parseStaticStringLiteral(element.text)?.let { parsed ->
                return ReferenceCandidate(
                    value = parsed.value,
                    rangeInElement = TextRange(parsed.contentStart, parsed.contentEnd)
                )
            }
        }

        var cursor = element.parent
        repeat(MAX_PARENT_WALK) {
            val parent = cursor ?: return null
            if (parent.textLength <= MAX_LITERAL_TEXT_LENGTH) {
                val parsed = GalleryResourceReferenceResolver.parseStaticStringLiteral(parent.text)
                if (parsed != null) {
                    val elementStart = element.textRange.startOffset
                    val elementEnd = element.textRange.endOffset
                    val contentStart = parent.textRange.startOffset + parsed.contentStart
                    val contentEnd = parent.textRange.startOffset + parsed.contentEnd
                    val overlapStart = max(elementStart, contentStart)
                    val overlapEnd = min(elementEnd, contentEnd)
                    if (overlapStart < overlapEnd) {
                        return ReferenceCandidate(
                            value = parsed.value,
                            rangeInElement = TextRange(overlapStart - elementStart, overlapEnd - elementStart)
                        )
                    }
                }
            }
            cursor = parent.parent
        }
        return null
    }

    companion object {
        private const val MAX_LITERAL_TEXT_LENGTH = 512
        private const val MAX_PARENT_WALK = 6
    }

    private data class ReferenceCandidate(
        val value: String,
        val rangeInElement: TextRange
    )
}

private class GalleryResourcePsiReference(
    element: PsiElement,
    range: TextRange,
    private val targetPath: String
) : PsiReferenceBase<PsiElement>(element, range, true) {
    override fun resolve(): PsiElement? {
        val virtualFile = LocalFileSystem.getInstance().refreshAndFindFileByIoFile(File(targetPath)) ?: return null
        return PsiManager.getInstance(element.project).findFile(virtualFile)
    }

    override fun getVariants(): Array<Any> = emptyArray()
}
