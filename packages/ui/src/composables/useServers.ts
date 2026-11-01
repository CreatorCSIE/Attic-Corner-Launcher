/**
 * useServers —— 社区服务器列表共享状态（对齐 useMods 范式：每次进页现拉 + 手动刷新，UI 零缓存）。
 * 桥面 listServers() 契约 = @attic/core-spec（SERVERS_LIST → IpcResult<ServerListView[]>）；
 * 桥接实装（mock/demo/tauri）由另一代理在途，本层做运行期存在性防御：
 * 方法缺席 = 落错误态可见失败（'no-bridge' 同纪律），不崩。
 */

import { ref } from 'vue';
import type { ServerListView } from '@attic/core-spec';
import { useBridge } from './useBridge';

const servers = ref<ServerListView[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
let started = false;

const { bridge } = useBridge();

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  const fn = bridge.listServers;
  if (!fn) {
    // 桥未实装 listServers（另一代理在途）：可见失败落错误态
    loading.value = false;
    error.value = 'no-bridge';
    return;
  }
  const res = await bridge.listServers();
  loading.value = false;
  if (res.ok) servers.value = res.value;
  else error.value = res.error;
}

function retry(): Promise<void> {
  return load();
}

export function useServers() {
  if (!started) {
    started = true;
    void load();
  }
  return { servers, loading, error, load, retry };
}
