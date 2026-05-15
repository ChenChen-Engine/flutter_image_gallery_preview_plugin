import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import exifReader from 'exif-reader';
import sharp from 'sharp';
import { GalleryAssetItem, ImageInfo, MediaMetadataInfo, MediaType, MetadataRow, MetadataSection } from './shared/types';
import { findMediaInfoExecutable } from './mediaInfoTool';

const execFileAsync = promisify(execFile);
const MEDIAINFO_DOWNLOAD_URL = 'https://mediaarea.net/en/MediaInfo/Download/Windows';

export interface ResolveIndexedMediaInfoDependencies {
  loadBuiltIn: (item: GalleryAssetItem) => Promise<MediaMetadataInfo>;
  loadFfprobe: (item: GalleryAssetItem) => Promise<MediaMetadataInfo | null>;
  loadImageInfo: (item: GalleryAssetItem) => Promise<ImageInfo>;
  loadMediaInfoCli: (item: GalleryAssetItem) => Promise<MediaMetadataInfo | null>;
}

export async function enrichIndexedItem(
  item: GalleryAssetItem,
  deps: ResolveIndexedMediaInfoDependencies = defaultResolveDependencies
): Promise<GalleryAssetItem> {
  if (item.mediaType === 'image') {
    const imageInfo = await deps.loadImageInfo(item);
    return {
      ...item,
      imageInfo,
      mediaInfo: imageInfoToMediaInfo(imageInfo)
    };
  }

  const mediaInfo = await resolveIndexedMediaInfo(item, deps);
  return {
    ...item,
    durationMillis: durationMillisFromInfo(mediaInfo) ?? item.durationMillis,
    mediaInfo
  };
}

export async function resolveIndexedMediaInfo(
  item: GalleryAssetItem,
  deps: ResolveIndexedMediaInfoDependencies = defaultResolveDependencies
): Promise<MediaMetadataInfo> {
  if (item.mediaType === 'image') {
    return imageInfoToMediaInfo(await deps.loadImageInfo(item));
  }

  const builtIn = await deps.loadBuiltIn(item);
  const mediaInfo = await deps.loadMediaInfoCli(item);
  const ffprobe = await deps.loadFfprobe(item);

  if (mediaInfo) {
    return mergeMetadataSources(mediaInfo, [ffprobe, builtIn]);
  }
  if (ffprobe) {
    return mergeMetadataSources(ffprobe, [builtIn]);
  }
  return builtIn;
}

export async function extractMediaInfo(absPath: string, item?: GalleryAssetItem): Promise<MediaMetadataInfo> {
  const baseItem = item ?? createFallbackItem(absPath);
  return resolveIndexedMediaInfo(baseItem);
}

export function seedMediaInfoCache(items: GalleryAssetItem[]): Map<string, MediaMetadataInfo> {
  const cache = new Map<string, MediaMetadataInfo>();
  for (const item of items) {
    if (!item.mediaInfo) continue;
    cache.set(normalizePath(item.absPath), item.mediaInfo);
  }
  return cache;
}

function mergeMetadataSources(primary: MediaMetadataInfo, supplements: Array<MediaMetadataInfo | null | undefined>): MediaMetadataInfo {
  const mergedSections = primary.sections.map((section) => ({
    title: section.title,
    rows: section.rows.map((row) => ({ ...row }))
  }));
  const sectionIndex = new Map<string, MetadataSection>();
  for (const section of mergedSections) {
    sectionIndex.set(section.title, section);
  }

  for (const supplement of supplements) {
    if (!supplement) continue;
    for (const section of supplement.sections) {
      const target = sectionIndex.get(section.title);
      if (!target) {
        const cloned = {
          title: section.title,
          rows: section.rows.map((row) => ({ ...row }))
        };
        mergedSections.push(cloned);
        sectionIndex.set(section.title, cloned);
        continue;
      }

      const rowIndex = new Map<string, MetadataRow>();
      for (const row of target.rows) {
        rowIndex.set(row.label, row);
      }

      for (const row of section.rows) {
        const existing = rowIndex.get(row.label);
        if (!existing) {
          const cloned = { ...row };
          target.rows.push(cloned);
          rowIndex.set(row.label, cloned);
          continue;
        }
        if (isUnknownValue(existing.value) && !isUnknownValue(row.value)) {
          existing.value = row.value;
        }
      }
    }
  }

  return {
    mediaType: primary.mediaType,
    source: primary.source,
    sections: mergedSections,
    installHint: primary.installHint ?? supplements.find((supplement) => supplement?.installHint)?.installHint ?? null
  };
}

function isUnknownValue(value: string): boolean {
  return value.trim().toLowerCase() === 'unknown';
}

