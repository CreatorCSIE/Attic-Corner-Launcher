/**
 * Betacraft 数据面客户端：版本清单 / 版本 .info / jar / 资产索引 / 库池下载。
 * 格式事实源：
 *   - version_list.txt：反引号分隔行，字段 0=id 1=other-name 2=compile-ms 3=release-ms [4=协议/标记]；
 *   - .info：Java properties（字段集见 info.ts）；
 *   - 全部 URL 经端点层；fetchImpl 可注入（测试/离线）。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { DownloadItem, DownloadProgressEvent, LibraryInfo, ModCategoryRaw, VersionEra, VersionJson, VersionRef } from '@attic/core-spec';

import { resolveEndpoints, type Endpoints } from './endpoints';

import { ASSET_INDEXES, planAssetObjects, resolveLaunchAssetIndexId } from './legacyAssets';
import { modMissingMessage, parseModCategories } from './mods';
import { assetIndexFile, assetsDir, binDir, clientJarFile, infoFile, modJarFile } from './storage';

export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

export interface BetacraftClientOptions {
  endpoints?: Partial<Endpoints>;
  fetchImpl?: FetchImpl;
  onProgress?: (event: DownloadProgressEvent) => void;
}

/** 年代分层：编译日期区间表（清单 release-date 对 rd- 等回填失真，compile-date 才可信）。 */
const ERA_TABLE: { from: number; era: VersionEra }[] = [
  { from: 0, era: 'pre-classic' },
  { from: Date.UTC(2009, 4, 17), era: 'classic' },
  { from: Date.UTC(2009, 11, 23), era: 'indev' },
  { from: Date.UTC(2010, 1, 27), era: 'infdev' },
  { from: Date.UTC(2010, 5, 28), era: 'alpha' },
  { from: Date.UTC(2010, 11, 20), era: 'beta' },
  // 边界钉在 rc2 与 tominecon 的 compile 空窗（rc2-1656=1321203394000 < 11-14 00:00
  // UTC=1321228800000 ≤ tominecon=1321267414000）：分组吃 compile 日期，按 1.0.0 官方
  // 发布日（11-18）定界会让 1.0.0 全族跌进 beta 桶。口径：rc 系属 beta 段（发布候选），
  // release 组自 tominecon/1.0.0 起；本边界只当 release 锚，rc 归属由 ERA_FIXUPS
  // 命名规则兜底（见其头注）。
  { from: Date.UTC(2011, 10, 14), era: 'release-1.0-1.5.2' },
];

export function eraForDate(ms: number | undefined): VersionEra | undefined {
  if (ms === undefined || !Number.isFinite(ms)) return undefined;
  let era: VersionEra | undefined;
  for (const row of ERA_TABLE) if (ms >= row.from) era = row.era;
  return era;
}

/** 清单数据缺陷矫正表（数据矫正，非客户端推断）。
 *  恶搞/开发版 compile+release 双 0 → eraForDate(0) 误归 Pre-Classic：
 *  - b1.2_02-dev-20110517：id 自带日期 2011-05-17 → 归 Beta，组内排在 b1.2_02 后；
 *  - 2.0-preview：取 2.0-red 编译时刻（1364841286000）前 1s → 归 Release，紧随其前。 */
const DATE_FIXUPS: Record<string, number> = {
  'b1.2_02-dev-20110517': Date.UTC(2011, 4, 17),
  '2.0-preview': 1364841285000,
};

/** 4k-* 单开年代组（Classic 之后展示）。
 *  1.0.0-rc* 钉回 beta：年代是系列/命名分类，日期只是近似——rc 系 compile 落在 beta 末位
 *  （b1.9-pre6，11-11）之后、1.0.0/tominecon 之前，纯日期边界无法同时满足「rc 归 beta +
 *  tominecon/1.0.0 归 release」，故 ERA_TABLE 边界只当 release 锚，rc 归属由命名规则兜底
 *  （同族：4k- 前缀、-renew 继承、DATE_FIXUPS，均为数据矫正而非客户端推断）。 */
const ERA_FIXUPS: { prefix: string; era: VersionEra }[] = [
  { prefix: '4k-', era: '4k' },
  { prefix: '1.0.0-rc', era: 'beta' },
];

