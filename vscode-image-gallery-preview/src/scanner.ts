import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { AssetKind, GalleryAssetItem, PlatformType, SourceType } from './shared/types';

const IGNORED_DIRS = new Set([
  '.git', '.gradle', '.idea', 'build', 'out', 'output', 'dist', 'node_modules', '.dart_tool', 'Pods'
]);

const DIRECT_FORMATS = new Set<AssetKind>([
  'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg', 'pdf',
  'heic', 'heif', 'apng', 'avif', 'ico',
  'xml'
]);

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

function extLower(filePath: string): string {
  return path.extname(filePath).replace('.', '').toLowerCase();
}

function shouldSkipDir(dirPath: string, root: string): boolean {
  if (dirPath === root) return false;
  return IGNORED_DIRS.has(path.basename(dirPath));
}

function walkFiles(rootDir: string, callback: (filePath: string) => void): void {
  if (!fs.existsSync(rootDir) || !fs.statSync(rootDir).isDirectory()) return;

  const stack: string[] = [rootDir];
  while (stack.length) {
    const current = stack.pop()!;
    if (shouldSkipDir(current, rootDir)) continue;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(abs);
      } else if (entry.isFile()) {
        callback(abs);
      }
    }
  }
}

function parsePubspec(pubspecPath: string): any {
  try {
    const text = fs.readFileSync(pubspecPath, 'utf8');
    return yaml.load(text);
  } catch {
    return null;
  }
}

function parseFlutterAssetEntries(pubspecPath: string): string[] {
  const doc = parsePubspec(pubspecPath);
  const assets = doc?.flutter?.assets;
  if (!Array.isArray(assets)) return [];

  return assets
    .map((entry) => {
      if (typeof entry === 'string') return entry.trim();
      if (entry && typeof entry === 'object' && typeof entry.path === 'string') {
        return entry.path.trim();
      }
      return '';
    })
    .filter((v) => !!v);
}

function parseFlutterProjectName(pubspecPath: string): string | null {
  const doc = parsePubspec(pubspecPath);
  return typeof doc?.name === 'string' && doc.name.trim() ? doc.name.trim() : null;
}

function resolveModuleName(moduleRoot: string): string {
  const name = path.basename(moduleRoot);
  return name || 'root';
}

function resolveFlutterModuleName(moduleRoot: string, pubspecPath: string): string {
  const name = path.basename(moduleRoot);
  return name || parseFlutterProjectName(pubspecPath) || 'flutter';
}

function resolveFlutterProjectName(moduleRoot: string, pubspecPath: string): string {
  return parseFlutterProjectName(pubspecPath) ?? (path.basename(moduleRoot) || 'flutter');
}

function resolveIosModuleName(moduleRoot: string): string {
  const name = path.basename(moduleRoot, path.extname(moduleRoot));
  return name || 'ios';
}

function resolveIosProjectName(moduleRoot: string, root: string): string {
  let cursor = moduleRoot;
  while (cursor && normalizePath(cursor).startsWith(normalizePath(root))) {
    if (path.basename(cursor).toLowerCase() === 'ios') {
      return path.basename(path.dirname(cursor)) || 'ios';
    }

    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }

  return path.basename(path.dirname(moduleRoot)) || path.basename(moduleRoot) || 'ios';
}

function resolveAndroidProjectName(root: string, moduleRoot: string): string {
  let cursor = moduleRoot;
  const normalizedRoot = normalizePath(root);

  while (cursor && normalizePath(cursor).startsWith(normalizedRoot)) {
    if (
      fs.existsSync(path.join(cursor, 'settings.gradle')) ||
      fs.existsSync(path.join(cursor, 'settings.gradle.kts'))
    ) {
      return path.basename(cursor) || 'android';
    }

    if (normalizePath(cursor) === normalizedRoot) {
      break;
    }

    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }

  return path.basename(path.dirname(moduleRoot)) || path.basename(moduleRoot) || 'android';
}

function detectFormatFamily(filePath: string, preferVectorXml: boolean): AssetKind {
  const extension = extLower(filePath);

  if (extension === 'json' && looksLikeLottie(filePath)) return 'lottie';
  if (extension === 'xml' && preferVectorXml && looksLikeVectorDrawable(filePath)) return 'vector_xml';
  if (DIRECT_FORMATS.has(extension as AssetKind)) return extension as AssetKind;
  return 'other';
}

function looksLikeVectorDrawable(filePath: string): boolean {
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    return text.includes('<vector') && text.includes('http://schemas.android.com/apk/res/android');
  } catch {
    return false;
  }
}

