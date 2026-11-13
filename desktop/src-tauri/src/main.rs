#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    fs,
    io::Write,
    net::{SocketAddr, TcpStream},
    path::PathBuf,
    process::{Child, Command},
    sync::{atomic::{AtomicBool, AtomicUsize, Ordering}, Mutex},
    thread,
    time::{Duration, Instant},
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};

fn show_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        fix_size(&window);
        let _ = window.set_focus();
    }
}

// A window that ended up smaller than its minimum (Windows restored it to a title bar while the server restarted) is
// maximized again, so Rex Desk never comes back as a 159x38 strip.
fn fix_size(window: &tauri::WebviewWindow) {
    if window.is_minimized().unwrap_or(false) {
        return;
    }
    let scale = window.scale_factor().unwrap_or(1.0);
    if let Ok(size) = window.inner_size() {
        let (width, height) = (size.width as f64 / scale, size.height as f64 / scale);
        if width < 900.0 || height < 600.0 {
            let _ = window.maximize();
        }
    }
}

const ADDRESS: &str = "127.0.0.1:4317";
static OPENED: AtomicUsize = AtomicUsize::new(0);
static RESTARTING: AtomicBool = AtomicBool::new(false);
// Why the server could not start, for the start page to show. The page asks for it (startup_error) instead of being told,
// because a server that fails fast can fail before the page has loaded its script.
static LAST_ERROR: Mutex<String> = Mutex::new(String::new());

fn set_error(message: &str) {
    if let Ok(mut last) = LAST_ERROR.lock() {
        *last = message.to_string();
    }
}

#[tauri::command]
fn startup_error() -> String {
    LAST_ERROR.lock().map(|last| last.clone()).unwrap_or_default()
}

// A link Rex Desk opens in a new window: its own pages open in a child window of the app (same sign-in);
// anything else opens in the person's browser.
fn open_link(app: &tauri::AppHandle, url: tauri::Url, features: tauri::webview::NewWindowFeatures) -> tauri::webview::NewWindowResponse<tauri::Wry> {
    let own = url.host_str() == Some("127.0.0.1") && url.port() == Some(4317);
    if !own {
        if matches!(url.scheme(), "http" | "https" | "mailto") {
            #[cfg(windows)]
            let mut command = { let mut command = Command::new("cmd"); command.args(["/c", "start", "", url.as_str()]); command };
            #[cfg(not(windows))]
            let mut command = { let mut command = Command::new("open"); command.arg(url.as_str()); command };
            let _ = hidden(&mut command).spawn();
        }
        return tauri::webview::NewWindowResponse::Deny;
    }
    let label = format!("page-{}", OPENED.fetch_add(1, Ordering::Relaxed));
    let built = WebviewWindowBuilder::new(app, label, WebviewUrl::External("about:blank".parse().unwrap()))
        .window_features(features)
        .title("Rex Desk")
        .inner_size(1200.0, 820.0)
        .on_document_title_changed(|window, title| { let _ = window.set_title(&title); })
        .build();
    match built {
        Ok(window) => tauri::webview::NewWindowResponse::Create { window },
        Err(_) => tauri::webview::NewWindowResponse::Deny,
    }
}
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

// Whether the server answers: a real request to /api/boot (cheap, and answered even while Rex Desk opens), not only a
// connection, because Windows accepts connections for a server that is frozen, which left the window black. Any HTTP
// answer counts (an older server says "not found"). On a busy computer an answer may take a few seconds.
fn server_running() -> bool {
    use std::io::Read;
    let address: SocketAddr = ADDRESS.parse().expect("valid address");
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(2000)) else { return false };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
    if stream.write_all(b"GET /api/boot HTTP/1.0\r\nHost: 127.0.0.1:4317\r\nConnection: close\r\n\r\n").is_err() {
        return false;
    }
    let mut head = [0u8; 5];
    stream.read_exact(&mut head).is_ok() && &head == b"HTTP/"
}

// Whether the server process named in runtime.lock is still alive. A living server that is slow to answer (busy, or still
// opening) is waited for, never killed: killing it also ended the agents it was running.
fn server_process_alive(runtime: &Runtime) -> bool {
    let Ok(text) = fs::read_to_string(runtime.data.join("runtime.lock")) else { return false };
    let Ok(pid) = text.trim().parse::<u32>() else { return false };
    #[cfg(windows)]
    {
        let mut command = Command::new("tasklist");
        command.args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"]);
        hidden(&mut command).output().map(|out| String::from_utf8_lossy(&out.stdout).contains(&format!("\"{pid}\""))).unwrap_or(false)
    }
    #[cfg(not(windows))]
    {
        Command::new("kill").args(["-0", &pid.to_string()]).status().map(|status| status.success()).unwrap_or(false)
    }
}

