/**
 * @attic/runtime — TS 侧启动器核心。
 * 分层：endpoints/properties/storage/info（基础）→ betacraft/java/zulu（数据）→ launch/process（执行）→ runtime（门面）。
 * 契约类型一律来自 @attic/core-spec。
 */

export { DEFAULT_ENDPOINTS, resolveEndpoints, endpointsFromOverrides, type Endpoints } from './endpoints';
export { parseProperties, serializeProperties } from './properties';
export {
  settingsFromProps,
  applySettingsToProps,
  instanceViewFromConfig,
  estimateMaxMemoryMb,
} from './appSettings';
export {
  resolveDataRoot,
  isPathWithin,
  hasUserData,
  ensureLayout,
  launcherDir,
  instancesDir,
  langDir,
  addonsDir,
  launchMethodsDir,
  settingsFile,
  accountsFile,
  versionListCacheFile,
  binDir,
  nativesDir,
  versionsDir,
  jsonsDir,
  infoFile,
  clientJarFile,
  modsDir,
  modJarFile,
  modRegistryFile,
  assetsDir,
  assetIndexFile,
  zuluJavaDir,
  readPropertiesFile,
  readPropertiesFileForMerge,
  writePropertiesFile,
  loadSettings,
  loadSettingsForMerge,
  saveSettings,
  listInstances,
  loadInstance,
  saveInstance,
  deleteInstance,
  renameInstance,
  assertInstanceName,
  scanBinPool,
  scanInstalledInfos,
  scanInstalledJars,
  scanInstalledVersions,
  loadAccounts,
  saveAccounts,
  offlineUuid,
  setInstanceVersionField,
  setInstanceAddonsField,
  type ResolveDataRootOptions,
  type InstanceConfig,
} from './storage';
export { infoToVersionJson, LAUNCH_METHOD_MAIN_CLASS } from './info';
export {
  PORTABLE_DIR_NAME,
  PORTABLE_ANCHOR_REL,
  classifyPathWarning,
  detectPortable,
  looksLikeTempExtraction,
  syncPortableRegistry,
  writePortableAnchor,
  writePortablePointer,
  type PortableProbeOptions,
  type PortablePathWarning,
  type PortableResolution,
} from './portable';
export {
  dependsOsFor,
  parseDependsVersion,
  hasLocalDepends,
  isDependsCurrent,
  ensureDepends,
  checkLwjgl2Arch,
  type DependsVersion,
  type DependsIO,
} from './depends';
export {
  attachConsoleCapture,
  buildCrashBundle,
  consumeCrashMarker,
  crashIssuesUrl,
  crashSummary,
  crashMarkerFile,
  launcherLogLine,
  tailLines,
  writeCrashMarker,
  LAUNCHER_LOG_MAX_BYTES,
  CRASH_LOG_TAIL_LINES,
  CRASH_MARKER_STACK_MAX,
  CRASH_DIALOG_STACK_MAX,
  type CrashBundleInput,
} from './crash';
export { DEFAULT_AGENT_MOUNTS } from './quirks';
export {
  BetacraftClient,
  parseVersionList,
  eraForDate,
  hashFile,
  sweepPartFiles,
  type BetacraftClientOptions,
  type FetchImpl,
} from './betacraft';
export { detectJavaRuntime } from './java/detect';
export { discoverJavaCandidates, type JavaCandidate } from './java/discover';
export { probeJavaExecutable, type ProbeResult } from './java/probe';
export { selectJavaInstallation, requiredMajor, type JavaDetectionOptions } from './java/select';
export { parseJavaVersion, parseVersionBanner, normaliseArchitecture } from './java/version';
export {
  queryZuluPackages,
  installZuluPackage,
  findJavaExecutable,
  zuluOs,
  zuluArch,
  provisionArch,
  type ZuluPackage,
  type ZuluInstallOutcome,
} from './zulu';
export {
  assembleLaunchConfig,
  filterAgentMounts,
  legacyfixReleaseVersion,
  APPLET_LAUNCHER_CLASS,
  APPLET_CLASS_BY_METHOD,
  type LaunchContext,
  type AssembleOptions,
} from './launch';
export { classifyCrash, classifyStopped, GameProcessManager, watchdogWindowClass, type GameProcessEvents } from './process';
export { canonicalLaunchMethod, detectLaunchMethod, probeIndevEntry, probePreclassicEntry } from './wrapperDetector';
export { extractZipTo, listZipEntryNames, readZipEntries, writeZipEntries, type ZipEntry } from './zip';
export {
  resolveAssetIndexId,
  resolveLaunchAssetIndexId,
  AUTHORITATIVE_ASSET_INDEXES,
  planAssetObjects,
  resourceDirsFromIndex,
  RESOURCE_DIRS_BY_INDEX,
  ASSET_INDEXES,
  type AssetIndexEntry,
  type AssetObjectPlan,
} from './legacyAssets';
export {
  parseModCategories,
  readModRegistry,
  upsertModRegistry,
  removeModRegistry,
  downloadInfoAtomic,
  refreshModInfo,
  isModVersionJson,
  composeModJars,
  modMissingMessage,
  type Downloader,
  type ModRegistryEntry,
  type ModRegistry,
} from './mods';
export {
  parseServerList,
  normalizePreferredVersion,
  matchVersionId,
} from './servers';
export {
  DEFAULT_MS_CLIENT_ID,
  MS_HOST_WHITELIST,
  isMsEndpointAllowed,
  DPAPI_PREFIX,
  MsAuthError,
  MsAbortError,
  javaUrlEncode,
  requestDeviceCode,
  pollDeviceToken,
  refreshMsToken,
  xblAuthenticate,
  xstsAuthenticate,
  mcsLogin,
  mcProfile,
  runAuthTail,
  joinServer,
  sha1ServerId,
  encodeTokenSecret,
  decodeTokenSecret,
  type DpapiDeps,
  type JoinServerInput,
  type LookupFn,
  type MsAuthDeps,
  type MsChainResult,
  type MsDeviceCodeIssue,
  type MsProfileResult,
  type MsTokenPair,
  type MsXblResult,
  type SleepFn,
} from './microsoftAuth';
export { AtticRuntime, maskSecrets, type AtticRuntimeOptions } from './runtime';
export { compareSemver, checkLatestRelease, type UpdateCheckDeps } from './updateCheck';
export { applyUpdate, pickUpdateAsset, type UpdateApplyDeps } from './updateApply';
export { shouldPromptUpdate } from './updatePolicy';
export { renderMarkdown } from './markdown';

// 契约面透传：壳层只 import 本包即可拿到全部通道常量与类型。
export {
  IPC_CHANNELS,
  IPC_EVENTS,
  NOT_IMPLEMENTED,
  type IpcResult,
  type RendererBridge,
} from '@attic/core-spec';
