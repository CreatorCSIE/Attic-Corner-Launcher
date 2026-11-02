/**
 * 最小 zip 解压器（仅 stored / deflate 两种方法，够 used jar 原生库条目）。
 * 零第三方依赖；用于把 bin/ 库池里的 `*-natives-<os>.jar` 解到 bin/natives
 * （显式 -Dorg.lwjgl.librarypath 会短路 LWJGL2 的 classpath 自解压，必须落盘）。
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

/** 中央目录条目名清单（不解压、不校验 CRC——够类存在性检测用）。文件无效时抛错。 */
export function listZipEntryNames(zipFile: string): string[] {
  const buf = fs.readFileSync(zipFile);
  let eocd = -1;
  const minPos = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= minPos; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error(`不是有效 zip：${zipFile}`);
  const entryCount = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const names: string[] = [];
  for (let n = 0; n < entryCount; n++) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) throw new Error(`zip 中央目录损坏：${zipFile}`);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    names.push(buf.toString('utf8', offset + 46, offset + 46 + nameLen));
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

/** zip 单条目解压后视图（data 永远是明文；method 保留原始压缩法供回写）。 */
export interface ZipEntry {
  name: string;
  method: number; // 0=stored 8=deflate
  dosTime: number;
  dosDate: number;
  data: Buffer; // 明文
}

/**
 * 读取 zip 全部文件条目到内存（解出明文；目录条目与罕见压缩法跳过）。
 * 供 legacyfix jar 原位补丁回写用（读→改条目→writeZipEntries 重建）。无效 zip 抛错。
 */
export function readZipEntries(zipFile: string): ZipEntry[] {
  const buf = fs.readFileSync(zipFile);
  let eocd = -1;
  const minPos = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= minPos; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error(`不是有效 zip：${zipFile}`);
  const entryCount = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);

  const out: ZipEntry[] = [];
  for (let n = 0; n < entryCount; n++) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) throw new Error(`zip 中央目录损坏：${zipFile}`);
    const method = buf.readUInt16LE(offset + 10);
    const compSize = buf.readUInt32LE(offset + 20);
    const dosTime = buf.readUInt16LE(offset + 12);
    const dosDate = buf.readUInt16LE(offset + 14);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLen);
    offset += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/')) continue; // 目录条目
    if (buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`zip 本地头损坏：${zipFile}`);
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    if (dataStart + compSize > buf.length) throw new Error(`zip 数据段截断：${zipFile}`);
    const comp = buf.subarray(dataStart, dataStart + compSize);
    let data: Buffer;
    if (method === 0) data = Buffer.from(comp);
    else if (method === 8) data = zlib.inflateRawSync(comp);
    else continue; // 罕见压缩法：丢弃（legacyfix jar 只用 stored/deflate）
    out.push({ name, method, dosTime, dosDate, data });
  }
  return out;
}

/** 回写 zip（每条目按原 method 重压，重建 CRC/大小/中央目录；stored 直存）。 */
export function writeZipEntries(zipFile: string, entries: ZipEntry[]): void {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let cursor = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    let method = e.method;
    let raw: Buffer;
    if (method === 8) {
      raw = zlib.deflateRawSync(e.data, { level: 9 });
      // 罕见：deflate 反而膨胀的极小条目退化为 stored，保持 header 与实际压缩一致。
      if (raw.length >= e.data.length) {
        method = 0;
        raw = e.data;
      }
    } else {
      method = 0;
      raw = e.data;
    }
    const crc = crc32(e.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags（无 data descriptor）
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(e.dosTime, 10);
    local.writeUInt16LE(e.dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(raw.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra len
    chunks.push(local, nameBuf, raw);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4); // version made by
    cd.writeUInt16LE(20, 6); // version needed
    cd.writeUInt16LE(0, 8); // flags
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(e.dosTime, 12);
    cd.writeUInt16LE(e.dosDate, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(raw.length, 20);
    cd.writeUInt32LE(e.data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30); // extra
    cd.writeUInt16LE(0, 32); // comment
    cd.writeUInt16LE(0, 34); // disk
    cd.writeUInt16LE(0, 36); // internal attrs
    cd.writeUInt32LE(0, 38); // external attrs
    cd.writeUInt32LE(cursor, 42); // local header offset
    central.push(cd, nameBuf);

    cursor += local.length + nameBuf.length + raw.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(cursor, 16);
  eocd.writeUInt16LE(0, 20);
  fs.writeFileSync(zipFile, Buffer.concat([...chunks, centralBuf, eocd]));
}

/** 标准 CRC-32（IEEE，zip 语义）。 */
function crc32(buf: Buffer): number {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}

/** 从 zip 文件解出全部文件条目到 destDir；已存在且大小相符的目标跳过。返回解出条目数。
 * strictMethods=true（depends 库集通道用）：罕见压缩法抛错而非静默跳过——半套库集
 * 不得带着成功假象让版本号指纹闸门恒过。 */
export function extractZipTo(zipFile: string, destDir: string, opts: { strictMethods?: boolean } = {}): number {
  const buf = fs.readFileSync(zipFile);
  // EOCD（End of Central Directory, PK\x05\x06）从尾部向前找。
  let eocd = -1;
  const minPos = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= minPos; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error(`不是有效 zip：${zipFile}`);
  const entryCount = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);

  let extracted = 0;
  for (let n = 0; n < entryCount; n++) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) throw new Error(`zip 中央目录损坏：${zipFile}`);
    const method = buf.readUInt16LE(offset + 10);
    const compSize = buf.readUInt32LE(offset + 20);
    const uncompSize = buf.readUInt32LE(offset + 24);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLen);
    offset += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/')) continue; // 目录条目
    if (name.includes('..') || path.isAbsolute(name)) continue; // 路径穿越防御
    const target = path.join(destDir, name);
    if (fs.existsSync(target)) {
      // 已存在 ≠ 完整：上次中断（磁盘满/被杀）留下的半截文件 size 必不符，
      // 须重解——「存在即跳过」会让坏 dll 永久幸存、UnsatisfiedLinkError 自愈失效。
      let intact = false;
      try {
        intact = fs.statSync(target).size === uncompSize;
      } catch {
        /* stat 失败（并发删除）= 按不完整处理 */
      }
      if (intact) continue;
    }

    // 本地文件头：数据起点 = localOffset + 30 + 本地 nameLen + 本地 extraLen。
    if (buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`zip 本地头损坏：${zipFile}`);
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    if (dataStart + compSize > buf.length) throw new Error(`zip 数据段截断：${zipFile}`);
    const comp = buf.subarray(dataStart, dataStart + compSize);
    let data: Buffer;
    if (method === 0) data = Buffer.from(comp);
    else if (method === 8) data = zlib.inflateRawSync(comp);
    else if (opts.strictMethods) throw new Error(`zip 条目含不支持的压缩法 ${method}：${name}（${zipFile}）`);
    else continue; // 罕见压缩方法：跳过（原生库 jar 只用 stored/deflate）

    fs.mkdirSync(path.dirname(target), { recursive: true });
    // 原子落盘（tmp+rename）：直写中途 ENOSPC 会留下新半截文件，本函数修的正是这类幸存。
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, target);
    extracted++;
  }
  return extracted;
}
