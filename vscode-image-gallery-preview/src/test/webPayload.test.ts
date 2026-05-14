import * as assert from 'assert';
import { toWebviewAssetItem } from '../webPayload';
import { GalleryAssetItem } from '../shared/types';

suite('web payload', () => {
  test('maps browser render kind from asset type', () => {
    assert.strictEqual(toWebviewAssetItem(asset('png'), 'file:///icon.png').renderKind, 'image');
    assert.strictEqual(toWebviewAssetItem(asset('lottie'), 'file:///like.json').renderKind, 'lottie');
    assert.strictEqual(toWebviewAssetItem(asset('vector_xml'), 'file:///ic.xml').renderKind, 'placeholder');
  });

  test('keeps host computed copy token and grouping fields', () => {
    const webItem = toWebviewAssetItem(asset('png'), 'file:///icon.png');

    assert.strictEqual(webItem.copyToken, 'R.drawable.icon');
    assert.strictEqual(webItem.platform, 'android');
    assert.strictEqual(webItem.projectName, 'demo');
    assert.strictEqual(webItem.projectPath, 'C:/demo');
    assert.strictEqual(webItem.isPrimaryProject, true);
    assert.strictEqual(webItem.moduleName, 'app');
    assert.strictEqual(webItem.isPrimaryModule, true);
    assert.strictEqual(webItem.groupPath, 'res/drawable');
    assert.strictEqual(webItem.isAnimated, false);
  });
});

function asset(formatFamily: GalleryAssetItem['formatFamily']): GalleryAssetItem {
  return {
    sourceType: 'android_res',
    platform: 'android',
    workspaceKind: 'android',
    projectName: 'demo',
    projectPath: 'C:/demo',
    isPrimaryProject: true,
    moduleName: 'app',
    isPrimaryModule: true,
    groupPath: 'res/drawable',
    copyToken: 'R.drawable.icon',
    md5: 'abc123',
    formatFamily,
    isAnimated: formatFamily === 'lottie' || formatFamily === 'gif',
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
