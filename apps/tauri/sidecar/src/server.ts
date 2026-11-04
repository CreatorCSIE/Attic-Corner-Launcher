/**
 * Attic sidecar —— Tauri 壳的 RPC 承载体。
 *
 * 线协议（stdio NDJSON，一行一帧，定义详见 docs/contract.md「双壳接入模型」）：
 *   请求  {id:number, method:string, params:unknown[]}
 *   响应  {id, result:...} | {id, error:string}          —— 错误以数据返回，不跨进程抛（对齐 IpcResult）
 *   事件  {event:string, payload:...}（无 id，服务端单向推送）
 *
 * 方法面 = packages/core-spec ipc.ts 的通道白名单（只允许引用契约常量）；
 * 宿主面通道（窗控/对话框/外链/openPath）由 Rust 侧处理，不进入本表。
 * 内部延伸方法（attic:internal:*）：Rust 需要「先拿路径再做宿主动作」的拆分面。
 */

import { createInterface } from 'node:readline';
import path from 'node:path';
import {
  IPC_CHANNELS,
  IPC_EVENTS,
  type GameExitEvent,
  type GameOutputEvent,
} from '@attic/core-spec';
import {
  AtticRuntime,
  isPathWithin,
  launcherDir,
  loadSettings,
  resolveDataRoot,
} from '@attic/runtime';

/**
 * 宿主安装目录：产线布局 node.exe 与主 exe 同目录（stage 随装），dirname(execPath) 天然 = 安装目录；
 * 开发态 = 系统 node 目录，护栏参照虽变但无害（无人把数据根指进 node 安装位）。
 */
const INSTALL_DIR = path.dirname(process.execPath);

/**
 * portable（硬纪律：sidecar 的 process.execPath = node.exe，exeDir 判定面不得依赖它）：
 * Rust 壳在 current_exe() 目录双指纹命中时注入 ATTIC_EXE_DIR（程序目录绝对路径），
 * marker 在场再加注 ATTIC_PORTABLE_INI（sidecar/portable.ini 绝对路径）；两键缺席 = 非便携形态
 * （安装版/开发态），判定与指针读写单点在 runtime（detectPortable）。
 */
const PORTABLE_EXE_DIR = process.env['ATTIC_EXE_DIR'];
const PORTABLE_INI = process.env['ATTIC_PORTABLE_INI'];

/** 数据根覆盖引导：与 Electron 壳同款（从默认根 peek rootOverride + 安装目录兜底护栏，手改 settings 拦存量）。 */
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
    return undefined;
  }
}

const runtime = new AtticRuntime({
  rootDir: bootstrapRootDir(),
  version: process.env['ATTIC_LAUNCHER_VERSION'] ?? '0.0.0',
  installDir: INSTALL_DIR,
  // 壳形态：sidecar 只在 tauri 壳下拉起（SYS_INFO shell 字段数据源）。
  shell: 'tauri',
  ...(PORTABLE_EXE_DIR
    ? { exeDir: PORTABLE_EXE_DIR, portableMarkers: [PORTABLE_INI ?? 'sidecar/portable.ini'] }
    : {}),
});

// —— 输出帧（NDJSON：单行、无内嵌换行）——
function send(frame: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

// —— 控制台 backlog（Electron 主进程同款语义的移植）：
// 独立控制台窗挂载前的输出先入缓冲，新窗经 GAME_BACKLOG 通道补拉，seq 去重。
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
    send({ event: IPC_EVENTS.GAME_OUTPUT, payload: stamped });
  });
  runtime.on(IPC_EVENTS.GAME_EXIT, (payload) => {
    backlogFor(payload.pid).exit = payload;
    send({ event: IPC_EVENTS.GAME_EXIT, payload });
  });
  // 双壳同步要求：新增宿主事件必须三处同步——本列表、electron main.ts wireEvents、lib.rs EVENT_CHANNELS
  for (const event of [IPC_EVENTS.DOWNLOAD_PROGRESS, IPC_EVENTS.CUSTOM_INFO_CHANGED, IPC_EVENTS.MS_LOGIN] as const) {
    runtime.on(event, (payload) => {
      send({ event, payload });
    });
  }
}

