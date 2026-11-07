# Attic 契约文档（@attic/core-spec）

> 唯一真相在 [packages/core-spec/src](../packages/core-spec/src)。本文解释形状从何而来、双壳如何镜像、夹具如何消费。
> 状态：Phase 1 定稿。Phase 2（TS 运行时）与 Phase 4（Rust core）实现时若需改契约，必须改 core-spec + 本文 + 夹具三处并过 CI。

## 1. 设计戒律在契约中的落点

| 戒律 | 契约落点 |
| --- | --- |
| 数据驱动（无 `if (version == …)`） | 版本差异全部表达为 `VersionJson.betacraft` 扩展字段与 `agentMount` 决策表；`LaunchConfig` 是拼装终点，壳拿到即可 spawn，不再判断版本 |
| 契约唯一 | 通道名/事件名/payload 只在 `ipc.ts` 定义；Rust 侧按 §5 镜像规则一一对应 |
| 机密不出宿主 | `Account`（含 token）仅存在于主进程/Rust core；渲染侧只见 `AccountView` |

## 2. 领域类型

### 2.1 Account（[account.ts](../packages/core-spec/src/account.ts)）

`MicrosoftAccount | OfflineAccount`，判别字段 `type`。

- 事实来源：Betacraft v1 `uk.betacraft.auth`——MS 流程产出 `local_uuid + username + sessionid(token:accessToken:profileId)`（`MicrosoftAuth.java`），离线走 `NoAuth(username, uuid)`。
- `accessToken`/`refreshToken`/`tokenExpiresAt`/`profileId` 为宿主侧字段；刷新策略（v2 已知坑：token 过期未刷新导致皮肤/验证失效）在 Phase 2 的 runtime 实现。

### 2.2 VersionRef / VersionManifest（[version.ts](../packages/core-spec/src/version.ts)）

清单条目轻量形状。事实来源：Betacraft v1 `version_list.txt`（反引号分隔行，字段 0 为 id）+ `.info` 属性文件（`release-date`/`compile-date`/`other-name`）。`era` 供 Phase 3 年代分层 UI；`installed` 由本地扫描填充（真相源 = `versions/<id>.jar` 实存）。`custom` 按 v1 语义标记自定义版本：裸 jar（有 jar 无 `.info`）或 `.info` 声明 `custom=true`；custom 版本的 `.info` 归用户所有，启动时跳过远端重下/覆盖（v1 Launcher.java L412/L432 豁免），裸 jar 由类检测（`wrapperDetector.ts`，v1 WrapperDetector 移植，4k 除外——4k 走 `--appletClass M` 显式数据路径）合成启动元数据，检测失败显式报错（Error 7 语义）。`protocol` = 清单行第 5 列协议值（`classic_7`/`beta_14`/`release_60` 等，v1 联机协议同源字段 = `Release.java` fields[4]；实测 291 行中 73 行无第 5 列 = 缺席本键），仅供服务器列表协议全集派生（`attic:servers:list`）消费。取数策略 = **stale-while-revalidate**（2026-10-22 修「列表首帧空窗」）：`launcher/version_list.json` 缓存在即返 + 后台刷新落盘（最终一致，下一次拉取生效；UI 每次展开重拉，钉开态滞留一帧）；缓存缺席才 await 网络。需要「刷新完成」语义的门禁方（installMod 官方同名拒绝，用户拍板）走运行时内部直网面，不经本缓存即返路径。v1 无清单缓存机制（`version_list.txt` 每次全量远取、首帧空列表直到惰性加载），本策略为 attic 改进。

### 2.3 VersionJson（Mojang 兼容 + Betacraft 扩展）

- Mojang 兼容段：`mainClass`、`minecraftArguments`（远古单行式）、`arguments`（现代结构化，解析器须容忍两者共存/缺失）、`libraries`、`assets`/`assetIndex`、`downloads.client`/顶层 `jar`、`javaVersion`、`inheritsFrom`。
- Betacraft 扩展段 `betacraft`：字段集取自 v1 `ReleaseJson.java` 实测解析——`proxyArgs`（默认 `-Dhttp.proxyHost=betacraft.uk -Dhttp.proxyPort=11702`；v1 默认值缺端口为已知缺陷，custom 版未配置 proxy-args 时由本默认值兜底）、`launchMethod`、`launchMethodLink`、`protocolVersion`、`baseVersion`、`custom`、`fileVer`，外加本契约新增的 `agentMount`。
- 除 `id` 外全部可选：远古 JSON 缺字段是常态，"缺什么补什么"是 Phase 2 解析器职责，契约只声明形状。

### 2.4 AgentMount（legacyfix 挂载决策表）

```ts
{ form: 'javaagent' | 'coremod' | 'mod', path, appliesFrom, appliesTo?, quirk? }
```

- 形态判定事实（legacyfix README）：Vanilla/Risugami ModLoader/Forge ≤1.3 → `javaagent`；Forge 1.4 → `coremod`（落位 `<gameDir>/coremods/`）；Forge ≥1.5 / Fabric 系 → `mod`（落位 `<gameDir>/mods/`）。
- `javaagent` 展开规则（与 Betacraft v1 `Launcher.java` 一致）：`-javaagent:<dataDir>/<path>=<gameDir>`。
- `appliesFrom`/`appliesTo` 是版本 id 字符串，**区间判定属运行时**（需要清单顺序/编译日期知识），契约不做比较语义。
- 获取通道：`path` 相对启动器数据目录；jar 本体来自 fork GitHub Release `CreatorCSIE/legacyfix-attic`（`endpoint.legacyfixRelease` 可覆盖回上游，风险 #1/#8），下载与本地 sha256 锚校验走统一下载事件（§3）。同 release 另挂外部 addon jar 构件（见下「jar 形态 addon」）。

### 2.5 JavaInstall / JavaDetectionReport（[java.ts](../packages/core-spec/src/java.ts)）

移植 MCANextGen `java/model.ts`，去掉 Node 类型（`platform: string`）。四级候选（`manual/env/registry/directory/path`）+ `-XshowSettings:properties -version` 真实验证 + 64 位 Java 8 优先、32 位兜底（`usedFallback`）。失败面板需要全量候选与原因，故报告含 `installs/failures/diagnostics/selection.reason`（风险 #7）。

### 2.6 LaunchConfig（[launch.ts](../packages/core-spec/src/launch.ts)）

可执行的最小完备描述：`javaPath/gameDir/assetsDir/mainClass/classpath/jvmArgs/gameArgs/agentMount/maxMemoryMb/minMemoryMb?`。
不变量（由夹具固化，见 §4）：

1. `agentMount` 中 `javaagent` 条数 == `jvmArgs` 中 `-javaagent:` 条数，且逐条展开为 `-javaagent:<dataDir>/<path>=<gameDir>`；
2. `coremod`/`mod` 形态不产生任何 `-javaagent:` 参数（文件落位在 spawn 前由运行时完成）；
3. `jvmArgs` 含 `-Xmx<maxMemoryMb>m`；
4. `classpath[0]` 是版本 jar（`<dataDir>/versions/<id>.jar`，v1 平铺布局）；其余条目为 `bin/` 库池（整目录上 classpath，v1 `Wrapper.loadJars` 语义，清单由运行时注入）；
5. `gameArgs[0]` 是用户名；
6. `betacraft.proxyArgs` 全量进 `jvmArgs`。

`jvmArgs` 固定组（顺序即拼装顺序）：intelFix `-XX:HeapDumpPath=java.exe_minecraft.exe.heapdump`（仅 `context.intelFix=true`，即 win32 门控 + 实例键非 false——v1 Launcher.java L576-578 紧跟 javapath 的首位语义）→ `-Xmx`（+可选 `-Xms`）→ 全局 `jvmArgs`（`AppSettings.jvmArgs` 空白分隔逐 token）→ 实例 `launchArgs` 空白分隔逐 token 注入（v1 语义：重复 `-Xmx` JVM 取后者，实例覆盖全局，全局居中）→ 实例 addons `-Dlf.*` 目录映射 →（一次性 `LaunchRequest.visualizer`：补注 `-Dlf.visualizer`，档案已含 visualizer 时不重复）→ `-Djava.util.Arrays.useLegacyMergeSort=true` → `-Dhttp.nonProxyHosts=api.betacraft.uk|files.betacraft.uk|checkip.amazonaws.com|textures.minecraft.net` → LWJGL2 natives 两参（`org.lwjgl.librarypath`/`net.java.games.input.librarypath` = `<dataDir>/bin/natives`）→ `proxyArgs` → `-Dlf.proxy.levelServer=<AppSettings.levelServer>`（仅设置里有值时注入，覆盖 `gameDir/legacyfix/level-server.txt`）→ `-Dlf.version=<versionJson.id>`（全版本无条件注入；legacyfix 的版本等值补丁如 `Classic15aServerPortPatch.shouldApply` 判 `lf.version=="c0.0.15a"`，决策在 `Agent.premain` 的 Patcher.apply——早于 `--version` 解析与窗口标题探测两条晚到通道，`-D` 系统属性经 Agent 静态块收集是唯一赶得上决策点的通道，c0.0.15a 端口补丁不中事故根因）→ `javaagent` 展开 → 请求侧 `extraJvmArgs`。（曾有的 `-Dsun.java2d.dpiaware=false` 已证伪摘除——该 Oracle JDK8 扩展属性只影响 Java2D 渲染缩放，对 LWJGL 原生窗坐标无作用。）

