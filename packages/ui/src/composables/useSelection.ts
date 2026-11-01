/**
 * useSelection —— 跨组件共享的"当前选中版本"（启动视图用）。
 * 实例联动：用户选中即写回激活实例档案（窄通道 setInstanceVersion，单字段落盘不等启动）；
 * 切换激活实例 / 档案版本变化（启动回写兜底、删除清指针）→ 版本选择跟随档案，用户手选不被同值回拽。
 */

import { ref, computed, watch, type Ref, type ComputedRef } from 'vue';
import type { VersionRef } from '@attic/core-spec';
import { useVersions } from './useVersions';
import { useInstances } from './useInstances';

const selectedId: Ref<string | null> = ref(null);

const { versions } = useVersions();
const { active, setVersion } = useInstances();

const selected: ComputedRef<VersionRef | null> = computed(
  () => versions.value.find((v) => v.id === selectedId.value) ?? null,
);

function select(id: string | null): void {
  selectedId.value = id;
  // 选中即写回实例档案（不等启动）。null 不写回——"取消选择"不清版本指针。
  // 回包 upsert 触发的 active watch 因 inst.version === selectedId 不会回拽（无成环）。
  if (id) void setVersion(active.value?.name ?? null, id);
}

// 激活实例 → 版本联动（immediate 覆盖"激活名已从 localStorage 恢复"的同步场景）。
// 只在"切换激活实例"或"档案版本变化"（启动回写/改名）时跟随；
// 保存实例（如「≡」菜单勾 addons）产生的同 (name, version) 新对象不得拽回用户手选版本。
let lastFollowed: string | null = null;
watch(
  active,
  (inst) => {
    if (!inst) return;
    const tag = `${inst.name}\u0000${inst.version}`;
    if (tag === lastFollowed) return;
    lastFollowed = tag;
    if (inst.version !== selectedId.value) selectedId.value = inst.version;
  },
  { immediate: true },
);

export function useSelection() {
  return { selectedId, selected, select };
}
