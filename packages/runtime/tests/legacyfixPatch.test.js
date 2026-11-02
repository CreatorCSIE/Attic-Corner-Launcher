// legacyfix DeAwtPatch 常量池补丁：合成 class/jar 夹具覆盖补丁、门控与幂等（不依赖真实 jar）。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  applyLegacyfixDeawtPatch,
  patchDeawtClassBytes,
  readZipEntries,
  writeZipEntries,
  listZipEntryNames,
  extractZipTo,
} = require('../dist/index.js');

const DEAWT_ENTRY = 'uk/betacraft/legacyfix/patch/impl/lwjgl/DeAwtPatch.class';
const ANCHOR =
  'org.lwjgl.opengl.Display.setDisplayMode(new org.lwjgl.opengl.DisplayMode(child.getWidth(), child.getHeight()));';
// PATCHED = ANCHOR + setLocation 句（锚点是补丁串的前缀——再入护栏因此必须显式存在）
const PATCHED = ANCHOR + 'org.lwjgl.opengl.Display.setLocation(frame.getX(), frame.getY());';
const countStr = (hay, needle) => hay.split(needle).length - 1;

/**
 * 合成 class：合法 header + 常量池（Utf8 携带 setParent 折叠源串、Class、Integer、Long 双槽、
 * 未知尾随区段模拟方法体——patchDeawtClassBytes 只解析常量池，其后字节原样保留）。
 */
function buildSyntheticDeawtClass(opts = {}) {
  const anchorLine = opts.noAnchor
    ? 'org.lwjgl.opengl.Display.setFullScreen(true);'
    : ANCHOR;
  const body =
    '{    if ($1 == null) return;    java.awt.Frame frame = (java.awt.Frame) parent;' +
    `    ${anchorLine}` +
    '    org.lwjgl.opengl.Display.setResizable(true);}';
  const utf8s = [
    Buffer.from(body, 'latin1'),
    Buffer.from('uk/betacraft/legacyfix/patch/impl/lwjgl/DeAwtPatch', 'latin1'),
  ];
  if (opts.extraUtf8Anchor) utf8s.push(Buffer.from(`pad ${ANCHOR} pad`, 'latin1'));

  const parts = [];
  const head = Buffer.alloc(10);
  head.writeUInt32BE(0xcafebabe, 0);
  head.writeUInt16BE(0, 4); // minor
  head.writeUInt16BE(52, 6); // major（JDK8）
  // 条目数：utf8 组 + Class(7) + Integer(3) + Long(5，占两槽)
  const cpCount = utf8s.length + 3 + 1;
  head.writeUInt16BE(cpCount, 8);
  parts.push(head);
  for (const u of utf8s) {
    const t = Buffer.alloc(3);
    t.writeUInt8(1, 0);
    t.writeUInt16BE(u.length, 1);
    parts.push(t, u);
  }
  const classEnt = Buffer.alloc(3);
  classEnt.writeUInt8(7, 0);
  classEnt.writeUInt16BE(1, 1);
  parts.push(classEnt);
  const intEnt = Buffer.alloc(5);
  intEnt.writeUInt8(3, 0);
  intEnt.writeUInt32BE(42, 1);
  parts.push(intEnt);
  const longEnt = Buffer.alloc(9);
  longEnt.writeUInt8(5, 0);
  longEnt.writeBigUInt64BE(7n, 1);
  parts.push(longEnt);
  parts.push(Buffer.from('METHODS-AND-ATTRIBUTES-RAW-REGION', 'latin1'));
  return Buffer.concat(parts);
}

function buildJar(classBytes, t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attic-lfpatch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const jar = path.join(dir, 'legacyfix.jar');
  writeZipEntries(jar, [
    { name: 'META-INF/MANIFEST.MF', method: 8, dosTime: 0x4445, dosDate: 0x5678, data: Buffer.from('Manifest-Version: 1.0\r\n\r\n', 'latin1') },
    { name: DEAWT_ENTRY, method: 8, dosTime: 0x1234, dosDate: 0x2345, data: classBytes },
    { name: 'uk/betacraft/legacyfix/Agent.class', method: 0, dosTime: 0, dosDate: 0, data: Buffer.from('AGENT-PLACEHOLDER', 'latin1') },
  ]);
  return jar;
}

