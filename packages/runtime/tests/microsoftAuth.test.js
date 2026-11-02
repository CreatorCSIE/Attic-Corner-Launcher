'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const {
  AtticRuntime,
  IPC_EVENTS,
  DPAPI_PREFIX,
  MsAuthError,
  DEFAULT_MS_CLIENT_ID,
  MS_HOST_WHITELIST,
  isMsEndpointAllowed,
  javaUrlEncode,
  requestDeviceCode,
  pollDeviceToken,
  refreshMsToken,
  runAuthTail,
  xstsAuthenticate,
  joinServer,
  sha1ServerId,
  encodeTokenSecret,
  decodeTokenSecret,
} = require('../dist/index.js');

/** 脱敏绊线用「机密子串」：mock 各 token 均含它，任何错误消息/事件载荷/磁盘明文不得出现。 */
const SECRET = 'SECRETTOKEN_0123456789_abcdefghijklmnopqrstuvwxyz';
const CLIENT = 'TEST-CLIENT-GUID';

function mockFetch(routes) {
  const calls = [];
  const counters = new Map();
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init, body: init.body });
    const key = Object.keys(routes).find((k) => url.includes(k));
    assert.ok(key, `no mock route for ${url}`);
    const n = counters.get(url) ?? 0;
    counters.set(url, n + 1);
    const handler = routes[key];
    const res = typeof handler === 'function' ? handler(n, { url, init }) : handler;
    const status = res.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => (res.json === undefined ? null : res.json),
      // jsonWithRaw 消费面：text = 序列化 mock json（缺省 = 空串 → unparsable 分支）。
      text: async () => (res.json === undefined ? '' : JSON.stringify(res.json)),
    };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function happyRoutes(overrides = {}) {
  return {
    '/devicecode': {
      json: {
        device_code: 'DEV-CODE-123',
        user_code: 'ABCD-EFGH',
        verification_uri: 'https://www.microsoft.com/link',
        verification_uri_complete: 'https://www.microsoft.com/link?o=ABCD-EFGH',
        expires_in: 900,
        interval: 5,
      },
    },
    '/token': {
      json: {
        token_type: 'Bearer',
        scope: 'XboxLive.signin offline_access',
        access_token: `MS-ACCESS.${SECRET}`,
        refresh_token: `MS-REFRESH.${SECRET}`,
        expires_in: 3600,
      },
    },
    '/user/authenticate': { json: { Token: 'XBL-TOKEN', DisplayClaims: { xui: [{ uhs: 'UHS123' }] } } },
    '/xsts/authorize': { json: { Token: 'XSTS-TOKEN', DisplayClaims: { xui: [{ uhs: 'UHS123' }] } } },
    '/login_with_xbox': { json: { access_token: `MC-${SECRET}`, token_type: 'Bearer', expires_in: '86400' } },
    // 真响应形状（2026-10-31 实测：顶层 skins[] + http url + variant，非旧 properties/base64 形状）。
    '/minecraft/profile': {
      json: {
        id: 'cafe1234deadbeef00000000000000ff',
        name: 'SteveOnline',
        skins: [{ id: 'sk-1', state: 'ACTIVE', url: 'http://textures.minecraft.net/texture/deadbeefcafe', variant: 'SLIM' }],
        capes: [],
        profileActions: {},
      },
    },
    ...overrides,
  };
}

function makeDeps(routes, extra = {}) {
  const fetchImpl = mockFetch(routes);
  return { deps: { fetchImpl, clientId: CLIENT, ...extra }, fetchImpl };
}

async function until(cond, ms = 3000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('until: 等待条件超时');
    await new Promise((r) => setTimeout(r, 10));
  }
}

function tempRuntime(t, fetchImpl, msDeps) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attic-ms-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new AtticRuntime({
    rootDir: dir,
    fetchImpl: fetchImpl ?? (() => Promise.reject(new Error('no-net'))),
    msDeps,
  });
}

// ---------- 六步链（fetch mock） ----------

