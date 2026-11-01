<script setup lang="ts">
/**
 * Mods 页 —— 双栏形态：
 * 左 = 搜索框 + 刷新钮 + 组件源列表（有且仅有 Betacraft 一个源，不引入加源功能）；
 * 右 = 该源的仓库：分类折页（animated grid-rows 0fr→1fr 两级展开），
 *     条目右侧「下载」= 只落 .info，jar 与基座合成延迟到启动期（runtime 编排）。
 * 列表每次进页现拉 + 手动刷新（无进程内缓存，保证列表新鲜）。
 */
import { computed } from 'vue';
import type { ModCategoryView } from '@attic/core-spec';
import { useI18n } from '../i18n';
import { useMods } from '../composables/useMods';
import { useBridge } from '../composables/useBridge';
import { isDemo } from '../dev/demo';

const { t } = useI18n();
const {
  categories,
  filtered,
  loading,
  error,
  installError,
  installingId,
  query,
  modCount,
  installedCount,
  isOpen,
  toggle,
  load,
  install,
  openWebsite,
} = useMods();
const { hasBridge } = useBridge();

// 动作面门控与其他页一致（浏览器无桥 = 禁用）；demo 桥的假安装在 useBridge 里可演练，放行。
const canInstall = computed(() => hasBridge.value || isDemo());

/** 项目主页 = 工程级属性 → 挂组头折页行（不在逐版本行放外链钮）。
 * 组内各版本 website 通常同源，取首个非空；全无则不显示。 */
function catWebsite(cat: ModCategoryView): string | undefined {
  return cat.mods.find((m) => m.website)?.website;
}
</script>

<template>
  <section class="mods-page">
    <!-- 左栏：搜索 + 刷新 + 组件源（仅 Betacraft） -->
    <aside class="menu">
      <h2 class="menu-title">{{ t('mods.title') }}</h2>

      <div class="menu-tools">
        <div class="search-box">
          <!-- lucide: search -->
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.3-4.3" />
          </svg>
          <input v-model="query" class="search-input" type="text" :placeholder="t('mods.search')" />
        </div>
        <button class="import-btn" type="button" :disabled="loading" @click="load">
          <!-- lucide: refresh-cw -->
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
            <path d="M21 3v5h-5" />
            <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
            <path d="M8 16H3v5" />
          </svg>
          <span>{{ t('mods.refresh') }}</span>
        </button>
      </div>

      <ul class="menu-list">
        <li class="menu-row">
          <!-- 有且仅有一个源 = 选中态常驻（不引入多源/加源） -->
          <div class="menu-item menu-item--selected" :title="'http://api.betacraft.uk'">
            <span class="mi-name">Betacraft</span>
            <span v-if="modCount" class="badge" :class="installedCount ? 'badge--ok' : 'badge--warn'">
              {{ installedCount }} / {{ modCount }}
            </span>
          </div>
        </li>
      </ul>
      <p class="menu-empty-hint">{{ t('mods.sourceHint') }}</p>
    </aside>

    <!-- 右栏：仓库折页列表 -->
    <div class="detail">
      <div v-if="loading && categories.length === 0" class="empty">
        <p class="state-hint">{{ t('common.loading') }}</p>
      </div>

      <div v-else-if="error" class="empty">
        <div class="error-state">
          <p class="state-hint error-text">{{ t('mods.loadError') }}：{{ error }}</p>
          <button class="retry" type="button" @click="load">{{ t('mods.retry') }}</button>
        </div>
      </div>

      <div v-else-if="filtered.length === 0" class="empty">
        <p class="state-hint">{{ categories.length ? t('mods.noMatch') : t('mods.empty') }}</p>
      </div>

      <div v-else class="repo">
        <div class="repo-head">
          <h3 class="id">{{ t('mods.repository') }}</h3>
          <p class="repo-hint">{{ t('mods.hint') }}</p>
        </div>

        <p v-if="installError" class="install-error">{{ installError }}</p>

        <section v-for="cat in filtered" :key="cat.name" class="cat">
          <div class="cat-head-row">
            <button class="cat-head" type="button" :aria-expanded="isOpen(cat.name)" @click="toggle(cat.name)">
              <!-- lucide: chevron-down（开合旋转） -->
              <svg
                class="chevron"
                :class="{ 'chevron--open': isOpen(cat.name) }"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <path d="m6 9 6 6 6-6" />
              </svg>
              <span class="cat-name">{{ cat.name }}</span>
              <span class="cat-count">{{ t('mods.count', { n: cat.mods.length }) }}</span>
            </button>
            <!-- 项目主页外链 = 组头工程级钮（HTML 禁 button 套 button，故并列于行内） -->
            <button
              v-if="catWebsite(cat)"
              class="link-btn cat-link"
              type="button"
              :title="t('mods.website')"
              @click="openWebsite(catWebsite(cat)!)"
            >
              <!-- lucide: external-link -->
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M15 3h6v6" />
                <path d="M10 14 21 3" />
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
              </svg>
            </button>
          </div>

          <!-- animated 折页：grid-template-rows 0fr→1fr（内容免测高） -->
          <div class="fold" :class="{ 'fold--open': isOpen(cat.name) }">
            <div class="fold-inner">
              <ul class="mod-list">
                <li v-for="mod in cat.mods" :key="mod.fullName" class="mod-row">
                  <div class="mod-main">
                    <span class="mod-name" :title="mod.fullName">{{ mod.fullName }}</span>
                    <span class="mod-ver">{{ mod.version }}</span>
                  </div>
                  <div class="mod-actions">
                    <span v-if="mod.installed" class="badge badge--ok">{{ t('mods.installed') }}</span>
                    <button
                      v-else
                      class="dl-btn"
                      type="button"
                      :disabled="!canInstall || installingId !== null"
                      @click="install(mod)"
                    >
                      <!-- lucide: download -->
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                        <polyline points="7 10 12 15 17 10" />
                        <line x1="12" x2="12" y1="15" y2="3" />
                      </svg>
                      <span>{{ installingId === mod.fullName ? t('mods.installing') : t('mods.install') }}</span>
                    </button>
                  </div>
                </li>
              </ul>
            </div>
          </div>
        </section>
      </div>
    </div>
  </section>
