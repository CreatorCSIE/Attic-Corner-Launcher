/**
 * useGame —— 启动状态机（launch/kill/status/dryRun）。
 * 错误以数据返回（IpcResult），UI 不抛异常；launch 后刷新 status。
 */

import { ref } from 'vue';
import {
  IPC_EVENTS,
  LAUNCH_CANCELLED_MESSAGE,
  type GameStatus,
  type LaunchConfig,
  type LaunchRequest,
} from '@attic/core-spec';
import { useBridge } from './useBridge';
import { useInstances } from './useInstances';

const status = ref<GameStatus>({ running: false, session: null, lastExit: null, lastError: null });
const busy = ref(false);
const lastError = ref<string | null>(null);
const dryRun = ref<LaunchConfig | null>(null);

const { bridge } = useBridge();

// 游戏自然退出（关窗口）无人通知 → 状态卡 running。订阅 game:exit 刷新（模块级一次，对齐 useConsole）。
let subscribed = false;
function subscribeExit(): void {
  if (subscribed) return;
  subscribed = true;
  bridge.on(IPC_EVENTS.GAME_EXIT, () => {
    console.log('[attic-ui] game-exit received → refresh status');
    void refresh();
  });
}

async function refresh(): Promise<void> {
  const res = await bridge.status();
  if (res.ok) status.value = res.value;
  else if (res.error !== 'no-bridge') lastError.value = res.error;
}

async function launch(req: LaunchRequest): Promise<boolean> {
  busy.value = true;
  lastError.value = null;
  const resPromise = bridge.launch(req);
  // 点启动即刷新实例列表：宿主 launch() 在首个 await 前的同步段完成建档+版本回写
  // （runtime.ts 时序注释），IPC 消息 FIFO 保证该同步段先于本条清单查询执行——新实例
  // 不再等下载/游戏进程起来才出现。fire-and-forget：结果由 launch resolve 后的刷新兜底。
  void useInstances().load();
  const res = await resPromise;
  // 取消 = 中性态：用户主动中止不记 lastError、不显红态。
  if (!res.ok && res.error !== LAUNCH_CANCELLED_MESSAGE) lastError.value = res.error;
  await refresh();
  void useInstances().load();
  busy.value = false;
  return res.ok;
}

/**
 * 取消进行中的启动：中止启动前下载/补全链。
 * 返回是否真正发出中止；无在途启动/已 spawn（cancelled:false）静默无操作。
 */
async function cancel(): Promise<boolean> {
  const res = await bridge.cancelLaunch();
  return res.ok && res.value.cancelled;
}

async function kill(): Promise<boolean> {
  busy.value = true;
  const res = await bridge.kill();
  if (!res.ok) lastError.value = res.error;
  await refresh();
  busy.value = false;
  return res.ok;
}

async function doDryRun(req: LaunchRequest): Promise<boolean> {
  const res = await bridge.dryRunLaunch(req);
  if (res.ok) dryRun.value = res.value;
  else lastError.value = res.error;
  return res.ok;
}

export function useGame() {
  subscribeExit();
  void refresh();
  return { status, busy, lastError, dryRun, refresh, launch, cancel, kill, doDryRun };
}
