/**
 * useDebouncedField —— 即改即存页的文本/滑杆防抖写入。
 * 本地态即改即显，落盘延后 400ms；settings 外部变化（保存回执/demo 复位）回同步本地，
 * 但防抖窗口内不打断用户输入。
 * savedFlash：commit 落盘后 1.5s 内为 true——即改即存页缺的不是保存按钮（自动保存已在），
 * 是「已保存」的视觉回执。展示面自选（文本字段挂徽标，滑杆类不挂避免拖拽期间频闪）。
 */

import { ref, watch, type Ref } from 'vue';

export function useDebouncedField<T>(
  get: () => T,
  commit: (value: T) => void,
  delayMs = 400,
): { local: Ref<T>; savedFlash: Ref<boolean> } {
  const local = ref(get()) as Ref<T>;
  const savedFlash = ref(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let flashTimer: ReturnType<typeof setTimeout> | undefined;
  watch(local, (v) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      commit(v);
      savedFlash.value = true;
      if (flashTimer) clearTimeout(flashTimer);
      flashTimer = setTimeout(() => {
        savedFlash.value = false;
      }, 1500);
    }, delayMs);
  });
  watch(get, (v) => {
    if (v !== local.value) local.value = v;
  });
  return { local, savedFlash };
}
