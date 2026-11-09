'use strict';

// portable B 期单测（plan.md 2026-10-25 终拍）：ini 四态 / 双指纹自愈 / 只读回落 /
// pathWarning 分类 / flavor 门 / 指针路由与登记簿。路径一律宿主原生形（detectPortable 触真实 fs）。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  AtticRuntime,
  resolveDataRoot,
  loadSettings,
  settingsFromProps,
  parseProperties,
  serializeProperties,
  settingsFile,
  PORTABLE_ANCHOR_REL,
  classifyPathWarning,
  detectPortable,
  looksLikeTempExtraction,
  syncPortableRegistry,
  writePortableAnchor,
  writePortablePointer,
} = require('../dist/index.js');

function tempRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attic-port-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** 便携夹具：exeDir（程序目录）+ 隔离默认根（env 注入，不碰真实 %APPDATA%/HOME）。 */
function portableFixture(t, exeName = 'attic-portable') {
  const base = tempRoot(t);
  const exeDir = path.join(base, exeName);
  fs.mkdirSync(exeDir, { recursive: true });
  const env = { APPDATA: path.join(base, 'appdata'), HOME: path.join(base, 'home') };
  return { base, exeDir, env, defaultRoot: resolveDataRoot({ env }) };
}

function writeMarker(exeDir, entries, rel = 'portable.ini') {
  const file = path.join(exeDir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, serializeProperties(entries), 'utf8');
  return file;
}

/** 直写某根的 launcher.settings（绕开 runtime——测试要的是「启动前根里就有数据」的形态）。 */
function seedSettings(root, props) {
  const file = settingsFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, props, 'utf8');
}

function dropAnchor(exeDir) {
  const anchor = path.join(exeDir, '.attic', PORTABLE_ANCHOR_REL);
  fs.mkdirSync(path.dirname(anchor), { recursive: true });
  fs.writeFileSync(anchor, 'exeDir=whatever\nversion=0.0.0\n', 'utf8');
  return anchor;
}

// ---------- 判定式（双指纹） ----------

test('detectPortable：无 marker 且无 anchor = 非便携（安装版天然不命中）', (t) => {
  const { exeDir, defaultRoot } = portableFixture(t);
  assert.equal(detectPortable({ exeDir, defaultRoot }), null);
  // 孤立 `.attic`（无锚）不算指纹：残留目录不得冒充便携身份
  fs.mkdirSync(path.join(exeDir, '.attic'), { recursive: true });
  assert.equal(detectPortable({ exeDir, defaultRoot }), null);
});

test('detectPortable：marker 在场即命中（含嵌套候选位 resources/portable.ini）', (t) => {
  const { exeDir, defaultRoot } = portableFixture(t);
  const ini = writeMarker(exeDir, {}, 'resources/portable.ini');
  const r = detectPortable({ exeDir, markerCandidates: ['resources/portable.ini'], defaultRoot });
  assert.equal(r.active, true);
  assert.equal(r.rebuilt, false);
  assert.equal(r.fallback, false);
  assert.equal(r.iniPath, ini);
  assert.equal(r.root, path.join(exeDir, '.attic'));
  assert.equal(r.pointerRoot, undefined);
});

test('detectPortable：ini rootDir 绝对照用 / 相对按 exeDir 解析', (t) => {
  const { exeDir, defaultRoot } = portableFixture(t);
  const target = path.join(exeDir, '..', 'elsewhere-data');
  fs.mkdirSync(target, { recursive: true });

  writeMarker(exeDir, { rootDir: target });
  let r = detectPortable({ exeDir, markerCandidates: ['portable.ini'], defaultRoot });
  assert.equal(r.root, path.normalize(target));
  assert.equal(r.pointerRoot, path.normalize(target));

  writeMarker(exeDir, { rootDir: path.relative(exeDir, target) });
  r = detectPortable({ exeDir, markerCandidates: ['portable.ini'], defaultRoot });
  assert.equal(r.root, path.resolve(exeDir, path.relative(exeDir, target)));
  assert.equal(r.pointerRoot, path.normalize(target));
});

