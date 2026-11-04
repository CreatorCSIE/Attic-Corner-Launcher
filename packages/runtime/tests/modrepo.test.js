'use strict';

/**
 * Mods 仓库（一期 = Betacraft 单源）测试面：
 * - parseModCategories：getmods.jsp JSON 防御式解析（v1 NPE/坏条目修复）；
 * - installMod：三道门禁（id 安全 / http(s) 白名单 / 官方同名拒绝）+ 原子落 .info + mods.json 登记；
 * - listMods：installed 实存标记、脏 id 不触文件系统；
 * - refreshModInfo / ensureModJar / composeModJars：启动期语义（autoupdate、sha1 强制、基座合成）；
 * - 自定义版本页联动：mod 落入本页（删除途径）、编辑门禁、删除清登记。
 * 启动编排（launch 的 mod 分支）由以上纯函数 + 门面门禁组合而成；spawn 面归 launch.test.js 既有纪律。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  AtticRuntime,
  BetacraftClient,
  parseModCategories,
  composeModJars,
  refreshModInfo,
  readModRegistry,
  isModVersionJson,
  readZipEntries,
} = require('../dist/index.js');
const { buildZip, buildJarBuffer } = require('./zipFixture.js');

function sha1(buf) {
  return crypto.createHash('sha1').update(buf).digest('hex');
}

function fakeFetch(routes) {
  return async (url) => {
    const entry = routes[url];
    if (entry === undefined) return new Response('not found', { status: 404 });
    if (typeof entry === 'string') {
      return new Response(entry, { status: 200, headers: { 'content-length': String(Buffer.byteLength(entry)) } });
    }
    if (Buffer.isBuffer(entry)) {
      return new Response(entry, { status: 200, headers: { 'content-length': String(entry.byteLength) } });
    }
    return new Response(JSON.stringify(entry), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

const MODS_LIST_URL = 'http://x/getmods.jsp';
const VERSION_LIST_URL = 'http://x/version_list.txt';
const TEST_ENDPOINTS = {
  versionList: VERSION_LIST_URL,
  versionJson: (id) => `http://x/jsons/${id}.info`,
  assetIndex: (id) => `http://x/indexes/${id}.json`,
  zuluMetadata: 'http://x/zulu',
  modsList: MODS_LIST_URL,
};

function mkRoot(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function tempRuntime(t, routes) {
  const dir = mkRoot(t, 'attic-mod-');
  const rt = new AtticRuntime({ rootDir: dir, endpoints: TEST_ENDPOINTS, fetchImpl: fakeFetch(routes) });
  return { rt, dir };
}

const jsonsDir = (dir) => path.join(dir, 'versions', 'jsons');
const infoOf = (dir, id) => path.join(jsonsDir(dir), `${id}.info`);
const modsDirOf = (dir) => path.join(dir, 'versions', 'mods');

/** getmods.jsp 形状示意：1 好分类（含缺省字段条目 + 坏条目）+ 1 mods=null 坏分类。 */
const GETMODS_BODY = JSON.stringify([
  {
    mod_category: 'APIs',
    mods: [
      {
        full_name: 'WorldAPI',
        version: 'WorldAPI Beta 5',
        info_file_url: 'http://x/WorldAPI.info',
        website: 'http://x/worldapi',
        autoupdate: true,
      },
      { full_name: 'ModLoader', info_file_url: 'http://x/ModLoader.info' },
      { full_name: 'BrokenNoUrl' },
    ],
  },
  { mod_category: 'Broken', mods: null },
]);

const INFO_TEXT = 'base-version=b1.7.3\nurl=http://x/WorldAPI.jar\nsha1=0000000000000000000000000000000000000000\n';

// ---------- 列表解析 ----------

