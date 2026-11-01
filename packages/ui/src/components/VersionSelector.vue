<script setup lang="ts">
/**
 * 版本选择器 —— 浮动面板，交互为鼠标驱动：
 * 悬浮 dock = 伸展列表；移出 dock = 收起（图钉固定时移出也不收）；
 * 图钉/收起按钮为显式操作。
 * 显式收起后直到鼠标移出 dock 前不再被 hover 重新展开（dismissed 标志，防止"点了收起没反应"）。
 * 默认折叠：仅持久化图钉偏好，不持久化展开态。
 * 列表项为纯文本双行（主标题 / 小字副标题），无图标。
 * 数据驱动：分组/排序全来自清单 era + 日期字段，UI 零版本判断。
 *
 * 几何：裁剪窗固定为展开高度（实测 scrollHeight），面板**始终挂载**，
 * 收起=面板整体下移 (panelH - peekH)、露出多少由静态裁剪窗决定；
 * 收起态卡片 = 覆盖在面板顶缘的 peekbar（绝对定位，不占内容流 → panelH 恒稳），
 * 展开时淡出上移、被裁剪窗顶缘吞掉——无 v-if/Transition，动画纯 transform+opacity。
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { useI18n } from '../i18n';
import { useVersions } from '../composables/useVersions';
import { useSelection } from '../composables/useSelection';
import type { VersionEra, VersionRef } from '@attic/core-spec';

const { t } = useI18n();
const { search, groups, loading, error, total, load, refresh } = useVersions();
const { selectedId, selected, select } = useSelection();

// —— 状态：pinned（持久化偏好）+ hover（瞬时）+ dismissed（显式收起后的 hover 抑制） ——
const STATE_KEY = 'attic:version-panel:v1';
const pinned = ref(false);
try {
  const raw = localStorage.getItem(STATE_KEY);
  if (raw) pinned.value = (JSON.parse(raw) as { p?: unknown }).p === true;
} catch {
  /* 隐私模式：默认未固定 */
}

const hover = ref(false);
const dismissed = ref(false);
const expanded = computed(() => pinned.value || hover.value);

function persist(): void {
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify({ p: pinned.value }));
  } catch {
    /* 隐私模式 */
  }
}

// 收起防抖 110ms：鼠标移出后延迟才收起，穿越缝隙/短暂出界不闪收
const COLLAPSE_DELAY_MS = 110;
let leaveTimer: ReturnType<typeof setTimeout> | null = null;

// 选中收起后的重入抑制窗：收起瞬间指针仍悬在 dock 盒上方，会合成触发
// mouseleave→mouseenter，dismissed 被复位后 hover 立即再展开。
// 窗口期内拒绝 hover 展开；显式点击/图钉不受限。
const SUPPRESS_REENTER_MS = 600;
let suppressUntil = 0;

function onEnter(): void {
  if (leaveTimer) {
    clearTimeout(leaveTimer); // 延迟期内回到 dock：取消收起
    leaveTimer = null;
  }
  if (dismissed.value || Date.now() < suppressUntil) return;
  hover.value = true;
}

function onLeave(): void {
  if (leaveTimer) clearTimeout(leaveTimer);
  leaveTimer = setTimeout(() => {
    hover.value = false;
    dismissed.value = false; // 移出后恢复 hover 展开能力
    leaveTimer = null;
  }, COLLAPSE_DELAY_MS);
}

function togglePin(): void {
  pinned.value = !pinned.value;
  if (pinned.value) dismissed.value = false;
  persist();
}

/** 显式收起：同时解除固定；dismissed 抑制当前悬停，直到鼠标移出 dock。 */
function collapse(suppressReenter = false): void {
  pinned.value = false;
  hover.value = false;
  dismissed.value = true;
  if (suppressReenter) suppressUntil = Date.now() + SUPPRESS_REENTER_MS;
  persist();
}

/** 选中版本：写入选择；未固定则收起（带重入抑制窗，防止合成 enter 立刻再展开）。 */
function onPick(id: string): void {
  select(id);
  if (!pinned.value) collapse(true);
}

