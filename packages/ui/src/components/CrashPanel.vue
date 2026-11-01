<script setup lang="ts">
/**
 * CrashPanel —— 启动器层崩溃呈现（渲染现场 + 脏退出「上次崩溃」）。
 * 形态 = AppDialog 模态弹窗；排版：错误栈先行，再落三按钮
 * 【复制诊断信息】【打开日志文件夹】【去 GitHub 报告】+ 关闭。
 * 数据面：liveError = useCrash 现场（渲染层错误，宿主已静默落 launcher.log）；
 * lastCrash = SYS_INFO.lastCrash（上次启动脏退出标记消费，读后即删天然只弹一次，关闭仅本会话）。
 * 两态同卡分区共存（罕见同场）；遮罩/Esc = 收最前一区（现场优先，其次横幅）。
 * 三按钮动作：bundle 走 CRASH_BUNDLE（栈+环境+两日志尾）；复制 = 剪贴板；
 * 报告 = 先写剪贴板再 openExternal(issuesUrl)（repo 未配置 issuesUrl 空串 → 可见提示不静默）。
 * 只挂 App 主页分支（控制台窗不挂）；桥面 err（demo/无桥）归一化为动作行可见失败。
 */
import { computed, ref } from 'vue';
import type { CrashBrief } from '@attic/core-spec';
import { useI18n } from '../i18n';
import { useBridge } from '../composables/useBridge';
import { useCrash } from '../composables/useCrash';
import { useSysInfo } from '../composables/useSysInfo';
import { useExternalLink } from '../composables/useExternalLink';
import AppDialog from './AppDialog.vue';

const { t } = useI18n();
const { bridge } = useBridge();
const { liveError, dismiss } = useCrash();
const { info } = useSysInfo();
const { openExternal } = useExternalLink();


/** 横幅关闭仅本会话：标记宿主侧读后即删，下次启动不会复现，无需持久化。 */
const lastDismissed = ref(false);
const copied = ref(false);
const actionError = ref('');
let copiedTimer: ReturnType<typeof setTimeout> | undefined;

interface Panel {
  key: string;
  title: string;
  brief: CrashBrief;
  close: () => void;
}

const panels = computed<Panel[]>(() => {
  const out: Panel[] = [];
  const last = info.value?.lastCrash;
  if (last && !lastDismissed.value) {
    out.push({ key: 'last', title: t('launcherCrash.lastTitle'), brief: last, close: () => (lastDismissed.value = true) });
  }
  if (liveError.value) {
    out.push({ key: 'live', title: t('launcherCrash.liveTitle'), brief: liveError.value, close: dismiss });
  }
  return out;
});

/** 遮罩/Esc：先收现场区（后挂 = 最前），其次横幅区。 */
function dismissTop(): void {
  if (liveError.value) dismiss();
  else lastDismissed.value = true;
}

function flashCopied(): void {
  copied.value = true;
  clearTimeout(copiedTimer);
  copiedTimer = setTimeout(() => (copied.value = false), 1500);
}

/** 拉诊断包（桥面 err 归一化为动作行可见失败，返回 null 表示不可用）。 */
async function fetchBundle(brief: CrashBrief): Promise<{ text: string; issuesUrl: string } | null> {
  actionError.value = '';
  const res = await bridge.getCrashBundle(brief.category, brief.stack);
  if (!res.ok) {
    actionError.value = res.error;
    return null;
  }
  return res.value;
}

async function copyDiag(brief: CrashBrief): Promise<void> {
  const bundle = await fetchBundle(brief);
  if (!bundle) return;
  try {
    await navigator.clipboard.writeText(bundle.text);
    flashCopied();
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : String(error);
  }
}

async function openLogs(): Promise<void> {
  actionError.value = '';
  const res = await bridge.openSpecialDir('logs-dir');
  if (!res.ok) actionError.value = res.error;
}

