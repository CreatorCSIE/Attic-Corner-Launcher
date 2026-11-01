<script setup lang="ts">
/**
 * 设置页 · 关于栏 —— 格式照搬 BlockHelm InfoSettingsView（用户定稿）：
 * 头区（名称 + v版本号 + GitHub/检查更新按钮）→ 启动器更新（策略单选组 + 通道占位）→
 * 版权及法律声明（版权/开源协议/用户协议三行）→ 引用的项目列表。
 * 许可证均经实查不虚构：上游四项目 LICENSE 逐字为 GPL-3.0，Vue/Electron=MIT，Tauri=MIT/Apache-2.0，Lucide=ISC。
 * 外链走 openExternalUrl（宿主白名单校验；浏览器 mock 直放 window.open，demo 可用）；
 * 打开失败（无默认浏览器等）经 useExternalLink 全局弹窗显式报错，不再静默。
 * 检查更新（2026-10-25「更新 UI」定稿）：手动按钮走 checkManually（无视策略与忽略账恒显弹窗），
 * 结果弹窗全局挂 App 层（UpdateDialog），本页只留红点徽标与策略选择。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from '../i18n';
import type { UpdatePolicy } from '@attic/core-spec';
import { useExternalLink } from '../composables/useExternalLink';
import { useSettings } from '../composables/useSettings';
import { useSysInfo } from '../composables/useSysInfo';
import { useUpdateCheck } from '../composables/useUpdateCheck';
import { isDemo } from '../dev/demo';
import AppSelect from './AppSelect.vue';
import appIcon from '../assets/app-icon.png';

const { t } = useI18n();
const { openExternal } = useExternalLink();
const { info } = useSysInfo();
const { settings, patch } = useSettings();
const { busy: checkingBusy, hasUpdate, checkManually } = useUpdateCheck();

/** 更新策略枚举（与 core-spec UpdatePolicy 同序；即选即存，缺省 startup 由消费端 ?? 兜底）。 */
const policies: readonly UpdatePolicy[] = ['startup', 'off'];

// 分段选择器滑动滑块：一块独立高亮层随激活段滑移（非底色生硬硬切）。
// 位置 = offsetLeft/offsetWidth 实测（两段宽度不等 + i18n 各语言文案长度不同，纯 CSS 算不出）；
// ResizeObserver 兜字体加载/语言切换/容器变宽，activePolicy 变更（含 settings 异步到达）经 watch 归位。
const activePolicy = computed<UpdatePolicy>(() => settings.value.updatePolicy ?? 'startup');
const segBox = ref<HTMLElement | null>(null);
const segEls = new Map<UpdatePolicy, HTMLElement>();
const thumbStyle = ref<Record<string, string>>({ opacity: '0' });

function setSegRef(p: UpdatePolicy, el: Element | null): void {
  if (el) segEls.set(p, el as HTMLElement);
  else segEls.delete(p);
}

function locateThumb(): void {
  const el = segEls.get(activePolicy.value);
  if (!el) return;
  thumbStyle.value = {
    transform: `translate(${el.offsetLeft}px, ${el.offsetTop}px)`,
    width: `${el.offsetWidth}px`,
    height: `${el.offsetHeight}px`,
    opacity: '1',
  };
}

let segResize: ResizeObserver | null = null;
onMounted(() => {
  void nextTick(locateThumb);
  if (segBox.value) {
    segResize = new ResizeObserver(() => locateThumb());
    segResize.observe(segBox.value);
  }
});
onBeforeUnmount(() => segResize?.disconnect());
watch(activePolicy, () => void nextTick(locateThumb));

const REPO_URL = 'https://github.com/CreatorCSIE/Attic-Minecraft-Launcher';
const LICENSE_URL = `${REPO_URL}/blob/HEAD/LICENSE`;
const AGREEMENT_URL = `${REPO_URL}/blob/HEAD/USER_AGREEMENT.md`;

// 运行面后缀（宿主版本号零感知，标注全在 UI 侧合成）：
// vite dev server（pnpm/npm run dev）下 DEV=true → `-dev`；?demo=1 时续接 `-demo`
// （isDemo 仅 dev 存活，顺序恒为 -dev-demo）；构建产物两态恒 false，后缀整体消失。
const versionSuffix = `${import.meta.env.DEV ? '-dev' : ''}${isDemo() ? '-demo' : ''}`;

interface ReferenceProject {
  name: string;
  url: string;
  license: string;
  /** i18n 键后缀（settings.about.ref.<key>）。 */
  key: string;
}

// 壳行只显示壳自身（2026-10-29 用户定稿）：Electron 壳列 Electron、Tauri 壳列 Tauri，
// 探测次序与 useBridge 两级真桥探测一致（window.attic 优先）；浏览器直开/demo 无壳，两行皆不列。
const shell: 'electron' | 'tauri' | null =
  typeof window === 'undefined'
    ? null
    : window.attic
      ? 'electron'
      : window.__TAURI__
        ? 'tauri'
        : null;

