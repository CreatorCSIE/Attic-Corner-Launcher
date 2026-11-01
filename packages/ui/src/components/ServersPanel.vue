<script setup lang="ts">
/**
 * 服务器页 —— 社区服务器列表（启动+进服动作页，全部复用既有 IPC 通道）。
 * 页面级状态 = 加载/错误+重试/空态，列表形态 = 顶部分类切换 + 卡片流。
 * 卡片点击 → AppDialog 确认弹窗：
 *   INSTANCES_SET_VERSION 写回目标版本 → LAUNCH({versionId, instanceId, server}) → 关窗；
 *   启动失败错误在弹窗内可见呈现，不静默。
 * matchedVersionId 缺省（宿主匹配未命中）→ 卡片弱提示 + 弹窗内版本下拉（数据源 = useVersions 清单）。
 * compatibleVersionIds 非空（宿主协议派生的兼容全集）→ 目标版本区直接出下拉，
 * 预选 = matched ?? 集合末项，用户改选即换启动目标。
 * Online Mode 服 × 当前离线账户 → 弹窗内警告行（账户切换由用户自理，不做跳转）。
 */
import { computed, ref } from 'vue';
import type { ModInstallRequest, ServerCategory, ServerListView } from '@attic/core-spec';
import { useServers } from '../composables/useServers';
import { useBridge } from '../composables/useBridge';
import { useI18n } from '../i18n';
import { useVersions } from '../composables/useVersions';
import { useInstances } from '../composables/useInstances';
import { useAccounts } from '../composables/useAccounts';
import { useSettings } from '../composables/useSettings';
import { useGame } from '../composables/useGame';
import AppDialog from './AppDialog.vue';
import AppSelect, { type SelectOption } from './AppSelect.vue';
// 无图标兜底图 = 仓内占位图 unknown_pack.png，随 UI 打包。
import unknownPackImg from '../assets/unknown-pack.png';

const { t } = useI18n();
const { bridge } = useBridge();
const { servers, loading, error, load, retry } = useServers();
const { versions } = useVersions();
const { activeName, setVersion } = useInstances();
const { current } = useAccounts();
const { settings } = useSettings();
const { busy, lastError, launch } = useGame();

// —— 顶部分类切换（All + 上游五段） ——
const CATEGORIES: (ServerCategory | 'all')[] = ['all', 'classic', 'indev', 'alpha', 'beta', 'release'];
const category = ref<ServerCategory | 'all'>('all');
const filtered = computed(() =>
  category.value === 'all' ? servers.value : servers.value.filter((s) => s.category === category.value),
);

// —— 图标回落：加载失败/缺席 → 仓内兜底图 unknown_pack ——
const iconFailed = ref<Record<string, boolean>>({});

// —— 确认弹窗 ——
const dialogServer = ref<ServerListView | null>(null);
/** 手动选版本（无兼容集合且 matchedVersionId 缺省时的全清单下拉值）。 */
const manualVersion = ref('');
/** 兼容集合下拉的当前选择（openDialog 时按预选规则初始化）。 */
const pickedVersion = ref('');
const launchError = ref<string | null>(null);
const confirming = ref(false);

// 下拉只显 id：别名/displayName 不进本弹窗，选的就是启动目标 id。
const versionOptions = computed<SelectOption[]>(() =>
  versions.value.map((v) => ({ value: v.id, label: v.id })),
);

/** 兼容全集非空 = 弹窗出兼容版本下拉。 */
const compatibleIds = computed(() => dialogServer.value?.compatibleVersionIds ?? []);
const compatibleOptions = computed<SelectOption[]>(() =>
  compatibleIds.value.map((id) => ({ value: id, label: id })),
);

const targetVersion = computed(() => {
  const s = dialogServer.value;
  if (!s) return '';
  if (compatibleIds.value.length > 0) return pickedVersion.value;
  return s.matchedVersionId ?? manualVersion.value;
});

/** Online Mode 服 × 离线账户 = 正版验证不满足（弹窗警告行）。 */
const onlineModeMismatch = computed(
  () => !!dialogServer.value?.onlineMode && current.value?.type === 'offline',
);

/** 兼容区间下拉中是否正停在 custom matched 位（弹窗知情提示只在选中它时亮）。 */
const customHintVisible = computed(
  () =>
    !!dialogServer.value?.matchedVersionIsCustom &&
    targetVersion.value !== '' &&
    targetVersion.value === dialogServer.value?.matchedVersionId,
);

