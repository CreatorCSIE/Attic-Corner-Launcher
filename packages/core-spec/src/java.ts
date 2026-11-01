/**
 * Java 探测契约（无 Node 依赖，可 Rust 镜像）。
 * 四级候选 + 真实 `-XshowSettings:properties -version` 验证；64 位 Java 8 优先。
 */

/** 候选来源：手动导入 / JAVA_HOME / 注册表或 jvm 目录 / PATH。 */
export type JavaDiscoverySource = 'manual' | 'env' | 'registry' | 'directory' | 'path';

export type JavaArchitecture = 'x86_64' | 'x86' | 'arm64' | 'arm' | 'unknown';

export interface JavaVersion {
  /** 原始 `java.version`，如 `1.8.0_431`。 */
  raw: string;
  /** 特性版本号：Java 8 归一为 8（不是 1.8）。 */
  major: number;
  minor: number;
  patch: number;
  /** `java.runtime.version`（可得时）。 */
  runtimeRaw?: string;
  vendor?: string;
}

/** 探测成功的一个 Java 安装。 */
export interface JavaInstall extends JavaVersion {
  /** java 可执行文件绝对路径。 */
  executable: string;
  /** JVM 自报的 `java.home`。 */
  javaHome: string;
  architecture: JavaArchitecture;
  source: JavaDiscoverySource;
  probeDurationMs: number;
}

export interface JavaProbeFailure {
  executable: string;
  source: JavaDiscoverySource;
  /** 短原因（ENOENT / probe timeout after 4000ms / …）。 */
  reason: string;
}

export interface JavaSelection {
  /** 应当用于启动游戏的 JVM；null = 未找到。 */
  install: JavaInstall | null;
  /** 因无 64 位 Java 8 而落到 32 位兜底。 */
  usedFallback: boolean;
  /** 选择理由或失败说明（面板直接展示）。 */
  reason: string;
}

/** 探测失败面板的全量报告：全部候选与原因。 */
export interface JavaDetectionReport {
  requiredMajor: number;
  platform: string;
  installs: JavaInstall[];
  failures: JavaProbeFailure[];
  selection: JavaSelection;
  /** 非致命备注（跳过的来源、不可读的注册表键等）。 */
  diagnostics: string[];
  startedAt: number;
  finishedAt: number;
}