test('parseModCategories：5 字段映射 + 缺省兜底 + 坏条目剔除', () => {
  const cats = parseModCategories(GETMODS_BODY);
  assert.equal(cats.length, 1, 'mods=null 的坏分类整类剔除（v1 NPE 源）');
  assert.equal(cats[0].name, 'APIs');
  assert.deepEqual(cats[0].mods[0], {
    fullName: 'WorldAPI',
    version: 'WorldAPI Beta 5',
    infoFileUrl: 'http://x/WorldAPI.info',
    website: 'http://x/worldapi',
    autoupdate: true,
  });
  // version 缺 → fullName 兜底（v1 树节点文本语义）；autoupdate 非 true → false；website 缺 → 无键
  assert.equal(cats[0].mods[1].version, 'ModLoader');
  assert.equal(cats[0].mods[1].autoupdate, false);
  assert.equal(cats[0].mods[1].website, undefined);
  assert.equal(cats[0].mods.length, 2, '必填缺失的条目剔除');
});

test('parseModCategories：顶层非数组 / 非 JSON = 显式抛错（上游形状崩坏不静默）', () => {
  assert.throws(() => parseModCategories('{"mod_category":"x"}'), /顶层不是数组/);
  assert.throws(() => parseModCategories('<html>404</html>'), /不是有效 JSON/);
});

test('parseModCategories：坏分类过滤（mods=null / 无名字 / 全坏条目=空分类）', () => {
  const cats = parseModCategories(
    JSON.stringify([
      { mod_category: 'A', mods: null },
      { mods: [{ full_name: 'x', info_file_url: 'http://x/i' }] },
      { mod_category: 'B', mods: [{ full_name: 'onlyName' }] },
      { mod_category: 'C', mods: [{ full_name: 'ok', info_file_url: 'http://x/ok.info' }] },
    ]),
  );
  assert.deepEqual(cats.map((c) => c.name), ['C']);
});

// ---------- 安装门禁与落盘 ----------

test('installMod：.info 原子落位 + mods.json 登记 + listMods installed 翻转', async (t) => {
  const { rt, dir } = tempRuntime(t, {
    [VERSION_LIST_URL]: 'b1.7.3``1310110334000`1310110334000\n',
    [MODS_LIST_URL]: GETMODS_BODY,
    'http://x/WorldAPI.info': INFO_TEXT,
  });
  await rt.installMod({ fullName: 'WorldAPI', infoFileUrl: 'http://x/WorldAPI.info', autoupdate: true });
  assert.ok(fs.existsSync(infoOf(dir, 'WorldAPI')), '.info 落 versions/jsons/');
  const reg = readModRegistry(dir);
  assert.equal(reg.WorldAPI.infoUrl, 'http://x/WorldAPI.info', '登记直链 = 启动期刷新唯一来源');
  assert.equal(reg.WorldAPI.autoupdate, true);
  const cats = await rt.listMods();
  assert.equal(cats[0].mods.find((m) => m.fullName === 'WorldAPI').installed, true);
  assert.equal(cats[0].mods.find((m) => m.fullName === 'ModLoader').installed, false);
  assert.deepEqual(fs.readdirSync(jsonsDir(dir)).filter((f) => f.endsWith('.tmp')), [], '无 .tmp 残留');
});

test('installMod：与官方版本同名 = 拒绝（先联网刷清单缓存再判）', async (t) => {
  const { rt, dir } = tempRuntime(t, {
    [VERSION_LIST_URL]: 'WorldAPI``1310110334000`1310110334000\n', // 上游把 mod 名列入官方清单
    [MODS_LIST_URL]: GETMODS_BODY,
    'http://x/WorldAPI.info': INFO_TEXT,
  });
  await assert.rejects(
    () => rt.installMod({ fullName: 'WorldAPI', infoFileUrl: 'http://x/WorldAPI.info', autoupdate: false }),
    /与 Betacraft 官方版本同名，拒绝安装/,
  );
  assert.ok(!fs.existsSync(infoOf(dir, 'WorldAPI')), '拒绝路径零落盘');
  assert.equal(readModRegistry(dir).WorldAPI, undefined);
});

