import * as fs from 'fs';
import * as path from 'path';

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
  platform: NodeJS.Platform = process.platform
): string | null {
  const configured = env.MEDIAINFO_PATH?.trim();
  if (configured && exists(configured)) return configured;

  const commandNames = ['MediaInfo', 'MediaInfo.exe', 'mediainfo'];
  const extensions = platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];
  const pathDirs = (env.PATH ?? '')
    .split(path.delimiter)
    .filter((entry) => entry.trim().length > 0);

  for (const dir of pathDirs) {
    for (const commandName of commandNames) {
      const candidates = commandName.includes('.') ? [commandName] : extensions.map((extension) => `${commandName}${extension}`);
      for (const candidateName of candidates) {
        const candidate = path.join(dir, candidateName);
        if (exists(candidate) && executable(candidate)) return candidate;
      }
    }
  }

  if (platform === 'win32') {
    const commonPaths = [
      'C:\\Program Files\\MediaInfo\\MediaInfo.exe',
      'C:\\Program Files (x86)\\MediaInfo\\MediaInfo.exe'
    ];
    return commonPaths.find((candidate) => exists(candidate)) ?? null;
  }

  return null;
}