#[cfg(windows)]
const NODE: &str = "node.exe";
#[cfg(not(windows))]
const NODE: &str = "node";

fn data_home(fallback: &PathBuf) -> PathBuf {
    #[cfg(windows)]
    let base = std::env::var_os("APPDATA").map(PathBuf::from);
    #[cfg(not(windows))]
    let base = std::env::var_os("HOME").map(|home| PathBuf::from(home).join("Library").join("Application Support"));
    base.unwrap_or_else(|| fallback.clone()).join("Rex Desk")
}

struct Runtime {
    node: PathBuf,
    app: PathBuf,
    data: PathBuf,
    bundled: bool,
}

// REX_DESK_HOME wins; otherwise the checkout this window was built from.
fn checkout() -> Option<PathBuf> {
    let built = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("..");
    std::env::var_os("REX_DESK_HOME")
        .map(PathBuf::from)
        .into_iter()
        .chain([built])
        .find(|root| root.join("src").join("server.js").is_file())
}

// Where the person's workspace lives is remembered in one small file outside the app, so a reinstall (or a new build that
// would look in another folder) opens the same workspace instead of an empty one.
fn pointer_file() -> Option<PathBuf> {
    #[cfg(windows)]
    let home = std::env::var_os("USERPROFILE");
    #[cfg(not(windows))]
    let home = std::env::var_os("HOME");
    home.map(|home| PathBuf::from(home).join(".rexdesk").join("data-folder.txt"))
}

fn saved_folder() -> Option<PathBuf> {
    let text = fs::read_to_string(pointer_file()?).ok()?;
    let line = text.lines().next()?.trim().trim_start_matches('\u{feff}');
    if line.is_empty() { None } else { Some(PathBuf::from(line)) }
}

fn remember_folder(folder: &PathBuf) {
    if let Some(file) = pointer_file() {
        if let Some(parent) = file.parent() { let _ = fs::create_dir_all(parent); }
        let _ = fs::write(file, folder.to_string_lossy().as_bytes());
    }
}

fn holds_workspace(folder: &PathBuf) -> bool {
    folder.join("accounts.json").is_file() || folder.join("desk.sqlite").is_file()
}

// Turns the folder the person picked into the folder that holds the data. People pick the folder they think of (a drive,
// their projects folder, a Rex Desk checkout), not the data folder itself, so look one level down for a workspace:
// <picked>/.local, <picked>/Rex Desk, or the same inside each folder in it (a drive finds <drive>/rex-desk/.local). When
// none is found, a new workspace goes into a "Rex Desk" folder inside a drive root or a folder that already holds other
// things, so its files never spread over them.
fn workspace_in(picked: &PathBuf) -> PathBuf {
    let inside = |folder: &PathBuf| -> Option<PathBuf> {
        [folder.clone(), folder.join(".local"), folder.join("Rex Desk")].into_iter().find(|candidate| holds_workspace(candidate))
    };
    if let Some(found) = inside(picked) { return found; }
    if let Ok(entries) = fs::read_dir(picked) {
        let mut folders: Vec<PathBuf> = entries.flatten().map(|entry| entry.path()).filter(|path| path.is_dir()).collect();
        folders.sort();
        if let Some(found) = folders.iter().find_map(|folder| inside(folder)) { return found; }
    }
    let empty = fs::read_dir(picked).map(|mut entries| entries.next().is_none()).unwrap_or(true);
    if picked.parent().is_none() || !empty { picked.join("Rex Desk") } else { picked.clone() }
}

// A folder picker, shown once before anything opens. None when the person cancels.
fn pick_folder(message: &str) -> Option<PathBuf> {
    #[cfg(windows)]
    let mut command = {
        let script = "Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = $env:REX_PICK; $d.ShowNewFolderButton = $true; $f = New-Object System.Windows.Forms.Form; $f.TopMost = $true; if ($d.ShowDialog($f) -eq 'OK') { [Console]::Out.Write($d.SelectedPath) }";
        let mut command = Command::new("powershell.exe");
        command.args(["-NoProfile", "-STA", "-Command", script]);
        command
    };
    #[cfg(not(windows))]
    let mut command = {
        let mut command = Command::new("osascript");
        command.args(["-e", "POSIX path of (choose folder with prompt (system attribute \"REX_PICK\"))"]);
        command
    };
    let output = hidden(command.env("REX_PICK", message)).output().ok()?;
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if text.is_empty() { None } else { Some(PathBuf::from(text)) }
}