Applet 容器（主类 `AppletLauncher`）的 `gameArgs` 末尾追加 `--width <w> --height <h>`（实例值，v1 缺省 854×480；`AppletFrame.java` 读取，缺省兜底 640×480）。非 Applet 版本窗口由 LWJGL/DeAwt 自管，不注入。

一次性直连 `LaunchRequest.server`（启动页「直连/单人」询问弹窗选「直连」才发，来源 = 激活实例档案 `server` 键，或档案缺省时弹窗内现场填写，§2.7）：拼装器解析 `ip[:port]` 后在 `gameArgs` 追加 `--server <host> --port <n>`——**端口恒显式传**（留空 = 本侧注入 25565；早期「缺省归 legacyfix 不显传」假设已证伪：CLI `--server` 路径端口缺省 = -1，`getValueForApplet("port")` 返 null，游戏自动加入要求 server+port 参数齐，缺 --port = 直进单人，裸指令实锤 2026-10-30），插入位 = 请求侧 `gameParams` 循环之后、Applet `--width/--height` 之前；非法格式（含越界端口）= 忽略仅 `[attic-launch]` 诊断、不拦启动。与 `visualizer` 同款一次性语义：**不写实例档案**、本次启动后不留痕。UI 校验/展示侧解析共用 core-spec `parseServerAddress`（语义一致）。

`bin/` 库池单通道（v1 移植，`depends.ts`）：**BC 基础库集**（depends）即唯一供给方——`depends-version.txt`（`libs-version`/`natives-version` 两行）与 `launcher.settings` 记录比对，不一致或缺物则重拉 `libs-<os>.zip`（BC patched `lwjgl.jar`/`lwjgl_util.jar`/`jinput.jar`）+ `natives-<os>.zip`（dll 集）→ 清空 `bin/` 重解 `bin/` 与 `bin/natives/`，版本号在解包成功后才写（v1 先写后解的假指纹缺陷已强化）；网络异常且本地库集在位 = assume-all-good 不拦启动（v1 语义），本地为空则启动失败。**Mojang 重发布回填通道已退役（2026-11-04）**：实测 b1.7.3→1.5.2 重发布库集全体同文 = 1.6 时代 wrapper boilerplate（无版本特有库），真依赖 lwjgl/jinput 族被污染闸门跳过，剩余 `launchwrapper/jopt/asm/jutils` 落跨版本共享池后触发 fork agent 存在性探测劫持（`LaunchWrapperInjector` 误报 → Agent 早退，整条 Patcher 矩阵 + addon 全跳过，26.11-attic.5 实机坐实；**fork 26.11-attic.7 已根除**：注入改按 `sun.java.command` 判真走 Launch，launchwrapper jar 仅躺在 classpath 上不再短路）；老版 jar 自包含、depends 三件套即足（v1 同口径），`mojangManifest` 端点与 `EndpointOverrides` 键一并拆除（存量 `launcher.settings` 的 `endpoint.mojangManifest` 键按未知键纪律保留不读）。动因（2026-10-22 实机）：库池缺 `org.lwjgl.LWJGLException` 类时 legacyfix `Agent.premain` 的重定义循环只 catch `ClassNotFoundException`，`NoClassDefFoundError` 穿透为 `processing of -javaagent failed` 秒崩；BC patched lwjgl 同时是修复红利（鼠标抓取等编进 jar）。

DeAwt 窗口偏移修复史（2026-11-04 切源收口）：启动器层曾以二进制常量池补丁给上游 26.10 jar 的 DeAwtPatch 注入体补 `Display.setLocation(frame.getX(), frame.getY())`（applet 容器高 DPI 右下偏移根因）。该修复已进 fork 源码（legacyfix-attic `DeAwtPatch.java`，commit 993cc31），agent 源切 fork 后启动器层补丁（原 `legacyfixPatch.ts`）与配套曾注入的 `-Dlf.minW/-Dlf.minH` 死通道（fork/上游构件均无消费方，javap+全文检索双证）一并退役。曾有的「同 release 构件无官方哈希 → 本地 meta 锚」纪律保留（`ensureLegacyfixAsset` 共用）。

jar 形态 addon（fork `AddonLoader`，2026-11-04 接线）：目录 `INSTANCE_ADDONS` 中 `addonAsset` 项（fullscreen/game-mode-switch/quit-game）不吃 `-Dlf.<prop>` 属性——勾选集映射为 `<dataDir>/launcher/addons/<addonAsset>-<agent 钉版>.jar` 绝对路径，单条 `-Dlf.addons=<逗号分隔>` 注入（位置 = `-Dlf.*` 属性组后、visualizer 补注前）。jar 本体由 `runtime.launch` 在 agentMount 落位后同版本 ensure（同 release 同 URL 拼装/同 meta 锚）；版本唯一事实源 = agentMount 文件名（`legacyfixReleaseVersion`），无挂载（版本在区间外）→ 不落位不注入 + `[attic-launch]` 诊断。fork 侧语义：`Agent` 静态块收集 `lf.*` → AddonLoader 逐项加载（manifest `LegacyFix-Addon` 入口），坏 addon 跳过不炸 agent。

c0.24 家族死链声音预置（`<gameDir>/resources/`，同样不动命令行，`runtime.ts#applyLegacyResources` + `legacyResources.ts`）：这些 jar 的 `ThreadDownloadResources.run()` 自拼 19 条 `https://s3.amazonaws.com/MinecraftDownload/resources/...`（step：wood/stone/grass/gravel × 序号 1-4；music：calm1-3），host 早已 404，scheme 写死 https（不吃 `http.proxyHost`）。URL 端键名 `newsound/step/wood1.ogg` 与落盘端 `resources/sound/step/wood1.ogg` **不同源** → 改写 host 或物化 `newsound/` 皆无效。做法 = `launch()` 在资产补全之后把已下载的资产对象（与 `-Dlf.assetsDir` 同源，零新增内置资源；索引键与对象逐一同源，故无需任何映射表）复制成 `<gameDir>/resources/<key>`，命中游戏自己的守卫 `new File(gameDir + file.getPath()).exists()` → 在位即 return、零请求。实测（JDK 8u202 反射直调真实 c0.24-dev8 jar 的 `run()`）：空 gameDir = 8-10s + 5 条 `FileNotFoundException`，预置后 = 40ms 零请求。**5 条而非 19 条**是字节码事实：`run()` 异常表粗粒度（step 段四次 `download()` 共用一个 try 7-271，music 段 calm1-3 同理 293-359），wood1 一抛即整块跳出 → stone/grass/gravel 与 calm2/calm3 连请求都发不出，故现状损失不止刷日志（四材质脚步声只有 wood 那条链有机会拿到文件，音乐只有 calm1 有机会）。闸门两条全是内容探测、**不写版本号**（744 jar 全扫：`MinecraftDownload` 只在 c0.24 家族，其中 `c0.24_st*` 5 枚无 https → 判否）：中央目录有资源下载线程类（`ThreadDownloadResources` 或 `c0.24_dev1` 的 `ResourceDownloadThread`）**且**明文含死链前缀常量。语义：幂等（目标在位且尺寸相符不动，缺席/尺寸不符 temp+rename 重写）；对象缺席只跳过该键（补下是既有 `downloadAssetObjects` 的职责）；`dryRunLaunch` 不预置（纯检视不留副作用）；任何失败 = 维持现状，永不阻断启动，诊断走 `[attic-runtime]`。**协议层路线已判死**（勿重试）：替换 https 处理器做 scheme 降级在装了 legacyfix 的启动次序里不生效——`GameArgs` 在无 `lf.proxy.disable` 时独占 `URL.setURLStreamHandlerFactory`（其工厂对 http 与 https 都返回自己的 Handler），JDK 8 工厂一旦设定即 `checkedWithFactory=true`，`java.protocol.handler.pkgs` 分支整段不查（实机探针：真实次序下自研 Handler 类根本不载入；抢注则让 legacyfix 抛 `Error("factory already defined")`，抢成功反而顶掉它那 12 条 https 重定向语义）。

