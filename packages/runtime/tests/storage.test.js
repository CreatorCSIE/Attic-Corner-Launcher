'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  resolveDataRoot,
  ensureLayout,
  saveInstance,
  loadInstance,
  listInstances,
  deleteInstance,
  renameInstance,
  scanBinPool,
  scanInstalledInfos,
  scanInstalledJars,
  scanInstalledVersions,
  offlineUuid,
  binDir,
  versionsDir,
  jsonsDir,
  nativesDir,
  instancesDir,
  versionListCacheFile,
  readPropertiesFile,
  readPropertiesFileForMerge,
  loadAccounts,
  saveAccounts,
  setInstanceVersionField,
  setInstanceAddonsField,
  instanceViewFromConfig,
  isPathWithin,
  hasUserData,
  settingsFile,
  settingsFromProps,
  loadSettings,
  AtticRuntime,
} = require('../dist/index.js');
const { buildJarBuffer } = require('./zipFixture.js');

function tempRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attic-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('resolveDataRoot：三平台 + portable + override 优先级', () => {
  const win = resolveDataRoot({ platform: 'win32', env: { APPDATA: 'C:\\Users\\s\\AppData\\Roaming' } });
  assert.equal(win, path.win32.join('C:\\Users\\s\\AppData\\Roaming', '.attic'));

  const linux = resolveDataRoot({ platform: 'linux', env: { HOME: '/home/steve' } });
  assert.equal(linux, '/home/steve/.attic');

  const mac = resolveDataRoot({ platform: 'darwin', env: { HOME: '/Users/steve' } });
  assert.equal(mac, '/Users/steve/Library/Application Support/attic');

  const portable = resolveDataRoot({
    platform: 'win32',
    env: {},
    execPath: 'D:\\Attic\\attic.exe',
    portable: true,
  });
  assert.equal(portable, path.win32.join('D:\\Attic', '.attic'));

  const override = resolveDataRoot({ platform: 'win32', env: {}, rootDirOverride: 'E:\\.betacraft' });
  assert.equal(override, path.resolve('E:\\.betacraft'));
});

test('ensureLayout：目录骨架齐备且幂等', (t) => {
  const root = tempRoot(t);
  ensureLayout(root);
  ensureLayout(root);
  for (const dir of [instancesDir(root), binDir(root), nativesDir(root), versionsDir(root), jsonsDir(root)]) {
    assert.ok(fs.existsSync(dir), `缺目录 ${dir}`);
  }
});

test('实例配置：保存/读回/列出（v1 键集）', (t) => {
  const root = tempRoot(t);
  ensureLayout(root);
  const config = {
    name: 'b1.7.3',
    version: 'b1.7.3',
    gameDir: path.join(root, 'b1.7.3'),
    launchArgs: '-Xmx1G',
    width: 854,
    height: 480,
    proxy: true,
    keepopen: false,
    RPC: true,
    javaPath: 'C:\\Java\\jdk1.8\\bin\\java.exe',
  };
  saveInstance(root, config);
  assert.deepEqual(listInstances(root), ['b1.7.3']);
  assert.deepEqual(loadInstance(root, 'b1.7.3'), config);
  assert.equal(loadInstance(root, '不存在'), null);
});

test('addons 档案回环：逗号串原样保存/读回；空串=显式全关、不写=无键', (t) => {
  const root = tempRoot(t);
  ensureLayout(root);
  saveInstance(root, { name: 'a', version: 'b1.7.3', gameDir: path.join(root, 'a'), addons: 'vsync,skins' });
  assert.equal(loadInstance(root, 'a').addons, 'vsync,skins');
  // 空串必须活过序列化（= 显式全关），不能被当成"没填"丢掉
  saveInstance(root, { name: 'b', version: 'b1.7.3', gameDir: path.join(root, 'b'), addons: '' });
  assert.equal(loadInstance(root, 'b').addons, '');
  saveInstance(root, { name: 'c', version: 'b1.7.3', gameDir: path.join(root, 'c') });
  assert.equal(loadInstance(root, 'c').addons, undefined);
});

test('server 档案回环：原样保存/读回；视图缺席 = 清空删键（javaPath 同语义）；空串视图不携带', (t) => {
  const root = tempRoot(t);
  ensureLayout(root);
  saveInstance(root, { name: 's1', version: 'b1.7.3', gameDir: path.join(root, 's1'), server: 'mc.example.com:25565' });
  assert.equal(loadInstance(root, 's1').server, 'mc.example.com:25565');
  saveInstance(root, { name: 's1', version: 'b1.7.3', gameDir: path.join(root, 's1') });
  assert.equal(loadInstance(root, 's1').server, undefined);
  const base = { name: 'x', version: 'b1.7.3', gameDir: '/g' };
  assert.equal(instanceViewFromConfig({ ...base, server: '' }).server, undefined);
  assert.equal(instanceViewFromConfig({ ...base, server: '1.2.3.4' }).server, '1.2.3.4');
});

test('instanceViewFromConfig：addons 三态（无键 undefined / 空串 [] / trim 切分）', () => {
  const base = { name: 'x', version: 'b1.7.3', gameDir: '/g' };
  assert.equal(instanceViewFromConfig(base).addons, undefined);
  assert.deepEqual(instanceViewFromConfig({ ...base, addons: '' }).addons, []);
  assert.deepEqual(instanceViewFromConfig({ ...base, addons: 'vsync, skins ,bad id' }).addons, ['vsync', 'skins', 'bad id']);
});

