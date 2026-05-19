package com.yourorg.imagegallerypreview.navigation

import com.yourorg.imagegallerypreview.model.GalleryAssetItem
import com.yourorg.imagegallerypreview.util.AssetFileUtil
import java.util.Locale

object GalleryResourceReferenceResolver {
    data class StaticStringLiteral(
        val value: String,
        val contentStart: Int,
        val contentEnd: Int
    )

    fun parseStaticStringLiteral(text: String): StaticStringLiteral? {
        if (text.length < 2 || text.any { it == '\n' || it == '\r' }) return null
        val quoteIndex = when {
            isQuote(text[0]) -> 0
            text.length >= 3 && (text[0] == 'r' || text[0] == 'R') && isQuote(text[1]) -> 1
            else -> return null
        }
        val quote = text[quoteIndex]
        if (text.last() != quote) return null

        val raw = quoteIndex == 1
        val body = text.substring(quoteIndex + 1, text.length - 1)
        if (!raw && body.contains('$')) return null

        val value = if (raw) body else unescape(body) ?: return null
        return StaticStringLiteral(
            value = normalizeReference(value),
            contentStart = quoteIndex + 1,
            contentEnd = text.length - 1
        )
    }

    fun buildIndex(items: List<GalleryAssetItem>): Map<String, List<GalleryAssetItem>> {
        return items
            .flatMap { item -> referenceKeys(item).map { key -> key to item } }
            .groupBy({ it.first }, { it.second })
            .mapValues { (_, value) -> value.sortedBy { normalizePath(it.absPath) } }
    }

    fun resolve(
        items: List<GalleryAssetItem>,
        value: String,
        currentFilePath: String?
    ): GalleryAssetItem? {
        return resolve(buildIndex(items), value, currentFilePath)
    }

    fun resolve(
        index: Map<String, List<GalleryAssetItem>>,
        value: String,
        currentFilePath: String?
    ): GalleryAssetItem? {
        val candidates = index[normalizeReference(value)].orEmpty()
        if (candidates.isEmpty()) return null
        val current = normalizePath(currentFilePath.orEmpty()).lowercase(Locale.ROOT)
        return candidates.sortedWith(
            compareByDescending<GalleryAssetItem> { contextScore(it, current) }
                .thenBy { normalizePath(it.absPath) }
        ).firstOrNull()
    }

    private fun referenceKeys(item: GalleryAssetItem): Set<String> {
        return setOf(item.copyToken, item.relPath)
            .map { normalizeReference(it) }
            .filter { it.isNotBlank() }
            .toSet()
    }

    private fun contextScore(item: GalleryAssetItem, currentPathLower: String): Int {
        val modulePath = normalizePath(item.modulePath).lowercase(Locale.ROOT).trimEnd('/')
        val projectPath = normalizePath(item.projectPath).lowercase(Locale.ROOT).trimEnd('/')
        var score = 0
        if (modulePath.isNotBlank() && currentPathLower.startsWith("$modulePath/")) score += 100
        if (projectPath.isNotBlank() && currentPathLower.startsWith("$projectPath/")) score += 50
        if (item.isPrimaryModule) score += 10
        if (item.isPrimaryProject) score += 5
        return score
    }

    private fun normalizeReference(value: String): String {
        return normalizePath(value).trimStart('/')
    }

    private fun normalizePath(value: String): String {
        return AssetFileUtil.normalizePath(value)
    }

    private fun isQuote(value: Char): Boolean = value == '\'' || value == '"'

    private fun unescape(value: String): String? {
        val builder = StringBuilder()
        var index = 0
        while (index < value.length) {
            val ch = value[index]
            if (ch == '\\') {
                if (index + 1 >= value.length) return null
                builder.append(value[index + 1])
                index += 2
            } else {
                builder.append(ch)
                index += 1
            }
        }
        return builder.toString()
    }
}
