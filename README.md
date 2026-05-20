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
  - persistent metadata cache for unchanged files, keyed by path, media type, mtime, and size / MD5 where available
  - Windows MediaInfo CLI probe via `cmd /c mediaInfo --output=json <file>`
  - macOS / Linux MediaInfo CLI probes try `mediainfo output=JSON <file>` before dashed output flags, matching Homebrew CLI behavior
  - macOS common install paths such as `/opt/homebrew/bin/mediainfo` and `/usr/local/bin/mediainfo` are checked because GUI-launched IDEs often have a reduced `PATH`
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
- Normal `Sync` reuses valid metadata from memory and persisted cache. Use `Refresh` only when you intentionally want to rebuild metadata for every file.
- IntelliJ shows a host-side loading state while JCEF is starting so the tool window is never blank.
- IntelliJ requires an IDE runtime with JCEF support; when JCEF is unavailable the tool window shows a large runtime instruction message and does not fall back to a system-browser gallery.
- VSCode uses incremental worker-based scanning, partial publishes, and loading diagnostics with phase/count/path, elapsed/heartbeat details, worker status, and OutputChannel diagnostics for long scans.
- The shared webview accepts VSCode `postMessage` events and JCEF direct calls through the same host-message path; loading is controlled by `loadingState`, not by partial asset publishes.
- If an item times out or falls back during indexing, the gallery shows lightweight fallback metadata, clicking `i` retries extraction on demand, and the metadata dialog refresh button forces a fresh MediaInfo read.
- MediaInfo GUI is intentionally ignored. Only MediaInfo CLI is considered valid metadata tooling.
- Full implementation details and iteration history are recorded in `IMPLEMENTATION_HANDOFF.md`.

## User guide

### Opening the gallery

1. Install the IntelliJ ZIP or VSCode VSIX from the `output/` directory.
2. Open a project that contains Android, Flutter, or iOS resources.
3. Open the `Image Gallery` tool window / side-bar view.
4. Wait for the first `Sync` to finish. The first scan may still be slower because metadata must be extracted once.
5. Subsequent `Sync` runs are faster because unchanged metadata is reused from cache.

### Browsing resources

- Use search for filename, relative path, or MD5.
- Use filters in this order for fastest narrowing: `Platform`, `Project`, `Module`, `Media Type`, then `Format`.
- Platform / project / module / directory groups can be collapsed. Collapse state is remembered locally.
- The zoom controls float at the bottom-right of the content area. Use `-`, reset, and `+` to adjust card size.

### Card actions

- Single-click a card preview to copy its platform-specific token.
- Double-click a card preview to open and reveal the resource in the IDE.
- Click `M` to copy MD5.
- Click `i` to open indexed metadata.
- In the metadata dialog, click the refresh icon to force re-read MediaInfo for that file.
- For audio/video, click the center play button to open the file with the OS default app.

### Sync versus Refresh

- `Sync` is the normal action. It detects added, removed, and changed files and reuses cached metadata for unchanged files.
- `Refresh` is the expensive action. It clears metadata cache and forces MediaInfo / built-in / ffprobe extraction again.
- If metadata looks incomplete because a file previously timed out, open `i` and click refresh for that item before using full `Refresh`.

### Performance notes

- MediaInfo extraction is bounded parallel work and can still be CPU / IO heavy on very large workspaces.
- The shared web UI precomputes search keys, keeps assets sorted once, renders cards in smaller fragments, and uses CSS containment to reduce repaint cost.
- VSCode partial publishes are throttled and coalesced to the latest batch so the webview is not forced to fully re-render every few files during indexing.
- If VSCode still appears stuck, open `View > Output > Image Gallery Preview` and collect lines beginning with `[sync]`, `[refresh]`, or `[worker:...]`.

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

1. Build VSIX with `cmd /c build-plugin.bat` from `vscode-image-gallery-preview`.
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
cmd /c build-plugin.bat
```

## Share with team

Distribute the generated `.zip` and `.vsix` files directly through artifact storage, LAN share, or chat file transfer.
