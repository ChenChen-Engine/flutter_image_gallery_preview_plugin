const fs = require('fs');
const path = require('path');

const sourceDir = path.resolve(__dirname, '..', '..', 'gallery-web');
const targetDir = path.resolve(__dirname, '..', 'webview');

if (!fs.existsSync(sourceDir)) {
  throw new Error(`Missing shared gallery web directory: ${sourceDir}`);
}

fs.rmSync(targetDir, { recursive: true, force: true });
fs.mkdirSync(targetDir, { recursive: true });

for (const entry of fs.readdirSync(sourceDir)) {
  const source = path.join(sourceDir, entry);
  const target = path.join(targetDir, entry);
  if (fs.statSync(source).isFile()) {
    fs.copyFileSync(source, target);
  }
}

console.log(`Synced gallery web assets to ${targetDir}`);
