/**
 * Mods 仓库（Betacraft 单源）——列表解析、安装登记、启动期刷新与基座合成。
 * 上游事实源：v1 ModsRepository.java（getmods.jsp JSON：mod_category/mods[5 字段]）、
 * Launcher.java L409-429（autoupdate 消费）、L793-876（mod jar → versions/mods/ → rezip 合成）。
 * v1 缺陷的结构性修复：
 * - loadMods 追加不清空/进程内永不刷新 → 本模块无进程内列表缓存，每次调用现拉；
 * - mods=null 分类 NPE（ModsRepository L141）→ 解析剔除；
 * - 离线时已安装 mod 被误路由官方默认 URL（L410-414）→ launcher/mods.json 持久登记；
 * - 下载失败毁旧文件（backup.tmp 固定名互踩）→ tmp+rename 原子写，失败原文件不动；
 * - 陈旧合成 jar 失配（hasJar 判定）→ 每次启动重合成；
 * - mod jar 下载后不验 sha1（hash_sha1 死代码）→ 必带哈希下载 + 本地复用先比对。
 */

import * as fs from 'fs';
import * as path from 'path';
import type { DownloadItem, ModCategoryRaw, ModEntryRaw, VersionJson } from '@attic/core-spec';
import { infoFile, modRegistryFile } from './storage';
import { readZipEntries, writeZipEntries, type ZipEntry } from './zip';

/** 最小下载面（BetacraftClient 结构化满足；type-free 依赖避免 betacraft↔mods 循环）。 */
export interface Downloader {
  download(
    url: string,
    destFile: string,
    item: DownloadItem,
    id: string,
    hash?: { algo: 'sha1' | 'sha256'; value: string },
  ): Promise<void>;
}

// ---------- 上游列表解析 ----------

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/**
 * getmods.jsp JSON → ModCategoryRaw[]（防御式：坏条目剔除、坏分类剔除；顶层非数组 = 上游
 * 形状崩坏，显式抛错——UI 空态+重试，不静默出半截列表）。
 */
export function parseModCategories(raw: string): ModCategoryRaw[] {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Mod 仓库列表不是有效 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(data)) throw new Error('Mod 仓库列表格式异常：顶层不是数组');
  const out: ModCategoryRaw[] = [];
  for (const cat of data) {
    if (cat === null || typeof cat !== 'object') continue;
    const name = str((cat as Record<string, unknown>).mod_category);
    const modsRaw = (cat as Record<string, unknown>).mods;
    if (!name || !Array.isArray(modsRaw)) continue; // mods 缺失/null = v1 NPE 源，整类剔除
    const mods: ModEntryRaw[] = [];
    for (const m of modsRaw) {
      if (m === null || typeof m !== 'object') continue;
      const e = m as Record<string, unknown>;
      const fullName = str(e.full_name);
      const infoFileUrl = str(e.info_file_url);
      if (!fullName || !infoFileUrl) continue; // 必填缺 = 装不动的条目，剔除
      const website = str(e.website);
      mods.push({
        fullName,
        version: str(e.version) ?? fullName, // v1 树节点显示 version；缺时以 full_name 兜底
        infoFileUrl,
        ...(website ? { website } : {}),
        autoupdate: e.autoupdate === true,
      });
    }
    if (mods.length === 0) continue; // 空分类无展示价值
    out.push({ name, mods });
  }
  return out;
}

// ---------- 安装登记（launcher/mods.json） ----------

export interface ModRegistryEntry {
  /** 安装当时的 .info 直链（autoupdate 刷新唯一入口，不走官方默认 URL）。 */
  infoUrl: string;
  autoupdate: boolean;
  installedAt: number;
}
export type ModRegistry = Record<string, ModRegistryEntry>;

/** 读登记（缺失/坏文件 = 空表；逐条形状校验，脏条目丢弃）。 */
export function readModRegistry(root: string): ModRegistry {
  try {
    const data = JSON.parse(fs.readFileSync(modRegistryFile(root), 'utf8')) as unknown;
    if (data === null || typeof data !== 'object' || Array.isArray(data)) return {};
    const out: ModRegistry = {};
    for (const [id, v] of Object.entries(data as Record<string, unknown>)) {
      if (v === null || typeof v !== 'object') continue;
      const e = v as Record<string, unknown>;
      if (typeof e.infoUrl !== 'string' || e.infoUrl === '') continue;
      out[id] = { infoUrl: e.infoUrl, autoupdate: e.autoupdate === true, installedAt: Number(e.installedAt) || 0 };
    }
    return out;
  } catch {
    return {};
  }
}

