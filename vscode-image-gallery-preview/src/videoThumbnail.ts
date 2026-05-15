import * as crypto from 'crypto';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { resolveMediaInfoExecutable } from './mediaInfoTool';

const execFileAsync = promisify(execFile);
export const VIDEO_THUMBNAIL_DIR = path.join(os.tmpdir(), 'image-gallery-video-thumbs');

const thumbnailPromises = new Map<string, Promise<string | null>>();

export async function thumbnailForVideo(absPath: string): Promise<string | null> {
  const stat = safeStat(absPath);
  if (!stat?.isFile()) return null;

  const key = cacheKey(absPath, stat.mtimeMs, stat.size);
  const existingPath = existingThumbnailPath(key);
  if (existingPath) return existingPath;

  const existing = thumbnailPromises.get(key);
  if (existing) return existing;

  const promise = generateThumbnail(absPath, key).finally(() => {
    thumbnailPromises.delete(key);
  });
  thumbnailPromises.set(key, promise);
  return promise;
}

async function generateThumbnail(absPath: string, key: string): Promise<string | null> {
  fs.mkdirSync(VIDEO_THUMBNAIL_DIR, { recursive: true });
  const embedded = await extractEmbeddedCover(absPath, key);
  if (embedded) return embedded;
  return extractFrameWithFfmpeg(absPath, path.join(VIDEO_THUMBNAIL_DIR, `${key}.png`));
}

function existingThumbnailPath(key: string): string | null {
  for (const extension of ['png', 'jpg', 'webp']) {
    const candidate = path.join(VIDEO_THUMBNAIL_DIR, `${key}.${extension}`);
    if (isUsableFile(candidate)) return candidate;
  }
  return null;
}

async function extractEmbeddedCover(absPath: string, key: string): Promise<string | null> {
  for (const command of mediaInfoCoverCommands(absPath)) {
    const stdout = await runCommand(command.file, command.args);
    if (!stdout) continue;
    const coverBytes = coverBytesFromMediaInfo(stdout);
    if (!coverBytes?.length) continue;
    const outputPath = path.join(VIDEO_THUMBNAIL_DIR, `${key}.${imageExtension(coverBytes)}`);
    fs.writeFileSync(outputPath, coverBytes);
    if (isUsableFile(outputPath)) return outputPath;
  }
  return null;
}

function mediaInfoCoverCommands(absPath: string): Array<{ file: string; args: string[] }> {
  const commands: Array<{ file: string; args: string[] }> = [];
  if (process.platform === 'win32') {
    commands.push({ file: 'cmd', args: ['/c', 'mediaInfo', '--Output=JSON', '--Cover_Data=base64', absPath] });
  }

  const executable = resolveMediaInfoExecutable();
  if (executable) {
    commands.push({ file: executable, args: ['--Output=JSON', '--Cover_Data=base64', absPath] });
  }

  if (process.platform !== 'win32' && commands.length === 0) {
    commands.push({ file: 'mediainfo', args: ['--Output=JSON', '--Cover_Data=base64', absPath] });
  }
  return commands;
}

function coverBytesFromMediaInfo(output: string): Buffer | null {
  const parsed = parseJson(output);
  const encoded = findCoverData(parsed) ?? findCoverDataInText(output);
  if (!encoded) return null;
  try {
    return Buffer.from(encoded, 'base64');
  } catch {
    return null;
  }
}

function findCoverData(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findCoverData(entry);
      if (found) return found;
    }
    return null;
  }

  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (/^cover[_ ]data$/i.test(key) && typeof entry === 'string' && entry.trim()) {
      return entry.trim();
    }
    const nested = findCoverData(entry);
    if (nested) return nested;
  }
  return null;
}

function findCoverDataInText(output: string): string | null {
  for (const line of output.split(/\r?\n/)) {
    if (!/cover/i.test(line)) continue;
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    const value = line.slice(separator + 1).trim();
    if (value.length > 64) return value;
  }
  return null;
}

async function extractFrameWithFfmpeg(absPath: string, outputPath: string): Promise<string | null> {
  for (const timestamp of ['00:00:01', '00:00:00']) {
    safeUnlink(outputPath);
    const stdout = await runCommand('ffmpeg', [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-ss',
      timestamp,
      '-i',
      absPath,
      '-frames:v',
      '1',
      '-vf',
      'scale=360:-1',
      outputPath
    ]);
    if (stdout != null && isUsableFile(outputPath)) return outputPath;
  }
  return null;
}

async function runCommand(file: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(file, args, {
      windowsHide: true,
      timeout: 8000,
      maxBuffer: 8 * 1024 * 1024
    });
    return stdout;
  } catch {
    return null;
  }
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function cacheKey(absPath: string, mtimeMs: number, size: number): string {
  return crypto.createHash('sha1').update(`${absPath}|${mtimeMs}|${size}`).digest('hex');
}

function imageExtension(bytes: Buffer): 'png' | 'jpg' | 'webp' {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'jpg';
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'webp';
  }
  return 'png';
}

function isUsableFile(filePath: string): boolean {
  const stat = safeStat(filePath);
  return !!stat?.isFile() && stat.size > 0;
}

function safeStat(filePath: string): fs.Stats | null {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function safeUnlink(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // ignore
  }
}