test('deleteInstance：默认只删档案；withFiles 连目录；护栏（数据根/共享目录）显式报错', (t) => {
  const root = tempRoot(t);
  ensureLayout(root);
  const mk = (name, gameDir) => {
    saveInstance(root, { name, version: 'b1.7.3', gameDir, launchArgs: '-Xmx1G', width: 854, height: 480 });
    fs.mkdirSync(gameDir, { recursive: true });
    fs.writeFileSync(path.join(gameDir, 'level.dat'), 'x');
  };

  // 不勾（保守缺省）：档案删除、目录数据不动；再删 = false（档案不存在）
  mk('solo', path.join(root, 'solo'));
  assert.equal(deleteInstance(root, 'solo'), true);
  assert.equal(loadInstance(root, 'solo'), null);
  assert.ok(fs.existsSync(path.join(root, 'solo', 'level.dat')));
  assert.equal(deleteInstance(root, 'solo'), false);

  // 勾选：档案与目录一并删除
  mk('gone', path.join(root, 'gone'));
  assert.equal(deleteInstance(root, 'gone', true), true);
  assert.equal(fs.existsSync(path.join(root, 'gone')), false);

  // 护栏 A：gameDir = 数据根本身 → 显式报错，档案保留（报错先于任何删除）
  mk('rooted', root);
  assert.throws(() => deleteInstance(root, 'rooted', true), /数据根/);
  assert.ok(loadInstance(root, 'rooted'));

  // 护栏 B：gameDir 与其他实例共享 → 显式报错，目录与双方档案都不动
  const shared = path.join(root, 'shared-dir');
  mk('a1', shared);
  mk('a2', shared);
  assert.throws(() => deleteInstance(root, 'a1', true), /共享/);
  assert.ok(fs.existsSync(path.join(shared, 'level.dat')));
  assert.ok(loadInstance(root, 'a1') && loadInstance(root, 'a2'));
});

test('renameInstance：v1 语义只迁档案，gameDir 原样带走（改名不动目录）', (t) => {
  const root = tempRoot(t);
  ensureLayout(root);
  const dir = path.join(root, 'my-game');
  saveInstance(root, { name: 'old', version: 'b1.7.3', gameDir: dir, launchArgs: '-Xmx2G', width: 1280, height: 720 });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'level.dat'), 'x');

  const renamed = renameInstance(root, 'old', 'new');
  // 新档案全字段继承，仅 name 变；旧档案消失；目录数据零改动
  assert.equal(renamed.name, 'new');
  assert.equal(renamed.gameDir, dir);
  assert.equal(renamed.version, 'b1.7.3');
  assert.equal(renamed.launchArgs, '-Xmx2G');
  assert.deepEqual(loadInstance(root, 'new'), renamed);
  assert.equal(loadInstance(root, 'old'), null);
  assert.ok(fs.existsSync(path.join(dir, 'level.dat')));

  // 同名 = no-op 返回原档案
  assert.deepEqual(renameInstance(root, 'new', 'new'), renamed);

  // 三类拒绝均显式报错且原档案不动
  saveInstance(root, { name: 'dup', version: 'c0.30', gameDir: path.join(root, 'dup'), launchArgs: '', width: 854, height: 480 });
  assert.throws(() => renameInstance(root, 'new', 'dup'), /已存在/); // 重名
  assert.throws(() => renameInstance(root, 'new', 'a/b'), /不合法/); // 路径分隔符
  assert.throws(() => renameInstance(root, '不存在', 'x'), /不存在/);
  assert.ok(loadInstance(root, 'new'));
});

test('setInstanceVersionField：单字段读-改-写保留其余全部键（v1 遗留键/未知键/键序不动）', (t) => {
  const root = tempRoot(t);
  ensureLayout(root);
  const file = path.join(instancesDir(root), 'sv.txt');
  fs.writeFileSync(
    file,
    'name=sv\nversion=b1.7.3\ngameDir=x\nproxy=true\nkeepopen=true\nconsole=false\nisJavaPathNew=true\nunknownKey=keepme\n',
    'utf8',
  );
  assert.equal(setInstanceVersionField(root, 'sv', 'c0.30'), true);
  const props = readPropertiesFile(file);
  assert.equal(props.version, 'c0.30');
  for (const [k, v] of [
    ['proxy', 'true'],
    ['keepopen', 'true'],
    ['console', 'false'],
    ['isJavaPathNew', 'true'],
    ['unknownKey', 'keepme'],
  ]) {
    assert.equal(props[k], v, `${k} 不得被单字段写回丢失`);
  }
  // version 键原位重写（读-改-写语义：赋已存在键保位置）
  assert.ok(fs.readFileSync(file, 'utf8').split('\n')[1].startsWith('version='));
  // 幂等：同值 = false 且零重写
  const before = fs.readFileSync(file, 'utf8');
  assert.equal(setInstanceVersionField(root, 'sv', 'c0.30'), false);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  // 档案不存在 = false 且不建档
  assert.equal(setInstanceVersionField(root, 'ghost', 'c0.30'), false);
  assert.equal(fs.existsSync(path.join(instancesDir(root), 'ghost.txt')), false);
  // 非法名走与 saveInstance 同闸（路径穿越拒绝）
  assert.throws(() => setInstanceVersionField(root, 'a/b', 'c0.30'), /不合法/);
});

test('setInstanceAddonsField：单字段写回（csv 序列化/空数组=显式全关/幂等/不建档/非法名同闸）', (t) => {
  const root = tempRoot(t);
  ensureLayout(root);
  const file = path.join(instancesDir(root), 'ad.txt');
  fs.writeFileSync(file, 'name=ad\nversion=b1.7.3\nproxy=true\nunknownKey=keepme\n', 'utf8');
  assert.equal(setInstanceAddonsField(root, 'ad', ['fullscreen', 'quitgame']), true);
  let props = readPropertiesFile(file);
  assert.equal(props.addons, 'fullscreen,quitgame');
  assert.equal(props.proxy, 'true', 'addons 单字段写不得丢 v1 遗留键');
  assert.equal(props.unknownKey, 'keepme', '未知键不得被动');
  // 空数组 = 显式全关：写空串键（区别于无键的 legacyfix 缺省开集）
  assert.equal(setInstanceAddonsField(root, 'ad', []), true);
  props = readPropertiesFile(file);
  assert.equal(props.addons, '');
  // 幂等：同值 = false 且零重写
  const before = fs.readFileSync(file, 'utf8');
  assert.equal(setInstanceAddonsField(root, 'ad', []), false);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  // 档案不存在 = false 且不建档；非法名同闸
  assert.equal(setInstanceAddonsField(root, 'ghost', ['x']), false);
  assert.equal(fs.existsSync(path.join(instancesDir(root), 'ghost.txt')), false);
  assert.throws(() => setInstanceAddonsField(root, 'a/b', ['x']), /不合法/);
});

