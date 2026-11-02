/**
 * 微软登录（正版认证链）runtime 层。
 * 线格式事实源 = reference/betacraft-launcher v1 源码逐字段对齐：
 *   MicrosoftAuth.java / DeviceCodeRequest.java / CheckTokenRequest.java /
 *   XBLAuthRequest.java / XSTSAuthRequest.java / MinecraftAuthRequest.java /
 *   MinecraftProfileRequest.java / JoinServerRequest.java / Wrapper.java L233-260。
 * 硬约束：
 *   ① 端点白名单闸——五域之外零发送（msFetch 单点）；
 *   ② 脱敏闸——MsAuthError.message 恒为分类码，响应体/URL 查询串永不进消息；
 *   ③ token 落盘 = Windows DPAPI（用户作用域）加密（dpapi:v1:<b64>），内存态解密。
 */

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { promises as dnsPromises } from 'node:dns';

import type { MsDeviceCode, MsLoginErrorCode } from '@attic/core-spec';

import type { FetchImpl } from './betacraft';

/**
 * 缺省 CLIENT_ID（**临时 = Betacraft 社区白名单 id**，v1 MicrosoftAuth.java L28 同源——Mojang 对
 * 第三方启动器实行 app 白名单制，未过审 id 在 login_with_xbox 被 403 "Invalid app registration"；
 * 借用面风险 = Mojang 可随时撤白（LiquidBounce 先例），仅作过审前过渡）。自有 id 15bc4a50
 * （Azure 应用注册，个人账户租户 + 公共客户端流）已提交 aka.ms/mce-reviewappid 白名单审批，
 * **过审即换**。生效值 = settings.microsoftClientId || DEFAULT_MS_CLIENT_ID（覆盖键供换绑/排障）。
 */
export const DEFAULT_MS_CLIENT_ID = '8075fa74-4091-4356-a0b8-a7c118ef121c';

/** 端点白名单（五域；msFetch 硬闸，域外直接 internal）。 */
export const MS_HOST_WHITELIST: ReadonlySet<string> = new Set([
  'login.microsoftonline.com',
  'user.auth.xboxlive.com',
  'xsts.auth.xboxlive.com',
  'api.minecraftservices.com',
  'sessionserver.mojang.com',
]);

const MS_URL = {
  deviceCode: 'https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode',
  token: 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token',
  xbl: 'https://user.auth.xboxlive.com/user/authenticate',
  xsts: 'https://xsts.auth.xboxlive.com/xsts/authorize',
  mcsLogin: 'https://api.minecraftservices.com/authentication/login_with_xbox',
  mcProfile: 'https://api.minecraftservices.com/minecraft/profile',
  join: 'https://sessionserver.mojang.com/session/minecraft/join',
} as const;

/** XSTS XErr 分类码（v1 MicrosoftAuth.java L67-72：2148916233=无 Xbox 档案 / 2148916238=未成年家长控制）。 */
const XERR_NO_XBOX_PROFILE = 2148916233;
const XERR_MINOR_PARENTAL = 2148916238;

/** 对外错误 = 分类码（脱敏硬闸：消息永不含 token 原文/响应体/URL 查询串）。 */
export class MsAuthError extends Error {
  readonly code: MsLoginErrorCode;
  constructor(code: MsLoginErrorCode) {
    super(code);
    this.name = 'MsAuthError';
    this.code = code;
  }
}

/** 流中止哨兵（cancel 路径专用；不是错误分类，由调用侧落 canceled）。 */
export class MsAbortError extends Error {
  constructor() {
    super('aborted');
    this.name = 'MsAbortError';
  }
}

export type SleepFn = (ms: number, signal?: AbortSignal) => Promise<void>;
export type LookupFn = (host: string) => Promise<string>;