function openDialog(s: ServerListView): void {
  dialogServer.value = s;
  manualVersion.value = '';
  // 预选规则：matched 在集合中则选它（宿主保证追加），否则集合末项。
  const ids = s.compatibleVersionIds ?? [];
  pickedVersion.value =
    ids.length > 0 ? (s.matchedVersionId && ids.includes(s.matchedVersionId) ? s.matchedVersionId : (ids[ids.length - 1] ?? '')) : '';
  launchError.value = null;
}

function closeDialog(): void {
  // 在途启动不可打断（AppDialog dismissible=false 同口径，Esc/遮罩已被掐断）
  if (confirming.value) return;
  dialogServer.value = null;
}

/**
 * 确认编排：
 * ① mod 轨命中且本地未入库（宿主投 matchedModInfoUrl = 远端仓库 .info 直链）→ 先 installMod
 *   自动入库（失败可见呈现并中止，不静默）；
 * ② 目标版本写回激活实例（await 保序）；
 * ③ LAUNCH 一次性 server 直连（不写实例档案）；
 * ④ 成功关窗，失败错误留弹窗可见（useGame.launch 已记 lastError）。
 */
async function confirmJoin(): Promise<void> {
  const s = dialogServer.value;
  const v = targetVersion.value;
  if (!s || !v || confirming.value || busy.value) return;
  confirming.value = true;
  launchError.value = null;
  // 自动入库判据 = 目录成员判断（非版本比较）：
  // 只在停在宿主 matched 位 + 仓库直链在场 + 本地清单无此 id 时触发；用户改选其他版本不装。
  if (
    s.matchedVersionIsCustom &&
    s.matchedModInfoUrl &&
    v === s.matchedVersionId &&
    !versions.value.some((x) => x.id === v)
  ) {
    // 现场构造纯对象（结构化克隆不认 Vue reactive Proxy）
    const request: ModInstallRequest = { fullName: v, infoFileUrl: s.matchedModInfoUrl, autoupdate: true };
    const res = await bridge.installMod(request);
    if (!res.ok) {
      confirming.value = false;
      launchError.value = res.error;
      return;
    }
  }
  await setVersion(activeName.value || null, v);
  const ok = await launch({
    versionId: v,
    instanceId: activeName.value || undefined,
    accountId: current.value?.id,
    javaPath: settings.value.javaPath,
    maxMemoryMb: settings.value.maxMemoryMb,
    server: `${s.address}:${s.port}`,
  });
  confirming.value = false;
  if (ok) {
    dialogServer.value = null;
    return;
  }
  launchError.value = lastError.value ?? t('launch.failed');
}
</script>

