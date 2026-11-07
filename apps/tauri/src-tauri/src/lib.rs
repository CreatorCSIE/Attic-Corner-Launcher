//! Attic Tauri 壳。
//!
//! 接入模型（docs/contract.md「双壳接入模型」）：
//!   渲染层 --invoke--> Rust 命令 --(sidecar 通道)--> stdio NDJSON RPC --> Node sidecar(@attic/runtime)
//!                                                    --(宿主通道)--> Rust 直处理（窗控/对话框/外链/openPath）
//! 事件：sidecar 推送帧 {event,payload} --> Rust `app.emit` 原名转发 --> 渲染 `listen`。
//! IpcResult 封装在本壳完成（sidecar 的 {result|error} 是线协议形状，不是契约形状）。

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command as StdCommand, Stdio};
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::{DialogExt, FilePath};
use tauri_plugin_opener::OpenerExt;
use tokio::sync::oneshot;

/// 通道镜像（值域源头 = packages/core-spec ipc.ts；与 fixture 的等式由 contract_tests 把关）。
pub mod channels {
    pub const ALL_CHANNELS: &[&str] = &[
        "attic:ping",
        "attic:versions:list",
        "attic:versions:json",
        "attic:version:probe-class",
        "attic:launch:dry-run",
        "attic:launch",
        "attic:launch:cancel",
        "attic:kill",
        "attic:status",
        "attic:java:detect",
        "attic:accounts:list",
        "attic:accounts:add",
        "attic:accounts:remove",
        "attic:accounts:rename",
        "attic:accounts:ms:start",
        "attic:accounts:ms:cancel",
        "attic:accounts:ms:refresh",
        "attic:settings:get",
        "attic:settings:set",
        "attic:instances:list",
        "attic:instances:save",
        "attic:instances:delete",
        "attic:instances:rename",
        "attic:instances:open-dir",
        "attic:instances:set-version",
        "attic:instances:set-addons",
        "attic:window:control",
        "attic:window:console",
        "attic:game:backlog",
        "attic:custom:list",
        "attic:custom:info",
        "attic:custom:info:save",
        "attic:custom:import-jar",
        "attic:custom:remove",
        "attic:mods:list",
        "attic:mods:install",
        "attic:servers:list",
        "attic:sys:info",
        "attic:update:check",
        "attic:update:apply",
        "attic:shell:open-dir",
        "attic:logs:clear",
        "attic:dialog:pick",
        "attic:image:data-url",
        "attic:shell:open-url",
        "attic:crash:report",
        "attic:crash:bundle",
    ];
    /// 宿主面（Rust 直处理，sidecar 拒收）：镜像 sidecar HOST_ONLY_CHANNELS。
    pub const HOST_CHANNELS: &[&str] = &[
        "attic:window:control",
        "attic:window:console",
        "attic:instances:open-dir",
        "attic:shell:open-dir",
        "attic:shell:open-url",
        "attic:dialog:pick",
        "attic:custom:import-jar",
    ];
    /// sidecar 承接面 = ALL - HOST（ipc_forward 白名单）。
    pub const SIDECAR_CHANNELS: &[&str] = &[
        "attic:ping",
        "attic:versions:list",
        "attic:versions:json",
        "attic:version:probe-class",
        "attic:launch:dry-run",
        "attic:launch",
        "attic:launch:cancel",
        "attic:kill",
        "attic:status",
        "attic:java:detect",
        "attic:accounts:list",
        "attic:accounts:add",
        "attic:accounts:remove",
        "attic:accounts:rename",
        "attic:accounts:ms:start",
        "attic:accounts:ms:cancel",
        "attic:accounts:ms:refresh",
        "attic:settings:get",
        "attic:settings:set",
        "attic:instances:list",
        "attic:instances:save",
        "attic:instances:delete",
        "attic:instances:rename",
        "attic:instances:set-version",
        "attic:instances:set-addons",
        "attic:game:backlog",
        "attic:custom:list",
        "attic:custom:info",
        "attic:custom:info:save",
        "attic:custom:remove",
        "attic:mods:list",
        "attic:mods:install",
        "attic:servers:list",
        "attic:sys:info",
        "attic:update:check",
        "attic:update:apply",
        "attic:logs:clear",
        "attic:image:data-url",
        "attic:crash:report",
        "attic:crash:bundle",
    ];
    /// Rust↔sidecar 私有延伸方法（非契约通道）。
    pub const INTERNAL_METHODS: &[&str] = &[
        "attic:internal:instance-game-dir",
        "attic:internal:special-dir",
        "attic:internal:import-jar",
        "attic:internal:shutdown",
    ];
    /// 推送事件（sidecar 帧 → app.emit 原名）。
    pub const EVENT_CHANNELS: &[&str] = &[
        "attic:game:output",
        "attic:game:exit",
        "attic:download:progress",
        "attic:custom:info-changed",
        "attic:account:ms:login",
    ];