/** 报告：剪贴板先行（失败不拦出门），再开预填 issue 链接；repo 未配置 = 可见提示。 */
async function reportOnGithub(brief: CrashBrief): Promise<void> {
  const bundle = await fetchBundle(brief);
  if (!bundle) return;
  try {
    await navigator.clipboard.writeText(bundle.text);
  } catch {
    /* 剪贴板失败不拦出门 */
  }
  if (!bundle.issuesUrl) {
    actionError.value = t('launcherCrash.reportNoRepo');
    return;
  }
  openExternal(bundle.issuesUrl);
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}
</script>

<template>
  <AppDialog :open="panels.length > 0" @close="dismissTop">
    <section v-for="panel in panels" :key="panel.key" class="crash-block" role="alert">
      <header class="crash-head">
        <h3 class="crash-title">{{ panel.title }}</h3>
        <span class="crash-time">{{ formatTime(panel.brief.at) }}</span>
        <button class="crash-close" type="button" :aria-label="t('launcherCrash.dismiss')" @click="panel.close()">
          &times;
        </button>
      </header>

      <p class="crash-summary">{{ panel.brief.summary }}</p>

      <!-- 栈先行：超高内滚，等宽字体 -->
      <pre class="crash-stack">{{ panel.brief.stack || panel.brief.summary }}</pre>

      <footer class="crash-foot">
        <span v-if="actionError" class="crash-action-error">{{ actionError }}</span>
        <span v-else-if="copied" class="crash-copied">{{ t('launcherCrash.copied') }}</span>
        <button class="ghost" type="button" @click="void copyDiag(panel.brief)">
          {{ t('launcherCrash.copy') }}
        </button>
        <button class="ghost" type="button" @click="void openLogs()">
          {{ t('launcherCrash.openLogs') }}
        </button>
        <button class="primary" type="button" @click="void reportOnGithub(panel.brief)">
          {{ t('launcherCrash.report') }}
        </button>
      </footer>
    </section>
  </AppDialog>
</template>

<style scoped>
.crash-block {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.crash-head {
  display: flex;
  align-items: baseline;
  gap: var(--space-3);
}
.crash-title {
  margin: 0;
  font-size: var(--fs-lg);
  font-weight: 700;
  color: var(--danger);
}
.crash-time {
  font-size: var(--fs-xs);
  color: var(--text-muted);
}
.crash-close {
  margin-left: auto;
  padding: 0 var(--space-2);
  background: transparent;
  border: none;
  font-size: var(--fs-lg);
  line-height: 1;
  color: var(--text-secondary);
  cursor: pointer;
}
.crash-close:hover {
  color: var(--text-primary);
}
.crash-summary {
  margin: 0;
  font-size: var(--fs-sm);
  color: var(--text-primary);
  overflow-wrap: anywhere;
}
.crash-stack {
  margin: 0;
  padding: var(--space-2) var(--space-3);
  max-height: 180px;
  overflow: auto;
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  line-height: 1.5;
  color: var(--text-secondary);
  background: var(--surface-1);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.crash-foot {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: var(--space-3);
}
.crash-copied {
  margin-right: auto;
  font-size: var(--fs-xs);
  color: var(--text-muted);
}
.crash-action-error {
  margin-right: auto;
  font-size: var(--fs-xs);
  color: var(--danger);
  overflow-wrap: anywhere;
}
.ghost {
  padding: var(--space-1) var(--space-4);
  background: var(--surface-3);
  border: 1px solid var(--card-border);
  border-radius: var(--radius-md);
  box-shadow: var(--inset-bottom);
  color: var(--text-primary);
  font-size: var(--fs-sm);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease-out);
}
.ghost:hover {
  background: var(--surface-4);
}
.primary {
  padding: var(--space-1) var(--space-4);
  background: var(--accent);
  color: var(--accent-ink);
  border: none;
  border-radius: var(--radius-md);
  font-size: var(--fs-sm);
  font-weight: 600;
  cursor: pointer;
  transition: filter var(--dur-fast) var(--ease-out);
}
.primary:hover {
  filter: brightness(1.12);
}
</style>
