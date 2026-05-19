package com.yourorg.imagegallerypreview.navigation

import com.intellij.openapi.Disposable
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.editor.EditorFactory
import com.intellij.openapi.editor.event.EditorMouseEvent
import com.intellij.openapi.editor.event.EditorMouseListener
import com.intellij.openapi.editor.event.EditorMouseMotionListener
import com.intellij.openapi.editor.markup.EffectType
import com.intellij.openapi.editor.markup.HighlighterLayer
import com.intellij.openapi.editor.markup.HighlighterTargetArea
import com.intellij.openapi.editor.markup.RangeHighlighter
import com.intellij.openapi.editor.markup.TextAttributes
import com.intellij.openapi.project.Project
import com.intellij.psi.PsiDocumentManager
import com.intellij.ui.JBColor
import java.awt.Cursor
import java.awt.KeyEventDispatcher
import java.awt.KeyboardFocusManager
import java.awt.Point
import java.awt.event.KeyEvent

@Service(Service.Level.PROJECT)
class GalleryResourceLinkPresentationService(private val project: Project) : Disposable {
    private var started = false
    private var highlighter: RangeHighlighter? = null
    private var highlightedEditor: Editor? = null
    private var previousCursor: Cursor? = null
    private var lastEditor: Editor? = null
    private var lastPoint: Point? = null

    private val keyDispatcher = KeyEventDispatcher { event ->
        if (event.id == KeyEvent.KEY_RELEASED && (event.keyCode == KeyEvent.VK_CONTROL || event.keyCode == KeyEvent.VK_META)) {
            clearPresentation()
            return@KeyEventDispatcher false
        }
        if (event.id == KeyEvent.KEY_PRESSED && (event.keyCode == KeyEvent.VK_CONTROL || event.keyCode == KeyEvent.VK_META)) {
            val editor = lastEditor
            val point = lastPoint
            if (editor != null && point != null) {
                updatePresentation(editor, point, true)
            }
        }
        false
    }

    fun start() {
        if (started) return
        started = true

        val multicaster = EditorFactory.getInstance().eventMulticaster
        multicaster.addEditorMouseMotionListener(
            object : EditorMouseMotionListener {
                override fun mouseMoved(event: EditorMouseEvent) {
                    lastEditor = event.editor
                    lastPoint = event.mouseEvent.point
                    updatePresentation(event.editor, event.mouseEvent.point, event.mouseEvent.isControlDown || event.mouseEvent.isMetaDown)
                }
            },
            this
        )
        multicaster.addEditorMouseListener(
            object : EditorMouseListener {
                override fun mouseExited(event: EditorMouseEvent) {
                    if (event.editor == highlightedEditor) clearPresentation()
                }
            },
            this
        )
        KeyboardFocusManager.getCurrentKeyboardFocusManager().addKeyEventDispatcher(keyDispatcher)
    }

    fun clearPresentation() {
        highlighter?.let { highlightedEditor?.markupModel?.removeHighlighter(it) }
        highlighter = null
        highlightedEditor?.contentComponent?.cursor = previousCursor ?: Cursor.getDefaultCursor()
        highlightedEditor = null
        previousCursor = null
    }

    override fun dispose() {
        clearPresentation()
        KeyboardFocusManager.getCurrentKeyboardFocusManager().removeKeyEventDispatcher(keyDispatcher)
    }

    private fun updatePresentation(editor: Editor, point: Point, modifierPressed: Boolean) {
        if (!modifierPressed || editor.project != project) {
            clearPresentation()
            return
        }

        val psiFile = PsiDocumentManager.getInstance(project).getPsiFile(editor.document)
        if (psiFile == null) {
            clearPresentation()
            return
        }

        val offset = editor.logicalPositionToOffset(editor.xyToLogicalPosition(point))
        val match = GalleryResourceNavigationSupport.matchAt(project, psiFile, offset)
        if (match == null) {
            clearPresentation()
            return
        }

        val start = match.contentRange.startOffset
        val end = match.contentRange.endOffset
        if (start < 0 || end > editor.document.textLength || start >= end) {
            clearPresentation()
            return
        }

        if (highlightedEditor == editor && highlighter?.startOffset == start && highlighter?.endOffset == end) {
            editor.contentComponent.cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
            return
        }

        clearPresentation()
        highlightedEditor = editor
        previousCursor = editor.contentComponent.cursor
        highlighter = editor.markupModel.addRangeHighlighter(
            start,
            end,
            HighlighterLayer.HYPERLINK,
            TextAttributes(null, null, JBColor(0x2563EB, 0x8AB4F8), EffectType.LINE_UNDERSCORE, 0),
            HighlighterTargetArea.EXACT_RANGE
        )
        editor.contentComponent.cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
    }

    companion object {
        fun getInstance(project: Project): GalleryResourceLinkPresentationService = project.service()
    }
}
