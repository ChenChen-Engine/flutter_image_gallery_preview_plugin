import * as assert from 'assert';
import { GalleryAssetItem, MediaMetadataInfo } from '../shared/types';

suite('media metadata helper', () => {
  test('writes indexed durationMillis from merged metadata rows', async () => {
    const metadataModule = require('../mediaMetadata') as Record<string, unknown>;
    const enrichIndexedItem = metadataModule.enrichIndexedItem as ((item: GalleryAssetItem, deps: {
      loadMediaInfoCli: (item: GalleryAssetItem) => Promise<MediaMetadataInfo | null>;
      loadFfprobe: (item: GalleryAssetItem) => Promise<MediaMetadataInfo | null>;
      loadBuiltIn: (item: GalleryAssetItem) => Promise<MediaMetadataInfo>;
      loadImageInfo: () => Promise<never>;
    }) => Promise<GalleryAssetItem>) | undefined;

    assert.ok(enrichIndexedItem, 'expected mediaMetadata helper to export enrichIndexedItem');

    const item = asset('mp3', 'audio');
    const enriched = await enrichIndexedItem!(item, {
      loadMediaInfoCli: async () => info('audio', 'MediaInfo (PATH)', {
        General: {
          Duration: '2 min 4 s'
        },
        Audio: {
          Format: 'AAC'
        }
      }),
      loadFfprobe: async () => null,
      loadBuiltIn: async () => info('audio', 'Built-in', {
        General: {
          'File size': '512 KiB'
        }
      }),
      loadImageInfo: async () => {
        throw new Error('not expected for audio');
      }
    });

    assert.strictEqual(enriched.durationMillis, 124_000);
    assert.strictEqual(enriched.mediaInfo?.source, 'MediaInfo (PATH)');
  });

  test('keeps MediaInfo as primary source while merging ffprobe and built-in rows', async () => {
    const metadataModule = require('../mediaMetadata') as Record<string, unknown>;
    const resolveIndexedMediaInfo = metadataModule.resolveIndexedMediaInfo as ((item: GalleryAssetItem, deps: {
      loadMediaInfoCli: (item: GalleryAssetItem) => Promise<MediaMetadataInfo | null>;
      loadFfprobe: (item: GalleryAssetItem) => Promise<MediaMetadataInfo | null>;
      loadBuiltIn: (item: GalleryAssetItem) => Promise<MediaMetadataInfo>;
      loadImageInfo: () => Promise<never>;
    }) => Promise<MediaMetadataInfo>) | undefined;

    assert.ok(resolveIndexedMediaInfo, 'expected mediaMetadata helper to export resolveIndexedMediaInfo');

    const item = asset('mp4', 'video');
    const result = await resolveIndexedMediaInfo!(item, {
      loadMediaInfoCli: async () => info('video', 'MediaInfo (mediainfo.exe)', {
        General: {
          'Complete name': item.absPath,
          Format: 'MPEG-4'
        },
        Video: {
          Format: 'AVC'
        }
      }),
      loadFfprobe: async () => info('video', 'ffprobe', {
        General: {
          Duration: '1 min 5 s',
          'Overall bit rate': '900 kb/s'
        },
        Video: {
          Width: '1920 pixels',
          Height: '1080 pixels'
        }
      }),
      loadBuiltIn: async () => info('video', 'Built-in', {
        General: {
          'File size': '2.00 MiB'
        },
        Video: {
          'Stream size': '2.00 MiB'
        }
      }),
      loadImageInfo: async () => {
        throw new Error('not expected for video');
      }
    });

    assert.strictEqual(result.source, 'MediaInfo (mediainfo.exe)');
    assert.strictEqual(rowValue(result, 'General', 'Duration'), '1 min 5 s');
    assert.strictEqual(rowValue(result, 'General', 'Overall bit rate'), '900 kb/s');
    assert.strictEqual(rowValue(result, 'General', 'File size'), '2.00 MiB');
    assert.strictEqual(rowValue(result, 'Video', 'Width'), '1920 pixels');
    assert.strictEqual(rowValue(result, 'Video', 'Height'), '1080 pixels');
    assert.strictEqual(rowValue(result, 'Video', 'Stream size'), '2.00 MiB');
  });

  test('falls back to ffprobe and built-in metadata when MediaInfo is unavailable', async () => {
    const metadataModule = require('../mediaMetadata') as Record<string, unknown>;
    const resolveIndexedMediaInfo = metadataModule.resolveIndexedMediaInfo as ((item: GalleryAssetItem, deps: {
      loadMediaInfoCli: (item: GalleryAssetItem) => Promise<MediaMetadataInfo | null>;
      loadFfprobe: (item: GalleryAssetItem) => Promise<MediaMetadataInfo | null>;
      loadBuiltIn: (item: GalleryAssetItem) => Promise<MediaMetadataInfo>;
      loadImageInfo: () => Promise<never>;
    }) => Promise<MediaMetadataInfo>) | undefined;

    assert.ok(resolveIndexedMediaInfo, 'expected mediaMetadata helper to export resolveIndexedMediaInfo');

    const item = asset('mp3', 'audio');
    const result = await resolveIndexedMediaInfo!(item, {
      loadMediaInfoCli: async () => null,
      loadFfprobe: async () => info('audio', 'ffprobe', {
        General: {
          Duration: '2 min 4 s'
        },
        Audio: {
          'Sampling rate': '48 kHz'
        }
      }),
      loadBuiltIn: async () => info('audio', 'Built-in', {
        General: {
          Format: 'MP3',
          'File size': '512 KiB'
        },
        Audio: {
          'Stream size': '512 KiB'
        }
      }),
      loadImageInfo: async () => {
        throw new Error('not expected for audio');
      }
    });

    assert.strictEqual(result.source, 'ffprobe');
    assert.strictEqual(rowValue(result, 'General', 'Format'), 'MP3');
    assert.strictEqual(rowValue(result, 'General', 'Duration'), '2 min 4 s');
    assert.strictEqual(rowValue(result, 'Audio', 'Sampling rate'), '48 kHz');
    assert.strictEqual(rowValue(result, 'Audio', 'Stream size'), '512 KiB');
  });
});

