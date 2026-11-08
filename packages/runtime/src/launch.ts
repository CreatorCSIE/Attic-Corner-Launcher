/**
 * LaunchConfig 拼装器（固定组顺序 + 6 条不变量，由 core-spec 夹具固化）。
 * 路径一律正斜杠字符串拼接——夹具是中性 POSIX 风格，拼装不得有平台假设。
 */

import { INSTANCE_ADDONS, type AgentMount, type LaunchConfig, type VersionJson } from '@attic/core-spec';

import { resolveLaunchAssetIndexId } from './legacyAssets';

/** 拼装输入：宿主侧运行上下文（binPool/versionOrder 由运行时注入）。 */
export interface LaunchContext {
  javaPath: string;
  gameDir: string;
  assetsDir: string;
  dataDir: string;
  username: string;
  uuid: string;
  accessToken: string;
  /** 启动器版本（宿主注入 runtime.version；进游戏侧 token `launcher_version`，须为真实版本）。 */
  launcherVersion: string;
  maxMemoryMb: number;
  minMemoryMb?: number;
  /** `<root>/bin/*.jar` 库池绝对路径清单。 */
  binPool: string[];
  /** 年代序（编译日期升序）的版本 id 数组（agentMount 区间判定用；上游清单行序不可当年代序用）。 */
  versionOrder: string[];
  /** LegacyFix 关卡存档模式（`lf.proxy.levelServer`）：'local'/URL；缺省=LegacyFix 一次性对话框。 */
  levelServer?: string;
  /** 实例 JVM 参数（v1 launchArgs，如 `-Xmx1G`），空白分隔注入 jvmArgs。 */
  launchArgs?: string;
  /** 全局 JVM 参数（launcher.settings `jvmArgs`，设置页「全局 JVM 参数」）：注入在实例参数之前，
   * JVM「后者胜」规则下实例级同名参数可覆盖全局。空白分隔。 */
  globalJvmArgs?: string;
  /** 窗口尺寸（Applet 容器 `--width/--height` 游戏参数；v1 缺省 854x480）。 */
  width?: number;
  height?: number;
  /**
   * Applet 容器 `--appletClass` 显式注入（宿主按本地 jar 探测的结果；rd 代 pre-Classic
   * 仅此通道可起——候选表两个 MinecraftApplet 名在 jar 中皆不存在）；优先于方法数据表。
   */
  appletClass?: string;
  /**
   * Intel 显卡修复（v1 `intelFix` 键语义；win32 门控归宿主 buildContext——非 Windows 恒不注入）。
   * true = jvmArgs 首位 `-XX:HeapDumpPath=java.exe_minecraft.exe.heapdump`（v1 Launcher.java
   * L576-578 紧跟 javapath 之后的首位语义）。
   */
  intelFix?: boolean;
  /** 实例勾选的 addon id 集（宿主从档案透传）；按目录映射注入 -Dlf.* 开关。
   * undefined = 档案无 addons 键（老档案）→ 零注入，行为与 legacyfix 自身缺省一致。 */
  addons?: string[];
  /** 一次性无限地图可视化器（LaunchRequest.visualizer 透传，不写档案）：
   * true = addons 目录映射之后补注 `-Dlf.visualizer`（档案已含 visualizer 时不重复）。 */
  visualizer?: boolean;
  /** 一次性直连地址 `ip[:port]`（LaunchRequest.server 透传，不写档案；启动询问弹窗「直连」才带）：
   * 解析注入 gameArgs `--server <host> --port <n>`（端口恒显式传，缺省 25565 由本侧注入）；
   * 非法格式 = 忽略仅诊断，不拦启动。 */
  server?: string;
  /** 窗口标题自定义（实例档案 Attic 扩展键 title 透传）：trim 后非空 = jvmArgs 追加
   * `-Dlf.title=<title>`（legacyfix-attic fork Agent.java L81-98，DeAWT 与原生 LWJGL 双路强制
   * 窗口标题）；缺键/空白 = 不传该属性，游戏自题。 */
  title?: string;
}

export interface AssembleOptions {
  extraJvmArgs?: string[];
  gameParams?: Record<string, string>;
  onDiagnostic?: (message: string) => void;
}

