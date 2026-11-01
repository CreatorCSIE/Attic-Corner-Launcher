<script setup lang="ts">
/**
 * 设置页 · Java 栏：
 * 自动/手动双态 + 探测候选列表（每行版本/架构/路径，手动模式可点选）+ 刷新 + 原生对话框导入。
 * 模式无独立契约键：settings.javaPath 有值 = 手动、清空 = 自动（与装配链消费顺序一致）。
 * 增量：auto 探测无果时 Zulu 自动供给（启动期兜底，不占 UI）。
 */
import { computed, onMounted } from 'vue';
import { useI18n } from '../i18n';
import { useBridge } from '../composables/useBridge';
import { useSettings } from '../composables/useSettings';
import { useJava } from '../composables/useJava';
import AppSelect from './AppSelect.vue';
import type { JavaArchitecture, JavaDiscoverySource } from '@attic/core-spec';

const { t } = useI18n();
const { hasBridge, bridge } = useBridge();
const { settings, patch } = useSettings();
const { report, loading, error, detect } = useJava();

const isManual = computed(() => !!settings.value.javaPath);

const archLabel: Record<JavaArchitecture, string> = {
  x86_64: 'x64',
  x86: 'x86',
  arm64: 'arm64',
  arm: 'arm',
  unknown: '?',
};

function sourceLabel(s: JavaDiscoverySource): string {
  return t(`settings.java.source.${s}`);
}

/** 当前生效行高亮：手动 = javaPath 相等；自动 = 探测选中项。 */
function isSelected(executable: string): boolean {
  if (isManual.value) return settings.value.javaPath === executable;
  return report.value?.selection.install?.executable === executable;
}

async function setMode(manual: boolean): Promise<void> {
  if (manual) {
    // 自动 → 手动：把当前自动选中项固化为手动选择；无候选时不写空值（空 = 自动，会打回原形）
    const fixed = report.value?.selection.install?.executable;
    if (!fixed) return;
    await patch({ javaPath: fixed });
  } else {
    await patch({ javaPath: undefined });
  }
}

async function pickCandidate(executable: string): Promise<void> {
  if (!isManual.value) return; // 自动模式列表只读
  await patch({ javaPath: executable });
}

async function importJava(): Promise<void> {
  const res = await bridge.pickJavaExecutable();
  if (!res.ok || !res.value) return;
  await patch({ javaPath: res.value });
  void detect(); // 导入即复核：手动候选会出现在列表并给出真实版本
}

onMounted(() => {
  if (!report.value && !loading.value) void detect();
});
</script>

<template>
  <section class="pane">
    <h3 class="pane-title">{{ t('settings.sectionJava') }}</h3>

    <!-- 模式 + 动作行 -->
    <div class="toolbar">
      <AppSelect
        :model-value="isManual ? 'manual' : 'auto'"
        :options="[
          { value: 'auto', label: t('settings.java.auto') },
          { value: 'manual', label: t('settings.java.manual') },
        ]"
        :aria-label="t('settings.java.auto')"
        @update:model-value="setMode($event === 'manual')"
      />
      <div class="spacer"></div>
      <button class="mini" :disabled="loading" @click="detect()">
        {{ loading ? t('common.loading') : t('settings.java.refresh') }}
      </button>
      <button class="mini" :disabled="!hasBridge" @click="importJava()">{{ t('settings.java.import') }}</button>
    </div>

    <!-- 状态消息行（探测中/已选/未找到） -->
    <p v-if="error" class="err">{{ error }}</p>
    <p v-else-if="loading" class="muted">{{ t('common.loading') }}</p>
    <p v-else-if="report && !report.selection.install && !isManual" class="warn">
      {{ t('settings.java.noneDetected') }}
      <span class="reason">{{ report.selection.reason }}</span>
    </p>
    <p v-else-if="report?.selection.usedFallback && !isManual" class="warn">{{ t('settings.java.usedFallback') }}</p>
    <p v-else-if="report" class="status">
      <template v-if="isManual">
        {{ t('settings.java.manualCurrent') }}
        <code class="mono">{{ settings.javaPath }}</code>
      </template>
      <template v-else-if="report.selection.install">
        Java {{ report.selection.install.major }} · {{ archLabel[report.selection.install.architecture] }}
        <span class="reason">{{ report.selection.reason }}</span>
      </template>
    </p>

    <!-- 候选列表（每行：Java 版本 + raw · 架构 · 来源 / 路径；手动模式可点选） -->
    <div v-if="report" class="list-well">
      <button
        v-for="i in report.installs"
        :key="i.executable"
        class="cand"
        :class="{ 'cand--sel': isSelected(i.executable), 'cand--viewonly': !isManual }"
        :disabled="!isManual"
        :title="i.executable"
        @click="pickCandidate(i.executable)"
      >
        <span class="cand-top">
          <span class="cand-java">Java {{ i.major }}</span>
          <span class="cand-meta">{{ i.raw }} · {{ archLabel[i.architecture] }} · {{ sourceLabel(i.source) }}</span>
        </span>
        <span class="cand-path mono">{{ i.executable }}</span>
      </button>
      <p v-if="!report.installs.length" class="muted empty">{{ t('settings.java.noCandidates') }}</p>
    </div>
    <p v-if="report && !isManual" class="hint">{{ t('settings.java.autoLockHint') }}</p>

    <!-- 失败候选/诊断：折叠保留（探测面板增量） -->
    <details v-if="report && (report.failures.length || report.diagnostics.length)" class="more">
      <summary>{{ t('settings.java.probeDetails') }}</summary>
      <ul v-if="report.failures.length" class="rows">
        <li v-for="f in report.failures" :key="f.executable">
          <span class="mono">{{ f.executable }}</span>
          <span class="tag tag--err">{{ f.reason }}</span>
        </li>
      </ul>
      <ul v-if="report.diagnostics.length" class="rows muted">
        <li v-for="(d, idx) in report.diagnostics" :key="idx">{{ d }}</li>
      </ul>
    </details>
  </section>
