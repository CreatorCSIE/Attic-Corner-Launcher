/**
 * 游戏进程生命周期：spawn、stdout/stderr 流、崩溃分类器 v0、kill/退出清理。
 * 戒律：游戏开独立顶层窗口，永不嵌入宿主（MCANextGen 风险登记 #3/#6 的全部教训）。
 */

import { spawn, type ChildProcess, type ChildProcessByStdio } from 'node:child_process';
import path from 'node:path';
import type { Readable } from 'node:stream';

import { APPLET_LAUNCHER_CLASS } from './launch.js';

import type {
  CrashCategory,
  CrashSummary,
  GameExit,
  GameExitEvent,
  GameOutputEvent,
  GameSession,
  GameStatus,
  LaunchConfig,
} from '@attic/core-spec';

interface CrashRule {
  category: CrashCategory;
  pattern: RegExp;
}

/** 分类规则按序匹配（v0 最小集，headline 取首个匹配行）。 */
const CRASH_RULES: CrashRule[] = [
  { category: 'out-of-memory', pattern: /OutOfMemoryError|GC overhead limit/i },
  { category: 'unsatisfied-link', pattern: /UnsatisfiedLinkError/ },
  { category: 'gl-init', pattern: /GLXBadContext|WGL|couldn.?t set up|Could not create (?:the )?context|Failed to create context/i },
  { category: 'lwjgl-native', pattern: /lwjgl.*(?:native|library)|(?:native|library).*lwjgl/i },
  { category: 'java-missing', pattern: /ENOENT|java(?:\s*executable)? not found|not recognized/i },
];

export function classifyCrash(output: string, code: number | null): CrashSummary | null {
  if (code === 0) return null;
  const lines = output.split(/\r?\n/).filter((line) => line.trim().length > 0);
  for (const rule of CRASH_RULES) {
    const hit = lines.find((line) => rule.pattern.test(line));
    if (hit) return { category: rule.category, headline: hit.trim() };
  }
  return { category: 'unknown', headline: lines.length > 0 ? lines[lines.length - 1]!.trim() : `exit code ${code}` };
}

/** 输出缓冲上限（分类只用尾部，内存有界）。 */
const OUTPUT_TAIL_LIMIT = 1024 * 1024;

/** 控制台字节流 → 文本解码器（win32 = GBK/cp936，其余 = UTF-8；stream 模式跨块续接多字节字符）。 */
function makeConsoleDecoder(): (chunk: Buffer) => string {
  const decoder = new TextDecoder(process.platform === 'win32' ? 'gbk' : 'utf-8');
  return (chunk: Buffer) => decoder.decode(chunk, { stream: true });
}

export interface GameProcessEvents {
  onOutput: (event: GameOutputEvent) => void;
  onExit: (event: GameExitEvent) => void;
}

/**
 * 窗口看门狗（Windows）：两类覆盖——
 * ① Applet 容器（classic/pre-classic）：游戏循环不检查 isCloseRequested（v1 靠 JVM wrapper 的
 *   windowClosing→exit 兜底，legacyfix AppletFrame 无此监听），关窗后进程空转不退；
 * ② **直连进服的非 Applet 启动**（gameArgs 含 `--server`，2026-11-01 用户报障扩展）：老版本
 *   多人网络读线程为非守护线程，联机中关窗 → 主线程退出但 JVM 被读线程挂住不随窗退出，
 *   进程残留在任务管理器（v1 由 QuitGame addon 兜底，legacyfix 上游空缺 = plan.md 已登记缺口）。
 * 轮询到游戏窗消失即 SIGTERM，让"关窗=退出"与常规版本行为一致。
 *
 * 游戏主窗识别 = 窗口类：Applet = `SunAwtFrame`（AppletFrame extends Frame 的 AWT 注册类），
 * 直连常规版 = `LWJGL`（LWJGL2 主窗注册类；类过滤同时天然排除 conhost/加载帧）。
 * 不吃 MainWindowHandle/标题字符串（2026-10-30 缺陷修复）：
 *   - legacyfix 的 levelServer 询问弹窗是 SunAwtDialog，且弹窗关闭后到游戏窗出现之间
 *     还有 downloadAssets 合法空窗——旧实现 $seen 被弹窗/瞬窗误闩 → 空窗期误报 CLOSED
 *     → SIGTERM 静默杀进程（用户实测「询问窗挂起 10s 内自动退出」）；
 *   - 标题匹配同样不可用——legacyfix-attic fork 已支持 -Dlf.title 自定义窗口标题，
 *     按 "Minecraft" 匹配会在自定义标题下永不闩上（看门狗失效 = 新缺陷）。
 * 共享 owner 帧（无标题）与隐藏窗被「未离屏 + 标题非空」过滤出局；双向 2 拍去抖
 * 防创建动画期瞬时枚举失败。
 * 实现选型 = UIAutomation（GAC 程序集直加载）——弃 Add-Type -MemberDefinition P/Invoke
 * 路线：那条路要现场跑 csc 编译，宿主环境 LIB 含失效路径时警告被当错误炸编译
 * （2026-10-30 本机实测），看门狗整体瘫痪。
 */