const defaultResolveDependencies: ResolveIndexedMediaInfoDependencies = {
  loadBuiltIn: async (item) => fallbackMediaInfo(item.absPath, item.mediaType, item),
  loadFfprobe: async (item) => tryFfprobe(item.absPath, item.mediaType),
  loadImageInfo: async (item) => extractImageInfo(item.absPath),
  loadMediaInfoCli: async (item) => tryMediaInfo(item.absPath, item.mediaType)
};

function createFallbackItem(absPath: string): GalleryAssetItem {
  const mediaType = mediaTypeFromPath(absPath);
  const format = path.extname(absPath).replace('.', '').toLowerCase() || 'other';
  return {
    sourceType: 'flutter_asset',
    platform: 'flutter',
    workspaceKind: 'unknown',
    projectName: '',
    projectPath: '',
    projectRelPath: '.',
    isPrimaryProject: true,
    moduleName: '',
    modulePath: '',
    moduleRelPath: '.',
    isPrimaryModule: true,
    groupPath: '',
    copyToken: normalizePath(absPath),
    md5: '',
    formatFamily: format as GalleryAssetItem['formatFamily'],
    isAnimated: false,
    mediaType,
    durationMillis: null,
    resourceRootPath: '',
    absPath: normalizePath(absPath),
    relPath: normalizePath(absPath),
    format,
    width: null,
    height: null,
    qualifier: '',
    mtime: 0,
    kind: format as GalleryAssetItem['kind']
  };
}

function imageInfoToMediaInfo(info: ImageInfo): MediaMetadataInfo {
  return {
    mediaType: 'image',
    source: 'Built-in',
    sections: [
      {
        title: 'Image',
        rows: [
          metadataRow('width', info.width),
          metadataRow('height', info.height),
          metadataRow('color Space', info.colorSpace),
          metadataRow('chroma subsampling', info.chromaSubsampling),
          metadataRow('bit depth', info.bitDepth),
          metadataRow('compression mode', info.compressionMode),
          metadataRow('stream size', info.streamSize),
          metadataRow('file size', info.fileSize),
          metadataRow('format', info.format),
          metadataRow('abs path', info.absPath)
        ]
      }
    ]
  };
}

async function tryMediaInfo(absPath: string, mediaType: MediaType): Promise<MediaMetadataInfo | null> {
  const commands: Array<{ file: string; args: string[]; source: string }> = [];
  if (process.platform === 'win32') {
    commands.push({
      file: 'cmd',
      args: ['/c', 'mediaInfo', '--output=json', absPath],
      source: 'MediaInfo (PATH)'
    });
  }

  const executable = findMediaInfoExecutable();
  if (executable) {
    commands.push({
      file: executable,
      args: ['--Output=JSON', absPath],
      source: `MediaInfo (${executable})`
    });
  }

  if (process.platform !== 'win32' && !commands.length) {
    commands.push({
      file: 'mediainfo',
      args: ['--Output=JSON', absPath],
      source: 'MediaInfo (PATH)'
    });
  }

  for (const command of commands) {
    try {
      const { stdout } = await execFileAsync(command.file, command.args, { windowsHide: true, timeout: 8000 });
      const parsed = JSON.parse(stdout);
      const tracks = Array.isArray(parsed?.media?.track) ? parsed.media.track : [];
      const sections = tracks
        .map((track: Record<string, unknown>) => mediaInfoTrackToSection(track))
        .filter((section: MetadataSection) => section.rows.length > 0);
      if (!sections.length) continue;
      return { mediaType, source: command.source, sections };
    } catch {
      // try the next command candidate
    }
  }

  return null;
}

function mediaInfoTrackToSection(track: Record<string, unknown>): MetadataSection {
  const title = String(track['@type'] ?? track.Type ?? 'General');
  const rows = Object.entries(track)
    .filter(([key, value]) => !key.startsWith('@') && value != null && typeof value !== 'object')
    .slice(0, 80)
    .map(([key, value]) => metadataRow(humanizeKey(key), value));
  return { title, rows };
}

