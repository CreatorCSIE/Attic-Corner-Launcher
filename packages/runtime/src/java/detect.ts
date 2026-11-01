/**
 * Java 探测编排（移植自 MCANextGen java-discovery/detect.ts，逻辑不动）：
 * 收集候选 → 并发执行验证（4 路）→ 应用选择规则。永不抛异常——
 * 没有 Java 8 的机器是一份报告，不是一个错误（失败面板范式）。
 */

import type { JavaDetectionReport, JavaInstall, JavaProbeFailure } from '@attic/core-spec';

import { discoverJavaCandidates } from './discover';
import { probeJavaExecutable } from './probe';
import { requiredMajor, selectJavaInstallation, type JavaDetectionOptions } from './select';

/** 探测期间同时启动的 JVM 数。 */
const PROBE_CONCURRENCY = 4;

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;

  const runners = new Array(Math.min(limit, items.length))
    .fill(0)
    .map(async () => {
      while (cursor < items.length) {
        const index = cursor++;
        const item = items[index];
        if (item !== undefined) results[index] = await worker(item);
      }
    });

  await Promise.all(runners);
  return results;
}

export async function detectJavaRuntime(options: JavaDetectionOptions = {}): Promise<JavaDetectionReport> {
  const startedAt = Date.now();
  const platform = options.platform ?? process.platform;
  const major = requiredMajor(options);

  const { candidates, diagnostics } = await discoverJavaCandidates(platform, options.manualPaths ?? []);

  const probes = await mapWithConcurrency(candidates, PROBE_CONCURRENCY, (candidate) =>
    probeJavaExecutable(candidate.executable, candidate.source, options.probeTimeoutMs),
  );

  const installations: JavaInstall[] = [];
  const failures: JavaProbeFailure[] = [];

  probes.forEach((probe, index) => {
    const candidate = candidates[index];
    if (!candidate) return;
    if (probe.ok) {
      installations.push(probe.install);
    } else {
      failures.push({ executable: candidate.executable, source: candidate.source, reason: probe.reason });
    }
  });

  // JDK 暴露两个等价启动器（<jdk>\bin\java 与其私有 <jdk>\jre\bin\java）：
  // 同一运行时只报一次，保留高优先级路径。
  const unique = new Map<string, JavaInstall>();
  for (const installation of installations) {
    const home = platform === 'win32' ? installation.javaHome.toLowerCase() : installation.javaHome;
    const key = `${home}|${installation.raw}|${installation.architecture}`;
    if (!unique.has(key)) unique.set(key, installation);
  }

  const usable = [...unique.values()];
  const selection = selectJavaInstallation(usable, options);

  if (selection.install === null) {
    diagnostics.push(`no usable Java ${major} executable among ${candidates.length} candidates`);
  }

  return {
    requiredMajor: major,
    platform,
    installs: usable,
    failures,
    selection,
    diagnostics,
    startedAt,
    finishedAt: Date.now(),
  };
}
