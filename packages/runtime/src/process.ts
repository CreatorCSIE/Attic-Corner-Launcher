/**
 * 游戏进程生命周期：spawn、stdout/stderr 流、崩溃分类器 v0、kill/退出清理。
 * 纪律：游戏开独立顶层窗口，永不嵌入宿主（对照 MCANextGen 风险登记 #3/#6）。
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

/**
 * 崩溃堆栈签名两条腿（2026-11-07 a1.2.3 实测定型，源码核对 =
 * minecraft-verification-analysis/src-minecraft/src-minecraft-alpha-v1.2.3 + legacyfix-attic）：
 * ① **Stopping! 紧邻堆栈块**：崩溃后仍走了收尾的路径（beta/alpha `func_6266_c()` 打
 *   "Stopping!"）。Stopping! 与块之间只允许堆栈行（body/header），`Caused by` 嵌套向上
 *   并拢到顶层 header——隔着日志行的陈旧堆栈不当死因。
 * ② **尾部堆栈块**：a1.2.3 主循环外层 `catch (Throwable)` → `printStackTrace()`（裸打
 *   `java.lang.StackOverflowError`，无 "Exception in thread" 前缀、无冒号）→ **不经过**
 *   stop()，崩溃日志里没有 Stopping!；legacyfix 又在 run() 尾注入 `System.exit(0)`，
 *   崩溃可带 0 码退出（实测三形态：0 码 / 0xCFFFFFFF fatal / 循环线程死透 JVM 僵尸靠
 *   用户点停止收尸）。故块底落在日志末 ≤8 行的完整堆栈块即签名。
 * Stopping! 在场时②只扫最后一个 Stopping! 之后的尾段（infdev-20100630 系 `catch(Exception)`
 * 不拦 Error：finally 先打 Stopping!、JDK uncaught handler 事后才打栈——栈在收尾后 = 真
 * 崩溃；收尾前压着的陈旧栈 = 正常退出噪音，不报）。classic/indev 族全程无 Stopping!
 * （源码普查：0.0.x 与 0.28/0.31/201001xx 的收尾不打任何日志），全靠②。
 */
const STOPPING_LINE = /Stopping!/;
const STACK_HEADER = /(?:Exception in thread|[\w$.]+(?:Exception|Error|Throwable)[\w$.]*(?::|$))/;
const STACK_BODY = /^\s*(?:at\s+[\w$.]|Caused by:|\.\.\.\s*\d+\s+more)/;
const STACK_GAP_TOLERANCE = 8;

const isStackLine = (line: string): boolean => STACK_BODY.test(line) || STACK_HEADER.test(line);

/**
 * 非致命噪音栈头（2026-11-07 用户实测 indev→infdev<0327 系：`SocketException: Unexpected
 * end of file from server` 被弹未知错误。源码实锤 = ThreadDownloadResources.run()（混淆
 * `net.minecraft.client.j`）L82-84 `catch(IOException)→printStackTrace()`——daemon 下载线程
 * 拉 www.minecraft.net/resources/ 死链打栈，游戏照常；同族 GuiLoadLevel/SoundPool/
 * ThreadDownloadImage/RenderEngine 等亦 IO/网络异常打栈）。两腿同闸：尾块**顶层** header
 * 命中此名单 → 不算死因（嵌套 `RuntimeException…Caused by: SocketException` 顶层仍是致命类，
 * 不受影响）。真崩于 IO 异常的罕见场景落回退出码行兜底。
 */
const NON_FATAL_STACK = /^(?:java\.net\.(?:SocketException|ConnectException|SocketTimeoutException|UnknownHostException|NoRouteToHostException|BindException|MalformedURLException|ProtocolException|UnknownServiceException|HttpRetryException)|javax\.net\.ssl\.SSL\w+|java\.io\.(?:IOException|EOFException|FileNotFoundException|InterruptedIOException|UnsupportedEncodingException)|java\.util\.zip\.(?:ZipException|DataFormatException)|javax\.imageio\.IIOException)(?::|$)/;

