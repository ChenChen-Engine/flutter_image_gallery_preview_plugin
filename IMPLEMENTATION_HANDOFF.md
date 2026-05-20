# Image Gallery Preview Implementation Handoff

This document records what has been implemented, how the implementation evolved, and what a future AI run should know before changing the repository again.

## Repository layout

- `C:\Users\chenz\Desktop\flutter_image_gallery_preview_plugin\intellij-image-gallery-preview`
  - IntelliJ / Android Studio plugin
- `C:\Users\chenz\Desktop\flutter_image_gallery_preview_plugin\vscode-image-gallery-preview`
  - VSCode extension
- `C:\Users\chenz\Desktop\flutter_image_gallery_preview_plugin\gallery-web`
  - shared HTML / CSS / JavaScript gallery UI used by both plugins
- `C:\Users\chenz\Desktop\flutter_image_gallery_preview_plugin\README.md`
  - end-user feature and build overview
- `C:\Users\chenz\Desktop\flutter_image_gallery_preview_plugin\RESOURCE_SCANNING_RULES.md`
  - resource-boundary and scanning contract

## Current implemented feature set

### Shared behavior

- The two plugins align on one gallery contract and one shared `gallery-web` frontend.
- The gallery supports three media categories:
  - `Image`
  - `Audio`
  - `Video`
- The gallery supports five filter dimensions:
  - `Platform`
  - `Project`
  - `Module`
  - `Media Type`
  - `Format`
- Grouping is:
  - `Platform > Project > Module > Directory`
- Search matches:
  - filename
  - MD5

### Scanning

- Android scanning:
  - scans `drawable*`, `mipmap*`, and `raw*`
  - supports multi-module projects
  - records `projectName`, `moduleName`, `projectPath`, and `modulePath`
- Flutter scanning:
  - scans all detected `pubspec.yaml`
  - only includes valid Flutter projects
  - uses declared `flutter.assets` first
  - falls back to project-root `assets/` and `res/`
  - does not scan arbitrary directories outside those resource roots
- iOS scanning:
  - scans `Assets.xcassets`
  - scans common bundle resource directories such as `Resources/`, `Assets/`, `res/`, and common app resource trees
- Audio and video scanning were added on top of the image scanner rather than implemented as a separate indexer.

### Supported format families

- Images include:
  - `png`, `jpg`, `jpeg`, `webp`, `gif`, `bmp`, `svg`, `lottie`, `vector_xml`, `pdf`, `heic`, `heif`, `apng`, `avif`, `ico`
- Audio includes:
  - `mp3`, `m4a`, `aac`, `wav`, `ogg`, `opus`, `flac`, `amr`, `mid`, `midi`, `caf`, `wma`, `aiff`, `aif`, `alac`, `mka`
- Video includes:
  - `mp4`, `m4v`, `mov`, `webm`, `mkv`, `avi`, `3gp`, `3gpp`, `mpeg`, `mpg`, `ts`, `m2ts`, `wmv`, `flv`

### Gallery interactions

- Click card:
  - copies the platform-specific `copyToken`
- `M` button:
  - copies MD5
- `i` button:
  - opens metadata dialog from indexed metadata when available
- Audio / video center play button:
  - opens the file with the OS default associated app
- Double-click card:
  - opens and reveals file
- Filename hover:
  - shows a deterministic full-name tooltip in both JCEF and VSCode webview
- Context menu:
  - common copy and file actions

### Indexing and duplicate detection

- Startup background indexing is enabled in both plugins.
- Duplicate detection is keyed by:
  - `platform + md5`
- Duplicate detection covers every scanned resource format, not only images.
- Duplicate prompts are intentionally limited to later manually added files inside legal resource roots.
- Build outputs and generated folders are excluded from duplicate prompts.

## Current architecture

### Shared UI layer

- `gallery-web/index.html`
- `gallery-web/gallery.css`
- `gallery-web/gallery.js`

The shared web layer owns:

- grouping and filter rendering
- search and infinite scrolling
- media card rendering
- metadata dialog
- loading overlay diagnostics
- copy / reveal / external-open message dispatch

The shared web layer does not guess platform copy rules. Host code sends the final `copyToken`.

### IntelliJ side

