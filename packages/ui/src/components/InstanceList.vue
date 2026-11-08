<script setup lang="ts">
/**
 * 实例页 —— 双栏骨架：
 * 左 = SecondaryMenu 列（248px：实例行[名/版本子行/激活标记/hover 删除] + 底部「新建实例」），
 * 右 = 详情编辑列（目录/JVM 参数/Java 路径/窗口尺寸），限宽浮中。
 * 版本不在本页编辑：档案版本 = 上次启动版本（宿主回写），编辑态只读展示；
 * 新建实例默认取启动页当前选中版本（useSelection，与激活实例联动）。
 * 激活实例（启动页 dock 共享同一状态）与浏览选中分离：点行 = 浏览，「设为启动实例」= 激活。
 * 名字为档案主键：编辑态经铅笔内联改名（只迁档案、gameDir 不动）；
 * 删除走 ConfirmDialog（默认只删档案，勾选才连目录）。
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { DEFAULT_ADDONS, INSTANCE_ADDONS, type InstanceView } from '@attic/core-spec';
import { useI18n } from '../i18n';
import { useInstances } from '../composables/useInstances';
import { useSelection } from '../composables/useSelection';
import { useBridge } from '../composables/useBridge';
import { isDemo } from '../dev/demo';
import ConfirmDialog from './ConfirmDialog.vue';
import AppDialog from './AppDialog.vue';

const { t } = useI18n();
const { instances, loading, error, save, remove, rename, setAddons, openDir, activeName, setActive } = useInstances();
const { selectedId } = useSelection();
const { hasBridge } = useBridge();

// —— 浏览选中（本地态；creating = 新建模式，与选中互斥） ——
const selectedName = ref<string | null>(null);
const creating = ref(false);
const selected = computed(() => instances.value.find((i) => i.name === selectedName.value) ?? null);

// —— 编辑表单 ——
const gameDir = ref('');
const launchArgs = ref('');
const javaPath = ref('');
// 多人直连（Attic 扩展键，独立 card + 单开保存；空 = 未配置不询问）：
// UI 双框（地址/端口），档案单串 `ip[:port]`——保存拼接、载入拆解。
// 常量必须声明在 watch(immediate) 之前（const 无提升）：loadForm 同步引用，setup 期即执行。
const SERVER_RE = /^([^:/\s]+)(?::(\d{1,5}))?$/;
const SERVER_PORT_OK = (v: string): boolean => /^\d{1,5}$/.test(v) && Number(v) >= 1 && Number(v) <= 65535;
const serverHost = ref('');
const serverPort = ref('');
const width = ref<number | ''>(854);
const height = ref<number | ''>(480);
// 窗口标题自定义（Attic 扩展键 title；空 = 不携带 = 游戏自题）
const windowTitle = ref('');
// intelFix 缺键 = 开；forceUpdate（Attic 扩展键）缺省 = 关
const intelFix = ref(true);
const forceUpdate = ref(false);
const newName = ref('');
const saving = ref(false);
const savedFlash = ref(false);
let savedTimer: ReturnType<typeof setTimeout> | undefined;
const dirError = ref<string | null>(null);

// —— Addons（目录驱动：INSTANCE_ADDONS ↔ legacyfix -Dlf.* 开关；占位项禁用） ——
// uiSection 分区：'basic'=基本设置 card，缺省 'addons'=Addons card，'launchmenu'=启动页菜单（本页不渲染）。
const addonDefs = INSTANCE_ADDONS;
const sectionOf = (def: (typeof INSTANCE_ADDONS)[number]) => def.uiSection ?? 'addons';
const basicAddons = computed(() => addonDefs.filter((d) => sectionOf(d) === 'basic'));
const addonCardDefs = computed(() => addonDefs.filter((d) => sectionOf(d) === 'addons'));
const addonsSel = ref<string[]>([...DEFAULT_ADDONS]);

function toggleAddon(id: string): void {
  const i = addonsSel.value.indexOf(id);
  if (i >= 0) addonsSel.value.splice(i, 1);
  else addonsSel.value.push(id);
  // 有变动即落盘：窄通道单字段写（其余表单现值不带走，与保存钮互不干扰）。
  // 新建态例外——档案还不存在，勾选集随「保存」全档案首落；老档案无 addons 键时
  // 本次落盘把当前展示集（默认开集±1）显式化，与保存钮首保语义一致。
  if (!creating.value && selected.value) void setAddons(selectedName.value as string, [...addonsSel.value]);
}

/** 重名校验（仅新建态；编辑态名字锁定不会撞）。 */
const existsError = computed(
  () => creating.value && newName.value.trim() !== ''
    && instances.value.some((i) => i.name === newName.value.trim()),
);
const canSave = computed(() =>
  // demo 覆写桥的 saveInstance 本就回声 ok（本地 CRUD 可演练），hasBridge 只认真桥——
  // 演示模式放行保存/创建钮，排版演练不被禁用态挡住（真壳行为不变）。
  (hasBridge.value || isDemo()) &&
  !saving.value &&
  !existsError.value &&
  // 新建态版本 = 启动页当前选中版本（无选中则不可创建，去启动页选版本即可）
  (creating.value ? newName.value.trim() !== '' && !!selectedId.value : !!selected.value),
);

