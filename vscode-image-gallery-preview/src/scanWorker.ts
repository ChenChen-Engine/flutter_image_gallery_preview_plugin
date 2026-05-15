import { parentPort, workerData } from 'worker_threads';
import { scanAssets } from './scanner';
import { GalleryAssetItem } from './shared/types';

interface ScanWorkerData {
  roots?: string[];
}

try {
  const data = workerData as ScanWorkerData;
  const roots = Array.isArray(data.roots) ? data.roots : [];
  const items: GalleryAssetItem[] = [];
  roots.forEach((root, index) => {
    parentPort?.postMessage({
      type: 'progress',
      message: `Indexing assets... (${index + 1}/${roots.length})`
    });
    items.push(...scanAssets(root));
    parentPort?.postMessage({
      type: 'assets',
      items,
      total: items.length
    });
  });
  parentPort?.postMessage({ type: 'done', items, total: items.length });
} catch (error) {
  parentPort?.postMessage({
    type: 'error',
    error: error instanceof Error ? error.message : String(error)
  });
}