test('saveInstance：properties 级合并写回（未知键保留、undefined 删键、既有键原位不重排）', (t) => {
  const root = tempRoot(t);
  ensureLayout(root);
  const file = path.join(instancesDir(root), 'mg.txt');
  fs.writeFileSync(file, 'name=mg\nversion=b1.7.3\ngameDir=g\nlaunchArgs=-Xmx9G\nproxy=true\nfutureKey=42\n', 'utf8');
  // 托管键给值 = 原位覆盖；proxy 随 config 带走；托管集之外的未知键零触碰
  saveInstance(root, { name: 'mg', version: 'c2.0', gameDir: 'g', launchArgs: '-Xmx2G', proxy: true });
  const props = readPropertiesFile(file);
  assert.equal(props.version, 'c2.0');
  assert.equal(props.launchArgs, '-Xmx2G');
  assert.equal(props.proxy, 'true');
  assert.equal(props.futureKey, '42', '未知键不得被整档案保存丢失');
  // config 未带（undefined）的托管键 = 删键（视图字段清空语义）；未知键仍不动
  saveInstance(root, { name: 'mg', version: 'c2.0', gameDir: 'g', launchArgs: '-Xmx2G' });
  const props2 = readPropertiesFile(file);
  assert.equal(props2.proxy, undefined);
  assert.equal(props2.futureKey, '42');
  // 读-改-写不重排：name 仍是首行
  assert.ok(fs.readFileSync(file, 'utf8').startsWith('name=mg'));
});

test('runtime.saveInstance：视图不携带的 v1 遗留键经档案底稿带走（实例页保存不丢 proxy）', (t) => {
  const root = tempRoot(t);
  ensureLayout(root);
  const rt = new AtticRuntime({ rootDir: root, fetchImpl: () => Promise.reject(new Error('offline')) });
  const file = path.join(instancesDir(root), 'sv.txt');
  fs.writeFileSync(
    file,
    'name=sv\nversion=b1.7.3\ngameDir=g\nproxy=true\nkeepopen=false\nRPC=true\nconsole=true\nisJavaPathNew=true\nfutureKey=42\n',
    'utf8',
  );
  rt.saveInstance({ name: 'sv', version: 'c2.0', width: 1024 });
  const raw = readPropertiesFile(file);
  assert.equal(raw.version, 'c2.0');
  assert.equal(raw.width, '1024');
  assert.equal(raw.gameDir, 'g', 'view 不带 gameDir → 既有落位保留');
  for (const [k, v] of [
    ['proxy', 'true'],
    ['keepopen', 'false'],
    ['RPC', 'true'],
    ['console', 'true'],
    ['isJavaPathNew', 'true'],
  ]) {
    assert.equal(raw[k], v, `${k} 不得被实例页保存静默丢失`);
  }
  assert.equal(raw.futureKey, '42');
});

test('runtime.setInstanceVersion：选中即落盘，name 空回落默认实例建档，只动 version', (t) => {
  const root = tempRoot(t);
  ensureLayout(root);
  const rt = new AtticRuntime({ rootDir: root, fetchImpl: () => Promise.reject(new Error('offline')) });
  // 无档案场景（UI 无激活实例）：null → 默认实例按 v1 缺省建档后立即写入选中版本
  const created = rt.setInstanceVersion(null, 'c2.0');
  assert.equal(created.name, 'default instance');
  assert.equal(created.version, 'c2.0');
  const def = loadInstance(root, 'default instance');
  assert.equal(def.version, 'c2.0');
  assert.equal(def.gameDir, path.join(root, 'default instance'));
  assert.equal(def.launchArgs, '-Xmx1G', '建档走 v1 缺省集');
  // 既有实例：视图可表达字段不被抹掉；视图携带不了的 v1 遗留键（proxy 等）也不被写回丢失
  rt.saveInstance({ name: 'keep', version: 'b1.7.3', width: 1234 });
  const keepFile = path.join(instancesDir(root), 'keep.txt');
  fs.appendFileSync(keepFile, 'proxy=true\nunknownKey=keepme\n', 'utf8');
  const view = rt.setInstanceVersion('keep', 'c0.30_04');
  assert.equal(view.version, 'c0.30_04');
  assert.equal(view.width, 1234);
  const raw = readPropertiesFile(keepFile);
  assert.equal(raw.version, 'c0.30_04');
  assert.equal(raw.width, '1234');
  assert.equal(raw.proxy, 'true');
  assert.equal(raw.unknownKey, 'keepme');
  // 幂等：重选同版 = 视图不变、档案不重写
  assert.deepEqual(rt.setInstanceVersion('keep', 'c0.30_04'), view);
});

test('runtime.setInstanceAddons：勾选即落盘，name 空回落默认实例，只动 addons 键', (t) => {
  const root = tempRoot(t);
  ensureLayout(root);
  const rt = new AtticRuntime({ rootDir: root, fetchImpl: () => Promise.reject(new Error('offline')) });
  // 无档案场景：null → 默认实例建档 + 勾选集落键；返回视图携带权威 addons
  const created = rt.setInstanceAddons(null, ['fullscreen']);
  assert.equal(created.name, 'default instance');
  assert.deepEqual(created.addons, ['fullscreen']);
  assert.equal(loadInstance(root, 'default instance').addons, 'fullscreen');
  // 既有实例：只动 addons——version/width/遗留键零触碰；空集回环 = []（显式全关不被吞）
  rt.saveInstance({ name: 'keep2', version: 'b1.7.3', width: 800, addons: ['fullscreen'] });
  const f2 = path.join(instancesDir(root), 'keep2.txt');
  fs.appendFileSync(f2, 'proxy=true\n', 'utf8');
  const view = rt.setInstanceAddons('keep2', []);
  assert.deepEqual(view.addons, []);
  assert.equal(view.width, 800);
  const raw = readPropertiesFile(f2);
  assert.equal(raw.addons, '');
  assert.equal(raw.version, 'b1.7.3');
  assert.equal(raw.width, '800');
  assert.equal(raw.proxy, 'true');
  // 幂等：同集重勾 = 视图不变、档案不重写
  assert.deepEqual(rt.setInstanceAddons('keep2', []), view);
});

