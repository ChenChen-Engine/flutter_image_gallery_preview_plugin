package com.yourorg.imagegallerypreview.scanner

import com.yourorg.imagegallerypreview.model.GalleryAssetItem
import com.yourorg.imagegallerypreview.model.SourceType
import com.yourorg.imagegallerypreview.util.AssetFileUtil
import com.yourorg.imagegallerypreview.util.PubspecAssetsParser
import java.io.File
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap

class FileSystemAssetScanner(private val root: File) : AssetScanner {

    private val ignoredDirs = setOf(
        ".git", ".gradle", ".idea", "build", "out", "output", "dist", "node_modules", ".dart_tool", "Pods"
    )

    private val androidProjectCache = ConcurrentHashMap<File, String>()

    override fun scan(): List<GalleryAssetItem> {
        if (!root.exists() || !root.isDirectory) return emptyList()

        val results = mutableListOf<GalleryAssetItem>()
        scanAndroidResources(results)
        scanFlutterAssets(results)
        scanIosAssets(results)

        return results
            .distinctBy { "${it.platform}|${it.projectName}|${it.moduleName}|${it.relPath}|${it.copyToken}" }
            .sortedWith(
                compareBy<GalleryAssetItem> { it.platform }
                    .thenBy { it.projectName.lowercase(Locale.ROOT) }
                    .thenBy { it.moduleName.lowercase(Locale.ROOT) }
                    .thenBy { it.groupPath.lowercase(Locale.ROOT) }
                    .thenBy { it.fileName.lowercase(Locale.ROOT) }
            )
    }

    private fun scanAndroidResources(results: MutableList<GalleryAssetItem>) {
        for (resDir in walkFiltered(root)) {
            if (!resDir.isDirectory || !resDir.name.equals("res", ignoreCase = true)) continue

            val sourceSetDir = resDir.parentFile ?: continue
            val srcDir = sourceSetDir.parentFile ?: continue
            if (!srcDir.name.equals("src", ignoreCase = true)) continue

            val moduleRoot = srcDir.parentFile ?: continue
            val moduleName = resolveModuleName(moduleRoot)
            val projectName = resolveAndroidProjectName(moduleRoot)

            val bucketDirs = resDir.listFiles()?.filter {
                it.isDirectory && (it.name.startsWith("drawable", ignoreCase = true) || it.name.startsWith("mipmap", ignoreCase = true))
            } ?: emptyList()

            for (bucketDir in bucketDirs) {
                val qualifier = bucketDir.name.substringAfter('-', "")
                val bucketName = bucketDir.name
                val files = bucketDir.listFiles()?.filter { it.isFile } ?: emptyList()

                for (file in files) {
                    val family = AssetFileUtil.detectFormatFamily(file, preferVectorXml = true)
                    if (!AssetFileUtil.isSupportedFamily(family)) continue

                    val kind = AssetFileUtil.assetKind(family)
                    val size = AssetFileUtil.readImageSize(file, family)
                    val moduleRelPath = AssetFileUtil.relativePath(moduleRoot, file, root)
                    val groupPath = moduleRelPath.substringBeforeLast('/', ".")

                    results += GalleryAssetItem(
                        sourceType = SourceType.ANDROID_RES,
                        platform = SourceType.ANDROID_RES.platform,
                        projectName = projectName,
                        moduleName = moduleName,
                        groupPath = groupPath,
                        copyToken = AssetFileUtil.androidCopyToken(bucketName, file),
                        md5 = AssetFileUtil.md5Hex(file),
                        formatFamily = family,
                        absPath = file.absolutePath,
                        relPath = AssetFileUtil.relativePath(root, file),
                        format = file.extension.lowercase(Locale.ROOT),
                        width = size?.first,
                        height = size?.second,
                        qualifier = qualifier,
                        mtime = file.lastModified(),
                        kind = kind
                    )
                }
            }
        }
    }

    private fun scanFlutterAssets(results: MutableList<GalleryAssetItem>) {
        val pubspecs = mutableListOf<File>()
        for (file in walkFiltered(root)) {
            if (file.isFile && file.name.equals("pubspec.yaml", ignoreCase = true)) {
                pubspecs += file
            }
        }

        for (pubspec in pubspecs) {
            val moduleRoot = pubspec.parentFile ?: continue
            val moduleName = resolveFlutterModuleName(moduleRoot, pubspec)
            val projectName = resolveFlutterProjectName(moduleRoot, pubspec)
            val entries = PubspecAssetsParser.parseAssetEntries(pubspec)

            for (raw in entries) {
                val entry = normalizeAssetEntry(raw)
                if (entry.isBlank()) continue

                val target = File(moduleRoot, entry)
                when {
                    target.isFile -> addFlutterFile(target, moduleRoot, projectName, moduleName, results)
                    target.isDirectory -> {
                        for (file in walkFiltered(target)) {
                            if (!file.isFile) continue
                            addFlutterFile(file, moduleRoot, projectName, moduleName, results)
                        }
                    }
                    else -> {
                        val wildcardFiles = resolveWildcardTargets(moduleRoot, entry)
                        for (file in wildcardFiles) {
                            addFlutterFile(file, moduleRoot, projectName, moduleName, results)
                        }
                    }
                }
            }
        }
    }

