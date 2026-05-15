import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { Worker } from 'worker_threads';
import exifReader from 'exif-reader';
import sharp from 'sharp';
import {
  GalleryAssetItem,
  ImageInfo,
  MediaMetadataInfo,
  MediaType,
  MetadataRow,
  MetadataSection,
  PlatformType
} from './shared/types';
import { findMediaInfoExecutable } from './mediaInfoTool';
import { toWebviewAssetItem, WebviewAssetItem } from './webPayload';

const execFileAsync = promisify(execFile);
const MEDIAINFO_DOWNLOAD_URL = 'https://mediaarea.net/en/MediaInfo/Download/Windows';
const SCAN_TIMEOUT_MS = 120_000;
const SCAN_STALE_MS = 12_000;

interface ScanWorkerMessage {
  type?: 'progress' | 'assets' | 'done' | 'error';
  items?: GalleryAssetItem[];
  total?: number;
  message?: string;
  error?: string;
}

function scanWorkspaceInWorker(
  roots: string[],
  onProgress: (message: string) => void,
  onPartial: (items: GalleryAssetItem[], done: boolean) => void
): Promise<GalleryAssetItem[]> {
  if (!roots.length) return Promise.resolve([]);

  const workerPath = path.join(__dirname, 'scanWorker.js');
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    let staleTimer: NodeJS.Timeout | undefined;
    const resetStaleTimer = () => {
      if (staleTimer) clearTimeout(staleTimer);
      staleTimer = setTimeout(() => {
        onProgress('Indexing is taking longer than expected; scanned results will appear incrementally.');
      }, SCAN_STALE_MS);
    };
    const worker = new Worker(workerPath, {
      workerData: { roots }
    });
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
      if (message?.type === 'progress') {
        onProgress(message.message || 'Indexing assets...');
        return;
      }
      if (message?.type === 'assets') {
        onPartial(Array.isArray(message.items) ? message.items : [], false);
        return;
      }
      if (message?.type === 'done') {
        const items = Array.isArray(message.items) ? message.items : [];
        onPartial(items, true);
        finish(() => resolve(items));
        void worker.terminate();
        return;
      }
      if (message?.type === 'error' || message?.error) {
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

  private view?: vscode.WebviewView;
  private watchers: vscode.FileSystemWatcher[] = [];
  private cachedItems: GalleryAssetItem[] = [];
  private duplicateIndex: Map<PlatformType, Map<string, GalleryAssetItem[]>> = new Map();
  private infoCache = new Map<string, MediaMetadataInfo>();
  private refreshTask: Promise<void> | null = null;
  private refreshPending = false;
  private afterRefreshQueue: Array<(items: GalleryAssetItem[]) => Promise<void> | void> = [];
  private started = false;

  constructor(private readonly context: vscode.ExtensionContext) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    this.setupWatchers();
    void this.refresh();
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

  async refresh(afterRefresh?: (items: GalleryAssetItem[]) => Promise<void> | void): Promise<void> {
    if (afterRefresh) {
      this.afterRefreshQueue.push(afterRefresh);
    }

    if (this.refreshTask) {
      this.refreshPending = true;
      await this.refreshTask;
      return;
    }

    this.refreshTask = this.performRefresh();
    try {
      await this.refreshTask;
    } finally {
      this.refreshTask = null;
      if (this.refreshPending) {
        this.refreshPending = false;
        await this.refresh();
      }
    }
  }

  dispose(): void {
    this.watchers.forEach((watcher) => watcher.dispose());
    this.watchers = [];
  }

  private async handleWebMessage(message: any): Promise<void> {
    if (message?.type === 'ready') {
      await this.postAssets();
      if (this.refreshTask) {
        await this.postLoadingState(true, 'Indexing assets...');
        return;
      }
      if (!this.cachedItems.length) {
        await this.refresh();
      } else {
        await this.postLoadingState(false, '');
      }
      return;
    }

    if (message?.type === 'refresh') {
      await this.refresh();
      return;
    }

    if (message?.type === 'open' && typeof message.absPath === 'string') {
      await openResourceByPath(message.absPath);
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
      const label = typeof message.label === 'string' ? message.label : '内容';
      await vscode.env.clipboard.writeText(message.value);
      vscode.window.setStatusBarMessage(`已复制${label}: ${message.value}`, 1500);
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

    if (message?.type === 'openWithChooser' && typeof message.absPath === 'string') {
      await openWithChooser(message.absPath);
      return;
    }

    if (message?.type === 'openExternal' && typeof message.url === 'string') {
      await vscode.env.openExternal(vscode.Uri.parse(message.url));
    }
  }

  private async performRefresh(): Promise<void> {
    const started = Date.now();
    await this.postLoadingState(true, 'Indexing assets...');

    try {
      if (!vscode.workspace.workspaceFolders?.length) {
        this.cachedItems = [];
        this.duplicateIndex.clear();
        await this.postAssets();
        await this.postLoadingState(false, '');
        this.afterRefreshQueue = [];
        return;
      }

      const roots = vscode.workspace.workspaceFolders.map((folder) => folder.uri.fsPath);
      const normalizeItems = (rawItems: GalleryAssetItem[]) => rawItems.map((item) => ({
        ...item,
        absPath: normalizePath(item.absPath),
        relPath: normalizePath(item.relPath),
        resourceRootPath: normalizePath(item.resourceRootPath)
      }));
      const publishPartial = async (rawItems: GalleryAssetItem[], done: boolean) => {
        const partialItems = normalizeItems(rawItems);
        this.cachedItems = partialItems;
        this.duplicateIndex = this.buildDuplicateIndex(partialItems);
        await this.postAssets();
        if (!done) {
          await this.postLoadingState(false, `Indexed ${partialItems.length} assets so far...`);
        }
      };
      const scannedItems = await scanWorkspaceInWorker(
        roots,
        (message) => {
          const stale = message.includes('taking longer');
          void this.postLoadingState(!stale, message);
        },
        (partialItems, done) => {
          void publishPartial(partialItems, done);
        }
      );
      const items = normalizeItems(scannedItems);

      this.cachedItems = items;
      this.duplicateIndex = this.buildDuplicateIndex(items);

      await this.postAssets();
      console.info(`[Image Gallery Preview] Indexed ${items.length} assets in ${Date.now() - started}ms`);
      await this.postLoadingState(false, `Updated ${new Date().toLocaleTimeString()}`);

      const callbacks = this.afterRefreshQueue.splice(0, this.afterRefreshQueue.length);
      for (const callback of callbacks) {
        await callback(items);
      }
    } catch (error) {
      this.afterRefreshQueue = [];
      console.error('[Image Gallery Preview] Failed to index assets', error);
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
        mediaInfo: this.infoCache.get(normalizedAbsPath)
      };
    });

    await this.view.webview.postMessage({ type: 'assets', items: serialized });
  }

  private async postLoadingState(loading: boolean, message: string): Promise<void> {
    await this.view?.webview.postMessage({ type: 'loadingState', loading, message });
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
    if (!createdItem) return;
    if (createdItem.mediaType !== 'image' || !createdItem.resourceRootPath || !createdItem.md5) return;

    const platformMap = this.duplicateIndex.get(createdItem.platform);
    if (!platformMap) return;

    const sameMd5 = platformMap.get(createdItem.md5) ?? [];
    const duplicates = sameMd5.filter((item) => normalizePath(item.absPath) !== absPath);
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
          title: '检测到多个重复图片，请选择要定位的旧图',
          canPickMany: false,
          ignoreFocusOut: true
        }
      );

      if (!picked?.item) return;
      selected = picked.item;
    }

    const choice = await vscode.window.showWarningMessage(
      [
        `检测到重复图片（同平台 ${createdItem.platform}）`,
        `新图：${absPath}`,
        `命中：${selected.absPath}`
      ].join('\n'),
      { modal: true },
      '强制添加新图',
      '删除新图并定位旧图'
    );

    if (choice !== '删除新图并定位旧图') return;

    try {
      await vscode.workspace.fs.delete(vscode.Uri.file(absPath), { recursive: false, useTrash: false });
      await revealResourceByPath(selected.absPath);
      await this.refresh();
    } catch {
      await vscode.window.showErrorMessage(`无法删除新图片，请手动处理：${absPath}`);
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
        void this.refresh(async (items) => {
          await this.handleCreatedFile(uri.fsPath, items);
        });
      });

      const onChange = (uri: vscode.Uri) => {
        if (isInterestingFsPath(uri.fsPath)) void this.refresh();
      };
      watcher.onDidChange(onChange);
      watcher.onDidDelete(onChange);

      this.watchers.push(watcher);
    }
  }

  private async loadMediaInfo(absPath: string): Promise<MediaMetadataInfo> {
    const normalized = normalizePath(absPath);
    const cached = this.infoCache.get(normalized);
    if (cached) return cached;

    const item = this.cachedItems.find((entry) => normalizePath(entry.absPath) === normalized);
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

function previewUriForItem(webview: vscode.Webview, item: GalleryAssetItem): string | null {
  const renderable = item.mediaType === 'audio' || item.mediaType === 'video' ||
    ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg', 'apng', 'avif', 'ico', 'lottie'].includes(item.formatFamily);
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
    text: '安装 MediaInfo CLI 可解析更多数据',
    actionLabel: '下载 CLI',
    url: MEDIAINFO_DOWNLOAD_URL
  };
}

