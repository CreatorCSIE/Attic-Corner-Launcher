/**
 * 社区服务器列表（Betacraft 单源）——legacy_server_list HTML 宽松解析 + 版本目录派生匹配。
 * 上游事实源：`POST http://api.betacraft.uk/v2/legacy_server_list` 回
 * HTML（UTF-8 带 BOM）：五个 `<div class="category"><h2>Classic|Indev|Alpha|
 * Beta|Release</h2><table>` 分组；每服务器两个 `<tr class="server">`——第一行 icon/join:// 链接/
 * 可选 Online Mode/可选 players/address span，第二行 description span。
 * join:// 四段 `ip:port/mppass/protocol/preferredVersion`（mppass=`use` 即无密码；preferredVersion
 * 值形脏：干净 id / 带构建后缀 / 第三方客户端名三形态，样本钉在 tests/fixtures/）。
 * 纪律：不引 HTML 解析库（正则宽松提取，坏行剔除不整页弃）；matchedVersionId 派生在宿主
 * （UI 零版本判断）；无进程内缓存（每次全量重拉）。
 */

import type { ServerCategory, ServerListView } from '@attic/core-spec';

const SERVER_CATEGORIES: readonly ServerCategory[] = ['classic', 'indev', 'alpha', 'beta', 'release'];

// ---------- HTML 实体解码（名字/描述含 &amp; 等；单趟替换避免二次解码） ----------

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#')) {
      const code = body.startsWith('#x') || body.startsWith('#X')
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named ?? whole;
  });
}

/** 剥 HTML 标签（宽松解析专用：属性里的 > 不管——上游模板不产生该形态）。 */
function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, '');
}

// ---------- preferredVersion 归一 + 三级匹配（①精确 ②前缀双向取最长 ③未命中=缺省） ----------

/**
 * 归一化 preferredVersion：trim；含空格取最后一个 token（`Uberbukkit Client a1.2.6`→`a1.2.6`、
 * `in-20100223MP v0.1.7`→`v0.1.7`）；lowercase。
 */
export function normalizePreferredVersion(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === '') return '';
  const tokens = trimmed.split(/\s+/);
  return (tokens[tokens.length - 1] ?? trimmed).toLowerCase();
}

/**
 * 对单个版本轨 id 集四级匹配：① 精确（大小写不敏感）；② 去分隔符精确（`b1.9pre6`↔`b1.9-pre6`，
 * 上游连字符噪声救援）；③ 前缀双向（`c0.30-c-1900` 命中目录 `c0.30-c`；反向如 `b1.7` 命中
 * `b1.7.3`），多个命中取最长公共段；④ 未命中 = undefined
 * （UI 走手动选版本或范围外解释态，matchedVersionId 键省略）。
 * 各轨调用序（自定义原样精确先行 → 官方 → 自定义兜底）在 parseServerList，见其注释。
 */
export function matchVersionId(preferred: string, versionIds: readonly string[]): string | undefined {
  return matchNormalized(normalizePreferredVersion(preferred), versionIds);
}

/**
 * preferred 全名去空格形态：`in-20100223MP v0.1.7` → `in-20100223mp_v0.1.7`——
 * BC mod 的 full_name 正是「基座名_版本」下划线拼接，第三方客户端服 preferred 与之只差分隔符。
 * mod/自定义轨兜底匹配专用（官方轨用不上：原版 id 无下划线拼接形态）。
 */
function underscorePreferred(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, '_');
}

/**
 * preferred 原样精确（trim + lowercase 全等，无前后缀级）——v1 WebsitePanel.getMod 对
 * ModsRepository full_name 的 `equalsIgnoreCase(preferred)` 语义：`in-20100223MP v0.1.7`
 * 直带空格命中仓库同名条目。mod/自定义轨先行级（官方轨用不上：原版服 preferred 恒干净 id，
 * 已由 matchVersionId 精确级覆盖；原样形含空格也绝不会撞原版 id）。
 */
function matchPreferredExact(raw: string, versionIds: readonly string[]): string | undefined {
  const norm = raw.trim().toLowerCase();
  if (norm === '') return undefined;
  for (const id of versionIds) {
    if (id.toLowerCase() === norm) return id;
  }
  return undefined;
}

/**
 * 前缀命中的分隔符边界闸：`Nomad Anarchy` preferred=`1.12.2`
 * 被官方 `1.1`（Minecraft 1.1）裸 startsWith 抢走——越界版本号不该互认。
 * 规则 = 前缀结束后下一字符**不得是数字**（数字 = 版本号还在延续，`1.1|2.2` 与
 * `1.1` 是两个版本）；`.`/字母/分隔符放行——`b1.7→b1.7.3`、`1.7.10x→1.7.10`、
 * `c0.30-c→c0.30-c-1900`、`a1.2.6→a1.2.6_UberBukkit`、`b1.4→b1.4-1507` 合法形态全保住。
 */
