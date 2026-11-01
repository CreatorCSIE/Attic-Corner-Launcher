// 拼装器行为断言：对 core-spec 同一组夹具产出 expected（双壳防漂移闸门的 TS 侧，风险 #2）。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { assembleLaunchConfig, filterAgentMounts, APPLET_LAUNCHER_CLASS } = require('../dist/index.js');

const FIXTURES_DIR = path.join(path.dirname(require.resolve('@attic/core-spec/package.json')), 'fixtures');

function loadFixtures() {
  return fs
    .readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, f), 'utf8')));
}

for (const fixture of loadFixtures()) {
  test(`夹具 ${fixture.name}：拼装输出 == expected`, () => {
    const config = assembleLaunchConfig(fixture.versionJson, fixture.context);
    assert.deepEqual(config, fixture.expected);
  });
}

test('区间过滤：不在适用区间的挂载被剔除', () => {
  const versionOrder = ['c0.0.13a', 'c2.0', 'b1.7.3', '1.5.2'];
  const mounts = [
    { form: 'javaagent', path: 'legacyfix/lf.jar', appliesFrom: 'c0.0.13a', appliesTo: 'c2.0' },
    { form: 'mod', path: 'legacyfix/lf.jar', appliesFrom: '1.5.2', appliesTo: '1.5.2' },
  ];
  const kept = filterAgentMounts(mounts, 'b1.7.3', versionOrder);
  assert.deepEqual(kept, []);
});

test('区间过滤：判定失败 fail-open + 诊断', () => {
  const diagnostics = [];
  const mounts = [{ form: 'javaagent', path: 'legacyfix/lf.jar', appliesFrom: 'c0.0.13a', appliesTo: 'c2.0' }];
  const kept = filterAgentMounts(mounts, 'unknown-id', ['c0.0.13a', 'c2.0'], undefined, (m) => diagnostics.push(m));
  assert.deepEqual(kept, mounts);
  assert.equal(diagnostics.length, 1);
});

test('未知占位符原样保留', () => {
  const versionJson = {
    id: 'b1.0',
    mainClass: 'net.minecraft.client.Minecraft',
    minecraftArguments: '${auth_player_name} ${totally_unknown}',
  };
  const context = baseContext();
  const config = assembleLaunchConfig(versionJson, context);
  assert.deepEqual(config.gameArgs, ['steve', '${totally_unknown}']);
});

test('extraJvmArgs 追加在固定组末尾；gameParams 以 --k v 追加', () => {
  const versionJson = { id: 'c2.0', mainClass: 'net.minecraft.client.Minecraft' };
  const context = baseContext();
  const config = assembleLaunchConfig(versionJson, context, {
    extraJvmArgs: ['-Dfoo=bar'],
    gameParams: { server: '1.2.3.4', port: '25565' },
  });
  assert.equal(config.jvmArgs[config.jvmArgs.length - 1], '-Dfoo=bar');
  assert.deepEqual(config.gameArgs.slice(-4), ['--server', '1.2.3.4', '--port', '25565']);
});

test('组序契约：固定堆参数 → 全局 jvmArgs → 实例 launchArgs（后者 JVM 胜出覆盖）', () => {
  const versionJson = { id: 'c2.0', mainClass: 'net.minecraft.client.Minecraft' };
  const context = { ...baseContext(), globalJvmArgs: '-XX:+UseSerialGC  -Dg=1', launchArgs: '-Xmx2G' };
  const config = assembleLaunchConfig(versionJson, context);
  assert.deepEqual(config.jvmArgs.slice(0, 5), [
    '-Xmx1024m',
    '-XX:+UseSerialGC',
    '-Dg=1',
    '-Xmx2G',
    '-Djava.util.Arrays.useLegacyMergeSort=true',
  ]);
});

test('minMemoryMb 下发 -Xms 且进 LaunchConfig', () => {
  const versionJson = { id: 'c2.0', mainClass: 'net.minecraft.client.Minecraft' };
  const context = { ...baseContext(), minMemoryMb: 256 };
  const config = assembleLaunchConfig(versionJson, context);
  assert.equal(config.jvmArgs[1], '-Xms256m');
  assert.equal(config.minMemoryMb, 256);
});

