; ============================================================================
; Attic Corner Launcher —— Inno Setup 6 共享安装脚本（双壳一个 .iss，flavor 参数化）。
;
; 路线拍板（2026-10-24）：双壳安装器由 NSIS 切 Inno —— NSIS 默认观感老旧、宏/插件
; 层晦涩（builder 模板 customInstallMode×UAC 插件 0xc0000005 崩溃史见 plan.md），
; Inno 的 Pascal [Code] 可维护性优先。两壳的 nsis target 均退场：
;   * 主壳（tauri）    ：tauri build --no-bundle → stage 目录（exe + sidecar/，bundler
;                        的 resources 拷贝不随 --no-bundle 发生，CI 显式组包）
;   * 兜底壳（legacy） ：electron-builder --dir → release\win-unpacked\
;   注意：Inno Setup 6 的 ISCC 仅有 32-bit 构建，产物安装器天然兼容 32/64-bit 全部
;   Windows —— 双 flavor 都用同一个 ISCC；"64-bit 构件装 32-bit 系统"的拦截因此
;   必须由 [Code] 的 IsWin64 闸门完成（对应原 NSIS ${RunningX64}）。
;
; CI/本地调用（ISCC 命令行 /D 一律带引号；VERSION 传去 v 前缀的 tag）：
;   ISCC /DATTIC_FLAVOR="legacy" /DATTIC_PAYLOAD="<win-unpacked>" \
;        /DATTIC_VERSION="0.0.0" /DATTIC_ARCH="x64" attic.iss
;   → attic-<shell>-windows-<arch>-<version>-setup.exe
;   构件命名统一范式（2026-10-24 用户拍板；2026-11-05 品牌更名，前缀 amcl→attic，
;   attic = Attic Corner Launcher 简称）：
;   attic-<shell>-<os>-<arch>-<ver>，shell = tauri | electron | electron-legacy（分发名走
;   ATTIC_NAME_SHELL：flavor 内部 ID 仍是 legacy，2026-10-25 用户反馈裸 legacy 看不出壳属，
;   分发名补 electron- 前缀）；
;   安装器后缀 = -setup（本 iss 产出）；portable 目录构件后缀 = -portable（CI 压缩步骤产出）。
;   戒律（实测）：Inno 的文件类路径（OutputDir / [Files]Source / SetupIconFile）相对
;   解析基准 = **本 .iss 所在目录，不是 cwd**——从仓根传 "installer\dist"、"stage"、
;   "apps\...\icon.ico" 会落 installer\installer\dist、installer\stage、编译报错。
;   OUTDIR 走缺省 "dist"（= installer\dist）不传；PAYLOAD 一律传绝对路径。
;   安装器图标 = Inno 缺省，两壳皆然（用户 2026-10-24 终拍：严格维持默认，不设
;   SetupIconFile 参数面；应用图标只归 exe/快捷方式/卸载面板面）。品牌位图/自定义
;   皮肤全部不上，向导维持 Inno 原生观感。
;
; 形态约定（本文件内不再改动）：
;   * 纯用户级（PrivilegesRequired=lowest，装 %LOCALAPPDATA%）——替代原 NSIS
;     customInstallMode 跳范围页的全部职能；无范围选择页（Inno 天然干净）
;   * 双闸 guard 移植自 windows/attic-checks.nsh：主壳/Electron 壳判 Win10+（WebView2 110 钉
;     由 OS 闸门代管；Evergreen 自更；embedBootstrapper 随 nsis target 退场，
;     残余差异记 plan.md；Electron 壳 = Electron 33，地板同为 Win10）；兜底壳判 Win7 SP1+
;     （Electron 22 = Chromium 108 一代，Win7 SP1 为其地板）
;   * attic:// 协议注册归运行时插件面，安装器不写协议表（与迁移前一致）
;
; 更新通道衔接（latest.json platforms.windows-x86_64）：
;   * 旧 NSIS 时代：url = bundler 产 *-setup.exe（bundler 自动签名）
;   * Inno 时代    ：url = ISCC 产 setup.exe，签名由 CI 用 `tauri signer sign`
;     手动产出 .sig（签名对象=任意字节流，不受安装器格式限制）；
;     tauri-plugin-updater 下载后以默认方式打开 exe → Inno 向导出现，用户点两下
;     （升级体验从"静默直装"变"可见向导"，拍板接受）
; ============================================================================