function prefixAtBoundary(longer: string, shorter: string): boolean {
  if (!longer.startsWith(shorter)) return false;
  if (longer.length === shorter.length) return true;
  return !/[0-9]/.test(longer[shorter.length] as string);
}

/** 剥连字符/下划线（上游 preferred 带连字符噪声形态：`b1.9pre6` ↔ 官方 `b1.9-pre6`）。 */
function stripSeps(s: string): string {
  return s.replace(/[-_]/g, '');
}

/** 对已归一串执行三级匹配（精确→去分隔符精确→前缀双向取最长→undefined），matchVersionId 的裸形核。 */
function matchNormalized(norm: string, versionIds: readonly string[]): string | undefined {
  if (norm === '') return undefined;
  for (const id of versionIds) {
    if (id.toLowerCase() === norm) return id;
  }
  // 去分隔符精确级（矛盾闸的配套救援，2026-11-03）：goplex `use/release_22/b1.9pre6` 类
  // 「协议段脏但 preferred 是真实 id 只差连字符」的服靠本级在名字轨先行命中，
  // matched 在场即不进矛盾闸——真实可玩服不被误杀成解释态。
  const stripped = stripSeps(norm);
  if (stripped !== '') {
    for (const id of versionIds) {
      if (stripSeps(id.toLowerCase()) === stripped) return id;
    }
  }
  let best: string | undefined;
  let bestLen = 0;
  for (const id of versionIds) {
    const lower = id.toLowerCase();
    if (prefixAtBoundary(lower, norm) || prefixAtBoundary(norm, lower)) {
      const hitLen = Math.min(lower.length, norm.length);
      if (hitLen > bestLen) {
        bestLen = hitLen;
        best = id;
      }
    }
  }
  return best;
}

// ---------- 列表页解析 ----------

/** join:// 四段拆解（第四段允许空格；前三段不含 `/`）。 */
function splitJoinHref(href: string): { address: string; mppass: string; protocol: string; preferredVersion: string } | null {
  const m = /^join:\/\/([^/]+)\/([^/]*)\/([^/]*)\/([\s\S]*)$/.exec(href.trim());
  if (!m) return null;
  const address = m[1] ?? '';
  const preferredVersion = m[4];
  if (address === '' || preferredVersion === undefined) return null;
  return { address, mppass: m[2] ?? '', protocol: m[3] ?? '', preferredVersion };
}

/** `ip:port` 拆解（无端口/非法端口 = null，条目剔除——id 稳定键依赖 port）。 */
function splitAddressPort(text: string): { address: string; port: number } | null {
  const idx = text.lastIndexOf(':');
  const address = idx >= 0 ? text.slice(0, idx) : text;
  const port = idx >= 0 ? Number(text.slice(idx + 1)) : NaN;
  if (address === '' || !Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return { address, port };
}

function extractIconUrl(rowHtml: string): string | undefined {
  const img = /<img[^>]*server__icon[^>]*>/i.exec(rowHtml)?.[0];
  if (!img) return undefined;
  const src = /src="([^"]*)"/i.exec(img)?.[1]?.trim();
  // 静态 unknown_pack.png = 上游占位（UI 自绘占位更省流量），不投 iconUrl；
  // `server_icon?socket=` 代理直链才给 UI 当 `<img>` 源。
  if (!src || src.includes('unknown_pack')) return undefined;
  return src;
}

