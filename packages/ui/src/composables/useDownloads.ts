/**
 * useDownloads —— 模块级下载聚合订阅层。
 * 主页启动面板消费：阶段文案 + 单调进度条（Math.Max 永不回退）+ 速率 + 失败显式态。
 * 不依赖控制台窗口存在；每次启动前 reset；启动结束后 UI 侧不再展示（迟到进度自然丢弃）。
 * 数据契约复用 DownloadProgressEvent（core-spec），不扩字段。
 */

import { computed, ref, type ComputedRef } from 'vue';
import { IPC_EVENTS, type DownloadItem, type DownloadProgressEvent } from '@attic/core-spec';
import { useBridge } from './useBridge';

const { bridge } = useBridge();

const items = ref<Record<string, DownloadProgressEvent>>({});
/** 聚合百分比：单调合并，只升不降。 */
const percent = ref(0);
/** 瞬时速率 B/s（500ms 采样窗，UI 侧计算——runtime 事件不带速率）。 */
const rateBps = ref(0);
/** 最近一次事件的下载类别 → 阶段文案来源。 */
const stage = ref<DownloadItem | null>(null);

let subscribed = false;
let sampleTs = 0;
let sampleBytes = 0;

function keyOf(e: DownloadProgressEvent): string {
  return `${e.item}:${e.id}`;
}

/* asset-check 的 bytesDone/bytesTotal 是对象计数（非字节），字节聚合两端均除外计入。 */
function isByteEvent(e: DownloadProgressEvent): boolean {
  return e.item !== 'asset-check';
}

function totalBytesDone(): number {
  let done = 0;
  for (const it of Object.values(items.value)) if (isByteEvent(it)) done += it.bytesDone;
  return done;
}

function subscribe(): void {
  if (subscribed) return;
  subscribed = true;

  bridge.on(IPC_EVENTS.DOWNLOAD_PROGRESS, (e) => {
    items.value[keyOf(e)] = { ...e };
    stage.value = e.item;

    let total = 0;
    for (const it of Object.values(items.value)) if (isByteEvent(it)) total += it.bytesTotal ?? it.bytesDone;
    if (total > 0) {
      const p = Math.min(100, Math.round((totalBytesDone() / total) * 100));
      if (p > percent.value) percent.value = p;
    }

    if (e.phase === 'transferring') {
      const now = Date.now();
      const done = totalBytesDone();
      if (sampleTs === 0) {
        sampleTs = now;
        sampleBytes = done;
      }
      const dt = now - sampleTs;
      if (dt >= 500) {
        rateBps.value = Math.max(0, Math.round(((done - sampleBytes) * 1000) / dt));
        sampleTs = now;
        sampleBytes = done;
      }
    }
  });
}

/** 每次启动前调用：清空聚合，保证进度/失败态从 0 开始。 */
function reset(): void {
  items.value = {};
  percent.value = 0;
  rateBps.value = 0;
  stage.value = null;
  sampleTs = 0;
  sampleBytes = 0;
}

const active: ComputedRef<boolean> = computed(() => Object.keys(items.value).length > 0);
const failed: ComputedRef<DownloadProgressEvent | null> = computed(
  () => Object.values(items.value).find((e) => e.phase === 'failed') ?? null,
);

export interface DownloadsStore {
  percent: typeof percent;
  rateBps: typeof rateBps;
  stage: typeof stage;
  active: ComputedRef<boolean>;
  failed: ComputedRef<DownloadProgressEvent | null>;
  /** 逐对象最新事件（`item:id` 键）——启动进度弹窗任务行数据源。 */
  items: typeof items;
  reset: () => void;
}

export function useDownloads(): DownloadsStore {
  subscribe();
  return { percent, rateBps, stage, active, failed, items, reset };
}