function loadForm(inst: InstanceView): void {
  gameDir.value = inst.gameDir ?? '';
  launchArgs.value = inst.launchArgs ?? '';
  javaPath.value = inst.javaPath ?? '';
  // 档案单串拆双框；解析失败 = 原样进地址框（校验会拦住直连保存，不让数据静默丢失）
  const sm = SERVER_RE.exec(inst.server?.trim() ?? '');
  serverHost.value = sm ? (sm[1] ?? '') : (inst.server ?? '');
  serverPort.value = sm?.[2] ?? '';
  width.value = inst.width ?? 854;
  height.value = inst.height ?? 480;
  windowTitle.value = inst.title ?? '';
  // 无 addons 键的老档案：展示按默认开集（与 legacyfix 缺省行为一致，保存时显式落键）
  addonsSel.value = inst.addons ? [...inst.addons] : [...DEFAULT_ADDONS];
  // 缺键语义：intelFix 缺省开、forceUpdate 缺省关
  intelFix.value = inst.intelFix !== false;
  forceUpdate.value = inst.forceUpdate === true;
  dirError.value = null;
  flashSaved(false);
}

// —— 改名（档案迁移、gameDir 不动）：内联编辑态 + 在途 + 宿主错误内联 ——
// 必须声明在 watch(immediate) 之前：其回调同步走 onSelect → cancelRename（const 无提升）
const renaming = ref(false);
const renameValue = ref('');
const renameBusy = ref(false);
const renameHostError = ref<string | null>(null);
const renameInput = ref<HTMLInputElement | null>(null);

/** 重名本地校验：非空、不同于原名、清单已占。 */
const renameDup = computed(() => {
  const next = renameValue.value.trim();
  return (
    renaming.value &&
    next !== '' &&
    next !== (selectedName.value ?? '') &&
    instances.value.some((i) => i.name === next)
  );
});
const canRename = computed(
  () =>
    hasBridge.value &&
    !renameBusy.value &&
    !renameDup.value &&
    renameValue.value.trim() !== '' &&
    renameValue.value.trim() !== (selectedName.value ?? ''),
);

function askRename(): void {
  if (!selectedName.value) return;
  renaming.value = true;
  renameValue.value = selectedName.value;
  renameHostError.value = null;
  // 全选原文本：直接输入即整体替换（IDE 改名惯例）
  void nextTick(() => renameInput.value?.select());
}

function cancelRename(): void {
  renaming.value = false;
  renameValue.value = '';
  renameHostError.value = null;
}

// 点击改名区域外 = 取消编辑（IDE 惯例）。mousedown capture 先于一切 click：
// 点行/点保存时改名先被丢弃，后续动作按旧名走，不产生半改状态。
const renameZone = ref<HTMLElement | null>(null);
function onDocMouseDown(e: MouseEvent): void {
  const zone = renameZone.value;
  if (zone && !zone.contains(e.target as Node)) cancelRename();
}
watch(renaming, (on) => {
  if (on) document.addEventListener('mousedown', onDocMouseDown, true);
  else document.removeEventListener('mousedown', onDocMouseDown, true);
});
onBeforeUnmount(() => document.removeEventListener('mousedown', onDocMouseDown, true));

async function confirmRename(): Promise<void> {
  const old = selectedName.value;
  const next = renameValue.value.trim();
  if (!old || !canRename.value) return;
  renameBusy.value = true;
  const err = await rename(old, next);
  renameBusy.value = false;
  if (err === null) {
    selectedName.value = next;
    cancelRename();
    flashSaved(true);
  } else {
    renameHostError.value = err;
  }
}

function onSelect(inst: InstanceView): void {
  creating.value = false;
  selectedName.value = inst.name;
  newName.value = '';
  cancelRename();
  loadForm(inst);
}

function onNew(): void {
  selectedName.value = null;
  creating.value = true;
  cancelRename();
  newName.value = '';
  gameDir.value = '';
  launchArgs.value = '';
  javaPath.value = '';
  serverHost.value = '';
  serverPort.value = '';
  width.value = 854;
  height.value = 480;
  windowTitle.value = '';
  addonsSel.value = [...DEFAULT_ADDONS];
  intelFix.value = true;
  forceUpdate.value = false;
  dirError.value = null;
  flashSaved(false);
}

/** 取消新建：关弹窗并恢复浏览选中（激活优先，其次首个——与 watch instances 同一回落口径）。 */
function cancelCreate(): void {
  creating.value = false;
  const fallback = instances.value.find((i) => i.name === activeName.value) ?? instances.value[0] ?? null;
  if (fallback) onSelect(fallback);
}

// 弹窗打开即聚焦名称框（v1 showInputDialog 的默认焦点语义）
const nameInputRef = ref<HTMLInputElement | null>(null);
watch(creating, (v) => {
  if (v) void nextTick(() => nameInputRef.value?.focus());
});

