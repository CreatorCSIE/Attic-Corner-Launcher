/**
 * BC 基础库集（depends）—— v1 checkDepends/downloadDepends 移植（Launcher.java L862-951）。
 *
 * 为什么是 v1 通道而非只修 Mojang 回填：
 * BC 的 libs-<os>.zip 里是 **patched** 的 lwjgl.jar / lwjgl_util.jar / jinput.jar
 * （鼠标抓取、AMD 云等修复编进 jar 本体），Mojang 重发布只有 2.9.0 原版。
 * 炸法：库池缺 org.lwjgl.LWJGLException 类时，legacyfix Agent.premain 的
 * CtTransformer 重定义循环只 catch ClassNotFoundException（Agent.java L80），
 * NoClassDefFoundError 属 LinkageError 直接穿透 → `processing of -javaagent failed` 秒崩。
 *
 * 两通道关系（2026-11-04 更新）：depends 铺 BC 基础库集（全版本恒定）即库池唯一供给方；
 * Mojang 回填通道已退役（重发布库集 = 1.6 时代 wrapper boilerplate，真依赖 lwjgl/jinput
 * 本族被污染闸门跳过，其余 launchwrapper 族触发 fork agent 探测劫持，账见 plan.md）。
 *
 * 对 v1 的语义强化（原缺陷，逐条）：
 * - v1 先写 settings 版本号再解压 zip（L933-949）——中途失败留下"半套库集 + 假指纹"，
 *   此后 checkDepends 恒过；改为解包成功后才写版本号，失败下次重拉自愈。
 * - v1 空判定 `listFiles().length <= 1`（L880-883，.DS_Store 类残留即可误判）；
 *   改为 bin 至少一个 .jar + natives 至少一个文件。
 * - v1 checkDepends 网络异常 assume-all-good（L899-903）：保留（本地有库集不拦启动）；
 *   本地为空且拿不到版本号 → 失败（v1 弹框拒绝启动语义）。forceUpdate 时版本号拿不到
 *   无从核对目标，直接失败而非静默跳过。
 */

import fs from 'node:fs';
import path from 'node:path';

import type { JavaArchitecture } from '@attic/core-spec';
import type { DependsOs, Endpoints } from './endpoints';
import { binDir, launcherDir, nativesDir } from './storage';
import { extractZipTo } from './zip';

/** depends-version.txt 的两枚版本号（值是不透明字符串，v1 只做等值比较）。 */
export interface DependsVersion {
  libs: string;
  natives: string;
}

/** Node platform → v1 的 depends 平台轴。 */
export function dependsOsFor(platform: NodeJS.Platform): DependsOs {
  return platform === 'win32' ? 'windows' : platform === 'darwin' ? 'osx' : 'linux';
}

/** 解析 `libs-version:N` / `natives-version:M` 两行（Java properties 形状，取首个冒号）。 */
export function parseDependsVersion(text: string): DependsVersion {
  let libs: string | undefined;
  let natives: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    const key = line.slice(0, i).trim();
    const value = line.slice(i + 1).trim();
    if (key === 'libs-version') libs = value;
    else if (key === 'natives-version') natives = value;
  }
  if (!libs || !natives) throw new Error(`depends-version.txt 形状异常：${JSON.stringify(text.slice(0, 120))}`);
  return { libs, natives };
}

/** 本地基础库集在位：bin 至少一个 jar + bin/natives 至少一个文件。 */
export function hasLocalDepends(root: string): boolean {
  let jars = 0;
  try {
    jars = fs.readdirSync(binDir(root)).filter((f) => f.toLowerCase().endsWith('.jar')).length;
  } catch {
    return false;
  }
  if (jars === 0) return false;
  try {
    return fs.readdirSync(nativesDir(root)).length > 0;
  } catch {
    return false;
  }
}

/**
 * 现物核对：本地库集非空，且（remote 缺省 = 不比版本号，v1 assume-all-good 语义；
 * 否则 settings 记录的两枚版本号与 remote 等值）。
 */
export function isDependsCurrent(
  root: string,
  settings: Record<string, string>,
  remote: DependsVersion | null,
): boolean {
  if (!hasLocalDepends(root)) return false;
  if (!remote) return true;
  return settings['libs-version'] === remote.libs && settings['natives-version'] === remote.natives;
}

/** IO 注入面（测试可全 mock；生产由 AtticRuntime 桥到 client/fetch/settings）。 */
export interface DependsIO {
  root: string;
  os: DependsOs;
  /** 当前 launcher.settings 扁平视图（只读两枚版本号键）。 */
  settings: Record<string, string>;
  fetchText(url: string): Promise<string>;
  /** 二进制下载落 destFile（进度事件走调用方既有 download 通道）。 */
  download(url: string, destFile: string, id: string): Promise<void>;
  /** 版本号键合并回写（实现方负责保留未知键）。 */
  saveVersionKeys(keys: Record<string, string>): void;
}