test('detectPortable：ini 损坏 = fail-open 回落 exe 旁 .attic + console.warn', (t) => {
  const { exeDir, defaultRoot } = portableFixture(t);
  fs.mkdirSync(path.join(exeDir, 'portable.ini')); // 目录冒充 ini：读取必炸
  const orig = console.warn;
  const warns = [];
  console.warn = (...args) => warns.push(args.join(' '));
  try {
    const r = detectPortable({ exeDir, markerCandidates: ['portable.ini'], defaultRoot });
    assert.equal(r.active, true);
    assert.equal(r.root, path.join(exeDir, '.attic'));
    assert.equal(r.pointerRoot, undefined);
  } finally {
    console.warn = orig;
  }
  assert.ok(warns.some((w) => w.includes('[attic-portable]')), 'fail-open 必须留 warn 痕');
});

test('detectPortable：marker 缺席 + anchor 在场 = 自愈（rebuilt，指针面缺席）', (t) => {
  const { exeDir, defaultRoot } = portableFixture(t);
  dropAnchor(exeDir);
  const r = detectPortable({ exeDir, markerCandidates: ['portable.ini'], defaultRoot });
  assert.equal(r.active, true);
  assert.equal(r.rebuilt, true);
  assert.equal(r.iniPath, undefined);
  assert.equal(r.root, path.join(exeDir, '.attic'));
});

test('detectPortable：便携根不可写 = 回落默认根（fallback，身份仍是便携）', (t) => {
  const { exeDir, defaultRoot } = portableFixture(t);
  writeMarker(exeDir, {});
  fs.writeFileSync(path.join(exeDir, '.attic'), 'occupied'); // 文件占死目录位：实写探针必炸
  const r = detectPortable({ exeDir, markerCandidates: ['portable.ini'], defaultRoot });
  assert.equal(r.active, true);
  assert.equal(r.fallback, true);
  assert.equal(r.root, defaultRoot);
});

// ---------- 路径警示 / temp 守卫（纯函数） ----------

test('classifyPathWarning：非 ASCII > 含空格 > 逼近 260（阈值 ≥240）', () => {
  assert.equal(classifyPathWarning('D:\\游戏\\attic'), 'non_ascii');
  assert.equal(classifyPathWarning('D:\\游戏 data\\attic'), 'non_ascii'); // 优先级：非 ASCII 居首
  assert.equal(classifyPathWarning('D:\\My Games\\attic'), 'space');
  assert.equal(classifyPathWarning('D:\\' + 'a'.repeat(240)), 'long');
  assert.equal(classifyPathWarning('D:\\attic'), undefined);
});

test('looksLikeTempExtraction：TEMP/TMP 前缀与压缩软件特征段命中，正常目录放行', (t) => {
  const tmp = tempRoot(t);
  assert.equal(looksLikeTempExtraction(path.join(tmp, 'sub'), { TEMP: tmp }), true);
  assert.equal(looksLikeTempExtraction(tmp, { TMP: tmp }), true); // 恰等 = 命中
  assert.equal(
    looksLikeTempExtraction('C:\\Users\\x\\AppData\\Local\\Temp\\Rar$DIa0.123\\attic', { TEMP: 'C:\\Windows\\Temp' }),
    true,
  );
  assert.equal(looksLikeTempExtraction('C:\\Program Files\\7z$abcdef\\attic', { TEMP: 'C:\\Windows\\Temp' }), true);
  assert.equal(looksLikeTempExtraction('D:\\Attic\\app', { TEMP: 'C:\\Windows\\Temp', TMP: 'C:\\Windows\\Temp' }), false);
});