#ifdef ATTIC_FLAVOR
#else
  #define ATTIC_FLAVOR "tauri"
#endif
#define Is(S, X) (Pos(X, S) > 0)
#define LEGACY Is(ATTIC_FLAVOR, "legacy")

#ifdef ATTIC_VERSION
#else
  #define ATTIC_VERSION "0.0.0"
#endif
#ifdef ATTIC_ARCH
#else
  #define ATTIC_ARCH "x64"
#endif
#ifdef ATTIC_OUTDIR
#else
  ; 相对基准 = 本 .iss 目录（installer\）→ 产物落 installer\dist
  #define ATTIC_OUTDIR "dist"
#endif

#if   ATTIC_FLAVOR == "legacy"
  #define ATTIC_APPID  "uk.attic.launcher.legacy"
  #define ATTIC_NAME   "Attic Corner Launcher Legacy"
  ; 与 electron-builder.yml productName 派生的 exe 名严格一致（改名两处同动）
  #define ATTIC_EXE    "Attic Corner Launcher Legacy.exe"
  ; 分发名壳段（用户反馈 2026-10-25）：裸 "legacy" 看不出是 Electron 22 兜底壳，补 electron- 前缀；
  ; flavor 内部 ID（AppId/注册表/portable marker）仍为 legacy 不动——只改用户可见的构件名。
  #define ATTIC_NAME_SHELL "electron-legacy"
#elif ATTIC_FLAVOR == "electron"
  ; 双壳并进（2026-10-24 用户拍板）：Tauri 主壳优先推荐，Electron 壳为可选发行形态。
  ; AppId/目录/快捷方式三者与主壳分离可同机共存；数据根两壳同走 .attic（壳只是窗层）
  #define ATTIC_APPID  "uk.attic.launcher.electron"
  #define ATTIC_NAME   "Attic Corner Launcher (Electron)"
  #define ATTIC_EXE    "Attic Corner Launcher (Electron).exe"
  #define ATTIC_NAME_SHELL "electron"
#elif ATTIC_FLAVOR == "tauri"
  #define ATTIC_APPID  "uk.attic.launcher"
  #define ATTIC_NAME   "Attic Corner Launcher"
  ; exe 名统一（2026-10-26 用户拍板）：crate 名孤例 attic-launcher.exe → productName 派生系
  ; （与两 electron 壳同轨），改名点 = tauri.conf.json mainBinaryName；见 [InstallDelete] 残留清理
  #define ATTIC_EXE    "Attic Corner Launcher.exe"
  #define ATTIC_NAME_SHELL "tauri"
#else
  #error ATTIC_FLAVOR 未知取值：tauri | electron | legacy
#endif

#if ATTIC_ARCH == "x64"
  #define ATTIC_64MODE "x64"
  #define NEED64 True
#else
  #define ATTIC_64MODE ""
  #define NEED64 False
#endif

#ifdef ATTIC_PAYLOAD
#else
  #error ATTIC_PAYLOAD 必传：/DATTIC_PAYLOAD="<构件目录>"（win-unpacked 或 tauri release）
