<script setup lang="ts">
/**
 * 微软设备码登录弹窗 —— AppDialog 壳语言（标题/正文/底栏钮行，LaunchProgressDialog 同款）。
 * 打开即 msStartLogin()：成功 → 大字设备码（一键复制，剪贴板先例 = AccountsPanel.copyUuid）
 * +「打开浏览器」（useExternalLink 出门，verificationUriComplete 优先）+ 纯文本链接（防无默认
 * 浏览器时 openExternal 静默失败，可复制粘贴到任意浏览器）+ 等待授权呼吸态；
 * 终局走 MS_LOGIN 事件（组件级 on/off：watch open 订阅/退订，bridge.on 回退订函数）。
 * success → 刷新账户列表 + select(新账户 id)（profileId 幂等覆盖既有账户，选中随落账重映射）后关窗；
 * error → 按 MsLoginErrorCode 分类文案渲染（每码一句「实际动作+出路」），可重试重新发起。
 * 取消/关闭 = fire-and-forget msCancelLogin() 后关窗；关窗后迟到事件（canceled 回声）忽略。
 * start 通道本身失败（无桥/single-flight 占用/network）→ 弹窗内错误行可见。
 * expiresIn 有值时显示 mm:ss 倒计时，缺省不显示。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { IPC_EVENTS, type MsDeviceCode, type MsLoginErrorCode, type MsLoginEvent } from '@attic/core-spec';
import { useI18n } from '../i18n';
import { useAccounts } from '../composables/useAccounts';
import { useBridge } from '../composables/useBridge';
import { useExternalLink } from '../composables/useExternalLink';
import AppDialog from './AppDialog.vue';

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ 'update:open': [value: boolean] }>();

const { t } = useI18n();
const { bridge } = useBridge();
const { load, select } = useAccounts();
const { openExternal } = useExternalLink();

type Phase = 'starting' | 'code' | 'error';
const phase = ref<Phase>('starting');
const device = ref<MsDeviceCode | null>(null);
/** start 通道失败原文（IpcResult.error，无分类码可用时兜底展示）。 */
const startError = ref<string | null>(null);
/** 终局事件分类码（error 态文案表键源）。 */
const failCode = ref<MsLoginErrorCode | null>(null);

const copied = ref(false);
let copiedTimer: ReturnType<typeof setTimeout> | undefined;

// —— 倒计时（expiresIn 有就显示，无则整行不渲染） ——
const remaining = ref(0);
let tickTimer: ReturnType<typeof setInterval> | undefined;
const hasCountdown = computed(() => phase.value === 'code' && !!device.value?.expiresIn);
const remainingText = computed(() => {
  const m = Math.max(0, Math.floor(remaining.value / 60));
  const s = Math.max(0, remaining.value % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
});

function stopTick(): void {
  if (tickTimer !== undefined) {
    clearInterval(tickTimer);
    tickTimer = undefined;
  }
}

function startTick(): void {
  stopTick();
  const total = device.value?.expiresIn ?? 0;
  if (!total) return;
  remaining.value = total;
  tickTimer = setInterval(() => {
    if (remaining.value > 0) remaining.value -= 1;
    else stopTick();
  }, 1000);
}

// —— 终局事件（success 落账 / error 分类文案） ——
function onLoginEvent(ev: MsLoginEvent): void {
  // 弹窗已关（取消关闭的 canceled 回声、或竞态迟到）→ 忽略，不再翻错误态
  if (!props.open) return;
  if (ev.state === 'success') {
    void (async () => {
      await load();
      select(ev.account.id);
      close();
    })();
    return;
  }
  failCode.value = ev.code;
  startError.value = null;
  phase.value = 'error';
  stopTick();
}

let off: (() => void) | null = null;

function subscribe(): void {
  if (off) return;
  off = bridge.on(IPC_EVENTS.MS_LOGIN, onLoginEvent);
}

function unsubscribe(): void {
  off?.();
  off = null;
}

async function start(): Promise<void> {
  phase.value = 'starting';
  device.value = null;
  startError.value = null;
  failCode.value = null;
  const res = await bridge.msStartLogin();
  // 在途期间用户已关窗 → 结果作废（取消动作已由关闭路径发出，这里不再渲染）
  if (!props.open) return;
  if (res.ok) {
    device.value = res.value;
    phase.value = 'code';
    startTick();
  } else {
    startError.value = res.error;
    phase.value = 'error';
  }
}

// 打开 = 复位 + 订阅 + 发起；关闭 = 退订 + 停表（组件级 on/off 纪律）
watch(
  () => props.open,
  (v) => {
    if (v) {
      subscribe();
      void start();
    } else {
      unsubscribe();
      stopTick();
      clearTimeout(copiedTimer);
      copied.value = false;
    }
  },
);

onBeforeUnmount(() => {
  unsubscribe();
  stopTick();
  clearTimeout(copiedTimer);
});

function close(): void {
  emit('update:open', false);
}

/** 取消/遮罩/Esc：设备码或发起在途 = 先 fire-and-forget 取消宿主流，再关窗；error 终局 = 直接关。 */
function onShellClose(): void {
  if (phase.value === 'starting' || phase.value === 'code') void bridge.msCancelLogin();
  close();
}

const verifyUrl = computed(
  () => device.value?.verificationUriComplete ?? device.value?.verificationUri ?? '',
);

function openBrowser(): void {
  if (verifyUrl.value) openExternal(verifyUrl.value);
}

async function copyCode(): Promise<void> {
  if (!device.value) return;
  try {
    await navigator.clipboard.writeText(device.value.userCode);
    copied.value = true;
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => (copied.value = false), 1500);
  } catch {
    /* 剪贴板不可用（无焦点/权限）：静默，用户仍可手输/全选 */
  }
}
</script>

