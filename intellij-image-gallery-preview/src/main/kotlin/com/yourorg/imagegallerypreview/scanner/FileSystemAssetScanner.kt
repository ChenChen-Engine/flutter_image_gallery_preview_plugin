package com.yourorg.imagegallerypreview.scanner

import com.yourorg.imagegallerypreview.model.GalleryAssetItem
import com.yourorg.imagegallerypreview.model.SourceType
import com.yourorg.imagegallerypreview.util.AssetFileUtil
import com.yourorg.imagegallerypreview.util.PubspecAssetsParser
import java.io.File
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap

class FileSystemAssetScanner(openedRoot: File) : AssetScanner {

    private val ignoredDirs = setOf(
        ".git", ".gradle", ".idea", "build", "out", "output", "dist", "node_modules", ".dart_tool", "pods", "deriveddata"
    )

    private val root: File = resolveWorkspaceRoot(openedRoot.absoluteFile)
    private val workspaceKind: String = detectWorkspaceKind(root)

    private val androidProjectCache = ConcurrentHashMap<File, ProjectIdentity>()
    private val flutterProjectCache = ConcurrentHashMap<File, ProjectIdentity?>()

    private data class ProjectIdentity(
        val name: String,
        val path: String,
        val isPrimary: Boolean
    )

