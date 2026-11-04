/**
 * 渲染侧 AppSettings / InstanceView ↔ 宿主 properties 文件的映射。
 * 设置是数据，落 `launcher.settings`（v1 格式）；本模块只做形状转换，不碰文件。
 * 未知键一律保留——launcher.settings 可能含 v1 遗留键，写回时不得丢失。
 */

import type { AppSettings, EndpointOverrides, InstanceView, ThemeMode } from '@attic/core-spec';

const ENDPOINT_PREFIX = 'endpoint.';
const ENDPOINT_KEYS: (keyof EndpointOverrides)[] = [
  'versionList',
  'filesBase',
  'legacyfixRelease',
  'zuluMetadata',
];
const THEMES: ThemeMode[] = ['dark', 'light', 'system'];
const MEMORY_MODES: string[] = ['auto', 'manual'];
const UPDATE_POLICIES: string[] = ['startup', 'off'];

/** properties 布尔三态：'true'→true / 'false'→false / 其他（含缺失）→undefined（= 消费端缺省）。 */
function boolFromProps(v: string | undefined): boolean | undefined {
  if (v === 'true') return true;
  if (v === 'false') return false;
  return undefined;
}

/**
 * 内存 auto 模式估算（BlockHelm 公式的 Attic 变体）：总内存 40% 取 128 步长，
 * 夹在 [512, 2048]——老版本场景堆需求低，上探 2G 无益（实例 launchArgs 仍可覆盖一切）。
 * totalMemMb<=0（宿主取不到）回落 1024（与历史定值缺省一致）。
 */
export function estimateMaxMemoryMb(totalMemMb: number): number {
  if (!(totalMemMb > 0)) return 1024;
  const want = Math.round((totalMemMb * 0.4) / 128) * 128;
  return Math.min(Math.max(want, 512), 2048);
}

/** 从 launcher.settings 的扁平属性读出渲染侧设置视图（缺省字段省略）。 */
export function settingsFromProps(props: Record<string, string>): AppSettings {
  const out: AppSettings = {};
  if (props['javaPath']) out.javaPath = props['javaPath'];
  const mem = Number(props['maxMemoryMb']);
  if (Number.isFinite(mem) && mem > 0) out.maxMemoryMb = mem;
  if (MEMORY_MODES.includes(props['memoryMode'] ?? '')) out.memoryMode = props['memoryMode'] as 'auto' | 'manual';
  if (THEMES.includes(props['theme'] as ThemeMode)) out.theme = props['theme'] as ThemeMode;
  if (props['language']) out.language = props['language'];
  if (props['jvmArgs']) out.jvmArgs = props['jvmArgs'];
  const checkIntegrity = boolFromProps(props['checkIntegrity']);
  if (checkIntegrity !== undefined) out.checkIntegrity = checkIntegrity;
  const fixMissing = boolFromProps(props['fixMissing']);
  if (fixMissing !== undefined) out.fixMissing = fixMissing;
  const minimizeOnLaunch = boolFromProps(props['minimizeOnLaunch']);
  if (minimizeOnLaunch !== undefined) out.minimizeOnLaunch = minimizeOnLaunch;
  const diagnosticLog = boolFromProps(props['diagnosticLog']);
  if (diagnosticLog !== undefined) out.diagnosticLog = diagnosticLog;
  const consoleOnLaunch = boolFromProps(props['consoleOnLaunch']);
  if (consoleOnLaunch !== undefined) out.consoleOnLaunch = consoleOnLaunch;
  if (props['rootOverride']) out.rootOverride = props['rootOverride'];
  const wizardDone = boolFromProps(props['wizardDone']);
  if (wizardDone !== undefined) out.wizardDone = wizardDone;
  if (props['wizardFlavor'] === 'installed' || props['wizardFlavor'] === 'portable') {
    out.wizardFlavor = props['wizardFlavor'];
  }
  if (props['lastPortableRoot']) out.lastPortableRoot = props['lastPortableRoot'];
  const portableFallback = boolFromProps(props['portableFallback']);
  if (portableFallback !== undefined) out.portableFallback = portableFallback;
  if (props['levelServer']) out.levelServer = props['levelServer'];
  // 更新策略/忽略账：非法值缺省省略（消费端 ?? 'startup'）；
  // updateIgnoreVersion 空串视同无键（与其余字符串 managed 键同纪律）。
  if (UPDATE_POLICIES.includes(props['updatePolicy'] ?? '')) {
    out.updatePolicy = props['updatePolicy'] as 'startup' | 'off';
  }
  if (props['updateIgnoreVersion']) out.updateIgnoreVersion = props['updateIgnoreVersion'];
  const updatePreview = boolFromProps(props['updatePreview']);
  if (updatePreview !== undefined) out.updatePreview = updatePreview;
  if (props['accentColor']) out.accentColor = props['accentColor'];
  if (props['backgroundImage']) out.backgroundImage = props['backgroundImage'];
  if (props['microsoftClientId']) out.microsoftClientId = props['microsoftClientId'];

  const endpoints: EndpointOverrides = {};
  let hasEndpoint = false;
  for (const key of ENDPOINT_KEYS) {
    const v = props[`${ENDPOINT_PREFIX}${key}`];
    if (v) {
      endpoints[key] = v;
      hasEndpoint = true;
    }
  }
  if (hasEndpoint) out.endpoints = endpoints;
  return out;
}

