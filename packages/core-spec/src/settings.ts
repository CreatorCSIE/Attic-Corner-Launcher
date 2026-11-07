/**
 * 应用设置与实例的渲染侧契约。
 * 设置/实例是数据，落盘走宿主 `launcher.settings` / `instances/*.txt`（v1 格式兼容）；
 * 渲染侧只通过本契约读写，绝不直接碰文件。
 * 本文件与 ipc.ts 通道、runtime 映射、docs/contract.md 四处同步。
 */

/** 主题模式（持久化以便双壳一致；解析/应用属渲染侧）。 */
export type ThemeMode = 'dark' | 'light' | 'system';

/** 内存分配模式（BlockHelm 语义移植）：auto = 宿主按总内存估算；manual = 用 maxMemoryMb。 */
export type MemoryMode = 'auto' | 'manual';

/**
 * 更新自动检查策略（缺省 `startup`）：`startup` = 启动时自动检查一次；`off` = 从不自动检查。
 * 只约束自动检查链——关于页手动「检查更新」按钮两策略下恒可用。
 */
export type UpdatePolicy = 'startup' | 'off';

/**
 * 端点覆盖：全部为可 IPC 序列化的纯字符串。
 * 函数形态的 `versionJson(id)`/`assetIndex(id)` 由 `filesBase` 在 runtime 侧派生，
 * 契约层不携带可调用形状（跨进程不可序列化）。
 */
export interface EndpointOverrides {
  /** 版本清单 URL；缺省 = `<filesBase>/version_list.txt`。 */
  versionList?: string;
  /** Betacraft files 基址（派生 versionJson/assetIndex）；缺省 = `http://files.betacraft.uk/launcher/assets`。 */
  filesBase?: string;
  /** legacyfix GitHub Release API；缺省 = betacraftuk/legacyfix latest。 */
  legacyfixRelease?: string;
  /** Azul Zulu 元数据 API。 */
  zuluMetadata?: string;
  /** Betacraft mod 仓库列表（getmods.jsp JSON）；缺省 = `http://api.betacraft.uk/getmods.jsp`。 */
  modsList?: string;
  /** Betacraft 社区服务器列表页（HTML，POST）；缺省 = `http://api.betacraft.uk/v2/legacy_server_list`。 */
  serverList?: string;
}