// —— 方法表：契约通道（Rust 侧不承接的部分）+ attic:internal:* 延伸 ——
// params 按位置传（渲染 invoke 的变参原样透传，与 Electron handle(...args) 同构）。
const C = IPC_CHANNELS;

// 宿主面通道：Rust 直处理，出现于此即协议违例（防御性拒绝，不静默吞）。
export const HOST_ONLY_CHANNELS: readonly string[] = [
  C.WINDOW_CONTROL,
  C.WINDOW_CONSOLE,
  C.INSTANCES_OPEN_DIR,
  C.SHELL_OPEN_DIR,
  C.SHELL_OPEN_URL,
  C.DIALOG_PICK,
  C.CUSTOM_IMPORT_JAR,
];

/** 契约全通道（ipc.ts 值的镜像）。 */
export const ALL_CHANNELS: readonly string[] = Object.values(C);

/** sidecar 承接的通道 = 全通道 - 宿主面（本表与 Rust 侧镜像共同受契约 fixture 闸门约束）。 */
export const SIDECAR_CHANNELS: readonly string[] = ALL_CHANNELS.filter(
  (ch) => !HOST_ONLY_CHANNELS.includes(ch),
);

/** attic:internal:* 延伸方法（非契约通道，Rust↔sidecar 私有面，同表受闸门约束）。 */
export const INTERNAL_METHODS: readonly string[] = [
  'attic:internal:instance-game-dir',
  'attic:internal:special-dir',
  'attic:internal:import-jar',
  'attic:internal:shutdown',
];

/** 事件通道（推送帧的 event 值域）。 */
export const EVENT_CHANNELS: readonly string[] = Object.values(IPC_EVENTS);

type Params = unknown[];