`CrashCategory`（v0 分类器枚举）：`none/java-missing/out-of-memory/gl-init/lwjgl-native/unsatisfied-link/null-pointer/tim-sort/index-out-of-bounds/illegal-state/stack-overflow/unknown`。规则命中最优先（headline = 首个匹配行）；堆栈签名（2026-11-07 语义增强，a1.2.3 实测定型）走**两条腿**：① 日志尾部 `Stopping!` 行**紧邻**（中间只允许堆栈 body/header 行，遇普通日志行即止）的 Java 异常堆栈块 → 取块首行（`Caused by` 嵌套向上并拢到顶层 header，不拿无关行当死因）；② 无 `Stopping!` 在场时，块底落在日志末 ≤8 行的完整堆栈块（header+body 俱备，裸 header 单行不算）——alpha 崩溃路径 `catch(Throwable)→printStackTrace()` 不经过 `stop()`，压根不打 `Stopping!`，且 legacyfix 在 run() 尾注入 `System.exit(0)` 让崩溃以 0 码收场（实测三形态：0 码/0xCFFFFFFF fatal/SIGTERM 僵尸）。`Stopping!` 在场时腿②只扫**最后一个 `Stopping!` 之后**的尾段——infdev 20100327+ 系 `catch(Exception)` 不拦 Error，finally 先打 `Stopping!`、JDK uncaught handler 线程死透后才打栈（栈在收尾后=真崩溃）；收尾前压着的陈旧堆栈=正常退出噪音不报。classic/indev 族全程无 `Stopping!`（源码普查：0.0.x 与 0.28/0.31/201001xx 收尾不打任何日志），全靠腿②。**非致命头类闸**（两腿同闸，只看块顶层 header）：`java.net.*`（Socket/Connect/UnknownHost/Timeout 等）、`javax.net.ssl.SSL*`、`java.io.IOException` 族（EOF/FileNotFound 等）、`java.util.zip.*`、`javax.imageio.IIOException` 开头 → 不算死因——indev→infdev<0327 系 daemon 下载线程 `ThreadDownloadResources.run()`（混淆 `net.minecraft.client.j`）catch(IOException)→printStackTrace 拉死链打栈属游戏照常噪音（短会话恰压尾部）；嵌套 `致命类…Caused by: SocketException` 顶层仍报；真崩于 IO 异常的罕见场景落回退出码行兜底。两条腿都落空 → `exit code N` / `signal <名>`，与 close 处打进控制台的 `[attic-runtime] 游戏异常退出：…` 退出码行同源指向（崩溃即打此行；用户收尸的 SIGTERM 不打，headline 已是堆栈）。**非致命帧内容闸**（与头类闸并列，两腿同闸）：签名块 body 帧**全部**落在 `paulscode.`/`de.jarnbjo.`/`java.`/`javax.`/`sun.` 前缀（无一游戏帧）= 引擎线程噪音不算死因——indev-20100223 paulscode soundManager 线程 NPE 属非致命案例（用户点名）；c0.24-dev 实机补档：`de.jarnbjo` OGG 解码栈（SoundSystem 内置解码库读截断流）同族；含任一游戏帧（如 indev Minecraft.java L363 tick catch 的 `net.minecraft` 栈）照常致命。**致命死因专类**（2026-11-07 用户拍板）：签名死因块过闸后，按其**顶层 header** 归类——`java.lang.NullPointerException` → `null-pointer`；`IllegalArgumentException: Comparison method violates…`（特判消息文本，同型 IAE 其他消息不配专类）→ `tim-sort`；`java.lang.(Array|String|)IndexOutOfBoundsException` → `index-out-of-bounds`；`java.lang.IllegalStateException` → `illegal-state`（状态冲突/重复初始化）；`java.lang.StackOverflowError` → `stack-overflow`。归类只作用于签名死因块，杂散非致命栈不升格；`unknown` 只留未分类签名与退出码/signal 兜底。**退出码 0 不再恒正常**：命中签名仍报崩溃（专类按死因，未分类为 unknown）；规则不在 0 码上跑（正常退出日志里的陈旧 OOM/ENOENT 行会误报，0 码只认堆栈签名）。**用户主动停止**（`stoppedByUser:true`）常规中性不报，但经 `classifyStopped` 复核签名——游戏先崩、停止只是收僵尸（循环线程死透 JVM 不退）→ 仍报崩溃（专类同规则；UI 红条优先于中性条）。**崩溃弹窗**（2026-11-07）：签名命中时 `CrashSummary.stack` = 死因块全文（header+body 逐行；规则命中/兜底无栈），主窗 `GameCrashDialog` 订阅 GAME_EXIT 带 crash 即弹（与控制台窗开闭无关；AppDialog 形态：分类标题 + headline + 栈全文 + 解决方案提示），提示文案纪律 = **有确定解才写、无提示类别整段隐藏**（不放「无」占位）：`crashHint.tim-sort` 全版本通用（引导实例「JVM 参数」栏添加 `useLegacyMergeSort=true`）；`crashHint.stack-overflow-a123` **仅钉 `versionId === 'a1.2.3'`**（树叶枯萎官方缺陷 = 守卫被世界通知链归零 → 进树区 100% SOE、JVM 参数无法规避，出路只有换 1.2.3_01/Beta 1.1+，依据 minecraft-alpha-leaf-decay-analysis.md）；null-pointer 多因不同解刻意不写。新增特化改组件 `resolveHintKey`（指纹 → 类别+版本双键，指纹优先）。**崩溃指纹**（`CrashFingerprint`，runtime `KNOWN_CRASH_FINGERPRINTS`；2026-11-07 用户拍板：只认指纹、不做版本闸）：签名死因块顶层 header 命中（+可选帧锚）即挂 `CrashSummary.fingerprint`，**类别归属不变**（指纹只决定提示取键）。入表纪律 = 每条须有源码级案卷钉死唯一性，盲猜指纹禁止、宁缺毋滥；唯一性两形态：**①消息本身唯一**（全源码无第二处能造出该消息）只测 header；**②消息为 JDK 通用格式**（如 ArrayList 的 `Index: x, Size: y`）须**消息+帧锚合钉**，帧锚 = 本启动器分发 jar 的稳定类.行号（实机栈对榫）。现表两条：`indev-huge-worldgen` = 形态① `IndexOutOfBoundsException: 295936`（Indev 0.31 系天光 flood-fill 队列硬编码容量、Huge 建世首次天光初始化即写穿；数字 = 队列长度 = 越界下标本身，全源码唯一；案卷 minecraft-indev-0.31-huge-crash-analysis.md；提示 = 版本通病、建议不要创建 Huge 世界）；`classic-death-screen-ioob` = 形态② `IndexOutOfBoundsException: Index: 2, Size: 2` + 帧锚（Classic 生存测试死亡屏化石行：DeathScreen 从 PauseScreen 裁剪、`get(2)` 未随 2 按钮列表重编号，0.26–0.30 八只原始 jar 逐字节相同、从未修复，Indev 起 GUI 重写无此屏；帧锚按家族扩宽=已实证三形态 `c.p.a(p.java:12|Unknown Source)` + `e.r.a(Unknown Source)`（0.26 还原/0.27/0.30，原始 jar javap 扫描+实机栈对榫双背书），0.28/0.29 同雷但混淆名未取证待复现后并锚；触发面：0.26 还原件无守卫死亡必崩，0.27–0.30 包 `if(user==null)` 仅无会话态崩（本启动器常规恒注入 user 不触发——异常面按家族扩宽，环境变了弹得出）；案卷 minecraft-classic-0.26-st-death-screen-ioob-analysis.md；提示 = 0.26–0.30 均带此雷，解法行＝核对启动器会话参数注入是否正常（0.26 还原件例外、无解可给，不入建议））。**留痕边界**（对照案卷：classic 单人聊天 NPE 系被游戏内吞、不 printStackTrace）：日志无观测物 → 指纹无从谈起；分类器只报留痕的崩溃，吞栈缺陷靠静态考古、不靠运行时检测，也不为它加"猜它崩了"的旁路。

`LaunchRequest.testLaunch`（≡ 菜单"测试启动"）：宿主在 `attic:launch` 成功后把启动前后日志逐行落盘 `<root>/launcher/logs/test-launch-<ISO>.log`（启动器侧头行：时间戳/版本/java/gameDir/命令行——**accessToken 已脱敏**：命令行与游戏输出行里的 token 一律替换为 `[censored sessionid]` 再写盘，v1 Launcher.java L659/L685 同款；离线短 token `'0'` 不替换，避免误伤通用子串；随后游戏 stdout/stderr 全量；进程退出追加退出行并退订）。日志落盘归 runtime（不触窗）；独立控制台窗由 UI 侧随后调用 `attic:window:console` 唤起（普通启动受 `consoleOnLaunch` 开关约束，testLaunch 恒弹）。普通启动缺省不写；`AppSettings.diagnosticLog=true` 时普通启动同样落盘（文件名前缀 `launch-`）。固定文件 `launcher/logs/output-client.log` **不受该闸门约束、每次启动恒写**（开头截断 = 恒为最近一次启动，v1 clearClientLog 语义；崩溃诊断包尾 200 行即取此文件。2026-11-07 实机修复：曾误挂闸门致普通启动不生成）。

`LaunchRequest.visualizer`（≡ 菜单"启动无限地图可视化器"，探针驱动的**动作项**）：true = 本次启动在 addons 目录映射同位补注 `-Dlf.visualizer`，**不写实例档案**、一次性生效；UI 侧可点前置 = `attic:version:probe-class` 命中选中版本 jar 的 `probeClass` 条目 + 常规可启动。档案 addons 仍可携带 `visualizer` id（常开语义，装配器去重不双注）。legacyfix 侧已生效——Release 26.10 含 `VisualizerPatch`/`VisualizerLauncher`（2026-10-22 钉版升级；nightly 供给路线随之废除，实机验收见 plan.md Phase 6 条目）。

### 2.7 AppSettings / InstanceView（[settings.ts](../packages/core-spec/src/settings.ts)，Phase 3）

渲染侧只通过契约读写设置/实例，绝不直接碰 `launcher.settings` / `instances/*.txt`（戒律 #1：设置是数据）。