    pub const LAUNCH: &str = "attic:launch";
    pub const STATUS: &str = "attic:status";
    pub const SETTINGS_GET: &str = "attic:settings:get";
    pub const INTERNAL_INSTANCE_GAME_DIR: &str = "attic:internal:instance-game-dir";
    pub const INTERNAL_SPECIAL_DIR: &str = "attic:internal:special-dir";
    pub const INTERNAL_IMPORT_JAR: &str = "attic:internal:import-jar";
    pub const INTERNAL_SHUTDOWN: &str = "attic:internal:shutdown";
}

fn ok_json(value: Value) -> Value {
    json!({ "ok": true, "value": value })
}
fn err_json(error: impl Into<String>) -> Value {
    json!({ "ok": false, "error": error.into() })
}

// ————————————————————————— sidecar 进程与 RPC —————————————————————————

struct Sidecar {
    stdin: Mutex<ChildStdin>,
    child: Mutex<Child>,
    next_id: AtomicU64,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>,
}

/// 解析 sidecar 启动命令：env 覆盖（开发/调试逃生舱）→ 安装态（资源目录 server.cjs + 随行 node）→ 开发态回退。
/// TODO(发布 SOP)：CI 产物里在 exe 同目录放置便携 node.exe（bundle 面「sidecar 运行时打包」条目）。
fn resolve_sidecar_launch(app: &AppHandle) -> Result<(PathBuf, PathBuf), String> {
    let node = std::env::var_os("ATTIC_SIDECAR_NODE")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            let exe_dir = std::env::current_exe()
                .ok()
                .and_then(|p| p.parent().map(|d| d.to_path_buf()))
                .unwrap_or_default();
            let companion = exe_dir.join("node.exe");
            if companion.exists() {
                companion
            } else {
                PathBuf::from("node") // PATH 兜底（开发机常态）
            }
        });
    // 候选：开发态优先仓内 dist（`sidecar build` 新鲜产物），安装态优先资源目录。
    // 关键：Tauri 的 resolve 返回 `\\?\` 扩展长度前缀，node 模块解析器不认（误当盘符相对 `E:` → EISDIR），须剥除。
    let entry = std::env::var_os("ATTIC_SIDECAR_ENTRY")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../sidecar/dist/server.cjs");
            let resource = app
                .path()
                .resolve("sidecar/server.cjs", tauri::path::BaseDirectory::Resource)
                .ok()
                .map(strip_verbatim);
            let ordered: Vec<PathBuf> = if cfg!(debug_assertions) {
                [Some(dev.clone()), resource].into_iter().flatten().collect()
            } else {
                [resource, Some(dev.clone())].into_iter().flatten().collect()
            };
            ordered.into_iter().find(|p| p.is_file()).unwrap_or(dev)
        });
    let entry = strip_verbatim(entry);
    if !entry.is_file() {
        return Err(format!("sidecar entry not a file: {}", entry.display()));
    }
    Ok((node, entry))
}

/// Releases 页（temp 守卫指路位；与 UI 关于页 REPO_URL 同源）。
const RELEASES_URL: &str = "https://github.com/CreatorCSIE/Attic-Corner-Launcher/releases";