test('looksLikeTempExtraction：AppImage 豁免（APPIMAGE 在场 = temp 运行是设计内形态）', () => {
  // 挂载态 / extract-and-run 态两形态都命中 temp 前缀，但 APPIMAGE env 在场 → 放行
  assert.equal(
    looksLikeTempExtraction('/tmp/.mount_atticZ1X2o3/usr/bin', { APPIMAGE: '/home/u/attic.AppImage', TMP: '/tmp' }),
    false,
  );
  assert.equal(
    looksLikeTempExtraction('/tmp/appimage_extracted_abc123/usr/bin', { APPIMAGE: '/home/u/attic.AppImage', TMP: '/tmp' }),
    false,
  );
  // 无 APPIMAGE 标记（手工解包到 temp）→ 守卫照常命中
  assert.equal(looksLikeTempExtraction('/tmp/attic/usr/bin', { TMP: '/tmp' }), true);
});

// ---------- 指针面 / 落锚 / 登记簿 ----------

test('writePortablePointer：rootDir 写/清 + 未知键保留 + 自愈态显式报错', (t) => {
  const { exeDir } = portableFixture(t);
  const ini = writeMarker(exeDir, { other: 'keep' });
  writePortablePointer(ini, 'D:\\data');
  let props = parseProperties(fs.readFileSync(ini, 'utf8'));
  assert.equal(props['rootDir'], 'D:\\data');
  assert.equal(props['other'], 'keep');
  writePortablePointer(ini, '');
  props = parseProperties(fs.readFileSync(ini, 'utf8'));
  assert.equal(props['rootDir'], undefined);
  assert.throws(() => writePortablePointer(undefined, 'D:\\data'), /便携包/);
});

test('writePortableAnchor：建骨架 + 首锚保留（幂等不覆盖）', (t) => {
  const { exeDir } = portableFixture(t);
  writePortableAnchor(exeDir, '1.2.3');
  const anchor = path.join(exeDir, '.attic', PORTABLE_ANCHOR_REL);
  assert.match(fs.readFileSync(anchor, 'utf8'), /version=1\.2\.3/);
  fs.writeFileSync(anchor, 'sentinel');
  writePortableAnchor(exeDir, '9.9.9');
  assert.equal(fs.readFileSync(anchor, 'utf8'), 'sentinel'); // 已存在 = 不动
  assert.ok(fs.existsSync(path.join(exeDir, '.attic', 'launcher', 'instances')), 'ensureLayout 骨架齐备');
});

test('syncPortableRegistry：面包屑/回落标记值变才写、回落不清面包屑', (t) => {
  const { defaultRoot, exeDir } = portableFixture(t);
  const root = path.join(exeDir, '.attic');
  const ok = { active: true, root, rebuilt: false, fallback: false, exeDir };
  syncPortableRegistry(defaultRoot, ok);
  assert.equal(loadSettings(defaultRoot)['lastPortableRoot'], root);
  syncPortableRegistry(defaultRoot, ok); // 值未变 = 幂等重写不炸
  syncPortableRegistry(defaultRoot, { ...ok, fallback: true, root: defaultRoot });
  const props = loadSettings(defaultRoot);
  assert.equal(props['portableFallback'], 'true');
  assert.equal(props['lastPortableRoot'], root); // 回落态面包屑保留上一个便携根
  syncPortableRegistry(defaultRoot, ok);
  assert.equal(loadSettings(defaultRoot)['portableFallback'], undefined); // 可写恢复 = 清过期标记
});

// ---------- runtime 接线（门面级） ----------

