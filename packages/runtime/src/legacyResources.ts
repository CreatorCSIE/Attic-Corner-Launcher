/**
 * c0.24 家族死链声音预置（喂游戏自己的守卫 —— jar 一字节不改，零 JVM 语义注入）。
 *
 * 上游病灶（c0.24-dev8 `com/mojang/minecraft/ThreadDownloadResources` 字节码）：
 * `download(URL, File)` 首行守卫 = `new File(<gameDir> + file.getPath()).exists()`，在位即 return、
 * 一个请求都不发；`run()` 拼 19 条 URL（4 材质 × 4 序号 + calm1-3），host 是早已 404 的
 * `s3.amazonaws.com`，scheme 写死 https。URL 端键名 `newsound/step/wood1.ogg` 与落盘端
 * `resources/sound/step/wood1.ogg` **不同源** —— 所以改写 host、或去物化 `newsound/` 目录两条路都是死的。
 *
 * 两态行为（直调真实 jar 的 `run()`）：
 * - 空 gameDir：8-10s 后全部 `FileNotFoundException`，resources 零文件。真实请求只有 5 条
 *   （wood1-4 + calm1）——`run()` 的异常表是粗粒度的：step 段 wood/stone/grass/gravel 四次
 *   `download()` 共用一个 try，music 段 calm1-3 同理，wood1 一抛即整块跳出，
 *   stone/grass/gravel 与 calm2/calm3 连请求都发不出去。⇒ 损失不止刷日志：四材质脚步声只有
 *   wood 那条链有机会拿到文件，音乐只有 calm1 有机会。
 * - 预置 19 个键：40ms、零请求、守卫完全短路。
 *
 * 为什么不是「把 https 降级成 http」：legacyfix `GameArgs` 在无 `lf.proxy.disable` 时调
 * `URL.setURLStreamHandlerFactory(new LegacyURLStreamHandlerFactory())`，该工厂对 http 与 https
 * **都**返回自己的 Handler；JDK 8 一旦工厂设定即 `checkedWithFactory=true`，
 * `java.protocol.handler.pkgs` 分支整段被跳过（真实启动次序下自研的 https Handler
 * 类根本不载入）。抢注工厂则让 legacyfix 自己的调用抛 `Error("factory already defined")`，抢成功反而
 * 顶掉它那 12 条 https 重定向语义。⇒ 协议层无路，只剩数据层。
 *
 * 数据源：启动器已按资产索引下载的 `assets/objects/<2>/<hash>`（与 `-Dlf.assetsDir` 同源），
 * 不新增任何随包内置资源；对象缺席即跳过该键（补下是 `launch()` 既有 `downloadAssetObjects` 的职责）。
 *
 * 闸门两条，全是内容探测，**不写版本号**（`MinecraftDownload` 只出现在
 * c0.24 家族，其中 `c0.24_st*` 5 枚无 https → 判否不预置）：
 * 1) jar 中央目录里有资源下载线程类（`c0.24_dev1` 的类名是 `ResourceDownloadThread`，一并认）；
 * 2) jar 明文里有死链前缀常量。
 * 任何异常 = 不预置（维持现状）；本模块的失败绝不得阻断启动。
 */

import fs from 'node:fs';
import path from 'node:path';

import { planAssetObjects } from './legacyAssets';
import { listZipEntryNames, readZipEntries } from './zip';

/** 死链前缀 = 闸门标记；也是 19 条 URL 的生成基址（逐字符来自 jar 常量池）。 */
export const LEGACY_RESOURCE_PROBE_BASE = 'https://s3.amazonaws.com/MinecraftDownload/resources/';

/** 游戏侧落盘根目录名（字节码：`this.a = new File(gameDir, "resources/")`，守卫按 `gameDir + path` 比对）。 */
export const LEGACY_RESOURCES_DIR = 'resources';

/**
 * 预置数据表：[URL 前缀尾段, 资产索引 key 前缀（= 守卫路径去掉 `resources/` 后的尾段）, 序号上界]。
 * 序号上界取字节码循环界（step：`iconst_1`..`iconst_4`；music：`iconst_1`..`iconst_3`）。
 * 界写宽了多出的键永不命中（本地多几个没人读的文件），写窄了退回现状（未覆盖的探针仍走网络）——两向都无害。
 */
