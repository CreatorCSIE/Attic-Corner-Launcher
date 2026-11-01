<script setup lang="ts">
/**
 * 实例 dock —— 启动页 Play 左侧的实例切换浮层（与版本列表同款 dock 交互）。
 * 几何/交互：裁剪窗固定展开高度（实测 scrollHeight）、
 * 面板常驻挂载、收起=整体下移 (panelH - peekH)、hover 展开 + 110ms 收起防抖 +
 * 600ms 选中重入抑制窗、图钉偏好独立持久化。
 * 选中 = 切换激活实例（useInstances.activeName，localStorage 持久化，
 * AppSettings 契约不动）；版本联动由 useSelection 对 active 的 watch 统一承担
 * （与宿主 persistInstanceVersion 的回写方向一致）。
 * 数据驱动：列表/计数全走契约，UI 零版本判断。
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { useI18n } from '../i18n';
import { useInstances } from '../composables/useInstances';

const { t } = useI18n();
const { instances, loading, error, load, activeName, active, setActive } = useInstances();

// —— 状态：pinned（持久化偏好）+ hover（瞬时）+ dismissed（显式收起后的 hover 抑制）——
const STATE_KEY = 'attic:instance-panel:v1';
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

// 收起防抖 110ms：穿越缝隙不闪收
const COLLAPSE_DELAY_MS = 110;
let leaveTimer: ReturnType<typeof setTimeout> | null = null;

// 选中收起后的重入抑制窗：防合成 mouseenter 秒弹回"关不上"
const SUPPRESS_REENTER_MS = 600;
let suppressUntil = 0;

function onEnter(): void {
  if (leaveTimer) {
    clearTimeout(leaveTimer);
    leaveTimer = null;
  }
  if (dismissed.value || Date.now() < suppressUntil) return;
  hover.value = true;
}

function onLeave(): void {
  if (leaveTimer) clearTimeout(leaveTimer);
  leaveTimer = setTimeout(() => {
    hover.value = false;
    dismissed.value = false;
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

/** 选中实例：切激活（版本联动由 useSelection 的 active watch 承担）；未固定则收起。 */
function onPick(name: string): void {
  setActive(name);
  if (!pinned.value) collapse(true);
}

// —— 搜索过滤（本地瞬时，不触宿主；实例量级小，无分组）——
const query = ref('');
const filtered = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return instances.value;
  return instances.value.filter(
    (i) => i.name.toLowerCase().includes(q) || i.version.toLowerCase().includes(q),
  );
});

// —— 高度实测：
// panelH = 面板内容流全高（peekbar 绝对定位不计入）；peekH = peekbar 自然高。
// 双 rAF 锚定真实绘制帧后才允许过渡（防重挂载首帧 0px→实测值被播成收缩动画）。
const panelEl = ref<HTMLElement | null>(null);
const peekbarEl = ref<HTMLElement | null>(null);
const panelH = ref(0);
const peekH = ref(0);
const ready = ref(false);
function remeasure(): void {
  if (panelEl.value) panelH.value = panelEl.value.scrollHeight;
  if (peekbarEl.value) peekH.value = peekbarEl.value.offsetHeight;
  if (!ready.value) {
    requestAnimationFrame(() => requestAnimationFrame(() => (ready.value = true)));
  }
}
onMounted(remeasure);
watch([filtered, query, loading, error], () => void nextTick(remeasure));
// 激活实例变化 → peekbar 文案双行长度可能变高 → 重测
watch(activeName, () => void nextTick(remeasure));