test('实例解耦（v1 语义）：gameDir=root/<实例名>，首启自动建 default instance，切版本目录不变', async (t) => {
  const root = tempRoot(t);
  ensureLayout(root);
  // 官方词表：b1.7.3/c2.0 的线上 .info 均为 launch-method=indev（2026-10 实测，见 info.test.js 夹具）
  fs.writeFileSync(path.join(jsonsDir(root), 'b1.7.3.info'), 'launch-method=indev\n');
  fs.writeFileSync(path.join(jsonsDir(root), 'c2.0.info'), 'launch-method=indev\n');
  fs.writeFileSync(path.join(jsonsDir(root), 'c0.0.15a.info'), 'launch-method=Classic15aWithSaving\n');
  const rt = new AtticRuntime({ rootDir: root, fetchImpl: () => Promise.reject(new Error('offline')) });
  rt.addAccount('Tester'); // 无默认账户回落：启动前需显式建档
  const java = 'C:\\Java\\jdk1.8\\bin\\java.exe';

  const cfg = await rt.dryRunLaunch({ versionId: 'b1.7.3', javaPath: java });
  assert.equal(cfg.gameDir, path.join(root, 'default instance'));
  assert.ok(fs.existsSync(path.join(instancesDir(root), 'default instance.txt')), '首启应自动建档 default instance');

  // v1 newInstance 缺省：老档案缺 width/height/launchArgs 也拿到 854x480 / -Xmx1G（而非 640x480 兜底）
  const def = loadInstance(root, 'default instance');
  assert.equal(def.width, 854);
  assert.equal(def.height, 480);
  assert.equal(def.launchArgs, '-Xmx1G');
  assert.ok(cfg.jvmArgs.includes('-Xmx1G'));
  // Applet 容器：实例窗口尺寸以 --width/--height 游戏参数注入 gameArgs 末尾（v1 Wrapper 面板尺寸语义）
  const cfgApplet = await rt.dryRunLaunch({ versionId: 'c0.0.15a', javaPath: java });
  assert.deepEqual(cfgApplet.gameArgs.slice(-4), ['--width', '854', '--height', '480']);

  // 同实例切版本：gameDir 不变（存档共享），目录不随版本漂移
  const cfg2 = await rt.dryRunLaunch({ versionId: 'c2.0', javaPath: java });
  assert.equal(cfg2.gameDir, cfg.gameDir);

  // saveInstance：v1 可编辑集全字段往返；gameDir 缺省按实例名派生
  rt.saveInstance({ name: '我的包', version: 'b1.7.3', width: 1024, height: 768, launchArgs: '-Xmx2G' });
  const mine = loadInstance(root, '我的包');
  assert.equal(mine.gameDir, path.join(root, '我的包'));
  assert.equal(mine.width, 1024);
  assert.equal(mine.height, 768);
  assert.equal(mine.launchArgs, '-Xmx2G');
});

test('intelFix/forceUpdate：档案回环 + 视图透传 + win32 门控注入/非 Windows 恒不注入', async (t) => {
  const root = tempRoot(t);
  ensureLayout(root);
  fs.writeFileSync(path.join(jsonsDir(root), 'b1.7.3.info'), 'launch-method=indev\n');
  const rt = new AtticRuntime({ rootDir: root, platform: 'win32', fetchImpl: () => Promise.reject(new Error('offline')) });
  rt.addAccount('Tester');
  const java = 'C:\\Java\\jdk1.8\\bin\\java.exe';

  // v1 缺键缺省=开：新建实例无 intelFix 键 → win32 下 jvmArgs 首位注入（v1 Launcher.java 语义）
  const cfgDef = await rt.dryRunLaunch({ versionId: 'b1.7.3', instanceId: 'iw', javaPath: java });
  assert.equal(cfgDef.jvmArgs[0], '-XX:HeapDumpPath=java.exe_minecraft.exe.heapdump');

  // 显式关：视图 → 档案 → 上下文链路上键即停注入；forceUpdate=true 落档案
  rt.saveInstance({ name: 'iw', version: 'b1.7.3', intelFix: false, forceUpdate: true });
  const view = rt.listInstances().find((i) => i.name === 'iw');
  assert.equal(view.intelFix, false);
  assert.equal(view.forceUpdate, true);
  const cfgOff = await rt.dryRunLaunch({ versionId: 'b1.7.3', instanceId: 'iw', javaPath: java });
  assert.ok(!cfgOff.jvmArgs.some((a) => a.includes('HeapDumpPath')));
  assert.equal(loadInstance(root, 'iw').forceUpdate, true, 'forceUpdate 应落档案键');
  // 只关 intelFix 不写 forceUpdate：缺键回落视图（UI 按缺省关展示）
  rt.saveInstance({ name: 'iw2', version: 'b1.7.3', intelFix: false });
  const v2 = rt.listInstances().find((i) => i.name === 'iw2');
  assert.equal(v2.intelFix, false);
  assert.equal(v2.forceUpdate, undefined);

  // 非 win32 宿主：intelFix 缺键（=v1 开）也恒不注入（v1 OS.isWindows 门控）
  const rtLx = new AtticRuntime({ rootDir: root, platform: 'linux', fetchImpl: () => Promise.reject(new Error('offline')) });
  const cfgLx = await rtLx.dryRunLaunch({ versionId: 'b1.7.3', instanceId: 'iw3', javaPath: '/usr/bin/java' });
  assert.ok(!cfgLx.jvmArgs.some((a) => a.includes('HeapDumpPath')));
});