/// portable 双指纹（判定单点在 runtime，本函数只负责宿主显式传参）：
/// 程序目录 marker（`sidecar/portable.ini`）在场 ∨（exe 旁 `.attic` ∧ 其内 `launcher/portable.anchor`）
/// → 注入 ATTIC_EXE_DIR（程序目录）；marker 在场再加注 ATTIC_PORTABLE_INI（ini 绝对路径）。
/// 硬纪律：sidecar 的 process.execPath = node.exe 不可信，exeDir 判定面必须由壳显式传。
/// 返回 None = 非便携（安装版/开发态天然不命中）。
fn portable_launch_env() -> Option<(PathBuf, Option<PathBuf>)> {
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| strip_verbatim(d.to_path_buf())))?;
    let marker = exe_dir.join("sidecar").join("portable.ini");
    let anchor = exe_dir.join(".attic").join("launcher").join("portable.anchor");
    let marker_hit = marker.is_file();
    if !marker_hit && !anchor.is_file() {
        return None;
    }
    Some((exe_dir, if marker_hit { Some(marker) } else { None }))
}

/// temp 守卫特征判定（runtime looksLikeTempExtraction 同款口径）：
/// exeDir 命中 temp 目录前缀或 `Rar$`/`7z$`/`WinRar$` 特征段 ∧ exe 旁无既有 `.attic` → true。
/// 防压缩包内直接双击：只抽 exe → marker 没跟出来判成安装态写 %APPDATA%；
/// 整目录抽到 temp → 数据随 temp 蒸发——两坑同由本守卫在 boot 拒服务。
fn temp_trap_hit() -> bool {
    let Some(exe_dir) = std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.to_path_buf())) else {
        return false;
    };
    if exe_dir.join(".attic").exists() {
        return false;
    }
    let lowered = strip_verbatim(exe_dir).to_string_lossy().to_lowercase();
    let temp = strip_verbatim(std::env::temp_dir())
        .to_string_lossy()
        .to_lowercase()
        .trim_end_matches(['\\', '/'])
        .to_string();
    if lowered == temp || lowered.starts_with(&format!("{temp}{}", std::path::MAIN_SEPARATOR)) {
        return true;
    }
    lowered
        .split(['\\', '/'])
        .any(|seg| seg.starts_with("rar$") || seg.starts_with("7z$") || seg.starts_with("winrar$"))
}

/// 剥除 Windows 扩展长度路径前缀 `\\?\`（Tauri resolve 产物）。
/// node 的模块解析器不识别该前缀，会把 `\\?\E:\...` 退化成盘符相对 `E:` 再 lstat → EISDIR。
fn strip_verbatim(p: PathBuf) -> PathBuf {
    let s = p.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{rest}"))
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        PathBuf::from(rest)
    } else {
        p
    }
}

/// Windows：控制台子系统子进程（node.exe / taskkill.exe）由 GUI 壳裸 spawn 会闪黑窗
/// （sidecar 弹 node 控制台）。CREATE_NO_WINDOW 抑制；POSIX 下为空操作。
#[cfg(windows)]
fn hide_console(cmd: &mut StdCommand) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn hide_console(_cmd: &mut StdCommand) {}

