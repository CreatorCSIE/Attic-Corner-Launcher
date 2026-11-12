/**
 * attic-cli —— 仓内开发控制面（**非产品功能**：不进 README、不进契约对账、argv 无稳定承诺）。
 *
 * 复用 sidecar 同款无头启动链：直构 AtticRuntime（跳过 NDJSON 传输层），供 AI/脚本无 GUI 做
 * e2e 启动回归、dry-run 组装核对与取证（数据根解析与 sidecar 同款 rootOverride 引导）。
 *
 * 语义边界：status/kill 是**进程内**语义（GameProcessManager 进程级单例），一次性 CLI 够不到
 * 别的会话——launch 进程即会话宿主：游戏输出直通 stdout/stderr、Ctrl+C 走 kill（stoppedByUser
 * 语义）、退出码随游戏。跨进程 status/kill 需 pid 持久化，dev 工具不做（YAGNI）。
 */

import path from 'node:path';
import { IPC_EVENTS, type GameExitEvent, type GameSession, type LaunchRequest } from '@attic/core-spec';
import { AtticRuntime, isPathWithin, loadSettings, resolveDataRoot } from '@attic/runtime';

/** 安装目录护栏参照：与 sidecar 同款（CLI 态 = node 目录，护栏无害）。 */
const INSTALL_DIR = path.dirname(process.execPath);

/** 数据根引导：与 sidecar 同款（默认根 peek rootOverride + 安装目录护栏）。 */
function bootstrapRootDir(): string | undefined {
  try {
    const override = loadSettings(resolveDataRoot())['rootOverride'];
    if (!override) return undefined;
    if (isPathWithin(INSTALL_DIR, override)) {
      console.warn('[attic-cli] rootOverride 位于安装目录内，本次忽略，回落默认根');
      return undefined;
    }
    return override;
  } catch {
    return undefined;
  }
}

const runtime = new AtticRuntime({
  rootDir: bootstrapRootDir(),
  version: process.env['ATTIC_LAUNCHER_VERSION'] ?? '0.0.0-cli',
  installDir: INSTALL_DIR,
});

// —— argv 解析（极简：--flag / --key value / 位置参）——
interface Parsed {
  positional: string[];
  flags: Map<string, string | boolean>;
}

function parseArgs(argv: string[]): Parsed {
  const positional: string[] = [];
  const flags = new Map<string, string | boolean>();
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] ?? '';
    if (a === '--dry-run') flags.set('dry-run', true);
    else if (a.startsWith('--')) flags.set(a.slice(2), argv[(i += 1)] ?? '');
    else positional.push(a);
  }
  return { positional, flags };
}

function usage(message?: string): never {
  if (message) console.error(`[attic-cli] ${message}\n`);
  console.error(
    [
      '用法：',
      '  attic-cli instances',
      '  attic-cli launch <实例名> [--account <id>] [--dry-run]',
      '  attic-cli launch --version <版本id> [--account <id>] [--dry-run]   （缺省实例）',
      '',
      '说明：launch 阻塞至游戏退出（输出直通 stdout/stderr，Ctrl+C = 用户停止）；',
      '      --dry-run 只组装并打印 LaunchConfig JSON，不下载不 spawn。',
    ].join('\n'),
  );
  process.exit(2);
}

async function cmdInstances(): Promise<void> {
  const list = runtime.listInstances();
  if (list.length === 0) {
    console.log('（无实例）');
    return;
  }
  for (const view of list) {
    console.log(`${view.name}\t${view.version || '（未设版本）'}${view.gameDir ? `\t${view.gameDir}` : ''}`);
  }
}

async function cmdLaunch(parsed: Parsed): Promise<void> {
  const { positional, flags } = parsed;
  const instanceName = positional[0];
  const versionFlag = typeof flags.get('version') === 'string' ? (flags.get('version') as string) : undefined;
  const accountFlag = typeof flags.get('account') === 'string' ? (flags.get('account') as string) : undefined;
  const dryRun = flags.get('dry-run') === true;

  if (!instanceName && !versionFlag) usage('launch 需要 <实例名> 或 --version <版本id>');

  let versionId: string;
  let instanceId: string | undefined;
  if (versionFlag) {
    versionId = versionFlag;
    instanceId = instanceName;
  } else {
    const view = runtime.listInstances().find((v) => v.name === instanceName);
    if (!view) {
      console.error(`[attic-cli] 实例不存在：${instanceName}（instances 命令可查现有实例）`);
      process.exit(2);
    }
    if (!view.version) {
      console.error(`[attic-cli] 实例未设版本：${instanceName}（先在 UI 里选版本，或 launch --version 直启）`);
      process.exit(2);
    }
    versionId = view.version;
    instanceId = view.name;
  }
  const request: LaunchRequest = {
    versionId,
    ...(instanceId ? { instanceId } : {}),
    ...(accountFlag ? { accountId: accountFlag } : {}),
  };

  if (dryRun) {
    const config = await runtime.dryRunLaunch(request);
    process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
    return;
  }

  // 会话宿主接线：游戏流直通两路 stdout/stderr；下载进度走 stderr（stdout 保持纯游戏输出可管道）。
  runtime.on(IPC_EVENTS.GAME_OUTPUT, (payload) => {
    (payload.stream === 'stderr' ? process.stderr : process.stdout).write(payload.chunk);
  });
  runtime.on(IPC_EVENTS.DOWNLOAD_PROGRESS, (payload) => {
    console.error(`[download] ${payload.item}/${payload.id} ${payload.phase}`);
  });
  const exitArrived = new Promise<GameExitEvent>((resolve) => {
    runtime.on(IPC_EVENTS.GAME_EXIT, (payload) => resolve(payload));
  });
  process.on('SIGINT', () => {
    console.error('[attic-cli] SIGINT → kill');
    void runtime.kill().catch(() => undefined);
  });

  let session: GameSession;
  try {
    session = await runtime.launch(request);
  } catch (error) {
    console.error(`[attic-cli] 启动失败：${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
  console.error(`[attic-cli] 会话 pid=${session.pid} 版本=${session.versionId}`);
  const exit = await exitArrived;
  console.error(
    `[attic-cli] 退出 code=${exit.code ?? 'null'} signal=${exit.signal ?? 'null'}` +
      (exit.stoppedByUser ? '（用户停止）' : '') +
      (exit.crash ? `\n[attic-cli] 崩溃：${JSON.stringify(exit.crash)}` : ''),
  );
  process.exit(exit.code ?? (exit.crash ? 1 : 0));
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const [command, ...rest] = argv;
  const parsed = parseArgs(rest);
  switch (command) {
    case 'instances':
      await cmdInstances();
      break;
    case 'launch':
      await cmdLaunch(parsed);
      break;
    case undefined:
    case '--help':
    case 'help':
      usage();
      break;
    default:
      usage(`未知命令：${command}`);
  }
}

main().catch((error: unknown) => {
  console.error(`[attic-cli] ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  process.exit(1);
});
