<script setup lang="ts">
/**
 * 设置面板：左栏分区导航 + 右栏详情，即改即存（防抖 400ms，无保存按钮）。
 * 分区：通用 / 语言 / 启动与内存 / Java / 外观 / 关于 / 开发者设置；末项「建议与反馈」弹对话框不切页。
 * 启动/Java/关于属重组件（SettingsLaunch/SettingsJava/SettingsAbout）；
 * 语言热切换（setLocale 即时 + settings.language 单一真相）；主题仅模式可用，强调色/背景占位。
 * 宿主动作（打开目录/对话框/清理）无桥时禁用——demo 排版靠假 SystemInfo，动作不伪装可用。
 */
import { computed, ref, watch, type Ref } from 'vue';
import { ACCENT_COLORS, THEME_PRESETS, type EndpointOverrides, type ThemePresetDef } from '@attic/core-spec';
import type { Locale } from '../i18n';
import { AVAILABLE_LOCALES, useI18n } from '../i18n';
import { useBridge } from '../composables/useBridge';
import { useExternalLink } from '../composables/useExternalLink';
import { useSettings } from '../composables/useSettings';
import { useSysInfo } from '../composables/useSysInfo';
import { useSettingsNav } from '../composables/useSettingsNav';
import { useDebouncedField } from '../composables/useDebouncedField';
import SettingToggle from './SettingToggle.vue';
import SettingsLaunch from './SettingsLaunch.vue';
import SettingsJava from './SettingsJava.vue';
import SettingsAbout from './SettingsAbout.vue';
import AppDialog from './AppDialog.vue';
import AppSelect from './AppSelect.vue';
import ConfirmDialog from './ConfirmDialog.vue';

const { t, locale, setLocale } = useI18n();
const { hasBridge, bridge } = useBridge();
const { openExternal } = useExternalLink();
const { settings, patch, patchDetailed, resolvedTheme } = useSettings();
const { info } = useSysInfo();
const { activeSection } = useSettingsNav();

const ENDPOINT_KEYS: (keyof EndpointOverrides)[] = [
  'versionList',
  'filesBase',
  'legacyfixRelease',
  'zuluMetadata',
  'mojangManifest',
];

/** 端点逐键防抖合并写（undefined 键 = 回落内置缺省；下次启动应用后生效）。 */
const endpointLocals = Object.fromEntries(
  ENDPOINT_KEYS.map((k) => [
    k,
    useDebouncedField(
      () => settings.value.endpoints?.[k] ?? '',
      (v) => void patch({ endpoints: { ...settings.value.endpoints, [k]: v.trim() || undefined } }),
    ),
  ]),
) as Record<keyof EndpointOverrides, { local: Ref<string>; savedFlash: Ref<boolean> }>;

// —— 通用栏：数据根（单根+更换/打开，重启生效）与日志（打开/清理/诊断开关） ——
const dataRoot = computed(() => info.value?.dataRoot ?? '');
const logsDir = computed(() => info.value?.logsDir ?? '');
/** 已设定但尚未生效的更换目标（≠ 当前应用根时提示重启）。 */
const pendingRoot = computed(() => {
  const o = settings.value.rootOverride;
  return o && o !== info.value?.dataRoot ? o : '';
});

// —— portable：路径警示常驻黄条 + 面包屑找回一次性提示 ——
/** 警示文案键（分类口径 = runtime classifyPathWarning，向导/设置页共用）。 */
const PATH_WARN_KEYS = {
  non_ascii: 'portable.warnNonAscii',
  space: 'portable.warnSpace',
  long: 'portable.warnLong',
} as const;
const portableWarnText = computed(() => {
  const w = info.value?.portable?.pathWarning;
  return w ? t(PATH_WARN_KEYS[w]) : '';
});
/** 面包屑（默认根登记簿）≠ 生效根 ∧ 便携非回落态 = ini 自定义后指针丢失，给出旧根出路（警告不拦截）。 */
const recoverHintPath = computed(() => {
  const p = info.value?.portable;
  const crumb = settings.value.lastPortableRoot;
  if (!p?.active || p.fallback || !crumb || !info.value) return '';
  return crumb !== info.value.dataRoot ? crumb : '';
});
// 每会话一次性（契约无 ack 键、不为此加通道 = 模块级 flag 兜住；关掉不再复现）
let recoverShownThisSession = false;
const recoverOpen = ref(false);
watch(
  recoverHintPath,
  (v) => {
    if (v && !recoverShownThisSession) {
      recoverShownThisSession = true;
      recoverOpen.value = true;
    }
  },
  { immediate: true },
);

