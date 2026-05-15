import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

suite('shared web smoke', () => {
  test('parses shared and synced gallery javascript', () => {
    for (const filePath of [sharedPath('gallery.js'), webviewPath('gallery.js')]) {
      const source = fs.readFileSync(filePath, 'utf8');
      assert.doesNotThrow(() => new vm.Script(source, { filename: filePath }));
    }
  });

  test('keeps synced webview assets aligned with gallery-web sources', () => {
    for (const assetName of ['index.html', 'gallery.css', 'gallery.js']) {
      const shared = fs.readFileSync(sharedPath(assetName), 'utf8');
      const synced = fs.readFileSync(webviewPath(assetName), 'utf8');
      assert.strictEqual(synced, shared, `expected synced ${assetName} to match gallery-web/${assetName}`);
    }
  });
});

function extensionRoot(): string {
  return path.resolve(__dirname, '../..');
}

function repoRoot(): string {
  return path.resolve(extensionRoot(), '..');
}

function sharedPath(fileName: string): string {
  return path.join(repoRoot(), 'gallery-web', fileName);
}

function webviewPath(fileName: string): string {
  return path.join(extensionRoot(), 'webview', fileName);
}