// —— 每次展开：静默重扫实例档案 + 定位到激活行。
// 竞态护栏：refresh 异步 IPC resolve 时面板可能已收起——序号守卫放弃定位；
// 定位只碰 .list 自身 scrollTop，绝不滚动任何祖先容器。
const listEl = ref<HTMLElement | null>(null);
let expandSeq = 0;
watch(expanded, async (open) => {
  if (!open) return;
  const seq = ++expandSeq;
  await load();
  await nextTick();
  if (seq !== expandSeq || !expanded.value) return;
  const el = listEl.value;
  if (!el) return;
  const row = el.querySelector<HTMLElement>('.row--active');
  if (row) {
    const host = el.getBoundingClientRect();
    const rect = row.getBoundingClientRect();
    el.scrollTop += rect.top - host.top - (host.height - rect.height) / 2;
  } else {
    el.scrollTop = 0;
  }
});
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
    <!-- 裁剪窗：底缘锚定、高度固定为展开值；窗本身不吃指针（收起态只有 peekbar 可点） -->
    <div class="window">
      <section ref="panelEl" class="panel" :class="{ 'panel--open': expanded }">
        <!-- 收起态卡片：覆盖面板顶缘，展开时淡出上移被窗顶缘吞掉 -->
        <button
          ref="peekbarEl"
          class="peekbar"
          :class="{ 'peekbar--away': expanded }"
          type="button"
          @click="hover = true"
        >
          <span class="lines">
            <span class="name">{{ active ? active.name : t('instance.pick') }}</span>
            <span class="subtitle subtitle--mono">
              {{ active ? active.version || t('instance.versionNone') : t('instance.pickHint') }}
            </span>
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
          <span class="ptitle">{{ t('instance.list') }}</span>
          <span class="phead-actions">
            <button
              class="icon-btn"
              type="button"
              :class="{ 'icon-btn--on': pinned }"
              :title="pinned ? t('instance.unpin') : t('instance.pin')"
              :aria-pressed="pinned"
              @click.stop="togglePin"
            >
              <!-- lucide: pin -->
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 17v5" />
                <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
              </svg>
            </button>
            <button class="icon-btn" type="button" :title="t('instance.collapse')" @click.stop="collapse()">
              <!-- lucide: chevron-down -->
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="m6 9 6 6 6-6" />
              </svg>
            </button>
          </span>
        </header>

        <input
          v-model="query"
          class="search"
          type="search"
          :placeholder="t('common.search')"
          :aria-label="t('common.search')"
        />

        <div v-if="loading" class="skeleton" aria-hidden="true">
          <div v-for="n in 3" :key="n" class="sk-row"></div>
        </div>

        <div v-else-if="error" class="state state--error">
          <p class="state-msg">{{ t('common.error') }}：{{ error }}</p>
          <button class="ghost" @click="load()">{{ t('common.retry') }}</button>
        </div>

        <div v-else-if="filtered.length === 0" class="state">
          <p class="state-msg">{{ instances.length === 0 ? t('instance.empty') : t('instance.noMatch') }}</p>
          <p class="state-hint">{{ instances.length === 0 ? t('instance.emptyHint') : t('instance.noMatchHint') }}</p>
        </div>

        <div v-else ref="listEl" class="list">
          <button
            v-for="inst in filtered"
            :key="inst.name"
            class="row"
            :class="{ 'row--active': activeName === inst.name }"
            @click="onPick(inst.name)"
          >
            <span class="lines">
              <span class="name">{{ inst.name }}</span>
              <span class="subtitle subtitle--mono">{{ inst.version || t('instance.versionNone') }}</span>
            </span>
          </button>
        </div>

        <footer class="pfoot">
          <span class="count tabular">{{ t('instance.count', { n: instances.length }) }}</span>
        </footer>
      </section>
    </div>
  </div>
</template>

<style scoped>
/* 视觉与几何与 VersionSelector 一致，差异仅：
   z-index 抬高覆盖 stage-hero（z5）、版本分组/chip/已装徽标去除（实例扁平列表）、
   版本副标题 mono 字体。 */
.dock {
  position: relative;
  z-index: 10;
  width: 300px;
  max-width: 100%;
  height: var(--peek-h);
}
.window {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: var(--panel-h);
  overflow: hidden;
  pointer-events: none;
  border-bottom: 1px solid var(--card-border);
  border-radius: var(--radius-lg);
  filter: drop-shadow(var(--shadow-3));
}
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
  border: none;
  border-radius: calc(var(--radius-lg) - 1px);
  text-align: left;
  cursor: pointer;
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
/* 实测高度落进 DOM 前禁用平移/淡出过渡（防重挂载假收缩动画） */
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
  /* 显式行高：mono 字体 normal 行高比 sans 矮 ~3px，
     不写死会让两 dock 一高一矮 */
  line-height: 1.4;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.subtitle--mono {
  font-family: var(--font-mono);
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
.search {
  padding: var(--space-2) var(--space-3);
  background: var(--surface-3);
  border: none;
  border-radius: var(--radius-md);
  color: var(--text-primary);
  box-shadow: var(--input-inset);
  transition:
    background-color var(--dur-fast) var(--ease-out),
    box-shadow var(--dur-fast) var(--ease-out);
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
  gap: 2px;
  padding-right: var(--space-1);
}
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
  transition:
    background var(--dur-fast) var(--ease-out),
    border-color var(--dur-fast) var(--ease-out);
}
.row:hover {
  background: var(--surface-4);
}
.row--active {
  background: var(--accent-soft);
  border-color: var(--accent);
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
.state-msg {
  margin: 0;
  font-size: var(--fs-sm);
}
.state-hint {
  margin: 0;
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
  0% {
    opacity: 0.5;
  }
  50% {
    opacity: 1;
  }
  100% {
    opacity: 0.5;
  }
}
</style>
