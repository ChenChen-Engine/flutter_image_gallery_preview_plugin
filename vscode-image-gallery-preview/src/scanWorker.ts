import { isMainThread, parentPort, workerData } from 'worker_threads';
import { enrichIndexedItem } from './mediaMetadata';
import { scanAssets } from './scanner';
import { GalleryAssetItem } from './shared/types';

export interface ScanWorkerProgress {
  count: number;
  currentPath: string | null;
  heartbeat: boolean;
  message: string;
  phase: 'discover' | 'enrich' | 'done';
  total: number;
}

export interface ScanWorkerMessage {
  error?: string;
  items?: GalleryAssetItem[];
  progress?: ScanWorkerProgress;
  total?: number;
  type: 'progress' | 'assets' | 'done' | 'error';
}

interface ScanWorkerData {
  roots?: string[];
}

interface RunScanWorkerArgs {
  enrichItem?: (item: GalleryAssetItem) => Promise<GalleryAssetItem>;
  heartbeatMs?: number;
  postMessage: (message: ScanWorkerMessage) => void;
  roots: string[];
  scanAssets?: (root: string) => GalleryAssetItem[];
}

const DEFAULT_HEARTBEAT_MS = 1000;

export async function runScanWorker({
  roots,
  postMessage,
  scanAssets: scanAssetsForRoot = scanAssets,
  enrichItem = enrichIndexedItem,
  heartbeatMs = DEFAULT_HEARTBEAT_MS
}: RunScanWorkerArgs): Promise<GalleryAssetItem[]> {
  const normalizedRoots = roots.map(normalizePath);
  const discoveredItems: GalleryAssetItem[] = [];
  const enrichedItems: GalleryAssetItem[] = [];
  let latestProgress = createProgress('discover', 0, normalizedRoots.length, null, false);

  const emitProgress = (
    phase: ScanWorkerProgress['phase'],
    count: number,
    total: number,
    currentPath: string | null,
    heartbeat: boolean
  ) => {
    latestProgress = createProgress(phase, count, total, currentPath, heartbeat);
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
          true
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
    for (const [index, item] of discoveredItems.entries()) {
      emitProgress('enrich', index + 1, totalItems, normalizePath(item.absPath), false);
      enrichedItems.push(await enrichItem(item));
      postMessage({
        type: 'assets',
        items: enrichedItems.slice(),
        total: enrichedItems.length
      });
    }

    emitProgress('done', enrichedItems.length, enrichedItems.length, null, false);
    postMessage({ type: 'done', items: enrichedItems, total: enrichedItems.length });
    return enrichedItems;
  } finally {
    if (heartbeat) clearInterval(heartbeat);
  }
}

function createProgress(
  phase: ScanWorkerProgress['phase'],
  count: number,
  total: number,
  currentPath: string | null,
  heartbeat: boolean
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
    total,
    currentPath: target,
    heartbeat,
    message: heartbeat ? `${activity} heartbeat: ${currentName}` : `${activity}: ${currentName}`
  };
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/');
}

if (!isMainThread) {
  const data = workerData as ScanWorkerData;
  const roots = Array.isArray(data.roots) ? data.roots : [];
  void runScanWorker({
    roots,
    postMessage: (message) => parentPort?.postMessage(message)
  }).catch((error) => {
    parentPort?.postMessage({
      type: 'error',
      error: error instanceof Error ? error.message : String(error)
    } satisfies ScanWorkerMessage);
  });
}