async function tryFfprobe(absPath: string, mediaType: MediaType): Promise<MediaMetadataInfo | null> {
  try {
    const { stdout } = await execFileAsync(
      'ffprobe',
      ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', absPath],
      { windowsHide: true, timeout: 8000, maxBuffer: 2 * 1024 * 1024 }
    );
    const parsed = JSON.parse(stdout);
    const sections: MetadataSection[] = [];
    if (parsed.format) {
      sections.push({
        title: 'General',
        rows: [
          metadataRow('Complete name', absPath),
          metadataRow('Format', parsed.format.format_long_name ?? parsed.format.format_name),
          metadataRow('File size', parsed.format.size ? readableBytes(Number(parsed.format.size)) : 'Unknown'),
          metadataRow('Duration', formatSeconds(parsed.format.duration)),
          metadataRow('Overall bit rate', parsed.format.bit_rate ? `${Math.round(Number(parsed.format.bit_rate) / 1000)} kb/s` : 'Unknown')
        ]
      });
    }
    for (const stream of parsed.streams ?? []) {
      const codecType = stream.codec_type === 'audio' ? 'Audio' : stream.codec_type === 'video' ? 'Video' : null;
      if (!codecType) continue;
      sections.push({
        title: codecType,
        rows: [
          metadataRow('Format', stream.codec_long_name ?? stream.codec_name),
          metadataRow('Codec ID', stream.codec_tag_string),
          metadataRow('Duration', formatSeconds(stream.duration)),
          metadataRow('Bit rate', stream.bit_rate ? `${Math.round(Number(stream.bit_rate) / 1000)} kb/s` : 'Unknown'),
          metadataRow('Width', stream.width ? `${stream.width} pixels` : undefined),
          metadataRow('Height', stream.height ? `${stream.height} pixels` : undefined),
          metadataRow('Frame rate', stream.avg_frame_rate),
          metadataRow('Channel(s)', stream.channels ? `${stream.channels} channels` : undefined),
          metadataRow('Sampling rate', stream.sample_rate ? `${Number(stream.sample_rate) / 1000} kHz` : undefined),
          metadataRow('Color space', stream.color_space),
          metadataRow('Chroma subsampling', stream.chroma_location),
          metadataRow('Bit depth', stream.bits_per_raw_sample || stream.bits_per_sample)
        ]
      });
    }
    return sections.length ? { mediaType, source: 'ffprobe', sections } : null;
  } catch {
    return null;
  }
}

function fallbackMediaInfo(absPath: string, mediaType: MediaType, item?: GalleryAssetItem): MediaMetadataInfo {
  const stat = safeStat(absPath);
  const generalRows = [
    metadataRow('Complete name', normalizePath(absPath)),
    metadataRow('Format', path.extname(absPath).replace('.', '').toUpperCase() || 'Unknown'),
    metadataRow('File size', stat ? readableBytes(stat.size) : 'Unknown'),
    metadataRow('Duration', formatMillis(item?.durationMillis)),
    metadataRow('Overall bit rate', 'Unknown')
  ];
  const streamRows = [
    metadataRow('Format', path.extname(absPath).replace('.', '').toUpperCase() || 'Unknown'),
    metadataRow('Duration', formatMillis(item?.durationMillis)),
    metadataRow('Bit rate', 'Unknown'),
    metadataRow('Compression mode', 'Unknown'),
    metadataRow('Stream size', stat ? readableBytes(stat.size) : 'Unknown')
  ];
  return {
    mediaType,
    source: 'Built-in',
    sections: [
      { title: 'General', rows: generalRows },
      { title: mediaType === 'video' ? 'Video' : 'Audio', rows: streamRows }
    ],
    installHint: installHint()
  };
}

async function extractImageInfo(absPath: string): Promise<ImageInfo> {
  const stat = safeStat(absPath);
  const fileSize = stat ? readableBytes(stat.size) : 'Unknown';
  const format = path.extname(absPath).replace('.', '').toUpperCase() || 'Unknown';

  const unknown: ImageInfo = {
    width: 'Unknown',
    height: 'Unknown',
    colorSpace: 'Unknown',
    chromaSubsampling: 'Unknown',
    bitDepth: 'Unknown',
    compressionMode: 'Unknown',
    streamSize: fileSize,
    fileSize,
    format,
    absPath: normalizePath(absPath)
  };

  if (!stat) return unknown;

  try {
    const image = sharp(absPath, { failOnError: false });
    const metadata = await image.metadata();

    let colorSpace: string = metadata.space ? String(metadata.space) : 'Unknown';
    let chromaSubsampling = metadata.chromaSubsampling || 'Unknown';
    let bitDepth: string = metadata.depth ? String(metadata.depth) : 'Unknown';
    let compressionMode = metadata.compression || 'Unknown';

    if (metadata.exif) {
      try {
        const exif = exifReader(metadata.exif as Buffer) as any;
        colorSpace = colorSpace !== 'Unknown' ? colorSpace : String(exif?.image?.ColorSpace ?? 'Unknown');
        chromaSubsampling =
          chromaSubsampling !== 'Unknown'
            ? chromaSubsampling
            : String(exif?.image?.YCbCrSubSampling ?? 'Unknown');
        bitDepth =
          bitDepth !== 'Unknown'
            ? bitDepth
            : String(exif?.image?.BitsPerSample ?? exif?.photo?.BitsPerSample ?? 'Unknown');
        compressionMode =
          compressionMode !== 'Unknown'
            ? compressionMode
            : String(exif?.image?.Compression ?? 'Unknown');
      } catch {
        // ignore malformed EXIF
      }
    }

    const streamSize = metadata.size != null ? readableBytes(metadata.size) : fileSize;

    return {
      width: metadata.width != null ? String(metadata.width) : 'Unknown',
      height: metadata.height != null ? String(metadata.height) : 'Unknown',
      colorSpace,
      chromaSubsampling,
      bitDepth,
      compressionMode,
      streamSize,
      fileSize,
      format,
      absPath: normalizePath(absPath)
    };
  } catch {
    return unknown;
  }
}

