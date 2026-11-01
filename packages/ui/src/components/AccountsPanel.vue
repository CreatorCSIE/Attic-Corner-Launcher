<script setup lang="ts">
/**
 * 账户页 —— 双栏形态：
 * 左 = 账户菜单列（标题「账户」+ 账户项[头像/名/hover 删除] + 底部「添加账户」），
 * 右 = 用户信息（64px 头像 + 名称[离线可重命名] + 类型标签 + UUID 节[只读字段+复制]）。
 * 皮肤/披风节不实现（仅留 UUID 部分）；添加账户为弹出子窗口（AddAccountDialog），非页内组件。
 * 选中列表项即设为当前账户。
 */
import { ref, watch } from 'vue';
import { useI18n } from '../i18n';
import { useAccounts } from '../composables/useAccounts';
import { useBridge } from '../composables/useBridge';
import type { AccountView } from '@attic/core-spec';
import SkinAvatar from './SkinAvatar.vue';
import AddAccountDialog from './AddAccountDialog.vue';
import RenameAccountDialog from './RenameAccountDialog.vue';
import MsLoginDialog from './MsLoginDialog.vue';
import ConfirmDialog from './ConfirmDialog.vue';

const { t } = useI18n();
const { accounts, current, loading, remove, select, load } = useAccounts();
const { bridge, hasBridge } = useBridge();

const addOpen = ref(false);
const renameOpen = ref(false);
const msOpen = ref(false);
const copied = ref(false);
let copiedTimer: ReturnType<typeof setTimeout> | undefined;

// 微软账户「重新验证」（tokenValid=false 行内动作）：在途态 + 可见失败行；切账户即清错误
const refreshing = ref(false);
const refreshError = ref<string | null>(null);
watch(
  () => current.value?.id,
  () => {
    refreshError.value = null;
  },
);

async function revalidate(account: AccountView): Promise<void> {
  if (refreshing.value) return;
  refreshError.value = null;
  refreshing.value = true;
  const res = await bridge.msRefreshAccount(account.id);
  refreshing.value = false;
  if (!res.ok) {
    refreshError.value = res.error;
    return;
  }
  await load();
}

// 删除确认（防误删）：记录目标账户 + 弹窗开关 + 在途态
const removeOpen = ref(false);
const removeTarget = ref<AccountView | null>(null);
const removing = ref(false);

function askRemove(account: AccountView): void {
  removeTarget.value = account;
  removeOpen.value = true;
}

async function onConfirmRemove(): Promise<void> {
  if (!removeTarget.value) return;
  removing.value = true;
  const ok = await remove(removeTarget.value.id);
  removing.value = false;
  if (ok) removeOpen.value = false;
}

async function copyUuid(): Promise<void> {
  if (!current.value) return;
  try {
    await navigator.clipboard.writeText(current.value.id);
    copied.value = true;
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => (copied.value = false), 1500);
  } catch {
    /* 剪贴板不可用（无焦点/权限）：静默，不打断布局 */
  }
}
</script>

