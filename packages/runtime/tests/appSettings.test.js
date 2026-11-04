// 设置映射断言：新键回环、布尔三态、managed 键清理与 auto 内存估算公式（契约四地点同步的测试侧闸门）。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { settingsFromProps, applySettingsToProps, estimateMaxMemoryMb, maskSecrets } = require('../dist/index.js');

test('AppSettings 新键回环：写入 launcher.settings 属性再读出形状不变', () => {
  const settings = {
    javaPath: 'C:/java/bin/java.exe',
    maxMemoryMb: 2048,
    memoryMode: 'auto',
    theme: 'dark',
    language: 'zh-CN',
    jvmArgs: '-XX:+UseSerialGC',
    checkIntegrity: false,
    fixMissing: true,
    minimizeOnLaunch: false,
    diagnosticLog: true,
    consoleOnLaunch: false,
    rootOverride: 'D:/AtticData',
    levelServer: 'local',
    endpoints: { versionList: 'https://example.test/version_list.txt' },
  };
  const props = applySettingsToProps({}, settings);
  assert.equal(props['checkIntegrity'], 'false');
  assert.equal(props['consoleOnLaunch'], 'false');
  assert.equal(props['endpoint.versionList'], 'https://example.test/version_list.txt');
  assert.deepEqual(settingsFromProps(props), settings);
});

test('username 退出 managed 键集（2026-10-22 拍板）：v1 遗留键写回不清除、读出忽略', () => {
  const existing = { username: 'Notch' };
  const props = applySettingsToProps(existing, { theme: 'light' });
  assert.equal(props['username'], 'Notch', '写回不得丢失 v1 的 username 键');
  assert.equal(settingsFromProps(props).username, undefined, '读侧不再映射 username');
});

test('布尔三态：缺键=undefined（消费端缺省），true/false 显式保留', () => {
  assert.equal(settingsFromProps({}).checkIntegrity, undefined);
  assert.equal(settingsFromProps({ checkIntegrity: 'true' }).checkIntegrity, true);
  assert.equal(settingsFromProps({ checkIntegrity: 'false' }).fixMissing, undefined);
  assert.equal(settingsFromProps({ fixMissing: 'garbage' }).fixMissing, undefined);
  assert.equal(settingsFromProps({ diagnosticLog: 'false' }).diagnosticLog, false);
  assert.equal(settingsFromProps({ consoleOnLaunch: 'false' }).consoleOnLaunch, false);
  assert.equal(settingsFromProps({ consoleOnLaunch: 'true' }).consoleOnLaunch, true);
});

test('undefined 值删除 managed 键；v1 未知键原样保留', () => {
  const props = applySettingsToProps({ 'v1.legacy': 'keep', checkIntegrity: 'false' }, { checkIntegrity: undefined });
  assert.equal(props['v1.legacy'], 'keep');
  assert.equal('checkIntegrity' in props, false);
});

test('memoryMode 只认 auto/manual；其他值缺省省略', () => {
  assert.equal(settingsFromProps({ memoryMode: 'auto' }).memoryMode, 'auto');
  assert.equal(settingsFromProps({ memoryMode: 'whatever' }).memoryMode, undefined);
});

test('wizardDone 回环（首启向导完成标记）：true/false 显式保留、缺键 = undefined、undefined 清键', () => {
  assert.equal(settingsFromProps({}).wizardDone, undefined, '缺键 = 从未见过向导');
  assert.equal(settingsFromProps({ wizardDone: 'true' }).wizardDone, true);
  assert.equal(settingsFromProps({ wizardDone: 'false' }).wizardDone, false);
  assert.deepEqual(applySettingsToProps({}, { wizardDone: true }), { wizardDone: 'true' });
  assert.equal(settingsFromProps(applySettingsToProps({}, { wizardDone: true })).wizardDone, true);
  assert.equal('wizardDone' in applySettingsToProps({ wizardDone: 'true' }, { wizardDone: undefined }), false);
});

