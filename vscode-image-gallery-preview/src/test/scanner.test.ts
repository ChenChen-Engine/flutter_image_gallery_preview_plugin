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
    fs.mkdirSync(path.join(root, 'app/src/main/res/raw'), { recursive: true });
    fs.writeFileSync(path.join(root, 'app/src/main/res/raw/intro.mp3'), Buffer.from([0x49, 0x44, 0x33, 0x03, 0x00]));
    writePng(path.join(root, 'feature_chat/src/debug/res/drawable-xxhdpi/hero.png'), 20, 22);
    fs.mkdirSync(path.join(root, 'app/src/main/res/mipmap-anydpi-v26'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml'),
      '<vector xmlns:android="http://schemas.android.com/apk/res/android" android:viewportWidth="24" android:viewportHeight="24"></vector>',
      'utf8'
    );

    const items = scanAssets(root).filter((item) => item.sourceType === 'android_res');

    assert.strictEqual(items.length, 4);
    assert.ok(items.some((item) =>
      item.workspaceKind === 'android' &&
      item.projectName === 'app' &&
      item.moduleName === 'app' &&
      item.isPrimaryProject &&
      item.isPrimaryModule &&
      item.copyToken === 'R.drawable.icon' &&
      item.mediaType === 'image' &&
      item.resourceRootPath.endsWith('/app/src/main/res/drawable')
    ));
    assert.ok(items.some((item) => item.moduleName === 'feature_chat' && item.qualifier === 'xxhdpi'));
    assert.ok(items.some((item) => item.copyToken === 'R.mipmap.ic_launcher' && item.formatFamily === 'vector_xml'));
    assert.ok(items.some((item) => item.copyToken === 'R.raw.intro' && item.mediaType === 'audio' && item.formatFamily === 'mp3'));
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
    assert.ok(items.some((item) =>
      item.workspaceKind === 'flutter' &&
      item.projectName === 'root_app' &&
      item.moduleName === path.basename(root) &&
      item.isPrimaryProject &&
      item.isPrimaryModule &&
      item.relPath.endsWith('assets/images/banner.png') &&
      item.mediaType === 'image' &&
      item.resourceRootPath.endsWith('/assets/images')
    ));
    assert.ok(items.some((item) =>
      item.projectName === 'feature_feed' &&
      item.moduleName === 'feature_feed' &&
      !item.isPrimaryProject &&
      item.copyToken.endsWith('res/images/feed.webp')
    ));
  });

  test('scan flutter fallback assets and keep duplicate project names separate by path', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'igp-vscode-flutter-adapted-libs-'));
    fs.writeFileSync(path.join(root, 'pubspec.yaml'), ['name: root_app', 'flutter:', '  assets:', '    - assets/images/'].join('\n'), 'utf8');

    const firstPlugin = path.join(root, 'adapted_libs/app_shortcuts');
    const secondPlugin = path.join(root, 'adapted_libs/group/app_shortcuts');
    fs.mkdirSync(firstPlugin, { recursive: true });
    fs.mkdirSync(secondPlugin, { recursive: true });
    fs.writeFileSync(path.join(firstPlugin, 'pubspec.yaml'), ['name: app_shortcuts', 'dependencies:', '  flutter:', '    sdk: flutter'].join('\n'), 'utf8');
    fs.writeFileSync(path.join(secondPlugin, 'pubspec.yaml'), ['name: app_shortcuts', 'dependencies:', '  flutter:', '    sdk: flutter'].join('\n'), 'utf8');
    writePng(path.join(firstPlugin, 'assets/icon.png'), 10, 10);
    writePng(path.join(secondPlugin, 'res/icon.png'), 12, 12);

    const items = scanAssets(root).filter((item) =>
      item.sourceType === 'flutter_asset' && item.projectName === 'app_shortcuts'
    );

    assert.strictEqual(items.length, 2);
    assert.deepStrictEqual(
      new Set(items.map((item) => item.projectRelPath)),
      new Set(['./adapted_libs/app_shortcuts', './adapted_libs/group/app_shortcuts'])
    );
    assert.strictEqual(new Set(items.map((item) => item.projectPath)).size, items.length);
    assert.ok(items.every((item) => item.modulePath === item.projectPath));
    assert.ok(items.some((item) => item.copyToken === 'assets/icon.png'));
    assert.ok(items.some((item) => item.copyToken === 'res/icon.png'));
  });

  test('scan flutter media only from valid flutter projects and resource roots', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'igp-vscode-flutter-media-boundary-'));
    fs.writeFileSync(
      path.join(root, 'pubspec.yaml'),
      ['name: root_app', 'flutter:', '  assets:', '    - assets/images/'].join('\n'),
      'utf8'
    );
    writePng(path.join(root, 'assets/images/declared.png'), 10, 10);
    fs.mkdirSync(path.join(root, 'assets/audio'), { recursive: true });
    fs.writeFileSync(path.join(root, 'assets/audio/click.mp3'), Buffer.from([0x49, 0x44, 0x33, 0x03, 0x00]));
    writePng(path.join(root, 'docs/temp.png'), 8, 8);

    const invalid = path.join(root, 'adapted_libs/plain_dart');
    fs.mkdirSync(invalid, { recursive: true });
    fs.writeFileSync(path.join(invalid, 'pubspec.yaml'), 'name: plain_dart\n', 'utf8');
    writePng(path.join(invalid, 'assets/ignored.png'), 8, 8);

    const plugin = path.join(root, 'adapted_libs/audio_plugin');
    fs.mkdirSync(plugin, { recursive: true });
    fs.writeFileSync(
      path.join(plugin, 'pubspec.yaml'),
      ['name: audio_plugin', 'dependencies:', '  flutter:', '    sdk: flutter'].join('\n'),
      'utf8'
    );
    fs.mkdirSync(path.join(plugin, 'res/video'), { recursive: true });
    fs.writeFileSync(path.join(plugin, 'res/video/intro.mp4'), Buffer.alloc(32));

    const items = scanAssets(root).filter((item) => item.sourceType === 'flutter_asset');

    assert.ok(items.some((item) => item.copyToken === 'assets/images/declared.png' && item.mediaType === 'image'));
    assert.ok(items.some((item) => item.copyToken === 'assets/audio/click.mp3' && item.mediaType === 'audio'));
    assert.ok(items.some((item) => item.projectName === 'audio_plugin' && item.copyToken === 'res/video/intro.mp4' && item.mediaType === 'video'));
    assert.ok(items.every((item) => !item.relPath.includes('docs/temp.png')));
    assert.ok(items.every((item) => item.projectName !== 'plain_dart'));
  });

  test('scan flutter workspace android and ios resources from root and nested projects', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'igp-vscode-flutter-platforms-'));

    fs.writeFileSync(
      path.join(root, 'pubspec.yaml'),
      ['name: root_app', 'flutter:', '  assets:', '    - assets/images/'].join('\n'),
      'utf8'
    );
    writePng(path.join(root, 'android/app/src/main/res/drawable/root_icon.png'), 16, 16);
    writePng(path.join(root, 'ios/Runner/Assets.xcassets/Root.imageset/root.png'), 16, 16);
    fs.writeFileSync(
      path.join(root, 'ios/Runner/Assets.xcassets/Root.imageset/Contents.json'),
      JSON.stringify({ images: [{ filename: 'root.png' }] }),
      'utf8'
    );

    const featureRoot = path.join(root, 'packages/feature_one');
    fs.mkdirSync(featureRoot, { recursive: true });
    fs.writeFileSync(
      path.join(featureRoot, 'pubspec.yaml'),
      ['name: feature_one', 'flutter:', '  assets:', '    - assets/'].join('\n'),
      'utf8'
    );
    writePng(path.join(featureRoot, 'android/app/src/main/res/drawable/feature_icon.png'), 18, 18);
    writePng(path.join(featureRoot, 'ios/Runner/Assets.xcassets/Feature.imageset/feature.png'), 18, 18);
    fs.writeFileSync(
      path.join(featureRoot, 'ios/Runner/Assets.xcassets/Feature.imageset/Contents.json'),
      JSON.stringify({ images: [{ filename: 'feature.png' }] }),
      'utf8'
    );

    const items = scanAssets(root);
    const androidItems = items.filter((item) => item.sourceType === 'android_res');
    const iosItems = items.filter((item) => item.sourceType === 'ios_asset');

    assert.ok(androidItems.some((item) => item.projectName === 'root_app' && item.isPrimaryProject && item.moduleName === 'app' && item.isPrimaryModule));
    assert.ok(androidItems.some((item) => item.projectName === 'feature_one' && !item.isPrimaryProject && item.moduleName === 'app' && item.isPrimaryModule));
    assert.ok(iosItems.some((item) => item.projectName === 'root_app' && item.isPrimaryProject && item.relPath.endsWith('root.png')));
    assert.ok(iosItems.some((item) => item.projectName === 'feature_one' && !item.isPrimaryProject && item.relPath.endsWith('feature.png')));
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
    fs.writeFileSync(path.join(resources, 'intro.mov'), Buffer.alloc(32));
    writePng(path.join(runner, 'Sources/Debug/debug.png'), 8, 8);
    writePng(path.join(root, 'ios/build/generated.png'), 8, 8);

    const items = scanAssets(root).filter((item) => item.sourceType === 'ios_asset');
    assert.strictEqual(items.length, 3);

    const avatar = items.find((item) => item.relPath.endsWith('avatar.png'));
    assert.ok(avatar);
    assert.ok(avatar!.copyToken.includes('Assets.xcassets/Avatar.imageset/avatar.png'));

    const banner = items.find((item) => item.relPath.endsWith('Resources/banner.png'));
    assert.ok(banner);
    assert.strictEqual(banner!.moduleName, 'Runner');
    assert.strictEqual(banner!.projectName, path.basename(root));
    assert.strictEqual(banner!.workspaceKind, 'ios');
    assert.ok(items.some((item) => item.relPath.endsWith('Resources/intro.mov') && item.mediaType === 'video'));
    assert.ok(items.every((item) => !item.relPath.includes('Sources/Debug')));
    assert.ok(items.every((item) => !item.relPath.includes('build/generated')));
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
    assert.strictEqual(items[0].isAnimated, true);
    assert.ok(items[0].md5.length > 0);
  });
});