// Which folder holds the data: the remembered one; else the app's default folder when it already holds a workspace
// (an upgrade); else, when `ask` is set, the person picks one (cancel keeps the default and starts a new workspace).
fn choose_data(default: PathBuf, ask: bool) -> PathBuf {
    let saved = saved_folder();
    if let Some(saved) = &saved {
        if saved.is_dir() || !ask {
            // An older pick may name a drive or a parent folder; settle it on the real data folder once.
            let found = if saved.is_dir() { workspace_in(saved) } else { saved.clone() };
            if &found != saved { remember_folder(&found); }
            return found;
        }
    }
    if saved.is_none() && holds_workspace(&default) {
        remember_folder(&default);
        return default;
    }
    if !ask { return default; }
    let chosen = pick_folder("Where is your Rex Desk workspace? Pick the folder that holds it (or the folder above it), or any folder to start fresh. Cancel uses the default folder.").map(|picked| workspace_in(&picked)).unwrap_or(default);
    remember_folder(&chosen);
    chosen
}

// The installed app carries its own Node and server next to the executable and keeps data in %APPDATA%\Rex Desk
// unless the person picked another folder. A development build falls back to a checkout and the system Node.
// On a Mac the payload sits in Contents/Resources, and the data in ~/Library/Application Support/Rex Desk.
fn runtime() -> Option<Runtime> {
    runtime_with(false)
}

fn runtime_with(ask: bool) -> Option<Runtime> {
    let exe = std::env::current_exe().ok()?;
    let folder = exe.parent()?;
    for beside in [folder.join("payload"), folder.join("..").join("Resources").join("payload")] {
        let (node, app) = (beside.join("node").join(NODE), beside.join("app"));
        if node.is_file() && app.join("src").join("server.js").is_file() {
            return Some(Runtime { node, app, data: choose_data(data_home(&beside), ask), bundled: true });
        }
    }
    checkout().map(|root| Runtime { node: PathBuf::from("node"), data: root.join(".local"), app: root, bundled: false })
}

fn hidden(command: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

// The server outlives the window so closing it never interrupts running agents.
fn start_server(runtime: &Runtime) -> std::io::Result<Child> {
    fs::create_dir_all(&runtime.data)?;
    let mut command = Command::new(&runtime.node);
    command
        .arg("src/server.js")
        .current_dir(&runtime.app)
        .env("REX_DATA_DIR", &runtime.data)
        // The window talks to 4317. A checkout started by itself is development and would pick 4318.
        .env("PORT", "4317")
        .stdin(std::process::Stdio::null())
        .stdout(log_file(runtime, "server.log")?)
        .stderr(log_file(runtime, "server-error.log")?);
    if runtime.bundled {
        // The server writes server.version itself once it listens, so the file always names the server that answers.
        command.env("REX_DESK_VERSION", env!("CARGO_PKG_VERSION"));
        if let Ok(executable) = std::env::current_exe() {
            command.env("REX_DESK_EXE", executable);
        }
        if let Some(home) = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }) {
            command.env("REX_CLONE_DIR", PathBuf::from(home).join("Rex Desk repositories"));
        }
    }
    // On Windows the server starts outside the window's job (the group Windows ties its child processes to). Started inside
    // it, servers often hung before running any code, which left the window black; started outside, the same server opens in
    // seconds, and it also no longer ends with the window. Where Windows does not allow leaving the job, it starts as before.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
        command.creation_flags(CREATE_NO_WINDOW | CREATE_BREAKAWAY_FROM_JOB);
        if let Ok(child) = command.spawn() {
            return Ok(child);
        }
        command.stdout(log_file(runtime, "server.log")?).stderr(log_file(runtime, "server-error.log")?);
    }
    hidden(&mut command).spawn()
}

const START_MARK: &str = "=== Rex Desk server starting";

// Each start appends to the log after a marker line instead of emptying it, so an earlier crash is still there to read
// and a second start never wipes the log of a server that is running. A log over 5 MB moves to *.old first.
fn log_file(runtime: &Runtime, name: &str) -> std::io::Result<fs::File> {
    let path = runtime.data.join(name);
    if fs::metadata(&path).map(|meta| meta.len() > 5 * 1024 * 1024).unwrap_or(false) {
        let _ = fs::rename(&path, runtime.data.join(format!("{name}.old")));
    }
    let mut file = fs::OpenOptions::new().create(true).append(true).open(&path)?;
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|time| time.as_secs()).unwrap_or(0);
    let _ = writeln!(file, "{START_MARK} (app {}, unix time {stamp}) ===", env!("CARGO_PKG_VERSION"));
    Ok(file)
}