function looksLikeLottie(filePath: string): boolean {
  if (extLower(filePath) !== 'json') return false;
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    return text.includes('"layers"') && text.includes('"v"') && text.includes('"w"') && text.includes('"h"');
  } catch {
    return false;
  }
}

function readPngSize(filePath: string): { width: number; height: number } | null {
  try {
    const buf = fs.readFileSync(filePath);
    if (buf.length < 24) return null;
    if (buf[0] !== 0x89 || buf.toString('ascii', 1, 4) !== 'PNG') return null;
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    if (width > 0 && height > 0) return { width, height };
    return null;
  } catch {
    return null;
  }
}

function readJpegSize(filePath: string): { width: number; height: number } | null {
  try {
    const buf = fs.readFileSync(filePath);
    if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;

    let offset = 2;
    while (offset + 9 < buf.length) {
      if (buf[offset] !== 0xff) {
        offset += 1;
        continue;
      }

      const marker = buf[offset + 1];
      offset += 2;

      if (marker === 0xd9 || marker === 0xda) break;
      if (offset + 1 >= buf.length) break;

      const length = buf.readUInt16BE(offset);
      if (length < 2 || offset + length > buf.length) break;

      const isSof =
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf);

      if (isSof && offset + 7 < buf.length) {
        const height = buf.readUInt16BE(offset + 3);
        const width = buf.readUInt16BE(offset + 5);
        if (width > 0 && height > 0) return { width, height };
      }

      offset += length;
    }

    return null;
  } catch {
    return null;
  }
}

function readWebpSize(filePath: string): { width: number; height: number } | null {
  try {
    const buf = fs.readFileSync(filePath);
    if (buf.length < 30) return null;
    if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') return null;

    const chunkType = buf.toString('ascii', 12, 16);
    if (chunkType === 'VP8X') {
      const width = 1 + buf.readUIntLE(24, 3);
      const height = 1 + buf.readUIntLE(27, 3);
      return width > 0 && height > 0 ? { width, height } : null;
    }

    return null;
  } catch {
    return null;
  }
}