test('updatePolicy/updateIgnoreVersion 回环（2026-10-25 更新 UI 设计两新键）：读写往返、undefined 删键、存量档案缺键 = startup 缺省', () => {
  // 读出：合法值映射、非法值缺省省略、空串视同无键
  assert.equal(settingsFromProps({}).updatePolicy, undefined, '缺键 = undefined（消费端 ?? startup）');
  assert.equal(settingsFromProps({ updatePolicy: 'startup' }).updatePolicy, 'startup');
  assert.equal(settingsFromProps({ updatePolicy: 'off' }).updatePolicy, 'off');
  assert.equal(settingsFromProps({ updatePolicy: 'bogus' }).updatePolicy, undefined, '非法值不进视图');
  assert.equal(settingsFromProps({ updateIgnoreVersion: '0.1.0' }).updateIgnoreVersion, '0.1.0');
  assert.equal(settingsFromProps({ updateIgnoreVersion: '' }).updateIgnoreVersion, undefined, '空串 = 无忽略');
  // 写回：同名键、有值则写
  const props = applySettingsToProps({}, { updatePolicy: 'off', updateIgnoreVersion: '0.2.0' });
  assert.equal(props['updatePolicy'], 'off');
  assert.equal(props['updateIgnoreVersion'], '0.2.0');
  assert.deepEqual(settingsFromProps(props), { updatePolicy: 'off', updateIgnoreVersion: '0.2.0' });
  // undefined 不落键（托管键删键纪律）
  assert.equal('updatePolicy' in applySettingsToProps({ updatePolicy: 'off' }, { updatePolicy: undefined }), false);
  assert.equal('updateIgnoreVersion' in applySettingsToProps({ updateIgnoreVersion: '0.1.0' }, { updateIgnoreVersion: undefined }), false);
  // 存量档案（不带两新键）读出 = 缺省 startup 语义（消费端 ?? 兜底，视图省略键）
  const legacy = settingsFromProps({ javaPath: 'C:/java/bin/java.exe', theme: 'dark' });
  assert.equal(legacy.updatePolicy, undefined);
  assert.equal(legacy.updateIgnoreVersion, undefined);
});

test('updatePreview 回环（测试版通道预览开关）：true/false 落盘、缺键 = undefined、非法值不进视图、undefined 删键', () => {
  assert.equal(settingsFromProps({}).updatePreview, undefined, '缺键 = 关（消费端 === true 兜底）');
  assert.equal(settingsFromProps({ updatePreview: 'true' }).updatePreview, true);
  assert.equal(settingsFromProps({ updatePreview: 'false' }).updatePreview, false);
  assert.equal(settingsFromProps({ updatePreview: 'bogus' }).updatePreview, undefined, '非法值不进视图');
  assert.equal(applySettingsToProps({}, { updatePreview: true })['updatePreview'], 'true');
  assert.equal(applySettingsToProps({}, { updatePreview: false })['updatePreview'], 'false');
  assert.equal('updatePreview' in applySettingsToProps({ updatePreview: 'true' }, { updatePreview: undefined }), false);
});

test('estimateMaxMemoryMb：40% 取 128 步长夹 [512,2048]，无宿主数据回落 1024', () => {
  assert.equal(estimateMaxMemoryMb(16384), 2048);
  assert.equal(estimateMaxMemoryMb(4096), 1664);
  assert.equal(estimateMaxMemoryMb(1024), 512);
  assert.equal(estimateMaxMemoryMb(0), 1024);
  assert.equal(estimateMaxMemoryMb(-1), 1024);
});

test('maskSecrets：长 token 全量替换 [censored sessionid]；短值/缺省不动（v1 脱敏语义）', () => {
  const token = 'eyJhbGciOiJIUzI1NiJ9.SIGNATURE.PAYLOAD';
  assert.equal(
    maskSecrets(`# command="java" --token ${token} --width 854`, token),
    `# command="java" --token [censored sessionid] --width 854`,
  );
  // 多次出现全部替换
  assert.equal(maskSecrets(`${token} x ${token}`, token), '[censored sessionid] x [censored sessionid]');
  // 离线短 token '0' 不替换（避免误伤通用子串）
  assert.equal(maskSecrets('gameArgs Player 0 -width 854', '0'), 'gameArgs Player 0 -width 854');
  assert.equal(maskSecrets('anything', undefined), 'anything');
  assert.equal(maskSecrets('anything', ''), 'anything');
});
