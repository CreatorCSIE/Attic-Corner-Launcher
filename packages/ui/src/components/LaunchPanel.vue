<script setup lang="ts">
/**
 * 启动面板 —— 每屏唯一 accent 实心元素 = Play（ui-design.md §2）。
 * 排版（新主页）：Play 置右下角；右侧「| ≡」菜单收纳【实例设置】【测试启动】。
 * 主页保持净空（用户指定）：无卡片底/版本摘要/停止钮，为后续背景图留清晰画布；
 * 选中版本信息由左下版本面板单卡承载。
 * v1 语义：每次启动成功自动唤起独立控制台窗口（MC 日志与主页解耦）。
 * 请求形状全走契约（LaunchRequest），UI 不拼参数（戒律 #1）。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { INSTANCE_ADDONS, MULTIPLAYER_JOIN_LAUNCH_METHODS, parseServerAddress } from '@attic/core-spec';
import { useI18n } from '../i18n';
import { useSelection } from '../composables/useSelection';
import { useGame } from '../composables/useGame';
import { useSettings } from '../composables/useSettings';
import { useAccounts } from '../composables/useAccounts';
import { useBridge } from '../composables/useBridge';
import { useDownloads } from '../composables/useDownloads';
import { useInstances } from '../composables/useInstances';
import AppDialog from './AppDialog.vue';
import InstanceDock from './InstanceDock.vue';
import LaunchProgressDialog from './LaunchProgressDialog.vue';
import VersionSelector from './VersionSelector.vue';

const emit = defineEmits<{ (e: 'open-instances'): void }>();

const { t } = useI18n();
const { selected } = useSelection();
const { status, busy, lastError, launch, cancel, kill } = useGame();
const { settings } = useSettings();
const { current } = useAccounts();
const { bridge, hasBridge } = useBridge();
const { reset: resetDownloads } = useDownloads();
const { activeName, instances } = useInstances();

const running = computed(() => status.value.running);
/* 启动进度弹窗（HMCL 移植，plan.md §4）：doLaunch 无条件唤起，spawn 成功即关
 * （控制台窗承接后续）；失败/取消后留窗显示 ✗ 行与错误，用户点「关闭」退场。 */
const progressOpen = ref(false);
const canPlay = computed(() => hasBridge.value && !!selected.value && !!current.value && !running.value && !busy.value);
/* 启动/停止/取消三态一体（用户指定）：同一按钮按状态切换动作——
 * 空闲=启动，运行=停止，busy 未运行=取消（0.0.2 feat①：补全资产/下载期间不再纯禁用）。
 * 空闲态真正可用的前置 = 有效账户 + 已选版本（用户指定：UI 侧硬门禁，不靠宿主兜底报错）。 */
const canToggle = computed(
  () =>
    hasBridge.value &&
    (running.value || (busy.value ? !running.value : !!selected.value && !!current.value)),
);
/* 禁用原因提示（hover 标题）：缺哪个说哪个。 */
const playHint = computed(() => {
  if (running.value || busy.value || !hasBridge.value) return '';
  if (!current.value && !selected.value) return t('launch.hintNeedBoth');
  if (!current.value) return t('launch.hintNeedAccount');
  if (!selected.value) return t('launch.hintNeedVersion');
  return '';
});

// —— 「| ≡」菜单：点外部收起 ——
const menuOpen = ref(false);
const menuEl = ref<HTMLElement | null>(null);

function onDocClick(e: MouseEvent): void {
  if (!menuOpen.value) return;
  if (menuEl.value && !menuEl.value.contains(e.target as Node)) menuOpen.value = false;
}

onMounted(() => document.addEventListener('click', onDocClick, true));
onBeforeUnmount(() => document.removeEventListener('click', onDocClick, true));

// —— 「≡」菜单 addon 动作项（INSTANCE_ADDONS 中 uiSection='launchmenu' 目录驱动；当前仅 visualizer）——
// 可点前置 = 启动页选中版本的本地 client jar 含 probeClass 条目（每次开菜单重探测）+ 常规可启动（canPlay）；
// 点击 = 一次性带 `-Dlf.visualizer` 启动（LaunchRequest.visualizer，不写实例档案）。
// legacyfix 26.10 Release 已含 VisualizerPatch（生效条件满足，nightly 依赖废除）；档案 addons 仍可携带同 id = 常开语义。
const menuAddonDefs = INSTANCE_ADDONS.filter((d) => d.uiSection === 'launchmenu');
const probeResults = ref<Record<string, boolean>>({});