/** 全局应用设置（`launcher.settings` 的渲染侧视图；缺省字段 = 沿用宿主默认）。 */
export interface AppSettings {
  /** 手动 Java 路径；缺省 = 自动探测（探测失败再 Zulu 供给）。设置即手动模式，清空即回自动（Java 栏双态由此派生）。 */
  javaPath?: string;
  /** 堆内存上限 MB；缺省 = 1024（memoryMode=auto 时被宿主估算值取代）。 */
  maxMemoryMb?: number;
  /** 内存分配模式；缺省 = manual（保持老用户/老档案既有的定值 1024 语义，auto 属 opt-in）。 */
  memoryMode?: MemoryMode;
  /** 主题；缺省 = system。 */
  theme?: ThemeMode;
  /** 启动器界面语言（i18n locale 键，如 `zh-CN`/`en`/`zh-TW`）；缺省 = 渲染侧一次性
   *  系统语言侦测并写回本键落盘（此后等同用户选择，不再自动改）。热切换生效，无重启语义。 */
  language?: string;
  /**
   * 全局 JVM 参数（BlockHelm 语义：固定 `-Xmx/-Xms` 之后、实例 launchArgs 之前注入，
   * 实例级同名参数按 JVM「后者胜」规则覆盖全局）。空白分隔。
   */
  jvmArgs?: string;
  /** 启动前复核版本 jar sha1；缺省 true。false = 本地存在即复用（大 jar 省哈希时间，坏文件不发现）。 */
  checkIntegrity?: boolean;
  /** 缺失/损坏自动补全（重下载）；缺省 true，仅在 checkIntegrity 生效时有意义。false = 发现问题显式报错，不擅动文件。 */
  fixMissing?: boolean;
  /** 启动成功后最小化主窗（宿主窗行为）；缺省 false。 */
  minimizeOnLaunch?: boolean;
  /** 诊断日志：每次启动都写 launcher/logs（普通启动也落盘，testLaunch 通道不受此开关影响恒写）；缺省 false。 */
  diagnosticLog?: boolean;
  /**
   * 启动成功后自动打开独立控制台窗（v1「Game log」开关的全局化：判定为用户习惯而非实例属性）；
   * 缺省 true = 维持"每次启动弹窗"行为。testLaunch 不受此开关影响恒弹（显式诊断语义）。
   */
  consoleOnLaunch?: boolean;
  /**
   * 数据根覆盖（更换目录逃生舱）：下次启动应用后生效——root 属构造级配置，
   * 宿主启动时从平台默认根的 launcher.settings 读本键。portable/env 覆盖优先级更高。
   */
  rootOverride?: string;
  /**
   * 首启欢迎向导完成标记（完成与跳过皆写此键——"已见过向导"语义收敛于此，
   * 与 rootOverride 指针职责分离，防「跳过不写指针 → 反复弹」）。
   * 弹出口径：无此键 且 无 rootOverride 且 默认根无既有数据 → 弹。缺省 false（缺键）。
   */
  wizardDone?: boolean;
  /**
   * 首启向导完成标记的形态戳：portable 只读回落与安装版共享默认根 `%APPDATA%\.attic`，
   * 无 flavor 戳则先完成者压掉后者弹窗、数据在错误形态下静默共用。
   * 完成判定 = 「无**本 flavor** 完成标记」；存量 `wizardDone=true` 无戳 = 视为 installed。
   * 向导完成/跳过时随 `wizardDone` 一并写。
   */
  wizardFlavor?: 'installed' | 'portable';
  /**
   * 便携面包屑：portable 激活时把生效根登记进**平台默认根** settings
   * （默认根永远可达，天然是登记簿）。启动发现生效根≠面包屑 ∧ 面包屑根有数据 → UI 找回提示
   * （ini `rootDir` 自定义后指针丢失的兜底出路）。portable 激活时 `getSettings` 回读恒取默认根位。
   */
  lastPortableRoot?: string;
  /**
   * 只读回落标记：exeDir 实写探针不可写 → 生效根回落默认根 + 本键置真，
   * UI 头区常驻徽标「数据未随盘」（一次性告知会被第二台只读机静默复用）。runtime 回落时自动写。
   */
  portableFallback?: boolean;
  /**
   * LegacyFix 关卡存档模式（JVM 属性 `lf.proxy.levelServer` 直通）：
   * `local`=强制本地单人存档；URL=在线关卡代理；缺省=LegacyFix 一次性对话框。
   * 有值时对话框永不弹，且覆盖游戏目录里陈旧的 `legacyfix/level-server.txt`（属性优先于文件）。
   */
  levelServer?: string;
  /**
   * 更新自动检查策略；缺省 `startup`（缺键 = 消费端 `?? 'startup'`）。
   * 只约束自动检查（启动时一次，无轮询）；手动「检查更新」不受此键约束恒可用。
   */
  updatePolicy?: UpdatePolicy;
  /**
   * 「忽略此版本」单槽账：自动检查命中 `update` 且版本等于本值 → 不弹窗、不打红点（全静默）。
   * 手动检查无视此账恒显结果。缺省 undefined = 无忽略。
   */
  updateIgnoreVersion?: string;
  /**
   * 提前体验测试版（HMCL「提前预览」语义，plan「测试版通道与更新执行面」条②）：
   * 开 = 交互检查链数据源切至 Releases 列表端点，候选集 = stable ∪ nightly 轨
   * （prerelease ∧ 非 draft ∧ 含 `-nightly.`）取最大；关/缺省 = stable 单轨照旧。
   * nightly 构件恒在轨中（形态判据 ∨ 开关判据并集，与本键无关）；
   * 静默通道 latest.json 恒只收 stable，不受本键影响。
   */
  updatePreview?: boolean;
  /** 端点覆盖；改动在下次启动应用后生效（端点属构造级配置）。 */
  endpoints?: EndpointOverrides;
  /**
   * 强调色板 id（见 `ACCENT_COLORS`；缺省 = `amber` 火把琥珀）。
   * 契约只持久化 id，色值属渲染侧 tokens.css 的 `[data-accent]` 静态层（零运行时计算）。
   */
  accentColor?: string;
  /**
   * 主界面背景图绝对路径（仅配置时启用；缺省/空 = 主题纯色背景，无内置默认图）。
   * 渲染侧经 `IMAGE_DATA_URL` 通道让宿主读字节转 data URL（双壳统一）；
   * 文件不可读时 UI 回落纯色（可见失败由选择动作当场承担，应用侧静默兜底）。
   */
  backgroundImage?: string;
  /**
   * 微软登录 CLIENT_ID 覆盖值（开发者设置面；空 = 用 runtime 内嵌缺省值）。
   * CLIENT_ID 是 public client 公开标识符、非机密；
   * 此键供自注册 Azure 应用先行实机验证，官方值随发布内嵌后一般无需触碰。
   */
  microsoftClientId?: string;
}

