const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const distDir = path.resolve(projectRoot, 'dist');

if (!distDir.startsWith(projectRoot + path.sep)) {
  throw new Error(`Refusing to remove dist outside project root: ${distDir}`);
}

fs.rmSync(distDir, { recursive: true, force: true });
console.log(`Cleaned ${distDir}`);
