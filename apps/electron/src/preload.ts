import { contextBridge, ipcRenderer } from 'electron';
import {
  IPC_CHANNELS,
  IPC_EVENTS,
  type AtticEventPayloads,
  type IpcResult,
  type LaunchRequest,
  type RendererBridge,
} from '@attic/core-spec';

/** 请求通道统一走 IpcResult 封装（错误不跨进程抛异常）。 */
function invoke<T>(channel: string, ...args: unknown[]): Promise<IpcResult<T>> {
  return ipcRenderer.invoke(channel, ...args) as Promise<IpcResult<T>>;
}

const bridge: RendererBridge = {
  ping: () => invoke(IPC_CHANNELS.PING),
  listVersions: () => invoke(IPC_CHANNELS.VERSIONS_LIST),
  getVersionJson: (versionId) => invoke(IPC_CHANNELS.VERSIONS_JSON, versionId),
  probeVersionClass: (versionId, className) => invoke(IPC_CHANNELS.VERSION_PROBE_CLASS, versionId, className),
  dryRunLaunch: (request: LaunchRequest) => invoke(IPC_CHANNELS.LAUNCH_DRY_RUN, request),
  launch: (request: LaunchRequest) => invoke(IPC_CHANNELS.LAUNCH, request),
  cancelLaunch: () => invoke(IPC_CHANNELS.LAUNCH_CANCEL),
  kill: () => invoke(IPC_CHANNELS.KILL),
  status: () => invoke(IPC_CHANNELS.STATUS),
  detectJava: () => invoke(IPC_CHANNELS.JAVA_DETECT),
  listAccounts: () => invoke(IPC_CHANNELS.ACCOUNTS_LIST),
  addAccount: (name) => invoke(IPC_CHANNELS.ACCOUNTS_ADD, name),
  removeAccount: (id) => invoke(IPC_CHANNELS.ACCOUNTS_REMOVE, id),
  renameAccount: (id, name) => invoke(IPC_CHANNELS.ACCOUNTS_RENAME, id, name),
  msStartLogin: () => invoke(IPC_CHANNELS.ACCOUNTS_MS_START),
  msCancelLogin: () => invoke(IPC_CHANNELS.ACCOUNTS_MS_CANCEL),
  msRefreshAccount: (id) => invoke(IPC_CHANNELS.ACCOUNTS_MS_REFRESH, id),
  getSettings: () => invoke(IPC_CHANNELS.SETTINGS_GET),
  setSettings: (settings) => invoke(IPC_CHANNELS.SETTINGS_SET, settings),
  listInstances: () => invoke(IPC_CHANNELS.INSTANCES_LIST),
  saveInstance: (instance) => invoke(IPC_CHANNELS.INSTANCES_SAVE, instance),
  deleteInstance: (name, withFiles) => invoke(IPC_CHANNELS.INSTANCES_DELETE, name, withFiles),
  renameInstance: (name, newName) => invoke(IPC_CHANNELS.INSTANCES_RENAME, name, newName),
  setInstanceVersion: (name, versionId) => invoke(IPC_CHANNELS.INSTANCES_SET_VERSION, name, versionId),
  openInstanceDir: (name) => invoke(IPC_CHANNELS.INSTANCES_OPEN_DIR, name),
  windowControl: (action) => invoke(IPC_CHANNELS.WINDOW_CONTROL, action),
  openConsoleWindow: () => invoke(IPC_CHANNELS.WINDOW_CONSOLE),
  getGameBacklog: (pid) => invoke(IPC_CHANNELS.GAME_BACKLOG, pid),
  listCustomVersions: () => invoke(IPC_CHANNELS.CUSTOM_LIST),
  getCustomVersionInfo: (id) => invoke(IPC_CHANNELS.CUSTOM_GET_INFO, id),
  saveCustomVersionInfo: (id, props) => invoke(IPC_CHANNELS.CUSTOM_SAVE_INFO, id, props),
  importCustomJar: () => invoke(IPC_CHANNELS.CUSTOM_IMPORT_JAR),
  removeCustomVersion: (id) => invoke(IPC_CHANNELS.CUSTOM_REMOVE, id),
  listMods: () => invoke(IPC_CHANNELS.MODS_LIST),
  installMod: (request) => invoke(IPC_CHANNELS.MODS_INSTALL, request),
  listServers: () => invoke(IPC_CHANNELS.SERVERS_LIST),
  getSystemInfo: () => invoke(IPC_CHANNELS.SYS_INFO),
  checkUpdate: () => invoke(IPC_CHANNELS.UPDATE_CHECK),
  openSpecialDir: (target) => invoke(IPC_CHANNELS.SHELL_OPEN_DIR, target),
  clearLogs: () => invoke(IPC_CHANNELS.LOGS_CLEAR),
  pickJavaExecutable: () => invoke(IPC_CHANNELS.DIALOG_PICK, 'java-executable'),
  pickDirectory: () => invoke(IPC_CHANNELS.DIALOG_PICK, 'directory'),
  pickImageFile: () => invoke(IPC_CHANNELS.DIALOG_PICK, 'image-file'),
  readImageAsDataUrl: (path) => invoke(IPC_CHANNELS.IMAGE_DATA_URL, path),
  openExternalUrl: (url) => invoke(IPC_CHANNELS.SHELL_OPEN_URL, url),
  reportRendererError: (report) => invoke(IPC_CHANNELS.CRASH_REPORT, report),
  getCrashBundle: (category, stack) => invoke(IPC_CHANNELS.CRASH_BUNDLE, category, stack),
  on: <E extends keyof AtticEventPayloads>(event: E, cb: (payload: AtticEventPayloads[E]) => void) => {
    const handler = (_: unknown, payload: AtticEventPayloads[E]): void => {
      if (event === IPC_EVENTS.GAME_EXIT) console.log(`[attic-preload] recv ${event}`);
      cb(payload);
    };
    ipcRenderer.on(event, handler);
    return () => ipcRenderer.removeListener(event, handler);
  },
};

contextBridge.exposeInMainWorld('attic', bridge);
// 诊断：确认 preload 执行且桥已注入（经 main 的 console-message 透传可见）。
console.log('[attic-preload] contextBridge.attic exposed');
