import * as assert from 'assert';
import * as path from 'path';
import { findMediaInfoExecutable } from '../mediaInfoTool';

suite('media info tooling', () => {
  test('prefers MEDIAINFO_PATH when configured', () => {
    const found = findMediaInfoExecutable(
      {
        MEDIAINFO_PATH: 'D:\\Tools\\MediaInfo\\MediaInfo.exe',
        MEDIAINFO_CLI_PATH: 'D:\\Tools\\MediaInfo\\MediaInfo.exe',
        PATH: 'C:\\Windows\\System32'
      },
      (candidate) => candidate === 'D:\\Tools\\MediaInfo\\MediaInfo.exe',
      () => true,
      'win32',
      () => 'MediaInfoLib - v25.04',
      () => true
    );

    assert.strictEqual(found, 'D:\\Tools\\MediaInfo\\MediaInfo.exe');
  });

  test('finds MediaInfo from PATH on Windows', () => {
    const expected = path.join('D:\\Media', 'MediaInfo.exe');
    const found = findMediaInfoExecutable(
      { PATH: 'C:\\Tools;D:\\Media' },
      (candidate) => candidate === expected,
      () => true,
      'win32',
      () => 'MediaInfoLib - v25.04',
      () => true
    );

    assert.strictEqual(found, expected);
  });

  test('falls back to Windows common install path', () => {
    const expected = 'C:\\Program Files\\MediaInfo CLI\\MediaInfo.exe';
    const found = findMediaInfoExecutable(
      {},
      (candidate) => candidate === expected,
      () => false,
      'win32',
      () => 'MediaInfoLib - v25.04',
      () => true
    );

    assert.strictEqual(found, expected);
  });

  test('ignores MediaInfo GUI candidate that does not answer as CLI', () => {
    const gui = 'D:\\Program Files\\MediaInfo\\MediaInfo.exe';
    const found = findMediaInfoExecutable(
      { MEDIAINFO_PATH: gui },
      (candidate) => candidate === gui,
      () => true,
      'win32',
      () => {
        throw new Error('GUI executable must not be launched for CLI validation');
      },
      () => false
    );

    assert.strictEqual(found, null);
  });
});