    private fun addFlutterFile(
        file: File,
        moduleRoot: File,
        projectName: String,
        moduleName: String,
        results: MutableList<GalleryAssetItem>
    ) {
        val family = AssetFileUtil.detectFormatFamily(file, preferVectorXml = false)
        if (!AssetFileUtil.isSupportedFamily(family)) return

        val kind = AssetFileUtil.assetKind(family)
        val size = AssetFileUtil.readImageSize(file, family)
        val moduleRelPath = AssetFileUtil.relativePath(moduleRoot, file, root)
        val groupPath = moduleRelPath.substringBeforeLast('/', ".")

        results += GalleryAssetItem(
            sourceType = SourceType.FLUTTER_ASSET,
            platform = SourceType.FLUTTER_ASSET.platform,
            projectName = projectName,
            moduleName = moduleName,
            groupPath = groupPath,
            copyToken = AssetFileUtil.flutterCopyToken(moduleRoot, file),
            md5 = AssetFileUtil.md5Hex(file),
            formatFamily = family,
            absPath = file.absolutePath,
            relPath = AssetFileUtil.relativePath(root, file),
            format = file.extension.lowercase(Locale.ROOT),
            width = size?.first,
            height = size?.second,
            qualifier = "",
            mtime = file.lastModified(),
            kind = kind
        )
    }

    private fun scanIosAssets(results: MutableList<GalleryAssetItem>) {
        val iosRoot = File(root, "ios")
        if (!iosRoot.exists() || !iosRoot.isDirectory) return

        val seenPaths = mutableSetOf<String>()
        scanIosXcassets(iosRoot, results, seenPaths)
        scanIosImageFiles(iosRoot, results, seenPaths)
    }

    private fun scanIosXcassets(
        iosRoot: File,
        results: MutableList<GalleryAssetItem>,
        seenPaths: MutableSet<String>
    ) {
        for (imageSetDir in walkFiltered(iosRoot)) {
            if (!imageSetDir.isDirectory || !imageSetDir.name.endsWith(".imageset", ignoreCase = true)) continue

            val contents = File(imageSetDir, "Contents.json")
            if (!contents.exists() || !contents.isFile) continue

            val filenames = extractIosImageSetFilenames(contents)
            if (filenames.isEmpty()) continue

            val moduleRoot = findIosModuleRoot(imageSetDir, iosRoot)
            val moduleName = resolveIosModuleName(moduleRoot)
            val projectName = resolveIosProjectName(moduleRoot)

            for (fileName in filenames) {
                val candidate = File(imageSetDir, fileName)
                if (!candidate.exists() || !candidate.isFile) continue

                val normalized = AssetFileUtil.normalizePath(candidate.absolutePath)
                if (!seenPaths.add(normalized)) continue

                addIosFile(candidate, moduleRoot, projectName, moduleName, results)
            }
        }
    }

    private fun scanIosImageFiles(
        iosRoot: File,
        results: MutableList<GalleryAssetItem>,
        seenPaths: MutableSet<String>
    ) {
        for (file in walkFiltered(iosRoot)) {
            if (!file.isFile) continue

            val normalizedPath = AssetFileUtil.normalizePath(file.absolutePath)
            if (normalizedPath.lowercase(Locale.ROOT).contains(".xcassets/")) continue
            if (file.name.equals("Contents.json", ignoreCase = true)) continue

            val family = AssetFileUtil.detectFormatFamily(file, preferVectorXml = false)
            if (!AssetFileUtil.isSupportedFamily(family)) continue
            if (!seenPaths.add(normalizedPath)) continue

            val moduleRoot = findIosModuleRoot(file, iosRoot)
            val moduleName = resolveIosModuleName(moduleRoot)
            val projectName = resolveIosProjectName(moduleRoot)
            addIosFile(file, moduleRoot, projectName, moduleName, results, family)
        }
    }

    private fun addIosFile(
        file: File,
        moduleRoot: File,
        projectName: String,
        moduleName: String,
        results: MutableList<GalleryAssetItem>,
        preDetectedFamily: String? = null
    ) {
        val family = preDetectedFamily ?: AssetFileUtil.detectFormatFamily(file, preferVectorXml = false)
        if (!AssetFileUtil.isSupportedFamily(family)) return

        val kind = AssetFileUtil.assetKind(family)
        val size = AssetFileUtil.readImageSize(file, family)
        val moduleRelPath = AssetFileUtil.relativePath(moduleRoot, file, root)
        val groupPath = moduleRelPath.substringBeforeLast('/', ".")

        results += GalleryAssetItem(
            sourceType = SourceType.IOS_ASSET,
            platform = SourceType.IOS_ASSET.platform,
            projectName = projectName,
            moduleName = moduleName,
            groupPath = groupPath,
            copyToken = AssetFileUtil.iosCopyToken(moduleRoot, file),
            md5 = AssetFileUtil.md5Hex(file),
            formatFamily = family,
            absPath = file.absolutePath,
            relPath = AssetFileUtil.relativePath(root, file),
            format = file.extension.lowercase(Locale.ROOT),
            width = size?.first,
            height = size?.second,
            qualifier = "",
            mtime = file.lastModified(),
            kind = kind
        )
    }

