/**
 * 启动器层崩溃诊断（纯函数 + fs 薄封装，Electron 无关）：
 *  - launcher.log：`<root>/launcher/logs/launcher.log`，v1 语义 = append 跨启动滚动历史
 *    （与 output-client.log「恒等于最近一次启动」互补），行前缀 `(HH:mm:ss.SSS) [OUT|ERR]`；
 *  - crash bundle：环境快照 + 崩溃栈 + 两日志尾部，落 `crash-<ISO>.txt` 并进剪贴板/issue 预填；
 *  - 脏退出标记：`<root>/launcher/crash-dirty.json`，崩溃当场写、下次启动构造期消费即删
 *    （消费语义 = 横幅只弹一次，崩溃后再崩由当场重写覆盖）；
 *  - issues 链接：repo 数据驱动自 releaseRepo（禁硬编码），端点可 override。
 * stdout/stderr 捕获器由 Electron 主进程显式挂载——sidecar 的 stdout 是 NDJSON 协议面，绝不可装。
 */

import fs from 'node:fs';
import path from 'node:path';

import type { CrashBrief } from '@attic/core-spec';

/** launcher.log 滚动封顶：超限截半保尾（append 语义防无界增长；截半而非清零保留近期现场）。 */
export const LAUNCHER_LOG_MAX_BYTES = 2 * 1024 * 1024;

/** bundle 内两日志各取尾部行数（现场密度经验值）。 */
export const CRASH_LOG_TAIL_LINES = 200;

/** 脏退出标记里栈的截断长度（横幅展示用；全量在 crash-*.txt 与 launcher.log）。 */
export const CRASH_MARKER_STACK_MAX = 4000;

/** 原生对话框 detail 的栈截断（渲染栈不可信场景下 detail 只是线索，全量在 bundle）。 */
export const CRASH_DIALOG_STACK_MAX = 2000;

/** 脏退出标记摘要（= 崩溃栈首行，issue 标题与横幅一行文案）。 */
export function crashSummary(stack: string): string {
  const line = stack.split('\n').map((s) => s.trim()).find((s) => s.length > 0) ?? 'unknown';
  return line.length > 120 ? `${line.slice(0, 117)}…` : line;
}

/** launcher.log 行形状：`(HH:mm:ss.SSS) [OUT|ERR] 文本`（多行块逐行落，前缀只打首行）。 */
export function launcherLogLine(stream: 'out' | 'err', text: string, at: Date = new Date()): string {
  const ts = `(${at.toISOString().slice(11, 23)})`;
  const tag = stream === 'out' ? '[OUT]' : '[ERR]';
  const lines = text.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n');
  return lines.map((l) => `${ts} ${tag} ${l}`).join('\n');
}

/** 取尾部 n 行（bundle 组装与 log 截半共用）。 */
export function tailLines(text: string, n: number): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.slice(-n).join('\n');
}

/** 崩溃现场简报 = 契约 CrashBrief（脏退出标记内容；SYS_INFO.lastCrash 投给 UI 横幅）。 */

export function crashMarkerFile(root: string): string {
  return path.join(root, 'launcher', 'crash-dirty.json');
}

/** 崩溃当场写标记（写失败静默——标记是增强面，不能反噬对话框主流程）。 */
export function writeCrashMarker(root: string, brief: CrashBrief): void {
  try {
    fs.mkdirSync(path.dirname(crashMarkerFile(root)), { recursive: true });
    fs.writeFileSync(
      crashMarkerFile(root),
      JSON.stringify({ ...brief, stack: brief.stack.slice(0, CRASH_MARKER_STACK_MAX) }, null, 2),
      'utf8',
    );
  } catch {
    /* 磁盘异常不阻断崩溃处理 */
  }
}

/** 下次启动消费标记：读 + 删（横幅只弹一次）。形状不符/缺席 = null。 */
export function consumeCrashMarker(root: string): CrashBrief | null {
  const file = crashMarkerFile(root);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  try {
    fs.rmSync(file);
  } catch {
    /* 删失败下次再消费，无害 */
  }
  try {
    // 剥 UTF-8 BOM：外部工具（如 PowerShell Set-Content -Encoding utf8）手写的标记带 BOM，
    // 不剥则 JSON.parse 抛 → 标记被静默消费掉，横幅永远不弹。
    const v = JSON.parse(raw.replace(/^\uFEFF/, '')) as Partial<CrashBrief>;
    if (typeof v.at === 'string' && typeof v.category === 'string' && typeof v.summary === 'string') {
      return { at: v.at, category: v.category, summary: v.summary, stack: typeof v.stack === 'string' ? v.stack : '' };
    }
  } catch {
    /* 坏 JSON = 无标记 */
  }
  return null;
}