test('AtticRuntime portable：根/指针路由/落锚/flavor 门/登记簿', (t) => {
  const { exeDir, env, defaultRoot } = portableFixture(t);
  const ini = writeMarker(exeDir, {});
  const runtime = new AtticRuntime({ exeDir, portableMarkers: ['portable.ini'], env, version: '9.9.9' });
  assert.equal(runtime.root, path.join(exeDir, '.attic'));
  const sys = runtime.getSystemInfo();
  assert.equal(sys.portable.active, true);
  assert.equal(sys.portable.fallback, false);
  assert.equal(sys.portable.rebuilt, undefined);
  assert.equal(loadSettings(defaultRoot)['lastPortableRoot'], runtime.root); // 面包屑落默认根

  // 指针路由：rootOverride 写 ini、不落 settings、视图回显
  const target = path.join(exeDir, 'sibling-data');
  fs.mkdirSync(target, { recursive: true });
  runtime.setSettings({ rootOverride: target });
  assert.equal(parseProperties(fs.readFileSync(ini, 'utf8'))['rootDir'], target);
  assert.equal(loadSettings(runtime.root)['rootOverride'], undefined);
  assert.equal(runtime.getSettings().rootOverride, target);

  // 部分 patch 不带 rootOverride 键 = 指针不动
  runtime.setSettings({ theme: 'dark' });
  assert.equal(parseProperties(fs.readFileSync(ini, 'utf8'))['rootDir'], target);

  // 显式空串 = 清除指针回落 exe 旁缺省
  runtime.setSettings({ rootOverride: '' });
  assert.equal(parseProperties(fs.readFileSync(ini, 'utf8'))['rootDir'], undefined);
  assert.equal(runtime.getSettings().rootOverride, undefined);

  // flavor 门：wizardDone 无 flavor 戳 = 不落锚（安装口径）；portable 戳 = 幂等落锚
  const anchor = path.join(exeDir, '.attic', PORTABLE_ANCHOR_REL);
  runtime.setSettings({ wizardDone: true });
  assert.equal(fs.existsSync(anchor), false);
  runtime.setSettings({ wizardDone: true, wizardFlavor: 'portable' });
  assert.ok(fs.existsSync(anchor));
  assert.equal(runtime.getSettings().wizardFlavor, 'portable');
});

// ---------- rootPopulated（门之三 flavor 感知数据源，2026-10-25 用户实机 bug 修复） ----------

test('rootPopulated：空便携根 = false——默认根有安装历史也不压便携首启（bug 主案）', (t) => {
  const { exeDir, env, defaultRoot } = portableFixture(t);
  // 预置「老用户机」形态：默认根有真实数据（安装版/dev 历史）
  seedSettings(defaultRoot, 'gameWidth=854');
  writeMarker(exeDir, {}, 'resources/portable.ini');
  const runtime = new AtticRuntime({ exeDir, portableMarkers: ['resources/portable.ini'], env, version: '9.9.9' });
  const sys = runtime.getSystemInfo();
  assert.equal(sys.defaultRootPopulated, true, '默认根确有历史数据');
  assert.equal(sys.portable.rootPopulated, false, '门之三 portable 数据源 = 生效根快照，非默认根');
});

test('rootPopulated：构造期快照时序——中断残留骨架不误判；真实数据 = true', (t) => {
  const { exeDir, env } = portableFixture(t);
  writeMarker(exeDir, {});
  const first = new AtticRuntime({ exeDir, portableMarkers: ['portable.ini'], env });
  assert.equal(first.getSystemInfo().portable.rootPopulated, false, '首启空根 = false');
  // 模拟向导中断退出：first 构造期 ensureLayout 已落骨架，次启不得被骨架压制
  const second = new AtticRuntime({ exeDir, portableMarkers: ['portable.ini'], env });
  assert.ok(fs.existsSync(path.join(exeDir, '.attic', 'launcher', 'instances')), '骨架确已残留（前提成立）');
  assert.equal(second.getSystemInfo().portable.rootPopulated, false, '骨架 ≠ 数据');
  // 真实数据（向导完成写 settings）→ 次启 true（门① flavorDone 同会拦，此处锁快照口径）
  second.setSettings({ wizardDone: true, wizardFlavor: 'portable' });
  const third = new AtticRuntime({ exeDir, portableMarkers: ['portable.ini'], env });
  assert.equal(third.getSystemInfo().portable.rootPopulated, true, 'launcher.settings = 真实数据');
});

test('rootPopulated：只读回落态 = 默认根快照（自然回落老语义，无特判）', (t) => {
  const { exeDir, env, defaultRoot } = portableFixture(t);
  writeMarker(exeDir, {});
  fs.writeFileSync(path.join(exeDir, '.attic'), 'occupied'); // 文件占死目录位 → 探针炸 → fallback
  seedSettings(defaultRoot, 'gameWidth=854');
  const runtime = new AtticRuntime({ exeDir, portableMarkers: ['portable.ini'], env });
  const sys = runtime.getSystemInfo();
  assert.equal(sys.portable.fallback, true);
  assert.equal(sys.portable.rootPopulated, true, '回落态生效根 = 默认根，老用户数据如实命中');
});