/** DPAPI 执行体注入面（测试可换 spawn；缺省真 powershell.exe）。 */
export interface DpapiDeps {
  spawnImpl?: typeof spawn;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
  /** 宿主本地诊断日志（失败原因落 launcher.log；永不跨 IPC——脱敏闸不变）。 */
  log?: (msg: string) => void;
}

/** 认证链依赖（fetch 面 + CLIENT_ID + 可注入的轮询退避/IP 解析/DPAPI 执行体）。 */
export interface MsAuthDeps {
  fetchImpl: FetchImpl;
  clientId: string;
  signal?: AbortSignal;
  sleep?: SleepFn;
  lookup?: LookupFn;
  dpapi?: DpapiDeps;
  /** 宿主本地诊断日志（internal 归因用：步骤+HTTP 状态+OAuth error 字段；token/响应体原文不落）。 */
  log?: (msg: string) => void;
}

// ---------- 端点白名单硬闸 + 统一请求 helper ----------

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || (error as NodeJS.ErrnoException).code === 'ABORT_ERR')
  );
}

/** 白名单闸谓词（绊线测试出口）：url 的 host 命中五域 = true；解析失败 = false。 */
export function isMsEndpointAllowed(url: string): boolean {
  try {
    return MS_HOST_WHITELIST.has(new URL(url).host.toLowerCase());
  } catch {
    return false;
  }
}

/** 唯一出门口：host 不在五域白名单 = 直接 internal（纪律不是建议）；传输失败 = network。 */
async function msFetch(deps: MsAuthDeps, url: string, init: RequestInit = {}): Promise<Response> {
  if (!isMsEndpointAllowed(url)) {
    deps.log?.(`whitelist-deny host=${new URL(url).host}`);
    throw new MsAuthError('internal');
  }
  try {
    return await deps.fetchImpl(url, { ...init, signal: deps.signal });
  } catch (error) {
    if (isAbortError(error) || deps.signal?.aborted) throw new MsAbortError();
    throw new MsAuthError('network');
  }
}

/** 响应体 = JSON + 原文首 300 字符（json 解析失败 = null）。raw 只进宿主本地日志归因，永不跨 IPC——脱敏闸不变。 */
async function jsonWithRaw(res: Response): Promise<{ json: Record<string, unknown> | null; raw: string }> {
  let text: string;
  try {
    text = await res.text();
  } catch {
    return { json: null, raw: '(body-read-fail)' };
  }
  const raw = text.replace(/\s+/g, ' ').slice(0, 300);
  try {
    const parsed: unknown = JSON.parse(text);
    return { json: parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null, raw };
  } catch {
    return { json: null, raw };
  }
}

function str(body: Record<string, unknown> | null, key: string): string | undefined {
  const v = body?.[key];
  return typeof v === 'string' ? v : undefined;
}

function num(body: Record<string, unknown> | null, key: string): number | undefined {
  const v = body?.[key];
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

/**
 * internal 归因（宿主本地诊断面）：步骤 + HTTP 状态 + OAuth error/error_description/XErr 摘要
 * 进 deps.log（launcher.log 本地可见；error_description 为 AADSTS 说明文本，不含 token）。
 * 跨 IPC 面不变——事件/错误消息仍只有分类码（脱敏硬闸）。
 */
function failInternal(
  deps: MsAuthDeps,
  step: string,
  res?: { status: number },
  body?: Record<string, unknown> | null,
  raw?: string,
): MsAuthError {
  const parts = [step];
  if (res) parts.push(`status=${res.status}`);
  if (body === null) parts.push(`body=unparsable(非JSON/代理劫持嫌疑) raw=${raw ?? '(none)'}`);
  else if (body) {
    const err = str(body, 'error');
    const desc = str(body, 'error_description');
    const xerr = num(body, 'XErr');
    if (err) parts.push(`error=${err}`);
    if (desc) parts.push(`desc=${desc.slice(0, 200)}`);
    if (xerr !== undefined) parts.push(`XErr=${xerr}`);
    if (!err && !desc && xerr === undefined) parts.push(`fields=missing raw=${raw ?? '(none)'}`);
  }
  deps.log?.(parts.join(' '));
  return new MsAuthError('internal');
}

const FORM_HEADERS: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' };
const JSON_HEADERS: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };

/** v1 URLEncoder.encode 同构（XBL RpsTicket 用）：字母数字与 .-*_ 保留、空格→+、其余 %XX 大写。 */
export function javaUrlEncode(value: string): string {
  return encodeURIComponent(value)
    .replace(/%20/g, '+')
    .replace(/[!'()~]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

// ---------- ① 设备码 ----------

export interface MsDeviceCodeIssue {
  /** 轮询用机密（不落事件面、不进错误消息）。 */
  deviceCode: string;
  /** 弹窗展示面（契约 MsDeviceCode）。 */
  view: MsDeviceCode;
}

/** POST devicecode（form: client_id + scope=XboxLive.signin offline_access，v1 DeviceCodeRequest.java 逐字对齐）。 */
export async function requestDeviceCode(deps: MsAuthDeps): Promise<MsDeviceCodeIssue> {
  const res = await msFetch(deps, MS_URL.deviceCode, {
    method: 'POST',
    headers: FORM_HEADERS,
    body: `client_id=${deps.clientId}&scope=XboxLive.signin offline_access`,
  });
  const { json: body, raw } = await jsonWithRaw(res);
  const deviceCode = str(body, 'device_code');
  const userCode = str(body, 'user_code');
  const verificationUri = str(body, 'verification_uri');
  if (!res.ok || !deviceCode || !userCode || !verificationUri) throw failInternal(deps, 'devicecode', res, body, raw);
  return {
    deviceCode,
    view: {
      userCode,
      verificationUri,
      verificationUriComplete: str(body, 'verification_uri_complete'),
      expiresIn: num(body, 'expires_in') ?? 900,
      interval: num(body, 'interval') ?? 5,
    },
  };
}

// ---------- ② 轮询 token / 刷新链共用 token endpoint ----------

export interface MsTokenPair {
  /** MS 访问令牌（进 XBL 用，非 MCS token）。 */
  accessToken: string;
  refreshToken?: string;
  /** 秒。 */
  expiresIn: number;
}

function parseTokenPair(body: Record<string, unknown> | null): MsTokenPair | null {
  const accessToken = str(body, 'access_token');
  if (!accessToken) return null;
  return {
    accessToken,
    refreshToken: str(body, 'refresh_token'),
    expiresIn: num(body, 'expires_in') ?? 3600,
  };
}

async function postTokenForm(deps: MsAuthDeps, form: string): Promise<{ json: Record<string, unknown> | null; raw: string }> {
  const res = await msFetch(deps, MS_URL.token, { method: 'POST', headers: FORM_HEADERS, body: form });
  return jsonWithRaw(res);
}

/**
 * 设备码轮询（v1 CheckTokenRequest.java 载荷逐字对齐：grant_type=urn:ietf:params:oauth:grant-type:device_code）。
 * authorization_pending 继续；slow_down interval+5s；expired_token/declined → 分类码。
 */
export async function pollDeviceToken(
  deps: MsAuthDeps,
  deviceCode: string,
  intervalSec: number,
): Promise<MsTokenPair> {
  const sleep = deps.sleep ?? defaultSleep;
  let interval = Math.max(1, intervalSec);
  /** 连续传输失败计数：瞬时网络抖动 ≠ 授权失败，容忍重试；超限才放弃。任何一次拿到响应即清零。 */
  let networkFails = 0;
  for (;;) {
    if (deps.signal?.aborted) throw new MsAbortError();
    let body: Record<string, unknown> | null;
    let raw: string;
    try {
      ({ json: body, raw } = await postTokenForm(
        deps,
        `client_id=${deps.clientId}&grant_type=urn:ietf:params:oauth:grant-type:device_code&device_code=${deviceCode}`,
      ));
    } catch (error) {
      if (!(error instanceof MsAuthError) || error.code !== 'network') throw error;
      if (++networkFails >= 5) throw error;
      await sleep(interval * 1000, deps.signal);
      continue;
    }
    networkFails = 0;
    const pair = parseTokenPair(body);
    if (pair) return pair;
    const error = str(body, 'error');
    if (error === 'authorization_pending') {
      await sleep(interval * 1000, deps.signal);
      continue;
    }
    if (error === 'slow_down') {
      interval += 5;
      await sleep(interval * 1000, deps.signal);
      continue;
    }
    if (error === 'expired_token') throw new MsAuthError('expired_token');
    if (error === 'authorization_declined' || error === 'invalid_user') throw new MsAuthError('access_denied');
    throw failInternal(deps, 'poll', undefined, body, raw);
  }
}

/** 刷新链入口：token endpoint grant_type=refresh_token（v1 CheckTokenRequest devcode=null 分支）。 */
export async function refreshMsToken(deps: MsAuthDeps, refreshToken: string): Promise<MsTokenPair> {
  const { json: body, raw } = await postTokenForm(deps, `client_id=${deps.clientId}&grant_type=refresh_token&refresh_token=${refreshToken}`);
  const pair = parseTokenPair(body);
  if (!pair) throw failInternal(deps, 'refresh', undefined, body, raw);
  return pair;
}

// ---------- ③ XBL / ④ XSTS / ⑤ MCS / ⑥ profile ----------

export interface MsXblResult {
  token: string;
  /** DisplayClaims.xui[0].uhs。 */
  uhs: string;
}

/** XBL（v1 XBLAuthRequest.java + XBLProperties.java 载荷逐字对齐：RpsTicket=`d=`+URLEncoder(msToken)）。 */
export async function xblAuthenticate(deps: MsAuthDeps, msAccessToken: string): Promise<MsXblResult> {
  const res = await msFetch(deps, MS_URL.xbl, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({
      Properties: {
        AuthMethod: 'RPS',
        SiteName: 'user.auth.xboxlive.com',
        RpsTicket: `d=${javaUrlEncode(msAccessToken)}`,
      },
      RelyingParty: 'http://auth.xboxlive.com',
      TokenType: 'JWT',
    }),
  });
  const { json: body, raw } = await jsonWithRaw(res);
  const token = str(body, 'Token');
  const claims = body?.['DisplayClaims'];
  const xui = claims !== null && typeof claims === 'object' ? (claims as Record<string, unknown>)['xui'] : undefined;
  const uhs = Array.isArray(xui) && xui.length > 0 ? str(xui[0] as Record<string, unknown>, 'uhs') : undefined;
  if (!res.ok || !token || !uhs) throw failInternal(deps, 'xbl', res, body, raw);
  return { token, uhs };
}

/**
 * XSTS（v1 XSTSAuthRequest.java + XSTSProperties.java 载荷逐字对齐：Properties={SandboxId,UserTokens:[xblToken]}、
 * RelyingParty=rp://api.minecraftservices.com/）。
 * XErr 分类：2148916233→no_xbox_profile、2148916238→minor_parental。
 */
export async function xstsAuthenticate(deps: MsAuthDeps, xblToken: string): Promise<MsXblResult> {
  const res = await msFetch(deps, MS_URL.xsts, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({
      Properties: { SandboxId: 'RETAIL', UserTokens: [xblToken] },
      RelyingParty: 'rp://api.minecraftservices.com/',
      TokenType: 'JWT',
    }),
  });
  const { json: body, raw } = await jsonWithRaw(res);
  const xerr = num(body, 'XErr');
  if (xerr === XERR_NO_XBOX_PROFILE) throw new MsAuthError('no_xbox_profile');
  if (xerr === XERR_MINOR_PARENTAL) throw new MsAuthError('minor_parental');
  const token = str(body, 'Token');
  const claims = body?.['DisplayClaims'];
  const xui = claims !== null && typeof claims === 'object' ? (claims as Record<string, unknown>)['xui'] : undefined;
  const uhs = Array.isArray(xui) && xui.length > 0 ? str(xui[0] as Record<string, unknown>, 'uhs') : undefined;
  if (!res.ok || !token || !uhs) throw failInternal(deps, 'xsts', res, body, raw);
  return { token, uhs };
}

/** MCS（v1 MinecraftAuthRequest.java：identityToken=`XBL3.0 x={uhs};{xstsToken}`）。 */
export async function mcsLogin(deps: MsAuthDeps, uhs: string, xstsToken: string): Promise<MsTokenPair> {
  const res = await msFetch(deps, MS_URL.mcsLogin, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ identityToken: `XBL3.0 x=${uhs};${xstsToken}` }),
  });
  const { json: body, raw } = await jsonWithRaw(res);
  const accessToken = str(body, 'access_token');
  if (!res.ok || !accessToken) throw failInternal(deps, 'mcs', res, body, raw);
  return { accessToken, expiresIn: num(body, 'expires_in') ?? 86400 };
}