impl Sidecar {
    fn spawn(app: &AppHandle) -> Result<Self, String> {
        let (node, entry) = resolve_sidecar_launch(app)?;
        let version = app.package_info().version.to_string();
        let mut cmd = StdCommand::new(&node);
        cmd.arg(&entry)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .env("ATTIC_LAUNCHER_VERSION", &version);
        // portable：双指纹命中才注入（缺席 = sidecar 走安装/开发形态，判定复核在 runtime）
        if let Some((exe_dir, marker)) = portable_launch_env() {
            cmd.env("ATTIC_EXE_DIR", &exe_dir);
            if let Some(ini) = marker {
                cmd.env("ATTIC_PORTABLE_INI", &ini);
            }
        }
        hide_console(&mut cmd);
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("spawn {} {}: {e}", node.display(), entry.display()))?;
        let stdin = child.stdin.take().ok_or("no stdin")?;
        let stdout = child.stdout.take().ok_or("no stdout")?;
        let pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        Self::spawn_reader(app.clone(), stdout, pending.clone());
        Ok(Self {
            stdin: Mutex::new(stdin),
            child: Mutex::new(child),
            next_id: AtomicU64::new(1),
            pending,
        })
    }

    /// stdout 读线程：响应帧按 id 投递 oneshot；事件帧原名 emit；EOF 时唤醒全部在途请求。
    fn spawn_reader(
        app: AppHandle,
        stdout: std::process::ChildStdout,
        pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>,
    ) {
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                let Ok(line) = line else { break };
                if line.trim().is_empty() {
                    continue;
                }
                let Ok(frame) = serde_json::from_str::<Value>(&line) else {
                    eprintln!("[sidecar-stdout] bad frame: {line}");
                    continue;
                };
                if let Some(name) = frame.get("event").and_then(Value::as_str) {
                    let payload = frame.get("payload").cloned().unwrap_or(Value::Null);
                    let _ = app.emit(name, payload);
                    continue;
                }
                if let Some(id) = frame.get("id").and_then(Value::as_u64) {
                    let result = match frame.get("error") {
                        Some(e) => Err(e.as_str().unwrap_or("unknown-sidecar-error").to_string()),
                        None => Ok(frame.get("result").cloned().unwrap_or(Value::Null)),
                    };
                    if let Some(tx) = pending.lock().unwrap().remove(&id) {
                        let _ = tx.send(result);
                    }
                }
            }
            let mut map = pending.lock().unwrap();
            for (_, tx) in map.drain() {
                let _ = tx.send(Err("sidecar-exited".into()));
            }
        });
    }

    /// 请求-响应往返（线协议：{id,method,params} → {id,result|error}）。
    async fn rpc(&self, method: &str, params: Vec<Value>) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);
        let line = serde_json::to_string(&json!({ "id": id, "method": method, "params": params }))
            .map_err(|e| e.to_string())?;
        {
            let mut stdin = self.stdin.lock().map_err(|e| e.to_string())?;
            writeln!(stdin, "{line}").map_err(|e| format!("sidecar-stdin: {e}"))?;
            stdin.flush().map_err(|e| format!("sidecar-stdin: {e}"))?;
        }
        match tokio::time::timeout(Duration::from_secs(120), rx).await {
            Ok(Ok(res)) => res,
            Ok(Err(_)) => Err("sidecar-response-dropped".into()),
            Err(_) => {
                self.pending.lock().unwrap().remove(&id);
                Err(format!("sidecar-timeout: {method}"))
            }
        }
    }

    /// 退出收敛：shutdown 帧（sidecar 侧先 kill 游戏进程）→ 宽限 → 强杀兜底。
    async fn shutdown(&self) {
        let _ = tokio::time::timeout(Duration::from_secs(2), self.rpc(channels::INTERNAL_SHUTDOWN, vec![])).await;
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

// ————————————————————————— Tauri 命令（渲染 invoke 面） —————————————————————————

/// async 命令的借用规避范式：不拿 `State<'_>`（引用入参会把 message 生命周期拽进 await），
/// 从 AppHandle 取 inner Arc 的所有权拷贝。
fn sidecar_of(app: &AppHandle) -> Arc<Sidecar> {
    app.state::<Arc<Sidecar>>().inner().clone()
}

/// sidecar 通道转发（白名单制；LAUNCH 成功后消费「启动后最小化」窗行为）。
#[tauri::command]
async fn ipc_forward(app: AppHandle, channel: String, args: Vec<Value>) -> Value {
    if !channels::SIDECAR_CHANNELS.contains(&channel.as_str()) {
        return err_json(format!("host-or-unknown-channel: {channel}"));
    }
    let sidecar = sidecar_of(&app);
    match sidecar.rpc(&channel, args).await {
        Ok(value) => {
            if channel == channels::LAUNCH {
                minimize_if_enabled(&app, &sidecar).await;
            }
            ok_json(value)
        }
        Err(error) => err_json(error),
    }
}

/// 「启动后最小化启动器」：开关数据在 runtime，窗动作在壳层（Electron 壳同款分工）。
async fn minimize_if_enabled(app: &AppHandle, sidecar: &Arc<Sidecar>) {
    if let Ok(settings) = sidecar.rpc(channels::SETTINGS_GET, vec![]).await {
        if settings.get("minimizeOnLaunch").and_then(Value::as_bool) == Some(true) {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.minimize();
            }
        }
    }
}