test('设备码请求：v1 DeviceCodeRequest 载荷逐字对齐（form client_id+scope）', async () => {
  const { deps: d, fetchImpl } = makeDeps(happyRoutes());
  const issued = await requestDeviceCode(d);
  const call = fetchImpl.calls[0];
  assert.equal(call.url, 'https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode');
  assert.equal(call.init.method, 'POST');
  assert.equal(call.body, `client_id=${CLIENT}&scope=XboxLive.signin offline_access`);
  assert.equal(call.init.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.equal(issued.deviceCode, 'DEV-CODE-123');
  assert.deepEqual(issued.view, {
    userCode: 'ABCD-EFGH',
    verificationUri: 'https://www.microsoft.com/link',
    verificationUriComplete: 'https://www.microsoft.com/link?o=ABCD-EFGH',
    expiresIn: 900,
    interval: 5,
  });
});

test('六步链 happy path：各步载荷/头与 v1 源码逐字段对齐', async () => {
  const { deps: d, fetchImpl } = makeDeps(happyRoutes());
  const issued = await requestDeviceCode(d);
  const pair = await pollDeviceToken(d, issued.deviceCode, issued.view.interval);
  const chain = await runAuthTail(d, pair);

  const tokenCall = fetchImpl.calls.find((c) => c.url.includes('/v2.0/token'));
  assert.equal(
    tokenCall.body,
    `client_id=${CLIENT}&grant_type=urn:ietf:params:oauth:grant-type:device_code&device_code=DEV-CODE-123`,
  );

  const xblBody = JSON.parse(fetchImpl.calls.find((c) => c.url.includes('/user/authenticate')).body);
  assert.equal(xblBody.Properties.AuthMethod, 'RPS');
  assert.equal(xblBody.Properties.SiteName, 'user.auth.xboxlive.com');
  assert.equal(xblBody.Properties.RpsTicket, `d=${javaUrlEncode(`MS-ACCESS.${SECRET}`)}`);
  assert.equal(xblBody.RelyingParty, 'http://auth.xboxlive.com');
  assert.equal(xblBody.TokenType, 'JWT');

  const xstsBody = JSON.parse(fetchImpl.calls.find((c) => c.url.includes('/xsts/authorize')).body);
  // v1 XSTSProperties 实锤：Properties={SandboxId,UserTokens:[xblToken]}（非任务书所述 DependsOn/AuthMethod）。
  assert.deepEqual(xstsBody.Properties, { SandboxId: 'RETAIL', UserTokens: ['XBL-TOKEN'] });
  assert.equal(xstsBody.RelyingParty, 'rp://api.minecraftservices.com/');
  assert.equal(xstsBody.TokenType, 'JWT');

  const mcsBody = JSON.parse(fetchImpl.calls.find((c) => c.url.includes('/login_with_xbox')).body);
  assert.deepEqual(mcsBody, { identityToken: 'XBL3.0 x=UHS123;XSTS-TOKEN' });

  const profileCall = fetchImpl.calls.find((c) => c.url.includes('/minecraft/profile'));
  assert.equal(profileCall.init.method, 'GET');
  assert.equal(profileCall.init.headers.Authorization, `Bearer MC-${SECRET}`);

  assert.equal(chain.id, 'cafe1234deadbeef00000000000000ff');
  assert.equal(chain.name, 'SteveOnline');
  assert.equal(chain.mcAccessToken, `MC-${SECRET}`);
  assert.equal(chain.mcExpiresIn, 86400);
  assert.equal(chain.refreshToken, `MS-REFRESH.${SECRET}`);
  // 皮肤 URL 从 profile skins[] ACTIVE 项解出（UI 头像一级数据源），http 统一升级 https。
  assert.equal(chain.skinUrl, 'https://textures.minecraft.net/texture/deadbeefcafe');
});

test('皮肤解析旧形状兼容：properties.textures(base64) 仍可解', async () => {
  const { deps: d } = makeDeps(
    happyRoutes({
      '/minecraft/profile': {
        json: {
          id: 'cafe1234deadbeef00000000000000ff',
          name: 'SteveOnline',
          properties: [
            {
              name: 'textures',
              value: Buffer.from(
                JSON.stringify({ skins: { SKIN: { url: 'http://textures.minecraft.net/texture/legacyb64' } } }),
              ).toString('base64'),
            },
          ],
        },
      },
    }),
  );
  const chain = await runAuthTail(d, { accessToken: 'MS-AT', refreshToken: 'MS-RT' });
  assert.equal(chain.skinUrl, 'https://textures.minecraft.net/texture/legacyb64');
});

test('皮肤缺席/坏值 = skinUrl 缺席，不拦登录', async () => {
  const { deps: d } = makeDeps(
    happyRoutes({
      '/minecraft/profile': {
        json: { id: 'cafe1234deadbeef00000000000000ff', name: 'SteveOnline', skins: [{ state: 'INACTIVE', url: 'http://textures.minecraft.net/texture/x' }], properties: [{ name: 'textures', value: '!!not-base64-json' }] },
      },
    }),
  );
  const chain = await runAuthTail(d, { accessToken: 'MS-AT', refreshToken: 'MS-RT' });
  assert.equal(chain.skinUrl, undefined);
});

test('轮询退避：authorization_pending 继续（interval 不变）、slow_down +5s', async () => {
  const sleeps = [];
  const { deps: d } = makeDeps(
    happyRoutes({
      '/token': (n) =>
        n === 0
          ? { status: 400, json: { error: 'authorization_pending' } }
          : n === 1
            ? { status: 400, json: { error: 'slow_down' } }
            : { json: { access_token: 'MS-A', refresh_token: 'MS-R', expires_in: 3600 } },
    }),
    { sleep: async (ms) => void sleeps.push(ms) },
  );
  const pair = await pollDeviceToken(d, 'DEV', 5);
  assert.deepEqual(sleeps, [5000, 10000]);
  assert.equal(pair.accessToken, 'MS-A');
});

test('XErr 分类：2148916233→no_xbox_profile、2148916238→minor_parental（v1 MicrosoftAuth L67-72）', async () => {
  for (const [xerr, code] of [
    [2148916233, 'no_xbox_profile'],
    [2148916238, 'minor_parental'],
  ]) {
    const { deps: d } = makeDeps(
      happyRoutes({ '/xsts/authorize': { status: 401, json: { XErr: xerr, Identity: 'id', Message: 'blocked' } } }),
    );
    await assert.rejects(
      xstsAuthenticate(d, 'XBL-TOKEN'),
      (e) => e instanceof MsAuthError && e.code === code && e.message === code,
      `XErr=${xerr} 应落 ${code}`,
    );
  }
});

test('profile 404 → no_minecraft（账户未持有 Java 版）', async () => {
  const { deps: d } = makeDeps(happyRoutes({ '/minecraft/profile': { status: 404, json: { error: 'NOT_FOUND' } } }));
  await assert.rejects(runAuthTail(d, { accessToken: 'MS-A', expiresIn: 3600 }), (e) => e instanceof MsAuthError && e.code === 'no_minecraft');
});

test('轮询错误分类：expired_token / authorization_declined → 对应码', async () => {
  for (const [err, code] of [
    ['expired_token', 'expired_token'],
    ['authorization_declined', 'access_denied'],
  ]) {
    const { deps: d } = makeDeps(happyRoutes({ '/token': { status: 400, json: { error: err } } }), {
      sleep: async () => {},
    });
    await assert.rejects(pollDeviceToken(d, 'DEV', 5), (e) => e instanceof MsAuthError && e.code === code);
  }
});

test('刷新链：token endpoint grant_type=refresh_token 重放（v1 CheckTokenRequest null-devcode 分支）', async () => {
  const { deps: d, fetchImpl } = makeDeps(happyRoutes());
  const pair = await refreshMsToken(d, `MS-REFRESH.${SECRET}`);
  const call = fetchImpl.calls.find((c) => c.url.includes('/v2.0/token'));
  assert.equal(call.body, `client_id=${CLIENT}&grant_type=refresh_token&refresh_token=MS-REFRESH.${SECRET}`);
  assert.equal(pair.accessToken, `MS-ACCESS.${SECRET}`);
});

// ---------- 白名单硬闸 + 脱敏绊线 ----------

test('端点白名单闸：五域放行、域外拒绝（含后缀伪装域）', () => {
  assert.deepEqual(
    [...MS_HOST_WHITELIST].sort(),
    ['api.minecraftservices.com', 'login.microsoftonline.com', 'sessionserver.mojang.com', 'user.auth.xboxlive.com', 'xsts.auth.xboxlive.com'].sort(),
  );
  for (const host of MS_HOST_WHITELIST) assert.ok(isMsEndpointAllowed(`https://${host}/x`));
  assert.ok(!isMsEndpointAllowed('https://evil.example.com/token'));
  assert.ok(!isMsEndpointAllowed('https://login.microsoftonline.com.evil.io/x'));
  assert.ok(!isMsEndpointAllowed('not-a-url'));
});

test('脱敏绊线：错误消息/栈零含 mock token 子串', async () => {
  const { deps: d } = makeDeps(
    happyRoutes({
      '/token': { status: 400, json: { error: 'expired_token', error_description: `token ${SECRET} dead` } },
    }),
    { sleep: async () => {} },
  );
  await assert.rejects(pollDeviceToken(d, `DEV-${SECRET}`, 5), (e) => {
    assert.equal(e.message, 'expired_token');
    assert.ok(!String(e.message).includes(SECRET));
    assert.ok(!String(e.stack ?? '').includes(SECRET));
    return true;
  });
});

// ---------- joinServer ----------

test('joinServer：serverId=sha1(解析 IPv4)、载荷字段照 v1 JoinServerRequest、端口剥离', async () => {
  const lookups = [];
  const { deps: d, fetchImpl } = makeDeps(
    { '/session/minecraft/join': { status: 204, json: null } },
    { lookup: async (host) => (lookups.push(host), '162.245.188.76') },
  );
  await joinServer(d, { sessionid: `MC-${SECRET}`, profileId: 'cafe1234', serverHost: 'play.example.net:25556' });
  assert.deepEqual(lookups, ['play.example.net']);
  const call = fetchImpl.calls[0];
  assert.equal(call.url, 'https://sessionserver.mojang.com/session/minecraft/join');
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers['Content-Type'], 'application/json');
  assert.equal(call.init.headers.Authorization, undefined); // v1 join 无 Authorization 头
  assert.deepEqual(JSON.parse(call.body), {
    accessToken: `MC-${SECRET}`, // v1 实锤：accessToken 字段 = sessionid（getAuthToken 直返 MCS token）
    selectedProfile: 'cafe1234',
    serverId: sha1ServerId('162.245.188.76'),
  });
  assert.equal(sha1ServerId('162.245.188.76'), crypto.createHash('sha1').update('162.245.188.76').digest('hex'));
});

