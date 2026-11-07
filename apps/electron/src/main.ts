import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron';
import {
  IPC_CHANNELS,
  IPC_EVENTS,
  type AppSettings,
  type AtticEventPayloads,
  type CrashBundleResult,
  type RendererErrorReport,
  type CustomVersionView,
  type GameBacklog,
  type GameExitEvent,
  type GameOutputEvent,
  type InstanceView,
  type IpcResult,
  type LaunchRequest,
  type ModInstallRequest,
  type PickTarget,
  type SpecialDir,
  type UpdateApplyRequest,
  type WindowAction,
} from '@attic/core-spec';
import {
  AtticRuntime,
  CRASH_DIALOG_STACK_MAX,
  PORTABLE_DIR_NAME,
  attachConsoleCapture,
  isPathWithin,
  launcherDir,
  loadSettings,
  looksLikeTempExtraction,
  resolveDataRoot,
} from '@attic/runtime';

/** 宿主安装目录（卸载器 {app} 射程 = 数据根禁入区）：产线 = exe 同目录，也是 portable 判定的 exeDir。 */
const INSTALL_DIR = path.dirname(process.execPath);

/** portable marker 位（electron/legacy 两壳 zip 出厂同键；判定与指针读写单点在 runtime）。 */
const PORTABLE_MARKER = 'resources/portable.ini';

/** Releases 页（temp 守卫指路位；与关于页 REPO_URL 同源）。 */
const RELEASES_URL = 'https://github.com/CreatorCSIE/Attic-Corner-Launcher/releases';

/**
 * temp 守卫：防压缩包内直接双击——只抽 exe 到 temp → marker 没跟出来判成安装态写 %APPDATA%；
 * 整目录抽到 temp → 数据随 temp 蒸发。
 * 特征 = exeDir 命中 %TEMP%/%TMP% 前缀或 Rar$/7z$/WinRar$ 段 ∧ exe 旁无既有 `.attic` → boot 拒建主窗。
 */
const tempTrap = looksLikeTempExtraction(INSTALL_DIR) && !fs.existsSync(path.join(INSTALL_DIR, PORTABLE_DIR_NAME));

/**
 * 数据根覆盖引导：设置页「更换数据根」写的是平台默认根 launcher.settings 的 rootOverride
 * （root 属构造级配置，运行期不换根）——启动时从默认根 peek 一次，指过去即完成迁移式切换。
 * 优先级口径 = rootDirOverride > portable > 默认（storage.ts）：portable 形态的随身指针不住这里
 * （住 marker ini 的 rootDir，两形态各写各的指针面），本 peek 只服务安装形态。
 * 兜底护栏（与 runtime.setSettings 道闸同款）：手改 settings 把根指进安装目录 = 卸载清存档
 * 的不可逆事故 → 忽略该指针回落默认根（setSettings 入口拦新写入，本处拦存量手改）。
 */
function bootstrapRootDir(): string | undefined {
  try {
    const override = loadSettings(resolveDataRoot())['rootOverride'];
    if (!override) return undefined;
    if (isPathWithin(INSTALL_DIR, override)) {
      console.warn('[attic] rootOverride 位于安装目录内，卸载会删除数据——本次已忽略该指针，回落默认根');
      return undefined;
    }
    return override;
  } catch {
    return undefined; // 首启无 settings = 走平台默认根
  }
}

/** TS 启动器核心门面：主进程唯一实例。exeDir 显式传（portable 双指纹判定面，硬纪律）。 */
const runtime = new AtticRuntime({
  rootDir: bootstrapRootDir(),
  version: app.getVersion(),
  installDir: INSTALL_DIR,
  exeDir: INSTALL_DIR,
  portableMarkers: [PORTABLE_MARKER],
});


// —— 启动器层崩溃处理——
// 真崩溃 = win32 原生 dialog（渲染栈不可信场景唯一可靠出口）：先展示错误栈，再给三按钮
// 【复制诊断信息 / 打开日志文件夹 / 去 GitHub 报告】；bundle 全量落 crash-<ISO>.txt。
// 非致命/事后 = Vue CrashPanel（CRASH_* 通道）+ 下次启动横幅（脏退出标记经 SYS_INFO 投出）。

