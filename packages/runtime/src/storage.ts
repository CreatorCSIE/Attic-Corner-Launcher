/**
 * 存储层：`.attic/` 数据根（三平台路径 + portable + rootDir 可配置），
 * 内部结构与 Betacraft v1 完全一致（对照 BC.java + Launcher.java L256-261）。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Account } from '@attic/core-spec';

import { parseProperties, serializeProperties } from './properties';

export interface ResolveDataRootOptions {
  /** 覆盖平台（测试注入），缺省 process.platform。 */
  platform?: string;
  /** 覆盖环境变量（测试注入），缺省 process.env。 */
  env?: NodeJS.ProcessEnv;
  /** portable 模式的可执行文件路径，缺省 process.execPath。 */
  execPath?: string;
  /** portable：根 = 可执行文件旁 `.attic`。 */
  portable?: boolean;
  /** rootDir 全局可配置（共存/迁移逃生舱：老用户可直接指回 .betacraft）。 */
  rootDirOverride?: string;
}

function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** 按目标平台语义取 path 实现（win32 钉死 win32，不随宿主分隔符漂移——resolveDataRoot 同款纪律）。 */
function pathFor(platform: string): typeof path.win32 {
  return platform === 'win32' ? path.win32 : path.posix;
}

/**
 * child 是否位于 parent 目录之内（含相等的场景：child === parent 也算命中）。
 * win32 大小写不敏感（盘符/段全小写后比较）；POSIX 原样。护栏与 peek 兜底共用。
 */
export function isPathWithin(parent: string, child: string, platform = process.platform): boolean {
  const win = platform === 'win32';
  const p = pathFor(platform);
  let a = p.resolve(parent);
  let b = p.resolve(child);
  if (win) {
    a = a.toLowerCase();
    b = b.toLowerCase();
  }
  if (a === b) return true;
  return b.startsWith(a + (win ? '\\' : '/'));
}

export function resolveDataRoot(options: ResolveDataRootOptions = {}): string {
  const platform = options.platform ?? process.platform;
  if (options.rootDirOverride) return path.resolve(expandHome(options.rootDirOverride));
  const env = options.env ?? process.env;
  const execPath = options.execPath ?? process.execPath;
  // win32 路径语义固定走 path.win32：宿主为 Windows 时与 path 等价（零回归），
  // 在 POSIX 宿主上注入 win32 也能产出正确的反斜杠路径（跨平台可测，不随宿主分隔符漂移）。
  if (options.portable) {
    const p = platform === 'win32' ? path.win32 : path.posix;
    return p.join(p.dirname(execPath), '.attic');
  }
  const home = env['HOME'] ?? env['USERPROFILE'] ?? os.homedir();
  if (platform === 'win32') {
    const appData = env['APPDATA'] ?? path.win32.join(home, 'AppData', 'Roaming');
    return path.win32.join(appData, '.attic');
  }
  // POSIX 分支用 '/' 拼接：目标平台路径语义，不随宿主分隔符漂移。
  if (platform === 'darwin') return `${home}/Library/Application Support/attic`;
  return `${home}/.attic`;
}

// ---------- 布局路径（纯函数，便于测试） ----------