async function dispatch(method: string, params: Params): Promise<unknown> {
  const s = (i: number) => params[i] as never;
  switch (method) {
    case C.PING:
      return runtime.ping();
    case C.VERSIONS_LIST:
      return runtime.listVersions();
    case C.VERSIONS_JSON:
      return runtime.getVersionJson(s(0));
    case C.VERSION_PROBE_CLASS:
      return runtime.probeVersionClass(s(0), s(1));
    case C.LAUNCH_DRY_RUN:
      return runtime.dryRunLaunch(s(0));
    case C.LAUNCH:
      return runtime.launch(s(0));
    case C.LAUNCH_CANCEL:
      return runtime.cancelLaunch();
    case C.KILL:
      return runtime.kill();
    case C.STATUS:
      return runtime.status();
    case C.JAVA_DETECT:
      return runtime.detectJava();
    case C.ACCOUNTS_LIST:
      return runtime.listAccounts();
    case C.ACCOUNTS_ADD:
      return runtime.addAccount(s(0));
    case C.ACCOUNTS_REMOVE:
      return runtime.removeAccount(s(0));
    case C.ACCOUNTS_RENAME:
      return runtime.renameAccount(s(0), s(1));
    case C.ACCOUNTS_MS_START:
      return runtime.msStartLogin();
    case C.ACCOUNTS_MS_CANCEL:
      return runtime.msCancelLogin();
    case C.ACCOUNTS_MS_REFRESH:
      return runtime.msRefreshAccount(s(0));
    case C.SETTINGS_GET:
      return runtime.getSettings();
    case C.SETTINGS_SET:
      return runtime.setSettings(s(0));
    case C.INSTANCES_LIST:
      return runtime.listInstances();
    case C.INSTANCES_SAVE:
      return runtime.saveInstance(s(0));
    case C.INSTANCES_DELETE:
      return runtime.deleteInstance(s(0), s(1));
    case C.INSTANCES_RENAME:
      return runtime.renameInstance(s(0), s(1));
    case C.INSTANCES_SET_VERSION:
      return runtime.setInstanceVersion(s(0), s(1));
    case C.INSTANCES_SET_ADDONS:
      return runtime.setInstanceAddons(s(0), s(1));
    case C.GAME_BACKLOG:
      return backlogOf(s(0) as number);
    case C.CUSTOM_LIST:
      return runtime.listCustomVersions();
    case C.CUSTOM_GET_INFO:
      return runtime.getCustomVersionInfo(s(0));
    case C.CUSTOM_SAVE_INFO:
      return runtime.saveCustomVersionInfo(s(0), s(1));
    case C.CUSTOM_REMOVE:
      return runtime.removeCustomVersion(s(0));
    case C.MODS_LIST:
      return runtime.listMods();
    case C.MODS_INSTALL:
      return runtime.installMod(s(0));
    case C.SERVERS_LIST:
      return runtime.listServers();
    case C.SYS_INFO:
      return runtime.getSystemInfo();
    case C.UPDATE_CHECK:
      return runtime.checkUpdate();
    case C.LOGS_CLEAR:
      return runtime.clearLogs();
    case C.IMAGE_DATA_URL:
      return runtime.readImageAsDataUrl(s(0));
    case C.CRASH_REPORT:
      return runtime.logRendererError(s(0));
    case C.CRASH_BUNDLE:
      return runtime.crashBundleResult(s(0), s(1));
    // —— attic:internal:*（非契约通道：Rust 宿主动作的路径/入参拆分面）——
    case 'attic:internal:instance-game-dir':
      return runtime.instanceGameDir(s(0));
    case 'attic:internal:special-dir': {
      const target = s(0) as 'data-root' | 'logs-dir';
      return target === 'logs-dir' ? path.join(launcherDir(runtime.root), 'logs') : runtime.root;
    }
    case 'attic:internal:import-jar':
      return runtime.importCustomJar(s(0));
    case 'attic:internal:shutdown':
      // Rust 退出收敛：先收敛游戏进程，宽限后自尽（Rust 侧另有强杀兜底）。
      if (runtime.status().running) void runtime.kill().catch(() => undefined);
      setTimeout(() => process.exit(0), 150);
      return 'ok';
    default:
      if (HOST_ONLY_CHANNELS.includes(method)) {
        throw new Error(`host-only-channel: ${method}`);
      }
      throw new Error(`unknown-method: ${method}`);
  }
}

function backlogOf(pid: number) {
  const b = backlogs.get(pid);
  if (!b) return { lines: [], exit: null, truncated: false };
  return { lines: [...b.entries], exit: b.exit, truncated: b.truncated };
}

// —— 主循环：stdin NDJSON → dispatch → stdout 响应帧 ——
export function startServer(): void {
  wireEvents();
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let frame: { id?: unknown; method?: unknown; params?: unknown };
    try {
      frame = JSON.parse(line);
    } catch {
      send({ id: null, error: 'bad-json-line' });
      return;
    }
    const { id, method, params } = frame;
    if (typeof id !== 'number' || typeof method !== 'string' || !Array.isArray(params)) {
      send({ id: typeof id === 'number' ? id : null, error: 'bad-request-frame' });
      return;
    }
    void Promise.resolve(dispatch(method, params)).then(
      (result) => send({ id, result }),
      (error: unknown) => send({ id, error: error instanceof Error ? error.message : String(error) }),
    );
  });
  rl.on('close', () => {
    // 宿主（Rust）关闭 stdin = 优雅退出信号：与 shutdown 通道同款收敛——异步 kill 需要
    // 一拍才发得出 SIGTERM，同步 exit 会把它截断成孤儿进程；宽限后自尽（Rust 侧另有强杀兜底）。
    if (runtime.status().running) void runtime.kill().catch(() => undefined);
    setTimeout(() => process.exit(0), 150);
  });
}

// autostart：直接 `node dist/server.cjs` 即服务；fixture 生成器以
// ATTIC_SIDECAR_DISABLE_AUTOSTART=1 import 本包只读导出表（不占用 stdin）。
if (process.env['ATTIC_SIDECAR_DISABLE_AUTOSTART'] !== '1') {
  startServer();
}