/** 重入闸：级联异常只弹一次框（第二次直接退，防 dialog 风暴钉死进程）。 */
let crashReported = false;

function reportLauncherCrash(
  category: string,
  error: unknown,
  opts: { /** true = 崩溃后必退；false = 现场报告后继续活（渲染窗事故）。 */ exit: boolean; /** gone 恢复路径：弹框后重载该窗。 */ reloadWin?: BrowserWindow },
): void {
  if (crashReported) {
    if (opts.exit) app.exit(1);
    return;
  }
  crashReported = true;
  const stack = error instanceof Error ? (error.stack ?? error.message) : String(error);
  runtime.appendLauncherLog('err', `[${category}] ${stack}`);
  const { text, issuesUrl } = runtime.crashBundleResult(category, stack);
  const logsDir = path.join(launcherDir(runtime.root), 'logs');
  try {
    fs.mkdirSync(logsDir, { recursive: true });
    fs.writeFileSync(path.join(logsDir, `crash-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`), text, 'utf8');
  } catch {
    /* bundle 落盘失败不拦对话框主流程 */
  }
  // 脏退出标记只给「当场退」的崩溃写（下次启动横幅数据源）。
  if (opts.exit) runtime.markCrashExit(category, stack);
  let choice = 0;
  try {
    choice = dialog.showMessageBoxSync({
      type: 'error',
      title: 'Attic 启动器崩溃',
      message: opts.exit ? '启动器遇到意外错误，即将退出' : '启动器窗口遇到意外错误',
      // 栈先行：detail 首段 = 崩溃栈截断，全量在 crash-*.txt。
      detail: `${stack.slice(0, CRASH_DIALOG_STACK_MAX)}\n\n完整诊断包已写入 launcher/logs/crash-*.txt`,
      buttons: ['复制诊断信息', '打开日志文件夹', '去 GitHub 报告'],
      defaultId: 0,
      cancelId: 0, // 关框 = 复制诊断（最中性动作，剪贴板不丢现场）
      noLink: true,
    });
  } catch {
    /* app 未 ready 等极端场景弹不出框：现场已落盘，直接走退出 */
  }
  if (choice === 1) void shell.openPath(logsDir);
  else if (choice === 2 && issuesUrl) {
    // 报告流程：先把 bundle 写剪贴板，再开预填 issue 链接——正文直接粘贴。
    clipboard.writeText(text);
    void shell.openExternal(issuesUrl);
  } else clipboard.writeText(text);
  if (opts.exit) {
    // app.exit 不触发 before-quit（L541 的 kill 被跳过）= 游戏进程孤儿：崩溃硬退前手动收敛一次。
    if (runtime.status().running) void runtime.kill().catch(() => undefined);
    // 给 kill 派发与 openPath/openExternal 的 OS 级留一拍再硬退（clipboard 为同步写，不丢）。
    setTimeout(() => app.exit(1), 500);
  } else if (opts.reloadWin && !opts.reloadWin.isDestroyed()) {
    crashReported = false; // 渲染窗事故恢复后允许下一次崩溃再报
    opts.reloadWin.reload();
  } else {
    crashReported = false; // unresponsive 等可恢复场景：闸复位
  }
}

/** 主进程未捕获异常/拒绝 = 取证 + 原生框 + 退（handle() 封装器不覆盖异步裸抛，本钩子是最后防线）。 */
process.on('uncaughtException', (error) => reportLauncherCrash('uncaught-exception', error, { exit: true }));
process.on('unhandledRejection', (reason) => reportLauncherCrash('unhandled-rejection', reason, { exit: true }));

/** launcher.log 跨启动滚动源：主进程 stdout/stderr 全量镜像（Electron 壳专属——sidecar stdout 是协议面，绝不挂）。 */
attachConsoleCapture((stream, text) => runtime.appendLauncherLog(stream, text));

