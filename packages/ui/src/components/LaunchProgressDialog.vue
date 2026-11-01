<script setup lang="ts">
/**
 * 启动进度弹窗 —— 无条件唤起（资产检查亦可见）；模态；阶段行 = LAUNCH_DOWNLOAD_STAGES
 * 目录驱动（零版本判断）；任务行 = 当前传输/失败项（id + 错误消息 + 整行细进度条，完成即隐）。
 * 计数器退化「已完成 N」（不扩契约、无总数分母）。
 * 取消钮 = 补全期唯一取消入口（= cancelLaunch）；Esc/遮罩 busy 时同语义。
 */
import { computed } from 'vue';
import { LAUNCH_DOWNLOAD_STAGES, type DownloadItem, type DownloadProgressEvent } from '@attic/core-spec';
import { useI18n } from '../i18n';
import { useDownloads } from '../composables/useDownloads';
import AppDialog from './AppDialog.vue';

const props = defineProps<{ open: boolean; busy: boolean; error?: string | null }>();
const emit = defineEmits<{ cancel: []; close: [] }>();

const { t } = useI18n();
const { items, percent, rateBps, stage } = useDownloads();

type StageState = 'running' | 'done' | 'failed';
interface StageRow {
  item: DownloadItem;
  state: StageState;
  doneCount: number;
  /** 任务行承载：失败项优先，其次当前传输/校验项。 */
  active: DownloadProgressEvent | null;
}

/** 当前阶段下标（最近事件所属 item）；-1 = 尚无事件。流水线串行，越过即完成。 */
const curIdx = computed(() => (stage.value ? LAUNCH_DOWNLOAD_STAGES.indexOf(stage.value) : -1));

/* 只列实际发生事件的阶段（已下完的游戏不整屏 ⋯ 占位）；
 * 未发生阶段不显示——弹窗随流水线推进逐行浮现，秒启动场景只剩 version-json 一行。 */
const rows = computed<StageRow[]>(() => {
  const evs = Object.values(items.value);
  const out: StageRow[] = [];
  LAUNCH_DOWNLOAD_STAGES.forEach((item, idx) => {
    const mine = evs.filter((e) => e.item === item);
    if (mine.length === 0) return;
    const failedEv = mine.find((e) => e.phase === 'failed') ?? null;
    const activeEv = mine.find((e) => e.phase === 'transferring' || e.phase === 'verifying') ?? null;
    const doneCount = mine.reduce((n, e) => (e.phase === 'done' ? n + 1 : n), 0);
    const state: StageState = failedEv ? 'failed' : idx < curIdx.value ? 'done' : 'running';
    out.push({ item, state, doneCount, active: failedEv ?? activeEv });
  });
  return out;
});

/** 单任务行进度（bytesTotal 未知 = chunked，无宽度）。 */
function itemPct(e: DownloadProgressEvent): number {
  if (!e.bytesTotal) return 0;
  return Math.min(100, Math.round((e.bytesDone / e.bytesTotal) * 100));
}

/** 速率文本（MB/s，一位小数）。 */
function mb(bytes: number): string {
  return (bytes / 1048576).toFixed(1);
}

/** Esc/遮罩：busy = 取消启动（弹窗留到 launch 落定）；非 busy = 关窗。 */
function onShellClose(): void {
  if (props.busy) emit('cancel');
  else emit('close');
}
</script>