function windowWatchdogScript(pid: number, windowClass: string): string {
  return [
    `Add-Type -AssemblyName UIAutomationClient`,
    `Add-Type -AssemblyName UIAutomationTypes`,
    `$gpid=${pid}`,
    `$seen=$false; $up=0; $down=0`,
    `$cond=[System.Windows.Automation.Condition]::TrueCondition`,
    `$root=[System.Windows.Automation.AutomationElement]::RootElement`,
    `for(;;) {`,
    `  if(-not (Get-Process -Id $gpid -ErrorAction SilentlyContinue)){ 'EXITED'; break }`,
    `  $found=$false`,
    `  $wins=$root.FindAll([System.Windows.Automation.TreeScope]::Children,$cond)`,
    `  foreach($w in $wins){`,
    `    $c=$w.Current`,
    `    if($c.ProcessId -eq $gpid -and $c.ClassName -eq '${windowClass}' -and (-not $c.IsOffscreen) -and $c.Name.Length -gt 0){ $found=$true; break }`,
    `  }`,
    `  if($found){ $down=0; if(-not $seen){ $up++; if($up -ge 2){ $seen=$true } } }`,
    `  else { $up=0; if($seen){ $down++; if($down -ge 2){ 'CLOSED'; break } } }`,
    `  Start-Sleep -Milliseconds 1000`,
    `}`,
  ].join('\n');
}

/**
 * 看门狗触发面 + 游戏主窗窗口类（纯函数，独立可测）：Applet 容器恒挂（SunAwtFrame）；
 * 非 Applet 仅直连进服挂（gameArgs 含 `--server` = 一次性直连/服务器页启动实锤信号；
 * LWJGL2 主窗类 `LWJGL`）；其余常规启动游戏自退、不挂。
 */
export function watchdogWindowClass(config: LaunchConfig): string | null {
  if (config.mainClass === APPLET_LAUNCHER_CLASS) return 'SunAwtFrame';
  if (config.gameArgs.includes('--server')) return 'LWJGL';
  return null;
}

export class GameProcessManager {
  private child: ChildProcessByStdio<null, Readable, Readable> | null = null;
  private watchdog: ChildProcess | null = null;
  private session: GameSession | null = null;
  private lastExit: GameExit | null = null;
  /** 用户主动停止标记（点停止按钮/看门狗关窗）：置真后 SIGTERM 导致的非零退出码不报崩溃，exit 消费即复位。 */
  private stopRequested = false;
  private lastError: string | null = null;
  private outputTail = '';
  private closedResolve: (() => void) | null = null;

  constructor(private readonly events: GameProcessEvents) {}

  get running(): boolean {
    return this.child !== null;
  }

  private appendOutput(chunk: string): void {
    this.outputTail += chunk;
    if (this.outputTail.length > OUTPUT_TAIL_LIMIT) {
      this.outputTail = this.outputTail.slice(-OUTPUT_TAIL_LIMIT);
    }
  }

