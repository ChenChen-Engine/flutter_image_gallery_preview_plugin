package com.yourorg.imagegallerypreview.util

import org.yaml.snakeyaml.Yaml
import java.io.File

object PubspecAssetsParser {
    private val yaml = Yaml()

    fun parseAssetEntries(pubspec: File): List<String> {
        val rootMap = loadRootMap(pubspec) ?: return emptyList()
        val flutter = rootMap["flutter"] as? Map<*, *> ?: return emptyList()
        val assets = flutter["assets"] as? List<*> ?: return emptyList()

        return assets.mapNotNull { entry ->
            when (entry) {
                is String -> normalizeEntry(entry)
                is Map<*, *> -> normalizeEntry(entry["path"] as? String)
                else -> null
            }
        }
    }

    fun parseProjectName(pubspec: File): String? {
        val rootMap = loadRootMap(pubspec) ?: return null
        val name = rootMap["name"] as? String
        return normalizeEntry(name)
    }

    fun isFlutterProject(pubspec: File): Boolean {
        val rootMap = loadRootMap(pubspec) ?: return false
        if (rootMap["flutter"] is Map<*, *>) return true

        val dependencies = rootMap["dependencies"] as? Map<*, *>
        val devDependencies = rootMap["dev_dependencies"] as? Map<*, *>
        return isFlutterDependency(dependencies?.get("flutter")) ||
            isFlutterDependency(devDependencies?.get("flutter"))
    }

    private fun isFlutterDependency(value: Any?): Boolean {
        return when (value) {
            is String -> value.contains("flutter", ignoreCase = true)
            is Map<*, *> -> value["sdk"]?.toString()?.equals("flutter", ignoreCase = true) == true
            else -> false
        }
    }

    private fun loadRootMap(pubspec: File): Map<*, *>? {
        if (!pubspec.exists() || !pubspec.isFile) return null
        return try {
            val loaded = yaml.load<Any?>(pubspec.readText())
            loaded as? Map<*, *>
        } catch (_: Throwable) {
            null
        }
    }

    private fun normalizeEntry(raw: String?): String? {
        if (raw == null) return null
        val clean = raw.trim().removeSurrounding("\"").removeSurrounding("'").trim()
        return clean.ifBlank { null }
    }
}