export interface MsProfileResult {
  /** MCS profile id（32 位 hex，v1 local_uuid 同源）。 */
  id: string;
  name: string;
  /** 官方皮肤贴图 URL（properties.textures base64 → skins.SKIN.url；解不出 = 缺席）。 */
  skinUrl?: string;
}

/** profile（GET Bearer；仅 404 = no_minecraft；其余非 2xx/坏形状 = internal 归因——
 * 401/429/5xx 误报「未购买游戏」会把瞬时故障说成永久事实，误导用户）。 */
export async function mcProfile(deps: MsAuthDeps, mcAccessToken: string): Promise<MsProfileResult> {
  const res = await msFetch(deps, MS_URL.mcProfile, {
    method: 'GET',
    headers: { Authorization: `Bearer ${mcAccessToken}` },
  });
  if (res.status === 404) throw new MsAuthError('no_minecraft');
  const { json: body, raw } = await jsonWithRaw(res);
  const id = str(body, 'id');
  const name = str(body, 'name');
  if (!res.ok || !id || !name) throw failInternal(deps, 'profile', res, body, raw);
  const skinUrl = parseSkinUrl(body);
  return { id, name, ...(skinUrl ? { skinUrl } : {}) };
}

/**
 * 皮肤 URL 双形状解析：
 * ① 新形状 = 顶层 `skins[]` 数组（`{state:'ACTIVE', url:'http://textures...', variant}`），
 *    取 ACTIVE 项；② 旧形状 = `properties[]` 的 textures 条目（base64(JSON) → skins.SKIN.url，
 *    sessionserver 遗留形状，防上游回切）。任何一环断 = 缺席（皮肤是展示面，不拦登录）。
 * textures 域真响应给 http——统一升级 https（该域 https 可用，UI webview 加载 http 图反被混合内容策略拦）。
 */