test('Applet 容器主类：javaagent jar 同时进 classpath；剔 launchwrapper；deawt 保持开启', () => {
  const versionJson = {
    id: 'c0.0.15a',
    mainClass: 'uk.betacraft.legacyfix.applet.AppletLauncher',
    betacraft: {
      proxyArgs: ['-Dhttp.proxyHost=betacraft.uk'],
      agentMount: [{ form: 'javaagent', path: 'legacyfix/lf.jar', appliesFrom: 'c0.0.13a' }],
    },
  };
  const context = {
    ...baseContext(),
    binPool: ['/data/bin/lwjgl-2.9.0.jar', '/data/bin/launchwrapper-1.5.jar'],
  };
  const config = assembleLaunchConfig(versionJson, context);
  assert.ok(config.classpath.includes('/data/legacyfix/lf.jar'));
  // legacyfix agent 见 classpath 上有 LaunchWrapper 即提前 return 跳过全部补丁（c0.0.12a 窗口事故）。
  assert.ok(!config.classpath.some((jar) => jar.includes('launchwrapper')));
  // deawt 保持开启（实测窗口正常）：关窗后 MainWindowHandle 归零，壳侧看门狗据此终止空转进程。
  assert.ok(!config.jvmArgs.some((a) => a.includes('deawt')));
});

test('Applet 容器 appletClass：context 注入值优先；无注入回落方法表；皆无则不传（可见失败）', () => {
  const appletJson = (method) => ({
    id: 'pc-132011',
    mainClass: APPLET_LAUNCHER_CLASS,
    betacraft: { launchMethod: method },
  });
  // rd 代 pre-Classic：宿主按 jar 探测注入 RubyDung（26.8 候选表无此类名，不注入 = code=0 秒退）
  const injected = assembleLaunchConfig(appletJson('preclassic'), {
    ...baseContext(),
    appletClass: 'com.mojang.rubydung.RubyDung',
  });
  assert.deepEqual(injected.gameArgs.slice(-2), ['--appletClass', 'com.mojang.rubydung.RubyDung']);
  // 无注入值 + 表命中（4k → M）：维持方法数据表通道
  const viaTable = assembleLaunchConfig(appletJson('4k'), baseContext());
  assert.deepEqual(viaTable.gameArgs.slice(-2), ['--appletClass', 'M']);
  // 无注入值 + 表无值（preclassic 不在表）：不传参数，legacyfix 原行为（失败可见不静默）
  const none = assembleLaunchConfig(appletJson('preclassic'), baseContext());
  assert.ok(!none.gameArgs.includes('--appletClass'));
});

test('非 Applet 容器：保留 launchwrapper、不加 deawt 开关', () => {
  const versionJson = { id: 'b1.7.3', mainClass: 'net.minecraft.launchwrapper.Launch' };
  const context = { ...baseContext(), binPool: ['/data/bin/launchwrapper-1.5.jar'] };
  const config = assembleLaunchConfig(versionJson, context);
  assert.ok(config.classpath.includes('/data/bin/launchwrapper-1.5.jar'));
  assert.ok(!config.jvmArgs.some((a) => a.includes('deawt')));
});

test('主类缺失（launch-method 不在表）→ 显式报错不静默兜底', () => {
  const versionJson = { id: '4k-0144', betacraft: { proxyArgs: [], launchMethod: '4k' } };
  assert.throws(
    () => assembleLaunchConfig(versionJson, baseContext()),
    /无法确定主类.*4k/,
  );
});

test('levelServer：proxyArgs 后、javaagent 前注入 -Dlf.proxy.levelServer；缺省不注入', () => {
  const versionJson = {
    id: 'b1.7.3',
    mainClass: 'net.minecraft.client.Minecraft',
    betacraft: {
      proxyArgs: ['-Dhttp.proxyHost=betacraft.uk'],
      agentMount: [{ form: 'javaagent', path: 'legacyfix/lf.jar' }],
    },
  };
  const withLs = assembleLaunchConfig(versionJson, { ...baseContext(), levelServer: 'local' });
  const idxProxy = withLs.jvmArgs.indexOf('-Dhttp.proxyHost=betacraft.uk');
  const idxLs = withLs.jvmArgs.indexOf('-Dlf.proxy.levelServer=local');
  const idxAgent = withLs.jvmArgs.findIndex((a) => a.startsWith('-javaagent:'));
  assert.ok(idxProxy >= 0 && idxLs === idxProxy + 1 && idxLs < idxAgent);
  const without = assembleLaunchConfig(versionJson, baseContext());
  assert.ok(!without.jvmArgs.some((a) => a.includes('lf.proxy.levelServer')));
});