/**
 * 强调色板目录（数据驱动；色值取 Modrinth 主题方案 variables.scss 六族，
 * Attic 暖木炭/羊皮纸底色与文字 token 独立，缺省火把琥珀 amber = 第一格）。
 * id 落 settings.accentColor；nameKey 供 i18n 标签。
 * swatch = 色板预览圆点色（dark 主题基准色，UI 端按当前主题自行选档亦可，此值仅预览用）。
 */
export interface AccentColorDef {
  id: string;
  nameKey: string;
  swatch: string;
}

export const ACCENT_COLORS: AccentColorDef[] = [
  { id: 'amber', nameKey: 'settings.theme.accentNames.amber', swatch: '#e8a33d' },
  { id: 'green', nameKey: 'settings.theme.accentNames.green', swatch: '#1bd96a' },
  { id: 'blue', nameKey: 'settings.theme.accentNames.blue', swatch: '#4f9cff' },
  { id: 'orange', nameKey: 'settings.theme.accentNames.orange', swatch: '#ffa347' },
  { id: 'purple', nameKey: 'settings.theme.accentNames.purple', swatch: '#c78aff' },
  { id: 'red', nameKey: 'settings.theme.accentNames.red', swatch: '#ff496e' },
  { id: 'gray', nameKey: 'settings.theme.accentNames.gray', swatch: '#9fa4b3' },
];

/**
 * 预设主题目录（数据驱动，推导式）：
 * 预设只是 `theme + accentColor` 组合的快捷写入，**不新增落盘键**——当前预设由
 * 两控件现值反查本目录推导（全等命中 = 该预设；任何不匹配 = 「自定义」态，
 * 自定义态天然由既有独立控件承载并已落盘）。背景图不进预设面，不受影响。
 */
export interface ThemePresetDef {
  id: string;
  nameKey: string;
  theme: ThemeMode;
  accentColor: string;
}

export const THEME_PRESETS: ThemePresetDef[] = [
  { id: 'attic', nameKey: 'settings.theme.presetNames.attic', theme: 'system', accentColor: 'amber' },
  { id: 'modrinth', nameKey: 'settings.theme.presetNames.modrinth', theme: 'dark', accentColor: 'green' },
];

/**
 * 实例的渲染侧视图——对齐 v1 Instance Settings 可编辑集（名字/版本/目录/JVM 参数/窗口尺寸/Java 路径）。
 * 版本是实例属性（v1 `InstanceSettings` 语义：同实例切版本存档共享）。gameDir 缺省 = 宿主派生
 * `root/<实例名>`（v1 `Instance.newInstance`）；内存另有全局设置，实例 `launchArgs` 在其后注入（后者生效）。
 */
