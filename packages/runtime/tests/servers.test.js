'use strict';

/**
 * 社区服务器列表测试面（上游取证 2026-11-01 钉在 tests/fixtures/legacy-server-list.html）：
 * - parseServerList：五分类分段、双行配对、join:// 四段拆解、名字 [版本] 前缀剥除、
 *   HTML 实体解码（名字/描述）、icon 两型（server_icon 投值 / unknown_pack 省略键）、
 *   Online Mode / players 有无两态、mppass=use 省略键（真实密码保留）、地址权威 = join 段；
 * - normalizePreferredVersion / matchVersionId：三级匹配（精确/前缀双向取最长/未命中缺省），
 *   脏样本（构建后缀/含空格/第三方客户端名/protocol=unknown）各就各位；
 * - parseServerList 两轨匹配：官方轨先行防 mod 前缀劫持；mod/自定义轨兜底命中打
 *   matchedVersionIsCustom（第三方客户端服正解 + UI 知情提示）；
 * - parseServerList 协议全集（v1 区间语义）：protocol 同值官方全集（清单序）+ matched
 *   缺席追加 + unknown/空协议/全集空 = 键省略各形态；
 * - AtticRuntime.listServers：现拉现发 + 版本目录派生 + 清单不可得降级 + 失败可见错误。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  AtticRuntime,
  parseServerList,
  normalizePreferredVersion,
  matchVersionId,
} = require('../dist/index.js');

const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'legacy-server-list.html'), 'utf8');

/** 假版本目录（对齐 BC manifest id 原形 + 前缀对 + 近似对，钉三级匹配各层）。
 *  protocol 列 = fixture 各服 join:// 第三段同形值（classic_7/beta_14/47），钉协议全集派生。 */
const OFFICIALS = [
  { id: 'c0.30-c', protocol: 'classic_7' },
  { id: 'c0.30_01', protocol: 'classic_7' },
  { id: 'in-20100223' },
  { id: 'b1.7.3', protocol: 'beta_14' },
  { id: '1.7.1', protocol: '47' },
  { id: '1.7.10', protocol: '47' },
];
const IDS = OFFICIALS.map((v) => v.id);

function byName(list, name) {
  const hit = list.find((s) => s.name === name);
  assert.ok(hit, `列表应含 ${name}`);
  return hit;
}

// ---------- 列表解析（fixture 钉形） ----------

test('parseServerList：fixture 全量 7 条 + 五分类归一小写', () => {
  const list = parseServerList(FIXTURE, OFFICIALS);
  assert.equal(list.length, 7, '解析计数钉死（上游 60 台 = 同模板裁剪）');
  assert.deepEqual(
    list.map((s) => s.category),
    ['classic', 'classic', 'indev', 'alpha', 'beta', 'beta', 'release'],
  );
});

test('parseServerList：join:// 四段拆解 + 前缀剥除 + 实体解码 + Online Mode/players/icon 全形态', () => {
  const list = parseServerList(FIXTURE, OFFICIALS);
  const na = byName(list, 'Not Awesome 2');
  assert.equal(na.id, '162.245.188.76:25556', '稳定键 = address:port');
  assert.equal(na.address, '162.245.188.76');
  assert.equal(na.port, 25556);
  assert.equal(na.preferredVersion, 'c0.30-c-1900', '第四段原样保留（含构建后缀）');
  assert.equal(na.protocol, 'classic_7');
  assert.equal(na.mppass, undefined, 'mppass=use = 无密码，省略键');
  assert.equal(na.onlineMode, true, 'server__mode--online 在场');
  assert.deepEqual(na.players, { online: 9, max: 128 });
  assert.equal(na.iconUrl, 'http://api.betacraft.uk/v2/server_icon?socket=162.245.188.76%3A25556', '代理直链投值');
  assert.equal(na.description, 'The classic survival experience & weekly events', '描述 &amp; 解码');
});