const allReferences: ReferenceProject[] = [
  { name: 'Betacraft Launcher (v1)', url: 'https://github.com/betacraftuk/betacraft-launcher', license: 'GPL-3.0', key: 'betacraft' },
  { name: 'LegacyFix', url: 'https://github.com/betacraftuk/legacyfix', license: 'GPL-3.0', key: 'legacyfix' },
  { name: 'MCANextGen', url: 'https://github.com/CreatorCSIE/MCANextGen', license: 'GPL-3.0', key: 'mcanextgen' },
  { name: 'BlockHelm Launcher', url: 'https://github.com/zqq-699/BlockHelm-Launcher', license: 'GPL-3.0', key: 'blockhelm' },
  { name: 'HMCL', url: 'https://github.com/huanghongxun/HMCL', license: 'GPL-3.0', key: 'hmcl' },
  { name: 'Vue', url: 'https://github.com/vuejs/core', license: 'MIT', key: 'vue' },
  { name: 'Electron', url: 'https://github.com/electron/electron', license: 'MIT', key: 'electron' },
  { name: 'Tauri', url: 'https://github.com/tauri-apps/tauri', license: 'MIT / Apache-2.0', key: 'tauri' },
  { name: 'Lucide Icons', url: 'https://github.com/lucide-icons/lucide', license: 'ISC', key: 'lucide' },
];

const references = computed(() =>
  allReferences.filter((p) => (p.key === 'electron' || p.key === 'tauri' ? p.key === shell : true)),
);

function openUrl(url: string): void {
  openExternal(url);
}
</script>

<template>
  <section class="pane">
    <h3 class="pane-title">{{ t('settings.sectionAbout') }}</h3>

    <!-- 头区：名称 + 版本 + 动作键（版本号来自宿主快照，无桥时隐藏版本行） -->
    <div class="card head-card">
      <div class="head-brand">
        <span class="head-logo">
          <!-- 品牌图标（源 = apps/tauri/brand/attic-icon.png 母版，与安装包图标同源） -->
          <img :src="appIcon" alt="" />
        </span>
        <div>
          <p class="head-name">{{ t('app.title') }}</p>
          <p v-if="info" class="head-version mono">v{{ info.launcherVersion }}{{ versionSuffix }}</p>
          <p class="head-copyright">{{ t('settings.about.copyright') }}</p>
        </div>
      </div>
      <div class="head-actions">
        <button class="mini" @click="openUrl(REPO_URL)">{{ t('settings.about.ghRepo') }}</button>
        <!-- 检查更新：手动触发（无视策略与忽略账恒显弹窗，UpdateDialog 全局挂载呈现） -->
        <button class="mini" :disabled="checkingBusy" @click="void checkManually()">
          {{ checkingBusy ? t('settings.about.checking') : t('settings.about.checkUpdate') }}
          <span v-if="hasUpdate" class="update-dot">{{ t('settings.about.newBadge') }}</span>
        </button>
      </div>
    </div>

    <!-- 启动器更新：策略单选组（即选即存）+ 更新通道占位（未来更新系统挂载点） -->
    <div class="card">
      <h4 class="group-title">{{ t('settings.about.updateSection') }}</h4>
      <div class="row">
        <div class="row-info">
          <span class="row-name">{{ t('settings.about.updatePolicy.label') }}</span>
          <p class="row-desc">{{ t('settings.about.updatePolicy.desc') }}</p>
        </div>
        <div ref="segBox" class="segmented" role="group" :aria-label="t('settings.about.updatePolicy.label')">
          <span class="seg-thumb" :style="thumbStyle" aria-hidden="true"></span>
          <button
            v-for="p in policies"
            :key="p"
            :ref="(el) => setSegRef(p, el as Element | null)"
            class="seg"
            :class="{ 'seg--active': activePolicy === p }"
            @click="void patch({ updatePolicy: p })"
          >
            {{ t(`settings.about.updatePolicy.${p}`) }}
          </button>
        </div>
      </div>
      <div class="row">
        <div class="row-info">
          <span class="row-name">{{ t('settings.about.updateChannel') }}</span>
          <p class="row-desc">{{ t('settings.about.updateSoon') }}</p>
        </div>
        <AppSelect
          class="select"
          :model-value="'release'"
          :options="[
            { value: 'release', label: t('settings.about.channelRelease') },
            { value: 'beta', label: t('settings.about.channelBeta') },
          ]"
          :aria-label="t('settings.about.updateChannel')"
          disabled
        />
      </div>
    </div>

    <!-- 版权及法律声明 -->
    <div class="card">
      <h4 class="group-title">{{ t('settings.about.legalSection') }}</h4>
      <div class="row">
        <div class="row-info">
          <span class="row-name">{{ t('settings.about.copyrightTitle') }}</span>
          <p class="row-desc">{{ t('settings.about.copyrightDesc') }}</p>
        </div>
        <button class="mini" @click="openUrl(REPO_URL)">{{ t('settings.about.view') }}</button>
      </div>
      <div class="row">
        <div class="row-info">
          <span class="row-name">{{ t('settings.about.license') }}</span>
          <p class="row-desc">{{ t('settings.about.licenseDesc') }}</p>
        </div>
        <button class="mini" @click="openUrl(LICENSE_URL)">{{ t('settings.about.view') }}</button>
      </div>
      <div class="row">
        <div class="row-info">
          <span class="row-name">{{ t('settings.about.agreement') }}</span>
          <p class="row-desc">{{ t('settings.about.agreementDesc') }}</p>
        </div>
        <button class="mini" @click="openUrl(AGREEMENT_URL)">{{ t('settings.about.view') }}</button>
      </div>
    </div>

    <!-- 引用的项目 -->
    <div class="card">
      <h4 class="group-title">{{ t('settings.about.refsSection') }}</h4>
      <div v-for="p in references" :key="p.name" class="row">
        <div class="row-info">
          <span class="row-name">{{ p.name }}</span>
          <p class="row-desc">{{ t(`settings.about.ref.${p.key}`) }}</p>
          <p class="row-license mono">{{ p.license }}</p>
        </div>
        <button class="mini" @click="openUrl(p.url)">{{ t('settings.about.view') }}</button>
      </div>
    </div>
  </section>