test('javaUrlEncode：Java URLEncoder 同构（空格→+、保留 .-*_、其余 %XX 大写）', () => {
  assert.equal(javaUrlEncode('abcDEF123._*-'), 'abcDEF123._*-');
  assert.equal(javaUrlEncode('a b'), 'a+b');
  assert.equal(javaUrlEncode("a!b'"), 'a%21b%27');
});

// ---------- DPAPI codec ----------

test('DPAPI codec：本机真 ProtectedData roundtrip（Windows）', async (t) => {
  if (process.platform !== 'win32') return t.skip('DPAPI 仅 Windows');
  const plain = `eyJ0eXAiOiJKV1QiLCJhbGciOi.${SECRET}`;
  const enc = await encodeTokenSecret(plain);
  assert.ok(enc.startsWith(DPAPI_PREFIX));
  assert.ok(!enc.includes(SECRET), '密文不得含明文子串');
  assert.equal(await decodeTokenSecret(enc), plain);
  // 旧明文形态装载：无前缀原样返回。
  assert.equal(await decodeTokenSecret('legacy-plain-token'), 'legacy-plain-token');
});

test('DPAPI codec：非 Windows 平台明文透盘（跨平台开发态逃生舱）', async () => {
  const enc = await encodeTokenSecret('tok', { platform: 'linux' });
  assert.equal(enc, 'tok');
  assert.equal(await decodeTokenSecret('tok', { platform: 'linux' }), 'tok');
});