<template>
  <AppDialog :open="props.open" :dismissible="false" @close="onShellClose">
    <header class="head">
      <h2 class="title">{{ t('account.ms.dialogTitle') }}</h2>
    </header>

    <!-- 发起中：呼吸占位 -->
    <div v-if="phase === 'starting'" class="waiting">
      <span class="pulse-dot" aria-hidden="true"></span>
      <p class="wait-text">{{ t('account.ms.starting') }}</p>
    </div>

    <!-- 设备码展示 + 等待授权 -->
    <div v-else-if="phase === 'code'" class="code-pane">
      <p class="code-label">{{ t('account.ms.codeLabel') }}</p>
      <div class="code-field">
        <code class="code-val mono">{{ device?.userCode }}</code>
        <button class="icon-btn" type="button" :title="t('account.ms.copyCode')" @click="copyCode">
          <!-- lucide: copy / check（已复制反馈，账户页 UUID 复制同款） -->
          <svg v-if="!copied" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
            <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
          </svg>
          <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M20 6 9 17l-5-5" />
          </svg>
        </button>
      </div>
      <div class="code-actions">
        <button class="primary" type="button" @click="openBrowser">
          {{ t('account.ms.openBrowser') }}
        </button>
        <span v-if="hasCountdown" class="countdown">{{
          t('account.ms.remaining', { time: remainingText })
        }}</span>
      </div>
      <p class="link-line">
        {{ t('account.ms.orOpen') }}
        <code class="link-val mono">{{ verifyUrl }}</code>
      </p>
      <p class="waiting-line">
        <span class="pulse-dot" aria-hidden="true"></span>
        {{ t('account.ms.waiting') }}
      </p>
    </div>

    <!-- 终局失败 / start 失败：分类码文案表（动态键先例 = launch.stage.${item}） -->
    <p v-else class="err">
      {{ failCode ? t(`account.ms.error.${failCode}`) : t('account.ms.startFailed', { message: startError ?? '' }) }}
    </p>

    <footer class="foot">
      <span class="foot-spacer"></span>
      <template v-if="phase === 'error'">
        <button class="ghost" type="button" @click="close">{{ t('account.ms.close') }}</button>
        <button class="primary" type="button" @click="start">{{ t('account.ms.retry') }}</button>
      </template>
      <button v-else class="ghost" type="button" @click="onShellClose">{{ t('account.ms.cancel') }}</button>
    </footer>
  </AppDialog>
</template>

<style scoped>
.head {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.title {
  margin: 0;
  font-size: var(--fs-xl);
  font-weight: 700;
  color: var(--text-primary);
}
/* 等待/发起态：呼吸点 + 文案（启动弹窗 stage-pulse 同款律） */
.waiting {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-6) 0;
}
.wait-text {
  margin: 0;
  font-size: var(--fs-sm);
  color: var(--text-secondary);
}
.pulse-dot {
  width: 10px;
  height: 10px;
  border-radius: var(--radius-pill);
  background: var(--accent);
  animation: ms-pulse 1.2s var(--ease-out) infinite;
}
@keyframes ms-pulse {
  50% {
    opacity: 0.3;
    transform: scale(0.8);
  }
}
.code-pane {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}
.code-label {
  margin: 0;
  font-size: var(--fs-xs);
  letter-spacing: var(--tracking-label);
  text-transform: uppercase;
  color: var(--text-muted);
}
/* 设备码大字：只读字段配方（uuid-field 同款），字号放大 + 等宽 */
.code-field {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  background: var(--surface-3);
  border: 1px solid var(--card-border);
  border-radius: var(--radius-md);
  box-shadow: var(--input-inset);
}
.code-val {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-xl);
  font-weight: 700;
  letter-spacing: 0.08em;
  color: var(--text-primary);
  user-select: all;
  overflow-wrap: anywhere;
}
.icon-btn {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  background: transparent;
  border: none;
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  cursor: pointer;
  transition:
    background var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out);
}
.icon-btn svg {
  width: 16px;
  height: 16px;
}
.icon-btn:hover {
  background: var(--surface-4);
  color: var(--text-primary);
}
.code-actions {
  display: flex;
  align-items: center;
  gap: var(--space-4);
}
.countdown {
  font-size: var(--fs-xs);
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
}
/* 纯文本链接（防无默认浏览器/openExternal 静默失败：可选中复制，粘贴到任意浏览器） */
.link-line {
  margin: 0;
  font-size: var(--fs-xs);
  color: var(--text-muted);
}
.link-val {
  user-select: all;
  word-break: break-all;
  color: var(--text-secondary);
}
.waiting-line {
  margin: 0;
  display: flex;
  align-items: center;
  gap: var(--space-3);
  font-size: var(--fs-sm);
  color: var(--text-secondary);
}
.err {
  margin: 0;
  font-size: var(--fs-sm);
  color: var(--danger);
  overflow-wrap: anywhere;
}
.foot {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}
.foot-spacer {
  flex: 1;
}
.ghost {
  padding: var(--space-2) var(--space-5);
  background: var(--surface-3);
  border: 1px solid var(--card-border);
  border-radius: var(--radius-md);
  box-shadow: var(--inset-bottom);
  color: var(--text-primary);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease-out);
}
.ghost:hover {
  background: var(--surface-4);
}
.primary {
  padding: var(--space-2) var(--space-5);
  background: var(--accent);
  color: var(--accent-ink);
  border: none;
  border-radius: var(--radius-md);
  font-weight: 600;
  cursor: pointer;
  transition:
    background var(--dur-fast) var(--ease-out),
    transform var(--dur-fast) var(--ease-out);
}
.primary:hover:not(:disabled) {
  background: var(--accent-hover);
}
.primary:active:not(:disabled) {
  transform: scale(0.97);
}
</style>
