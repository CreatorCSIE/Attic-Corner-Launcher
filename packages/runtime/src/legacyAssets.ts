/**
 * legacyfix 资产数据表 —— 逐字移植 legacyfix common/src/main/resources/{version_data,asset_indexes}.json。
 * 机理：legacyfix AssetUtils.downloadAssets() 只补索引 `custom` 段，`objects` 全体
 * 由启动器负责预置（Betacraft v2 C++ bc_game_download_assets 语义）；索引 ID 由本表正则推导
 * （Java Pattern.matches 全串匹配语义，首中即返）；'empty' = 该版本无资产。
 */

export interface AssetIndexEntry {
  id: string;
  url: string;
  sha1: string;
  size: number;
  totalSize: number;
}

/** version_data.json 的 version→assetIndex 映射（settings 段由 legacyfix 自身应用，不在此移植）。 */
const VERSION_ASSET_ROWS: readonly (readonly [string, string])[] = [
  ['^(rd-.+|pc-.+)', 'empty'],
  ['^c0\\.0\\.(?:[0-9]|1(?:[0-9])|2(?:[0-1]))a(?:.+)?', 'empty'],
  ['^c0\\.0\\.2[2-3]a(?:.+)?', 'c0.0.22a_01'],
  ['^c0\\.(?:2[4-9]|30)(?:.+)?', 'c0.0.22a_01'],
  ['^c0\\.31(?:.+)?', '20100124'],
  ['^in-.+', '20100212'],
  ['^inf-.+', '20100607'],
  ['^a1\\.0\\.[1-2](?:_0[1-2])?(?:-[0-9]{4,6})?$', '20100607'],
  ['^a1\\.0\\.[3-7](?:_0[1-3])?(?:-[0-9]{4,6})?$', 'a1.0.3'],
  ['^a1\\.0\\.8(?:.+)?', 'a1.0.8'],
  ['^a1\\.0\\.(?:9|1[0-1])(?:-[0-9]{4,6})?$', 'a1.0.9'],
  ['^a1\\.0\\.1[2-3](?:-[0-9]{4,6})?$', 'a1.0.12'],
  ['^a1\\.0\\.1[4-5](?:.*)?$', 'a1.0.14'],
  ['^a1\\.(?:0\\.1[6-7]|1\\.[0-2])(?:_0[1-4])?(?:-[0-9]{4,6})?$', 'a1.0.14'],
  ['^a1\\.2\\.0(?:_01)?(?:-[0-9]{4})?$', 'a1.2.0'],
  ['^(?:a1\\.2\\.[0-6](?:_0[1-5])?(?:[a-b])?(?:-[0-9]{4,6})?|b1\\.[0-1](?:.+)?)$', 'a1.2.0_02'],
  ['^b1\\.[2-3](?:.+)?$', 'b1.2'],
  ['^b1\\.4(?:.+)?$', 'b1.4'],
  ['^b1\\.[5-6](?:.+)?$', 'b1.5'],
  ['^b1\\.[7-8](?:.+)?$', 'b1.7'],
  ['^b1\\.9(?:.+)?$', 'b1.7'],
  ['^1\\.(?:0(?:.+)?$|1$)', '1.0.0-rc1'],
  ['^(?:11w[4-5][0-9][a-z]|12w0[1-5][a-z])(?:.+)?$', '1.0.0-rc1'],
  ['^1\\.[2-3](?:\\.[1-5])?(?:-pre(?:.+)?)?$', '1.2'],
  ['^12w(?:0[6-8]|[1-2][0-9]|3[0-7])[a-z](?:.+)?$', '1.2'],
  ['^1\\.[4-5](?:\\.[1-7])?(?:-pre(?:.+)?)?$', '1.4'],
  ['^(?:12w(?:3[8-9]|[4-5][0-9])|13w(?:0[1-9]|1[0-12]))[a-z~](?:.+)?$', '1.4'],
  ['^2\\.0(?:.+)?$', '1.4'],
  ['^1\\.6(?:\\.[1-4])?(?:-pre(?:.+)?)?$', '1.6'],
  ['^13w1[6-8][a-z](?:.+)?$', '13w16a'],
  ['^13w(?:19|2[0-1])[a-z](?:.+)?$', '13w19a'],
  ['^13w22[a-z](?:.+)?$', '13w22a'],
  ['^13w23a(?:.+)?$', '13w22a'],
  ['^13w23b(?:.+)?$', '13w22a'],
  ['^13w2[4-6][a-z](?:.+)?$', '13w24a'],
  ['^13w(?:3[6-9]|4[0-1])[a-z](?:.+)?$', '1.6'],
  ['^1\\.7(?:\\.[0-1])?(?:-[a-z0-9]+)?$', '13w42a'],
  ['^13w4[2-3][a-z](?:.+)?$', '13w42a'],
  ['^1\\.7\\.2(?:.+)?$', '1.7.2'],
  ['^13w4[7-8][a-z](?:.+)?$', '1.7.2'],
  ['^1\\.7\\.3(?:.+)?$', '1.7.3'],
  ['^13w49a(?:.+)?$', '1.7.3'],
  ['^1\\.7\\.(?:[4-9]|10-pre[1-3])(?:.+)?$', '1.7.4'],
  ['^14w02[a-z](?:.+)?$', '1.7.4'],
  ['^14w0[3-4][a-z](?:.+)?$', '1.7.4'],
  ['^14w(?:0[5-9]|1[0-9]|2[0-1])[a-z](?:.+)?$', '1.7.4'],
  ['^1\\.7\\.(?:10-pre4|10)$', '1.7.10'],
  ['^14w(?:2[5-9]|30)[a-z](?:.+)?$', '14w25a'],
  ['^14w(?:3[1-4])[a-z](?:.+)?$', '14w31a'],
  ['^24w20a$', '24w20a'],
];

