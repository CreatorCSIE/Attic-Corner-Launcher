# Attic UI 设计守则 —— "精美"的工程化拆解

> 供 Phase 3（UI v0）执行与验收。核心立场：**精美不是装饰，是纪律**。
> 廉价 UI 的根源几乎总是四件事：间距失序、字阶崩坏、颜色噪音、状态缺失——它们全部可检查、可自动化。
> 本版（2026-10）已按代码实况校准：tokens.css、App.vue 布局壳、VersionSelector（BlockHelm dock）、Tailwind 映射壳试点均以仓库现状为准，不再以初始设想为准。
> 〔2026-11-01 二次校准（0.0.9 + 服务器列表页后）：双栏内容页全面落地、主题三态/强调色板/背景图落地、i18n 三语、§11 改造标的收口——以下各节按现码为准。〕

## 1. Design Token：唯一真相源

所有视觉数值进 token（CSS custom properties），组件**禁止**写死值：

| 维度 | 规则 |
|---|---|
| 间距 | 4px 基准刻度：4/8/12/16/24/32/48（`--space-1..7`），禁止刻度外数值 |
| 字号 | 5 档封顶（12/13/15/18/24，`--fs-xs..xl`）；正文行高 1.5，标题 1.2 |
| 圆角 | **4 档 Modrinth 大圆角刻度**：`--radius-sm 8`（chip/微件）、`--radius-md 12`（输入框/行卡/次级卡）、`--radius-lg 16`（base-card）、`--radius-pill`（主按钮/rail 高亮），按层级用，不混用 |
| 颜色 | **四级 surface**（1 页面底 → 2 次级面/rail → 3 卡片与控件底 → 4 控件 hover 与卡片描边）+ 语义色 `text-primary/secondary/muted、accent、ok、warn、danger`（各带 *-soft 低饱和对）；`--card-bg/--card-border` = surface 3/4 的语义引用；浅色主题 = 整组换 token 值（已实现 `[data-theme="light"]`），组件零改动 |
| 阴影 | 高度 3 档（`--shadow-1..3`）+ **质感配方组**：`--shadow-card`（base-card = 顶内高光 + 底缘内阴影 + 双层外投影）、`--btn-primary-*`（主按钮五层叠影：tint 环 + 4 层递进投影 + 顶部 rim 高光）、`--input-inset/--input-focus-shadow`（输入框下沉 + accent 投影环） |
| 布局 | `--sidebar-width 220` / `--rail-width 60` / `--rail-item-size 40` / `--rail-icon-size 20`；内容页栏宽**不设全局 token**——各页 `.content` 内按页 max-width（560–680px；原 `--content-max 1280` 设想已废） |
| 年代色码 | 8 组 chip 色（pre-classic/classic/4k/indev/infdev/alpha/beta/release）各带 -soft，自绘、属内容区装饰 |
| 强调色板 | `settings.accentColor` → `<html data-accent>` 7 色（缺省 amber 火把琥珀 + green/blue/orange/purple/red/gray，色值源 = Modrinth 主题方案）；`[data-theme][data-accent]` 双属性静态层各覆写 8 变量（accent/hover/press/ink/soft/ring/ring-strong/glow），零运行时计算，surface/文字 token 不动 |
| 启动页背景 | `settings.backgroundImage`（仅配置时启用、无内置默认图）→ `--app-bg-image/--app-bg-overlay` + `html[data-bg-image]`；舞台三层 = 固定暗遮罩 + 图 + surface-1 色垫（变量缺省 none 回落纯色），浮空元素文字 token 随 `data-bg-image` 条件重映射亮值 |

执行机制：tokens.css 文件头纪律注释 + 评审检查单（§9 Definition of Polish）。**stylelint 自动拦截尚未接入**，属 TODO；在此之前"裸 hex / 刻度外数值"由评审兜底。

## 2. 层级：眼睛得知道先看哪

- 每屏**恰好一个**主操作 = 唯一 accent 实心元素：启动页 = Play；内容页（实例/账户/自定义版本/Mods/服务器/设置）= 该屏唯一主操作（如「保存」「新建实例」）。列表卡上的「设为当前」等行内操作一律描边/幽灵，不做 accent 实心。
- 60-30-10：中性底色占大头、次级色构建分区、accent ≤10% 面积。
- **眯眼测试**（squint test）：眯眼看界面，仍能分出三级层次才算过关。
- 信息密度即设计：数字一律 `font-variant-numeric: tabular-nums`；年代色码 chip；相对时间。
- **双栏范式已全面落地（2026-11-01 收口）**：内容页形态 = 主列表 | 右侧详情（Prism 范式）——账户/自定义版本/实例/Mods/服务器/设置六页均带 `.detail` 右栏；启动页版本选择由左下浮动 dock 承载（§3 布局现状），搜索优先已在 VersionSelector 落地。