- `AppSettings`：`javaPath?`、`maxMemoryMb?`、`memoryMode?`（`auto|manual`，缺省 manual）、`theme?`（`dark|light|system`）、`language?`（i18n locale 键，渲染侧热切换，单一真相；localStorage 仅 bootstrap 缓存）、`jvmArgs?`（全局 JVM 参数，组序见 §2.6）、`checkIntegrity?`/`fixMissing?`/`minimizeOnLaunch?`/`diagnosticLog?`/`consoleOnLaunch?`（布尔三态：落盘 `'true'/'false'`，缺键 = undefined = 消费端缺省——`checkIntegrity`/`fixMissing`/`consoleOnLaunch` 缺省 true，`minimizeOnLaunch`/`diagnosticLog` 缺省 false；`consoleOnLaunch` = 启动成功后自动唤起独立控制台窗（v1「Game log」开关的全局化转置，testLaunch 不受约束恒弹））、`rootOverride?`（数据根更换：下次启动应用后由宿主从平台默认根 peek，portable/env 优先；**安装目录护栏**：宿主注入 `installDir` = dirname(process.execPath)，`setSettings` 拒绝指向安装目录内的 rootOverride——卸载 `{app}` 整删不可逆，向导/设置页/手改三入口同闸；peek 同款兜底拦存量手改=忽略回落默认根 + console.warn；**portable 形态改道（B 期）**：portable 激活时 rootOverride 落点 = 程序目录 marker ini 的 `rootDir`（随身指针面，不落 settings；相对按 exeDir 解析=换盘符纪律、绝对照用=UI 警示「换机即断」；空串 = 清除回落 exe 旁缺省），安装目录护栏跳过（无卸载器，`{app}` 风险面不存在），`getSettings` 把 ini 指针投映回 rootOverride 字段回显——两形态各写各的指针面，见 plan.md portable 终拍）、`wizardDone?`（首启欢迎向导完成标记：完成与跳过皆写，"已见过向导"语义与此键、与指针职责分离；向导三重门 = 无此键 ∧ 无 rootOverride ∧ 默认根无既有数据，任一不满足不弹；见 plan.md 向导定稿）、`wizardFlavor?`（`installed|portable`，B 期：三重门③ = 无**本 flavor** 完成标记——portable 只读回落与安装版共享默认根，无 flavor 戳则先完成者压掉后者弹窗、数据在错误形态下静默共用；A 期存量 `wizardDone=true` 无戳 = 视为 installed；向导完成时随 `wizardDone` 一并写，portable 戳同时触发幂等落锚 `launcher/portable.anchor`）、`lastPortableRoot?`（便携面包屑：portable 激活时 runtime 构造期把生效根登记进**平台默认根** settings——默认根永远可达，天然是登记簿；`getSettings` 回读恒取默认根位；启动发现生效根≠面包屑 ∧ 面包屑根有数据 → UI 一次性找回提示，ini 指针丢失的兜底出路）、`portableFallback?`（只读回落标记：exeDir 实写探针（mkdir+rm，不信属性位）不可写 → 生效根回落默认根 + 本键置真，UI 头区常驻徽标「数据未随盘」——一次性告知会被第二台只读机静默复用；runtime 回落/恢复时自动写清）、`levelServer?`（LegacyFix 关卡存档模式：`local`/URL；有值时直通 `-Dlf.proxy.levelServer`，抑制一次性对话框并覆盖陈旧 txt）、`updatePolicy?`（`startup|off`，缺省 `startup`：更新自动检查策略——`startup` = 启动时自动检查一次（无轮询），`off` = 从不自动检查；**只约束自动检查**，关于页手动「检查更新」两策略下恒可用）、`updateIgnoreVersion?`（「忽略此版本」单槽账：自动检查 `update` 命中本版本 → 不弹窗、不打红点（全静默）；手动检查无视此账恒显结果；写账 = 弹窗「忽略此版本」钮，undefined/删键 = 无忽略）、`updatePreview?`（布尔三态：落盘 `'true'/'false'`，缺键 = undefined = 关；「提前体验测试版」（HMCL 提前预览语义）：`update:check` 交互检查链数据源从 `/releases/latest` 切至 `/releases?per_page=30` 列表，候选 = **stable ∪ nightly 轨**（非 draft ∧ [prerelease→tag 含 `-nightly.` ∨ stable→tag 无 `-`]）取最大——开开关不丢 stable 提示；rc/0.0.x 预发布构件不受本键影响（预发布纪律优先，照旧 /latest 且永不提示）；nightly 构件恒在轨与开关无关；静默通道 latest.json 恒只收 stable）、`accentColor?`（强调色板 id，数据表 `ACCENT_COLORS` 七族，缺省 `amber` 火把琥珀；契约只持久化 id，色值 = 渲染侧 tokens.css `[data-theme][data-accent]` 静态层零运行时计算。预设主题 `THEME_PRESETS` = `theme+accentColor` 组合的快捷写入，**不新增落盘键**，当前预设由两控件现值反查推导）、`backgroundImage?`（主界面背景图绝对路径：仅配置时启用、无内置默认图，缺省/空 = 主题纯色；渲染侧经 `IMAGE_DATA_URL` 通道由宿主读字节转 data URL（双壳统一），文件不可读 UI 回落纯色）、`microsoftClientId?`（微软登录 CLIENT_ID 覆盖值，开发者设置面：空 = runtime 内嵌缺省；public client 公开标识符非机密，供自注册 Azure 应用先行验证）、`endpoints?`。落盘键同名 + `endpoint.*`；`setSettings` 合并写回、未知键保留（v1 遗留键不丢）。~~`username?`~~（2026-10-22 拍板删除：账户体系落地后零消费方的孤儿设置，启动玩家名恒取 `account.name`；文件里既有的 v1 `username` 键退出 managed 集后按未知键纪律原样保留、不读写不清除）。
- 派生语义（无独立契约键）：Java 模式 = `javaPath` 有值为手动、空为自动（自动 → 手动由 UI 固化当前选中项）；`javaPath` 双形态（2026-11-01 用户拍板，向导「指定 Java 目录」入口）= exe 路径原样 / JDK 目录由宿主向下至多两层解析 `bin/java`（Zulu 供给同款 `findJavaExecutable`），目录内无 java = 启动面显式报错、不静默回落自动探测；堆内存三级优先 = `LaunchRequest.maxMemoryMb` > `memoryMode=auto` 宿主估算（`round(总×0.4)` 取 128 步长夹 `[512,2048]`，取不到回落 1024）> `maxMemoryMb` 定值 > 1024；UI 展示拷贝与宿主估算公式改动须双侧同步。
- `EndpointOverrides`：全为可序列化的纯字符串（`versionList`/`filesBase`/`legacyfixRelease`/`zuluMetadata`/`modsList`/`serverList`）。函数形态的 `versionJson(id)`/`assetIndex(id)` 由 `filesBase` 在 runtime 侧派生（`endpointsFromOverrides`），契约层不携带可调用形状；`modsList` 缺省 = `http://api.betacraft.uk/getmods.jsp`（v1 `ModsRepository.java` 同源端点）；`serverList` 缺省 = `http://api.betacraft.uk/v2/legacy_server_list`（HTML，POST，社区服务器列表页单源）。端点属构造级配置——改动在下次启动应用后生效。
- `InstanceView`：对齐 v1 Instance Settings 可编辑集 `{ name, version, gameDir?, launchArgs?, width?, height?, javaPath?, addons?, intelFix?, forceUpdate?, server? }`。`gameDir` 缺省 = 宿主派生 `root/<实例名>`（v1 `Instance.newInstance`；已存在实例保留其落位）；`launchArgs`/`width`/`height` 缺省 = v1 `newInstance` 值（`-Xmx1G`、854×480，`loadInstance` 以缺省为底、属性覆盖）。版本是实例属性——**选中即写回激活实例**（v1 `SelectVersion.saveVersion` 语义：选中版本立刻落实例档案，不等启动；走 `attic:instances:set-version` 窄通道单字段读-改-写，视图不携带的 v1 遗留键不丢；UI 侧 seq 守卫丢弃快速连选的过期回包，失败静默、下次 load/启动回写收敛）。launch 入口保留同步段回写作兜底（`persistInstanceVersion` 委托同一窄通道，启动失败也已落盘；幂等：同值不重写）——同实例切版本存档共享语义不变。整档案保存（`attic:instances:save`）与设置保存同款纪律：properties 级合并写回，视图不携带的 v1 遗留键（`proxy/keepopen/RPC/console/isJavaPathNew`）由宿主以既有档案为底稿带走、未知键原样保留，视图字段显式缺席 = 清空删键。**反向清理（悬空指针，`removeCustomVersion` 联动）**：删除自定义版本/mod 卸载时，宿主扫全部实例档案把 `version` 恰等于被删 id 的写成**空串**（= 未选择；只动该字段，其余键一字不改，不匹配的档案零触碰）——回写在先，删版本必留悬空 id（既不能启动、又让 dock 与实例页显示已消失的版本并死锁 Play），删除不可逆故悬空无恢复语义。写空串而非删键：`loadInstance` 的 `version ?? 'b1.7.3'` 只在**键缺席**时兜底，删键会把实例静默改指向 v1 缺省版本。UI 侧空 `version` 渲染 `instance.versionNone` 占位（dock 副标题/实例行/详情三处），删除成功后联动重拉实例清单（`useCustomVersions.remove` 同 `useVersions`/`useMods` 联动）；删除确认弹窗按当前实例清单预告影响面（N 个实例 + 名字，纯客户端派生，无新通道）。`LaunchRequest.instanceId?` 缺省 = `default instance`（v1 首启自动建档）。
- `addons`（v1 同名档案键 = 逗号分隔；视图数组、宿主序列化）：目录 `INSTANCE_ADDONS` 数据驱动，`prop/mode` 映射 legacyfix `-Dlf.*`（enable=勾选注入 / disable=取消注入）；`addonAsset` 项（fork 外部 addon jar 三枚 fullscreen/game-mode-switch/quit-game，原 v1 占位转正）不吃属性，勾选集 → `-Dlf.addons=` 逗号路径表（§2.6「jar 形态 addon」）。三态：无键（老档案）= 零注入（legacyfix 自身缺省）；空串 = 显式全关；数组 = 勾选集。**勾选有变动即落盘**（`attic:instances:set-addons` 窄通道，set-version 同款单字段读-改-写；新建态例外随全档案首保）。`uiSection` 仅决定渲染归属（`basic`=实例页基本设置 card：vsync/proxy/skins/server-auth；缺省 `addons`=Addons card；`launchmenu`=启动页「≡」菜单：visualizer——**动作项**，点击 = `LaunchRequest.visualizer` 一次性启动、不读写档案），注入顺序按目录序。`probeClass`（launchmenu 项）= 可点前置：`attic:version:probe-class` 探测选中版本本地 jar 条目。visualizer 的 legacyfix 侧生效待 nightly（用户拍板：注入链保留、功能暂缓）。`demo`（v1 wrapper jar 族首个转正项）：legacyfix 原生 `-Dlf.demo` 即等价开关（`GameArgs.isDemo`；applet 参数注 `demo=true`、1.6 快照转 `--demo`、配套 BetaAntiPiracyHandler 回 400），v1 官方生效区间 12w16a–1.5.2，区间外属性无感。
- `intelFix`（v1 同名键，缺键 = true）：Windows 启动注入 `-XX:HeapDumpPath=java.exe_minecraft.exe.heapdump`（v1 首位语义，§2.6）；非 win32 恒不注入（门控在宿主 buildContext，拼装器保持平台中性）。`forceUpdate`（Attic 扩展键，v1 为全局 static 不落档案；缺键 = false）：启动下载编排旁路 jar/库/资产的「已存在即复用」检查重下（`.info` 的 custom 豁免不动）。两键均只在偏离缺省时落档案键。
- `server`（Attic 扩展档案键，v1 无对应物；缺键/空 = 未配置）：多人直连地址 `ip[:port]` 原样存（不做规范化，消费端解析）。非空 = 启动页 Play 前置「直连/单人」询问弹窗（确认形态，展示档案地址）；缺键/空 = 缺省触发面 = 选中版本 `betacraft.launchMethod` 命中 `MULTIPLAYER_JOIN_LAUNCH_METHODS`（数据表，当前 = `ClassicMpWithSaving`，戒律 #1 允许的数据形态）时仍弹（手动形态 = 弹窗现场填地址），否则不弹直接单人启动。两形态的「直连」都走 `LaunchRequest.server` 一次性注入（解析与组序见 §2.6，**不因启动/弹窗改写档案**）；关窗 = 放弃本次启动。保存 = 清空删键（与 `javaPath` 同语义）。实例页 UI 归属：基本设置 card 之下、Addons card 之上的独立「多人直连」card（单开保存按钮，地址/端口双框 ↔ 档案单串互转）。