// 清单加载/变动后维持浏览选中：无选中 → 激活实例优先，其次首个；选中项被删 → 清空。
watch(
  instances,
  (list) => {
    if (creating.value) return;
    if (selectedName.value && list.some((i) => i.name === selectedName.value)) return;
    const fallback = list.find((i) => i.name === activeName.value) ?? list[0] ?? null;
    if (fallback) onSelect(fallback);
    else {
      selectedName.value = null;
      dirError.value = null;
    }
  },
  { immediate: true },
);

function flashSaved(on: boolean): void {
  savedFlash.value = on;
  clearTimeout(savedTimer);
  if (on) savedTimer = setTimeout(() => (savedFlash.value = false), 1500);
}

/** 当前表单态 → 全档案视图（基本设置保存与直连 card 保存共用——
 * 保存通道是整档案合并写回，任一钮都带走全部表单现值，互不误删）。 */
function currentView(): InstanceView {
  const inst: InstanceView = {
    name: creating.value ? newName.value.trim() : (selectedName.value as string),
    // 新建 = 启动页当前选中版本；编辑 = 档案版本不动（调整走启动页）
    version: creating.value ? (selectedId.value as string) : (selected.value as InstanceView).version,
    // addons 恒发送当前勾选集（保存即显式落键；老档案首保语义不变——默认开集=legacyfix 缺省）
    addons: [...addonsSel.value],
    // 双开关仅在偏离缺省时落键（intelFix 缺省开、forceUpdate 缺省关；缺键 = 宿主补默认）
    ...(intelFix.value ? {} : { intelFix: false }),
    ...(forceUpdate.value ? { forceUpdate: true } : {}),
  };
  if (gameDir.value.trim()) inst.gameDir = gameDir.value.trim();
  if (launchArgs.value.trim()) inst.launchArgs = launchArgs.value.trim();
  if (javaPath.value.trim()) inst.javaPath = javaPath.value.trim();
  // 直连双框 → 档案单串 `ip[:port]`（端口留空 = 不带冒号，拼装器注入缺省 25565）；
  // 地址空 = 不携带（宿主清空删键语义）。格式校验在 card 侧（canSaveServer），此处原样拼接
  const serverAddr = serverHost.value.trim();
  if (serverAddr) {
    const port = serverPort.value.trim();
    inst.server = port ? `${serverAddr}:${port}` : serverAddr;
  }
  const w = Number(width.value);
  const h = Number(height.value);
  if (Number.isFinite(w) && w > 0) inst.width = w;
  if (Number.isFinite(h) && h > 0) inst.height = h;
  // 窗口标题：trim 非空才落键（空 = 不携带 = 宿主清空删键，游戏自题）
  const titleVal = windowTitle.value.trim();
  if (titleVal) inst.title = titleVal;
  return inst;
}

async function onSave(): Promise<void> {
  if (!canSave.value) return;
  saving.value = true;
  const inst = currentView();
  const ok = await save(inst);
  saving.value = false;
  if (ok) {
    creating.value = false;
    selectedName.value = inst.name;
    newName.value = '';
    flashSaved(true);
  }
}

// —— 多人直连 card（单开保存）：格式校验 = 拼装器同源宽松版（host[:port]，端口 1-65535）；
// 空 = 未配置（保存即删键）；校验只拦 card 自己的保存钮，不拦基本设置保存（地址缺席由 trim 判定）。
// SERVER_RE / SERVER_PORT_OK 声明在上方 refs 区（watch(immediate) 需先声明，const 无提升）。
const savingServer = ref(false);
const serverSavedFlash = ref(false);
let serverSavedTimer: ReturnType<typeof setTimeout> | undefined;

const serverError = computed(() => {
  const host = serverHost.value.trim();
  const port = serverPort.value.trim();
  if (!host && !port) return false;
  // 只填端口没填地址 = 无效组合；地址框承载非法串（老档案解析失败原样回填）同样拦下
  if (!host || !SERVER_RE.test(port ? `${host}:${port}` : host)) return true;
  return port !== '' && !SERVER_PORT_OK(port);
});
const canSaveServer = computed(
  () => hasBridge.value && !savingServer.value && !serverError.value && !creating.value && !!selected.value,
);

async function onSaveServer(): Promise<void> {
  if (!canSaveServer.value) return;
  savingServer.value = true;
  const ok = await save(currentView());
  savingServer.value = false;
  if (ok) {
    serverSavedFlash.value = true;
    clearTimeout(serverSavedTimer);
    serverSavedTimer = setTimeout(() => (serverSavedFlash.value = false), 1500);
  }
}

function onActivate(): void {
  if (selectedName.value) setActive(selectedName.value);
}

async function onOpenDir(): Promise<void> {
  if (!selectedName.value) return;
  dirError.value = await openDir(selectedName.value);
}

// —— 删除确认（防误删）：目标 + 开关 + 在途态 + 可选连删目录 ——
const delOpen = ref(false);
const delTarget = ref<InstanceView | null>(null);
const deleting = ref(false);
// 默认不勾（保守语义 = 只删档案）；每次开弹窗复位，防上次选择串台
const delWithFiles = ref(false);