<template>
  <section class="accounts-page">
    <!-- 左栏：账户列表菜单 -->
    <aside class="menu">
      <h2 class="menu-title">{{ t('account.title') }}</h2>

      <div v-if="loading" class="menu-state">{{ t('common.loading') }}</div>
      <ul v-else class="menu-list">
        <li v-for="a in accounts" :key="a.id" class="menu-row">
          <button
            class="menu-item"
            :class="{ 'menu-item--selected': current?.id === a.id }"
            type="button"
            @click="select(a.id)"
          >
            <SkinAvatar :username="a.name" :uuid="a.id" :skin-url="a.skinUrl ?? ''" :size="28" />
            <span class="mi-name">{{ a.name }}</span>
            <!-- 微软令牌失效徽标（tokenValid=false；离线账户无此面） -->
            <span v-if="a.type === 'microsoft' && a.tokenValid === false" class="mi-warn">{{
              t('account.ms.revalidateBadge')
            }}</span>
          </button>
          <button
            class="mi-del"
            type="button"
            :disabled="!hasBridge"
            :title="t('account.remove')"
            @click.stop="askRemove(a)"
          >
            <!-- lucide: trash-2 -->
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 6h18" />
              <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
              <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
              <line x1="10" x2="10" y1="11" y2="17" />
              <line x1="14" x2="14" y1="11" y2="17" />
            </svg>
          </button>
        </li>
      </ul>

      <button class="menu-add" type="button" @click="addOpen = true">
        <!-- lucide: user-plus -->
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <line x1="19" x2="19" y1="8" y2="14" />
          <line x1="22" x2="16" y1="11" y2="11" />
        </svg>
        <span>{{ t('account.add') }}</span>
      </button>
    </aside>

    <!-- 右栏：用户信息（离线形态：头像 + 名称[重命名] + 类型 + UUID；皮肤节不实现） -->
    <div class="detail">
      <div v-if="current" class="info">
        <SkinAvatar :username="current.name" :uuid="current.id" :skin-url="current.skinUrl ?? ''" :size="64" rounded="var(--radius-md)" />

        <div class="name-row">
          <h3 class="name">{{ current.name }}</h3>
          <button
            v-if="current.type === 'offline' && hasBridge"
            class="icon-btn"
            type="button"
            :title="t('account.rename')"
            @click="renameOpen = true"
          >
            <!-- lucide: pencil -->
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
              <path d="m15 5 4 4" />
            </svg>
          </button>
        </div>
        <p class="kind">
          {{ current.type === 'microsoft' ? t('account.typeMicrosoft') : t('account.typeOffline') }}
          <span v-if="current.type === 'microsoft' && current.tokenValid === false" class="mi-warn">{{
            t('account.ms.revalidateBadge')
          }}</span>
        </p>

        <!-- 微软令牌失效：行内「重新验证」动作（成功刷新列表，失败可见错误行；离线账户无此面） -->
        <div v-if="current.type === 'microsoft' && current.tokenValid === false && hasBridge" class="reval-row">
          <button class="reval-btn" type="button" :disabled="refreshing" @click="revalidate(current)">
            {{ refreshing ? t('account.ms.revalidating') : t('account.ms.revalidate') }}
          </button>
        </div>
        <p v-if="current.type === 'microsoft' && refreshError" class="reval-err">{{
          t('account.ms.revalidateFailed', { message: refreshError })
        }}</p>

        <section class="uuid-sec">
          <h4 class="sec-title">{{ t('account.uuid') }}</h4>
          <div class="uuid-field">
            <code class="uuid-val">{{ current.id }}</code>
            <button class="icon-btn" type="button" :title="t('account.copy')" @click="copyUuid">
              <!-- lucide: copy / check（已复制反馈） -->
              <svg v-if="!copied" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
                <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
              </svg>
              <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M20 6 9 17l-5-5" />
              </svg>
            </button>
          </div>
        </section>
      </div>

      <!-- 空态：无卡片容器，仅一行居中文案 -->
      <div v-else class="empty">
        <p class="state-hint">{{ t('account.hint') }}</p>
      </div>
    </div>

    <AddAccountDialog v-model:open="addOpen" @ms="msOpen = true" />
    <RenameAccountDialog v-model:open="renameOpen" :account="current" />
    <!-- 微软设备码登录弹窗（添加流程「正版账户」入口唤起；成功事件内自刷列表） -->
    <MsLoginDialog v-model:open="msOpen" />
    <!-- 删除确认（防误删）：文案含账户名 -->
    <ConfirmDialog
      v-model:open="removeOpen"
      :title="t('account.removeDialog.title')"
      :message="t('account.removeDialog.message', { name: removeTarget?.name ?? '' })"
      :busy="removing"
      @confirm="onConfirmRemove"
    />
  </section>
</template>

