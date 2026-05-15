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
  - built-in image metadata extraction
  - native / built-in image and media metadata merge
  - `ffprobe` fallback to fill missing stream and duration fields
  - built-in fallback metadata when external tools are unavailable
- Startup indexing and duplicate detection:
  - background indexing on IDE / VSCode startup
  - duplicate image check by `platform + md5`
  - duplicate prompts only for files inside legal resource roots

## Runtime notes

- Both plugins use the shared web gallery and open audio/video in the OS default associated app instead of in-plugin playback.
- IntelliJ resolves indexed metadata before publishing assets and reports structured loading phases for discovery vs metadata enrichment.
- VSCode uses incremental worker-based scanning, partial publishes, and loading diagnostics with phase/count/path plus OutputChannel heartbeats for long scans.
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

1. Build VSIX.
2. Run command: `Extensions: Install from VSIX...`
3. Select VSIX from `vscode-image-gallery-preview/output/`.

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