fn tauri_result_json(result: Result<(), tauri::Error>) -> Value {
    match result {
        Ok(()) => ok_json(Value::Null),
        Err(e) => err_json(e.to_string()),
    }
}

#[tauri::command]
fn window_control(window: tauri::Window, action: String) -> Value {
    match action.as_str() {
        "minimize" => tauri_result_json(window.minimize()),
        "close" => tauri_result_json(window.close()),
        "toggle-maximize" => tauri_result_json(match window.is_maximized() {
            Ok(true) => window.unmaximize(),
            _ => window.maximize(),
        }),
        other => err_json(format!("bad-window-action: {other}")),
    }
}

static CONSOLE_SEQ: AtomicU32 = AtomicU32::new(0);

/// 独立控制台窗（每次新建、不复用；pid 取当前会话，秒退场景由 ?window=console 无 pid + backlog 兜）。
#[tauri::command]
async fn open_console(app: AppHandle) -> Value {
    let sidecar = sidecar_of(&app);
    let pid = sidecar
        .rpc(channels::STATUS, vec![])
        .await
        .ok()
        .and_then(|v| v.pointer("/session/pid").and_then(Value::as_u64));
    let label = format!("console-{}", CONSOLE_SEQ.fetch_add(1, Ordering::Relaxed));
    let (url, title) = match pid {
        Some(p) => (format!("index.html?window=console&pid={p}"), format!("Attic Console — pid {p}")),
        None => (
            "index.html?window=console".to_string(),
            "Attic Corner Launcher — Console".to_string(),
        ),
    };
    // .icon() 返回 Result（解码失败可拒），and_then 串进 build()
    match WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(url.into()))
        .title(&title)
        .inner_size(860.0, 600.0)
        .min_inner_size(520.0, 360.0)
        .decorations(false)
        .icon(app_icon())
        .and_then(WebviewWindowBuilder::build)
    {
        Ok(_) => ok_json(Value::Null),
        Err(e) => err_json(e.to_string()),
    }
}

fn file_path_to_string(fp: FilePath) -> String {
    match fp {
        FilePath::Path(p) => p.to_string_lossy().into_owned(),
        other => format!("{other:?}"),
    }
}

/// 原生对话框选择（kind = PickTarget；取消 = ok(null)，与 Electron 壳同语义）。
#[tauri::command]
async fn pick_path(app: AppHandle, kind: String) -> Value {
    let blocking = tauri::async_runtime::spawn_blocking(move || {
        let picker = app.dialog().file();
        if kind == "java-executable" {
            picker
                .set_title("选择 Java 可执行文件")
                .add_filter("java 可执行文件", &["exe"])
                .blocking_pick_file()
        } else if kind == "image-file" {
            picker
                .set_title("选择背景图片")
                .add_filter("图片", &["png", "jpg", "jpeg", "webp", "gif", "bmp"])
                .blocking_pick_file()
        } else {
            picker.set_title("选择文件夹").blocking_pick_folder()
        }
    })
    .await;
    match blocking {
        Ok(Some(fp)) => ok_json(json!(file_path_to_string(fp))),
        Ok(None) => ok_json(Value::Null),
        Err(e) => err_json(e.to_string()),
    }
}

fn open_dir_json(app: &AppHandle, dir: &str) -> Value {
    let _ = std::fs::create_dir_all(dir); // 首启未落盘场景不失败（Electron 壳同款）
    match app.opener().open_path(dir, None::<&str>) {
        Ok(()) => ok_json(Value::Null),
        Err(e) => err_json(e.to_string()),
    }
}