async function extractMediaInfo(absPath: string, item?: GalleryAssetItem): Promise<MediaMetadataInfo> {
  const mediaType = item?.mediaType ?? mediaTypeFromPath(absPath);
  if (mediaType === 'image') {
    return imageInfoToMediaInfo(await extractImageInfo(absPath));
  }

  const mediaInfo = await tryMediaInfo(absPath, mediaType);
  if (mediaInfo) return mediaInfo;

  const ffprobeInfo = await tryFfprobe(absPath, mediaType);
  if (ffprobeInfo) return ffprobeInfo;

  return fallbackMediaInfo(absPath, mediaType, item);
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
  const executable = findMediaInfoExecutable();
  if (!executable) return null;
  try {
    const { stdout } = await execFileAsync(executable, ['--Output=JSON', absPath], { windowsHide: true, timeout: 8000 });
    const parsed = JSON.parse(stdout);
    const tracks = Array.isArray(parsed?.media?.track) ? parsed.media.track : [];
    const sections = tracks
      .map((track: Record<string, unknown>) => mediaInfoTrackToSection(track))
      .filter((section: MetadataSection) => section.rows.length > 0);
    if (!sections.length) return null;
    return { mediaType, source: `MediaInfo (${executable})`, sections };
  } catch {
    return null;
  }
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

function humanizeKey(key: string): string {
  return key
    .replace(/_String\d*$/i, '')
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim();
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
  const uri = vscode.Uri.file(absPath);
  await vscode.commands.executeCommand('vscode.open', uri, {
    preview: false
  });
}

async function revealResourceByPath(absPath: string): Promise<void> {
  await openResourceByPath(absPath);
  await vscode.commands.executeCommand('workbench.files.action.showActiveFileInExplorer');
}

async function openWithDefaultApp(absPath: string): Promise<void> {
  await vscode.env.openExternal(vscode.Uri.file(absPath));
}

async function openWithChooser(absPath: string): Promise<void> {
  if (process.platform === 'win32') {
    try {
      execFile('rundll32.exe', ['shell32.dll,OpenAs_RunDLL', absPath], { windowsHide: true }, () => undefined);
      return;
    } catch {
      await openWithDefaultApp(absPath);
      return;
    }
  }
  await openWithDefaultApp(absPath);
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
