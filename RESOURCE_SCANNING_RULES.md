# Shared Resource Scanning Rules

This repository contains two independent plugins (IntelliJ + VSCode) with aligned behavior.

## Android resources

- Scan all module paths matching:
  - `**/src/*/res/drawable*`
  - `**/src/*/res/mipmap*`
- Keep same-name resources from different modules (no overwrite by name).
- Copy token:
  - `R.drawable.<name>` for `drawable*`
  - `R.mipmap.<name>` for `mipmap*`
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

- `png`, `jpg`, `jpeg`, `webp`, `gif`, `bmp`, `svg`, `lottie`, `vector_xml`, `pdf`, `heic`, `heif`, `apng`, `avif`, `ico`, `xml`

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
- `absPath`
- `relPath`
- `format`
- `width`
- `height`
- `qualifier`
- `mtime`
- `kind`
- `imageInfo` (`width`, `height`, `colorSpace`, `chromaSubsampling`, `bitDepth`, `compressionMode`, `streamSize`, `fileSize`, `format`, `absPath`)

## Duplicate handling

- Startup background indexing is enabled.
- Duplicate key is `same platform + md5`.
- New file is checked immediately after creation (post-create interception pattern).
- If duplicate is found:
  - Prompt with:
    - `强制添加新图`
    - `删除新图并定位旧图`
  - If multiple existing duplicates are found, user selects one target path before opening.
