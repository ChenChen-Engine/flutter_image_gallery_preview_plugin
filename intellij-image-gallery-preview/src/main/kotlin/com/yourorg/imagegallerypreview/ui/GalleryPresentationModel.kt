package com.yourorg.imagegallerypreview.ui

import com.yourorg.imagegallerypreview.model.GalleryAssetItem
import java.util.Locale

internal object GalleryPresentationModel {

    enum class SectionLevel(val indent: Int) {
        PLATFORM(0),
        PROJECT(16),
        MODULE(32),
        DIRECTORY(48)
    }

    sealed interface Row

    data class HeaderRow(
        val level: SectionLevel,
        val title: String
    ) : Row

    data class CardsRow(
        val level: SectionLevel,
        val items: List<GalleryAssetItem>
    ) : Row

    data class Page<T>(
        val pageIndex: Int,
        val pageSize: Int,
        val totalItems: Int,
        val totalPages: Int,
        val items: List<T>
    )

    data class Layout(
        val rows: List<Row>,
        val renderedCardCount: Int
    )

    fun sortItems(items: List<GalleryAssetItem>): List<GalleryAssetItem> {
        return items.sortedWith(
            compareBy<GalleryAssetItem> { platformOrder(it.platform) }
                .thenBy { it.projectName.lowercase(Locale.ROOT) }
                .thenBy { it.moduleName.lowercase(Locale.ROOT) }
                .thenBy { normalizeGroupPath(it.groupPath).lowercase(Locale.ROOT) }
                .thenBy { it.fileName.lowercase(Locale.ROOT) }
        )
    }

    fun <T> paginate(items: List<T>, requestedPageIndex: Int, requestedPageSize: Int): Page<T> {
        val pageSize = requestedPageSize.coerceAtLeast(1)
        val totalItems = items.size
        val totalPages = maxOf(1, (totalItems + pageSize - 1) / pageSize)
        val pageIndex = requestedPageIndex.coerceIn(0, totalPages - 1)
        val fromIndex = (pageIndex * pageSize).coerceAtMost(totalItems)
        val toIndex = (fromIndex + pageSize).coerceAtMost(totalItems)
        val pageItems = if (fromIndex >= toIndex) emptyList() else items.subList(fromIndex, toIndex)
        return Page(
            pageIndex = pageIndex,
            pageSize = pageSize,
            totalItems = totalItems,
            totalPages = totalPages,
            items = pageItems
        )
    }

    fun buildRows(items: List<GalleryAssetItem>, columns: Int): Layout {
        if (items.isEmpty()) {
            return Layout(emptyList(), 0)
        }

        val safeColumns = columns.coerceAtLeast(1)
        val rows = mutableListOf<Row>()
        var renderedCardCount = 0

        var lastPlatform: String? = null
        var lastProject: String? = null
        var lastModule: String? = null
        var lastDirectory: String? = null
        val currentRow = mutableListOf<GalleryAssetItem>()

        fun flushRow() {
            if (currentRow.isEmpty()) return
            rows += CardsRow(SectionLevel.DIRECTORY, currentRow.toList())
            renderedCardCount += currentRow.size
            currentRow.clear()
        }

        for (item in items) {
            val normalizedDirectory = normalizeGroupPath(item.groupPath)

            if (item.platform != lastPlatform) {
                flushRow()
                rows += HeaderRow(SectionLevel.PLATFORM, platformLabel(item.platform))
                lastPlatform = item.platform
                lastProject = null
                lastModule = null
                lastDirectory = null
            }

            if (item.projectName != lastProject) {
                flushRow()
                rows += HeaderRow(SectionLevel.PROJECT, item.projectName)
                lastProject = item.projectName
                lastModule = null
                lastDirectory = null
            }

            if (item.moduleName != lastModule) {
                flushRow()
                rows += HeaderRow(SectionLevel.MODULE, item.moduleName)
                lastModule = item.moduleName
                lastDirectory = null
            }

            if (normalizedDirectory != lastDirectory) {
                flushRow()
                rows += HeaderRow(SectionLevel.DIRECTORY, normalizedDirectory)
                lastDirectory = normalizedDirectory
            }

            currentRow += item
            if (currentRow.size >= safeColumns) {
                flushRow()
            }
        }

        flushRow()
        return Layout(rows, renderedCardCount)
    }

    private fun normalizeGroupPath(path: String): String {
        return if (path.isBlank() || path == ".") "." else path
    }

    private fun platformOrder(platform: String): Int = when (platform) {
        "android" -> 0
        "flutter" -> 1
        "ios" -> 2
        else -> 9
    }

    private fun platformLabel(platform: String): String = when (platform) {
        "android" -> "Android"
        "flutter" -> "Flutter"
        "ios" -> "iOS"
        else -> platform
    }
}
