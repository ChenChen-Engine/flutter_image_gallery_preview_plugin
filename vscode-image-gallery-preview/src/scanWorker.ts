import { isMainThread, parentPort, workerData } from 'worker_threads';
import * as os from 'os';
import { enrichIndexedItem } from './mediaMetadata';
import { scanAssets } from './scanner';
import { GalleryAssetItem } from './shared/types';

export interface ScanWorkerProgress {
  count: number;
  currentPath: string | null;
  diagnostic?: string;
  elapsedMillis?: number;
  fallbackSource?: string;
  heartbeat: boolean;
  lastHeartbeatMillis?: number;
  message: string;
  phase: 'discover' | 'enrich' | 'done';
  partialCount?: number;
  total: number;
  workerStatus?: string;
}

export interface ScanWorkerMessage {
  error?: string;
  items?: GalleryAssetItem[];
  progress?: ScanWorkerProgress;
  total?: number;
  type: 'progress' | 'assets' | 'done' | 'error';
}

interface ScanWorkerData {
  metadataCacheKeys?: string[];
  roots?: string[];
}

interface RunScanWorkerArgs {
  enrichItem?: (item: GalleryAssetItem) => Promise<GalleryAssetItem>;
  heartbeatMs?: number;
  metadataCacheKeys?: Set<string> | string[];
  metadataParallelism?: number;
  metadataTimeoutMs?: number;
  postMessage: (message: ScanWorkerMessage) => void;
  roots: string[];
  scanAssets?: (root: string) => GalleryAssetItem[];
}

const DEFAULT_HEARTBEAT_MS = 1000;
const DEFAULT_METADATA_PARALLELISM = Math.min(6, Math.max(2, os.cpus()?.length ?? 2));
const ASSET_PUBLISH_BATCH_SIZE = 10;
const ASSET_PUBLISH_INTERVAL_MS = 500;
const DEFAULT_METADATA_ITEM_TIMEOUT_MS = 15_000;

