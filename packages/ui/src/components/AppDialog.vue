<script setup lang="ts">
/**
 * 应用内模态弹窗壳 —— BlockHelm 对话框形态（DialogTitle/Subtitle/FormPanel/Footer 三段式）的 Web 等效：
 * Teleport 挂 body、遮罩点击与 Esc 关闭、卡片内容全部由插槽提供。
 * 视觉走本项目 token（暖木炭 surface 层级），不照抄 BlockHelm 浅色主题。
 */
import { onBeforeUnmount, onMounted, watch } from 'vue';

/**
 * zIndex：叠窗场景抬层（缺省走 CSS 100）。全局 ExternalLinkErrorDialog 用 200——
 * 其 Teleport 挂载先于业务弹窗，同 z-index 时 DOM 序在下，从登录窗内点「打开浏览器」
 * 失败会被压在登录窗下不可见（2026-10-31 用户报障修复）。
 * dismissible：false = 掐断遮罩点击与 Esc 两条隐式关闭路径（防误关，MsLoginDialog 用——
 * 登录流中误触即取消授权；关闭只允许显式「取消」钮），缺省 true 全窗行为不变。
 */
const props = defineProps<{ open: boolean; zIndex?: number; dismissible?: boolean }>();
const emit = defineEmits<{ close: [] }>();

const canDismiss = () => props.dismissible !== false;

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape' && props.open && canDismiss()) emit('close');
}

function onBackdropDown(): void {
  if (canDismiss()) emit('close');
}

onMounted(() => window.addEventListener('keydown', onKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));

// 弹窗打开时锁背景滚动（账户页右栏可滚动，避免滚轮穿透）
watch(
  () => props.open,
  (v) => {
    document.body.style.overflow = v ? 'hidden' : '';
  },
);
</script>

<template>
  <Teleport to="body">
    <Transition name="dialog">
      <!-- 遮罩关闭用 mousedown.self 而非 click.self：click 的 target = mousedown/mouseup
           的最近共同祖先——弹窗内拖选文字（如全选用户名）拖出卡片、松手在遮罩上时，
           click.target 塌缩成 backdrop，click.self 误判"点空白"把弹窗关掉（issue #1
           "修改用户名全选的时候窗口闪退"）。按下动作本身落在遮罩才关，拖选免疫。 -->
      <div v-if="open" class="backdrop" :style="zIndex ? { zIndex } : undefined" @mousedown.self="onBackdropDown">
        <div class="card" role="dialog" aria-modal="true">
          <slot />
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.backdrop {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-5);
  background: rgba(0, 0, 0, 0.55);
}
.card {
  width: min(560px, 100%);
  max-height: min(80vh, 100% - var(--space-5));
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
  padding: var(--space-6);
  background: var(--surface-2);
  border: 1px solid var(--card-border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-3), var(--card-highlight);
}
/* 进出场：遮罩淡入 + 卡片微缩放（200ms 律） */
.dialog-enter-active,
.dialog-leave-active {
  transition: opacity var(--dur-base) var(--ease-out);
}
.dialog-enter-active .card,
.dialog-leave-active .card {
  transition: transform var(--dur-base) var(--ease-out);
}
.dialog-enter-from,
.dialog-leave-to {
  opacity: 0;
}
.dialog-enter-from .card,
.dialog-leave-to .card {
  transform: scale(0.96);
}
</style>