<template>
  <section class="servers-page">
    <header class="page-head">
      <h2 class="page-title">{{ t('servers.title') }}</h2>
      <button class="import-btn" type="button" :disabled="loading" @click="load">
        <!-- lucide: refresh-cw -->
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
          <path d="M21 3v5h-5" />
          <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
          <path d="M8 16H3v5" />
        </svg>
        <span>{{ t('servers.refresh') }}</span>
      </button>
    </header>

    <div class="cat-tabs" role="tablist" :aria-label="t('servers.title')">
      <button
        v-for="c in CATEGORIES"
        :key="c"
        class="cat-tab"
        :class="{ 'cat-tab--active': category === c }"
        type="button"
        role="tab"
        :aria-selected="category === c"
        @click="category = c"
      >
        {{ t(`servers.category.${c}`) }}
      </button>
    </div>

    <div class="detail">
      <div v-if="loading && servers.length === 0" class="empty">
        <p class="state-hint">{{ t('common.loading') }}</p>
      </div>

      <div v-else-if="error" class="empty">
        <div class="error-state">
          <p class="state-hint error-text">{{ t('servers.loadError') }}：{{ error }}</p>
          <button class="retry" type="button" @click="retry">{{ t('servers.retry') }}</button>
        </div>
      </div>

      <div v-else-if="filtered.length === 0" class="empty">
        <p class="state-hint">{{ servers.length ? t('servers.noMatch') : t('servers.empty') }}</p>
      </div>

      <div v-else class="server-list">
        <button
          v-for="s in filtered"
          :key="s.id"
          class="server-card"
          type="button"
          @click="openDialog(s)"
        >
          <span class="sc-icon">
            <img
              v-if="s.iconUrl && !iconFailed[s.id]"
              :src="s.iconUrl"
              alt=""
              loading="lazy"
              @error="iconFailed[s.id] = true"
            />
            <img v-else :src="unknownPackImg" alt="" />
          </span>
          <span class="sc-body">
            <span class="sc-top">
              <span class="sc-name" :title="s.name">{{ s.name }}</span>
              <span class="badge badge--ver" :title="t('servers.preferredVersionHint', { version: s.preferredVersion })">{{ s.preferredVersion }}</span>
              <span v-if="s.onlineMode" class="badge badge--ok">{{ t('servers.onlineMode') }}</span>
              <span v-if="s.players" class="sc-players">({{ s.players.online }} / {{ s.players.max }})</span>
            </span>
            <span class="sc-desc">{{ s.description }}</span>
            <span v-if="!s.matchedVersionId && !s.compatibleVersionIds?.length" class="sc-need">{{ t('servers.needVersion') }}</span>
          </span>
        </button>
      </div>
    </div>

    <!-- 确认弹窗：服务器名/地址:端口/目标版本（匹配直显 or 手动下拉）/正版验证警告/启动失败可见呈现 -->
    <AppDialog :open="dialogServer !== null" :dismissible="!confirming" @close="closeDialog">
      <template v-if="dialogServer">
        <header class="dlg-head">
          <h2 class="dlg-title">{{ dialogServer.name }}</h2>
          <p class="dlg-addr mono">{{ dialogServer.address }}:{{ dialogServer.port }}</p>
        </header>

        <div class="dlg-ver">
          <p class="dlg-label">{{ t('servers.dialog.targetVersion') }}</p>
          <!-- 协议兼容全集非空 → 直接出下拉（预选 matched ?? 末项） -->
          <template v-if="compatibleIds.length > 0">
            <AppSelect
              v-model="pickedVersion"
              :options="compatibleOptions"
              :aria-label="t('servers.dialog.pickVersion')"
              :disabled="confirming"
            />
            <p v-if="customHintVisible" class="dlg-hint">{{ t('servers.dialog.customMatchHint') }}</p>
          </template>
          <template v-else-if="dialogServer.matchedVersionId">
            <p class="dlg-ver-val mono">{{ dialogServer.matchedVersionId }}</p>
            <p v-if="dialogServer.matchedVersionIsCustom" class="dlg-hint">{{ t('servers.dialog.customMatchHint') }}</p>
          </template>
          <template v-else>
            <p class="dlg-hint">{{ t('servers.dialog.manualHint') }}</p>
            <AppSelect
              v-model="manualVersion"
              :options="versionOptions"
              :aria-label="t('servers.dialog.pickVersion')"
              :disabled="confirming"
            />
          </template>
        </div>

        <p v-if="onlineModeMismatch" class="dlg-warn">{{ t('servers.dialog.onlineModeWarn') }}</p>

        <p v-if="launchError" class="dlg-err">
          {{ t('servers.dialog.launchFailed') }}：{{ launchError }}
        </p>

        <footer class="dlg-foot">
          <span class="dlg-spacer"></span>
          <button class="ghost" type="button" :disabled="confirming" @click="closeDialog">
            {{ t('servers.dialog.cancel') }}
          </button>
          <button
            class="primary"
            type="button"
            :disabled="!targetVersion || confirming || busy"
            @click="confirmJoin"
          >
            {{ confirming ? t('servers.dialog.launching') : t('servers.dialog.confirm') }}
          </button>
        </footer>
      </template>
    </AppDialog>
  </section>
</template>

