import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';

export function createMediaInfoExecutableResolver(
  finder: () => string | null = () => findMediaInfoExecutable()
): () => string | null {
  let resolved = false;
  let cached: string | null = null;
  return () => {
    if (resolved) return cached;
    cached = finder();
    resolved = true;
    return cached;
  };
}

let mediaInfoExecutableResolver = createMediaInfoExecutableResolver();

export function resolveMediaInfoExecutable(): string | null {
  return mediaInfoExecutableResolver();
}

export function clearMediaInfoExecutableCache(): void {
  mediaInfoExecutableResolver = createMediaInfoExecutableResolver();
}

export function findMediaInfoExecutable(
  env: NodeJS.ProcessEnv = process.env,
  exists: (candidate: string) => boolean = fs.existsSync,
  executable: (candidate: string) => boolean = (candidate) => {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
  platform: NodeJS.Platform = process.platform,
  commandRunner: (candidate: string) => string | null = (candidate) => runMediaInfoVersion(candidate),
  isConsoleExecutable: (candidate: string) => boolean = (candidate) => isWindowsConsoleExecutable(candidate)
): string | null {
  const isWindows = platform === 'win32';

  for (const key of ['MEDIAINFO_CLI_PATH', 'MEDIAINFO_PATH']) {
    const configured = env[key]?.trim();
    if (configured && isMediaInfoCli(configured, isWindows, exists, commandRunner, isConsoleExecutable)) return configured;
  }

  const checkCandidate = (candidate: string): string | null => {
    if (!exists(candidate)) return null;
    if (!isWindows && !executable(candidate)) return null;
    return isMediaInfoCli(candidate, isWindows, exists, commandRunner, isConsoleExecutable) ? candidate : null;
  };

  const commandNames = ['mediainfo', 'mediainfo.exe', 'MediaInfo', 'MediaInfo.exe'];
  const extensions = isWindows ? ['', '.exe', '.cmd', '.bat'] : [''];
  const pathDirs = (env.PATH ?? '')
    .split(path.delimiter)
    .filter((entry) => entry.trim().length > 0);

  for (const dir of pathDirs) {
    for (const commandName of commandNames) {
      const candidates = commandName.includes('.') ? [commandName] : extensions.map((extension) => `${commandName}${extension}`);
      for (const candidateName of candidates) {
        const candidate = path.join(dir, candidateName);
        const found = checkCandidate(candidate);
        if (found) return found;
      }
    }
  }

  if (isWindows) {
    const roots = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((drive) => `${drive}:\\`);
    const commonPaths = roots.flatMap((root) => [
      path.join(root, 'Program Files', 'MediaInfo CLI', 'MediaInfo.exe'),
      path.join(root, 'Program Files (x86)', 'MediaInfo CLI', 'MediaInfo.exe'),
      path.join(root, 'Program Files', 'MediaInfo_CLI', 'MediaInfo.exe'),
      path.join(root, 'Program Files (x86)', 'MediaInfo_CLI', 'MediaInfo.exe'),
      path.join(root, 'Program Files', 'MediaInfo_Cli', 'MediaInfo.exe'),
      path.join(root, 'Program Files (x86)', 'MediaInfo_Cli', 'MediaInfo.exe')
    ]);
    for (const candidate of commonPaths) {
      const found = checkCandidate(candidate);
      if (found) return found;
    }
  } else {
    const commonPaths = [
      '/opt/homebrew/bin/mediainfo',
      '/usr/local/bin/mediainfo',
      '/opt/local/bin/mediainfo',
      '/usr/bin/mediainfo'
    ];
    for (const candidate of commonPaths) {
      const found = checkCandidate(candidate);
      if (found) return found;
    }
  }

  return null;
}

function isMediaInfoCli(
  candidate: string,
  isWindows: boolean,
  exists: (candidate: string) => boolean,
  commandRunner: (candidate: string) => string | null,
  isConsoleExecutable: (candidate: string) => boolean
): boolean {
  if (!exists(candidate)) return false;
  if (isWindows && candidate.toLowerCase().endsWith('.exe') && !isConsoleExecutable(candidate)) return false;
  const output = commandRunner(candidate);
  return typeof output === 'string' && output.trim().toLowerCase().includes('mediainfo');
}

function runMediaInfoVersion(candidate: string): string | null {
  try {
    const result = spawnSync(candidate, ['--Version'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 2000,
      maxBuffer: 128 * 1024
    });
    if (result.error || result.status !== 0) return null;
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
    return output.length ? output : null;
  } catch {
    return null;
  }
}

function isWindowsConsoleExecutable(candidate: string): boolean {
  try {
    const buffer = fs.readFileSync(candidate);
    if (buffer.length < 0x40) return false;
    if (buffer.readUInt16LE(0) !== 0x5a4d) return false;
    const peOffset = buffer.readInt32LE(0x3c);
    if (peOffset <= 0 || peOffset + 0x5f >= buffer.length) return false;
    if (buffer.readUInt32LE(peOffset) !== 0x00004550) return false;
    const subsystem = buffer.readUInt16LE(peOffset + 4 + 20 + 68);
    return subsystem === 3;
  } catch {
    return false;
  }
}
