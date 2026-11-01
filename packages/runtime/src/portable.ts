/**
 * portable 便携态判定与随身指针。
 *
 * 双指纹判定式 = 程序目录 marker ini 在场 ∨（exe 旁 `.attic` 在场 ∧ 其内 `launcher/portable.anchor` 在场）。
 * marker 埋程序目录（tauri = `sidecar/portable.ini`、electron/legacy = `resources/portable.ini`，随 zip 出厂）；
 * anchor = 首启向导确认时落锚（内容 = 落锚时 exeDir + 版本），职能 = ini 被升级重解压重置/误删后的
 * 自愈指纹——marker 可丢可烧，便携身份不能丢。
 *
 * 硬纪律：exeDir 必须宿主显式传（sidecar 的 process.execPath = node.exe 不可信）。
 * ini `rootDir` = 随身指针：相对按 exeDir 解析（换盘符纪律，出厂留空）、绝对照用（UI 警示「换机即断」）；
 * ini 损坏 = fail-open 回落 exe 旁 `.attic` + console.warn。
 * 只读回落：exeDir 实写探针（mkdir+rm，不信属性位）不可写 → 回落默认根 + settings.portableFallback。
 */

import fs from 'node:fs';
import path from 'node:path';

import { parseProperties, serializeProperties } from './properties';
import { ensureLayout, loadSettings, saveSettings } from './storage';

/** exe 旁便携数据目录名（与平台默认根同名不同位：这里随盘走）。 */
export const PORTABLE_DIR_NAME = '.attic';
/** 首启落锚指纹（相对便携根）：`launcher/portable.anchor`。 */
export const PORTABLE_ANCHOR_REL = path.join('launcher', 'portable.anchor');
/** marker ini 里的随身指针键。 */
const INI_ROOT_KEY = 'rootDir';

export type PortablePathWarning = 'non_ascii' | 'space' | 'long';

export interface PortableProbeOptions {
  /** 程序目录（exe 所在目录绝对路径；宿主显式传，见头注硬纪律）。 */
  exeDir: string;
  /** marker ini 候选（相对 exeDir 或绝对路径，按壳形态宿主传：tauri=['sidecar/portable.ini']、electron=['resources/portable.ini']）。 */
  markerCandidates?: string[];
  /** 覆盖环境变量（测试注入），缺省 process.env。 */
  env?: NodeJS.ProcessEnv;
  /** 覆盖平台（测试注入），缺省 process.platform。 */
  platform?: string;
  /** 启动器版本（anchor 内容携带，排障用）。 */
  version?: string;
  /** 平台默认根（只读回落目标；由调用方 resolveDataRoot 算好传入，避免本模块重复平台逻辑）。 */
  defaultRoot: string;
}

export interface PortableResolution {
  /** 双指纹判定命中（含只读回落态——身份是便携，只是数据暂不随盘）。 */
  active: boolean;
  /** 生效根：ini rootDir 解析位 / exe 旁 `.attic`；fallback 时 = defaultRoot。 */
  root: string;
  /** 命中的 marker ini 绝对路径（anchor 自愈态 = undefined）。 */
  iniPath?: string;
  /** marker 缺席、anchor 自愈命中（升级重解压重置/误删 ini 后的便携身份恢复）。 */
  rebuilt: boolean;
  /** 实写探针不可写 → 已回落默认根。 */
  fallback: boolean;
  /** 生效根路径警示（对便携根判定，回落态也如实报）。 */
  pathWarning?: PortablePathWarning;
  /** 程序目录回带（anchor 落锚/守卫复用，免调用方另存）。 */
  exeDir: string;
  /** ini rootDir 解析出的绝对随身指针（未设 = undefined；回落态也保留，供 UI 指针视图）。 */
  pointerRoot?: string;
}

function pathFor(platform: string): typeof path.win32 {
  return platform === 'win32' ? path.win32 : path.posix;
}

