'use strict';

/**
 * Zulu 供给通道：元数据查询的字段映射（真实 API = download_url，WSL 实机取证）与平台映射。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { queryZuluPackages, zuluOs, zuluArch, provisionArch, findJavaExecutable, installZuluPackage } = require('../dist/index.js');

const endpoints = { zuluMetadata: 'https://api.example.test/zulu/packages/' };

function mockFetch(payload, check) {
  return async (url) => {
    if (check) check(url);
    return { ok: true, status: 200, json: async () => payload };
  };
}

test('zuluOs/zuluArch 平台映射', () => {
  assert.equal(zuluOs('win32'), 'win');
  assert.equal(zuluOs('darwin'), 'macos');
  assert.equal(zuluOs('linux'), 'linux');
  assert.equal(zuluArch('x64'), 'x64');
  assert.equal(zuluArch('arm64'), 'aarch64');
  // IA32 Legacy 修复：ia32/x86 → Zulu 32 位构建（旧映射一律 x64，32 位 OS spawn 即挂）
  assert.equal(zuluArch('ia32'), 'x86');
  assert.equal(zuluArch('x86'), 'x86');
});

test('provisionArch：ia32 壳按 WOW64 逃逸变量分真 32 位 OS / 64 位宿主', () => {
  // 真 32 位 OS（Vista/XP x86）：无 PROCESSOR_ARCHITEW6432 → x86
  assert.equal(provisionArch('win32', 'ia32', {}), 'x86');
  // WOW64（64 位 OS 跑 32 位壳）：逃逸变量在场 → x64（32 位壳 spawn 64 位 JVM 合法）
  assert.equal(provisionArch('win32', 'ia32', { PROCESSOR_ARCHITEW6432: 'AMD64' }), 'x64');
  // 其余原样透传
  assert.equal(provisionArch('win32', 'x64', {}), 'x64');
  assert.equal(provisionArch('linux', 'ia32', { PROCESSOR_ARCHITEW6432: 'AMD64' }), 'ia32');
  assert.equal(provisionArch('darwin', 'arm64', {}), 'arm64');
});

test('queryZuluPackages 解析真实 API 的 download_url 字段', async () => {
  // 2026-10-25 api.azul.com 实采形态（截断）：无 url 键，只有 download_url。
  const real = [
    {
      availability_type: 'CA',
      distro_version: [8, 98, 0, 107],
      download_url: 'https://cdn.azul.com/zulu/bin/zulu8.98.0.107-ca-jdk8.0.512-linux_x64.zip',
      filename: 'zulu8.98.0.107-ca-jdk8.0.512-linux_x64.zip',
      name: 'zulu8.98.0.107-ca-jdk8.0.512-linux_x64.zip',
      sha256: 'aa56bbf3',
    },
    {
      download_url: 'https://cdn.azul.com/zulu/bin/zulu8.86.0.25-ca-jdk8.0.442-linux_x64.zip',
      name: 'zulu8.86.0.25-ca-jdk8.0.442-linux_x64.zip',
    },
  ];
  const pkgs = await queryZuluPackages(8, endpoints, mockFetch(real), 'linux', 'x64');
  assert.equal(pkgs.length, 2);
  assert.equal(pkgs[0].url, 'https://cdn.azul.com/zulu/bin/zulu8.98.0.107-ca-jdk8.0.512-linux_x64.zip');
  assert.equal(pkgs[0].sha256, 'aa56bbf3');
  assert.equal('sha256' in pkgs[1], false);
});

test('queryZuluPackages 兼容 url 字段回退、筛掉残缺条目', async () => {
  const payload = [
    { name: 'a.zip', url: 'https://x/a.zip' },
    { name: 'b.zip', download_url: 'https://x/b.zip', url: 'https://stale/b.zip' },
    { name: 'c.zip' },
    { download_url: 'https://x/d.zip' },
  ];
  const pkgs = await queryZuluPackages(8, endpoints, mockFetch(payload), 'linux', 'x64');
  assert.deepEqual(pkgs, [
    { name: 'a.zip', url: 'https://x/a.zip' },
    { name: 'b.zip', url: 'https://x/b.zip' },
  ]);
});

test('queryZuluPackages 查询参数按 os/arch/zip/jdk/ga 组装', async () => {
  let seen = '';
  const fetchImpl = mockFetch([], (url) => { seen = url; });
  const pkgs = await queryZuluPackages(8, endpoints, fetchImpl, 'darwin', 'arm64');
  assert.deepEqual(pkgs, []);
  const u = new URL(seen);
  assert.equal(u.pathname, '/zulu/packages/');
  assert.equal(u.searchParams.get('java_version'), '8');
  assert.equal(u.searchParams.get('os'), 'macos');
  assert.equal(u.searchParams.get('arch'), 'aarch64');
  assert.equal(u.searchParams.get('archive_type'), 'zip');
  assert.equal(u.searchParams.get('java_package_type'), 'jdk');
  assert.equal(u.searchParams.get('release_status'), 'ga');
});

test('queryZuluPackages HTTP 非 2xx 抛错', async () => {
  await assert.rejects(
    queryZuluPackages(8, endpoints, async () => ({ ok: false, status: 422, json: async () => [] }), 'linux', 'x64'),
    /HTTP 422/,
  );
});

// ---------- 供给缓存命中（免重下，WSL 实机取证 2026-10-25） ----------

test('findJavaExecutable：直装 bin/java 命中', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'attic-zulu-java-'));
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  const exe = path.join(root, 'bin', 'java');
  fs.writeFileSync(exe, '');
  assert.equal(findJavaExecutable(root, 'linux'), exe);
});

test('findJavaExecutable：一层子目录（zip 带顶层目录）命中', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'attic-zulu-java-'));
  const nested = path.join(root, 'zulu8.98.0.107-ca-jdk8.0.512-linux_x64');
  fs.mkdirSync(path.join(nested, 'bin'), { recursive: true });
  const exe = path.join(nested, 'bin', 'java');
  fs.writeFileSync(exe, '');
  assert.equal(findJavaExecutable(root, 'linux'), exe);
});

test('findJavaExecutable：两层嵌套（Zulu 实机形态 destRoot/name/name/bin/java）命中', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'attic-zulu-java-'));
  const name = 'zulu8.98.0.107-ca-jdk8.0.512-linux_x64';
  fs.mkdirSync(path.join(root, name, name, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(root, `${name}.zip`), 'zipbytes'); // 残留 zip 干扰项
  const exe = path.join(root, name, name, 'bin', 'java');
  fs.writeFileSync(exe, '');
  assert.equal(findJavaExecutable(root, 'linux'), exe);
});

test('findJavaExecutable：win 找 java.exe；空目录/不存在返回 null', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'attic-zulu-java-'));
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  const exe = path.join(root, 'bin', 'java.exe');
  fs.writeFileSync(exe, '');
  assert.equal(findJavaExecutable(root, 'win32'), exe);
  // 同目录只有 java.exe，posix 平台查 java 不命中
  assert.equal(findJavaExecutable(root, 'linux'), null);
  assert.equal(findJavaExecutable(path.join(root, 'missing'), 'linux'), null);
});

// ---------- 失败清理（2026-11-02 隐性 bug 审计：半套 JDK 幸存 = 供给缓存命中坏 javaPath） ----------

test('installZuluPackage 下载中断：半截 zip 不留存、失败归因照回', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attic-zulu-inst-'));
  const pkg = { name: 'zulu8-test-linux_x64.zip', url: 'https://cdn.azul.com/zulu/bin/zulu8-test-linux_x64.zip' };
  const client = {
    download: async (_url, dest) => {
      fs.writeFileSync(dest, 'HALF-DO'); // 半截文件落盘后才失败（ENOSPC/abort 形态）
      throw new Error('download aborted');
    },
  };
  const out = await installZuluPackage(pkg, dir, { client, platform: 'linux' });
  assert.equal(out.ok, false);
  assert.match(out.reason, /download aborted/);
  assert.ok(!fs.existsSync(path.join(dir, pkg.name)), '半截 zip 已清理（下次供给走全新下载，不依赖覆盖语义）');
  fs.rmSync(dir, { recursive: true, force: true });
});