</template>

<style scoped>
.pane {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}
.pane-title {
  margin: 0;
  font-size: var(--fs-lg);
  font-weight: 600;
}
.toolbar {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}
.spacer {
  flex: 1;
}
.mini {
  padding: var(--space-2) var(--space-4);
  background: transparent;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-md);
  font-size: var(--fs-sm);
  color: var(--text-primary);
  box-shadow: var(--inset-bottom);
  transition: background var(--dur-fast) var(--ease-out);
}
.mini:hover:not(:disabled) {
  background: var(--surface-4);
}
.mini:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.status {
  margin: 0;
  font-size: var(--fs-sm);
  color: var(--text-secondary);
}
.reason {
  margin-left: var(--space-2);
  font-size: var(--fs-xs);
  color: var(--text-muted);
}
.err {
  margin: 0;
  font-size: var(--fs-sm);
  color: var(--danger);
}
.warn {
  margin: 0;
  font-size: var(--fs-sm);
  color: var(--warn);
}
.muted {
  color: var(--text-muted);
}
.mono {
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
}
/* 候选列表：下沉井样式 */
.list-well {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: var(--space-2);
  background: var(--surface-1);
  border-radius: var(--radius-md);
  box-shadow: var(--input-inset);
}
.cand {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  width: 100%;
  padding: var(--space-2) var(--space-3);
  background: transparent;
  border: none;
  border-radius: var(--radius-sm);
  text-align: left;
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease-out);
}
.cand:hover:not(:disabled) {
  background: var(--surface-3);
}
.cand:disabled {
  cursor: default;
}
.cand--sel {
  background: var(--surface-3);
  box-shadow: inset 0 0 0 1px var(--accent);
}
.cand-top {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  width: 100%;
}
.cand-java {
  font-weight: 600;
  color: var(--text-primary);
}
.cand-meta {
  font-size: var(--fs-xs);
  color: var(--text-secondary);
}
.cand-path {
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}
.empty {
  margin: 0;
  padding: var(--space-2);
  font-size: var(--fs-sm);
}
.hint {
  margin: 0;
  font-size: var(--fs-xs);
  color: var(--text-muted);
}
.more {
  font-size: var(--fs-sm);
  color: var(--text-secondary);
}
.more summary {
  cursor: pointer;
}
.rows {
  list-style: none;
  margin: var(--space-2) 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: var(--fs-xs);
}
.rows li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}
.rows .mono {
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tag {
  color: var(--text-muted);
  flex: 0 0 auto;
}
.tag--err {
  color: var(--danger);
}
</style>