export function parseVersionList(text: string): VersionRef[] {
  const refs: VersionRef[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const fields = trimmed.split('`');
    const id = fields[0];
    if (!id) continue;
    const rawCompile = Number(fields[2]);
    const rawRelease = Number(fields[3]);
    let compile = Number.isFinite(rawCompile) && rawCompile > 0 ? rawCompile : undefined;
    let release = Number.isFinite(rawRelease) && rawRelease > 0 ? rawRelease : undefined;
    const fix = DATE_FIXUPS[id];
    if (fix !== undefined && compile === undefined && release === undefined) {
      compile = fix;
      release = fix;
    }
    let era = eraForDate(compile ?? release);
    for (const f of ERA_FIXUPS) {
      if (id.startsWith(f.prefix)) era = f.era;
    }
    refs.push({
      id,
      repository: 'betacraft',
      displayName: fields[1] ? fields[1] : undefined,
      compileDate: compile,
      releaseDate: release,
      era,
      installed: false,
      protocol: fields[4] ? fields[4] : undefined,
    });
  }
  // `-renew` = BC 重传替身行，日期栏写法不一（c0.0.13a_03-renew 保原时刻；c0.30-c-1900-renew
  // 写重传时刻 2011-07-31 → eraForDate 误归 beta）。
  // 通用矫正 = 基名（去后缀）在清单 → 继承基名 compile/release/era；基名缺席保持本行原样。
  // 数据驱动矫正，非客户端版本推断（同 DATE_FIXUPS/ERA_FIXUPS 层级）。
  const byId = new Map(refs.map((ref) => [ref.id, ref]));
  for (const ref of refs) {
    if (!ref.id.endsWith('-renew')) continue;
    const base = byId.get(ref.id.slice(0, -'-renew'.length));
    if (!base) continue;
    ref.compileDate = base.compileDate;
    ref.releaseDate = base.releaseDate;
    ref.era = base.era;
  }
  return refs;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 取消中止错误：signal.reason 优先，缺省 DOMException AbortError 形态。 */
function abortError(signal: AbortSignal): Error {
  const reason = signal.reason as Error | undefined;
  if (reason instanceof Error) return reason;
  return new Error('aborted');
}

/**
 * 启动期清扫下载残留 `.part`：进程被杀留下的半截文件。dest 侧「存在=复用」
 * 判据已不被 .part 污染（原子写），清扫纯属回收磁盘；depth=目录递归层数。
 */
export function sweepPartFiles(dir: string, depth: number): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // 目录不存在 = 无残留
  }
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (depth > 1) sweepPartFiles(p, depth - 1);
    } else if (entry.isFile() && entry.name.endsWith('.part')) {
      fs.rmSync(p, { force: true });
    }
  }
}

/**
 * zip/jar 尾部 EOCD 签名探测（`PK\x05\x06`，尾部 22..65557 字节窗口）：O(1) 截断判定——
 * 网络中断留下的半截 jar 尾部是随机数据，几乎必然无 EOCD。
 */
function zipHasEocd(file: string): boolean {
  let size: number;
  try {
    size = fs.statSync(file).size;
  } catch {
    return false;
  }
  if (size < 22) return false;
  const windowSize = Math.min(size, 65557);
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(windowSize);
    fs.readSync(fd, buf, 0, windowSize, size - windowSize);
    return buf.indexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])) >= 0;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** legacyfix 本地完整性锚点：GitHub release 构件无官方哈希，下载+打补丁后本地算。 */
interface LegacyfixMeta {
  sha256: string;
  size: number;
}

/** 流式读文件算哈希（sha1 校验 jar 用）。 */
export function hashFile(file: string, algo: 'sha1' | 'sha256'): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash(algo);
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

function basenameFromUrl(url: string): string {
  const noQuery = url.split('?')[0]!.split('#')[0]!;
  const base = noQuery.split('/').pop();
  return base && base.length > 0 ? base : 'download.bin';
}

export class BetacraftClient {
  readonly endpoints: Endpoints;
  private readonly fetchImpl: FetchImpl;
  private readonly onProgress: ((event: DownloadProgressEvent) => void) | undefined;

  constructor(options: BetacraftClientOptions = {}) {
    this.endpoints = resolveEndpoints(options.endpoints);
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
    this.onProgress = options.onProgress;
  }

  private emit(event: DownloadProgressEvent): void {
    this.onProgress?.(event);
  }