### 2.8 Mods 仓库（一期 = Betacraft 单源）（[mods.ts](../packages/core-spec/src/mods.ts)）

事实来源：v1 `ModsRepository.java`（`getmods.jsp` 返回 JSON `ModCategory[]`，条目 5 字段 `full_name/version/info_file_url/website/autoupdate`）+ `Launcher.java` L409-429（autoupdate 消费）/ L793-876（mod jar → 基座合成）。类型面：`ModEntryRaw/ModCategoryRaw`（宿主解析产物，上游坏条目/坏分类剔除——`mods=null` 整类剔除修 v1 NPE，顶层非数组显式抛错不静默出半截列表）；`ModEntryView/ModCategoryView`（宿主附加 `installed` = `versions/jsons/<full_name>.info` 实存，不安全 id 恒 false 不触文件系统）；`ModInstallRequest`（UI 从列表项原样回传，宿主不复用渲染侧未校验字段）。

**安装语义（v1 Load 按钮 = saveVersions 的转写）**：只下载 `.info` 落 `versions/jsons/<id>.info`（tmp+rename 原子写 + 内容样貌校验，失败旧文件不动——替代 v1 backup.tmp 固定名互踩），并登记 `launcher/mods.json` `{infoUrl, autoupdate, installedAt}`；jar 与合成延迟到启动期（见下方「启动期语义」）。门禁：id 安全规则（同 CUSTOM 通道）、下载 URL 仅 http(s)、与官方版本清单同名拒绝安装（先联网刷清单缓存再判，v1 同名踩踏修复）；不写实例选中版本（v1 顺带改 `currentInstance.version` 的行为不照抄——只安装不动实例，用户拍板）。Mods 页无卸载钮（用户拍板），唯一删除途径 = 自定义版本页：mod 的 `.info`（含 `base-version`）落入 `listCustomVersions`（打 `mod` 标、右栏只读），该页删除联动清 `launcher/mods.json` 登记（防幽灵条目按登记 URL 复活），UI 删除 mod 项成功后联动重拉 Mods 列表（installed 徽标即时恢复「下载」）。`base-version` 为托管判型键：`saveCustomVersionInfo` 拒绝经编辑器写入（防普通自定义版本被误打标永久只读），UI 表单不提供该字段。

**启动期语义**：`refreshVersionInfo` 见登记 → 只按登记 `infoUrl` 刷新（autoupdate=false 且本地在位不联网；失败留旧文件离线启动；本地缺失且刷新失败 = 显式报错，修 v1 离线误路由官方 URL + 静默假可用）→ `ensureModJar`（`versions/mods/<id>.jar` 缓存，sha1 强制：`.info` 缺 sha1 且校验开启 = 拒绝无锚点下载；命中复用/不符重下/force 恒重下）→ 基座 `.info`/jar/libraries/assets 全按基座 → 每次启动重合成 `versions/<id>.jar`（基座条目在前、mod 同名覆盖；剥 `META-INF` 直接子级 `*.SF/*.DSA/*.RSA/*.EC`，保留 MANIFEST 与嵌套资源——修 v1 陈旧合成 jar 失配与过宽剥离）。mod 缺失字段继承基座（mainClass/launchMethod/assets/libraries 等；agentMount 区间判定用 baseVersion）。明示不修：依赖 `launch-method-link` 外部 wrapper 的 mod 属二期；`.info` 走 http 明文且无哈希锚点为上游继承性残余（jar 侧已由 sha1 强制缓解）。

## 3. IPC 通道与事件

### 请求通道（渲染 → 宿主，invoke/handle 或 command）

