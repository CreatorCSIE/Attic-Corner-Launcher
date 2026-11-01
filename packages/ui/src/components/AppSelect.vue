<script setup lang="ts">
/**
 * 主题化动画下拉（BlockHelm AnimatedComboBox 移植，GPL-3.0 参考项目——版式与动画参数
 * 取自 ControlStyles.Inputs.xaml L208-560 + AnimatedComboBox.cs 源码实测值）：
 * 替换原生 <select>——OS 级弹层不跟主题、圆角/字体与整窗违和（用户反馈"被误识别为弹窗"）。
 * 动画规格：开 210ms Cubic-EaseOut / 关 180ms Cubic-EaseInOut，opacity + scaleY .92 +
 * translateY ∓10/∓8（方向感知，向上翻时符号反转、原点换底部）；展开时描边 accent（= v1 的
 * BorderExpanded 主题色语义）；浮层 6px 间隙、max-height 260、条目 38px/圆角 7；禁用态 .58。
 */
import { computed, nextTick, onBeforeUnmount, ref } from 'vue';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

const props = withDefaults(
  defineProps<{
    modelValue: string;
    options: SelectOption[];
    id?: string;
    ariaLabel?: string;
    disabled?: boolean;
    /** 必填缺失的红色反馈（对齐 .input--invalid 语义）。 */
    invalid?: boolean;
  }>(),
  { id: undefined, ariaLabel: undefined, disabled: false, invalid: false },
);

const emit = defineEmits<{ 'update:modelValue': [string] }>();

const open = ref(false);
const dir = ref<'down' | 'up'>('down');
const hlIdx = ref(0);
const rootEl = ref<HTMLElement | null>(null);
const btnEl = ref<HTMLElement | null>(null);
const flyoutEl = ref<HTMLElement | null>(null);
/**
 * 弹层 Teleport 到 body + fixed 定位（2026-11-01 修「弹窗内下拉被截断」）：
 * 原 absolute 挂在 AppDialog 滚动容器里，超出窗体即裁。视口坐标直落，配 scroll
 * （capture，弹窗内滚动也重定位）/resize 监听保持贴合。
 */
const flyStyle = ref<Record<string, string>>({});
const listId = `app-select-list-${Math.random().toString(36).slice(2, 8)}`;

const selected = computed(() => props.options.find((o) => o.value === props.modelValue));
const selectedLabel = computed(() => selected.value?.label ?? '');

/** 条目高 38 + 上下内衬 10 的 BlockHelm 估值式：决定向上翻的空间判定。 */
function estimateFlyoutHeight(): number {
  return Math.min(260, props.options.length * 38 + 10);
}

function place(): void {
  const btn = btnEl.value;
  if (!btn) return;
  const rect = btn.getBoundingClientRect();
  const below = window.innerHeight - rect.bottom;
  const above = rect.top;
  dir.value = below < estimateFlyoutHeight() + 8 && above > below ? 'up' : 'down';
  flyStyle.value =
    dir.value === 'down'
      ? { left: `${rect.left}px`, top: `${rect.bottom + 6}px`, minWidth: `${rect.width}px` }
      : { left: `${rect.left}px`, bottom: `${window.innerHeight - rect.top + 6}px`, minWidth: `${rect.width}px` };
}

function toggleOpen(): void {
  if (props.disabled) return;
  if (open.value) {
    closeList();
    return;
  }
  hlIdx.value = Math.max(0, props.options.findIndex((o) => o.value === props.modelValue));
  place();
  open.value = true;
  document.addEventListener('pointerdown', onDocPointer, true);
  window.addEventListener('resize', place);
  // capture：弹窗/页面任意祖先滚动都触发重定位（flyout 已脱离文档流，不跟滚即脱节）
  window.addEventListener('scroll', place, true);
}

function closeList(): void {
  open.value = false;
  document.removeEventListener('pointerdown', onDocPointer, true);
  window.removeEventListener('resize', place);
  window.removeEventListener('scroll', place, true);
}

function onDocPointer(ev: PointerEvent): void {
  const target = ev.target as Node;
  // flyout Teleport 后不在 rootEl 子树内：点击弹层条目须豁免外点关闭（否则 pick 前即卸载）
  if (rootEl.value?.contains(target) || flyoutEl.value?.contains(target)) return;
  closeList();
}

function moveHl(step: number): void {
  const n = props.options.length;
  if (!n) return;
  let i = hlIdx.value;
  for (let k = 0; k < n; k++) {
    i = (i + step + n) % n;
    if (!props.options[i]?.disabled) break;
  }
  hlIdx.value = i;
  void nextTick(() => document.getElementById(`${listId}-${i}`)?.scrollIntoView({ block: 'nearest' }));
}

function pick(o: SelectOption): void {
  if (o.disabled || props.disabled) return;
  emit('update:modelValue', o.value);
  closeList();
  btnEl.value?.focus();
}

function onKey(ev: KeyboardEvent): void {
  if (props.disabled) return;
  switch (ev.key) {
    case 'ArrowDown':
      ev.preventDefault();
      if (!open.value) toggleOpen();
      else moveHl(1);
      break;
    case 'ArrowUp':
      ev.preventDefault();
      if (!open.value) toggleOpen();
      else moveHl(-1);
      break;
    case 'Home':
      if (open.value) { ev.preventDefault(); moveHlTo(0); }
      break;
    case 'End':
      if (open.value) { ev.preventDefault(); moveHlTo(props.options.length - 1); }
      break;
    case 'Enter':
    case ' ':
      ev.preventDefault();
      if (open.value) {
        const o = props.options[hlIdx.value];
        if (o) pick(o);
      } else {
        toggleOpen();
      }
      break;
    case 'Escape':
      if (open.value) { ev.preventDefault(); closeList(); btnEl.value?.focus(); }
      break;
    case 'Tab':
      if (open.value) closeList();
      break;
  }
}