/** 语言下拉选项（AppSelect 形态；自名形态不随 locale 翻译，见 AVAILABLE_LOCALES 注释）。 */
const localeOptions = AVAILABLE_LOCALES.map((l) => ({ value: l.code, label: l.name }));

const diagnosticLog = computed(() => settings.value.diagnosticLog ?? false);

async function openDir(target: 'data-root' | 'logs-dir'): Promise<void> {
  await bridge.openSpecialDir(target);
}

/** 安装目录护栏拒绝的可见错误行（changeRoot 消费）。 */
const rootErr = ref('');

async function changeRoot(): Promise<void> {
  const res = await bridge.pickDirectory();
  if (!res.ok || !res.value) return;
  rootErr.value = '';
  // patchDetailed：护栏拒绝原文必须可见（"实际动作+出路"微文案，静默失败 = 事故温床）
  const r = await patchDetailed({ rootOverride: res.value });
  if (!r.ok) rootErr.value = r.error ?? 'save failed';
}

const clearOpen = ref(false);
const clearing = ref(false);
const clearMsg = ref('');

async function doClearLogs(): Promise<void> {
  clearing.value = true;
  const res = await bridge.clearLogs();
  clearing.value = false;
  clearOpen.value = false;
  if (res.ok) clearMsg.value = res.value > 0 ? t('settings.general.cleared', { n: res.value }) : t('settings.general.clearNothing');
}

// —— 语言栏：热切换（即时应用 + 持久化到 settings.language 单一真相） ——
async function chooseLanguage(code: string): Promise<void> {
  if (code === locale.value) return;
  setLocale(code as Locale);
  await patch({ language: code });
}

// —— 外观栏：预设 + 主题模式 + 强调色板（六族+琥珀缺省，tokens [data-accent] 静态层）+ 背景图 ——
const themes = ['dark', 'light', 'system'] as const;
const accentId = computed(() => settings.value.accentColor || 'amber');

// 预设 = theme+accentColor 组合的快捷写入（推导式，零落盘键）：
// 当前预设由两控件现值反查目录全等命中；任何不匹配 = 自定义态（天然已落盘）。
const activePresetId = computed(
  () =>
    THEME_PRESETS.find(
      (p) => (settings.value.theme ?? 'system') === p.theme && accentId.value === p.accentColor,
    )?.id ?? null,
);
function choosePreset(p: ThemePresetDef): void {
  patch({ theme: p.theme, accentColor: p.accentColor === 'amber' ? undefined : p.accentColor });
}

/** 背景图选择：宿主弹原生对话框 → 路径入 settings（useSettings 保存后重应用 data URL）。 */
const bgErr = ref('');
async function chooseBackground(): Promise<void> {
  const res = await bridge.pickImageFile();
  if (!res.ok || !res.value) {
    if (!res.ok) bgErr.value = res.error;
    return;
  }
  bgErr.value = '';
  const r = await patchDetailed({ backgroundImage: res.value });
  if (!r.ok) bgErr.value = r.error ?? 'save failed';
}
/** 清除外置背景 = 回落内置默认品牌背景（undefined → managed 键删除）。 */
async function clearBackground(): Promise<void> {
  bgErr.value = '';
  const r = await patchDetailed({ backgroundImage: undefined });
  if (!r.ok) bgErr.value = r.error ?? 'save failed';
}

// —— 反馈弹屏（功能建议 → Discussions 的 ideas 分区；Bug → Issues 空白新建页。
// 两侧均不钉模板：仓库无 ISSUE_TEMPLATE/） ——
const feedbackOpen = ref(false);
const FEATURE_URL = 'https://github.com/CreatorCSIE/Attic-Corner-Launcher/discussions/new?category=ideas';
const BUG_URL = 'https://github.com/CreatorCSIE/Attic-Corner-Launcher/issues/new';

