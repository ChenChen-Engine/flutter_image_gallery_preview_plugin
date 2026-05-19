import * as assert from 'assert';
import * as vscode from 'vscode';
import { GalleryAssetItem } from '../shared/types';
import {
  buildResourceReferenceIndex,
  findResourceLinkMatches,
  findStaticStringLiterals,
  ResourceDocumentLinkProvider,
  ResourceDefinitionProvider,
  resolveResourceReference,
  ResourceReferenceState
} from '../resourceLinks';

suite('resource links', () => {
  test('matches copyToken and relPath from complete static strings', () => {
    const logo = asset({
      absPath: 'C:/demo/assets/images/logo.png',
      copyToken: 'assets/images/logo.png',
      relPath: 'assets/images/logo.png'
    });
    const icon = asset({
      absPath: 'C:/demo/app/src/main/res/drawable/icon.png',
      copyToken: 'R.drawable.icon',
      relPath: 'app/src/main/res/drawable/icon.png'
    });
    const state = new ResourceReferenceState(true);
    state.updateItems([logo, icon]);

    const text = [
      "Image.asset('assets/images/logo.png')",
      'val icon = "R.drawable.icon"'
    ].join('\n');
    const matches = findResourceLinkMatches(text, state, 'C:/demo/lib/main.dart');

    assert.deepStrictEqual(matches.map((match) => match.item.absPath), [logo.absPath, icon.absPath]);
    assert.strictEqual(text.slice(matches[0].start, matches[0].end), 'assets/images/logo.png');
  });

  test('rejects interpolation, concatenation, templates, comments, and filenames', () => {
    const state = new ResourceReferenceState(true);
    state.updateItems([
      asset({
        absPath: 'C:/demo/assets/images/logo.png',
        copyToken: 'assets/images/logo.png',
        relPath: 'assets/images/logo.png'
      })
    ]);

    const text = [
      "'assets/' + name",
      '"assets/${name}.png"',
      '`assets/images/logo.png`',
      '// "assets/images/logo.png"',
      '/* "assets/images/logo.png" */',
      '"logo.png"'
    ].join('\n');

    assert.strictEqual(findResourceLinkMatches(text, state, 'C:/demo/lib/main.dart').length, 0);
  });

  test('supports Dart raw string literals', () => {
    const state = new ResourceReferenceState(true);
    state.updateItems([
      asset({
        absPath: 'C:/demo/res/images/logo.png',
        copyToken: 'res/images/logo.png',
        relPath: 'res/images/logo.png'
      })
    ]);

    const text = "Image.asset(r'res/images/logo.png')";
    const matches = findResourceLinkMatches(text, state, 'C:/demo/lib/main.dart');

    assert.strictEqual(matches.length, 1);
    assert.strictEqual(text.slice(matches[0].start, matches[0].end), 'res/images/logo.png');
  });

  test('sorts duplicate references by current module then project then primary flags', () => {
    const feature = asset({
      absPath: 'C:/demo/packages/feature/assets/logo.png',
      copyToken: 'assets/logo.png',
      relPath: 'packages/feature/assets/logo.png',
      projectPath: 'C:/demo',
      modulePath: 'C:/demo/packages/feature',
      isPrimaryProject: false,
      isPrimaryModule: false
    });
    const app = asset({
      absPath: 'C:/demo/app/assets/logo.png',
      copyToken: 'assets/logo.png',
      relPath: 'app/assets/logo.png',
      projectPath: 'C:/demo',
      modulePath: 'C:/demo/app',
      isPrimaryProject: true,
      isPrimaryModule: true
    });
    const index = buildResourceReferenceIndex([app, feature]);

    assert.strictEqual(resolveResourceReference(index, 'assets/logo.png', 'C:/demo/packages/feature/lib/page.dart')?.absPath, feature.absPath);
    assert.strictEqual(resolveResourceReference(index, 'assets/logo.png', 'C:/demo/other/lib/page.dart')?.absPath, app.absPath);
  });

  test('returns no links when setting is disabled', () => {
    const state = new ResourceReferenceState(false);
    state.updateItems([
      asset({
        absPath: 'C:/demo/assets/images/logo.png',
        copyToken: 'assets/images/logo.png',
        relPath: 'assets/images/logo.png'
      })
    ]);

    assert.strictEqual(findStaticStringLiterals("'assets/images/logo.png'").length, 1);
    assert.strictEqual(findResourceLinkMatches("'assets/images/logo.png'", state, 'C:/demo/lib/main.dart').length, 0);
  });

  test('document link range covers only the literal content', () => {
    const state = new ResourceReferenceState(true);
    state.updateItems([
      asset({
        absPath: 'C:/demo/assets/images/logo.png',
        copyToken: 'assets/images/logo.png',
        relPath: 'assets/images/logo.png'
      })
    ]);
    const provider = new ResourceDocumentLinkProvider(state);
    const text = "Image.asset('assets/images/logo.png')";
    const document = {
      uri: vscode.Uri.file('C:/demo/lib/main.dart'),
      getText: () => text,
      positionAt: (offset: number) => new vscode.Position(0, offset)
    } as vscode.TextDocument;

    const links = provider.provideDocumentLinks(document);

    assert.strictEqual(links.length, 1);
    assert.strictEqual(links[0].range.start.character, text.indexOf('assets/images/logo.png'));
    assert.strictEqual(links[0].range.end.character, text.indexOf('assets/images/logo.png') + 'assets/images/logo.png'.length);
    assert.strictEqual(links[0].target?.fsPath.replace(/\\/g, '/').toLowerCase(), 'c:/demo/assets/images/logo.png');
  });

  test('definition provider resolves Ctrl click positions inside matching literals', () => {
    const state = new ResourceReferenceState(true);
    state.updateItems([
      asset({
        absPath: 'C:/demo/assets/images/logo.png',
        copyToken: 'assets/images/logo.png',
        relPath: 'assets/images/logo.png'
      })
    ]);
    const provider = new ResourceDefinitionProvider(state);
    const text = "Image.asset('assets/images/logo.png')";
    const document = {
      uri: vscode.Uri.file('C:/demo/lib/main.dart'),
      getText: () => text,
      positionAt: (offset: number) => new vscode.Position(0, offset),
      offsetAt: (position: vscode.Position) => position.character
    } as vscode.TextDocument;

    const definition = provider.provideDefinition(document, new vscode.Position(0, text.indexOf('logo.png'))) as vscode.Location | null;

    assert.strictEqual(definition?.uri.fsPath.replace(/\\/g, '/').toLowerCase(), 'c:/demo/assets/images/logo.png');
  });
});

function asset(overrides: Partial<GalleryAssetItem>): GalleryAssetItem {
  return {
    sourceType: 'flutter_asset',
    platform: 'flutter',
    workspaceKind: 'flutter',
    projectName: 'demo',
    projectPath: 'C:/demo',
    projectRelPath: '.',
    isPrimaryProject: true,
    moduleName: 'app',
    modulePath: 'C:/demo',
    moduleRelPath: '.',
    isPrimaryModule: true,
    groupPath: 'assets',
    copyToken: 'assets/icon.png',
    md5: 'abc123',
    formatFamily: 'png',
    isAnimated: false,
    mediaType: 'image',
    durationMillis: null,
    resourceRootPath: 'C:/demo/assets',
    absPath: 'C:/demo/assets/icon.png',
    relPath: 'assets/icon.png',
    format: 'png',
    width: 24,
    height: 24,
    qualifier: '',
    mtime: 1,
    kind: 'png',
    ...overrides
  };
}
