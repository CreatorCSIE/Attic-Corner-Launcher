/**
 * 检查更新数据面（GitHub Releases，零依赖自包含）。
 * 事实来源按当前构件轨分流：
 * - stable 构件（版本号无 `-`）= `https://api.github.com/repos/{owner}/{repo}/releases/latest`
 *   —— /latest 端点天然排除 draft/prerelease，不消费 latest.json（无自托管清单依赖）；
 * - nightly 构件（版本号含 `-nightly.`）= `.../releases?per_page=30` 列表轨中匹配
 *   —— 候选 = prerelease=true ∧ draft≠true ∧ tag 含 `-nightly.`（跨 base 允许、永不混 stable 轨）；
 * - stable 构件开 `updatePreview`（deps.preview）= 同列表端点，候选 = stable ∪ nightly 轨取最大
 *   （plan「测试版通道与更新执行面」条②；静默通道 latest.json 不受影响）。
 * semver 比较自研（semver 2.0 完整预发布序）：主段数字逐位比较（缺段按 0：1.0 == 1.0.0）；
 * tag 去 v 前缀；预发布段：有预发布 < 无预发布（0.1.0-nightly.X < 0.1.0），
 * 标识符逐个比较（纯数字按数值、字母数字按 ASCII、数字恒小于字母数字、全等则短者小）。
 * 预发布纪律：其余预发布构件（0.0.x 短命试装轨、-rc 等，不含 `-nightly.`）→ 永不提示
 * （归 upToDate，手动跟 Releases 页）；stable 构件遇 latest tag 含 `-` → 同样永不提示（防御双保险）。
 * UA 纪律：GitHub API 无 User-Agent 一律 403 —— 请求头带 `Attic/<version>`（契约门面注入）。
 */

import type { UpdateCheckResult } from '@attic/core-spec';

import type { FetchImpl } from './betacraft';

/**
 * 默认发布仓库（同仓：开发仓即发布仓）。
 * 依据：releases 构件 = 纯启动器二进制（与源码仓同一零版权面）；`releases/latest` API
 * 天然排除 prerelease/draft（nightly/0.0.x/台账不污染通道）；同仓 = Actions GITHUB_TOKEN
 * 零跨仓 PAT。env ATTIC_RELEASE_REPO / 构造选项 = 测试仓彩排逃生舱；显式空串 = 强制关通道（unconfigured）。
 */
export const DEFAULT_RELEASE_REPO = 'CreatorCSIE/Attic-Minecraft-Launcher';

export interface UpdateCheckDeps {
  /** 发布仓库 "owner/repo"（构造选项 releaseRepo > env ATTIC_RELEASE_REPO > DEFAULT_RELEASE_REPO；显式空串 = unconfigured）。 */
  releaseRepo?: string;
  /** 当前版本（宿主注入的启动器版本）。 */
  currentVersion: string;
  /** 网络注入面（与 betacraft 同款：测试/离线可换 fake fetch）。 */
  fetchImpl: FetchImpl;
  /**
   * 提前体验测试版（settings.updatePreview 透传）：stable 构件开 = 改走列表端点，
   * 候选集 = stable ∪ nightly 轨取最大（stable 更新提示不丢）；nightly 构件恒在轨、
   * 本开关对其无效（形态判据 ∨ 开关判据并集）。其余预发布构件（rc/0.0.x）不受开关影响仍永不提示。
   */
  preview?: boolean;
}