| 通道 | 请求 | 响应 |
| --- | --- | --- |
| `attic:ping` | — | `IpcResult<string>` |
| `attic:versions:list` | — | `IpcResult<VersionRef[]>` |
| `attic:versions:json` | `versionId: string` | `IpcResult<VersionJson>` |
| `attic:version:probe-class` | `versionId: string, className: string` | `IpcResult<boolean>`（本地 client jar zip 条目探测（如 `net/minecraft/isom/IsomPreviewApplet.class`）：启动页「≡」菜单 launchmenu 项启用判定。jar 未下载/损坏/无条目=false；宿主按 jar 路径+mtime 缓存条目清单。Rust 侧镜像：`versions/<id>.jar` 中央目录读条目名，同一语义） |
| `attic:launch:dry-run` | `LaunchRequest` | `IpcResult<LaunchConfig>` |
| `attic:launch` | `LaunchRequest` | `IpcResult<GameSession>` |
| `attic:launch:cancel` | — | `IpcResult<LaunchCancelResult>`（0.0.2 feat①：中止在途启动前下载/补全链；无在途/已 spawn=`cancelled:false`，取消后 launch 以「启动已取消」失败且不落 lastError。Rust 侧镜像：白名单转发通道，无专用 command） |
| `attic:kill` | — | `IpcResult<GameExit>` |
| `attic:status` | — | `IpcResult<GameStatus>` |
| `attic:java:detect` | — | `IpcResult<JavaDetectionReport>` |
| `attic:accounts:list` | — | `IpcResult<AccountView[]>`（可为空：无默认账户回落，空列表时 UI 禁用启动） |
| `attic:accounts:add` | `name: string` | `IpcResult<AccountView>`（仅离线账户；MC 规则 3-16 位字母/数字/下划线校验，同名幂等返回既有。微软账户走 `attic:accounts:ms:start`） |
| `attic:accounts:remove` | `id: string` | `IpcResult<void>`（可移除至空，无默认账户回落） |
| `attic:accounts:rename` | `id: string, name: string` | `IpcResult<AccountView>`（仅离线账户；MC 规则校验，同名幂等、与他名冲突报错；离线 UUID 随新名重生成，返回视图含新 id） |
| `attic:accounts:ms:start` | — | `IpcResult<MsDeviceCode>`（发起微软设备码登录；single-flight：已有在途流=错误返回。成功值=设备码展示面（`userCode/verificationUri/verificationUriComplete?/expiresIn/interval`），终局经 `attic:account:ms:login` 事件异步送达；token 机密全程驻宿主（DPAPI 用户作用域加密落盘，磁盘形态 `dpapi:v1:<b64>`），渲染只见 AccountView） |
| `attic:accounts:ms:cancel` | — | `IpcResult<void>`（取消在途设备码流：轮询中止 + 落 `canceled` 终局事件；无流在跑 = no-op 成功） |
| `attic:accounts:ms:refresh` | `id: string` | `IpcResult<AccountView>`（refreshToken → XBL/XSTS/MCS/profile 重放链，返回刷新后脱敏视图；启动编排对过期 token 自动刷新，本通道供 UI 手动「重新验证」；id 非微软账户/无 refreshToken/刷新失败=错误返回） |
| `attic:settings:get` | — | `IpcResult<AppSettings>` |
| `attic:settings:set` | `AppSettings` | `IpcResult<AppSettings>`（保存后的视图） |
| `attic:instances:list` | — | `IpcResult<InstanceView[]>` |
| `attic:instances:save` | `InstanceView` | `IpcResult<InstanceView>`（**properties 级合并写回**（`setSettings` 同款纪律）：托管键集内 defined→原位写入、undefined→删键（视图字段清空语义）；托管集之外的键原样保留——视图不携带的 v1 遗留键（`proxy/keepopen/RPC/console/isJavaPathNew`）由宿主以既有档案为底稿带走，未知键零触碰。曾经的整档案盲写覆盖会静默丢这些键，2026-10-25 判缺修正） |
| `attic:instances:set-version` | `name: string \| null, versionId: string` | `IpcResult<InstanceView>`（版本选中即写回：宿主 properties 级**单字段读-改-写**——只改 `version` 键，`InstanceView` 不携带的 v1 遗留键（`proxy/keepopen/RPC/console/isJavaPathNew`…）与未知键、键序全部原样保留；同值 = 不重写。`name` 空 = 回落 `default instance`（无档案按 v1 缺省建档）。比 `attic:instances:save` 更窄（连托管键都不动，UI 选中版本的高频动作零副作用），返回宿主权威视图供 UI 就地 upsert） |
| `attic:instances:set-addons` | `name: string \| null, addons: string[]` | `IpcResult<InstanceView>`（Addons 勾选有变动即落盘：set-version 同款 properties 级**单字段读-改-写**——只改 `addons` 键（数组 → v1 逗号分隔串；空数组 = 空串键 = 显式全关，区别于无键的 legacyfix 缺省开集），其余键与键序零触碰；同值 = 不重写。`name` 空 = 回落 `default instance`（建档兜底同 set-version）。实例页勾选与保存钮解耦：勾选即时写当前勾选集，表单其余现值不带走；新建态例外（档案未落，随全档案首保）。返回宿主权威视图供 UI upsert，seq 守卫 + 失败静默同 setVersion 口径） |
| `attic:window:control` | `WindowAction`（`minimize` \| `toggle-maximize` \| `close`） | `IpcResult<void>`（无边距窗顶栏三键；`toggle-maximize` 由宿主在最大化/还原间切换） |
| `attic:window:console` | — | `IpcResult<void>`（独立控制台窗口；v1 语义：MC 日志独立窗，与主页解耦。每次调用新建窗口并绑定当前会话 pid（`?window=console&pid=`），旧控制台不复用；ConsolePanel 按 pid 过滤本会话输出。唤起时机归 UI 侧：普通启动受全局开关 `consoleOnLaunch`（缺省开）约束，testLaunch 恒弹） |
| `attic:game:backlog` | `pid: number` | `IpcResult<GameBacklog{lines,exit,truncated}>`（控制台 backlog 补拉——丢首批日志的竞态根因修复：独立控制台窗挂载订阅前，spawn 瞬间的早期输出（LegacyFix premain 等）已广播完毕，实时事件面永远收不到。宿主按 pid 缓存会话输出（盖 seq 戳，环形封顶 1MB、最多 4 个会话）+ 退出事件；新窗**先订阅后补拉**，按 seq 去重有序插回；游戏秒退时顺带恢复已错过的 exit（崩溃摘要卡不空窗）。宿主未实现=错误返回，UI 静默降级为纯实时流） |
| `attic:custom:list` | — | `IpcResult<CustomVersionView[]>`（custom 项 + Mods 托管项：`.info` custom=true=已配置 / 裸 jar=未配置 / `.info` 含 base-version=模组版本（`mod:true`，已配置态但右栏只读）；Betacraft 官方版本不落入——**官方清单缓存 id 命中即官方，优先于本地 custom=true 残留声明**（inf-20100227-1433 实案，裸 jar 与已配置两分支同源排除），`importCustomJar` 同源拒绝官方 id） |
| `attic:custom:info` | `id: string` | `IpcResult<CustomInfoView>`（官方清单 id 直接拒绝；mod 的 `.info`（base-version）可读并打 `mod:true`（右栏只读）；已配置回 `.info` 原始 props；未配置裸 jar 附 `detectLaunchMethod` 建议——v1 检测名经 `canonicalLaunchMethod` 归一为官方值，必属 `launchMethods` 键集，表内无合法值（custom/1.6）不给建议；`launchMethods` 为合法键集，UI 下拉零硬编码） |
| `attic:custom:info:save` | `id: string, props: Record<string,string>` | `IpcResult<CustomVersionView>`（官方清单 id 直接拒绝；Mods 托管的模组版本（`.info` 含 base-version）拒绝编辑——autoupdate 会整文件重写，编辑必丢；props 携带非空 `base-version` 同样拒绝（托管判型键禁用户写入）；`launch-method` 必填；其余字段选填，留空落盘为 `key=` 空值段；强制 `custom=true`；launch-method 不在主类表内时必须显式给 main-class，否则报错） |
| `attic:custom:import-jar` | — | `IpcResult<CustomVersionView \| null>`（宿主弹原生文件对话框；取消=`null`；选中复制为 `versions/<id>.jar`，id=文件名去扩展名，同名报错不覆盖，落裸 jar=未配置态） |
| `attic:custom:remove` | `id: string` | `IpcResult<void>`（jar 与 `.info` 一并移除，mod 项联动清 `launcher/mods.json` 登记；门禁=listCustomVersions 成员判定，官方版本/不存在显式报错；UI 删除须经确认弹窗，本通道不做二次确认） |
| `attic:mods:list` | — | `IpcResult<ModCategoryView[]>`（Betacraft 单源仓库现拉现发，无进程内缓存——v1「追加不清空/永不刷新」修复；`installed` = `.info` 实存；解析防御见 §2.8） |
| `attic:mods:install` | `ModInstallRequest` | `IpcResult<void>`（只下 `.info`：id 安全 + http(s) 白名单 + 官方同名拒绝三道门禁；tmp+rename 原子写 + 登记 `launcher/mods.json`；jar 与基座合成延迟到启动期，见 §2.8） |
| `attic:servers:list` | — | `IpcResult<ServerListView[]>`（Betacraft `legacy_server_list` HTML 单源现拉现发，无进程内缓存——MODS_LIST 同款纪律；宿主宽松解析 join:// 四段（`ip:port/mppass/protocol/preferredVersion`，`mppass=use`=无密码省略键）+ 版本目录**两轨 × 三级**匹配派生 `matchedVersionId`（轨=宿主切分：官方轨（BC 清单原版）先行——原版服不被更长前缀的 mod/自定义 id 劫持；官方全不中才落 mod/自定义轨（轨成员 = 本地自定义条目 ∪ 远端仓库 full_name——getmods.jsp 现拉，v1 StartThread 启动即 loadMods + WebsitePanel.getMod 对仓库直匹配语义对齐，未安装的 mod 也能匹配上；仓库拉取失败 = 只落本地轨不拦列表；mod 轨三级 = 原样精确先行（trim+lowercase 全等，v1 getMod equalsIgnoreCase——2026-11-01 实测 full_name 恒带空格与 preferred 逐字同形，`in-20100223MP v0.1.7` 直命中）→ 尾 token/前缀三级居中 → 全名空格→下划线形兜底（历史形兼容））并打 `matchedVersionIsCustom:true`（UI 弹窗知情提示「将以模组/自定义客户端进服」，官方轨/未命中省略本键）；命中条目携带仓库 `.info` 直链时投 `matchedModInfoUrl`（本地已装条目不带 = 省略本键；UI 确认进服时据此 installMod 自动入库后再启动，失败弹窗可见呈现并中止，v1 直装语义）；级=精确/双向前缀取最长/未命中省略键=UI 手动选版本；戒律 #1：UI 零版本判断）；协议全集（v1 WebsitePanel 区间语义，2026-11-01 实装；取证 2026-11-03：v1 协议过滤读 `.info` `protocolVersion` 键而该键全清单缺席 = 坏档恒空窗（仅 mod 仓库一支生效），本实装系 v1 意图 + 清单第 5 列数据源的修复性实装，非 v1 行为复刻）= 官方清单第 5 列与 join:// 第三段**字符串相等**的全部版本（清单序）投 `compatibleVersionIds`，matched 不在集内（mod 兜底形/协议缺席形）追加末尾（与 v1「preferred 不在候选集则 getMod 追加」同构），协议段空/`unknown` 且无 matched = 省略本键；UI 消费=集合非空→弹窗目标版本区出区间下拉（预选=matched ?? 集合末项，v1 SelectServerVersion 语义，改选即换启动目标），空→回落单值静态/手动全列表下拉；**范围外判定 `versionOutOfRange`**（2026-11-03，BC v1 空白选版本窗的可见化改进）= protocol 已知（非空非 `unknown`）∧ 官方清单存在协议列可对照（清单不可得/protocol 全缺席的降级态恒省略本键，不误判）∧（compatible 全集空（matched 在场必已追加进全集，空集即双落空）**或矛盾闸**（preferred 非空 ∧ matched 落空 ∧ 协议全集非空 = 上游 preferred 与协议段互相矛盾（2026-11-03 4B4T `use/release_22/1.21.11` 实锤），协议段不可信→全集键一并省略））才打 `true`——UI 弹窗出解释态（要求版本/协议 + 复制服务器地址），无手动下拉与确认钮（库内任选必握手失败 = 自相矛盾；自备客户端走启动页经典多人数据表直连，名字对得上的自定义版本宿主 mod 轨本就会命中不进此分支）；协议空/unknown 服恒走手动形态；地址权威=join 段，span 展示仅兜底；上游无分类段=显式错误，UI 空态+重试。无图标兜底 = UI 仓内静态资源 `packages/ui/src/assets/unknown-pack.png`（上游 v1 占位图 `gui/unknown_pack.png` 本体，取证 a1.2.6.jar；2026-11-01 拍板入库随 UI 打包，不走宿主提取/data URL 通道）；`iconUrl` 缺席/加载失败即回落该图） |
| `attic:sys:info` | — | `IpcResult<SystemInfo>`（宿主快照单通道：`launcherVersion/platform/dataRoot/defaultRoot/defaultRootPopulated/logsDir/totalMemMb/freeMemMb/shell`；`shell` = 壳形态（`tauri` \| `electron`，宿主构造注入：sidecar 传 `tauri`，electron/legacy 缺省 `electron` 保守）；版本=壳注入（runtime 构造参数，缺省 0.0.0），内存=os 总量/空闲 MB 取整；`defaultRoot`=平台默认根（rootOverride 指针落位，portable 下也是它），`defaultRootPopulated`=该根已有真实用户数据（B 期修复 2026-10-25 口径 = 文件标记：launcher.settings——须含便携登记簿之外的键，`lastPortableRoot`/`portableFallback` 是 portable 写默认根的机器生成面包屑不算数，先用过便携版的机器装安装版向导不被压——/accounts.json/mods.json/实例任一/versions 顶层 jar/bin 顶层 jar——`ensureLayout` 骨架 = 纯目录零文件不误判，新机首启必弹的成立面；读失败=false 保守）；`portable?`（B 期便携态，安装版缺席本键）= `{active, fallback, rootPopulated, rebuilt?, pathWarning?}`，`rootPopulated` = 便携生效根数据态构造期快照（`ensureLayout` 前取，hasUserData 同款文件标记口径）——向导门之三 portable 数据源 = 本键而非 defaultRootPopulated（安装版/dev 历史在默认根，不得压掉便携首启弹窗）；只读回落态生效根 = 默认根，本键自然回落老语义——宿主显式传 exeDir + marker 候选（tauri=`sidecar/portable.ini`、electron/legacy=`resources/portable.ini`；sidecar 的 `process.execPath` = node.exe 不可信，硬纪律），runtime 双指纹判定 = 程序目录 marker 在场 ∨（exe 旁 `.attic` ∧ 其内 `launcher/portable.anchor`）；`rebuilt` = marker 缺席 anchor 自愈命中（升级重解压重置/误删 ini 后的便携身份恢复）；`fallback` = 实写探针不可写已回落默认根（头区常驻徽标）；`pathWarning` = 生效根非 ASCII/含空格/长度≥240（黄条警示，警告不拦截）；`lastCrash?` = 上次启动器异常退出简报 `CrashBrief{at,category,summary,stack}`（P0 脏退出标记 `<root>/launcher/crash-dirty.json` 构造期消费 = 读后即删，UI「上次崩溃」横幅只弹一次；缺席 = 上次正常退出）） |
| `attic:update:check` | — | `IpcResult<UpdateCheckResult>`（检查更新链，sidecar/主进程承接面。数据源 = GitHub Releases API，按构件轨分流（stable = `https://api.github.com/repos/{owner}/{repo}/releases/latest`，nightly = `.../releases?per_page=30` 列表，语义见下）；`/latest` 天然排除 draft/prerelease，不消费 latest.json；仓库 = runtime 构造选项 `releaseRepo`（`"owner/repo"`），缺省回落 env `ATTIC_RELEASE_REPO` > 默认同仓 `CreatorCSIE/Attic-Corner-Launcher`（2026-10-25 发布仓库收口 = 开发仓即发布仓；2026-11-05 品牌更名随仓库改名同步）；显式空串 = `unconfigured`（数据化明示不炸）；请求头 `User-Agent: Attic/<version>`（GitHub API 强制，无则 403，两轨同 UA）。semver 自研零依赖（semver 2.0 完整预发布序）：主段数字逐位比较（缺段按 0：`0.0.9<0.1.0`、`1.9.0<1.10.0`）、tag 去 v 前缀；预发布段 = 有预发布 < 无预发布（`0.1.0-nightly.X < 0.1.0`），标识符逐个比较（纯数字按数值 `nightly.2<nightly.10`、字母数字按 ASCII、数字恒小于字母数字、全等则短者小）。轨中纪律三句：**stable 构件（无 `-`）→ `/releases/latest` 单请求，行为照旧**（开设置键 `updatePreview` = 改走列表端点，候选 = stable ∪ nightly 轨取最大——开开关不丢 stable 提示）；**nightly 构件（含 `-nightly.`）→ `/releases?per_page=30` 列表轨中匹配**——候选 = `prerelease=true ∧ draft≠true ∧ tag 含 -nightly.`，跨 base 允许（`0.2.0-nightly.*` 对 `0.1.0-nightly.*` 也是更新，仍锁 nightly 轨永不混 stable），取最大者，高于 current → `update`，列表空/无候选/不高于 → `upToDate`；**其余预发布构件（0.0.x 短命试装轨、-rc 等，不含 `-nightly.`）→ 永不提示**（归 `upToDate`，手动跟 Releases 页）。相等/更旧 = `upToDate`。判别联合分支：`update{version,url,notes,publishedAt}` / `upToDate{current}` / `unconfigured` / `error{message}`（网络炸/非 2xx 含 404/响应缺 tag_name/仓库格式非法，均可读文案）——全分支数据化在 value 内，不占 error 封装。UI 消费 = 自动检查受设置键 `updatePolicy` 约束（`startup` = 启动时一次，无轮询；`off` = 从不自动查）+ 忽略账 `updateIgnoreVersion` 门（update 命中忽略账 → 不弹窗不打红点全静默；版本串比较天然兼容 nightly 版本号，忽略账与打扰门不随轨分流变化；打扰门纯函数 = runtime `updatePolicy.ts` shouldPromptUpdate）+ 关于页手动检查（无视策略与忽略账，弹窗四分支全可见）；update 分支弹窗 = 三钮框（忽略此版本/更新/取消，notes 经 runtime `markdown.ts` 最小子集渲染）；动作分叉现状 = 全壳统一「提示 + Releases 链接」（`attic:shell:open-url` 出门），tauri updater plugin 闭环待依赖决策挂账 |
| `attic:shell:open-dir` | `SpecialDir`（`data-root` \| `logs-dir`） | `IpcResult<void>`（宿主白名单枚举解析目录后 `shell.openPath`；logs 目录不存在时先建；不接受任意路径，防注入） |
| `attic:logs:clear` | — | `IpcResult<number>`（只删 `<root>/launcher/logs` 下 `*.log`，被占用文件跳过不报错；目录不存在返 0；返回删除数） |
| `attic:dialog:pick` | `PickTarget`（`java-executable` \| `directory` \| `image-file`） | `IpcResult<string \| null>`（原生打开对话框；取消=`null`；java 过滤可执行文件，directory 允许新建目录，image-file 过滤 png/jpg/jpeg/webp/gif/bmp） |
| `attic:image:data-url` | `path` | `IpcResult<string>`（宿主读图片字节转 base64 data URL；扩展白名单 png/jpg/jpeg/webp/gif/bmp + ≤12MB，违规/不可读=error；背景图进 webview，双壳统一） |
| `attic:shell:open-url` | `url: string` | `IpcResult<void>`（宿主 `new URL` 校验协议仅 http/https 后 `shell.openExternal`；渲染侧外链唯一出口） |
| `attic:crash:report` | `RendererErrorReport{source,message,stack?}` | `IpcResult<void>`（P2 渲染层错误静默上报：宿主只落 `launcher/logs/launcher.log`（`(时间戳) [ERR] [renderer:<source>]` 行），不弹框不打扰。Rust 侧镜像：sidecar 转发通道） |
| `attic:crash:bundle` | `category: string, stack: string` | `IpcResult<CrashBundleResult{text,issuesUrl}>`（崩溃诊断包：环境快照（启动器/Electron/Chrome/Node 版本 + OS/架构）+ 栈 + launcher.log/output-client.log 尾 200 行；`issuesUrl` = releaseRepo 数据驱动的预填 issue 链接（repo 未配置 = 空串）。消费面 = Vue CrashPanel 三按钮（复制=text 进剪贴板，报告=先写剪贴板再开 issuesUrl）；Electron 原生 dialog 路径不经本通道（主进程直调 runtime 同款函数）） |