test('installMod：不安全 id / 非 http(s) URL / 非法 URL 显式拒绝', async (t) => {
  const { rt } = tempRuntime(t, {});
  await assert.rejects(
    () => rt.installMod({ fullName: '../evil', infoFileUrl: 'http://x/a.info', autoupdate: false }),
    /非法版本 id/,
  );
  await assert.rejects(
    () => rt.installMod({ fullName: 'ok', infoFileUrl: 'file:///C:/evil.info', autoupdate: false }),
    /拒绝非 HTTP\(S\) 下载地址/,
  );
  await assert.rejects(
    () => rt.installMod({ fullName: 'ok', infoFileUrl: 'not a url', autoupdate: false }),
    /不是合法 URL/,
  );
});

test('installMod：下载失败不毁既有 .info（tmp+rename 原子写）', async (t) => {
  const { rt, dir } = tempRuntime(t, {
    [VERSION_LIST_URL]: 'b1.7.3``1310110334000`1310110334000\n',
    [MODS_LIST_URL]: GETMODS_BODY,
    // http://x/WorldAPI.info 无路由 = 404
  });
  fs.mkdirSync(jsonsDir(dir), { recursive: true });
  fs.writeFileSync(infoOf(dir, 'WorldAPI'), 'base-version=b1.7.3\nurl=OLD\n');
  await assert.rejects(
    () => rt.installMod({ fullName: 'WorldAPI', infoFileUrl: 'http://x/WorldAPI.info', autoupdate: true }),
    /HTTP 404/,
  );
  assert.equal(fs.readFileSync(infoOf(dir, 'WorldAPI'), 'utf8'), 'base-version=b1.7.3\nurl=OLD\n');
  assert.deepEqual(fs.readdirSync(jsonsDir(dir)).filter((f) => f.endsWith('.tmp')), []);
});

test('listMods：上游脏 id 不触文件系统（installed 恒 false）', async (t) => {
  const dirty = JSON.stringify([
    {
      mod_category: 'X',
      mods: [{ full_name: 'evil/../../pwn', version: 'v', info_file_url: 'http://x/e.info', autoupdate: false }],
    },
  ]);
  const { rt, dir } = tempRuntime(t, { [MODS_LIST_URL]: dirty });
  const cats = await rt.listMods();
  assert.equal(cats[0].mods[0].installed, false);
  assert.ok(!fs.existsSync(path.join(dir, 'pwn.info')));
});

test('已安装 mod：进 listVersions 本地组（jar 未合成=installed false），且落入自定义版本页（mod 标）', async (t) => {
  const { rt, dir } = tempRuntime(t, {
    [VERSION_LIST_URL]: 'b1.7.3``1310110334000`1310110334000\n',
    [MODS_LIST_URL]: GETMODS_BODY,
    'http://x/WorldAPI.info': INFO_TEXT,
  });
  await rt.installMod({ fullName: 'WorldAPI', infoFileUrl: 'http://x/WorldAPI.info', autoupdate: false });
  const refs = await rt.listVersions();
  const world = refs.find((r) => r.id === 'WorldAPI');
  assert.equal(world.repository, 'local');
  assert.equal(world.installed, false, 'versions/mods/ 缓存 jar 不算安装位，合成产物才算了');
  // mods/ 子目录不得污染版本列表（顶层扫描纪律）
  assert.ok(!refs.some((r) => r.id === 'mods'));
  // 用户拍板：mod 的删除途径 = 自定义版本页（base-version 即落入，打 mod 标）
  const custom = rt.listCustomVersions().find((v) => v.id === 'WorldAPI');
  assert.ok(custom, 'mod .info（base-version）落入自定义页');
  assert.equal(custom.mod, true);
  assert.equal(custom.configured, true);
  assert.equal(custom.installed, false);
});