function feedback(url: string): void {
  feedbackOpen.value = false;
  // 走 useExternalLink：裸调 openExternalUrl 丢结果 = 无默认浏览器时静默失败，
  // 统一经它包装，失败落全局弹窗
  openExternal(url);
}
</script>

<template>
  <div class="settings">
    <!-- 左栏：分区导航（反馈为弹屏项不切页） -->
    <nav class="menu" :aria-label="t('settings.title')">
      <span class="menu-title">{{ t('settings.title') }}</span>
      <button
        class="menu-item"
        :class="{ 'menu-item--active': activeSection === 'general' }"
        @click="activeSection = 'general'"
      >
        <!-- lucide: settings -->
        <svg class="menu-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
        <span class="menu-label">{{ t('settings.nav.general') }}</span>
      </button>
      <button
        class="menu-item"
        :class="{ 'menu-item--active': activeSection === 'language' }"
        @click="activeSection = 'language'"
      >
        <!-- lucide: globe -->
        <svg class="menu-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="10" />
          <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
          <path d="M2 12h20" />
        </svg>
        <span class="menu-label">{{ t('settings.nav.language') }}</span>
      </button>
      <button
        class="menu-item"
        :class="{ 'menu-item--active': activeSection === 'launch' }"
        @click="activeSection = 'launch'"
      >
        <!-- lucide: rocket -->
        <svg class="menu-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" />
          <path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" />
          <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0" />
          <path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" />
        </svg>
        <span class="menu-label">{{ t('settings.nav.launch') }}</span>
      </button>
      <button
        class="menu-item"
        :class="{ 'menu-item--active': activeSection === 'java' }"
        @click="activeSection = 'java'"
      >
        <!-- lucide: coffee -->
        <svg class="menu-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M17 8h1a4 4 0 1 1 0 8h-1" />
          <path d="M3 8h14v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4Z" />
          <path d="M6 2v2" />
          <path d="M10 2v2" />
          <path d="M14 2v2" />
        </svg>
        <span class="menu-label">{{ t('settings.nav.java') }}</span>
      </button>
      <button
        class="menu-item"
        :class="{ 'menu-item--active': activeSection === 'theme' }"
        @click="activeSection = 'theme'"
      >
        <!-- 对比圆（主题/外观通用形态：右半实心） -->
        <svg class="menu-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="10" />
          <path d="M12 2v20" />
          <path d="M12 2a10 10 0 0 1 0 20z" fill="currentColor" stroke="none" />
        </svg>
        <span class="menu-label">{{ t('settings.nav.theme') }}</span>
      </button>
      <button
        class="menu-item"
        :class="{ 'menu-item--active': activeSection === 'about' }"
        @click="activeSection = 'about'"
      >
        <!-- lucide: info -->
        <svg class="menu-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="10" />
          <path d="M12 16v-4" />
          <path d="M12 8h.01" />
        </svg>
        <span class="menu-label">{{ t('settings.nav.about') }}</span>
      </button>
      <button
        class="menu-item"
        :class="{ 'menu-item--active': activeSection === 'developer' }"
        @click="activeSection = 'developer'"
      >
        <!-- lucide: code -->
        <svg class="menu-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="m16 18 6-6-6-6" />
          <path d="m8 6-6 6 6 6" />
        </svg>
        <span class="menu-label">{{ t('settings.nav.developer') }}</span>
      </button>

      <button class="menu-item" @click="feedbackOpen = true">
        <!-- lucide: message-square -->
        <svg class="menu-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
        <span class="menu-label">{{ t('settings.nav.feedback') }}</span>
      </button>
    </nav>

    <!-- 右栏：详情（内容列在剩余空间内浮中） -->
    <div class="detail">
      <div class="detail-inner">
        <!-- 通用 -->
        <section v-if="activeSection === 'general'" class="pane">
          <h3 class="pane-title">{{ t('settings.sectionGeneral') }}</h3>

          <div class="card">
            <h4 class="group-title">{{ t('settings.general.dataRoot') }}</h4>
            <p class="row-desc">{{ t('settings.general.dataRootDesc') }}</p>
            <p class="path mono" :title="dataRoot">{{ dataRoot || '—' }}</p>
            <div class="btn-row">
              <button class="mini" :disabled="!hasBridge" @click="openDir('data-root')">{{ t('settings.general.open') }}</button>
              <button class="mini" :disabled="!hasBridge" @click="changeRoot">{{ t('settings.general.change') }}</button>
            </div>
            <p v-if="pendingRoot" class="warn">{{ t('settings.general.rootPending', { path: pendingRoot }) }}</p>
            <p v-if="rootErr" class="warn root-err" role="alert">{{ rootErr }}</p>
            <!-- 生效根路径警示常驻（警告不拦截，翻车面留给用户决策） -->
            <p v-if="portableWarnText" class="warn">{{ portableWarnText }}</p>
            <!-- 面包屑找回一次性提示（ini 自定义后指针丢失的兜底出路） -->
            <p v-if="recoverOpen && recoverHintPath" class="warn root-err">
              {{ t('portable.recoverHint', { path: recoverHintPath }) }}
              <button class="mini" type="button" @click="recoverOpen = false">{{ t('portable.recoverDismiss') }}</button>
            </p>
          </div>

          <div class="card">
            <h4 class="group-title">{{ t('settings.general.logs') }}</h4>
            <p class="path mono" :title="logsDir">{{ logsDir || '—' }}</p>
            <div class="btn-row">
              <button class="mini" :disabled="!hasBridge" @click="openDir('logs-dir')">{{ t('settings.general.open') }}</button>
              <button class="mini" :disabled="!hasBridge" @click="clearOpen = true">{{ t('settings.general.logsClear') }}</button>
            </div>
            <p v-if="clearMsg" class="ok-line">{{ clearMsg }}</p>
            <SettingToggle
              :model-value="diagnosticLog"
              :label="t('settings.general.diagLog')"
              :desc="t('settings.general.diagLogDesc')"
              @update:model-value="patch({ diagnosticLog: $event })"
            />
          </div>
        </section>

        <!-- 语言 -->
        <section v-else-if="activeSection === 'language'" class="pane">
          <h3 class="pane-title">{{ t('settings.sectionLanguage') }}</h3>
          <div class="card">
            <div class="field">
              <label class="label" for="lang">{{ t('settings.language.label') }}</label>
              <AppSelect
                id="lang"
                :model-value="locale"
                :options="localeOptions"
                @update:model-value="chooseLanguage"
              />
              <p class="row-desc">{{ t('settings.language.hint') }}</p>
            </div>
          </div>
        </section>

        <!-- 启动与内存 / Java / 关于：重组件 -->
        <SettingsLaunch v-else-if="activeSection === 'launch'" />
        <SettingsJava v-else-if="activeSection === 'java'" />
        <SettingsAbout v-else-if="activeSection === 'about'" />

        <!-- 外观 -->
        <section v-else-if="activeSection === 'theme'" class="pane">
          <h3 class="pane-title">{{ t('settings.sectionTheme') }}</h3>
          <div class="card">
            <div class="field">
              <span class="label">{{ t('settings.theme.presets') }}</span>
              <div class="preset-row" role="radiogroup" :aria-label="t('settings.theme.presets')">
                <button
                  v-for="p in THEME_PRESETS"
                  :key="p.id"
                  class="preset-btn"
                  :class="{ 'preset-btn--active': activePresetId === p.id }"
                  role="radio"
                  :aria-checked="activePresetId === p.id"
                  @click="choosePreset(p)"
                >
                  <!-- 预览胶囊：自带 data-theme/data-accent，tokens 静态层在按钮内派生
                       --surface-3（底色档）与 --accent（强调点），system 档现值走 resolvedTheme -->
                  <span
                    class="preset-chip"
                    :data-theme="p.theme === 'system' ? resolvedTheme : p.theme"
                    :data-accent="p.accentColor"
                  >
                    <span class="preset-chip-dot" />
                  </span>
                  {{ t(p.nameKey) }}
                </button>
                <span v-if="!activePresetId" class="preset-custom">{{ t('settings.theme.custom') }}</span>
              </div>
              <p class="row-desc">{{ t('settings.theme.presetsDesc') }}</p>
            </div>
          </div>
          <div class="card">
            <div class="field">
              <span class="label">{{ t('settings.theme.mode') }}</span>
              <div class="segmented">
                <button
                  v-for="th in themes"
                  :key="th"
                  class="seg"
                  :class="{ 'seg--active': (settings.theme ?? 'system') === th }"
                  @click="patch({ theme: th })"
                >
                  {{ t(`settings.theme.${th}`) }}
                </button>
              </div>
            </div>
          </div>
          <div class="card">
            <div class="field">
              <span class="label">{{ t('settings.theme.accent') }}</span>
              <!-- swatch 预览技巧：按钮自带 data-theme + data-accent，
                   tokens 的 [data-theme][data-accent] 块在按钮自身派生 --accent，色点即所见即所得 -->
              <div class="accent-row" role="radiogroup" :aria-label="t('settings.theme.accent')">
                <button
                  v-for="c in ACCENT_COLORS"
                  :key="c.id"
                  class="accent-swatch"
                  :class="{ 'accent-swatch--active': accentId === c.id }"
                  :data-theme="resolvedTheme"
                  :data-accent="c.id"
                  role="radio"
                  :aria-checked="accentId === c.id"
                  :title="t(c.nameKey)"
                  @click="patch({ accentColor: c.id === 'amber' ? undefined : c.id })"
                >
                  <span class="accent-dot" />
                </button>
              </div>
              <p class="row-desc">{{ t('settings.theme.accentDesc') }}</p>
            </div>
          </div>
          <div class="card">
            <div class="field">
              <span class="label">{{ t('settings.theme.background') }}</span>
              <div class="btn-row">
                <button class="mini" :disabled="!hasBridge" @click="chooseBackground">
                  {{ t('settings.theme.backgroundPick') }}
                </button>
                <button v-if="settings.backgroundImage" class="mini" @click="clearBackground">
                  {{ t('settings.theme.backgroundClear') }}
                </button>
              </div>
              <p class="path mono" :title="settings.backgroundImage || ''">
                {{ settings.backgroundImage || t('settings.theme.backgroundDefault') }}
              </p>
              <p v-if="bgErr" class="warn root-err" role="alert">{{ bgErr }}</p>
              <p class="row-desc">{{ t('settings.theme.backgroundDesc') }}</p>
            </div>
          </div>
        </section>

        <!-- 开发者设置（endpoints+username 收编于此，发行时再评估可见性） -->
        <section v-else class="pane">
          <h3 class="pane-title">{{ t('settings.sectionDeveloper') }}</h3>
          <div class="card">
            <div class="head-row">
              <h4 class="group-title">{{ t('settings.developer.endpoints') }}</h4>
              <span class="note">{{ t('settings.developer.endpointsNote') }}</span>
            </div>
            <div v-for="k in ENDPOINT_KEYS" :key="k" class="field">
              <label class="label" :for="`ep-${k}`">{{ k }}</label>
              <input :id="`ep-${k}`" v-model="endpointLocals[k].local.value" class="input mono" type="text" />
              <!-- 即改即存回执（400ms 防抖落盘后亮 1.5s；绝对定位零布局抖动） -->
              <span v-if="endpointLocals[k].savedFlash.value" class="saved-flash">{{ t('settings.saved') }}</span>
            </div>
          </div>
        </section>
      </div>
    </div>

    <!-- 反馈弹屏（不切页，纯外链两条大按钮） -->
    <AppDialog :open="feedbackOpen" @close="feedbackOpen = false">
      <header class="fb-head">
        <h2 class="fb-title">{{ t('settings.feedback.title') }}</h2>
        <p class="fb-sub">{{ t('settings.feedback.subtitle') }}</p>
      </header>
      <div class="fb-list">
        <button class="fb-item" @click="feedback(FEATURE_URL)">
          <!-- lucide: lightbulb -->
          <svg class="menu-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5" />
            <path d="M9 18h6" />
            <path d="M10 22h4" />
          </svg>
          <span class="fb-info">
            <span class="fb-name">{{ t('settings.feedback.feature') }}</span>
            <span class="fb-desc">{{ t('settings.feedback.featureDesc') }}</span>
          </span>
        </button>
        <button class="fb-item" @click="feedback(BUG_URL)">
          <!-- lucide: bug -->
          <svg class="menu-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="m8 2 1.88 1.88" />
            <path d="M14.12 3.88 16 2" />
            <path d="M9 7v1a3 3 0 0 0 6 0V7" />
            <path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6" />
            <path d="M12 20v-9" />
            <path d="M6.53 9C4.6 8.8 3 7.1 3 5" />
            <path d="M6 13H2" />
            <path d="M3 21c0-2.1 1.7-3.9 3.8-4" />
            <path d="M20.97 5c0 2.1-1.7 3.8-3.5 4" />
            <path d="M22 13h-4" />
            <path d="M17.2 17c0 2.1 1.9 3.9 4 4" />
          </svg>
          <span class="fb-info">
            <span class="fb-name">{{ t('settings.feedback.bug') }}</span>
            <span class="fb-desc">{{ t('settings.feedback.bugDesc') }}</span>
          </span>
        </button>
      </div>
      <footer class="fb-foot">
        <button class="ghost" @click="feedbackOpen = false">{{ t('common.cancel') }}</button>
      </footer>
    </AppDialog>

    <!-- 清理日志确认（防误删） -->
    <ConfirmDialog
      v-model:open="clearOpen"
      :busy="clearing"
      :title="t('settings.general.clearConfirmTitle')"
      :message="t('settings.general.clearConfirmMessage')"
      @confirm="doClearLogs"
    />
  </div>