// —— 高度实测：
// panelH = 面板内容流全高（peekbar 绝对定位不计入，值恒稳）；
// peekH = peekbar 自然高（内容决定，零硬编码）。两者写进 CSS 变量驱动平移与裁剪。
// onMounted 同步测（DOM 已插入、浏览器尚未绘制）→ 无闪帧；内容变化经 nextTick 重测。
const panelEl = ref<HTMLElement | null>(null);
const peekbarEl = ref<HTMLElement | null>(null);
const panelH = ref(0);
const peekH = ref(0);
// 首帧保护：重挂载（切页返回启动页）时变量从 0px→实测值，若 transition 在场
// 会被渲染成一次"收缩动画"。实测值不仅要写进 DOM，还必须**被浏览器绘制过一帧**
// （transition:none 状态下），之后才能恢复过渡——nextTick 只等 patch 不等 paint，
// 中间态会被合并进同一次样式变更而照常触发动画，故用双 rAF 锚定真实绘制帧。
const ready = ref(false);
function remeasure(): void {
  if (panelEl.value) panelH.value = panelEl.value.scrollHeight;
  if (peekbarEl.value) peekH.value = peekbarEl.value.offsetHeight;
  if (!ready.value) {
    requestAnimationFrame(() => requestAnimationFrame(() => (ready.value = true)));
  }
}
onMounted(remeasure);
watch([groups, search, loading, error], () => void nextTick(remeasure));
// 选中版本变化 → peekbar 文案双行长度变化，高度可能微差 → 一并重测
watch(selectedId, () => void nextTick(remeasure));

// —— 每次展开：静默重扫磁盘（运行期丢 jar 也能即时更新列表）
// + 定位到已选中版本（无选中回顶部）。列表滚动容器 = .list。
// 竞态护栏：refresh 是异步 IPC，resolve 时面板可能已被收起——必须用序号守卫放弃后续定位。
// scrollIntoView 会把祖先滚动容器（.window overflow:hidden）一并滚动，
// peekbar 被位移到光标下 → 命中测试合成 mouseenter → 面板秒弹回。
// 故定位只做 .list 容器内手动 scrollTop，绝不碰祖先。
const listEl = ref<HTMLElement | null>(null);
let expandSeq = 0;
watch(expanded, async (open) => {
  if (!open) return;
  const seq = ++expandSeq;
  await refresh();
  await nextTick();
  if (seq !== expandSeq || !expanded.value) return; // 期间已收起/又展开过：放弃
  const el = listEl.value;
  if (!el) return;
  const active = el.querySelector<HTMLElement>('.row--active');
  if (active) {
    const host = el.getBoundingClientRect();
    const rect = active.getBoundingClientRect();
    el.scrollTop += rect.top - host.top - (host.height - rect.height) / 2;
  } else {
    el.scrollTop = 0;
  }
});