/**
 * 启动链维护点：核对/拉取 libs+natives zip → 清空重解 bin/ → 成功后登记版本号。
 * 幂等：版本一致直接返回；失败抛错由启动链统一呈现。
 */
export async function ensureDepends(
  io: DependsIO,
  endpoints: Endpoints,
  opts: { force?: boolean } = {},
): Promise<void> {
  let remote: DependsVersion | null = null;
  try {
    remote = parseDependsVersion(await io.fetchText(endpoints.dependsVersion));
  } catch {
    remote = null;
  }
  if (!opts.force && isDependsCurrent(io.root, io.settings, remote)) {
    dropStaleZips(io.root);
    return;
  }
  if (!remote) {
    // 拿不到版本号：本地已有库集且非强更 → v1 assume-all-good，不拦启动。
    if (!opts.force && isDependsCurrent(io.root, io.settings, null)) {
      dropStaleZips(io.root);
      return;
    }
    throw new Error('无法获取 depends-version.txt，且本地 BC 基础库集（libs/natives）缺失或需强制更新——无法完成');
  }

  // v1 L922-930 同位：zip 暂存 launcher/（同名覆盖）；v1 Util.unzip(delete=true)
  // 解包后即删源 zip（Util.java L259-263）——照做，解包成功后清理。
  const libsZip = path.join(launcherDir(io.root), 'libs.zip');
  const nativesZip = path.join(launcherDir(io.root), 'natives.zip');
  await io.download(endpoints.libsZip(io.os), libsZip, 'libs.zip');
  await io.download(endpoints.nativesZip(io.os), nativesZip, 'natives.zip');

  // v1 L943-949：清空 bin（含 natives 子目录）再解包；版本号写在解包成功之后。
  // strictMethods：罕见压缩法抛错中断（版本号不落）——静默跳过会产半套库集 + 指纹恒过。
  removeContents(binDir(io.root));
  fs.mkdirSync(nativesDir(io.root), { recursive: true });
  extractZipTo(nativesZip, nativesDir(io.root), { strictMethods: true });
  extractZipTo(libsZip, binDir(io.root), { strictMethods: true });
  dropStaleZips(io.root);
  io.saveVersionKeys({ 'libs-version': remote.libs, 'natives-version': remote.natives });
}

/** v1 unzip(delete=true) 语义：解包后删暂存 zip；幂等路径顺带清扫残留 zip。 */
function dropStaleZips(root: string): void {
  for (const name of ['libs.zip', 'natives.zip']) {
    fs.rmSync(path.join(launcherDir(root), name), { force: true });
  }
}

function removeContents(dir: string): void {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    fs.rmSync(path.join(dir, entry.name), { recursive: true, force: true });
  }
}

// ---------- LWJGL2 原生库架构闸门 ----------

/**
 * LWJGL 2.x 官方从未发布 arm64/armhf 原生库（2015 停维，桌面 arm64 当时不存在）；
 * BC depends 现状：natives-windows/linux = x86+x64 双份，
 * natives-osx = 单文件 liblwjgl.dylib（x86_64，ODDLABS 老签名）——三平台零 arm 覆盖。
 * 平台结论：
 * - Windows arm64：系统自带 x64 模拟（x64 JDK8 + lwjgl64.dll 可跑）→ 不拦。
 * - Linux arm/arm64：无系统级 x64 模拟、无 arm64/armhf .so → 一律拦（明示暂不支持）。
 * - macOS arm64（Apple Silicon）：x86_64 JDK 经 Rosetta 2 可跑（选择逻辑架构偏好
 *   x86_64 > x86 > arm64 已天然优先命中）；arm64 JVM 加载 x86_64 dylib 必
 *   UnsatisfiedLinkError → 拦并指路。jvmArch=null（探测失败/未知）放行不误杀。
 * 返回 null = 放行；返回文案 = 拒绝启动（调用方抛错，走既有启动失败呈现）。
 */
export function checkLwjgl2Arch(
  platform: NodeJS.Platform,
  hostArch: string,
  jvmArch: JavaArchitecture | null,
): string | null {
  if (platform === 'win32') return null;
  if (hostArch !== 'arm64' && hostArch !== 'arm') return null;
  if (platform === 'linux') {
    return 'LWJGL 2 在 Linux arm/arm64 无可用原生库（官方从未发布 arm64/armhf 构建），暂不支持启动历史版本；x86_64 机器不受影响。';
  }
  if (platform === 'darwin' && (jvmArch === 'arm64' || jvmArch === 'arm')) {
    return 'Apple Silicon 的 arm64 Java 无法加载 LWJGL 2 原生库（仅有 x86_64 构建）：请安装 x86_64 架构的 Java 8（经 Rosetta 2 运行，未装时终端执行 softwareupdate --install-rosetta），并在设置页指定该 Java。';
  }
  return null;
}
