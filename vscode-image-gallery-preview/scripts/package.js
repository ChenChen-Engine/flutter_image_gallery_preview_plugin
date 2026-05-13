const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const packageJsonPath = path.resolve(__dirname, '..', 'package.json');
const packageLockPath = path.resolve(__dirname, '..', 'package-lock.json');
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

function bumpPatch(version) {
  const parts = String(version || '0.0.1')
    .split('.')
    .map((part) => Number.parseInt(part, 10) || 0);
  const [major = 0, minor = 0, patch = 0] = parts;
  return `${major}.${minor}.${patch + 1}`;
}

const nextVersion = bumpPatch(packageJson.version);
packageJson.version = nextVersion;
fs.writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8');

if (fs.existsSync(packageLockPath)) {
  const packageLock = JSON.parse(fs.readFileSync(packageLockPath, 'utf8'));
  packageLock.version = nextVersion;
  if (packageLock.packages && packageLock.packages['']) {
    packageLock.packages[''].version = nextVersion;
  }
  fs.writeFileSync(packageLockPath, `${JSON.stringify(packageLock, null, 2)}\n`, 'utf8');
}

const outputDir = path.resolve(__dirname, '..', 'output');
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

for (const entry of fs.readdirSync(outputDir)) {
  if (entry.endsWith('.vsix')) {
    fs.rmSync(path.join(outputDir, entry), { force: true });
  }
}

const outPath = path.join(outputDir, `vscode-image-gallery-preview-${nextVersion}.vsix`);

execSync(`npx vsce package --out "${outPath}"`, { stdio: 'inherit' });
console.log(`VSIX packaged: ${outPath}`);