test('launch() 入口回写：启动失败也已落盘建档+版本（实例列表延迟修复的宿主侧契约）', async (t) => {
  const root = tempRoot(t);
  ensureLayout(root);
  const rt = new AtticRuntime({ rootDir: root, platform: 'win32', fetchImpl: () => Promise.reject(new Error('offline')) });
  rt.addAccount('Tester');
  const java = 'C:\\Java\\jdk1.8\\bin\\java.exe';
  // 离线 fetch 使 refreshVersionInfo（launch 首个 await）抛错——但回写落在其前的同步段，
  // UI 端点启动后立即可见新实例（IPC FIFO），不必等下载/游戏进程起来。
  await assert.rejects(rt.launch({ versionId: 'c0.0.15a', javaPath: java }), /offline/);
  assert.equal(loadInstance(root, 'default instance').version, 'c0.0.15a', '新档案版本=启动请求（非建档缺省 b1.7.3）');
  assert.ok(rt.listInstances().some((i) => i.name === 'default instance'));
  // 既有实例切版本：gameDir 不变（存档共享），可编辑字段不被回写抹掉
  rt.saveInstance({ name: 'fast', version: 'b1.7.3', width: 640 });
  const gameDirBefore = loadInstance(root, 'fast').gameDir;
  await assert.rejects(rt.launch({ versionId: 'c2.0', instanceId: 'fast', javaPath: java }), /offline/);
  const switched = loadInstance(root, 'fast');
  assert.equal(switched.version, 'c2.0');
  assert.equal(switched.gameDir, gameDirBefore);
  assert.equal(switched.width, 640);
});

test('LaunchRequest.visualizer：dryRun 链路注入 -Dlf.visualizer 且不写实例档案', async (t) => {
  const root = tempRoot(t);
  ensureLayout(root);
  fs.writeFileSync(path.join(jsonsDir(root), 'b1.7.3.info'), 'launch-method=indev\n');
  const rt = new AtticRuntime({ rootDir: root, fetchImpl: () => Promise.reject(new Error('offline')) });
  rt.addAccount('Tester');
  const cfg = await rt.dryRunLaunch({ versionId: 'b1.7.3', instanceId: 'iv', javaPath: '/usr/bin/java', visualizer: true });
  assert.ok(cfg.jvmArgs.includes('-Dlf.visualizer'));
  // 一次性语义：dryRun 不落 addons 键（档案压根没建 = 无键）
  rt.saveInstance({ name: 'iv', version: 'b1.7.3' });
  const cfg2 = await rt.dryRunLaunch({ versionId: 'b1.7.3', instanceId: 'iv', javaPath: '/usr/bin/java' });
  assert.ok(!cfg2.jvmArgs.includes('-Dlf.visualizer'), '不带键 = 不注入');
  assert.equal(loadInstance(root, 'iv').addons, undefined, 'visualizer 启动请求不得写档案 addons');
});

test('probeVersionClass：jar 条目探测 + 未安装=false + mtime 换代缓存失效', (t) => {
  const root = tempRoot(t);
  ensureLayout(root);
  const rt = new AtticRuntime({ rootDir: root, fetchImpl: () => Promise.reject(new Error('offline')) });
  const ISOM = 'net/minecraft/isom/IsomPreviewApplet.class';
  assert.equal(rt.probeVersionClass('pv', ISOM), false, 'jar 不在 = false');
  fs.writeFileSync(
    path.join(versionsDir(root), 'pv.jar'),
    buildJarBuffer(['net.minecraft.isom.IsomPreviewApplet', 'net.minecraft.client.MinecraftApplet']),
  );
  assert.equal(rt.probeVersionClass('pv', ISOM), true);
  assert.equal(rt.probeVersionClass('pv', 'net/minecraft/client/Minecraft.class'), false);
  // 换 jar（forceUpdate 重下/修复场景）：mtime 前移逼缓存失效，不得读到旧条目清单
  const jar = path.join(versionsDir(root), 'pv.jar');
  fs.writeFileSync(jar, buildJarBuffer(['net.minecraft.client.MinecraftApplet']));
  const st = fs.statSync(jar);
  fs.utimesSync(jar, st.atime, new Date(st.mtimeMs + 10_000));
  assert.equal(rt.probeVersionClass('pv', ISOM), false);
});

test('扫描：bin 库池与已安装版本并集', (t) => {
  const root = tempRoot(t);
  ensureLayout(root);
  fs.writeFileSync(path.join(binDir(root), 'lwjgl-2.9.4.jar'), 'x');
  fs.writeFileSync(path.join(binDir(root), 'launchwrapper-1.12.jar'), 'x');
  fs.writeFileSync(path.join(binDir(root), 'notes.txt'), 'x');
  fs.writeFileSync(path.join(versionsDir(root), 'b1.7.3.jar'), 'x');
  fs.writeFileSync(path.join(jsonsDir(root), 'c2.0.info'), 'x');
  fs.writeFileSync(path.join(jsonsDir(root), 'b1.7.3.info'), 'x');

  assert.deepEqual(scanBinPool(root), [
    path.join(binDir(root), 'launchwrapper-1.12.jar'),
    path.join(binDir(root), 'lwjgl-2.9.4.jar'),
  ]);
  assert.deepEqual(scanInstalledVersions(root), ['b1.7.3', 'c2.0']);
  // "已安装"徽标真相源 = jar 实存：仅有 .info 的 c2.0 不算安装（用户指定）
  assert.deepEqual(scanInstalledJars(root), ['b1.7.3']);
  assert.deepEqual(scanInstalledInfos(root), ['b1.7.3', 'c2.0']);
});