async function probeMenuAddons(): Promise<void> {
  const v = selected.value;
  if (!v) {
    probeResults.value = {};
    return;
  }
  const next = { ...probeResults.value };
  for (const def of menuAddonDefs) {
    if (!def.probeClass) continue;
    const res = await bridge.probeVersionClass(v.id, def.probeClass);
    next[def.id] = res.ok ? res.value : false;
  }
  probeResults.value = next;
}

function onMenuToggle(): void {
  menuOpen.value = !menuOpen.value;
  if (menuOpen.value) void probeMenuAddons();
}

/**
 * 启动编排：accountId = 当前账户（契约可选字段，缺省回落宿主首个账户）；
 * test=true 走测试启动（宿主落盘启动前后日志）；成功后唤起独立控制台窗（v1 语义）——
 * 普通启动受全局开关 consoleOnLaunch（缺省开）约束；测试启动属显式诊断，恒弹。
 * visualizer=true = 一次性带 -Dlf.visualizer 启动（「≡」菜单动作项，不写档案）。
 */
async function doLaunch(test: boolean, visualizer = false, server?: string): Promise<void> {
  const v = selected.value;
  if (!v) return;
  menuOpen.value = false;
  resetDownloads();
  progressOpen.value = true;
  const ok = await launch({
    versionId: v.id,
    // 激活实例（Play 左侧实例 dock 选择；未初始化时留空 = 宿主按契约回落 default instance）
    instanceId: activeName.value || undefined,
    accountId: current.value?.id,
    javaPath: settings.value.javaPath,
    maxMemoryMb: settings.value.maxMemoryMb,
    ...(test ? { testLaunch: true } : {}),
    ...(visualizer ? { visualizer: true } : {}),
    ...(server ? { server } : {}),
  });
  if (ok) progressOpen.value = false;
  if (ok && (test || settings.value.consoleOnLaunch !== false)) void bridge.openConsoleWindow();
}

/** 弹窗取消（钮 + Esc/遮罩 busy 态同语义，HMCL onEscPressed）：取消启动并关窗
 * （HMCL 同款 onCancel = cancel+close；失败详情仍落面板 lastError 横幅）。 */
function onProgressCancel(): void {
  void cancel();
  progressOpen.value = false;
}

// —— 直连询问弹窗（Play 前置，MVP）：激活实例档案 server 非空必拦；server 缺省时，选中版本
// launchMethod 命中 MULTIPLAYER_JOIN_LAUNCH_METHODS（经典多人数据表，戒律 #1）仍拦 = 弹窗现场
// 填地址一次性直连（不写档案）。测试启动/可视化器属诊断与特殊动作路径不打扰。
// 关窗（Esc/遮罩）= 放弃本次启动（询问语义：不选就不启动）。
const serverPrompt = ref(false);
const activeServer = computed(
  () => instances.value.find((i) => i.name === activeName.value)?.server?.trim() ?? '',
);
// 缺省触发面探测：launchMethod 只在 VersionJson.betacraft 上（VersionRef 轻量形状无此字段），
// 按版本 id 缓存探测结果（本地 json 读，失败 = 否，不拦正常启动）。
const mpJoinCapable = ref(false);
const mpJoinCache = new Map<string, boolean>();
watch(
  () => selected.value?.id,
  (id) => {
    if (!id) {
      mpJoinCapable.value = false;
      return;
    }
    const hit = mpJoinCache.get(id);
    if (hit !== undefined) {
      mpJoinCapable.value = hit;
      return;
    }
    void bridge.getVersionJson(id).then((res) => {
      const ok = res.ok && MULTIPLAYER_JOIN_LAUNCH_METHODS.includes(res.value.betacraft?.launchMethod ?? '');
      mpJoinCache.set(id, ok);
      // 竞态护栏：回包时选中已换 = 只留缓存不落地
      if (selected.value?.id === id) mpJoinCapable.value = ok;
    });
  },
  { immediate: true },
);
// 弹窗内现场填地址（仅 server 缺省的手动模式生效）：地址/端口双框，与档案单串同构拼接
const promptHost = ref('');
const promptPort = ref('');
const promptAddr = computed(() => {
  const host = promptHost.value.trim();
  const port = promptPort.value.trim();
  return host ? (port ? `${host}:${port}` : host) : '';
});
const promptValid = computed(() => promptAddr.value !== '' && parseServerAddress(promptAddr.value) !== null);

