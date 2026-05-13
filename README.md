# Flutter Image Gallery Preview Plugins

This repository contains **two parallel plugins**:

- `intellij-image-gallery-preview` (IntelliJ / Android Studio plugin)
- `vscode-image-gallery-preview` (VSCode extension)

Both plugins now align on behavior:

- Scan Android resources across **all modules** (`**/src/*/res/drawable*`, `**/src/*/res/mipmap*`)
- Scan Flutter assets from **all detected `pubspec.yaml` files**
- Scan iOS resources from `ios/**/Assets.xcassets/**.imageset` + regular iOS image files
- Group as **Platform > Module > Directory**
- Search by **filename + MD5**
- Card interactions:
  - click thumbnail: copy `copyToken`
  - `M` button at top-left: copy MD5
  - `i` button at top-right: hover to show image technical info
  - open file: secondary action
- Dynamic filters:
  - `Platform` (All/Android/Flutter/iOS)
  - `Module` (All + discovered modules)
  - `Type` (All + discovered real types like `png`, `jpg`, `webp`, `svg`, `lottie`, ...)
- Startup indexing + duplicate detection:
  - Index on IDE/VSCode startup in background
  - On new image creation, compare MD5 in same platform
  - Duplicate dialog actions:
    - `强制添加新图`
    - `删除新图并定位旧图`

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

Distribute the generated `.zip` and `.vsix` files directly (artifact storage, LAN share, chat file transfer, etc.).
