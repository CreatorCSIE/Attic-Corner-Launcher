/**
 * Mods 仓库页契约视图（MODS_* 通道，一期 = Betacraft 单源）。
 * 上游事实：`http://api.betacraft.uk/getmods.jsp` 返回
 * JSON `ModCategory[]`，条目 5 字段（full_name/version/info_file_url/website/autoupdate）。
 * v1 模型 = mod 即自定义版本：安装只落 `versions/jsons/<full_name>.info`，
 * jar 下载与基座合成延迟到点 Play（见 docs/contract.md §2.8）。
 */

/** 仓库条目（上游原始形状；宿主不下发上游未知键——Gson 丢弃语义等价）。 */
export interface ModEntryRaw {
  /** = 版本 id（自定义版本模型的身份；宿主按版本 id 安全规则校验后方可安装）。 */
  fullName: string;
  /** 树节点显示文本（= 上游 version 字段）。 */
  version: string;
  /** .info 直链（安装/autoupdate 刷新唯一入口）。 */
  infoFileUrl: string;
  /** 项目主页（可缺省；UI 外链走 openExternalUrl 出门）。 */
  website?: string;
  /** true = 启动前重新拉取 .info（缺省 false）。 */
  autoupdate: boolean;
}

/** 分类（上游 `mod_category` + `mods`；`mods` 缺失/为 null 的分类由宿主剔除——NPE 防御）。 */
export interface ModCategoryRaw {
  name: string;
  mods: ModEntryRaw[];
}

/** 下发给 UI 的条目：宿主附加 installed 实存标记。 */
export interface ModEntryView extends ModEntryRaw {
  /** `versions/jsons/<fullName>.info` 实存（= 已安装；id 不安全的条目恒 false）。 */
  installed: boolean;
}

export interface ModCategoryView {
  name: string;
  mods: ModEntryView[];
}

/** 安装请求（UI 从列表项原样回传；宿主不复用渲染侧任何未校验字段直接落盘）。 */
export interface ModInstallRequest {
  fullName: string;
  infoFileUrl: string;
  autoupdate: boolean;
}