export async function runScanWorker({
  roots,
  postMessage,
  scanAssets: scanAssetsForRoot = scanAssets,
  enrichItem = enrichIndexedItem,
  heartbeatMs = DEFAULT_HEARTBEAT_MS,
  metadataCacheKeys,
  metadataParallelism = DEFAULT_METADATA_PARALLELISM,
  metadataTimeoutMs = DEFAULT_METADATA_ITEM_TIMEOUT_MS
}: RunScanWorkerArgs): Promise<GalleryAssetItem[]> {
  const normalizedRoots = roots.map(normalizePath);
  const discoveredItems: GalleryAssetItem[] = [];
  const enrichedItems: Array<GalleryAssetItem | undefined> = [];
  const startedAt = Date.now();
  let lastProgressAt = startedAt;
  const cachedKeys = normalizeMetadataCacheKeys(metadataCacheKeys);
  let latestProgress = createProgress('discover', 0, normalizedRoots.length, null, false, startedAt, lastProgressAt, 0, 'starting');
  let lastAssetPublishAt = 0;

  const emitProgress = (
    phase: ScanWorkerProgress['phase'],
    count: number,
    total: number,
    currentPath: string | null,
    heartbeat: boolean,
    partialCount = enrichedItems.filter(Boolean).length,
    workerStatus = heartbeat ? 'heartbeat' : 'active',
    diagnostic?: string,
    fallbackSource?: string
  ) => {
    const now = Date.now();
    if (!heartbeat) lastProgressAt = now;
    latestProgress = createProgress(phase, count, total, currentPath, heartbeat, startedAt, lastProgressAt, partialCount, workerStatus, diagnostic, fallbackSource);
    postMessage({
      type: 'progress',
      progress: latestProgress,
      total: phase === 'discover' ? discoveredItems.length : total
    });
  };

  let heartbeat: NodeJS.Timeout | undefined;
  if (heartbeatMs > 0) {
    heartbeat = setInterval(() => {
      postMessage({
        type: 'progress',
        progress: createProgress(
          latestProgress.phase,
          latestProgress.count,
          latestProgress.total,
          latestProgress.currentPath,
          true,
          startedAt,
          lastProgressAt,
          enrichedItems.filter(Boolean).length,
          'heartbeat',
          'worker heartbeat active',
          latestProgress.fallbackSource
        ),
        total: latestProgress.phase === 'discover' ? discoveredItems.length : latestProgress.total
      });
    }, heartbeatMs);
  }

  try {
    for (const [index, root] of normalizedRoots.entries()) {
      emitProgress('discover', index + 1, normalizedRoots.length, root, false);
      discoveredItems.push(...scanAssetsForRoot(root));
    }

    const totalItems = discoveredItems.length;
    const parallelism = Math.max(1, Math.min(metadataParallelism, totalItems || 1));
    let nextIndex = 0;
    let completed = 0;

    const publishAssets = (force: boolean) => {
      const now = Date.now();
      if (
        !force &&
        completed !== totalItems &&
        completed % ASSET_PUBLISH_BATCH_SIZE !== 0 &&
        now - lastAssetPublishAt < ASSET_PUBLISH_INTERVAL_MS
      ) {
        return;
      }
      lastAssetPublishAt = now;
      postMessage({
        type: 'assets',
        items: compactItems(enrichedItems),
        total: completed
      });
    };

    const runNext = async (): Promise<void> => {
      while (nextIndex < totalItems) {
        const index = nextIndex++;
        const item = discoveredItems[index];
        const currentPath = normalizePath(item.absPath);
        emitProgress('enrich', completed, totalItems, currentPath, false, completed, `active ${Math.min(parallelism, totalItems - completed)}/${parallelism}`);
        enrichedItems[index] = cachedKeys.has(metadataCacheKey(item))
          ? item
          : await withMetadataTimeout(enrichItem(item), item, metadataTimeoutMs);
        completed += 1;
        const enrichedItem = enrichedItems[index];
        emitProgress(
          'enrich',
          completed,
          totalItems,
          currentPath,
          false,
          completed,
          `active ${Math.max(0, Math.min(parallelism, totalItems - completed))}/${parallelism}`,
          diagnosticFor(enrichedItem),
          fallbackSourceFor(enrichedItem)
        );
        publishAssets(false);
      }
    };

    await Promise.all(Array.from({ length: parallelism }, () => runNext()));

    const finalItems = compactItems(enrichedItems);
    publishAssets(true);
    emitProgress('done', finalItems.length, finalItems.length, null, false, finalItems.length, 'complete');
    postMessage({ type: 'done', items: finalItems, total: finalItems.length });
    return finalItems;
  } finally {
    if (heartbeat) clearInterval(heartbeat);
  }
}

function createProgress(
  phase: ScanWorkerProgress['phase'],
  count: number,
  total: number,
  currentPath: string | null,
  heartbeat: boolean,
  startedAt: number,
  lastProgressAt: number,
  partialCount: number,
  workerStatus: string,
  diagnostic?: string,
  fallbackSource?: string
): ScanWorkerProgress {
  const target = currentPath ? normalizePath(currentPath) : null;
  const currentName = target ? target.split('/').pop() || target : 'workspace';
  const activity = phase === 'discover'
    ? `Discovering roots ${count}/${Math.max(total, 1)}`
    : phase === 'enrich'
      ? `Enriching metadata ${count}/${Math.max(total, 1)}`
      : `Indexed ${count} assets`;
  return {
    phase,
    count,
    diagnostic,
    elapsedMillis: Date.now() - startedAt,
    fallbackSource,
    total,
    currentPath: target,
    heartbeat,
    lastHeartbeatMillis: Date.now() - lastProgressAt,
    partialCount,
    workerStatus,
    message: heartbeat ? `${activity} heartbeat: ${currentName}` : `${activity}: ${currentName}`
  };
}

function fallbackSourceFor(item: GalleryAssetItem | undefined): string | undefined {
  const source = item?.mediaInfo?.source;
  if (!source) return undefined;
  if (failureReasonForSource(source) || !source.toLowerCase().includes('mediainfo')) return source;
  return undefined;
}

function diagnosticFor(item: GalleryAssetItem | undefined): string | undefined {
  const source = item?.mediaInfo?.source;
  if (!source) return undefined;
  const reason = failureReasonForSource(source);
  if (reason) return `MediaInfo ${reason}; click i or Refresh Info to retry.`;
  if (!source.toLowerCase().includes('mediainfo')) return `MediaInfo unavailable; used ${source}`;
  return undefined;
}