统一 `IpcResult<T>` 封装：错误以 `{ ok:false, error }` 返回，不跨进程抛异常。未实现通道返回 `error: 'not-implemented'`（Phase 1 桥面占位即此值）。

### 事件通道（宿主 → 渲染，推送）

| 事件 | payload | 说明 |
| --- | --- | --- |
| `attic:game:output` | `GameOutputEvent{stream,chunk,pid,seq?}` | stdout/stderr 流，UI 控制台面板消费；`seq` = electron 宿主广播时盖的会话内单调序号（backlog 补拉与实时事件去重用，见 `attic:game:backlog`；宿主不实现 backlog 时缺省） |
| `attic:game:exit` | `GameExitEvent{code,signal,crash,stoppedByUser?,pid,versionId}` | 退出 + 崩溃分类摘要；`stoppedByUser:true` = 用户主动停止（点停止按钮/关游戏窗触发看门狗），`crash` 恒为 null，控制台以中性条显示最后一行日志；外部 taskkill/自身异常退出仍照常报崩溃条 |
| `attic:download:progress` | `DownloadProgressEvent{item,id,phase,bytesDone,bytesTotal?,bytesPerSec?,error?}` | jar/资产/Java/legacyfix 统一形状；`phase`: `queued/transferring/verifying/done/failed/cancelled`（cancelled=feat①取消中止，UI 落中性态）；`item=asset-check` = 资产检查阶段合成事件（queued/transferring/done 括住存在性+尺寸核对循环，id=资产索引 id；`bytesDone/bytesTotal` = 已核对对象数/对象总数（**非字节**，动态节流连发并让出事件循环——UI 字节聚合层对此 item 除外计入；HMCL 启动弹窗移植，UI 阶段行数据源）。**cache-hit 合成对**（五轮根因修正：全本地启动曾零事件、弹窗空白）：version-json/client-jar/mod-jar/library/asset-index/legacyfix 缓存命中同样发 queued/done 一对（字节=本地文件大小或 0），阶段行「缓存=秒过 ✓」；真下载路径 download() 同键自带序列覆盖，无双计 |
| `attic:custom:info-changed` | `CustomInfoChangedEvent{id}` | 宿主监视 `versions/jsons/` 目录：外部编辑/新建/删除 `.info`，按 id 去抖 250ms 合并后发射；自定义版本配置页实时刷新（未编辑自动重载，有未保存编辑则提示不覆盖；本方保存/删除的回声由 UI selfWrite 窗口吸收） |
| `attic:account:ms:login` | `MsLoginEvent`（`{state:'success',account:AccountView}` \| `{state:'error',code:MsLoginErrorCode}`） | 微软设备码登录流终局（success=账户已落盘；error=八分类码之一：`access_denied/expired_token/no_xbox_profile/minor_parental/no_minecraft/canceled/network/internal`——HTTP 原文可能含 token/URL 查询串，一律不过桥，只传分类码；弹窗按码出文案） |