// The last lines this start wrote to server-error.log, which say why a server that just started has stopped.
fn crash_log(runtime: &Runtime) -> String {
    let text = fs::read_to_string(runtime.data.join("server-error.log")).unwrap_or_default();
    text.rsplit_once(START_MARK).map(|(_, last)| last.split_once('\n').map(|(_, rest)| rest).unwrap_or("").to_string()).unwrap_or(text)
}

fn crash_reason(runtime: &Runtime) -> String {
    let text = crash_log(runtime);
    let lines: Vec<&str> = text.lines().map(str::trim).filter(|line| !line.is_empty() && !line.starts_with("at ")).collect();
    let reason = lines[lines.len().saturating_sub(4)..].join("\n");
    if reason.is_empty() { format!("Rex Desk stopped while starting. See {}", runtime.data.join("server-error.log").display()) } else { format!("Rex Desk stopped while starting:\n{reason}") }
}

// Waits until the server answers. A server that stops while starting (a broken file, a missing module) ends the wait
// at once with its error instead of leaving the window waiting minutes for a server that is no longer there.
fn wait_for_start(runtime: &Runtime, child: &mut Child, seconds: u64) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(seconds);
    loop {
        if server_running() {
            return Ok(());
        }
        if let Ok(Some(_)) = child.try_wait() {
            // Another server (started at Windows sign-in, or by a second window) was already starting with this data folder:
            // this one stops at once, and that one answers when it is ready, so keep waiting for it.
            if crash_log(runtime).contains("already running") {
                return if wait_for_server(deadline.saturating_duration_since(Instant::now()).as_secs().max(2)) { Ok(()) } else { Err(crash_reason(runtime)) };
            }
            return if wait_for_server(2) { Ok(()) } else { Err(crash_reason(runtime)) };
        }
        if Instant::now() > deadline {
            return Err(format!("Rex Desk did not start. See {}", runtime.data.join("server-error.log").display()));
        }
        thread::sleep(Duration::from_millis(250));
    }
}

// Ends the running server (its process id is in runtime.lock) so a fresh one can start.
fn stop_server(runtime: &Runtime) {
    let Ok(text) = fs::read_to_string(runtime.data.join("runtime.lock")) else { return };
    let Ok(pid) = text.trim().parse::<u32>() else { return };
    #[cfg(windows)]
    let mut command = { let mut command = Command::new("taskkill"); command.args(["/PID", &pid.to_string(), "/T", "/F"]); command };
    #[cfg(not(windows))]
    let mut command = { let mut command = Command::new("kill"); command.args(["-9", &pid.to_string()]); command };
    let _ = hidden(&mut command).status();
}

// A server left running by an older version (an install over the top keeps it, as it outlives the window) runs the old
// code: the installed app would show the old version and miss every fix. Such a server is replaced by one of this version.
fn server_outdated(runtime: &Runtime) -> bool {
    runtime.bundled && fs::read_to_string(runtime.data.join("server.version")).map(|text| text.trim() != env!("CARGO_PKG_VERSION")).unwrap_or(true)
}

fn wait_for_server(seconds: u64) -> bool {
    let deadline = Instant::now() + Duration::from_secs(seconds);
    while Instant::now() < deadline {
        if server_running() {
            return true;
        }
        thread::sleep(Duration::from_millis(250));
    }
    server_running()
}

// Stops the server if it still answers, starts a new one and waits until it is up. Used by the Restart button, the tray and the watchdog.
fn restart(runtime: &Runtime) -> Result<(), String> {
    if RESTARTING.swap(true, Ordering::SeqCst) {
        return Err("Rex Desk is already restarting.".into());
    }
    let result = (|| {
        stop_server(runtime);
        let deadline = Instant::now() + Duration::from_secs(5);
        while server_running() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(200));
        }
        let mut child = start_server(runtime).map_err(|error| format!("Could not start Rex Desk: {error}"))?;
        wait_for_start(runtime, &mut child, 360)
    })();
    RESTARTING.store(false, Ordering::SeqCst);
    set_error(result.as_ref().err().map(String::as_str).unwrap_or(""));
    result
}

#[tauri::command]
async fn restart_server() -> Result<(), String> {
    let runtime = runtime().ok_or("Rex Desk files are missing. Reinstall Rex Desk.")?;
    tauri::async_runtime::spawn_blocking(move || restart(&runtime)).await.map_err(|error| error.to_string())?
}