  /** 启动游戏进程（同一时刻仅允许一个）。 */
  start(config: LaunchConfig, versionId: string): GameSession {
    if (this.child) throw new Error('游戏进程已在运行');

    const args = [...config.jvmArgs, '-cp', config.classpath.join(path.delimiter), config.mainClass, ...config.gameArgs];
    const child = spawn(config.javaPath, args, { cwd: config.gameDir, stdio: ['ignore', 'pipe', 'pipe'] });
    this.outputTail = '';
    this.lastError = null;
    this.stopRequested = false;

    const pid = child.pid ?? -1;
    this.session = { pid, versionId, startedAt: Date.now() };

    // Windows 下 java.exe 控制台输出走系统代码页（GBK/cp936）：UTF-8 解码中文报错即乱码（用户实测）。
    // stream:true 解码器处理跨 chunk 拆开的多字节字符；非 Windows 维持 UTF-8。
    const decodeStdout = makeConsoleDecoder();
    const decodeStderr = makeConsoleDecoder();
    child.stdout.on('data', (data: Buffer) => {
      const text = decodeStdout(data);
      this.appendOutput(text);
      this.events.onOutput({ stream: 'stdout', chunk: text, pid });
    });
    child.stderr.on('data', (data: Buffer) => {
      const text = decodeStderr(data);
      this.appendOutput(text);
      this.events.onOutput({ stream: 'stderr', chunk: text, pid });
    });

    // spawn 失败（如 java 不存在）走 error 事件：把原因喂进输出缓冲供分类器命中 java-missing。
    child.on('error', (error: Error) => {
      this.appendOutput(`${error.message}\n`);
      this.lastError = error.message;
    });

    child.on('close', (code, signal) => {
      console.log(`[attic-runtime] game close pid=${pid} code=${code} signal=${signal}`);
      this.watchdog?.kill();
      this.watchdog = null;
      // 用户主动停止（点停止按钮 / 看门狗关窗）：不报崩溃，控制台以中性态显示最后一行日志。
      const stoppedByUser = this.stopRequested;
      this.stopRequested = false;
      const crash = stoppedByUser ? null : classifyCrash(this.outputTail, code);
      const exit: GameExit = { code, signal, crash, ...(stoppedByUser ? { stoppedByUser: true } : {}) };
      this.lastExit = exit;
      this.child = null;
      const session = this.session;
      this.session = null;
      this.events.onExit({ ...exit, pid, versionId: session?.versionId ?? versionId });
      this.closedResolve?.();
      this.closedResolve = null;
    });

    this.child = child;

    // 看门狗触发面（见 windowWatchdogScript 头注）：Applet 容器恒挂；非 Applet 仅直连进服挂
    // （--server 在 gameArgs = 一次性直连/服务器页启动的实锤信号，联机关窗挂线程残留的修复面）。
    if (process.platform === 'win32') {
      const watchdogClass = watchdogWindowClass(config);
      if (watchdogClass) this.startWindowWatchdog(child, pid, watchdogClass);
    }
    return this.session;
  }

  /** 看门狗进程输出 CLOSED（用户关窗且进程未自退）→ SIGTERM 游戏，走常规退出事件链。 */
  private startWindowWatchdog(child: ChildProcessByStdio<null, Readable, Readable>, pid: number, windowClass: string): void {
    const ps = spawn('powershell', ['-NoProfile', '-Command', windowWatchdogScript(pid, windowClass)], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    this.watchdog = ps;
    ps.stdout.setEncoding('utf8');
    ps.stdout.on('data', (data: string) => {
      if (!data.includes('CLOSED') || this.child !== child) return;
      this.appendOutput('[attic-runtime] 游戏窗口已关闭，终止进程\n');
      this.events.onOutput({ stream: 'stdout', chunk: '[attic-runtime] 游戏窗口已关闭，终止进程\n', pid });
      this.stopRequested = true;
      child.kill('SIGTERM');
    });
    ps.on('close', () => {
      if (this.watchdog === ps) this.watchdog = null;
    });
  }

  /** SIGTERM 终止并等待退出；无进程时返回上次退出（或空退出）。 */
  async kill(): Promise<GameExit> {
    if (!this.child) {
      return this.lastExit ?? { code: null, signal: null, crash: null };
    }
    const closed = new Promise<void>((resolve) => {
      this.closedResolve = resolve;
    });
    this.stopRequested = true;
    this.child.kill('SIGTERM');
    await closed;
    return this.lastExit ?? { code: null, signal: null, crash: null };
  }

  status(): GameStatus {
    return {
      running: this.child !== null,
      session: this.session,
      lastExit: this.lastExit,
      lastError: this.lastError,
    };
  }
}
