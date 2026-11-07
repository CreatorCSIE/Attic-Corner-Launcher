/**
 * Attic 自带的 legacyfix 挂载决策表（quirk 矩阵是数据）。
 * 真实 betacraft `.info` 不含 agentMount——本表在 runtime 装配时并入 VersionJson.betacraft，
 * 区间判定仍走 launch.filterAgentMounts（versionOrder 来自版本清单缓存）。
 * 形态判定事实：legacyfix README——Vanilla/ModLoader/Forge ≤1.3 → javaagent；
 * Forge 1.4 → coremod；Forge ≥1.5 / Fabric 系 → mod。jar 本体统一落
 * `<root>/legacyfix/legacyfix-<版本>.jar`（数据供给面从 fork GitHub Release 下载，path 相对数据根）。
 * 文件名钉版 = 显式升级通道：旧版构件名不同 → `ensureLegacyfix` 的「存在即复用」自然失配
 * 重下新版；且与 Release asset 名精确同名，命中构件匹配主支（非 legacyfix* 前缀兜底）。
 * 钉版 `26.11-attic.8` = fork（CreatorCSIE/legacyfix-attic）构件要点：基 = 上游 26.11
 * （c0.0.15a 非 5565 端口补丁/DemoPatch/Infdev visualizer 重实现全在），attic 增量 =
 * DeAwt setLocation 源码化（启动器层二进制补丁退役）、AddonLoader + `-Dlf.addons=` 外部
 * addon 机制（同 release 挂 `legacyfix-addon-{fullscreen,gamemodeswitch,quitgame}-<版本>.jar`）、
 * c0.24 s3 死链 patch、addon 生命周期两趟修复（pre 趟不再清空 loaded，postAppletInit 型
 * addon 如 gamemodeswitch 自此真正执行——26.10-attic.6 实机证伪的缺陷）。
 * attic.2→attic.6 = fullscreen addon 修复迭代（attic.4 退化：仅 `-Dlf.deawt.disable=true`
 * 下有效 = addon×DeAWT 冲突）。
 * attic.7/8（2026-11-07 紧急钉两连）= F1 退役后实机回归的修复：① **proxy 兜底**——legacy
 * S3 资源下载改由本地 assets 供（14e1fe5；c0.24 声音此前实为启动器 F1 预置顶着的假绿，
 * F1 砍掉即暴露 s3 双协议 patch 未覆盖该链路；attic.8 续修 ac2ed94 = classic 声音下载
 * 落到真实资产对象，首修未竟全功）；② **LaunchWrapper 注入闸门**——按
 * `sun.java.command` 判定游戏是否真走 Launch（6b440a1：classpath 上躺一个 launchwrapper
 * jar 不再短路整条直接补丁矩阵，此前 Patcher/addons/重定义全跳、游戏裸奔）。
 * 同版并落 fullscreen 终局结论（a8196b2/86725af）：DeAWT 下 agent 侧 AWT 全屏不可达 =
 * 设计使然，addon 在该路径静默 no-op，全屏归启动器侧职责。
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
    path: 'legacyfix/legacyfix-26.11-attic.8.jar',
    appliesFrom: 'c0.0.13a',
    appliesTo: '1.3.2',
    quirk: 'legacyfix',
  },
  {
    form: 'coremod',
    path: 'legacyfix/legacyfix-26.11-attic.8.jar',
    appliesFrom: '1.4-pre',
    appliesTo: '1.4.7',
    quirk: 'legacyfix',
  },
  {
    form: 'mod',
    path: 'legacyfix/legacyfix-26.11-attic.8.jar',
    appliesFrom: '1.5',
    appliesTo: '1.5.2',
    quirk: 'legacyfix',
  },
];