/**
 * 音频引擎线程噪音栈（2026-11-07 用户点名 indev-20100223 paulscode 案例）：paulscode
 * SoundSystem 自家 CommandThread/TimerThread catch(Throwable)→printStackTrace——声卡/库
 * 挂了游戏循环照常。判据 = 块内**全部**帧都是引擎/JDK 框架（无任何游戏代码帧）；对照
 * 同版 Minecraft.java L363-366：tick 异常 catch = GuiErrorScreen "The game broke!" +
 * return（致命），其栈必含 net.minecraft 帧，不受本闸影响。
 */
const NOISE_ONLY_FRAMES = /^\s*at\s+(?:(?:com\.)?paulscode\.|java\.|javax\.|sun\.)/;

const isNoiseThreadStack = (bodies: string[]): boolean =>
  bodies.length > 0 && bodies.every((line) => NOISE_ONLY_FRAMES.test(line));

/**
 * 致命死因分类（2026-11-07 用户拍板）：只对签名认定的**死因块顶层 header** 归类——
 * 日志里非致命路径（引擎线程/被 catch 恢复）打出的杂散栈不因其存在而升格分类。
 * unknown 只留给未分类（含退出码兜底）。tim-sort 特判消息文本（同一 IAE 类其他消息
 * 不配享有专类）；IllegalState 专类语义 = 状态冲突/重复初始化（Timer already registered、
 * Display 未建先用、组件重复添加等）。
 */
const FATAL_CAUSE_RULES: ReadonlyArray<{ category: CrashCategory; pattern: RegExp }> = [
  { category: 'tim-sort', pattern: /IllegalArgumentException:\s*Comparison method violates/ },
  { category: 'stack-overflow', pattern: /java\.lang\.StackOverflowError(?::|$)/ },
  { category: 'null-pointer', pattern: /java\.lang\.NullPointerException(?::|$)/ },
  { category: 'index-out-of-bounds', pattern: /java\.lang\.(?:Array|String)?IndexOutOfBoundsException(?::|$)/ },
  { category: 'illegal-state', pattern: /java\.lang\.IllegalStateException(?::|$)/ },
];

function categorizeSignature(header: string): CrashCategory {
  const rule = FATAL_CAUSE_RULES.find((r) => r.pattern.test(header));
  return rule ? rule.category : 'unknown';
}

function splitLines(output: string): string[] {
  return output.split(/\r?\n/).filter((line) => line.trim().length > 0);
}

/** 自最后一个 Stopping! 向上取紧邻堆栈块的块首行；无紧邻堆栈 → null（不拿无关行当死因）。 */
function findStoppingStack(lines: string[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!STOPPING_LINE.test(lines[i]!)) continue;
    let header: string | null = null;
    const bodies: string[] = [];
    for (let j = i - 1; j >= 0 && isStackLine(lines[j]!); j--) {
      if (STACK_HEADER.test(lines[j]!)) header = lines[j]!;
      else bodies.push(lines[j]!);
    }
    if (!header) return null;
    const top = header.trim();
    return NON_FATAL_STACK.test(top) || isNoiseThreadStack(bodies) ? null : top;
  }
  return null;
}

/** 尾部堆栈块：块底须在日志末 ≤8 行内（崩溃后零星残留日志不遮签名），向上并拢到块顶；
 *  须 header+body 俱备——裸 header 单行（日志里偶提一句异常名）不算完整栈签名。 */
function findTrailingStack(lines: string[]): string | null {
  const floor = lines.length - STACK_GAP_TOLERANCE;
  let m = lines.length - 1;
  while (m >= floor && !isStackLine(lines[m]!)) m--;
  if (m < floor) return null;
  let header: string | null = null;
  const bodies: string[] = [];
  for (let j = m; j >= 0; j--) {
    const line = lines[j]!;
    if (STACK_BODY.test(line)) {
      bodies.push(line);
      continue;
    }
    if (STACK_HEADER.test(line)) {
      header = line;
      continue;
    }
    break;
  }
  if (!header || bodies.length === 0) return null;
  const top = header.trim();
  return NON_FATAL_STACK.test(top) || isNoiseThreadStack(bodies) ? null : top;
}