    private fun extractIosImageSetFilenames(contentsFile: File): List<String> {
        return try {
            Regex("""\"filename\"\s*:\s*\"([^\"]+)\"""")
                .findAll(contentsFile.readText())
                .mapNotNull { it.groupValues.getOrNull(1) }
                .filter { it.isNotBlank() }
                .distinct()
                .toList()
        } catch (_: Throwable) {
            emptyList()
        }
    }

    private fun findIosModuleRoot(file: File, iosRoot: File): File {
        var cursor: File? = if (file.isDirectory) file else file.parentFile
        var fallback: File = iosRoot

        while (cursor != null) {
            if (cursor.name == "ios") return fallback

            val hasXcodeProj = cursor.listFiles()?.any {
                it.name.endsWith(".xcodeproj", ignoreCase = true)
            } == true
            if (hasXcodeProj) fallback = cursor

            cursor = cursor.parentFile
        }

        return fallback
    }

    private fun resolveModuleName(moduleRoot: File): String = moduleRoot.name.ifBlank { "root" }

    private fun resolveFlutterModuleName(moduleRoot: File, pubspec: File): String {
        val pubspecName = PubspecAssetsParser.parseProjectName(pubspec)
        if (!pubspecName.isNullOrBlank()) {
            return moduleRoot.name.ifBlank { pubspecName }
        }
        return resolveModuleName(moduleRoot)
    }

    private fun resolveFlutterProjectName(moduleRoot: File, pubspec: File): String {
        return PubspecAssetsParser.parseProjectName(pubspec).takeUnless { it.isNullOrBlank() }
            ?: moduleRoot.name.ifBlank { "flutter" }
    }

    private fun resolveIosModuleName(moduleRoot: File): String {
        val name = moduleRoot.nameWithoutExtension
        return if (name.isBlank()) "ios" else name
    }

    private fun resolveIosProjectName(moduleRoot: File): String {
        var cursor: File? = moduleRoot
        while (cursor != null && cursor != root) {
            if (cursor.name.equals("ios", ignoreCase = true)) {
                val parentName = cursor.parentFile?.name?.takeIf { it.isNotBlank() }
                return parentName ?: "ios"
            }
            cursor = cursor.parentFile
        }
        return moduleRoot.parentFile?.name?.takeIf { it.isNotBlank() } ?: moduleRoot.name
    }

    private fun resolveAndroidProjectName(moduleRoot: File): String {
        return androidProjectCache.computeIfAbsent(moduleRoot) { resolveAndroidProjectNameInternal(it) }
    }

    private fun resolveAndroidProjectNameInternal(moduleRoot: File): String {
        var cursor: File? = moduleRoot
        while (cursor != null) {
            if (cursor == root.parentFile) break
            val hasSettings = File(cursor, "settings.gradle").exists() || File(cursor, "settings.gradle.kts").exists()
            if (hasSettings) {
                return cursor.name.ifBlank { "android" }
            }
            if (cursor == root) {
                break
            }
            cursor = cursor.parentFile
        }
        return moduleRoot.parentFile?.name?.takeIf { it.isNotBlank() } ?: moduleRoot.name
    }

    private fun normalizeAssetEntry(raw: String): String {
        val clean = raw.trim().removeSurrounding("\"").removeSurrounding("'")
        return clean.replace('\\', '/').trimStart('/')
    }

    private fun resolveWildcardTargets(moduleRoot: File, entry: String): List<File> {
        val normalized = entry.replace('\\', '/').trimStart('/')
        val wildcardPos = normalized.indexOf('*')
        if (wildcardPos < 0) return emptyList()

        val slashPos = normalized.lastIndexOf('/', wildcardPos)
        val basePrefix = if (slashPos >= 0) normalized.substring(0, slashPos + 1) else ""
        val baseDir = File(moduleRoot, basePrefix)
        if (!baseDir.exists() || !baseDir.isDirectory) return emptyList()

        val extPattern = Regex("""\*\*?/\*\.([a-zA-Z0-9]+)$|\*\.([a-zA-Z0-9]+)$""")
        val ext = extPattern.find(normalized)
            ?.groupValues
            ?.drop(1)
            ?.firstOrNull { it.isNotBlank() }
            ?.lowercase(Locale.ROOT)

        val files = mutableListOf<File>()
        for (candidate in walkFiltered(baseDir)) {
            if (!candidate.isFile) continue
            if (ext != null && !candidate.extension.equals(ext, ignoreCase = true)) continue
            files += candidate
        }
        return files
    }

    private fun walkFiltered(start: File): Sequence<File> {
        return start.walkTopDown().onEnter { dir -> !shouldSkipDirectory(dir) }
    }

    private fun shouldSkipDirectory(dir: File): Boolean {
        if (!dir.isDirectory) return false
        if (dir == root) return false
        return dir.name in ignoredDirs
    }
}