function fmtDate(ts?: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** i18n 键走点路径，`release-1.0-1.5.2` 含点无法寻址 → 映射为无点的 `release`。 */
function eraKey(era: VersionEra | 'unknown'): string {
  return era === 'release-1.0-1.5.2' ? 'release' : era;
}

/** 加粗位 = 启动 id（与 jar/实例配置一致，如 pc-132011）；别名（如 rd-132211）降为第二行。 */
function titleOf(v: VersionRef): string {
  return v.id;
}

/** 别名（仅当存在且不同于 id）；行副标题不显示日期（太占空间）。 */
function aliasOf(v: VersionRef): string {
  return v.displayName && v.displayName !== v.id ? v.displayName : '';
}

/** 行副标题 = 别名（仅当存在且不同于 id）+ Custom 标记，同放第二行
 * （加粗主位只留启动 id，不挂行右侧徽标）。 */
function rowSubtitle(v: VersionRef): string {
  const parts: string[] = [];
  const alias = aliasOf(v);
  if (alias) parts.push(alias);
  if (v.custom) parts.push('Custom'); // 英文原样，与 era 标签同策略
  return parts.join(' · ');
}

function subtitleOf(v: VersionRef): string {
  const parts = [t(`era.${eraKey(v.era ?? 'unknown')}`)];
  const date = fmtDate(v.compileDate ?? v.releaseDate);
  if (date) parts.push(date);
  if (v.custom) parts.push('Custom'); // 英文原样，与 era 标签同策略
  return parts.join(' · ');
}
</script>

<template>
  <div
    class="dock"
    :class="{ 'is-ready': ready }"
    :style="{
      '--panel-h': panelH ? `${panelH}px` : '0px',
      '--peek-h': peekH ? `${peekH}px` : '0px',
    }"
    @mouseenter="onEnter"
    @mouseleave="onLeave"
  >
    <!-- 裁剪窗：底缘锚定、高度固定为展开值，
         overflow 决定露出多少；窗本身不吃指针（收起态只有 peekbar 可点）。 -->
    <div class="window">
      <!-- 面板：常驻挂载。收起=整体下移 (panel-h - peek-h)，
           顶缘 peekbar 恰好落进 dock 槽位；展开=平移归零，顶缘上移、内容随之显形。
           时长/缓动 = --dur-grow / --ease-grow。 -->
      <section ref="panelEl" class="panel" :class="{ 'panel--open': expanded }">
        <!-- 收起态卡片：覆盖面板顶缘（不占内容流 → panel-h 恒稳）。展开时淡出上移，
             被裁剪窗顶缘吞掉；收起态点击=伸展。 -->
        <button
          ref="peekbarEl"
          class="peekbar"
          :class="{ 'peekbar--away': expanded }"
          type="button"
          @click="hover = true"
        >
          <span class="lines">
            <span class="name">{{ selected ? titleOf(selected) : t('version.pick') }}</span>
            <span class="subtitle">{{ selected ? subtitleOf(selected) : t('version.pickHint') }}</span>
          </span>
          <span class="peek-chevron" aria-hidden="true">
            <!-- lucide: chevrons-up -->
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="m17 11-5-5-5 5" />
              <path d="m17 18-5-5-5 5" />
            </svg>
          </span>
        </button>

        <header class="phead">
          <span class="ptitle">{{ t('version.list') }}</span>
          <span class="phead-actions">
            <button
              class="icon-btn"
              type="button"
              :class="{ 'icon-btn--on': pinned }"
              :title="pinned ? t('version.unpin') : t('version.pin')"
              :aria-pressed="pinned"
              @click.stop="togglePin"
            >
              <!-- lucide: pin -->
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 17v5" />
                <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
              </svg>
            </button>
            <button class="icon-btn" type="button" :title="t('version.collapse')" @click.stop="collapse()">
              <!-- lucide: chevron-down -->
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="m6 9 6 6 6-6" />
              </svg>
            </button>
          </span>
        </header>

        <input
          v-model="search"
          class="search"
          type="search"
          :placeholder="t('common.search')"
          :aria-label="t('common.search')"
        />

        <div v-if="loading" class="skeleton" aria-hidden="true">
          <div v-for="n in 4" :key="n" class="sk-row"></div>
        </div>

        <div v-else-if="error" class="state state--error">
          <p class="state-msg">{{ t('common.error') }}：{{ error }}</p>
          <button class="ghost" @click="load()">{{ t('common.retry') }}</button>
        </div>

        <div v-else-if="groups.length === 0" class="state">
          <p class="state-msg">{{ t('version.empty') }}</p>
          <p class="state-hint">{{ t('version.emptyHint') }}</p>
        </div>

        <div v-else ref="listEl" class="list">
          <div v-for="g in groups" :key="g.era" class="group">
            <div class="group-head">
              <span class="chip" :data-era="g.era">{{ t(`era.${eraKey(g.era)}`) }}</span>
              <span class="group-count tabular">{{ g.items.length }}</span>
            </div>
            <button
              v-for="v in g.items"
              :key="v.id"
              class="row"
              :class="{ 'row--active': selectedId === v.id }"
              @click="onPick(v.id)"
            >
              <span class="lines">
                <span class="name">{{ titleOf(v) }}</span>
                <span v-if="rowSubtitle(v)" class="subtitle">{{ rowSubtitle(v) }}</span>
              </span>
              <span v-if="v.installed" class="badge badge--ok">{{ t('version.installed') }}</span>
            </button>
          </div>
        </div>

        <footer class="pfoot">
          <span class="count tabular">{{ t('version.count', { n: total }) }}</span>
        </footer>
      </section>
    </div>
  </div>