function parseSkinUrl(body: Record<string, unknown> | null): string | undefined {
  const skins = body?.['skins'];
  if (Array.isArray(skins)) {
    for (const s of skins) {
      const entry = s as Record<string, unknown> | null;
      if (entry?.state === 'ACTIVE' && typeof entry.url === 'string' && entry.url.startsWith('http')) {
        return entry.url.replace(/^http:/, 'https:');
      }
    }
  }
  const props = body?.['properties'];
  if (!Array.isArray(props)) return undefined;
  for (const p of props) {
    const value = (p as Record<string, unknown> | null)?.['value'];
    if ((p as Record<string, unknown> | null)?.['name'] !== 'textures' || typeof value !== 'string') continue;
    try {
      const decoded = JSON.parse(Buffer.from(value, 'base64').toString('utf8')) as {
        skins?: { SKIN?: { url?: unknown } };
      };
      const url = decoded?.skins?.SKIN?.url;
      if (typeof url === 'string' && url.startsWith('http')) return url.replace(/^http:/, 'https:');
    } catch {
      /* 坏 textures 忽略 */
    }
    return undefined;
  }
  return undefined;
}

/** 链尾 ③-⑥（设备码成功与刷新链共用重放段）。 */
export interface MsChainResult extends MsProfileResult {
  /** MCS 访问令牌（join sessionid / 游戏 auth 用）。 */
  mcAccessToken: string;
  mcExpiresIn: number;
  refreshToken?: string;
}

