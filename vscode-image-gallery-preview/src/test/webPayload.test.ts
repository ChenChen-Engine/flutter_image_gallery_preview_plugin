import * as assert from 'assert';
import { toWebviewAssetItem } from '../webPayload';
import { GalleryAssetItem } from '../shared/types';

suite('web payload', () => {
  test('maps browser render kind from asset type', () => {
    assert.strictEqual(toWebviewAssetItem(asset('png'), 'file:///icon.png').renderKind, 'image');
    assert.strictEqual(toWebviewAssetItem(asset('lottie'), 'file:///like.json').renderKind, 'lottie');
    assert.strictEqual(toWebviewAssetItem(asset('vector_xml'), 'file:///ic.xml').renderKind, 'placeholder');
    assert.strictEqual(toWebviewAssetItem(asset('mp3', 'audio'), 'file:///click.mp3').renderKind, 'audio');
    assert.strictEqual(toWebviewAssetItem(asset('mp4', 'video'), 'file:///intro.mp4').renderKind, 'video');
  });

  test('keeps host computed copy token and grouping fields', () => {
    const webItem = toWebviewAssetItem(asset('png'), 'file:///icon.png');

    assert.strictEqual(webItem.copyToken, 'R.drawable.icon');
    assert.strictEqual(webItem.platform, 'android');
    assert.strictEqual(webItem.projectName, 'demo');
    assert.strictEqual(webItem.projectPath, 'C:/demo');
    assert.strictEqual(webItem.projectRelPath, '.');
    assert.strictEqual(webItem.isPrimaryProject, true);
    assert.strictEqual(webItem.moduleName, 'app');
    assert.strictEqual(webItem.modulePath, 'C:/demo/app');
    assert.strictEqual(webItem.moduleRelPath, './app');
    assert.strictEqual(webItem.isPrimaryModule, true);
    assert.strictEqual(webItem.groupPath, 'res/drawable');
    assert.strictEqual(webItem.isAnimated, false);
  });
});

function asset(formatFamily: GalleryAssetItem['formatFamily'], mediaType: GalleryAssetItem['mediaType'] = 'image'): GalleryAssetItem {
  return {
    sourceType: 'android_res',
    platform: 'android',
    workspaceKind: 'android',
    projectName: 'demo',
    projectPath: 'C:/demo',
    projectRelPath: '.',
    isPrimaryProject: true,
    moduleName: 'app',
    modulePath: 'C:/demo/app',
    moduleRelPath: './app',
    isPrimaryModule: true,
    groupPath: 'res/drawable',
    copyToken: 'R.drawable.icon',
    md5: 'abc123',
    formatFamily,
    isAnimated: formatFamily === 'lottie' || formatFamily === 'gif',
    mediaType,
    durationMillis: null,
    resourceRootPath: 'C:/demo/app/src/main/res/drawable',
    absPath: 'C:/demo/app/src/main/res/drawable/icon.png',
    relPath: 'app/src/main/res/drawable/icon.png',
    format: formatFamily,
    width: 24,
    height: 24,
    qualifier: '',
    mtime: 1,
    kind: formatFamily
  };
}
