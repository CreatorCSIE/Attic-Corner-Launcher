/**
 * WrapperDetector 移植（v1 WrapperDetector.java 逐字核对）：裸 jar custom 版本的启动方法检测。
 * 语义等价性：v1 testClass 用 Class.forName(name, false, loader) 只做类可解析性检查
 * （initialize=false，不执行静态块）→ 等价于 jar 内 `<类路径>.class` 条目存在性，无需解析字节码。
 * classRules 逐字移植 v1 数组——顺序即优先级，首个全规则命中的返回；`!` 前缀 = 类必须不存在
 * （v1 借此区分 classic 系三个变体）。
 * `4k` 规则剔除：4k-* 不依赖检测，走显式启动方法数据路径（launch-method=4k →
 * AppletLauncher + --appletClass M，见 launch.ts）。
 * 全不中 / jar 不可读 → 'custom'（v1 Error 7 语义：用户需手编 .info 配置 launch-method）。
 */

import { listZipEntryNames } from './zip';

/** [launch-method, 规则列表]——顺序 = v1 classRules 数组序（首个全命中即返回）。 */
const CLASS_RULES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['rd', ['com.mojang.rubydung.RubyDung']],
  ['mc', ['com.mojang.minecraft.RubyDung', 'com.mojang.minecraft.MinecraftApplet']],
  [
    'classic12a',
    [
      'com.mojang.minecraft.MinecraftApplet',
      'com.mojang.minecraft.server.MinecraftServer',
      '!com.mojang.minecraft.User',
    ],
  ],
  ['classic', ['com.mojang.minecraft.MinecraftApplet', '!com.mojang.minecraft.net.NetworkPlayer']],
  [
    'classic15a',
    [
      'com.mojang.minecraft.MinecraftApplet',
      'com.mojang.minecraft.net.NetworkPlayer',
      '!com.mojang.minecraft.e',
    ],
  ],
  ['classicmp', ['com.mojang.minecraft.MinecraftApplet', 'com.mojang.minecraft.net.NetworkPlayer']],
  ['indev', ['net.minecraft.client.MinecraftApplet']],
  ['1.6', ['net.minecraft.client.main.Main']],
];

function hasClass(entries: Set<string>, className: string): boolean {
  return entries.has(`${className.replace(/\./g, '/')}.class`);
}

/**
 * indev 混代探测（v1 Wrapper.loadClass 兜底探测同构语义）：BC 的 launch-method=indev
 * 一个值覆盖 2.0-preview→1.5.2，但 jar 形态分裂——早期 indev/infdev 仅含
 * net.minecraft.client.MinecraftApplet（无 main 入口），
 * beta+ 同时含 Minecraft.main()。返回 'main'|'applet'；jar 缺失/不可读/两类皆无 = null
 * （维持数据表默认，让显式错误可见）。
 */
export function probeIndevEntry(jarFile: string): 'main' | 'applet' | null {
  let entries: Set<string>;
  try {
    entries = new Set(listZipEntryNames(jarFile));
  } catch {
    return null;
  }
  if (entries.has('net/minecraft/client/Minecraft.class')) return 'main';
  if (entries.has('net/minecraft/client/MinecraftApplet.class')) return 'applet';
  return null;
}

/**
 * pre-Classic（rd 代）入口类探测：rd 系 jar 仅含 RubyDung 入口——rd-132211 形态只有
 * com.mojang.rubydung.RubyDung，后续 rd-1322xx 形态为 com.mojang.minecraft.RubyDung
 * （其 MinecraftApplet 是 0 字段空壳类，v3 GameClasses 以字段数过滤明确弃用）。
 * 26.8 AppletLauncher 候选表只认两个 MinecraftApplet 名，全部加载失败 = main 返回、
 * 进程 code=0 即退（静默秒退）；--appletClass 是唯一可用显式通道
 * （注入后窗口起来、游戏循环正常）。返回全限定类名；jar 不可读/皆无 = null（不注入）。
 */
export function probePreclassicEntry(jarFile: string): string | null {
  let entries: Set<string>;
  try {
    entries = new Set(listZipEntryNames(jarFile));
  } catch {
    return null;
  }
  for (const candidate of ['com.mojang.rubydung.RubyDung', 'com.mojang.minecraft.RubyDung']) {
    if (entries.has(`${candidate.replace(/\./g, '/')}.class`)) return candidate;
  }
  return null;
}

/** 检测 jar 的启动方法；不可读或全规则不中 = 'custom'。 */
export function detectLaunchMethod(jarFile: string): string {
  let entries: Set<string>;
  try {
    entries = new Set(listZipEntryNames(jarFile));
  } catch {
    return 'custom';
  }
  for (const [method, rules] of CLASS_RULES) {
    const passes = rules.every((rule) => {
      const negated = rule.startsWith('!');
      const present = hasClass(entries, negated ? rule.slice(1) : rule);
      return negated ? !present : present;
    });
    if (passes) return method;
  }
  return 'custom';
}

/**
 * 检测名（v1 classRules 原名）→ 主类表（LAUNCH_METHOD_MAIN_CLASS）合法值的归一。
 * v1 把检测名直接喂 wrapper 分支，而官方 .info 用的是另一套值名（c0.0.15a→
 * Classic15aWithSaving、c0.0.16a+→ClassicMpWithSaving、pc/rd 系→preclassic）；
 * 不归一则裸 jar 检测合成撞表外键 → "无法确定主类"，配置页预填值也永远命不中下拉。
 * `1.6`（net.minecraft.client.main.Main，1.9+ 形态）无合法目标名——BC 清单止步 1.5.2，
 * 故意不归一，维持显式报错（数据缺口可见，同 DL_ 纪律）；'4k' 检测规则已剔除（见文件头）。
 */
export function canonicalLaunchMethod(detected: string): string {
  switch (detected) {
    case 'rd':
    case 'mc':
      return 'preclassic';
    case 'classic15a':
      return 'Classic15aWithSaving';
    case 'classicmp':
      return 'ClassicMpWithSaving';
    default:
      // classic12a / classic / indev 在表内即合法名，原样通过
      return detected;
  }
}