export async function runAuthTail(deps: MsAuthDeps, ms: MsTokenPair): Promise<MsChainResult> {
  const xbl = await xblAuthenticate(deps, ms.accessToken);
  const xsts = await xstsAuthenticate(deps, xbl.token);
  const mcs = await mcsLogin(deps, xbl.uhs, xsts.token);
  const profile = await mcProfile(deps, mcs.accessToken);
  return { ...profile, mcAccessToken: mcs.accessToken, mcExpiresIn: mcs.expiresIn, refreshToken: ms.refreshToken };
}

// ---------- joinServer（spawn 前预注册，Wrapper.java L233-260 + JoinServerRequest.java 对齐） ----------

/** serverId = sha1(IP 字符串) hex（v1 JoinServerRequest.sha1：小写 hex、逐字节 %02x）。 */
export function sha1ServerId(ip: string): string {
  return crypto.createHash('sha1').update(ip, 'utf8').digest('hex');
}

async function defaultLookup(host: string): Promise<string> {
  const result = await dnsPromises.lookup(host, { family: 4 });
  return result.address;
}

async function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new MsAbortError();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new MsAbortError());
      },
      { once: true },
    );
  });
}

export interface JoinServerInput {
  /** v1 sessionid 形状：微软账户 = getAuthToken() 直返的 MCS access_token（Wrapper.java L103 javadoc 的
   * token:accessToken:profileid 为老 YGGDRASIL 遗留格式，v1 微软账户实发裸 token）。 */
  sessionid: string;
  /** selectedProfile = v1 uuid（credentials.local_uuid = MCS profile id）。 */
  profileId: string;
  /** `ip[:port]`（LaunchContext.server 原样；端口剥离后解析）。 */
  serverHost: string;
}

/**
 * 预注册 join：POST sessionserver /session/minecraft/join，载荷字段名照 v1 JoinServerRequest
 * （accessToken/selectedProfile/serverId，无 Authorization 头）。
 * serverId 派生 = dns.lookup(服务器主机名)→IPv4 字符串→sha1 hex。
 * ⚠ 与 v1 有一处实现分歧：v1 对公网服务器哈希的是**本机外网 IP**（getExternalIP→checkip），
 * localhost→"127.0.0.1"；本实现哈希服务器解析 IP（checkip 域不在五域白名单纪律内）。
 * 失败抛 MsAuthError（调用侧不拦启动，只推警告行）。
 */
export async function joinServer(deps: MsAuthDeps, input: JoinServerInput): Promise<void> {
  const match = /^([^:/\s]+)(?::\d{1,5})?$/.exec(input.serverHost.trim());
  if (!match?.[1]) throw new MsAuthError('internal');
  const host = match[1];
  const lookup = deps.lookup ?? defaultLookup;
  let ip: string;
  try {
    ip = await lookup(host);
  } catch {
    throw new MsAuthError('network');
  }
  const res = await msFetch(deps, MS_URL.join, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accessToken: input.sessionid, selectedProfile: input.profileId, serverId: sha1ServerId(ip) }),
  });
  if (!res.ok) throw new MsAuthError('network');
}

// ---------- DPAPI（Windows 用户作用域，PowerShell ProtectedData 执行体） ----------

/** 磁盘密文前缀（accounts.json 内 token 字段形态：`dpapi:v1:<base64>`）。 */
export const DPAPI_PREFIX = 'dpapi:v1:';