test('版本钉 -Dlf.version：全版本无条件注入（premain 等值补丁的唯一确定通道）', () => {
  const versionJson = {
    id: 'c0.0.15a',
    mainClass: APPLET_LAUNCHER_CLASS,
    betacraft: {
      proxyArgs: ['-Dhttp.proxyHost=betacraft.uk'],
      agentMount: [{ form: 'javaagent', path: 'legacyfix/lf.jar' }],
    },
  };
  const config = assembleLaunchConfig(versionJson, { ...baseContext(), levelServer: 'local' });
  const idxLs = config.jvmArgs.indexOf('-Dlf.proxy.levelServer=local');
  const idxVer = config.jvmArgs.indexOf('-Dlf.version=c0.0.15a');
  const idxDir = config.jvmArgs.indexOf('-Dlf.assetsDir=/game/assets');
  const idxAgent = config.jvmArgs.findIndex((a) => a.startsWith('-javaagent:'));
  // 位置钉：levelServer 之后、assetsDir/javaagent 之前（Agent 静态块收集须在 premain 前就位）
  assert.ok(idxLs >= 0 && idxVer === idxLs + 1 && idxVer < idxDir && idxDir < idxAgent);
  // 数据表键戒律：无版本判断代码——普通非 Applet 版本同样注入
  const beta = assembleLaunchConfig({ id: 'b1.7.3', mainClass: 'net.minecraft.client.Minecraft' }, baseContext());
  assert.ok(beta.jvmArgs.includes('-Dlf.version=b1.7.3'));
});

test('资产索引钉死：assetsDir 后、javaagent 前注入 -Dlf.assetIndex（0130 → 权威 20100124）', () => {
  const versionJson = {
    id: 'in-20100130',
    mainClass: 'net.minecraft.client.Minecraft',
    betacraft: { agentMount: [{ form: 'javaagent', path: 'legacyfix/lf.jar' }] },
  };
  const config = assembleLaunchConfig(versionJson, baseContext());
  const idxDir = config.jvmArgs.indexOf('-Dlf.assetsDir=/game/assets');
  assert.ok(idxDir >= 0);
  // BC v2 权威：0130 → 20100124（标题探测同值），而非 ID 正则表的 20100212。
  assert.equal(config.jvmArgs[idxDir + 1], '-Dlf.assetIndex=20100124');
  const idxAgent = config.jvmArgs.findIndex((a) => a.startsWith('-javaagent:'));
  assert.ok(idxDir + 1 < idxAgent);

  // legacy/pre-1.6（legacyfix isInvalidIndex 语义）→ 不注入，保留缺省行为。
  for (const assets of ['legacy', 'pre-1.6']) {
    const c = assembleLaunchConfig({ id: '1.5.2', mainClass: 'net.minecraft.client.Minecraft', assets }, baseContext());
    assert.ok(!c.jvmArgs.some((a) => a.includes('lf.assetIndex')), `${assets} 不应注入`);
  }
  // 无资产（pre-classic → empty / 4k → 表外）→ 不注入。
  for (const id of ['pc-132011', '4k-0144']) {
    const c = assembleLaunchConfig({ id, mainClass: 'net.minecraft.client.Minecraft' }, baseContext());
    assert.ok(!c.jvmArgs.some((a) => a.includes('lf.assetIndex')), `${id} 不应注入`);
  }
});

test('实例 launchArgs 紧随固定 -Xmx 注入；Applet 容器 gameArgs 末尾带 --width/--height，非 Applet 不带', () => {
  const appletJson = { id: 'c0.0.15a', mainClass: APPLET_LAUNCHER_CLASS };
  const context = { ...baseContext(), launchArgs: '-Xmx1G -XX:+UseG1GC', width: 854, height: 480 };
  const config = assembleLaunchConfig(appletJson, context);
  assert.equal(config.jvmArgs[0], '-Xmx1024m');
  assert.equal(config.jvmArgs[1], '-Xmx1G');
  assert.equal(config.jvmArgs[2], '-XX:+UseG1GC');
  const tail = config.gameArgs.slice(-4);
  assert.deepEqual(tail, ['--width', '854', '--height', '480']);

  const betaConfig = assembleLaunchConfig({ id: 'b1.7.3', mainClass: 'net.minecraft.client.Minecraft' }, context);
  assert.ok(!betaConfig.gameArgs.includes('--width'));
  assert.ok(betaConfig.jvmArgs.includes('-Xmx1G'));
});