/** 渲染进程事故（gone = 弹框取证后重载恢复；unresponsive = 只报不退）。每个窗都挂（主窗 + 控制台窗）。 */
function attachWindowCrashGuards(win: BrowserWindow): void {
  win.webContents.on('render-process-gone', (_event, details) => {
    reportLauncherCrash(
      `render-process-gone(${details.reason})`,
      new Error(`Renderer process gone: reason=${details.reason} code=${details.exitCode ?? 'n/a'}`),
      { exit: false, reloadWin: win },
    );
  });
  win.webContents.on('unresponsive', () => {
    reportLauncherCrash('window-unresponsive', new Error('渲染窗无响应（主线程卡死或长时间阻塞）'), { exit: false });
  });
}

/** 无边距主窗引用（WINDOW_CONTROL 通道操作目标）。 */
let mainWindow: BrowserWindow | null = null;

/** 每次启动一个独立控制台窗：集合仅用于生命周期跟踪，不做复用。 */
const consoleWindows = new Set<BrowserWindow>();

/** 开发模式渲染地址：--dev-url= 或 ELECTRON_RENDERER_URL；缺省 = ui 构建产物。 */
function resolveDevUrl(): string | undefined {
  const devArg = process.argv.find((a) => a.startsWith('--dev-url='));
  return devArg?.slice('--dev-url='.length) ?? process.env['ELECTRON_RENDERER_URL'];
}

function uiDistIndex(): string {
  // 产线（随装）：extraResources 把 packages/ui/dist 落成 resources/ui（两壳 yml 同键）；
  // 开发态：仓内 packages/ui/dist 相对位。legacy 壳复用本文件（legacy-entry 同源），零分叉。
  if (app.isPackaged) return path.join(process.resourcesPath, 'ui', 'index.html');
  return path.resolve(app.getAppPath(), '..', '..', 'packages', 'ui', 'dist', 'index.html');
}

/**
 * 通道注册器：IpcResult 封装归壳层（runtime 以异常抛出）。
 * 参数透传：渲染侧 invoke(channel, ...args) → handle 回调 (event, ...args)。
 */
