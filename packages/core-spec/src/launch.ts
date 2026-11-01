/**
 * 启动配置契约：LaunchConfig 是"可执行的最小完备描述"——
 * 拿到它的任何壳（TS/Rust）都应能原样 spawn 游戏进程，不再做任何版本判断。
 */

import type { AgentMount } from './version';

/** 最终拼装的启动参数（占位符已全部展开，路径全部绝对化）。 */
export interface LaunchConfig {
  /** java 可执行文件绝对路径。 */
  javaPath: string;
  /** 游戏工作目录（远古版本用 per-version 隔离目录，`game-dir` quirk 承担）。 */
  gameDir: string;
  /** 资产目录（`assets/` 根，虚拟映射由 legacyfix/解析器决定）。 */
  assetsDir: string;
  mainClass: string;
  /** 依序拼接的 classpath 条目（绝对路径）。 */
  classpath: string[];
  /** JVM 参数组（含 `-javaagent:` 形态的 agentMount 展开结果、代理重定向、`useLegacyMergeSort`、内存参数等）。 */
  jvmArgs: string[];
  /** 传给 mainClass 的游戏参数（username/uuid/token/窗口尺寸…按版本形态）。 */
  gameArgs: string[];
  /** 本次启动实际生效的 legacyfix 挂载（决策表按版本区间过滤后的结果）。 */
  agentMount: AgentMount[];
  /** 堆内存上限 MB（下限由版本表/设置决定，缺省不下发）。 */
  maxMemoryMb: number;
  minMemoryMb?: number;
}

/** 崩溃分类器的类别（判定逻辑在 runtime；契约固定枚举）。 */
export type CrashCategory =
  | 'none'
  | 'java-missing'
  | 'out-of-memory'
  | 'gl-init'
  | 'lwjgl-native'
  | 'unsatisfied-link'
  | 'unknown';

export interface CrashSummary {
  category: CrashCategory;
  /** 单行摘要（stdout/stderr 首个匹配行）。 */
  headline: string;
}

export interface GameExit {
  code: number | null;
  signal: string | null;
  /** 非正常退出时由崩溃分类器填充；正常退出为 null。 */
  crash: CrashSummary | null;
  /** 用户主动停止（点停止按钮 / 关闭游戏窗口触发看门狗）：控制台以中性态显示最后一行日志，不报崩溃。 */
  stoppedByUser?: boolean;
}

export interface GameSession {
  pid: number;
  versionId: string;
  startedAt: number;
}

export interface GameStatus {
  running: boolean;
  session: GameSession | null;
  lastExit: GameExit | null;
  /** 最近一次启动失败原因（缺 jar / 无 Java 8 / …）。 */
  lastError: string | null;
}