/**
 * legacy_server_list HTML → ServerListView[]（宽松正则，不引解析库）。
 * 防御式：join:// 拆解失败或地址端口非法的条目剔除；描述行孤儿忽略；
 * 顶层无任何分类 h2 = 上游形状崩坏，显式抛错（UI 空态+重试，不静默出半截列表）。
 * 版本匹配三段：① v1 getMod 直命中先行——preferred 原串与
 * 仓库/本地 full_name equalsIgnoreCase 精确 = 服务器点名要该 mod 客户端，压过官方轨
 * （如 `Uberbukkit Client a1.2.6` 直命中仓库同名条目）；
 * ② 官方轨（BC 清单原版）——原版服不被 mod/自定义 id 的更长前缀劫持；
 * ③ mod/自定义轨尾 token/前缀 + 下划线形兜底（第三方客户端服 preferred 指 mod 名）。
 * ①③ 命中打 `matchedVersionIsCustom`（UI 弹窗知情提示）。mod 轨三级 = 原样精确先行
 * （v1 getMod 对仓库 full_name equalsIgnoreCase 语义，带空格全名直命中）→ 尾 token/前缀三级
 * → 下划线全名形兜底；customVersions 条目可携带 infoUrl（远端仓库 .info 直链），
 * 命中条目有值即投 `matchedModInfoUrl`（UI 确认进服时据此自动入库，v1 启动即 loadMods 对齐）。
 * 协议兼容全集（v1 区间语义，WebsitePanel 同款）：官方清单中 protocol 与 join:// 第三段
 * 字符串相等的全部版本（清单序）；matchedVersionId 不在其中（mod 兜底形）追加末尾；
 * 协议段空/`unknown` 或全集为空 = 省略 compatibleVersionIds 键（UI 回落单值/手动形态）。
 * 〔取证 2026-11-03：v1 该路径实为坏档——ReleaseJson L68 从 .info 读 `protocolVersion` 键，
 * 全清单无此键 → equals 恒 false → v1 协议循环永不命中、选版本窗恒空（仅 mod 仓库一支生效）。
 * 本实装 = v1 意图 + 清单第 5 列数据源的修复性实装，非 v1 行为复刻。〕
 * versionOutOfRange（BC v1 空白选版本窗的可见化改进）= 协议已知、清单有协议列可对照、
 * compatible 全集空（matched 双落空）或矛盾闸（preferred 非空与协议全集互斥，协议段不可信）
 * ——降级/旧缓存形态省略键，UI 维持手动形态。
 */
