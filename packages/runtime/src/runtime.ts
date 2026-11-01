/**
 * AtticRuntime：TS 侧启动器核心门面（Electron 主进程唯一消费者）。
 * 方法面 = RendererBridge 九请求（ipc.ts）；事件面 = IPC_EVENTS 三通道。
 * 错误以异常抛出，IpcResult 封装归壳层（apps/electron/main.ts）。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  IPC_EVENTS,
  LAUNCH_CANCELLED_MESSAGE,
  type Account,
  type AccountView,
  type CrashBrief,
  type CrashBundleResult,
  type RendererErrorReport,
  type CustomInfoView,
  type CustomVersionView,
  type OfflineAccount,
  type AppSettings,
  type SystemInfo,
  type AtticEventPayloads,
  type DownloadProgressEvent,
  type GameExit,
  type GameSession,
  type GameStatus,
  type InstanceView,
  type JavaDetectionReport,
  type LaunchCancelResult,
  type LaunchConfig,
  type LaunchRequest,
  type MicrosoftAccount,
  type ModCategoryView,
  type MsDeviceCode,
  type MsLoginErrorCode,
  type MsLoginEvent,
  type ModInstallRequest,
  type ServerListView,
  type UpdateCheckResult,
  type VersionJson,
  type VersionManifest,
  type VersionRef,
} from '@attic/core-spec';

import { applySettingsToProps, estimateMaxMemoryMb, instanceViewFromConfig, settingsFromProps } from './appSettings';
import { BetacraftClient, sweepPartFiles, type FetchImpl } from './betacraft';
import {
  buildCrashBundle,
  consumeCrashMarker,
  crashIssuesUrl,
  crashSummary,
  launcherLogLine,
  LAUNCHER_LOG_MAX_BYTES,
  writeCrashMarker,
  CRASH_LOG_TAIL_LINES,
  tailLines,
} from './crash';
import { endpointsFromOverrides, resolveEndpoints, type Endpoints } from './endpoints';
import { infoToVersionJson, LAUNCH_METHOD_MAIN_CLASS } from './info';
import { checkLwjgl2Arch, dependsOsFor, ensureDepends, type DependsIO } from './depends';
import { detectJavaRuntime } from './java/detect';
import { probeJavaExecutable } from './java/probe';
import { hasLegacyResourceProbes, materializeLegacyResources } from './legacyResources';
import { APPLET_LAUNCHER_CLASS, assembleLaunchConfig, type LaunchContext } from './launch';
import {
  composeModJars,
  downloadInfoAtomic,
  isModVersionJson,
  readModRegistry,
  refreshModInfo,
  removeModRegistry,
  upsertModRegistry,
  type ModRegistryEntry,
} from './mods';
import { parseServerList } from './servers';
import {
  DEFAULT_MS_CLIENT_ID,
  MsAbortError,
  MsAuthError,
  decodeTokenSecret,
  encodeTokenSecret,
  joinServer,
  pollDeviceToken,
  refreshMsToken,
  requestDeviceCode,
  runAuthTail,
  type DpapiDeps,
  type LookupFn,
  type MsAuthDeps,
  type MsChainResult,
  type MsDeviceCodeIssue,
  type SleepFn,
} from './microsoftAuth';
import { GameProcessManager } from './process';
import { parseProperties } from './properties';
import {
  detectPortable,
  syncPortableRegistry,
  writePortableAnchor,
  writePortablePointer,
  type PortableResolution,
} from './portable';
import { DEFAULT_AGENT_MOUNTS } from './quirks';
import {
  assetIndexFile,
  assetsDir,
  binDir,
  clientJarFile,
  deleteInstance,
  ensureLayout,
  infoFile,
  jsonsDir,
  hasUserData,
  isPathWithin,
  listInstances,
  loadAccounts,
  loadInstance,
  loadSettings,
  launcherDir,
  nativesDir,
  offlineUuid,
  readPropertiesFile,
  renameInstance,
  resolveDataRoot,
  saveAccounts,
  saveInstance,
  saveSettings,
  scanBinPool,
  versionsDir,
  scanInstalledInfos,
  scanInstalledJars,
  scanInstalledVersions,
  setInstanceVersionField,
  type InstanceConfig,
  versionListCacheFile,
  writePropertiesFile,
  zuluJavaDir,
} from './storage';
import { checkLatestRelease, DEFAULT_RELEASE_REPO } from './updateCheck';
import { canonicalLaunchMethod, detectLaunchMethod, probeIndevEntry, probePreclassicEntry } from './wrapperDetector';
import { extractZipTo, listZipEntryNames } from './zip';
import { findJavaExecutable, installZuluPackage, provisionArch, queryZuluPackages } from './zulu';

/** 背景图扩展白名单 → MIME（IMAGE_DATA_URL 宿主把关面）。 */
const IMAGE_MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
};
/** 背景图大小上限（base64 进 webview 的内存代价封顶 ~12MB 原图）。 */
const IMAGE_MAX_BYTES = 12 * 1024 * 1024;

