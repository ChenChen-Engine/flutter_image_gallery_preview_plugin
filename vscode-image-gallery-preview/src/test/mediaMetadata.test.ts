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

  test('tries MediaInfo CLI before built-in and ffprobe metadata', async () => {
    const metadataModule = require('../mediaMetadata') as Record<string, unknown>;
    const resolveIndexedMediaInfo = metadataModule.resolveIndexedMediaInfo as ((item: GalleryAssetItem, deps: {
      loadMediaInfoCli: (item: GalleryAssetItem) => Promise<MediaMetadataInfo | null>;
      loadFfprobe: (item: GalleryAssetItem) => Promise<MediaMetadataInfo | null>;
      loadBuiltIn: (item: GalleryAssetItem) => Promise<MediaMetadataInfo>;
      loadImageInfo: () => Promise<never>;
    }) => Promise<MediaMetadataInfo>) | undefined;

    assert.ok(resolveIndexedMediaInfo, 'expected mediaMetadata helper to export resolveIndexedMediaInfo');

    const calls: string[] = [];
    await resolveIndexedMediaInfo!(asset('mp4', 'video'), {
      loadMediaInfoCli: async () => {
        calls.push('mediainfo');
        return info('video', 'MediaInfo (PATH)', { General: { Format: 'MPEG-4' } });
      },
      loadFfprobe: async () => {
        calls.push('ffprobe');
        return info('video', 'ffprobe', { General: { Duration: '1 min 5 s' } });
      },
      loadBuiltIn: async () => {
        calls.push('built-in');
        return info('video', 'Built-in', { General: { 'File size': '2.00 MiB' } });
      },
      loadImageInfo: async () => {
        throw new Error('not expected for video');
      }
    });

    assert.strictEqual(calls[0], 'mediainfo');
  });

  test('maps every primitive MediaInfo row without truncating at eighty entries', () => {
    const metadataModule = require('../mediaMetadata') as Record<string, unknown>;
    const mediaInfoTrackToSection = metadataModule.mediaInfoTrackToSection as ((track: Record<string, unknown>) => {
      title: string;
      rows: Array<{ label: string; value: string }>;
    }) | undefined;

    assert.ok(mediaInfoTrackToSection, 'expected mediaInfoTrackToSection to be exported for parser tests');

    const track: Record<string, unknown> = { '@type': 'General' };
    for (let index = 0; index < 120; index++) {
      track[`Field_${index}`] = `value-${index}`;
    }

    const section = mediaInfoTrackToSection!(track);

    assert.strictEqual(section.rows.length, 120);
    assert.strictEqual(section.rows[119].value, 'value-119');
  });

  test('parses MediaInfo text output when lowercase json flag returns default text', () => {
    const metadataModule = require('../mediaMetadata') as Record<string, unknown>;
    const parseMediaInfoOutput = metadataModule.parseMediaInfoOutput as ((output: string, mediaType: 'audio') => MediaMetadataInfo | null) | undefined;

    assert.ok(parseMediaInfoOutput, 'expected parseMediaInfoOutput to be exported for parser tests');

    const output = [
      'General',
      'Complete name                            : E:\\Work\\Project\\FlutterProject\\shanjian\\res\\audio\\countdown.mp3',
      'Format                                   : MPEG Audio',
      'File size                                : 85.8 KiB',
      'Duration                                 : 5 s 59 ms',
      'Overall bit rate mode                    : Constant',
      'Overall bit rate                         : 128 kb/s',
      'Genre                                    : Blues',
      'Recorded date                            : 2024-05-09 11:15',
      'Writing library                          : LAME3.100',
      '',
      'Audio',
      'Format                                   : MPEG Audio',
      'Format version                           : Version 1',
      'Format profile                           : Layer 3',
      'Duration                                 : 5 s 60 ms',
      'Bit rate                                 : 128 kb/s',
      'Channel(s)                               : 2 channels',
      'Sampling rate                            : 44.1 kHz',
      'Compression mode                         : Lossy',
      'Stream size                              : 79.1 KiB (92%)'
    ].join('\n');

    const info = parseMediaInfoOutput!(output, 'audio');

    assert.strictEqual(info?.source, 'MediaInfo');
    assert.strictEqual(rowValue(info!, 'General', 'File size'), '85.8 KiB');
    assert.strictEqual(rowValue(info!, 'Audio', 'Sampling rate'), '44.1 kHz');
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