const sha256Hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

test('class 补丁：setLocation 交接句注入锚点之后，锚点保持恰 1 次，其余字节原样', () => {
  const classBytes = buildSyntheticDeawtClass();
  const patched = patchDeawtClassBytes(classBytes);
  assert.ok(patched, '应成功补丁');
  const text = patched.toString('latin1');
  assert.ok(text.includes(PATCHED), '补丁串应在');
  assert.equal(countStr(text, ANCHOR), 1, '锚点（含 setResizable 前缀形态）仍恰 1 次');
  assert.ok(text.includes('org.lwjgl.opengl.Display.setLocation(frame.getX(), frame.getY());'), '交接句应在');
  // 长度差 = setLocation 句长度
  assert.equal(patched.length, classBytes.length + (PATCHED.length - ANCHOR.length));
  // 尾部原始区段（方法体/属性模拟区）逐字节不变
  assert.equal(
    patched.subarray(patched.length - 30).toString('latin1'),
    classBytes.subarray(classBytes.length - 30).toString('latin1')
  );
  // 幂等：再跑一次命中再入护栏 → null，防双重插入
  assert.equal(patchDeawtClassBytes(patched), null);
});

test('class 补丁门控：锚点缺失 / 双条目命中 / 坏 magic / 未知 tag 均返回 null', () => {
  const base = buildSyntheticDeawtClass();
  // 锚点缺失（合成体不含 ANCHOR 句——noAnchor 变体换成了别的调用句）
  assert.equal(patchDeawtClassBytes(buildSyntheticDeawtClass({ noAnchor: true })), null);
  // 双 Utf8 条目各含一次锚点 → hits!=1 拒绝
  assert.equal(patchDeawtClassBytes(buildSyntheticDeawtClass({ extraUtf8Anchor: true })), null);
  // 坏 magic
  const badMagic = Buffer.from(base);
  badMagic.writeUInt32BE(0xdeadbeef, 0);
  assert.equal(patchDeawtClassBytes(badMagic), null);
  // 未知 tag（把 Class 条目的 tag 7 改成 99）→ 结构不可信拒绝
  const badTag = Buffer.from(base);
  const cpEnd = 10; // 顺序：utf8 组之后第一个是 Class；先跳过 utf8 条目找到 tag 7
  let p = cpEnd;
  for (;;) {
    const tag = badTag[p];
    if (tag === 1) {
      p += 3 + badTag.readUInt16BE(p + 1);
    } else break;
  }
  badTag[p] = 99;
  assert.equal(patchDeawtClassBytes(badTag), null);
});

test('jar 原位补丁：钉版命中 → patched；重入 → already；回写 zip 结构可被既有工具读回', (t) => {
  const classBytes = buildSyntheticDeawtClass();
  const jar = buildJar(classBytes, t);
  const pins = new Set([sha256Hex(classBytes)]);

  assert.deepEqual(applyLegacyfixDeawtPatch(jar, pins), { status: 'patched' });
  const entries = readZipEntries(jar);
  const entry = entries.find((e) => e.name === DEAWT_ENTRY);
  assert.ok(entry.data.toString('latin1').includes(PATCHED));
  // 其余条目字节不变（MANIFEST 与 Agent.class 原样）
  const agent = entries.find((e) => e.name === 'uk/betacraft/legacyfix/Agent.class');
  assert.equal(agent.data.toString('latin1'), 'AGENT-PLACEHOLDER');
  const mf = entries.find((e) => e.name === 'META-INF/MANIFEST.MF');
  assert.equal(mf.data.toString('latin1'), 'Manifest-Version: 1.0\r\n\r\n');

  // 幂等重入
  assert.deepEqual(applyLegacyfixDeawtPatch(jar, pins), { status: 'already' });
  // zip 工具链兼容：中央目录清单 + 全量解出
  assert.deepEqual(listZipEntryNames(jar).sort(), [DEAWT_ENTRY, 'META-INF/MANIFEST.MF', 'uk/betacraft/legacyfix/Agent.class'].sort());
  const outDir = path.join(path.dirname(jar), 'extract');
  assert.equal(extractZipTo(jar, outDir), 3);
  assert.ok(fs.readFileSync(path.join(outDir, DEAWT_ENTRY)).equals(entry.data));
});

