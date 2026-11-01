/**
 * Java 选择规则（移植自 MCANextGen java-discovery/select.ts，逻辑不动）。
 * 64 位 Java 8 优先；32 位仅在无 64 位时兜底，且必须告知调用方。
 */

import type { JavaArchitecture, JavaInstall, JavaSelection } from '@attic/core-spec';

const DEFAULT_REQUIRED_MAJOR = 8;

const ARCHITECTURE_PREFERENCE: JavaArchitecture[] = ['x86_64', 'x86', 'arm64', 'arm', 'unknown'];

export interface JavaDetectionOptions {
  /** 需要的 Java 大版本，缺省 8（LWJGL2 + MinecraftApplet 要求）。 */
  requiredMajor?: number;
  /** 用户设置提供的额外 java 可执行文件或 JDK/JRE 根。 */
  manualPaths?: string[];
  /** 单可执行文件探测超时。 */
  probeTimeoutMs?: number;
  /** 覆盖平台（测试注入）。 */
  platform?: NodeJS.Platform;
}

export function requiredMajor(options: JavaDetectionOptions = {}): number {
  return options.requiredMajor ?? DEFAULT_REQUIRED_MAJOR;
}

function compareInstalls(a: JavaInstall, b: JavaInstall): number {
  const preference = ARCHITECTURE_PREFERENCE.indexOf(a.architecture) - ARCHITECTURE_PREFERENCE.indexOf(b.architecture);
  if (preference !== 0) return preference;
  // 同特性版本取最新 update；并列保持发现顺序（sort 稳定，候选按来源优先级到达）。
  if (a.patch !== b.patch) return b.patch - a.patch;
  return b.minor - a.minor;
}

export function selectJavaInstallation(
  installs: JavaInstall[],
  options: JavaDetectionOptions = {},
): JavaSelection {
  const major = requiredMajor(options);
  const compatible = installs.filter((entry) => entry.major === major);

  if (compatible.length === 0) {
    const found = installs.map((entry) => `${entry.raw} (${entry.architecture})`);
    return {
      install: null,
      usedFallback: false,
      reason:
        found.length === 0
          ? `no Java installation could be probed; Java ${major} is required`
          : `Java ${major} is not installed; found: ${[...new Set(found)].join(', ')}`,
    };
  }

  const sorted = [...compatible].sort(compareInstalls);
  const selected = sorted[0]!;
  const usedFallback = selected.architecture === 'x86';

  return {
    install: selected,
    usedFallback,
    reason: usedFallback
      ? `no 64-bit Java ${major} found, falling back to the 32-bit installation`
      : `Java ${major} ${selected.architecture} selected`,
  };
}