/** Java Pattern.matches = 全串匹配：JS 侧补 (?:...)$ 锚尾（源表部分行缺 $ 锚）。 */
const VERSION_ASSET_PATTERNS: readonly (readonly [RegExp, string])[] = VERSION_ASSET_ROWS.map(
  ([src, id]) => [new RegExp(`^(?:${src})$`), id] as const,
);

/** asset_indexes.json：索引 ID → 下载元数据（files.betacraft.uk v2 索引）。 */
export const ASSET_INDEXES: Readonly<Record<string, AssetIndexEntry>> = {
  empty: { id: 'empty', sha1: '5a48d9fc5877b925eaa65ddef68cb5dbaee9df64', size: 15, totalSize: 0, url: 'https://files.betacraft.uk/launcher/v2/assets/indexes/v2/empty.json' },
  'c0.0.22a_01': { id: 'c0.0.22a_01', sha1: '9c2bfa09259ab89cb73ca4ae6915c0008df5be59', size: 3995, totalSize: 114708, url: 'https://files.betacraft.uk/launcher/v2/assets/indexes/v2/c0.0.22a_01.json' },
  '20100104': { id: '20100104', sha1: '8fa578734364a621798d5bda7b8d1b3c31334a18', size: 2894, totalSize: 110323, url: 'https://files.betacraft.uk/launcher/v2/assets/indexes/v2/20100104.json' },
  '20100110': { id: '20100110', sha1: '6a675c529f1d9b34b6a91cff9271774be3f12dfe', size: 4155, totalSize: 222191, url: 'https://files.betacraft.uk/launcher/v2/assets/indexes/v2/20100110.json' },
  '20100124': { id: '20100124', sha1: '5fdea2eb79c92bcc5f7fbe33623559be29ac1010', size: 4527, totalSize: 235157, url: 'https://files.betacraft.uk/launcher/v2/assets/indexes/v2/20100124.json' },
  '20100206': { id: '20100206', sha1: '83bbf522977514920c6f4d8b07053e068e26ef98', size: 4802, totalSize: 270846, url: 'https://files.betacraft.uk/launcher/v2/assets/indexes/v2/20100206.json' },
  '20100212': { id: '20100212', sha1: '8973a6554d29de9db764ade4ca0b752e968daeb3', size: 10595, totalSize: 629618, url: 'https://files.betacraft.uk/launcher/v2/assets/indexes/v2/20100212.json' },
  '20100607': { id: '20100607', sha1: 'be307e51c429cfd7b09819e76b3ecf65bea609a7', size: 11076, totalSize: 629618, url: 'https://files.betacraft.uk/launcher/v2/assets/indexes/v2/20100607.json' },
  'a1.0.3': { id: 'a1.0.3', sha1: '93bb74cc254759b76477070b550270455db2558d', size: 16746, totalSize: 1360114, url: 'https://files.betacraft.uk/launcher/v2/assets/indexes/v2/a1.0.3.json' },
  'a1.0.8': { id: 'a1.0.8', sha1: '7b1b929e1fc660a7ff72f61e8d615cca3698fca3', size: 18389, totalSize: 1360114, url: 'https://files.betacraft.uk/launcher/v2/assets/indexes/v2/a1.0.8.json' },
  'a1.0.9': { id: 'a1.0.9', sha1: '8f48f25ac915133099542aff6558ef3b8c1c923f', size: 17707, totalSize: 1435446, url: 'https://files.betacraft.uk/launcher/v2/assets/indexes/v2/a1.0.9.json' },
  'a1.0.12': { id: 'a1.0.12', sha1: 'fe3548e814e60dd422e7c09fdb227149a664d149', size: 18678, totalSize: 1478027, url: 'https://files.betacraft.uk/launcher/v2/assets/indexes/v2/a1.0.12.json' },
  'a1.0.14': { id: 'a1.0.14', sha1: 'e169cf3490308a2beff922b6c34ef069071605cc', size: 22978, totalSize: 20803913, url: 'https://files.betacraft.uk/launcher/v2/assets/indexes/v2/a1.0.14.json' },
  'a1.2.0': { id: 'a1.2.0', sha1: '148e06b5d27b88d59fde0363db8498bc3a32efd6', size: 27578, totalSize: 40544558, url: 'https://files.betacraft.uk/launcher/v2/assets/indexes/v2/a1.2.0.json' },
  'a1.2.0_02': { id: 'a1.2.0_02', sha1: 'c6832ef22863835ac6a54022b58341a7ebacce62', size: 27190, totalSize: 40571871, url: 'https://files.betacraft.uk/launcher/v2/assets/indexes/v2/a1.2.0_02.json' },
  'b1.2': { id: 'b1.2', sha1: '9b9373af97c3611267f768599bd8a4543608ea64', size: 28147, totalSize: 40607034, url: 'https://files.betacraft.uk/launcher/v2/assets/indexes/v2/b1.2.json' },
  'b1.4': { id: 'b1.4', sha1: '5c96bf6d26c83ef0a9f8af7d1060391a50662460', size: 30273, totalSize: 40750218, url: 'https://files.betacraft.uk/launcher/v2/assets/indexes/v2/b1.4.json' },
  'b1.5': { id: 'b1.5', sha1: '0f046e9c97fd46d012dd4e7bed3a425479ff6720', size: 31325, totalSize: 40881673, url: 'https://files.betacraft.uk/launcher/v2/assets/indexes/v2/b1.5.json' },
  'b1.7': { id: 'b1.7', sha1: '3f8be62ee493576e0a97436e387e957acc223156', size: 31608, totalSize: 40893632, url: 'https://files.betacraft.uk/launcher/v2/assets/indexes/v2/b1.7.json' },
  '1.0.0-rc1': { id: '1.0.0-rc1', sha1: 'e15ff8a06bfc189cea1952451f2c52ccd8fc241d', size: 36587, totalSize: 41790336, url: 'https://files.betacraft.uk/launcher/v2/assets/indexes/v2/1.0.0-rc1.json' },
  '1.2': { id: '1.2', sha1: '0f01c0c32f524e80cc57e683e3ce36a1aaee7843', size: 40782, totalSize: 42166084, url: 'https://files.betacraft.uk/launcher/v2/assets/indexes/v2/1.2.json' },
  '1.4': { id: '1.4', sha1: '5eae14c6678a530507c672a5c8d1eb1ed98d5b12', size: 92710, totalSize: 47500989, url: 'https://files.betacraft.uk/launcher/v2/assets/indexes/v2/1.4.json' },
  '13w16a': { id: '13w16a', sha1: '07f2c6b0fd14f1d5b01d9464be611ab1c305cf28', size: 76729, totalSize: 41532376, url: 'https://files.betacraft.uk/launcher/v2/assets/indexes/v2/13w16a.json' },
  '13w18c': { id: '13w18c', sha1: '30f95e3c1092fe6372189bcdbc5c254eca800c40', size: 76739, totalSize: 41532376, url: 'https://files.betacraft.uk/launcher/v2/assets/indexes/v2/13w18c.json' },
  '13w19a': { id: '13w19a', sha1: '709f59e2922ddcc35871c2cd564bb07de05eeb26', size: 76453, totalSize: 41656189, url: 'https://files.betacraft.uk/launcher/v2/assets/indexes/v2/13w19a.json' },
  '13w22a': { id: '13w22a', sha1: 'abf5fd700799a7e7844cad8fded4387b2a63c12f', size: 86998, totalSize: 42314230, url: 'https://files.betacraft.uk/launcher/v2/assets/indexes/v2/13w22a.json' },
  '13w24a': { id: '13w24a', sha1: 'bfec62e9856872247a715496dedff261d782a846', size: 88273, totalSize: 42325563, url: 'https://files.betacraft.uk/launcher/v2/assets/indexes/v2/13w24a.json' },
  '1.6': { id: '1.6', sha1: 'a5061469bcd9d86fe4e45ad1dc4f6d96451d6a72', size: 88039, totalSize: 42325563, url: 'https://files.betacraft.uk/launcher/v2/assets/indexes/v2/1.6.json' },
  '13w42a': { id: '13w42a', sha1: '837c91a3ff21e3b2c8501bc2054c85a4ba40b0f2', size: 88697, totalSize: 42325563, url: 'https://files.betacraft.uk/launcher/v2/assets/indexes/v2/13w42a.json' },
  '1.7.2': { id: '1.7.2', sha1: '28058b8ea0af98f1ba6d49e8bd135c6d765b47e0', size: 75061, totalSize: 111273415, url: 'https://files.betacraft.uk/launcher/v2/assets/indexes/v2/1.7.2.json' },
  '24w20a': { id: '24w20a', sha1: 'd2db1ecca63a6f52b8342135edcd16052019ca54', size: 446905, totalSize: 799014789, url: 'https://piston-meta.mojang.com/v1/packages/d2db1ecca63a6f52b8342135edcd16052019ca54/17.json' },
};