- The old Swing card grid has been removed; the IntelliJ tool window uses a `JBCefBrowser`-based gallery panel.
- The Tool Window host is:
  - `C:\Users\chenz\Desktop\flutter_image_gallery_preview_plugin\intellij-image-gallery-preview\src\main\kotlin\com\yourorg\imagegallerypreview\ui\JcefImageGalleryPanel.kt`
- Discovery and eager metadata enrichment are coordinated in:
  - `C:\Users\chenz\Desktop\flutter_image_gallery_preview_plugin\intellij-image-gallery-preview\src\main\kotlin\com\yourorg\imagegallerypreview\service\GalleryIndexService.kt`
- Media payload shaping happens in:
  - `C:\Users\chenz\Desktop\flutter_image_gallery_preview_plugin\intellij-image-gallery-preview\src\main\kotlin\com\yourorg\imagegallerypreview\ui\GalleryWebPayloadBuilder.kt`
- Media metadata extraction and merge logic lives in:
  - `C:\Users\chenz\Desktop\flutter_image_gallery_preview_plugin\intellij-image-gallery-preview\src\main\kotlin\com\yourorg\imagegallerypreview\metadata\MediaMetadataExtractor.kt`

### VSCode side

- The extension host scans and shapes payloads.
- The webview consumes the synced `gallery-web` bundle in:
  - `C:\Users\chenz\Desktop\flutter_image_gallery_preview_plugin\vscode-image-gallery-preview\webview`
- Incremental worker-based scanning is implemented in:
  - `C:\Users\chenz\Desktop\flutter_image_gallery_preview_plugin\vscode-image-gallery-preview\src\scanWorker.ts`
  - `C:\Users\chenz\Desktop\flutter_image_gallery_preview_plugin\vscode-image-gallery-preview\src\extension.ts`
- Shared metadata extraction / merge helpers for worker and fallback requests live in:
  - `C:\Users\chenz\Desktop\flutter_image_gallery_preview_plugin\vscode-image-gallery-preview\src\mediaMetadata.ts`

## Media metadata strategy

### Images

- Image metadata is resolved MediaInfo-first, then merged with built-in library metadata for dimensions and image-specific fallbacks.
- The image metadata contract includes:
  - `width`
  - `height`
  - `colorSpace`
  - `chromaSubsampling`
  - `bitDepth`
  - `compressionMode`
  - `streamSize`
  - `fileSize`
  - `format`
  - `absPath`

### Audio and video

- Metadata resolution order for every indexed item is:
  1. MediaInfo CLI
  2. built-in / native metadata
  3. `ffprobe` to fill audio / video stream and duration gaps
  4. built-in fallback metadata
- Metadata is enriched with bounded parallelism (`max 6`) after discovery and before publish.
- A single item can time out and fall back to lightweight metadata so indexing continues; timed-out metadata is not treated as rich cache, and clicking `i` retries extraction on demand.
- MediaInfo JSON keeps all primitive track fields; row truncation is intentionally avoided so the `i` dialog can show complete CLI output.
- MediaInfo text reports are also parsed because `mediaInfo --output=json <file>` can return the default readable report on MediaInfo CLI v26.05.
- Windows direct executable fallback checks PATH and common CLI install directories across all drive letters, including `MediaInfo_Cli`.
- macOS / Linux probing tries `mediainfo output=JSON <file>` and `mediainfo output=json <file>` before dashed output flags, then plain text output.
- macOS common install paths include `/opt/homebrew/bin/mediainfo`, `/usr/local/bin/mediainfo`, `/opt/local/bin/mediainfo`, and `/usr/bin/mediainfo` to cover GUI-launched IDEs with a reduced `PATH`.
- MediaInfo executable discovery is session-cached in both hosts. The scanner still runs MediaInfo per item, but PATH scanning and version probes happen once per plugin process.
- MediaInfo command failures are surfaced as explicit source labels: `timeout`, `parse-empty`, `command-failed`, or `fallback`.
- IntelliJ drains process stdout while waiting for MediaInfo / ffprobe, avoiding false timeouts caused by a full output pipe.
- Indexed items are enriched before the gallery payload is published, so `durationMillis`, `durationLabel`, and `mediaInfo` are ready when `i` is clicked.
- MediaInfo GUI is intentionally rejected.
- MediaInfo detection now requires CLI-style execution, not just an `.exe` with a matching name.

### Why MediaInfo detection was changed