function requestNormalLaunch(): void {
  if (activeServer.value || mpJoinCapable.value) {
    promptHost.value = '';
    promptPort.value = '';
    serverPrompt.value = true;
    return;
  }
  void doLaunch(false);
}

function onLaunchDirect(): void {
  if (!activeServer.value && !promptValid.value) return;
  serverPrompt.value = false;
  void doLaunch(false, false, activeServer.value || promptAddr.value);
}

function onLaunchSingle(): void {
  serverPrompt.value = false;
  void doLaunch(false);
}

function onToggle(): void {
  if (running.value) kill();
  else if (busy.value) void cancel();
  else void requestNormalLaunch();
}

function onTestLaunch(): void {
  void doLaunch(true);
}

function onVisualizerLaunch(): void {
  void doLaunch(false, true);
}

function onInstanceSettings(): void {
  menuOpen.value = false;
  emit('open-instances');
}


</script>

<template>
  <section class="panel">
    <p v-if="lastError" class="error">{{ t('launch.failed') }}：{{ lastError }}</p>
    <p v-else-if="status.lastError" class="error">{{ status.lastError }}</p>

    <!-- 动作行：Play+菜单沉底靠右；实例 dock（用户指定）置于 Play 左侧，
         与版本 dock 同款交互，展开向上浮出、不吃布局空间。
         版本 dock 也在此行（margin-right:auto 钉左缘）：两 dock 同 flex 流互斥收缩，
         窄窗下不再重叠（曾因 stage-dock 绝对定位与实例 dock 互不感知而压盖）。 -->
    <div class="actions">
      <VersionSelector class="dock-version" />
      <InstanceDock class="dock-instance" />
      <button
        class="play"
        :class="{ 'play--stop': running, 'play--cancel': busy && !running }"
        :disabled="!canToggle"
        :title="playHint || undefined"
        @click="onToggle"
      >
        <span v-if="running || busy" class="sq" aria-hidden="true"></span>
        <span v-else class="tri" aria-hidden="true"></span>
        {{ running ? t('launch.kill') : busy ? t('launch.cancel') : t('launch.play') }}
      </button>
      <div ref="menuEl" class="menu-wrap">
        <span class="divider" aria-hidden="true"></span>
        <button
          class="menu-btn"
          type="button"
          :aria-label="t('launch.menu')"
          :title="t('launch.menu')"
          :aria-expanded="menuOpen"
          @click="onMenuToggle"
        >
          <!-- lucide: align-left（≡） -->
          <svg
            viewBox="0 0 24 24"
            width="18"
            height="18"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            aria-hidden="true"
          >
            <path d="M15 12H3" />
            <path d="M17 6H3" />
            <path d="M21 18H3" />
          </svg>
        </button>
        <div v-if="menuOpen" class="menu-pop" role="menu">
          <button class="menu-item" type="button" role="menuitem" @click="onInstanceSettings">
            {{ t('launch.instanceSettings') }}
          </button>
          <button
            class="menu-item"
            type="button"
            role="menuitem"
            :disabled="!canPlay"
            @click="onTestLaunch"
          >
            {{ t('launch.testLaunch') }}
          </button>
          <!-- addon 动作项（目录驱动）：jar 探测不含 probeClass 或不可启动 = 禁用；点击 = 一次性带 -Dlf.visualizer 启动 -->
          <button
            v-for="def in menuAddonDefs"
            :key="def.id"
            class="menu-item"
            type="button"
            role="menuitem"
            :disabled="!canPlay || !probeResults[def.id]"
            :title="probeResults[def.id] ? t(`instance.addonList.${def.id}.desc`) : t('launch.visualizerOff')"
            @click="onVisualizerLaunch"
          >
            {{ t('launch.visualizerLaunch') }}
          </button>
        </div>
      </div>
    </div>

    <!-- 直连询问弹窗（AppDialog 壳，实例删除确认同款配方）：档案有地址 = 确认形态；
         缺省但版本命中经典多人表 = 手动形态（现场填地址，一次性、不写档案） -->
    <AppDialog :open="serverPrompt" @close="serverPrompt = false">
      <header class="prompt-head">
        <h2 class="prompt-title">{{ t('launch.serverDialog.title') }}</h2>
        <p v-if="activeServer" class="prompt-message">
          {{ t('launch.serverDialog.message', { server: activeServer }) }}
        </p>
        <template v-else>
          <p class="prompt-message">{{ t('launch.serverDialog.manualHint') }}</p>
          <div class="prompt-fields">
            <input
              v-model="promptHost"
              class="prompt-input mono"
              type="text"
              :placeholder="t('instance.server.placeholder')"
              @keydown.enter="onLaunchDirect"
            />
            <input
              v-model="promptPort"
              class="prompt-input prompt-input--port mono"
              type="text"
              inputmode="numeric"
              placeholder="25565"
              @keydown.enter="onLaunchDirect"
            />
          </div>
          <p v-if="promptHost.trim() !== '' && !promptValid" class="prompt-err">
            {{ t('instance.server.invalid') }}
          </p>
        </template>
      </header>
      <footer class="prompt-foot">
        <span class="prompt-spacer"></span>
        <!-- 显式取消（2026-11-01 用户拍板）：此前出路只有两个启动钮，「不启动了」没有途径 -->
        <button class="prompt-single" type="button" @click="serverPrompt = false">
          {{ t('launch.serverDialog.cancel') }}
        </button>
        <button class="prompt-single" type="button" @click="onLaunchSingle">
          {{ t('launch.serverDialog.single') }}
        </button>
        <button
          class="prompt-direct"
          type="button"
          :disabled="!activeServer && !promptValid"
          @click="onLaunchDirect"
        >
          {{ t('launch.serverDialog.direct') }}
        </button>
      </footer>
    </AppDialog>

    <!-- 启动进度弹窗（HMCL 移植）：doLaunch 无条件唤起；取代原右上聚合进度条 -->
    <LaunchProgressDialog
      :open="progressOpen"
      :busy="busy"
      :error="lastError"
      @cancel="onProgressCancel"
      @close="progressOpen = false"
    />
  </section>