function askRemove(inst: InstanceView): void {
  delTarget.value = inst;
  delWithFiles.value = false;
  delOpen.value = true;
}

async function onConfirmRemove(): Promise<void> {
  if (!delTarget.value) return;
  deleting.value = true;
  const name = delTarget.value.name;
  const ok = await remove(name, delWithFiles.value);
  deleting.value = false;
  if (ok) {
    delOpen.value = false;
    if (selectedName.value === name) {
      selectedName.value = null;
      dirError.value = null;
    }
  }
}
</script>

<template>
  <section class="instances-page">
    <!-- 左栏：实例菜单（248px） -->
    <aside class="menu">
      <h2 class="menu-title">{{ t('nav.instances') }}</h2>

      <div v-if="loading" class="menu-state">{{ t('common.loading') }}</div>
      <div v-else-if="error" class="menu-state menu-state--err">{{ t('common.error') }}</div>
      <ul v-else class="menu-list">
        <li v-for="inst in instances" :key="inst.name" class="menu-row">
          <button
            class="menu-item"
            :class="{ 'menu-item--selected': !creating && selectedName === inst.name }"
            type="button"
            :title="inst.name"
            @click="onSelect(inst)"
          >
            <span class="mi-body">
              <!-- 名字让位、徽标免疫收缩（防 ellipsis 截徽标） -->
              <span class="mi-name">
                <span class="mi-text">{{ inst.name }}</span>
                <span v-if="activeName === inst.name" class="mi-active">{{ t('instance.active') }}</span>
              </span>
              <span class="mi-sub mono" :title="inst.version || t('instance.versionNone')">
                {{ inst.version || t('instance.versionNone') }}
              </span>
            </span>
          </button>
          <button
            class="mi-del"
            type="button"
            :disabled="!hasBridge"
            :title="t('instance.delete')"
            @click.stop="askRemove(inst)"
          >
            <!-- lucide: trash-2 -->
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 6h18" />
              <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
              <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
              <line x1="10" x2="10" y1="11" y2="17" />
              <line x1="14" x2="14" y1="11" y2="17" />
            </svg>
          </button>
        </li>
      </ul>

      <button class="menu-add" type="button" @click="onNew">
        <!-- lucide: plus -->
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M5 12h14" />
          <path d="M12 5v14" />
        </svg>
        <span>{{ t('instance.new') }}</span>
      </button>
    </aside>

    <!-- 右栏：详情编辑（限宽列在剩余空间浮中；无选中 = 一行居中文案） -->
    <div class="detail">
      <div v-if="creating || selected" class="info">
        <div class="head-row">
          <!-- 改名态：内联输入 + 确认/取消（Enter/Esc 同效；点击区域外 = 取消），名字是唯一可改的主键 -->
          <template v-if="renaming">
            <span ref="renameZone" class="rename-zone">
              <input
                ref="renameInput"
                v-model="renameValue"
                class="input rename-input"
                type="text"
                :disabled="renameBusy"
                @keyup.enter="confirmRename"
                @keyup.esc="cancelRename"
              />
              <button class="icon-btn" type="button" :disabled="!canRename" :title="t('common.confirm')" @click="confirmRename">
                <!-- lucide: check -->
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M20 6 9 17l-5-5" />
                </svg>
              </button>
              <button class="icon-btn" type="button" :title="t('common.cancel')" @click="cancelRename">
                <!-- lucide: x -->
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M18 6 6 18" />
                  <path d="m6 6 12 12" />
                </svg>
              </button>
            </span>
          </template>
          <template v-else>
            <h3 class="name">{{ creating ? t('instance.new') : selectedName }}</h3>
            <button
              v-if="!creating && selected"
              class="icon-btn"
              type="button"
              :disabled="!hasBridge"
              :title="t('instance.rename')"
              @click="askRename"
            >
              <!-- lucide: pencil -->
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
                <path d="m15 5 4 4" />
              </svg>
            </button>
          </template>
          <template v-if="!creating && selected && !renaming">
            <span v-if="activeName === selectedName" class="badge">{{ t('instance.active') }}</span>
            <span class="head-spacer" />
            <button
              v-if="activeName !== selectedName"
              class="ghost-btn"
              type="button"
              :title="t('instance.activateHint')"
              @click="onActivate"
            >
              <!-- lucide: play -->
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polygon points="6 3 20 12 6 21 6 3" />
              </svg>
              <span>{{ t('instance.activate') }}</span>
            </button>
            <button
              class="icon-btn"
              type="button"
              :disabled="!hasBridge"
              :title="t('instance.openDir')"
              @click="onOpenDir"
            >
              <!-- lucide: folder-open -->
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="m6 14 1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" />
              </svg>
            </button>
            <button
              class="icon-btn icon-btn--danger"
              type="button"
              :disabled="!hasBridge"
              :title="t('instance.delete')"
              @click="askRemove(selected)"
            >
              <!-- lucide: trash-2 -->
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M3 6h18" />
                <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                <line x1="10" x2="10" y1="11" y2="17" />
                <line x1="14" x2="14" y1="11" y2="17" />
              </svg>
            </button>
          </template>
        </div>

        <!-- 改名错误：本地重名优先，其次宿主显式失败（非法名/竞态重名等） -->
        <p v-if="renaming && renameDup" class="field-err">{{ t('instance.exists') }}</p>
        <p v-else-if="renaming && renameHostError" class="field-err">{{ renameHostError }}</p>

        <p v-if="!creating && selected" class="kind mono">
          {{ selected.version || t('instance.versionNone') }}
          <template v-if="selected.width && selected.height"> · {{ selected.width }}×{{ selected.height }}</template>
        </p>

        <!-- 编辑表单：新建态整体隐藏（新建走 AppDialog 弹窗，v1 语义） -->
        <form v-if="!creating" class="form card" @submit.prevent="onSave">
          <h4 class="card-title">{{ t('instance.basic') }}</h4>
          <!-- 版本不在本页展示：档案版本 = 上次启动版本（宿主回写），标题下 kind 行只读 -->
          <!-- 目录路径长（数据根/<实例名>），独占整行避免截断；JVM 参数顺延第二行 -->
          <div class="field field--full">
            <label class="label" for="inst-dir">{{ t('instance.gameDir') }}</label>
            <input id="inst-dir" v-model="gameDir" class="input" type="text" :placeholder="t('instance.gameDirPlaceholder')" />
          </div>
          <div class="field field--wide">
            <label class="label" for="inst-jvm">{{ t('instance.launchArgs') }}</label>
            <input id="inst-jvm" v-model="launchArgs" class="input" type="text" :placeholder="t('instance.launchArgsPlaceholder')" />
          </div>
          <!-- Java 路径与实例目录同为长路径字段，独占整行避免截断 -->
          <div class="field field--full">
            <label class="label" for="inst-java">{{ t('instance.javaPath') }}</label>
            <input id="inst-java" v-model="javaPath" class="input" type="text" :placeholder="t('instance.javaPathPlaceholder')" />
          </div>
          <div class="field field--num">
            <label class="label" for="inst-w">{{ t('instance.width') }}</label>
            <input id="inst-w" v-model.number="width" class="input" type="number" min="1" step="1" />
          </div>
          <div class="field field--num">
            <label class="label" for="inst-h">{{ t('instance.height') }}</label>
            <input id="inst-h" v-model.number="height" class="input" type="number" min="1" step="1" />
          </div>
          <div class="field field--wide">
            <label class="label" for="inst-title">{{ t('instance.windowTitle') }}</label>
            <input id="inst-title" v-model="windowTitle" class="input" type="text" :placeholder="t('instance.windowTitlePlaceholder')" />
          </div>
          <!-- 开关组：两开关（Intel 修复/强制更新）+ 高频 addon 四项。
               addon 项数据仍是 addonsSel 数组（-Dlf.* 注入链不动），仅渲染归属换到基本设置。 -->
          <div class="toggles">
            <div class="addon-row">
              <div class="addon-info">
                <span class="addon-name">{{ t('instance.intelFix.name') }}</span>
                <p class="addon-desc">{{ t('instance.intelFix.desc') }}</p>
              </div>
              <label class="switch">
                <input v-model="intelFix" type="checkbox" :disabled="!hasBridge" />
                <span class="track" />
              </label>
            </div>
            <div class="addon-row">
              <div class="addon-info">
                <span class="addon-name">{{ t('instance.forceUpdate.name') }}</span>
                <p class="addon-desc">{{ t('instance.forceUpdate.desc') }}</p>
              </div>
              <label class="switch">
                <input v-model="forceUpdate" type="checkbox" :disabled="!hasBridge" />
                <span class="track" />
              </label>
            </div>
            <div v-for="def in basicAddons" :key="def.id" class="addon-row">
              <div class="addon-info">
                <span class="addon-name">{{ t(`instance.addonList.${def.id}.name`) }}</span>
                <p class="addon-desc">{{ t(`instance.addonList.${def.id}.desc`) }}</p>
              </div>
              <label class="switch">
                <input
                  type="checkbox"
                  :checked="addonsSel.includes(def.id)"
                  :disabled="!hasBridge"
                  @change="toggleAddon(def.id)"
                />
                <span class="track" />
              </label>
            </div>
          </div>
          <div class="actions">
            <button class="primary" type="submit" :disabled="!canSave">
              {{ t('instance.saveChanges') }}
            </button>
            <span v-if="savedFlash" class="saved">{{ t('instance.saved') }}</span>
          </div>
          <p v-if="dirError" class="field-err">{{ dirError }}</p>
        </form>

        <!-- 多人直连（Attic 扩展键，单开 card + 单开保存）：非空 = 启动页 Play 前置
             「直连/单人」询问弹窗（一次性注入，不因启动改写本档案）；空 = 不询问。新建态不展示（先建档再配）。 -->
        <section v-if="!creating && selected" class="card server-card">
          <h4 class="card-title">{{ t('instance.server.title') }}</h4>
          <div class="server-fields">
            <div class="field field--wide">
              <label class="label" for="inst-server-host">{{ t('instance.server.label') }}</label>
              <input
                id="inst-server-host"
                v-model="serverHost"
                class="input mono"
                type="text"
                :placeholder="t('instance.server.placeholder')"
                :disabled="!hasBridge"
              />
            </div>
            <div class="field field--port">
              <label class="label" for="inst-server-port">{{ t('instance.server.portLabel') }}</label>
              <input
                id="inst-server-port"
                v-model="serverPort"
                class="input mono"
                type="text"
                inputmode="numeric"
                placeholder="25565"
                :disabled="!hasBridge"
              />
            </div>
          </div>
          <p class="addon-desc">{{ t('instance.server.desc') }}</p>
          <p v-if="serverError" class="field-err">{{ t('instance.server.invalid') }}</p>
          <div class="actions">
            <button class="primary" type="button" :disabled="!canSaveServer" @click="onSaveServer">
              {{ t('instance.server.save') }}
            </button>
            <span v-if="serverSavedFlash" class="saved">{{ t('instance.saved') }}</span>
          </div>
        </section>

        <!-- Addons 栏：目录驱动（INSTANCE_ADDONS 中 uiSection 缺省项）；已接入项开关映射 legacyfix -Dlf.*，占位项禁用。
             高频四项归基本设置 card、visualizer 归启动页「≡」菜单（uiSection 分区，数据模型不分家）。 -->
        <section class="card addons">
          <h4 class="card-title">{{ t('instance.addons') }}</h4>
          <div v-for="def in addonCardDefs" :key="def.id" class="addon-row">
            <div class="addon-info">
              <span class="addon-name">
                {{ t(`instance.addonList.${def.id}.name`) }}
              </span>
              <p class="addon-desc">{{ t(`instance.addonList.${def.id}.desc`) }}</p>
            </div>
            <label class="switch">
              <input
                type="checkbox"
                :checked="addonsSel.includes(def.id)"
                :disabled="!hasBridge"
                @change="toggleAddon(def.id)"
              />
              <span class="track" />
            </label>
          </div>
        </section>
      </div>

      <!-- 空态：无卡片容器，仅一行居中文案 -->
      <div v-else class="empty">
        <p class="state-hint">{{ instances.length === 0 ? t('instance.emptyHint') : t('instance.hint') }}</p>
      </div>
    </div>

    <!-- 新建实例弹窗（v1 语义 reference/betacraft-launcher InstanceList.java L49-50：
         showInputDialog 只问名称）——其余字段出厂默认（onNew 已铺），创建后即选中进编辑表单。 -->
    <AppDialog :open="creating" @close="cancelCreate">
      <h3 class="dlg-title">{{ t('instance.new') }}</h3>
      <form class="dlg-body" @submit.prevent="onSave">
        <label class="label" for="inst-name">{{ t('instance.name') }}</label>
        <input
          id="inst-name"
          ref="nameInputRef"
          v-model="newName"
          class="input"
          type="text"
          :placeholder="t('instance.namePlaceholder')"
        />
        <p v-if="existsError" class="field-err">{{ t('instance.exists') }}</p>
        <p class="create-hint">{{ t('instance.createHint') }}</p>
        <!-- 版本透明化：新建静默取启动页选中版本——明示所用版本；无选中时禁用原因可见 -->
        <p v-if="selectedId" class="dlg-version mono">{{ t('instance.createVersion', { version: selectedId }) }}</p>
        <p v-else class="field-err">{{ t('instance.createNoVersion') }}</p>
        <div class="actions">
          <button class="ghost" type="button" @click="cancelCreate">{{ t('common.cancel') }}</button>
          <button class="primary" type="submit" :disabled="!canSave">{{ t('instance.create') }}</button>
        </div>
      </form>
    </AppDialog>

    <!-- 删除确认（防误删）：默认只删档案；勾选才连实例目录一并删（护栏在宿主） -->
    <ConfirmDialog
      v-model:open="delOpen"
      :title="t('instance.deleteDialog.title')"
      :message="t('instance.deleteDialog.message', { name: delTarget?.name ?? '' })"
      :busy="deleting"
      @confirm="onConfirmRemove"
    >
      <label class="del-files">
        <input v-model="delWithFiles" type="checkbox" :disabled="deleting" />
        <span>{{ t('instance.deleteDialog.withFiles') }}</span>
      </label>
    </ConfirmDialog>
  </section>