// ---------- runtime：single-flight / cancel / success / refresh ----------

const abortiveSleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    // 与生产 defaultSleep 同纪律：signal 在注册监听前已 aborted 时立即拒绝，
    // 否则 addEventListener('abort') 永不触发（cancel 竞态窗口）。
    if (signal?.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new Error('aborted'));
      },
      { once: true },
    );
  });

test('msStartLogin single-flight：在途流拒并发；cancel 落 canceled 事件；无流 cancel = no-op', async (t) => {
  const { fetchImpl } = makeDeps(happyRoutes({ '/token': { status: 400, json: { error: 'authorization_pending' } } }));
  const rt = tempRuntime(t, fetchImpl, { sleep: abortiveSleep, dpapi: { platform: 'linux' } });
  const events = [];
  rt.on(IPC_EVENTS.MS_LOGIN, (e) => events.push(e));

  const view = await rt.msStartLogin();
  assert.equal(view.userCode, 'ABCD-EFGH');
  await assert.rejects(rt.msStartLogin(), /已在进行中/);

  await rt.msCancelLogin();
  await until(() => events.length === 1);
  assert.deepEqual(events[0], { state: 'error', code: 'canceled' });

  // 流已释放：可再发起、再取消。
  await rt.msStartLogin();
  await rt.msCancelLogin();
  await until(() => events.length === 2);
  await rt.msCancelLogin(); // 无流 = no-op 成功（不抛）
});