export function parseServerList(
  html: string,
  officialVersions: readonly { id: string; protocol?: string }[],
  customVersions: readonly { id: string; infoUrl?: string }[] = [],
): ServerListView[] {
  const officialIds = officialVersions.map((v) => v.id);
  const customIds = customVersions.map((v) => v.id);
  // 范围外判定的对照协议集（降级护栏）：官方清单 protocol 列整体缺席（清单不可得/旧缓存形）
  // = 无可对照集，全部服务器省略 versionOutOfRange，UI 维持手动选版本形态不误判「库外」。
  const knownProtocols = new Set(
    officialVersions.map((v) => v.protocol).filter((p): p is string => p !== undefined && p !== ''),
  );
  const body = html.replace(/^\uFEFF/, '');
  // 分类分段：按 h2 出现序切段（上游模板恒五段 Classic→Release；未知段名条目剔除）。
  const headers: { category: ServerCategory | null; start: number }[] = [];
  for (const m of body.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/gi)) {
    const name = decodeEntities(stripTags(m[1] ?? '')).trim().toLowerCase();
    headers.push({
      category: (SERVER_CATEGORIES as readonly string[]).includes(name) ? (name as ServerCategory) : null,
      start: m.index,
    });
  }
  if (headers.length === 0) throw new Error('服务器列表格式异常：无任何分类段（h2）');

  const out: ServerListView[] = [];
  for (let h = 0; h < headers.length; h++) {
    const header = headers[h];
    const category = header?.category;
    if (!header || !category) continue;
    const next = headers[h + 1];
    const segment = body.slice(header.start, next ? next.start : body.length);
    let pending: ServerListView | null = null; // 描述在下一行，先挂起等拼
    for (const row of segment.matchAll(/<tr[^>]*class="[^"]*\bserver\b[^"]*"[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const rowHtml = row[1] ?? '';
      const href = /href="(join:\/\/[^"]*)"/i.exec(rowHtml)?.[1];
      if (href) {
        // 服务器主行：join:// 四段 + 名字/在线标记/players/地址/icon。
        const join = splitJoinHref(href);
        if (!join) {
          pending = null;
          continue;
        }
        // 地址权威 = join:// 第一段（直连拼装用它）；server__address span 仅在其非法时兜底。
        const addressText = decodeEntities(
          stripTags(/<span class="server__address"[^>]*>([\s\S]*?)<\/span>/i.exec(rowHtml)?.[1] ?? ''),
        ).trim();
        const addr = splitAddressPort(join.address) ?? splitAddressPort(addressText);
        if (!addr) {
          pending = null;
          continue;
        }
        // 名字 = 锚内文本剥 server__version span（`[c0.30-c] ` 前缀不进 name）。
        const anchorInner = /href="join:\/\/[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(rowHtml)?.[1] ?? '';
        const name = decodeEntities(
          stripTags(anchorInner.replace(/<span class="server__version"[^>]*>[\s\S]*?<\/span>/i, '')),
        ).trim();
        if (name === '') {
          pending = null;
          continue;
        }
        const playersText = /<span class="server__players"[^>]*>([\s\S]*?)<\/span>/i.exec(rowHtml)?.[1] ?? '';
        const playersMatch = /\(\s*(\d+)\s*\/\s*(\d+)\s*\)/.exec(stripTags(playersText));
        const iconUrl = extractIconUrl(rowHtml);
        // v1 getMod 直命中先行：preferred 原串与仓库/本地
        // full_name equalsIgnoreCase 精确 = 服务器点名要该 mod 客户端的最强信号，
        // 排在官方轨前（`Uberbukkit Client a1.2.6` 直命中仓库同名条目，不被归一后的
        // 原版 id 抢走）。不中再官方轨先行（防 mod 长前缀劫持原版服），
        // 最后 mod 轨尾 token/前缀 + 全名下划线形两级兜底。
        let matched = matchPreferredExact(join.preferredVersion, customIds);
        let matchedIsCustom = matched !== undefined;
        if (matched === undefined) matched = matchVersionId(join.preferredVersion, officialIds);
        if (matched === undefined) {
          matched =
            matchVersionId(join.preferredVersion, customIds) ??
            matchNormalized(underscorePreferred(join.preferredVersion), customIds);
          matchedIsCustom = matched !== undefined;
        }
        const matchedModInfoUrl = matchedIsCustom && matched !== undefined
          ? customVersions.find((v) => v.id === matched)?.infoUrl
          : undefined;
        // 协议兼容全集（v1 区间语义）：官方 protocol 字符串相等（清单序）；
        // matched 不在集合（mod 兜底形/协议缺席形）追加末尾——与 v1「preferred 不在
        // matches 则把 mod 追加进集合」同构。
        const compatible: string[] = [];
        if (join.protocol !== '' && join.protocol !== 'unknown') {
          for (const v of officialVersions) {
            if (v.protocol === join.protocol) compatible.push(v.id);
          }
        }
        if (matched !== undefined && !compatible.includes(matched)) compatible.push(matched);
        // 矛盾闸（上游脏数据防线，2026-11-03 4B4T 实锤）：`use/release_22/1.21.11` 类行
        // preferred 与协议段互相矛盾——matched 落空 ∧ preferred 非空 ∧ 协议全集非空即矛盾
        // （全集成员全是官方 id，preferred 若与任何成员有名字关系，官方轨同一匹配器在更大
        // 集合上必先命中，matched 不会落空）。协议段不可信 → 省略全集键、改投范围外解释态：
        // preferred 与协议同屏展示，上游矛盾对用户可见，不再给 1.0 时代候选的误导下拉。
        const contradiction =
          matched === undefined && join.preferredVersion.trim() !== '' && compatible.length > 0;
        const entry: ServerListView = {
          id: `${addr.address}:${addr.port}`,
          name,
          description: '',
          address: addr.address,
          port: addr.port,
          ...(join.mppass !== '' && join.mppass !== 'use' ? { mppass: join.mppass } : {}),
          preferredVersion: join.preferredVersion.trim(),
          protocol: join.protocol,
          onlineMode: /class="server__mode--online"/i.test(rowHtml),
          ...(playersMatch ? { players: { online: Number(playersMatch[1]), max: Number(playersMatch[2]) } } : {}),
          ...(iconUrl ? { iconUrl } : {}),
          category,
          ...(matched ? { matchedVersionId: matched } : {}),
          ...(matchedIsCustom ? { matchedVersionIsCustom: true } : {}),
          ...(matchedModInfoUrl ? { matchedModInfoUrl } : {}),
          ...(compatible.length > 0 && !contradiction ? { compatibleVersionIds: compatible } : {}),
          // 范围外 = 协议已知且清单有协议列可对照，且「双落空」（compatible 全集空，matched
          // 在场必已追加进 compatible，空集即双落空）或「矛盾闸」（preferred 与协议段互斥，
          // 协议段不可信）——库里没有任何可信同协议客户端，UI 弹窗出解释态。
          ...(knownProtocols.size > 0 &&
          join.protocol !== '' &&
          join.protocol !== 'unknown' &&
          (compatible.length === 0 || contradiction)
            ? { versionOutOfRange: true }
            : {}),
        };
        out.push(entry);
        pending = entry;
      } else if (pending) {
        // 描述行：只认「刚建条目」的下一行；孤儿描述行（无主行在前）忽略。
        const desc = /<span class="server__description"[^>]*>([\s\S]*?)<\/span>/i.exec(rowHtml)?.[1];
        if (desc !== undefined) {
          pending.description = decodeEntities(stripTags(desc)).trim();
          pending = null;
        }
      }
    }
  }
  return out;
}