#endif
[Setup]
AppId={#ATTIC_APPID}
AppName={#ATTIC_NAME}
AppVersion={#ATTIC_VERSION}
AppVerName={#ATTIC_NAME} {#ATTIC_VERSION}
; 开发者口径 = README 署名（CreatorCSIE，GPLv3 Copyright (c) 2026）——控制面板发布者/安装器 exe 属性均同源
AppPublisher=CreatorCSIE
AppPublisherURL=https://github.com/CreatorCSIE/Attic-Corner-Launcher
VersionInfoCopyright=Copyright (c) 2026 CreatorCSIE
; 许可协议页（2026-11-01 用户拍板）：GPLv3 全文（仓库根 LICENSE，与 README License 节同源）
LicenseFile=..\LICENSE
; 默认语言钉 English（2026-11-01 修正：原 [Code] ActiveLanguage('en') 是编不过的臆写——
; ActiveLanguage 为无参 getter；官方开关本指令 = 不做系统 locale 侦测，恒落 [Languages] 首项 en；
; 多语言下语言选择页照常出现（ShowLanguageDialog=auto），简中/繁中仍可选）
LanguageDetectionMethod=None
; {autopf} 在 lowest 特权安装 = %LOCALAPPDATA%\Programs（VS Code/Blockbench 同轨；
; 勿用 {localappdata} = %LOCALAPPDATA% 根，实测已踩）
DefaultDirName={autopf}\{#ATTIC_NAME}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesInstallIn64BitMode={#ATTIC_64MODE}
OutputDir={#ATTIC_OUTDIR}
OutputBaseFilename=attic-{#ATTIC_NAME_SHELL}-windows-{#ATTIC_ARCH}-{#ATTIC_VERSION}-setup
; SetupIconFile 有意不设：安装器图标维持 Inno 缺省（两壳统一，终拍见头注）
UninstallDisplayName={#ATTIC_NAME}
UninstallDisplayIcon={app}\{#ATTIC_EXE}
Compression=lzma2/max
SolidCompression=yes
UsePreviousAppDir=yes
CloseApplications=yes

[Languages]
; 排序与默认（2026-10-31 用户拍板）：English 第一、简体中文第二、新增繁體中文；
; 默认语言 = English，由 [Setup] LanguageDetectionMethod=None 保证（恒落本表首项，
; 详见 Setup 段注释）；两中文皆非官方翻译，
; 不随 Inno 安装包分发 —— 已 vendor 进 installer\lang\（简中 6.7.3 版 / 繁中 6.5.0+ 版）
Name: "en"; MessagesFile: "compiler:Default.isl"
Name: "zh"; MessagesFile: "{#SourcePath}lang\ChineseSimplified.isl"
Name: "zhtw"; MessagesFile: "{#SourcePath}lang\ChineseTraditional.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[InstallDelete]
; exe 改名（2026-10-26）升级残留清理：0.0.1/0.0.2 装的旧 crate 名 exe 不在新 [Files]
; 清单里，Inno 升级不会自动删 = {app} 僵尸 exe（双入口可误启旧版）；仅 tauri flavor 需要
#if ATTIC_FLAVOR == "tauri"
Type: files; Name: "{app}\attic-launcher.exe"
#endif

[Files]
Source: "{#ATTIC_PAYLOAD}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{userprograms}\{#ATTIC_NAME}"; Filename: "{app}\{#ATTIC_EXE}"
Name: "{userdesktop}\{#ATTIC_NAME}"; Filename: "{app}\{#ATTIC_EXE}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#ATTIC_EXE}"; Description: "{cm:LaunchProgram,{#ATTIC_NAME}}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
Type: filesandordirs; Name: "{app}"

[Code]
// 双闸 guard（移植自 windows/attic-checks.nsh）：
//   主壳   = Win10+（WebView2 110 由 OS 面代管；Evergreen 自更）
//   兜底壳 = Win7 SP1+（Electron 22 = Chromium 108 一代，Win7 SP1 为其地板）
// 32-bit 主机装 x64 构件的拦截 = [Code] 的 IsWin64 闸门（NEED64=ARCH=="x64" 时启用）：
// 安装器本体是 32-bit、在 32-bit 主机能启动，不会"自然挡"，必须自己拦
// （等价原 ${RunningX64}）。
// 版本源 = HKLM\...\Windows NT\CurrentVersion（6.3+ 的 CurrentMajorVersionNumber
// 为权威；老系统回退 '6.1 SP1' 式 Version+CSDVersion 解析）。Inno 6 脚本 API 没有
// GetWindowsVersion —— 别照抄 Inno 7 文档。
const
  LegacyDownloadUrl = 'https://github.com/CreatorCSIE/Attic-Corner-Launcher/releases';

function GetWinMajorSP(out Major, SP: Integer): Boolean;
var
  Maj, Min: Cardinal;
  S: String;
  P: Integer;
begin
  Result := False;
  SP := 0;
  if RegQueryDWordValue(HKLM, 'SOFTWARE\Microsoft\Windows NT\CurrentVersion',
      'CurrentMajorVersionNumber', Maj) and
     RegQueryDWordValue(HKLM, 'SOFTWARE\Microsoft\Windows NT\CurrentVersion',
      'CurrentMinorVersionNumber', Min) then
  begin
    Major := Maj; // Win8+ 路径（10/11 均报 Major=10）
    if Major >= 8 then SP := 1; // SP 概念对 Win8+ 无意义，置 1 表示"够新"
    Result := True;
    Exit;
  end;
  // Win7 等老系统：无上述 DWORD，退回字符串解析 '6.1' + CSDVersion 'SP1'
  if not RegQueryStringValue(HKLM, 'SOFTWARE\Microsoft\Windows NT\CurrentVersion', 'Version', S) then Exit;
  P := Pos('.', S);
  if P = 0 then Exit;
  Major := StrToInt(Copy(S, 1, P - 1));
  if RegQueryStringValue(HKLM, 'SOFTWARE\Microsoft\Windows NT\CurrentVersion', 'CSDVersion', S) then
  begin
    if Pos('SP2', S) > 0 then SP := 2
    else if Pos('SP1', S) > 0 then SP := 1;
  end;
  Result := True;
end;

function InitializeSetup: Boolean;
var
  Major, SP: Integer;
  Msg: String;
  VS: String;
begin
  Result := True;
  // 默认语言 = English 经 [Setup] LanguageDetectionMethod=None 实现（本函数不设语言——
  // ActiveLanguage 是无参 getter，Pascal Script 无法赋值）
  if not GetWinMajorSP(Major, SP) then Exit;

#if LEGACY
  // Win7 = 6.1 且必须 SP1+；更低（Vista 6.0 / XP 5.x）拒装
  if (Major < 6) or ((Major = 6) and (SP < 1)) then
  begin
    RegQueryStringValue(HKLM, 'SOFTWARE\Microsoft\Windows NT\CurrentVersion', 'ProductName', VS);
    Msg := 'Attic Corner Launcher Legacy 需要 Windows 7 SP1 或更新系统（当前：' + VS + '）。';
    MsgBox(Msg, mbCriticalError, MB_OK);
    Result := False;
    Exit;
  end;
#else
  // 主壳地板 = Win10（Major 10；Win11 同报 10）。戒律：[Code] 内禁用 #13#10 字符码
  // ——续行以 # 开头会被 ISPP 当预处理指令（Unknown preprocessor directive，实测两踩），
  // 换行一律 Chr(13)+Chr(10)。
  if Major < 10 then
  begin
    RegQueryStringValue(HKLM, 'SOFTWARE\Microsoft\Windows NT\CurrentVersion', 'ProductName', VS);
    Msg := '{#ATTIC_NAME} requires Windows 10 or later (WebView2 110+). Current system: ' + VS + '. ' +
           'Windows 7/8/8.1 users please install the Electron-compatible build from:' +
           Chr(13) + Chr(10) + LegacyDownloadUrl + Chr(13) + Chr(13) + Chr(10) +
           '安装已中止：本程序需要 Windows 10 或更新系统。';
    MsgBox(Msg, mbCriticalError, MB_OK);
    Result := False;
    Exit;
  end;
  #if NEED64
  // x64 构件装不进 32-bit 主机（安装器本体是 32-bit 可启动，闸门必须自己拦——
  // 等价原 NSIS ${RunningX64}；arm64 Windows 过此项 = x64 仿真可运行）
  if not IsWin64 then
  begin
    Msg := 'This installer carries the 64-bit build. 本机是 32-bit Windows，' +
           '请改用 Electron 兼容构件（ia32）：' + Chr(13) + Chr(10) + LegacyDownloadUrl;
    MsgBox(Msg, mbCriticalError, MB_OK);
    Result := False;
    Exit;
  end;
  #endif
#endif
end;
