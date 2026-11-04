/**
 * useInstances —— 实例薄档案共享状态（list/save/激活实例）。
 * 实例数据驱动：name/version/javaPath 全走契约，UI 不派生 gameDir（属宿主）。
 * 激活实例（activeName）为 UI 层共享态：localStorage 持久化 + 清单加载后兜底，
 * AppSettings 契约不动。
 */

import { computed, ref, watch } from 'vue';
import type { InstanceView } from '@attic/core-spec';
import { useBridge } from './useBridge';

const instances = ref<InstanceView[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
let started = false;

const { bridge } = useBridge();

// —— 激活实例：localStorage 持久化（键名规则：attic:<域>:v1） ——
const ACTIVE_KEY = 'attic:active-instance:v1';
const activeName = ref<string>('');
try {
  activeName.value = localStorage.getItem(ACTIVE_KEY) ?? '';
} catch {
  /* 隐私模式：空激活名 = 宿主按契约缺省回落 default instance */
}

const active = computed(() => instances.value.find((i) => i.name === activeName.value) ?? null);

function setActive(name: string): void {
  activeName.value = name;
  try {
    localStorage.setItem(ACTIVE_KEY, name);
  } catch {
    /* 隐私模式：仅内存态 */
  }
}

// 兜底：激活名未初始化/已失效 → 契约文档缺省 `default instance`（LaunchRequest.instanceId
// 注释所载宿主缺省，非 UI 自造规则）→ 回落首个实例。清单为空则不动。
watch(instances, (list) => {
  if (list.length === 0 || active.value) return;
  const fallback = list.find((i) => i.name === 'default instance') ?? list[0];
  if (fallback) setActive(fallback.name);
});

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  const res = await bridge.listInstances();
  if (res.ok) instances.value = res.value;
  else error.value = res.error;
  loading.value = false;
}

/** 保存（新建/覆盖），成功后就地 upsert。 */
async function save(inst: InstanceView): Promise<boolean> {
  const res = await bridge.saveInstance(inst);
  if (res.ok) {
    const saved = res.value;
    const idx = instances.value.findIndex((i) => i.name === saved.name);
    if (idx >= 0) instances.value[idx] = saved;
    else instances.value.push(saved);
  }
  return res.ok;
}

/** 删除薄档案（withFiles=true 连实例目录一并删，护栏在宿主）；成功后就地移除，
 * 激活兜底由 watch 自动接管。 */
async function remove(name: string, withFiles: boolean): Promise<boolean> {
  const res = await bridge.deleteInstance(name, withFiles);
  if (res.ok) instances.value = instances.value.filter((i) => i.name !== name);
  return res.ok;
}

/** 改名（档案迁移、gameDir 不动）：成功就地替换（改名只动 name，本地视图
 * 与宿主返回等价），激活实例被改名时 setActive 跟随防指针失效。返回 null=成功 / 错误文案。 */
async function rename(name: string, newName: string): Promise<string | null> {
  const res = await bridge.renameInstance(name, newName);
  if (!res.ok) return res.error;
  instances.value = instances.value.map((i) => (i.name === name ? { ...i, name: newName } : i));
  if (activeName.value === name) setActive(newName);
  return null;
}

/** 版本选中即写回（窄通道单字段落盘）：宿主返回的
 * 权威视图就地 upsert。seq 守卫防快速连选的过期回包把清单拽回旧版本；失败静默
 * （实例页 save 同口径）——下次 load 或启动回写收敛。 */
let setVersionSeq = 0;
async function setVersion(name: string | null, versionId: string): Promise<void> {
  const seq = ++setVersionSeq;
  const res = await bridge.setInstanceVersion(name, versionId);
  if (!res.ok || seq !== setVersionSeq) return;
  const saved = res.value;
  const idx = instances.value.findIndex((i) => i.name === saved.name);
  if (idx >= 0) instances.value[idx] = saved;
  else instances.value.push(saved);
  // 宿主建档兜底（无激活实例时回落默认实例）：清单原本为空/激活失效 → 跟随新档案。
  if (!active.value) setActive(saved.name);
}

/** Addons 勾选即落盘（set-version 同款窄通道）：宿主单字段读-改-写，权威视图就地
 * upsert。seq 守卫防快速连勾的过期回包拽回旧勾选集；失败静默（下次 load 或全档案 save 收敛）。 */
let setAddonsSeq = 0;
async function setAddons(name: string | null, addons: string[]): Promise<void> {
  const seq = ++setAddonsSeq;
  const res = await bridge.setInstanceAddons(name, addons);
  if (!res.ok || seq !== setAddonsSeq) return;
  const saved = res.value;
  const idx = instances.value.findIndex((i) => i.name === saved.name);
  if (idx >= 0) instances.value[idx] = saved;
  else instances.value.push(saved);
  if (!active.value) setActive(saved.name);
}

/** 打开实例目录：成功返回 null，失败返回错误文案（UI 内联可见）。 */
async function openDir(name: string): Promise<string | null> {
  const res = await bridge.openInstanceDir(name);
  return res.ok ? null : res.error;
}

function ensureLoaded(): void {
  if (started) return;
  started = true;
  void load();
}

export function useInstances() {
  ensureLoaded();
  return {
    instances,
    loading,
    error,
    load,
    save,
    remove,
    rename,
    setVersion,
    setAddons,
    openDir,
    activeName,
    active,
    setActive,
  };
}