/**
 * 把 AppSettings 合并进既有属性（managed 键有值则写、无值则删；未知键原样保留）。
 * 返回新对象，不改入参。
 */
export function applySettingsToProps(
  existing: Record<string, string>,
  settings: AppSettings,
): Record<string, string> {
  const next: Record<string, string> = { ...existing };

  const put = (key: string, value: string | undefined): void => {
    if (value === undefined || value === '') delete next[key];
    else next[key] = value;
  };

  put('javaPath', settings.javaPath);
  put('maxMemoryMb', settings.maxMemoryMb === undefined ? undefined : String(settings.maxMemoryMb));
  put('memoryMode', settings.memoryMode);
  // username（v1 遗留键）不在 managed 键集：本行不再出现 = 文件里
  // 既有的 username 键按「未知键原样保留」纪律自然不动，v1 数据面零破坏。
  put('theme', settings.theme);
  put('language', settings.language);
  put('jvmArgs', settings.jvmArgs);
  put('checkIntegrity', settings.checkIntegrity === undefined ? undefined : String(settings.checkIntegrity));
  put('fixMissing', settings.fixMissing === undefined ? undefined : String(settings.fixMissing));
  put('minimizeOnLaunch', settings.minimizeOnLaunch === undefined ? undefined : String(settings.minimizeOnLaunch));
  put('diagnosticLog', settings.diagnosticLog === undefined ? undefined : String(settings.diagnosticLog));
  put('consoleOnLaunch', settings.consoleOnLaunch === undefined ? undefined : String(settings.consoleOnLaunch));
  put('rootOverride', settings.rootOverride);
  put('wizardDone', settings.wizardDone === undefined ? undefined : String(settings.wizardDone));
  put('wizardFlavor', settings.wizardFlavor);
  put('lastPortableRoot', settings.lastPortableRoot);
  put('portableFallback', settings.portableFallback === undefined ? undefined : String(settings.portableFallback));
  put('levelServer', settings.levelServer);
  put('updatePolicy', settings.updatePolicy);
  put('updateIgnoreVersion', settings.updateIgnoreVersion);
  put('updatePreview', settings.updatePreview === undefined ? undefined : String(settings.updatePreview));
  put('accentColor', settings.accentColor);
  put('backgroundImage', settings.backgroundImage);
  put('microsoftClientId', settings.microsoftClientId);

  for (const key of ENDPOINT_KEYS) {
    put(`${ENDPOINT_PREFIX}${key}`, settings.endpoints?.[key]);
  }
  return next;
}

/** 实例视图 ↔ v1 InstanceConfig（对齐 v1 Instance Settings 可编辑集，全字段往返）。 */
export function instanceViewFromConfig(config: {
  name: string;
  version: string;
  gameDir?: string;
  launchArgs?: string;
  width?: number;
  height?: number;
  javaPath?: string;
  addons?: string;
  server?: string;
  intelFix?: boolean;
  forceUpdate?: boolean;
}): InstanceView {
  const view: InstanceView = { name: config.name, version: config.version };
  if (config.gameDir) view.gameDir = config.gameDir;
  if (config.launchArgs) view.launchArgs = config.launchArgs;
  if (config.width !== undefined) view.width = config.width;
  if (config.height !== undefined) view.height = config.height;
  if (config.javaPath) view.javaPath = config.javaPath;
  // v1 `addons` 档案键 = 逗号分隔；空串 = 显式全关（与"无键 = legacyfix 缺省"区分，不可丢弃）
  if (config.addons !== undefined) {
    view.addons = config.addons.split(',').map((s) => s.trim()).filter(Boolean);
  }
  if (config.intelFix !== undefined) view.intelFix = config.intelFix;
  if (config.forceUpdate !== undefined) view.forceUpdate = config.forceUpdate;
  // 直连地址：空串 = 无效值（视图不携带，保存即删键）
  if (config.server) view.server = config.server;
  return view;
}