test('parseServerList：名字 [版本] 前缀剥除 + 名字内实体解码 + mppass 真实密码保留 + unknown_pack 省略 iconUrl', () => {
  const list = parseServerList(FIXTURE, OFFICIALS);
  const tj = byName(list, 'Tom & Jerry Classic');
  assert.ok(!tj.name.startsWith('['), 'server__version span 不进 name');
  assert.equal(tj.mppass, 'abc123hash', '非 use 的 mppass 保留');
  assert.equal(tj.iconUrl, undefined, '静态 unknown_pack.png 不投 iconUrl');
  assert.equal(tj.onlineMode, false, '无 online span = false');
  assert.equal(tj.players, undefined, '无 players span = 省略键');
  assert.equal(tj.protocol, 'classic_7');
});

test('parseServerList：脏 preferredVersion 原样保留（含空格）+ protocol=unknown 纯展示 + &#39;/&#8211; 数字实体解码', () => {
  const list = parseServerList(FIXTURE, OFFICIALS);
  assert.equal(byName(list, 'TurtleSMP').preferredVersion, 'in-20100223MP v0.1.7');
  const twizl = byName(list, "Twizl's Beta World");
  assert.equal(twizl.protocol, 'unknown');
  const stone = byName(list, 'Stone11');
  assert.equal(stone.description, 'Third-party client only \u2013 read the forum post');
});

test('parseServerList：地址权威 = join:// 第一段（span 不一致时 join 胜出）', () => {
  const list = parseServerList(FIXTURE, OFFICIALS);
  const rel = byName(list, 'ExampleRelease');
  assert.equal(rel.id, 'mc.example.net:25565');
  assert.equal(rel.port, 25565);
});

test('parseServerList：BOM 容忍（上游 UTF-8 带 BOM）；无分类 h2 = 形状崩坏显式抛错', () => {
  assert.equal(parseServerList('\uFEFF' + FIXTURE, OFFICIALS).length, 7);
  assert.throws(() => parseServerList('<html><body><p>404</p></body></html>', []), /无任何分类段/);
});

// ---------- preferredVersion 归一 + 三级匹配 ----------

test('normalizePreferredVersion：trim + 含空格取最后 token + lowercase', () => {
  assert.equal(normalizePreferredVersion('Uberbukkit Client a1.2.6'), 'a1.2.6');
  assert.equal(normalizePreferredVersion('in-20100223MP v0.1.7'), 'v0.1.7');
  assert.equal(normalizePreferredVersion('  b1.7.3 '), 'b1.7.3');
  assert.equal(normalizePreferredVersion('C0.30-C-1900'), 'c0.30-c-1900');
  assert.equal(normalizePreferredVersion(''), '');
});

test('matchVersionId：① 精确（大小写不敏感）② 前缀双向取最长 ③ 未命中 undefined', () => {
  assert.equal(matchVersionId('b1.7.3', IDS), 'b1.7.3');
  assert.equal(matchVersionId('B1.7.3', IDS), 'b1.7.3');
  assert.equal(matchVersionId('1.7.10', IDS), '1.7.10', '精确级先于前缀级（不误配 1.7.1）');
  // 前缀正向：构建后缀命中基名
  assert.equal(matchVersionId('c0.30-c-1900', IDS), 'c0.30-c');
  // 前缀双向 + 最长命中：'1.7.10x' 同时前缀命中 1.7.1 与 1.7.10 → 取长
  assert.equal(matchVersionId('1.7.10x', IDS), '1.7.10');
  // 反向：目录比期望值更长（b1.7 → b1.7.3）
  assert.equal(matchVersionId('b1.7', IDS), 'b1.7.3');
  // 未命中：第三方客户端名最后 token 不在目录 / 空值
  assert.equal(matchVersionId('Uberbukkit Client a1.2.6', ['b1.7.3']), undefined);
  assert.equal(matchVersionId('in-20100223MP v0.1.7', IDS), undefined);
  assert.equal(matchVersionId('   ', IDS), undefined);
});

test('parseServerList：matchedVersionId 三级落位（精确/前缀/未命中含第三方客户端名）', () => {
  const list = parseServerList(FIXTURE, OFFICIALS);
  assert.equal(byName(list, 'Not Awesome 2').matchedVersionId, 'c0.30-c', '前缀级');
  assert.equal(byName(list, 'Tom & Jerry Classic').matchedVersionId, 'c0.30_01', '精确级');
  assert.equal(byName(list, 'ModernBeta').matchedVersionId, 'b1.7.3');
  assert.equal(byName(list, "Twizl's Beta World").matchedVersionId, 'b1.7.3', 'protocol=unknown 不参与匹配');
  assert.equal(byName(list, 'ExampleRelease').matchedVersionId, '1.7.10');
  assert.equal(byName(list, 'Stone11').matchedVersionId, undefined, '第三方客户端名未命中 = 缺省键');
  assert.equal(byName(list, 'TurtleSMP').matchedVersionId, undefined);
  assert.ok(!('matchedVersionId' in byName(list, 'Stone11')), '未命中时键整体缺席而非 undefined');
});

