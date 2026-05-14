import { GalleryAssetItem, ImageInfo, MediaMetadataInfo } from './shared/types';

export type GalleryRenderKind = 'image' | 'lottie' | 'audio' | 'video' | 'placeholder';

export interface WebviewAssetItem extends GalleryAssetItem {
  fileName: string;
  previewSrc: string | null;
  renderKind: GalleryRenderKind;
  lottieJson?: string | null;
  durationLabel: string;
  imageInfo?: ImageInfo;
  mediaInfo?: MediaMetadataInfo;
}

const BROWSER_IMAGE_FAMILIES = new Set([
  'png',
  'jpg',
  'jpeg',
  'webp',
  'gif',
  'bmp',
  'svg',
  'apng',
  'avif',
  'ico'
]);

export function toWebviewAssetItem(
  item: GalleryAssetItem,
  previewSrc: string | null,
  lottieJson: string | null = null
): WebviewAssetItem {
  const renderKind: GalleryRenderKind =
    item.formatFamily === 'lottie'
      ? 'lottie'
      : item.mediaType === 'audio'
        ? 'audio'
        : item.mediaType === 'video'
          ? 'video'
      : previewSrc && BROWSER_IMAGE_FAMILIES.has(item.formatFamily)
        ? 'image'
        : 'placeholder';

  return {
    ...item,
    absPath: normalizePath(item.absPath),
    relPath: normalizePath(item.relPath),
    fileName: fileNameOf(item.absPath),
    previewSrc,
    renderKind,
    lottieJson,
    durationLabel: durationLabel(item.durationMillis),
    imageInfo: item.imageInfo,
    mediaInfo: item.mediaInfo
  };
}

function durationLabel(durationMillis: number | null | undefined): string {
  if (!durationMillis || durationMillis <= 0) return '';
  const totalSeconds = Math.floor(durationMillis / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/');
}

function fileNameOf(value: string): string {
  const normalized = normalizePath(value);
  const slash = normalized.lastIndexOf('/');
  return slash >= 0 ? normalized.substring(slash + 1) : normalized;
}
