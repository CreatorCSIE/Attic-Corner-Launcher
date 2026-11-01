'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { compareSemver, checkLatestRelease, shouldPromptUpdate, AtticRuntime } = require('../dist/index.js');

function tempRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attic-upd-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** 指定 URL 的 JSON 应答 fetch（其余 404，同 betacraft.test.js 口径）。 */
function jsonFetch(url, body, status = 200) {
  return async (u) =>
    u === url
      ? new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
      : new Response('not found', { status: 404 });
}

const REPO_URL = 'https://api.github.com/repos/CreatorCSIE/Attic-Minecraft-Launcher/releases/latest';
const NIGHTLY_LIST_URL = 'https://api.github.com/repos/a/b/releases?per_page=30';

// ---------- compareSemver：数字段边界 + semver 2.0 预发布序 ----------

test('compareSemver：进位边界按数值位而非字典序', () => {
  assert.equal(compareSemver('0.0.9', '0.1.0'), -1);
  assert.equal(compareSemver('1.9.0', '1.10.0'), -1);
  assert.equal(compareSemver('1.10.0', '1.9.0'), 1);
  assert.equal(compareSemver('2.0.0', '10.0.0'), -1);
});

test('compareSemver：v 前缀剥离 + 缺段按 0 补齐 + 相等', () => {
  assert.equal(compareSemver('v1.2.3', '1.2.3'), 0);
  assert.equal(compareSemver('1.0', '1.0.0'), 0);
  assert.equal(compareSemver('1.0.1', '1.0'), 1);
  assert.equal(compareSemver('v0.1.0', '0.0.9'), 1);
});

test('compareSemver：预发布序——有预发布 < 无预发布（同主段）', () => {
  assert.equal(compareSemver('0.1.0-nightly.1', '0.1.0'), -1);
  assert.equal(compareSemver('0.1.0', '0.1.0-nightly.1'), 1);
  assert.equal(compareSemver('0.1.0-nightly.99999999', '0.1.0'), -1, '预发布序号再大也小于正式版');
  assert.equal(compareSemver('0.1.0-nightly.1', '0.1.0-nightly.1'), 0);
});

test('compareSemver：预发布标识符数值序而非字典序（nightly.2 < nightly.10）', () => {
  assert.equal(compareSemver('0.1.0-nightly.1', '0.1.0-nightly.2'), -1);
  assert.equal(compareSemver('0.1.0-nightly.2', '0.1.0-nightly.10'), -1);
  assert.equal(compareSemver('0.1.0-nightly.10', '0.1.0-nightly.2'), 1);
  assert.equal(compareSemver('0.1.0-nightly.20261025', '0.1.0-nightly.20261026'), -1);
});

test('compareSemver：字母数字按 ASCII + 数字恒小于字母数字 + 全等则短者小', () => {
  assert.equal(compareSemver('1.0.0-rc.1', '1.0.0-rc.2'), -1);
  assert.equal(compareSemver('1.0.0-alpha', '1.0.0-beta'), -1);
  assert.equal(compareSemver('1.0.0-9', '1.0.0-alpha'), -1, '数字标识符恒小于字母数字标识符');
  assert.equal(compareSemver('0.1.0-nightly.1', '0.1.0-nightly.1.1'), -1, '标识符全等则短者小');
  assert.equal(compareSemver('0.1.0-nightly.2', '0.1.0-nightly.1.1'), 1, '首个差异标识符优先于长度');
});

test('compareSemver：主段先行——跨 base nightly 排序（0.2.0-nightly.1 > 0.1.0-nightly.999）', () => {
  assert.equal(compareSemver('0.2.0-nightly.1', '0.1.0-nightly.999'), 1);
  assert.equal(compareSemver('1.9.0-nightly.1', '1.10.0'), -1, '主段数值序回归 + 预发布小于正式版');
});

// ---------- checkLatestRelease：数据面全分支 ----------