<style scoped>
/* 双栏骨架：左菜单卡片贴左，详情内容浮中见 .info。 */
.accounts-page {
  display: flex;
  flex: 1;
  gap: var(--space-5);
  min-height: 0;
  padding: var(--space-5);
}
/* —— 左栏：账户菜单（固定宽卡片 248px） —— */
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
.menu-state {
  font-size: var(--fs-sm);
  color: var(--text-muted);
  padding: var(--space-2);
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
/* 列表项：头像 + 名；选中 = surface-3 底高亮 */
.menu-item {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  width: 100%;
  padding: var(--space-2) var(--space-3);
  padding-right: 40px; /* 给 hover 删除钮让位 */
  background: transparent;
  border: none;
  border-radius: var(--radius-md);
  color: var(--text-primary);
  font-size: var(--fs-md);
  text-align: left;
  cursor: pointer;
  transition:
    background-color var(--dur-fast) var(--ease-out),
    box-shadow var(--dur-fast) var(--ease-out);
}
.menu-item:hover {
  background-color: var(--surface-3);
}
.menu-item--selected {
  background-color: var(--surface-3);
  box-shadow: inset 0 0 0 1px var(--surface-4);
}
.mi-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 令牌失效徽标（warn 色系）：行内 + 详情类型行共用 */
.mi-warn {
  flex: 0 0 auto;
  font-size: var(--fs-xs);
  letter-spacing: var(--tracking-label);
  padding: 1px var(--space-2);
  border-radius: var(--radius-sm);
  color: var(--warn);
  background: var(--warn-soft);
}
/* 删除钮：hover 行时浮现（opacity 0→1） */
.mi-del {
  position: absolute;
  top: 50%;
  right: var(--space-2);
  transform: translateY(-50%);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  background: transparent;
  border: none;
  border-radius: var(--radius-sm);
  color: var(--danger);
  opacity: 0;
  pointer-events: none;
  cursor: pointer;
  transition:
    opacity var(--dur-fast) var(--ease-out),
    background var(--dur-fast) var(--ease-out);
}
.mi-del svg {
  width: 16px;
  height: 16px;
}
.menu-row:hover .mi-del {
  opacity: 1;
  pointer-events: auto;
}
.mi-del:hover {
  background: var(--danger-soft);
}
.mi-del:disabled {
  display: none;
}
/* 添加账户：菜单底部行 */
.menu-add {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  width: 100%;
  padding: var(--space-2) var(--space-3);
  background: transparent;
  border: none;
  border-radius: var(--radius-md);
  color: var(--text-primary);
  font-size: var(--fs-md);
  text-align: left;
  cursor: pointer;
  transition: background-color var(--dur-fast) var(--ease-out);
}
.menu-add svg {
  flex: 0 0 24px;
  width: 24px;
  height: 24px;
}
.menu-add:hover {
  background-color: var(--surface-3);
}
/* —— 右栏：用户信息（限宽列在剩余空间中水平浮中） —— */
.detail {
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
  padding: var(--space-6) var(--space-3);
}
.info {
  max-width: 560px;
  margin-inline: auto;
}
.name-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin-top: var(--space-4);
}
.name {
  margin: 0;
  font-size: var(--fs-xl);
  font-weight: 700;
  color: var(--text-primary);
}
.kind {
  margin: var(--space-2) 0 0;
  font-size: var(--fs-sm);
  color: var(--text-secondary);
  display: flex;
  align-items: center;
  gap: var(--space-3);
}
/* 重新验证动作行 + 失败可见错误行（微软令牌失效态专属） */
.reval-row {
  margin-top: var(--space-3);
}
.reval-btn {
  padding: var(--space-2) var(--space-5);
  background: var(--surface-3);
  border: 1px solid var(--card-border);
  border-radius: var(--radius-md);
  box-shadow: var(--inset-bottom);
  color: var(--text-primary);
  font-size: var(--fs-sm);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease-out);
}
.reval-btn:hover:not(:disabled) {
  background: var(--surface-4);
}
.reval-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.reval-err {
  margin: var(--space-2) 0 0;
  font-size: var(--fs-xs);
  color: var(--danger);
  overflow-wrap: anywhere;
}
.uuid-sec {
  margin-top: var(--space-6);
}
.sec-title {
  margin: 0 0 var(--space-3);
  font-size: var(--fs-lg);
  font-weight: 600;
  color: var(--text-primary);
}
/* UUID 只读字段：控件底 + inset + 右缘复制钮 */
.uuid-field {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  background: var(--surface-3);
  border: 1px solid var(--card-border);
  border-radius: var(--radius-md);
  box-shadow: var(--input-inset);
}
.uuid-val {
  flex: 1;
  min-width: 0;
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
  color: var(--text-primary);
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
</style>
