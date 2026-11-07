'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { applyUpdate, pickUpdateAsset } = require('../dist/index.js');

const SHA = 'a'.repeat(64);
const ASSETS = [
  { name: 'attic-tauri-windows-x64-0.1.0-setup.exe', url: 'https://github.com/a/b/releases/download/v0.1.0/s.exe', digest: `sha256:${SHA}`, size: 9 },
  { name: 'attic-tauri-windows-x64-0.1.0-portable.zip', url: 'https://github.com/a/b/releases/download/v0.1.0/p.zip', digest: `sha256:${SHA}`, size: 8 },
  { name: 'attic-tauri-windows-arm64-0.1.0-portable.zip', url: 'https://github.com/a/b/releases/download/v0.1.0/p-arm.zip', digest: `sha256:${SHA}`, size: 8 },
];
const REQ = { version: '0.1.0', assets: ASSETS };

function tempInstall(t, { withBat = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attic-apply-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  if (withBat) fs.writeFileSync(path.join(dir, 'attic-update.bat'), '@echo off\r\n');
  return dir;
}

/** 记录型 deps：download/spawn 全桩（断言参数不真起进程）。 */
function makeDeps(over = {}) {
  const calls = { download: [], spawn: [] };
  const deps = {
    platform: 'win32',
    portable: true,
    installDir: undefined,
    root: undefined,
    download: async (url, dest, asset, sha256) => {
      calls.download.push({ url, dest, name: asset.name, sha256 });
    },
    spawnImpl: (command, args) => calls.spawn.push({ command, args }),
    launcherPid: 4242,
    ...over,
  };
  return { deps, calls };
}

test('applyUpdate：非 Windows = unsupported(windows-only)，零下载零 spawn', async () => {
  const { deps, calls } = makeDeps({ platform: 'linux' });
  const res = await applyUpdate(REQ, deps);
  assert.deepEqual(res, { status: 'unsupported', reason: 'windows-only' });
  assert.equal(calls.download.length, 0);
  assert.equal(calls.spawn.length, 0);
});

test('applyUpdate：便携形态 = 选型 portable.zip → 下载 sha256 → spawn 脚本对快路径参数逐字', async (t) => {
  const installDir = tempInstall(t);
  const root = tempInstall(t, { withBat: false });
  const { deps, calls } = makeDeps({ installDir, root });
  const res = await applyUpdate(REQ, deps);
  assert.deepEqual(res, { status: 'spawned', mode: 'portable' });
  assert.equal(calls.download.length, 1);
  assert.equal(calls.download[0].name, 'attic-tauri-windows-x64-0.1.0-portable.zip');
  assert.equal(calls.download[0].sha256, SHA);
  assert.equal(calls.download[0].dest, path.join(root, 'cache', 'update', 'attic-tauri-windows-x64-0.1.0-portable.zip'));
  assert.equal(calls.spawn.length, 1);
  assert.deepEqual(calls.spawn[0], {
    command: 'cmd.exe',
    args: [
      '/d', '/c', path.join(installDir, 'attic-update.bat'),
      '-Zip', calls.download[0].dest,
      '-WaitPid', '4242',
      '-Sha256', SHA,
    ],
  });
});

test('applyUpdate：安装形态 = 选型 setup.exe → spawn 向导（/CURRENTUSER 免提权）', async (t) => {
  const root = tempInstall(t, { withBat: false });
  const { deps, calls } = makeDeps({ portable: false, installDir: root, root });
  const res = await applyUpdate(REQ, deps);
  assert.deepEqual(res, { status: 'spawned', mode: 'installed' });
  assert.equal(calls.download[0].name, 'attic-tauri-windows-x64-0.1.0-setup.exe');
  assert.deepEqual(calls.spawn[0].args, ['/CURRENTUSER']);
});

test('applyUpdate：老便携无脚本对 = unsupported(no-script)，不白下 150MB', async (t) => {
  const installDir = tempInstall(t, { withBat: false });
  const root = tempInstall(t, { withBat: false });
  const { deps, calls } = makeDeps({ installDir, root });
  const res = await applyUpdate(REQ, deps);
  assert.equal(res.status, 'unsupported');
  assert.equal(res.reason, 'no-script');
  assert.equal(calls.download.length, 0, '脚本位探测必须先于下载');
});

test('applyUpdate：digest 缺位 = unsupported(no-digest)（宁走外链不裸装）', async (t) => {
  const installDir = tempInstall(t);
  const root = tempInstall(t, { withBat: false });
  const { deps, calls } = makeDeps({ installDir, root });
  const req = { version: '0.1.0', assets: [{ ...ASSETS[1], digest: '' }] };
  const res = await applyUpdate(req, deps);
  assert.equal(res.status, 'unsupported');
  assert.equal(res.reason, 'no-digest');
  assert.equal(calls.download.length, 0);
});

test('applyUpdate：无匹配构件 = unsupported(no-asset)（全名精确，零模糊）', async (t) => {
  const installDir = tempInstall(t);
  const { deps } = makeDeps({ installDir, root: installDir });
  const res = await applyUpdate({ version: '9.9.9', assets: ASSETS }, deps);
  assert.equal(res.status, 'unsupported');
  assert.equal(res.reason, 'no-asset');
});

test('applyUpdate：下载腿抛错 = error（原地重试语义，不 spawn 不退出）', async (t) => {
  const installDir = tempInstall(t);
  const { deps, calls } = makeDeps({
    installDir,
    root: installDir,
    download: async () => {
      throw new Error('partial stream');
    },
  });
  const res = await applyUpdate(REQ, deps);
  assert.equal(res.status, 'error');
  assert.match(res.message, /partial stream/);
  assert.equal(calls.spawn.length, 0);
});

test('applyUpdate：spawn 抛错 = error（构件已落盘，重试不重下由 .part 语义兜——此处只断不炸）', async (t) => {
  const installDir = tempInstall(t);
  const { deps } = makeDeps({
    installDir,
    root: installDir,
    spawnImpl: () => {
      throw new Error('ELEVATION_REQUIRED');
    },
  });
  const res = await applyUpdate(REQ, deps);
  assert.equal(res.status, 'error');
  assert.match(res.message, /ELEVATION_REQUIRED/);
});

test('pickUpdateAsset：模板逐字对榫（arch/版本/后缀全等才中）', () => {
  assert.equal(pickUpdateAsset(REQ, true, 'x64', '0.1.0').name, 'attic-tauri-windows-x64-0.1.0-portable.zip');
  assert.equal(pickUpdateAsset(REQ, false, 'x64', '0.1.0').name, 'attic-tauri-windows-x64-0.1.0-setup.exe');
  assert.equal(pickUpdateAsset(REQ, true, 'arm64', '0.1.0').name, 'attic-tauri-windows-arm64-0.1.0-portable.zip');
  assert.equal(pickUpdateAsset(REQ, false, 'arm64', '0.1.0'), null, 'arm64 无 setup 条目');
  assert.equal(pickUpdateAsset(REQ, true, 'x86', '0.1.0'), null);
});