/**
 * 非代理白名单：BC 代理（.info proxy-args 注入 -Dhttp.proxyHost=betacraft.uk:11707）只服务
 * 老端点（skins.minecraft.net 等），对 textures.minecraft.net 返回 404（直连 200、BC 代理 404）
 * → 皮肤贴图主机必须直通，否则 MinecraftApi.fetchSkin 抛 FileNotFoundException、皮肤缺失。
 */
const NON_PROXY_HOSTS = 'api.betacraft.uk|files.betacraft.uk|checkip.amazonaws.com|textures.minecraft.net';

/** Applet 容器主类（legacyfix）：需要把 javaagent 形态的 jar 本体也送上 classpath。 */
export const APPLET_LAUNCHER_CLASS = 'uk.betacraft.legacyfix.applet.AppletLauncher';

/**
 * Applet 容器子类型 → 游戏参数 `--appletClass`（legacyfix AppletLauncher.java L56 读取，
 * launchEntry 检查直接父类 = java.applet.Applet 则 AppletFrame 嵌入）。
 * 缺省不传 = legacyfix 候选表自动探测（MinecraftApplet 系）；4k-* jar 仅含 M.class，
 * 须显式指定（v1 FkWrapper loadClass("M") 同语义）。表按启动方法键控。
 */
export const APPLET_CLASS_BY_METHOD: Record<string, string> = {
  '4k': 'M',
};

function indexOfOr(list: string[], value: string, fallback: number): number {
  const idx = list.indexOf(value);
  return idx === -1 ? fallback : idx;
}

/**
 * 区间过滤（判定 id：清单序含 id 用 id，否则用 baseVersion）。
 * 判定失败（都不在序中）→ 全保留 + 诊断（fail-open：宁多挂不错挂——legacyfix 挂载本身幂等）。
 */
export function filterAgentMounts(
  mounts: AgentMount[],
  id: string,
  versionOrder: string[],
  baseVersion?: string,
  onDiagnostic?: (message: string) => void,
): AgentMount[] {
  if (mounts.length === 0) return [];
  const judgedId = versionOrder.includes(id) ? id : baseVersion;
  const idxCur = judgedId === undefined ? -1 : versionOrder.indexOf(judgedId);
  if (idxCur < 0) {
    onDiagnostic?.(`agentMount 区间判定失败：${id}（base-version：${baseVersion ?? '无'}）不在版本序中，全部挂载保留`);
    return mounts;
  }
  const last = versionOrder.length - 1;
  return mounts.filter((mount) => {
    const from = mount.appliesFrom ? indexOfOr(versionOrder, mount.appliesFrom, 0) : 0;
    const to = mount.appliesTo ? indexOfOr(versionOrder, mount.appliesTo, last) : last;
    return idxCur >= from && idxCur <= to;
  });
}

/**
 * 从 agentMount 集解析 legacyfix release 版本（文件名 `legacyfix-<version>.jar` = 钉版唯一
 * 事实源，与 betacraft.ensureLegacyfix 同一正则；agent 与 fork addon jar 同 release 同版本）。
 * 空挂载集/解析不出 → null（jar addon 不注入、不落位）。
 */
export function legacyfixReleaseVersion(mounts: AgentMount[]): string | null {
  for (const mount of mounts) {
    const file = mount.path.split('/').pop() ?? '';
    const version = /^legacyfix-(.+)\.jar$/i.exec(file)?.[1];
    if (version) return version;
  }
  return null;
}

function placeholderValues(versionJson: VersionJson, context: LaunchContext): Record<string, string> {
  return {
    auth_player_name: context.username,
    auth_session: context.accessToken,
    auth_access_token: context.accessToken,
    auth_uuid: context.uuid,
    game_directory: context.gameDir,
    assets_root: context.assetsDir,
    assets_index_name: versionJson.assetIndex?.id ?? versionJson.assets ?? 'legacy',
    version_name: versionJson.id,
    version_type: versionJson.type ?? 'release',
    user_type: 'legacy',
    user_properties: '{}',
    launcher_name: 'attic-launcher',
    launcher_version: context.launcherVersion,
    natives_directory: `${context.dataDir}/bin/natives`,
  };
}

/** 展开 `${key}`；未知占位符原样保留（数据缺口可见，不静默吞）。 */
function expandToken(token: string, values: Record<string, string>): string {
  return token.replace(/\$\{([^}]+)\}/g, (whole, key: string) => values[key] ?? whole);
}

