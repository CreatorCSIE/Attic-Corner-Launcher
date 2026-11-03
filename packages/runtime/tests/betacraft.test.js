'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { BetacraftClient, parseVersionList, eraForDate, sweepPartFiles } = require('../dist/index.js');
const { buildZip } = require('./zipFixture');

function sha1(text) {
  return crypto.createHash('sha1').update(text).digest('hex');
}

function fakeFetch(routes) {
  return async (url) => {
    const entry = routes[url];
    if (entry === undefined) return new Response('not found', { status: 404 });
    if (typeof entry === 'string') {
      return new Response(entry, {
        status: 200,
        headers: { 'content-length': String(Buffer.byteLength(entry)) },
      });
    }
    return new Response(JSON.stringify(entry), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

function tempRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attic-bc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('parseVersionList：真实行形状（反引号分隔，4/5 字段混排）', () => {
  const text = [
    'c0.0.15a-05311904`Multiplayer Test 1`1243796664000`1243796740000`15a-05311904',
    '4k-021742``1259775720000`1259775720000',
    '',
  ].join('\n');
  const refs = parseVersionList(text);
  assert.equal(refs.length, 2);
  assert.deepEqual(refs[0], {
    id: 'c0.0.15a-05311904',
    repository: 'betacraft',
    displayName: 'Multiplayer Test 1',
    compileDate: 1243796664000,
    releaseDate: 1243796740000,
    era: 'classic',
    installed: false,
    protocol: '15a-05311904',
  });
  assert.equal(refs[1].displayName, undefined);
  assert.equal(refs[1].protocol, undefined, '4 字段行无第 5 列 = protocol 缺席');
});

test('parseVersionList：数据缺陷矫正（双 0 日期归位 + 4k 单开年代组）', () => {
  const text = [
    'b1.2_02-dev-20110517``0`0',
    '2.0-preview``0`0',
    '4k-0144``1259891046000`1259891046000',
    'b1.2_02``1295618254000`1295618277000',
    '2.0-red``1364841286000`1364841286001',
  ].join('\n');
  const by = new Map(parseVersionList(text).map((r) => [r.id, r]));
  // 双 0 不再误归 pre-classic：dev 版按 id 日期归 Beta 且排在 b1.2_02 后
  assert.equal(by.get('b1.2_02-dev-20110517').era, 'beta');
  assert.ok(by.get('b1.2_02-dev-20110517').compileDate > by.get('b1.2_02').compileDate);
  // 2.0-preview 归 Release 且紧随 2.0-red 前
  assert.equal(by.get('2.0-preview').era, 'release-1.0-1.5.2');
  assert.ok(by.get('2.0-preview').compileDate < by.get('2.0-red').compileDate);
  // 4k-* 单开年代组
  assert.equal(by.get('4k-0144').era, '4k');
});

test('parseVersionList：1.0.0 边界区命名规则（rc 系无条件钉 beta，tominecon/1.0.0 归 release）', () => {
  const text = [
    // 假想更晚 compile 的 rc（越过 11-14 边界）——命名规则兜底，仍归 beta
    '1.0.0-rc9``1321400000000`1321400000000',
    '1.0.0-tominecon``1321267414000`1321395786000',
    '1.0.0``1321289032000`1321653290000',
  ].join('\n');
  const by = new Map(parseVersionList(text).map((r) => [r.id, r]));
  assert.equal(by.get('1.0.0-rc9').era, 'beta');
  assert.equal(by.get('1.0.0-tominecon').era, 'release-1.0-1.5.2');
  assert.equal(by.get('1.0.0').era, 'release-1.0-1.5.2');
});

test('parseVersionList：-renew 重传行继承基名日期/年代（基名缺席不动）', () => {
  const text = [
    'c0.30-c-1900`c0.30_01c`1257879638000`1257879900001`classic_7',
    // 重传时刻写进日期栏（真实事故形状）：不矫正则 eraForDate(2011-07-31) 误归 beta
    'c0.30-c-1900-renew`c0.30_01c`1312118096000`1312118096000`classic_7',
    'orphan-renew``1312118096000`1312118096000',
  ].join('\n');
  const by = new Map(parseVersionList(text).map((r) => [r.id, r]));
  const renew = by.get('c0.30-c-1900-renew');
  assert.equal(renew.era, 'classic');
  assert.equal(renew.compileDate, 1257879638000);
  assert.equal(renew.releaseDate, 1257879900001);
  // 基名缺席：三值原样保留（无副作用）
  const orphan = by.get('orphan-renew');
  assert.equal(orphan.compileDate, 1312118096000);
  assert.equal(orphan.era, 'beta');
});

test('eraForDate：年代边界（编译日期）', () => {
  assert.equal(eraForDate(1242245460000), 'pre-classic'); // rd-20090513
  assert.equal(eraForDate(1243796664000), 'classic'); // c0.0.15a
  assert.equal(eraForDate(1261580346000), 'indev'); // in-20091223
  assert.equal(eraForDate(1270137600000), 'infdev'); // 2010-04
  assert.equal(eraForDate(1277856000000), 'alpha'); // 2010-06-30
  assert.equal(eraForDate(1292866740000), 'beta'); // b1.0
  assert.equal(eraForDate(1310110334000), 'beta'); // b1.7.3
  assert.equal(eraForDate(1321025580000), 'beta'); // b1.9-pre6（真 beta 末位）
  assert.equal(eraForDate(1321196546000), 'beta'); // 1.0.0-rc1（用户拍板：rc 系仍属 beta 段）
  assert.equal(eraForDate(1321203394000), 'beta'); // 1.0.0-rc2-1656（rc 末位，边界前最后一名）
  assert.equal(eraForDate(1321267414000), 'release-1.0-1.5.2'); // 1.0.0-tominecon（release 组首位）
  assert.equal(eraForDate(1321289032000), 'release-1.0-1.5.2'); // 1.0.0 本尊
  assert.equal(eraForDate(1368748800000), 'release-1.0-1.5.2'); // 1.5.2
});

test('download：成功路径事件序 + 落盘内容', async (t) => {
  const root = tempRoot(t);
  const events = [];
  const content = 'JARBYTES';
  const client = new BetacraftClient({
    fetchImpl: fakeFetch({ 'http://x/client.jar': content }),
    onProgress: (e) => events.push(e),
  });
  const dest = path.join(root, 'versions', 'b1.7.3.jar');
  await client.download('http://x/client.jar', dest, 'client-jar', 'b1.7.3', {
    algo: 'sha1',
    value: sha1(content),
  });
  assert.equal(fs.readFileSync(dest, 'utf8'), content);
  const phases = events.map((e) => e.phase);
  assert.equal(phases[0], 'queued');
  assert.ok(phases.includes('verifying'));
  assert.equal(phases[phases.length - 1], 'done');
});

test('download：sha1 不符 → failed 事件 + 删文件 + 抛错', async (t) => {
  const root = tempRoot(t);
  const events = [];
  const client = new BetacraftClient({
    fetchImpl: fakeFetch({ 'http://x/bad.jar': 'CORRUPT' }),
    onProgress: (e) => events.push(e),
  });
  const dest = path.join(root, 'versions', 'bad.jar');
  await assert.rejects(
    () => client.download('http://x/bad.jar', dest, 'client-jar', 'bad', { algo: 'sha1', value: '0'.repeat(40) }),
    /sha1 校验失败/,
  );
  assert.equal(fs.existsSync(dest), false);
  const failed = events.find((e) => e.phase === 'failed');
  assert.ok(failed && /sha1/.test(failed.error));
});

test('downloadClientJar：本地已存在且 sha1 相符则不重下', async (t) => {
  const root = tempRoot(t);
  const content = 'LOCAL';
  const digest = sha1(content);
  fs.mkdirSync(path.join(root, 'versions'), { recursive: true });
  fs.writeFileSync(path.join(root, 'versions', 'c2.0.jar'), content);
  let fetched = 0;
  const client = new BetacraftClient({
    fetchImpl: async (url) => {
      fetched++;
      return fakeFetch({ [url]: content })(url);
    },
  });
  await client.downloadClientJar({ id: 'c2.0', jar: { url: 'http://x/c2.0.jar', sha1: digest } }, root);
  assert.equal(fetched, 0);
});

test('downloadClientJar：verify=false 存在即复用（损坏也不复核）', async (t) => {
  const root = tempRoot(t);
  fs.mkdirSync(path.join(root, 'versions'), { recursive: true });
  fs.writeFileSync(path.join(root, 'versions', 'c2.0.jar'), 'CORRUPT');
  let fetched = 0;
  const client = new BetacraftClient({
    fetchImpl: async (url) => {
      fetched++;
      return fakeFetch({ [url]: 'GOOD' })(url);
    },
  });
  await client.downloadClientJar({ id: 'c2.0', jar: { url: 'http://x/c2.0.jar', sha1: sha1('GOOD') } }, root, { verify: false });
  assert.equal(fetched, 0);
  assert.equal(fs.readFileSync(path.join(root, 'versions', 'c2.0.jar'), 'utf8'), 'CORRUPT');
});

test('downloadClientJar：repair=false 复核不符显式抛错（不静默覆盖）', async (t) => {
  const root = tempRoot(t);
  fs.mkdirSync(path.join(root, 'versions'), { recursive: true });
  fs.writeFileSync(path.join(root, 'versions', 'c2.0.jar'), 'CORRUPT');
  const client = new BetacraftClient({ fetchImpl: fakeFetch({ 'http://x/c2.0.jar': 'GOOD' }) });
  await assert.rejects(
    () => client.downloadClientJar({ id: 'c2.0', jar: { url: 'http://x/c2.0.jar', sha1: sha1('GOOD') } }, root, { repair: false }),
    /校验不符.*自动补全已禁用/,
  );
  assert.equal(fs.readFileSync(path.join(root, 'versions', 'c2.0.jar'), 'utf8'), 'CORRUPT');
});

test('downloadClientJar：repair=false 缺失显式抛错（不擅自下载）', async (t) => {
  const root = tempRoot(t);
  const client = new BetacraftClient({ fetchImpl: fakeFetch({ 'http://x/c2.0.jar': 'GOOD' }) });
  await assert.rejects(
    () => client.downloadClientJar({ id: 'c2.0', jar: { url: 'http://x/c2.0.jar', sha1: sha1('GOOD') } }, root, { repair: false }),
    /缺失.*自动补全已禁用/,
  );
});

test('downloadClientJar：缺省行为损坏时自动重下修复', async (t) => {
  const root = tempRoot(t);
  fs.mkdirSync(path.join(root, 'versions'), { recursive: true });
  fs.writeFileSync(path.join(root, 'versions', 'c2.0.jar'), 'CORRUPT');
  const client = new BetacraftClient({ fetchImpl: fakeFetch({ 'http://x/c2.0.jar': 'GOOD' }) });
  await client.downloadClientJar({ id: 'c2.0', jar: { url: 'http://x/c2.0.jar', sha1: sha1('GOOD') } }, root);
  assert.equal(fs.readFileSync(path.join(root, 'versions', 'c2.0.jar'), 'utf8'), 'GOOD');
});

test('downloadClientJar：force=true 旁路「存在即复用」重下（实例 forceUpdate 语义）', async (t) => {
  const root = tempRoot(t);
  fs.mkdirSync(path.join(root, 'versions'), { recursive: true });
  fs.writeFileSync(path.join(root, 'versions', 'c2.0.jar'), 'FRESH');
  let fetched = 0;
  const client = new BetacraftClient({
    fetchImpl: async (url) => {
      fetched++;
      return fakeFetch({ [url]: 'FRESH' })(url);
    },
  });
  const json = { id: 'c2.0', jar: { url: 'http://x/c2.0.jar', sha1: sha1('FRESH') } };
  // 基线：sha1 相符 → 不重下
  await client.downloadClientJar(json, root);
  assert.equal(fetched, 0);
  // force：相符也重下（覆盖本地文件）
  await client.downloadClientJar(json, root, { force: true });
  assert.equal(fetched, 1);
  assert.equal(fs.readFileSync(path.join(root, 'versions', 'c2.0.jar'), 'utf8'), 'FRESH');
  // force 压过 repair=false 的「缺失抛错」（强制更新场景直接补下）
  fs.rmSync(path.join(root, 'versions', 'c2.0.jar'));
  await client.downloadClientJar(json, root, { repair: false, force: true });
  assert.equal(fetched, 2);
  assert.equal(fs.readFileSync(path.join(root, 'versions', 'c2.0.jar'), 'utf8'), 'FRESH');
});

test('downloadLibrariesToBin：force=true 覆盖已存在库（缺失才下基线不回归）', async (t) => {
  const root = tempRoot(t);
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'bin', 'gson-2.8.0.jar'), 'OLD');
  let fetched = 0;
  const client = new BetacraftClient({
    fetchImpl: async (url) => {
      fetched++;
      return fakeFetch({ [url]: 'NEW' })(url);
    },
  });
  const json = { id: 'x', libraries: [{ name: 'com.google.code.gson:gson:2.8.0', url: 'http://x/gson-2.8.0.jar' }] };
  await client.downloadLibrariesToBin(json, root);
  assert.equal(fetched, 0, '已存在默认不重下');
  await client.downloadLibrariesToBin(json, root, { force: true });
  assert.equal(fetched, 1);
  assert.equal(fs.readFileSync(path.join(root, 'bin', 'gson-2.8.0.jar'), 'utf8'), 'NEW');
});

test('downloadLibrariesToBin：污染闸门——LWJGL/JInput 族一律不下（depends 独占供给）', async (t) => {
  const root = tempRoot(t);
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  let fetched = 0;
  const client = new BetacraftClient({
    fetchImpl: async (url) => {
      fetched++;
      return fakeFetch({ [url]: 'X' })(url);
    },
  });
  const json = {
    id: 'x',
    libraries: [
      { name: 'org.lwjgl.lwjgl:lwjgl:2.9.0', url: 'http://x/lwjgl-2.9.0.jar' },
      { name: 'org.lwjgl.lwjgl:lwjgl_util:2.9.0', url: 'http://x/lwjgl_util-2.9.0.jar' },
      { name: 'org.lwjgl:lwjgl:2.9.4-nightly', url: 'http://x/lwjgl-nightly.jar' },
      { name: 'net.java.jinput:jinput:2.0.5', url: 'http://x/jinput-2.0.5.jar' },
      { name: 'com.google.code.gson:gson:2.8.0', url: 'http://x/gson-2.8.0.jar' },
    ],
  };
  await client.downloadLibrariesToBin(json, root, { force: true });
  assert.equal(fetched, 1, '仅非受管族 gson 落池');
  assert.ok(fs.existsSync(path.join(root, 'bin', 'gson-2.8.0.jar')));
  assert.ok(!fs.existsSync(path.join(root, 'bin', 'lwjgl-2.9.0.jar')), '原生 lwjgl 不得进池劫持类加载');
  assert.ok(!fs.existsSync(path.join(root, 'bin', 'jinput-2.0.5.jar')));
});

test('ensureLegacyfix：钉版直链下载落位（不走 api.github.com，版本=文件名派生）', async (t) => {
  const root = tempRoot(t);
  const jar = 'LEGACYFIX';
  const client = new BetacraftClient({
    fetchImpl: fakeFetch({
      'https://github.com/CreatorCSIE/legacyfix-attic/releases/download/26.10/legacyfix-26.10.jar': jar,
    }),
  });
  const dest = await client.ensureLegacyfix(root, 'legacyfix/legacyfix-26.10.jar');
  assert.equal(dest, path.join(root, 'legacyfix', 'legacyfix-26.10.jar'));
  assert.equal(fs.readFileSync(dest, 'utf8'), jar);
});

test('ensureLegacyfixAsset：addon jar 显式版本落位（同 release 同 URL 拼装/同 meta 锚自愈）', async (t) => {
  const jar = buildZip(['uk/betacraft/legacyfix/addon/Fullscreen.class']);
  const root = tempRoot(t);
  let fetches = 0;
  const client = new BetacraftClient({
    fetchImpl: async (url) => {
      if (url === 'https://github.com/CreatorCSIE/legacyfix-attic/releases/download/26.10-attic.6/legacyfix-addon-fullscreen-26.10-attic.6.jar') {
        fetches++;
        return new Response(jar, { status: 200, headers: { 'content-length': String(jar.length) } });
      }
      return new Response('not found', { status: 404 });
    },
  });
  const rel = path.join('launcher', 'addons', 'legacyfix-addon-fullscreen-26.10-attic.6.jar');
  const dest = await client.ensureLegacyfixAsset(root, rel, '26.10-attic.6');
  assert.equal(dest, path.join(root, 'launcher', 'addons', 'legacyfix-addon-fullscreen-26.10-attic.6.jar'));
  assert.ok(fs.existsSync(`${dest}.meta`), 'meta 锚随 addon jar 同立');
  // 完好复核 = 不重下；截断（无 EOCD）= 自愈重下——与 agent jar 同一纪律
  await client.ensureLegacyfixAsset(root, rel, '26.10-attic.6');
  assert.equal(fetches, 1);
  fs.writeFileSync(dest, 'TRUNC');
  await client.ensureLegacyfixAsset(root, rel, '26.10-attic.6');
  assert.equal(fetches, 2);
  assert.ok(fs.readFileSync(dest).equals(jar), '自愈重下还原完整构件');
});

test('ensureLegacyfix：文件名无版本号 = 数据表错误，直链无从派生 → 显式报错', async (t) => {
  const root = tempRoot(t);
  const client = new BetacraftClient({ fetchImpl: fakeFetch({}) });
  await assert.rejects(
    () => client.ensureLegacyfix(root, 'legacyfix/legacyfix.jar'),
    /无法从 agentMount 文件名解析 legacyfix 版本/,
  );
});

/* ---------------- 0.0.2 feat②：原子写 + legacyfix SHA 校验自愈 ---------------- */

test('download：原子写——成功后 dest 侧无 .part 残留', async (t) => {
  const root = tempRoot(t);
  const client = new BetacraftClient({ fetchImpl: fakeFetch({ 'http://x/a.jar': 'ATOM' }) });
  const dest = path.join(root, 'a.jar');
  await client.download('http://x/a.jar', dest, 'client-jar', 'a');
  assert.equal(fs.readFileSync(dest, 'utf8'), 'ATOM');
  assert.equal(fs.existsSync(`${dest}.part`), false);
});

test('download：流中途 error → 清 .part、dest 不出现、failed 事件', async (t) => {
  const root = tempRoot(t);
  const events = [];
  const stream = new ReadableStream({
    start(c) {
      c.enqueue(new Uint8Array([1, 2, 3]));
      c.error(new Error('stream broken'));
    },
  });
  const client = new BetacraftClient({
    fetchImpl: async () => new Response(stream),
    onProgress: (e) => events.push(e),
  });
  const dest = path.join(root, 'broken.jar');
  await assert.rejects(() => client.download('http://x/broken.jar', dest, 'client-jar', 'broken'), /stream broken/);
  assert.equal(fs.existsSync(dest), false, '半截流绝不落 dest');
  assert.equal(fs.existsSync(`${dest}.part`), false);
  const failed = events.find((e) => e.phase === 'failed');
  assert.ok(failed && /stream broken/.test(failed.error));
});

test('download：signal 流中途中止 → cancelled 事件（非 failed）+ 清 .part', async (t) => {
  const root = tempRoot(t);
  const ac = new AbortController();
  const events = [];
  let n = 0;
  const stream = new ReadableStream({ pull(c) { c.enqueue(new Uint8Array([n++])); } });
  const client = new BetacraftClient({
    fetchImpl: async () => new Response(stream),
    onProgress: (e) => {
      events.push(e);
      if (e.phase === 'transferring') ac.abort(new Error('user cancel'));
    },
  });
  const dest = path.join(root, 'cancel.jar');
  await assert.rejects(
    () => client.download('http://x/cancel.jar', dest, 'client-jar', 'cancel', undefined, ac.signal),
    /user cancel/,
  );
  assert.equal(fs.existsSync(dest), false);
  assert.equal(fs.existsSync(`${dest}.part`), false);
  assert.ok(events.some((e) => e.phase === 'cancelled'), '取消落中性态事件');
  assert.equal(events.some((e) => e.phase === 'failed'), false);
});

test('sweepPartFiles：递归清扫 .part（depth 控制、正常文件不动、缺目录静默）', (t) => {
  const root = tempRoot(t);
  fs.mkdirSync(path.join(root, 'sub', 'deep'), { recursive: true });
  for (const rel of ['a.part', path.join('sub', 'b.part'), path.join('sub', 'deep', 'c.part')]) {
    fs.writeFileSync(path.join(root, rel), 'x');
  }
  fs.writeFileSync(path.join(root, 'keep.jar'), 'y');
  sweepPartFiles(root, 2);
  assert.equal(fs.existsSync(path.join(root, 'a.part')), false);
  assert.equal(fs.existsSync(path.join(root, 'sub', 'b.part')), false);
  assert.equal(fs.existsSync(path.join(root, 'sub', 'deep', 'c.part')), true, '超出 depth 不清');
  assert.equal(fs.existsSync(path.join(root, 'keep.jar')), true);
  sweepPartFiles(path.join(root, 'nonexistent'), 3); // 缺目录 = 静默无残留可清
});

/** legacyfix 自愈测试台：合法 EOCD jar + jar 下载计数（钉版直链走 fakeFetch 表）。 */
function legacyfixHarness(t, jar) {
  const root = tempRoot(t);
  const dest = path.join(root, 'legacyfix', 'legacyfix-26.10.jar');
  let jarFetches = 0;
  const client = new BetacraftClient({
    fetchImpl: async (url) => {
      if (url === 'https://github.com/CreatorCSIE/legacyfix-attic/releases/download/26.10/legacyfix-26.10.jar') {
        jarFetches++;
        return new Response(jar, { status: 200, headers: { 'content-length': String(jar.length) } });
      }
      return new Response('not found', { status: 404 });
    },
  });
  return { root, dest, client, fetches: () => jarFetches };
}

test('ensureLegacyfix：完好文件复核通过不重下；截断（无 EOCD）→ 自愈重下', async (t) => {
  const jar = buildZip(['uk/betacraft/legacyfix/A.class']);
  const h = legacyfixHarness(t, jar);
  await h.client.ensureLegacyfix(h.root, 'legacyfix/legacyfix-26.10.jar');
  assert.equal(h.fetches(), 1);
  assert.ok(fs.existsSync(`${h.dest}.meta`), '下载后立本地锚点');
  await h.client.ensureLegacyfix(h.root, 'legacyfix/legacyfix-26.10.jar');
  assert.equal(h.fetches(), 1, '三级校验全过 = 不重下');
  fs.writeFileSync(h.dest, jar.subarray(0, Math.floor(jar.length / 2))); // 网络中断半截形态
  await h.client.ensureLegacyfix(h.root, 'legacyfix/legacyfix-26.10.jar');
  assert.equal(h.fetches(), 2, 'EOCD 不过 → 删残件重下');
  assert.deepEqual(fs.readFileSync(h.dest), jar);
});

test('ensureLegacyfix：同长度篡改（size 过、sha256 不符）→ 自愈重下', async (t) => {
  const jar = buildZip(['uk/betacraft/legacyfix/B.class']);
  const h = legacyfixHarness(t, jar);
  await h.client.ensureLegacyfix(h.root, 'legacyfix/legacyfix-26.10.jar');
  const bad = Buffer.from(jar);
  bad[Math.floor(bad.length / 2)] ^= 0xff; // 中段翻一字节：size 不变、EOCD 仍在、sha256 变
  fs.writeFileSync(h.dest, bad);
  await h.client.ensureLegacyfix(h.root, 'legacyfix/legacyfix-26.10.jar');
  assert.equal(h.fetches(), 2);
  assert.deepEqual(fs.readFileSync(h.dest), jar);
});

test('ensureLegacyfix：无 meta 的历史存量 → TOFU 立锚不重下', async (t) => {
  const jar = buildZip(['uk/betacraft/legacyfix/C.class']);
  const h = legacyfixHarness(t, jar);
  fs.mkdirSync(path.dirname(h.dest), { recursive: true });
  fs.writeFileSync(h.dest, jar); // 0.0.1 存量：无 .meta
  await h.client.ensureLegacyfix(h.root, 'legacyfix/legacyfix-26.10.jar');
  assert.equal(h.fetches(), 0, '首见信任不触网重下');
  const meta = JSON.parse(fs.readFileSync(`${h.dest}.meta`, 'utf8'));
  assert.equal(meta.size, jar.length);
  assert.equal(meta.sha256, crypto.createHash('sha256').update(jar).digest('hex'));
});