test('checkLatestRelease：200 有新版 → update 分支字段全带出（tag 去 v 前缀）', async () => {
  const res = await checkLatestRelease({
    releaseRepo: 'CreatorCSIE/Attic-Minecraft-Launcher',
    currentVersion: '0.0.0',
    fetchImpl: jsonFetch(REPO_URL, {
      tag_name: 'v0.1.0',
      html_url: 'https://github.com/CreatorCSIE/Attic-Minecraft-Launcher/releases/tag/v0.1.0',
      body: '## 更新内容\n- 检查更新链上线',
      published_at: '2026-10-20T12:00:00Z',
    }),
  });
  assert.equal(res.status, 'update');
  assert.equal(res.version, '0.1.0');
  assert.equal(res.url, 'https://github.com/CreatorCSIE/Attic-Minecraft-Launcher/releases/tag/v0.1.0');
  assert.equal(res.notes, '## 更新内容\n- 检查更新链上线');
  assert.equal(res.publishedAt, '2026-10-20T12:00:00Z');
});

test('checkLatestRelease：相等/更旧 → upToDate（不降级提示）', async () => {
  const mk = (tag) =>
    checkLatestRelease({
      releaseRepo: 'a/b',
      currentVersion: '0.2.0',
      fetchImpl: jsonFetch('https://api.github.com/repos/a/b/releases/latest', { tag_name: tag, html_url: 'u' }),
    });
  assert.equal((await mk('v0.2.0')).status, 'upToDate');
  assert.equal((await mk('v0.1.9')).status, 'upToDate');
  const up = await mk('v0.2.0');
  assert.equal(up.current, '0.2.0');
});

test('checkLatestRelease：预发布纪律——自身或 latest 含 - 永不提示', async () => {
  const call = async (current, tag) =>
    checkLatestRelease({
      releaseRepo: 'a/b',
      currentVersion: current,
      fetchImpl: jsonFetch('https://api.github.com/repos/a/b/releases/latest', { tag_name: tag, html_url: 'u' }),
    });
  // 自身预发布：即便 latest 数字更大也不提示
  assert.equal((await call('0.2.0-beta.1', 'v0.3.0')).status, 'upToDate');
  // latest 预发布（理论上 /latest 已排除，防御双保险）
  assert.equal((await call('0.1.0', 'v0.2.0-rc1')).status, 'upToDate');
});

test('checkLatestRelease：其余预发布构件（0.0.x 短命轨 / -rc）恒不提示——回归锁', async () => {
  const call = async (current) =>
    checkLatestRelease({
      releaseRepo: 'a/b',
      currentVersion: current,
      fetchImpl: jsonFetch('https://api.github.com/repos/a/b/releases/latest', { tag_name: 'v9.9.9', html_url: 'u' }),
    });
  for (const current of ['0.0.7-dev.3', '0.0.0-rc.1', '1.0.0-rc.2']) {
    assert.equal((await call(current)).status, 'upToDate', `非 nightly 预发布不得提示：${current}`);
  }
});

// ---------- checkLatestRelease：nightly 轨中匹配 ----------

