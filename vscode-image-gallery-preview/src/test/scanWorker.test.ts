import * as assert from 'assert';
import { GalleryAssetItem } from '../shared/types';

suite('scan worker', () => {
  test('emits structured discover and enrich progress with heartbeats', async () => {
    const workerModule = require('../scanWorker') as Record<string, unknown>;
    const runScanWorker = workerModule.runScanWorker as ((args: {
      roots: string[];
      postMessage: (message: any) => void;
      scanAssets: (root: string) => GalleryAssetItem[];
      enrichItem: (item: GalleryAssetItem) => Promise<GalleryAssetItem>;
      heartbeatMs: number;
    }) => Promise<GalleryAssetItem[]>) | undefined;

    assert.ok(runScanWorker, 'expected scanWorker to export runScanWorker');

    const messages: any[] = [];
    const items = await runScanWorker!({
      roots: ['C:/demo/one', 'C:/demo/two'],
      postMessage: (message) => messages.push(message),
      scanAssets: (root) =>
        root.endsWith('/one') ? [asset('one.mp3', 'audio')] : [asset('two.mp4', 'video')],
      enrichItem: async (item) => {
        await delay(12);
        return {
          ...item,
          mediaInfo: {
            mediaType: item.mediaType,
            source: 'Built-in',
            sections: [{ title: item.mediaType === 'video' ? 'Video' : 'Audio', rows: [{ label: 'Format', value: item.format.toUpperCase() }] }]
          }
        };
      },
      heartbeatMs: 5
    });

    const progress = messages.filter((message) => message.type === 'progress');
    assert.ok(progress.some((message) => message.progress?.phase === 'discover' && message.progress?.count === 1 && message.progress?.currentPath === 'C:/demo/one'));
    assert.ok(progress.some((message) => message.progress?.phase === 'enrich' && message.progress?.count === 2 && /two\.mp4$/.test(message.progress?.currentPath ?? '')));
    assert.ok(progress.some((message) => message.progress?.heartbeat === true), 'expected at least one heartbeat progress message');

    const done = messages.find((message) => message.type === 'done');
    assert.ok(done, 'expected done message');
    assert.strictEqual(done.items.length, 2);
    assert.ok(done.items.every((item: GalleryAssetItem) => item.mediaInfo), 'expected eager metadata enrichment in done payload');
    assert.ok(items.every((item) => item.mediaInfo), 'expected returned items to include eager media info');
  });
});

function asset(fileName: string, mediaType: GalleryAssetItem['mediaType']): GalleryAssetItem {
  const formatFamily = mediaType === 'audio' ? 'mp3' : 'mp4';
  return {
    sourceType: 'flutter_asset',
    platform: 'flutter',
    workspaceKind: 'flutter',
    projectName: 'demo',
    projectPath: 'C:/demo',
    projectRelPath: '.',
    isPrimaryProject: true,
    moduleName: 'demo',
    modulePath: 'C:/demo',
    moduleRelPath: '.',
    isPrimaryModule: true,
    groupPath: 'assets/media',
    copyToken: `assets/media/${fileName}`,
    md5: fileName,
    formatFamily,
    isAnimated: false,
    mediaType,
    durationMillis: mediaType === 'audio' ? 124_000 : 65_000,
    resourceRootPath: 'C:/demo/assets/media',
    absPath: `C:/demo/assets/media/${fileName}`,
    relPath: `assets/media/${fileName}`,
    format: formatFamily,
    width: null,
    height: null,
    qualifier: '',
    mtime: 1,
    kind: formatFamily
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
