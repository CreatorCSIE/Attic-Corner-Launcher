/**
 * 版本数据契约：VersionRef（清单条目）、VersionJson（Mojang 兼容 + Betacraft 扩展）、
 * AgentMount（legacyfix 挂载决策——戒律 #1：quirk 矩阵是数据，不是客户端代码）。
 */

/** 版本来源仓库（端点可配置，风险 #1）。 */
export type VersionRepository = 'betacraft' | 'local' | 'custom';

/** 年代分层（UI 信息架构用，Phase 3；数据来自清单而非客户端推断）。 */
export type VersionEra =
  | 'pre-classic'
  | 'classic'
  | '4k'
  | 'indev'
  | 'infdev'
  | 'alpha'
  | 'beta'
  | 'release-1.0-1.5.2';

/** 版本清单条目（轻量，供列表/选择器）。 */
export interface VersionRef {
  id: string;
  repository: VersionRepository;
  /** Betacraft `other-name`：官方叫法之外的别名（如 "Origin Update"）。 */
  displayName?: string;
  era?: VersionEra;
  /** 发行日期（epoch 毫秒，来自 `release-date`）。 */
  releaseDate?: number;
  /** 编译日期（epoch 毫秒，来自 `compile-date`）。 */
  compileDate?: number;
  /** 本地是否已有可用 jar。 */
  installed: boolean;
  /** 自定义版本（v1 语义：裸 jar = 有 jar 无 .info，或 .info 声明 custom=true）；缺省 = 干净原版。 */
  custom?: boolean;
  /** version_list.txt 第 5 列协议值（`classic_7`/`beta_14`/`release_60` 等；v1 联机协议同源字段）。缺席 = 清单该行无第 5 列。 */
  protocol?: string;
}

/** 规则节点（Mojang 现代格式，远古 JSON 不出现但解析器须容忍）。 */
export interface VersionRule {
  action: 'allow' | 'disallow';
  os?: { name?: string; arch?: string; version?: string };
  features?: Record<string, boolean>;
}

export type VersionArgument = string | { rules?: VersionRule[]; value: string | string[] };

/** 现代 Mojang `arguments` 形态。 */
export interface VersionArguments {
  game?: VersionArgument[];
  jvm?: VersionArgument[];
}

/** 下载描述（url + sha1 + size 三元组，全契约通用）。 */
export interface DownloadArtifact {
  url: string;
  sha1?: string;
  size?: number;
}

export interface LibraryInfo {
  /** Maven 坐标，如 `org.lwjgl.lwjgl:lwjgl:2.9.4-nightly-20150209`。 */
  name: string;
  /** Betacraft 风格直链（现代格式在 downloads 里）。 */
  url?: string;
  client?: DownloadArtifact;
  server?: DownloadArtifact;
  /** natives 解压规则（现代格式）。 */
  natives?: Record<string, string>;
  extract?: { exclude?: string[] };
  rules?: VersionRule[];
}

/**
 * legacyfix 挂载决策表条目——进版本数据，不进代码。
 * 形态判定事实（legacyfix README）：
 *   - Vanilla / Risugami ModLoader / Forge ≤1.3 → javaagent（`-javaagent:<jar>=<gameDir>`）
 *   - Forge 1.4 → coremod（游戏目录 `coremods/`）
 *   - Forge ≥1.5 / Fabric 系 → mod（游戏目录 `mods/`）
 */
export interface AgentMount {
  form: 'javaagent' | 'coremod' | 'mod';
  /** 相对启动器数据目录的本地路径（获取通道见 docs/contract.md §agentMount）。 */
  path: string;
  /** 适用下限版本（含）。版本先后次序以清单顺序/编译日期判定，属运行时职责。 */
  appliesFrom: string;
  /** 适用上限版本（含）；缺省 = 无上限。 */
  appliesTo?: string;
  /** 该挂载对应的 quirk 标识（legacyfix 补丁名，如 `intel`、`classic-resize`），供 UI 展示与排障。 */
  quirk?: string;
}

/** Betacraft 扩展（来自版本 `.info` 属性文件，v1 实测字段集）。 */
export interface BetacraftExtension {
  /** 代理 JVM 参数（默认 `-Dhttp.proxyHost=betacraft.uk`），正版验证/皮肤/资产走代理。 */
  proxyArgs?: string[];
  /** 启动方法标记（如 `launchwrapper`、`start`）。 */
  launchMethod?: string;
  /** 启动方法说明链接。 */
  launchMethodLink?: string;
  /** 协议版本（联机用，如 `1.6.6`）。 */
  protocolVersion?: string;
  /** 该版本所基于的官方版本 id。 */
  baseVersion?: string;
  /** 是否自定义/模组化版本（缺省 = 干净原版）。 */
  custom?: boolean;
  /** `.info` 文件 schema 版本。 */
  fileVer?: number;
  /** legacyfix 挂载决策表。 */
  agentMount?: AgentMount[];
}

/**
 * 支持经典多人「加入服务器」的 launchMethod 值（数据表键控，非版本 id 判断，戒律 #1）。
 * 启动页直连询问弹窗的缺省触发面：激活实例未配 `server` 时，选中版本命中此表仍弹窗
 * （现场填地址一次性直连，不写实例档案）；配了 server 则无条件弹（§2.7）。
 * 事实来源：Betacraft `.info` launch-method——ClassicMpWithSaving = c0.28+（MP + 存档）。
 */
export const MULTIPLAYER_JOIN_LAUNCH_METHODS: readonly string[] = ['ClassicMpWithSaving'];

/**
 * 版本 JSON：Mojang 兼容字段 + Betacraft 扩展。
 * 远古版本 JSON 大量字段缺失（无 arguments/无 downloads.client），全部可选；
 * 运行时按"缺什么补什么"的解析器策略处理（Phase 2），契约只声明形状。
 */
export interface VersionJson {
  id: string;
  /** Mojang 类型 + Betacraft 扩展类型。 */
  type?: 'old_alpha' | 'old_beta' | 'release' | 'snapshot' | 'modded' | 'legacy';
  /** ISO 时间戳（发布/编译）。 */
  time?: string;
  releaseTime?: string;
  inheritsFrom?: string;
  mainClass?: string;
  /** 远古单行参数串（`${auth_player_name}` 等占位符）。 */
  minecraftArguments?: string;
  /** 现代结构化参数。 */
  arguments?: VersionArguments;
  /** 资产索引 id（如 `legacy`、`pre-1.6`）。 */
  assets?: string;
  assetIndex?: DownloadArtifact & { id?: string; totalSize?: number };
  /** 客户端 jar（现代格式在 downloads.client；Betacraft 在顶层 jar）。 */
  downloads?: { client?: DownloadArtifact };
  jar?: DownloadArtifact;
  libraries?: LibraryInfo[];
  javaVersion?: { component?: string; majorVersion?: number };
  /** Betacraft 扩展段。 */
  betacraft?: BetacraftExtension;
}

/** 版本清单（version_list 的解析结果形状）。 */
export interface VersionManifest {
  /** 上游生成时间，用于缓存失效判断。 */
  generatedAt?: number;
  versions: VersionRef[];
}