export const launcherDir = (root: string): string => path.join(root, 'launcher');
export const instancesDir = (root: string): string => path.join(launcherDir(root), 'instances');
export const langDir = (root: string): string => path.join(launcherDir(root), 'lang');
export const addonsDir = (root: string): string => path.join(launcherDir(root), 'addons');
export const launchMethodsDir = (root: string): string => path.join(launcherDir(root), 'launch-methods');
export const settingsFile = (root: string): string => path.join(launcherDir(root), 'launcher.settings');
export const accountsFile = (root: string): string => path.join(launcherDir(root), 'accounts.json');
export const versionListCacheFile = (root: string): string => path.join(launcherDir(root), 'version_list.json');
export const binDir = (root: string): string => path.join(root, 'bin');
export const nativesDir = (root: string): string => path.join(binDir(root), 'natives');
export const versionsDir = (root: string): string => path.join(root, 'versions');
export const jsonsDir = (root: string): string => path.join(versionsDir(root), 'jsons');
/** mod jar 暂存区（v1 readyVersion L796-800 同位：合成前原料，不进 versions/ 顶层）。 */
export const modsDir = (root: string): string => path.join(versionsDir(root), 'mods');
export const modJarFile = (root: string, id: string): string => path.join(modsDir(root), `${id}.jar`);
export const infoFile = (root: string, id: string): string => path.join(jsonsDir(root), `${id}.info`);
export const clientJarFile = (root: string, id: string): string => path.join(versionsDir(root), `${id}.jar`);
/** mod 安装登记（id → infoUrl/autoupdate；启动期刷新与误路由防护的持久真相——v1 靠进程内静态列表，离线即失效）。 */
export const modRegistryFile = (root: string): string => path.join(launcherDir(root), 'mods.json');
export const assetsDir = (root: string): string => path.join(root, 'assets');
export const assetIndexFile = (root: string, id: string): string =>
  path.join(assetsDir(root), 'indexes', `${id}.json`);
export const zuluJavaDir = (root: string): string => path.join(launcherDir(root), 'java');

