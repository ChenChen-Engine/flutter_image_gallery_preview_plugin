import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { AssetKind, GalleryAssetItem, MediaType, PlatformType, SourceType } from './shared/types';

const IGNORED_DIRS = new Set([
  '.git', '.gradle', '.idea', 'build', 'out', 'output', 'dist', 'node_modules', '.dart_tool', 'pods', 'deriveddata'
]);

const IMAGE_FORMATS = new Set<AssetKind>([
  'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg', 'pdf',
  'heic', 'heif', 'apng', 'avif', 'ico'
]);
const AUDIO_FORMATS = new Set<AssetKind>([
  'mp3', 'm4a', 'aac', 'wav', 'ogg', 'opus', 'flac', 'amr', 'mid', 'midi', 'caf',
  'wma', 'aiff', 'aif', 'alac', 'mka'
]);
const VIDEO_FORMATS = new Set<AssetKind>([
  'mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi', '3gp', '3gpp',
  'mpeg', 'mpg', 'ts', 'm2ts', 'wmv', 'flv'
]);
const DIRECT_FORMATS = new Set<AssetKind>([...IMAGE_FORMATS, ...AUDIO_FORMATS, ...VIDEO_FORMATS]);

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

function extLower(filePath: string): string {
  return path.extname(filePath).replace('.', '').toLowerCase();
}

