/**
 * useCrash —— 渲染层错误采集共享状态（模块级单例）。
 * 三源归一：window 'error' / 'unhandledrejection' / Vue app.config.errorHandler
 * → 经 CRASH_REPORT 静默落宿主 launcher.log（永不弹框），同时喂 liveError
 * 给 CrashPanel 渲染现场卡片（栈先行 + 三按钮，与 win32 原生框同构）。
 * 节流：单会话至多上报 REPORT_CAP 条（渲染循环错误可瞬时上千发，风暴护栏）；
 * 资源加载错误（ErrorEvent 无 error 对象）不上报，避免 favicon/图片 404 噪音。
 * 监听器全局挂（main.ts，含控制台窗）；CrashPanel 只挂主页。
 */

import { ref } from 'vue';
import type { CrashBrief } from '@attic/core-spec';
import { useBridge } from './useBridge';

const { bridge } = useBridge();

/** 最近一次渲染层错误（null = 本会话无现场）；CrashPanel 数据源。 */
const liveError = ref<CrashBrief | null>(null);

let started = false;
let reported = 0;
const REPORT_CAP = 20;
/** 栈截断上限（与宿主脏退出标记 CRASH_MARKER_STACK_MAX 同口径）。 */
const STACK_MAX = 4000;

/** 栈首行摘要（与 runtime crashSummary 同口径：≤117 + 省略号）。 */
function summarize(text: string): string {
  const line = (text.split('\n')[0] ?? '').trim();
  return line.length > 117 ? line.slice(0, 117) + '…' : line;
}

/** 统一上报入口：截栈 → 填 liveError → 静默发宿主（桥面失败不反噬页面）。 */
function report(source: string, message: string, stack: string): void {
  if (reported >= REPORT_CAP) return;
  reported += 1;
  const full = stack || message;
  const capped = full.length > STACK_MAX ? full.slice(0, STACK_MAX) : full;
  liveError.value = {
    at: new Date().toISOString(),
    category: `renderer:${source}`,
    summary: summarize(full) || source,
    stack: capped,
  };
  void bridge
    .reportRendererError({ source, message, stack: capped })
    .catch(() => undefined);
}

/** Vue app.config.errorHandler 入口（main.ts 接线；组件树内异常走这里而非 window.onerror）。 */
function captureVueError(err: unknown, info: string): void {
  const e = err instanceof Error ? err : null;
  report('vue-error', `${e?.message ?? String(err)} (${info})`, e?.stack ?? String(err));
}

/** 安装全局监听（幂等；main.ts 启动时调用一次）。 */
function start(): void {
  if (started) return;
  started = true;
  window.addEventListener('error', (ev: ErrorEvent) => {
    // 资源加载错误（img/script/link）ev.error 为空且不可取消——不上报（噪音过滤）。
    if (!ev.error) return;
    const e = ev.error instanceof Error ? ev.error : null;
    const where = ev.filename ? `${ev.filename}:${ev.lineno}:${ev.colno}` : '';
    report('window-error', ev.message || String(ev.error), e?.stack ?? `${ev.message} @ ${where}`);
  });
  window.addEventListener('unhandledrejection', (ev: PromiseRejectionEvent) => {
    const reason = ev.reason;
    const e = reason instanceof Error ? reason : null;
    report('unhandled-rejection', e?.message ?? String(reason), e?.stack ?? String(reason));
  });
}

/** 忽略现场卡片（日志已落，仅清 UI 态）。 */
function dismiss(): void {
  liveError.value = null;
}

export function useCrash() {
  return { liveError, start, captureVueError, dismiss };
}
