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
  metadataCache?: Array<[string, CachedMetadata]>;
  roots?: string[];
}

interface RunScanWorkerArgs {
  enrichItem?: (item: GalleryAssetItem) => Promise<GalleryAssetItem>;
  heartbeatMs?: number;
  metadataCache?: Map<string, CachedMetadata> | Array<[string, CachedMetadata]>;
  metadataParallelism?: number;
  postMessage: (message: ScanWorkerMessage) => void;
  roots: string[];
  scanAssets?: (root: string) => GalleryAssetItem[];
}

const DEFAULT_HEARTBEAT_MS = 1000;
const DEFAULT_METADATA_PARALLELISM = Math.min(6, Math.max(2, os.cpus()?.length ?? 2));

interface CachedMetadata {
  durationMillis?: number | null;
  imageInfo?: GalleryAssetItem['imageInfo'];
  mediaInfo?: GalleryAssetItem['mediaInfo'];
}

export async function runScanWorker({
  roots,
  postMessage,
  scanAssets: scanAssetsForRoot = scanAssets,
  enrichItem = enrichIndexedItem,
  heartbeatMs = DEFAULT_HEARTBEAT_MS,
  metadataCache,
  metadataParallelism = DEFAULT_METADATA_PARALLELISM
}: RunScanWorkerArgs): Promise<GalleryAssetItem[]> {
  const normalizedRoots = roots.map(normalizePath);
  const discoveredItems: GalleryAssetItem[] = [];
  const enrichedItems: Array<GalleryAssetItem | undefined> = [];
  const startedAt = Date.now();
  let lastProgressAt = startedAt;
  const cachedMetadata = normalizeMetadataCache(metadataCache);
  let latestProgress = createProgress('discover', 0, normalizedRoots.length, null, false, startedAt, lastProgressAt, 0, 'starting');

  const emitProgress = (
    phase: ScanWorkerProgress['phase'],
    count: number,
    total: number,
    currentPath: string | null,
    heartbeat: boolean,
    partialCount = enrichedItems.filter(Boolean).length,
    workerStatus = heartbeat ? 'heartbeat' : 'active',
    diagnostic?: string
  ) => {
    const now = Date.now();
    if (!heartbeat) lastProgressAt = now;
    latestProgress = createProgress(phase, count, total, currentPath, heartbeat, startedAt, lastProgressAt, partialCount, workerStatus, diagnostic);
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
          'worker heartbeat active'
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

    const runNext = async (): Promise<void> => {
      while (nextIndex < totalItems) {
        const index = nextIndex++;
        const item = discoveredItems[index];
        const currentPath = normalizePath(item.absPath);
        emitProgress('enrich', completed, totalItems, currentPath, false, completed, `active ${Math.min(parallelism, totalItems - completed)}/${parallelism}`);
        const cached = cachedMetadata.get(metadataCacheKey(item));
        enrichedItems[index] = cached ? applyCachedMetadata(item, cached) : await enrichItem(item);
        completed += 1;
        emitProgress('enrich', completed, totalItems, currentPath, false, completed, `active ${Math.max(0, Math.min(parallelism, totalItems - completed))}/${parallelism}`);
        postMessage({
          type: 'assets',
          items: compactItems(enrichedItems),
          total: completed
        });
      }
    };

    await Promise.all(Array.from({ length: parallelism }, () => runNext()));

    const finalItems = compactItems(enrichedItems);
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
  diagnostic?: string
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
    total,
    currentPath: target,
    heartbeat,
    lastHeartbeatMillis: Date.now() - lastProgressAt,
    partialCount,
    workerStatus,
    message: heartbeat ? `${activity} heartbeat: ${currentName}` : `${activity}: ${currentName}`
  };
}

function normalizeMetadataCache(value: RunScanWorkerArgs['metadataCache']): Map<string, CachedMetadata> {
  if (!value) return new Map();
  return value instanceof Map ? value : new Map(value);
}

function metadataCacheKey(item: GalleryAssetItem): string {
  return `${normalizePath(item.absPath)}|${item.mtime}|${item.mediaType}`;
}

function applyCachedMetadata(item: GalleryAssetItem, cached: CachedMetadata): GalleryAssetItem {
  return {
    ...item,
    durationMillis: cached.durationMillis ?? item.durationMillis,
    imageInfo: cached.imageInfo ?? item.imageInfo,
    mediaInfo: cached.mediaInfo ?? item.mediaInfo
  };
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
    metadataCache: data.metadataCache,
    postMessage: (message) => parentPort?.postMessage(message)
  }).catch((error) => {
    parentPort?.postMessage({
      type: 'error',
      error: error instanceof Error ? error.message : String(error)
    } satisfies ScanWorkerMessage);
  });
}