</template>

<style scoped>
.settings {
  display: flex;
  flex: 1;
  gap: var(--space-5);
  min-height: 0;
  padding: var(--space-5);
}
/* —— 左栏分区导航：与实例/账户/自定义版本页同构的卡片列（非贴边侧栏） —— */
.menu {
  flex: 0 0 248px;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-5) var(--space-4);
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-card);
  overflow-y: auto;
}
.menu-title {
  margin: 0 0 var(--space-3) var(--space-2);
  font-size: var(--fs-xl);
  font-weight: 700;
  color: var(--text-primary);
}
.menu-item {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  width: 100%;
  padding: var(--space-2) var(--space-3);
  background: transparent;
  border: none;
  border-radius: var(--radius-md);
  color: var(--text-secondary);
  font-size: var(--fs-md);
  text-align: left;
  cursor: pointer;
  transition:
    background-color var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out);
}
.menu-item:hover {
  background-color: var(--surface-3);
}
.menu-item--active {
  background-color: var(--surface-3);
  box-shadow: inset 0 0 0 1px var(--surface-4);
  color: var(--text-primary);
}
.menu-icon {
  flex: 0 0 18px;
  width: 18px;
  height: 18px;
}
.menu-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* —— 右栏详情：滚动 + 内容列浮中 —— */
.detail {
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
  padding: var(--space-6);
}
.detail-inner {
  max-width: 680px;
  margin-inline: auto;
}
.pane {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}
.pane-title {
  margin: 0;
  font-size: var(--fs-lg);
  font-weight: 600;
}
.card {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-5);
  background: var(--card-bg);
  border: 1px solid var(--card-border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-card);
}
.group-title {
  margin: 0;
  font-size: var(--fs-xs);
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.head-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-3);
}
.field {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
/* 即改即存回执徽标：label 行右侧绝对定位（出现/消失不推动布局） */
.saved-flash {
  position: absolute;
  top: 0;
  right: 0;
  font-size: var(--fs-xs);
  color: var(--ok);
  animation: saved-in var(--dur-fast) var(--ease-out);
}
@keyframes saved-in {
  from {
    opacity: 0;
    transform: translateY(2px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
.label {
  font-size: var(--fs-sm);
  font-weight: 600;
  color: var(--text-primary);
}
.row-name {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--fs-sm);
  font-weight: 600;
  color: var(--text-primary);
}
.row-desc {
  margin: 0;
  font-size: var(--fs-xs);
  color: var(--text-muted);
}
.path {
  margin: 0;
  padding: var(--space-2) var(--space-3);
  font-size: var(--fs-xs);
  color: var(--text-secondary);
  background: var(--surface-1);
  border-radius: var(--radius-md);
  box-shadow: var(--input-inset);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.btn-row {
  display: flex;
  gap: var(--space-3);
}
.mini {
  padding: var(--space-2) var(--space-4);
  background: transparent;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-md);
  font-size: var(--fs-sm);
  color: var(--text-primary);
  box-shadow: var(--inset-bottom);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease-out);
}
.mini:hover:not(:disabled) {
  background: var(--surface-4);
}
.mini:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.warn {
  margin: 0;
  font-size: var(--fs-xs);
  color: var(--warn);
}
/* 护栏拒绝行：danger 语义高于 warn（不可逆事故被拦下的告知） */
.root-err {
  color: var(--danger);
}
.ok-line {
  margin: 0;
  font-size: var(--fs-xs);
  color: var(--ok);
}
.note {
  font-size: var(--fs-xs);
  color: var(--warn);
}
/* —— 强调色板行：swatch 按钮 = 描边环 + 内圆点；圆点色经 data-accent 自派生（见模板注） —— */
.accent-row {
  display: flex;
  gap: var(--space-3);
  flex-wrap: wrap;
}
/* —— 预设主题按钮（胶囊预览 = 底色档 + 强调点；选中态描边沿用 accent-swatch 语言） —— */
.preset-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
}
.preset-btn {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-4);
  background: var(--surface-1);
  border: 2px solid transparent;
  border-radius: var(--radius-pill);
  color: var(--text-secondary);
  box-shadow: var(--input-inset);
  cursor: pointer;
  transition: border-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.preset-btn:hover {
  border-color: var(--border-strong);
}
.preset-btn--active {
  border-color: var(--text-secondary);
  color: var(--text-primary);
}
.preset-chip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 18px;
  border-radius: var(--radius-sm);
  background: var(--surface-3);
  box-shadow: var(--inset-bottom);
}
.preset-chip-dot {
  width: 10px;
  height: 10px;
  border-radius: var(--radius-pill);
  background: var(--accent);
}
.preset-custom {
  color: var(--text-muted);
  font-size: var(--fs-sm);
  font-style: italic;
}
.accent-swatch {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  padding: 0;
  background: transparent;
  border: 2px solid transparent;
  border-radius: var(--radius-pill);
  cursor: pointer;
  transition: border-color var(--dur-fast) var(--ease-out);
}
.accent-swatch:hover {
  border-color: var(--border-strong);
}
.accent-swatch--active {
  border-color: var(--text-secondary);
}
.accent-dot {
  width: 22px;
  height: 22px;
  border-radius: var(--radius-pill);
  background: var(--accent);
  box-shadow: var(--inset-bottom);
}
.input {
  padding: var(--space-3) var(--space-4);
  background: var(--surface-3);
  border: none;
  border-radius: var(--radius-md);
  color: var(--text-primary);
  box-shadow: var(--input-inset);
}
.input:focus-visible {
  outline: none;
  box-shadow: var(--input-focus-shadow);
}
.mono {
  font-family: var(--font-mono);
}
/* 主题分段器 */
.segmented {
  display: inline-flex;
  gap: var(--space-1);
  padding: var(--space-1);
  background: var(--surface-1);
  border: none;
  border-radius: var(--radius-md);
  box-shadow: var(--input-inset);
  width: fit-content;
}
.seg {
  padding: var(--space-2) var(--space-4);
  background: transparent;
  border: none;
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.seg:hover {
  background: var(--surface-3);
}
.seg--active {
  background: var(--surface-4);
  color: var(--text-primary);
}
/* —— 反馈弹屏：两条外链大按钮行（图标+标题+描述，零表单） —— */
.fb-head {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.fb-title {
  margin: 0;
  font-size: var(--fs-xl);
  font-weight: 700;
  color: var(--text-primary);
}
.fb-sub {
  margin: 0;
  font-size: var(--fs-sm);
  color: var(--text-secondary);
}
.fb-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin-top: var(--space-4);
}
.fb-item {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-4);
  background: var(--surface-3);
  border: 1px solid var(--card-border);
  border-radius: var(--radius-md);
  color: var(--text-primary);
  text-align: left;
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease-out);
}
.fb-item:hover {
  background: var(--surface-4);
}
.fb-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.fb-name {
  font-size: var(--fs-md);
  font-weight: 600;
}
.fb-desc {
  font-size: var(--fs-xs);
  color: var(--text-muted);
}
.fb-foot {
  display: flex;
  justify-content: flex-end;
  margin-top: var(--space-4);
}
.ghost {
  padding: var(--space-2) var(--space-5);
  background: var(--surface-3);
  border: 1px solid var(--card-border);
  border-radius: var(--radius-md);
  box-shadow: var(--inset-bottom);
  color: var(--text-primary);
  cursor: pointer;
}
.ghost:hover {
  background: var(--surface-4);
}
</style>
