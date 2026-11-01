/**
 * useMods —— Mods 仓库页共享状态（左 = Betacraft 单源卡；右 = 分类折页 + 安装）。
 * 模块级单例（对齐 useCustomVersions 范式）。列表每次进页现拉 + 手动刷新钮，UI 侧不做缓存——
 * runtime 本就无进程内列表缓存。
 * 安装语义 = 只落 .info：jar 与基座合成延迟到启动期（点 Play 才补全，页面文案提示）。
 */

import { computed, ref } from 'vue';
import type { ModCategoryView, ModEntryView, ModInstallRequest } from '@attic/core-spec';
import { useBridge } from './useBridge';
import { useExternalLink } from './useExternalLink';
import { useVersions } from './useVersions';

const categories = ref<ModCategoryView[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
const installError = ref<string | null>(null);
const installingId = ref<string | null>(null);
const query = ref('');
/** 分类折页展开态：多分类可同时展开；缺省全折叠。 */
const openMap = ref<Record<string, boolean>>({});

let started = false;
const { bridge } = useBridge();
const { openExternal } = useExternalLink();

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  const res = await bridge.listMods();
  loading.value = false;
  if (res.ok) categories.value = res.value;
  else error.value = res.error;
}

const modCount = computed(() => categories.value.reduce((n, c) => n + c.mods.length, 0));
const installedCount = computed(() =>
  categories.value.reduce((n, c) => n + c.mods.filter((m) => m.installed).length, 0),
);

/** 搜索过滤（fullName/version 子串，不区分大小写）；零命中分类不出现在右侧。 */
const filtered = computed<ModCategoryView[]>(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return categories.value;
  return categories.value
    .map((c) => ({
      ...c,
      mods: c.mods.filter((m) => `${m.fullName} ${m.version}`.toLowerCase().includes(q)),
    }))
    .filter((c) => c.mods.length > 0);
});

/** 搜索中命中分类强制展开（结果直达可见）；空查询回到用户手动折叠态。 */
function isOpen(name: string): boolean {
  if (query.value.trim() !== '') return true;
  return openMap.value[name] === true;
}

function toggle(name: string): void {
  openMap.value = { ...openMap.value, [name]: !openMap.value[name] };
}

/** 安装（下载 .info）；在途锁单钮防重复提交，成功后重拉列表翻转 installed 态。 */
async function install(mod: ModEntryView): Promise<void> {
  if (mod.installed || installingId.value !== null) return;
  installingId.value = mod.fullName;
  installError.value = null;
  // 现场构造纯对象（值全为原始类型）：结构化克隆不认 Vue reactive Proxy
  const request: ModInstallRequest = {
    fullName: mod.fullName,
    infoFileUrl: mod.infoFileUrl,
    autoupdate: mod.autoupdate,
  };
  const res = await bridge.installMod(request);
  if (!res.ok) {
    installingId.value = null;
    installError.value = res.error;
    return;
  }
  // 成功路径先重拉列表、后解锁：解锁早于 load() 完成会闪现「下载」态空窗
  // （installed 尚未翻转 + installingId 已清空 = 三态中间态回退，宿主下载耗时越长越明显）。
  await load();
  // .info 落位即进启动页版本列表本地组（repository:'local'）——与自定义版本页联动同构
  await useVersions().load();
  installingId.value = null;
}

function openWebsite(url: string): void {
  // 失败（无默认浏览器等）经 useExternalLink 全局弹窗显式报错（不静默）
  openExternal(url);
}

export function useMods() {
  if (!started) {
    started = true;
    void load();
  }
  return {
    categories,
    filtered,
    loading,
    error,
    installError,
    installingId,
    query,
    modCount,
    installedCount,
    isOpen,
    toggle,
    load,
    install,
    openWebsite,
  };
}
