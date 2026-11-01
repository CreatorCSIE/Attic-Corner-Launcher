<script setup lang="ts">
/**
 * 更新结果弹窗 —— 全局挂 App 层：消费 useUpdateCheck 模块级单例的 dialogOpen/dialogResult，
 * 自动检查（打扰门裁决后弹）与手动检查（恒弹）共用。
 * update 分支 = 三钮框：忽略此版本（写单槽忽略账+关窗+红点熄灭）/ 取消（关窗，红点保留）/
 * 更新（openExternal 发布页——宿主白名单 attic:shell:open-url；浏览器 mock 直放 window.open）。
 * 其余分支（upToDate/unconfigured/error）= 单钮信息框，全可见呈现不静默。
 * notes 走 runtime markdown.ts 子集渲染（先转义后注入）；md 框内 <a>
 * 点击委托改走 openExternal——壳内禁渲染导航，target=_blank 不可信。
 */
import { computed } from 'vue';
import { renderMarkdown } from '@attic/runtime/markdown';
import { useI18n } from '../i18n';
import { useExternalLink } from '../composables/useExternalLink';
import { useUpdateCheck } from '../composables/useUpdateCheck';
import AppDialog from './AppDialog.vue';

const { t } = useI18n();
const { openExternal } = useExternalLink();
const { dialogOpen, dialogResult, closeDialog, ignoreCurrent } = useUpdateCheck();

/** 发布说明 md → HTML（仅 update 分支且有 notes 时非空）。 */
const notesHtml = computed(() => {
  const r = dialogResult.value;
  return r && r.status === 'update' && r.notes ? renderMarkdown(r.notes) : '';
});

/** 「更新」：开发布页 + 关窗；openExternal 失败经全局 ExternalLinkErrorDialog 呈现。 */
function openRelease(): void {
  const r = dialogResult.value;
  if (r && r.status === 'update' && r.url) openExternal(r.url);
  closeDialog();
}

/** md 框点击委托：命中 <a> 即拦截默认导航，改走宿主出门通道。 */
function onNotesClick(e: MouseEvent): void {
  const anchor = (e.target as HTMLElement).closest?.('a');
  const href = anchor?.getAttribute('href');
  if (href) {
    e.preventDefault();
    openExternal(href);
  }
}
</script>

<template>
  <AppDialog :open="dialogOpen" @close="closeDialog">
    <template v-if="dialogResult">
      <header class="upd-head">
        <!-- update 分支标题即「发现新版本 vX」，其余分支沿用「检查更新」题头 -->
        <h2 v-if="dialogResult.status === 'update'" class="upd-title">
          {{ t('settings.about.updateDialog.found', { version: dialogResult.version }) }}
        </h2>
        <h2 v-else class="upd-title">{{ t('settings.about.updateDialog.title') }}</h2>

        <p v-if="dialogResult.status === 'update' && dialogResult.publishedAt" class="upd-date">
          {{ t('settings.about.updateDialog.published', { date: dialogResult.publishedAt.slice(0, 10) }) }}
        </p>

        <!-- md 内容框：子集渲染，超高内滚（~50vh 封顶），链接点击委托出门 -->
        <div
          v-if="dialogResult.status === 'update' && notesHtml"
          class="upd-notes"
          @click="onNotesClick"
          v-html="notesHtml"
        />

        <p v-if="dialogResult.status === 'upToDate'" class="upd-body">
          {{ t('settings.about.updateDialog.upToDate', { version: dialogResult.current }) }}
        </p>
        <p v-else-if="dialogResult.status === 'unconfigured'" class="upd-body">
          {{ t('settings.about.updateDialog.unconfigured') }}
        </p>
        <p v-else-if="dialogResult.status === 'error'" class="upd-body upd-failed">
          {{ t('settings.about.updateDialog.failed', { message: dialogResult.message }) }}
        </p>

        <p v-if="dialogResult.status === 'update'" class="upd-hint">
          {{ t('settings.about.updateDialog.ignoreHint') }}
        </p>
      </header>

      <footer class="upd-foot">
        <template v-if="dialogResult.status === 'update'">
          <button class="ghost" type="button" @click="void ignoreCurrent()">
            {{ t('settings.about.updateDialog.ignore') }}
          </button>
          <button class="ghost" type="button" @click="closeDialog">
            {{ t('settings.about.updateDialog.cancel') }}
          </button>
          <button class="primary" type="button" @click="openRelease">
            {{ t('settings.about.updateDialog.update') }}
          </button>
        </template>
        <button v-else class="primary" type="button" @click="closeDialog">
          {{ t('settings.about.updateDialog.close') }}
        </button>
      </footer>
    </template>
  </AppDialog>
