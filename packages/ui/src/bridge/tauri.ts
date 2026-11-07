/**
 * Tauri 桥适配器：UI 跑在 Tauri 壳（withGlobalTauri=true）时，
 * window.__TAURI__ 在场 —— 以此全局面（core.invoke / event.listen）实现 RendererBridge 全桥。
 *
 * 设计约束：
 *  - 不 import 任何 @tauri-apps npm 包（UI 与壳技术栈解耦，浏览器/Electron 线零连带）；
 *  - 通道名一律引用 @attic/core-spec 契约常量；
 *  - sidecar 通道走 Rust 的 ipc_forward 白名单转发；宿主面走 Rust 专用命令；
 *  - Rust 返回的已是 IpcResult 封装（{ok,value|error}），本层原样透传。
 */

import {
  IPC_CHANNELS,
  type AppSettings,
  type CustomInfoView,
  type CustomVersionView,
  type GameBacklog,
  type IpcResult,
  type LaunchRequest,
  type ModInstallRequest,
  type LaunchCancelResult,
  type RendererBridge,
  type UpdateApplyRequest,
  type UpdateApplyResult,
  type UpdateCheckResult,
  type WindowAction,
} from '@attic/core-spec';

/** withGlobalTauri 注入的最小全局面（只声明用到的两域）。 */
export interface TauriGlobal {
  core: { invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> };
  event: {
    listen(name: string, handler: (e: { payload: unknown }) => void): Promise<() => void>;
  };
}

declare global {
  interface Window {
    __TAURI__?: TauriGlobal;
  }
}

const C = IPC_CHANNELS;

export function buildTauriBridge(t: TauriGlobal): RendererBridge {
  /** sidecar 通道统一转发口（Rust 白名单校验，返回 IpcResult 形状的 JSON）。 */
  const forward = async <T>(channel: string, args: unknown[] = []): Promise<IpcResult<T>> =>
    (await t.core.invoke('ipc_forward', { channel, args })) as IpcResult<T>;
  /** 宿主面命令直连（Rust 专用 command，同样返回 IpcResult 形状）。 */
  const host = async <T>(cmd: string, args?: Record<string, unknown>): Promise<IpcResult<T>> =>
    (await t.core.invoke(cmd, args)) as IpcResult<T>;

  return {
    ping: () => forward<string>(C.PING),
    listVersions: () => forward(C.VERSIONS_LIST),
    getVersionJson: (versionId) => forward(C.VERSIONS_JSON, [versionId]),
    probeVersionClass: (versionId, className) => forward<boolean>(C.VERSION_PROBE_CLASS, [versionId, className]),
    dryRunLaunch: (request: LaunchRequest) => forward(C.LAUNCH_DRY_RUN, [request]),
    launch: (request: LaunchRequest) => forward(C.LAUNCH, [request]),
    cancelLaunch: () => forward<LaunchCancelResult>(C.LAUNCH_CANCEL),
    kill: () => forward(C.KILL),
    status: () => forward(C.STATUS),
    detectJava: () => forward(C.JAVA_DETECT),
    listAccounts: () => forward(C.ACCOUNTS_LIST),
    addAccount: (name) => forward(C.ACCOUNTS_ADD, [name]),
    removeAccount: (id) => forward<void>(C.ACCOUNTS_REMOVE, [id]),
    renameAccount: (id, name) => forward(C.ACCOUNTS_RENAME, [id, name]),
    msStartLogin: () => forward(C.ACCOUNTS_MS_START),
    msCancelLogin: () => forward<void>(C.ACCOUNTS_MS_CANCEL),
    msRefreshAccount: (id) => forward(C.ACCOUNTS_MS_REFRESH, [id]),
    getSettings: () => forward<AppSettings>(C.SETTINGS_GET),
    setSettings: (settings) => forward<AppSettings>(C.SETTINGS_SET, [settings]),
    listInstances: () => forward(C.INSTANCES_LIST),
    saveInstance: (instance) => forward(C.INSTANCES_SAVE, [instance]),
    deleteInstance: (name, withFiles) => forward<void>(C.INSTANCES_DELETE, [name, withFiles]),
    renameInstance: (name, newName) => forward(C.INSTANCES_RENAME, [name, newName]),
    setInstanceVersion: (name, versionId) => forward(C.INSTANCES_SET_VERSION, [name, versionId]),
    setInstanceAddons: (name, addons) => forward(C.INSTANCES_SET_ADDONS, [name, addons]),
    // —— 宿主面：Rust 专用命令 ——
    openInstanceDir: (name) => host<void>('open_instance_dir', { name }),
    windowControl: (action: WindowAction) => host<void>('window_control', { action }),
    openConsoleWindow: () => host<void>('open_console'),
    // backlog 归 sidecar（事件缓存随核心进程走），仍是转发通道。
    getGameBacklog: (pid) => forward<GameBacklog>(C.GAME_BACKLOG, [pid]),
    listCustomVersions: () => forward<CustomVersionView[]>(C.CUSTOM_LIST),
    getCustomVersionInfo: (id) => forward<CustomInfoView>(C.CUSTOM_GET_INFO, [id]),
    saveCustomVersionInfo: (id, props) => forward<CustomVersionView>(C.CUSTOM_SAVE_INFO, [id, props]),
    importCustomJar: () => host<CustomVersionView | null>('import_custom_jar'),
    removeCustomVersion: (id) => forward<void>(C.CUSTOM_REMOVE, [id]),
    listMods: () => forward(C.MODS_LIST),
    installMod: (request: ModInstallRequest) => forward<void>(C.MODS_INSTALL, [request]),
    listServers: () => forward(C.SERVERS_LIST),
    getSystemInfo: () => forward(C.SYS_INFO),
    checkUpdate: () => forward<UpdateCheckResult>(C.UPDATE_CHECK),
    applyUpdate: (req: UpdateApplyRequest) => forward<UpdateApplyResult>(C.UPDATE_APPLY, [req]),
    openSpecialDir: (target) => host<void>('open_special_dir', { target }),
    clearLogs: () => forward<number>(C.LOGS_CLEAR),
    pickJavaExecutable: () => host<string | null>('pick_path', { kind: 'java-executable' }),
    pickDirectory: () => host<string | null>('pick_path', { kind: 'directory' }),
    pickImageFile: () => host<string | null>('pick_path', { kind: 'image-file' }),
    readImageAsDataUrl: (path) => forward<string>(C.IMAGE_DATA_URL, [path]),
    openExternalUrl: (url) => host<void>('open_external_url', { url }),
    reportRendererError: (report) => forward<void>(C.CRASH_REPORT, [report]),
    getCrashBundle: (category, stack) => forward(C.CRASH_BUNDLE, [category, stack]),
    // 事件：__TAURI__.event.listen 的退订是 Promise 形的，桥面要求同步返回 —— 先挂门闩，
    // 订阅就绪前卸载则立即回收（与 Electron preload on() 的同步退订语义对齐）。
    on: (event, cb) => {
      let dispose: (() => void) | null = null;
      let cancelled = false;
      void t.event
        .listen(event, (e) => cb(e.payload as never))
        .then((d) => {
          if (cancelled) d();
          else dispose = d;
        })
        .catch(() => undefined);
      return () => {
        cancelled = true;
        dispose?.();
      };
    },
  };
}