test('便携面包屑不压安装版向导：默认根仅登记簿键 = defaultRootPopulated false（2026-10-25 拍板口径）', (t) => {
  const { exeDir, env, defaultRoot } = portableFixture(t);
  writeMarker(exeDir, {});
  const portable = new AtticRuntime({ exeDir, portableMarkers: ['portable.ini'], env });
  assert.equal(loadSettings(defaultRoot)['lastPortableRoot'], portable.root, '前提：面包屑确已落默认根');
  // 同机安装版视角（无 marker/anchor）：纯登记簿 settings 不得冒充老用户
  const installed = new AtticRuntime({ env });
  const sys = installed.getSystemInfo();
  assert.equal(sys.portable, undefined);
  assert.equal(sys.defaultRootPopulated, false, '面包屑 = 机器生成登记簿，非用户数据');
});

test('AtticRuntime portable 只读回落：徽标口径 + portableFallback 落默认根', (t) => {
  const { exeDir, env } = portableFixture(t);
  writeMarker(exeDir, {});
  fs.writeFileSync(path.join(exeDir, '.attic'), 'occupied');
  const runtime = new AtticRuntime({ exeDir, portableMarkers: ['portable.ini'], env });
  assert.equal(runtime.root, runtime.defaultRoot);
  assert.equal(runtime.getSystemInfo().portable.fallback, true);
  assert.equal(runtime.getSettings().portableFallback, true);
  assert.equal(loadSettings(runtime.defaultRoot)['portableFallback'], 'true');
  // 回落态向导完成：flavor 戳落 settings（回落根可达），锚跳过（写不进盘）
  runtime.setSettings({ wizardDone: true, wizardFlavor: 'portable' });
  assert.equal(runtime.getSettings().wizardDone, true);
  assert.equal(fs.existsSync(path.join(exeDir, '.attic', PORTABLE_ANCHOR_REL)), false);
});

test('AtticRuntime portable 自愈态：rebuilt 透传 + pathWarning 命中（非 ASCII）', (t) => {
  const { exeDir, env } = portableFixture(t, '游戏 data');
  dropAnchor(exeDir);
  const runtime = new AtticRuntime({ exeDir, portableMarkers: ['portable.ini'], env });
  const sys = runtime.getSystemInfo();
  assert.equal(sys.portable.rebuilt, true);
  assert.equal(sys.portable.pathWarning, 'non_ascii');
  // 自愈态无 ini：改根 = 显式报错（指针面无处可写），不落任何部分状态
  assert.throws(() => runtime.setSettings({ rootOverride: 'D:\\somewhere' }), /便携包/);
});

test('AtticRuntime 安装版口径不变：SYS_INFO 无 portable 键 + 安装目录护栏仍拒', (t) => {
  const { exeDir, env } = portableFixture(t);
  const runtime = new AtticRuntime({ exeDir, portableMarkers: ['portable.ini'], env, installDir: exeDir });
  assert.equal(runtime.getSystemInfo().portable, undefined);
  assert.throws(() => runtime.setSettings({ rootOverride: path.join(exeDir, 'data') }), /安装目录/);
  // 安装版 rootOverride 正常落 settings（不经 ini）
  runtime.setSettings({ rootOverride: path.join(exeDir, '..', 'outside-data') });
  assert.equal(loadSettings(runtime.root)['rootOverride'], path.join(exeDir, '..', 'outside-data'));
});

test('settingsFromProps：wizardFlavor 白名单 + B 期三键映射', () => {
  assert.equal(settingsFromProps({ wizardFlavor: 'bogus' }).wizardFlavor, undefined);
  assert.deepEqual(
    settingsFromProps({ wizardFlavor: 'portable', lastPortableRoot: 'D:\\p', portableFallback: 'true' }),
    { wizardFlavor: 'portable', lastPortableRoot: 'D:\\p', portableFallback: true },
  );
});