/**
 * 路径警示分类（纯函数，UI 黄条与 runtime 共用口径）：非 ASCII → 含空格 → 长度逼近 260（阈值 ≥240）。
 * 判定对象 = 生效便携根；警告不拦截（LWJGL2/Java8 非 ASCII 翻车面留给用户决策）。
 */
export function classifyPathWarning(root: string): PortablePathWarning | undefined {
  if (/[^\x00-\x7f]/.test(root)) return 'non_ascii';
  if (root.includes(' ')) return 'space';
  if (root.length >= 240) return 'long';
  return undefined;
}

/** 实写探针：mkdir + 写删临时文件（不信属性位——只读介质/UAC 虚拟化都藏不住）。 */
function probeWritable(dir: string): boolean {
  const probeDir = path.join(dir, `.attic-write-probe-${process.pid}-${Date.now()}`);
  try {
    fs.mkdirSync(probeDir, { recursive: true });
    fs.writeFileSync(path.join(probeDir, 'probe.tmp'), '');
    fs.rmSync(probeDir, { recursive: true, force: true });
    return true;
  } catch {
    try {
      fs.rmSync(probeDir, { recursive: true, force: true });
    } catch {
      /* 探针目录都没建起来 = 不可写，清理失败无所谓 */
    }
    return false;
  }
}

/**
 * 双指纹判定 + 随身指针解析 + 只读回落（一次算齐，runtime 构造期消费）。
 * 返回 null = 非便携（安装版天然不命中：无 marker ∧ exe 旁无 `.attic`）。
 */
export function detectPortable(options: PortableProbeOptions): PortableResolution | null {
  const p = pathFor(options.platform ?? process.platform);
  const exeAttic = p.join(options.exeDir, PORTABLE_DIR_NAME);
  const anchor = p.join(exeAttic, PORTABLE_ANCHOR_REL);
  const marker = (options.markerCandidates ?? [])
    .map((c) => (p.isAbsolute(c) ? c : p.join(options.exeDir, c)))
    .find((c) => fs.existsSync(c));
  const anchorHit = fs.existsSync(anchor);
  if (!marker && !anchorHit) return null;

  // ini rootDir 解析：缺省/空 = exe 旁 `.attic`；相对按 exeDir 解析（换盘符纪律）；绝对照用；
  // 损坏（读不出合法 rootDir 形态以外的炸）= fail-open 回落 exe 旁 `.attic` + warn。
  let root = exeAttic;
  let iniPath: string | undefined;
  let pointerRoot: string | undefined;
  if (marker) {
    iniPath = marker;
    const props = loadPortableIni(marker);
    if (props === null) {
      console.warn(`[attic-portable] portable.ini 读取失败，回落 exe 旁 .attic：${marker}`);
    } else {
      const pointer = props[INI_ROOT_KEY]?.trim();
      if (pointer) {
        pointerRoot = p.isAbsolute(pointer) ? p.normalize(pointer) : p.resolve(options.exeDir, pointer);
        root = pointerRoot;
      }
    }
  }
  const rebuilt = !marker && anchorHit;
  const pathWarning = classifyPathWarning(root);

  // 只读回落：对便携根实写探针（探针即测「能不能往随盘位置写数据」，覆盖 exeDir 只读场景）
  if (probeWritable(root)) {
    return {
      active: true,
      root,
      ...(iniPath ? { iniPath } : {}),
      rebuilt,
      fallback: false,
      exeDir: options.exeDir,
      ...(pointerRoot ? { pointerRoot } : {}),
      ...(pathWarning ? { pathWarning } : {}),
    };
  }
  return {
    active: true,
    root: options.defaultRoot,
    ...(iniPath ? { iniPath } : {}),
    rebuilt,
    fallback: true,
    exeDir: options.exeDir,
    ...(pointerRoot ? { pointerRoot } : {}),
    ...(pathWarning ? { pathWarning } : {}),
  };
}

/**
 * marker ini 读取（properties 形态复用 storage 解析器，读失败/不存在 = null 触发 fail-open）。
 * 独立小函数：ini 只认 rootDir 一键，其余键（未来出厂项）原样带出不消费。
 */
