#!/usr/bin/env node
/**
 * 版本单一源守卫（2026-10-25 落实，发版流程前置）。
 *
 * 背景 = 「tag 版本 ≠ 构件内版本」漂移面：内嵌版本各有独立声明源
 * （tauri.conf.json = tauri 壳 package_info → sidecar env；两 electron 壳 package.json = app.getVersion()），
 * 而 release.yml 的 tag 只驱动构件命名/安装器——打 tag 不改这些源 = 构件名 0.0.1、体内 0.0.0，
 * updater 比对恒真 + anchor/游戏侧宣告错版。
 *
 * 纪律 = 根 package.json `version` 为唯一权威源；本脚本把它同步进三个构件内嵌面。
 * 发版流程：改根 version → `pnpm version:sync` → 同一 commit 提交 → 打 tag v<version>
 * （release.yml gates 交叉断言 tag == 根 version，不一致 = 构建期炸）。
 *
 * 模式：默认 = 写入（正则单行替换，保留目标文件其余格式）；`--check` = 只核对，漂移 exit 1（CI 绊线）。
 * `--set <ver>` = CI 构建期注入（release.yml 各腿跑）：以内嵌面写入指定版本而非根单一源——
 * nightly/dispatch 构件名由 meta.version 驱动（如 0.1.0-nightly.*），不锚定根 version（nightlyBase
 * 语义），不注入则体内 = 根版本（显示错版 + updateCheck 轨判据失灵：内嵌版本无 -nightly. 被当
 * stable 走 /latest）。仓内单一源纪律不动：--set 只改 CI 临时工作树，永不提交。
 * Cargo.toml 版本豁免 = 构件显示链无消费面（exe 文件属性级，不参与比对/宣告）。
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 内嵌版本目标面（相对仓库根）：壳运行时实际读取的字段所在文件。 */
const TARGETS = [
  'apps/tauri/src-tauri/tauri.conf.json',
  'apps/electron/package.json',
  'apps/electron-legacy/package.json',
];

const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(repoRoot, rel), 'utf8'));

const setIdx = process.argv.indexOf('--set');
if (setIdx >= 0 && !process.argv[setIdx + 1]) {
  console.error('[sync-version] --set 需要版本参数');
  process.exit(1);
}
const source = setIdx >= 0 ? process.argv[setIdx + 1] : readJson('package.json').version;
if (typeof source !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(source)) {
  console.error(`[sync-version] 版本非法 semver：${JSON.stringify(source)}`);
  process.exit(1);
}

const check = process.argv.includes('--check');
let drift = 0;
for (const rel of TARGETS) {
  const current = readJson(rel).version;
  if (current === source) {
    console.log(`✓ ${rel} = ${source}`);
    continue;
  }
  if (check) {
    console.error(`✗ ${rel} = ${current} ≠ 根单一源 ${source}（本地跑 pnpm version:sync 后一并提交）`);
    drift += 1;
    continue;
  }
  // 首个 "version" 键 = 顶层版本字段（三文件皆然）；单行替换保留其余字节不动。
  const text = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
  const patched = text.replace(/("version"\s*:\s*)"[^"]*"/, `$1"${source}"`);
  if (patched === text) {
    console.error(`✗ ${rel} 未找到可替换的 version 字段（结构变更？人工核对）`);
    drift += 1;
    continue;
  }
  fs.writeFileSync(path.join(repoRoot, rel), patched, 'utf8');
  console.log(`→ ${rel}: ${current} → ${source}`);
}
process.exit(drift ? 1 : 0);