const LEGACY_RESOURCE_TABLE: readonly (readonly [string, string, number])[] = [
  ['newsound/step/wood', 'sound/step/wood', 4],
  ['newsound/step/stone', 'sound/step/stone', 4],
  ['newsound/step/grass', 'sound/step/grass', 4],
  ['newsound/step/gravel', 'sound/step/gravel', 4],
  ['music/calm', 'music/calm', 3],
];

/** 资源下载线程类（闸门阶段一）：c0.24 家族存在两代类名，一并认。 */
const PROBE_CLASS_RE = /(?:ThreadDownloadResources|ResourceDownloadThread)\.class$/;

/** 文件在位则返回字节数，否则 null（闸门与预置共用，不抛错）。 */
function fileSizeIfPresent(file: string): number | null {
  try {
    const st = fs.statSync(file);
    return st.isFile() ? st.size : null;
  } catch {
    return null;
  }
}

/**
 * 闸门：jar 内容探测（两阶段，先廉价后昂贵）。
 * 阶段一只读中央目录（不解压）；阶段二解压找死链前缀常量。任何异常 = false（维持现状）。
 */
export function hasLegacyResourceProbes(jarFile: string): boolean {
  try {
    if (!fs.existsSync(jarFile)) return false;
    if (!listZipEntryNames(jarFile).some((name) => PROBE_CLASS_RE.test(name))) return false;
    const marker = Buffer.from(LEGACY_RESOURCE_PROBE_BASE, 'latin1');
    return readZipEntries(jarFile).some((entry) => entry.data.includes(marker));
  } catch {
    return false;
  }
}

/** 探针行（19 条：4 材质 × 4 序号 + 3 首音乐）。纯函数，单测直接对数。 */
export function legacyResourceRows(): { url: string; key: string }[] {
  const rows: { url: string; key: string }[] = [];
  for (const [urlPart, keyPart, count] of LEGACY_RESOURCE_TABLE) {
    for (let n = 1; n <= count; n++) {
      rows.push({ url: `${LEGACY_RESOURCE_PROBE_BASE}${urlPart}${n}.ogg`, key: `${keyPart}${n}.ogg` });
    }
  }
  return rows;
}

/** 一条可预置项：本地对象 → 游戏守卫读的落盘位置。 */
export interface LegacyResourceEntry {
  /** 资产索引 key（POSIX 形态，如 `sound/step/wood1.ogg`）。 */
  key: string;
  /** 源：`assets/objects/<2 位前缀>/<hash>` 绝对路径。 */
  source: string;
  /** 目标：`<gameDir>/resources/<key>` 绝对路径。 */
  target: string;
  /** 索引声明的字节数（幂等判定与尺寸不符时的重写依据）。 */
  size: number;
}

/**
 * 预置计划：只产出「索引里有该键 + 本地对象在位且尺寸相符」的条目。
 * 缺席键由调用方按 `rows.length - entries.length` 得知（不静默，见 materialize 的诊断）。
 */
export function planLegacyResources(options: {
  indexJson: unknown;
  assetsRoot: string;
  gameDir: string;
  /** 注入用（单测）：对象文件 → 字节数 | null。 */
  sizeOf?: (file: string) => number | null;
  /** 注入用（单测）：目标文件 → 字节数 | null。 */
  targetSizeOf?: (file: string) => number | null;
}): { entries: LegacyResourceEntry[]; total: number } {
  const sizeOf = options.sizeOf ?? fileSizeIfPresent;
  const rows = legacyResourceRows();
  const byKey = new Map(rows.map((row) => [row.key, row]));
  const entries: LegacyResourceEntry[] = [];
  for (const obj of planAssetObjects(options.indexJson)) {
    const row = byKey.get(obj.key);
    if (!row) continue;
    const source = path.join(options.assetsRoot, ...obj.relPath.split('/'));
    if (sizeOf(source) !== obj.size) continue;
    entries.push({ key: obj.key, source, size: obj.size, target: legacyTargetFile(options.gameDir, obj.key) });
  }
  return { entries, total: rows.length };
}