function mediaTypeFromPath(absPath: string): MediaType {
  const extension = path.extname(absPath).replace('.', '').toLowerCase();
  if (['mp3', 'm4a', 'aac', 'wav', 'ogg', 'opus', 'flac', 'amr', 'mid', 'midi', 'caf', 'wma', 'aiff', 'aif', 'alac', 'mka'].includes(extension)) return 'audio';
  if (['mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi', '3gp', '3gpp', 'mpeg', 'mpg', 'ts', 'm2ts', 'wmv', 'flv'].includes(extension)) return 'video';
  return 'image';
}

function formatMillis(value: number | null | undefined): string {
  if (!value || value <= 0) return 'Unknown';
  return formatSeconds(value / 1000);
}

function formatSeconds(value: unknown): string {
  const secondsValue = Number(value);
  if (!Number.isFinite(secondsValue) || secondsValue <= 0) return 'Unknown';
  const totalMs = Math.round(secondsValue * 1000);
  const totalSeconds = Math.floor(totalMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const millis = totalMs % 1000;
  const base = hours > 0
    ? `${hours} h ${minutes} min ${seconds} s`
    : minutes > 0
      ? `${minutes} min ${seconds} s`
      : `${seconds} s`;
  return millis > 0 ? `${base} ${millis} ms` : base;
}

function durationMillisFromInfo(info: MediaMetadataInfo | null | undefined): number | null {
  if (!info) return null;
  for (const section of info.sections) {
    for (const row of section.rows) {
      if (row.label.trim().toLowerCase().startsWith('duration')) {
        const parsed = parseDurationMillis(row.value);
        if (parsed && parsed > 0) return parsed;
      }
    }
  }
  return null;
}

function parseDurationMillis(value: string): number | null {
  const text = String(value ?? '').trim();
  if (!text) return null;

  const clock = text.match(/^(?:(\d+):)?(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?$/);
  if (clock) {
    const hours = Number(clock[1] || 0);
    const minutes = Number(clock[2] || 0);
    const seconds = Number(clock[3] || 0);
    const millis = Number(String(clock[4] || '').padEnd(3, '0') || 0);
    return (((hours * 60) + minutes) * 60 + seconds) * 1000 + millis;
  }

  let matched = false;
  let total = 0;
  for (const match of text.matchAll(/(\d+(?:\.\d+)?)\s*(ms|h|hr|hrs|hour|hours|min|mn|m|s)\b/gi)) {
    matched = true;
    const amount = Number(match[1]);
    const unit = match[2].toLowerCase();
    total += unit === 'ms'
      ? amount
      : ['h', 'hr', 'hrs', 'hour', 'hours'].includes(unit)
        ? amount * 3_600_000
        : ['min', 'mn', 'm'].includes(unit)
          ? amount * 60_000
          : amount * 1000;
  }
  if (matched && total > 0) return Math.round(total);

  const secondsValue = Number(text);
  return Number.isFinite(secondsValue) && secondsValue > 0 ? Math.round(secondsValue * 1000) : null;
}

function humanizeKey(key: string): string {
  return key
    .replace(/_String\d*$/i, '')
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim();
}

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

function safeStat(absPath: string): fs.Stats | null {
  try {
    return fs.statSync(absPath);
  } catch {
    return null;
  }
}

function readableBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'Unknown';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let unitIndex = -1;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(2)} ${units[unitIndex]}`;
}

function metadataRow(label: string, value: unknown): MetadataRow {
  return {
    label,
    value: value == null || value === '' ? 'Unknown' : String(value)
  };
}

function installHint() {
  return {
    text: 'Install MediaInfo CLI for richer metadata.',
    actionLabel: 'Download CLI',
    url: MEDIAINFO_DOWNLOAD_URL
  };
}