  /**
   * 公开事件口：宿主编排层（runtime.ts launch）为 cache-hit 阶段插合成 queued/done 对
   * （HMCL 阶段行可见性：缓存命中也显示 ✓ 行，弹窗不空白）。
   */
  emitProgress(event: DownloadProgressEvent): void {
    this.emit(event);
  }

  private async get(url: string): Promise<Response> {
    const res = await this.fetchImpl(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    return res;
  }

  /**
   * 通用下载：进度事件 + 可选 sha1/sha256 校验 + 可选取消信号。
   * **原子落盘**：流写 `<dest>.part`，校验通过后 rename 到 dest——进程被杀/断流
   * 只留 `.part`（dest 侧「存在=复用」判据永不被半截文件污染）；失败/取消清 `.part`。
   * 取消：signal 贯穿 fetch 与读循环，中止清 `.part`、发 `cancelled` 阶段（UI 落中性态）、
   * 原样重抛中止错误由 runtime 归一为取消语义。
   */
  async download(
    url: string,
    destFile: string,
    item: DownloadItem,
    id: string,
    hash?: { algo: 'sha1' | 'sha256'; value: string },
    signal?: AbortSignal,
  ): Promise<void> {
    this.emit({ item, id, phase: 'queued', bytesDone: 0 });
    const partFile = `${destFile}.part`;
    let bytesDone = 0;
    let bytesTotal: number | undefined;
    try {
      if (signal?.aborted) throw abortError(signal);
      const res = await this.fetchImpl(url, { signal });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
      const totalHeader = res.headers.get('content-length');
      bytesTotal = totalHeader ? Number(totalHeader) : undefined;
      fs.mkdirSync(path.dirname(destFile), { recursive: true });
      const hasher = hash ? crypto.createHash(hash.algo) : null;
      const handle = await fs.promises.open(partFile, 'w');
      try {
        const reader = res.body?.getReader();
        if (reader) {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) {
              await handle.writeFile(value);
              bytesDone += value.byteLength;
              hasher?.update(value);
              this.emit({ item, id, phase: 'transferring', bytesDone, bytesTotal });
              if (signal?.aborted) throw abortError(signal);
            }
          }
        } else {
          const buf = new Uint8Array(await res.arrayBuffer());
          await handle.writeFile(buf);
          bytesDone = buf.byteLength;
          hasher?.update(buf);
        }
      } finally {
        await handle.close();
      }
      if (hasher && hash) {
        this.emit({ item, id, phase: 'verifying', bytesDone, bytesTotal });
        const actual = hasher.digest('hex');
        if (actual !== hash.value.toLowerCase()) {
          throw new Error(`${hash.algo} 校验失败：期望 ${hash.value}，实际 ${actual}`);
        }
      }
      fs.renameSync(partFile, destFile);
      this.emit({ item, id, phase: 'done', bytesDone, bytesTotal: bytesTotal ?? bytesDone });
    } catch (error) {
      fs.rmSync(partFile, { force: true });
      if (signal?.aborted) this.emit({ item, id, phase: 'cancelled', bytesDone, bytesTotal });
      else this.emit({ item, id, phase: 'failed', bytesDone, bytesTotal, error: messageOf(error) });
      throw error;
    }
  }

  async fetchVersionList(): Promise<VersionRef[]> {
    const res = await this.get(this.endpoints.versionList);
    return parseVersionList(await res.text());
  }

  /** 版本 .info 原文（每次启动重下策略由 runtime 编排，这里只管取）。 */
  async fetchVersionInfo(id: string): Promise<string> {
    const res = await this.get(this.endpoints.versionJson(id));
    return res.text();
  }

  /** 落 versions/jsons/<id>.info。 */
  saveVersionInfo(root: string, id: string, text: string): void {
    const dest = infoFile(root, id);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, text, 'utf8');
  }

  /**
   * 客户端 jar → versions/<id>.jar（BlockHelm「启动前检查/补全」语义）：
   * - `verify=false`（checkIntegrity 关）：本地存在即复用，跳过 sha1 复核；
   * - `repair=false`（fixMissing 关）：缺失或复核不符时显式报错，不擅自重下载/覆盖。
   * - `force=true`（实例 forceUpdate，v1 Launcher.forceUpdate 语义）：旁路全部「已存在即复用」
   *   检查直接重下（覆盖本地文件）。
   * 缺省（都不传）= 恒复核 + 自动补全。
   */
  async downloadClientJar(
    json: VersionJson,
    root: string,
    opts: { verify?: boolean; repair?: boolean; force?: boolean; signal?: AbortSignal } = {},
  ): Promise<void> {
    const url = json.jar?.url ?? json.downloads?.client?.url;
    if (!url) throw new Error(`版本 ${json.id} 无 jar 下载地址`);
    const sha1 = json.jar?.sha1 ?? json.downloads?.client?.sha1;
    const dest = clientJarFile(root, json.id);
    if (!opts.force && fs.existsSync(dest)) {
      // cache-hit 合成对（HMCL 阶段行可见性）：queued 先于哈希复核、done 于命中返回处；
      // 不符走重下时 download() 自带序列（同键覆盖，无残留）。
      const size = fs.statSync(dest).size;
      this.emit({ item: 'client-jar', id: json.id, phase: 'queued', bytesDone: 0, bytesTotal: size });
      if (!sha1 || opts.verify === false) {
        this.emit({ item: 'client-jar', id: json.id, phase: 'done', bytesDone: size, bytesTotal: size });
        return;
      }
      if ((await hashFile(dest, 'sha1')) === sha1.toLowerCase()) {
        this.emit({ item: 'client-jar', id: json.id, phase: 'done', bytesDone: size, bytesTotal: size });
        return;
      }
      // 复核不符 = 本地损坏；补全关闭时把决定权交回用户（可见失败，不静默覆盖）
      if (opts.repair === false) {
        throw new Error(`版本 ${json.id} 的 jar 校验不符（本地文件损坏），自动补全已禁用——请手动删除该 jar 或开启补全开关`);
      }
    } else if (!opts.force && opts.repair === false) {
      throw new Error(`版本 ${json.id} 的 jar 缺失，自动补全已禁用——请开启补全开关或手动放入 versions/${json.id}.jar`);
    }
    await this.download(url, dest, 'client-jar', json.id, sha1 ? { algo: 'sha1', value: sha1 } : undefined, opts.signal);
  }

  /** Mods 仓库列表（Betacraft 单源，getmods.jsp）；解析防御见 mods.ts parseModCategories。 */
  async fetchModCategories(): Promise<ModCategoryRaw[]> {
    const res = await this.get(this.endpoints.modsList);
    return parseModCategories(await res.text());
  }

  /**
   * 社区服务器列表页原文（HTML，UTF-8 带 BOM；端点形态 = POST 空体）。
   * 解析防御见 servers.ts parseServerList；每次全量重拉（无进程内缓存，fetchModCategories 同款）。
   */
  async fetchServerListHtml(): Promise<string> {
    const res = await this.fetchImpl(this.endpoints.serverList, { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${this.endpoints.serverList}`);
    return res.text();
  }

  /**
   * mod jar 补全 → versions/mods/<id>.jar（v1 readyVersion 的下载段，不复刻其 hash_sha1 死代码）：
   * - sha1 强制：`.info` 缺 sha1 且完整性校验开启 = 显式拒绝无锚点下载（v1 下载后从不复验，本侧强制）；
   * - 本地命中 sha1 即复用；复核不符直接带哈希重下（mods/ 下是纯缓存产物，重取无用户数据风险，
   *   不套用 client jar 的 fixMissing 拦截面）；
   * - force=true（实例强更）旁路复用检查恒重下。
   */
  async ensureModJar(
    json: VersionJson,
    root: string,
    opts: { verify?: boolean; force?: boolean; signal?: AbortSignal } = {},
  ): Promise<string> {
    const baseId = json.betacraft?.baseVersion ?? '?';
    const url = json.jar?.url;
    if (!url) throw new Error(modMissingMessage(json, baseId, '.info 缺少 jar 下载地址（url 键）'));
    const sha1 = json.jar?.sha1;
    if (!sha1 && opts.verify !== false) {
      throw new Error(modMissingMessage(json, baseId, '.info 缺少 sha1，完整性校验开启时拒绝无锚点下载'));
    }
    const dest = modJarFile(root, json.id);
    if (!opts.force && fs.existsSync(dest)) {
      const size = fs.statSync(dest).size;
      this.emit({ item: 'mod-jar', id: json.id, phase: 'queued', bytesDone: 0, bytesTotal: size });
      if (!sha1 || opts.verify === false) {
        this.emit({ item: 'mod-jar', id: json.id, phase: 'done', bytesDone: size, bytesTotal: size });
        return dest;
      }
      if ((await hashFile(dest, 'sha1')) === sha1.toLowerCase()) {
        this.emit({ item: 'mod-jar', id: json.id, phase: 'done', bytesDone: size, bytesTotal: size });
        return dest;
      }
    }
    await this.download(url, dest, 'mod-jar', json.id, sha1 ? { algo: 'sha1', value: sha1 } : undefined, opts.signal);
    return dest;
  }

  /**
   * 资产索引 → assets/indexes/<id>.json，返回落位的索引 ID（无资产/无数据 → null）。
   * ID 四级来源（resolveLaunchAssetIndexId 统一入口，与启动注入 -Dlf.assetIndex 同源）：
   * Mojang 形状 assetIndex > .info assets 字段 > BC v2 权威表 > legacyfix version_data 表。
   * BC `.info` 全线无 assets 字段；Indev 年代标题探测与 ID 表不同源（0130 标题 "Minecraft 0.31"
   * → c0.31 → 20100124，ID 表 → 20100212），必须由 BC v2 权威表钉死，否则 objects 错配、部分声音缺失。
   */
  async downloadAssetIndex(json: VersionJson, root: string, opts: { force?: boolean; signal?: AbortSignal } = {}): Promise<string | null> {
    const ai = json.assetIndex;
    const id = resolveLaunchAssetIndexId(json);
    if (!id) return null;
    const entry = ASSET_INDEXES[id];
    const url = ai?.url ?? entry?.url;
    if (!url) return null;
    const sha1 = ai?.sha1 ?? entry?.sha1;
    const dest = assetIndexFile(root, id);
    if (!opts.force && fs.existsSync(dest)) {
      const size = fs.statSync(dest).size;
      this.emit({ item: 'asset-index', id, phase: 'queued', bytesDone: 0, bytesTotal: size });
      if (!sha1) {
        this.emit({ item: 'asset-index', id, phase: 'done', bytesDone: size, bytesTotal: size });
        return id;
      }
      if ((await hashFile(dest, 'sha1')) === sha1.toLowerCase()) {
        this.emit({ item: 'asset-index', id, phase: 'done', bytesDone: size, bytesTotal: size });
        return id;
      }
    }
    await this.download(url, dest, 'asset-index', id, sha1 ? { algo: 'sha1', value: sha1 } : undefined, opts.signal);
    return id;
  }

  /**
   * 资产对象补全 → assets/objects/<2位前缀>/<hash>（v2 bc_game_download_assets 语义：
   * 存在且 size 相符即跳过；hash 即 sha1，下载时校验）。
   * legacyfix 只自动补索引 `custom` 段，`objects` 全体是启动器责任——缺失即游戏内声音 NPE。
   */
  async downloadAssetObjects(root: string, indexId: string, opts: { force?: boolean; signal?: AbortSignal } = {}): Promise<void> {
    const indexFile = assetIndexFile(root, indexId);
    if (!fs.existsSync(indexFile)) return;
    // HMCL 配方「资产检查」阶段行：queued/transferring*/done 序列括住存在性+尺寸核对循环。
    // bytesDone/bytesTotal = 已核对对象数/对象总数（非字节，UI 聚合层对 asset-check 除外
    // 计入字节和）。全本地时循环是纯同步块，不让出则事件积压到检查完才 flush（检查期间
    // 无显示）→ 每段核对后 setImmediate 让出。
    const plan = planAssetObjects(JSON.parse(fs.readFileSync(indexFile, 'utf8')) as unknown);
    const total = plan.length;
    // 节流粒度动态：约 40 段、每段至少 25 对象——经典版资产仅几十~几百对象，
    // 固定 250 永不触发。开头即发一条 0 进度 transferring：行与进度条立即出现，
    // 不等第一段核对完。
    const step = Math.max(25, Math.ceil(total / 40) || 1);
    this.emit({ item: 'asset-check', id: indexId, phase: 'queued', bytesDone: 0, bytesTotal: total });
    this.emit({ item: 'asset-check', id: indexId, phase: 'transferring', bytesDone: 0, bytesTotal: total });
    let checked = 0;
    for (const obj of plan) {
      const dest = path.join(assetsDir(root), 'objects', obj.hash.slice(0, 2), obj.hash);
      if (!opts.force && !(fs.existsSync(dest) && fs.statSync(dest).size === obj.size)) {
        await this.download(obj.url, dest, 'asset', `${indexId}:${obj.key}`, { algo: 'sha1', value: obj.hash }, opts.signal);
      }
      checked += 1;
      if (checked % step === 0) {
        this.emit({ item: 'asset-check', id: indexId, phase: 'transferring', bytesDone: checked, bytesTotal: total });
        await new Promise((r) => setImmediate(r));
      }
    }
    this.emit({ item: 'asset-check', id: indexId, phase: 'done', bytesDone: total, bytesTotal: total });
  }

  /**
   * json.libraries → bin/<basename>（整目录上 classpath，缺失才下；force=true 覆盖已存在文件）。
   * **库池污染闸门**：bin 是跨版本共享 classpath 池，scanBinPool 字母序把原生 `lwjgl-2.9.0.jar`
   * 排在 BC 魔改 `lwjgl.jar` 之前（`-` < `.`），一旦回填/Mojang 通道把同族原生库倒进池里
   * 即劫持 org.lwjgl/net.java.jinput 类加载——原生 WindowsDisplay × Win11 × DeAWT 序列
   * 窗口坍缩 136x39（client 120x0）。
   * LWJGL/JInput 族唯一供给方是 depends 通道（libs/natives zip 的 patched 库集），
   * 其余通道同族库（含 natives classifier）一律跳过。
   */
  async downloadLibrariesToBin(json: VersionJson, root: string, opts: { force?: boolean; signal?: AbortSignal } = {}): Promise<void> {
    for (const lib of json.libraries ?? []) {
      const group = lib.name.split(':')[0] ?? '';
      if (group === 'org.lwjgl' || group.startsWith('org.lwjgl.') || group === 'net.java.jinput') continue;
      const url = lib.url ?? lib.client?.url;
      if (!url) continue;
      const dest = path.join(binDir(root), basenameFromUrl(url));
      if (!opts.force && fs.existsSync(dest)) continue;
      await this.download(url, dest, 'library', lib.name, lib.client?.sha1 ? { algo: 'sha1', value: lib.client.sha1 } : undefined, opts.signal);
    }
  }

  /**
   * Mojang 重发布库集 → LibraryInfo[]（BC `.info` 无 libraries 时的库池回填通道）。
   * 形状转换在此完成，契约不动（LibraryInfo 只走 url/client）。
   * rules 语义：无 rules → 收录；有 rules → 仅当存在匹配当前 os.name 的 allow。
   * natives classifier（如 lwjgl-platform/jinput-platform 的 -natives-windows.jar）
   * 也进 bin/ 池——LWJGL2/JInput 会自行从 classpath 解出原生库。
   */
  async fetchMojangLibraries(id: string, platform: NodeJS.Platform): Promise<LibraryInfo[]> {
    const manifest = (await (await this.get(this.endpoints.mojangManifest)).json()) as {
      versions?: { id: string; url: string }[];
    };
    const entry = manifest.versions?.find((v) => v.id === id);
    if (!entry) throw new Error(`Mojang 清单无 ${id}`);
    const doc = (await (await this.get(entry.url)).json()) as {
      libraries?: {
        name: string;
        url?: string;
        downloads?: {
          artifact?: { url: string; sha1?: string };
          classifiers?: Record<string, { url: string; sha1?: string }>;
        };
        natives?: Record<string, string>;
        rules?: { action: 'allow' | 'disallow'; os?: { name?: string } }[];
      }[];
    };
    const osName = platform === 'win32' ? 'windows' : platform === 'darwin' ? 'osx' : 'linux';
    const out: LibraryInfo[] = [];
    const seen = new Set<string>();
    const push = (name: string, url: string, sha1?: string): void => {
      if (seen.has(url)) return;
      seen.add(url);
      out.push({ name, url, client: sha1 ? { url, sha1 } : { url } });
    };
    for (const lib of doc.libraries ?? []) {
      if (lib.rules) {
        const allowed = lib.rules.some((r) => r.action === 'allow' && (!r.os || r.os.name === osName));
        if (!allowed) continue;
      }
      const artifactUrl = lib.downloads?.artifact?.url ?? lib.url;
      if (artifactUrl) push(lib.name, artifactUrl, lib.downloads?.artifact?.sha1);
      const natKey = lib.natives?.[osName];
      const nat = natKey ? lib.downloads?.classifiers?.[natKey] : undefined;
      if (nat?.url) push(lib.name, nat.url, nat.sha1);
    }
    return out;
  }

  /**
   * legacyfix 钉版直链下载 → <root>/<relPath>（relPath 来自 agentMount.path，
   * 文件名携带的版本号 = 唯一事实源；直链拼法见 ensureLegacyfixAsset）。
   * 源 = 自有 fork CreatorCSIE/legacyfix-attic（endpoints.legacyfixRelease）：
   * DeAwt 窗口位置已在 fork 源码层修复，启动器层二进制常量池补丁（原 legacyfixPatch.ts）
   * 随切源退役。
   */
  async ensureLegacyfix(root: string, relPath: string, signal?: AbortSignal): Promise<string> {
    const file = path.basename(relPath);
    const version = /^legacyfix-(.+)\.jar$/i.exec(file)?.[1];
    if (!version) throw new Error(`无法从 agentMount 文件名解析 legacyfix 版本（应为 legacyfix-<version>.jar）：${file}`);
    return this.ensureLegacyfixAsset(root, relPath, version, signal);
  }

  /**
   * 同 release 构件落位（agent 胖 jar 与 fork addon jar 共用 URL 拼装/校验）：
   * `<base>/<version>/<basename>` → <root>/<relPath>。addon jar 版本由调用方从
   * agentMount 文件名解析传入（addon 文件名不满足 `legacyfix-<ver>.jar` 正则）。
   * **SHA 校验自愈**：GitHub release 构件无官方哈希可锚，改为本地锚点——
   * 下载落定后算 sha256+size 写 sidecar `<dest>.meta`；下次启动三级校验
   * （size → zip 尾部 EOCD → sha256），任一级不过 = 残缺/损坏 → 删本体+meta 重下
   * （防网络中断留半截 jar、被「存在=跳过」喂给 -javaagent 崩）。
   * meta 缺席的历史文件 = 首见信任：EOCD 过了才立锚。
   */
  async ensureLegacyfixAsset(
    root: string,
    relPath: string,
    version: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const dest = path.join(root, relPath);
    const file = path.basename(relPath);
    if (fs.existsSync(dest)) {
      const size = fs.statSync(dest).size;
      this.emit({ item: 'legacyfix', id: file, phase: 'queued', bytesDone: 0, bytesTotal: size });
      if (await this.legacyfixIntact(dest)) {
        this.emit({ item: 'legacyfix', id: file, phase: 'done', bytesDone: size, bytesTotal: size });
        return dest;
      }
      // 残缺自愈：本体+锚点一并删除，走下方重下通道（download() 同键自带序列覆盖 queued）。
      fs.rmSync(dest, { force: true });
      fs.rmSync(`${dest}.meta`, { force: true });
    }
    // 钉版直链：版本唯一事实源 = agentMount 文件名（调用方解析后传入）→ tag=<version> 直链。
    // 不走 api.github.com/releases/latest：未认证 60 req/h/IP
    // 限流会直接导致下载失败；且 latest 语义下突发新 release 会经 fallback 匹配换掉
    // jar 版本、与数据表钉版打架——直链天然把版本锁死在数据表。
    await this.download(`${this.endpoints.legacyfixRelease}/${version}/${file}`, dest, 'legacyfix', file, undefined, signal);
    await this.writeLegacyfixMeta(dest);
    return dest;
  }

  /** 三级完整性校验：size 对锚 → EOCD 截断探测 → sha256 全量比对。 */
  private async legacyfixIntact(dest: string): Promise<boolean> {
    if (!zipHasEocd(dest)) return false;
    let meta: LegacyfixMeta | null = null;
    try {
      meta = JSON.parse(fs.readFileSync(`${dest}.meta`, 'utf8')) as LegacyfixMeta;
    } catch {
      meta = null;
    }
    if (!meta || typeof meta.sha256 !== 'string' || typeof meta.size !== 'number') {
      await this.writeLegacyfixMeta(dest); // 历史文件首见信任（EOCD 已过）：立锚
      return true;
    }
    if (fs.statSync(dest).size !== meta.size) return false;
    return (await hashFile(dest, 'sha256')) === meta.sha256.toLowerCase();
  }

  /** 下载/打补丁落定后写本地锚点（sha256+size）。 */
  private async writeLegacyfixMeta(dest: string): Promise<void> {
    const sha256 = await hashFile(dest, 'sha256');
    const size = fs.statSync(dest).size;
    fs.writeFileSync(`${dest}.meta`, JSON.stringify({ sha256, size } satisfies LegacyfixMeta), 'utf8');
  }
}
