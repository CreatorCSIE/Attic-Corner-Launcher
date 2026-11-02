/**
 * 远古 Java 供给通道：Azul Zulu 元数据 API 查 JDK 6/7/8 归档包，
 * 下载 zip + sha256 校验 + 解压（win 用 powershell Expand-Archive，posix 用 unzip）。
 * 失败返回原因——手动导入兜底永远存在（探测失败面板给全候选与原因）。
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import type { DownloadProgressEvent } from '@attic/core-spec';

import { BetacraftClient, type FetchImpl } from './betacraft';
import type { Endpoints } from './endpoints';

const execFileAsync = promisify(execFile);

export interface ZuluPackage {
  name: string;
  url: string;
  sha256?: string;
}

export interface ZuluInstallOutcome {
  ok: boolean;
  javaPath?: string;
  reason?: string;
}

export function zuluOs(platform: string): 'win' | 'linux' | 'macos' {
  if (platform === 'win32') return 'win';
  if (platform === 'darwin') return 'macos';
  return 'linux';
}

export function zuluArch(arch: string): 'x64' | 'aarch64' | 'x86' {
  if (arch === 'arm64') return 'aarch64';
  // ia32/x86 → Zulu 32 位构建（win_x86 / linux_i386，JDK 8 均有 GA）。
  // IA32 Legacy 壳在无 WOW64 的 32 位 OS 上必须取 x86 包：x64 构建 spawn 即挂。
  if (arch === 'ia32' || arch === 'x86') return 'x86';
  return 'x64';
}

/**
 * 自动供给的宿主位宽判定（与 zuluArch 分工：本函数答"宿主能给什么位宽的 JVM 跑"，
 * zuluArch 答"API 参数怎么写"）。ia32 进程在 64 位 OS 上以 WOW64 逃逸变量
 * PROCESSOR_ARCHITEW6432 为凭（真 32 位 OS 永不存在该变量）：逃逸在场 = 宿主 64 位，
 * 取 x64（32 位壳 spawn 64 位 JVM 合法）；缺席 = 真 32 位 OS（Vista/XP x86，
 * Legacy 构建的目标段），取 x86。
 */
export function provisionArch(platform: string, processArch: string, env: NodeJS.ProcessEnv): string {
  if (platform === 'win32' && processArch === 'ia32') {
    return env.PROCESSOR_ARCHITEW6432 ? 'x64' : 'x86';
  }
  return processArch;
}

/** 查询指定 JDK 大版本的最新 GA 包（按 os/arch 过滤，zip 归档）。 */
export async function queryZuluPackages(
  javaVersion: number,
  endpoints: Endpoints,
  fetchImpl: FetchImpl,
  platform: string,
  arch: string,
): Promise<ZuluPackage[]> {
  const params = new URLSearchParams({
    java_version: String(javaVersion),
    os: zuluOs(platform),
    arch: zuluArch(arch),
    archive_type: 'zip',
    java_package_type: 'jdk',
    latest: 'true',
    release_status: 'ga',
  });
  const res = await fetchImpl(`${endpoints.zuluMetadata}?${params.toString()}`);
  if (!res.ok) throw new Error(`Zulu 元数据 API HTTP ${res.status}`);
  // 真实 API 字段是 download_url（只认 url 会全数筛掉、自动供给静默失效）；
  // url 保留为回退。
  const data = (await res.json()) as { name?: string; url?: string; download_url?: string; sha256?: string }[];
  const out: ZuluPackage[] = [];
  for (const entry of data) {
    const dl = entry.download_url ?? entry.url;
    if (!entry.name || !dl) continue;
    out.push({ name: entry.name, url: dl, ...(entry.sha256 ? { sha256: entry.sha256 } : {}) });
  }
  return out;
}

/** 解压 zip：win 走 powershell Expand-Archive，其余走 unzip。 */
async function extractZip(zipPath: string, destDir: string, platform: string): Promise<void> {
  fs.mkdirSync(destDir, { recursive: true });
  if (platform === 'win32') {
    await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`,
      ],
      { windowsHide: true, timeout: 300_000 },
    );
  } else {
    await execFileAsync('unzip', ['-o', '-q', zipPath, '-d', destDir], { timeout: 300_000 });
  }
}

/**
 * 在解压根向下至多两层找 bin/java；也用于供给缓存命中检查（已装则免重下）。
 * 两层是必须的：Zulu zip 顶层目录与包同名，解压后真实形态为 destRoot/<name>/<name>/bin/java
 * （只查一层 = 缓存永不命中、每次启动重下 111MB）。
 */
export function findJavaExecutable(dir: string, platform: string): string | null {
  const binary = platform === 'win32' ? 'java.exe' : 'java';
  const check = (d: string): string | null => {
    const p = path.join(d, 'bin', binary);
    return fs.existsSync(p) ? p : null;
  };
  const direct = check(dir);
  if (direct) return direct;
  let level1: string[];
  try {
    level1 = fs.readdirSync(dir);
  } catch {
    return null;
  }
  for (const entry of level1) {
    const d1 = path.join(dir, entry);
    const found = check(d1);
    if (found) return found;
    let level2: string[];
    try {
      level2 = fs.readdirSync(d1);
    } catch {
      continue; // 普通文件（如残留 zip）ENOTDIR = 跳过
    }
    for (const sub of level2) {
      const found2 = check(path.join(d1, sub));
      if (found2) return found2;
    }
  }
  return null;
}

/** 下载 + 校验 + 解压一个 Zulu 包，返回 java 可执行路径；失败带原因。 */
export async function installZuluPackage(
  pkg: ZuluPackage,
  destRoot: string,
  deps: {
    client: BetacraftClient;
    platform?: string;
    onProgress?: (event: DownloadProgressEvent) => void;
    /** 取消信号：中止 111MB 级 zip 下载。 */
    signal?: AbortSignal;
  },
): Promise<ZuluInstallOutcome> {
  const platform = deps.platform ?? process.platform;
  const zipPath = path.join(destRoot, pkg.name);
  const extractDir = path.join(destRoot, pkg.name.replace(/\.zip$/i, ''));
  try {
    fs.mkdirSync(destRoot, { recursive: true });
    await deps.client.download(
      pkg.url,
      zipPath,
      'java-runtime',
      pkg.name,
      pkg.sha256 ? { algo: 'sha256', value: pkg.sha256 } : undefined,
      deps.signal,
    );
    await extractZip(zipPath, extractDir, platform);
    const javaPath = findJavaExecutable(extractDir, platform);
    if (!javaPath) throw new Error(`解压后未找到 bin/java：${extractDir}`);
    return { ok: true, javaPath };
  } catch (error) {
    // 失败清理：半套 JDK 不得幸存——findJavaExecutable 两层扫描会命中残缺目录的
    // bin/java，供给缓存据此把坏 javaPath 当已装返回（zip 同理：下次直写覆盖不可依赖）。
    // rm 尽力而为（AV 瞬时锁不让清理炸掉失败归因路径，同 legacyfixPatch/CI 清理先例）。
    for (const p of [extractDir, zipPath]) {
      try {
        fs.rmSync(p, { recursive: true, force: true });
      } catch {
        /* 清理失败不影响本次失败返回 */
      }
    }
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
