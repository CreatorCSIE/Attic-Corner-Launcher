/**
 * useJava —— Java 探测全量报告（失败面板列全部候选与原因）。
 */

import { ref } from 'vue';
import type { JavaDetectionReport } from '@attic/core-spec';
import { useBridge } from './useBridge';

const report = ref<JavaDetectionReport | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);

const { bridge } = useBridge();

async function detect(): Promise<boolean> {
  loading.value = true;
  error.value = null;
  const res = await bridge.detectJava();
  if (res.ok) report.value = res.value;
  else error.value = res.error;
  loading.value = false;
  return res.ok;
}

export function useJava() {
  return { report, loading, error, detect };
}
