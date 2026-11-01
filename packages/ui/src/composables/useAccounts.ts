/**
 * useAccounts —— 账户列表 + 当前账户共享状态。
 * 数据面走契约（AccountView 脱敏视图）；当前账户 id 属渲染侧偏好，localStorage 持久化。
 * 模块级单例：切视图不重复拉取（对齐 useGame/useConsole 范式）。
 */

import { computed, ref, type ComputedRef } from 'vue';
import type { AccountView } from '@attic/core-spec';
import { useBridge } from './useBridge';

const CURRENT_KEY = 'attic:account:current';

const accounts = ref<AccountView[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
const currentId = ref<string | null>(readStored());
let started = false;


const { bridge } = useBridge();

function readStored(): string | null {
  try {
    return localStorage.getItem(CURRENT_KEY);
  } catch {
    return null;
  }
}

/** 当前账户：显式选中优先，缺省回落列表首个（与 runtime buildContext 的 accounts[0] 语义一致）。 */
const current: ComputedRef<AccountView | null> = computed(
  () => accounts.value.find((a) => a.id === currentId.value) ?? accounts.value[0] ?? null,
);

async function load(): Promise<void> {
  loading.value = true;
  const res = await bridge.listAccounts();
  if (res.ok) accounts.value = res.value;
  else error.value = res.error;
  loading.value = false;
}

/** 添加离线账户；成功即设为当前。返回是否成功（失败原因在 error）。 */
async function add(name: string): Promise<boolean> {
  error.value = null;
  const res = await bridge.addAccount(name);
  if (!res.ok) {
    error.value = res.error;
    return false;
  }
  await load();
  select(res.value.id);
  return true;
}

/** 移除账户；移除的是当前账户时清除持久化选中（回落首个）。 */
async function remove(id: string): Promise<boolean> {
  error.value = null;
  const res = await bridge.removeAccount(id);
  if (!res.ok) {
    error.value = res.error;
    return false;
  }
  if (currentId.value === id) {
    currentId.value = null;
    try {
      localStorage.removeItem(CURRENT_KEY);
    } catch {
      /* 隐私模式 */
    }
  }
  await load();
  return true;
}

/** 重命名离线账户；被改账户为当前选中时把持久化选中重映射到新 id（离线 UUID 随名重生成）。 */
async function rename(id: string, name: string): Promise<boolean> {
  error.value = null;
  const res = await bridge.renameAccount(id, name);
  if (!res.ok) {
    error.value = res.error;
    return false;
  }
  if (currentId.value === id) select(res.value.id);
  await load();
  return true;
}

function select(id: string): void {
  currentId.value = id;
  try {
    localStorage.setItem(CURRENT_KEY, id);
  } catch {
    /* 隐私模式：会话内仍生效 */
  }
}

/**
 * 进程生命周期首拉一次：列表变化由增删改操作显式 load() 驱动。
 * skinUrl 宿主回填是一次性迁移（落盘后不再变），下次启动首拉天然带皮肤，无需实时感知。
 */
function ensureLoaded(): void {
  if (started) return;
  started = true;
  void load();
}

export function useAccounts() {
  ensureLoaded();
  return { accounts, current, loading, error, load, add, remove, rename, select };
}