/** 登记写回（「失败不留半截」纪律：tmp+rename，与 .info 原子写同配方）。 */
function writeModRegistry(root: string, reg: ModRegistry): void {
  const file = modRegistryFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(reg, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
}

export function upsertModRegistry(root: string, id: string, entry: ModRegistryEntry): void {
  const reg = readModRegistry(root);
  reg[id] = entry;
  writeModRegistry(root, reg);
}

/** 删除登记条目（不存在 = 静默）：自定义版本页删 mod 时联动调用，防 mods.json 幽灵条目。 */
export function removeModRegistry(root: string, id: string): void {
  const reg = readModRegistry(root);
  if (!(id in reg)) return;
  delete reg[id];
  writeModRegistry(root, reg);
}

// ---------- .info 原子落盘 ----------

/** properties 样貌底线（至少一条 `key:`/`key=` 属性行）：404-HTML/空页不进 versions/jsons。 */
function assertInfoPlausible(text: string, url: string): void {
  if (text.trim() === '' || !/^[^#\s=]+[=:]/m.test(text)) {
    throw new Error(`.info 内容异常（非属性文件样貌）：${url}`);
  }
}

/**
 * 下载 .info 到 versions/jsons/<id>.info：先落 <dest>.tmp、验内容样貌、rename 覆盖。
 * 失败/中断 = 旧文件原样保留（v1 backup.tmp 固定名互踩的结构性替代；id 安全性由调用方把关）。
 */
export async function downloadInfoAtomic(client: Downloader, root: string, id: string, url: string): Promise<void> {
  const dest = infoFile(root, id);
  const tmp = `${dest}.tmp`;
  fs.rmSync(tmp, { force: true });
  try {
    await client.download(url, tmp, 'version-json', id);
    assertInfoPlausible(fs.readFileSync(tmp, 'utf8'), url);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(tmp, dest); // win32 rename 替换既存文件（MOVEFILE_REPLACE_EXISTING）
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
}

/**
 * 启动期 mod .info 刷新（v1 Launcher.java L417-426 语义；离线不得静默失败）：
 * autoupdate 或本地缺失才拉；网络失败但本地存在 = 留旧文件离线启动（v1 FAILED_WITH_BACKUP 放行）；
 * 本地也缺失 = 异常上抛（点 Play 可见失败，不假可用）。
 */
export async function refreshModInfo(
  client: Downloader,
  root: string,
  versionId: string,
  entry: ModRegistryEntry,
): Promise<void> {
  const hasLocal = fs.existsSync(infoFile(root, versionId));
  if (!entry.autoupdate && hasLocal) return;
  await downloadInfoAtomic(client, root, versionId, entry.infoUrl);
}

// ---------- 基座合成（v1 readyVersion + Util.rezip 语义） ----------

/** mod .info 判型（v1：base-version 键存在即 mod；自定义版本页的 custom=true 与它正交）。 */
export function isModVersionJson(json: VersionJson): string | undefined {
  return json.betacraft?.baseVersion?.trim() || undefined;
}

/**
 * 合成 mod jar：基座条目在前、mod 条目同名覆盖（v1 Util.rezip 解压序），
 * 剥离签名文件（META-INF 直接子级 *.SF/*.DSA/*.RSA/*.EC，保留 MANIFEST.MF 与嵌套资源——
 * v1 连 MANIFEST.MF 一起丢是过宽，正确口径 = 只剥 META-INF/* 签名）。
 * 整包内存重建（远古 jar 十 MB 级；zip.ts 既有纪律）。输出原子：tmp+rename。
 */
export function composeModJars(baseJar: string, modJar: string, destJar: string): void {
  const byName = new Map<string, ZipEntry>();
  for (const e of readZipEntries(baseJar)) byName.set(e.name, e);
  for (const e of readZipEntries(modJar)) byName.set(e.name, e); // mod 胜出（v1 覆盖序）
  const entries = [...byName.values()].filter((e) => !/^META-INF\/[^/]+\.(SF|DSA|RSA|EC)$/i.test(e.name));
  const tmp = `${destJar}.tmp`;
  try {
    fs.mkdirSync(path.dirname(destJar), { recursive: true });
    writeZipEntries(tmp, entries);
    fs.renameSync(tmp, destJar);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
}

/** mod 启动前合成缺料的显式诊断（v1「假可用」不可重演：绝不带残缺进 spawn）。 */
export function modMissingMessage(json: VersionJson, baseId: string, reason: string): string {
  return `Mod ${json.id}（基座 ${baseId}）缺基座合成：${reason}`;
}
