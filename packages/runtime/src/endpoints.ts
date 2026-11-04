/**
 * 端点配置层：所有上游 URL 经此层解析，支持部分覆盖。
 * 默认值为 Betacraft v1 的 files.betacraft.uk 路径（ReleaseJson.java L39）。
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
   * 会直接导致 legacyfix 下载失败）。
   * 缺省源 = 自有 fork `CreatorCSIE/legacyfix-attic`（attic 分支，版本命名 `<upstream>-attic.<n>`；
   * DeAwt setLocation 源码化 + AddonLoader 外部 addon + c0.24 双协议 patch 所在，
   * 同 release 挂 agent 胖 jar + addon jar 构件）。`endpoint.legacyfixRelease` 覆盖键
   * （launcher.settings）仍可指回上游 betacraftuk/legacyfix。
   */
  legacyfixRelease: string;
  /** Azul Zulu 元数据 API。 */
  zuluMetadata: string;
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
  legacyfixRelease: 'https://github.com/CreatorCSIE/legacyfix-attic/releases/download',
  zuluMetadata: 'https://api.azul.com/metadata/v1/zulu/packages/',
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
    modsList: overrides.modsList ?? DEFAULT_ENDPOINTS.modsList,
    serverList: overrides.serverList ?? DEFAULT_ENDPOINTS.serverList,
    dependsVersion: `${base}/depends-version.txt`,
    libsZip: (os: DependsOs) => `${base}/libs-${os}.zip`,
    nativesZip: (os: DependsOs) => `${base}/natives-${os}.zip`,
  };
}