Earlier iterations treated `MediaInfo.exe` as potentially valid if it existed and answered a version probe. On this machine that could still open the GUI application and create a blocking user-facing side effect. The current implementation tightens this by:

- preferring `MEDIAINFO_CLI_PATH`, then `MEDIAINFO_PATH`
- checking PATH entries for CLI names
- limiting Windows common-path fallback to CLI installation folders
- rejecting Windows GUI executables by checking the PE subsystem before trying to execute them

Relevant files:

- `C:\Users\chenz\Desktop\flutter_image_gallery_preview_plugin\intellij-image-gallery-preview\src\main\kotlin\com\yourorg\imagegallerypreview\metadata\MediaMetadataExtractor.kt`
- `C:\Users\chenz\Desktop\flutter_image_gallery_preview_plugin\vscode-image-gallery-preview\src\mediaMetadata.ts`
- `C:\Users\chenz\Desktop\flutter_image_gallery_preview_plugin\vscode-image-gallery-preview\src\mediaInfoTool.ts`

## Playback strategy and why it changed

### Initial approach

- Audio and video were first routed through the shared web player.
- IntelliJ used JCEF with local HTTP range streaming to feed browser media tags.

### Observed problem

- Browser-level playback was not reliable in Android Studio for common files on the user machine.
- Even when transport was correct, codec support depended on the embedded Chromium runtime.
- That made MP4 playback inconsistent enough that transport fixes alone were not sufficient.

### Current approach

- Both hosts render audio/video as non-playing placeholders in the shared web UI.
- The center play button calls `openWithDefaultApp`, so playback always happens in the OS default associated app.
- The play button keeps the original centered circular overlay visual; only the behavior changed.
- Duration is rendered as a bottom-centered overlay inside the thumbnail border with a 4px bottom offset.
- Single-click copy and double-click reveal stay unchanged.
- Indexed metadata is shown immediately from the cached payload; `requestMediaInfo` remains only as a defensive fallback path.
- The metadata dialog has a refresh button next to close. It sends `requestMediaInfo` with `force: true`, bypasses host metadata cache, and toasts after the new info is returned.

## Sync, Refresh, and diagnostics

- `Sync` is the normal incremental path for startup, file watcher changes, and toolbar sync. It detects added / deleted / changed resources and reuses valid indexed metadata for unchanged files.
- `Refresh` is a forced reindex path. It clears or bypasses metadata cache and reruns MediaInfo / native / ffprobe enrichment.
- IntelliJ shows a host-side loading state before the JCEF web UI reports `ready`, preventing a blank Image Gallery window after IDE restart.
- If `JBCefApp.isSupported()` is false, IntelliJ shows a large in-tool-window runtime instruction message and does not start the removed system-browser fallback.
- `plugin.xml` intentionally does not declare `com.intellij.modules.jcef`; the plugin detects missing JCEF at runtime so users can still install it and switch to a matching JetBrains Runtime.
- Loading payloads can include `phase`, item counts, metadata counts, current path, fallback source, elapsed time, worker status, partial count, and diagnostic text.
- If a metadata item times out, both hosts publish a diagnostic and keep scanning instead of waiting indefinitely.
- VSCode mirrors worker diagnostics into the `Image Gallery Preview` OutputChannel; if loading gets stuck, collect both overlay text and OutputChannel lines beginning with `[sync]`, `[refresh]`, or `[worker:...]`.
- VSCode webview messages now enter the shared UI through a `window.message` bridge to `galleryHostReceive`; this is required for host-sent `assets` and `loadingState` payloads to be observed.
- Partial `assets` payloads no longer hide the loading overlay; the overlay hides only when `loadingState.loading` becomes false.

### Tradeoff

- This removes embedded-player codec/runtime variance from both hosts and simplifies the shared UI contract.
- The shared gallery remains the source of truth; only host-specific file-open plumbing differs.

## Implementation process summary

The implementation evolved in these stages:

1. Initial MVP:
   - Android `res` scanning
   - Flutter asset scanning
   - basic gallery display
2. Cross-platform expansion:
   - iOS resource scanning
   - project / module grouping
   - richer copy-token rules
3. UI and performance rewrite:
   - Swing card tree replaced by shared web gallery
   - infinite scrolling and better resize behavior
   - dynamic filters and collapsible grouping
