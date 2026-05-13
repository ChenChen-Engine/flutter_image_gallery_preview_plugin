import { GalleryAssetItem, ImageInfo } from './shared/types';

export type GalleryRenderKind = 'image' | 'lottie' | 'placeholder';

export interface WebviewAssetItem extends GalleryAssetItem {
  fileName: string;
  previewSrc: string | null;
  renderKind: GalleryRenderKind;
  lottieJson?: string | null;
  imageInfo?: ImageInfo;
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
    imageInfo: item.imageInfo
  };
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/');
}

function fileNameOf(value: string): string {
  const normalized = normalizePath(value);
  const slash = normalized.lastIndexOf('/');
  return slash >= 0 ? normalized.substring(slash + 1) : normalized;
}
