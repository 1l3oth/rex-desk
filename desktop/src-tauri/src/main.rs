#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    fs,
    net::{SocketAddr, TcpStream},
    path::PathBuf,
    process::Command,
    thread,
    time::{Duration, Instant},
};
use tauri::{WebviewUrl, WebviewWindowBuilder};

const ADDRESS: &str = "127.0.0.1:4317";
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn server_running() -> bool {
    let address: SocketAddr = ADDRESS.parse().expect("valid address");
    TcpStream::connect_timeout(&address, Duration::from_millis(300)).is_ok()
}

struct Runtime {
    node: PathBuf,
    app: PathBuf,
    data: PathBuf,
    bundled: bool,
}

// REX_DESK_HOME wins; otherwise the checkout this window was built from, then the README's default folder.
fn checkout() -> Option<PathBuf> {
    let built = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("..");
    std::env::var_os("REX_DESK_HOME")
        .map(PathBuf::from)
        .into_iter()
        .chain([built, PathBuf::from(r"F:\rex-desk")])
        .find(|root| root.join("src").join("server.js").is_file())
}

// The installed app carries its own Node and server next to the executable and keeps data in %APPDATA%\Rex Desk.
// A development build falls back to a checkout and the system Node.
fn runtime() -> Option<Runtime> {
    let beside = std::env::current_exe().ok()?.parent()?.join("payload");
    let (node, app) = (beside.join("node").join("node.exe"), beside.join("app"));
    if node.is_file() && app.join("src").join("server.js").is_file() {
        let data = std::env::var_os("APPDATA").map(PathBuf::from).unwrap_or_else(|| beside.clone()).join("Rex Desk");
        return Some(Runtime { node, app, data, bundled: true });
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
        if let Some(home) = std::env::var_os("USERPROFILE") {
            command.env("REX_CLONE_DIR", PathBuf::from(home).join("Rex Desk repositories"));
        }
    }
    hidden(&mut command).spawn().map(|_| ())
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
        .setup(|app| {
            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Rex Desk")
                .inner_size(1440.0, 900.0)
                .min_inner_size(900.0, 600.0)
                .maximized(true)
                .build()?;
            thread::spawn(move || {
                let fail = |message: String| { let _ = window.eval(&format!("showError({message:?})")); };
                let Some(runtime) = runtime() else {
                    return fail("Rex Desk files are missing. Reinstall Rex Desk.".into());
                };
                if !server_running() {
                    if let Err(error) = start_server(&runtime) {
                        return fail(format!("Could not start Rex Desk: {error}"));
                    }
                    ensure_browser(&runtime);
                }
                let deadline = Instant::now() + Duration::from_secs(30);
                while !server_running() {
                    if Instant::now() > deadline {
                        return fail(format!("Rex Desk did not start. See {}", runtime.data.join("server-error.log").display()));
                    }
                    thread::sleep(Duration::from_millis(250));
                }
                let _ = window.navigate(format!("http://{ADDRESS}").parse().expect("valid URL"));
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Rex Desk");
}