4. Metadata and duplicate detection:
   - MD5 indexing
   - duplicate detection bounded to resource roots
   - duplicate prompts for manually added resources across all scanned formats
   - image metadata dialog
5. Media expansion:
   - audio and video scanning
   - media-type and format filters
   - metadata pipeline extended to non-image assets
6. Media tooling and playback hardening:
   - MediaInfo CLI-only detection
   - VSCode incremental worker scanning for long-running projects
   - eager indexed metadata and structured loading diagnostics
   - external OS playback for audio and video
7. Restore / diagnostics pass:
   - Sync versus forced Refresh toolbar semantics
   - bounded parallel MediaInfo-first metadata enrichment
   - full MediaInfo row retention
   - IntelliJ host-side loading fallback
   - expanded VSCode loading and OutputChannel diagnostics
8. Timeout hardening:
   - per-file metadata timeout fallback in IntelliJ and VSCode
   - click-`i` forced metadata retry when indexed metadata is a timeout fallback
   - VSCode worker passes cache keys instead of full metadata payloads to reduce worker IPC pressure
9. VSCode loading / MediaInfo performance pass:
   - webview `postMessage` bridge into `galleryHostReceive`
   - metadata dialog force-refresh button
   - session-cached MediaInfo executable discovery
   - explicit timeout / parse-empty / command-failed / fallback diagnostics
   - VSCode activity icon aligned with IntelliJ's generic image glyph

## Data model contract

The plugins align on these core fields:

- `platform`
- `workspaceKind`
- `projectName`
- `projectPath`
- `projectRelPath`
- `isPrimaryProject`
- `moduleName`
- `modulePath`
- `moduleRelPath`
- `isPrimaryModule`
- `groupPath`
- `sourceType`
- `copyToken`
- `md5`
- `formatFamily`
- `mediaType`
- `durationMillis`
- `resourceRootPath`
- `absPath`
- `relPath`
- `format`
- `width`
- `height`
- `qualifier`
- `mtime`
- `imageInfo`
- `mediaInfo`

## Build constraints

- IntelliJ build chain:
  - Gradle `9.2.0`
  - Kotlin `2.1.0`
  - IntelliJ Platform Gradle plugin `2.16.0`
- IntelliJ JDK / JBR:
  - Android Studio JBR `21`
  - configured in `intellij-image-gallery-preview/gradle.properties`
- IntelliJ Gradle mirror:
  - `https://mirrors.cloud.tencent.com/gradle/gradle-9.2.0-bin.zip`
- IntelliJ packaging bundles JavaFX runtime dependencies for native media metadata probing.

## Packaging behavior

- IntelliJ version source:
  - `C:\Users\chenz\Desktop\flutter_image_gallery_preview_plugin\intellij-image-gallery-preview\version.txt`
- VSCode version source:
  - `C:\Users\chenz\Desktop\flutter_image_gallery_preview_plugin\vscode-image-gallery-preview\package.json`
- Version policy:
  - set the release version explicitly in both plugin manifests before packaging
- IntelliJ output:
  - `C:\Users\chenz\Desktop\flutter_image_gallery_preview_plugin\intellij-image-gallery-preview\output`
- VSCode output:
  - `C:\Users\chenz\Desktop\flutter_image_gallery_preview_plugin\vscode-image-gallery-preview\output`

## Verification commands used so far

### IntelliJ

```powershell
cd intellij-image-gallery-preview
.\gradlew.bat test --no-daemon
cmd /c build-plugin.bat
```

### VSCode

```powershell
cd vscode-image-gallery-preview
cmd /c npm run compile
cmd /c "node -e ""require('./dist/test/suite/index').run().then(()=>process.exit(0),e=>{console.error(e);process.exit(1)})"""
cmd /c build-plugin.bat
```

## Practical notes for future AI runs

- Treat the shared `gallery-web` directory as the source of truth for gallery UI behavior.
- If IntelliJ and VSCode diverge visually, check whether `vscode-image-gallery-preview/webview` has been resynced from `gallery-web`.
- If MediaInfo unexpectedly opens a GUI again, audit CLI detection first rather than changing the metadata dialog.
- If duration badges disappear on audio/video cards, verify the indexed item now carries `durationMillis` before checking the shared UI.
- If VSCode appears stuck on indexing, inspect worker heartbeats, OutputChannel diagnostics, and partial asset publish flow before touching the scanner rules.
