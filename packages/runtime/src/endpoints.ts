/**
 * 端点配置层（风险 #1）：所有上游 URL 经此层解析，支持部分覆盖。
 * 默认值为 Betacraft v1 实测的 files.betacraft.uk 路径（取证 ReleaseJson.java L39）。
 */

import type { EndpointOverrides } from '@attic/core-spec';

export interface Endpoints {
  /** 版本清单（反引号分隔文本行）。 */
  versionList: string;
  /** 版本元数据 .info（Java properties 格式）。 */
  versionJson(id: string): string;
  /** 资产索引 JSON。 */
  assetIndex(id: string): string;
  /**
   * legacyfix GitHub Release **直链 base**（拼 `<base>/<version>/<asset>`，version 取自
   * agentMount 文件名 = 钉版唯一事实源；不走 api.github.com——未认证 60 req/h/IP 限流
   * 会直接导致 legacyfix 下载失败，2026-10-28 发版前实测确认）。
   */
  legacyfixRelease: string;
  /** Azul Zulu 元数据 API。 */
  zuluMetadata: string;
  /** Mojang 官方版本清单（v2）。用途：BC `.info` 无 libraries 字段时，按重发布 JSON 回填库池（bin/）。 */
  mojangManifest: string;
  /** Betacraft mod 仓库列表（JSON `ModCategory[]`，v1 ModsRepository.java L41 同源端点）。 */
  modsList: string;
  /** Betacraft 社区服务器列表页（HTML，POST 取回；v1 WebsitePanel.getServers L120 同源端点）。 */
  serverList: string;
  /** BC 基础库集版本号（两行 `libs-version:N` / `natives-version:M`，v1 Launcher.java L887）。 */
  dependsVersion: string;
  /** BC patched LWJGL/JInput 库集 zip → bin/（v1 downloadDepends L911-919；补丁红利见 depends.ts 头注）。 */
  libsZip(os: DependsOs): string;
  /** 原生库 zip（lwjgl/jinput/OpenAL dll）→ bin/natives/。 */
  nativesZip(os: DependsOs): string;
}

/** depends 包的平台轴（v1 命名：windows/linux/osx）。 */
export type DependsOs = 'windows' | 'linux' | 'osx';

const FILES_BASE = 'http://files.betacraft.uk/launcher/assets';

export const DEFAULT_ENDPOINTS: Endpoints = {
  versionList: `${FILES_BASE}/version_list.txt`,
  versionJson: (id: string) => `${FILES_BASE}/jsons/${encodeURIComponent(id)}.info`,
  assetIndex: (id: string) => `${FILES_BASE}/indexes/${encodeURIComponent(id)}.json`,
  legacyfixRelease: 'https://github.com/betacraftuk/legacyfix/releases/download',
  zuluMetadata: 'https://api.azul.com/metadata/v1/zulu/packages/',
  mojangManifest: 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json',
  modsList: 'http://api.betacraft.uk/getmods.jsp',
  serverList: 'http://api.betacraft.uk/v2/legacy_server_list',
  dependsVersion: `${FILES_BASE}/depends-version.txt`,
  libsZip: (os: DependsOs) => `${FILES_BASE}/libs-${os}.zip`,
  nativesZip: (os: DependsOs) => `${FILES_BASE}/natives-${os}.zip`,
};

/** 部分覆盖：只替换给出的字段，其余保持默认。 */
export function resolveEndpoints(overrides: Partial<Endpoints> = {}): Endpoints {
  return { ...DEFAULT_ENDPOINTS, ...overrides };
}

/**
 * 由可序列化的端点覆盖（launcher.settings 的 `endpoint.*` 渲染侧视图）派生完整端点。
 * `filesBase` 一旦给出，versionJson/assetIndex 从其派生；缺省值与 DEFAULT_ENDPOINTS 一致。
 * 空覆盖 = 与 DEFAULT_ENDPOINTS 等价（runtime 测试无 settings 时走此路径）。
 */
export function endpointsFromOverrides(overrides: EndpointOverrides = {}): Endpoints {
  const base = overrides.filesBase ?? FILES_BASE;
  return {
    versionList: overrides.versionList ?? `${base}/version_list.txt`,
    versionJson: (id: string) => `${base}/jsons/${encodeURIComponent(id)}.info`,
    assetIndex: (id: string) => `${base}/indexes/${encodeURIComponent(id)}.json`,
    legacyfixRelease: overrides.legacyfixRelease ?? DEFAULT_ENDPOINTS.legacyfixRelease,
    zuluMetadata: overrides.zuluMetadata ?? DEFAULT_ENDPOINTS.zuluMetadata,
    mojangManifest: overrides.mojangManifest ?? DEFAULT_ENDPOINTS.mojangManifest,
    modsList: overrides.modsList ?? DEFAULT_ENDPOINTS.modsList,
    serverList: overrides.serverList ?? DEFAULT_ENDPOINTS.serverList,
    dependsVersion: `${base}/depends-version.txt`,
    libsZip: (os: DependsOs) => `${base}/libs-${os}.zip`,
    nativesZip: (os: DependsOs) => `${base}/natives-${os}.zip`,
  };
}
