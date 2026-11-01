/**
 * legacyfix jar DeAwtPatch 常量池补丁 —— applet 容器高 DPI 窗口偏右下的最小化修复。
 *
 * 机理（javap 字节码，LWJGL 2.9.0/2.9.3 同构）：
 * - DeAwtPatch.transformDisplay 用 javassist 把 Display.setParent 方法体整段替换为
 *   字符串常量（javac 编译期折叠为单个 CONSTANT_Utf8 条目）；注入体只设尺寸不设位置；
 * - Display.getWindowX/Y：静态字段 x==−1 才走居中公式 Math.max(0,(initial_mode −
 *   current_mode)/2)——initial=物理桌面、current=逻辑分辨率，高 DPI 混缩放下不同源，
 *   窗口偏右下（x!=−1 时直接返回 x，不进居中分支）；
 * - Display.setLocation(x,y)：无条件写 x/y 静态字段（与是否已创建无关），createWindow
 *   建窗时才经 getWindowX/Y 读取；且 DeAWT 替换体从不给 LWJGL 的 parent Canvas 字段
 *   赋值，getWindowX 必走 x/y 分支（javadoc 的 parented no-op 在此不成立）。
 *
 * 补丁 = 在注入体 setResizable 之前插入 `Display.setLocation(frame.getX(), frame.getY())`
 * （frame 局部变量已由 AppletLauncher setLocationRelativeTo(null) 定妥；未显示 Frame 的
 * getX/getY 仍返回显式设置值，getLocationOnScreen 会抛 InvalidComponentException 故不用）。
 * 坐标经 setLocation 写入 x/y → createWindow 原样采用，混源居中公式永不触达。
 * 注：DisplayMode 公开构造器仅 (w,h)（javadoc），坐标无构造器通道，setLocation 是唯一落点。
 *
 * 安全门（绝不静默降级）：
 * - SHA256 钉版：DeAwtPatch.class 明文字节必须在已验证表内，表外版本一律不碰
 *   （换 legacyfix 版本需实测锚点语义后在 PINNED_DEAWT_CLASS_SHA256 补一行）；
 * - 锚点全文唯一（恰 1 次出现且落在恰 1 个 Utf8 条目）才替换；
 * - 幂等：条目已含补丁串 → already，不重复改写（class 层函数同语拒绝再入）；
 * - 任何失败（含异常）→ 原 jar 原样保留，跳过 + 显式诊断（applet 容器维持原偏移行为）；
 * - class 文件常量池按索引引用、无绝对偏移依赖，改单个 Utf8 条目长度合法
 *   （补丁后 javap -v exit=0/常量池全量重解析验证）。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readZipEntries, writeZipEntries } from './zip';

const DEAWT_ENTRY = 'uk/betacraft/legacyfix/patch/impl/lwjgl/DeAwtPatch.class';

/** 折叠常量里的锚点：注入体尾两句（javassist 源字符串片段，ASCII）。 */
const ANCHOR = Buffer.from(
  'org.lwjgl.opengl.Display.setDisplayMode(new org.lwjgl.opengl.DisplayMode(child.getWidth(), child.getHeight()));',
  'latin1'
);
/** 补丁形态：setDisplayMode 与 setResizable 之间插入 setLocation 交接 frame 坐标。 */
const PATCHED = Buffer.from(
  'org.lwjgl.opengl.Display.setDisplayMode(new org.lwjgl.opengl.DisplayMode(child.getWidth(), child.getHeight()));org.lwjgl.opengl.Display.setLocation(frame.getX(), frame.getY());',
  'latin1'
);

/** 锚点语义已验证的 DeAwtPatch.class 明文 SHA256（hex 小写）。 */
const PINNED_DEAWT_CLASS_SHA256 = new Set([
  'bcf09fe03447d04fdd5c047e5b1954ec2021eb2957c8f12012f7a79496331b0e', // legacyfix.jar 2026-10 构件
  // 26.10 Release 构件：锚点恰 1 次、无补丁串（upstream 未合 setLocation，窗口补丁仍必要）；
  // 哈希与 2026-10-18 nightly 同值（0394721 起 DeAwtPatch.java 形态稳定）。
  'd1003d49a286c48696992427f63ac9d4efa105700c4fbf3b3d0d0156ece3b7ef',
]);

export type LfPatchOutcome =
  | { status: 'patched' }
  | { status: 'already' }
  | { status: 'skipped'; reason: string };

/** 统计 buf 中 needle 出现次数（上限 stopAt，防大 jar 空转）。 */
function countOccurrences(buf: Buffer, needle: Buffer, stopAt: number): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const idx = buf.indexOf(needle, from);
    if (idx < 0) return count;
    count++;
    if (count >= stopAt) return count;
    from = idx + 1;
  }
}

/**
 * 改写 class 字节：定位含 ANCHOR 的单个 CONSTANT_Utf8 条目，替换后重建（长度前缀同步）。
 * 返回 null = 不可安全补丁（锚点缺失/多条目命中/未知常量池 tag/超 65535）。
 */