export function assembleLaunchConfig(
  versionJson: VersionJson,
  context: LaunchContext,
  opts: AssembleOptions = {},
): LaunchConfig {
  const dataDir = context.dataDir;
  // 主类缺失 = 数据缺口（launch-method 不在表且无显式 main-class），显式报错不静默兜底。
  const mainClass = versionJson.mainClass;
  if (!mainClass) {
    throw new Error(
      `无法确定主类：.info 无 main-class，launch-method "${versionJson.betacraft?.launchMethod ?? '(无)'}" 不在数据表中`,
    );
  }
  // Applet 容器（pre-classic/classic）：classpath 上有 launchwrapper 时 agent 走
  // LaunchWrapperInjector 提前 return，全部补丁（含 proxy/game-dir/classic-resize/deawt）
  // 被跳过且帧永不显示；容器不用 tweaker，剔除即恢复全量挂载。
  // deawt 保持开启（窗口正常）：游戏走 LWJGL 窗口，关窗后进程 MainWindowHandle 归零，
  // 壳侧窗口看门狗据此判定"用户关窗"并 kill（classic 循环不检查 isCloseRequested，进程不自退）。
  const isAppletContainer = mainClass === APPLET_LAUNCHER_CLASS;
  const mounts = filterAgentMounts(
    versionJson.betacraft?.agentMount ?? [],
    versionJson.id,
    context.versionOrder,
    versionJson.betacraft?.baseVersion,
    opts.onDiagnostic,
  );

  // ---------- jvmArgs 固定组（顺序即契约） ----------
  const jvmArgs: string[] = [];
  // v1 intelFix（Launcher.java L576-578）：win32 门控已在宿主 buildContext 完成（非 Windows 恒 false），
  // 注入位 = 固定组最前（v1「紧跟 javapath」首位语义）。
  if (context.intelFix) jvmArgs.push('-XX:HeapDumpPath=java.exe_minecraft.exe.heapdump');
  jvmArgs.push(`-Xmx${context.maxMemoryMb}m`);
  if (context.minMemoryMb !== undefined) jvmArgs.push(`-Xms${context.minMemoryMb}m`);
  // 组序契约：固定堆参数 → 全局 JVM 参数（settings.jvmArgs）→ 实例 launchArgs。
  for (const token of (context.globalJvmArgs ?? '').trim().split(/\s+/)) {
    if (token) jvmArgs.push(token);
  }
  // v1 语义：实例 launchArgs（如 "-Xmx1G"）紧随固定 -Xmx 注入——JVM 对重复 -Xmx 取后者，实例覆盖全局。
  for (const token of (context.launchArgs ?? '').trim().split(/\s+/)) {
    if (token) jvmArgs.push(token);
  }
  // 实例 addons → legacyfix 开关（目录 INSTANCE_ADDONS）：enable 勾选注入 / disable 取消注入。
  // addons=undefined（老档案无键）零注入 = legacyfix 自身缺省行为，不擅自改写。
  // addonAsset 项走 jar 形态通道（下方 -Dlf.addons=），不吃属性开关。
  if (context.addons) {
    for (const def of INSTANCE_ADDONS) {
      if (def.addonAsset) continue;
      const on = context.addons.includes(def.id);
      if ((def.mode === 'enable') === on) jvmArgs.push(`-Dlf.${def.prop}`);
    }
    // jar 形态 addon（fork AddonLoader）：勾选集 → `-Dlf.addons=<逗号分隔绝对路径>` 单条注入。
    // 路径 = launcher/addons/<构件基名>-<agent 钉版>.jar（版本唯一事实源 = agentMount 文件名，
    // 与宿主下载链同源）；无 agent 挂载（版本在区间外）→ 不注入 + 诊断（addon 依赖 agent 在场）。
    // AddonLoader 语义 = 逗号分隔路径逐项加载（.jar 结尾按文件，不扫目录），坏 addon 只跳过不炸 agent。
    const jarDefs = INSTANCE_ADDONS.filter((d) => d.addonAsset && context.addons!.includes(d.id));
    if (jarDefs.length > 0) {
      const lfVersion = legacyfixReleaseVersion(mounts);
      if (!lfVersion) {
        opts.onDiagnostic?.('jar addon 已勾选但当前版本无 legacyfix 挂载，未注入 -Dlf.addons');
      } else {
        const paths = jarDefs.map((d) => `${dataDir}/launcher/addons/${d.addonAsset}-${lfVersion}.jar`);
        jvmArgs.push(`-Dlf.addons=${paths.join(',')}`);
      }
    }
  }
  // 一次性可视化器（LaunchRequest.visualizer，菜单动作项）：同位补注；档案已含则上面已注入，不重复。
  if (context.visualizer && !context.addons?.includes('visualizer')) jvmArgs.push('-Dlf.visualizer');
  jvmArgs.push('-Djava.util.Arrays.useLegacyMergeSort=true');
  // 注：-Dsun.java2d.dpiaware 对 applet 容器高 DPI 窗口右下偏移无效——该 Oracle JDK8
  // 扩展属性只影响 Java2D 字体/渲染缩放，不影响 LWJGL 原生窗 SetWindowPos 坐标语义，勿注入。
  // 根因（DeAwtPatch 注入体不交接 frame 位置 + LWJGL getWindowX/Y 混源居中公式）已在 fork
  // 源码层修复（legacyfix-attic DeAwtPatch.java 注入体 Display.setLocation(frame.getX(), frame.getY())），
  // 启动器层二进制常量池补丁随切源退役。
  jvmArgs.push(`-Dhttp.nonProxyHosts=${NON_PROXY_HOSTS}`);
  const natives = `${dataDir}/bin/natives`;
  jvmArgs.push(`-Dorg.lwjgl.librarypath=${natives}`);
  jvmArgs.push(`-Dnet.java.games.input.librarypath=${natives}`);
  for (const arg of versionJson.betacraft?.proxyArgs ?? []) jvmArgs.push(arg);
  // 属性优先于 gameDir/legacyfix/level-server.txt（LevelProxyConfig 源码）：
  // 设置里有值即直通覆盖，用户无需删 txt 重触发一次性对话框；缺省不传，保留 LegacyFix 原行为。
  if (context.levelServer) jvmArgs.push(`-Dlf.proxy.levelServer=${context.levelServer}`);
  // 窗口标题自定义（档案 title 透传，trim 后非空即传；args 数组直传无需引号转义）：
  // fork Agent.java L81-98 = DeAWT 与原生 LWJGL 双路强制标题，且注册在 DeAwtPatch setTitle 钩
  // 之后——getTitle 捕获仍得游戏原题（按标题的版本探测不受影响）。缺键/空白 = 不传，游戏自题。
  const lfTitle = context.title?.trim();
  if (lfTitle) jvmArgs.push(`-Dlf.title=${lfTitle}`);
  // 版本钉：legacyfix 的按版本等值补丁（Classic15aServerPortPatch.shouldApply 判
  // lf.version=="c0.0.15a"）在 Agent.premain 的 Patcher.apply 决策——早于 main 的 --version
  // 解析与游戏窗口标题探测（两条晚到的注入通道都追不上决策点）。-Dlf.* 走 Agent 静态块
  // 系统属性收集（Agent.java L237-242），premain 前即入 SETTINGS = 唯一确定通道。
  // 数据表键控原则：值取 versionJson.id，无版本判断代码。
  jvmArgs.push(`-Dlf.version=${versionJson.id}`);
  // legacyfix GameArgs.getAssetsDir() 缺省回退 = cwd 相对 "assets"（即 gameDir/assets），读不到启动器共享资产根
  // （声音 NPE）。官方提示通道 -Dlf.assetsDir 显式钉死共享根，initAssets 的 objects 路径随之前移。
  jvmArgs.push(`-Dlf.assetsDir=${context.assetsDir.replace(/\\/g, '/')}`);
  // 资产索引钉死（BC v2 语义：每版本 JSON 权威 assetIndex.id）。legacyfix 运行时标题探测
  // （ProxyPatch→setVersion→resolveIndex）无条件覆写 GameArgs.assetIndex 静态字段，标题变换串
  // （如 0130 标题 "Minecraft 0.31"→c0.31→20100124）与预取的版本 ID 表结果（in-.+→20100212）不同源
  // → objects 错配、部分声音缺失。-Dlf.assetIndex 走 Agent SETTINGS 通道（Agent.java 收 lf.* 系统属性），
  // getAssetIndexPath/getAssetIndexId 优先读它、标题探测覆写不到 → 与预取同源。
  // legacyfix isInvalidIndex 语义：'legacy'/'pre-1.6' 不注入（保留 legacyfix 缺省行为）。
  const assetIndexId = resolveLaunchAssetIndexId(versionJson);
  if (assetIndexId && assetIndexId !== 'legacy' && assetIndexId !== 'pre-1.6') {
    jvmArgs.push(`-Dlf.assetIndex=${assetIndexId}`);
  }
  for (const mount of mounts) {
    if (mount.form === 'javaagent') jvmArgs.push(`-javaagent:${dataDir}/${mount.path}=${context.gameDir}`);
  }
  if (opts.extraJvmArgs) jvmArgs.push(...opts.extraJvmArgs);

  // ---------- classpath：版本 jar（平铺）+ bin 整池 ----------
  const binPool = isAppletContainer
    ? context.binPool.filter((jar) => !/launchwrapper[^/\\]*\.jar$/i.test(jar))
    : context.binPool;
  const classpath = [`${dataDir}/versions/${versionJson.id}.jar`, ...binPool];
  // Applet 容器（<a1.0.6）：legacyfix jar 必须同时在 classpath 上才有 AppletLauncher 类。
  if (isAppletContainer) {
    for (const mount of mounts) {
      if (mount.form === 'javaagent') classpath.push(`${dataDir}/${mount.path}`);
    }
  }

  // ---------- gameArgs ----------
  const values = placeholderValues(versionJson, context);
  let gameArgs: string[];
  const template = versionJson.minecraftArguments?.trim();
  if (template) {
    gameArgs = template.split(/\s+/).map((token) => expandToken(token, values));
  } else {
    // v1 classic/beta 位置参：username sessionid
    gameArgs = [context.username, context.accessToken];
  }
  if (opts.gameParams) {
    for (const [key, value] of Object.entries(opts.gameParams)) {
      gameArgs.push(`--${key}`, value);
    }
  }
  // 一次性直连（启动询问弹窗「直连」，LaunchRequest.server 透传，不写档案）：legacyfix GameArgs
  // 消费 --server/--port。**端口恒显式传**（缺省 25565 由本侧注入）：CLI --server 路径端口缺省 = -1
  // （GameArgs.getServerPort()），游戏自动加入要求 server+port 参数齐（带 --port 真实发起 TCP 连接；
  // 缺 --port 直进单人）。25565 缺省只存在于 readServer（-Dlf.server 属性路径），不吃 CLI 路径。
  // 非法格式 = 忽略（诊断），不拦启动；插入位 = gameParams 之后、Applet --width/--height 之前。
  if (context.server) {
    const m = /^([^:/\s]+)(?::(\d{1,5}))?$/.exec(context.server.trim());
    const host = m?.[1];
    const port = m?.[2];
    if (host && (port === undefined || (Number(port) >= 1 && Number(port) <= 65535))) {
      gameArgs.push('--server', host, '--port', port ?? '25565');
    } else {
      opts.onDiagnostic?.(`[attic-launch] 直连地址格式非法，已忽略：${context.server}`);
    }
  }
  // Applet 容器窗口尺寸（AppletFrame.java L24-25 读 --width/--height，缺省兜底 640x480）：
  // 实例值以 v1 缺省 854x480 显式传入；非 Applet 版本窗口由 LWJGL/DeAwt 自管，不注入（避免污染主类参数解析）。
  if (isAppletContainer && context.width && context.height) {
    gameArgs.push('--width', String(context.width), '--height', String(context.height));
  }
  // Applet 子类型指定（4k-* → --appletClass M；pre-Classic → 宿主按 jar 探测注入 RubyDung）。
  // 注入值优先于方法表：rd 系 launch-method 同键（preclassic）但 jar 形态跨两代类名，表无法表达。
  // deawt 保持缺省开启（4k 纯 AWT 渲染是否需 -Dlf.deawt.disable 以实机窗口测试为准）。
  if (isAppletContainer) {
    const appletClass =
      context.appletClass ??
      (versionJson.betacraft?.launchMethod ? APPLET_CLASS_BY_METHOD[versionJson.betacraft.launchMethod] : undefined);
    if (appletClass) gameArgs.push('--appletClass', appletClass);
  }

  const config: LaunchConfig = {
    javaPath: context.javaPath,
    gameDir: context.gameDir,
    assetsDir: context.assetsDir,
    mainClass,
    classpath,
    jvmArgs,
    gameArgs,
    agentMount: mounts,
    maxMemoryMb: context.maxMemoryMb,
  };
  if (context.minMemoryMb !== undefined) config.minMemoryMb = context.minMemoryMb;
  return config;
}