function moveHlTo(i: number): void {
  hlIdx.value = Math.max(0, Math.min(props.options.length - 1, i));
}

onBeforeUnmount(() => closeList());
</script>

<template>
  <div ref="rootEl" class="app-select">
    <button
      :id="id"
      ref="btnEl"
      class="trigger"
      :class="{ 'trigger--open': open, 'trigger--invalid': invalid }"
      type="button"
      role="combobox"
      :disabled="disabled"
      :aria-label="ariaLabel"
      :aria-expanded="open"
      aria-haspopup="listbox"
      :aria-controls="open ? listId : undefined"
      @click="toggleOpen"
      @keydown="onKey"
    >
      <span class="trigger-label">{{ selectedLabel }}</span>
      <!-- lucide chevron-down（ISC 路径） -->
      <svg class="trigger-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="m6 9 6 6 6-9" />
      </svg>
    </button>
    <Teleport to="body">
      <Transition name="pop">
        <div
          v-if="open"
          :id="listId"
          ref="flyoutEl"
          class="flyout"
          :data-dir="dir"
          :style="flyStyle"
          role="listbox"
          :aria-activedescendant="`${listId}-${hlIdx}`"
        >
          <div
            v-for="(o, i) in options"
            :id="`${listId}-${i}`"
            :key="o.value"
            class="item"
            :class="{ 'item--sel': o.value === modelValue, 'item--hl': i === hlIdx, 'item--dis': o.disabled }"
            role="option"
            :aria-selected="o.value === modelValue"
            @click="pick(o)"
            @mouseenter="hlIdx = i"
          >
            {{ o.label }}
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.app-select {
  position: relative;
  display: inline-block;
  min-width: 160px; /* = BlockHelm LauncherComboBoxStyle MinWidth */
}

.trigger {
  display: flex;
  align-items: center;
  gap: var(--space-2, 8px);
  width: 100%;
  min-height: 38px;
  padding: var(--space-2) var(--space-4);
  padding-right: var(--space-6);
  background: var(--surface-3);
  border: none;
  border-radius: var(--radius-md);
  color: var(--text-primary);
  font-size: var(--fs-md);
  cursor: pointer;
  box-shadow: var(--input-inset);
  transition:
    background-color var(--dur-fast) var(--ease-out),
    box-shadow var(--dur-fast) var(--ease-out);
}
.trigger:hover:not(:disabled) {
  background: var(--surface-4);
}
/* 展开描边 accent（BlockHelm Brush.Input.ComboBox.BorderExpanded 的主题色语义） */
.trigger--open,
.trigger:focus-visible {
  box-shadow: var(--input-inset), 0 0 0 1.5px var(--accent);
  outline: none;
}
.trigger--invalid {
  box-shadow: var(--input-inset), 0 0 0 1px var(--danger);
}
.trigger:disabled {
  opacity: 0.58; /* = BlockHelm 禁用值 */
  cursor: default;
}
.trigger-label {
  flex: 1;
  text-align: left;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.trigger-chevron {
  flex: none;
  color: var(--text-secondary);
}

.flyout {
  /* Teleport 到 body：fixed + 视口坐标（place()），压过 AppDialog 遮罩（z=100） */
  position: fixed;
  z-index: 1000;
  max-width: 420px;
  max-height: 260px; /* = BlockHelm MaxDropDownHeight */
  overflow-y: auto;
  padding: 5px;
  background: var(--overlay);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-3);
}
.flyout[data-dir='down'] {
  transform-origin: top center;
}
.flyout[data-dir='up'] {
  transform-origin: bottom center;
}

.item {
  min-height: 38px;
  padding: var(--space-2) 10px;
  display: flex;
  align-items: center;
  border-radius: 7px;
  color: var(--text-primary);
  font-size: var(--fs-md);
  cursor: pointer;
  white-space: nowrap;
}
.item--hl {
  background: var(--surface-4);
}
.item--sel {
  background: var(--accent-soft);
  color: var(--accent);
}
.item--dis {
  opacity: 0.45;
  cursor: default;
}

/* 动画参数 = AnimatedComboBox.cs 实测值：开 210ms Cubic EaseOut、关 180ms Cubic EaseInOut */
.pop-enter-active {
  transition:
    opacity 210ms cubic-bezier(0.215, 0.61, 0.355, 1),
    transform 210ms cubic-bezier(0.215, 0.61, 0.355, 1);
}
.pop-leave-active {
  transition:
    opacity 180ms cubic-bezier(0.645, 0.045, 0.355, 1),
    transform 180ms cubic-bezier(0.645, 0.045, 0.355, 1);
}
.pop-enter-from {
  opacity: 0;
}
.pop-leave-to {
  opacity: 0;
}
.flyout[data-dir='down'].pop-enter-from {
  transform: translateY(-10px) scaleY(0.92);
}
.flyout[data-dir='down'].pop-leave-to {
  transform: translateY(-8px) scaleY(0.92);
}
.flyout[data-dir='up'].pop-enter-from {
  transform: translateY(10px) scaleY(0.92);
}
.flyout[data-dir='up'].pop-leave-to {
  transform: translateY(8px) scaleY(0.92);
}
</style>
