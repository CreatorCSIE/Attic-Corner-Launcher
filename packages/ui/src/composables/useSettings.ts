/**
 * useSettings —— 全局设置共享状态 + 主题应用。
 * 主题属渲染侧（契约只持久化 mode）；system 经 matchMedia 解析为 dark/light 落到 data-theme。
 * 写入走桥 setSettings（合并落盘属 runtime 职责）。
 */

import { computed, ref, type ComputedRef } from 'vue';
import type { AppSettings, ThemeMode } from '@attic/core-spec';
import { locale, setLocale } from '../i18n';
import { useBridge } from './useBridge';

const settings = ref<AppSettings>({});
const loaded = ref(false);
const saving = ref(false);
let started = false;

const { bridge } = useBridge();

function prefersDark(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-color-scheme: dark)').matches;
}

function resolveMode(mode: ThemeMode | undefined): 'dark' | 'light' {
  if (mode === 'dark' || mode === 'light') return mode;
  return prefersDark() ? 'dark' : 'light';
}

function applyTheme(): void {
  if (typeof document === 'undefined') return;
  const el = document.documentElement;
  el.setAttribute('data-theme', resolveMode(settings.value.theme));
  // 强调色板（tokens.css [data-theme][data-accent] 静态层，缺省 amber = 无覆写块回落原值）
  el.setAttribute('data-accent', settings.value.accentColor || 'amber');
  void applyBackground();
}

/** 背景图应用序号：连续 patch（防抖保存链）时丢弃过期读取结果，后发胜出。 */
let bgSeq = 0;

/**
 * 外置背景图 → `--app-bg-image` + `--app-bg-overlay` + `data-bg-image`（宿主 data URL，双壳统一）。
 * 仅配置时启用（无内置默认图，缺省 = 纯色主题底）；
 * 缺省/读取失败 = 全部移除回落纯色（可见失败已由选择动作当场承担，应用侧静默兜底）。
 * data-bg-image 同时驱动舞台浮空元素的亮字重映射（无图浅底时那些覆写必须撤除）。
 */
async function applyBackground(): Promise<void> {
  if (typeof document === 'undefined') return;
  const el = document.documentElement;
  const filePath = settings.value.backgroundImage;
  const seq = ++bgSeq;
  const clear = () => {
    el.style.removeProperty('--app-bg-image');
    el.style.removeProperty('--app-bg-overlay');
    el.removeAttribute('data-bg-image');
  };
  if (!filePath) {
    clear();
    return;
  }
  const res = await bridge.readImageAsDataUrl(filePath);
  if (seq !== bgSeq) return;
  if (res.ok && res.value) {
    el.style.setProperty('--app-bg-image', `url("${res.value}")`);
    // 固定暗遮罩（Modrinth splash 暗色配方）：文字亮字重映射以此为前提
    el.style.setProperty('--app-bg-overlay', 'linear-gradient(rgba(22, 24, 28, 0.64), rgba(22, 24, 28, 0.64))');
    el.setAttribute('data-bg-image', 'on');
  } else {
    clear();
  }
}

if (typeof window !== 'undefined') {
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const onChange = () => {
    if ((settings.value.theme ?? 'system') === 'system') applyTheme();
  };
  if (typeof media.addEventListener === 'function') media.addEventListener('change', onChange);
  else if (typeof (media as MediaQueryList).addListener === 'function')
    (media as MediaQueryList).addListener(onChange);
}

const themeMode = computed<ThemeMode>(() => settings.value.theme ?? 'system');

/** 解析后的实际主题（swatch 预览等需要按 dark/light 取 accent 档的消费点用）。 */
const resolvedTheme = computed<'dark' | 'light'>(() => resolveMode(settings.value.theme));

async function load(): Promise<void> {
  const res = await bridge.getSettings();
  if (res.ok) settings.value = res.value;
  loaded.value = true;
  applyTheme();
  applyLanguage();
}

/** 语言单一真相 = settings.language（localStorage 仅 bootstrap 缓存）；load 后即时无感应用。
 *  键缺席 = 系统语言侦测**只发生这一次**：结果立即写回 settings.language 落盘
 *  （否则 OS 语言变更后界面会跟着漂），此后该值等同用户选择，不再自动改。 */
function applyLanguage(): void {
  const lang = settings.value.language;
  if (lang === 'en' || lang === 'zh-CN' || lang === 'zh-TW') {
    setLocale(lang);
    return;
  }
  void patch({ language: locale.value });
}

/** 合并补丁并落盘；返回是否成功。 */
async function patch(partial: Partial<AppSettings>): Promise<boolean> {
  return (await patchDetailed(partial)).ok;
}

/**
 * patch 的结果版：带宿主拒绝原文（护栏类显式报错需要把"实际动作+出路"文案呈现给用户，
 * 布尔版吞掉了它）。语义与 patch 完全一致，向导等表单用此版。
 */
async function patchDetailed(partial: Partial<AppSettings>): Promise<{ ok: boolean; error?: string }> {
  saving.value = true;
  const next: AppSettings = { ...settings.value, ...partial };
  const res = await bridge.setSettings(next);
  if (res.ok) settings.value = res.value;
  applyTheme();
  saving.value = false;
  return res.ok ? { ok: true } : { ok: false, error: res.error };
}

async function setTheme(mode: ThemeMode): Promise<boolean> {
  return patch({ theme: mode });
}

function ensureLoaded(): void {
  if (started) return;
  started = true;
  void load();
}

export interface SettingsStore {
  settings: typeof settings;
  loaded: typeof loaded;
  saving: typeof saving;
  themeMode: ComputedRef<ThemeMode>;
  resolvedTheme: ComputedRef<'dark' | 'light'>;
  load: () => Promise<void>;
  patch: (p: Partial<AppSettings>) => Promise<boolean>;
  patchDetailed: (p: Partial<AppSettings>) => Promise<{ ok: boolean; error?: string }>;
  setTheme: (m: ThemeMode) => Promise<boolean>;
  ensureLoaded: () => void;
}

export function useSettings(): SettingsStore {
  ensureLoaded();
  return { settings, loaded, saving, themeMode, resolvedTheme, load, patch, patchDetailed, setTheme, ensureLoaded };
}
