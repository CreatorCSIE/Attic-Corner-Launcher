/**
 * @attic/core-spec — IPC 契约唯一真相。
 * 纯形状、常量与无副作用校验助手（如 parseServerAddress）：不含任何实现逻辑；
 * quirk/版本判断一律以数据字段表达。
 */

export type { Account, AccountType, AccountView, MicrosoftAccount, OfflineAccount } from './account';
export type { CustomInfoView, CustomVersionView } from './custom';
export type { ModCategoryRaw, ModCategoryView, ModEntryRaw, ModEntryView, ModInstallRequest } from './mods';
export { IPC_CHANNELS, IPC_EVENTS, NOT_IMPLEMENTED, LAUNCH_CANCELLED_MESSAGE, LAUNCH_DOWNLOAD_STAGES } from './ipc';
export type {
  AtticEventPayloads,
  CrashBrief,
  CrashBundleResult,
  DownloadItem,
  DownloadProgressEvent,
  RendererErrorReport,
  GameBacklog,
  GameExitEvent,
  GameOutputEvent,
  IpcChannel,
  IpcEventName,
  IpcResult,
  LaunchCancelResult,
  LaunchRequest,
  MsDeviceCode,
  MsLoginErrorCode,
  MsLoginEvent,
  PickTarget,
  RendererBridge,
  ServerCategory,
  ServerListView,
  SpecialDir,
  SystemInfo,
  UpdateCheckResult,
  WindowAction,
} from './ipc';
export type {
  AgentMount,
  BetacraftExtension,
  DownloadArtifact,
  LibraryInfo,
  VersionArgument,
  VersionEra,
  VersionJson,
  VersionManifest,
  VersionRef,
  VersionRepository,
  VersionRule,
} from './version';
export type {
  JavaArchitecture,
  JavaDetectionReport,
  JavaDiscoverySource,
  JavaInstall,
  JavaProbeFailure,
  JavaSelection,
  JavaVersion,
} from './java';
export type {
  CrashCategory,
  CrashSummary,
  GameExit,
  GameSession,
  GameStatus,
  LaunchConfig,
} from './launch';
export type {
  AccentColorDef,
  AddonDef,
  AppSettings,
  EndpointOverrides,
  InstanceView,
  MemoryMode,
  ThemeMode,
  ThemePresetDef,
  UpdatePolicy,
} from './settings';
export { MULTIPLAYER_JOIN_LAUNCH_METHODS } from './version';
export { INSTANCE_ADDONS, DEFAULT_ADDONS, parseServerAddress } from './settings';
export { ACCENT_COLORS, THEME_PRESETS } from './settings';