/** 版本 ID → 资产索引 ID；无匹配或 'empty' → null（无资产，静默跳过）。 */
export function resolveAssetIndexId(versionId: string): string | null {
  for (const [pattern, assetIndex] of VERSION_ASSET_PATTERNS) {
    if (pattern.test(versionId)) return assetIndex === 'empty' ? null : assetIndex;
  }
  return null;
}

/**
 * BC v2 服务端每版本 JSON 的权威 assetIndex.id（数据源 files.betacraft.uk/launcher/v2/assets/jsons/<id>.json，
 * 23 条 in- 条目已逐条核对）。运行时标题探测永远无法产出 20100104/20100110/20100206
 * （version_data.json 无对应行），且 Indev 早期版本标题为 "Minecraft 0.31" → c0.31 → 20100124，
 * 与 BC 版本 ID 正则表结果（20100212）不同源——预取与运行时必须以本表为准，并经 -Dlf.assetIndex 注入钉死。
 * 仅列 Indev 年代的分歧项；其余年代 ID 表结果与标题探测同源一致，无需覆盖。
 */
export const AUTHORITATIVE_ASSET_INDEXES: Readonly<Record<string, string>> = {
  'in-20091223-1459': 'c0.0.22a_01',
  'in-20091231-2255': 'c0.0.22a_01',
  'in-20100104-2258': '20100104',
  'in-20100110': '20100110',
  'in-20100124-2310': '20100124',
  'in-20100125': '20100124',
  'in-20100128-2304': '20100124',
  'in-20100129-1452': '20100124',
  'in-20100130': '20100124',
  'in-20100131-2244': '20100124',
  'in-20100201-0025': '20100124',
  'in-20100201-2227': '20100124',
  'in-20100202-2330': '20100124',
  'in-20100206-2103': '20100206',
  'in-20100207-1101': '20100206',
  'in-20100207-1703': '20100206',
  'in-20100212-1210': '20100212',
  'in-20100212-1622': '20100212',
  'in-20100213': '20100212',
  'in-20100214': '20100212',
  'in-20100218-0016': '20100212',
  'in-20100219': '20100212',
  'in-20100223': '20100212',
};

