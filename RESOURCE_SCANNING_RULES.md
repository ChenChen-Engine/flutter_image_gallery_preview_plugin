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
- If MediaInfo CLI is unavailable or incomplete, hosts merge built-in/native metadata and `ffprobe`.
- `requestMediaInfo` remains a defensive fallback only when indexed metadata is missing.

## Loading diagnostics

- IntelliJ publishes `phase`, `indexedCount`, `metadataCount`, `currentPath`, and optional `fallbackSource`.
- VSCode publishes worker `phase`, `count`, `total`, `currentPath`, and heartbeat diagnostics, and mirrors them to an OutputChannel.

## Duplicate handling

- Startup background indexing is enabled.
- Duplicate key is `same platform + md5`.
- New file is checked immediately after creation (post-create interception pattern).
- If duplicate is found:
  - Prompt with:
    - `强制添加新图`
    - `删除新图并定位旧图`
    - `强制添加新图`
    - `删除新图并定位旧图`
  - If multiple existing duplicates are found, user selects one target path before opening.
