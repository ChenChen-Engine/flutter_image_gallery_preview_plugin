# Flutter Image Gallery Preview Plugins

This repository contains two parallel plugins:

- `intellij-image-gallery-preview` for IntelliJ / Android Studio
- `vscode-image-gallery-preview` for VSCode

Both plugins now share the same media-gallery contract and the same `gallery-web` UI layer.

## Implemented capabilities

- Media scanning:
  - Android: `drawable*`, `mipmap*`, and `raw*` across detected modules
  - Flutter: declared assets from all detected `pubspec.yaml` files, plus project-root `assets/` and `res/` fallback scanning
  - iOS: `Assets.xcassets`, `Resources/`, `Assets/`, `res/`, and common bundle resource directories
- Media categories:
  - `Image`
  - `Audio`
  - `Video`
- Filters:
  - `Platform`
  - `Project`
  - `Module`
  - `Media Type`
  - `Format`
- Grouping:
  - `Platform > Project > Module > Directory`
- Search:
  - filename
  - MD5
- Card interactions:
  - `Sync`: incremental rescan for added / removed / changed files, reusing valid indexed metadata
  - `Refresh`: forced reindex, including metadata cache rebuild
  - click card: copy platform-specific resource token
  - `M`: copy MD5
  - `i`: open metadata dialog
  - audio/video center play button: open the file with the OS default associated app
  - double-click: open and reveal file
  - filename hover: show full file name tooltip
  - context menu: common file and copy actions
- Metadata:
  - eager metadata indexing before items are shown
  - Windows MediaInfo CLI probe via `cmd /c mediaInfo --output=json <file>`
  - MediaInfo text-output parsing when that CLI flag returns the default readable report instead of JSON
  - MediaInfo executable discovery is cached for the plugin session, so PATH and version probes do not repeat per file
  - bounded parallel metadata enrichment for faster MediaInfo / ffprobe extraction
  - per-file metadata timeout fallback so one problematic resource cannot block indexing
  - explicit metadata failure labels (`timeout`, `parse-empty`, `command-failed`, `fallback`) in loading diagnostics and the `i` dialog source line
  - full primitive MediaInfo track fields are retained for the `i` dialog
  - built-in image metadata extraction
  - native / built-in image and media metadata merge
  - `ffprobe` fallback to fill missing stream and duration fields
  - built-in fallback metadata when external tools are unavailable
- Startup indexing and duplicate detection:
  - background indexing on IDE / VSCode startup
  - duplicate resource check by `platform + md5` for every scanned format
  - duplicate prompts only for later manually added files inside legal resource roots

## Runtime notes

- Both plugins use the shared web gallery and open audio/video in the OS default associated app instead of in-plugin playback.
- IntelliJ resolves indexed metadata before publishing assets and reports structured loading phases for discovery vs metadata enrichment.
- IntelliJ shows a host-side loading fallback while JCEF is starting so the tool window is never blank.
- VSCode uses incremental worker-based scanning, partial publishes, and loading diagnostics with phase/count/path, elapsed/heartbeat details, worker status, and OutputChannel diagnostics for long scans.
- The shared webview accepts VSCode `postMessage` events and JCEF direct calls through the same host-message path; loading is controlled by `loadingState`, not by partial asset publishes.
- If an item times out or falls back during indexing, the gallery shows lightweight fallback metadata, clicking `i` retries extraction on demand, and the metadata dialog refresh button forces a fresh MediaInfo read.
- MediaInfo GUI is intentionally ignored. Only MediaInfo CLI is considered valid metadata tooling.
- Full implementation details and iteration history are recorded in `IMPLEMENTATION_HANDOFF.md`.

## Build artifacts

- IntelliJ plugin ZIP output:
  - `intellij-image-gallery-preview/output/*.zip`
- VSCode extension VSIX output:
  - `vscode-image-gallery-preview/output/*.vsix`

## Local install

### IntelliJ / Android Studio

1. Build ZIP.
2. Open IDE: `Settings > Plugins > gear icon > Install Plugin from Disk...`
3. Select ZIP from `intellij-image-gallery-preview/output/`.
4. Restart IDE.

### VSCode

1. Build VSIX with `npm run package` from `vscode-image-gallery-preview`.
2. In VSCode, uninstall any existing `Image Gallery Preview` extension build, then run `Developer: Reload Window`.
3. Run `Extensions: Install from VSIX...`.
4. Select the newest file from `vscode-image-gallery-preview/output/`.
5. Run `Developer: Reload Window` again.
6. Open `View > Output`, select `Image Gallery Preview`, then open the Image Gallery view.
7. If the view remains loading, copy the visible loading details and the OutputChannel lines that start with `[sync]`, `[refresh]`, or `[worker:...]`.

## Build commands

### IntelliJ plugin

```powershell
cd intellij-image-gallery-preview
.\gradlew.bat clean buildPlugin copyPluginZipToOutput
```

### VSCode extension

```powershell
cd vscode-image-gallery-preview
cmd /c npm ci
cmd /c npm run package
```

## Share with team

Distribute the generated `.zip` and `.vsix` files directly through artifact storage, LAN share, or chat file transfer.