export interface AtticRuntimeOptions {
  /** rootDir 覆盖（共存/迁移逃生舱）。 */
  rootDir?: string;
  portable?: boolean;
  endpoints?: Partial<Endpoints>;
  fetchImpl?: FetchImpl;
  env?: NodeJS.ProcessEnv;
  execPath?: string;
  platform?: NodeJS.Platform;
  /** 启动器版本（宿主注入：electron = app.getVersion()；SYS_INFO 展示用）。 */
  version?: string;
  /**
   * 宿主安装目录（宿主注入 dirname(process.execPath)；Tauri 产线 = 与 exe 同目录的 node.exe，
   * 天然成立）。setSettings 护栏消费：rootOverride 落在安装目录之内 = 卸载器 {app} 整删射程 → 拒绝。
   */
  installDir?: string;
  /**
   * portable 形态：程序目录（exe 所在目录）。宿主显式传——sidecar 的 process.execPath = node.exe
   * 不可信（硬纪律），exeDir 判定面不得依赖它。在场 = runtime 做双指纹便携判定。
   */
  exeDir?: string;
  /** portable marker ini 候选（相对 exeDir；tauri=['sidecar/portable.ini']、electron/legacy=['resources/portable.ini']）。 */
  portableMarkers?: string[];
  /** 检查更新发布仓库 "owner/repo"（缺省回落 env ATTIC_RELEASE_REPO > 默认同仓；显式空串 = unconfigured 关通道）。 */
  releaseRepo?: string;
  /** 壳形态（SYS_INFO shell 字段数据源；宿主构造注入，缺省 'electron' 保守）。 */
  shell?: 'tauri' | 'electron';
  /**
   * 微软登录测试缝：覆盖轮询退避计时器 / join 的 IPv4 解析 / DPAPI 执行体（platform、spawn）。
   * 缺省 = 真 setTimeout + dns.lookup(family 4) + 真 powershell.exe DPAPI（Windows 生产面）。
   */
  msDeps?: {
    sleep?: SleepFn;
    lookup?: LookupFn;
    dpapi?: DpapiDeps;
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 诊断日志脱敏（v1 Launcher.java L659/L685 `[censored sessionid]` 同款）：
 * 命令行与游戏输出行里的 accessToken 一律替换后再落盘。
 * 短值（离线 '0'、空）不替换——避免把 '0' 这类通用子串在整行里乱伤。
 */
export function maskSecrets(text: string, accessToken: string | undefined): string {
  if (!accessToken || accessToken.length < 16) return text;
  return text.split(accessToken).join('[censored sessionid]');
}

/** v1 首启语义（Launcher.java L369）：缺省实例名 "default instance"。 */
export const DEFAULT_INSTANCE_NAME = 'default instance';

function readTextIfPresent(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function readJsonIfPresent<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

function toAccountView(account: Account): AccountView {
  if (account.type === 'microsoft') {
    const expires = account.tokenExpiresAt;
    return {
      id: account.id,
      name: account.name,
      type: account.type,
      tokenValid: expires === undefined || expires > Date.now(),
      ...(account.skinUrl ? { skinUrl: account.skinUrl } : {}),
    };
  }
  return { id: account.id, name: account.name, type: 'offline' };
}

/** 版本 id → 文件名安全（CUSTOM_* 通道入参面：拒绝路径分隔/穿越/Windows 非法字符/控制符）。 */
function assertSafeVersionId(id: string): void {
  if (
    id === '' ||
    id === '.' ||
    id === '..' ||
    /[\\/:*?"<>|\x00-\x1f]/.test(id) ||
    id.length > 128
  ) {
    throw new Error(`非法版本 id：${JSON.stringify(id)}`);
  }
}

export class AtticRuntime {
  readonly root: string;
  /** 平台默认根（不受 rootOverride/portable 影响——rootOverride 指针位与向导三重门判定基线）。 */
  readonly defaultRoot: string;
  /** 宿主安装目录（护栏参照；缺省 = 无护栏，测试/程序化场景）。 */
  readonly installDir: string | undefined;
  /** portable 双指纹判定结果（exeDir 缺席或非便携 = null）。pointerRoot 随 setSettings 指针写回同步。 */
  readonly portable: PortableResolution | null;
  /**
   * 便携生效根「已有真实数据」构造期快照（SYS_INFO portable.rootPopulated 数据源）：
   * ensureLayout 之前取（读的是启动前状态）；hasUserData 文件标记口径 = 中断残留骨架不误判。
   * 只读回落态 root = defaultRoot，快照自然回落「默认根老用户」老语义，无需特判。
   */
  private readonly portableRootPopulated: boolean;
  readonly endpoints: Endpoints;
  /** 启动器版本（宿主注入，SYS_INFO/关于页消费）。 */
  readonly version: string;
  /**
   * 上次异常退出简报（构造期消费脏退出标记 = 读后即删，横幅只弹一次；
   * SYS_INFO.lastCrash 投给 UI。崩溃当场由宿主 markCrashExit 写标记）。
   */
  readonly lastCrash: CrashBrief | null;
  /** 检查更新发布仓库 "owner/repo"（构造选项 > env > 默认同仓；显式空串 = unconfigured）。 */
  private readonly releaseRepo: string | undefined;
  /** 壳形态（SYS_INFO 透传；构造缺省 'electron' 保守）。 */
  private readonly shell: 'tauri' | 'electron';
  private readonly platform: NodeJS.Platform;
  private readonly fetchImpl: FetchImpl;
  private readonly client: BetacraftClient;
  private readonly processes: GameProcessManager;
  private readonly listeners = new Map<string, Set<(payload: never) => void>>();
  private lastLaunchError: string | null = null;
  /** 在途启动的取消控制器：launch() 建、finally 清；cancelLaunch() 消费。 */
  private launchAbort: AbortController | null = null;
  /** 在途微软设备码流（single-flight）：msStartLogin 建、链终局清；msCancelLogin 消费 abort。 */
  private msLoginFlow: { controller: AbortController } | null = null;
  /** 微软登录测试缝（见 AtticRuntimeOptions.msDeps）。 */
  private readonly msDeps: NonNullable<AtticRuntimeOptions['msDeps']>;
  private infoWatcher: fs.FSWatcher | null = null;
  /** .info 监视去抖：id → 挂起定时器（编辑器保存常触发多事件）。 */
  private readonly infoWatchTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(options: AtticRuntimeOptions = {}) {
    // 平台默认根（rootOverride 指针落位/向导三重门判定基线/只读回落目标）：同参数但不带 override/portable。
    this.defaultRoot = resolveDataRoot({ platform: options.platform, env: options.env, execPath: options.execPath });
    // portable 双指纹判定（exeDir 缺席 = 非便携：测试/程序化场景天然不命中）。
    // exeDir 必须宿主显式传（sidecar 的 process.execPath = node.exe 不可信），判定逻辑单点在 runtime。
    this.portable = options.exeDir
      ? detectPortable({
          exeDir: options.exeDir,
          markerCandidates: options.portableMarkers,
          env: options.env,
          platform: options.platform,
          version: options.version,
          defaultRoot: this.defaultRoot,
        })
      : null;
    this.root = resolveDataRoot({
      platform: options.platform,
      env: options.env,
      execPath: options.execPath,
      portable: options.portable,
      // 优先级 rootDirOverride > portable > 默认（storage.ts 口径不动）：便携命中时随身根经 override 位注入，
      // 显式 rootDir（宿主 peek / 共存逃生舱）仍压过便携。
      rootDirOverride: options.rootDir ?? (this.portable?.active ? this.portable.root : undefined),
    });
    this.installDir = options.installDir;
    // flavor 感知数据源：便携态在 ensureLayout 落骨架前快照生效根数据态。
    this.portableRootPopulated = this.portable?.active ? hasUserData(this.root) : false;
    ensureLayout(this.root);
    this.lastCrash = consumeCrashMarker(this.root);
    this.version = options.version ?? '0.0.0';
    // 检查更新仓库：构造参数 > env ATTIC_RELEASE_REPO > 默认同仓。
    // 显式空串 = 强制关通道（unconfigured 数据分支，不炸）；env/选项非空 = 测试仓彩排逃生舱。
    this.releaseRepo = options.releaseRepo ?? (options.env ?? process.env)['ATTIC_RELEASE_REPO'] ?? DEFAULT_RELEASE_REPO;
    this.shell = options.shell ?? 'electron';
    this.platform = options.platform ?? process.platform;
    this.msDeps = options.msDeps ?? {};
    // 便携态构造期副作用（幂等、值变才写）：面包屑登记 / 只读回落标记（默认根登记簿）。
    if (this.portable?.active) syncPortableRegistry(this.defaultRoot, this.portable);
    // 端点优先级：构造参数（测试/程序化）> launcher.settings 的 endpoint.* 覆盖 > 默认。
    this.endpoints = options.endpoints
      ? resolveEndpoints(options.endpoints)
      : endpointsFromOverrides(settingsFromProps(loadSettings(this.root)).endpoints);
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
    this.client = new BetacraftClient({
      endpoints: this.endpoints,
      fetchImpl: this.fetchImpl,
      onProgress: (event: DownloadProgressEvent) => this.emitEvent(IPC_EVENTS.DOWNLOAD_PROGRESS, event),
    });
    this.processes = new GameProcessManager({
      onOutput: (event) => this.emitEvent(IPC_EVENTS.GAME_OUTPUT, event),
      onExit: (event) => this.emitEvent(IPC_EVENTS.GAME_EXIT, event),
    });
  }

  // ---------- 事件面 ----------

  on<E extends keyof AtticEventPayloads>(event: E, cb: (payload: AtticEventPayloads[E]) => void): () => void {
    const set = this.listeners.get(event) ?? new Set();
    set.add(cb as (payload: never) => void);
    this.listeners.set(event, set);
    // jsons 监视器懒启停：无订阅者不开句柄（Windows 下未 close 的 fs.watch 会钉住
    // node --test 子进程退出，unref 不解除）；宿主 wireEvents 常驻订阅 → 等价全程监视。
    if (event === IPC_EVENTS.CUSTOM_INFO_CHANGED) this.startInfoWatcher();
    return () => {
      set.delete(cb as (payload: never) => void);
      if (event === IPC_EVENTS.CUSTOM_INFO_CHANGED && set.size === 0) this.stopInfoWatcher();
    };
  }

  private emitEvent(event: string, payload: unknown): void {
    for (const cb of this.listeners.get(event) ?? []) {
      (cb as (p: unknown) => void)(payload);
    }
  }

  /**
   * jsons 目录监视（外部编辑 .info 实时更新）：只认 `*.info`，编辑器保存常伴随
   * 多事件/temp+rename，按 id 去抖 250ms 合并后发 CUSTOM_INFO_CHANGED。
   * 启动器自身保存的回声由 UI 侧 selfWrite 窗口吸收（配置页保存后已自刷新，不依赖本事件）。
   * 由 on(CUSTOM_INFO_CHANGED) 首个订阅者懒启动（见上）；unref + 订阅清零时 close
   * （Windows 未 close 的 fs.watch 句柄会钉住 node --test 子进程退出）。
   */
  private startInfoWatcher(): void {
    if (this.infoWatcher) return;
    try {
      this.infoWatcher = fs.watch(jsonsDir(this.root), (_event, filename) => {
        if (!filename || !filename.endsWith('.info')) return;
        const id = filename.slice(0, -'.info'.length);
        const pending = this.infoWatchTimers.get(id);
        if (pending) clearTimeout(pending);
        this.infoWatchTimers.set(
          id,
          setTimeout(() => {
            this.infoWatchTimers.delete(id);
            this.emitEvent(IPC_EVENTS.CUSTOM_INFO_CHANGED, { id });
          }, 250),
        );
      });
      this.infoWatcher.unref();
    } catch {
      this.infoWatcher = null;
    }
  }

  /** 末订阅者退订：关句柄 + 清去抖定时器（不得留悬垂事件源）。 */
  private stopInfoWatcher(): void {
    try {
      this.infoWatcher?.close();
    } catch {
      /* 已失效句柄：忽略 */
    }
    this.infoWatcher = null;
    for (const timer of this.infoWatchTimers.values()) clearTimeout(timer);
    this.infoWatchTimers.clear();
  }

  // ---------- 请求面（RendererBridge 九通道） ----------

  ping(): string {
    return 'pong';
  }

  /**
   * 清单刷新的在途合并（listVersions 后台刷新面与 installMod 门禁同步面共用）。
   * 网络取回 + 落缓存文件；失败原样抛出（调用方面对）。
   */
  private versionListRefresh: Promise<VersionRef[]> | null = null;

  private refreshVersionListCache(): Promise<VersionRef[]> {
    if (this.versionListRefresh) return this.versionListRefresh;
    this.versionListRefresh = (async () => {
      const refs = await this.client.fetchVersionList();
      const cache: VersionManifest = { generatedAt: Date.now(), versions: refs };
      fs.mkdirSync(launcherDir(this.root), { recursive: true });
      fs.writeFileSync(versionListCacheFile(this.root), JSON.stringify(cache), 'utf8');
      return refs;
    })().finally(() => {
      this.versionListRefresh = null;
    });
    return this.versionListRefresh;
  }

  /**
   * 缓存优先（stale-while-revalidate）：缓存即在 → 即返缓存 + fire-and-forget 后台刷新
   * （最终一致：下一次拉取即新数据；UI 每次展开都重拉，钉开态滞留一帧可接受）。
   * 缓存缺席 → 等网络（首次运行的诚实等待），失败 → refs=null。
   * installed/custom 判定面每次现扫磁盘 + 读缓存文件，不受本方法返回新鲜度影响。
   * 注意：需要「刷新完成」语义的调用方（installMod 官方同名门禁）必须直接
   * await refreshVersionListCache()——本方法缓存即在时不等网络。
   */
  async listVersions(): Promise<VersionRef[]> {
    let refs: VersionRef[] | null = null;
    const cached = readJsonIfPresent<VersionManifest>(versionListCacheFile(this.root));
    if (cached?.versions?.length) {
      refs = cached.versions;
      void this.refreshVersionListCache().catch(() => {
        /* 后台刷新失败：保留现缓存（=旧「网络失败退缓存」同语义） */
      });
    } else {
      try {
        refs = await this.refreshVersionListCache();
      } catch {
        /* 无缓存且网络失败：refs 保持 null，走本地扫描兜底 */
      }
    }

    // "已安装"= jar 实存；jar∪info 并集仅用于离线兜底列出本地版本
    const jars = new Set(scanInstalledJars(this.root));
    const infos = new Set(scanInstalledInfos(this.root));
    // 官方清单 id 集（网络/缓存 refs 同源）：**官方命中 > 本地声明**——
    // BC 版本地 .info 缺失或残留 custom=true 都不得判 custom（前者"未落元数据"，后者为陈旧误写）。
    const official = new Set((refs ?? []).map((ref) => ref.id));
    const isCustom = (id: string): boolean =>
      // v1 语义（offlineVersionList）：裸 jar（有 jar 无 .info）或 .info 显式声明，且不在官方清单
      !official.has(id) &&
      ((jars.has(id) && !infos.has(id)) ||
        (infos.has(id) && readPropertiesFile(infoFile(this.root, id))['custom']?.toLowerCase() === 'true'));
    const local = scanInstalledVersions(this.root);
    const out: VersionRef[] = (refs ?? []).map((ref) => ({
      ...ref,
      installed: jars.has(ref.id),
      ...(isCustom(ref.id) ? { custom: true } : {}),
    }));
    for (const id of local) {
      if (!out.some((ref) => ref.id === id)) {
        out.push({ id, repository: 'local', installed: jars.has(id), ...(isCustom(id) ? { custom: true } : {}) });
      }
    }
    if (out.length === 0) throw new Error('版本清单获取失败且无本地缓存/安装');
    return out;
  }

  /** 本地 .info 优先（离线可用），缺失才下载并落盘；下载失败退裸 jar custom 路径。 */
  async getVersionJson(versionId: string): Promise<VersionJson> {
    const local = readTextIfPresent(infoFile(this.root, versionId));
    if (local !== null) return this.withAgentMounts(infoToVersionJson(versionId, parseProperties(local)));
    try {
      const text = await this.client.fetchVersionInfo(versionId);
      this.client.saveVersionInfo(this.root, versionId, text);
      return this.withAgentMounts(infoToVersionJson(versionId, parseProperties(text)));
    } catch (error) {
      const custom = this.tryCustomVersionJson(versionId);
      if (custom) return custom;
      throw error;
    }
  }

  /**
   * 本地 client jar class 条目探测（VERSION_PROBE_CLASS）：启动页「≡」菜单项启用判定
   * （visualizer → `net/minecraft/isom/IsomPreviewApplet.class`，infdev-20100617 同 jar 并存类）。
   * jar 未下载/损坏/条目缺失 = false（菜单项禁用，不报错——可见降级）。
   * 条目清单按 jar 路径+mtime 缓存，避免每次开菜单都重读 zip 中央目录。
   */
  private readonly classProbeCache = new Map<string, { mtimeMs: number; entries: string[] }>();

  probeVersionClass(versionId: string, className: string): boolean {
    const jar = clientJarFile(this.root, versionId);
    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(jar).mtimeMs;
    } catch {
      return false;
    }
    let cached = this.classProbeCache.get(jar);
    if (!cached || cached.mtimeMs !== mtimeMs) {
      try {
        cached = { mtimeMs, entries: listZipEntryNames(jar) };
      } catch {
        cached = { mtimeMs, entries: [] };
      }
      this.classProbeCache.set(jar, cached);
    }
    return cached.entries.includes(className);
  }

  /**
   * 每次启动重下 .info（防元数据陈旧）；网络失败退本地。
   * v1 豁免（Launcher.java L412/L432）：custom=true 的 .info 归用户所有，跳过重下/覆盖。
   * Mods 安装器登记的 mod 走独立通道：按 launcher/mods.json 登记的直链刷新（autoupdate/缺失才拉），
   * 绝不回落官方默认 versionJson(id) URL（v1 Launcher.java L410-414 离线误路由官方 URL 的坑）。
   */
  private async refreshVersionInfo(versionId: string): Promise<VersionJson> {
    // HMCL 阶段行可见性：version-json 每次启动必刷（本地命中也走），合成 queued/done 对括住刷新
    this.client.emitProgress({ item: 'version-json', id: versionId, phase: 'queued', bytesDone: 0 });
    const json = await this.refreshVersionInfoInner(versionId);
    this.client.emitProgress({ item: 'version-json', id: versionId, phase: 'done', bytesDone: 0 });
    return json;
  }

  private async refreshVersionInfoInner(versionId: string): Promise<VersionJson> {
    const modEntry = readModRegistry(this.root)[versionId];
    if (modEntry) return this.refreshRegisteredModInfo(versionId, modEntry);
    const localText = readTextIfPresent(infoFile(this.root, versionId));
    if (localText !== null) {
      const props = parseProperties(localText);
      if (props['custom']?.toLowerCase() === 'true') return this.withAgentMounts(infoToVersionJson(versionId, props));
    }
    try {
      const text = await this.client.fetchVersionInfo(versionId);
      this.client.saveVersionInfo(this.root, versionId, text);
      return this.withAgentMounts(infoToVersionJson(versionId, parseProperties(text)));
    } catch (error) {
      if (localText !== null) return this.withAgentMounts(infoToVersionJson(versionId, parseProperties(localText)));
      const custom = this.tryCustomVersionJson(versionId);
      if (custom) return custom;
      throw error;
    }
  }

  /**
   * 已登记 mod 的 .info 刷新（v1 Launcher.java L417-426 语义）：
   * - autoupdate=false 且本地在位 → 直接用本地，不联网；
   * - 刷新失败但本地在位 → 留旧文件离线启动（原子写保证旧文件未被破坏）；
   * - 刷新失败且本地缺失 → 显式报错（v1「静默假可用」的坑：绝不带残缺进 spawn）。
   */
  private async refreshRegisteredModInfo(versionId: string, entry: ModRegistryEntry): Promise<VersionJson> {
    const localText = readTextIfPresent(infoFile(this.root, versionId));
    try {
      await refreshModInfo(this.client, this.root, versionId, entry);
    } catch (error) {
      if (localText !== null) return this.withAgentMounts(infoToVersionJson(versionId, parseProperties(localText)));
      throw new Error(`Mod ${versionId} 的 .info 本地缺失，且从登记地址刷新失败：${messageOf(error)}`);
    }
    const text = readTextIfPresent(infoFile(this.root, versionId)) ?? localText;
    if (text === null) throw new Error(`Mod ${versionId} 的 .info 未正确落位`);
    return this.withAgentMounts(infoToVersionJson(versionId, parseProperties(text)));
  }

  /**
   * 裸 jar custom 路径（v1：bare jar 即 custom，downloadJson 豁免）：类检测合成元数据。
   * 检测失败 = Error 7 语义：显式报错并指引手编 .info（数据缺口可见，不静默兜底）。
   */
  private tryCustomVersionJson(versionId: string): VersionJson | null {
    if (fs.existsSync(infoFile(this.root, versionId))) return null;
    const jar = clientJarFile(this.root, versionId);
    if (!fs.existsSync(jar)) return null;
    // 检测名归一为主类表合法值（rd/mc→preclassic 等，见 canonicalLaunchMethod），
    // 否则合成 JSON 撞表外键 → "无法确定主类"（v1 两套餐名不同源的固有断层）。
    const method = canonicalLaunchMethod(detectLaunchMethod(jar));
    if (method === 'custom') {
      throw new Error(
        `无法识别启动方式（v1 Error 7）：请编辑 ${infoFile(this.root, versionId)} 配置 launch-method`,
      );
    }
    return this.withAgentMounts(infoToVersionJson(versionId, { 'launch-method': method, custom: 'true' }));
  }

  /**
   * indev 混代归位（早期 indev jar 无 Minecraft.main → "找不到主类"）：
   * launch-method=indev 覆盖 2.0-preview→1.5.2，按本地 jar 探测——仅 MinecraftApplet 形态
   * 改走 legacyfix AppletLauncher 容器（候选表首项即 net.minecraft.client.MinecraftApplet，
   * jar 已在 classpath，无需 --appletClass）；beta+ 维持 Minecraft 主类直启。
   */
  private resolveIndevMainClass(json: VersionJson): VersionJson {
    if (json.betacraft?.launchMethod !== 'indev') return json;
    if (probeIndevEntry(clientJarFile(this.root, json.id)) === 'applet') {
      return { ...json, mainClass: APPLET_LAUNCHER_CLASS };
    }
    return json;
  }

  /**
   * pre-Classic（launch-method=preclassic，rd 代 jar）的 --appletClass 显式注入：
   * rd 系 jar 仅含 RubyDung 入口，26.8 AppletLauncher 候选表两个 MinecraftApplet 名
   * 皆不存在 → main 返回、进程 code=0 静默秒退。探测失败 = 不注入（维持可见失败，
   * probeIndevEntry 同纪律）。
   * 已知不修（视为 Pre-Classic 特色）：rd 窗口内容 LWJGL Display 右下偏移。
   */
  private resolvePreclassicAppletClass(json: VersionJson): string | undefined {
    if (json.betacraft?.launchMethod !== 'preclassic') return undefined;
    return probePreclassicEntry(clientJarFile(this.root, json.id)) ?? undefined;
  }

  /**
   * c0.24 家族死链声音预置（判定 → 计划 → 落位；任何一步失败 = 维持现状，绝不阻断启动）。
   * 必须在 `downloadAssetObjects` 之后调用——本地对象缺席即跳过该键（补下是既有资产流程的职责，
   * 机制与闸门见 legacyResources.ts 头注）。
   */
  private applyLegacyResources(json: VersionJson, gameDir: string, assetIndexId: string | null): void {
    if (!assetIndexId) return;
    if (!hasLegacyResourceProbes(clientJarFile(this.root, json.id))) return;
    let indexJson: unknown;
    try {
      indexJson = JSON.parse(fs.readFileSync(assetIndexFile(this.root, assetIndexId), 'utf8')) as unknown;
    } catch {
      return; // 索引缺席 → 无从预置，游戏行为不变
    }
    materializeLegacyResources({
      indexJson,
      assetsRoot: assetsDir(this.root),
      gameDir,
      onDiagnostic: (message) => console.log(message),
    });
  }

  /** 真实 betacraft .info 不含 agentMount——并入 Attic 自带决策表（数据，非代码）。 */
  private withAgentMounts(json: VersionJson): VersionJson {
    if (json.betacraft?.agentMount) return json;
    return { ...json, betacraft: { ...json.betacraft, agentMount: DEFAULT_AGENT_MOUNTS } };
  }

  async dryRunLaunch(request: LaunchRequest): Promise<LaunchConfig> {
    const json = this.resolveIndevMainClass(await this.getVersionJson(request.versionId));
    const context = await this.buildContext(request);
    context.appletClass = this.resolvePreclassicAppletClass(json);
    return assembleLaunchConfig(json, context, {
      extraJvmArgs: request.extraJvmArgs,
      gameParams: request.gameParams,
    });
  }

  /**
   * 启动：全程挂一个 AbortController，cancelLaunch() 中止下载/补全链；
   * 各阶段边界 + spawn 前最后一道 throwIfAborted 防竞态。取消中止以 LAUNCH_CANCELLED_MESSAGE
   * 失败且不记 lastLaunchError（中性态，UI 不报崩）。进链先清扫上次进程被杀留下的 `.part`。
   */
  async launch(request: LaunchRequest): Promise<GameSession> {
    const controller = new AbortController();
    try {
      if (this.processes.running) throw new Error('游戏进程已在运行');
      this.launchAbort = controller;
      const signal = controller.signal;
      this.sweepStaleParts();
      // v1 语义（InstanceSettings.java L556）：选中版本写回实例属性——同实例切版本 gameDir 不变、存档共享。
      // 建档+回写必须落在 launch 的**首个 await 之前的同步段**：UI 在发起 launch IPC 后立即重拉
      // 实例清单，Electron IPC 消息 FIFO 保证本同步段先于清单 IPC 执行，新实例点击即得见。
      this.persistInstanceVersion(request);
      // 设置页开关的消费点（properties 三态：缺键=缺省开/关按各键注释）
      const settings = loadSettings(this.root);
      // 实例「强制更新」（v1 Launcher.forceUpdate 语义，Attic 实例化）：旁路 jar/库/资产的
      // 「已存在即复用」检查重下。.info 的 custom 豁免不动（v1 同义：用户所有的配置不被覆盖）。
      const forceUpdate = this.resolveInstance(request.instanceId ?? DEFAULT_INSTANCE_NAME).forceUpdate === true;
      let json = await this.refreshVersionInfo(request.versionId);
      // mod 判型（`.info` base-version 键，v1 readyVersion 语义）：libraries/jar/资产口径全部
      // 跟随基座——mod `.info` 只有 url/sha1/base-version，没有可独立启动的元数据。
      const baseId = isModVersionJson(json);
      const metaJson = baseId ? await this.refreshVersionInfo(baseId) : json;
      if (baseId && isModVersionJson(metaJson)) {
        throw new Error(`Mod ${json.id} 的基座 ${baseId} 本身也是 mod（v1 getReleaseByName 递归语义），一期不支持嵌套 mod`);
      }
      // BC `.info` 无 libraries → 从 Mojang 重发布 JSON 回填库池（classic 等不在清单：BC jar 自捆绑依赖，静默跳过）。
      if (!metaJson.libraries || metaJson.libraries.length === 0) {
        try {
          metaJson.libraries = await this.client.fetchMojangLibraries(metaJson.id, this.platform);
        } catch {
          /* 无重发布数据 */
        }
      }
      // 裸 jar custom 合成元数据无下载地址：jar 本体已在位，跳过下载（v1 downloadJson 豁免）。
      // mod 通道的 versions/<id>.jar 是合成产物，不走本下载（基座 jar 由 metaJson 走齐）。
      signal.throwIfAborted();
      if (metaJson.jar?.url || metaJson.downloads?.client?.url) {
        await this.client.downloadClientJar(metaJson, this.root, {
          verify: settings['checkIntegrity'] !== 'false',
          repair: settings['fixMissing'] !== 'false',
          force: forceUpdate,
          signal,
        });
      }
      if (baseId) {
        // v1 readyVersion + assembleWithBaseVersion 语义：每次启动重合成（修 hasJar 存在性判定的陈旧合成 jar 失配）：
        // mod jar 补全（sha1 强制）→ 基座在前、mod 同名
        // 覆盖、剥签名 → 原子落 versions/<id>.jar（launch.ts classpath[0] 天然命中，组装面不动）。
        const modJar = await this.client.ensureModJar(json, this.root, {
          verify: settings['checkIntegrity'] !== 'false',
          force: forceUpdate,
          signal,
        });
        composeModJars(clientJarFile(this.root, baseId), modJar, clientJarFile(this.root, json.id));
        // 字段继承：mod 自带键胜出，缺失回落基座（mainClass/assets/betacraft.launchMethod 等；
        // betacraft 段显式合并——spread 整段覆盖会把基座 launchMethod 弄丢，agentMount 区间判定
        // 与 Applet 容器路径都靠它）。
        json = {
          ...metaJson,
          ...json,
          betacraft: { ...metaJson.betacraft, ...json.betacraft },
        };
      }
      json = this.resolveIndevMainClass(json);
      // BC 基础库集先行（清池重解在 libraries 增量下载之前，避免误删刚下的库；v1 移植见 depends.ts）。
      // library 阶段合成对括住 depends 池 + 增量库全段（缓存命中全本地时本段近零事件，行也可见）。
      signal.throwIfAborted();
      this.client.emitProgress({ item: 'library', id: metaJson.id, phase: 'queued', bytesDone: 0 });
      await this.updateDepends(settings, forceUpdate, signal);
      signal.throwIfAborted();
      await this.client.downloadLibrariesToBin(json, this.root, { force: forceUpdate, signal });
      this.client.emitProgress({ item: 'library', id: metaJson.id, phase: 'done', bytesDone: 0 });
      this.extractNatives();
      // 资产补全（v2 语义）：索引 + objects 全体由启动器预置——legacyfix 只自动补 custom 段，
      // objects 缺失即游戏内 CodecJOrbis/OpenAL 声音 NPE。
      signal.throwIfAborted();
      const assetIndexId = await this.client.downloadAssetIndex(json, this.root, { force: forceUpdate, signal });
      if (assetIndexId) await this.client.downloadAssetObjects(this.root, assetIndexId, { force: forceUpdate, signal });

      signal.throwIfAborted();
      // java-runtime 阶段合成对括住 buildContext（Java 解析/探测在其中以 execFile 异步跑，
      // 全本地无下载时本行也可见；真下载 runtime 时 download() 同 item 不同 id 并存）。
      this.client.emitProgress({ item: 'java-runtime', id: request.versionId, phase: 'queued', bytesDone: 0 });
      const launchAccount = await this.resolveLaunchAccount(request);
      const context = await this.buildContext(request, signal, launchAccount);
      this.client.emitProgress({ item: 'java-runtime', id: request.versionId, phase: 'done', bytesDone: 0 });
      context.appletClass = this.resolvePreclassicAppletClass(json);
      // 死链声音预置（gameDir 侧写数据，不动 JVM 参数；dryRun 不预置——纯检视不留副作用）。
      this.applyLegacyResources(json, context.gameDir, assetIndexId);
      const config = assembleLaunchConfig(json, context, {
        extraJvmArgs: request.extraJvmArgs,
        gameParams: request.gameParams,
      });

      // agentMount 落位：javaagent/Applet 容器需要 jar 本体在位；coremod/mod 复制进游戏目录。
      signal.throwIfAborted();
      for (const mount of config.agentMount) {
        const source = await this.client.ensureLegacyfix(this.root, mount.path, signal);
        if (mount.form === 'javaagent') continue;
        const targetDir = path.join(context.gameDir, mount.form === 'coremod' ? 'coremods' : 'mods');
        fs.mkdirSync(targetDir, { recursive: true });
        fs.copyFileSync(source, path.join(targetDir, path.basename(mount.path)));
      }

      // 微软验证预注册：server 直连 ∧ 微软账户 → spawn 前 joinServer
      // （token 过期先自动刷新链重放）。join 失败 = 不拦截启动，spawn 后向游戏输出面推一行可见警告；
      // 离线账户路径零改动（零版本判断纪律）。
      let joinWarning: string | null = null;
      if (context.server && launchAccount.type === 'microsoft') {
        try {
          let mc = launchAccount;
          if (mc.tokenExpiresAt !== undefined && mc.tokenExpiresAt <= Date.now() && mc.refreshToken) {
            await this.msRefreshAccount(mc.id);
            const reloaded = await this.resolveLaunchAccount(request);
            if (reloaded.type === 'microsoft') mc = reloaded;
          }
          await joinServer(this.msAuthDeps(signal), {
            sessionid: mc.accessToken,
            profileId: mc.profileId ?? mc.id,
            serverHost: context.server,
          });
        } catch (error) {
          joinWarning = `[attic] 微软验证预注册失败：验证未注册，正版服可能被踢（${error instanceof MsAuthError ? error.code : 'internal'}）`;
        }
      }
      fs.mkdirSync(context.gameDir, { recursive: true });
      // spawn 前最后一道闸门（防竞态）：取消落在 start 之前 = 中止；之后 = 游戏已在跑，走 KILL。
      signal.throwIfAborted();
      const session = this.processes.start(config, request.versionId);
      if (joinWarning) {
        this.emitEvent(IPC_EVENTS.GAME_OUTPUT, { stream: 'stderr', chunk: joinWarning, pid: session.pid });
      }
      // 日志落盘：testLaunch 恒写；普通启动受「诊断日志」开关（diagnosticLog=true 全量落盘）
      if (request.testLaunch || settings['diagnosticLog'] === 'true') {
        this.attachLaunchLog(
          request.versionId,
          config,
          session,
          request.testLaunch ? 'test-launch' : 'launch',
          context.accessToken,
        );
      }
      this.lastLaunchError = null;
      return session;
    } catch (error) {
      if (controller.signal.aborted) {
        // 用户主动取消 = 中性态：不记 lastLaunchError（status 不显崩），归一文案回 UI。
        this.lastLaunchError = null;
        throw new Error(LAUNCH_CANCELLED_MESSAGE);
      }
      this.lastLaunchError = messageOf(error);
      throw error;
    } finally {
      if (this.launchAbort === controller) this.launchAbort = null;
    }
  }

  /**
   * 取消进行中的启动（LAUNCH_CANCEL 通道）：中止在途下载/补全链。
   * 游戏已 spawn 或无在途启动 = cancelled:false（取消窗口已过，终止应走 KILL）。
   */
  cancelLaunch(): LaunchCancelResult {
    if (!this.launchAbort || this.processes.running) return { cancelled: false };
    this.launchAbort.abort(new Error(LAUNCH_CANCELLED_MESSAGE));
    return { cancelled: true };
  }

  /** 清扫原子写残留的 `.part`（进程被杀/断电留下的半截文件，回收磁盘）。 */
  private sweepStaleParts(): void {
    sweepPartFiles(versionsDir(this.root), 2);
    sweepPartFiles(binDir(this.root), 2);
    sweepPartFiles(path.join(assetsDir(this.root), 'objects'), 2);
    sweepPartFiles(launcherDir(this.root), 1);
    sweepPartFiles(zuluJavaDir(this.root), 1);
  }

  async kill(): Promise<GameExit> {
    return this.processes.kill();
  }

  status(): GameStatus {
    const status = this.processes.status();
    return { ...status, lastError: status.lastError ?? this.lastLaunchError };
  }

  async detectJava(): Promise<JavaDetectionReport> {
    const settings = loadSettings(this.root);
    return detectJavaRuntime({ manualPaths: this.manualJavaPaths(settings) });
  }

  async listAccounts(): Promise<AccountView[]> {
    this.backfillMicrosoftSkins();
    return this.currentAccounts().map(toAccountView);
  }

  /**
   * skinUrl 惰性回填：皮肤直链上线前的旧版落盘微软账户没有 skinUrl（当时 profile 步未解 textures），
   * 首拉账户列表时后台补跑一次刷新链回填；失败静默，下次启动再试。
   * 第三方头像生态已随 Mojang 匿名 profile 端点退役而失效，带 token 的 services 链
   * 是唯一皮肤数据源——不回填则头像永远默认脸。
   */
  private skinBackfillStarted = false;
  private backfillMicrosoftSkins(): void {
    if (this.skinBackfillStarted) return;
    this.skinBackfillStarted = true;
    void (async () => {
      for (const a of loadAccounts(this.root)) {
        if (a.type === 'microsoft' && a.refreshToken && !a.skinUrl) {
          try {
            await this.msRefreshAccount(a.id);
          } catch {
            /* 静默：网络/DPAPI 失败不打扰，下次启动重试 */
          }
        }
      }
    })();
  }

  /**
   * 添加离线账户：MC 用户名规则（3-16 位字母/数字/下划线，BlockHelm AccountNameValidator 同款）；
   * 同名幂等返回既有账户（不重复建档）。微软账户无此通道（登录走 MS_LOGIN 三通道）。
   */
  addAccount(name: string): AccountView {
    const trimmed = name.trim();
    if (!/^[A-Za-z0-9_]{3,16}$/.test(trimmed)) {
      throw new Error(`无效用户名（需 3-16 位字母/数字/下划线）：${name}`);
    }
    const stored = loadAccounts(this.root);
    const existing = stored.find((a) => a.name === trimmed);
    if (existing) return toAccountView(existing);
    const account: OfflineAccount = { id: offlineUuid(trimmed), name: trimmed, type: 'offline' };
    saveAccounts(this.root, [...stored, account]);
    return toAccountView(account);
  }

  /** 移除账户（按 id）；可移除至空，无默认账户回落。 */
  removeAccount(id: string): void {
    saveAccounts(this.root, loadAccounts(this.root).filter((a) => a.id !== id));
  }

  /**
   * 重命名离线账户（BlockHelm RenameAccount 对话框同款语义）：MC 用户名规则校验；
   * 与他名冲突报错、同名幂等；离线 UUID 随用户名重生成（id 即新 UUID，与 addAccount 派生一致）。
   * 微软账户名由档案决定，不支持重命名。
   */
  renameAccount(id: string, name: string): AccountView {
    const trimmed = name.trim();
    if (!/^[A-Za-z0-9_]{3,16}$/.test(trimmed)) {
      throw new Error(`无效用户名（需 3-16 位字母/数字/下划线）：${name}`);
    }
    const stored = loadAccounts(this.root);
    const account = stored.find((a) => a.id === id);
    if (!account) throw new Error(`账户不存在：${id}`);
    if (account.type !== 'offline') throw new Error('仅离线账户支持重命名');
    if (account.name === trimmed) return toAccountView(account);
    if (stored.some((a) => a.name === trimmed)) throw new Error(`用户名已存在：${trimmed}`);
    const renamed: OfflineAccount = { ...account, name: trimmed, id: offlineUuid(trimmed) };
    saveAccounts(this.root, stored.map((a) => (a.id === id ? renamed : a)));
    return toAccountView(renamed);
  }

  // ---------- 微软登录（ACCOUNTS_MS_* 三通道 + MS_LOGIN 事件面） ----------

  /** 生效 CLIENT_ID：settings.microsoftClientId 覆盖 > 内嵌缺省（OAuth public client 公开常量）。 */
  private msClientId(): string {
    const override = settingsFromProps(loadSettings(this.root)).microsoftClientId?.trim();
    return override && override.length > 0 ? override : DEFAULT_MS_CLIENT_ID;
  }

  /** MS 链宿主本地诊断通道（internal 归因进 launcher.log；跨 IPC 面仍只有分类码——脱敏闸不变）。 */
  private msDpapi(): DpapiDeps {
    return { ...this.msDeps.dpapi, log: (m) => console.warn(`[attic-ms] ${m}`) };
  }

  private msAuthDeps(signal?: AbortSignal): MsAuthDeps {
    return {
      fetchImpl: this.fetchImpl,
      clientId: this.msClientId(),
      signal,
      sleep: this.msDeps.sleep,
      lookup: this.msDeps.lookup,
      dpapi: this.msDpapi(),
      log: (m) => console.warn(`[attic-ms] ${m}`),
    };
  }

  /**
   * 发起微软设备码登录（single-flight，同时只允许一条流——在跑 = 稳定错误拒绝）：
   * 第①步设备码同步返回（弹窗展示面），轮询 + 链尾后台推进，终局经 MS_LOGIN 事件异步送达
   * （success = 落盘账户的 AccountView，同 profileId 幂等覆盖既有微软账户；error = 分类码，
   * HTTP 原文/ token 永不外传——token 全程驻宿主）。
   */
  async msStartLogin(): Promise<MsDeviceCode> {
    if (this.msLoginFlow) throw new Error('微软登录流已在进行中，请等待完成或先取消');
    const controller = new AbortController();
    const flow = { controller };
    this.msLoginFlow = flow;
    let issued: MsDeviceCodeIssue;
    try {
      issued = await requestDeviceCode(this.msAuthDeps(controller.signal));
    } catch (error) {
      if (this.msLoginFlow === flow) this.msLoginFlow = null;
      throw error;
    }
    void this.runMsLoginChain(issued, controller.signal).finally(() => {
      if (this.msLoginFlow === flow) this.msLoginFlow = null;
    });
    return issued.view;
  }

  /** 中止设备码轮询与链尾（canceled 事件由链 catch 发射）；无流在跑 = no-op 成功。 */
  async msCancelLogin(): Promise<void> {
    this.msLoginFlow?.controller.abort();
  }

  private async runMsLoginChain(issued: MsDeviceCodeIssue, signal: AbortSignal): Promise<void> {
    try {
      const pair = await pollDeviceToken(this.msAuthDeps(signal), issued.deviceCode, issued.view.interval);
      const chain = await runAuthTail(this.msAuthDeps(signal), pair);
      const account = await this.upsertMicrosoftAccount(chain);
      const event: MsLoginEvent = { state: 'success', account: toAccountView(account) };
      this.emitEvent(IPC_EVENTS.MS_LOGIN, event);
    } catch (error) {
      const code: MsLoginErrorCode =
        signal.aborted || error instanceof MsAbortError
          ? 'canceled'
          : error instanceof MsAuthError
            ? error.code
            : 'internal';
      const event: MsLoginEvent = { state: 'error', code };
      this.emitEvent(IPC_EVENTS.MS_LOGIN, event);
    }
  }

  /**
   * 刷新链（ACCOUNTS_MS_REFRESH）：refreshToken → token endpoint 重放 → XBL/XSTS/MCS/profile → 落盘。
   * 错误以 MsAuthError 抛（message = 分类码，脱敏闸保证不含 token 原文）。
   */
  async msRefreshAccount(id: string): Promise<AccountView> {
    const stored = loadAccounts(this.root);
    const account = stored.find((a) => a.id === id);
    if (!account) throw new Error(`账户不存在：${id}`);
    if (account.type !== 'microsoft') throw new Error('仅微软账户支持 token 刷新');
    if (!account.refreshToken) throw new Error('微软账户缺刷新令牌，请重新走设备码登录');
    const deps = this.msDpapi();
    const refreshToken = await decodeTokenSecret(account.refreshToken, deps);
    const pair = await refreshMsToken(this.msAuthDeps(), refreshToken);
    const chain = await runAuthTail(this.msAuthDeps(), pair);
    const saved = await this.upsertMicrosoftAccount(chain);
    return toAccountView(saved);
  }

  /**
   * 账户落盘（同 profileId 幂等覆盖）：token 磁盘形态 = DPAPI 密文 `dpapi:v1:<b64>`
   * （refresh token 是长期凭证，禁明文）；返回内存态明文账户。
   */
  private async upsertMicrosoftAccount(chain: MsChainResult): Promise<MicrosoftAccount> {
    const deps = this.msDpapi();
    const accessToken = await encodeTokenSecret(chain.mcAccessToken, deps);
    const refreshToken = chain.refreshToken ? await encodeTokenSecret(chain.refreshToken, deps) : undefined;
    const disk: MicrosoftAccount = {
      id: chain.id,
      name: chain.name,
      type: 'microsoft',
      accessToken,
      ...(refreshToken !== undefined ? { refreshToken } : {}),
      tokenExpiresAt: Date.now() + chain.mcExpiresIn * 1000,
      profileId: chain.id,
      ...(chain.skinUrl ? { skinUrl: chain.skinUrl } : {}),
    };
    const stored = loadAccounts(this.root);
    const idx = stored.findIndex((a) => a.id === disk.id);
    if (idx === -1) saveAccounts(this.root, [...stored, disk]);
    else {
      const next = [...stored];
      next[idx] = disk;
      saveAccounts(this.root, next);
    }
    return {
      ...disk,
      accessToken: chain.mcAccessToken,
      ...(chain.refreshToken !== undefined ? { refreshToken: chain.refreshToken } : {}),
    };
  }

  /**
   * 启动面账户解析（buildContext 选型逻辑的单点）：微软账户 token 从磁盘 DPAPI 密文解密为
   * 内存明文（旧明文形态原样装载，见 decodeTokenSecret）。
   */
  private async resolveLaunchAccount(request: LaunchRequest): Promise<Account> {
    const accounts = this.currentAccounts();
    const account = request.accountId ? accounts.find((a) => a.id === request.accountId) : accounts[0];
    if (!account) throw new Error('无可用账户，请先在账户页添加账户');
    if (account.type !== 'microsoft') return account;
    const deps = this.msDpapi();
    return {
      ...account,
      accessToken: await decodeTokenSecret(account.accessToken, deps),
      ...(account.refreshToken !== undefined ? { refreshToken: await decodeTokenSecret(account.refreshToken, deps) } : {}),
    };
  }

  // ---------- 自定义版本配置页（CUSTOM_* 四通道） ----------

  /**
   * 自定义版本列表：custom 项 + Mods 仓库托管项（mod 的删除途径 = 本页，
   * 故 .info 含 base-version 的模组版本也落入，打 mod 标、编辑禁用）——
   * `.info` custom=true = 已配置；裸 jar（有 jar 无 .info 且不在官方清单）= 未配置。
   * Betacraft 官方版本不落入本页：含 .info 无 custom=true/base-version 的，也含 **官方清单 id 的裸 jar**
   * （BC 版本地 .info 缺失 ≠ 用户导入）。官方集取版本清单缓存
   * （仅 fetchVersionList 成功时写入=纯 BC 列表；缓存缺席=还没联网拉过，维持 v1 裸 jar 语义）。
   * 列表不跑 jar 检测（zip 开销留给按需 get）。
   */
  listCustomVersions(): CustomVersionView[] {
    const jars = new Set(scanInstalledJars(this.root));
    const infos = scanInstalledInfos(this.root);
    const official = this.cachedOfficialVersionIds();
    const out: CustomVersionView[] = [];
    for (const id of infos) {
      // 官方清单命中即官方（> 本地 custom=true 残留声明）
      if (official.has(id)) continue;
      const props = readPropertiesFile(infoFile(this.root, id));
      const isMod = Boolean(props['base-version']?.trim());
      if (!isMod && props['custom']?.toLowerCase() !== 'true') continue;
      const launchMethod = props['launch-method'];
      const mainClass = props['main-class'] ?? (launchMethod ? LAUNCH_METHOD_MAIN_CLASS[launchMethod] : undefined);
      out.push({
        id,
        installed: jars.has(id),
        configured: true,
        ...(isMod ? { mod: true } : {}),
        ...(launchMethod ? { launchMethod } : {}),
        ...(mainClass ? { mainClass } : {}),
      });
    }
    const withInfo = new Set(infos);
    for (const id of jars) {
      if (withInfo.has(id) || official.has(id)) continue;
      out.push({ id, installed: true, configured: false });
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
  }

  /** 版本清单缓存的 id 集（=Betacraft 官方全集；缓存缺席回空集）。 */
  private cachedOfficialVersionIds(): Set<string> {
    const cache = readJsonIfPresent<VersionManifest>(versionListCacheFile(this.root));
    return new Set((cache?.versions ?? []).map((ref) => ref.id));
  }

  /** CUSTOM get/save 统一门禁：官方清单命中即官方（> 本地 custom=true 残留声明），显式拒绝。 */
  private assertNotOfficialId(id: string): void {
    if (this.cachedOfficialVersionIds().has(id)) {
      throw new Error(`${id} 是 Betacraft 官方版本 id，不落入自定义版本配置（本地残留的 custom=true 声明已失效）`);
    }
  }

  /** 读取单个自定义版本 .info：已配置回原始属性；未配置裸 jar 附 detectLaunchMethod 建议。 */
  getCustomVersionInfo(id: string): CustomInfoView {
    assertSafeVersionId(id);
    this.assertNotOfficialId(id);
    const jar = clientJarFile(this.root, id);
    const info = infoFile(this.root, id);
    const hasJar = fs.existsSync(jar);
    const hasInfo = fs.existsSync(info);
    if (!hasJar && !hasInfo) throw new Error(`自定义版本不存在：${id}`);
    const launchMethods = Object.keys(LAUNCH_METHOD_MAIN_CLASS);
    if (hasInfo) {
      const props = readPropertiesFile(info);
      // mod 的 .info 无 custom=true（base-version 判型）：可查看不可编辑（右栏据此走只读态）
      const isMod = Boolean(props['base-version']?.trim());
      if (!isMod && props['custom']?.toLowerCase() !== 'true') {
        throw new Error(`${id} 不是自定义版本（Betacraft 官方版本不落入本页）`);
      }
      return { id, configured: true, props, launchMethods, ...(isMod ? { mod: true } : {}) };
    }
    // 预填建议：归一后仍不在主类表内的（'custom' 全不中、'1.6' 超 BC 清单范围）不给——
    // 保证 UI 下拉必命中，不会预填一个存不进去的名字。
    const detected = canonicalLaunchMethod(detectLaunchMethod(jar));
    return {
      id,
      configured: false,
      props: {},
      ...(LAUNCH_METHOD_MAIN_CLASS[detected] ? { detectedMethod: detected } : {}),
      launchMethods,
    };
  }

  /**
   * 保存自定义版本 .info：launch-method 必填；其余字段选填（留空落盘为 `key=` 空值段，不删键）；
   * 强制 custom=true（归本启动器所有，豁免远端重写）；
   * launch-method 不在主类数据表内时必须显式给 main-class（未映射=主类空，Error 7 语义显式报错）。
   */
  saveCustomVersionInfo(id: string, props: Record<string, string>): CustomVersionView {
    assertSafeVersionId(id);
    this.assertNotOfficialId(id);
    const jar = clientJarFile(this.root, id);
    const info = infoFile(this.root, id);
    if (!fs.existsSync(jar) && !fs.existsSync(info)) throw new Error(`自定义版本不存在：${id}`);
    // mod 的 .info 由 Mods 仓库托管（autoupdate 会整文件重写，编辑必丢）：显式拒绝，删除不受限
    if (fs.existsSync(info) && readPropertiesFile(info)['base-version']?.trim()) {
      throw new Error(`${id} 是 Mods 仓库托管的模组版本：编辑已禁用（删除可在本页执行）`);
    }
    // base-version = mod 判型托管键：禁经编辑器写入——误填会把普通自定义版本永久打成 Mod 只读态，
    // 且启动期按 mod 合成链处理必缺料（v1 同款键，非用户可配置面）。
    if (props['base-version']?.trim()) {
      throw new Error('base-version 是 Mods 仓库托管键，不能经编辑器写入');
    }
    const launchMethod = props['launch-method']?.trim();
    const mainClass = props['main-class']?.trim();
    if (!launchMethod) throw new Error('launch-method 为必填项');
    if (!(launchMethod in LAUNCH_METHOD_MAIN_CLASS) && !mainClass) {
      throw new Error(`未知 launch-method「${launchMethod}」（主类表无映射，且未显式提供 main-class）`);
    }
    const toWrite: Record<string, string> = {};
    for (const [rawKey, rawValue] of Object.entries(props)) {
      const key = rawKey.trim();
      if (key === '' || key === 'custom') continue; // custom 由启动器强制写
      toWrite[key] = rawValue == null ? '' : String(rawValue); // 选填留空=写 `key=`
    }
    toWrite['custom'] = 'true';
    writePropertiesFile(info, toWrite);
    return {
      id,
      installed: fs.existsSync(jar),
      configured: true,
      launchMethod,
      ...(mainClass || LAUNCH_METHOD_MAIN_CLASS[launchMethod]
        ? { mainClass: mainClass || LAUNCH_METHOD_MAIN_CLASS[launchMethod] }
        : {}),
    };
  }

  /** 导入自定义版本 jar：复制为 versions/<id>.jar（id=文件名去扩展名；同名报错不覆盖）；落裸 jar=未配置态。 */
  importCustomJar(srcPath: string): CustomVersionView {
    if (!fs.existsSync(srcPath)) throw new Error(`文件不存在：${srcPath}`);
    const ext = path.extname(srcPath).toLowerCase();
    if (ext !== '.jar' && ext !== '.zip') throw new Error('仅支持 .jar / .zip 客户端包');
    const id = path.basename(srcPath, path.extname(srcPath));
    assertSafeVersionId(id);
    const target = clientJarFile(this.root, id);
    if (fs.existsSync(target)) throw new Error(`已存在同名版本 jar：${id}`);
    // 官方清单 id 拒绝导入：BC 版本走正常下载/启动链路，
    // 导成裸 jar 只会得到无元数据的残缺本地版。
    if (this.cachedOfficialVersionIds().has(id)) {
      throw new Error(`${id} 是 Betacraft 官方版本 id，不能作为自定义版本导入（启动页直接选择该版本即可）`);
    }
    fs.copyFileSync(srcPath, target);
    const info = infoFile(this.root, id);
    const configured =
      fs.existsSync(info) && readPropertiesFile(info)['custom']?.toLowerCase() === 'true';
    return { id, installed: true, configured };
  }

  /**
   * 删除自定义版本：versions/<id>.jar 与 versions/jsons/<id>.info 一并移除（缺哪个跳哪个）；
   * mod 项联动清 launcher/mods.json 登记（防幽灵条目：登记在 = 启动期仍会按登记 URL 复活 .info）。
   * 门禁 = listCustomVersions 成员判定（与列表页同源）：官方版本（.info 无 custom=true/base-version）拒绝，
   * 从入口排除误删 BC 文件；不存在/非 custom 均显式报错。
   *
   * 实例指针联动清理：`launch()` 每次启动都把选中版本写回实例档案，
   * 故刚启动过该版本的实例会留下指向已消失版本的 `version`；
   * 删除是不可逆的（jar+.info+登记三清，无"日后重新导入同名"可恢复语义），悬空 id 既不能启动
   * 也让实例页/dock 显示已不存在的版本 → 逐个档案把该字段写成空串（= 未选择版本，UI 出占位文案）。
   * 只清 `version` 恰好等于被删 id 的档案，其余实例一字不动；写空串而非删键：`loadInstance` 的
   * `?? 'b1.7.3'` 只在键缺席时兜底，删键会把实例静默改指向 v1 缺省版本。
   */
  removeCustomVersion(id: string): void {
    assertSafeVersionId(id);
    if (!this.listCustomVersions().some((v) => v.id === id)) {
      throw new Error(`${id} 不是自定义版本（不存在，或为 Betacraft 官方版本不可删除）`);
    }
    fs.rmSync(clientJarFile(this.root, id), { force: true });
    fs.rmSync(infoFile(this.root, id), { force: true });
    removeModRegistry(this.root, id);
    for (const name of listInstances(this.root)) {
      const config = loadInstance(this.root, name);
      if (!config || config.version !== id) continue;
      saveInstance(this.root, { ...config, version: '' });
    }
  }

  // ---------- Mods 页（MODS_* 两通道；Betacraft 单源） ----------

  /**
   * 仓库列表 = 每次调用现拉（无进程内缓存，区别于 v1 ModsRepository 的「进程级追加不清空、永不刷新」）。
   * installed = versions/jsons/<full_name>.info 在位；上游脏 id（路径穿越等）
   * 不触文件系统，按未安装处理。
   */
  async listMods(): Promise<ModCategoryView[]> {
    const categories = await this.client.fetchModCategories();
    return categories.map((cat) => ({
      name: cat.name,
      mods: cat.mods.map((mod) => ({ ...mod, installed: this.modInfoPresent(mod.fullName) })),
    }));
  }

  private modInfoPresent(fullName: string): boolean {
    try {
      assertSafeVersionId(fullName);
    } catch {
      return false;
    }
    return fs.existsSync(infoFile(this.root, fullName));
  }

  /**
   * 安装 = 只下 .info（jar 在启动期补全；v1 Load 顺带写 currentInstance.version 的行为
   * 不照抄——只安装不动实例）。门禁三道：id 安全、http(s) 协议白名单、同名拒绝
   * （先尝试刷新官方清单缓存，官方清单命中即拒，网络失败按现有缓存判）。
   * 落位后写 launcher/mods.json 登记 {infoUrl, autoupdate}——启动期刷新的唯一来源（v1 离线
   * 误路由官方 URL 的坑）；.info watcher 会自动发 CUSTOM_INFO_CHANGED，无需新增事件。
   */
  async installMod(request: ModInstallRequest): Promise<void> {
    const id = request.fullName.trim();
    assertSafeVersionId(id);
    const infoFileUrl = request.infoFileUrl.trim();
    let url: URL;
    try {
      url = new URL(infoFileUrl);
    } catch {
      throw new Error(`.info 下载地址不是合法 URL：${infoFileUrl}`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(`拒绝非 HTTP(S) 下载地址：${url.protocol}`);
    }
    try {
      // 直接刷新（非 listVersions——SWR 下缓存即在即返不等网络，保证不了本门禁的「先刷新」语义）：
      // 刷新成功即最新、网络失败按现有缓存判。
      await this.refreshVersionListCache();
    } catch {
      /* 网络失败：按现有缓存判定 */
    }
    if (this.cachedOfficialVersionIds().has(id)) {
      throw new Error(`${id} 与 Betacraft 官方版本同名，拒绝安装（.info/jar 会覆盖官方版本文件）`);
    }
    await downloadInfoAtomic(this.client, this.root, id, infoFileUrl);
    upsertModRegistry(this.root, id, {
      infoUrl: infoFileUrl,
      autoupdate: request.autoupdate === true,
      installedAt: Date.now(),
    });
  }

  /**
   * 社区服务器列表 = 每次调用现拉 HTML 宽松解析（无进程内缓存，listMods 同款）；
   * 失败以异常上抛、壳层 IpcResult 封装为错误字符串（UI 空态+重试）。
   * matchedVersionId 派生在此（UI 零版本判断纪律）：版本目录取 listVersions
   * 缓存优先面；清单不可得（无缓存且断网）= 全未命中降级，列表照常返回（UI 走手动选版本）。
   */
  async listServers(): Promise<ServerListView[]> {
    const html = await this.client.fetchServerListHtml();
    let refs: VersionRef[] = [];
    try {
      refs = await this.listVersions();
    } catch {
      /* 版本目录不可得：匹配级降级为全未命中，不拦列表 */
    }
    // 匹配两轨（防劫持 + 第三方客户端正解，见 parseServerList 注释）：
    // 官方轨 = BC 清单原版（repository 命中且未判 custom），带清单 protocol 供协议全集；
    // mod/自定义轨 = 本地自定义条目 ∪ 远端仓库 full_name（v1 StartThread 启动即 loadMods、
    // WebsitePanel.getMod 对仓库直匹配的语义对齐——未安装的 mod 也能匹配上，
    // infoUrl 随条目携带 = UI 确认进服时自动入库的直链）。仓库拉取失败 = 只落本地轨，不拦列表。
    const officialVersions = refs
      .filter((ref) => ref.repository === 'betacraft' && !ref.custom)
      .map((ref) => ({ id: ref.id, protocol: ref.protocol }));
    const localCustom = refs
      .filter((ref) => ref.repository !== 'betacraft' || ref.custom)
      .map((ref) => ({ id: ref.id }));
    let repoMods: { id: string; infoUrl?: string }[] = [];
    try {
      const categories = await this.client.fetchModCategories();
      repoMods = categories.flatMap((cat) =>
        cat.mods.map((mod) => ({ id: mod.fullName, infoUrl: mod.infoFileUrl })),
      );
    } catch {
      /* 仓库不可得：mod 轨回落本地条目，匹配级降级不拦列表 */
    }
    // 本地先行去重（已装条目不带 infoUrl = 不触发 UI 自动入库；仓库同名条目让位）。
    const seen = new Set(localCustom.map((v) => v.id.toLowerCase()));
    const customVersions = [...localCustom, ...repoMods.filter((v) => !seen.has(v.id.toLowerCase()))];
    return parseServerList(html, officialVersions, customVersions);
  }

  getSettings(): AppSettings {
    const view = settingsFromProps(loadSettings(this.root));
    if (this.portable?.active) {
      // 便携形态视图映射（两形态各写各的指针面）：marker ini 的 rootDir 投映进 rootOverride 字段
      // （UI 三重门①/设置页 pendingRoot 复用现成逻辑，ini 相对位按 exeDir 解析后回显绝对形）；
      // 回落标记恒取本次判定现场、面包屑恒取默认根登记簿（生效根 settings 里的同名键不可信，覆盖之）。
      if (this.portable.pointerRoot) view.rootOverride = this.portable.pointerRoot;
      else delete view.rootOverride;
      view.portableFallback = this.portable.fallback;
      const crumb = loadSettings(this.defaultRoot)['lastPortableRoot'];
      if (crumb) view.lastPortableRoot = crumb;
      else delete view.lastPortableRoot;
    }
    return view;
  }

  /**
   * 合并落盘（未知键保留），返回保存后的视图。端点改动下次启动应用生效。
   * 安装版落盘前护栏：rootOverride 若落在宿主安装目录之内 = 卸载器 `{app}` 整删射程
   * （Inno `[UninstallDelete]` 无排除机制），数据必丢且不可逆 → 显式拒绝。
   * 向导/设置页/手改 settings 三入口共用本道闸；宿主侧 bootstrap peek 另有同款兜底。
   * 便携形态：rootOverride 落点改道 marker ini 的 rootDir（随盘指针面，不落 settings）；
   * 安装目录护栏跳过（无卸载器，{app} 风险面不存在）；向导 portable flavor 完成时幂等落锚。
   */
  setSettings(settings: AppSettings): AppSettings {
    if (this.portable?.active) {
      // 键在场才动指针面（部分 patch 不带 rootOverride = 指针不动；空串/undefined = 显式清除回落 exe 旁缺省）。
      // 视图恒带当前指针回显（getSettings 映射），与 pointerRoot 比对判「真改动」，未动 = 零写。
      // 相对 rootDir 按 exeDir 解析（换盘符纪律）后写原形入 ini。
      if ('rootOverride' in settings) {
        const raw = settings.rootOverride?.trim() ?? '';
        const p = this.platform === 'win32' ? path.win32 : path.posix;
        const resolved = raw ? (p.isAbsolute(raw) ? p.normalize(raw) : p.resolve(this.portable.exeDir, raw)) : '';
        if (resolved !== (this.portable.pointerRoot ?? '')) {
          writePortablePointer(this.portable.iniPath, raw);
          this.portable.pointerRoot = resolved || undefined;
        }
      }
      // 落锚副作用（自愈指纹，幂等保留首锚）：只读回落态跳过（写不进盘，
      // 待可写态下向导再落——flavor 戳本身照常落 settings，回落根可达）。
      if (settings.wizardDone === true && settings.wizardFlavor === 'portable' && !this.portable.fallback) {
        writePortableAnchor(this.portable.exeDir, this.version);
      }
      const rest: AppSettings = { ...settings };
      delete rest.rootOverride;
      saveSettings(this.root, applySettingsToProps(loadSettings(this.root), rest));
      return this.getSettings();
    }
    if (
      settings.rootOverride &&
      this.installDir &&
      isPathWithin(this.installDir, settings.rootOverride, this.platform)
    ) {
      throw new Error(
        '游戏数据不能放进安装目录——卸载时会连同整个安装目录删除，存档不可恢复。' +
          '请选安装目录之外的位置；想要「一切随一个文件夹」请用便携版构件（amcl-*-portable.zip）。',
      );
    }
    saveSettings(this.root, applySettingsToProps(loadSettings(this.root), settings));
    return this.getSettings();
  }

  /** 宿主环境快照（设置页通用/内存/关于栏共用；内存取不到按 0 返回，UI 端降级）。 */
  getSystemInfo(): SystemInfo {
    return {
      launcherVersion: this.version,
      platform: this.platform,
      dataRoot: this.root,
      defaultRoot: this.defaultRoot,
      defaultRootPopulated: hasUserData(this.defaultRoot),
      logsDir: path.join(launcherDir(this.root), 'logs'),
      totalMemMb: Math.round(os.totalmem() / 0x100000),
      freeMemMb: Math.round(os.freemem() / 0x100000),
      shell: this.shell,
      // 上次异常退出简报（构造期消费脏标记；缺席 = 上次正常退出，UI 不弹横幅）。
      ...(this.lastCrash ? { lastCrash: this.lastCrash } : {}),
      // portable 便携态：安装版缺席本键；rebuilt/pathWarning 仅命中时带出（契约可选字段口径）。
      ...(this.portable?.active
        ? {
            portable: {
              active: true,
              fallback: this.portable.fallback,
              rootPopulated: this.portableRootPopulated,
              ...(this.portable.rebuilt ? { rebuilt: true } : {}),
              ...(this.portable.pathWarning ? { pathWarning: this.portable.pathWarning } : {}),
            },
          }
        : {}),
    };
  }

  /**
   * 检查更新（GitHub Releases latest，数据面见 updateCheck.ts）。
   * 全分支数据化返回（unconfigured/error 也在 value 内，不抛异常）——UI 弹窗可见呈现；
   * 动作 = 全壳统一「提示 + Releases 链接」（tauri updater plugin 闭环未接）。
   */
  checkUpdate(): Promise<UpdateCheckResult> {
    return checkLatestRelease({ releaseRepo: this.releaseRepo, currentVersion: this.version, fetchImpl: this.fetchImpl });
  }

  /** 清理 launcher/logs 下的 *.log（正在被占用的文件跳过），返回删除个数。 */
  clearLogs(): number {
    const dir = path.join(launcherDir(this.root), 'logs');
    let removed = 0;
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return 0; // 目录不存在 = 无日志可清
    }
    for (const file of entries) {
      if (!file.endsWith('.log')) continue;
      try {
        fs.rmSync(path.join(dir, file));
        removed++;
      } catch {
        /* 文件被句柄占用（如诊断日志仍在写）：跳过不阻断 */
      }
    }
    return removed;
  }

  /**
   * 读图片字节转 base64 data URL（IMAGE_DATA_URL，背景图进 webview：双壳统一走宿主读）。
   * 扩展白名单 + 大小上限在宿主侧把关，
   * 违规/不可读 = 显式抛错（IPC 层转 IpcResult error，UI 可见失败）。
   */
  readImageAsDataUrl(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    const mime = IMAGE_MIME_BY_EXT[ext];
    if (!mime) throw new Error(`不支持的图片格式：${ext || '(无扩展名)'}`);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      throw new Error('背景图文件不存在或不可读');
    }
    if (!stat.isFile()) throw new Error('背景图路径不是文件');
    if (stat.size > IMAGE_MAX_BYTES) {
      throw new Error(`背景图超过 ${Math.floor(IMAGE_MAX_BYTES / (1024 * 1024))}MB 上限`);
    }
    const buf = fs.readFileSync(filePath);
    return `data:${mime};base64,${buf.toString('base64')}`;
  }

  // ---------- 启动器层崩溃诊断（纯逻辑在 crash.ts，本区只接 fs/环境） ----------

  /** launcher.log 路径（启动器自身 append 滚动历史，跨启动；与 output-client.log 互补）。 */
  launcherLogPath(): string {
    return path.join(launcherDir(this.root), 'logs', 'launcher.log');
  }

  /** 追加一条 launcher.log（`(时间戳) [OUT/ERR]` 前缀；封顶截半滚动；磁盘失败静默不反噬调用方）。 */
  appendLauncherLog(stream: 'out' | 'err', text: string): void {
    try {
      const file = this.launcherLogPath();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      try {
        if (fs.statSync(file).size > LAUNCHER_LOG_MAX_BYTES) {
          const all = fs.readFileSync(file, 'utf8');
          fs.writeFileSync(file, all.slice(Math.floor(all.length / 2)), 'utf8');
        }
      } catch {
        /* 首写无文件 */
      }
      fs.appendFileSync(file, `${launcherLogLine(stream, text)}\n`, 'utf8');
    } catch {
      /* launcher.log 写失败不影响主流程 */
    }
  }

  /** 渲染层错误静默落盘（CRASH_REPORT）：只进 launcher.log，不弹任何框。 */
  logRendererError(report: RendererErrorReport): void {
    this.appendLauncherLog('err', `[renderer:${report.source}] ${report.message}${report.stack ? `\n${report.stack}` : ''}`);
  }

  /** 崩溃当场写脏退出标记（下次启动构造期消费 → SYS_INFO.lastCrash → UI 横幅）。 */
  markCrashExit(category: string, stack: string): void {
    writeCrashMarker(this.root, { at: new Date().toISOString(), category, summary: crashSummary(stack), stack });
  }

  /** 诊断包文本：环境快照 + 崩溃栈 + 两日志尾各 200 行。 */
  crashBundle(category: string, stack: string): string {
    const logsDir = path.join(launcherDir(this.root), 'logs');
    const tail = (file: string): string => {
      try {
        return tailLines(fs.readFileSync(path.join(logsDir, file), 'utf8'), CRASH_LOG_TAIL_LINES);
      } catch {
        return '';
      }
    };
    const v = process.versions as Record<string, string | undefined>;
    return buildCrashBundle({
      launcherVersion: this.version,
      shell: this.shell,
      versions: { electron: v['electron'], chrome: v['chrome'], node: v['node'] },
      platform: this.platform,
      osRelease: os.release(),
      arch: process.arch,
      category,
      stack,
      launcherLog: tail('launcher.log'),
      clientLog: tail('output-client.log'),
    });
  }

  /** CRASH_BUNDLE 响应：bundle 文本 + releaseRepo 派生的预填 issue 链接（数据驱动，禁硬编码 repo）。 */
  crashBundleResult(category: string, stack: string): CrashBundleResult {
    return {
      text: this.crashBundle(category, stack),
      issuesUrl: crashIssuesUrl(this.releaseRepo, this.version, crashSummary(stack)),
    };
  }

  listInstances(): InstanceView[] {
    const out: InstanceView[] = [];
    for (const name of listInstances(this.root)) {
      const config = loadInstance(this.root, name);
      if (config) out.push(instanceViewFromConfig(config));
    }
    return out;
  }

  /** v1 Instance Settings 可编辑集全量落盘；gameDir 缺省派生 root/<实例名>，已存在实例保留其落位。
   * 以既有档案为底稿：视图不携带的 v1 遗留键（proxy/keepopen/RPC/console/isJavaPathNew）原样
   * 带走不丢（防实例页保存静默丢键）；视图字段显式 undefined = 清空删键语义不变。 */
  saveInstance(view: InstanceView): InstanceView {
    const existing = loadInstance(this.root, view.name);
    saveInstance(this.root, {
      ...(existing ?? {}),
      name: view.name,
      version: view.version,
      gameDir: view.gameDir ?? existing?.gameDir ?? path.join(this.root, view.name),
      launchArgs: view.launchArgs,
      width: view.width,
      height: view.height,
      javaPath: view.javaPath,
      // v1 `addons` 键 = 逗号分隔；[] → 空串 = 显式全关（区别于无键的 legacyfix 缺省）
      addons: view.addons?.join(','),
      // Attic 扩展键：直连地址原样存（undefined = 清空删键，与 javaPath 同语义）
      server: view.server,
      // v1 同名键 intelFix（缺键 = v1 缺省 true，视图 undefined 不落键）；forceUpdate = Attic 扩展键
      intelFix: view.intelFix,
      forceUpdate: view.forceUpdate,
    });
    return view;
  }

  /** 删除实例薄档案；withFiles=true 连实例目录一并删（护栏见 storage.deleteInstance）。
   * 档案不存在 = 显式报错（可见失败纪律）。 */
  deleteInstance(name: string, withFiles: boolean): void {
    if (!deleteInstance(this.root, name, withFiles)) throw new Error(`实例不存在：${name}`);
  }

  /** 改实例名（v1 语义：档案迁移，gameDir 原样带走不动目录）。返回改名后的权威视图。 */
  renameInstance(name: string, newName: string): InstanceView {
    return instanceViewFromConfig(renameInstance(this.root, name, newName));
  }

  /** 实例 gameDir（档案缺失按契约缺省 root/<实例名>，供宿主打开目录）。 */
  instanceGameDir(name: string): string {
    return loadInstance(this.root, name)?.gameDir ?? path.join(this.root, name);
  }

  /** 版本选中即写回实例（v1 SelectVersion.saveVersion 语义）：properties 级单字段读-改-写，
   * 保留档案其余全部键（InstanceView 不携带的 v1 遗留键不丢）。name 空 → 回落默认实例
   * （resolveInstance 建档兜底，与启动路径同款）。返回宿主权威视图供 UI upsert。 */
  setInstanceVersion(name: string | null, versionId: string): InstanceView {
    const target = name && name.trim() !== '' ? name : DEFAULT_INSTANCE_NAME;
    const config = this.resolveInstance(target);
    setInstanceVersionField(this.root, target, versionId);
    return instanceViewFromConfig({ ...config, version: versionId });
  }

  // ---------- 内部编排 ----------

  /** 实例解析（v1 Instance.newInstance 语义）：不存在则按缺省建档（gameDir=root/<实例名>）。 */
  private resolveInstance(name: string): InstanceConfig {
    const loaded = loadInstance(this.root, name);
    if (loaded) return loaded;
    // v1 Instance.newInstance 缺省集：launchArgs/-Xmx1G、854x480（与 loadInstance 补底一致）
    const fresh: InstanceConfig = {
      name,
      version: 'b1.7.3',
      gameDir: path.join(this.root, name),
      launchArgs: '-Xmx1G',
      width: 854,
      height: 480,
    };
    saveInstance(this.root, fresh);
    return fresh;
  }

  /** 选中版本写回实例：与 UI 选中即写回共用窄通道语义（幂等：同值不重写文件）。 */
  private persistInstanceVersion(request: LaunchRequest): void {
    this.setInstanceVersion(request.instanceId ?? DEFAULT_INSTANCE_NAME, request.versionId);
  }

  /**
   * 启动日志（testLaunch ≡ 菜单语义 + diagnosticLog 开关的普通启动共用）：启动器侧头行
   * （时间戳/版本/命令行——token 已脱敏）+ 游戏 stdout/stderr 全量 + 退出行，
   * 逐行落盘 `<root>/launcher/logs/<prefix>-<ISO>.log`。
   * 同点双写固定文件 `logs/output-client.log`（Betacraft v1 Logger.output-client.log 语义：
   * 恒等于**最近一次启动**的完整日志——本次启动开头截断旧文件，等价 v1 启动前
   * clearClientLog；逐行 append 即时开关句柄，无占用锁，clearLogs 的 *.log 清扫自然覆盖）。
   * 控制台窗口唤起归 UI 侧（WINDOW_CONSOLE），runtime 不触窗；落盘失败静默（不阻断启动）。
   */
  private attachLaunchLog(
    versionId: string,
    config: LaunchConfig,
    session: GameSession,
    prefix: 'test-launch' | 'launch',
    accessToken?: string,
  ): void {
    const logsDir = path.join(launcherDir(this.root), 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    // Windows 文件名禁冒点：ISO 串统一替换。
    const file = path.join(logsDir, `${prefix}-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
    const clientLog = path.join(logsDir, 'output-client.log');
    try {
      fs.writeFileSync(clientLog, '', 'utf8');
    } catch {
      /* 磁盘异常不影响游戏进程 */
    }
    const write = (line: string): void => {
      try {
        fs.appendFileSync(file, `${line}\n`, 'utf8');
      } catch {
        /* 磁盘异常不影响游戏进程 */
      }
      try {
        fs.appendFileSync(clientLog, `${line}\n`, 'utf8');
      } catch {
        /* 同上 */
      }
    };
    const at = (): string => new Date().toISOString().slice(11, 23);
    const censor = (line: string): string => maskSecrets(line, accessToken);
    write(`# Attic ${prefix} ${versionId} pid=${session.pid} ${new Date().toISOString()}`);
    write(`# java=${config.javaPath}`);
    write(`# gameDir=${config.gameDir}`);
    write(censor(`# command="${config.javaPath}" ${config.jvmArgs.join(' ')} -cp "${config.classpath.join(path.delimiter)}" ${config.mainClass} ${config.gameArgs.join(' ')}`));
    const offOutput = this.on(IPC_EVENTS.GAME_OUTPUT, (event) => {
      write(censor(`[${at()}] [${event.stream}] ${event.chunk.trimEnd()}`));
    });
    const offExit = this.on(IPC_EVENTS.GAME_EXIT, (event) => {
      write(`[${at()}] === exit code=${event.code} signal=${event.signal} crash=${event.crash?.category ?? 'none'} ===`);
      offOutput();
      offExit();
    });
  }

  private currentAccounts(): Account[] {
    // 无默认账户回落：首启/移除至空后恒为空列表，启动由 UI 侧禁用（需先手动添加账户）。
    return loadAccounts(this.root);
  }

  /**
   * 手动 javaPath 双形态语义（向导「指定 Java 目录」入口）：
   * 可执行文件路径原样；JDK 目录 → 向下至多两层找 bin/java（Zulu 供给同款 findJavaExecutable）。
   * 返回 null = 目录里没找到（调用方决定报错/保留原值进探测失败面）。
   */
  private resolveManualJava(raw: string): string | null {
    let isDir = false;
    try {
      isDir = fs.statSync(raw).isDirectory();
    } catch {
      return raw; // 不存在/不可 stat = 原样交给探测报错
    }
    if (!isDir) return raw;
    return findJavaExecutable(raw, this.platform);
  }

  private manualJavaPaths(settings: Record<string, string>): string[] {
    const paths: string[] = [];
    if (settings['javaPath']) paths.push(this.resolveManualJava(settings['javaPath']) ?? settings['javaPath']);
    // Zulu 自动供给落位的 JDK 也进手动候选。
    try {
      for (const entry of fs.readdirSync(zuluJavaDir(this.root))) {
        paths.push(path.join(zuluJavaDir(this.root), entry));
      }
    } catch {
      /* 未装过 Zulu */
    }
    return paths;
  }

  /** agentMount 区间判定序：按编译日期升序（version_list.txt 是乱序手工清单，不可当年代序用）。 */
  private cachedVersionOrder(): string[] {
    const cache = readJsonIfPresent<VersionManifest>(versionListCacheFile(this.root));
    const refs = cache?.versions ?? [];
    const dateOf = (ref: VersionRef): number => ref.compileDate ?? ref.releaseDate ?? Number.POSITIVE_INFINITY;
    return [...refs].sort((a, b) => dateOf(a) - dateOf(b)).map((ref) => ref.id);
  }

  private async buildContext(request: LaunchRequest, signal?: AbortSignal, preAccount?: Account): Promise<LaunchContext> {
    const settings = loadSettings(this.root);
    // 账户选型 + 微软 token DPAPI 解密单点（resolveLaunchAccount）；launch 已解析过则直接带走，
    // 免二次 PowerShell spawn。
    const account = preAccount ?? (await this.resolveLaunchAccount(request));

    // 手动 javaPath 双形态（exe / JDK 目录，见 resolveManualJava）：目录里没 java = 显式报错，
    // 不静默回落自动探测（用户明确指定过位置，探测另选更错）。
    const manualJava = settings['javaPath'] ? this.resolveManualJava(settings['javaPath']) : undefined;
    if (settings['javaPath'] && !manualJava) {
      throw new Error(`指定的 Java 目录下未找到可执行文件（bin/java）：${settings['javaPath']}`);
    }
    const javaPath = request.javaPath ?? manualJava ?? (await this.ensureJavaPath(settings, signal));
    await this.gateLwjgl2Arch(javaPath);
    // 内存三级优先：请求覆盖 > memoryMode=auto 宿主估算（总内存 40% 夹 [512,2048]）> 定值 > 1024 兜底
    const memory = Number(settings['maxMemoryMb']);
    const maxMemoryMb =
      request.maxMemoryMb ??
      (settings['memoryMode'] === 'auto'
        ? estimateMaxMemoryMb(Math.round(os.totalmem() / 0x100000))
        : Number.isFinite(memory) && memory > 0
          ? memory
          : 1024);

    const instance = this.resolveInstance(request.instanceId ?? DEFAULT_INSTANCE_NAME);

    return {
      javaPath,
      // v1 惯例（Instance.newInstance）：gameDir = 数据根/<实例名>，版本是实例属性、不参与目录派生。
      gameDir: instance.gameDir,
      launchArgs: instance.launchArgs,
      // 全局 JVM 参数（设置页「全局 JVM 参数」）：注入在实例参数之前（后者胜，实例可覆盖）
      globalJvmArgs: settings['jvmArgs'],
      // 档案 addons 逗号串 → 数组透传（undefined 保持 = 老档案零注入；空串 = 显式全关）
      addons: instance.addons?.split(',').map((s) => s.trim()).filter(Boolean),
      // v1 intelFix 缺键 = true（Instance.java newInstance 缺省）；win32 门控在此（launch.ts 保持平台中性）
      intelFix: this.platform === 'win32' && instance.intelFix !== false,
      // 一次性可视化器（「≡」菜单动作项）：true 才带键，false/缺省不落（dryRun/launch 同走此路）
      visualizer: request.visualizer === true ? true : undefined,
      // 一次性直连（启动询问弹窗「直连」才带键，来源 = 档案 server；拼装器解析）
      server: request.server,
      width: instance.width,
      height: instance.height,
      assetsDir: path.join(this.root, 'assets'),
      dataDir: this.root,
      username: account.name,
      uuid: account.id,
      accessToken: account.type === 'microsoft' ? account.accessToken : '0',
      launcherVersion: this.version,
      maxMemoryMb,
      binPool: scanBinPool(this.root),
      versionOrder: this.cachedVersionOrder(),
      levelServer: settings['levelServer'],
    };
  }

  /**
   * LWJGL2 原生库架构闸门（arm64 死区，判定表见 depends.ts checkLwjgl2Arch）：
   * 仅 arm 宿主触发；darwin arm64 需实测所选 JVM 架构（探测失败放行，不抢自身报错）。
   */
  private async gateLwjgl2Arch(javaPath: string): Promise<void> {
    if (this.platform === 'win32') return;
    if (process.arch !== 'arm64' && process.arch !== 'arm') return;
    let jvmArch: import('@attic/core-spec').JavaArchitecture | null = null;
    if (this.platform === 'darwin' && process.arch === 'arm64') {
      const probe = await probeJavaExecutable(javaPath, 'manual');
      if (probe.ok) jvmArch = probe.install.architecture;
    }
    const error = checkLwjgl2Arch(this.platform, process.arch, jvmArch);
    if (error) throw new Error(error);
  }

  /** BC 基础库集（libs/natives zip）核对与重拉——v1 downloadDepends 移植，语义见 depends.ts。 */
  private async updateDepends(settings: Record<string, string>, force: boolean, signal?: AbortSignal): Promise<void> {
    const io: DependsIO = {
      root: this.root,
      os: dependsOsFor(this.platform),
      settings,
      fetchText: async (url: string) => {
        const res = await this.fetchImpl(url, { signal });
        if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
        return res.text();
      },
      download: (url: string, destFile: string, id: string) => this.client.download(url, destFile, 'library', id, undefined, signal),
      saveVersionKeys: (keys: Record<string, string>) => saveSettings(this.root, { ...loadSettings(this.root), ...keys }),
    };
    await ensureDepends(io, this.endpoints, { force });
  }

  /** bin/ 库池里的 `*-natives-<os>.jar` 解到 bin/natives（LWJGL2/JInput 原生库落盘）。 */
  private extractNatives(): void {
    const os = this.platform === 'win32' ? 'windows' : this.platform === 'darwin' ? 'osx' : 'linux';
    const suffix = `-natives-${os}.jar`;
    let files: string[];
    try {
      files = fs.readdirSync(binDir(this.root));
    } catch {
      return;
    }
    for (const file of files) {
      if (!file.endsWith(suffix)) continue;
      extractZipTo(path.join(binDir(this.root), file), nativesDir(this.root));
    }
  }

  /** 探测 → 没有则 Zulu 自动供给（失败抛全因，手动导入兜底）。 */
  private async ensureJavaPath(settings: Record<string, string>, signal?: AbortSignal): Promise<string> {
    const report = await detectJavaRuntime({ manualPaths: this.manualJavaPaths(settings) });
    if (report.selection.install) return report.selection.install.executable;

    // 供给缓存命中：zuluJavaDir 已有上次解压好的 java 则直接复用
    // （缺这一步 = 无系统 Java 的机器每次启动重下 111MB zip）。
    const cached = findJavaExecutable(zuluJavaDir(this.root), this.platform);
    if (cached) return cached;

    try {
      // 位宽走 provisionArch 而非裸 process.arch：IA32 Legacy 壳在真 32 位 OS 上
      // process.arch='ia32'，裸值会被 zuluArch 旧映射成 x64 → 下的包 spawn 即挂。
      const pkgs = await queryZuluPackages(
        8,
        this.endpoints,
        this.fetchImpl,
        process.platform,
        provisionArch(process.platform, process.arch, process.env),
      );
      const pkg = pkgs[0];
      if (!pkg) throw new Error('Zulu 归档无匹配包');
      const outcome = await installZuluPackage(pkg, zuluJavaDir(this.root), { client: this.client, signal });
      if (!outcome.ok || !outcome.javaPath) throw new Error(outcome.reason ?? 'Zulu 安装失败');
      return outcome.javaPath;
    } catch (error) {
      throw new Error(
        `未找到 Java 8：${report.selection.reason}；自动供给失败：${messageOf(error)}；请在设置中手动导入 Java 路径`,
      );
    }
  }
}
