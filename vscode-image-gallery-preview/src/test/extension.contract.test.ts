import * as assert from 'assert';
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

  test('detects duplicate images only for the affected file path', () => {
    const extensionModule = requireExtensionModule();
    const duplicateAlertForAffectedPath = extensionModule.duplicateAlertForAffectedPath as ((items: GalleryAssetItem[], affectedPath: string) => { newItem: GalleryAssetItem; duplicates: GalleryAssetItem[] } | null) | undefined;

    assert.ok(duplicateAlertForAffectedPath, 'expected extension to export duplicateAlertForAffectedPath for contract tests');

    const existing = asset('png', 'image', {
      absPath: 'C:/demo/res/image/a.png',
      relPath: 'res/image/a.png',
      resourceRootPath: 'C:/demo/res/image',
      md5: 'same-md5',
      mtime: 1
    });
    const added = asset('png', 'image', {
      absPath: 'C:/demo/res/image/news/a.png',
      relPath: 'res/image/news/a.png',
      resourceRootPath: 'C:/demo/res/image',
      md5: 'same-md5',
      mtime: 2
    });
    const otherPlatform = asset('png', 'image', {
      absPath: 'C:/demo/ios/Runner/Assets.xcassets/a.imageset/a.png',
      relPath: 'ios/Runner/Assets.xcassets/a.imageset/a.png',
      resourceRootPath: 'C:/demo/ios/Runner/Assets.xcassets/a.imageset',
      platform: 'ios',
      md5: 'same-md5',
      mtime: 3
    });

    assert.strictEqual(duplicateAlertForAffectedPath!([existing, added, otherPlatform], existing.absPath)?.newItem.absPath, existing.absPath);
    const alert = duplicateAlertForAffectedPath!([existing, added, otherPlatform], added.absPath);
    assert.strictEqual(alert?.newItem.absPath, added.absPath);
    assert.deepStrictEqual(alert?.duplicates.map((item) => item.absPath), [existing.absPath]);
    assert.strictEqual(duplicateAlertForAffectedPath!([existing, added, otherPlatform], 'C:/demo/res/image/missing.png'), null);
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

function requireExtensionModule(): Record<string, unknown> {
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
          showQuickPick: async () => undefined,
          showWarningMessage: async () => undefined,
          showErrorMessage: async () => undefined
        },
        workspace: {
          workspaceFolders: [],
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
          executeCommand: async () => undefined,
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