test('自定义页 mod 项：右栏可读（mod 标）+ 编辑被拒 + 删除联动清 mods.json 登记', async (t) => {
  const { rt, dir } = tempRuntime(t, {
    [VERSION_LIST_URL]: 'b1.7.3``1310110334000`1310110334000\n',
    [MODS_LIST_URL]: GETMODS_BODY,
    'http://x/WorldAPI.info': INFO_TEXT,
  });
  await rt.installMod({ fullName: 'WorldAPI', infoFileUrl: 'http://x/WorldAPI.info', autoupdate: false });
  const view = rt.getCustomVersionInfo('WorldAPI');
  assert.equal(view.mod, true);
  assert.equal(view.props['base-version'], 'b1.7.3');
  // autoupdate 会整文件重写 .info → 编辑必丢：保存显式拒绝
  assert.throws(
    () => rt.saveCustomVersionInfo('WorldAPI', { 'launch-method': 'custom', 'main-class': 'a.b.C' }),
    /Mods 仓库托管/,
  );
  // 删除 = jar+.info+登记三合一清理（防幽灵条目复活）
  rt.removeCustomVersion('WorldAPI');
  assert.ok(!fs.existsSync(infoOf(dir, 'WorldAPI')));
  assert.equal(readModRegistry(dir).WorldAPI, undefined, 'mods.json 登记被联动清除');
  assert.ok(!rt.listCustomVersions().some((v) => v.id === 'WorldAPI'), '卸载后脱离自定义页');
  // base-version 托管判型键禁经编辑器写入：防普通自定义版本被误打成 Mod 永久只读
  fs.mkdirSync(jsonsDir(dir), { recursive: true });
  fs.writeFileSync(infoOf(dir, 'MyVer'), 'custom=true\nlaunch-method=custom\nmain-class=a.b.C\n', 'utf8');
  assert.throws(
    () => rt.saveCustomVersionInfo('MyVer', { 'launch-method': 'custom', 'main-class': 'a.b.C', 'base-version': 'b1.7.3' }),
    /base-version 是 Mods 仓库托管键/,
  );
});

// ---------- 启动期语义 ----------

test('refreshModInfo：autoupdate=false 且本地在位不联网；=true 或缺失才拉登记 URL', async (t) => {
  const dir = mkRoot(t, 'attic-modrf-');
  fs.mkdirSync(jsonsDir(dir), { recursive: true });
  fs.writeFileSync(infoOf(dir, 'M'), 'base-version=b1.7.3\nurl=OLD\n');
  let calls = 0;
  const fake = {
    download: async (url, destFile) => {
      calls += 1;
      assert.equal(url, 'http://x/M.info', '只走登记直链，不回落官方默认 versionJson URL');
      fs.writeFileSync(destFile, 'base-version=b1.7.3\nurl=FRESH\n');
    },
  };
  await refreshModInfo(fake, dir, 'M', { infoUrl: 'http://x/M.info', autoupdate: false, installedAt: 0 });
  assert.equal(calls, 0);
  await refreshModInfo(fake, dir, 'M', { infoUrl: 'http://x/M.info', autoupdate: true, installedAt: 0 });
  assert.equal(calls, 1);
  assert.match(fs.readFileSync(infoOf(dir, 'M'), 'utf8'), /FRESH/);
  // 本地缺失：autoupdate=false 也须补拉（v1 缺失补全语义）
  await refreshModInfo(fake, dir, 'M2', { infoUrl: 'http://x/M.info', autoupdate: false, installedAt: 0 });
  assert.equal(calls, 2);
});

test('isModVersionJson：base-version 键判型（空串/空白不算 mod）', () => {
  assert.equal(isModVersionJson({ id: 'm', betacraft: { baseVersion: 'b1.7.3' } }), 'b1.7.3');
  assert.equal(isModVersionJson({ id: 'm', betacraft: { baseVersion: '   ' } }), undefined);
  assert.equal(isModVersionJson({ id: 'm' }), undefined);
});

// ---------- mod jar 补全（客户端面） ----------

function modClient(t, routes) {
  const dir = mkRoot(t, 'attic-mjar-');
  const client = new BetacraftClient({ endpoints: TEST_ENDPOINTS, fetchImpl: fakeFetch(routes) });
  return { dir, client };
}