## 3. 排版与布局：抄公式与范式，不从 0 发明

排版是最不需要原创能力的部分——公式、组件、布局范式全是现成的。"从 0 开始难"的解法是站在三样东西上：

**三套公式**（间距/字号已在 §1 token 表落地，此处补字号之外的参数）：

| 参数 | 取值 | 说明 |
|---|---|---|
| 间距栅格 | 8pt（4 的倍数） | 样式表里不允许再出现 5/7/13 这类数值 |
| 行长 | 正文 45–75 字符（中文 35–45 字） | 超宽先断栏，不拉长行 |
| 栏宽 | 内容页 `.content` 居中、按页 max-width（560–680px，见 §1 布局行） | 行高沿用 token：正文 1.5、标题 1.2 |

**组件层（现状 = 混合路线）**：目标是"外观由 token 单一真相驱动"。实际采用 **(b) 手写 token CSS 为主**（tokens.css 唯一真相）+ **Tailwind 作为映射壳试点**（tailwind.config.ts：色板/刻度全部映射到 `var()`，`preflight:false` 避免与 base.css 双重 reset 打架；只允许使用映射到 token 的工具类，禁止直接产色）。shadcn-vue 未引入；oklch 风险（§8）由"Tailwind 只做映射壳"整体规避。被禁止的仍是老第三条路：组件里写死值。

**布局现状（已落地的应用骨架，App.vue）**：
- 顶栏 `TitleBar`（无边距窗三键）+ 左侧栏：展开 220px（图标+文字、BrandWordmark 置顶可折叠、作者头像沉底）↔ 折叠 60px 图标 rail，偏好 localStorage 持久化；激活态 = surface-3 底 + inset 描边（overlay 质感）。
- **启动舞台**（主页）：左上 `AccountHero` 角标式浮层；`LaunchPanel` 铺满（Play + 「| ≡」菜单沉底靠右，实例经 `InstanceDock` 选择、`LaunchRequest.instanceId` 传参）；**左下 `VersionSelector` 浮动 dock**——BlockHelm `HomeLaunchGameListView` 单组件配方的 CSS 移植（悬浮展开/移出收起/图钉固定、110ms 收起防抖、纯 transform+opacity）；配置背景图时舞台转三层（遮罩+图+色垫，见 §1 启动页背景行）。
- **内容页**：实例/账户/自定义版本/Mods/服务器/设置走 `.content`（按页 max-width 居中 + 左列表右详情双栏）；设置页 = 分栏导航形态（主题/关于/建议反馈等分区，侧栏沉底头像点击直达关于区）；控制台 = 独立窗口（`?window=console`），与主页完全解耦（v1 语义）。

**布局范式抄启动器同行，不抄后台模板**：Prism / HMCL / Steam / Battle.net 是同一个成熟骨架——左侧窄导航 + 中间主列表 + 右侧详情/操作区。admin dashboard 模板（表格 + CRUD）的信息架构与启动器完全不同，套上去必拆。**现状自查（2026-11-01）**：左导航 ✅、启动舞台 ✅、内容页双栏 ✅——原"顶部大表单 + 扁平列表"CRUD 形态改造已收口（§11）。

**Figma 参考（可选）**：Untitled UI 免费套件、GitHub Primer 设计文件——借的是**页面结构**（列表页怎么分组、设置页怎么分栏），不是照搬视觉。

**土办法自检**：截 3 个觉得好看的界面，用 devtools 量间距与字号——会发现间距全是 4/8 的倍数、字号全落在一条 ratio 曲线上。把量出的数字写进 token 表，"模板"就成型了。

## 4. 字体

- 一套西文 + 一套中文，全局例外为零：Inter/Geist + MiSans/HarmonyOS Sans/思源黑体。**零 webfont 依赖**：`--font-sans/--font-mono` 为本地字体栈、未装回落 system-ui（v0 约束）。
- 版本 ID、路径、日志、数字：等宽（`--font-mono`：JetBrains Mono/Cascadia/Consolas）。
- display 字体（含像素字体）**只允许出现在 hero/内容区**，chrome 区保持现代无衬线——见第 10 节"证据不是戏服"。
- 大写小标签 `letter-spacing: .06em`（`--tracking-label`）；正文 0。