test('custom 语义（v1）：列表打标 + 裸 jar 检测合成 + Error 7 + 4k --appletClass', async (t) => {
  const root = tempRoot(t);
  ensureLayout(root);
  fs.writeFileSync(path.join(versionsDir(root), 'b1.7.3.jar'), buildJarBuffer([]));
  fs.writeFileSync(path.join(jsonsDir(root), 'b1.7.3.info'), 'launch-method=indev\n');
  // 裸 jar（有 jar 无 .info，classic 形态类）= custom（v1 offlineVersionList 语义）
  fs.writeFileSync(
    path.join(versionsDir(root), 'myver.jar'),
    buildJarBuffer(['com.mojang.minecraft.MinecraftApplet']),
  );
  // 无类可检测的裸 jar → Error 7 指引
  fs.writeFileSync(path.join(versionsDir(root), 'emptyver.jar'), buildJarBuffer(['com.example.Nothing']));
  // .info 显式声明 custom=true（无 jar：未安装但 custom）
  fs.writeFileSync(path.join(jsonsDir(root), 'declared.info'), 'launch-method=indev\ncustom=true\n');
  fs.writeFileSync(path.join(jsonsDir(root), '4k-021742.info'), 'launch-method=4k\n');

  const rt = new AtticRuntime({ rootDir: root, fetchImpl: () => Promise.reject(new Error('offline')) });
  // 离线兜底：远端失败 → 读缓存清单。myver 不在官方清单（用户导入 jar 的真实形态）——
  // 若在官方 id 内则裸 jar 不判 custom（inf-20100227-1433 修复语义，见 customVersions.test.js）
  fs.writeFileSync(
    versionListCacheFile(root),
    JSON.stringify({
      generatedAt: Date.now(),
      versions: [{ id: 'b1.7.3', repository: 'betacraft', installed: false }],
    }),
  );
  const java = 'C:\\Java\\jdk1.8\\bin\\java.exe';
  rt.addAccount('Tester'); // 无默认账户回落：启动前需显式建档

  const list = await rt.listVersions();
  const byId = Object.fromEntries(list.map((v) => [v.id, v]));
  assert.equal(byId['b1.7.3'].custom, undefined, 'jar+info 齐备 = 干净原版');
  assert.equal(byId['myver'].custom, true, '裸 jar = custom');
  assert.equal(byId['myver'].installed, true);
  assert.equal(byId['declared'].custom, true, '.info 声明 custom=true');
  assert.equal(byId['declared'].installed, false);
  assert.equal(byId['emptyver'].custom, true);

  // 裸 jar 启动：远端 404/离线 → 类检测合成（classic → AppletLauncher 容器）
  const cfgMy = await rt.dryRunLaunch({ versionId: 'myver', javaPath: java });
  assert.equal(cfgMy.mainClass, 'uk.betacraft.legacyfix.applet.AppletLauncher');
  // 检测失败 = Error 7 语义：显式报错并指引手编 .info
  await assert.rejects(rt.dryRunLaunch({ versionId: 'emptyver', javaPath: java }), /Error 7/);
  // 4k：显式启动方法数据路径（不依赖检测），gameArgs 末尾注入 --appletClass M
  const cfg4k = await rt.dryRunLaunch({ versionId: '4k-021742', javaPath: java });
  assert.deepEqual(cfg4k.gameArgs.slice(-2), ['--appletClass', 'M']);
});

test('indev 混代（用户报障修复）：按本地 jar 探测选主类——仅 Applet → AppletLauncher 容器', async (t) => {
  const root = tempRoot(t);
  ensureLayout(root);
  const INDEV_APPLET = 'net.minecraft.client.MinecraftApplet';
  const INDEV_MAIN = 'net.minecraft.client.Minecraft';
  fs.writeFileSync(path.join(jsonsDir(root), 'in-20100223.info'), 'launch-method=indev\n');
  fs.writeFileSync(path.join(jsonsDir(root), 'b-mix.info'), 'launch-method=indev\n');
  // 早期 indev 形态：仅 MinecraftApplet（无 main）→ 容器
  fs.writeFileSync(path.join(versionsDir(root), 'in-20100223.jar'), buildJarBuffer([INDEV_APPLET]));
  // beta+ 形态：两类齐备 → 维持 Minecraft 主类直启（不回归）
  fs.writeFileSync(path.join(versionsDir(root), 'b-mix.jar'), buildJarBuffer([INDEV_MAIN, INDEV_APPLET]));

  const rt = new AtticRuntime({ rootDir: root, fetchImpl: () => Promise.reject(new Error('offline')) });
  rt.addAccount('Tester'); // 无默认账户回落：启动前需显式建档
  const java = 'C:\\Java\\jdk1.8\\bin\\java.exe';

  const cfgApplet = await rt.dryRunLaunch({ versionId: 'in-20100223', javaPath: java });
  assert.equal(cfgApplet.mainClass, 'uk.betacraft.legacyfix.applet.AppletLauncher');
  // 容器形态：AppletFrame 尺寸参数注入（--width/--height 归 gameArgs 末尾）
  assert.deepEqual(cfgApplet.gameArgs.slice(-4), ['--width', '854', '--height', '480']);

  const cfgMain = await rt.dryRunLaunch({ versionId: 'b-mix', javaPath: java });
  assert.equal(cfgMain.mainClass, 'net.minecraft.client.Minecraft');
});