export interface InstanceView {
  name: string;
  version: string;
  /** 游戏目录；缺省 = `root/<实例名>`。 */
  gameDir?: string;
  /** JVM 参数（v1 `launchArgs`，如 `-Xmx1G`），空白分隔注入 jvmArgs。 */
  launchArgs?: string;
  /** 窗口宽（Applet 容器 `--width`；v1 缺省 854）。 */
  width?: number;
  /** 窗口高（Applet 容器 `--height`；v1 缺省 480）。 */
  height?: number;
  javaPath?: string;
  /** 勾选的 addon id 集（v1 `addons` 档案键 = 逗号分隔；视图用数组，宿主序列化）。 */
  addons?: string[];
  /**
   * Intel 显卡修复（v1 `intelFix` 档案键，同名；v1 缺省 true）。Windows 上注入
   * `-XX:HeapDumpPath=java.exe_minecraft.exe.heapdump`（v1 原样），其余平台宿主不注入。
   * 缺键 = true（v1 语义）。
   */
  intelFix?: boolean;
  /**
   * 强制更新（Attic 扩展键；v1 是全局 static，本设计判定为实例属性落实例）。
   * true = 启动时旁路 jar/库/资产的「已存在即复用」检查重下。
   */
  forceUpdate?: boolean;
  /**
   * 多人直连地址 `ip[:port]`（Attic 扩展键，原样存；v1 无对应物）。非空 = 启动页询问
   * 「直连/单人」，直连走 `LaunchRequest.server` 一次性注入，**本键只在弹窗里被读、
   * 不因启动而改写**；缺键/空 = 仅当选中版本命中 `MULTIPLAYER_JOIN_LAUNCH_METHODS`
   * （经典多人 launchMethod 数据表）时仍询问（弹窗现场填地址、一次性），否则直接单人启动。
   */
  server?: string;
}

/**
 * 解析直连地址 `ip[:port]`（UI 校验/展示共用；runtime 拼装器侧解析语义一致）：
 * host 非空无冒号无空白，端口可选 1-65535；非法 = null。
 */
export function parseServerAddress(raw: string): { host: string; port?: number } | null {
  const m = /^([^:/\s]+)(?::(\d{1,5}))?$/.exec(raw.trim());
  const host = m?.[1];
  if (!m || !host) return null;
  const port = m[2] !== undefined ? Number(m[2]) : undefined;
  if (port !== undefined && (port < 1 || port > 65535)) return null;
  return { host, ...(port !== undefined ? { port } : {}) };
}

/**
 * 实例 addon 目录（数据驱动）：id 入 v1 `addons` 档案键，
 * prop/mode 映射 legacyfix 的 -Dlf.* 开关（事实源：legacyfix docs/Additional settings.md）。
 * mode=enable：勾选才注入 prop；mode=disable：取消才注入（功能默认开，如皮肤/代理）。
 * placeholder：v1 addons 有、legacyfix 无对应开关 → UI 占位禁用，不参与装配。
 * uiSection：渲染归属——'basic'=实例页基本设置 card，'launchmenu'=启动页「≡」菜单
 * （动作项：点击 = `LaunchRequest.visualizer` 一次性启动，不读写档案），缺省 'addons'=Addons card。
 * 仅影响 UI 布局，数据模型不变。
 * probeClass：launchmenu 项的启用前置探测（选中版本 client jar 需含此 class 条目才可点击）。
 */