## 5. 颜色：贵气来自底色，不来自 accent

- 深色主题为默认。底色**不用纯黑**：暖木炭四级 `#14120f → #1d1a15 → #28241e → #353027`（级差拉到肉眼可数）；正文**不用纯白**：羊皮纸 `#e8e4dc`。浅色主题已实现：羊皮纸底 `#f2ede3` 起、四级反向着色（3 比 1 更亮、4 顶白）、accent 降饱和至 `#a86a18` 过 AA。
- accent：**火把琥珀**（`#e8a33d` 系，hover/press 各一档），全屏唯一高饱和；语义次级色苔藓绿（--ok）。accent 可经设置页色板切 7 色（§1 强调色板行，缺省火把琥珀）；主题三态 = 深/浅/跟随系统（matchMedia 解析，缺省 system）。
- 层级抬升靠**明度步进**（四级 surface），阴影只做辅助；两个重阴影永远不叠。
- "贵气"两板斧已 token 化：卡片顶部 1px 内高光 `--card-highlight` + 描边 = surface-4 同阶色（`--card-border`，不是灰线）；控件底缘内阴影 `--inset-bottom`。
- 对比度门槛：正文 WCAG AA（4.5:1）、大字 3:1，双主题都要过。
- **内容即装饰**（本项目独有的审美特权）：历史全景图、各时代真实图标、旧 splash 艺术——拿考古素材本身当视觉主角，比任何抽象装饰都有效，且零成本不撞风格。

## 6. 动效：200ms 律（一条具名例外）

- 微交互 120–200ms（`--dur-fast/--dur-base`）；进 ease-out、出 ease-in；**只动 `transform`/`opacity`**（GPU 友好，且是 WebKitGTK 基线内最安全的一档）。
- **具名例外 = 面板生长类**：版本 dock 展开/收起用 `--dur-grow 380ms + --ease-grow`（BlockHelm HomeLaunchMenuAnimation 实测配方：Power 3.2 EaseOut，起步快长减速尾）。生长类仅限 dock/抽屉这类空间展开，微交互不得借道；`--dur-slow 320ms` 保留未用。
- 骨架屏替代转圈；列表切换 fade-slide 8px；禁止整页大动效。
- Play 按下 `scale(0.97)` 回弹（已落地）；启动成功"火把点燃"微动画——**未实现，预留为全应用唯一品牌时刻**（稀缺才有记忆点）。
- 尊重 `prefers-reduced-motion`。
- 规则：同屏同时播放的动画超过两个，删一个。

## 7. 状态完备性："精美"到"专业"的分界线

- 每个交互元素五态齐全：default / hover / active / focus-visible / disabled；focus ring 用 accent 投影环（输入框 `--input-focus-shadow`、主按钮 `--btn-primary-focus-shadow`，等效 2px+）。
- 空状态 = 插画 + 一句话 + **行动按钮**（无实例时直接给"新建实例（预填 b1.7.3）"，对齐宿主 resolveInstance 缺省集）。
- 错误状态 = 原因 + 出处 + 出路（沿用 MCANextGen Java 探测面板范式：列出全部候选与每个失败原因，绝不只说"未找到"）。
- 加载必须有数字（MB/s、第 n/m 项）——已落地：启动期聚合下载进度条（阶段文案 + 细进度 + 速率，失败红态常驻）。
- 微文案：按钮动词开头；确认弹窗禁用"确定/取消"，写实际动作（"删除实例"）。删除类操作默认**只删档案不碰 gameDir**，删目录必须是二次确认里的显式选项。

## 8. 实现约束（挂风险登记 #4）

- CSS 特性基线：只用近两大版本 WebKitGTK 全绿的特性；`backdrop-filter` 必须有降级（毛玻璃→实色半透明）。**现状补充**：规避 `color-mix()`/`oklch()`——accent tint、era -soft 全部预计算 rgba 落 token。
- DPI 验收：125%/150% 缩放不破版（Windows 主战场）；最小窗 960×600。
- 深色主题自定义滚动条（`--scroll-thumb`，已 token 化）。
- 图标单一库（lucide，stroke 宽度统一，内联 path 零依赖）；年代 chip 自绘。
- 渲染侧偏好持久化统一走 `localStorage`（键名 `attic:<域>:v1`：sidebar-collapsed、version-panel pin 等）；业务数据一律走 IPC 契约，不混用（戒律 #1）。