function info(
  mediaType: 'image' | 'audio' | 'video',
  sections: Record<string, Record<string, string>>
): MediaMetadataInfo;
function info(
  mediaType: 'image' | 'audio' | 'video',
  source: string,
  sections: Record<string, Record<string, string>>
): MediaMetadataInfo;
function info(
  mediaType: 'image' | 'audio' | 'video',
  sourceOrSections: string | Record<string, Record<string, string>>,
  maybeSections?: Record<string, Record<string, string>>
): MediaMetadataInfo {
  const source = typeof sourceOrSections === 'string' ? sourceOrSections : 'Built-in';
  const sections = typeof sourceOrSections === 'string' ? maybeSections! : sourceOrSections;
  return {
    mediaType,
    source,
    sections: Object.entries(sections).map(([title, rows]) => ({
      title,
      rows: Object.entries(rows).map(([label, value]) => ({ label, value }))
    }))
  };
}

function rowValue(info: MediaMetadataInfo, title: string, label: string): string | undefined {
  return info.sections.find((section) => section.title === title)?.rows.find((row) => row.label === label)?.value;
}

function asset(
  formatFamily: GalleryAssetItem['formatFamily'],
  mediaType: GalleryAssetItem['mediaType']
): GalleryAssetItem {
  const extension = mediaType === 'audio' ? 'mp3' : 'mp4';
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
    groupPath: 'assets',
    copyToken: `assets/media/file.${extension}`,
    md5: 'hash',
    formatFamily,
    isAnimated: false,
    mediaType,
    durationMillis: mediaType === 'audio' ? 124_000 : 65_000,
    resourceRootPath: 'C:/demo/assets/media',
    absPath: `C:/demo/assets/media/file.${extension}`,
    relPath: `assets/media/file.${extension}`,
    format: extension,
    width: null,
    height: null,
    qualifier: '',
    mtime: 1,
    kind: formatFamily
  };
}
