package com.yourorg.imagegallerypreview.ui

import com.intellij.icons.AllIcons
import com.intellij.ide.projectView.ProjectView
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.ide.CopyPasteManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.popup.Balloon
import com.intellij.openapi.ui.popup.JBPopupFactory
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.wm.WindowManager
import com.intellij.psi.PsiManager
import com.intellij.ui.JBColor
import com.intellij.ui.awt.RelativePoint
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.components.JBTextField
import com.intellij.util.ui.JBUI
import com.yourorg.imagegallerypreview.metadata.ImageMetadataExtractor
import com.yourorg.imagegallerypreview.metadata.ImageMetadataInfo
import com.yourorg.imagegallerypreview.model.GalleryAssetItem
import com.yourorg.imagegallerypreview.service.GalleryIndexService
import java.awt.BorderLayout
import java.awt.Color
import java.awt.Component
import java.awt.Dimension
import java.awt.FlowLayout
import java.awt.Font
import java.awt.GridBagConstraints
import java.awt.GridBagLayout
import java.awt.datatransfer.StringSelection
import java.awt.event.ComponentAdapter
import java.awt.event.ComponentEvent
import java.awt.event.MouseAdapter
import java.awt.event.MouseEvent
import java.io.File
import java.time.Instant
import java.time.LocalDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import javax.swing.BorderFactory
import javax.swing.Box
import javax.swing.BoxLayout
import javax.swing.DefaultComboBoxModel
import javax.swing.JButton
import javax.swing.JComboBox
import javax.swing.JComponent
import javax.swing.JMenuItem
import javax.swing.JPanel
import javax.swing.JPopupMenu
import javax.swing.SwingConstants
import javax.swing.SwingUtilities
import javax.swing.Timer

class ImageGalleryPanel(private val project: Project) : JPanel(BorderLayout()) {

    companion object {
        private const val DEFAULT_PAGE_SIZE = 120
    }

    private data class FilterState(
        val query: String,
        val platform: String,
        val projectName: String,
        val module: String,
        val type: String
    )

    private val service = GalleryIndexService.getInstance(project)
    private val allItems = mutableListOf<GalleryAssetItem>()

    private val contentPanel = JPanel().apply {
        layout = GridBagLayout()
        isOpaque = false
    }
    private val scrollPane = JBScrollPane(contentPanel)
    private val loadingOverlay = LoadingOverlayPanel()
    private val contentHost = JPanel().apply {
        layout = javax.swing.OverlayLayout(this)
        scrollPane.alignmentX = 0f
        scrollPane.alignmentY = 0f
        loadingOverlay.alignmentX = 0f
        loadingOverlay.alignmentY = 0f
        add(loadingOverlay)
        add(scrollPane)
    }

    private val searchField = JBTextField()
    private val platformFilter = JComboBox(DefaultComboBoxModel(arrayOf("All Platforms", "Android", "Flutter", "iOS")))
    private val projectFilter = JComboBox(DefaultComboBoxModel(arrayOf("All Projects")))
    private val moduleFilter = JComboBox(DefaultComboBoxModel(arrayOf("All Modules")))
    private val typeFilter = JComboBox(DefaultComboBoxModel(arrayOf("All Types")))
    private val pageSizeFilter = JComboBox(DefaultComboBoxModel(arrayOf("60", "120", "240")))
    private val prevPageButton = JButton("Prev")
    private val nextPageButton = JButton("Next")
    private val syncButton = JButton("Sync")
    private val refreshButton = JButton("Refresh")

    private val statusLabel = JBLabel("Visible 0 / Indexed 0")
    private val pageLabel = JBLabel("Page 1 / 1")
    private val indexStateLabel = JBLabel("Idle")
    private val logger = Logger.getInstance(ImageGalleryPanel::class.java)

    private val filterDebounceTimer: Timer = Timer(220, null).apply {
        isRepeats = false
        addActionListener {
            stop()
            applyFilterNow()
        }
    }

    private val resizeDebounceTimer: Timer = Timer(240, null).apply {
        isRepeats = false
        addActionListener {
            stop()
            refreshRowsForWidthIfNeeded()
        }
    }

    private var indexedCount = 0
    private var lastRenderedColumns = 4
    private var renderEpoch = 0L
    private var currentPageIndex = 0
    private var pendingPageReset = false