</template>

<style scoped>
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
/* GroupBox 标题（BlockHelm LauncherContentSection Header 等效） */
.group-title {
  margin: 0;
  font-size: var(--fs-xs);
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.head-card {
  gap: var(--space-4);
}
.head-brand {
  display: flex;
  align-items: center;
  gap: var(--space-4);
}
.head-logo {
  display: inline-flex;
  width: 56px;
  height: 56px;
  flex: 0 0 auto;
  overflow: hidden;
  border-radius: var(--radius-lg);
}
.head-logo img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.head-name {
  margin: 0;
  font-size: var(--fs-xl);
  font-weight: 600;
  color: var(--text-primary);
}
.head-version {
  margin: var(--space-1) 0 0;
  font-size: var(--fs-sm);
  color: var(--text-secondary);
}
.head-copyright {
  margin: var(--space-1) 0 0;
  font-size: var(--fs-xs);
  color: var(--text-muted);
}
.head-actions {
  display: flex;
  gap: var(--space-3);
}
/* 声明/引用行：左信息 + 右动作（BlockHelm Grid * / Auto 配方） */
.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  padding: var(--space-3) 0;
  border-bottom: 1px solid var(--border);
}
.row:first-of-type {
  padding-top: 0;
}
.row:last-child {
  padding-bottom: 0;
  border-bottom: none;
}
.row-info {
  min-width: 0;
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
  margin: 2px 0 0;
  font-size: var(--fs-xs);
  color: var(--text-muted);
}
.row-license {
  margin: 2px 0 0;
  font-size: var(--fs-xs);
  color: var(--text-secondary);
}
.soon {
  padding: 1px 6px;
  font-size: 10px;
  font-weight: 600;
  color: var(--text-muted);
  background: var(--surface-1);
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
}
/* 有新版红点徽标（复用 .soon 样式位换 danger 色——「有新版」是行动提示，非状态占位） */
.update-dot {
  padding: 1px 6px;
  font-size: 10px;
  font-weight: 600;
  color: var(--danger-ink);
  background: var(--danger);
  border: 1px solid var(--danger);
  border-radius: var(--radius-pill);
}
/* 更新策略分段单选器（SettingsPanel 主题模式选择器同款样式，弹窗已迁出本页） */
.segmented {
  position: relative;
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
  position: relative;
  z-index: 1;
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
/* 激活段底色让位给滑块（滑块滑过去即高亮，文字色仍随类切换） */
.seg--active {
  background: transparent;
  color: var(--text-primary);
}
.seg-thumb {
  position: absolute;
  top: 0;
  left: 0;
  border-radius: var(--radius-sm);
  background: var(--surface-4);
  pointer-events: none;
  transition:
    transform var(--dur-base) var(--ease-out),
    width var(--dur-base) var(--ease-out),
    height var(--dur-base) var(--ease-out),
    opacity var(--dur-fast) var(--ease-out);
}
.mini {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
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
.select {
  flex: 0 0 auto;
}
.mono {
  font-family: var(--font-mono);
}
.input {
  color: var(--text-primary);
}
</style>
