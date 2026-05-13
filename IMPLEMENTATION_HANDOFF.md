# Image Gallery Preview Implementation Handoff

This document is the continuation guide for future AI iterations in this workspace.

## Repository layout

- `C:\Users\chenz\Desktop\flutter_image_gallery_preview_plugin\intellij-image-gallery-preview`
  - IntelliJ / Android Studio plugin under active iteration.
- `C:\Users\chenz\Desktop\flutter_image_gallery_preview_plugin\vscode-image-gallery-preview`
  - VSCode extension scaffold and first-pass implementation.
- `C:\Users\chenz\Desktop\flutter_image_gallery_preview_plugin\README.md`
  - End-user build and install overview.
- `C:\Users\chenz\Desktop\flutter_image_gallery_preview_plugin\RESOURCE_SCANNING_RULES.md`
  - Cross-platform scanning and data-model contract.

## Current build constraints

- Current IntelliJ build chain uses Gradle `9.2.0`.
- Current IntelliJ build script uses:
  - Kotlin Gradle plugin `2.1.0`
  - IntelliJ Platform Gradle plugin `2.16.0`
- Current Java runtime for Gradle is pinned in:
  - `C:\Users\chenz\Desktop\flutter_image_gallery_preview_plugin\intellij-image-gallery-preview\gradle.properties`
- Expected JDK:
  - Android Studio JBR `21`
  - configured path: `D:/Program Files/Android/Android Studio/jbr`
- Build entrypoint:
  - `C:\Users\chenz\Desktop\flutter_image_gallery_preview_plugin\intellij-image-gallery-preview\build-plugin.bat`
- Gradle wrapper distribution mirror:
  - `https://mirrors.cloud.tencent.com/gradle/gradle-9.2.0-bin.zip`
- Repositories are intentionally fronted by Tencent's Maven public proxy before Maven Central.
- Important cache detail:
  - `E:\Work\Sdk\.gradle` had `kotlin-compiler-embeddable:2.1.10` metadata only, but no jar.
  - `Kotlin 2.1.0` is fully present locally and avoids the earlier long compile stall.

## IntelliJ plugin status

Implemented in current branch:

- Startup background indexing
- Android multi-module scanning
- Flutter multi-`pubspec.yaml` asset scanning
- iOS resource scanning
- Duplicate-image indexing by `platform + md5`
- Tool window filters:
  - `Platform`
  - `Project`
  - `Module`
  - `Type`
- Card interactions:
  - thumbnail click copies resource token
  - `M` button copies MD5
  - `i` button shows technical metadata hover
- Responsive filter bar
- Pagination:
  - page size selector
  - previous / next navigation
- Embedded loading overlay
- Refresh single-flight protection
- Async thumbnail loading for raster images
- Version bump on packaging via `version.txt`

Current parity status:

- IntelliJ and VSCode now both use:
  - `Platform -> Project -> Module -> Type`
  - grouping `Platform > Project > Module > Directory`
  - page-based rendering for large result sets
- VSCode duplicate-image Chinese dialog strings were fixed and the backend now normalizes paths before caching and opening.
- Packaging is unblocked on both sides:
  - IntelliJ latest ZIP is in its `output` directory
  - VSCode latest VSIX is in its `output` directory
- The next verification step should happen inside Android Studio first, because the user's blocking issue was runtime rendering there.

## Files most likely to change next

IntelliJ plugin:

- `C:\Users\chenz\Desktop\flutter_image_gallery_preview_plugin\intellij-image-gallery-preview\build.gradle.kts`
- `C:\Users\chenz\Desktop\flutter_image_gallery_preview_plugin\intellij-image-gallery-preview\build-plugin.bat`
- `C:\Users\chenz\Desktop\flutter_image_gallery_preview_plugin\intellij-image-gallery-preview\src\main\resources\META-INF\plugin.xml`
- `C:\Users\chenz\Desktop\flutter_image_gallery_preview_plugin\intellij-image-gallery-preview\src\main\kotlin\com\yourorg\imagegallerypreview\service\`
- `C:\Users\chenz\Desktop\flutter_image_gallery_preview_plugin\intellij-image-gallery-preview\src\main\kotlin\com\yourorg\imagegallerypreview\ui\`

VSCode extension:

- `C:\Users\chenz\Desktop\flutter_image_gallery_preview_plugin\vscode-image-gallery-preview\src\`
- `C:\Users\chenz\Desktop\flutter_image_gallery_preview_plugin\vscode-image-gallery-preview\webview\`

## Data model contract

Both plugin implementations are intended to align on these fields:

- `platform`
- `projectName`
- `moduleName`
- `groupPath`
- `sourceType`
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
- `imageInfo`

`imageInfo` target fields:

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

## Packaging behavior

- Version source file:
  - `C:\Users\chenz\Desktop\flutter_image_gallery_preview_plugin\intellij-image-gallery-preview\version.txt`
- Policy:
  - base starts at `0.0.1`
  - package build increments patch by `+1`
  - IntelliJ now increments at Gradle configuration time so `version.txt` and ZIP filename stay aligned
- IntelliJ output directory:
  - `C:\Users\chenz\Desktop\flutter_image_gallery_preview_plugin\intellij-image-gallery-preview\output`
- VSCode output directory:
  - `C:\Users\chenz\Desktop\flutter_image_gallery_preview_plugin\vscode-image-gallery-preview\output`

## Recommended next iteration order

1. Finish offline IntelliJ packaging and verify the ZIP installs.
2. Run the plugin inside Android Studio and confirm:
   - visible items render correctly
   - loading overlay blocks refresh spam
   - filter hierarchy matches user expectation
   - resize performance is materially improved
3. Fix any remaining IntelliJ runtime issues before resuming VSCode parity.
4. Only after IntelliJ stabilizes, port equivalent fixes to VSCode.

## Practical notes for future AI runs

- Treat the IntelliJ plugin as the critical path until the user explicitly re-prioritizes.
- Avoid broad refactors across both plugins in one pass unless the user asks for parity work.
- If a build breaks, first verify:
  - Gradle major version
  - JDK version
  - `plugin.xml` readability and encoding
  - whether Kotlin version points to a locally complete compiler artifact
  - whether repository order still keeps Tencent Maven proxy ahead of Maven Central
- If package build succeeds, always report the exact ZIP path in:
  - `C:\Users\chenz\Desktop\flutter_image_gallery_preview_plugin\intellij-image-gallery-preview\output`
