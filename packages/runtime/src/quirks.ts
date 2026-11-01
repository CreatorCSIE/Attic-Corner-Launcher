/**
 * Attic 自带的 legacyfix 挂载决策表（quirk 矩阵是数据）。
 * 真实 betacraft `.info` 不含 agentMount——本表在 runtime 装配时并入 VersionJson.betacraft，
 * 区间判定仍走 launch.filterAgentMounts（versionOrder 来自版本清单缓存）。
 * 形态判定事实：legacyfix README——Vanilla/ModLoader/Forge ≤1.3 → javaagent；
 * Forge 1.4 → coremod；Forge ≥1.5 / Fabric 系 → mod。jar 本体统一落
 * `<root>/legacyfix/legacyfix-26.10.jar`（数据供给面从 GitHub Release 下载，path 相对数据根）。
 * 文件名钉版 = 显式升级通道：旧版构件名不同 → `ensureLegacyfix` 的「存在即复用」自然失配
 * 重下新版；且与 Release asset 名精确同名，命中构件匹配主支（非 legacyfix* 前缀兜底）。
 * 26.10 构件要点：c0.0.15a 非 5565 端口补丁/DemoPatch/Infdev visualizer
 * 重实现全部进入 Release；DeAwtPatch.class 哈希已录入 legacyfixPatch.ts 钉版表
 * （窗口位置补丁对 26.10 依旧必要且兼容）。
 */

import type { AgentMount } from '@attic/core-spec';

/**
 * 边界 id 均取 betacraft 清单实存值：`c0.0.13a`/`1.4`/`1.7.10` 不在清单，
 * 分别以 `c0.0.13a`（缺省 → 区间头=fail-open，pre-classic 的 Applet 容器本就需要挂载）、
 * `1.4-pre`、`1.5.2`（v0 范围上限）表达。
 */
export const DEFAULT_AGENT_MOUNTS: AgentMount[] = [
  {
    form: 'javaagent',
    path: 'legacyfix/legacyfix-26.10.jar',
    appliesFrom: 'c0.0.13a',
    appliesTo: '1.3.2',
    quirk: 'legacyfix',
  },
  {
    form: 'coremod',
    path: 'legacyfix/legacyfix-26.10.jar',
    appliesFrom: '1.4-pre',
    appliesTo: '1.4.7',
    quirk: 'legacyfix',
  },
  {
    form: 'mod',
    path: 'legacyfix/legacyfix-26.10.jar',
    appliesFrom: '1.5',
    appliesTo: '1.5.2',
    quirk: 'legacyfix',
  },
];