## 9. 流程：怎么验证，而不是怎么想象

1. **浏览器里设计**：已落地 `packages/ui/src/dev/demo.ts`——无宿主 mock 桥面，`vite dev` 直接真组件真数据出真稿，不需要 Electron/Tauri 在场。
2. 动手前截 3 个对标对象，各提炼 3 个可迁移模式（已消费：BlockHelm dock 几何/动效、Modrinth omorphia 质感配方、Prism/HMCL 双栏骨架、Raycast 搜索优先）。
3. 验收仪式：1080p 与 1440p 各跑一遍眯眼测试 + 间距刻度抽查 + 状态完备清单。

### Definition of Polish（进 Phase 3 PR 检查单）

- [ ] 无裸 hex、无刻度外数值（stylelint 接入前由评审兜底）
- [ ] 正文行长 ≤75 字符（中文 ≤45 字），超宽断栏
- [ ] 每屏 accent 实心元素恰好 1 个
- [ ] 所有数字 tabular-nums；路径/ID 等宽
- [ ] 全部交互元素五态齐全
- [ ] 动画 ≤200ms 且只动 transform/opacity（面板生长类例外走 §6 具名通道）
- [ ] 骨架屏无布局跳动（CLS=0）
- [ ] 深/浅主题对比度过 AA
- [ ] backdrop-filter 有降级路径
- [ ] 125%/150% DPI 不破版
- [ ] 空/错误/加载三态每屏都有定义

## 10. Attic 品牌基调（先定调，不过早定死）

一句话："**落灰，但都还活着。**"

暖木炭底 + 火把琥珀 accent + 羊皮纸文字 + 年代色码。复古元素（像素字、旧图标、全景图）是**证据，不是戏服**——只出现在内容区（版本卡、hero 背景），chrome（导航/按钮/表单）保持现代极简。这条线决定它是"精密仪器里的考古馆"，而不是"复古模板站"。

## 11. 现状清单（2026-10 校准，改造对账基准）

**已落地（对上面各节的实现度）**：

| 块 | 状态 |
|---|---|
| 应用骨架：TitleBar + 可折叠侧栏（220↔60）+ 启动舞台（hero/净空 Play 区/左下版本 dock/实例 dock） | ✅ |
| 版本 dock：搜索、年代分组/chip、图钉、生长动效、收起防抖 | ✅ |
| Token 体系：四级 surface + 质感配方组 + 浅色主题整组覆盖 + 年代色码 | ✅ |
| 内容页双栏全套：账户/自定义版本/实例/Mods/服务器/设置六页左列表 + `.detail` 右栏（§2 改造标的收口） | ✅ |
| 设置页重写：分栏导航 + 主题三态（深/浅/跟随系统）+ 强调色板 7 色 + 背景图 + 关于栏（logo/检查更新/引用清单）+ 建议反馈（§1 强调色板/背景行） | ✅ |
| 弹窗体系：AppDialog 基座（`dismissible` 防误关）+ 专用弹窗（确认/更新 UpdateDialog/启动进度 LaunchProgressDialog/微软登录 MsLoginDialog/添加账户/重命名/外链失败）+ 首启向导 WelcomeWizard | ✅ |
| 皮肤头像三级回落链：官方 `skinUrl` → minotar → 内置脸图（原版 UUID 哈希算法，18 张 8×8） | ✅ |
| i18n 三语：zh-CN / zh-TW / en（缺键回落 en，首启系统语言侦测） | ✅ |
| 独立控制台窗（?window=console）、启动期聚合下载进度、失败红态常驻 | ✅ |
| Tailwind 映射壳试点（preflight off，仅 var() 映射类） | ✅（试点，非全面迁移） |
| dev/demo.ts 无宿主设计回路 | ✅ |

**待改造（下一批 PR 的标的）**：

〔2026-11-01 收口：原「实例页/用户页/自定义版本页/实例切换」四条改造标的均已按双栏范式落地并移出本表（形态微调记录见 plan.md UI 迭代段）。〕

| 块 | 现状 | 目标（对齐 §2/§3/§7） |
|---|---|---|
| stylelint 自动拦截 | 未接入 | TODO（§1） |
| 火把点燃品牌时刻 | 未实现 | 预留（§6） |