// Recorded checks need Playwright's Chromium; the installer cannot carry it, so it downloads once in the background.
fn ensure_browser(runtime: &Runtime) {
    if !runtime.bundled {
        return;
    }
    let Ok(log) = fs::File::create(runtime.data.join("browser-install.log")) else { return };
    let mut command = Command::new(&runtime.node);
    command
        .args(["node_modules/playwright/cli.js", "install", "chromium"])
        .current_dir(&runtime.app)
        .stdout(log.try_clone().expect("log handle"))
        .stderr(log);
    let _ = hidden(&mut command).spawn();
}

fn main() {
    // Started at Windows sign-in: run the server without a window, then exit.
    if std::env::args().any(|arg| arg == "--background") {
        if let Some(runtime) = runtime() {
            if server_running() && server_outdated(&runtime) {
                let _ = restart(&runtime);
            } else if !server_running() && start_server(&runtime).map(drop).is_ok() {
                ensure_browser(&runtime);
            }
        }
        return;
    }
    tauri::Builder::default()
        // Opening Rex Desk again brings the existing window back instead of starting a second copy.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_window(app)))
        .invoke_handler(tauri::generate_handler![restart_server, startup_error])
        .setup(|app| {
            let handle = app.handle().clone();
            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .on_new_window(move |url, features| open_link(&handle, url, features))
                .title("Rex Desk Beta")
                .inner_size(1440.0, 900.0)
                .min_inner_size(900.0, 600.0)
                .maximized(true)
                .build()?;
            // Rex Desk lives in the system tray: closing the window hides it while the server keeps running agents.
            let open = MenuItem::with_id(app, "open", "Open Rex Desk", true, None::<&str>)?;
            let again = MenuItem::with_id(app, "restart", "Restart Rex Desk server", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Rex Desk window", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &again, &quit])?;
            let mut tray = TrayIconBuilder::with_id("rex-desk")
                .tooltip("Rex Desk")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show_window(app),
                    "restart" => {
                        if let Some(runtime) = runtime() {
                            thread::spawn(move || { let _ = restart(&runtime); });
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                        show_window(tray.app_handle());
                    }
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;
            let hide_on_close = window.clone();
            window.on_window_event(move |event| {
                match event {
                    WindowEvent::CloseRequested { api, .. } => {
                        api.prevent_close();
                        let _ = hide_on_close.hide();
                    }
                    // Switching to the window checks its size too.
                    WindowEvent::Focused(true) => fix_size(&hide_on_close),
                    _ => {}
                }
            });
            let home = window.url().ok();
            thread::spawn(move || {
                let fail = |message: String| { set_error(&message); let _ = window.eval(&format!("showError({message:?})")); };
                let Some(runtime) = runtime_with(true) else {
                    return fail("Rex Desk files are missing. Reinstall Rex Desk.".into());
                };
                if server_running() && server_outdated(&runtime) {
                    if let Err(error) = restart(&runtime) {
                        return fail(error);
                    }
                } else if !server_running() {
                    let mut child = match start_server(&runtime) {
                        Ok(child) => child,
                        Err(error) => return fail(format!("Could not start Rex Desk: {error}")),
                    };
                    ensure_browser(&runtime);
                    if let Err(error) = wait_for_start(&runtime, &mut child, 360) {
                        return fail(error);
                    }
                }
                let server: tauri::Url = format!("http://{ADDRESS}").parse().expect("valid URL");
                let _ = window.navigate(server.clone());
                // Watchdog: when the server stops answering for about 8 seconds (longer than a self-update handover), the window
                // shows the app's own page with a Restart button and the app starts the server again by itself. When the server
                // answers again, the window goes back to Rex Desk.
                let mut down = 0u32;
                let mut away = false;
                loop {
                    thread::sleep(Duration::from_secs(2));
                    if server_running() {
                        down = 0;
                        if away {
                            away = false;
                            let _ = window.navigate(server.clone());
                        }
                        continue;
                    }
                    down += 1;
                    if down < 4 || RESTARTING.load(Ordering::SeqCst) {
                        continue;
                    }
                    // A server whose process is alive is busy, not gone: wait for it (up to five minutes), and only then
                    // restart it. A server whose process has ended is started again at once. The start page says which.
                    let alive = server_process_alive(&runtime);
                    if !away {
                        away = true;
                        if let Some(mut page) = home.clone() {
                            page.set_query(Some(if alive { "busy=1" } else { "down=1" }));
                            let _ = window.navigate(page);
                        }
                    }
                    if alive && down < 150 {
                        continue;
                    }
                    if (!alive && (down == 4 || down % 30 == 0)) || (alive && down % 150 == 0) {
                        if let Err(error) = restart(&runtime) {
                            let _ = window.eval(&format!("showError({error:?})"));
                        }
                    }
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Rex Desk");
}