function readSvgSize(filePath: string): { width: number; height: number } | null {
  try {
    const text = fs.readFileSync(filePath, 'utf8');

    const widthMatch = text.match(/width\s*=\s*["']\s*([-+]?\d+(?:\.\d+)?)(?:px|pt|pc|cm|mm|in)?\s*["']/i);
    const heightMatch = text.match(/height\s*=\s*["']\s*([-+]?\d+(?:\.\d+)?)(?:px|pt|pc|cm|mm|in)?\s*["']/i);
    if (widthMatch && heightMatch) {
      const width = Math.floor(Number(widthMatch[1]));
      const height = Math.floor(Number(heightMatch[1]));
      if (width > 0 && height > 0) return { width, height };
    }

    const vb = text.match(/viewBox\s*=\s*["']\s*[-+]?\d+(?:\.\d+)?\s+[-+]?\d+(?:\.\d+)?\s+([-+]?\d+(?:\.\d+)?)\s+([-+]?\d+(?:\.\d+)?)\s*["']/i);
    if (vb) {
      const width = Math.floor(Number(vb[1]));
      const height = Math.floor(Number(vb[2]));
      if (width > 0 && height > 0) return { width, height };
    }

    return null;
  } catch {
    return null;
  }
}

function readVectorSize(filePath: string): { width: number; height: number } | null {
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    const vpw = text.match(/viewportWidth\s*=\s*["']\s*([-+]?\d+(?:\.\d+)?)\s*["']/i);
    const vph = text.match(/viewportHeight\s*=\s*["']\s*([-+]?\d+(?:\.\d+)?)\s*["']/i);
    if (vpw && vph) {
      const width = Math.floor(Number(vpw[1]));
      const height = Math.floor(Number(vph[1]));
      if (width > 0 && height > 0) return { width, height };
    }

    const widthMatch = text.match(/android:width\s*=\s*["']\s*([-+]?\d+(?:\.\d+)?)(?:dp|dip|px)?\s*["']/i);
    const heightMatch = text.match(/android:height\s*=\s*["']\s*([-+]?\d+(?:\.\d+)?)(?:dp|dip|px)?\s*["']/i);
    if (widthMatch && heightMatch) {
      const width = Math.floor(Number(widthMatch[1]));
      const height = Math.floor(Number(heightMatch[1]));
      if (width > 0 && height > 0) return { width, height };
    }

    return null;
  } catch {
    return null;
  }
}

function readLottieSize(filePath: string): { width: number; height: number } | null {
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    const widthMatch = text.match(/"w"\s*:\s*(\d{1,6})/);
    const heightMatch = text.match(/"h"\s*:\s*(\d{1,6})/);
    if (!widthMatch || !heightMatch) return null;

    const width = Number(widthMatch[1]);
    const height = Number(heightMatch[1]);
    if (width > 0 && height > 0) return { width, height };
    return null;
  } catch {
    return null;
  }
}

function readImageSize(filePath: string, formatFamily: AssetKind): { width: number; height: number } | null {
  switch (formatFamily) {
    case 'png':
      return readPngSize(filePath);
    case 'jpg':
    case 'jpeg':
      return readJpegSize(filePath);
    case 'webp':
      return readWebpSize(filePath);
    case 'svg':
      return readSvgSize(filePath);
    case 'vector_xml':
      return readVectorSize(filePath);
    case 'lottie':
      return readLottieSize(filePath);
    default:
      return null;
  }
}

function md5Hex(filePath: string): string {
  try {
    const content = fs.readFileSync(filePath);
    return crypto.createHash('md5').update(content).digest('hex');
  } catch {
    return '';
  }
}

function androidCopyToken(folderName: string, filePath: string): string {
  const prefix = folderName.startsWith('mipmap') ? 'R.mipmap' : 'R.drawable';
  const stem = path.basename(filePath, path.extname(filePath)).toLowerCase();
  const normalized = stem.replace(/[^a-z0-9_]/g, '_').replace(/^_+|_+$/g, '') || 'asset';
  return `${prefix}.${normalized}`;
}

function flutterCopyToken(moduleRoot: string, filePath: string): string {
  const normalized = normalizePath(filePath);
  const segments = normalized.split('/');

  for (let i = segments.length - 2; i >= 0; i -= 1) {
    if (segments[i].toLowerCase() === 'res') {
      return segments.slice(i).join('/');
    }
  }

  for (let i = segments.length - 2; i >= 0; i -= 1) {
    if (segments[i].toLowerCase() === 'assets') {
      return segments.slice(i).join('/');
    }
  }

  return normalizePath(path.relative(moduleRoot, filePath));
}

function iosCopyToken(moduleRoot: string, filePath: string): string {
  const normalized = normalizePath(filePath);
  const segments = normalized.split('/');

  for (let i = segments.length - 2; i >= 0; i -= 1) {
    if (segments[i].toLowerCase().endsWith('.xcassets')) {
      return segments.slice(i).join('/');
    }
  }

  return normalizePath(path.relative(moduleRoot, filePath));
}

function toGalleryItem(params: {
  root: string;
  filePath: string;
  sourceType: SourceType;
  platform: PlatformType;
  projectName: string;
  moduleName: string;
  groupPath: string;
  copyToken: string;
  qualifier: string;
  formatFamily: AssetKind;
}): GalleryAssetItem {
  const stat = fs.statSync(params.filePath);
  const size = readImageSize(params.filePath, params.formatFamily);

  return {
    sourceType: params.sourceType,
    platform: params.platform,
    projectName: params.projectName,
    moduleName: params.moduleName,
    groupPath: params.groupPath,
    copyToken: params.copyToken,
    md5: md5Hex(params.filePath),
    formatFamily: params.formatFamily,
    absPath: params.filePath,
    relPath: normalizePath(path.relative(params.root, params.filePath)),
    format: extLower(params.filePath),
    width: size?.width ?? null,
    height: size?.height ?? null,
    qualifier: params.qualifier,
    mtime: stat.mtimeMs,
    kind: params.formatFamily
  };
}

function scanAndroidRes(root: string): GalleryAssetItem[] {
  const results: GalleryAssetItem[] = [];

  walkFiles(root, (filePath) => {
    const normalized = normalizePath(filePath);
    const marker = '/src/';
    const srcIndex = normalized.indexOf(marker);
    if (srcIndex < 0) return;

    const afterSrc = normalized.slice(srcIndex + marker.length).split('/');
    if (afterSrc.length < 3) return;

    const sourceSet = afterSrc[0];
    const maybeRes = afterSrc[1];
    const bucket = afterSrc[2];
    if (!sourceSet || maybeRes !== 'res') return;
    if (!(bucket.startsWith('drawable') || bucket.startsWith('mipmap'))) return;

    const moduleRoot = normalized.slice(0, srcIndex);
    const moduleName = resolveModuleName(moduleRoot);
    const projectName = resolveAndroidProjectName(root, moduleRoot);
    const qualifier = bucket.includes('-') ? bucket.substring(bucket.indexOf('-') + 1) : '';
    const family = detectFormatFamily(filePath, true);
    if (family === 'other') return;

    const moduleRel = normalizePath(path.relative(moduleRoot, filePath));
    const groupPath = moduleRel.includes('/') ? moduleRel.slice(0, moduleRel.lastIndexOf('/')) : '.';

    results.push(toGalleryItem({
      root,
      filePath,
      sourceType: 'android_res',
      platform: 'android',
      projectName,
      moduleName,
      groupPath,
      copyToken: androidCopyToken(bucket, filePath),
      qualifier,
      formatFamily: family
    }));
  });

  return results;
}

function normalizeAssetEntry(raw: string): string {
  return raw.trim().replace(/^['"]|['"]$/g, '').replace(/\\/g, '/').replace(/^\/+/, '');
}

function resolveWildcardTargets(moduleRoot: string, entry: string): string[] {
  const normalized = normalizeAssetEntry(entry);
  const wildcardPos = normalized.indexOf('*');
  if (wildcardPos < 0) return [];

  const slashPos = normalized.lastIndexOf('/', wildcardPos);
  const basePrefix = slashPos >= 0 ? normalized.substring(0, slashPos + 1) : '';
  const baseDir = path.join(moduleRoot, basePrefix);
  if (!fs.existsSync(baseDir) || !fs.statSync(baseDir).isDirectory()) return [];

  const extMatch = normalized.match(/\*\*?\/\*\.([a-zA-Z0-9]+)$|\*\.([a-zA-Z0-9]+)$/);
  const ext = (extMatch?.[1] || extMatch?.[2] || '').toLowerCase() || null;

  const files: string[] = [];
  walkFiles(baseDir, (filePath) => {
    if (!ext || extLower(filePath) === ext) files.push(filePath);
  });
  return files;
}

function scanFlutterAssets(root: string): GalleryAssetItem[] {
  const results: GalleryAssetItem[] = [];

  const pubspecs: string[] = [];
  walkFiles(root, (filePath) => {
    if (path.basename(filePath).toLowerCase() === 'pubspec.yaml') {
      pubspecs.push(filePath);
    }
  });

  for (const pubspecPath of pubspecs) {
    const moduleRoot = path.dirname(pubspecPath);
    const moduleName = resolveFlutterModuleName(moduleRoot, pubspecPath);
    const projectName = resolveFlutterProjectName(moduleRoot, pubspecPath);
    const entries = parseFlutterAssetEntries(pubspecPath);

    for (const rawEntry of entries) {
      const entry = normalizeAssetEntry(rawEntry);
      if (!entry) continue;

      const target = path.join(moduleRoot, entry);
      if (fs.existsSync(target) && fs.statSync(target).isFile()) {
        const family = detectFormatFamily(target, false);
        if (family !== 'other') {
          const moduleRel = normalizePath(path.relative(moduleRoot, target));
          const groupPath = moduleRel.includes('/') ? moduleRel.slice(0, moduleRel.lastIndexOf('/')) : '.';
          results.push(toGalleryItem({
            root,
            filePath: target,
            sourceType: 'flutter_asset',
            platform: 'flutter',
            projectName,
            moduleName,
            groupPath,
            copyToken: flutterCopyToken(moduleRoot, target),
            qualifier: '',
            formatFamily: family
          }));
        }
        continue;
      }

      if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
        walkFiles(target, (filePath) => {
          const family = detectFormatFamily(filePath, false);
          if (family === 'other') return;

          const moduleRel = normalizePath(path.relative(moduleRoot, filePath));
          const groupPath = moduleRel.includes('/') ? moduleRel.slice(0, moduleRel.lastIndexOf('/')) : '.';
          results.push(toGalleryItem({
            root,
            filePath,
            sourceType: 'flutter_asset',
            platform: 'flutter',
            projectName,
            moduleName,
            groupPath,
            copyToken: flutterCopyToken(moduleRoot, filePath),
            qualifier: '',
            formatFamily: family
          }));
        });
        continue;
      }

      for (const wildcardFile of resolveWildcardTargets(moduleRoot, entry)) {
        const family = detectFormatFamily(wildcardFile, false);
        if (family === 'other') continue;

        const moduleRel = normalizePath(path.relative(moduleRoot, wildcardFile));
        const groupPath = moduleRel.includes('/') ? moduleRel.slice(0, moduleRel.lastIndexOf('/')) : '.';
        results.push(toGalleryItem({
          root,
          filePath: wildcardFile,
          sourceType: 'flutter_asset',
          platform: 'flutter',
          projectName,
          moduleName,
          groupPath,
          copyToken: flutterCopyToken(moduleRoot, wildcardFile),
          qualifier: '',
          formatFamily: family
        }));
      }
    }
  }

  return results;
}

function extractIosImageSetFilenames(contentsPath: string): string[] {
  try {
    const text = fs.readFileSync(contentsPath, 'utf8');
    return [...text.matchAll(/"filename"\s*:\s*"([^"]+)"/g)]
      .map((m) => m[1])
      .filter((v) => !!v);
  } catch {
    return [];
  }
}

function findIosModuleRoot(filePath: string, iosRoot: string): string {
  let current = fs.statSync(filePath).isDirectory() ? filePath : path.dirname(filePath);
  let fallback = iosRoot;

  while (current && normalizePath(current).startsWith(normalizePath(iosRoot))) {
    if (path.basename(current) === 'ios') return fallback;

    try {
      const entries = fs.readdirSync(current, { withFileTypes: true });
      const hasXcodeproj = entries.some((entry) => entry.name.toLowerCase().endsWith('.xcodeproj'));
      if (hasXcodeproj) fallback = current;
    } catch {
      // noop
    }

    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return fallback;
}

function scanIosAssets(root: string): GalleryAssetItem[] {
  const results: GalleryAssetItem[] = [];
  const iosRoot = path.join(root, 'ios');
  if (!fs.existsSync(iosRoot) || !fs.statSync(iosRoot).isDirectory()) return results;

  const seen = new Set<string>();

  walkFiles(iosRoot, (filePath) => {
    if (path.basename(filePath) !== 'Contents.json') return;
    if (!normalizePath(filePath).includes('.xcassets/')) return;

    const imageSetDir = path.dirname(filePath);
    const moduleRoot = findIosModuleRoot(imageSetDir, iosRoot);
    const moduleName = resolveIosModuleName(moduleRoot);
    const projectName = resolveIosProjectName(moduleRoot, root);

    for (const fileName of extractIosImageSetFilenames(filePath)) {
      const assetPath = path.join(imageSetDir, fileName);
      if (!fs.existsSync(assetPath) || !fs.statSync(assetPath).isFile()) continue;

      const normalizedAssetPath = normalizePath(assetPath);
      if (seen.has(normalizedAssetPath)) continue;

      const family = detectFormatFamily(assetPath, false);
      if (family === 'other') continue;

      seen.add(normalizedAssetPath);
      const moduleRel = normalizePath(path.relative(moduleRoot, assetPath));
      const groupPath = moduleRel.includes('/') ? moduleRel.slice(0, moduleRel.lastIndexOf('/')) : '.';

      results.push(toGalleryItem({
        root,
        filePath: assetPath,
        sourceType: 'ios_asset',
        platform: 'ios',
        projectName,
        moduleName,
        groupPath,
        copyToken: iosCopyToken(moduleRoot, assetPath),
        qualifier: '',
        formatFamily: family
      }));
    }
  });

  walkFiles(iosRoot, (filePath) => {
    const normalized = normalizePath(filePath);
    if (normalized.includes('.xcassets/')) return;
    if (path.basename(filePath).toLowerCase() === 'contents.json') return;
    if (seen.has(normalized)) return;

    const family = detectFormatFamily(filePath, false);
    if (family === 'other') return;

    const moduleRoot = findIosModuleRoot(filePath, iosRoot);
    const moduleName = resolveIosModuleName(moduleRoot);
    const projectName = resolveIosProjectName(moduleRoot, root);
    const moduleRel = normalizePath(path.relative(moduleRoot, filePath));
    const groupPath = moduleRel.includes('/') ? moduleRel.slice(0, moduleRel.lastIndexOf('/')) : '.';

    seen.add(normalized);
    results.push(toGalleryItem({
      root,
      filePath,
      sourceType: 'ios_asset',
      platform: 'ios',
      projectName,
      moduleName,
      groupPath,
      copyToken: iosCopyToken(moduleRoot, filePath),
      qualifier: '',
      formatFamily: family
    }));
  });

  return results;
}

export function scanAssets(root: string): GalleryAssetItem[] {
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return [];

  const all = [...scanAndroidRes(root), ...scanFlutterAssets(root), ...scanIosAssets(root)];

  const dedup = new Map<string, GalleryAssetItem>();
  for (const item of all) {
    const key = `${item.platform}|${item.projectName}|${item.moduleName}|${item.relPath}|${item.copyToken}`;
    if (!dedup.has(key)) dedup.set(key, item);
  }

  return [...dedup.values()].sort((a, b) => {
    return (
      a.platform.localeCompare(b.platform) ||
      a.projectName.localeCompare(b.projectName) ||
      a.moduleName.localeCompare(b.moduleName) ||
      a.groupPath.localeCompare(b.groupPath) ||
      a.relPath.localeCompare(b.relPath)
    );
  });
}