<style scoped>
/* 页面骨架：内容列限宽浮中，状态区用页面级统一样式 */
.servers-page {
  display: flex;
  flex-direction: column;
  flex: 1;
  gap: var(--space-4);
  min-height: 0;
  padding: var(--space-5);
}
.page-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
}
.page-title {
  margin: 0;
  font-size: var(--fs-xl);
  font-weight: 700;
  color: var(--text-primary);
}
/* 刷新钮（accent 描边实心反色） */
.import-btn {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  background: var(--accent-soft);
  border: 1px solid var(--accent);
  border-radius: var(--radius-md);
  color: var(--accent);
  font-size: var(--fs-md);
  font-weight: 600;
  cursor: pointer;
  transition:
    background var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out);
}
.import-btn svg {
  flex: 0 0 16px;
  width: 16px;
  height: 16px;
}
.import-btn:hover:not(:disabled) {
  background: var(--accent);
  color: var(--accent-ink);
}
.import-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
/* —— 顶部分类切换（pill 行） —— */
.cat-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}
.cat-tab {
  padding: var(--space-1) var(--space-4);
  background: transparent;
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  color: var(--text-secondary);
  font-size: var(--fs-sm);
  font-weight: 600;
  cursor: pointer;
  transition:
    background var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out),
    border-color var(--dur-fast) var(--ease-out);
}
.cat-tab:hover {
  background: var(--surface-3);
  color: var(--text-primary);
}
.cat-tab--active {
  background: var(--accent-soft);
  border-color: var(--accent);
  color: var(--accent);
}
.detail {
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
  padding: var(--space-2) var(--space-3);
}
/* —— 卡片流（限宽浮中） —— */
.server-list {
  max-width: 620px;
  margin-inline: auto;
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
.server-card {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  width: 100%;
  padding: var(--space-4);
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  text-align: left;
  cursor: pointer;
  transition:
    background-color var(--dur-fast) var(--ease-out),
    border-color var(--dur-fast) var(--ease-out);
}
.server-card:hover {
  background-color: var(--surface-3);
  border-color: var(--border-strong);
}
.sc-icon {
  flex: 0 0 48px;
  width: 48px;
  height: 48px;
  border-radius: var(--radius-sm);
  overflow: hidden;
  background: var(--surface-3);
  box-shadow: var(--input-inset);
}
.sc-icon img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.sc-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
.sc-top {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2);
  min-width: 0;
}
.sc-name {
  font-size: var(--fs-md);
  font-weight: 600;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.badge {
  flex: 0 0 auto;
  padding: 2px var(--space-2);
  border-radius: var(--radius-pill);
  font-size: var(--fs-xs);
  font-weight: 600;
  white-space: nowrap;
}
.badge--ok {
  background: var(--ok-soft);
  color: var(--ok);
}
.badge--ver {
  background: var(--surface-3);
  color: var(--text-secondary);
  font-family: var(--font-mono);
}
.sc-players {
  flex: 0 0 auto;
  font-size: var(--fs-xs);
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}
/* 描述截断两行 */
.sc-desc {
  font-size: var(--fs-sm);
  color: var(--text-secondary);
  line-height: 1.5;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  overflow-wrap: anywhere;
}
/* matchedVersionId 缺省 = 弱提示（muted 小字，不抢视觉） */
.sc-need {
  font-size: var(--fs-xs);
  color: var(--text-muted);
}
/* —— 页面级状态（加载/错误/空） —— */
.empty {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
}
.state-hint {
  margin: 0;
  font-size: var(--fs-md);
  color: var(--text-secondary);
}
.error-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-3);
  max-width: 480px;
  text-align: center;
}
.error-text {
  color: var(--danger);
  overflow-wrap: anywhere;
}
.retry {
  padding: var(--space-2) var(--space-5);
  background: transparent;
  border: 1px solid var(--accent);
  border-radius: var(--radius-md);
  color: var(--accent);
  font-size: var(--fs-md);
  font-weight: 600;
  cursor: pointer;
  transition:
    background var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out);
}
.retry:hover {
  background: var(--accent);
  color: var(--accent-ink);
}
/* —— 确认弹窗内容（头/体/脚三段） —— */
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
  overflow-wrap: anywhere;
}
.dlg-addr {
  margin: 0;
  font-size: var(--fs-sm);
  color: var(--text-secondary);
  overflow-wrap: anywhere;
}
.dlg-ver {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.dlg-label {
  margin: 0;
  font-size: var(--fs-xs);
  letter-spacing: var(--tracking-label);
  text-transform: uppercase;
  color: var(--text-muted);
}
.dlg-ver-val {
  margin: 0;
  font-size: var(--fs-md);
  font-weight: 600;
  color: var(--text-primary);
  overflow-wrap: anywhere;
}
.dlg-hint {
  margin: 0;
  font-size: var(--fs-sm);
  color: var(--text-secondary);
}
.dlg-warn {
  margin: 0;
  padding: var(--space-2) var(--space-3);
  background: var(--warn-soft);
  border-radius: var(--radius-md);
  font-size: var(--fs-sm);
  color: var(--warn);
  line-height: 1.5;
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
.dlg-spacer {
  flex: 1;
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
.ghost:hover:not(:disabled) {
  background: var(--surface-4);
}
.ghost:disabled {
  opacity: 0.5;
  cursor: default;
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
    background var(--dur-fast) var(--ease-out),
    transform var(--dur-fast) var(--ease-out);
}
.primary:hover:not(:disabled) {
  background: var(--accent-hover);
}
.primary:active:not(:disabled) {
  transform: scale(0.97);
}
.primary:disabled {
  background: var(--surface-3);
  color: var(--text-muted);
  cursor: not-allowed;
}
</style>