test('ensureModJar：sha1 命中复用/损坏重下/force 恒重下', async (t) => {
  const jar = buildJarBuffer(['com.w.WorldAPI']);
  const { dir, client } = modClient(t, {
    'http://x/WorldAPI.jar': jar,
    'http://x/b173.jar': buildJarBuffer(['net.minecraft.client.Minecraft']),
  });
  const json = { id: 'WorldAPI', jar: { url: 'http://x/WorldAPI.jar', sha1: sha1(jar) }, betacraft: { baseVersion: 'b1.7.3' } };
  const dest = path.join(modsDirOf(dir), 'WorldAPI.jar');
  await client.ensureModJar(json, dir, { verify: true });
  assert.equal(fs.readFileSync(dest).toString('utf8'), jar.toString('utf8'), 'sha1 锚定落位');
  // 二次调用走本地复用（fetchImpl 命中计数）：包一层计数 fetch 重建 client
  let hits = 0;
  const counted = new BetacraftClient({
    endpoints: TEST_ENDPOINTS,
    fetchImpl: async (url) => {
      hits += 1;
      return fakeFetch({ 'http://x/WorldAPI.jar': jar })(url);
    },
  });
  await counted.ensureModJar(json, dir, { verify: true });
  assert.equal(hits, 0, '本地命中 sha1 → 不联网');
  fs.writeFileSync(dest, 'CORRUPT');
  await counted.ensureModJar(json, dir, { verify: true });
  assert.equal(hits, 1, '复核不符 → 带哈希重下');
  assert.equal(sha1(fs.readFileSync(dest)), json.jar.sha1);
  await counted.ensureModJar(json, dir, { verify: true, force: true });
  assert.equal(hits, 2, 'force 旁路复用恒重下');
});

test('ensureModJar：缺 url / 缺 sha1（verify 开）显式报错；verify=false 放行无锚下载', async (t) => {
  const { dir, client } = modClient(t, { 'http://x/n.jar': 'DATA' });
  await assert.rejects(
    () => client.ensureModJar({ id: 'NoUrl', betacraft: { baseVersion: 'b1.7.3' } }, dir, { verify: true }),
    /缺少 jar 下载地址/,
  );
  const noHash = { id: 'NoHash', jar: { url: 'http://x/n.jar' }, betacraft: { baseVersion: 'b1.7.3' } };
  await assert.rejects(() => client.ensureModJar(noHash, dir, { verify: true }), /拒绝无锚点下载/);
  await client.ensureModJar(noHash, dir, { verify: false });
  assert.equal(fs.readFileSync(path.join(modsDirOf(dir), 'NoHash.jar'), 'utf8'), 'DATA');
});

// ---------- 基座合成 ----------

test('composeModJars：基座+mod 并集、mod 同名覆盖、剥签名保 MANIFEST 与嵌套资源', (t) => {
  const dir = mkRoot(t, 'attic-comp-');
  const base = path.join(dir, 'base.jar');
  const mod = path.join(dir, 'mod.jar');
  const out = path.join(dir, 'out.jar');
  fs.writeFileSync(
    base,
    buildZip(['a.txt', 'b.class', 'META-INF/MANIFEST.MF', 'META-INF/BASE.SF', 'META-INF/BASE.DSA', 'META-INF/services/x.y']),
  );
  fs.writeFileSync(mod, buildZip(['a.txt', 'c.class', 'META-INF/MOD.SF', 'META-INF/MOD.EC']));
  composeModJars(base, mod, out);
  const names = readZipEntries(out).map((e) => e.name);
  assert.deepEqual([...names].sort(), ['META-INF/MANIFEST.MF', 'META-INF/services/x.y', 'a.txt', 'b.class', 'c.class'].sort());
  assert.ok(!names.some((n) => /\.(SF|DSA|RSA|EC)$/i.test(n)), 'META-INF 直接子级签名全剥');
  assert.ok(names.includes('META-INF/MANIFEST.MF'), 'MANIFEST 保留（v1 过宽剥离的收窄修正）');
  assert.ok(names.includes('META-INF/services/x.y'), '嵌套 services 资源保留');
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), [], '输出原子：无 .tmp 残留');
});