export interface AddonDef {
  id: string;
  /** legacyfix JVM 属性名（不含 `-Dlf.` 前缀）；placeholder 项为空串。 */
  prop: string;
  mode: 'enable' | 'disable';
  placeholder?: boolean;
  uiSection?: 'basic' | 'addons' | 'launchmenu';
  /** jar 内条目路径（如 `net/minecraft/isom/IsomPreviewApplet.class`）；uiSection=launchmenu 时提供。 */
  probeClass?: string;
  /**
   * jar 形态 addon 的 release 构件基名（如 `legacyfix-addon-fullscreen`；实际 asset =
   * `<基名>-<agent 钉版>.jar`）。有值 = fork AddonLoader 外部 addon：勾选不注入 `-Dlf.<prop>`
   * 属性，而是把 `<dataDir>/launcher/addons/<基名>-<版本>.jar` 绝对路径汇入 `-Dlf.addons=`
   * （逗号分隔单条）；jar 本体随 agent 同 release 同版本由宿主下载链落位。
   */
  addonAsset?: string;
}

export const INSTANCE_ADDONS: AddonDef[] = [
  // 基本设置 card（v1 实例对话框常用项）
  { id: 'vsync', prop: 'vsync', mode: 'enable', uiSection: 'basic' },
  { id: 'proxy', prop: 'proxy.disable', mode: 'disable', uiSection: 'basic' },
  { id: 'skins', prop: 'skin.disable', mode: 'disable', uiSection: 'basic' },
  { id: 'server-auth', prop: 'auth-on-server-join.disable', mode: 'disable', uiSection: 'basic' },
  // Addons card
  { id: 'modloader', prop: 'modloader', mode: 'enable' },
  { id: 'beta-forge', prop: 'beta-forge', mode: 'enable' },
  { id: 'bouncycastle', prop: 'bouncycastle', mode: 'enable' },
  { id: 'show-notice', prop: 'showNotice', mode: 'enable' },
  // legacyfix 原生 -Dlf.demo 即等价开关（GameArgs.isDemo）；
  // 官方生效区间 12w16a–1.5.2，区间外该属性无感
  { id: 'demo', prop: 'demo', mode: 'enable' },
  // legacyfix IntelGraphicsPatch：glActiveTexture 前补发 glClientActiveTexture，
  // 修老 Intel GPU 多纹理渲染错乱（b1.9–1.7.10）；opt-in 默认关
  { id: 'intel', prop: 'intel', mode: 'enable' },
  // v1 addons 转正（fork legacyfix-attic 外部 addon jar，AddonLoader 经 -Dlf.addons= 装载；
  // 上游矩阵确认无对应 Patch = 真缺口，fork 任务 B 首批三枚）
  // fullscreen 终局结论（2026-11-07，attic.7 落码 a8196b2/86725af）：DeAWT 下可见窗口
  // 归启动器、游戏 JVM 内无 java.awt.Frame 可达 = agent 侧全屏设计性不可达，
  // addon 在该路径静默 no-op；仅非 DeAWT（-Dlf.deawt.disable=true / 原生 LWJGL）有效，
  // DeAWT 主路径全屏归启动器侧职责（挂账）
  { id: 'fullscreen', prop: '', mode: 'enable', addonAsset: 'legacyfix-addon-fullscreen' },
  { id: 'game-mode-switch', prop: '', mode: 'enable', addonAsset: 'legacyfix-addon-gamemodeswitch' },
  { id: 'quit-game', prop: '', mode: 'enable', addonAsset: 'legacyfix-addon-quitgame' },
  // 启动页「≡」菜单动作项（探测到类才可点击；点击 = LaunchRequest.visualizer 一次性注入，
  // 档案 addons 仍可携带同 id = 常开语义，装配器去重不双注）
  {
    id: 'visualizer',
    prop: 'visualizer',
    mode: 'enable',
    uiSection: 'launchmenu',
    probeClass: 'net/minecraft/isom/IsomPreviewApplet.class',
  },
];

/** 新建实例的默认勾选集 = 默认开功能全开（与 legacyfix 自身缺省一致）。 */
export const DEFAULT_ADDONS: string[] = INSTANCE_ADDONS.filter((a) => a.mode === 'disable' && !a.placeholder).map((a) => a.id);
