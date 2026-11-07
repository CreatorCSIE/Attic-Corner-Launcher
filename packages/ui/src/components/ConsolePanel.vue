<script setup lang="ts">
/**
 * 控制台 —— stdout/stderr 滚动 + 崩溃摘要卡。
 * 订阅在 useConsole 模块级，切视图不丢日志。
 * 下载进度已迁至主页启动面板聚合区（BlockHelm 形态，见 useDownloads/LaunchPanel）。
 */
import { computed, nextTick, ref, watch } from 'vue';
import { useI18n } from '../i18n';
import { useConsole } from '../composables/useConsole';

const { t } = useI18n();
const { lines, lastExit, clear } = useConsole();

const autoscroll = ref(true);
const scroller = ref<HTMLElement | null>(null);

const crash = computed(() => lastExit.value?.crash ?? null);
/* 用户主动停止（点停止按钮/关游戏窗）且无崩溃签名：中性条 + 最后一行日志。
   崩溃签名在场 = 游戏先崩、停止只是收尸（僵尸清理）→ 红条优先。 */
const stopped = computed(() => !!lastExit.value?.stoppedByUser);
const lastLine = computed(() => {
  for (let i = lines.value.length - 1; i >= 0; i -= 1) {
    const text = lines.value[i]?.text.trim();
    if (text) return text;
  }
  return '';
});

watch(
  () => lines.value.length,
  async () => {
    if (!autoscroll.value) return;
    await nextTick();
    const el = scroller.value;
    if (el) el.scrollTop = el.scrollHeight;
  },
);
</script>

<template>
  <section class="console">
    <div class="bar">
      <span class="label">{{ t('console.title') }}</span>
      <div class="bar-actions">
        <label class="toggle">
          <input v-model="autoscroll" type="checkbox" />
          {{ t('console.autoscroll') }}
        </label>
        <button class="mini" @click="clear">{{ t('console.clear') }}</button>
      </div>
    </div>

    <div v-if="crash" class="crash">
      <span class="crash-cat">{{ t(`crash.${crash.category}`) }}</span>
      <span class="crash-head mono">{{ crash.headline }}</span>
    </div>
    <div v-else-if="stopped" class="stopped">
      <span class="stopped-cat">{{ t('console.stopped') }}</span>
      <span class="stopped-head mono">{{ lastLine }}</span>
    </div>

    <div ref="scroller" class="out">
      <p v-if="lines.length === 0" class="empty">{{ t('console.empty') }}</p>
      <pre
        v-for="l in lines"
        :key="l.seq"
        class="line"
        :class="l.stream === 'stderr' ? 'line--err' : 'line--out'"
        >{{ l.text }}</pre>
    </div>
  </section>
</template>

<style scoped>
/* base-card 统一配方：第3级底 + 第4级 surface 描边 + radius-lg + 弱投影 + padding 升档 */
.console {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  min-height: 0;
  height: 100%;
  padding: var(--space-5);
  background: var(--card-bg);
  border: 1px solid var(--card-border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-card);
}
.bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.bar .label {
  font-size: var(--fs-lg);
  font-weight: 600;
  color: var(--text-primary);
  letter-spacing: 0;
  text-transform: none;
}
.bar-actions {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}
.toggle {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  font-size: var(--fs-xs);
  color: var(--text-secondary);
}
.mini {
  padding: 2px var(--space-2);
  background: transparent;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font-size: var(--fs-xs);
  color: var(--text-secondary);
  transition: background var(--dur-fast) var(--ease-out);
}
.mini:hover {
  background: var(--surface-4);
}
.crash {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  background: var(--danger-soft);
  border: 1px solid var(--danger);
  border-radius: var(--radius-md);
}
/* 用户停止中性条：与崩溃条同构但走次级语义色，不带告警感。 */
.stopped {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  background: var(--surface-3);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
}
.stopped-cat {
  font-size: var(--fs-xs);
  font-weight: 600;
  color: var(--text-secondary);
  flex-shrink: 0;
}
.stopped-head {
  font-size: var(--fs-xs);
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.crash-cat {
  font-size: var(--fs-xs);
  font-weight: 600;
  color: var(--danger);
}
.crash-head {
  font-size: var(--fs-xs);
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 日志输出区 = 卡片上的下沉井：第1级底 + 底缘内阴影 */
.out {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--space-3);
  background: var(--surface-1);
  border-radius: var(--radius-md);
  box-shadow: var(--input-inset);
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  line-height: 1.45;
}
.empty {
  color: var(--text-muted);
  font-family: var(--font-sans);
}
.line {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
}
.line--out {
  color: var(--text-secondary);
}
.line--err {
  color: var(--danger);
}
</style>