    private val itemsListener: (List<GalleryAssetItem>) -> Unit = { items ->
        allItems.clear()
        allItems.addAll(items)
        indexedCount = items.size
        logger.info("Gallery index delivered ${items.size} items")
        updateFilterOptions(items)
        scheduleFilterApply()
    }

    private val statusListener: (GalleryIndexService.IndexStatus) -> Unit = { status ->
        val indexing = status.state == GalleryIndexService.IndexState.INDEXING
        setLoading(indexing)

        indexStateLabel.text = when (status.state) {
            GalleryIndexService.IndexState.IDLE -> "Idle"
            GalleryIndexService.IndexState.INDEXING -> "Indexing..."
            GalleryIndexService.IndexState.SUCCESS -> "Updated ${formatTime(status.timestampMillis)}"
            GalleryIndexService.IndexState.FAILED -> "Failed"
        }

        if (status.state == GalleryIndexService.IndexState.FAILED) {
            loadingOverlay.showError("Failed to index assets") { refreshNow() }
        } else if (status.state == GalleryIndexService.IndexState.SUCCESS) {
            loadingOverlay.hideError()
        }
    }

    init {
        border = JBUI.Borders.empty(8)

        val topPanel = JPanel(BorderLayout(8, 0))
        val controlsPanel = JPanel(WrapFlowLayout(FlowLayout.LEFT, 8, 6))

        searchField.emptyText.text = "Search by file name or MD5"
        searchField.preferredSize = Dimension(260, 28)
        searchField.minimumSize = Dimension(220, 28)
        pageSizeFilter.selectedItem = DEFAULT_PAGE_SIZE.toString()

        syncButton.addActionListener { syncNow() }
        refreshButton.addActionListener { refreshNow() }
        prevPageButton.addActionListener {
            if (currentPageIndex > 0) {
                currentPageIndex -= 1
                applyFilterNow()
            }
        }
        nextPageButton.addActionListener {
            currentPageIndex += 1
            applyFilterNow()
        }

        controlsPanel.add(searchField)
        controlsPanel.add(platformFilter)
        controlsPanel.add(projectFilter)
        controlsPanel.add(moduleFilter)
        controlsPanel.add(typeFilter)
        controlsPanel.add(pageSizeFilter)
        controlsPanel.add(prevPageButton)
        controlsPanel.add(nextPageButton)
        controlsPanel.add(syncButton)
        controlsPanel.add(refreshButton)

        val rightPanel = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.Y_AXIS)
            isOpaque = false
            add(statusLabel)
            add(pageLabel)
            add(indexStateLabel)
        }

        topPanel.add(controlsPanel, BorderLayout.CENTER)
        topPanel.add(rightPanel, BorderLayout.EAST)

        add(topPanel, BorderLayout.NORTH)
        add(contentHost, BorderLayout.CENTER)

        searchField.document.addDocumentListener(SimpleDocumentListener { scheduleFilterApply() })
        platformFilter.addActionListener {
            updateProjectOptions(projectFilter.selectedItem?.toString())
            updateModuleOptions(moduleFilter.selectedItem?.toString())
            updateFilterVisibility()
            scheduleFilterApply()
        }
        projectFilter.addActionListener {
            updateModuleOptions(moduleFilter.selectedItem?.toString())
            updateFilterVisibility()
            scheduleFilterApply()
        }
        moduleFilter.addActionListener { scheduleFilterApply() }
        typeFilter.addActionListener { scheduleFilterApply() }
        pageSizeFilter.addActionListener { scheduleFilterApply() }

        addComponentListener(object : ComponentAdapter() {
            override fun componentResized(e: ComponentEvent?) {
                resizeDebounceTimer.restart()
            }
        })

        service.addListener(itemsListener)
        service.addStatusListener(statusListener)

        if (service.currentItems().isEmpty()) {
            setLoading(true)
        }
    }

    fun refreshNow() {
        service.refreshAsync()
    }

    fun syncNow() {
        service.syncAsync()
    }

    fun disposePanel() {
        service.removeListener(itemsListener)
        service.removeStatusListener(statusListener)
    }

    private fun updateFilterOptions(items: List<GalleryAssetItem>) {
        val selectedType = typeFilter.selectedItem?.toString() ?: "All Types"
        val types = items.map { it.formatFamily }
            .distinct()
            .sortedWith(String.CASE_INSENSITIVE_ORDER)

        typeFilter.model = DefaultComboBoxModel((listOf("All Types") + types).toTypedArray())
        typeFilter.selectedItem = if (types.contains(selectedType)) selectedType else "All Types"

        updateProjectOptions(projectFilter.selectedItem?.toString())
        updateModuleOptions(moduleFilter.selectedItem?.toString())
        updateFilterVisibility()
    }

    private fun updateProjectOptions(previousSelected: String?) {
        val selectedPlatform = platformFilter.selectedItem?.toString() ?: "All Platforms"
        val projects = allItems
            .filter { matchesPlatform(it, selectedPlatform) }
            .map { it.projectName }
            .distinct()
            .sortedWith(String.CASE_INSENSITIVE_ORDER)

        projectFilter.model = DefaultComboBoxModel((listOf("All Projects") + projects).toTypedArray())
        projectFilter.selectedItem = if (projects.contains(previousSelected)) previousSelected else "All Projects"
    }

    private fun updateModuleOptions(previousSelected: String?) {
        val selectedPlatform = platformFilter.selectedItem?.toString() ?: "All Platforms"
        val selectedProject = projectFilter.selectedItem?.toString() ?: "All Projects"

        val modules = allItems
            .filter {
                matchesPlatform(it, selectedPlatform) &&
                    (selectedProject == "All Projects" || it.projectName == selectedProject)
            }
            .map { it.moduleName }
            .distinct()
            .sortedWith(String.CASE_INSENSITIVE_ORDER)

        moduleFilter.model = DefaultComboBoxModel((listOf("All Modules") + modules).toTypedArray())
        moduleFilter.selectedItem = if (modules.contains(previousSelected)) previousSelected else "All Modules"
    }

    private fun updateFilterVisibility() {
        val selectedPlatform = platformFilter.selectedItem?.toString() ?: "All Platforms"
        val selectedProject = projectFilter.selectedItem?.toString() ?: "All Projects"

        when (selectedPlatform) {
            "All Platforms" -> {
                projectFilter.isVisible = false
                moduleFilter.isVisible = false
            }

            "Android", "Flutter" -> {
                projectFilter.isVisible = true
                moduleFilter.isVisible = true
            }

            "iOS" -> {
                projectFilter.isVisible = true
                val moduleCount = allItems
                    .filter { it.platform == "ios" && (selectedProject == "All Projects" || it.projectName == selectedProject) }
                    .map { it.moduleName }
                    .distinct()
                    .size
                moduleFilter.isVisible = moduleCount > 1
            }
        }

        projectFilter.revalidate()
        moduleFilter.revalidate()
        revalidate()
        repaint()
    }

    private fun scheduleFilterApply(resetPage: Boolean = true) {
        if (resetPage) {
            pendingPageReset = true
        }
        filterDebounceTimer.restart()
    }

    private fun applyFilterNow() {
        val epoch = ++renderEpoch
        val startedAt = System.currentTimeMillis()
        if (pendingPageReset) {
            currentPageIndex = 0
            pendingPageReset = false
        }
        val state = FilterState(
            query = searchField.text.trim().lowercase(Locale.ROOT),
            platform = platformFilter.selectedItem?.toString() ?: "All Platforms",
            projectName = projectFilter.selectedItem?.toString() ?: "All Projects",
            module = moduleFilter.selectedItem?.toString() ?: "All Modules",
            type = typeFilter.selectedItem?.toString() ?: "All Types"
        )

        val filtered = GalleryPresentationModel.sortItems(allItems.filter { item ->
            val matchesQuery = state.query.isBlank() || item.searchText.contains(state.query)
            val matchesPlatform = matchesPlatform(item, state.platform)
            val matchesProject = state.platform == "All Platforms" || state.projectName == "All Projects" || item.projectName == state.projectName
            val matchesModule =
                if (state.platform == "All Platforms") true
                else if (!moduleFilter.isVisible) true
                else state.module == "All Modules" || item.moduleName == state.module
            val matchesType = state.type == "All Types" || item.formatFamily.equals(state.type, ignoreCase = true)
            matchesQuery && matchesPlatform && matchesProject && matchesModule && matchesType
        })

        statusLabel.text = "Visible ${filtered.size} / Indexed $indexedCount"
        val page = GalleryPresentationModel.paginate(filtered, currentPageIndex, selectedPageSize())
        currentPageIndex = page.pageIndex
        updatePaginationControls(page)
        renderRows(page.items, epoch)
        val elapsed = System.currentTimeMillis() - startedAt
        indexStateLabel.toolTipText = "Filter ${filtered.size} items in ${elapsed}ms"
    }

    private fun matchesPlatform(item: GalleryAssetItem, selected: String): Boolean {
        return when (selected) {
            "Android" -> item.platform == "android"
            "Flutter" -> item.platform == "flutter"
            "iOS" -> item.platform == "ios"
            else -> true
        }
    }

    private fun renderRows(items: List<GalleryAssetItem>, epoch: Long) {
        if (epoch != renderEpoch) return

        if (items.isEmpty()) {
            renderPlaceholder("No items", false)
            return
        }

        val columns = computeColumns()
        lastRenderedColumns = columns

        val startedAt = System.currentTimeMillis()
        val layout = try {
            GalleryPresentationModel.buildRows(items, columns)
        } catch (error: Throwable) {
            logger.warn("Failed to build gallery rows", error)
            renderFlatFallback(items, columns)
            return
        }

        val renderedComponents = mutableListOf<JComponent>()
        layout.rows.forEach { row ->
            val component = try {
                when (row) {
                    is GalleryPresentationModel.HeaderRow -> createHeaderRow(row)
                    is GalleryPresentationModel.CardsRow -> createCardsRow(row)
                }
            } catch (error: Throwable) {
                logger.warn("Failed to render row $row", error)
                null
            }

            if (component != null) {
                renderedComponents += component
            }
        }

        if (layout.renderedCardCount == 0 || renderedComponents.isEmpty()) {
            logger.warn("Gallery render produced no visible components; falling back. items=${items.size}, rows=${layout.rows.size}, columns=$columns")
            renderFlatFallback(items, columns)
            return
        }

        if (epoch == renderEpoch) {
            mountContent(renderedComponents)
            val renderElapsed = System.currentTimeMillis() - startedAt
            statusLabel.toolTipText = "Rendered ${items.size} items in ${renderElapsed}ms"
            logger.info("Gallery rendered pageItems=${items.size}, rows=${layout.rows.size}, cards=${layout.renderedCardCount}, attached=${renderedComponents.size}, columns=$columns")
        }
    }

    private fun refreshRowsForWidthIfNeeded() {
        val columns = computeColumns()
        if (columns == lastRenderedColumns) return
        scheduleFilterApply(resetPage = false)
    }

    private fun updatePaginationControls(page: GalleryPresentationModel.Page<GalleryAssetItem>) {
        pageLabel.text = "Page ${page.pageIndex + 1} / ${page.totalPages}"
        prevPageButton.isEnabled = page.pageIndex > 0
        nextPageButton.isEnabled = page.pageIndex < page.totalPages - 1
    }

    private fun selectedPageSize(): Int {
        return pageSizeFilter.selectedItem?.toString()?.toIntOrNull()?.coerceAtLeast(1) ?: DEFAULT_PAGE_SIZE
    }

    private fun computeColumns(): Int {
        val availableWidth = scrollPane.viewport.extentSize.width
            .takeIf { it > 0 }
            ?: scrollPane.width
            .takeIf { it > 0 }
            ?: width

        val cardWidth = 200
        return maxOf(1, availableWidth / cardWidth)
    }

    private fun createHeaderRow(row: GalleryPresentationModel.HeaderRow): JComponent {
        val fontSize = when (row.level) {
            GalleryPresentationModel.SectionLevel.PLATFORM -> 14f
            GalleryPresentationModel.SectionLevel.PROJECT -> 13f
            GalleryPresentationModel.SectionLevel.MODULE -> 12f
            GalleryPresentationModel.SectionLevel.DIRECTORY -> 12f
        }
        val label = JBLabel(row.title).apply {
            font = font.deriveFont(Font.BOLD, fontSize)
            foreground = if (row.level == GalleryPresentationModel.SectionLevel.DIRECTORY) JBColor.GRAY else foreground
        }

        return JPanel(BorderLayout()).apply {
            isOpaque = false
            alignmentX = LEFT_ALIGNMENT
            border = JBUI.Borders.empty(if (row.level == GalleryPresentationModel.SectionLevel.PLATFORM) 10 else 6, row.level.indent, 4, 0)
            add(label, BorderLayout.CENTER)
        }
    }

    private fun createCardsRow(row: GalleryPresentationModel.CardsRow): JComponent {
        val cardRow = JPanel().apply {
            layout = FlowLayout(FlowLayout.LEFT, 10, 0)
            isOpaque = false
            border = JBUI.Borders.empty(0, row.level.indent, 6, 0)
        }

        row.items.forEach { item ->
            cardRow.add(createAssetCard(item))
        }
        cardRow.maximumSize = Dimension(Int.MAX_VALUE, cardRow.preferredSize.height)
        return cardRow
    }

    private fun createAssetCard(item: GalleryAssetItem): JComponent {
        return try {
            AssetCard(item).apply {
                minimumSize = preferredSize
                maximumSize = preferredSize
                alignmentY = TOP_ALIGNMENT
            }
        } catch (error: Throwable) {
            logger.warn("Failed to build asset card for ${item.absPath}", error)
            createFailedCard(item)
        }
    }

    private fun createFailedCard(item: GalleryAssetItem): JComponent {
        return JPanel(BorderLayout(6, 6)).apply {
            isOpaque = true
            background = JBColor.PanelBackground
            border = BorderFactory.createCompoundBorder(
                BorderFactory.createLineBorder(JBColor.RED, 1),
                JBUI.Borders.empty(8)
            )
            preferredSize = Dimension(180, 186)
            minimumSize = preferredSize
            maximumSize = preferredSize

            add(JBLabel(AllIcons.General.Error).apply {
                horizontalAlignment = SwingConstants.CENTER
                verticalAlignment = SwingConstants.CENTER
                preferredSize = Dimension(160, 100)
            }, BorderLayout.CENTER)
            add(JBLabel("Load Failed").apply {
                font = font.deriveFont(Font.BOLD, 12f)
            }, BorderLayout.NORTH)
            add(JBLabel(item.fileName).apply {
                foreground = JBColor.GRAY
                toolTipText = item.absPath
            }, BorderLayout.SOUTH)
        }
    }

    private fun renderFlatFallback(items: List<GalleryAssetItem>, columns: Int) {
        val fallbackComponents = mutableListOf<JComponent>()
        fallbackComponents += createHeaderRow(
            GalleryPresentationModel.HeaderRow(
                GalleryPresentationModel.SectionLevel.PLATFORM,
                "Results"
            )
        )
        GalleryPresentationModel.buildRows(items, columns)
            .rows
            .filterIsInstance<GalleryPresentationModel.CardsRow>()
            .forEach { row ->
                fallbackComponents += createCardsRow(row)
            }
        if (fallbackComponents.size <= 1) {
            renderPlaceholder("Render fallback failed", true)
            return
        }
        mountContent(fallbackComponents)
    }

    private fun renderPlaceholder(message: String, canRetry: Boolean) {
        val placeholder = JPanel(BorderLayout()).apply {
            isOpaque = false
            border = JBUI.Borders.empty(24)
            add(JBLabel(message, SwingConstants.CENTER).apply {
                foreground = JBColor.GRAY
            }, BorderLayout.CENTER)
        }
        mountContent(listOf(placeholder))
        if (canRetry) {
            loadingOverlay.showError(message) { refreshNow() }
        }
    }

    private fun setLoading(loading: Boolean) {
        syncButton.isEnabled = !loading
        refreshButton.isEnabled = !loading
        if (loading) {
            loadingOverlay.showLoading("Indexing assets...")
        } else if (!loadingOverlay.isErrorVisible) {
            loadingOverlay.hideLoading()
        }
        loadingOverlay.isVisible = loading || loadingOverlay.isErrorVisible
    }

    private fun formatTime(timestampMillis: Long): String {
        return try {
            val formatter = DateTimeFormatter.ofPattern("HH:mm:ss")
            LocalDateTime.ofInstant(Instant.ofEpochMilli(timestampMillis), ZoneId.systemDefault()).format(formatter)
        } catch (_: Throwable) {
            "just now"
        }
    }

    private fun showToast(message: String) {
        ApplicationManager.getApplication().invokeLater {
            WindowManager.getInstance().getStatusBar(project)?.info = message
        }
    }

    private fun copyText(value: String, toastLabel: String) {
        CopyPasteManager.getInstance().setContents(StringSelection(value))
        showToast("Copied $toastLabel: $value")
    }

    private fun openAssetInProject(item: GalleryAssetItem) {
        val ioFile = File(item.absPath)
        val virtualFile = LocalFileSystem.getInstance().refreshAndFindFileByIoFile(ioFile) ?: return

        FileEditorManager.getInstance(project).openFile(virtualFile, true)

        PsiManager.getInstance(project).findFile(virtualFile)?.let {
            ProjectView.getInstance(project).select(virtualFile, virtualFile, false)
        }
    }

    private inner class AssetCard(private val item: GalleryAssetItem) : JPanel(BorderLayout(6, 6)) {
        private var infoBalloon: Balloon? = null

        init {
            isOpaque = true
            background = JBColor.PanelBackground
            border = BorderFactory.createCompoundBorder(
                BorderFactory.createLineBorder(JBColor.border(), 1),
                JBUI.Borders.empty(8)
            )
            preferredSize = Dimension(180, 186)

            val cornerPanel = JPanel(BorderLayout()).apply {
                isOpaque = false
            }

            val md5Button = JButton("M").apply {
                toolTipText = "Copy MD5"
                margin = JBUI.insets(1, 5)
                addActionListener { copyText(item.md5, "MD5") }
            }

            val infoButton = JButton("i").apply {
                toolTipText = "Show image info"
                margin = JBUI.insets(1, 5)
                addMouseListener(object : MouseAdapter() {
                    override fun mouseEntered(e: MouseEvent) {
                        showInfoBalloon(this@apply)
                    }

                    override fun mouseExited(e: MouseEvent) {
                        hideInfoBalloon()
                    }
                })
            }

            cornerPanel.add(md5Button, BorderLayout.WEST)
            cornerPanel.add(infoButton, BorderLayout.EAST)

            val thumbLabel = JBLabel().apply {
                icon = ThumbnailIconProvider.placeholderFor(item, 96)
                horizontalAlignment = SwingConstants.CENTER
                verticalAlignment = SwingConstants.CENTER
                border = JBUI.Borders.empty(4)
                preferredSize = Dimension(160, 100)
                toolTipText = "Click to copy: ${item.copyToken}"
            }

            updateThumbnailState(thumbLabel, thumbLabel.icon, ThumbnailIconProvider.isLoadFailed(item, 96))
            ThumbnailIconProvider.loadInto(item, 96) { icon, failed ->
                if (!isDisplayable) return@loadInto
                updateThumbnailState(thumbLabel, icon, failed)
            }

            thumbLabel.addMouseListener(object : MouseAdapter() {
                override fun mouseClicked(e: MouseEvent) {
                    if (SwingUtilities.isLeftMouseButton(e)) {
                        copyText(item.copyToken, "Path")
                    }
                    if (SwingUtilities.isRightMouseButton(e)) {
                        showContextMenu(e.component as JComponent, e.x, e.y)
                    }
                    if (e.clickCount == 2) {
                        openAssetInProject(item)
                    }
                }

                override fun mousePressed(e: MouseEvent) {
                    if (e.isPopupTrigger) {
                        showContextMenu(e.component as JComponent, e.x, e.y)
                    }
                }

                override fun mouseReleased(e: MouseEvent) {
                    if (e.isPopupTrigger) {
                        showContextMenu(e.component as JComponent, e.x, e.y)
                    }
                }
            })

            val nameLabel = JBLabel(item.fileName).apply {
                font = font.deriveFont(Font.BOLD, 12f)
            }

            val detail = "${item.platform.uppercase(Locale.ROOT)} | ${item.projectName} | ${item.moduleName} | ${item.formatFamily.uppercase(Locale.ROOT)} | ${item.dimensionLabel}"
            val metaLabel = JBLabel(detail).apply {
                font = font.deriveFont(Font.PLAIN, 11f)
                foreground = JBColor.GRAY
                toolTipText = item.relPath
            }

            val openButton = JButton("Open").apply {
                margin = JBUI.insets(2, 8)
                addActionListener { openAssetInProject(item) }
            }

            val center = JPanel(BorderLayout()).apply { isOpaque = false }
            center.add(cornerPanel, BorderLayout.NORTH)
            center.add(thumbLabel, BorderLayout.CENTER)

            val footer = JPanel(BorderLayout(4, 2)).apply {
                isOpaque = false
                add(nameLabel, BorderLayout.NORTH)
                add(metaLabel, BorderLayout.CENTER)
                add(openButton, BorderLayout.EAST)
            }

            add(center, BorderLayout.CENTER)
            add(footer, BorderLayout.SOUTH)
        }

        private fun updateThumbnailState(label: JBLabel, icon: javax.swing.Icon?, failed: Boolean) {
            label.icon = icon
            if (failed) {
                label.text = "Load Failed"
                label.horizontalTextPosition = SwingConstants.CENTER
                label.verticalTextPosition = SwingConstants.BOTTOM
                label.toolTipText = "Load Failed: ${item.absPath}"
            } else {
                label.text = null
                label.toolTipText = "Click to copy: ${item.copyToken}"
            }
        }

        private fun buildInfoText(info: ImageMetadataInfo): String {
            return """
                width: ${info.width}
                height: ${info.height}
                color Space: ${info.colorSpace}
                chroma subsampling: ${info.chromaSubsampling}
                bit depth: ${info.bitDepth}
                compression mode: ${info.compressionMode}
                stream size: ${info.streamSize}
                file size: ${info.fileSize}
                format: ${info.format}
                abs path: ${info.absPath}
            """.trimIndent().replace("\n", "<br/>")
        }

        private fun showInfoBalloon(anchor: JComponent) {
            hideInfoBalloon()
            val info = ImageMetadataExtractor.infoFor(item)
            val html = "<html><body style='padding:6px;'>${buildInfoText(info)}</body></html>"

            infoBalloon = JBPopupFactory.getInstance()
                .createHtmlTextBalloonBuilder(html, null, JBColor.PanelBackground, null)
                .setHideOnClickOutside(true)
                .setHideOnAction(true)
                .setHideOnKeyOutside(true)
                .createBalloon()

            val point = RelativePoint(anchor, java.awt.Point(anchor.width, anchor.height))
            infoBalloon?.show(point, Balloon.Position.below)
        }

        private fun hideInfoBalloon() {
            infoBalloon?.hide()
            infoBalloon = null
        }

        private fun showContextMenu(component: JComponent, x: Int, y: Int) {
            val menu = JPopupMenu()
            menu.add(JMenuItem("Copy Path").apply { addActionListener { copyText(item.copyToken, "Path") } })
            menu.add(JMenuItem("Copy MD5").apply { addActionListener { copyText(item.md5, "MD5") } })
            menu.add(JMenuItem("Open File").apply { addActionListener { openAssetInProject(item) } })
            menu.show(component, x, y)
        }
    }

    private class CollapsibleSectionPanel(title: String, expanded: Boolean) : JPanel(BorderLayout()) {
        private val bodyContainer = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.Y_AXIS)
            isOpaque = false
            border = JBUI.Borders.empty(4, 12, 10, 0)
        }

        private val toggleButton = JButton().apply {
            horizontalAlignment = SwingConstants.LEFT
            isBorderPainted = false
            isFocusPainted = false
            isContentAreaFilled = false
        }

        private var isExpanded = expanded

        init {
            isOpaque = false
            border = JBUI.Borders.empty(6, 0)

            toggleButton.font = toggleButton.font.deriveFont(Font.BOLD, 13f)
            toggleButton.addActionListener {
                isExpanded = !isExpanded
                refreshState(title)
            }

            add(toggleButton, BorderLayout.NORTH)
            add(bodyContainer, BorderLayout.CENTER)
            refreshState(title)
        }

        fun setBody(component: Component) {
            bodyContainer.removeAll()
            bodyContainer.add(component)
            revalidate()
            repaint()
        }

        fun addBody(component: Component) {
            bodyContainer.add(component)
            revalidate()
            repaint()
        }

        private fun refreshState(title: String) {
            val prefix = if (isExpanded) "▼" else "▶"
            toggleButton.text = "$prefix $title"
            bodyContainer.isVisible = isExpanded
        }
    }

    private fun mountContent(components: List<JComponent>) {
        contentPanel.removeAll()

        components.forEachIndexed { index, component ->
            contentPanel.add(component, GridBagConstraints().apply {
                gridx = 0
                gridy = index
                weightx = 1.0
                anchor = GridBagConstraints.NORTHWEST
                fill = GridBagConstraints.HORIZONTAL
            })
        }

        contentPanel.add(JPanel().apply { isOpaque = false }, GridBagConstraints().apply {
            gridx = 0
            gridy = components.size
            weightx = 1.0
            weighty = 1.0
            fill = GridBagConstraints.BOTH
        })

        contentPanel.revalidate()
        contentPanel.repaint()
    }

    private class LoadingOverlayPanel : JPanel(BorderLayout()) {
        private val messageLabel = JBLabel("", SwingConstants.CENTER)
        private val retryButton = JButton("Retry")

        var isErrorVisible: Boolean = false
            private set

        init {
            isOpaque = true
            background = JBColor(Color(0, 0, 0, 35), Color(0, 0, 0, 90))
            border = JBUI.Borders.empty(16)

            val inner = JPanel().apply {
                layout = BoxLayout(this, BoxLayout.Y_AXIS)
                isOpaque = false
            }

            messageLabel.alignmentX = CENTER_ALIGNMENT
            retryButton.alignmentX = CENTER_ALIGNMENT
            retryButton.isVisible = false

            inner.add(messageLabel)
            inner.add(JBLabel(" "))
            inner.add(retryButton)

            add(inner, BorderLayout.CENTER)
            hideLoading()
        }

        fun showLoading(text: String) {
            if (isErrorVisible) return
            messageLabel.text = text
            retryButton.isVisible = false
            retryButton.actionListeners.forEach { retryButton.removeActionListener(it) }
            isVisible = true
        }

        fun hideLoading() {
            if (!isErrorVisible) {
                isVisible = false
            }
        }

        fun showError(text: String, onRetry: () -> Unit) {
            isErrorVisible = true
            messageLabel.text = text
            retryButton.actionListeners.forEach { retryButton.removeActionListener(it) }
            retryButton.addActionListener { onRetry() }
            retryButton.isVisible = true
            isVisible = true
        }

        fun hideError() {
            isErrorVisible = false
            retryButton.isVisible = false
            retryButton.actionListeners.forEach { retryButton.removeActionListener(it) }
            isVisible = false
        }
    }

    private class WrapFlowLayout(align: Int, hgap: Int, vgap: Int) : FlowLayout(align, hgap, vgap) {
        override fun preferredLayoutSize(target: java.awt.Container): Dimension {
            return layoutSize(target, true)
        }

        override fun minimumLayoutSize(target: java.awt.Container): Dimension {
            val minimum = layoutSize(target, false)
            minimum.width -= (hgap + 1)
            return minimum
        }

        private fun layoutSize(target: java.awt.Container, preferred: Boolean): Dimension {
            synchronized(target.treeLock) {
                var targetWidth = target.width
                if (targetWidth == 0) {
                    targetWidth = Int.MAX_VALUE
                }

                val insets = target.insets
                val horizontalInsetsAndGap = insets.left + insets.right + hgap * 2
                val maxWidth = targetWidth - horizontalInsetsAndGap

                val dim = Dimension(0, 0)
                var rowWidth = 0
                var rowHeight = 0

                for (component in target.components) {
                    if (!component.isVisible) continue
                    val d = if (preferred) component.preferredSize else component.minimumSize

                    if (rowWidth + d.width > maxWidth) {
                        addRow(dim, rowWidth, rowHeight)
                        rowWidth = 0
                        rowHeight = 0
                    }

                    if (rowWidth != 0) {
                        rowWidth += hgap
                    }
                    rowWidth += d.width
                    rowHeight = maxOf(rowHeight, d.height)
                }

                addRow(dim, rowWidth, rowHeight)

                dim.width += horizontalInsetsAndGap
                dim.height += insets.top + insets.bottom + vgap * 2
                return dim
            }
        }

        private fun addRow(dim: Dimension, rowWidth: Int, rowHeight: Int) {
            dim.width = maxOf(dim.width, rowWidth)
            if (dim.height > 0) {
                dim.height += vgap
            }
            dim.height += rowHeight
        }
    }
}
