/** 建目录骨架（addons 仅占位，v0 不消费机制）。幂等。 */
export function ensureLayout(root: string): void {
  for (const dir of [
    instancesDir(root),
    langDir(root),
    addonsDir(root),
    launchMethodsDir(root),
    nativesDir(root),
    jsonsDir(root),
    modsDir(root),
    assetsDir(root),
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * 根是否已有真实用户数据（首启向导门之三「有数据 = 老用户」的统一口径）。
 * 按文件标记判定：launcher.settings / accounts.json / mods.json / instances 任一文件 /
 * versions 顶层任一文件（游戏 jar）/ bin 顶层任一文件（库池 jar）——ensureLayout
 * 骨架是纯目录零文件，天然不误判（裸条目计数会被骨架恒真击穿）。
 * settings 须含**便携登记簿之外的键**才算数：`lastPortableRoot`/`portableFallback` 是 portable
 * 激活时写进默认根的机器生成面包屑（syncPortableRegistry），非用户数据——不得被它压掉向导。
 * 读失败 = false（未初始化方向；向导其余两门仍把误弹）。
 */
export function hasUserData(root: string): boolean {
  const settingsProps = readPropertiesFile(settingsFile(root));
  if (Object.keys(settingsProps).some((k) => k !== 'lastPortableRoot' && k !== 'portableFallback')) return true;
  for (const file of [accountsFile(root), modRegistryFile(root)]) {
    if (fs.existsSync(file)) return true;
  }
  for (const dir of [instancesDir(root), versionsDir(root), binDir(root)]) {
    try {
      if (fs.readdirSync(dir, { withFileTypes: true }).some((e) => e.isFile())) return true;
    } catch {
      /* 目录缺席 = 无数据 */
    }
  }
  return false;
}

// ---------- properties 文件 ----------

export function readPropertiesFile(file: string): Record<string, string> {
  try {
    return parseProperties(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

/** 读-改-写底稿专用（saveInstance/setSettings 同款纪律的读侧）：文件缺席（ENOENT）= {}
 * 走新建档案语义；其余读失败（AV 锁定 EBUSY/权限 EPERM）**抛**——不得静默回 {} 当底稿，
 * 否则托管键集整档覆盖会把 v1 遗留键静默丢掉（readPropertiesFile 的宽容只适用于纯读展示面）。 */
export function readPropertiesFileForMerge(file: string): Record<string, string> {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  return parseProperties(raw);
}

export function writePropertiesFile(file: string, entries: Record<string, string>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, serializeProperties(entries), 'utf8');
}

export const loadSettings = (root: string): Record<string, string> => readPropertiesFile(settingsFile(root));

/** settings 读-改-写底稿专用（合并写回前必须用这条，防整档覆盖丢未知键）。 */
export const loadSettingsForMerge = (root: string): Record<string, string> =>
  readPropertiesFileForMerge(settingsFile(root));

export const saveSettings = (root: string, settings: Record<string, string>): void =>
  writePropertiesFile(settingsFile(root), settings);

// ---------- 实例配置（键照抄 v1 Instance.java） ----------

export interface InstanceConfig {
  name: string;
  version: string;
  gameDir: string;
  launchArgs?: string;
  width?: number;
  height?: number;
  proxy?: boolean;
  keepopen?: boolean;
  RPC?: boolean;
  intelFix?: boolean;
  console?: boolean;
  javaPath?: string;
  isJavaPathNew?: boolean;
  addons?: string;
  /** Attic 扩展键（v1 无对应物）：多人直连地址 `ip[:port]` 原样存（启动询问弹窗数据源）。 */
  server?: string;
  /** Attic 扩展键（v1 无对应物——v1 是全局 static）：启动时旁路「已存在即复用」强制重下。 */
  forceUpdate?: boolean;
}

const INSTANCE_FILE = (root: string, name: string): string => path.join(instancesDir(root), `${name}.txt`);

/** 实例名 = 档案文件名（v1 `<name>.txt` 语义）：按最受限平台（Windows）钉死非法字符集，
 * 路径分隔符/相对段一并拒绝（防穿越）。写入与改名共用同一道闸。 */
export function assertInstanceName(name: string): void {
  if (
    name.trim() === '' ||
    name === '.' ||
    name === '..' ||
    // eslint-disable-next-line no-control-regex
    /[\x00-\x1f<>:"/\\|?*]/.test(name)
  ) {
    throw new Error(`实例名称不合法：${name}`);
  }
}

export function listInstances(root: string): string[] {
  try {
    return fs
      .readdirSync(instancesDir(root))
      .filter((f) => f.endsWith('.txt'))
      .map((f) => f.slice(0, -4))
      .sort();
  } catch {
    return [];
  }
}

function toBool(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  return value.toLowerCase() === 'true';
}

function toNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

export function loadInstance(root: string, name: string): InstanceConfig | null {
  const props = readPropertiesFile(INSTANCE_FILE(root, name));
  if (Object.keys(props).length === 0) return null;
  // v1 语义（Instance.loadInstance 以 newInstance 缺省为底、属性覆盖）：
  // 缺 launchArgs/width/height 的老档案也拿到 v1 缺省（854x480，而非 legacyfix 兜底的 640x480）。
  const config: InstanceConfig = {
    name: props['name'] ?? name,
    version: props['version'] ?? 'b1.7.3',
    gameDir: props['gameDir'] ?? path.join(root, props['name'] ?? name),
    launchArgs: props['launchArgs'] ?? '-Xmx1G',
    width: 854,
    height: 480,
  };
  const width = toNumber(props['width']);
  if (width !== undefined) config.width = width;
  const height = toNumber(props['height']);
  if (height !== undefined) config.height = height;
  for (const key of ['javaPath', 'addons', 'server'] as const) {
    if (props[key] !== undefined) config[key] = props[key];
  }
  for (const key of ['proxy', 'keepopen', 'RPC', 'intelFix', 'console', 'isJavaPathNew', 'forceUpdate'] as const) {
    const b = toBool(props[key]);
    if (b !== undefined) config[key] = b;
  }
  return config;
}

/** 删除实例薄档案（<name>.txt）；withFiles=true 时连实例目录（gameDir）一并递归删除。
 * 递归删除双护栏（触线 = 显式报错不静默）：目录即数据根本身、或与其他实例共享目录
 * （gameDir 可指向任意路径，误删代价不可逆）。返回是否删到。 */
export function deleteInstance(root: string, name: string, withFiles = false): boolean {
  const file = INSTANCE_FILE(root, name);
  if (!fs.existsSync(file)) return false;
  if (withFiles) {
    const dir = path.resolve(loadInstance(root, name)?.gameDir ?? path.join(root, name));
    if (dir === path.resolve(root)) {
      throw new Error(`拒绝删除：实例目录即数据根本身（${dir}）`);
    }
    for (const other of listInstances(root)) {
      if (other === name) continue;
      const otherDir = loadInstance(root, other)?.gameDir;
      if (otherDir && path.resolve(otherDir) === dir) {
        throw new Error(`拒绝删除：实例目录与「${other}」共享（${dir}）`);
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
  fs.rmSync(file, { force: true });
  return true;
}

/** 改实例名（v1 Instance.renameInstance 语义）：克隆档案只换 name，**gameDir 原样带走**——
 * 目录落位与名字解耦，改名不动存档、不迁文件。v1 的 <name>.png 图标迁移暂无对应物（未实现图标）。
 * 先写新档案再删旧（任一步失败最坏是双档案，绝不丢配置）；重名/非法名/不存在 = 显式报错。 */
export function renameInstance(root: string, name: string, newName: string): InstanceConfig {
  const config = loadInstance(root, name);
  if (!config) throw new Error(`实例不存在：${name}`);
  if (newName === name) return config;
  assertInstanceName(newName);
  if (fs.existsSync(INSTANCE_FILE(root, newName))) throw new Error(`实例名称已存在：${newName}`);
  const renamed: InstanceConfig = { ...config, name: newName };
  saveInstance(root, renamed);
  fs.rmSync(INSTANCE_FILE(root, name), { force: true });
  return renamed;
}

/** 单字段写回（properties 级读-改-写，保留其余全部键与键序）：版本选中即落盘走这条窄路——
 * `saveInstance` 按 `InstanceConfig` 整档案覆盖，而 `InstanceView` 不携带 v1 遗留键
 * （proxy/keepopen/RPC/console/isJavaPathNew…），用整档案回灌改版本会静默丢键。
 * 档案不存在（或空档案）= false 不动盘；库中已是同值 = false 不重写（连点同版零 IO）。 */
export function setInstanceVersionField(root: string, name: string, version: string): boolean {
  assertInstanceName(name);
  const file = INSTANCE_FILE(root, name);
  const props = readPropertiesFileForMerge(file);
  if (Object.keys(props).length === 0) return false;
  if (props['version'] === version) return false;
  props['version'] = version;
  writePropertiesFile(file, props);
  return true;
}

/** Addons 勾选有变动即写回（与 setInstanceVersionField 同构的 properties 级单字段读-改-写）：
 * 只动 `addons` 键，其余键与既有键序原样；数组 → v1 逗号分隔串，空数组 = 显式全关（空串键，
 * 区别于无键的 legacyfix 缺省开集）；同值不重写（返回 false）；档案不存在返回 false（不建档，
 * 建档归 set-version 链——addons 落盘前实例必已存在，新建走全档案 save）。非法名同闸。 */
export function setInstanceAddonsField(root: string, name: string, addons: string[]): boolean {
  assertInstanceName(name);
  const file = INSTANCE_FILE(root, name);
  const props = readPropertiesFileForMerge(file);
  if (Object.keys(props).length === 0) return false;
  const csv = addons.join(',');
  if (props['addons'] === csv) return false;
  props['addons'] = csv;
  writePropertiesFile(file, props);
  return true;
}

/** 整档案保存 = properties 级合并写回（setSettings 同款纪律，setInstanceVersionField 同构）：
 * 托管键集内 defined → 原位写入、undefined → 删键（视图字段"清空"语义）；托管集之外的键
 * （未来发现的 v1 遗留键、用户手加的未知键）原样保留、键序不动。
 * 视图不携带的键（proxy/keepopen/RPC/console/isJavaPathNew…）由 facade 层以既有档案
 * 为底稿带走（runtime.saveInstance），storage 层只认 config 形状——整档案盲写会静默丢键。 */
export function saveInstance(root: string, config: InstanceConfig): void {
  assertInstanceName(config.name);
  const file = INSTANCE_FILE(root, config.name);
  const props = readPropertiesFileForMerge(file);
  const managed: Record<string, string | undefined> = {
    name: config.name,
    version: config.version,
    gameDir: config.gameDir,
    launchArgs: config.launchArgs,
    javaPath: config.javaPath,
    addons: config.addons,
    server: config.server,
    width: config.width === undefined ? undefined : String(config.width),
    height: config.height === undefined ? undefined : String(config.height),
  };
  for (const key of ['proxy', 'keepopen', 'RPC', 'intelFix', 'console', 'isJavaPathNew', 'forceUpdate'] as const) {
    const v = config[key];
    managed[key] = v === undefined ? undefined : String(v);
  }
  for (const [key, value] of Object.entries(managed)) {
    if (value === undefined) delete props[key];
    else props[key] = value;
  }
  writePropertiesFile(file, props);
}

// ---------- 本地扫描 ----------

/** bin/ 库池：*.jar 排序后的绝对路径清单（v1 Wrapper.loadJars 的整目录 classpath 语义）。 */
export function scanBinPool(root: string): string[] {
  try {
    return fs
      .readdirSync(binDir(root))
      .filter((f) => f.endsWith('.jar'))
      .sort()
      .map((f) => path.join(binDir(root), f));
  } catch {
    return [];
  }
}

/** 已安装（有客户端 jar）版本：versions/*.jar。"已安装"徽标的唯一真相源——
 * 仅有 .info 元数据而无 jar 不算安装。 */
export function scanInstalledJars(root: string): string[] {
  const ids = new Set<string>();
  try {
    for (const f of fs.readdirSync(versionsDir(root))) {
      if (f.endsWith('.jar')) ids.add(f.slice(0, -4));
    }
  } catch {
    /* 目录缺失 = 无安装 */
  }
  return [...ids].sort();
}

/** 本地已有元数据的版本：versions/jsons/*.info（裸 jar = 有 jar 无 info = custom，v1 语义）。 */
export function scanInstalledInfos(root: string): string[] {
  const ids = new Set<string>();
  try {
    for (const f of fs.readdirSync(jsonsDir(root))) {
      if (f.endsWith('.info')) ids.add(f.slice(0, -5));
    }
  } catch {
    /* 目录缺失 = 无元数据 */
  }
  return [...ids].sort();
}

/** 本地已有元数据/jar 的版本：versions/*.jar 与 versions/jsons/*.info 并集去重
 * （离线兜底列表用；"已安装"标记请用 scanInstalledJars）。 */
export function scanInstalledVersions(root: string): string[] {
  const ids = new Set<string>();
  try {
    for (const f of fs.readdirSync(versionsDir(root))) {
      if (f.endsWith('.jar')) ids.add(f.slice(0, -4));
    }
  } catch {
    /* 目录缺失 = 无安装 */
  }
  try {
    for (const f of fs.readdirSync(jsonsDir(root))) {
      if (f.endsWith('.info')) ids.add(f.slice(0, -5));
    }
  } catch {
    /* 同上 */
  }
  return [...ids].sort();
}

// ---------- 账户 ----------

export function loadAccounts(root: string): Account[] {
  let raw: string;
  try {
    raw = fs.readFileSync(accountsFile(root), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  // parse 失败/形状不正 = 抛：静默回 [] 会让下一次 saveAccounts 把空清单固化（全账户丢失）。
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('accounts.json 顶层不是数组：请手工修复或删除该文件');
  return parsed as Account[];
}

export function saveAccounts(root: string, accounts: Account[]): void {
  fs.mkdirSync(launcherDir(root), { recursive: true });
  const file = accountsFile(root);
  // 原子写（tmp+rename）：直写中断（断电/强杀）会留下半截 JSON，配合 loadAccounts 的
  // parse-抛 语义即不会把坏文件误当空清单固化。
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(accounts, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

/** MC 离线 UUID 算法：md5("OfflinePlayer:" + name)，version 3 / variant 2。 */
export function offlineUuid(name: string): string {
  const digest = crypto.createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest();
  digest[6] = (digest[6]! & 0x0f) | 0x30;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = Buffer.from(digest).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
