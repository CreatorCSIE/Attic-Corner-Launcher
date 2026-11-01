/**
 * useUpdateCheck —— 检查更新共享状态（UPDATE_CHECK 通道唯一消费点，模块级单例）。
 * 策略语义（settings.updatePolicy，缺省 startup）：startup = 启动时自动检查一次；off = 从不自动检查。
 * 无 24h 轮询：策略语义即「启动时一次」，跨会话靠下次启动。
 * 自动结果打扰门 = shouldPromptUpdate（runtime updatePolicy.ts 纯函数，测试覆盖）：
 * update ∧ 版本≠忽略账 → 弹更新弹窗 + 红点；命中忽略账 → 全静默（不弹不红点）。
 * 手动检查（关于页按钮入口）：无视策略与忽略账，恒显结果弹窗。
 * 弹窗状态放本单例（dialogOpen/dialogResult），UpdateDialog 全局挂 App 层消费——关于页外也要能弹。
 * 桥面 err（无桥/壳未接线）也归一化为 error 分支：弹窗可见呈现，不静默。
 */

import { computed, ref, watch, type Ref } from 'vue';
import type { UpdateCheckResult } from '@attic/core-spec';
import { shouldPromptUpdate } from '@attic/runtime/updatePolicy';
import { useBridge } from './useBridge';
import { useSettings } from './useSettings';

const { bridge } = useBridge();

/** 最近一次检查结果（null = 尚未出结果）；自动检查与手动检查共用同一份。 */
const result = ref<UpdateCheckResult | null>(null);
/** 检查在途（手动按钮禁用 + 文案切「检查中」）。 */
const busy = ref(false);
let started = false;

// —— 弹窗状态（UpdateDialog 全局挂载消费；自动=打扰门裁决后弹，手动=恒弹） ——
const dialogOpen = ref(false);
const dialogResult = ref<UpdateCheckResult | null>(null);

/**
 * 执行一次检查（自动/手动共用一条路径，返回结果供调用方决策；busy 重入返回 null = 不弹第二发）。
 */
async function check(): Promise<UpdateCheckResult | null> {
  if (busy.value) return null;
  busy.value = true;
  try {
    const res = await bridge.checkUpdate();
    // 桥面异常封装（如 no-bridge）也归一化为 error 分支——弹窗可见呈现。
    result.value = res.ok ? res.value : { status: 'error', message: res.error };
    return result.value;
  } finally {
    busy.value = false;
  }
}

function openDialog(res: UpdateCheckResult): void {
  dialogResult.value = res;
  dialogOpen.value = true;
}

/** 关窗（取消/Esc/遮罩同路）：红点数据源在 result+忽略账，不随关窗清除。 */
function closeDialog(): void {
  dialogOpen.value = false;
}

/**
 * 红点徽标数据源 = 打扰门口径：update ∧ 版本≠忽略账（error/unconfigured 不打——误报比漏报烦人；
 * 忽略即静默，写账后本 computed 随 settings 响应自然熄灭）。
 */
const hasUpdate = computed(
  () =>
    result.value !== null &&
    result.value.status === 'update' &&
    result.value.version !== useSettings().settings.value.updateIgnoreVersion,
);

/** 手动检查（关于页按钮入口）：无视策略与忽略账，恒显结果弹窗。 */
async function checkManually(): Promise<void> {
  const res = await check();
  if (res) openDialog(res);
}

/** 「忽略此版本」：把当前弹窗对应的版本写进单槽账并关窗；红点随 hasUpdate 重算熄灭。 */
async function ignoreCurrent(): Promise<void> {
  const r = dialogResult.value;
  if (!r || r.status !== 'update') return;
  await useSettings().patch({ updateIgnoreVersion: r.version });
  dialogOpen.value = false;
}

/** 等设置就绪（策略与忽略账都是数据门，load 异步；已就绪立即 resolve）。 */
function settingsLoadedOnce(loaded: Ref<boolean>): Promise<void> {
  if (loaded.value) return Promise.resolve();
  return new Promise((resolve) => {
    const stop = watch(loaded, (v) => {
      if (v) {
        stop();
        resolve();
      }
    });
  });
}

/**
 * 启动自动检查链（幂等；App.vue 主页 onMounted 挂载，控制台窗不挂）：
 * 等设置就绪读策略 → off 不查；startup 查一次，结果过打扰门才打扰（弹窗+红点）。
 */
function start(): void {
  if (started) return;
  started = true;
  const { settings, loaded } = useSettings();
  void settingsLoadedOnce(loaded).then(async () => {
    const policy = settings.value.updatePolicy ?? 'startup';
    if (policy === 'off') return;
    const res = await check();
    if (!res) return;
    if (shouldPromptUpdate(res, settings.value.updateIgnoreVersion, policy)) openDialog(res);
  });
}

export function useUpdateCheck() {
  return {
    result,
    busy,
    hasUpdate,
    checkManually,
    start,
    dialogOpen,
    dialogResult,
    closeDialog,
    ignoreCurrent,
  };
}