/**
 * 资产索引解析唯一权威入口（预取与启动注入共用，保证两侧同源）：
 * .info assetIndex.id > .info assets > BC v2 权威表 > legacyfix version_data 正则表；无资产 → null。
 * `c0.24-dev*` 声音缺失（该系用 ogg = infdev 资产集，正则表按 c0.2x 族给 c0.0.22a_01 只有 wav）
 * 属**数据侧问题**，修法 = BC `.info` 给 `assets=20100607`（本链第二级即生效），
 * 启动器不加硬编码例外（2026-11-07 用户定调）。
 */
export function resolveLaunchAssetIndexId(json: {
  id: string;
  assets?: string;
  assetIndex?: { id?: string };
}): string | null {
  return json.assetIndex?.id ?? json.assets ?? AUTHORITATIVE_ASSET_INDEXES[json.id] ?? resolveAssetIndexId(json.id);
}

/** 索引 objects/custom 条目（Mojang 形状 + Betacraft 扩展字段）。 */
interface AssetIndexRawEntry {
  hash?: string;
  size?: number;
  /** legacyfix AssetUtils.downloadAssets 识别的绝对 URL。 */
  url?: string;
  /** v2 bc_assetindex 识别的 per-object 基础 URL。 */
  custom_url?: string;
}

export interface AssetObjectPlan {
  key: string;
  hash: string;
  size: number;
  url: string;
  /** 相对 assets 根的 POSIX 路径：objects/<2位前缀>/<hash>。 */
  relPath: string;
}

const MOJANG_OBJECTS_BASE = 'https://resources.download.minecraft.net';

/**
 * 索引 JSON → 对象下载计划。语义对齐两处上游行为：
 * - legacyfix initAssets：`custom` 段覆盖/追加 `objects` 同名键；
 * - v2 bc_game_download_assets + legacyfix downloadAssets：URL 优先级 obj.url > custom_url > Mojang resources。
 */
