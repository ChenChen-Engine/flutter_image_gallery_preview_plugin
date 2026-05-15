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

  test('shared toolbar exposes Sync and Refresh actions', () => {
    const html = fs.readFileSync(sharedPath('index.html'), 'utf8');
    const script = fs.readFileSync(sharedPath('gallery.js'), 'utf8');

    assert.match(html, /id="syncButton"/);
    assert.match(html, /id="refreshButton"/);
    assert.match(script, /post\('sync'/);
    assert.match(script, /post\('refresh',\s*\{\s*force:\s*true\s*\}\)/);
  });

  test('shared web accepts VSCode host messages and exposes info refresh', () => {
    const html = fs.readFileSync(sharedPath('index.html'), 'utf8');
    const script = fs.readFileSync(sharedPath('gallery.js'), 'utf8');

    assert.match(html, /id="infoRefreshButton"/);
    assert.match(script, /window\.addEventListener\('message'/);
    assert.match(script, /window\.galleryHostReceive\s*=\s*handleHostMessage/);
    assert.match(script, /post\('requestMediaInfo',\s*\{\s*absPath:\s*item\.absPath,\s*force:\s*true\s*\}\)/);
  });

  test('shared media preview keeps external playback without stale web player code', () => {
    const script = fs.readFileSync(sharedPath('gallery.js'), 'utf8');

    assert.match(script, /openWithDefaultApp/);
    assert.match(script, /\\u25b6/);
    assert.doesNotMatch(script, /createAudioController/);
    assert.doesNotMatch(script, /openVideoDialog/);
    assert.doesNotMatch(script, /showUnsupportedMedia/);
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