</template>

<style scoped>
/* 双栏骨架：左 248px 卡片贴左，右栏内容限宽浮中。 */
.mods-page {
  display: flex;
  flex: 1;
  gap: var(--space-5);
  min-height: 0;
  padding: var(--space-5);
}
.menu {
  flex: 0 0 248px;
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding: var(--space-5) var(--space-4);
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-card);
  overflow-y: auto;
}
.menu-title {
  margin: 0 0 0 var(--space-2);
  font-size: var(--fs-xl);
  font-weight: 700;
  color: var(--text-primary);
}
.menu-tools {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.search-box {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  background: var(--surface-3);
  border-radius: var(--radius-md);
  box-shadow: var(--input-inset);
  transition: box-shadow var(--dur-fast) var(--ease-out);
}
.search-box:focus-within {
  box-shadow: var(--input-focus-shadow);
}
.search-box svg {
  flex: 0 0 16px;
  width: 16px;
  height: 16px;
  color: var(--text-muted);
}
.search-input {
  flex: 1;
  min-width: 0;
  background: transparent;
  border: none;
  outline: none;
  color: var(--text-primary);
  font-size: var(--fs-md);
}
.search-input::placeholder {
  color: var(--text-muted);
}
.import-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  background: var(--accent-soft);
  border: 1px solid var(--accent);
  border-radius: var(--radius-md);
  color: var(--accent);
  font-size: var(--fs-md);
  font-weight: 600;
  cursor: pointer;
  transition:
    background var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out);
}
.import-btn svg {
  flex: 0 0 16px;
  width: 16px;
  height: 16px;
}
.import-btn:hover:not(:disabled) {
  background: var(--accent);
  color: var(--accent-ink);
}
.import-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.menu-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
.menu-row {
  position: relative;
}
.menu-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  width: 100%;
  padding: var(--space-2) var(--space-3);
  background: transparent;
  border: none;
  border-radius: var(--radius-md);
  color: var(--text-primary);
  font-size: var(--fs-md);
  text-align: left;
}
.menu-item--selected {
  background-color: var(--surface-3);
  box-shadow: inset 0 0 0 1px var(--surface-4);
}
.mi-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
}
.menu-empty-hint {
  margin: var(--space-2);
  font-size: var(--fs-sm);
  color: var(--text-muted);
  line-height: 1.5;
}
.badge {
  flex: 0 0 auto;
  padding: 2px var(--space-2);
  border-radius: var(--radius-pill);
  font-size: var(--fs-xs);
  font-weight: 600;
  white-space: nowrap;
}
.badge--ok {
  background: var(--ok-soft);
  color: var(--ok);
}
.badge--warn {
  background: var(--warn-soft);
  color: var(--warn);
}
/* —— 右栏：仓库折页 —— */
.detail {
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
  padding: var(--space-6) var(--space-3);
}
.repo {
  max-width: 620px;
  margin-inline: auto;
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}
.repo-head {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.id {
  margin: 0;
  font-size: var(--fs-xl);
  font-weight: 700;
  color: var(--text-primary);
}
.repo-hint {
  margin: 0;
  font-size: var(--fs-sm);
  color: var(--text-muted);
}
.install-error {
  margin: 0;
  font-size: var(--fs-sm);
  color: var(--danger);
}
.cat {
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  overflow: hidden;
}
/* 组头行 = 开合钮 + 工程级外链钮并列（hover 底色挂整行，两钮共享一条视觉带） */
.cat-head-row {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  padding-right: var(--space-3);
  transition: background-color var(--dur-fast) var(--ease-out);
}
.cat-head-row:hover {
  background-color: var(--surface-3);
}
.cat-head {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex: 1;
  min-width: 0;
  padding: var(--space-3) var(--space-4);
  background: transparent;
  border: none;
  color: var(--text-primary);
  font-size: var(--fs-md);
  font-weight: 600;
  text-align: left;
  cursor: pointer;
}
.cat-link {
  flex: 0 0 auto;
}
.chevron {
  flex: 0 0 16px;
  width: 16px;
  height: 16px;
  color: var(--text-muted);
  transition: transform var(--dur-base) var(--ease-out);
}
.chevron--open {
  transform: rotate(180deg);
}
.cat-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cat-count {
  flex: 0 0 auto;
  font-size: var(--fs-xs);
  font-weight: 500;
  color: var(--text-muted);
}
/* 折页动画：0fr→1fr 行高过渡（内容无需测高），生长曲线用 --dur-grow/--ease-grow */
.fold {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows var(--dur-grow) var(--ease-grow);
}
.fold--open {
  grid-template-rows: 1fr;
}
.fold-inner {
  overflow: hidden;
  min-height: 0;
}
.mod-list {
  list-style: none;
  margin: 0;
  padding: var(--space-1) var(--space-2) var(--space-3);
  display: flex;
  flex-direction: column;
}
.mod-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-2);
  border-radius: var(--radius-sm);
  transition: background-color var(--dur-fast) var(--ease-out);
}
.mod-row:hover {
  background-color: var(--surface-3);
}
.mod-main {
  display: flex;
  align-items: baseline;
  gap: var(--space-3);
  min-width: 0;
}
.mod-name {
  font-size: var(--fs-md);
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mod-ver {
  flex: 0 0 auto;
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  color: var(--text-muted);
}
.mod-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: 0 0 auto;
}
.link-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  background: transparent;
  border: none;
  border-radius: var(--radius-sm);
  color: var(--text-muted);
  cursor: pointer;
  transition:
    color var(--dur-fast) var(--ease-out),
    background var(--dur-fast) var(--ease-out);
}
.link-btn svg {
  width: 15px;
  height: 15px;
}
.link-btn:hover {
  color: var(--accent);
  background: var(--accent-soft);
}
.dl-btn {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-1) var(--space-3);
  background: var(--accent-soft);
  border: 1px solid var(--accent);
  border-radius: var(--radius-md);
  color: var(--accent);
  font-size: var(--fs-sm);
  font-weight: 600;
  cursor: pointer;
  transition:
    background var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out);
}
.dl-btn svg {
  flex: 0 0 14px;
  width: 14px;
  height: 14px;
}
.dl-btn:hover:not(:disabled) {
  background: var(--accent);
  color: var(--accent-ink);
}
.dl-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
/* 页面级状态（加载/错误/空）：居中 */
.empty {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
}
.state-hint {
  margin: 0;
  font-size: var(--fs-md);
  color: var(--text-secondary);
}
.error-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-3);
  max-width: 480px;
  text-align: center;
}
.error-text {
  color: var(--danger);
  overflow-wrap: anywhere;
}
.retry {
  padding: var(--space-2) var(--space-5);
  background: transparent;
  border: 1px solid var(--accent);
  border-radius: var(--radius-md);
  color: var(--accent);
  font-size: var(--fs-md);
  font-weight: 600;
  cursor: pointer;
  transition:
    background var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out);
}
.retry:hover {
  background: var(--accent);
  color: var(--accent-ink);
}
</style>