    override fun scan(): List<GalleryAssetItem> {
        if (!root.exists() || !root.isDirectory) return emptyList()

        val results = mutableListOf<GalleryAssetItem>()
        scanAndroidResources(results)
        scanFlutterAssets(results)
        scanIosAssets(results)

        return results
            .distinctBy { "${it.platform}|${it.projectPath}|${it.modulePath}|${it.relPath}|${it.copyToken}" }
            .sortedWith(
                compareBy<GalleryAssetItem> { it.platform }
                    .thenBy { !it.isPrimaryProject }
                    .thenBy { it.projectName.lowercase(Locale.ROOT) }
                    .thenBy { it.projectRelPath.lowercase(Locale.ROOT) }
                    .thenBy { !it.isPrimaryModule }
                    .thenBy { it.moduleName.lowercase(Locale.ROOT) }
                    .thenBy { it.moduleRelPath.lowercase(Locale.ROOT) }
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
            val projectIdentity = resolveAndroidProject(moduleRoot)

            val bucketDirs = resDir.listFiles()?.filter {
                it.isDirectory && (
                    it.name.startsWith("drawable", ignoreCase = true) ||
                        it.name.startsWith("mipmap", ignoreCase = true) ||
                        it.name.startsWith("raw", ignoreCase = true)
                    )
            } ?: emptyList()

            for (bucketDir in bucketDirs) {
                val qualifier = bucketDir.name.substringAfter('-', "")
                val bucketName = bucketDir.name
                val files = bucketDir.listFiles()?.filter { it.isFile } ?: emptyList()

                for (file in files) {
                    val family = AssetFileUtil.detectFormatFamily(file, preferVectorXml = true)
                    if (!AssetFileUtil.isSupportedFamily(family)) continue
                    val mediaType = AssetFileUtil.mediaType(family)
                    val isRaw = bucketName.startsWith("raw", ignoreCase = true)
                    if (isRaw && mediaType == "image") continue
                    if (!isRaw && mediaType != "image") continue

                    val kind = AssetFileUtil.assetKind(family)
                    val size = AssetFileUtil.readImageSize(file, family)
                    val moduleRelPath = AssetFileUtil.relativePath(moduleRoot, file, root)
                    val groupPath = moduleRelPath.substringBeforeLast('/', ".")

                    results += GalleryAssetItem(
                        sourceType = SourceType.ANDROID_RES,
                        platform = SourceType.ANDROID_RES.platform,
                        workspaceKind = workspaceKind,
                        projectName = projectIdentity.name,
                        projectPath = projectIdentity.path,
                        projectRelPath = displayRelativePath(File(projectIdentity.path)),
                        isPrimaryProject = projectIdentity.isPrimary,
                        moduleName = moduleName,
                        modulePath = AssetFileUtil.normalizePath(moduleRoot.absolutePath),
                        moduleRelPath = displayRelativePath(moduleRoot),
                        isPrimaryModule = isPrimaryModule(moduleName),
                        groupPath = groupPath,
                        copyToken = AssetFileUtil.androidCopyToken(bucketName, file),
                        md5 = AssetFileUtil.md5Hex(file),
                        formatFamily = family,
                        isAnimated = AssetFileUtil.isAnimated(file, family),
                        mediaType = mediaType,
                        durationMillis = null,
                        resourceRootPath = AssetFileUtil.normalizePath(bucketDir.absolutePath),
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
            if (!PubspecAssetsParser.isFlutterProject(pubspec)) continue
            val moduleRoot = pubspec.parentFile ?: continue
            val moduleName = resolveFlutterModuleName(moduleRoot, pubspec)
            val projectIdentity = resolveFlutterProject(moduleRoot, pubspec)
            val entries = PubspecAssetsParser.parseAssetEntries(pubspec)
            val seenProjectFiles = linkedSetOf<String>()

            fun addCandidate(file: File, resourceRoot: File) {
                val normalized = AssetFileUtil.normalizePath(file.absolutePath)
                if (seenProjectFiles.add(normalized)) {
                    addFlutterFile(file, moduleRoot, projectIdentity, moduleName, resourceRoot, results)
                }
            }

            for (raw in entries) {
                val entry = normalizeAssetEntry(raw)
                if (entry.isBlank()) continue

                val target = File(moduleRoot, entry)
                when {
                    target.isFile -> addCandidate(target, target.parentFile ?: moduleRoot)
                    target.isDirectory -> {
                        for (file in walkFiltered(target)) {
                            if (!file.isFile) continue
                            addCandidate(file, target)
                        }
                    }
                    else -> {
                        val wildcardFiles = resolveWildcardTargets(moduleRoot, entry)
                        for (file in wildcardFiles) {
                            addCandidate(file, file.parentFile ?: moduleRoot)
                        }
                    }
                }
            }

            for (fallbackName in listOf("assets", "res")) {
                val fallbackDir = File(moduleRoot, fallbackName)
                if (!fallbackDir.exists() || !fallbackDir.isDirectory) continue
                for (file in walkFiltered(fallbackDir)) {
                    if (!file.isFile) continue
                    addCandidate(file, fallbackDir)
                }
            }
        }
    }

    private fun addFlutterFile(
        file: File,
        moduleRoot: File,
        projectIdentity: ProjectIdentity,
        moduleName: String,
        resourceRoot: File,
        results: MutableList<GalleryAssetItem>
    ) {
        val family = AssetFileUtil.detectFormatFamily(file, preferVectorXml = false)
        if (!AssetFileUtil.isSupportedFamily(family)) return

        val kind = AssetFileUtil.assetKind(family)
        val mediaType = AssetFileUtil.mediaType(family)
        val size = AssetFileUtil.readImageSize(file, family)
        val moduleRelPath = AssetFileUtil.relativePath(moduleRoot, file, root)
        val groupPath = moduleRelPath.substringBeforeLast('/', ".")

        results += GalleryAssetItem(
            sourceType = SourceType.FLUTTER_ASSET,
            platform = SourceType.FLUTTER_ASSET.platform,
            workspaceKind = workspaceKind,
            projectName = projectIdentity.name,
            projectPath = projectIdentity.path,
            projectRelPath = displayRelativePath(File(projectIdentity.path)),
            isPrimaryProject = projectIdentity.isPrimary,
            moduleName = moduleName,
            modulePath = AssetFileUtil.normalizePath(moduleRoot.absolutePath),
            moduleRelPath = displayRelativePath(moduleRoot),
            isPrimaryModule = projectIdentity.isPrimary,
            groupPath = groupPath,
            copyToken = AssetFileUtil.flutterCopyToken(moduleRoot, file),
            md5 = AssetFileUtil.md5Hex(file),
            formatFamily = family,
            isAnimated = AssetFileUtil.isAnimated(file, family),
            mediaType = mediaType,
            durationMillis = null,
            resourceRootPath = AssetFileUtil.normalizePath(resourceRoot.absolutePath),
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
        val seenPaths = mutableSetOf<String>()
        for (iosRoot in findIosRoots()) {
            scanIosXcassets(iosRoot, results, seenPaths)
            scanIosImageFiles(iosRoot, results, seenPaths)
        }
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
            val projectIdentity = resolveIosProject(moduleRoot)

            for (fileName in filenames) {
                val candidate = File(imageSetDir, fileName)
                if (!candidate.exists() || !candidate.isFile) continue

                val normalized = AssetFileUtil.normalizePath(candidate.absolutePath)
                if (!seenPaths.add(normalized)) continue

                addIosFile(candidate, moduleRoot, projectIdentity, moduleName, imageSetDir, results)
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
            if (!isIosBundleResourceFile(file, iosRoot)) continue

            val family = AssetFileUtil.detectFormatFamily(file, preferVectorXml = false)
            if (!AssetFileUtil.isSupportedFamily(family)) continue
            if (!seenPaths.add(normalizedPath)) continue

            val moduleRoot = findIosModuleRoot(file, iosRoot)
            val moduleName = resolveIosModuleName(moduleRoot)
            val projectIdentity = resolveIosProject(moduleRoot)
            addIosFile(file, moduleRoot, projectIdentity, moduleName, file.parentFile ?: moduleRoot, results, family)
        }
    }

    private fun addIosFile(
        file: File,
        moduleRoot: File,
        projectIdentity: ProjectIdentity,
        moduleName: String,
        resourceRoot: File,
        results: MutableList<GalleryAssetItem>,
        preDetectedFamily: String? = null
    ) {
        val family = preDetectedFamily ?: AssetFileUtil.detectFormatFamily(file, preferVectorXml = false)
        if (!AssetFileUtil.isSupportedFamily(family)) return

        val kind = AssetFileUtil.assetKind(family)
        val mediaType = AssetFileUtil.mediaType(family)
        val size = AssetFileUtil.readImageSize(file, family)
        val moduleRelPath = AssetFileUtil.relativePath(moduleRoot, file, root)
        val groupPath = moduleRelPath.substringBeforeLast('/', ".")

        results += GalleryAssetItem(
            sourceType = SourceType.IOS_ASSET,
            platform = SourceType.IOS_ASSET.platform,
            workspaceKind = workspaceKind,
            projectName = projectIdentity.name,
            projectPath = projectIdentity.path,
            projectRelPath = displayRelativePath(File(projectIdentity.path)),
            isPrimaryProject = projectIdentity.isPrimary,
            moduleName = moduleName,
            modulePath = AssetFileUtil.normalizePath(moduleRoot.absolutePath),
            moduleRelPath = displayRelativePath(moduleRoot),
            isPrimaryModule = projectIdentity.isPrimary && moduleName.equals("Runner", ignoreCase = true),
            groupPath = groupPath,
            copyToken = AssetFileUtil.iosCopyToken(moduleRoot, file),
            md5 = AssetFileUtil.md5Hex(file),
            formatFamily = family,
            isAnimated = AssetFileUtil.isAnimated(file, family),
            mediaType = mediaType,
            durationMillis = null,
            resourceRootPath = AssetFileUtil.normalizePath(resourceRoot.absolutePath),
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

    private fun isIosBundleResourceFile(file: File, iosRoot: File): Boolean {
        val relative = AssetFileUtil.relativePath(iosRoot, file).lowercase(Locale.ROOT)
        val segments = relative.split('/').filter { it.isNotBlank() }
        if (segments.any { it in setOf("build", "pods", "deriveddata", "source", "sources", "classes") }) {
            return false
        }
        if (segments.any { it.endsWith(".xcodeproj") || it.endsWith(".xcworkspace") }) {
            return false
        }
        if (segments.any { it in setOf("resources", "assets", "res") }) return true
        if (segments.firstOrNull()?.equals("runner", ignoreCase = true) == true && segments.size <= 2) return true
        return false
    }

    private fun resolveModuleName(moduleRoot: File): String = moduleRoot.name.ifBlank { "root" }

    private fun resolveFlutterModuleName(moduleRoot: File, pubspec: File): String {
        val pubspecName = PubspecAssetsParser.parseProjectName(pubspec)
        if (!pubspecName.isNullOrBlank()) {
            return moduleRoot.name.ifBlank { pubspecName }
        }
        return resolveModuleName(moduleRoot)
    }

    private fun resolveFlutterProject(moduleRoot: File, pubspec: File): ProjectIdentity {
        val name = PubspecAssetsParser.parseProjectName(pubspec).takeUnless { it.isNullOrBlank() }
            ?: moduleRoot.name.ifBlank { "flutter" }
        return ProjectIdentity(
            name = name,
            path = AssetFileUtil.normalizePath(moduleRoot.absolutePath),
            isPrimary = sameFile(moduleRoot, root)
        )
    }

    private fun resolveIosModuleName(moduleRoot: File): String {
        val name = moduleRoot.nameWithoutExtension
        return if (name.isBlank()) "ios" else name
    }

    private fun resolveIosProject(moduleRoot: File): ProjectIdentity {
        findNearestFlutterProject(moduleRoot)?.let { return it }

        return ProjectIdentity(
            name = resolveIosProjectName(moduleRoot),
            path = AssetFileUtil.normalizePath(moduleRoot.absolutePath),
            isPrimary = workspaceKind == "ios" && (sameFile(moduleRoot, root) || isDescendant(moduleRoot, root))
        )
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

    private fun resolveAndroidProject(moduleRoot: File): ProjectIdentity {
        return androidProjectCache.computeIfAbsent(moduleRoot) { resolveAndroidProjectInternal(it) }
    }

    private fun resolveAndroidProjectInternal(moduleRoot: File): ProjectIdentity {
        findNearestFlutterProject(moduleRoot)?.let { return it }

        if (workspaceKind == "android") {
            return ProjectIdentity(
                name = primaryAndroidProjectName(),
                path = AssetFileUtil.normalizePath(root.absolutePath),
                isPrimary = true
            )
        }

        var cursor: File? = moduleRoot
        while (cursor != null) {
            if (cursor == root.parentFile) break
            val hasSettings = File(cursor, "settings.gradle").exists() || File(cursor, "settings.gradle.kts").exists()
            if (hasSettings) {
                return ProjectIdentity(
                    name = cursor.name.ifBlank { "android" },
                    path = AssetFileUtil.normalizePath(cursor.absolutePath),
                    isPrimary = sameFile(cursor, root)
                )
            }
            if (cursor == root) {
                break
            }
            cursor = cursor.parentFile
        }

        return ProjectIdentity(
            name = moduleRoot.parentFile?.name?.takeIf { it.isNotBlank() } ?: moduleRoot.name,
            path = AssetFileUtil.normalizePath(moduleRoot.parentFile?.absolutePath ?: moduleRoot.absolutePath),
            isPrimary = false
        )
    }

    private fun findNearestFlutterProject(start: File): ProjectIdentity? {
        return flutterProjectCache.computeIfAbsent(start.absoluteFile) {
            var cursor: File? = if (start.isDirectory) start else start.parentFile
            while (cursor != null && isDescendantOrSame(cursor, root)) {
                val pubspec = File(cursor, "pubspec.yaml")
                if (pubspec.exists() && pubspec.isFile) {
                    return@computeIfAbsent resolveFlutterProject(cursor, pubspec)
                }
                if (sameFile(cursor, root)) break
                cursor = cursor.parentFile
            }
            null
        }
    }

    private fun primaryAndroidProjectName(): String {
        return if (File(root, "app").exists()) "app" else root.name.ifBlank { "app" }
    }

    private fun isPrimaryModule(moduleName: String): Boolean {
        return moduleName.equals("app", ignoreCase = true)
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

    private fun findIosRoots(): List<File> {
        val roots = linkedSetOf<File>()
        if (root.name.equals("ios", ignoreCase = true)) {
            roots += root
        }
        for (candidate in walkFiltered(root)) {
            if (candidate.isDirectory && candidate.name.equals("ios", ignoreCase = true)) {
                roots += candidate
            }
        }
        if (workspaceKind == "ios" && roots.isEmpty()) {
            roots += root
        }
        return roots.toList()
    }

    private fun walkFiltered(start: File): Sequence<File> {
        return start.walkTopDown().onEnter { dir -> !shouldSkipDirectory(dir) }
    }

    private fun shouldSkipDirectory(dir: File): Boolean {
        if (!dir.isDirectory) return false
        if (dir == root) return false
        return dir.name.lowercase(Locale.ROOT) in ignoredDirs
    }

    private fun resolveWorkspaceRoot(openedRoot: File): File {
        var cursor: File? = if (openedRoot.isDirectory) openedRoot else openedRoot.parentFile
        while (cursor != null) {
            val pubspec = File(cursor, "pubspec.yaml")
            if (pubspec.exists() && pubspec.isFile) return cursor
            cursor = cursor.parentFile
        }
        return openedRoot
    }

    private fun detectWorkspaceKind(root: File): String {
        if (File(root, "pubspec.yaml").exists()) return "flutter"
        if (File(root, "settings.gradle").exists() || File(root, "settings.gradle.kts").exists()) return "android"
        if (containsAndroidResources(root)) return "android"
        if (root.name.equals("ios", ignoreCase = true) || containsXcodeProject(root)) return "ios"
        return "unknown"
    }

    private fun containsXcodeProject(start: File): Boolean {
        return try {
            walkFiltered(start).any { it.name.endsWith(".xcodeproj", ignoreCase = true) }
        } catch (_: Throwable) {
            false
        }
    }

    private fun containsAndroidResources(start: File): Boolean {
        return try {
            walkFiltered(start).any {
                val path = AssetFileUtil.normalizePath(it.absolutePath).lowercase(Locale.ROOT)
                path.contains("/src/") && (path.contains("/res/drawable") || path.contains("/res/mipmap"))
            }
        } catch (_: Throwable) {
            false
        }
    }

    private fun sameFile(left: File, right: File): Boolean {
        return try {
            left.canonicalFile == right.canonicalFile
        } catch (_: Throwable) {
            left.absoluteFile == right.absoluteFile
        }
    }

    private fun isDescendant(child: File, parent: File): Boolean {
        return isDescendantOrSame(child, parent) && !sameFile(child, parent)
    }

    private fun isDescendantOrSame(child: File, parent: File): Boolean {
        return try {
            child.canonicalFile.toPath().startsWith(parent.canonicalFile.toPath())
        } catch (_: Throwable) {
            AssetFileUtil.normalizePath(child.absolutePath).startsWith(AssetFileUtil.normalizePath(parent.absolutePath))
        }
    }

    private fun displayRelativePath(target: File): String {
        return try {
            val relative = AssetFileUtil.normalizePath(root.canonicalFile.toPath().relativize(target.canonicalFile.toPath()).toString())
            when {
                relative.isBlank() -> "."
                relative.startsWith("..") -> relative
                else -> "./$relative"
            }
        } catch (_: Throwable) {
            AssetFileUtil.normalizePath(target.absolutePath)
        }
    }
}