test('offlineUuid：确定性 + MC 离线格式（version 3 / variant 2）', () => {
  const a = offlineUuid('steve');
  assert.equal(a, offlineUuid('steve'));
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-3[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('listVersions SWR（首帧空窗修复）：缓存在即返回不等网络，后台刷新落新缓存', async (t) => {
  const root = tempRoot(t);
  ensureLayout(root);
  fs.writeFileSync(
    versionListCacheFile(root),
    JSON.stringify({ generatedAt: 1, versions: [{ id: 'b1.7.3', repository: 'betacraft', installed: false }] }),
  );
  // 手动闸门的 fetch：网络永不自动返回——旧策略（永远 await 网络）下本测试会挂死；
  // SWR 下 listVersions 必须先 resolve（= 首帧不等网络的语义断言）
  let releaseFetch;
  const fetchImpl = () =>
    new Promise((resolve) => {
      releaseFetch = () =>
        resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve('b1.7.3``1310110334000`1310110334000\nb2.0``1310110334001`1310110334001\n'),
        });
    });
  const rt = new AtticRuntime({ rootDir: root, platform: 'win32', fetchImpl });

  const list = await rt.listVersions();
  assert.ok(
    list.some((v) => v.id === 'b1.7.3'),
    '缓存版本即时可见',
  );
  assert.ok(!list.some((v) => v.id === 'b2.0'), '未释放网络前返回的是旧缓存');

  releaseFetch();
  await new Promise((r) => setTimeout(r, 25));
  const cache = JSON.parse(fs.readFileSync(versionListCacheFile(root), 'utf8'));
  assert.ok(cache.generatedAt > 1, '后台刷新已落新缓存');
  assert.ok(
    cache.versions.some((v) => v.id === 'b2.0'),
    '新清单项在下一次拉取生效（最终一致）',
  );
});

// ---------- 首启欢迎向导三重门（数据面契约测试） ----------

test('isPathWithin：win32 大小写不敏感、包含自身、兄弟前缀不误判；POSIX 原样', () => {
  // 安装目录护栏的底层谓词：卸载器 {app} 整删射程判定共用。
  assert.equal(isPathWithin('C:\\Programs\\Attic', 'C:\\Programs\\Attic\\.attic', 'win32'), true);
  assert.equal(isPathWithin('C:\\Programs\\Attic', 'c:\\programs\\attic\\sub\\data', 'win32'), true, 'win32 大小写不敏感');
  assert.equal(isPathWithin('C:\\Programs\\Attic', 'C:\\Programs\\Attic', 'win32'), true, '相等算命中');
  assert.equal(isPathWithin('C:\\Programs\\Attic', 'C:\\Programs\\AtticX', 'win32'), false, '兄弟目录前缀不误判');
  assert.equal(isPathWithin('C:\\Programs\\Attic', 'C:\\Users\\me\\.attic', 'win32'), false);
  assert.equal(isPathWithin('/opt/attic', '/opt/attic/.attic', 'linux'), true);
  assert.equal(isPathWithin('/opt/attic', '/opt/atticX', 'linux'), false);
  assert.equal(isPathWithin('/opt/Attic', '/opt/attic/data', 'linux'), false, 'POSIX 大小写敏感');
});

test('hasUserData：骨架不误判（ensureLayout 后仍 false）；文件标记 = 有数据（B 期修复口径）', (t) => {
  const base = tempRoot(t);
  assert.equal(hasUserData(path.join(base, 'nope')), false, '缺目录 = 未初始化');
  const empty = path.join(base, 'empty');
  fs.mkdirSync(empty, { recursive: true });
  assert.equal(hasUserData(empty), false, '空目录 = 未初始化');
  ensureLayout(empty);
  assert.equal(hasUserData(empty), false, 'ensureLayout 骨架 = 纯目录零文件，不得冒充老用户');
  fs.writeFileSync(settingsFile(empty), 'x=1');
  assert.equal(hasUserData(empty), true, 'launcher.settings = 真实数据');
  const inst = path.join(base, 'inst');
  fs.mkdirSync(instancesDir(inst), { recursive: true });
  fs.writeFileSync(path.join(instancesDir(inst), 'default instance.txt'), 'version=b1.7.3');
  assert.equal(hasUserData(inst), true, '任一实例档案 = 真实数据');
  const jar = path.join(base, 'jarred');
  ensureLayout(jar);
  fs.writeFileSync(path.join(versionsDir(jar), 'b1.7.3.jar'), 'x');
  assert.equal(hasUserData(jar), true, 'versions 顶层游戏 jar = 真实数据');
  const pool = path.join(base, 'pooled');
  ensureLayout(pool);
  fs.writeFileSync(path.join(binDir(pool), 'lwjgl.jar'), 'x');
  assert.equal(hasUserData(pool), true, 'bin 顶层库池 jar = 真实数据');
  assert.equal(hasUserData(path.join(base, 'nope2')), false, '读失败 = false 保守方向');
  const crumbs = path.join(base, 'crumbs');
  fs.mkdirSync(path.dirname(settingsFile(crumbs)), { recursive: true });
  fs.writeFileSync(settingsFile(crumbs), 'lastPortableRoot=D\\:\\\\p\nportableFallback=true');
  assert.equal(hasUserData(crumbs), false, '纯便携登记簿 = 机器生成面包屑，非用户数据（安装版向导不被压）');
  fs.writeFileSync(settingsFile(crumbs), 'lastPortableRoot=D\\:\\\\p\nwizardDone=true');
  assert.equal(hasUserData(crumbs), true, '任一登记簿外键 = 有数据');
});

test('setSettings 护栏：rootOverride 落在安装目录内 = 显式报错（文案含实际动作+出路）；目录外正常写入', (t) => {
  const base = tempRoot(t);
  const installDir = path.join(base, 'Programs', 'Attic Launcher');
  fs.mkdirSync(installDir, { recursive: true });
  const rt = new AtticRuntime({
    rootDir: path.join(base, 'data'),
    platform: process.platform,
    fetchImpl: () => Promise.reject(new Error('offline')),
    installDir,
  });
  // 命中射程：拒绝，且文案带"卸载"动作与 portable 出路（微文案戒律的机器闸）
  assert.throws(
    () => rt.setSettings({ rootOverride: path.join(installDir, '.attic') }),
    (e) => e.message.includes('卸载') && e.message.includes('portable'),
  );
  // 相等场景同样拒绝
  assert.throws(() => rt.setSettings({ rootOverride: installDir }), /卸载/);
  // 射程外正常：写入并回读一致
  const outside = path.join(base, 'games', 'attic-data');
  const saved = rt.setSettings({ rootOverride: outside });
  assert.equal(saved.rootOverride, outside);
  assert.equal(settingsFromProps(loadSettings(rt.root)).rootOverride, outside);
  // 不传 installDir = 无护栏（测试/程序化场景不设闸）
  const free = new AtticRuntime({ rootDir: path.join(base, 'free'), platform: process.platform, fetchImpl: () => Promise.reject(new Error('offline')) });
  assert.equal(free.setSettings({ rootOverride: installDir }).rootOverride, installDir);
});

test('getSystemInfo：defaultRoot 恒为平台默认根（不随 rootOverride/portable 漂移），populated 如实', (t) => {
  const base = tempRoot(t);
  const override = path.join(base, 'elsewhere');
  const rt = new AtticRuntime({
    rootDir: override,
    platform: process.platform,
    env: { APPDATA: path.join(base, 'appdata'), HOME: path.join(base, 'home') },
    fetchImpl: () => Promise.reject(new Error('offline')),
  });
  const info = rt.getSystemInfo();
  assert.equal(info.dataRoot, path.resolve(override));
  // 默认根 = 平台默认位（win32=APPDATA/.attic，其余 HOME/.attic 或 macOS Application Support）
  assert.notEqual(info.defaultRoot, info.dataRoot, '指针生效不得改写默认根参照位');
  assert.equal(info.defaultRootPopulated, false, '默认根未建 = 未初始化（三重门之二成立）');
  fs.mkdirSync(info.defaultRoot, { recursive: true });
  ensureLayout(info.defaultRoot);
  assert.equal(rt.getSystemInfo().defaultRootPopulated, false, '骨架目录不算既有数据（B 期修复口径：新机首启必弹的成立面）');
  fs.writeFileSync(settingsFile(info.defaultRoot), 'x=1');
  assert.equal(rt.getSystemInfo().defaultRootPopulated, true, '既有数据 = 老用户，保守不弹');
});

test('手动 javaPath 双形态（向导「指定 Java 目录」2026-11-01）：JDK 目录解析 bin/java；目录没 java 显式报错不静默回落；exe 形态原样', async (t) => {
  const root = tempRoot(t);
  ensureLayout(root);
  fs.writeFileSync(path.join(jsonsDir(root), 'b1.7.3.info'), 'launch-method=indev\n');
  const rt = new AtticRuntime({ rootDir: root, fetchImpl: () => Promise.reject(new Error('offline')) });
  rt.addAccount('Tester');
  const binary = process.platform === 'win32' ? 'java.exe' : 'java';
  // 目录形态：向下找 bin/java（至多两层，findJavaExecutable 同款）
  const jdk = path.join(root, 'jdk-picked');
  fs.mkdirSync(path.join(jdk, 'bin'), { recursive: true });
  const exe = path.join(jdk, 'bin', binary);
  fs.writeFileSync(exe, '', 'utf8');
  rt.setSettings({ javaPath: jdk });
  assert.equal((await rt.dryRunLaunch({ versionId: 'b1.7.3' })).javaPath, exe);
  // exe 形态原样（旧语义不动）
  rt.setSettings({ javaPath: exe });
  assert.equal((await rt.dryRunLaunch({ versionId: 'b1.7.3' })).javaPath, exe);
  // 目录里没 java = 启动面显式报错（用户指定过位置，不得探测另选更错的）
  const bare = path.join(root, 'jdk-empty');
  fs.mkdirSync(bare, { recursive: true });
  rt.setSettings({ javaPath: bare });
  await assert.rejects(rt.dryRunLaunch({ versionId: 'b1.7.3' }), /bin\/java/);
});

// ---------- 合并写回底稿严格读（2026-11-02 隐性 bug 审计：宽容读回 {} 当底稿 = 整档覆盖丢键） ----------

test('readPropertiesFileForMerge：缺席={}（新建语义）；读失败（EISDIR）=抛——宽容读只留纯展示面', (t) => {
  const root = tempRoot(t);
  const file = settingsFile(root);
  assert.deepEqual(readPropertiesFileForMerge(file), {}, '缺席必须走新建底稿，不抛');
  fs.mkdirSync(file, { recursive: true }); // 目录顶替文件：readFileSync = EISDIR
  assert.deepEqual(readPropertiesFile(file), {}, '宽容读语义不变（纯读展示兜底）');
  assert.throws(() => readPropertiesFileForMerge(file), /EISDIR/);
});

test('saveInstance：实例档案不可读（EISDIR）= 抛且拒写回（空底稿整档覆盖丢 v1 遗留键的路被掐死）', (t) => {
  const root = tempRoot(t);
  const locked = path.join(instancesDir(root), 'locked.txt');
  fs.mkdirSync(locked, { recursive: true });
  assert.throws(
    () => saveInstance(root, { name: 'locked', version: 'b1.7.3', gameDir: root }),
    /EISDIR/,
  );
  assert.ok(fs.statSync(locked).isDirectory(), '拒绝路径不碰盘');
});

test('loadAccounts：坏 JSON/非数组=抛（防下一次保存固化空清单）；saveAccounts 原子写不留 .tmp', (t) => {
  const root = tempRoot(t);
  const file = path.join(root, 'launcher', 'accounts.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{not json');
  assert.throws(() => loadAccounts(root), SyntaxError);
  fs.writeFileSync(file, '{"a":1}');
  assert.throws(() => loadAccounts(root), /不是数组/);
  fs.rmSync(file);
  assert.deepEqual(loadAccounts(root), [], '缺席 = 空清单（首启正常语义）');
  saveAccounts(root, [{ id: 'x', name: 'Steve', type: 'offline' }]);
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((f) => f.endsWith('.tmp')), [], 'tmp 已 rename 归位');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8'))[0].name, 'Steve');
});
