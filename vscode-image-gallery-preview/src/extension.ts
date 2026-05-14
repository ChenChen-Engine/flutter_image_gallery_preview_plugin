import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import exifReader from 'exif-reader';
import sharp from 'sharp';
import { scanAssets } from './scanner';
import { GalleryAssetItem, ImageInfo, PlatformType } from './shared/types';
import { toWebviewAssetItem, WebviewAssetItem } from './webPayload';

class ImageGalleryViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'imageGalleryPreview.view';

  private view?: vscode.WebviewView;
  private watchers: vscode.FileSystemWatcher[] = [];
  private cachedItems: GalleryAssetItem[] = [];
  private duplicateIndex: Map<PlatformType, Map<string, GalleryAssetItem[]>> = new Map();
  private infoCache = new Map<string, ImageInfo>();
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

  resolveWebviewView(webviewView: vscode.WebviewView): void | Thenable<void> {
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
      await this.postLoadingState(false, 'Ready');
      await this.postAssets();
      if (!this.cachedItems.length) {
        await this.refresh();
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

    if (message?.type === 'requestImageInfo' && typeof message.absPath === 'string') {
      const info = await this.loadImageInfo(message.absPath);
      await this.view?.webview.postMessage({
        type: 'imageInfo',
        absPath: normalizePath(message.absPath),
        info
      });
    }
  }

  private async performRefresh(): Promise<void> {
    await this.postLoadingState(true, 'Indexing assets...');

    if (!vscode.workspace.workspaceFolders?.length) {
      this.cachedItems = [];
      this.duplicateIndex.clear();
      await this.postAssets();
      await this.postLoadingState(false, 'Ready');
      this.afterRefreshQueue = [];
      return;
    }

    const items = vscode.workspace.workspaceFolders.flatMap((folder) =>
      scanAssets(folder.uri.fsPath).map((item) => ({
        ...item,
        absPath: normalizePath(item.absPath),
        relPath: normalizePath(item.relPath)
      }))
    );

    this.cachedItems = items;
    this.duplicateIndex = this.buildDuplicateIndex(items);

    await this.postAssets();
    await this.postLoadingState(false, `Updated ${new Date().toLocaleTimeString()}`);

    const callbacks = this.afterRefreshQueue.splice(0, this.afterRefreshQueue.length);
    for (const callback of callbacks) {
      await callback(items);
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
        imageInfo: this.infoCache.get(normalizedAbsPath)
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
      '**/pubspec.yaml',
      '**/assets/**/*',
      '**/res/**/*',
      '**/ios/**/*'
    ];

    for (const pattern of patterns) {
      const watcher = vscode.workspace.createFileSystemWatcher(pattern);

      watcher.onDidCreate((uri) => {
        void this.refresh(async (items) => {
          await this.handleCreatedFile(uri.fsPath, items);
        });
      });

      const onChange = () => void this.refresh();
      watcher.onDidChange(onChange);
      watcher.onDidDelete(onChange);

      this.watchers.push(watcher);
    }
  }

  private async loadImageInfo(absPath: string): Promise<ImageInfo> {
    const normalized = normalizePath(absPath);
    const stat = safeStat(normalized);
    const cached = this.infoCache.get(normalized);
    if (cached && stat && cached.fileSize === readableBytes(stat.size)) {
      return cached;
    }

    const info = await extractImageInfo(normalized);
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
  const renderable = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg', 'apng', 'avif', 'ico', 'lottie']);
  if (!renderable.has(item.formatFamily)) return null;
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
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unitIndex = -1;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(2)} ${units[unitIndex]}`;
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
