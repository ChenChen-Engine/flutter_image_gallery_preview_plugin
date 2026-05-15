import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Worker } from 'worker_threads';
import { extractMediaInfo, seedMediaInfoCache } from './mediaMetadata';
import { ScanWorkerMessage, ScanWorkerProgress } from './scanWorker';
import { GalleryAssetItem, MediaMetadataInfo, PlatformType } from './shared/types';
import { toWebviewAssetItem, WebviewAssetItem } from './webPayload';

const SCAN_TIMEOUT_MS = 120_000;
const SCAN_STALE_MS = 12_000;

export interface LoadingStateMessage {
  count?: number;
  currentPath?: string | null;
  diagnostic?: string;
  elapsedMillis?: number;
  heartbeat?: boolean;
  lastHeartbeatMillis?: number;
  loading: boolean;
  message: string;
  partialCount?: number;
  phase?: string;
  total?: number;
  type: 'loadingState';
  workerStatus?: string;
}

function scanWorkspaceInWorker(
  roots: string[],
  metadataCacheKeys: string[],
  onProgress: (progress: ScanWorkerProgress) => void,
  onPartial: (items: GalleryAssetItem[], done: boolean) => void
): Promise<GalleryAssetItem[]> {
  if (!roots.length) return Promise.resolve([]);

  const workerPath = path.join(__dirname, 'scanWorker.js');
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    let staleTimer: NodeJS.Timeout | undefined;

    const worker = new Worker(workerPath, { workerData: { roots, metadataCacheKeys } });

    const resetStaleTimer = () => {
      if (staleTimer) clearTimeout(staleTimer);
      staleTimer = setTimeout(() => {
        onProgress({
          phase: 'enrich',
          count: 0,
          total: 0,
          currentPath: null,
          elapsedMillis: 0,
          heartbeat: true,
          lastHeartbeatMillis: SCAN_STALE_MS,
          message: 'Indexing is taking longer than expected; worker heartbeat is still active.',
          workerStatus: 'stale',
          diagnostic: 'No worker message received within stale threshold.'
        });
      }, SCAN_STALE_MS);
    };

    const finish = (complete: () => void) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (staleTimer) clearTimeout(staleTimer);
      complete();
    };

    timeout = setTimeout(() => {
      finish(() => reject(new Error(`Indexing timed out after ${SCAN_TIMEOUT_MS / 1000}s`)));
      void worker.terminate();
    }, SCAN_TIMEOUT_MS);
    resetStaleTimer();

    worker.on('message', (message: ScanWorkerMessage) => {
      resetStaleTimer();
      if (message.type === 'progress' && message.progress) {
        onProgress(message.progress);
        return;
      }
      if (message.type === 'assets') {
        onPartial(Array.isArray(message.items) ? message.items : [], false);
        return;
      }
      if (message.type === 'done') {
        const items = Array.isArray(message.items) ? message.items : [];
        onPartial(items, true);
        finish(() => resolve(items));
        void worker.terminate();
        return;
      }
      if (message.type === 'error' || message.error) {
        finish(() => reject(new Error(message.error || 'Index worker failed')));
        void worker.terminate();
      }
    });

    worker.on('error', (error) => {
      finish(() => reject(error));
    });

    worker.on('exit', (code) => {
      if (code !== 0) {
        finish(() => reject(new Error(`Index worker exited with code ${code}`)));
      }
    });
  });
}

class ImageGalleryViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'imageGalleryPreview.view';

  private afterRefreshQueue: Array<(items: GalleryAssetItem[]) => Promise<void> | void> = [];
  private cachedItems: GalleryAssetItem[] = [];
  private duplicateIndex: Map<PlatformType, Map<string, GalleryAssetItem[]>> = new Map();
  private infoCache = new Map<string, MediaMetadataInfo>();
  private readonly output = vscode.window.createOutputChannel('Image Gallery Preview');
  private refreshPending = false;
  private refreshPendingForce = false;
  private refreshTask: Promise<void> | null = null;
  private started = false;
  private view?: vscode.WebviewView;
  private watchers: vscode.FileSystemWatcher[] = [];

  constructor(private readonly context: vscode.ExtensionContext) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    this.setupWatchers();
    void this.sync();
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.file(path.join(this.context.extensionPath, 'webview')),
        ...(vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri)
      ]
    };

    webviewView.webview.html = this.htmlForWebview(webviewView.webview);
    webviewView.webview.onDidReceiveMessage((message) => void this.handleWebMessage(message));
    this.start();
  }

  async sync(afterRefresh?: (items: GalleryAssetItem[]) => Promise<void> | void): Promise<void> {
    await this.startRefresh(false, afterRefresh);
  }

  async refresh(forceReindex = true, afterRefresh?: (items: GalleryAssetItem[]) => Promise<void> | void): Promise<void> {
    await this.startRefresh(forceReindex, afterRefresh);
  }

  private async startRefresh(forceReindex: boolean, afterRefresh?: (items: GalleryAssetItem[]) => Promise<void> | void): Promise<void> {
    if (afterRefresh) this.afterRefreshQueue.push(afterRefresh);

    if (this.refreshTask) {
      this.refreshPending = true;
      if (forceReindex) this.refreshPendingForce = true;
      await this.refreshTask;
      return;
    }

    this.refreshTask = this.performRefresh(forceReindex);
    try {
      await this.refreshTask;
    } finally {
      this.refreshTask = null;
      if (this.refreshPending) {
        const pendingForce = this.refreshPendingForce;
        this.refreshPending = false;
        this.refreshPendingForce = false;
        await this.startRefresh(pendingForce, undefined);
      }
    }
  }

  dispose(): void {
    this.watchers.forEach((watcher) => watcher.dispose());
    this.watchers = [];
    this.output.dispose();
  }

  private async handleWebMessage(message: any): Promise<void> {
    if (message?.type === 'ready') {
      await this.postAssets();
      if (this.refreshTask) {
        await this.postLoadingState(true, 'Indexing assets...');
        return;
      }
      if (!this.cachedItems.length) {
        await this.sync();
      } else {
        await this.postLoadingState(false, '');
      }
      return;
    }

    if (message?.type === 'sync') {
      await this.sync();
      return;
    }

    if (message?.type === 'refresh') {
      await this.refresh(message.force !== false);
      return;
    }

    if (message?.type === 'reveal' && typeof message.absPath === 'string') {
      await revealResourceByPath(message.absPath);
      return;
    }

    if (message?.type === 'showInSystem' && typeof message.absPath === 'string') {
      await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(message.absPath));
      return;
    }

    if (message?.type === 'copy' && typeof message.value === 'string') {
      const label = typeof message.label === 'string' ? message.label : 'content';
      await vscode.env.clipboard.writeText(message.value);
      vscode.window.setStatusBarMessage(`Copied ${label}: ${message.value}`, 1500);
      return;
    }

    if ((message?.type === 'requestImageInfo' || message?.type === 'requestMediaInfo') && typeof message.absPath === 'string') {
      const info = await this.loadMediaInfo(message.absPath);
      await this.view?.webview.postMessage({
        type: 'imageInfo',
        absPath: normalizePath(message.absPath),
        info
      });
      return;
    }

    if (message?.type === 'openWithDefaultApp' && typeof message.absPath === 'string') {
      await openWithDefaultApp(message.absPath);
      return;
    }

    if (message?.type === 'openExternal' && typeof message.url === 'string') {
      await vscode.env.openExternal(vscode.Uri.parse(message.url));
    }
  }

  private async performRefresh(forceReindex: boolean): Promise<void> {
    const started = Date.now();
    const operation = forceReindex ? 'refresh' : 'sync';
    this.output.appendLine(`[${operation}] starting workspace index`);
    if (forceReindex) this.infoCache.clear();
    await this.postLoadingState(true, forceReindex ? 'Reindexing assets...' : 'Syncing assets...');

    try {
      if (!vscode.workspace.workspaceFolders?.length) {
        this.cachedItems = [];
        this.duplicateIndex.clear();
        this.infoCache.clear();
        await this.postAssets();
        await this.postLoadingState(false, '');
        this.afterRefreshQueue = [];
        return;
      }

      const roots = vscode.workspace.workspaceFolders.map((folder) => folder.uri.fsPath);
      const metadataCache = metadataByKey(this.cachedItems);
      const normalizeItems = (rawItems: GalleryAssetItem[]) => rawItems.map((item) => {
        const normalized = {
          ...item,
          absPath: normalizePath(item.absPath),
          relPath: normalizePath(item.relPath),
          resourceRootPath: normalizePath(item.resourceRootPath)
        };
        const cached = metadataCache.get(metadataCacheKey(normalized));
        if (!cached || normalized.mediaInfo) return normalized;
        return {
          ...normalized,
          durationMillis: cached.durationMillis ?? normalized.durationMillis,
          imageInfo: cached.imageInfo ?? normalized.imageInfo,
          mediaInfo: cached.mediaInfo ?? normalized.mediaInfo
        };
      });

      const publishPartial = async (rawItems: GalleryAssetItem[], done: boolean) => {
        const partialItems = normalizeItems(rawItems);
        this.cachedItems = partialItems;
        this.duplicateIndex = this.buildDuplicateIndex(partialItems);
        this.infoCache = primeInfoCacheFromItems(partialItems);
        await this.postAssets();
        if (!done) {
          this.output.appendLine(`[${operation}] partial publish ${partialItems.length} assets`);
        }
      };

      const scannedItems = await scanWorkspaceInWorker(
        roots,
        forceReindex ? [] : [...metadataCache.keys()],
        (progress) => {
          this.output.appendLine(formatWorkerDiagnostic(progress));
          void this.postLoadingState(progress);
        },
        (partialItems, done) => {
          void publishPartial(partialItems, done);
        }
      );

      const items = normalizeItems(scannedItems);
      this.cachedItems = items;
      this.duplicateIndex = this.buildDuplicateIndex(items);
      this.infoCache = primeInfoCacheFromItems(items);

      await this.postAssets();
      const elapsed = Date.now() - started;
      console.info(`[Image Gallery Preview] Indexed ${items.length} assets in ${elapsed}ms`);
      this.output.appendLine(`[${operation}] indexed ${items.length} assets in ${elapsed}ms`);
      await this.postLoadingState(false, `Updated ${new Date().toLocaleTimeString()}`);

      const callbacks = this.afterRefreshQueue.splice(0, this.afterRefreshQueue.length);
      for (const callback of callbacks) {
        await callback(items);
      }
    } catch (error) {
      this.afterRefreshQueue = [];
      console.error('[Image Gallery Preview] Failed to index assets', error);
      this.output.appendLine(`[${operation}] failed: ${error instanceof Error ? error.message : String(error)}`);
      await this.postLoadingState(false, `Failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async postAssets(): Promise<void> {
    if (!this.view) return;

    const serialized: WebviewAssetItem[] = this.cachedItems.map((item) => {
      const normalizedAbsPath = normalizePath(item.absPath);
      const previewUri = previewUriForItem(this.view!.webview, item);
      const lottieJson = item.formatFamily === 'lottie' ? readSmallTextFile(normalizedAbsPath) : null;
      return {
        ...toWebviewAssetItem(item, previewUri, lottieJson),
        mediaInfo: item.mediaInfo ?? this.infoCache.get(normalizedAbsPath)
      };
    });

    await this.view.webview.postMessage({ type: 'assets', items: serialized });
  }

  private async postLoadingState(progress: ScanWorkerProgress): Promise<void>;
  private async postLoadingState(loading: boolean, message: string): Promise<void>;
  private async postLoadingState(progressOrLoading: ScanWorkerProgress | boolean, message = ''): Promise<void> {
    const payload = typeof progressOrLoading === 'boolean'
      ? ({ type: 'loadingState', loading: progressOrLoading, message } satisfies LoadingStateMessage)
      : toLoadingStateMessage(progressOrLoading);
    await this.view?.webview.postMessage(payload);
  }

  private buildDuplicateIndex(items: GalleryAssetItem[]): Map<PlatformType, Map<string, GalleryAssetItem[]>> {
    const index = new Map<PlatformType, Map<string, GalleryAssetItem[]>>();

    for (const item of items) {
      if (item.mediaType !== 'image' || !item.md5) continue;
      const platformMap = index.get(item.platform) ?? new Map<string, GalleryAssetItem[]>();
      const list = platformMap.get(item.md5) ?? [];
      list.push(item);
      platformMap.set(item.md5, list);
      index.set(item.platform, platformMap);
    }

    return index;
  }

  private async handleCreatedFile(fsPath: string, items: GalleryAssetItem[]): Promise<void> {
    const absPath = normalizePath(fsPath);
    const createdItem = items.find((item) => normalizePath(item.absPath) === absPath);
    if (!createdItem || createdItem.mediaType !== 'image' || !createdItem.resourceRootPath || !createdItem.md5) return;

    const platformMap = this.duplicateIndex.get(createdItem.platform);
    if (!platformMap) return;

    const duplicates = (platformMap.get(createdItem.md5) ?? []).filter((item) => normalizePath(item.absPath) !== absPath);
    if (duplicates.length === 0) return;

    let selected = duplicates[0];
    if (duplicates.length > 1) {
      const picked = await vscode.window.showQuickPick(
        duplicates.map((item) => ({
          label: path.basename(item.absPath),
          description: item.absPath,
          item
        })),
        {
          title: 'Choose the existing duplicate to reveal',
          canPickMany: false,
          ignoreFocusOut: true
        }
      );

      if (!picked?.item) return;
      selected = picked.item;
    }

    const choice = await vscode.window.showWarningMessage(
      [
        `Detected duplicate image on platform ${createdItem.platform}.`,
        `New: ${absPath}`,
        `Existing: ${selected.absPath}`
      ].join('\n'),
      { modal: true },
      'Keep new file',
      'Delete new file and reveal existing'
    );

    if (choice !== 'Delete new file and reveal existing') return;

    try {
      await vscode.workspace.fs.delete(vscode.Uri.file(absPath), { recursive: false, useTrash: false });
      await revealResourceByPath(selected.absPath);
      await this.sync();
    } catch {
      await vscode.window.showErrorMessage(`Failed to delete duplicate file: ${absPath}`);
    }
  }

  private setupWatchers(): void {
    this.watchers.forEach((watcher) => watcher.dispose());
    this.watchers = [];

    if (!vscode.workspace.workspaceFolders?.length) return;

    const patterns = [
      '**/src/*/res/drawable*/**/*',
      '**/src/*/res/mipmap*/**/*',
      '**/src/*/res/raw*/**/*',
      '**/pubspec.yaml',
      '**/assets/**/*',
      '**/res/**/*',
      '**/ios/**/*'
    ];

    for (const pattern of patterns) {
      const watcher = vscode.workspace.createFileSystemWatcher(pattern);

      watcher.onDidCreate((uri) => {
        if (!isInterestingFsPath(uri.fsPath)) return;
        void this.sync(async (items) => {
          await this.handleCreatedFile(uri.fsPath, items);
        });
      });

      const onChange = (uri: vscode.Uri) => {
        if (isInterestingFsPath(uri.fsPath)) void this.sync();
      };
      watcher.onDidChange(onChange);
      watcher.onDidDelete(onChange);
      this.watchers.push(watcher);
    }
  }

  private async loadMediaInfo(absPath: string): Promise<MediaMetadataInfo> {
    const normalized = normalizePath(absPath);
    const cached = this.infoCache.get(normalized);
    if (cached && !isTimeoutFallbackInfo(cached)) return cached;

    const item = this.cachedItems.find((entry) => normalizePath(entry.absPath) === normalized);
    if (item?.mediaInfo && !isTimeoutFallbackInfo(item.mediaInfo)) {
      this.infoCache.set(normalized, item.mediaInfo);
      return item.mediaInfo;
    }

    const info = await extractMediaInfo(normalized, item);
    this.infoCache.set(normalized, info);
    return info;
  }

  private htmlForWebview(webview: vscode.Webview): string {
    const webviewDir = path.join(this.context.extensionPath, 'webview');
    const htmlPath = path.join(webviewDir, 'index.html');
    let html = fs.readFileSync(htmlPath, 'utf8');

    for (const assetName of ['gallery.css', 'gallery.js', 'lottie-light.min.js']) {
      const uri = webview.asWebviewUri(vscode.Uri.file(path.join(webviewDir, assetName))).toString();
      html = html.replace(`./${assetName}`, uri);
    }

    return html;
  }
}

export function previewUriForItem(webview: vscode.Webview, item: GalleryAssetItem): string | null {
  const renderable = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg', 'apng', 'avif', 'ico', 'lottie'].includes(item.formatFamily);
  if (!renderable) return null;
  return webview.asWebviewUri(vscode.Uri.file(item.absPath)).toString();
}

function readSmallTextFile(absPath: string): string | null {
  try {
    const stat = fs.statSync(absPath);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) return null;
    return fs.readFileSync(absPath, 'utf8');
  } catch {
    return null;
  }
}

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

export function primeInfoCacheFromItems(items: GalleryAssetItem[]): Map<string, MediaMetadataInfo> {
  return seedMediaInfoCache(items);
}

interface CachedMetadata {
  durationMillis?: number | null;
  imageInfo?: GalleryAssetItem['imageInfo'];
  mediaInfo?: GalleryAssetItem['mediaInfo'];
}

function metadataByKey(items: GalleryAssetItem[]): Map<string, CachedMetadata> {
  const cache = new Map<string, CachedMetadata>();
  for (const item of items) {
    if (!item.mediaInfo && !item.imageInfo) continue;
    if (isTimeoutFallbackInfo(item.mediaInfo)) continue;
    cache.set(metadataCacheKey(item), {
      durationMillis: item.durationMillis,
      imageInfo: item.imageInfo,
      mediaInfo: item.mediaInfo
    });
  }
  return cache;
}

function metadataCacheKey(item: GalleryAssetItem): string {
  return `${normalizePath(item.absPath)}|${item.mtime}|${item.mediaType}`;
}

function isTimeoutFallbackInfo(info: MediaMetadataInfo | null | undefined): boolean {
  return typeof info?.source === 'string' && info.source.toLowerCase().startsWith('timed out fallback');
}

export function toLoadingStateMessage(progress: ScanWorkerProgress): LoadingStateMessage {
  const currentName = progress.currentPath ? progress.currentPath.split('/').pop() || progress.currentPath : 'workspace';
  return {
    type: 'loadingState',
    loading: progress.phase !== 'done',
    message: progress.message || `${progress.phase} ${progress.count}/${progress.total}: ${currentName}`,
    phase: progress.phase,
    count: progress.count,
    total: progress.total,
    currentPath: progress.currentPath,
    diagnostic: progress.diagnostic,
    elapsedMillis: progress.elapsedMillis,
    heartbeat: progress.heartbeat,
    lastHeartbeatMillis: progress.lastHeartbeatMillis,
    partialCount: progress.partialCount,
    workerStatus: progress.workerStatus
  };
}

export function formatWorkerDiagnostic(progress: ScanWorkerProgress): string {
  const suffix = progress.currentPath ? ` ${progress.currentPath}` : '';
  const marker = progress.heartbeat ? 'heartbeat' : 'progress';
  const elapsed = typeof progress.elapsedMillis === 'number' ? ` elapsed=${progress.elapsedMillis}ms` : '';
  const partial = typeof progress.partialCount === 'number' ? ` partial=${progress.partialCount}` : '';
  const status = progress.workerStatus ? ` status=${progress.workerStatus}` : '';
  const diagnostic = progress.diagnostic ? ` diagnostic=${progress.diagnostic}` : '';
  return `[worker:${marker}] ${progress.phase} ${progress.count}/${progress.total}${partial}${elapsed}${status}${diagnostic}${suffix}`;
}

function isInterestingFsPath(fsPath: string): boolean {
  const normalized = normalizePath(fsPath).toLowerCase();
  if (hasIgnoredSegment(normalized)) return false;
  if (normalized.endsWith('/pubspec.yaml')) return true;
  const mediaLike = /\.(png|jpe?g|webp|gif|bmp|svg|pdf|heic|heif|apng|avif|ico|json|xml|mp3|m4a|aac|wav|ogg|opus|flac|amr|mid|midi|caf|wma|aiff?|alac|mka|mp4|m4v|mov|webm|mkv|avi|3gp|3gpp|mpe?g|ts|m2ts|wmv|flv)$/i.test(normalized);
  if (!mediaLike) return false;
  return normalized.includes('/assets/') ||
    normalized.includes('/res/') ||
    normalized.includes('/ios/') ||
    (normalized.includes('/src/') && normalized.includes('/res/'));
}

function hasIgnoredSegment(normalizedPath: string): boolean {
  return normalizedPath.split('/').some((segment) =>
    ['build', 'out', 'output', 'dist', 'node_modules', '.dart_tool', 'pods', 'deriveddata'].includes(segment)
  );
}

async function openResourceByPath(absPath: string): Promise<void> {
  await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(absPath), { preview: false });
}

async function revealResourceByPath(absPath: string): Promise<void> {
  await openResourceByPath(absPath);
  await vscode.commands.executeCommand('workbench.files.action.showActiveFileInExplorer');
}

async function openWithDefaultApp(absPath: string): Promise<void> {
  await vscode.env.openExternal(vscode.Uri.file(absPath));
}

export function activate(context: vscode.ExtensionContext): void {
  const provider = new ImageGalleryViewProvider(context);
  provider.start();

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ImageGalleryViewProvider.viewId, provider),
    vscode.commands.registerCommand('imageGalleryPreview.refresh', () => provider.refresh()),
    vscode.commands.registerCommand('imageGalleryPreview.openResource', (absPath: string) => openResourceByPath(absPath)),
    { dispose: () => provider.dispose() }
  );
}

export function deactivate(): void {}