/** bundle 组装入参（Electron 专有版本串由宿主从 process.versions 摘带来，runtime 不感知壳）。 */
export interface CrashBundleInput {
  launcherVersion: string;
  shell: string;
  /** electron/chrome/node 等 process.versions 子集（缺项省略行）。 */
  versions: Record<string, string | undefined>;
  platform: string;
  osRelease: string;
  arch: string;
  category: string;
  stack: string;
  /** launcher.log 全文或尾部（内部再截 CRASH_LOG_TAIL_LINES）。 */
  launcherLog: string;
  /** output-client.log 全文或尾部。 */
  clientLog: string;
  at?: string;
}

/** 诊断包文本：环境 + 栈 + 两日志尾部。issue 正文与 crash-*.txt 同一形状（单点真相）。 */
export function buildCrashBundle(input: CrashBundleInput): string {
  const versionLines = Object.entries(input.versions)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  return [
    '==== Attic Launcher 崩溃诊断 ====',
    `时间: ${input.at ?? new Date().toISOString()}`,
    `类别: ${input.category}`,
    `启动器: v${input.launcherVersion} (${input.shell})`,
    versionLines,
    `系统: ${input.platform} ${input.osRelease} (${input.arch})`,
    '',
    '---- 崩溃栈 ----',
    input.stack || '(无栈信息)',
    '',
    `---- launcher.log 尾 ${CRASH_LOG_TAIL_LINES} 行 ----`,
    tailLines(input.launcherLog, CRASH_LOG_TAIL_LINES) || '(空)',
    '',
    `---- output-client.log 尾 ${CRASH_LOG_TAIL_LINES} 行 ----`,
    tailLines(input.clientLog, CRASH_LOG_TAIL_LINES) || '(空)',
    '',
  ].join('\n');
}

/**
 * GitHub 预填 issue 链接（repo = releaseRepo 派生，禁硬编码；空 repo 返空串 = 报告钮隐藏面）。
 * 报告动作纪律：宿主/渲染先把 bundle 写剪贴板，再开本链接——正文提示直接粘贴。
 */
export function crashIssuesUrl(repo: string | undefined, version: string, summary: string): string {
  if (!repo) return '';
  const title = `[崩溃] v${version} ${summary}`;
  const body =
    '### 复现步骤\n\n1. \n\n### 期望行为\n\n\n\n' +
    '### 崩溃诊断\n\n诊断包已复制到剪贴板，请在下方直接粘贴（Ctrl+V）：\n\n```\n\n```\n';
  return `https://github.com/${repo}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
}

/**
 * stdout/stderr 捕获（launcher.log 的跨启动滚动源）：包一层原 write、把内容同步转交 sink，
 * 返回还原函数。只允许 Electron 主进程调用（sidecar stdout = NDJSON 协议面）。
 */
export function attachConsoleCapture(sink: (stream: 'out' | 'err', text: string) => void): () => void {
  const originals: Array<[NodeJS.WriteStream, (chunk: unknown) => void]> = [];
  for (const [stream, tag] of [
    [process.stdout, 'out'],
    [process.stderr, 'err'],
  ] as const) {
    const original = stream.write.bind(stream);
    originals.push([stream, original as (chunk: unknown) => void]);
    const patched = stream.write as unknown as (chunk: unknown, ...rest: unknown[]) => boolean;
    stream.write = function (chunk: unknown, ...rest: unknown[]): boolean {
      try {
        const text = typeof chunk === 'string' ? chunk : String(chunk);
        if (text) sink(tag, text);
      } catch {
        /* 捕获失败不碰真流 */
      }
      return patched(chunk, ...rest);
    } as typeof stream.write;
  }
  return () => {
    for (const [stream, original] of originals) {
      stream.write = original as typeof stream.write;
    }
  };
}
