<script setup lang="ts">
/**
 * 添加账户弹窗 —— 两步流程：
 * ① 类型选择（离线 / 正版 Microsoft）；
 * ② 离线用户名输入（MC 规则 3-16 位字母/数字/下划线，与 runtime.addAccount 校验一致）。
 * 底部按钮：名称步左侧"返回"，右侧 取消/确定。
 * 微软路径确定 = 关本窗并向父级发 ms 事件（设备码弹窗由账户页挂载与驱动）。
 */
import { computed, ref, watch } from 'vue';
import { useI18n } from '../i18n';
import { useAccounts } from '../composables/useAccounts';
import { useBridge } from '../composables/useBridge';
import AppDialog from './AppDialog.vue';

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ 'update:open': [value: boolean]; ms: [] }>();

const { t } = useI18n();
const { add, error } = useAccounts();
const { hasBridge } = useBridge();

type Step = 'type' | 'name';
type AccountKind = 'offline' | 'microsoft';

const step = ref<Step>('type');
const selected = ref<AccountKind | null>(null);
const name = ref('');
const submitting = ref(false);

// 校验规则与 runtime.addAccount 一致（校验前置到 UI，错误文案走 i18n）
const NAME_RE = /^[A-Za-z0-9_]{3,16}$/;
const nameValid = computed(() => NAME_RE.test(name.value.trim()));

const confirmDisabled = computed(() =>
  step.value === 'type' ? selected.value === null : !hasBridge.value || !nameValid.value || submitting.value,
);

// 每次打开复位两步状态（避免上次选择残留）
watch(
  () => props.open,
  (v) => {
    if (!v) return;
    step.value = 'type';
    selected.value = null;
    name.value = '';
    submitting.value = false;
    error.value = null;
  },
);

function close(): void {
  emit('update:open', false);
}

async function onConfirm(): Promise<void> {
  error.value = null;
  if (step.value === 'type') {
    if (selected.value === 'offline') step.value = 'name';
    else if (selected.value === 'microsoft') {
      // 微软路径：关本窗，设备码弹窗由父级（账户页）接管
      close();
      emit('ms');
    }
    return;
  }
  if (!nameValid.value || submitting.value) return;
  submitting.value = true;
  const ok = await add(name.value);
  submitting.value = false;
  if (ok) close();
}
</script>

<template>
  <AppDialog :open="props.open" @close="close">
    <header class="head">
      <h2 class="title">{{ t('account.add') }}</h2>
      <p class="subtitle">{{ t('account.dialog.subtitle') }}</p>
    </header>

    <!-- 第一步：账户类型选择卡列表 -->
    <ul v-if="step === 'type'" class="options">
      <li>
        <button
          class="option"
          :class="{ 'option--selected': selected === 'offline' }"
          type="button"
          @click="selected = 'offline'"
        >
          <span class="opt-icon" aria-hidden="true">
            <!-- lucide: link -->
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M9 17H7A5 5 0 0 1 7 7h2" />
              <path d="M15 7h2a5 5 0 1 1 0 10h-2" />
              <line x1="8" x2="16" y1="12" y2="12" />
            </svg>
          </span>
          <span class="opt-main">
            <span class="opt-title">{{ t('account.dialog.offlineTitle') }}</span>
            <span class="opt-desc">{{ t('account.dialog.offlineDesc') }}</span>
          </span>
        </button>
      </li>
      <li>
        <button
          class="option"
          :class="{ 'option--selected': selected === 'microsoft' }"
          type="button"
          @click="selected = 'microsoft'"
        >
          <span class="opt-icon" aria-hidden="true">
            <!-- lucide: user -->
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
              <circle cx="12" cy="7" r="4" />
            </svg>
          </span>
          <span class="opt-main">
            <span class="opt-title">{{ t('account.dialog.msTitle') }}</span>
            <span class="opt-desc">{{ t('account.dialog.msDesc') }}</span>
          </span>
        </button>
      </li>
    </ul>

    <!-- 第二步：离线账户用户名 -->
    <div v-else class="form">
      <label class="field-label" for="add-acct-name">{{ t('account.dialog.usernameLabel') }}</label>
      <input
        id="add-acct-name"
        v-model="name"
        class="input"
        type="text"
        maxlength="16"
        autocomplete="off"
        :placeholder="t('account.namePlaceholder')"
        @keyup.enter="onConfirm"
      />
      <p v-if="name && !nameValid" class="invalid">{{ t('account.dialog.usernameValidation') }}</p>
    </div>

    <p v-if="error" class="err">{{ error }}</p>

    <footer class="foot">
      <button v-if="step === 'name'" class="ghost" type="button" @click="step = 'type'">
        {{ t('account.dialog.back') }}
      </button>
      <span class="foot-spacer"></span>
      <button class="ghost" type="button" @click="close">{{ t('account.dialog.cancel') }}</button>
      <button class="primary" type="button" :disabled="confirmDisabled" @click="onConfirm">
        {{ t('account.dialog.confirm') }}
      </button>
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
.subtitle {
  margin: 0;
  font-size: var(--fs-sm);
  color: var(--text-secondary);
}
.options {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
/* 类型卡：surface-3 底 + 层级描边；选中 = accent 环 */
.option {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  width: 100%;
  padding: var(--space-4) var(--space-5);
  background: var(--card-bg);
  border: 1px solid var(--card-border);
  border-radius: var(--radius-md);
  box-shadow: var(--inset-bottom);
  color: var(--text-primary);
  text-align: left;
  cursor: pointer;
  transition:
    border-color var(--dur-fast) var(--ease-out),
    background var(--dur-fast) var(--ease-out),
    box-shadow var(--dur-fast) var(--ease-out);
}
.option:hover:not(:disabled) {
  background: var(--surface-4);
}
.option--selected {
  border-color: var(--accent);
  box-shadow: var(--inset-bottom), 0 0 0 1px var(--accent-ring);
}
.option:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.opt-icon {
  flex: 0 0 24px;
  width: 24px;
  height: 24px;
  color: var(--text-secondary);
}
.opt-icon svg {
  width: 100%;
  height: 100%;
}
.opt-main {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
  flex: 1;
}
.opt-title {
  font-size: var(--fs-md);
  font-weight: 600;
}
.opt-desc {
  font-size: var(--fs-xs);
  color: var(--text-secondary);
}
.form {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.field-label {
  font-size: var(--fs-xs);
  letter-spacing: var(--tracking-label);
  text-transform: uppercase;
  color: var(--text-muted);
}
.input {
  padding: var(--space-3) var(--space-4);
  background: var(--surface-3);
  border: none;
  border-radius: var(--radius-md);
  color: var(--text-primary);
  box-shadow: var(--input-inset);
  transition:
    background-color var(--dur-fast) var(--ease-out),
    box-shadow var(--dur-fast) var(--ease-out);
}
.input:hover {
  background: var(--surface-4);
}
.input:focus-visible {
  outline: none;
  box-shadow: var(--input-focus-shadow);
}
.invalid {
  margin: 0;
  font-size: var(--fs-xs);
  color: var(--danger);
}
.err {
  margin: 0;
  font-size: var(--fs-xs);
  color: var(--danger);
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
.primary:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
</style>