test('checkLatestRelease：nightly 构件走 /releases 列表端点（UA 同、空列表 → upToDate）', async () => {
  let seen = null;
  const fetchImpl = async (url, init) => {
    seen = { url, init };
    return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const res = await checkLatestRelease({ releaseRepo: 'a/b', currentVersion: '0.1.0-nightly.5', fetchImpl });
  assert.equal(seen.url, NIGHTLY_LIST_URL);
  assert.equal(seen.init.headers['User-Agent'], 'Attic/0.1.0-nightly.5');
  assert.equal(seen.init.headers.Accept, 'application/vnd.github+json');
  assert.equal(res.status, 'upToDate', '列表空 → upToDate');
  assert.equal(res.current, '0.1.0-nightly.5');
});

test('checkLatestRelease：stable 构件仍走 /latest 单请求路径（与 nightly 轨 URL 分流）', async () => {
  const seen = [];
  const spy = async (url, init) => {
    seen.push(url);
    return new Response(url.includes('per_page') ? '[]' : JSON.stringify({ tag_name: 'v9.9.9', html_url: 'u' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  await checkLatestRelease({ releaseRepo: 'a/b', currentVersion: '0.1.0', fetchImpl: spy });
  await checkLatestRelease({ releaseRepo: 'a/b', currentVersion: '0.1.0-nightly.1', fetchImpl: spy });
  assert.deepEqual(seen, [
    'https://api.github.com/repos/a/b/releases/latest',
    'https://api.github.com/repos/a/b/releases?per_page=30',
  ]);
});

test('checkLatestRelease：nightly 轨——更高 stable（prerelease:false）不被选，只认同轨', async () => {
  const res = await checkLatestRelease({
    releaseRepo: 'a/b',
    currentVersion: '0.1.0-nightly.3',
    fetchImpl: jsonFetch(NIGHTLY_LIST_URL, [
      { tag_name: 'v0.2.0', prerelease: false, draft: false, html_url: 'stable-url' },
      {
        tag_name: 'v0.1.5-nightly.7',
        prerelease: true,
        draft: false,
        html_url: 'nightly-url',
        body: 'n',
        published_at: 'p',
      },
    ]),
  });
  assert.equal(res.status, 'update');
  assert.equal(res.version, '0.1.5-nightly.7', 'stable 0.2.0 数字更大但轨不同，不得混入');
  assert.equal(res.url, 'nightly-url');
  assert.equal(res.notes, 'n');
  assert.equal(res.publishedAt, 'p');
});

test('checkLatestRelease：nightly 轨——跨 base 更高 nightly 提示且取最大者', async () => {
  const res = await checkLatestRelease({
    releaseRepo: 'a/b',
    currentVersion: '0.1.0-nightly.20261020',
    fetchImpl: jsonFetch(NIGHTLY_LIST_URL, [
      { tag_name: 'v0.1.0-nightly.20261026', prerelease: true, html_url: 'u-same-base' },
      { tag_name: 'v0.2.0-nightly.20261024', prerelease: true, html_url: 'u-cross-base' },
    ]),
  });
  assert.equal(res.status, 'update');
  assert.equal(res.version, '0.2.0-nightly.20261024', '按 compareSemver 取最大（主段先行），非列表首位');
});

test('checkLatestRelease：nightly 轨——draft 排除 + 数值序选 nightly.10 非 nightly.9', async () => {
  const res = await checkLatestRelease({
    releaseRepo: 'a/b',
    currentVersion: '0.1.0-nightly.1',
    fetchImpl: jsonFetch(NIGHTLY_LIST_URL, [
      { tag_name: 'v0.1.0-nightly.99', prerelease: true, draft: true, html_url: 'draft-url' },
      { tag_name: 'v0.1.0-nightly.9', prerelease: true, draft: false, html_url: 'u9' },
      { tag_name: 'v0.1.0-nightly.10', prerelease: true, draft: false, html_url: 'u10' },
    ]),
  });
  assert.equal(res.status, 'update');
  assert.equal(res.version, '0.1.0-nightly.10', 'draft 的 99 排除；10>9 按数值序');
});

test('checkLatestRelease：nightly 轨——仅更旧/相等 nightly 或无候选 → upToDate（不降级提示）', async () => {
  const mk = (items) =>
    checkLatestRelease({
      releaseRepo: 'a/b',
      currentVersion: '0.1.0-nightly.5',
      fetchImpl: jsonFetch(NIGHTLY_LIST_URL, items),
    });
  assert.equal((await mk([{ tag_name: 'v0.1.0-nightly.4', prerelease: true, html_url: 'u' }])).status, 'upToDate');
  assert.equal((await mk([{ tag_name: 'v0.1.0-nightly.5', prerelease: true, html_url: 'u' }])).status, 'upToDate', '相等不提示');
  assert.equal((await mk([{ tag_name: 'v0.9.0', prerelease: false, html_url: 'u' }])).status, 'upToDate', '无轨内候选');
  assert.equal((await mk([{ tag_name: '', prerelease: true, html_url: 'u' }])).status, 'upToDate', '脏项容忍');
});

test('checkLatestRelease：nightly 轨——网络炸/非 2xx/响应形状非法 → error 语义照旧', async () => {
  const boom = await checkLatestRelease({
    releaseRepo: 'a/b',
    currentVersion: '0.1.0-nightly.1',
    fetchImpl: async () => {
      throw new Error('ECONNRESET 网络离线');
    },
  });
  assert.equal(boom.status, 'error');
  assert.match(boom.message, /ECONNRESET/);
  const e403 = await checkLatestRelease({
    releaseRepo: 'a/b',
    currentVersion: '0.1.0-nightly.1',
    fetchImpl: async () => new Response('', { status: 403 }),
  });
  assert.equal(e403.status, 'error');
  assert.match(e403.message, /403/);
  const notArray = await checkLatestRelease({
    releaseRepo: 'a/b',
    currentVersion: '0.1.0-nightly.1',
    fetchImpl: jsonFetch(NIGHTLY_LIST_URL, { message: 'unexpected object' }),
  });
  assert.equal(notArray.status, 'error');
  assert.match(notArray.message, /数组/);
});

test('checkLatestRelease：请求头带 GitHub 强制的 User-Agent = Attic/<version>', async () => {
  let seen = null;
  const fetchImpl = async (url, init) => {
    seen = { url, init };
    return jsonFetch(url, { tag_name: 'v0.1.0', html_url: 'u' })(url, init);
  };
  await checkLatestRelease({ releaseRepo: 'a/b', currentVersion: '0.0.3', fetchImpl });
  assert.equal(seen.url, 'https://api.github.com/repos/a/b/releases/latest');
  assert.equal(seen.init.headers['User-Agent'], 'Attic/0.0.3');
  assert.equal(seen.init.headers.Accept, 'application/vnd.github+json');
});

test('checkLatestRelease：网络炸 → error 可读（不抛异常）', async () => {
  const res = await checkLatestRelease({
    releaseRepo: 'a/b',
    currentVersion: '0.0.0',
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED 网络离线');
    },
  });
  assert.equal(res.status, 'error');
  assert.match(res.message, /ECONNREFUSED/);
});

test('checkLatestRelease：非 2xx（404/403）→ error 带状态与提示', async () => {
  const res404 = await checkLatestRelease({
    releaseRepo: 'no/such-repo',
    currentVersion: '0.0.0',
    fetchImpl: async () => new Response('{"message":"Not Found"}', { status: 404 }),
  });
  assert.equal(res404.status, 'error');
  assert.match(res404.message, /404/);
  assert.match(res404.message, /仓库不存在/);
  const res403 = await checkLatestRelease({
    releaseRepo: 'a/b',
    currentVersion: '0.0.0',
    fetchImpl: async () => new Response('', { status: 403 }),
  });
  assert.equal(res403.status, 'error');
  assert.match(res403.message, /403/);
});

test('checkLatestRelease：响应缺 tag_name → error；缺 body/published_at → 空串容忍', async () => {
  const bad = await checkLatestRelease({
    releaseRepo: 'a/b',
    currentVersion: '0.0.0',
    fetchImpl: jsonFetch('https://api.github.com/repos/a/b/releases/latest', { html_url: 'u' }),
  });
  assert.equal(bad.status, 'error');
  assert.match(bad.message, /tag_name/);
  const okMin = await checkLatestRelease({
    releaseRepo: 'a/b',
    currentVersion: '0.0.0',
    fetchImpl: jsonFetch('https://api.github.com/repos/a/b/releases/latest', { tag_name: 'v1.0.0', html_url: 'u' }),
  });
  assert.equal(okMin.status, 'update');
  assert.equal(okMin.notes, '');
  assert.equal(okMin.publishedAt, '');
});

test('checkLatestRelease：仓库未配置 = unconfigured（不发请求）；格式非法 = error', async () => {
  let called = 0;
  const spy = async () => {
    called++;
    return new Response('{}', { status: 200 });
  };
  const un = await checkLatestRelease({ currentVersion: '0.0.0', fetchImpl: spy });
  assert.equal(un.status, 'unconfigured');
  const blank = await checkLatestRelease({ releaseRepo: '   ', currentVersion: '0.0.0', fetchImpl: spy });
  assert.equal(blank.status, 'unconfigured');
  assert.equal(called, 0, 'unconfigured 分支零网络');
  for (const repo of ['just-name', 'a/b/c', '/b', 'a/']) {
    const bad = await checkLatestRelease({ releaseRepo: repo, currentVersion: '0.0.0', fetchImpl: spy });
    assert.equal(bad.status, 'error', `非法格式应 error：${repo}`);
    assert.match(bad.message, /owner\/repo/);
  }
});

// ---------- shouldPromptUpdate：自动检查打扰门（纯函数，UI 经 alias 直消费） ----------

test('shouldPromptUpdate：update ∧ 版本≠忽略账 → 打扰；命中忽略账 → 全静默', () => {
  const upd = { status: 'update', version: '0.2.0', url: 'u', notes: '', publishedAt: '' };
  assert.equal(shouldPromptUpdate(upd, undefined, 'startup'), true, '无忽略账 → 弹+红点');
  assert.equal(shouldPromptUpdate(upd, '0.1.0', 'startup'), true, '忽略账是别的版本 → 照打扰');
  assert.equal(shouldPromptUpdate(upd, '0.2.0', 'startup'), false, '命中忽略账 → 不弹不红点');
});

test('shouldPromptUpdate：策略 off 恒静默（双保险——start 侧本就不发自动检查）', () => {
  const upd = { status: 'update', version: '0.2.0', url: 'u', notes: '', publishedAt: '' };
  assert.equal(shouldPromptUpdate(upd, undefined, 'off'), false);
});

test('shouldPromptUpdate：upToDate/unconfigured/error 分支恒静默（误报比漏报烦人）', () => {
  assert.equal(shouldPromptUpdate({ status: 'upToDate', current: '0.1.0' }, undefined, 'startup'), false);
  assert.equal(shouldPromptUpdate({ status: 'unconfigured' }, undefined, 'startup'), false);
  assert.equal(shouldPromptUpdate({ status: 'error', message: 'x' }, undefined, 'startup'), false);
});

// ---------- AtticRuntime 门面集成 ----------

test('AtticRuntime.checkUpdate：构造选项 releaseRepo 走通全链', async (t) => {
  const runtime = new AtticRuntime({
    rootDir: tempRoot(t),
    version: '0.0.0',
    releaseRepo: 'CreatorCSIE/Attic-Minecraft-Launcher',
    fetchImpl: jsonFetch(REPO_URL, { tag_name: 'v0.1.0', html_url: 'u', body: 'n', published_at: 'p' }),
  });
  const res = await runtime.checkUpdate();
  assert.equal(res.status, 'update');
  assert.equal(res.version, '0.1.0');
});

test('AtticRuntime.checkUpdate：env ATTIC_RELEASE_REPO 兜底（构造选项缺席时）', async (t) => {
  const runtime = new AtticRuntime({
    rootDir: tempRoot(t),
    version: '0.0.0',
    env: { ATTIC_RELEASE_REPO: 'CreatorCSIE/Attic-Minecraft-Launcher' },
    fetchImpl: jsonFetch(REPO_URL, { tag_name: 'v0.1.0', html_url: 'u' }),
  });
  assert.equal((await runtime.checkUpdate()).status, 'update');
});

test('AtticRuntime.checkUpdate：两缺 = 回落默认同仓（开发仓即发布仓，2026-10-25 收口）', async (t) => {
  let url = '';
  const runtime = new AtticRuntime({
    rootDir: tempRoot(t),
    version: '0.1.0',
    env: {}, // 显式空 env：不吃真实进程的 ATTIC_RELEASE_REPO
    fetchImpl: async (u) => {
      url = String(u);
      return new Response(JSON.stringify({ tag_name: 'v0.2.0', html_url: 'u', body: 'n', published_at: 'p' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  const res = await runtime.checkUpdate();
  assert.equal(res.status, 'update');
  assert.equal(url, REPO_URL, '默认发布仓库 = CreatorCSIE/Attic-Minecraft-Launcher');
});

test('AtticRuntime.checkUpdate：显式空串 = unconfigured 关通道逃生舱（不发网络）', async (t) => {
  const runtime = new AtticRuntime({
    rootDir: tempRoot(t),
    version: '0.1.0',
    releaseRepo: '',
    fetchImpl: async () => {
      throw new Error('不应发起网络');
    },
  });
  assert.equal((await runtime.checkUpdate()).status, 'unconfigured');
});

test('AtticRuntime 出站 UA 统一：fetchImpl 层对无头请求注入 Attic/<version>（数据面卫生，全消费方共享）', async (t) => {
  const seen = [];
  const INFO = ['id=b1.7.3', 'launch-method=indev', 'release-date=1310110334000'].join('\n');
  const runtime = new AtticRuntime({
    rootDir: tempRoot(t),
    version: '0.0.11',
    fetchImpl: async (url, init) => {
      seen.push({ url, init });
      return new Response(INFO, { status: 200 });
    },
  });
  await runtime.getVersionJson('b1.7.3');
  assert.ok(seen.length > 0, '应发生出站请求');
  for (const call of seen) assert.equal(call.init.headers['User-Agent'], 'Attic/0.0.11');
});

test('AtticRuntime.getSystemInfo：shell 注入（tauri）与缺省（electron 保守）', (t) => {
  const injected = new AtticRuntime({ rootDir: tempRoot(t), shell: 'tauri' });
  assert.equal(injected.getSystemInfo().shell, 'tauri');
  const defaulted = new AtticRuntime({ rootDir: tempRoot(t) });
  assert.equal(defaulted.getSystemInfo().shell, 'electron');
});