</template>

<style scoped>
/* 净空容器（用户指定）：无卡片底/描边/投影，为后续背景图留清晰画布 */
.panel {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  flex: 1;
  min-height: 0;
  background: transparent;
}
/* 动作行：版本 dock 钉左缘，Play+菜单沉底靠右 */
.actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-3);
  margin-top: auto;
}
/* 版本 dock 推至行首左缘；两 dock 允许收缩到内容以下（内部 name 有 ellipsis 配方接住），
   窄窗时横向让位而不是互相压盖 */
.dock-version {
  margin-right: auto;
}
.dock-version,
.dock-instance {
  min-width: 0;
}
.play,
.menu-wrap {
  flex-shrink: 0;
}
/* Play —— 质感配方样板：pill 大圆角 + 五层叠影 + 顶部内高光 + hover 抬升 + active 下压 + focus 投影环（token 定义见 tokens.css） */
.play {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-6);
  background: var(--accent);
  color: var(--accent-ink);
  border: none;
  border-radius: var(--radius-pill);
  font-weight: 600;
  font-size: var(--fs-md);
  box-shadow: var(--btn-primary-shadow);
  transition:
    transform var(--dur-fast) var(--ease-out),
    background var(--dur-fast) var(--ease-out),
    box-shadow var(--dur-fast) var(--ease-out);
}
.play:hover:not(:disabled) {
  background: var(--accent-hover);
  transform: translateY(-1px);
  box-shadow: var(--btn-primary-hover-shadow);
}
.play:active:not(:disabled) {
  background: var(--accent-press);
  transform: translateY(0) scale(0.97);
  box-shadow: var(--btn-primary-active-shadow);
}
/* 投影式 focus 环（替代全局描边式，Modrinth ring-4 手法）；置后保证 hover 下环不被覆盖 */
.play:focus-visible {
  outline: none;
  box-shadow: var(--btn-primary-focus-shadow);
}
.play:disabled {
  opacity: 0.5;
  filter: grayscale(50%);
  box-shadow: none;
  cursor: not-allowed;
}
.tri {
  width: 0;
  height: 0;
  border-left: 8px solid var(--accent-ink);
  border-top: 5px solid transparent;
  border-bottom: 5px solid transparent;
}
/* 运行态：同一按钮切为停止（danger 底 + 方块图标），保持同一质感配方；
   busy 未运行态切为取消（feat①，同款 danger 视觉语言 = 「中断当前动作」） */