<template>
  <AppDialog :open="open" @close="onShellClose">
    <header class="dlg-head">
      <h2 class="dlg-title">{{ t('launch.dialog.title') }}</h2>
    </header>

    <ul class="tasklist">
      <li v-for="row in rows" :key="row.item" class="stage" :class="`stage--${row.state}`">
        <span class="stage-icon" aria-hidden="true">
          <template v-if="row.state === 'done'">✓</template>
          <template v-else-if="row.state === 'failed'">✗</template>
          <template v-else>›</template>
        </span>
        <span class="stage-name">{{ t(`launch.stage.${row.item}`) }}</span>
        <!-- 计数只在进行中显示（完成/失败后无意义；asset-check 合成事件也天然不显「已完成 1」） -->
        <span v-if="row.doneCount && row.state === 'running'" class="stage-count">{{ t('launch.dialog.doneCount', { n: row.doneCount }) }}</span>

        <!-- 任务行（缩进）：整行细进度条绑单对象字节进度；
             asset-check 的 id 是资产索引 sha（无信息量）→ 只显计数进度条不显 id -->
        <div v-if="row.active" class="task">
          <span v-if="row.item !== 'asset-check'" class="task-id mono">{{ row.active.id }}</span>
          <span v-if="row.active.error" class="task-err">{{ row.active.error }}</span>
          <div class="task-bar">
            <div class="task-fill" :style="{ width: itemPct(row.active) + '%' }"></div>
          </div>
        </div>
      </li>
    </ul>

    <p v-if="!busy && error" class="dlg-err">{{ t('launch.failed') }}：{{ error }}</p>

    <footer class="dlg-foot">
      <span class="dlg-foot-info">
        <span v-if="percent" class="dlg-pct">{{ percent }}%</span>
        <span v-if="busy && rateBps" class="dlg-rate">{{ mb(rateBps) }} MB/s</span>
      </span>
      <button class="dlg-btn" type="button" @click="onShellClose">
        {{ busy ? t('launch.dialog.cancel') : t('launch.dialog.close') }}
      </button>
    </footer>
  </AppDialog>
</template>

<style scoped>
.dlg-head {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.dlg-title {
  margin: 0;
  font-size: var(--fs-xl);
  font-weight: 700;
  color: var(--text-primary);
}
/* 任务列表：固定高度滚动区（弹窗不随行数伸缩跳动） */
.tasklist {
  list-style: none;
  margin: 0;
  padding: 0 2px;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  overflow-y: auto;
  height: 240px;
}
.stage {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: var(--space-3);
  font-size: var(--fs-sm);
  color: var(--text-muted);
}
.stage-icon {
  flex: 0 0 1.2em;
  text-align: center;
}
.stage--running {
  color: var(--text-primary);
}
.stage--running .stage-icon {
  color: var(--accent);
  animation: stage-pulse 1s var(--ease-out) infinite;
}
.stage--done {
  color: var(--text-secondary);
}
.stage--done .stage-icon {
  color: var(--text-secondary);
}
.stage--failed,
.stage--failed .stage-icon,
.stage--failed .task-err {
  color: var(--danger);
}
.stage-count {
  margin-left: auto;
  font-size: var(--fs-xs);
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
}
/* 任务行：缩进，整行独占 */
.task {
  flex: 1 1 100%;
  padding-left: var(--space-5);
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
.task-id {
  font-size: var(--fs-xs);
  color: var(--text-secondary);
  overflow-wrap: anywhere;
}
.task-err {
  font-size: var(--fs-xs);
  color: var(--danger);
  overflow-wrap: anywhere;
}
.task-bar {
  height: 5px;
  background: var(--surface-1);
  border-radius: var(--radius-pill);
  overflow: hidden;
}
.task-fill {
  height: 100%;
  background: var(--accent);
  border-radius: var(--radius-pill);
  transition: width var(--dur-base) var(--ease-out);
}
.stage--failed .task-fill {
  background: var(--danger);
}
.dlg-err {
  margin: 0;
  font-size: var(--fs-sm);
  color: var(--danger);
  overflow-wrap: anywhere;
}
.dlg-foot {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}
.dlg-foot-info {
  flex: 1;
  display: flex;
  gap: var(--space-3);
  font-size: var(--fs-xs);
  color: var(--accent);
  font-variant-numeric: tabular-nums;
}
.dlg-btn {
  padding: var(--space-2) var(--space-5);
  background: var(--surface-3);
  border: 1px solid var(--card-border);
  border-radius: var(--radius-md);
  box-shadow: var(--inset-bottom);
  color: var(--text-primary);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease-out);
}
.dlg-btn:hover {
  background: var(--surface-4);
}
@keyframes stage-pulse {
  50% {
    opacity: 0.35;
  }
}
</style>