</template>

<style scoped>
.upd-head {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.upd-title {
  margin: 0;
  font-size: var(--fs-xl);
  font-weight: 700;
  color: var(--text-primary);
}
.upd-body {
  margin: 0;
  font-size: var(--fs-md);
  color: var(--text-secondary);
  overflow-wrap: anywhere;
}
.upd-failed {
  color: var(--danger);
}
.upd-date {
  margin: 0;
  font-size: var(--fs-xs);
  color: var(--text-muted);
}
.upd-hint {
  margin: 0;
  font-size: var(--fs-xs);
  color: var(--text-muted);
}
/* md 内容框：渲染器输出的固定容器（子集标记样式在此 :deep 落地，超高内滚 ~50vh 封顶） */
.upd-notes {
  padding: var(--space-3) var(--space-4);
  max-height: 50vh;
  overflow-y: auto;
  font-size: var(--fs-sm);
  line-height: 1.6;
  color: var(--text-secondary);
  background: var(--surface-1);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  overflow-wrap: anywhere;
}
.upd-notes :deep(h1),
.upd-notes :deep(h2),
.upd-notes :deep(h3),
.upd-notes :deep(h4) {
  margin: var(--space-3) 0 var(--space-2);
  color: var(--text-primary);
}
.upd-notes :deep(h1:first-child),
.upd-notes :deep(h2:first-child),
.upd-notes :deep(h3:first-child),
.upd-notes :deep(h4:first-child) {
  margin-top: 0;
}
.upd-notes :deep(p) {
  margin: 0 0 var(--space-2);
}
.upd-notes :deep(ul) {
  margin: 0 0 var(--space-2);
  padding-left: var(--space-5);
}
.upd-notes :deep(li) {
  margin: 2px 0;
}
.upd-notes :deep(code) {
  padding: 1px 5px;
  font-family: var(--font-mono);
  font-size: 0.92em;
  background: var(--surface-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}
.upd-notes :deep(pre) {
  margin: 0 0 var(--space-2);
  padding: var(--space-3);
  overflow-x: auto;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
}
.upd-notes :deep(pre code) {
  padding: 0;
  background: none;
  border: none;
}
.upd-notes :deep(a) {
  color: var(--accent);
  text-decoration: underline;
  cursor: pointer;
}
.upd-foot {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: var(--space-3);
}
.ghost {
  padding: var(--space-2) var(--space-5);
  background: var(--surface-3);
  border: 1px solid var(--card-border);
  border-radius: var(--radius-md);
  box-shadow: var(--inset-bottom);
  color: var(--text-primary);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease-out);
}
.ghost:hover {
  background: var(--surface-4);
}
.primary {
  padding: var(--space-2) var(--space-5);
  background: var(--accent);
  color: var(--accent-ink);
  border: none;
  border-radius: var(--radius-md);
  font-weight: 600;
  cursor: pointer;
  transition:
    filter var(--dur-fast) var(--ease-out),
    transform var(--dur-fast) var(--ease-out);
}
.primary:hover {
  filter: brightness(1.12);
}
.primary:active {
  transform: scale(0.97);
}
</style>
