import { parentPort, workerData } from 'worker_threads';
import { scanAssets } from './scanner';
import { GalleryAssetItem } from './shared/types';

interface ScanWorkerData {
  roots?: string[];
}

try {
  const data = workerData as ScanWorkerData;
  const roots = Array.isArray(data.roots) ? data.roots : [];
  const items: GalleryAssetItem[] = roots.flatMap((root) => scanAssets(root));
  parentPort?.postMessage({ items });
} catch (error) {
  parentPort?.postMessage({
    error: error instanceof Error ? error.message : String(error)
  });
}