test('jar 补丁门控：未钉版 skipped 且 jar 字节不变；无 DeAwtPatch 条目 skipped；jar 不存在 skipped', (t) => {
  const classBytes = buildSyntheticDeawtClass();
  const jar = buildJar(classBytes, t);
  const before = fs.readFileSync(jar);

  const miss = applyLegacyfixDeawtPatch(jar, new Set(['f'.repeat(64)]));
  assert.equal(miss.status, 'skipped');
  assert.match(miss.reason, /未钉版/);
  assert.ok(fs.readFileSync(jar).equals(before), '未钉版绝不改写 jar');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attic-lfpatch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const noDeawt = path.join(dir, 'other.jar');
  writeZipEntries(noDeawt, [{ name: 'a.txt', method: 0, dosTime: 0, dosDate: 0, data: Buffer.from('hi') }]);
  const r2 = applyLegacyfixDeawtPatch(noDeawt, new Set([sha256Hex(classBytes)]));
  assert.equal(r2.status, 'skipped');
  assert.match(r2.reason, /无 DeAwtPatch\.class/);

  const r3 = applyLegacyfixDeawtPatch(path.join(dir, 'missing.jar'), new Set());
  assert.equal(r3.status, 'skipped');
});

// ---------- extractZipTo 自愈与严格化（2026-11-02 隐性 bug 审计：存在即跳过 = 半截幸存） ----------

test('extractZipTo：半截文件（size 不符）重解自愈；完好目标零重写；截断数据段抛；strictMethods 拒静默跳过', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attic-zipfix-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const zip = path.join(dir, 'natives.zip');
  writeZipEntries(zip, [{ name: 'lwjgl.dll', method: 0, dosTime: 0, dosDate: 0, data: Buffer.from('fake-dll-contents') }]);
  const out = path.join(dir, 'out');
  assert.equal(extractZipTo(zip, out), 1);
  const dll = path.join(out, 'lwjgl.dll');
  fs.writeFileSync(dll, 'half'); // 模拟上次 ENOSPC/被杀留下的半截幸存
  assert.equal(extractZipTo(zip, out), 1, 'size 不符 = 重解（存在即跳过不再成立）');
  assert.equal(fs.readFileSync(dll, 'utf8'), 'fake-dll-contents');
  assert.equal(extractZipTo(zip, out), 0, '完好目标 = 零重写');

  const buf = fs.readFileSync(zip);
  const cd = buf.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));

  const trunc = Buffer.from(buf);
  trunc.writeUInt32LE(0xffff, cd + 20); // compSize 吹到超缓冲尾
  const truncZip = path.join(dir, 'trunc.zip');
  fs.writeFileSync(truncZip, trunc);
  assert.throws(() => extractZipTo(truncZip, path.join(dir, 'out2')), /截断/);

  const odd = Buffer.from(buf);
  odd.writeUInt16LE(14, cd + 10); // 中央目录 method=bzip2（本地头无需同步：method 只从中目录读）
  const oddZip = path.join(dir, 'odd.zip');
  fs.writeFileSync(oddZip, odd);
  assert.equal(extractZipTo(oddZip, path.join(dir, 'out3')), 0, '宽容模式罕见法照旧跳过');
  assert.throws(() => extractZipTo(oddZip, path.join(dir, 'out4'), { strictMethods: true }), /不支持的压缩法/);
});
