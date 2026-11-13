#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    fs,
    net::{SocketAddr, TcpStream},
    path::PathBuf,
    process::Command,
    sync::atomic::{AtomicBool, AtomicUsize, Ordering},
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
        let _ = window.set_focus();
    }
}

const ADDRESS: &str = "127.0.0.1:4317";
static OPENED: AtomicUsize = AtomicUsize::new(0);
static RESTARTING: AtomicBool = AtomicBool::new(false);

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

fn server_running() -> bool {
    let address: SocketAddr = ADDRESS.parse().expect("valid address");
    TcpStream::connect_timeout(&address, Duration::from_millis(300)).is_ok()
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
fn start_server(runtime: &Runtime) -> std::io::Result<()> {
    fs::create_dir_all(&runtime.data)?;
    let mut command = Command::new(&runtime.node);
    command
        .arg("src/server.js")
        .current_dir(&runtime.app)
        .env("REX_DATA_DIR", &runtime.data)
        .stdout(fs::File::create(runtime.data.join("server.log"))?)
        .stderr(fs::File::create(runtime.data.join("server-error.log"))?);
    if runtime.bundled {
        command.env("REX_DESK_VERSION", env!("CARGO_PKG_VERSION"));
        if let Ok(executable) = std::env::current_exe() {
            command.env("REX_DESK_EXE", executable);
        }
        if let Some(home) = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }) {
            command.env("REX_CLONE_DIR", PathBuf::from(home).join("Rex Desk repositories"));
        }
    }
    hidden(&mut command).spawn().map(|_| ())
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
        start_server(runtime).map_err(|error| format!("Could not start Rex Desk: {error}"))?;
        if wait_for_server(240) {
            Ok(())
        } else {
            Err(format!("Rex Desk did not start. See {}", runtime.data.join("server-error.log").display()))
        }
    })();
    RESTARTING.store(false, Ordering::SeqCst);
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
            if !server_running() && start_server(&runtime).is_ok() {
                ensure_browser(&runtime);
            }
        }
        return;
    }
    tauri::Builder::default()
        // Opening Rex Desk again brings the existing window back instead of starting a second copy.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_window(app)))
        .invoke_handler(tauri::generate_handler![restart_server])
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
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = hide_on_close.hide();
                }
            });
            let home = window.url().ok();
            thread::spawn(move || {
                let fail = |message: String| { let _ = window.eval(&format!("showError({message:?})")); };
                let Some(runtime) = runtime_with(true) else {
                    return fail("Rex Desk files are missing. Reinstall Rex Desk.".into());
                };
                if !server_running() {
                    if let Err(error) = start_server(&runtime) {
                        return fail(format!("Could not start Rex Desk: {error}"));
                    }
                    ensure_browser(&runtime);
                }
                let deadline = Instant::now() + Duration::from_secs(90);
                while !server_running() {
                    if Instant::now() > deadline {
                        return fail(format!("Rex Desk did not start. See {}", runtime.data.join("server-error.log").display()));
                    }
                    thread::sleep(Duration::from_millis(250));
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
                    if !away {
                        away = true;
                        if let Some(mut page) = home.clone() {
                            page.set_query(Some("down=1"));
                            let _ = window.navigate(page);
                        }
                    }
                    if down == 4 || down % 30 == 0 {
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