/** 签名合成：Stopping! 紧邻优先；尾部块在 Stopping! 在场时只看最后一个 Stopping! 之后的尾段
 *  （infdev Error 崩溃 = finally 先打 Stopping!、JDK uncaught handler 事后打栈——栈在收尾后
 *  = 真签名；收尾前压着的陈旧栈 = 正常退出噪音不报。classic/indev/alpha 无 Stopping! 全尾扫）。 */
function findStackSignature(lines: string[]): string | null {
  const adjacent = findStoppingStack(lines);
  if (adjacent) return adjacent;
  let lastStopping = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (STOPPING_LINE.test(lines[i]!)) {
      lastStopping = i;
      break;
    }
  }
  return findTrailingStack(lastStopping >= 0 ? lines.slice(lastStopping + 1) : lines);
}

export function classifyCrash(output: string, code: number | null, signal?: string | null): CrashSummary | null {
  const lines = splitLines(output);
  const signature = findStackSignature(lines);
  // 退出码 0 ≠ 恒正常（2026-11-07 用户拍板 + a1.2.3 实证）：legacyfix run() 尾注入的
  // System.exit(0) 让崩溃以 0 码收场——命中签名仍报 unknown。规则不在 0 码上跑——
  // 正常退出日志里的陈旧 OOM/ENOENT 行会误报，0 码只认堆栈签名。
  if (code === 0) return signature ? { category: categorizeSignature(signature), headline: signature } : null;
  for (const rule of CRASH_RULES) {
    const hit = lines.find((line) => rule.pattern.test(line));
    if (hit) return { category: rule.category, headline: hit.trim() };
  }
  if (signature) return { category: categorizeSignature(signature), headline: signature };
  return {
    category: 'unknown',
    headline: code !== null ? `exit code ${code}` : `signal ${signal ?? 'unknown'}`,
  };
}

/**
 * 用户主动停止复核（2026-11-07 a1.2.3 僵尸场景）：游戏先崩（循环线程死透、窗口失效）
 * 但 JVM 不退，用户点停止 = SIGTERM 收尸——日志命中崩溃签名仍报 unknown；无签名 =
 * 常规中性停止，语义不变。
 */