test('parseServerList 两轨：官方轨先行防 mod 前缀劫持（更长 mod 前缀不抢原版服）', () => {
  // Not Awesome 2 preferred=`c0.30-c-1900`：合并列表时 mod id `c0.30-c-1900b` 前缀更长必抢；
  // 两轨下官方 `c0.30-c` 先行命中即止，且不落兜底轨 = 无 isCustom 标记。
  const list = parseServerList(FIXTURE, OFFICIALS, [{ id: 'c0.30-c-1900b' }]);
  const na = byName(list, 'Not Awesome 2');
  assert.equal(na.matchedVersionId, 'c0.30-c', '官方轨胜出');
  assert.ok(!('matchedVersionIsCustom' in na), '官方轨命中不带 mod 标记');
});

test('parseServerList 两轨：官方全不中落 mod/自定义轨 = 命中打 matchedVersionIsCustom；两轨皆不中 = 双缺省', () => {
  // TurtleSMP preferred=`in-20100223MP v0.1.7`（第三方客户端名）→ 归一 `v0.1.7` 命中 mod 轨。
  const list = parseServerList(FIXTURE, OFFICIALS, [{ id: 'v0.1.7' }]);
  const ts = byName(list, 'TurtleSMP');
  assert.equal(ts.matchedVersionId, 'v0.1.7');
  assert.equal(ts.matchedVersionIsCustom, true, '兜底轨命中打知情标记');
  // Stone11（`a1.2.6`）两轨皆无 = 双键缺席
  const s11 = byName(list, 'Stone11');
  assert.ok(!('matchedVersionId' in s11) && !('matchedVersionIsCustom' in s11));
  // 官方轨在场时缺省 customIds 参（旧调用形状）行为不变
  assert.equal(byName(parseServerList(FIXTURE, OFFICIALS), 'TurtleSMP').matchedVersionId, undefined);
});

test('parseServerList 两轨：mod 轨下划线全名形命中 BC full_name（实案 in-20100223MP v0.1.7）', () => {
  // 尾 token `v0.1.7` 对 full_name `in-20100223MP_v0.1.7` 精确/前缀皆不中；
  // 全名空格→下划线形精确命中（第三方客户端服 = 自家 mod 托管的正解形态）。
  const list = parseServerList(FIXTURE, OFFICIALS, [{ id: 'in-20100223MP_v0.1.7' }]);
  const ts = byName(list, 'TurtleSMP');
  assert.equal(ts.matchedVersionId, 'in-20100223MP_v0.1.7');
  assert.equal(ts.matchedVersionIsCustom, true);
  // 下划线形不越轨抢官方原版（官方轨先行命中即止）
  const na = byName(list, 'Not Awesome 2');
  assert.equal(na.matchedVersionId, 'c0.30-c');
  assert.ok(!('matchedVersionIsCustom' in na));
});

test('parseServerList mod 轨：原样精确先行命中带空格仓库 full_name（v1 getMod equalsIgnoreCase）+ 投 matchedModInfoUrl', () => {
  // 2026-11-01 实测：getmods.jsp 的 in-20100223MP full_name 恒带空格、与 preferred 逐字同形——
  // 原样精确级直命中（不必落尾 token/下划线兜底级），条目 infoUrl 投 matchedModInfoUrl 供 UI 自动入库。
  const list = parseServerList(FIXTURE, OFFICIALS, [
    { id: 'in-20100223MP v0.1.7', infoUrl: 'https://sithgames.com/dl/in-20100223MP_v0.1.7.info' },
  ]);
  const ts = byName(list, 'TurtleSMP');
  assert.equal(ts.matchedVersionId, 'in-20100223MP v0.1.7', '带空格全名原样命中');
  assert.equal(ts.matchedVersionIsCustom, true);
  assert.equal(ts.matchedModInfoUrl, 'https://sithgames.com/dl/in-20100223MP_v0.1.7.info');
  // 本地已装条目不带 infoUrl = 键省略（UI 不触发自动入库）
  const bare = parseServerList(FIXTURE, OFFICIALS, [{ id: 'in-20100223MP v0.1.7' }]);
  assert.ok(!('matchedModInfoUrl' in byName(bare, 'TurtleSMP')));
  // 官方轨命中恒不投 matchedModInfoUrl（即使 mod 轨同名条目在场——原版服不走入库）
  const na = byName(list, 'Not Awesome 2');
  assert.equal(na.matchedVersionId, 'c0.30-c');
  assert.ok(!('matchedModInfoUrl' in na));
});