function failureReasonForSource(source: string): string | null {
  const normalized = source.toLowerCase();
  if (normalized.includes('timeout')) return 'timeout';
  if (normalized.includes('parse-empty')) return 'parse-empty';
  if (normalized.includes('command-failed')) return 'command-failed';
  if (normalized.includes('fallback')) return 'fallback';
  return null;
}

function normalizeMetadataCacheKeys(value: RunScanWorkerArgs['metadataCacheKeys']): Set<string> {
  if (!value) return new Set();
  return value instanceof Set ? value : new Set(value);
}

function metadataCacheKey(item: GalleryAssetItem): string {
  return `${normalizePath(item.absPath)}|${item.mtime}|${item.mediaType}`;
}

function withMetadataTimeout(
  task: Promise<GalleryAssetItem>,
  item: GalleryAssetItem,
  timeoutMs: number
): Promise<GalleryAssetItem> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      finish(timeoutFallbackItem(item, `timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    const finish = (result: GalleryAssetItem) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    task.then(finish).catch((error) => {
      const reason = error instanceof Error ? error.name : 'metadata extraction failed';
      finish(timeoutFallbackItem(item, reason));
    });
  });
}

function timeoutFallbackItem(item: GalleryAssetItem, reason: string): GalleryAssetItem {
  const fileSize = readableFileSize(item.absPath);
  const reasonLabel = reason.toLowerCase().includes('timed out') ? 'timeout' : 'fallback';
  const source = `MediaInfo (${reasonLabel}: ${reason}; click i to retry)`;
  if (item.mediaType === 'image') {
    const imageInfo = {
      width: item.width != null ? String(item.width) : 'Unknown',
      height: item.height != null ? String(item.height) : 'Unknown',
      colorSpace: 'Unknown',
      chromaSubsampling: 'Unknown',
      bitDepth: 'Unknown',
      compressionMode: 'Unknown',
      streamSize: fileSize,
      fileSize,
      format: item.format.toUpperCase(),
      absPath: normalizePath(item.absPath)
    };
    return {
      ...item,
      imageInfo,
      mediaInfo: {
        mediaType: 'image',
        source,
        sections: [
          {
            title: 'Image',
            rows: [
              { label: 'width', value: imageInfo.width },
              { label: 'height', value: imageInfo.height },
              { label: 'format', value: imageInfo.format },
              { label: 'file size', value: imageInfo.fileSize },
              { label: 'abs path', value: imageInfo.absPath }
            ]
          }
        ]
      }
    };
  }

  const streamTitle = item.mediaType === 'video' ? 'Video' : 'Audio';
  return {
    ...item,
    mediaInfo: {
      mediaType: item.mediaType,
      source,
      sections: [
        {
          title: 'General',
          rows: [
            { label: 'Complete name', value: normalizePath(item.absPath) },
            { label: 'Format', value: item.format.toUpperCase() || 'Unknown' },
            { label: 'File size', value: fileSize },
            { label: 'Duration', value: 'Unknown' }
          ]
        },
        {
          title: streamTitle,
          rows: [
            { label: 'Format', value: item.format.toUpperCase() || 'Unknown' },
            { label: 'Duration', value: 'Unknown' },
            { label: 'Stream size', value: fileSize }
          ]
        }
      ]
    }
  };
}

function readableFileSize(absPath: string): string {
  try {
    const size = require('fs').statSync(absPath).size;
    if (size < 1024) return `${size} B`;
    const units = ['KiB', 'MiB', 'GiB', 'TiB'];
    let value = size / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit += 1;
    }
    return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[unit]}`;
  } catch {
    return 'Unknown';
  }
}

function compactItems(items: Array<GalleryAssetItem | undefined>): GalleryAssetItem[] {
  return items.filter((item): item is GalleryAssetItem => !!item);
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/');
}

if (!isMainThread) {
  const data = workerData as ScanWorkerData;
  const roots = Array.isArray(data.roots) ? data.roots : [];
  void runScanWorker({
    roots,
    metadataCacheKeys: data.metadataCacheKeys,
    postMessage: (message) => parentPort?.postMessage(message)
  }).catch((error) => {
    parentPort?.postMessage({
      type: 'error',
      error: error instanceof Error ? error.message : String(error)
    } satisfies ScanWorkerMessage);
  });
}