test('addons 注入：档案三态 + 勾选/取消按目录映射 -Dlf.*', () => {
  const versionJson = { id: 'b1.7.3', mainClass: 'net.minecraft.client.Minecraft' };
  // 属性表钉死 legacyfix 契约（不引目录常量，防"测试跟着实现一起写错"）
  const ENABLE = ['vsync', 'visualizer', 'modloader', 'beta-forge', 'bouncycastle', 'showNotice', 'demo', 'intel'];
  const DISABLE = ['skin.disable', 'proxy.disable', 'auth-on-server-join.disable'];
  const has = (c, p) => c.jvmArgs.includes(`-Dlf.${p}`);
  // 态一：老档案无 addons 键（undefined）→ 零注入，行为 = legacyfix 自身缺省
  const legacy = assembleLaunchConfig(versionJson, baseContext());
  for (const p of [...ENABLE, ...DISABLE]) assert.ok(!has(legacy, p), `undefined 不应注入 ${p}`);
  // 态二：UI 缺省集（disable 族全勾 = 功能默认开）→ 同样零注入
  const dflt = assembleLaunchConfig(versionJson, { ...baseContext(), addons: ['skins', 'proxy', 'server-auth'] });
  for (const p of [...ENABLE, ...DISABLE]) assert.ok(!has(dflt, p), `缺省集不应注入 ${p}`);
  // 态三：显式全关（[]）→ disable 族注入 .disable，enable 族静默
  const allOff = assembleLaunchConfig(versionJson, { ...baseContext(), addons: [] });
  for (const p of DISABLE) assert.ok(has(allOff, p), `[] 应注入 ${p}`);
  for (const p of ENABLE) assert.ok(!has(allOff, p), `[] 不应注入 ${p}`);
  // 勾选 enable 族 = 注入正开关；disable 族保持勾选 = 不注入 .disable
  const mixed = assembleLaunchConfig(versionJson, { ...baseContext(), addons: ['vsync', 'skins', 'demo'] });
  assert.ok(has(mixed, 'vsync'));
  assert.ok(has(mixed, 'demo')); // v1 Demo addon 转正项：-Dlf.demo（legacyfix 原生开关）
  assert.ok(!has(mixed, 'skin.disable'));
  assert.ok(has(mixed, 'proxy.disable'));
  // 占位项（v1 fullscreen/game-mode-switch/quit-game）勾选也不产生空属性开关
  const ph = assembleLaunchConfig(versionJson, { ...baseContext(), addons: ['fullscreen', 'game-mode-switch', 'quit-game'] });
  assert.ok(!ph.jvmArgs.includes('-Dlf.'));
  // 注入位置：紧随实例 launchArgs token、固定收尾属性之前
  const pos = assembleLaunchConfig(versionJson, { ...baseContext(), launchArgs: '-XX:+UseG1GC', addons: ['vsync'] });
  assert.ok(pos.jvmArgs.indexOf('-XX:+UseG1GC') < pos.jvmArgs.indexOf('-Dlf.vsync'));
  assert.ok(pos.jvmArgs.indexOf('-Dlf.vsync') < pos.jvmArgs.indexOf('-Djava.util.Arrays.useLegacyMergeSort=true'));
});

test('一次性 visualizer：LaunchRequest 透传注入 -Dlf.visualizer（同 addons 位），档案携带时去重不双注', () => {
  const versionJson = { id: 'b1.7.3', mainClass: 'net.minecraft.client.Minecraft' };
  const count = (c) => c.jvmArgs.filter((a) => a === '-Dlf.visualizer').length;
  // 缺省不带键 = 不注入（老行为零回归）
  const off = assembleLaunchConfig(versionJson, baseContext());
  assert.equal(count(off), 0);
  // 一次性：老档案（addons undefined）也注入，位置 = addons 族后、固定收尾属性前
  const on = assembleLaunchConfig(versionJson, { ...baseContext(), launchArgs: '-XX:+UseG1GC', visualizer: true });
  assert.equal(count(on), 1);
  assert.ok(on.jvmArgs.indexOf('-XX:+UseG1GC') < on.jvmArgs.indexOf('-Dlf.visualizer'));
  assert.ok(on.jvmArgs.indexOf('-Dlf.visualizer') < on.jvmArgs.indexOf('-Djava.util.Arrays.useLegacyMergeSort=true'));
  // 显式全关档案（[]）不挡一次性启动；disable 族照常按档案语义注入
  const allOff = assembleLaunchConfig(versionJson, { ...baseContext(), addons: [], visualizer: true });
  assert.equal(count(allOff), 1);
  assert.ok(allOff.jvmArgs.includes('-Dlf.proxy.disable'));
  // 档案已含 visualizer（常开）+ 一次性再带 = 去重不双注
  const dup = assembleLaunchConfig(versionJson, { ...baseContext(), addons: ['visualizer'], visualizer: true });
  assert.equal(count(dup), 1);
});