// ---------- 协议全集（v1 区间语义：WebsitePanel 协议同值候选集 + mod 追加） ----------

test('parseServerList 协议全集：同值官方全集按清单序；matched 已在集内不重复', () => {
  const list = parseServerList(FIXTURE, OFFICIALS);
  assert.deepEqual(byName(list, 'Not Awesome 2').compatibleVersionIds, ['c0.30-c', 'c0.30_01']);
  assert.deepEqual(byName(list, 'Tom & Jerry Classic').compatibleVersionIds, ['c0.30-c', 'c0.30_01']);
  assert.deepEqual(byName(list, 'ExampleRelease').compatibleVersionIds, ['1.7.1', '1.7.10']);
  assert.deepEqual(byName(list, 'ModernBeta').compatibleVersionIds, ['b1.7.3']);
});

test('parseServerList 协议全集：matched 缺席追加末尾（unknown 协议/协议无同值 + mod 兜底形）', () => {
  // protocol=unknown：全集空但官方轨按名命中 → matched 追加成单元素集
  const list = parseServerList(FIXTURE, OFFICIALS);
  assert.deepEqual(byName(list, "Twizl's Beta World").compatibleVersionIds, ['b1.7.3']);
  // TurtleSMP protocol='5' 无同值官方版本 + mod 轨命中 → 集合=[matched]（v1 getMod 追加语义）
  const withMod = parseServerList(FIXTURE, OFFICIALS, [{ id: 'v0.1.7' }]);
  assert.deepEqual(byName(withMod, 'TurtleSMP').compatibleVersionIds, ['v0.1.7']);
  // 官方 protocol 列整体缺席（旧缓存形）→ 全集退化为 matched 单元素
  const bare = parseServerList(FIXTURE, OFFICIALS.map((v) => ({ id: v.id })));
  assert.deepEqual(byName(bare, 'Not Awesome 2').compatibleVersionIds, ['c0.30-c']);
});

test('parseServerList 协议全集：无同值官方版本且无 matched = 键整体省略（UI 回落手动选版本）', () => {
  const list = parseServerList(FIXTURE, OFFICIALS);
  assert.ok(!('compatibleVersionIds' in byName(list, 'Stone11')), 'alpha_6 无同值官方 + 未命中');
  assert.ok(!('compatibleVersionIds' in byName(list, 'TurtleSMP')), 'protocol=5 无同值官方 + 无 mod 轨');
});

// ---------- 门面集成（版本目录 = 既有清单缓存 API，fakeFetch 桩） ----------

function fakeFetch(routes) {
  return async (url) => {
    const entry = routes[url];
    if (entry === undefined) return new Response('not found', { status: 404 });
    return new Response(entry, { status: 200 });
  };
}

const SERVER_LIST_URL = 'http://x/legacy_server_list';
const VERSION_LIST_URL = 'http://x/version_list.txt';
const TEST_ENDPOINTS = {
  versionList: VERSION_LIST_URL,
  versionJson: (id) => `http://x/jsons/${id}.info`,
  assetIndex: (id) => `http://x/indexes/${id}.json`,
  mojangManifest: 'http://x/mojang_manifest.json',
  modsList: 'http://x/getmods.jsp',
  serverList: SERVER_LIST_URL,
};
const VERSION_LIST_BODY = [
  'c0.30-c``1246406400000`1246406400000`classic_7',
  'c0.30_01``1246406400000`1246406400000`classic_7',
  'in-20100223``1266917580000`1266917580000',
  'b1.7.3``1309036200000`1309036200000`beta_14',
  '1.7.1``1398796800000`1398819919000`47',
  '1.7.10``1401643368000`1401643368000`47',
].join('\n');

