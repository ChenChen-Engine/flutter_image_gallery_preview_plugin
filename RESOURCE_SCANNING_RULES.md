# Shared Resource Scanning Rules

This repository contains two independent plugins (IntelliJ + VSCode) with aligned behavior.

## Android resources

- Scan all module paths matching:
  - `**/src/*/res/drawable*`
  - `**/src/*/res/mipmap*`
  - `**/src/*/res/raw*`
- Keep same-name resources from different modules (no overwrite by name).
- Copy token:
  - `R.drawable.<name>` for `drawable*`
  - `R.mipmap.<name>` for `mipmap*`
  - `R.raw.<name>` for `raw*`
- Extract qualifier from folder suffix (`drawable-xxhdpi` => `xxhdpi`).

## Flutter resources

- Discover all `pubspec.yaml` files in workspace (not root-only).
- Parse each `flutter.assets` list.
- Support file entries, directory entries, and wildcard fallback expansion.
- Preserve owning module from pubspec context.
- Copy token:
  - Prefer `res/...` when path contains `res`
  - Fallback to `assets/...`
  - Otherwise fallback to pubspec-module-relative path

## iOS resources

- Scan `ios/**/Assets.xcassets/**.imageset` and parse `Contents.json` `filename` entries.
- Scan common iOS image files under `ios/**` (excluding duplicates from xcassets).
- Copy token:
  - Prefer `Assets.xcassets/...` style path
  - Otherwise module-relative bundle path

## Supported format families

Dynamic filters show only discovered families. Supported family set:

- Images: `png`, `jpg`, `jpeg`, `webp`, `gif`, `bmp`, `svg`, `lottie`, `vector_xml`, `pdf`, `heic`, `heif`, `apng`, `avif`, `ico`, `xml`
- Audio: `mp3`, `m4a`, `aac`, `wav`, `ogg`, `opus`, `flac`, `amr`, `mid`, `midi`, `caf`, `wma`, `aiff`, `aif`, `alac`, `mka`
- Video: `mp4`, `m4v`, `mov`, `webm`, `mkv`, `avi`, `3gp`, `3gpp`, `mpeg`, `mpg`, `ts`, `m2ts`, `wmv`, `flv`

Lottie recognition rule:

- extension `.json` **and** structural markers (`"v"`, `"layers"`, `"w"`, `"h"`).

## Unified model fields

Both plugins align on:

- `sourceType`
- `platform`
- `moduleName`
- `groupPath`
- `copyToken`
- `md5`
- `formatFamily`
- `mediaType`
- `durationMillis`
- `absPath`
- `relPath`
- `format`
- `width`
- `height`
- `qualifier`
- `mtime`
- `kind`
- `imageInfo` (`width`, `height`, `colorSpace`, `chromaSubsampling`, `bitDepth`, `compressionMode`, `streamSize`, `fileSize`, `format`, `absPath`)
- `mediaInfo` (`source`, `sections[]`, optional install hint)

## Metadata enrichment

- Discovery stays resource-root scoped.
- Metadata enrichment happens after discovery and before publish.
- Windows MediaInfo CLI is attempted first with `cmd /c mediaInfo --output=json <file>`.
- Some MediaInfo CLI builds return the default readable text report for that lowercase flag; hosts parse both JSON and text reports.
- Windows direct executable fallback scans PATH plus common CLI install directories on all local drive letters, including `MediaInfo_Cli`.
- macOS / Linux try `mediainfo output=JSON <file>` and `mediainfo output=json <file>` before dashed output flags.
- macOS common Homebrew and MacPorts paths are checked because IDEs launched from Finder or Dock may not inherit shell `PATH`.
- Direct executable discovery is cached per plugin process; do not re-scan PATH or version-probe MediaInfo for every item.
- Metadata extraction is bounded parallel work with a maximum of 6 concurrent items per host.
- A single item is allowed to time out and fall back to lightweight metadata; indexing continues.
- Timeout, parse-empty, command-failed, and fallback states are represented in the metadata source label so both the loading overlay and `i` dialog explain why full MediaInfo rows are missing.
- Timed-out or fallback metadata is not treated as a permanent rich metadata cache. Clicking `i` retries extraction on demand, and the dialog refresh button forces a fresh MediaInfo read.
- Host parsers keep every primitive MediaInfo track field; they do not cap the modal rows at 80.
- If MediaInfo CLI is unavailable or incomplete, hosts merge built-in/native metadata and `ffprobe`.
- `requestMediaInfo` remains a defensive fallback only when indexed metadata is missing.

## Loading diagnostics

- `Sync` performs incremental discovery and reuses valid indexed metadata for unchanged files.
- `Refresh` forces full reindexing and metadata cache rebuild.
- IntelliJ publishes `phase`, `indexedCount`, `metadataCount`, `currentPath`, optional `fallbackSource`, `elapsedMillis`, `workerStatus`, and `diagnostic`.
- IntelliJ also shows a host-side loading state while JCEF is starting.
- IntelliJ requires JCEF and does not open a system-browser fallback gallery when JCEF is unavailable.
- VSCode publishes worker `phase`, `count`, `total`, `currentPath`, `partialCount`, `fallbackSource`, `elapsedMillis`, `lastHeartbeatMillis`, `workerStatus`, and `diagnostic`, and mirrors them to an OutputChannel.
- The shared web UI receives VSCode `webview.postMessage` payloads through a `window.message` bridge to `galleryHostReceive`; partial `assets` messages must not hide loading.

## Duplicate handling

- Startup background indexing is enabled.
- Duplicate key is `same platform + md5`; all scanned resource formats participate, not only images.
- New file is checked immediately after creation or modification using the in-memory MD5 index before the full sync completes.
- Existing duplicates found during startup/full indexing are not forced on the user; only later manually added duplicate resources prompt.
- If duplicate is found:
  - Prompt with:
    - `强制添加新资源`
    - `删除新添加资源并定位已存在资源`
  - If multiple existing duplicates are found, user selects one target path before opening.
