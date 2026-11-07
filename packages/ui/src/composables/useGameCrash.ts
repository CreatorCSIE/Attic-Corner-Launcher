/**
 * useGameCrash —— 游戏崩溃弹窗状态源（模块级单例，对齐 useConsole 订阅纪律）。
 * 订阅 GAME_EXIT：crash 在场（含 stoppedByUser 收尸复核命中签名）即置态——
 * 与控制台开不开无关（弹窗恒挂主窗，控制台窗不订阅不挂载）。
 * pid 天然去重：一次退出一个弹窗；新退出事件直接顶替旧态。
 */

import { ref, type Ref } from 'vue';
import { IPC_EVENTS, type GameExitEvent } from '@attic/core-spec';
import { useBridge } from './useBridge';

const crash: Ref<GameExitEvent | null> = ref(null);
let subscribed = false;

const { bridge } = useBridge();

function subscribe(): void {
  if (subscribed) return;
  subscribed = true;
  bridge.on(IPC_EVENTS.GAME_EXIT, (e) => {
    if (e.crash) crash.value = e;
  });
}

export function useGameCrash(): { crash: Ref<GameExitEvent | null>; dismiss: () => void } {
  subscribe();
  return { crash, dismiss: () => (crash.value = null) };
}