## 4. 契约测试夹具

目录：[packages/core-spec/fixtures/](../packages/core-spec/fixtures)。每个夹具：

```jsonc
{ "name", "description",
  "context":     { "javaPath","gameDir","assetsDir","dataDir","username","uuid","accessToken","maxMemoryMb",
                    "binPool" /* 注入的 bin/ 库池绝对路径清单 */, "versionOrder" /* 年代序（编译日期升序）的版本 id 数组，agentMount 区间判定用；上游清单本身乱序，不可直接用其行序 */ },
  "versionJson": { /* VersionJson 输入 */ },
  "expected":    { /* LaunchConfig 期望输出 */ } }
```

现有 4 个夹具覆盖三形态：`c2.0-javaagent`、`b1.7.3-javaagent`（占位符展开 + 代理参数）、`1.4.7-forge-coremod`、`1.5.2-forge-mod`。

- **TS 侧**：[tests/contract.test.js](../packages/core-spec/tests/contract.test.js)（`node --test`）断言形状 + §2.6 不变量。Phase 2 起，runtime 的 LaunchConfig 拼装器必须对同一组夹具产出 `expected`（行为断言替换形状断言）。
- **Rust 侧**（2026-10-22 口径修订）：拼装器不再有 Rust 第二实现（启动核心单一承载 = Node sidecar，见 §5 双壳接入模型），本组夹具的跨实现同绿闸门**收窄为契约镜像闸门**：`cargo test` 读 `tests/fixtures/ipc-channels.json` 比对 `src-tauri` 通道镜像；TS 侧 `fixtures:check` 保证 fixture 与 sidecar 导出表不漂移。
- 夹具路径为中性 POSIX 风格字符串；两实现都不得对路径做平台假设（拼装时原样透传即可）。

## 5. Rust 镜像规则（Phase 4 约束）

- 类型名一一对应（`LaunchConfig` → `struct LaunchConfig`），字段名保持 camelCase：serde 统一 `#[serde(rename_all = "camelCase")]`。
- 判别联合用 `#[serde(tag = "type", rename_all = "camelCase")]`（`Account`）；`AccountType`/`form`/`phase` 等字符串枚举用 `#[serde(rename_all = "camelCase")]`。
- 通道/事件常量镜像为 `src-tauri` 内同名 `pub const`，值必须与 `ipc.ts` 逐字节一致（契约测试含常量比对）。
- 可选字段用 `Option<T>` + `#[serde(skip_serializing_if = "Option::is_none")]`，缺省语义与 TS `?` 对齐。

### 双壳接入模型（Phase 4/5 脚手架落地）

三壳并立，UI 面（RendererBridge）唯一：

| 壳 | 核心承载 | 桥注入 | 定位 |
| --- | --- | --- | --- |
| `apps/electron` | 同进程直连 `AtticRuntime` | preload → `window.attic` | 日常开发 + 可选 Windows 发行形态（Electron 33，Inno electron flavor，更新 = 检查+提示+手动下载；双壳并进 2026-10-24） |
| `apps/electron-legacy` | 同上（esbuild 打包 = fetch 桥 + **同一份** `main.ts` 源码） | 同上 | Win7/8/8.1 兜底发布线（Electron 22 = Chromium 108 / Node 16.17，无自动更新） |
| `apps/tauri` | **Node sidecar 子进程**（`@attic/runtime` 门面） | UI `bridge/tauri.ts` 适配 `window.__TAURI__`（withGlobalTauri）→ Rust 命令 | 主发布线（Windows Inno Setup + updater 分轨） |

Tauri 线 Rust↔sidecar 线协议（stdio NDJSON，一行一帧；sidecar `src/server.ts`）：

- 请求 `{id:number, method:string, params:unknown[]}`；响应 `{id, result}` | `{id, error}`；事件推送 `{event, payload}`（无 id）。
- **错误以数据返回不跨进程抛**（IpcResult 语义的线协议形态）；`IpcResult` 封装由 Rust 壳完成（`{result|error}` → `{ok,value|error}`）。
- 通道切分：41 契约通道 = **34 sidecar 承接** + **7 宿主面**（`window:control / window:console / instances:open-dir / shell:open-dir / shell:open-url / dialog:pick / custom:import-jar`，Rust 直处理；sidecar 收到即防御拒绝）。宿主面拆步走 `attic:internal:*` 私有方法（`instance-game-dir / special-dir / import-jar / shutdown`：Rust「先拿路径/入参，再做宿主动作」）。
- 控制台 backlog（seq 盖戳 + 1MB 环形 + 4 会话）归属**壳层**：Electron 线在主进程、Tauri 线在 sidecar。
- 环境面：`ATTIC_LAUNCHER_VERSION`（Rust 注入包版本）；`ATTIC_SIDECAR_NODE / ATTIC_SIDECAR_ENTRY`（开发/调试逃生舱）；sidecar 解析次序 = env 覆盖 → 安装态（resource 目录 `sidecar/server.cjs` + 随行/PATH node）→ 开发态仓内 dist。

跨语言镜像闸门（戒律 #2 执行面）：`scripts/emit-contract-fixtures.mjs` 从 sidecar 导出表生成
`packages/core-spec/tests/fixtures/ipc-channels.json`；Rust `contract_tests`（cargo test）与
`fixtures:check`（CI）双向比对；Node16 API 锁 = `scripts/node16-api-gate.mjs`。

Windows 安装器结论（2026-10-24 改拍板：NSIS → Inno Setup）：双壳共用仓库级
`installer/attic.iss`（flavor 参数化 main/legacy，Inno 6.7.3 版本钉，简中 isl vendor
于 `installer/lang/`）；两壳的 nsis target 均退场（tauri `--no-bundle` + stage 组包、
electron-builder `--dir`），CI 用 ISCC 出安装器、`tauri signer sign` 手动签名 updater 产物。
定制面 = `[Code]` 双闸 guard（主壳 Win10+ / 兜底壳 Win7 SP1+；x64 载荷 IsWin64 防错装）+
`PrivilegesRequired=lowest` 纯用户级安装。WebView2 引导残余差异（embedBootstrapper 随
nsis target 退场）与 NSIS 崩溃戒律归档见 attic.iss 头注及 plan.md。

## 6. 端点与版本数据流（Phase 2 预告）

`version_list → .info/VersionJson → jar/资产/库下载（事件 3）→ LaunchConfig 拼装（不变量 6 条）→ spawn`。所有上游 URL 经端点配置层重写（风险 #1），契约中的 URL 字段只是上游原值。
