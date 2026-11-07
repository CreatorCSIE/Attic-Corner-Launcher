/**
 * 自更新执行面（plan.md「测试版通道与更新执行面」条 Windows 快路径，2026-11-07 用户拍板
 * 对齐 HMCL「确认后自动更新」语义）。
 * 启动器只做 **网络腿 + spawn**：选型 → 下载（复用 BetacraftClient.download：.part 原子落盘 +
 * sha256 校验 + 进度事件）→ 校验 → spawn 更新器（portable = `attic-update.bat -Zip -Pid`，
 * installed = Inno setup.exe 可见向导）；**文件系统腿（验/解/换/启）只有脚本一份**——本模块
 * 不碰 extractZipTo（三职责纪律，正典与自救共用同一份换体逻辑）。
 * 信任分界：锚 = https + GitHub 官方域 + asset digest（GitHub API `assets[].digest`
 * `sha256:<hex>`；脚本消费点 Get-FileHash 双验）；minisign 不归本路径管（Inno/plugin 面）。
 * 失败语义：下载/校验/spawn 失败 = error（UI 原地重试，**不退出**）；数据面判定不进自动路径
 * （非 Windows/无匹配构件/无 digest/老便携无脚本）= unsupported（UI 回落 Releases 外链）。
 * 自退不在本模块：spawn 成功返回后由 UI 关窗（主窗 Destroyed → app exit → sidecar 收）。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { ReleaseAssetInfo, UpdateApplyRequest, UpdateApplyResult } from '@attic/core-spec';

export interface UpdateApplyDeps {
  platform: NodeJS.Platform;
  /** portable 形态位（detectPortable.active；true = zip 换体腿，false = Inno 向导腿）。 */
  portable: boolean;
  /** 启动器安装目录（= exe 所在目录；生产布局 node.exe 与主 exe 同目录，脚本对亦在此）。 */
  installDir: string | undefined;
  /** 数据根（构件暂落 `<root>/cache/update/`，脚本从这里消费）。 */
  root: string;
  /** 下载腿（runtime 接 BetacraftClient.download；sha256 校验失败/网络断 = 抛，本模块转 error）。 */
  download: (url: string, destFile: string, asset: ReleaseAssetInfo, sha256: string) => Promise<void>;
  /** 进程 spawn 缝（测试注入；缺省 = detached 独立子进程，控制台可见——AV 退路面）。 */
  spawnImpl?: (command: string, args: string[]) => void;
  /** 启动器主进程 PID（更新器等它消失再换体；sidecar 缺省 = 壳进程 ppid）。 */
  launcherPid?: number;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 构件命名模板选型（与 release.yml portable/setup 腿逐字对榫）：全名精确匹配，零模糊。 */
export function pickUpdateAsset(
  req: UpdateApplyRequest,
  portable: boolean,
  arch: string,
  version: string,
): ReleaseAssetInfo | null {
  const want = `attic-tauri-windows-${arch}-${version}${portable ? '-portable.zip' : '-setup.exe'}`;
  return req.assets.find((a) => a.name === want) ?? null;
}

function defaultSpawn(command: string, args: string[]): void {
  const child = spawn(command, args, { detached: true, stdio: 'ignore' });
  child.unref();
}

export async function applyUpdate(req: UpdateApplyRequest, deps: UpdateApplyDeps): Promise<UpdateApplyResult> {
  // 执行面本轮只 Windows + tauri 主壳（plan 原文）；其余平台照旧提示+外链。
  if (deps.platform !== 'win32') return { status: 'unsupported', reason: 'windows-only' };
  const arch = os.arch() === 'x64' || os.arch() === 'arm64' ? os.arch() : null;
  if (!arch) return { status: 'unsupported', reason: 'no-asset', message: `当前架构 ${os.arch()} 无匹配构件` };
  const asset = pickUpdateAsset(req, deps.portable, arch, req.version);
  if (!asset) {
    return {
      status: 'unsupported',
      reason: 'no-asset',
      message: `未找到匹配构件（${deps.portable ? 'portable.zip' : 'setup.exe'} · ${arch} · v${req.version}）`,
    };
  }
  // digest 缺位 = 自动路径拒绝（信任锚不完整；宁走外链不裸装）。
  const sha256 = asset.digest.startsWith('sha256:') ? asset.digest.slice('sha256:'.length) : '';
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    return { status: 'unsupported', reason: 'no-digest', message: '构件未回填 digest，请从 Releases 页手动下载' };
  }
  // 先查腿再下载：老便携装（zip 里没有脚本对）不值得白下 150MB。
  const bat = deps.installDir ? path.join(deps.installDir, 'attic-update.bat') : '';
  if (deps.portable && (!bat || !fs.existsSync(bat))) {
    return { status: 'unsupported', reason: 'no-script', message: '当前便携包未随附更新器；手动换体一次后自动更新即可用' };
  }
  const dest = path.join(deps.root, 'cache', 'update', asset.name);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    await deps.download(asset.url, dest, asset, sha256);
  } catch (error) {
    return { status: 'error', message: `下载/校验失败：${messageOf(error)}` };
  }
  const spawnImpl = deps.spawnImpl ?? defaultSpawn;
  const pid = String(deps.launcherPid ?? process.ppid);
  try {
    if (deps.portable) {
      // 快路径 = 跳过脚本网络腿：等 PID 消失→再验（-Sha256 双消费点）→解→换→启（正典见 scripts/attic-update.ps1）。
      spawnImpl('cmd.exe', ['/d', '/c', bat, '-Zip', dest, '-WaitPid', pid, '-Sha256', sha256]);
      return { status: 'spawned', mode: 'portable' };
    }
    // Inno 形态 = 应用内下载 + 唤起可见向导（安装动作在用户手里，2026-10-24 拍板不变）；
    // /CURRENTUSER = 用户级装免提权（installPerMachineUser 默认面）。
    spawnImpl(dest, ['/CURRENTUSER']);
    return { status: 'spawned', mode: 'installed' };
  } catch (error) {
    return { status: 'error', message: `更新器拉起失败：${messageOf(error)}` };
  }
}