export function planAssetObjects(indexJson: unknown): AssetObjectPlan[] {
  const idx = indexJson as { objects?: Record<string, AssetIndexRawEntry>; custom?: Record<string, AssetIndexRawEntry> };
  const merged = new Map<string, AssetIndexRawEntry>();
  for (const [key, entry] of Object.entries(idx?.objects ?? {})) merged.set(key, entry);
  for (const [key, entry] of Object.entries(idx?.custom ?? {})) merged.set(key, entry);

  const plan: AssetObjectPlan[] = [];
  for (const [key, entry] of merged) {
    const hash = entry?.hash;
    const size = entry?.size;
    if (typeof hash !== 'string' || hash.length < 2 || typeof size !== 'number') continue;
    const hashPath = `${hash.slice(0, 2)}/${hash}`;
    plan.push({
      key,
      hash,
      size,
      url: entry.url ?? entry.custom_url ?? `${MOJANG_OBJECTS_BASE}/${hashPath}`,
      relPath: `objects/${hashPath}`,
    });
  }
  return plan;
}

/**
 * 索引对象键 → 游戏 `resources/` 落盘所需的父目录集（POSIX 相对路径，'' = resources 根本身）。
 * 用途 = 兼容无法使用 assets 体系的版本（c0.24-dev* 即其中，游戏只认 resources/；能用
 * assets 的版本不写 resources、无影响）。游戏侧 ThreadDownloadResources.download() 直接
 * new FileOutputStream、**不自建目录**（2026-11-07 用户实机点名：手动清空 resources 后
 * fork agent 改写死链命中真对象，落盘仍走游戏自家写路径 → FileNotFoundException）。
 * 启动器按本集预建目录即可根除。
 */
export function resourceDirsFromIndex(indexJson: unknown): string[] {
  const dirs = new Set<string>();
  for (const obj of planAssetObjects(indexJson)) {
    const slash = obj.key.lastIndexOf('/');
    dirs.add(slash < 0 ? '' : obj.key.slice(0, slash));
  }
  return [...dirs];
}

/**
 * BC v2 索引目录（files.betacraft.uk/launcher/v2/assets/indexes/v2/）全 29 条的**对象键父目录集**
 * 烘焙表（2026-11-07 逐条实拉，objects+custom 合并口径，'' = resources 根本身）。
 * resources 预建以此为准：不依赖索引 JSON 是否已落盘（首启/网络失败也建得出），
 * 表外索引（如 24w20a 走 piston-meta）回落本地索引解析。
 */