export function classifyStopped(output: string): CrashSummary | null {
  const lines = splitLines(output);
  const signature = findStackSignature(lines);
  return signature ? { category: categorizeSignature(signature), headline: signature } : null;
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
 * ② **直连进服的非 Applet 启动**（gameArgs 含 `--server`）：老版本
 *   多人网络读线程为非守护线程，联机中关窗 → 主线程退出但 JVM 被读线程挂住不随窗退出，
 *   进程残留在任务管理器（v1 由 QuitGame addon 兜底，legacyfix 上游空缺）。
 * 轮询到游戏窗消失即 SIGTERM，让"关窗=退出"与常规版本行为一致。
 *
 * 游戏主窗识别 = 窗口类：Applet = `SunAwtFrame`（AppletFrame extends Frame 的 AWT 注册类），
 * 直连常规版 = `LWJGL`（LWJGL2 主窗注册类；类过滤同时天然排除 conhost/加载帧）。
 * 不吃 MainWindowHandle/标题字符串：
 *   - legacyfix 的 levelServer 询问弹窗是 SunAwtDialog，且弹窗关闭后到游戏窗出现之间
 *     还有 downloadAssets 合法空窗——按窗口在场判定会被弹窗/瞬窗误闩 $seen → 空窗期误报
 *     CLOSED → SIGTERM 静默杀进程（表现为询问窗挂起 10s 内自动退出）；
 *   - 标题匹配同样不可用——legacyfix-attic fork 已支持 -Dlf.title 自定义窗口标题，
 *     按 "Minecraft" 匹配会在自定义标题下永不闩上（看门狗失效 = 新缺陷）。
 * 共享 owner 帧（无标题）与隐藏窗被「未离屏 + 标题非空」过滤出局；双向 2 拍去抖
 * 防创建动画期瞬时枚举失败。
 * 实现选型 = UIAutomation（GAC 程序集直加载）——弃 Add-Type -MemberDefinition P/Invoke
 * 路线：那条路要现场跑 csc 编译，宿主环境 LIB 含失效路径时警告被当错误炸编译，看门狗整体瘫痪。
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
 * 非 Applet 仅直连进服挂（gameArgs 含 `--server` = 一次性直连/服务器页启动的判定信号；
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
  /** 用户主动停止标记（点停止按钮/看门狗关窗）：置真后 SIGTERM 走 classifyStopped 复核——无堆栈签名不报崩溃，exit 消费即复位。 */
  private stopRequested = false;
  private lastError: string | null = null;
  private outputTail = '';
  private closedResolve: (() => void) | null = null;
  /** 在途的 close 等待 promise——并发 kill 共享同一条，防后者覆写 closedResolve 让前者 await 永不 resolve。 */
  private closeWait: Promise<void> | null = null;

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

    // Windows 下 java.exe 控制台输出走系统代码页（GBK/cp936）：UTF-8 解码中文报错即乱码。
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
      // 用户主动停止（点停止按钮 / 看门狗关窗）：常规不报崩溃，控制台以中性态显示最后一行日志；
      // 例外 = classifyStopped 命中堆栈签名（游戏先崩、停止收尸）。
      const stoppedByUser = this.stopRequested;
      this.stopRequested = false;
      // 用户主动停止也复核堆栈签名（a1.2.3 僵尸收尸场景：游戏先崩、停止只是清理）。
      const crash = stoppedByUser ? classifyStopped(this.outputTail) : classifyCrash(this.outputTail, code, signal);
      // 崩溃即打一行退出码（控制台可见、测试启动日志同流），unknown 分类即指向这行；
      // 含 code=0 但命中堆栈签名的场景——「exit code = 0」正是该报的诊断。
      // 用户收尸的 SIGTERM 不打（headline 已是堆栈，「异常退出」字样与主动停止矛盾）。
      if (crash && !stoppedByUser) {
        const line = `[attic-runtime] 游戏异常退出：${code !== null ? `exit code = ${code}` : `signal = ${signal ?? 'unknown'}`}\n`;
        this.appendOutput(line);
        this.events.onOutput({ stream: 'stdout', chunk: line, pid });
      }
      const exit: GameExit = { code, signal, crash, ...(stoppedByUser ? { stoppedByUser: true } : {}) };
      this.lastExit = exit;
      this.child = null;
      const session = this.session;
      this.session = null;
      this.events.onExit({ ...exit, pid, versionId: session?.versionId ?? versionId });
      this.closedResolve?.();
      this.closedResolve = null;
      this.closeWait = null;
    });

    this.child = child;

    // 看门狗触发面（见 windowWatchdogScript 头注）：Applet 容器恒挂；非 Applet 仅直连进服挂
    // （--server 在 gameArgs = 一次性直连/服务器页启动的判定信号，对应联机关窗线程残留）。
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
    // spawn 失败（powershell 缺失/被策略拦截）走 error 事件：无监听 = 未捕获异常炸宿主。
    // 看门狗不可用只回退「关窗后进程残留」旧行为；不写 outputTail——避免 "not recognized"
    // 之类消息误命中 java-missing 崩溃分类。
    ps.on('error', (error: Error) => {
      console.log(`[attic-runtime] 看门狗不可用：${error.message}`);
    });
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
    // 并发 kill（连点停止/两处同时调用）复用同一条 close-wait：各自新建会覆写
    // closedResolve，先 await 的那条永不 resolve（停止按钮假死）。
    const closed = (this.closeWait ??= new Promise<void>((resolve) => {
      this.closedResolve = resolve;
    }));
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