/** `<gameDir>/resources/<key>`（守卫路径逐字符对齐字节码：`gameDir` + `resources/...`）。 */
export function legacyTargetFile(gameDir: string, key: string): string {
  return path.join(gameDir, LEGACY_RESOURCES_DIR, ...key.split('/'));
}

/** 预置结果计数（诊断与单测共用）。 */
export interface LegacyResourceOutcome {
  /** 应覆盖的探针键数（19）。 */
  total: number;
  /** 本地对象就绪、可预置的键数。 */
  ready: number;
  /** 本次实际写入的条目数。 */
  copied: number;
  /** 目标已在位且尺寸相符，未动的条目数（幂等路径）。 */
  skipped: number;
  /** 目标在位但尺寸不符（半截毒文件），被重写的条目数。 */
  replaced: number;
  /** 索引缺键或本地对象缺席/尺寸不符的键数（这些探针退回现状：发请求拿 404）。 */
  missing: number;
}

/**
 * 幂等物化到 `<gameDir>/resources/`。语义：
 * - 目标已在位且尺寸相符 → 不动（用户目录里的既有文件不覆盖，重复启动零写入）；
 * - 目标缺席或尺寸不符 → temp + rename 原子写入（半截文件正是游戏守卫认不出的那种毒状态）；
 * - 单条失败只跳过该键，其余继续；整体异常返回 null。调用方（`launch()`）任何结果都不得中断启动。
 */
export function materializeLegacyResources(options: {
  indexJson: unknown;
  assetsRoot: string;
  gameDir: string;
  onDiagnostic?: (message: string) => void;
  sizeOf?: (file: string) => number | null;
  targetSizeOf?: (file: string) => number | null;
}): LegacyResourceOutcome | null {
  const say = (message: string): void => options.onDiagnostic?.(message);
  try {
    const { entries, total } = planLegacyResources(options);
    const targetSizeOf = options.targetSizeOf ?? fileSizeIfPresent;
    const outcome: LegacyResourceOutcome = {
      total,
      ready: entries.length,
      copied: 0,
      skipped: 0,
      replaced: 0,
      missing: total - entries.length,
    };
    for (const entry of entries) {
      const tmp = `${entry.target}.attic-tmp`;
      try {
        const present = targetSizeOf(entry.target);
        if (present === entry.size) {
          outcome.skipped += 1;
          continue;
        }
        fs.mkdirSync(path.dirname(entry.target), { recursive: true });
        fs.copyFileSync(entry.source, tmp);
        fs.renameSync(tmp, entry.target); // win32 rename 替换既存文件（MOVEFILE_REPLACE_EXISTING）
        if (targetSizeOf(entry.target) !== entry.size) {
          say(`[attic-runtime] legacy resource 落位自检失败（${entry.key}）`);
          continue;
        }
        if (present === null) outcome.copied += 1;
        else outcome.replaced += 1;
      } catch (error) {
        // temp 清理是尽力而为：祖先链本身不可操作时（gameDir 被文件占位）rmSync 在 POSIX 抛
        // ENOTDIR（force 只吞 ENOENT）——若让它穿出，逐条 fail-open 就塌成整体 null。
        try {
          fs.rmSync(tmp, { force: true });
        } catch {
          /* 清不掉也无妨：该键下次预置仍走同路径 temp+rename 覆盖 */
        }
        say(`[attic-runtime] legacy resource 预置失败（${entry.key}）：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (outcome.ready === 0) {
      say(`[attic-runtime] legacy resources: 本地对象 0/${total} 就绪，维持现状：${options.gameDir}`);
    } else {
      say(
        `[attic-runtime] legacy resources: ${outcome.ready}/${total} 预置到 ${path.join(options.gameDir, LEGACY_RESOURCES_DIR)}` +
          `（写入 ${outcome.copied}，修复 ${outcome.replaced}，已在位 ${outcome.skipped}，缺席 ${outcome.missing}）`,
      );
    }
    return outcome;
  } catch (error) {
    say(`[attic-runtime] legacy resources 预置异常，维持现状：${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}