.play--stop,
.play--cancel {
  background: var(--danger);
}
.play--stop:hover:not(:disabled),
.play--cancel:hover:not(:disabled) {
  background: var(--danger);
}
.sq {
  width: 10px;
  height: 10px;
  border-radius: 2px;
  background: var(--accent-ink);
}
.error {
  font-size: var(--fs-sm);
  color: var(--danger);
}
/* —— 「| ≡」：竖分隔线 + 幽灵菜单钮；弹层向上右对齐（Play 在右下角，菜单在其右侧） —— */
.menu-wrap {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
}
.divider {
  width: 1px;
  height: var(--space-5);
  background: var(--border-strong);
}
.menu-btn {
  width: var(--rail-item-size);
  height: var(--rail-item-size);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  background: transparent;
  border: none;
  border-radius: var(--radius-md);
  color: var(--text-secondary);
  cursor: pointer;
  transition:
    background var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out);
}
.menu-btn:hover {
  background: var(--surface-4);
  color: var(--text-primary);
}
/* 背景图启用态（html[data-bg-image]，App.vue 同源条件）：≡ 按钮直接浮在暗图上，
   浅主题深图标不可读 → token 局部取暗主题亮值；悬停底不能用 surface-4
   （浅主题=羊皮纸，配亮字又糊），用半透暗 chip */
html[data-bg-image] .menu-btn {
  --text-primary: #e8e4dc;
  --text-secondary: #a8a296;
}
html[data-bg-image] .menu-btn:hover {
  background: rgba(22, 24, 28, 0.55);
}
.menu-pop {
  position: absolute;
  right: 0;
  bottom: calc(100% + var(--space-2));
  min-width: 160px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: var(--space-2);
  background: var(--card-bg);
  border: 1px solid var(--card-border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-3);
  z-index: 20;
}
.menu-item {
  padding: var(--space-2) var(--space-3);
  background: transparent;
  border: none;
  border-radius: var(--radius-sm);
  color: var(--text-primary);
  font-size: var(--fs-sm);
  text-align: left;
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease-out);
}
.menu-item:hover:not(:disabled) {
  background: var(--surface-4);
}
.menu-item:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
/* 直连询问弹窗（AppDialog 插槽内容，ConfirmDialog 三段式同配方） */
.prompt-head {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.prompt-title {
  margin: 0;
  font-size: var(--fs-xl);
  font-weight: 700;
  color: var(--text-primary);
}
.prompt-message {
  margin: 0;
  font-size: var(--fs-md);
  color: var(--text-secondary);
  overflow-wrap: anywhere;
}
.prompt-foot {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}
.prompt-spacer {
  flex: 1;
}
.prompt-single {
  padding: var(--space-2) var(--space-5);
  background: var(--surface-3);
  border: 1px solid var(--card-border);
  border-radius: var(--radius-md);
  box-shadow: var(--inset-bottom);
  color: var(--text-primary);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease-out);
}
.prompt-single:hover {
  background: var(--surface-4);
}
.prompt-direct {
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
.prompt-direct:hover {
  background: var(--accent-hover);
}
.prompt-direct:active {
  transform: scale(0.97);
}
.prompt-direct:disabled {
  background: var(--surface-3);
  color: var(--text-muted);
  cursor: not-allowed;
  transform: none;
}
/* 手动形态：地址/端口双框（输入质感对齐全局 .input 配方） */
.prompt-fields {
  display: flex;
  gap: var(--space-3);
}
.prompt-input {
  flex: 1;
  min-width: 0;
  padding: var(--space-3) var(--space-4);
  background: var(--surface-3);
  border: none;
  border-radius: var(--radius-md);
  box-shadow: var(--input-inset);
  color: var(--text-primary);
  transition:
    background-color var(--dur-fast) var(--ease-out),
    box-shadow var(--dur-fast) var(--ease-out);
}
.prompt-input:hover {
  background: var(--surface-4);
}
.prompt-input:focus-visible {
  outline: none;
  box-shadow: var(--input-focus-shadow);
}
.prompt-input--port {
  flex: 0 0 96px;
}
.prompt-err {
  margin: 0;
  font-size: var(--fs-xs);
  color: var(--danger);
}
</style>