export function patchDeawtClassBytes(classBytes: Buffer): Buffer | null {
  if (classBytes.length < 10 || classBytes.readUInt32BE(0) !== 0xcafebabe) return null;
  // 再入护栏：PATCHED 以 ANCHOR 为前缀，锚点计数在补丁态仍为 1——不显式拒绝会双重插入。
  if (classBytes.indexOf(PATCHED) >= 0) return null;
  if (countOccurrences(classBytes, ANCHOR, 2) !== 1) return null;

  const cpCount = classBytes.readUInt16BE(8);
  let p = 10;
  let target = -1; // 命中 Utf8 条目首字节（tag 处）
  let hits = 0;
  for (let i = 1; i < cpCount; i++) {
    const tag = classBytes[p];
    if (tag === 1) {
      const len = classBytes.readUInt16BE(p + 1);
      const content = classBytes.subarray(p + 3, p + 3 + len);
      if (content.indexOf(ANCHOR) >= 0) {
        hits++;
        target = p;
      }
      p += 3 + len;
    } else if (tag === 3 || tag === 4 || tag === 9 || tag === 10 || tag === 11 || tag === 12) {
      p += 5;
    } else if (tag === 5 || tag === 6) {
      p += 9;
      i++; // long/double 占两个常量池槽位
    } else if (tag === 7 || tag === 8 || tag === 16 || tag === 19 || tag === 20) {
      p += 3;
    } else if (tag === 15) {
      p += 4;
    } else if (tag === 17 || tag === 18) {
      p += 5;
    } else {
      return null; // 未知 tag：结构不可信，放弃
    }
    if (p > classBytes.length) return null;
  }
  if (hits !== 1 || target < 0) return null;

  const len = classBytes.readUInt16BE(target + 1);
  const content = Buffer.from(classBytes.subarray(target + 3, target + 3 + len));
  const idx = content.indexOf(ANCHOR);
  const replaced = Buffer.concat([
    content.subarray(0, idx),
    PATCHED,
    content.subarray(idx + ANCHOR.length),
  ]);
  if (replaced.length > 0xffff) return null;

  const lenBuf = Buffer.alloc(2);
  lenBuf.writeUInt16BE(replaced.length, 0);
  return Buffer.concat([
    classBytes.subarray(0, target + 1),
    lenBuf,
    replaced,
    classBytes.subarray(target + 3 + len),
  ]);
}

/**
 * 对 jar 原位应用 DeAwtPatch 窗口位置补丁（幂等；供 legacyfix jar 下载落位后调用）。
 * 永不抛错：任何失败 = 原 jar 保留 + skipped 诊断。pins 仅测试注入用，缺省走内置钉版表。
 */
export function applyLegacyfixDeawtPatch(
  jarPath: string,
  pins: Set<string> = PINNED_DEAWT_CLASS_SHA256
): LfPatchOutcome {
  try {
    if (!fs.existsSync(jarPath)) return { status: 'skipped', reason: 'jar 不存在' };
    const entries = readZipEntries(jarPath);
    const entry = entries.find((e) => e.name === DEAWT_ENTRY);
    if (!entry) return { status: 'skipped', reason: '无 DeAwtPatch.class 条目（非标准 legacyfix jar）' };

    if (entry.data.indexOf(PATCHED) >= 0) return { status: 'already' };
    const sha = crypto.createHash('sha256').update(entry.data).digest('hex');
    if (!pins.has(sha)) {
      return { status: 'skipped', reason: `DeAwtPatch.class 未钉版（sha256=${sha}），窗口位置补丁未应用` };
    }
    const patched = patchDeawtClassBytes(entry.data);
    if (!patched) return { status: 'skipped', reason: `锚点非唯一/常量池不可解析（sha256=${sha}）` };
    entry.data = patched;

    // 原子回写：temp 文件 + rename；随后重读自检（补丁串在，锚点仍恰 1 次——PATCHED 含锚点为前缀）。
    const tmp = `${jarPath}.deawt-patch.tmp`;
    writeZipEntries(tmp, entries);
    fs.renameSync(tmp, jarPath);
    const reread = readZipEntries(jarPath).find((e) => e.name === DEAWT_ENTRY);
    if (!reread || reread.data.indexOf(PATCHED) < 0 || countOccurrences(reread.data, ANCHOR, 2) !== 1) {
      return { status: 'skipped', reason: '回写自检失败（原形态不可确认）' };
    }
    return { status: 'patched' };
  } catch (error) {
    try {
      fs.rmSync(`${jarPath}.deawt-patch.tmp`, { force: true });
    } catch {
      /* temp 不存在 */
    }
    return { status: 'skipped', reason: `补丁异常，原 jar 保留：${error instanceof Error ? error.message : String(error)}` };
  }
}

/** 诊断输出统一走 [attic-runtime] 前缀（process.ts 同款通道，不静默）。 */
export function reportLegacyfixDeawtPatch(jarPath: string, outcome: LfPatchOutcome): void {
  if (outcome.status === 'patched') {
    console.log(`[attic-runtime] legacyfix deawt-patch applied: ${path.basename(jarPath)}（窗口偏右下修复）`);
  } else if (outcome.status === 'skipped') {
    console.log(`[attic-runtime] legacyfix deawt-patch skipped: ${outcome.reason}`);
  }
}