/** 固定 Entropy 字节串（同机同用户、熵一致才能解）。 */
const DPAPI_ENTROPY_TEXT = 'Attic-Minecraft-Launcher DPAPI v1';

function dpapiScript(kind: 'protect' | 'unprotect'): string {
  // stdin 进数据、stdout 出 base64——token 永不进命令行参数（进程列表泄漏面）。
  const op =
    kind === 'protect'
      ? "[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($in), $e, [Security.Cryptography.DataProtectionScope]::CurrentUser))"
      : "[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($in.Trim()), $e, [Security.Cryptography.DataProtectionScope]::CurrentUser))";
  return (
    "$ErrorActionPreference='Stop';" +
    'Add-Type -AssemblyName System.Security;' +
    '$in=[Console]::In.ReadToEnd();' +
    'if ($in.EndsWith("`r") -or $in.EndsWith("`n")) { $in = $in.TrimEnd("`r","`n") };' +
    `$e=[Text.Encoding]::UTF8.GetBytes('${DPAPI_ENTROPY_TEXT}');` +
    `${op}`
  );
}

/** 真跑一次 powershell.exe：stdin 喂数据、stdout 收 base64；非零退出 = internal（stderr 不回显内容）。 */
function runDpapi(kind: 'protect' | 'unprotect', stdinData: string, deps: DpapiDeps): Promise<string> {
  const spawnImpl = deps.spawnImpl ?? spawn;
  const timeoutMs = deps.timeoutMs ?? 30_000;
  return new Promise<string>((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawnImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', dpapiScript(kind)], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      deps.log?.(`dpapi-${kind} spawn-fail ${error instanceof Error ? error.message : String(error)}`);
      reject(new MsAuthError('internal'));
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* 已退出 */
      }
      deps.log?.(`dpapi-${kind} timeout(${timeoutMs}ms)`);
      reject(new MsAuthError('internal'));
    }, timeoutMs);
    let out = '';
    let err = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      err += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      deps.log?.(`dpapi-${kind} child-error ${error.message}`);
      reject(new MsAuthError('internal'));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const b64 = out.replace(/\s+/g, '');
      if (code === 0 && b64.length > 0) resolve(b64);
      else {
        // stderr = PowerShell 报错文本（无 token——stdin 数据不出现在错误里）；截断防日志爆量。
        deps.log?.(`dpapi-${kind} exit=${code} stderr=${err.replace(/\s+/g, ' ').slice(0, 240) || '(empty)'}`);
        reject(new MsAuthError('internal'));
      }
    });
    child.stdin?.on('error', () => {
      /* powershell 提前退出时写管道 EPIPE：由 close 分支统一失败 */
    });
    child.stdin?.end(stdinData);
  });
}

/**
 * token → 磁盘形态：Windows = `dpapi:v1:<b64>`（DPAPI 用户作用域）；
 * 非 Windows 平台无 DPAPI = 明文透传（跨平台开发态逃生舱，Windows 生产面恒密文）。
 */
export async function encodeTokenSecret(plain: string, deps: DpapiDeps = {}): Promise<string> {
  const platform = deps.platform ?? process.platform;
  if (platform !== 'win32') return plain;
  const b64 = await runDpapi('protect', plain, deps);
  return `${DPAPI_PREFIX}${b64}`;
}

/**
 * 磁盘形态 → 内存明文：`dpapi:v1:` 前缀走 Unprotect；无前缀 = 旧明文原样装载
 * （下次落盘自动升级为密文）。
 */
export async function decodeTokenSecret(value: string, deps: DpapiDeps = {}): Promise<string> {
  if (!value.startsWith(DPAPI_PREFIX)) return value;
  const platform = deps.platform ?? process.platform;
  if (platform !== 'win32') throw new MsAuthError('internal');
  const b64 = await runDpapi('unprotect', value.slice(DPAPI_PREFIX.length), deps);
  return Buffer.from(b64, 'base64').toString('utf8');
}