</template>

<style scoped>
/* 双栏骨架：左列贴左 248px，详情列在剩余空间浮中。 */
.instances-page {
  display: flex;
  flex: 1;
  gap: var(--space-5);
  min-height: 0;
  padding: var(--space-5);
}
.menu {
  flex: 0 0 248px;
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding: var(--space-5) var(--space-4);
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-card);
  overflow-y: auto;
}
.menu-title {
  margin: 0 0 0 var(--space-2);
  font-size: var(--fs-xl);
  font-weight: 700;
  color: var(--text-primary);
}
.menu-state {
  font-size: var(--fs-sm);
  color: var(--text-muted);
  padding: var(--space-2);
}
.menu-state--err {
  color: var(--danger);
}
.menu-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
.menu-row {
  position: relative;
}
/* 列表项：名 + 版本子行；选中 = surface-3 底高亮 */
.menu-item {
  display: flex;
  align-items: center;
  width: 100%;
  padding: var(--space-2) var(--space-3);
  padding-right: 40px; /* 给 hover 删除钮让位 */
  background: transparent;
  border: none;
  border-radius: var(--radius-md);
  color: var(--text-primary);
  font-size: var(--fs-md);
  text-align: left;
  cursor: pointer;
  transition:
    background-color var(--dur-fast) var(--ease-out),
    box-shadow var(--dur-fast) var(--ease-out);
}
.menu-item:hover {
  background-color: var(--surface-3);
}
.menu-item--selected {
  background-color: var(--surface-3);
  box-shadow: inset 0 0 0 1px var(--surface-4);
}
.mi-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.mi-name {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}
/* ellipsis 只落在名字文本上（可让位内容），徽标不陪葬 */
.mi-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mi-sub {
  font-size: var(--fs-xs);
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 激活标记：行内小徽（与 dock 的激活语义同源；启动实例 = activeName 命中的行） */
.mi-active {
  flex-shrink: 0;
  padding: 1px 6px;
  font-size: 10px;
  font-weight: 600;
  color: var(--accent);
  background: var(--accent-soft);
  border-radius: var(--radius-pill);
}
/* 删除钮：hover 行时浮现 */
.mi-del {
  position: absolute;
  top: 50%;
  right: var(--space-2);
  transform: translateY(-50%);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  background: transparent;
  border: none;
  border-radius: var(--radius-sm);
  color: var(--danger);
  opacity: 0;
  pointer-events: none;
  cursor: pointer;
  transition:
    opacity var(--dur-fast) var(--ease-out),
    background var(--dur-fast) var(--ease-out);
}
.mi-del svg {
  width: 16px;
  height: 16px;
}
.menu-row:hover .mi-del {
  opacity: 1;
  pointer-events: auto;
}
.mi-del:hover {
  background: var(--danger-soft);
}
.mi-del:disabled {
  display: none;
}
.menu-add {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  width: 100%;
  padding: var(--space-2) var(--space-3);
  background: transparent;
  border: none;
  border-radius: var(--radius-md);
  color: var(--text-primary);
  font-size: var(--fs-md);
  text-align: left;
  cursor: pointer;
  transition: background-color var(--dur-fast) var(--ease-out);
}
.menu-add svg {
  flex: 0 0 24px;
  width: 24px;
  height: 24px;
}
.menu-add:hover {
  background-color: var(--surface-3);
}
/* —— 右栏：详情编辑列（限宽浮中） —— */
.detail {
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
  padding: var(--space-6) var(--space-3);
}
.info {
  /* 560→720：长 Java 路径（IDE jbr /  Program Files 系）不再截断，
     且 jvm+java、宽+高两两同行的余量更足（窄窗 resize 时不易挤成单列）。 */
  max-width: 720px;
  margin-inline: auto;
}
.head-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}
.name {
  margin: 0;
  min-width: 0;
  font-size: var(--fs-xl);
  font-weight: 700;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 改名输入区（input+确认/取消）：click-outside 命中测试的边界；吃 .input 质感 */
.rename-zone {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex: 1;
  min-width: 0;
}
.rename-input {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-xl);
  font-weight: 700;
}
.head-spacer {
  flex: 1;
}
.badge {
  padding: 2px 8px;
  font-size: var(--fs-xs);
  font-weight: 600;
  color: var(--accent);
  background: var(--accent-soft);
  border-radius: var(--radius-pill);
}
.ghost-btn {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-1) var(--space-3);
  background: transparent;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  color: var(--text-primary);
  font-size: var(--fs-sm);
  cursor: pointer;
  transition:
    background var(--dur-fast) var(--ease-out),
    border-color var(--dur-fast) var(--ease-out);
}
.ghost-btn svg {
  width: 14px;
  height: 14px;
}
.ghost-btn:hover {
  background: var(--surface-3);
  border-color: var(--accent);
}
.icon-btn {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  background: transparent;
  border: none;
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  cursor: pointer;
  transition:
    background var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out);
}
.icon-btn svg {
  width: 16px;
  height: 16px;
}
.icon-btn:hover {
  background: var(--surface-4);
  color: var(--text-primary);
}
.icon-btn:disabled {
  display: none;
}
.icon-btn--danger:hover {
  background: var(--danger-soft);
  color: var(--danger);
}
.kind {
  margin: var(--space-2) 0 0;
  font-size: var(--fs-sm);
  color: var(--text-secondary);
}
.form {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: var(--space-4);
  margin-top: var(--space-5);
}
.field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 180px;
}
.field--wide {
  flex: 1 1 260px;
}
.field--full {
  flex: 1 1 100%;
}
.field--num {
  min-width: 96px;
}
/* 基本设置内开关组：独占整行，行样式与 Addons card 共用（addon-row 配方） */
.toggles {
  flex: 1 1 100%;
}
.label {
  font-size: var(--fs-xs);
  color: var(--text-muted);
}
/* 输入控件 inset 质感（全局配方）：第3级底 + 底缘内阴影 + focus accent 环 */
.input {
  padding: var(--space-3) var(--space-4);
  background: var(--surface-3);
  border: none;
  border-radius: var(--radius-md);
  color: var(--text-primary);
  box-shadow: var(--input-inset);
  transition:
    background-color var(--dur-fast) var(--ease-out),
    box-shadow var(--dur-fast) var(--ease-out);
}
.input:hover {
  background: var(--surface-4);
}
.input:focus-visible {
  outline: none;
  box-shadow: var(--input-focus-shadow);
}
.actions {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex: 1 1 100%;
}
/* 新建弹窗（AppDialog 插槽内容）：标题 + 纵排表单体 + 取消钮 */
.dlg-title {
  margin: 0;
  font-size: var(--fs-lg);
  font-weight: 600;
  color: var(--text-primary);
}
.dlg-body {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.dlg-version {
  margin: 0;
  font-size: var(--fs-xs);
  color: var(--text-muted);
}
.ghost {
  padding: var(--space-2) var(--space-4);
  background: transparent;
  color: var(--text-secondary);
  border: 1px solid var(--card-border);
  border-radius: var(--radius-md);
  cursor: pointer;
}
.ghost:hover {
  color: var(--text-primary);
  border-color: var(--accent);
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
  opacity: 0.45;
  cursor: not-allowed;
}
.saved {
  font-size: var(--fs-xs);
  color: var(--ok);
}
.field-err {
  flex: 1 1 100%;
  margin: 0;
  font-size: var(--fs-xs);
  color: var(--danger);
}
/* 新建弹窗提示（v1 语义：只问名称，建完再配）——dlg-body gap 已管间距，无需外边距 */
.create-hint {
  flex: 1 1 100%;
  margin: 0;
  font-size: var(--fs-xs);
  color: var(--text-muted);
}
.mono {
  font-family: var(--font-mono);
}
/* 设置分组 card（基本设置/addons 共用外观，同 .menu 质感） */
.card {
  padding: var(--space-5);
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-card);
}
.card-title {
  margin: 0 0 var(--space-4);
  font-size: var(--fs-sm);
  font-weight: 700;
  letter-spacing: 0.05em;
  color: var(--text-muted);
  /* .form 是 flex-wrap 容器，标题作为 flex 子项只占内容宽——首字段（名称）会被挤上同一行；
     强制独占整行（块级容器 server-card/addons 内此属性无副作用） */
  flex: 1 1 100%;
}
/* 多人直连 card：本页卡距 = 各卡自带 margin-top（.form/.addons 同配方），新卡缺位即贴上一卡末端 */
.server-card {
  margin-top: var(--space-5);
}
/* 地址/端口双框：地址吃满、端口定宽（field--num 同档） */
.server-fields {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: var(--space-4);
}
.field--port {
  flex: 0 0 120px;
  min-width: 0;
}
.addons {
  margin-top: var(--space-5);
}
.addon-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  padding: var(--space-3) 0;
  border-bottom: 1px solid var(--border);
}
.addon-row:first-of-type {
  padding-top: 0;
}
.addon-row:last-child {
  padding-bottom: 0;
  border-bottom: none;
}
.addon-info {
  min-width: 0;
}
.addon-name {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-weight: 600;
  color: var(--text-primary);
}
.addon-desc {
  margin: 2px 0 0;
  font-size: var(--fs-xs);
  color: var(--text-muted);
}
/* iOS 式开关：checkbox 透明覆盖，track/thumb 纯 CSS */
.switch {
  position: relative;
  flex-shrink: 0;
  cursor: pointer;
}
.switch input {
  position: absolute;
  inset: 0;
  width: 36px;
  height: 20px;
  margin: 0;
  opacity: 0;
  cursor: pointer;
}
.switch input:disabled {
  cursor: default;
}
.track {
  position: relative;
  display: block;
  width: 36px;
  height: 20px;
  background: var(--border);
  border-radius: var(--radius-pill);
  transition: background 0.15s ease;
  pointer-events: none;
}
.track::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  background: var(--surface-1);
  border-radius: 50%;
  box-shadow: 0 1px 2px rgb(0 0 0 / 25%);
  transition: transform 0.15s ease;
}
.switch input:checked + .track {
  background: var(--accent);
}
.switch input:checked + .track::after {
  transform: translateX(16px);
}
.switch input:disabled + .track {
  opacity: 0.45;
}
/* 删除弹窗附加选项：连删目录复选框（danger 色调强调不可逆） */
.del-files {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--fs-sm);
  color: var(--text-secondary);
  cursor: pointer;
  user-select: none;
}
.del-files input {
  width: 15px;
  height: 15px;
  accent-color: var(--danger);
  cursor: pointer;
}
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
</style>