function loadPortableIni(file: string): Record<string, string> | null {
  try {
    return parseProperties(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 随身指针写回（portable 形态下「更换数据根」的落点 = marker ini 的 rootDir，两形态各写各的指针面）。
 * 写绝对路径（相对位仅出厂留空与手工编辑用；UI 选择器给出的必是绝对路径）；空串 = 清除指针回落 exe 旁缺省。
 * ini 缺席（anchor 自愈态）= 显式报错——指针面无处可写，绝不静默写进生效根 settings（下次读不到 = 假持久）。
 */
export function writePortablePointer(iniPath: string | undefined, rootDir: string): void {
  if (!iniPath) throw new Error('便携指针无处可写：marker ini 缺席（anchor 自愈态），请重新解压完整便携包');
  const existing = loadPortableIni(iniPath) ?? {};
  if (rootDir) existing[INI_ROOT_KEY] = rootDir;
  else delete existing[INI_ROOT_KEY];
  fs.mkdirSync(path.dirname(iniPath), { recursive: true });
  fs.writeFileSync(iniPath, serializeProperties(existing), 'utf8');
}

/**
 * 首启落锚（向导完成 ∧ wizardFlavor=portable 时调，幂等）：
 * ensureLayout 建便携根骨架 + 写 `launcher/portable.anchor`（内容 = 落锚时 exeDir + 版本）。
 * 已存在 = 不动（保留首次落锚指纹，升级重解压不覆盖）。
 */
export function writePortableAnchor(exeDir: string, version: string): void {
  const root = path.join(exeDir, PORTABLE_DIR_NAME);
  ensureLayout(root);
  const anchor = path.join(root, PORTABLE_ANCHOR_REL);
  if (fs.existsSync(anchor)) return;
  fs.mkdirSync(path.dirname(anchor), { recursive: true });
  fs.writeFileSync(anchor, `exeDir=${exeDir}\nversion=${version}\n`, 'utf8');
}

/**
 * 登记簿同步（portable 激活时构造期调，幂等、值变才写省 IO）：默认根永远可达，天然是登记簿。
 * 正常态 = 生效根记进 `lastPortableRoot`（面包屑，指针丢失时的找回兜底）+ 清除过期 `portableFallback`；
 * 只读回落态 = 置 `portableFallback`（UI 常驻徽标数据源），面包屑保留上一个便携根不动。
 */
export function syncPortableRegistry(defaultRoot: string, resolution: PortableResolution): void {
  const props = loadSettings(defaultRoot);
  let dirty = false;
  if (resolution.fallback) {
    if (props['portableFallback'] !== 'true') {
      props['portableFallback'] = 'true';
      dirty = true;
    }
  } else {
    if (props['portableFallback'] !== undefined) {
      delete props['portableFallback'];
      dirty = true;
    }
    if (props['lastPortableRoot'] !== resolution.root) {
      props['lastPortableRoot'] = resolution.root;
      dirty = true;
    }
  }
  if (dirty) saveSettings(defaultRoot, props);
}

/**
 * temp 守卫特征判定（宿主 boot 消费）：exeDir 命中 %TEMP%/%TMP% 前缀
 * 或 `Rar$`/`7z$`/`WinRar$` 特征段（压缩软件就地解体的目录指纹）。
 * 「exe 旁无既有 .attic」条件归宿主（与判定式合取后才拒启）。
 */
export function looksLikeTempExtraction(exeDir: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const resolved = path.resolve(exeDir).toLowerCase();
  for (const key of ['TEMP', 'TMP'] as const) {
    const tmp = env[key];
    if (!tmp) continue;
    const tmpRoot = path.resolve(tmp).toLowerCase();
    if (resolved === tmpRoot || resolved.startsWith(tmpRoot + path.sep)) return true;
  }
  return /(?:^|[\\/])(?:rar|7z|winrar)\$/i.test(exeDir);
}