function shouldSkipDir(dirPath: string, root: string): boolean {
  if (dirPath === root) return false;
  return IGNORED_DIRS.has(path.basename(dirPath).toLowerCase());
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

function isFlutterDependency(value: any): boolean {
  if (typeof value === 'string') return value.toLowerCase().includes('flutter');
  if (value && typeof value === 'object') {
    return String(value.sdk ?? '').toLowerCase() === 'flutter';
  }
  return false;
}

function isFlutterProject(pubspecPath: string): boolean {
  const doc = parsePubspec(pubspecPath);
  if (!doc || typeof doc !== 'object') return false;
  if (doc.flutter && typeof doc.flutter === 'object') return true;
  return isFlutterDependency(doc.dependencies?.flutter) || isFlutterDependency(doc.dev_dependencies?.flutter);
}

interface ProjectIdentity {
  name: string;
  path: string;
  isPrimary: boolean;
}

function samePath(left: string, right: string): boolean {
  return normalizePath(path.resolve(left)).toLowerCase() === normalizePath(path.resolve(right)).toLowerCase();
}

function isDescendantOrSame(child: string, parent: string): boolean {
  const relative = normalizePath(path.relative(parent, child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function displayRelativePath(root: string, target: string): string {
  const relative = normalizePath(path.relative(root, target));
  if (!relative) return '.';
  if (relative.startsWith('..') || path.isAbsolute(relative)) return relative;
  return `./${relative}`;
}

function findNearestPubspecRoot(start: string, root: string): string | null {
  let cursor = fs.existsSync(start) && fs.statSync(start).isDirectory() ? start : path.dirname(start);
  while (cursor && isDescendantOrSame(cursor, root)) {
    const pubspec = path.join(cursor, 'pubspec.yaml');
    if (fs.existsSync(pubspec) && fs.statSync(pubspec).isFile()) return cursor;
    if (samePath(cursor, root)) break;
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return null;
}

function resolveWorkspaceRoot(openedRoot: string): string {
  let cursor = fs.existsSync(openedRoot) && fs.statSync(openedRoot).isDirectory() ? openedRoot : path.dirname(openedRoot);
  while (cursor) {
    const pubspec = path.join(cursor, 'pubspec.yaml');
    if (fs.existsSync(pubspec) && fs.statSync(pubspec).isFile()) return cursor;
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return openedRoot;
}

function containsXcodeProject(root: string): boolean {
  const stack = [root];
  while (stack.length) {
    const current = stack.pop()!;
    if (shouldSkipDir(current, root)) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.toLowerCase().endsWith('.xcodeproj')) return true;
      if (entry.isDirectory()) stack.push(path.join(current, entry.name));
    }
  }
  return false;
}

function detectWorkspaceKind(root: string): GalleryAssetItem['workspaceKind'] {
  if (fs.existsSync(path.join(root, 'pubspec.yaml'))) return 'flutter';
  if (fs.existsSync(path.join(root, 'settings.gradle')) || fs.existsSync(path.join(root, 'settings.gradle.kts'))) return 'android';
  if (containsAndroidResources(root)) return 'android';
  if (path.basename(root).toLowerCase() === 'ios' || containsXcodeProject(root)) return 'ios';
  return 'unknown';
}

function containsAndroidResources(root: string): boolean {
  let found = false;
  walkFiles(root, (filePath) => {
    const normalized = normalizePath(filePath).toLowerCase();
    if (normalized.includes('/src/') && (normalized.includes('/res/drawable') || normalized.includes('/res/mipmap'))) {
      found = true;
    }
  });
  return found;
}

function resolveFlutterProject(root: string, moduleRoot: string, pubspecPath: string): ProjectIdentity {
  return {
    name: parseFlutterProjectName(pubspecPath) ?? (path.basename(moduleRoot) || 'flutter'),
    path: normalizePath(moduleRoot),
    isPrimary: samePath(moduleRoot, root)
  };
}

function findNearestFlutterProject(root: string, start: string): ProjectIdentity | null {
  const pubspecRoot = findNearestPubspecRoot(start, root);
  if (!pubspecRoot) return null;
  return resolveFlutterProject(root, pubspecRoot, path.join(pubspecRoot, 'pubspec.yaml'));
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

function mediaTypeFor(formatFamily: AssetKind): MediaType {
  if (AUDIO_FORMATS.has(formatFamily)) return 'audio';
  if (VIDEO_FORMATS.has(formatFamily)) return 'video';
  return 'image';
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
  if (mediaTypeFor(formatFamily) !== 'image') return null;
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

function isAnimated(filePath: string, formatFamily: AssetKind): boolean {
  if (formatFamily === 'gif' || formatFamily === 'apng' || formatFamily === 'lottie') return true;
  if (formatFamily !== 'webp') return false;

  try {
    return fs.readFileSync(filePath).includes(Buffer.from('ANMF', 'ascii'));
  } catch {
    return false;
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
  const prefix = folderName.startsWith('mipmap') ? 'R.mipmap' : folderName.startsWith('raw') ? 'R.raw' : 'R.drawable';
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
  projectPath: string;
  isPrimaryProject: boolean;
  moduleName: string;
  modulePath: string;
  isPrimaryModule: boolean;
  groupPath: string;
  copyToken: string;
  qualifier: string;
  formatFamily: AssetKind;
  resourceRootPath: string;
  workspaceKind: GalleryAssetItem['workspaceKind'];
}): GalleryAssetItem {
  const stat = fs.statSync(params.filePath);
  const size = readImageSize(params.filePath, params.formatFamily);
  const mediaType = mediaTypeFor(params.formatFamily);

  return {
    sourceType: params.sourceType,
    platform: params.platform,
    workspaceKind: params.workspaceKind,
    projectName: params.projectName,
    projectPath: normalizePath(params.projectPath),
    projectRelPath: displayRelativePath(params.root, params.projectPath),
    isPrimaryProject: params.isPrimaryProject,
    moduleName: params.moduleName,
    modulePath: normalizePath(params.modulePath),
    moduleRelPath: displayRelativePath(params.root, params.modulePath),
    isPrimaryModule: params.isPrimaryModule,
    groupPath: params.groupPath,
    copyToken: params.copyToken,
    md5: md5Hex(params.filePath),
    formatFamily: params.formatFamily,
    isAnimated: isAnimated(params.filePath, params.formatFamily),
    mediaType,
    durationMillis: null,
    resourceRootPath: normalizePath(params.resourceRootPath).replace(/\/+$/, ''),
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

function primaryAndroidProjectName(root: string): string {
  return fs.existsSync(path.join(root, 'app')) ? 'app' : (path.basename(root) || 'app');
}

function resolveAndroidProject(root: string, moduleRoot: string, workspaceKind: GalleryAssetItem['workspaceKind']): ProjectIdentity {
  const flutterProject = findNearestFlutterProject(root, moduleRoot);
  if (flutterProject) return flutterProject;

  if (workspaceKind === 'android') {
    return {
      name: primaryAndroidProjectName(root),
      path: normalizePath(root),
      isPrimary: true
    };
  }

  let cursor = moduleRoot;
  const normalizedRoot = normalizePath(root);
  while (cursor && normalizePath(cursor).startsWith(normalizedRoot)) {
    if (
      fs.existsSync(path.join(cursor, 'settings.gradle')) ||
      fs.existsSync(path.join(cursor, 'settings.gradle.kts'))
    ) {
      return {
        name: path.basename(cursor) || 'android',
        path: normalizePath(cursor),
        isPrimary: samePath(cursor, root)
      };
    }
    if (normalizePath(cursor) === normalizedRoot) break;
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }

  return {
    name: resolveAndroidProjectName(root, moduleRoot),
    path: normalizePath(path.dirname(moduleRoot) || moduleRoot),
    isPrimary: samePath(moduleRoot, root)
  };
}

function scanAndroidRes(root: string, workspaceKind: GalleryAssetItem['workspaceKind']): GalleryAssetItem[] {
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
    if (!(bucket.startsWith('drawable') || bucket.startsWith('mipmap') || bucket.startsWith('raw'))) return;

    const moduleRoot = normalized.slice(0, srcIndex);
    const moduleName = resolveModuleName(moduleRoot);
    const project = resolveAndroidProject(root, moduleRoot, workspaceKind);
    const qualifier = bucket.includes('-') ? bucket.substring(bucket.indexOf('-') + 1) : '';
    const family = detectFormatFamily(filePath, true);
    if (family === 'other') return;
    const mediaType = mediaTypeFor(family);
    const isRaw = bucket.startsWith('raw');
    if (isRaw && mediaType === 'image') return;
    if (!isRaw && mediaType !== 'image') return;

    const moduleRel = normalizePath(path.relative(moduleRoot, filePath));
    const groupPath = moduleRel.includes('/') ? moduleRel.slice(0, moduleRel.lastIndexOf('/')) : '.';

    results.push(toGalleryItem({
      root,
      filePath,
      sourceType: 'android_res',
      platform: 'android',
      workspaceKind,
      projectName: project.name,
      projectPath: project.path,
      isPrimaryProject: project.isPrimary,
      moduleName,
      modulePath: moduleRoot,
      isPrimaryModule: moduleName.toLowerCase() === 'app',
      groupPath,
      copyToken: androidCopyToken(bucket, filePath),
      qualifier,
      formatFamily: family,
      resourceRootPath: path.dirname(filePath)
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

function scanFlutterAssets(root: string, workspaceKind: GalleryAssetItem['workspaceKind']): GalleryAssetItem[] {
  const results: GalleryAssetItem[] = [];

  const pubspecs: string[] = [];
  walkFiles(root, (filePath) => {
    if (path.basename(filePath).toLowerCase() === 'pubspec.yaml') {
      pubspecs.push(filePath);
    }
  });

  for (const pubspecPath of pubspecs) {
    if (!isFlutterProject(pubspecPath)) continue;
    const moduleRoot = path.dirname(pubspecPath);
    const moduleName = resolveFlutterModuleName(moduleRoot, pubspecPath);
    const project = resolveFlutterProject(root, moduleRoot, pubspecPath);
    const entries = parseFlutterAssetEntries(pubspecPath);
    const seenProjectFiles = new Set<string>();

    const addFlutterFile = (filePath: string, resourceRootPath: string): void => {
      const normalized = normalizePath(filePath);
      if (seenProjectFiles.has(normalized)) return;
      seenProjectFiles.add(normalized);

      const family = detectFormatFamily(filePath, false);
      if (family === 'other') return;

      const moduleRel = normalizePath(path.relative(moduleRoot, filePath));
      const groupPath = moduleRel.includes('/') ? moduleRel.slice(0, moduleRel.lastIndexOf('/')) : '.';
      results.push(toGalleryItem({
        root,
        filePath,
        sourceType: 'flutter_asset',
        platform: 'flutter',
        workspaceKind,
        projectName: project.name,
        projectPath: project.path,
        isPrimaryProject: project.isPrimary,
        moduleName,
        modulePath: moduleRoot,
        isPrimaryModule: project.isPrimary,
        groupPath,
        copyToken: flutterCopyToken(moduleRoot, filePath),
        qualifier: '',
        formatFamily: family,
        resourceRootPath
      }));
    };

    for (const rawEntry of entries) {
      const entry = normalizeAssetEntry(rawEntry);
      if (!entry) continue;

      const target = path.join(moduleRoot, entry);
      if (fs.existsSync(target) && fs.statSync(target).isFile()) {
        addFlutterFile(target, path.dirname(target));
        continue;
      }

      if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
        walkFiles(target, (filePath) => {
          addFlutterFile(filePath, target);
        });
        continue;
      }

      for (const wildcardFile of resolveWildcardTargets(moduleRoot, entry)) {
        addFlutterFile(wildcardFile, path.dirname(wildcardFile));
      }
    }

    for (const fallbackName of ['assets', 'res']) {
      const fallbackDir = path.join(moduleRoot, fallbackName);
      if (!fs.existsSync(fallbackDir) || !fs.statSync(fallbackDir).isDirectory()) continue;
      walkFiles(fallbackDir, (filePath) => {
        addFlutterFile(filePath, fallbackDir);
      });
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

function findIosRoots(root: string, workspaceKind: GalleryAssetItem['workspaceKind']): string[] {
  const roots = new Set<string>();
  if (path.basename(root).toLowerCase() === 'ios') roots.add(root);

  const stack = [root];
  while (stack.length) {
    const current = stack.pop()!;
    if (shouldSkipDir(current, root)) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const abs = path.join(current, entry.name);
      if (entry.name.toLowerCase() === 'ios') roots.add(abs);
      stack.push(abs);
    }
  }

  if (workspaceKind === 'ios' && roots.size === 0) roots.add(root);
  return [...roots];
}

function isIosBundleResourceFile(filePath: string, iosRoot: string): boolean {
  const relative = normalizePath(path.relative(iosRoot, filePath)).toLowerCase();
  const segments = relative.split('/').filter(Boolean);
  if (segments.some((segment) => ['build', 'pods', 'deriveddata', 'source', 'sources', 'classes'].includes(segment))) {
    return false;
  }
  if (segments.some((segment) => segment.endsWith('.xcodeproj') || segment.endsWith('.xcworkspace'))) {
    return false;
  }
  if (segments.some((segment) => ['resources', 'assets', 'res'].includes(segment))) return true;
  return segments[0] === 'runner' && segments.length <= 2;
}

function resolveIosProject(root: string, moduleRoot: string, workspaceKind: GalleryAssetItem['workspaceKind']): ProjectIdentity {
  const flutterProject = findNearestFlutterProject(root, moduleRoot);
  if (flutterProject) return flutterProject;

  return {
    name: resolveIosProjectName(moduleRoot, root),
    path: normalizePath(moduleRoot),
    isPrimary: workspaceKind === 'ios' && isDescendantOrSame(moduleRoot, root)
  };
}

function scanIosAssets(root: string, workspaceKind: GalleryAssetItem['workspaceKind']): GalleryAssetItem[] {
  const results: GalleryAssetItem[] = [];
  const seen = new Set<string>();

  for (const iosRoot of findIosRoots(root, workspaceKind)) {
    walkFiles(iosRoot, (filePath) => {
      if (path.basename(filePath) !== 'Contents.json') return;
      if (!normalizePath(filePath).includes('.xcassets/')) return;

      const imageSetDir = path.dirname(filePath);
      const moduleRoot = findIosModuleRoot(imageSetDir, iosRoot);
      const moduleName = resolveIosModuleName(moduleRoot);
      const project = resolveIosProject(root, moduleRoot, workspaceKind);

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
          workspaceKind,
          projectName: project.name,
          projectPath: project.path,
          isPrimaryProject: project.isPrimary,
          moduleName,
          modulePath: moduleRoot,
          isPrimaryModule: project.isPrimary && moduleName.toLowerCase() === 'runner',
          groupPath,
          copyToken: iosCopyToken(moduleRoot, assetPath),
          qualifier: '',
          formatFamily: family,
          resourceRootPath: imageSetDir
        }));
      }
    });

    walkFiles(iosRoot, (filePath) => {
      const normalized = normalizePath(filePath);
      if (normalized.includes('.xcassets/')) return;
      if (path.basename(filePath).toLowerCase() === 'contents.json') return;
      if (seen.has(normalized)) return;
      if (!isIosBundleResourceFile(filePath, iosRoot)) return;

      const family = detectFormatFamily(filePath, false);
      if (family === 'other') return;

      const moduleRoot = findIosModuleRoot(filePath, iosRoot);
      const moduleName = resolveIosModuleName(moduleRoot);
      const project = resolveIosProject(root, moduleRoot, workspaceKind);
      const moduleRel = normalizePath(path.relative(moduleRoot, filePath));
      const groupPath = moduleRel.includes('/') ? moduleRel.slice(0, moduleRel.lastIndexOf('/')) : '.';

      seen.add(normalized);
      results.push(toGalleryItem({
        root,
        filePath,
        sourceType: 'ios_asset',
        platform: 'ios',
        workspaceKind,
        projectName: project.name,
        projectPath: project.path,
        isPrimaryProject: project.isPrimary,
        moduleName,
        modulePath: moduleRoot,
        isPrimaryModule: project.isPrimary && moduleName.toLowerCase() === 'runner',
        groupPath,
        copyToken: iosCopyToken(moduleRoot, filePath),
        qualifier: '',
        formatFamily: family,
        resourceRootPath: path.dirname(filePath)
      }));
    });
  }

  return results;
}

export function scanAssets(root: string): GalleryAssetItem[] {
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return [];

  const workspaceRoot = resolveWorkspaceRoot(root);
  const workspaceKind = detectWorkspaceKind(workspaceRoot);
  const all = [
    ...scanAndroidRes(workspaceRoot, workspaceKind),
    ...scanFlutterAssets(workspaceRoot, workspaceKind),
    ...scanIosAssets(workspaceRoot, workspaceKind)
  ];

  const dedup = new Map<string, GalleryAssetItem>();
  for (const item of all) {
    const key = `${item.platform}|${item.projectPath}|${item.modulePath}|${item.relPath}|${item.copyToken}`;
    if (!dedup.has(key)) dedup.set(key, item);
  }

  return [...dedup.values()].sort((a, b) => {
    return (
      a.platform.localeCompare(b.platform) ||
      Number(b.isPrimaryProject) - Number(a.isPrimaryProject) ||
      a.projectName.localeCompare(b.projectName) ||
      a.projectRelPath.localeCompare(b.projectRelPath) ||
      Number(b.isPrimaryModule) - Number(a.isPrimaryModule) ||
      a.moduleName.localeCompare(b.moduleName) ||
      a.moduleRelPath.localeCompare(b.moduleRelPath) ||
      a.groupPath.localeCompare(b.groupPath) ||
      a.relPath.localeCompare(b.relPath)
    );
  });
}