test('msStartLogin 成功终局：MS_LOGIN success=AccountView；accounts.json token 落盘为 dpapi:v1 密文形态', async (t) => {
  const cipherB64 = Buffer.from('DPAPI-CIPHER-BYTES').toString('base64');
  const fakeSpawn = (_cmd, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.kill = () => {};
    child.stdin = {
      on: () => {},
      end: () => {
        setTimeout(() => {
          child.stdout.emit('data', Buffer.from(cipherB64));
          child.emit('close', 0);
        }, 0);
      },
    };
    assert.ok(String(args.at(-1)).includes('ProtectedData'), 'DPAPI 执行体须走 ProtectedData');
    return child;
  };
  const { fetchImpl } = makeDeps(happyRoutes());
  const rt = tempRuntime(t, fetchImpl, { sleep: async () => {}, dpapi: { platform: 'win32', spawnImpl: fakeSpawn } });
  const events = [];
  rt.on(IPC_EVENTS.MS_LOGIN, (e) => events.push(e));

  await rt.msStartLogin();
  await until(() => events.length === 1);
  const event = events[0];
  assert.equal(event.state, 'success');
  assert.deepEqual(event.account, {
    id: 'cafe1234deadbeef00000000000000ff',
    name: 'SteveOnline',
    type: 'microsoft',
    tokenValid: true,
    skinUrl: 'https://textures.minecraft.net/texture/deadbeefcafe',
  });
  assert.ok(!JSON.stringify(event).includes(SECRET), '事件载荷零 token（渲染只见 AccountView）');

  const disk = fs.readFileSync(path.join(rt.root, 'launcher', 'accounts.json'), 'utf8');
  assert.ok(disk.includes(`${DPAPI_PREFIX}${cipherB64}`), '磁盘形态 = dpapi:v1:<b64>');
  assert.ok(!disk.includes(SECRET), '磁盘密文零含 token 明文');
  const parsed = JSON.parse(disk);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].profileId, 'cafe1234deadbeef00000000000000ff');
});

test('同 profileId 幂等覆盖既有微软账户（不重复建档）', async (t) => {
  const { fetchImpl } = makeDeps(happyRoutes());
  const rt = tempRuntime(t, fetchImpl, { sleep: async () => {}, dpapi: { platform: 'linux' } });
  const events = [];
  rt.on(IPC_EVENTS.MS_LOGIN, (e) => events.push(e));
  await rt.msStartLogin();
  await until(() => events.length === 1);
  await rt.msStartLogin();
  await until(() => events.length === 2);
  const parsed = JSON.parse(fs.readFileSync(path.join(rt.root, 'launcher', 'accounts.json'), 'utf8'));
  assert.equal(parsed.length, 1);
});

test('msRefreshAccount：装载旧明文 → 重放链 → 落盘更新，返回脱敏视图', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attic-ms-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'launcher'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'launcher', 'accounts.json'),
    JSON.stringify([
      {
        id: 'cafe1234deadbeef00000000000000ff',
        name: 'SteveOnline',
        type: 'microsoft',
        accessToken: `OLD-${SECRET}`,
        refreshToken: `MS-REFRESH.${SECRET}`,
        tokenExpiresAt: Date.now() - 1000,
        profileId: 'cafe1234deadbeef00000000000000ff',
      },
    ]),
    'utf8',
  );
  const rt = new AtticRuntime({
    rootDir: dir,
    fetchImpl: mockFetch(happyRoutes()),
    msDeps: { dpapi: { platform: 'linux' } },
  });
  const view = await rt.msRefreshAccount('cafe1234deadbeef00000000000000ff');
  assert.deepEqual(view, {
    id: 'cafe1234deadbeef00000000000000ff',
    name: 'SteveOnline',
    type: 'microsoft',
    tokenValid: true,
    skinUrl: 'https://textures.minecraft.net/texture/deadbeefcafe',
  });
  const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'launcher', 'accounts.json'), 'utf8'));
  assert.equal(parsed[0].accessToken, `MC-${SECRET}`);
  assert.ok(parsed[0].tokenExpiresAt > Date.now());
  await assert.rejects(rt.msRefreshAccount('nope'), /账户不存在/);
  const offline = rt.addAccount('SteveOffline');
  await assert.rejects(rt.msRefreshAccount(offline.id), /仅微软账户/);
});