export const RESOURCE_DIRS_BY_INDEX: Readonly<Record<string, readonly string[]>> = {
  'c0.0.22a_01': ['music', 'sound/loops', 'sound/random', 'sound/step'],
  '20100104': ['music', 'sound/step'],
  '20100110': ['music', 'newsound/random', 'sound/step'],
  '20100124': ['music', 'newsound/random', 'sound/step'],
  '20100206': ['music', 'newsound/fire', 'newsound/random', 'sound/step'],
  '20100212': ['music', 'newsound/fire', 'newsound/liquid', 'newsound/mob', 'newsound/random', 'newsound/step', 'sound/step'],
  '20100607': ['music', 'newsound/fire', 'newsound/liquid', 'newsound/mob', 'newsound/random', 'newsound/step', 'sound/step'],
  'a1.0.3': ['music', 'newsound/ambient/cave', 'newsound/fire', 'newsound/liquid', 'newsound/mob', 'newsound/random', 'newsound/step', 'sound/step'],
  'a1.0.8': ['music', 'newsound/ambient/cave', 'newsound/fire', 'newsound/liquid', 'newsound/mob', 'newsound/random', 'newsound/step', 'sound/step'],
  'a1.0.9': ['music', 'newsound/ambient/cave', 'newsound/fire', 'newsound/liquid', 'newsound/mob', 'newsound/random', 'newsound/step', 'sound/step'],
  'a1.0.12': ['music', 'newsound/ambient/cave', 'newsound/fire', 'newsound/liquid', 'newsound/mob', 'newsound/random', 'newsound/step', 'sound/step'],
  'a1.0.14': ['music', 'newmusic', 'newsound/ambient/cave', 'newsound/damage', 'newsound/fire', 'newsound/liquid', 'newsound/mob', 'newsound/random', 'newsound/step', 'sound/step', 'streaming'],
  'a1.2.0': ['music', 'newmusic', 'newsound/ambient/cave', 'newsound/damage', 'newsound/fire', 'newsound/liquid', 'newsound/mob', 'newsound/mob/ghast', 'newsound/mob/zombiepig', 'newsound/portal', 'newsound/random', 'newsound/step', 'sound/step', 'streaming'],
  'a1.2.0_02': ['music', 'newmusic', 'newsound/ambient/cave', 'newsound/damage', 'newsound/fire', 'newsound/liquid', 'newsound/mob', 'newsound/mob/ghast', 'newsound/mob/zombiepig', 'newsound/portal', 'newsound/random', 'newsound/step', 'sound/step', 'streaming'],
  'b1.2': ['music', 'newmusic', 'newsound/ambient/cave', 'newsound/damage', 'newsound/fire', 'newsound/liquid', 'newsound/mob', 'newsound/mob/ghast', 'newsound/mob/zombiepig', 'newsound/note', 'newsound/portal', 'newsound/random', 'newsound/step', 'sound/step', 'streaming'],
  'b1.4': ['music', 'newmusic', 'newsound/ambient/cave', 'newsound/damage', 'newsound/fire', 'newsound/liquid', 'newsound/mob', 'newsound/mob/ghast', 'newsound/mob/wolf', 'newsound/mob/zombiepig', 'newsound/note', 'newsound/portal', 'newsound/random', 'newsound/step', 'sound/step', 'streaming'],
  'b1.5': ['music', 'newmusic', 'newsound/ambient/cave', 'newsound/ambient/weather', 'newsound/damage', 'newsound/fire', 'newsound/liquid', 'newsound/mob', 'newsound/mob/ghast', 'newsound/mob/wolf', 'newsound/mob/zombiepig', 'newsound/note', 'newsound/portal', 'newsound/random', 'newsound/step', 'sound/step', 'streaming'],
  'b1.7': ['music', 'newmusic', 'newsound/ambient/cave', 'newsound/ambient/weather', 'newsound/damage', 'newsound/fire', 'newsound/liquid', 'newsound/mob', 'newsound/mob/ghast', 'newsound/mob/wolf', 'newsound/mob/zombiepig', 'newsound/note', 'newsound/portal', 'newsound/random', 'newsound/step', 'newsound/tile/piston', 'sound/step', 'streaming'],
  '1.0.0-rc1': ['music', 'newmusic', 'newsound/ambient/cave', 'newsound/ambient/weather', 'newsound/damage', 'newsound/fire', 'newsound/liquid', 'newsound/mob', 'newsound/mob/blaze', 'newsound/mob/endermen', 'newsound/mob/ghast', 'newsound/mob/magmacube', 'newsound/mob/silverfish', 'newsound/mob/wolf', 'newsound/mob/zombiepig', 'newsound/note', 'newsound/portal', 'newsound/random', 'newsound/step', 'newsound/tile/piston', 'sound/step', 'streaming'],
  '1.2': ['music', 'newmusic', 'newsound/ambient/cave', 'newsound/ambient/weather', 'newsound/damage', 'newsound/fire', 'newsound/liquid', 'newsound/mob', 'newsound/mob/blaze', 'newsound/mob/cat', 'newsound/mob/endermen', 'newsound/mob/ghast', 'newsound/mob/irongolem', 'newsound/mob/magmacube', 'newsound/mob/silverfish', 'newsound/mob/wolf', 'newsound/mob/zombie', 'newsound/mob/zombiepig', 'newsound/note', 'newsound/portal', 'newsound/random', 'newsound/step', 'newsound/tile/piston', 'sound/step', 'streaming'],
  '1.4': ['music', 'newmusic', 'newsound/ambient/cave', 'newsound/ambient/weather', 'newsound/damage', 'newsound/fire', 'newsound/liquid', 'newsound/mob', 'newsound/mob/blaze', 'newsound/mob/cat', 'newsound/mob/endermen', 'newsound/mob/ghast', 'newsound/mob/irongolem', 'newsound/mob/magmacube', 'newsound/mob/silverfish', 'newsound/mob/wolf', 'newsound/mob/zombie', 'newsound/mob/zombiepig', 'newsound/note', 'newsound/portal', 'newsound/random', 'newsound/step', 'newsound/tile/piston', 'sound/step', 'sound3/ambient/cave', 'sound3/ambient/weather', 'sound3/damage', 'sound3/dig', 'sound3/fire', 'sound3/fireworks', 'sound3/liquid', 'sound3/minecart', 'sound3/mob/bat', 'sound3/mob/blaze', 'sound3/mob/cat', 'sound3/mob/chicken', 'sound3/mob/cow', 'sound3/mob/creeper', 'sound3/mob/enderdragon', 'sound3/mob/endermen', 'sound3/mob/ghast', 'sound3/mob/irongolem', 'sound3/mob/magmacube', 'sound3/mob/pig', 'sound3/mob/sheep', 'sound3/mob/silverfish', 'sound3/mob/skeleton', 'sound3/mob/slime', 'sound3/mob/spider', 'sound3/mob/wither', 'sound3/mob/wolf', 'sound3/mob/zombie', 'sound3/mob/zombiepig', 'sound3/note', 'sound3/portal', 'sound3/random', 'sound3/step', 'sound3/tile/piston', 'streaming'],
  '13w16a': ['icons', 'lang', 'music', 'records', 'sound/ambient/cave', 'sound/ambient/weather', 'sound/damage', 'sound/dig', 'sound/fire', 'sound/fireworks', 'sound/liquid', 'sound/minecart', 'sound/mob/bat', 'sound/mob/blaze', 'sound/mob/cat', 'sound/mob/chicken', 'sound/mob/cow', 'sound/mob/creeper', 'sound/mob/enderdragon', 'sound/mob/endermen', 'sound/mob/ghast', 'sound/mob/irongolem', 'sound/mob/magmacube', 'sound/mob/pig', 'sound/mob/sheep', 'sound/mob/silverfish', 'sound/mob/skeleton', 'sound/mob/slime', 'sound/mob/spider', 'sound/mob/wither', 'sound/mob/wolf', 'sound/mob/zombie', 'sound/mob/zombiepig', 'sound/note', 'sound/portal', 'sound/random', 'sound/step', 'sound/tile/piston'],
  '13w18c': ['', 'icons', 'lang', 'music', 'records', 'sound/ambient/cave', 'sound/ambient/weather', 'sound/damage', 'sound/dig', 'sound/fire', 'sound/fireworks', 'sound/liquid', 'sound/minecart', 'sound/mob/bat', 'sound/mob/blaze', 'sound/mob/cat', 'sound/mob/chicken', 'sound/mob/cow', 'sound/mob/creeper', 'sound/mob/enderdragon', 'sound/mob/endermen', 'sound/mob/ghast', 'sound/mob/irongolem', 'sound/mob/magmacube', 'sound/mob/pig', 'sound/mob/sheep', 'sound/mob/silverfish', 'sound/mob/skeleton', 'sound/mob/slime', 'sound/mob/spider', 'sound/mob/wither', 'sound/mob/wolf', 'sound/mob/zombie', 'sound/mob/zombiepig', 'sound/note', 'sound/portal', 'sound/random', 'sound/step', 'sound/tile/piston'],
  '13w19a': ['', 'icons', 'lang', 'music', 'records', 'sound/ambient/cave', 'sound/ambient/weather', 'sound/damage', 'sound/dig', 'sound/fire', 'sound/fireworks', 'sound/liquid', 'sound/minecart', 'sound/mob/bat', 'sound/mob/blaze', 'sound/mob/cat', 'sound/mob/chicken', 'sound/mob/cow', 'sound/mob/creeper', 'sound/mob/enderdragon', 'sound/mob/endermen', 'sound/mob/ghast', 'sound/mob/irongolem', 'sound/mob/magmacube', 'sound/mob/pig', 'sound/mob/sheep', 'sound/mob/silverfish', 'sound/mob/skeleton', 'sound/mob/slime', 'sound/mob/spider', 'sound/mob/wither', 'sound/mob/wolf', 'sound/mob/zombie', 'sound/mob/zombiepig', 'sound/note', 'sound/portal', 'sound/random', 'sound/step', 'sound/tile/piston'],
  '13w22a': ['', 'icons', 'lang', 'music', 'records', 'sound/ambient/cave', 'sound/ambient/weather', 'sound/damage', 'sound/dig', 'sound/fire', 'sound/fireworks', 'sound/liquid', 'sound/minecart', 'sound/mob/bat', 'sound/mob/blaze', 'sound/mob/cat', 'sound/mob/chicken', 'sound/mob/cow', 'sound/mob/creeper', 'sound/mob/enderdragon', 'sound/mob/endermen', 'sound/mob/ghast', 'sound/mob/horse', 'sound/mob/horse/donkey', 'sound/mob/horse/skeleton', 'sound/mob/horse/zombie', 'sound/mob/irongolem', 'sound/mob/magmacube', 'sound/mob/pig', 'sound/mob/sheep', 'sound/mob/silverfish', 'sound/mob/skeleton', 'sound/mob/slime', 'sound/mob/spider', 'sound/mob/villager', 'sound/mob/wither', 'sound/mob/wolf', 'sound/mob/zombie', 'sound/mob/zombiepig', 'sound/note', 'sound/portal', 'sound/random', 'sound/step', 'sound/tile/piston'],
  '13w24a': ['', 'icons', 'lang', 'music', 'records', 'sound/ambient/cave', 'sound/ambient/weather', 'sound/damage', 'sound/dig', 'sound/fire', 'sound/fireworks', 'sound/liquid', 'sound/minecart', 'sound/mob/bat', 'sound/mob/blaze', 'sound/mob/cat', 'sound/mob/chicken', 'sound/mob/cow', 'sound/mob/creeper', 'sound/mob/enderdragon', 'sound/mob/endermen', 'sound/mob/ghast', 'sound/mob/horse', 'sound/mob/horse/donkey', 'sound/mob/horse/skeleton', 'sound/mob/horse/zombie', 'sound/mob/irongolem', 'sound/mob/magmacube', 'sound/mob/pig', 'sound/mob/sheep', 'sound/mob/silverfish', 'sound/mob/skeleton', 'sound/mob/slime', 'sound/mob/spider', 'sound/mob/villager', 'sound/mob/wither', 'sound/mob/wolf', 'sound/mob/zombie', 'sound/mob/zombiepig', 'sound/note', 'sound/portal', 'sound/random', 'sound/step', 'sound/tile/piston'],
  '1.6': ['', 'icons', 'lang', 'music', 'records', 'sound/ambient/cave', 'sound/ambient/weather', 'sound/damage', 'sound/dig', 'sound/fire', 'sound/fireworks', 'sound/liquid', 'sound/minecart', 'sound/mob/bat', 'sound/mob/blaze', 'sound/mob/cat', 'sound/mob/chicken', 'sound/mob/cow', 'sound/mob/creeper', 'sound/mob/enderdragon', 'sound/mob/endermen', 'sound/mob/ghast', 'sound/mob/horse', 'sound/mob/horse/donkey', 'sound/mob/horse/skeleton', 'sound/mob/horse/zombie', 'sound/mob/irongolem', 'sound/mob/magmacube', 'sound/mob/pig', 'sound/mob/sheep', 'sound/mob/silverfish', 'sound/mob/skeleton', 'sound/mob/slime', 'sound/mob/spider', 'sound/mob/villager', 'sound/mob/wither', 'sound/mob/wolf', 'sound/mob/zombie', 'sound/mob/zombiepig', 'sound/note', 'sound/portal', 'sound/random', 'sound/step', 'sound/tile/piston'],
  '13w42a': ['', 'icons', 'lang', 'sounds/ambient/cave', 'sounds/ambient/weather', 'sounds/damage', 'sounds/dig', 'sounds/fire', 'sounds/fireworks', 'sounds/liquid', 'sounds/minecart', 'sounds/mob/bat', 'sounds/mob/blaze', 'sounds/mob/cat', 'sounds/mob/chicken', 'sounds/mob/cow', 'sounds/mob/creeper', 'sounds/mob/enderdragon', 'sounds/mob/endermen', 'sounds/mob/ghast', 'sounds/mob/horse', 'sounds/mob/horse/donkey', 'sounds/mob/horse/skeleton', 'sounds/mob/horse/zombie', 'sounds/mob/irongolem', 'sounds/mob/magmacube', 'sounds/mob/pig', 'sounds/mob/sheep', 'sounds/mob/silverfish', 'sounds/mob/skeleton', 'sounds/mob/slime', 'sounds/mob/spider', 'sounds/mob/villager', 'sounds/mob/wither', 'sounds/mob/wolf', 'sounds/mob/zombie', 'sounds/mob/zombiepig', 'sounds/music', 'sounds/note', 'sounds/portal', 'sounds/random', 'sounds/records', 'sounds/step', 'sounds/tile/piston'],
  '1.7.2': ['', 'icons', 'lang', 'sounds/ambient/cave', 'sounds/ambient/weather', 'sounds/damage', 'sounds/dig', 'sounds/fire', 'sounds/fireworks', 'sounds/liquid', 'sounds/minecart', 'sounds/mob/bat', 'sounds/mob/blaze', 'sounds/mob/cat', 'sounds/mob/chicken', 'sounds/mob/cow', 'sounds/mob/creeper', 'sounds/mob/enderdragon', 'sounds/mob/endermen', 'sounds/mob/ghast', 'sounds/mob/horse', 'sounds/mob/horse/donkey', 'sounds/mob/horse/skeleton', 'sounds/mob/horse/zombie', 'sounds/mob/irongolem', 'sounds/mob/magmacube', 'sounds/mob/pig', 'sounds/mob/sheep', 'sounds/mob/silverfish', 'sounds/mob/skeleton', 'sounds/mob/slime', 'sounds/mob/spider', 'sounds/mob/villager', 'sounds/mob/wither', 'sounds/mob/wolf', 'sounds/mob/zombie', 'sounds/mob/zombiepig', 'sounds/music/game', 'sounds/music/game/creative', 'sounds/music/game/end', 'sounds/music/game/nether', 'sounds/music/menu', 'sounds/note', 'sounds/portal', 'sounds/random', 'sounds/records', 'sounds/step', 'sounds/tile/piston'],
};
