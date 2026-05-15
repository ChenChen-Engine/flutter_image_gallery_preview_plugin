const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const packageJsonPath = path.resolve(__dirname, '..', 'package.json');
const packageLockPath = path.resolve(__dirname, '..', 'package-lock.json');
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
const configuredVersion = packageJson.version;

const outputDir = path.resolve(__dirname, '..', 'output');
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

for (const entry of fs.readdirSync(outputDir)) {
  if (entry.endsWith('.vsix')) {
    fs.rmSync(path.join(outputDir, entry), { force: true });
  }
}

const outPath = path.join(outputDir, `vscode-image-gallery-preview-${configuredVersion}.vsix`);

execSync(`npx vsce package --out "${outPath}"`, { stdio: 'inherit' });
console.log(`VSIX packaged: ${outPath}`);