/// 打开特殊目录（路径解析在 sidecar runtime 根，动作在壳层）。
#[tauri::command]
async fn open_special_dir(app: AppHandle, target: String) -> Value {
    let sidecar = sidecar_of(&app);
    match sidecar.rpc(channels::INTERNAL_SPECIAL_DIR, vec![json!(target)]).await {
        Ok(v) => match v.as_str() {
            Some(dir) => open_dir_json(&app, dir),
            None => err_json("special-dir-not-string"),
        },
        Err(e) => err_json(e),
    }
}

#[tauri::command]
async fn open_instance_dir(app: AppHandle, name: String) -> Value {
    let sidecar = sidecar_of(&app);
    match sidecar.rpc(channels::INTERNAL_INSTANCE_GAME_DIR, vec![json!(name)]).await {
        Ok(v) => match v.as_str() {
            Some(dir) => open_dir_json(&app, dir),
            None => err_json("game-dir-not-string"),
        },
        Err(e) => err_json(e),
    }
}

/// 外链出门：协议白名单 http/https（渲染侧无 shell，唯一出门口收紧校验）。
#[tauri::command]
fn open_external_url(app: AppHandle, url: String) -> Value {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return err_json(format!("仅允许 http/https 协议：{url}"));
    }
    match app.opener().open_url(&url, None::<&str>) {
        Ok(()) => ok_json(Value::Null),
        Err(e) => err_json(e.to_string()),
    }
}

/// 导入自定义版本 jar：Rust 弹框取路径 → sidecar runtime.importCustomJar（取消 = ok(null)）。
#[tauri::command]
async fn import_custom_jar(app: AppHandle) -> Value {
    let sidecar = sidecar_of(&app);
    let blocking = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title("导入自定义版本 jar")
            .add_filter("Minecraft jar", &["jar", "zip"])
            .blocking_pick_file()
    })
    .await;
    let file = match blocking {
        Ok(Some(fp)) => file_path_to_string(fp),
        Ok(None) => return ok_json(Value::Null),
        Err(e) => return err_json(e.to_string()),
    };
    match sidecar.rpc(channels::INTERNAL_IMPORT_JAR, vec![json!(file)]).await {
        Ok(v) => ok_json(v),
        Err(e) => err_json(e),
    }
}

// ————————————————————————— 装配 —————————————————————————

/// 应用窗口图标（任务栏/标题栏）：显式注入，不依赖 tauri 2.12 运行时读 exe
/// APP_ICON@32512 的新约定——dev 场景该链任一环失配即回退 Windows 缺省图标，
/// 显式 set_icon 幂等且 dev/release 行为一致。需 Cargo.toml `image-png` feature。
/// 注：`include_image!` 路径基准 = CARGO_MANIFEST_DIR（非源文件目录），非 `include_bytes!` 语义。
fn app_icon() -> tauri::image::Image<'static> {
    tauri::include_image!("icons/32x32.png")
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            // temp 守卫：conf 建窗先于 setup，命中即藏窗 + 原生对话框讲清
            // 「实际动作 + 出路」+ 指路 Releases，再退出；sidecar 不 spawn（不产生便携态副作用）。
            if temp_trap_hit() {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.hide();
                }
                let handle = app.handle().clone();
                let open_releases = handle
                    .dialog()
                    .message(
                        "请先解压整个文件夹，勿在压缩包里直接运行。\n\n\
                         检测到启动器正从临时目录运行——游戏数据会随临时目录清理而丢失。\
                         请把 zip 里的整个文件夹解压到固定位置（如 D:\\Attic）后再双击启动。",
                    )
                    .title("Attic Launcher")
                    .buttons(tauri_plugin_dialog::MessageDialogButtons::OkCancelCustom(
                        "打开 Releases 页".to_string(),
                        "退出".to_string(),
                    ))
                    .blocking_show();
                if open_releases {
                    let _ = handle.opener().open_url(RELEASES_URL, None::<&str>);
                }
                handle.exit(0);
                return Ok(());
            }
            let handle = app.handle().clone();
            let sidecar = Sidecar::spawn(&handle).map_err(|e| e)?;
            app.manage(Arc::new(sidecar));
            // 防白底：原生窗缺省底色为白，WebView2 首帧前会闪出。conf 已钉深色
            // 底（#14120f，应用默认主题 = tokens.css 深色 --surface-1）；系统为
            // 浅色主题时（渲染侧 system 模式经 matchMedia 解析为 light）在首帧
            // 前改钉浅色底 #f2ede3，两种主题启动都不闪白。
            if let Some(win) = app.get_webview_window("main") {
                // 主窗任务栏图标显式注入（conf 窗口创建先于 setup，此处窗口已存在）
                let _ = win.set_icon(app_icon());
                if matches!(win.theme(), Ok(tauri::Theme::Light)) {
                    let _ = win.set_background_color(Some(tauri::window::Color(242, 237, 227, 255)));
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ipc_forward,
            window_control,
            open_console,
            pick_path,
            open_special_dir,
            open_instance_dir,
            open_external_url,
            import_custom_jar
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            match event {
                tauri::RunEvent::Exit { .. } => {
                    // temp 守卫路径 sidecar 未 manage：try_state 缺席即跳过（state! 会 panic）
                    if let Some(state) = app_handle.try_state::<Arc<Sidecar>>() {
                        tauri::async_runtime::block_on(state.shutdown());
                    }
                }
                // 主窗销毁 = 应用本体退出：控制台窗（console-* 前缀）是附属会话窗，
                // 连带全关——否则控制台独活撑住「全窗关闭即退」判定，进程滞留无 UI
                // （与 Electron 壳 closed 钩子同语义，Electron 面主窗销毁还会 kill 在跑的
                // 游戏走 before-quit；sidecar 数据面常驻无害，Exit 钩子兜 shutdown）。
                tauri::RunEvent::WindowEvent {
                    label,
                    event: tauri::WindowEvent::Destroyed,
                    ..
                } => {
                    if label == "main" {
                        for (name, w) in app_handle.webview_windows() {
                            if name.starts_with("console-") {
                                let _ = w.close();
                            }
                        }
                    }
                }
                _ => {}
            }
        });
}