</template>

<style scoped>
.dock {
  position: relative;
  /* 展开面板浮在 Play/相邻内容之上 */
  z-index: 10;
  width: 300px;
  max-width: 100%;
  /* 页面流里只占收起高度（实测 peek-h）；展开部分经裁剪窗浮层覆盖，不推挤布局 */
  height: var(--peek-h);
}
.window {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  /* border-box：内高 = panel-h - 1px，面板底缘恰好悬出裁剪线 1px
     → 面板自带底描边永不可见，
     底缘线统一由窗的 border-bottom 提供，收起/展开两态一致。 */
  height: var(--panel-h);
  overflow: hidden;
  pointer-events: none;
  /* 静态底缘端帽：
     圆角裁剪 + 1px 底描边，收起态被裁平的卡片底缘由此复原。 */
  border-bottom: 1px solid var(--card-border);
  border-radius: var(--radius-lg);
  /* 投影挂窗上、随可见轮廓渲染（drop-shadow 对 overflow 裁剪后的结果取形），
     两态都有完整投影，且不会在窗内被 overflow:hidden 裁掉。 */
  filter: drop-shadow(var(--shadow-3));
}
/* 面板：常驻挂载，内容流 = header/search/list/footer（peekbar 绝对定位不计入）。
   收起=下移 (panel-h - peek-h)，窗口顶缘露出恰为 peek-h 高的 peekbar；展开=归零。 */
.panel {
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-4);
  background: var(--card-bg);
  border: 1px solid var(--card-border);
  border-radius: var(--radius-lg);
  /* 投影不写在面板上：overflow 裁剪窗会切掉外投影，统一由 .window 的 drop-shadow 承担 */
  transform: translateY(calc(var(--panel-h) - var(--peek-h)));
  transition: transform var(--dur-grow) var(--ease-grow);
  pointer-events: none;
}
.panel--open {
  transform: translateY(0);
  pointer-events: auto;
}
.panel > * {
  flex-shrink: 0;
}
/* —— peekbar：收起态卡片 = 覆盖面板顶缘的绝对层（与面板同底色/圆角，无缝）。
   展开时淡出+上移，被裁剪窗顶缘吞掉；不吃指针，避免挡住 header 操作。 */