/** Release 响应中消费的字段（/latest 单对象与 /releases 列表项同形状，其余原样忽略）。 */
interface ReleaseRaw {
  tag_name?: unknown;
  html_url?: unknown;
  body?: unknown;
  published_at?: unknown;
  prerelease?: unknown;
  draft?: unknown;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 版本拆主段与预发布标识符（v 前缀剥离、trim；首个 `-` 后为预发布段，无则 null）。 */
function splitVersion(version: string): { core: string[]; pre: string[] | null } {
  const v = version.trim().replace(/^v/i, '');
  const dash = v.indexOf('-');
  if (dash < 0) return { core: v.split('.'), pre: null };
  return { core: v.slice(0, dash).split('.'), pre: v.slice(dash + 1).split('.') };
}

/** 主段数字值（非数字按 0 —— 非法输入维持现行为）。 */
function segmentNumber(seg: string | undefined): number {
  const n = Number.parseInt(seg ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** 预发布标识符比较（semver 2.0 §11）：纯数字按数值、字母数字按 ASCII，数字恒小于字母数字标识符。 */
function compareIdentifiers(a: string, b: string): number {
  const aNum = /^\d+$/.test(a);
  const bNum = /^\d+$/.test(b);
  if (aNum && bNum) {
    const x = Number(a);
    const y = Number(b);
    if (x !== y) return x < y ? -1 : 1;
    return 0;
  }
  if (aNum !== bNum) return aNum ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * semver 2.0 比较（含完整预发布序）：a<b → -1，相等 → 0，a>b → 1。
 * 主段：长度不齐缺段按 0 补齐（0.0.9 < 0.1.0、1.9.0 < 1.10.0 均按数值位而非字典序）。
 * 预发布段：有预发布 < 无预发布（0.1.0-nightly.99999999 < 0.1.0）；标识符逐个比较
 * （nightly.2 < nightly.10 数值序；nightly.20261025 < nightly.20261026；全等则短者小 nightly.1 < nightly.1.1）。
 */
export function compareSemver(a: string, b: string): number {
  const pa = splitVersion(a);
  const pb = splitVersion(b);
  const len = Math.max(pa.core.length, pb.core.length);
  for (let i = 0; i < len; i++) {
    const x = segmentNumber(pa.core[i]);
    const y = segmentNumber(pb.core[i]);
    if (x !== y) return x < y ? -1 : 1;
  }
  if (pa.pre === null || pb.pre === null) {
    if (pa.pre === pb.pre) return 0;
    return pa.pre === null ? 1 : -1;
  }
  const shared = Math.min(pa.pre.length, pb.pre.length);
  for (let i = 0; i < shared; i++) {
    const c = compareIdentifiers(pa.pre[i] ?? '', pb.pre[i] ?? '');
    if (c !== 0) return c;
  }
  if (pa.pre.length === pb.pre.length) return 0;
  return pa.pre.length < pb.pre.length ? -1 : 1;
}

/** 组装 update 分支（url/notes/publishedAt 缺字段空串容忍；stable/nightly 两轨同形状）。 */
function toUpdateResult(raw: ReleaseRaw, version: string): UpdateCheckResult {
  return {
    status: 'update',
    version,
    url: typeof raw.html_url === 'string' ? raw.html_url : '',
    notes: typeof raw.body === 'string' ? raw.body : '',
    publishedAt: typeof raw.published_at === 'string' ? raw.published_at : '',
  };
}

/**
 * 轨中匹配：从 /releases 列表（GitHub 序 = 创建时间新在前，per_page=30 窗口）取最大候选。
 * 候选 = 非 draft ∧ [（prerelease ∧ tag 含 `-nightly.`）∨（includeStable ∧ 非 prerelease ∧ tag 无 `-`）]；
 * includeStable 由入口决定：nightly 构件 = false（永不混 stable 轨，跨 base nightly 允许）、
 * stable+预览 = true（stable ∪ nightly 并集，stable 更新提示不因开关丢失）。
 * 列表空/无候选/最大者不高于 current → upToDate；响应形状非法 → error（与 /latest 路径同口径）。
 */
async function pickTrackRelease(res: Response, current: string, includeStable: boolean): Promise<UpdateCheckResult> {
  let list: unknown;
  try {
    list = await res.json();
  } catch (error) {
    return { status: 'error', message: `响应不是合法 JSON（${messageOf(error)}）` };
  }
  if (!Array.isArray(list)) return { status: 'error', message: 'Release 列表响应不是数组' };
  let best: ReleaseRaw | null = null;
  let bestVersion = '';
  for (const item of list as unknown[]) {
    if (!item || typeof item !== 'object') continue;
    const rel = item as ReleaseRaw;
    if (rel.draft === true) continue;
    const tag = typeof rel.tag_name === 'string' ? rel.tag_name.trim() : '';
    if (rel.prerelease === true) {
      // 其余预发布（rc/0.0.x 短命试装轨）恒不入候选（预发布纪律）
      if (!tag.includes('-nightly.')) continue;
    } else if (!includeStable || tag.includes('-')) {
      continue;
    }
    const version = tag.replace(/^v/i, '');
    if (!best || compareSemver(version, bestVersion) > 0) {
      best = rel;
      bestVersion = version;
    }
  }
  if (!best || compareSemver(bestVersion, current) <= 0) return { status: 'upToDate', current };
  return toUpdateResult(best, bestVersion);
}

/**
 * 拉取 GitHub 最新 Release 并与当前版本比较（轨分流见文件头）。
 * 全分支数据化返回（不抛）：仓库未配置 = unconfigured；格式非法/网络炸/非 2xx/响应缺 tag_name = error。
 */
export async function checkLatestRelease(deps: UpdateCheckDeps): Promise<UpdateCheckResult> {
  const repo = deps.releaseRepo?.trim() ?? '';
  if (!repo) return { status: 'unconfigured' };
  const parts = repo.split('/');
  if (parts.length !== 2 || parts.some((p) => p === '' || p !== p.trim())) {
    return { status: 'error', message: `发布仓库格式非法：${JSON.stringify(repo)}（期望 "owner/repo"）` };
  }
  const [owner, name] = parts as [string, string];
  const current = deps.currentVersion;
  // 轨分流（形态判据 ∨ 开关判据并集）：nightly 构件恒走列表轨中匹配；stable 开预览也走列表
  // （候选并集含 stable）；stable 关预览与其余预发布构件 = /latest 单请求。
  // 预发布纪律优先于开关判据：rc/0.0.x 短命试装轨构件开预览也不换源（永不提示照旧）。
  const nightlyTrack = current.includes('-nightly.');
  const useList = nightlyTrack || (deps.preview === true && !current.includes('-'));
  const repoBase = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  const url = useList ? `${repoBase}/releases?per_page=30` : `${repoBase}/releases/latest`;
  let res: Response;
  try {
    res = await deps.fetchImpl(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        // GitHub API 强制 UA（无则 403）；版本串原样入 UA。
        'User-Agent': `Attic/${deps.currentVersion}`,
      },
    });
  } catch (error) {
    return { status: 'error', message: `检查更新请求失败：${messageOf(error)}` };
  }
  if (!res.ok) {
    const hint = res.status === 404 ? '（仓库不存在或尚无 Release）' : res.status === 403 ? '（限流或 UA 被拒）' : '';
    return { status: 'error', message: `GitHub API HTTP ${res.status}${hint}` };
  }
  if (useList) return pickTrackRelease(res, current, !nightlyTrack);
  let raw: ReleaseRaw;
  try {
    raw = (await res.json()) as ReleaseRaw;
  } catch (error) {
    return { status: 'error', message: `响应不是合法 JSON（${messageOf(error)}）` };
  }
  const tag = typeof raw.tag_name === 'string' ? raw.tag_name.trim() : '';
  if (!tag) return { status: 'error', message: 'Release 响应缺少 tag_name' };
  // 预发布纪律（见文件头）：自身为其余预发布（不含 -nightly.，0.0.x 短命试装轨手动跟 Releases 页）
  // 或 latest tag 含 `-`（防御双保险）→ 永不提示。
  if (current.includes('-') || tag.includes('-')) return { status: 'upToDate', current };
  const version = tag.replace(/^v/i, '');
  if (compareSemver(version, current) <= 0) return { status: 'upToDate', current };
  return toUpdateResult(raw, version);
}