test('skinUrl 惰性回填：旧账户（无 skinUrl 落盘）首拉列表后台补跑刷新链回填', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attic-skinfill-'));
  fs.mkdirSync(path.join(dir, 'launcher'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'launcher', 'accounts.json'),
    JSON.stringify([
      {
        id: 'cafe1234deadbeef00000000000000ff',
        name: 'SteveOnline',
        type: 'microsoft',
        accessToken: `MC-${SECRET}`,
        refreshToken: `MS-REFRESH.${SECRET}`,
        tokenExpiresAt: Date.now() + 86400_000, // 令牌仍有效（无 UI 重验入口）→ 只能靠回填
        profileId: 'cafe1234deadbeef00000000000000ff',
      },
    ]),
    'utf8',
  );
  const rt = new AtticRuntime({
    rootDir: dir,
    fetchImpl: mockFetch(happyRoutes()),
    msDeps: { dpapi: { platform: 'linux' } },
  });
  // 首拉 = 当帧旧数据 + 后台回填启动；回填完成后（磁盘出现 skinUrl）再拉即见新皮肤。
  const first = await rt.listAccounts();
  assert.equal(first[0].skinUrl, undefined);
  await until(() => {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'launcher', 'accounts.json'), 'utf8'));
    return raw[0].skinUrl === 'https://textures.minecraft.net/texture/deadbeefcafe';
  });
  const second = await rt.listAccounts();
  assert.equal(second[0].skinUrl, 'https://textures.minecraft.net/texture/deadbeefcafe');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('CLIENT_ID 生效值：内嵌缺省 → settings.microsoftClientId 覆盖', async (t) => {
  const { fetchImpl } = makeDeps(happyRoutes());
  const rt = tempRuntime(t, fetchImpl, { sleep: async () => {}, dpapi: { platform: 'linux' } });
  const events = [];
  rt.on(IPC_EVENTS.MS_LOGIN, (e) => events.push(e));

  await rt.msStartLogin();
  await until(() => events.length === 1);
  const deviceCodeCalls = () => fetchImpl.calls.filter((c) => c.url.includes('/devicecode'));
  assert.ok(deviceCodeCalls()[0].body.includes(`client_id=${DEFAULT_MS_CLIENT_ID}`));

  rt.setSettings({ microsoftClientId: 'MY-OWN-CLIENT' });
  await rt.msStartLogin();
  await until(() => events.length === 2);
  assert.ok(deviceCodeCalls()[1].body.includes('client_id=MY-OWN-CLIENT'));
});

// ---------- 轮询网络抖动容忍 + profile 误分类（2026-11-02 隐性 bug 审计） ----------

test('轮询网络抖动容忍：瞬时传输失败按 interval 重试（授权窗口不中止）；拿到响应即清零', async () => {
  let netFails = 0;
  const base = mockFetch(
    happyRoutes({
      '/token': (n) =>
        n === 0
          ? { status: 400, json: { error: 'authorization_pending' } }
          : { json: { access_token: 'MS-A', refresh_token: 'MS-R', expires_in: 3600 } },
    }),
  );
  const fetchImpl = async (url, init) => {
    if (url.includes('/v2.0/token') && netFails < 2) {
      netFails++;
      throw new Error('ECONNRESET 模拟抖动');
    }
    return base(url, init);
  };
  const sleeps = [];
  const d = { fetchImpl, clientId: CLIENT, sleep: async (ms) => void sleeps.push(ms) };
  const pair = await pollDeviceToken(d, 'DEV', 5);
  assert.equal(pair.accessToken, 'MS-A');
  assert.equal(netFails, 2);
  assert.deepEqual(sleeps, [5000, 5000, 5000], '两次抖动 + 一次 pending 各睡 interval');
});

test('轮询网络失败上限：连续 5 次抖动 = 放弃抛 network（不无限轮询）', async () => {
  let attempts = 0;
  const d = {
    fetchImpl: async () => {
      attempts++;
      throw new Error('ETIMEDOUT');
    },
    clientId: CLIENT,
    sleep: async () => {},
  };
  await assert.rejects(pollDeviceToken(d, 'DEV', 5), (e) => e instanceof MsAuthError && e.code === 'network');
  assert.equal(attempts, 5, '第 5 次连续失败即弃');
});

test('profile 瞬时故障（503）= internal 归因，不误报 no_minecraft（仅 404 才是不持有游戏）', async () => {
  const { deps: d } = makeDeps(
    happyRoutes({ '/minecraft/profile': { status: 503, json: { error: 'SERVICE_UNAVAILABLE' } } }),
  );
  await assert.rejects(
    runAuthTail(d, { accessToken: 'MS-A', expiresIn: 3600 }),
    (e) => e instanceof MsAuthError && e.code === 'internal',
  );
});
