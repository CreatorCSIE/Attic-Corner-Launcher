/**
 * useVersions —— 版本清单共享状态（模块级单例，多处消费只拉一次）。
 * 年代分组属信息架构：数据来自清单 era 字段，客户端零推断。
 */

import { computed, ref, type ComputedRef } from 'vue';
import type { VersionEra, VersionRef } from '@attic/core-spec';
import { useBridge } from './useBridge';

/** 年代展示顺序（旧 → 新）。 */
const ERA_ORDER: (VersionEra | 'unknown')[] = [
  'pre-classic',
  'classic',
  '4k',
  'indev',
  'infdev',
  'alpha',
  'beta',
  'release-1.0-1.5.2',
  'unknown',
];

export interface EraGroup {
  era: VersionEra | 'unknown';
  items: VersionRef[];
}

const versions = ref<VersionRef[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
const search = ref('');
let started = false;

const { bridge } = useBridge();

/** 组内排序键：编译日期优先，回落发布日期，再回落 0（升序 = 旧在前）。 */
function sortKey(v: VersionRef): number {
  return v.compileDate ?? v.releaseDate ?? 0;
}

const filtered = computed<VersionRef[]>(() => {
  const q = search.value.trim().toLowerCase();
  if (!q) return versions.value;
  return versions.value.filter(
    (v) => v.id.toLowerCase().includes(q) || (v.displayName ?? '').toLowerCase().includes(q),
  );
});

const groups = computed<EraGroup[]>(() => {
  const buckets = new Map<VersionEra | 'unknown', VersionRef[]>();
  for (const v of filtered.value) {
    const era = v.era ?? 'unknown';
    const list = buckets.get(era);
    if (list) list.push(v);
    else buckets.set(era, [v]);
  }
  return ERA_ORDER.filter((era) => buckets.has(era)).map((era) => ({
    era,
    items: buckets.get(era)!.sort((a, b) => sortKey(a) - sortKey(b)),
  }));
});

const total = computed(() => filtered.value.length);

/** 在途请求共享：load/refresh 汇入同一次在途拉取。
 * 关键时序：启动即恢复 selectedId，首帧悬停展开时初始 load 可能尚未返回——
 * refresh 若直接跳过，展开定位会打在未渲染的列表上（静默失准，数据到达后也不补定位）。
 * join 保证 refresh resolve 时数据必已就绪。 */
let inflight: Promise<void> | null = null;

function fetchVersions(): Promise<void> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const res = await bridge.listVersions();
      if (res.ok) {
        versions.value = res.value;
        error.value = null;
      } else error.value = res.error;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

async function load(): Promise<void> {
  loading.value = true;
  await fetchVersions();
  loading.value = false;
}

/** 静默刷新：不翻动 loading 骨架，但汇入在途的初始 load（供面板每次展开重扫磁盘，
 * 保证运行期版本列表新鲜）。 */
async function refresh(): Promise<void> {
  await fetchVersions();
}

/** 首次访问时拉取，幂等。 */
function ensureLoaded(): void {
  if (started) return;
  started = true;
  void load();
}

export interface VersionsStore {
  versions: typeof versions;
  loading: typeof loading;
  error: typeof error;
  search: typeof search;
  filtered: ComputedRef<VersionRef[]>;
  groups: ComputedRef<EraGroup[]>;
  total: ComputedRef<number>;
  load: () => Promise<void>;
  refresh: () => Promise<void>;
  ensureLoaded: () => void;
}

export function useVersions(): VersionsStore {
  ensureLoaded();
  return { versions, loading, error, search, filtered, groups, total, load, refresh, ensureLoaded };
}