// ————————————————————————— 契约镜像闸门（跨语言半边） —————————————————————————

#[cfg(test)]
mod contract_tests {
    use super::channels::*;
    use serde_json::Value;
    use std::path::PathBuf;

    fn fixture() -> Value {
        let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../packages/core-spec/tests/fixtures/ipc-channels.json");
        let raw = std::fs::read_to_string(&p)
            .expect("fixture 缺失：先跑 `node scripts/emit-contract-fixtures.mjs`");
        serde_json::from_str(&raw).expect("fixture 非法 JSON")
    }

    fn sorted(list: &[&str]) -> Vec<String> {
        let mut v: Vec<String> = list.iter().map(|s| s.to_string()).collect();
        v.sort();
        v
    }

    fn fixture_list(f: &Value, key: &str) -> Vec<String> {
        f[key]
            .as_array()
            .expect("fixture 键缺数组")
            .iter()
            .map(|x| x.as_str().expect("fixture 项非字符串").to_string())
            .collect()
    }

    #[test]
    fn rust_mirror_equals_ts_fixture() {
        let f = fixture();
        assert_eq!(sorted(ALL_CHANNELS), fixture_list(&f, "allChannels"), "allChannels");
        assert_eq!(sorted(HOST_CHANNELS), fixture_list(&f, "hostOnlyChannels"), "hostOnlyChannels");
        assert_eq!(sorted(SIDECAR_CHANNELS), fixture_list(&f, "sidecarChannels"), "sidecarChannels");
        assert_eq!(sorted(INTERNAL_METHODS), fixture_list(&f, "internalMethods"), "internalMethods");
        assert_eq!(sorted(EVENT_CHANNELS), fixture_list(&f, "eventChannels"), "eventChannels");
    }

    #[test]
    fn host_and_sidecar_partition_all() {
        for ch in SIDECAR_CHANNELS.iter().chain(HOST_CHANNELS.iter()) {
            assert!(ALL_CHANNELS.contains(ch), "非契约通道混入: {ch}");
        }
        assert_eq!(
            SIDECAR_CHANNELS.len() + HOST_CHANNELS.len(),
            ALL_CHANNELS.len(),
            "划分不是不交并集"
        );
    }
}
