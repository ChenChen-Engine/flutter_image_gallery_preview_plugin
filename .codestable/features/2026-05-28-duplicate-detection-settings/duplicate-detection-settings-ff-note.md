---
doc_type: feature-ff-note
feature: duplicate-detection-settings
date: 2026-05-28
requirement: optional duplicate resource detection
tags: [settings, duplicate-detection, release]
---

## Did
Made duplicate resource detection configurable for both IntelliJ and VSCode.
The setting defaults to off and can be enabled from Image Gallery Preview Settings.

## Changed
- `GallerySettingsService` / `GalleryProjectConfigurable` - added `duplicateResourceDetectionEnabled`.
- `GalleryIndexService` / VSCode `extension.ts` - skip duplicate md5 checks and prompts unless the setting is enabled.
- `README.md` / `RESOURCE_SCANNING_RULES.md` / `IMPLEMENTATION_HANDOFF.md` - documented default-off duplicate detection and version 1.2.4 release behavior.

## Verified
Ran shared JS syntax check, IntelliJ tests and packaging, VSCode compile, tests, and packaging.
Generated IntelliJ ZIP and VSCode VSIX for version 1.2.4.

## Follow-up
No blocking follow-up found in this fastforward change.
