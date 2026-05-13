import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { scanAssets } from '../scanner';

function writePng(filePath: string, width: number, height: number): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const png = Buffer.alloc(24);
  png[0] = 0x89;
  png.write('PNG', 1, 'ascii');
  png[4] = 0x0d;
  png[5] = 0x0a;
  png[6] = 0x1a;
  png[7] = 0x0a;
  png.writeUInt32BE(13, 8);
  png.write('IHDR', 12, 'ascii');
  png.writeUInt32BE(width, 16);
  png.writeUInt32BE(height, 20);

  fs.writeFileSync(filePath, png);
}

suite('scanner', () => {
  test('scan android multi-module resources with module and qualifier', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'igp-vscode-android-'));

    writePng(path.join(root, 'app/src/main/res/drawable/icon.png'), 10, 12);
    writePng(path.join(root, 'feature_chat/src/debug/res/drawable-xxhdpi/hero.png'), 20, 22);
    fs.mkdirSync(path.join(root, 'app/src/main/res/mipmap-anydpi-v26'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml'),
      '<vector xmlns:android="http://schemas.android.com/apk/res/android" android:viewportWidth="24" android:viewportHeight="24"></vector>',
      'utf8'
    );

    const items = scanAssets(root).filter((item) => item.sourceType === 'android_res');

    assert.strictEqual(items.length, 3);
    assert.ok(items.some((item) => item.projectName === path.basename(root) && item.moduleName === 'app' && item.copyToken === 'R.drawable.icon'));
    assert.ok(items.some((item) => item.moduleName === 'feature_chat' && item.qualifier === 'xxhdpi'));
    assert.ok(items.some((item) => item.copyToken === 'R.mipmap.ic_launcher' && item.formatFamily === 'vector_xml'));
  });

  test('scan flutter assets from multiple pubspec files', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'igp-vscode-flutter-'));

    writePng(path.join(root, 'assets/images/banner.png'), 120, 60);
    writePng(path.join(root, 'modules/feature_feed/res/images/feed.webp'), 18, 20);

    fs.writeFileSync(
      path.join(root, 'pubspec.yaml'),
      ['name: root_app', 'flutter:', '  assets:', '    - assets/images/'].join('\n'),
      'utf8'
    );

    fs.writeFileSync(
      path.join(root, 'modules/feature_feed/pubspec.yaml'),
      ['name: feature_feed', 'flutter:', '  assets:', '    - res/images/'].join('\n'),
      'utf8'
    );

    const items = scanAssets(root).filter((item) => item.sourceType === 'flutter_asset');

    assert.strictEqual(items.length, 2);
    assert.ok(items.some((item) => item.projectName === 'root_app' && item.moduleName === path.basename(root) && item.relPath.endsWith('assets/images/banner.png')));
    assert.ok(items.some((item) => item.projectName === 'feature_feed' && item.moduleName === 'feature_feed' && item.copyToken.endsWith('res/images/feed.webp')));
  });

  test('scan ios assets from xcassets and regular folders', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'igp-vscode-ios-'));

    const runner = path.join(root, 'ios/Runner');
    fs.mkdirSync(runner, { recursive: true });
    fs.writeFileSync(path.join(runner, 'Runner.xcodeproj'), 'project', 'utf8');

    const imageSet = path.join(runner, 'Assets.xcassets/Avatar.imageset');
    fs.mkdirSync(imageSet, { recursive: true });
    writePng(path.join(imageSet, 'avatar.png'), 40, 40);
    fs.writeFileSync(
      path.join(imageSet, 'Contents.json'),
      JSON.stringify({ images: [{ idiom: 'universal', filename: 'avatar.png', scale: '1x' }] }),
      'utf8'
    );

    const resources = path.join(runner, 'Resources');
    fs.mkdirSync(resources, { recursive: true });
    writePng(path.join(resources, 'banner.png'), 64, 32);

    const items = scanAssets(root).filter((item) => item.sourceType === 'ios_asset');
    assert.strictEqual(items.length, 2);

    const avatar = items.find((item) => item.relPath.endsWith('avatar.png'));
    assert.ok(avatar);
    assert.ok(avatar!.copyToken.includes('Assets.xcassets/Avatar.imageset/avatar.png'));

    const banner = items.find((item) => item.relPath.endsWith('Resources/banner.png'));
    assert.ok(banner);
    assert.strictEqual(banner!.moduleName, 'Runner');
    assert.strictEqual(banner!.projectName, path.basename(root));
  });

  test('lottie detection does not include regular json', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'igp-vscode-lottie-'));

    fs.mkdirSync(path.join(root, 'assets/anim'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'assets/anim/like.json'),
      JSON.stringify({ v: '5.8.1', w: 200, h: 200, layers: [{ nm: 'shape' }] }),
      'utf8'
    );
    fs.writeFileSync(path.join(root, 'assets/anim/not_lottie.json'), JSON.stringify({ name: 'x' }), 'utf8');

    fs.writeFileSync(
      path.join(root, 'pubspec.yaml'),
      ['name: demo', 'flutter:', '  assets:', '    - assets/anim/'].join('\n'),
      'utf8'
    );

    const items = scanAssets(root).filter((item) => item.sourceType === 'flutter_asset');

    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].formatFamily, 'lottie');
    assert.ok(items[0].md5.length > 0);
  });
});