test('一次性 server 直连：ip[:port] 解析注入 --server/--port（端口恒显式传缺省 25565），非法格式忽略不拦启动', () => {
  const versionJson = { id: 'b1.7.3', mainClass: 'net.minecraft.client.Minecraft' };
  // 不带键 = 零注入（老行为零回归）
  const off = assembleLaunchConfig(versionJson, baseContext());
  assert.ok(!off.gameArgs.includes('--server'));
  // 仅主机：--server + --port 25565 恒显式传（端口缺省由本侧注入；裸指令实锤缺 --port = 游戏直进单人）
  const hostOnly = assembleLaunchConfig(versionJson, { ...baseContext(), server: 'mc.example.com' });
  assert.deepEqual(hostOnly.gameArgs.slice(-4), ['--server', 'mc.example.com', '--port', '25565']);
  // 带端口：两参齐发
  const withPort = assembleLaunchConfig(versionJson, { ...baseContext(), server: '127.0.0.1:25566' });
  assert.deepEqual(withPort.gameArgs.slice(-4), ['--server', '127.0.0.1', '--port', '25566']);
  // 插入位：请求侧 gameParams 之后
  const gp = assembleLaunchConfig(versionJson, { ...baseContext(), server: 'a.b' }, { gameParams: { foo: 'bar' } });
  assert.deepEqual(gp.gameArgs.slice(-6), ['--foo', 'bar', '--server', 'a.b', '--port', '25565']);
  // Applet 容器：server 组在 --width/--height 之前
  const applet = assembleLaunchConfig(
    { id: 'c0.0.15a', mainClass: APPLET_LAUNCHER_CLASS },
    { ...baseContext(), width: 854, height: 480, server: 'a.b:1234' },
  );
  assert.deepEqual(applet.gameArgs.slice(-8), ['--server', 'a.b', '--port', '1234', '--width', '854', '--height', '480']);
  // 非法格式（含空格/越界端口）= 忽略 + 诊断，不拦启动
  const diags = [];
  const bad = assembleLaunchConfig(versionJson, { ...baseContext(), server: 'bad host!' }, { onDiagnostic: (m) => diags.push(m) });
  assert.ok(!bad.gameArgs.includes('--server'));
  assert.equal(diags.length, 1);
  const badPort = assembleLaunchConfig(versionJson, { ...baseContext(), server: 'a.b:99999' }, { onDiagnostic: (m) => diags.push(m) });
  assert.ok(!badPort.gameArgs.includes('--server'));
  assert.equal(diags.length, 2);
});

test('intelFix：true = -XX:HeapDumpPath 置 jvmArgs 首位（v1 javapath 后首位语义），false/缺省不注入', () => {
  const versionJson = { id: 'b1.7.3', mainClass: 'net.minecraft.client.Minecraft' };
  const on = assembleLaunchConfig(versionJson, { ...baseContext(), intelFix: true });
  assert.equal(on.jvmArgs[0], '-XX:HeapDumpPath=java.exe_minecraft.exe.heapdump');
  assert.equal(on.jvmArgs[1], '-Xmx1024m');
  for (const ctx of [{}, { intelFix: false }]) {
    const off = assembleLaunchConfig(versionJson, { ...baseContext(), ...ctx });
    assert.ok(!off.jvmArgs.some((a) => a.includes('HeapDumpPath')));
    assert.equal(off.jvmArgs[0], '-Xmx1024m');
  }
});

function baseContext() {
  return {
    javaPath: '/opt/java/zulu8/bin/java',
    gameDir: '/game/x',
    assetsDir: '/game/assets',
    dataDir: '/data',
    username: 'steve',
    uuid: '069a79f4-44e9-4726-a5be-fca90e38aaf5',
    accessToken: '0',
    maxMemoryMb: 1024,
    binPool: [],
    versionOrder: ['c0.0.13a', 'c2.0', 'b1.7.3', '1.5.2'],
  };
}