function tempRuntime(t, routes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attic-servers-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new AtticRuntime({ rootDir: dir, endpoints: TEST_ENDPOINTS, fetchImpl: fakeFetch(routes) });
}

test('listServers：现拉 HTML + 宿主派生 matchedVersionId（版本目录 = listVersions 清单面）', async (t) => {
  const rt = tempRuntime(t, { [SERVER_LIST_URL]: FIXTURE, [VERSION_LIST_URL]: VERSION_LIST_BODY });
  const list = await rt.listServers();
  assert.equal(list.length, 7);
  assert.equal(byName(list, 'Not Awesome 2').matchedVersionId, 'c0.30-c');
  assert.equal(byName(list, 'ExampleRelease').matchedVersionId, '1.7.10');
  assert.equal(byName(list, 'Stone11').matchedVersionId, undefined);
  // 协议全集端到端：清单第 5 列 → compatibleVersionIds（v1 区间语义过真实管线）
  assert.deepEqual(byName(list, 'Not Awesome 2').compatibleVersionIds, ['c0.30-c', 'c0.30_01']);
  assert.deepEqual(byName(list, 'ExampleRelease').compatibleVersionIds, ['1.7.1', '1.7.10']);
});

test('listServers：mod 轨 = 本地 ∪ 远端仓库（v1 启动即 loadMods 对齐）——未安装 mod 经 getmods.jsp full_name 命中 + 投 matchedModInfoUrl', async (t) => {
  const modsBody = JSON.stringify([
    {
      mod_category: 'Multiplayer',
      mods: [
        {
          full_name: 'in-20100223MP v0.1.7',
          version: 'v0.1.7',
          info_file_url: 'https://sithgames.com/dl/in-20100223MP_v0.1.7.info',
          autoupdate: true,
        },
      ],
    },
  ]);
  const rt = tempRuntime(t, {
    [SERVER_LIST_URL]: FIXTURE,
    [VERSION_LIST_URL]: VERSION_LIST_BODY,
    [TEST_ENDPOINTS.modsList]: modsBody,
  });
  const list = await rt.listServers();
  const ts = byName(list, 'TurtleSMP');
  assert.equal(ts.matchedVersionId, 'in-20100223MP v0.1.7', '仓库 full_name 原样命中（本地未安装也匹配）');
  assert.equal(ts.matchedVersionIsCustom, true);
  assert.equal(ts.matchedModInfoUrl, 'https://sithgames.com/dl/in-20100223MP_v0.1.7.info');
  // 官方轨服不受仓库条目影响（无入库直链）
  assert.ok(!('matchedModInfoUrl' in byName(list, 'Not Awesome 2')));
});

test('listServers：仓库不可得（getmods.jsp 404）= mod 轨只落本地条目，列表照常返回（不拦）', async (t) => {
  const rt = tempRuntime(t, { [SERVER_LIST_URL]: FIXTURE, [VERSION_LIST_URL]: VERSION_LIST_BODY });
  const list = await rt.listServers();
  assert.equal(list.length, 7);
  assert.ok(!('matchedVersionId' in byName(list, 'TurtleSMP')), '无本地 mod 条目 + 仓库缺席 = 缺省');
});

test('listServers：版本清单不可得 = 匹配级全未命中降级，列表照常返回（不拦）', async (t) => {
  const rt = tempRuntime(t, { [SERVER_LIST_URL]: FIXTURE }); // version_list.txt 无路由 = 404
  const list = await rt.listServers();
  assert.equal(list.length, 7);
  assert.ok(list.every((s) => s.matchedVersionId === undefined), '全部缺省 matchedVersionId');
});

test('listServers：上游失败 = 可读错误（壳层 handle 封装 IpcResult 错误字符串，UI 空态+重试）', async (t) => {
  const rt = tempRuntime(t, { [VERSION_LIST_URL]: VERSION_LIST_BODY }); // serverList 无路由 = 404
  await assert.rejects(() => rt.listServers(), /HTTP 404/);
});