function handle<I extends unknown[], T>(channel: string, fn: (...args: I) => T | Promise<T>): void {
  ipcMain.handle(channel, async (_event, ...args: unknown[]): Promise<IpcResult<T>> => {
    try {
      return { ok: true, value: await fn(...(args as I)) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
}

/** 事件广播：runtime 事件面 → 全部窗口的 webContents（preload 的 on() 订阅侧）。 */
function broadcast<E extends keyof AtticEventPayloads>(event: E, payload: AtticEventPayloads[E]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(event, payload);
  }
}

/**
 * 控制台 backlog（GAME_BACKLOG 通道的数据源）：按 pid 缓存本会话已发射的输出与退出事件。
 * 独立控制台窗是启动后才新建/挂载的，spawn 瞬间的 LegacyFix premain 首批输出
 * 在窗内订阅前就广播完了，实时事件面收不到。
 * 新窗订阅完成后按 pid 补拉，seq 去重；每会话缓冲封顶 1MB（截断置 truncated），最多保留 4 个会话。
 */
interface SessionBacklog {
  seq: number;
  entries: GameOutputEvent[];
  bytes: number;
  exit: GameExitEvent | null;
  truncated: boolean;
}
const backlogs = new Map<number, SessionBacklog>();
const BACKLOG_BYTES_LIMIT = 1024 * 1024;

function backlogFor(pid: number): SessionBacklog {
  let b = backlogs.get(pid);
  if (!b) {
    b = { seq: 0, entries: [], bytes: 0, exit: null, truncated: false };
    backlogs.set(pid, b);
    while (backlogs.size > 4) {
      const oldest = backlogs.keys().next().value as number;
      backlogs.delete(oldest);
    }
  }
  return b;
}

function wireEvents(): void {
  // 输出事件：盖会话内单调 seq 戳 → 进 backlog → 广播（渲染侧以 seq 对补拉去重）。
  runtime.on(IPC_EVENTS.GAME_OUTPUT, (payload) => {
    const b = backlogFor(payload.pid);
    const stamped: GameOutputEvent = { ...payload, seq: ++b.seq };
    b.entries.push(stamped);
    b.bytes += stamped.chunk.length;
    while (b.bytes > BACKLOG_BYTES_LIMIT && b.entries.length > 1) {
      const drop = b.entries.shift() as GameOutputEvent;
      b.bytes -= drop.chunk.length;
      b.truncated = true;
    }
    broadcast(IPC_EVENTS.GAME_OUTPUT, stamped);
  });
  // 退出事件同样入档：游戏秒退时新建控制台窗收不到实时 exit，靠补拉恢复崩溃摘要卡。
  runtime.on(IPC_EVENTS.GAME_EXIT, (payload) => {
    backlogFor(payload.pid).exit = payload;
    broadcast(IPC_EVENTS.GAME_EXIT, payload);
  });
  // 双壳同步要求：新增宿主事件必须同时进本列表与 lib.rs EVENT_CHANNELS，
  // 否则对应壳的弹窗/面板收不到终局（MS_LOGIN 曾踩）
  for (const event of [IPC_EVENTS.DOWNLOAD_PROGRESS, IPC_EVENTS.CUSTOM_INFO_CHANGED, IPC_EVENTS.MS_LOGIN] as const) {
    runtime.on(event, (payload: AtticEventPayloads[typeof event]) => {
      broadcast(event, payload);
    });
  }
}

/** 无边距主窗：拖拽区由 UI 的 .titlebar（-webkit-app-region: drag）承担。 */
function createWindow(): void {
  const win = new BrowserWindow({
    width: 980,
    height: 720,
    minWidth: 800,
    minHeight: 560,
    frame: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // preload 需要 require('@attic/core-spec') 取通道常量；Electron 20+ 默认沙箱
      // 只允许 require 少数内置模块，不禁用沙箱 preload 会静默失败（缺桥横幅的根因）。
      sandbox: false,
    },
  });
  mainWindow = win;
  win.on('closed', () => {
    mainWindow = null;
    // 主窗 = 应用本体：控制台窗是附属会话窗，主窗退出连带全关——
    // 否则控制台独活撑住 window-all-closed，进程滞留且无 UI 可 kill 在跑的游戏。
    // 兜底壳复用同源同生效。
    for (const c of [...consoleWindows]) c.close();
  });
  attachWindowCrashGuards(win);

  // 直接 show，不等 ready-to-show——页面 JS 异常/加载失败时
  // ready-to-show 可能永不触发，导致"日志正常但窗口不出现"。
  win.show();
  win.webContents.on('did-fail-load', (_e, code, desc) => {
    console.error(`[attic-main] did-fail-load ${code}: ${desc}`);
  });
  win.webContents.on('console-message', (_e, _level, msg, _line, src) => {
    console.log(`[renderer] ${msg} (${src})`);
  });
  // DevTools 仅开发态（无条件开 = 安装版弹出调试窗）。
  // 兜底壳（electron-legacy）复用本源码，同修同生效。
  if (!app.isPackaged) {
    win.webContents.openDevTools({ mode: 'detach' });
  }

  const devUrl = resolveDevUrl();
  if (devUrl) {
    void win.loadURL(devUrl);
  } else {
    // 加载 packages/ui 的构建产物。
    void win.loadFile(uiDistIndex());
  }
}

/**
 * 独立控制台窗（v1 语义，每次启动独立）：加载同一 UI 带 ?window=console&pid=<会话pid>。
 * 每次调用都新建窗口（旧控制台不复用）；窗内 ConsolePanel 按 pid 过滤本会话输出，旧窗保留各自历史日志。
 */
function createConsoleWindow(): void {
  const session = runtime.status().session;
  const win = new BrowserWindow({
    width: 860,
    height: 600,
    minWidth: 520,
    minHeight: 360,
    frame: false,
    show: false,
    title: session ? `Attic Console — ${session.versionId} (${session.pid})` : 'Attic Corner Launcher — Console',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  consoleWindows.add(win);
  win.on('closed', () => {
    consoleWindows.delete(win);
  });
  attachWindowCrashGuards(win);
  win.show();

  const query: Record<string, string> = { window: 'console' };
  if (session) query['pid'] = String(session.pid);
  const devUrl = resolveDevUrl();
  if (devUrl) {
    const sep = devUrl.includes('?') ? '&' : '?';
    void win.loadURL(`${devUrl}${sep}${new URLSearchParams(query).toString()}`);
  } else {
    void win.loadFile(uiDistIndex(), { query });
  }
}

app.whenReady().then(() => {
  // temp 守卫命中（模块顶已判）：拒建主窗，原生对话框讲清「实际动作 + 出路」再退。
  if (tempTrap) {
    const choice = dialog.showMessageBoxSync({
      type: 'warning',
      title: 'Attic Launcher',
      message: '请先解压整个文件夹，勿在压缩包里直接运行',
      detail:
        '检测到启动器正从临时目录运行——游戏数据会随临时目录清理而丢失。' +
        '请关闭压缩软件窗口，把 zip 里的整个文件夹解压到固定位置（如 D:\\Attic）后再双击启动。' +
        '免安装构件请从项目 Releases 页下载（attic-*-portable.zip）。',
      buttons: ['打开 Releases 页', '退出'],
      noLink: true,
    });
    if (choice === 0) void shell.openExternal(RELEASES_URL);
    app.quit();
    return;
  }
  // 契约通道注册（ipc.ts 一一对应）。
  handle(IPC_CHANNELS.PING, () => runtime.ping());
  handle(IPC_CHANNELS.VERSIONS_LIST, () => runtime.listVersions());
  handle(IPC_CHANNELS.VERSIONS_JSON, (versionId: string) => runtime.getVersionJson(versionId));
  handle(IPC_CHANNELS.VERSION_PROBE_CLASS, (versionId: string, className: string) =>
    runtime.probeVersionClass(versionId, className),
  );
  handle(IPC_CHANNELS.LAUNCH_DRY_RUN, (request: LaunchRequest) => runtime.dryRunLaunch(request));
  handle(IPC_CHANNELS.LAUNCH, async (request: LaunchRequest) => {
    const session = await runtime.launch(request);
    // 「启动后最小化启动器」：窗行为归壳层，开关消费点在成功启动之后（失败不缩窗）
    if (runtime.getSettings().minimizeOnLaunch) mainWindow?.minimize();
    return session;
  });
  handle(IPC_CHANNELS.LAUNCH_CANCEL, () => runtime.cancelLaunch());
  handle(IPC_CHANNELS.KILL, () => runtime.kill());
  handle(IPC_CHANNELS.STATUS, () => runtime.status());
  handle(IPC_CHANNELS.JAVA_DETECT, () => runtime.detectJava());
  handle(IPC_CHANNELS.ACCOUNTS_LIST, () => runtime.listAccounts());
  handle(IPC_CHANNELS.ACCOUNTS_ADD, (name: string) => runtime.addAccount(name));
  handle(IPC_CHANNELS.ACCOUNTS_REMOVE, (id: string) => runtime.removeAccount(id));
  handle(IPC_CHANNELS.ACCOUNTS_RENAME, (id: string, name: string) => runtime.renameAccount(id, name));
  handle(IPC_CHANNELS.ACCOUNTS_MS_START, () => runtime.msStartLogin());
  handle(IPC_CHANNELS.ACCOUNTS_MS_CANCEL, () => runtime.msCancelLogin());
  handle(IPC_CHANNELS.ACCOUNTS_MS_REFRESH, (id: string) => runtime.msRefreshAccount(id));
  handle(IPC_CHANNELS.SETTINGS_GET, () => runtime.getSettings());
  handle(IPC_CHANNELS.SETTINGS_SET, (settings: AppSettings) => runtime.setSettings(settings));
  handle(IPC_CHANNELS.INSTANCES_LIST, () => runtime.listInstances());
  handle(IPC_CHANNELS.INSTANCES_SAVE, (instance: InstanceView) => runtime.saveInstance(instance));
  handle(IPC_CHANNELS.INSTANCES_DELETE, (name: string, withFiles: boolean) => runtime.deleteInstance(name, withFiles));
  handle(IPC_CHANNELS.INSTANCES_RENAME, (name: string, newName: string) => runtime.renameInstance(name, newName));
  handle(IPC_CHANNELS.INSTANCES_SET_VERSION, (name: string | null, versionId: string) =>
    runtime.setInstanceVersion(name, versionId),
  );
  handle(IPC_CHANNELS.INSTANCES_SET_ADDONS, (name: string | null, addons: string[]) =>
    runtime.setInstanceAddons(name, addons),
  );
  // 打开实例目录：先 mkdir 保证可见（首启未落盘的场景不失败），再交系统文件管理器。
  // openPath 失败语义 = 返回非空错误字符串（成功 = ''），回抛给渲染侧可见。
  handle(IPC_CHANNELS.INSTANCES_OPEN_DIR, async (name: string) => {
    const dir = runtime.instanceGameDir(name);
    fs.mkdirSync(dir, { recursive: true });
    const err = await shell.openPath(dir);
    if (err) throw new Error(err);
  });
  // 自定义版本配置页通道（list/get/save/remove 直连 runtime；import 见下方对话框）。
  handle(IPC_CHANNELS.CUSTOM_LIST, () => runtime.listCustomVersions());
  handle(IPC_CHANNELS.CUSTOM_GET_INFO, (id: string) => runtime.getCustomVersionInfo(id));
  handle(IPC_CHANNELS.CUSTOM_SAVE_INFO, (id: string, props: Record<string, string>) => runtime.saveCustomVersionInfo(id, props));
  handle(IPC_CHANNELS.CUSTOM_REMOVE, (id: string) => runtime.removeCustomVersion(id));
  // 导入 jar：主进程弹原生文件对话框（渲染侧无 fs 权限）；取消 = ok(null)，选中路径交 runtime 复制落位。
  ipcMain.handle(IPC_CHANNELS.CUSTOM_IMPORT_JAR, async (): Promise<IpcResult<CustomVersionView | null>> => {
    try {
      const res = await dialog.showOpenDialog({
        title: '导入自定义版本 jar',
        properties: ['openFile'],
        filters: [{ name: 'Minecraft jar', extensions: ['jar', 'zip'] }],
      });
      const file = res.filePaths[0];
      if (res.canceled || !file) return { ok: true, value: null };
      return { ok: true, value: runtime.importCustomJar(file) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
  // Mods 页（Betacraft 单源）：列表现拉现发（runtime 无进程内缓存）；安装 = 只落 .info，
  // jar 与基座合成延迟到启动期（点 Play 才补全）。
  handle(IPC_CHANNELS.MODS_LIST, () => runtime.listMods());
  handle(IPC_CHANNELS.MODS_INSTALL, (request: ModInstallRequest) => runtime.installMod(request));
  // 社区服务器页（Betacraft 单源）：列表现拉现发（runtime 无进程内缓存），matchedVersionId 宿主派生。
  handle(IPC_CHANNELS.SERVERS_LIST, () => runtime.listServers());
  // —— 设置页宿主能力面（SYS_INFO/检查更新/目录/日志/对话框/外链）——
  handle(IPC_CHANNELS.SYS_INFO, () => runtime.getSystemInfo());
  // 检查更新：runtime 全分支数据化返回（unconfigured/error 也在 value 内），UI 弹窗呈现。
  handle(IPC_CHANNELS.UPDATE_CHECK, () => runtime.checkUpdate());
  // 应用更新（执行面 Windows 快路径；runtime 共享实现，壳差异只在自退通道 = windowControl close）。
  handle(IPC_CHANNELS.UPDATE_APPLY, (req: UpdateApplyRequest) => runtime.applyUpdate(req));
  // 打开特殊目录：白名单枚举、路径宿主解析（渲染侧给不出任意路径）；logs 未生成时先建再开。
  handle(IPC_CHANNELS.SHELL_OPEN_DIR, async (target: SpecialDir) => {
    const dir = target === 'logs-dir' ? path.join(launcherDir(runtime.root), 'logs') : runtime.root;
    fs.mkdirSync(dir, { recursive: true });
    const err = await shell.openPath(dir);
    if (err) throw new Error(err);
  });
  handle(IPC_CHANNELS.LOGS_CLEAR, () => runtime.clearLogs());
  // 背景图读取：runtime 单点把关（扩展白名单 + 大小上限），违规以 error 数据返回。
  handle(IPC_CHANNELS.IMAGE_DATA_URL, (filePath: string) => runtime.readImageAsDataUrl(filePath));
  // 原生对话框选择（java 可执行 / 目录 / 图片）：取消 = ok(null)，与 CUSTOM_IMPORT_JAR 同语义。
  ipcMain.handle(IPC_CHANNELS.DIALOG_PICK, async (_event, kind: PickTarget): Promise<IpcResult<string | null>> => {
    try {
      const res = await dialog.showOpenDialog({
        title: kind === 'java-executable' ? '选择 Java 可执行文件' : kind === 'image-file' ? '选择背景图片' : '选择文件夹',
        properties: kind === 'directory' ? ['openDirectory', 'createDirectory'] : ['openFile'],
        ...(kind === 'java-executable' && process.platform === 'win32'
          ? { filters: [{ name: 'java 可执行文件', extensions: ['exe'] }] }
          : {}),
        ...(kind === 'image-file'
          ? { filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }] }
          : {}),
      });
      const picked = res.filePaths[0];
      return { ok: true, value: res.canceled || !picked ? null : picked };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
  // 外链出门：协议白名单 http/https（渲染进程拿不到 shell，唯一出门口收紧校验）。
  handle(IPC_CHANNELS.SHELL_OPEN_URL, async (url: string) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`非法 URL：${url}`);
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error(`仅允许 http/https 协议：${parsed.protocol}`);
    }
    await shell.openExternal(parsed.toString());
  });
  // —— 崩溃取证通道（渲染层 → 宿主）——
  // 渲染层错误静默落 launcher.log（不弹框、不打扰；框归 CrashPanel 渲染层自理）。
  handle<[RendererErrorReport], void>(IPC_CHANNELS.CRASH_REPORT, (report) => {
    runtime.logRendererError(report);
  });
  // CrashPanel 三按钮数据源：诊断包文本（渲染侧写剪贴板）+ releaseRepo 派生预填链接。
  handle<[string, string], CrashBundleResult>(IPC_CHANNELS.CRASH_BUNDLE, (category, stack) =>
    runtime.crashBundleResult(category, stack),
  );
  // 窗控制：动作合法性由契约类型保证；toggle-maximize 在最大化/还原间切换。
  // 按发送方窗口操作（非固定 mainWindow）——独立控制台窗的顶栏三键才能控自己的窗。
  ipcMain.handle(IPC_CHANNELS.WINDOW_CONTROL, async (event, action: WindowAction): Promise<IpcResult<void>> => {
    try {
      const win = BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
      if (!win) return { ok: true, value: undefined };
      if (action === 'minimize') win.minimize();
      else if (action === 'close') win.close();
      else if (win.isMaximized()) win.unmaximize();
      else win.maximize();
      return { ok: true, value: undefined };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
  // 独立控制台窗：唤起/聚焦（v1 语义；主页 Play/测试启动后由 UI 侧触发）。
  handle<[], void>(IPC_CHANNELS.WINDOW_CONSOLE, () => {
    createConsoleWindow();
  });
  // 控制台 backlog 补拉：新窗订阅后按 pid 拉取已发射输出与退出事件。
  handle<[number], GameBacklog>(IPC_CHANNELS.GAME_BACKLOG, (pid) => {
    const b = backlogs.get(pid);
    if (!b) return { lines: [], exit: null, truncated: false };
    return { lines: [...b.entries], exit: b.exit, truncated: b.truncated };
  });

  wireEvents();
  createWindow();
  // 崩溃演练钩子（dev-only 双闸：--dev-url 在场 ∧ env 在场；产线天然失效——
  // 注：不能用 app.isPackaged，Electron 33 下 `electron .` 直跑该标志实测为 true）：
  // ATTIC_CRASH_DEMO = exception | rejection | gone，8s 后触发，供 P0/P1 全链自动演练。
  const crashDemo = process.env['ATTIC_CRASH_DEMO'];
  if (crashDemo && resolveDevUrl()) {
    setTimeout(() => {
      if (crashDemo === 'gone') mainWindow?.webContents.forcefullyCrashRenderer();
      else if (crashDemo === 'rejection') void Promise.reject(new Error('crash-drill: unhandledRejection'));
      else throw new Error('crash-drill: uncaughtException');
    }, 8000);
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// 退出清理：游戏进程在跑则先 kill（进程生命周期归 runtime，壳只触发）。
app.on('before-quit', () => {
  if (runtime.status().running) void runtime.kill().catch(() => undefined);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
