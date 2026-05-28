import * as assert from 'assert';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Module = require('module');
import { GalleryAssetItem, MediaMetadataInfo } from '../shared/types';

suite('extension contracts', () => {
  test('creates preview URIs for images, lottie, and video cover probing', async () => {
    const extensionModule = requireExtensionModule();
    const previewUriForItem = extensionModule.previewUriForItem as ((webview: any, item: GalleryAssetItem) => Promise<string | null>) | undefined;

    assert.ok(previewUriForItem, 'expected extension to export previewUriForItem for contract tests');

    const webview = {
      asWebviewUri(uri: { fsPath: string }) {
        return { toString: () => `webview:${uri.fsPath.replace(/\\/g, '/')}` };
      }
    };

    assert.ok(await previewUriForItem!(webview, asset('png')));
    assert.ok(await previewUriForItem!(webview, asset('lottie')));
    assert.strictEqual(await previewUriForItem!(webview, asset('mp3', 'audio')), null);
    assert.ok(await previewUriForItem!(webview, asset('mp4', 'video')));
  });

  test('primes media info cache from indexed items', () => {
    const extensionModule = requireExtensionModule();
    const primeInfoCacheFromItems = extensionModule.primeInfoCacheFromItems as ((items: GalleryAssetItem[]) => Map<string, MediaMetadataInfo>) | undefined;

    assert.ok(primeInfoCacheFromItems, 'expected extension to export primeInfoCacheFromItems for contract tests');

    const indexed = mediaInfo('audio', 'MediaInfo (mediainfo.exe)', 'General', [
      ['Format', 'MPEG Audio'],
      ['Duration', '2 min 4 s']
    ]);
    const cache = primeInfoCacheFromItems!([
      asset('mp3', 'audio', { mediaInfo: indexed }),
      asset('png', 'image', { mediaInfo: mediaInfo('image', 'Built-in', 'Image', [['width', '24']]) })
    ]);

    assert.strictEqual(cache.get('C:/demo/app/src/main/res/drawable/icon.mp3')?.source, 'MediaInfo (mediainfo.exe)');
    assert.strictEqual(cache.get('C:/demo/app/src/main/res/drawable/icon.png')?.sections[0].title, 'Image');
  });

  test('detects duplicate resources only for the affected file path', () => {
    const extensionModule = requireExtensionModule();
    const duplicateAlertForAffectedPath = extensionModule.duplicateAlertForAffectedPath as ((items: GalleryAssetItem[], affectedPath: string) => { newItem: GalleryAssetItem; duplicates: GalleryAssetItem[] } | null) | undefined;

    assert.ok(duplicateAlertForAffectedPath, 'expected extension to export duplicateAlertForAffectedPath for contract tests');

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'igp-dup-affected-'));
    try {
      const existingPath = normalizeForTest(path.join(root, 'res', 'image', 'a.png'));
      const addedPath = normalizeForTest(path.join(root, 'res', 'image', 'news', 'a.png'));
      const audioExistingPath = normalizeForTest(path.join(root, 'res', 'audio', 'a.mp3'));
      const audioAddedPath = normalizeForTest(path.join(root, 'res', 'audio', 'news', 'a.mp3'));
      const otherPlatformPath = normalizeForTest(path.join(root, 'ios', 'Runner', 'Assets.xcassets', 'a.imageset', 'a.png'));
      for (const filePath of [existingPath, addedPath, audioExistingPath, audioAddedPath, otherPlatformPath]) {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, Buffer.from('same'));
      }

      const existing = asset('png', 'image', {
        absPath: existingPath,
        relPath: 'res/image/a.png',
        resourceRootPath: normalizeForTest(path.join(root, 'res', 'image')),
        platform: 'flutter',
        md5: 'same-md5',
        mtime: 1
      });
      const added = asset('png', 'image', {
        absPath: addedPath,
        relPath: 'res/image/news/a.png',
        resourceRootPath: normalizeForTest(path.join(root, 'res', 'image')),
        platform: 'flutter',
        md5: 'same-md5',
        mtime: 2
      });
      const audioExisting = asset('mp3', 'audio', {
        absPath: audioExistingPath,
        relPath: 'res/audio/a.mp3',
        resourceRootPath: normalizeForTest(path.join(root, 'res', 'audio')),
        platform: 'flutter',
        md5: 'same-audio-md5',
        mtime: 4
      });
      const audioAdded = asset('mp3', 'audio', {
        absPath: audioAddedPath,
        relPath: 'res/audio/news/a.mp3',
        resourceRootPath: normalizeForTest(path.join(root, 'res', 'audio')),
        platform: 'flutter',
        md5: 'same-audio-md5',
        mtime: 5
      });
      const otherPlatform = asset('png', 'image', {
        absPath: otherPlatformPath,
        relPath: 'ios/Runner/Assets.xcassets/a.imageset/a.png',
        resourceRootPath: normalizeForTest(path.dirname(otherPlatformPath)),
        platform: 'ios',
        md5: 'same-md5',
        mtime: 3
      });

      assert.strictEqual(duplicateAlertForAffectedPath!([existing, added, otherPlatform], existing.absPath)?.newItem.absPath, existing.absPath);
      const alert = duplicateAlertForAffectedPath!([existing, added, otherPlatform], added.absPath);
      assert.strictEqual(alert?.newItem.absPath, added.absPath);
      assert.deepStrictEqual(alert?.duplicates.map((item) => item.absPath), [existing.absPath]);

      const audioAlert = duplicateAlertForAffectedPath!([audioExisting, audioAdded], audioAdded.absPath);
      assert.strictEqual(audioAlert?.newItem.absPath, audioAdded.absPath);
      assert.deepStrictEqual(audioAlert?.duplicates.map((item) => item.absPath), [audioExisting.absPath]);
      assert.strictEqual(duplicateAlertForAffectedPath!([existing, added, otherPlatform], normalizeForTest(path.join(root, 'res', 'image', 'missing.png'))), null);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('detects repeated duplicate copies from indexed md5 without waiting for rescan', () => {
    const extensionModule = requireExtensionModule();
    const duplicateAlertFromIndexedMd5 = extensionModule.duplicateAlertFromIndexedMd5 as ((index: Map<string, Map<string, GalleryAssetItem[]>>, affectedPath: string) => { newItem: GalleryAssetItem; duplicates: GalleryAssetItem[] } | null) | undefined;
    const duplicatePromptKeyForItem = extensionModule.duplicatePromptKeyForItem as ((item: GalleryAssetItem) => string) | undefined;

    assert.ok(duplicateAlertFromIndexedMd5, 'expected extension to export duplicateAlertFromIndexedMd5 for contract tests');
    assert.ok(duplicatePromptKeyForItem, 'expected extension to export duplicatePromptKeyForItem for contract tests');

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'igp-dup-'));
    try {
      const content = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
      const md5 = crypto.createHash('md5').update(content).digest('hex');
      const addedPath = path.join(root, 'res', 'image', 'news', 'a.png');
      fs.mkdirSync(path.dirname(addedPath), { recursive: true });

      const existing = asset('png', 'image', {
        absPath: normalizeForTest(path.join(root, 'res', 'image', 'a.png')),
        relPath: 'res/image/a.png',
        resourceRootPath: normalizeForTest(path.join(root, 'res', 'image')),
        platform: 'flutter',
        md5
      });
      const index = new Map<string, Map<string, GalleryAssetItem[]>>([
        ['flutter', new Map([[md5, [existing]]])]
      ]);

      fs.writeFileSync(addedPath, content);
      fs.utimesSync(addedPath, new Date(2_000), new Date(2_000));
      const first = duplicateAlertFromIndexedMd5!(index, addedPath);
      assert.strictEqual(first?.newItem.absPath, normalizeForTest(addedPath));
      assert.deepStrictEqual(first?.duplicates.map((item) => item.absPath), [existing.absPath]);
      const firstKey = duplicatePromptKeyForItem!(first!.newItem);

      fs.utimesSync(addedPath, new Date(3_000), new Date(3_000));
      const sameFile = duplicateAlertFromIndexedMd5!(index, addedPath);
      const sameFileKey = duplicatePromptKeyForItem!(sameFile!.newItem);
      assert.strictEqual(sameFileKey, firstKey);

      fs.unlinkSync(addedPath);
      fs.writeFileSync(addedPath, content);
      fs.utimesSync(addedPath, new Date(4_000), new Date(4_000));
      const second = duplicateAlertFromIndexedMd5!(index, addedPath);
      assert.strictEqual(second?.newItem.absPath, normalizeForTest(addedPath));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('detects non-image duplicate resources from indexed md5', () => {
    const extensionModule = requireExtensionModule();
    const duplicateAlertFromIndexedMd5 = extensionModule.duplicateAlertFromIndexedMd5 as ((index: Map<string, Map<string, GalleryAssetItem[]>>, affectedPath: string) => { newItem: GalleryAssetItem; duplicates: GalleryAssetItem[] } | null) | undefined;

    assert.ok(duplicateAlertFromIndexedMd5, 'expected extension to export duplicateAlertFromIndexedMd5 for contract tests');

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'igp-dup-audio-'));
    try {
      const content = Buffer.from('audio-content');
      const md5 = crypto.createHash('md5').update(content).digest('hex');
      const addedPath = path.join(root, 'res', 'audio', 'news', 'a.mp3');
      fs.mkdirSync(path.dirname(addedPath), { recursive: true });
      fs.writeFileSync(addedPath, content);

      const existing = asset('mp3', 'audio', {
        absPath: normalizeForTest(path.join(root, 'res', 'audio', 'a.mp3')),
        relPath: 'res/audio/a.mp3',
        resourceRootPath: normalizeForTest(path.join(root, 'res', 'audio')),
        platform: 'flutter',
        md5
      });
      const index = new Map<string, Map<string, GalleryAssetItem[]>>([
        ['flutter', new Map([[md5, [existing]]])]
      ]);

      const alert = duplicateAlertFromIndexedMd5!(index, addedPath);
      assert.strictEqual(alert?.newItem.mediaType, 'audio');
      assert.strictEqual(alert?.newItem.formatFamily, 'mp3');
      assert.deepStrictEqual(alert?.duplicates.map((item) => item.absPath), [existing.absPath]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('builds structured loading state payloads from worker progress', () => {
    const extensionModule = requireExtensionModule();
    const toLoadingStateMessage = extensionModule.toLoadingStateMessage as ((progress: {
      phase: string;
      count: number;
      total: number;
      currentPath: string | null;
      heartbeat: boolean;
      message?: string;
      elapsedMillis?: number;
      lastHeartbeatMillis?: number;
      workerStatus?: string;
      partialCount?: number;
      fallbackSource?: string;
      diagnostic?: string;
    }) => Record<string, unknown>) | undefined;
    const formatWorkerDiagnostic = extensionModule.formatWorkerDiagnostic as ((progress: {
      phase: string;
      count: number;
      total: number;
      currentPath: string | null;
      heartbeat: boolean;
      message?: string;
      fallbackSource?: string;
    }) => string) | undefined;

    assert.ok(toLoadingStateMessage, 'expected extension to export toLoadingStateMessage for contract tests');
    assert.ok(formatWorkerDiagnostic, 'expected extension to export formatWorkerDiagnostic for contract tests');

    const payload = toLoadingStateMessage!({
      phase: 'enrich',
      count: 2,
      total: 5,
      currentPath: 'C:/demo/assets/audio/clip.mp3',
      heartbeat: true,
      elapsedMillis: 12_345,
      lastHeartbeatMillis: 678,
      workerStatus: 'active',
      partialCount: 2,
      fallbackSource: 'Built-in (fallback)',
      diagnostic: 'worker heartbeat active'
    });

    assert.deepStrictEqual(
      {
        type: payload.type,
        loading: payload.loading,
        phase: payload.phase,
        count: payload.count,
        total: payload.total,
        currentPath: payload.currentPath,
        heartbeat: payload.heartbeat,
        elapsedMillis: payload.elapsedMillis,
        lastHeartbeatMillis: payload.lastHeartbeatMillis,
        workerStatus: payload.workerStatus,
        partialCount: payload.partialCount,
        fallbackSource: payload.fallbackSource,
        diagnostic: payload.diagnostic
      },
      {
        type: 'loadingState',
        loading: true,
        phase: 'enrich',
        count: 2,
        total: 5,
        currentPath: 'C:/demo/assets/audio/clip.mp3',
        heartbeat: true,
        elapsedMillis: 12_345,
        lastHeartbeatMillis: 678,
        workerStatus: 'active',
        partialCount: 2,
        fallbackSource: 'Built-in (fallback)',
        diagnostic: 'worker heartbeat active'
      }
    );
    assert.match(String(payload.message), /2\/5/);
    assert.match(String(payload.message), /clip\.mp3/);

    const diagnostic = formatWorkerDiagnostic!({
      phase: 'enrich',
      count: 2,
      total: 5,
      currentPath: 'C:/demo/assets/audio/clip.mp3',
      heartbeat: true,
      fallbackSource: 'Built-in (fallback)'
    });

    assert.match(diagnostic, /heartbeat/i);
    assert.match(diagnostic, /enrich/i);
    assert.match(diagnostic, /2\/5/);
    assert.match(diagnostic, /clip\.mp3/);
    assert.match(diagnostic, /fallback=Built-in/);
  });

  test('opens native settings with exact resource string link setting id', async () => {
    const calls: Array<{ command: string; arg?: string }> = [];
    const extensionModule = requireExtensionModule({
      executeCommand: async (command: string, arg?: string) => {
        calls.push({ command, arg });
      }
    });
    const openResourceStringLinkSettings = extensionModule.openResourceStringLinkSettings as (() => Promise<void>) | undefined;

    assert.ok(openResourceStringLinkSettings, 'expected extension to export openResourceStringLinkSettings for contract tests');

    await openResourceStringLinkSettings!();

    assert.deepStrictEqual(calls, [
      {
        command: 'workbench.action.openWorkspaceSettings',
        arg: '@ext:ChenChen.vscode-image-gallery-preview'
      }
    ]);
  });

  test('falls back through settings commands when native settings command fails', async () => {
    const calls: Array<{ command: string; arg?: string }> = [];
    const extensionModule = requireExtensionModule({
      executeCommand: async (command: string, arg?: string) => {
        calls.push({ command, arg });
        if (calls.length < 3) throw new Error('not available');
      }
    });
    const openResourceStringLinkSettings = extensionModule.openResourceStringLinkSettings as (() => Promise<void>) | undefined;

    assert.ok(openResourceStringLinkSettings, 'expected extension to export openResourceStringLinkSettings for contract tests');

    await openResourceStringLinkSettings!();

    assert.deepStrictEqual(calls, [
      {
        command: 'workbench.action.openWorkspaceSettings',
        arg: '@ext:ChenChen.vscode-image-gallery-preview'
      },
      {
        command: 'workbench.action.openWorkspaceSettings',
        arg: 'imageGalleryPreview.resourceStringLinksEnabled'
      },
      {
        command: 'workbench.action.openSettings',
        arg: '@ext:ChenChen.vscode-image-gallery-preview'
      }
    ]);
  });

  test('duplicate resource detection setting defaults off and can be enabled', () => {
    const defaultModule = requireExtensionModule();
    const readDuplicateResourceDetectionEnabled = defaultModule.readDuplicateResourceDetectionEnabled as (() => boolean) | undefined;
    assert.ok(readDuplicateResourceDetectionEnabled, 'expected duplicate detection setting reader to be exported');
    assert.strictEqual(readDuplicateResourceDetectionEnabled!(), false);

    const enabledModule = requireExtensionModule({
      configuration: {
        'imageGalleryPreview.duplicateResourceDetectionEnabled': true
      }
    });
    const readEnabled = enabledModule.readDuplicateResourceDetectionEnabled as (() => boolean) | undefined;
    assert.strictEqual(readEnabled!(), true);
  });
});

function mediaInfo(
  mediaType: 'image' | 'audio' | 'video',
  source: string,
  title: string,
  rows: Array<[string, string]>
): MediaMetadataInfo {
  return {
    mediaType,
    source,
    sections: [
      {
        title,
        rows: rows.map(([label, value]) => ({ label, value }))
      }
    ]
  };
}

function asset(
  formatFamily: GalleryAssetItem['formatFamily'],
  mediaType: GalleryAssetItem['mediaType'] = 'image',
  overrides: Partial<GalleryAssetItem> = {}
): GalleryAssetItem {
  const extension = mediaType === 'audio' ? 'mp3' : mediaType === 'video' ? 'mp4' : formatFamily === 'lottie' ? 'json' : 'png';
  const absPath = `C:/demo/app/src/main/res/drawable/icon.${extension}`;

  return {
    sourceType: 'android_res',
    platform: 'android',
    workspaceKind: 'android',
    projectName: 'demo',
    projectPath: 'C:/demo',
    projectRelPath: '.',
    isPrimaryProject: true,
    moduleName: 'app',
    modulePath: 'C:/demo/app',
    moduleRelPath: './app',
    isPrimaryModule: true,
    groupPath: 'res/drawable',
    copyToken: 'R.drawable.icon',
    md5: 'abc123',
    formatFamily,
    isAnimated: formatFamily === 'lottie',
    mediaType,
    durationMillis: mediaType === 'audio' ? 124_000 : mediaType === 'video' ? 65_000 : null,
    resourceRootPath: 'C:/demo/app/src/main/res/drawable',
    absPath,
    relPath: absPath.replace('C:/demo/', ''),
    format: extension,
    width: mediaType === 'image' ? 24 : null,
    height: mediaType === 'image' ? 24 : null,
    qualifier: '',
    mtime: 1,
    kind: formatFamily,
    ...overrides
  };
}

function normalizeForTest(value: string): string {
  return value.replace(/\\/g, '/');
}

function requireExtensionModule(overrides: {
  configuration?: Record<string, unknown>;
  executeCommand?: (command: string, arg?: string) => Promise<void>;
} = {}): Record<string, unknown> {
  const originalLoad = (Module as any)._load;
  (Module as any)._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
    if (request === 'vscode') {
      return {
        Uri: {
          file(fsPath: string) {
            return { fsPath };
          },
          parse(value: string) {
            return { value };
          }
        },
        window: {
          createOutputChannel() {
            return { appendLine() {}, dispose() {} };
          },
          registerWebviewViewProvider() {
            return { dispose() {} };
          },
          setStatusBarMessage() {},
          showInformationMessage: async () => undefined,
          showQuickPick: async () => undefined,
          showWarningMessage: async () => undefined,
          showErrorMessage: async () => undefined
        },
        workspace: {
          workspaceFolders: [],
          getConfiguration(section: string) {
            return {
              get(name: string, defaultValue: unknown) {
                return overrides.configuration?.[`${section}.${name}`] ?? defaultValue;
              },
              update: async () => undefined
            };
          },
          createFileSystemWatcher() {
            return {
              onDidCreate() {},
              onDidChange() {},
              onDidDelete() {},
              dispose() {}
            };
          },
          fs: {
            delete: async () => undefined
          }
        },
        commands: {
          executeCommand: overrides.executeCommand ?? (async () => undefined),
          registerCommand() {
            return { dispose() {} };
          }
        },
        env: {
          clipboard: { writeText: async () => undefined },
          openExternal: async () => undefined
        }
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const extensionPath = require.resolve('../extension');
    delete require.cache[extensionPath];
    return require(extensionPath) as Record<string, unknown>;
  } finally {
    (Module as any)._load = originalLoad;
  }
}