.peekbar {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-4) var(--space-5);
  background: var(--card-bg);
  /* 必须显式清掉 UA 默认按钮边框（base.css reset 不删 border，项目惯例逐组件自管） */
  border: none;
  border-radius: calc(var(--radius-lg) - 1px);
  text-align: left;
  cursor: pointer;
  /* .window 的 pointer-events:none 会继承下来——收起态唯一可点的就是这张卡，必须显式吃指针 */
  pointer-events: auto;
  transition:
    transform var(--dur-grow) var(--ease-grow),
    opacity var(--dur-grow) var(--ease-grow),
    background var(--dur-fast) var(--ease-out);
}
.peekbar--away {
  transform: translateY(calc(-1 * (var(--peek-h) + var(--space-4))));
  opacity: 0;
  pointer-events: none;
}
.peekbar:hover {
  background: var(--surface-3);
}
/* 实测高度落进 DOM 前禁用平移/淡出过渡：防重挂载首帧 0px→实测值被当成收缩动画播一遍 */
.dock:not(.is-ready) .panel,
.dock:not(.is-ready) .peekbar {
  transition: none;
}
.peek-chevron {
  margin-left: auto;
  display: inline-flex;
  color: var(--text-muted);
  flex: 0 0 auto;
}
.lines {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
  flex: 1;
}
.name {
  font-size: var(--fs-md);
  font-weight: 600;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.subtitle {
  font-size: var(--fs-xs);
  color: var(--text-muted);
  /* 显式行高：sans/mono 字体 normal 行高差 ~3px，
     不写死会让两个 dock 一高一矮 */
  line-height: 1.4;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.phead {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 var(--space-1);
}
.ptitle {
  font-size: var(--fs-lg);
  font-weight: 600;
  color: var(--text-primary);
}
.phead-actions {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
}
.icon-btn {
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  background: transparent;
  border: none;
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  cursor: pointer;
  transition:
    background var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out);
}
.icon-btn:hover {
  background: var(--surface-4);
  color: var(--text-primary);
}
.icon-btn--on {
  color: var(--accent);
  background: var(--accent-soft);
}
/* 搜索框：inset 质感（第3级底 + 底缘内阴影 + 无边框），focus accent 投影环 */
.search {
  padding: var(--space-2) var(--space-3);
  background: var(--surface-3);
  border: none;
  border-radius: var(--radius-md);
  color: var(--text-primary);
  box-shadow: var(--input-inset);
  transition: background-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out);
}
.search:hover {
  background: var(--surface-4);
}
.search:focus-visible {
  outline: none;
  box-shadow: var(--input-focus-shadow);
}
.list {
  max-height: 52vh;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding-right: var(--space-1);
}
.group {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.group-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-1) var(--space-2);
  position: sticky;
  top: 0;
  background: var(--card-bg);
}
.group-count {
  font-size: var(--fs-xs);
  color: var(--text-muted);
}
.chip {
  --chip: var(--text-muted);
  --chip-soft: var(--surface-1);
  font-size: var(--fs-xs);
  letter-spacing: var(--tracking-label);
  padding: 2px var(--space-2);
  border-radius: var(--radius-sm);
  color: var(--chip);
  background: var(--chip-soft);
}
.chip[data-era='pre-classic'] { --chip: var(--era-pre-classic); --chip-soft: var(--era-pre-classic-soft); }
.chip[data-era='classic'] { --chip: var(--era-classic); --chip-soft: var(--era-classic-soft); }
.chip[data-era='4k'] { --chip: var(--era-4k); --chip-soft: var(--era-4k-soft); }
.chip[data-era='indev'] { --chip: var(--era-indev); --chip-soft: var(--era-indev-soft); }
.chip[data-era='infdev'] { --chip: var(--era-infdev); --chip-soft: var(--era-infdev-soft); }
.chip[data-era='alpha'] { --chip: var(--era-alpha); --chip-soft: var(--era-alpha-soft); }
.chip[data-era='beta'] { --chip: var(--era-beta); --chip-soft: var(--era-beta-soft); }
.chip[data-era='release-1.0-1.5.2'] { --chip: var(--era-release); --chip-soft: var(--era-release-soft); }
/* 列表项：纯文本双行（主标题/副标题），点击选中；未固定时选中即收起。
   列表始终"已准备好"（无逐行动画），展开观感全部交给面板平移 */
.row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  padding: var(--space-2) var(--space-3);
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--radius-md);
  text-align: left;
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out);
}
.row:hover {
  background: var(--surface-4);
}
.row--active {
  background: var(--accent-soft);
  border-color: var(--accent);
}
.badge {
  font-size: var(--fs-xs);
  padding: 1px var(--space-2);
  border-radius: var(--radius-sm);
  flex: 0 0 auto;
}
.badge--ok {
  color: var(--ok);
  background: var(--ok-soft);
}
.pfoot {
  display: flex;
  justify-content: flex-end;
  padding: 0 var(--space-1);
}
.count {
  font-size: var(--fs-xs);
  color: var(--text-muted);
}
/* 空态/错误态 */
.state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: var(--space-5);
  text-align: center;
  color: var(--text-secondary);
}
.state--error .state-msg {
  color: var(--danger);
}
.state-hint {
  font-size: var(--fs-sm);
  color: var(--text-muted);
}
.ghost {
  padding: var(--space-2) var(--space-4);
  background: transparent;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-md);
  color: var(--text-primary);
  box-shadow: var(--inset-bottom);
  transition: background var(--dur-fast) var(--ease-out);
}
.ghost:hover {
  background: var(--surface-4);
}
.skeleton {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.sk-row {
  height: 44px;
  border-radius: var(--radius-md);
  background: var(--surface-3);
  animation: shimmer 1.2s var(--ease-in) infinite;
}
@keyframes shimmer {
  0% { opacity: 0.5; }
  50% { opacity: 1; }
  100% { opacity: 0.5; }
}
</style>
