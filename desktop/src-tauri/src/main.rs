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

fn server_running() -> bool {
    let address: SocketAddr = ADDRESS.parse().expect("valid address");
    TcpStream::connect_timeout(&address, Duration::from_millis(300)).is_ok()
}

// REX_DESK_HOME wins; otherwise the checkout this window was built from, then the README's default folder.
fn project_root() -> Option<PathBuf> {
    let built = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("..");
    std::env::var_os("REX_DESK_HOME")
        .map(PathBuf::from)
        .into_iter()
        .chain([built, PathBuf::from(r"F:\rex-desk")])
        .find(|root| root.join("src").join("server.js").is_file())
}

// Same logs as Start-RexDesk.ps1. The server outlives the window so closing it never interrupts running agents.
fn start_server(root: &PathBuf) -> std::io::Result<()> {
    let local = root.join(".local");
    fs::create_dir_all(&local)?;
    let mut command = Command::new("node");
    command
        .arg("src/server.js")
        .current_dir(root)
        .stdout(fs::File::create(local.join("server.log"))?)
        .stderr(fs::File::create(local.join("server-error.log"))?);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    command.spawn().map(|_| ())
}

fn main() {
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
                if !server_running() {
                    let Some(root) = project_root() else {
                        return fail("Rex Desk folder not found. Set REX_DESK_HOME to your rex-desk checkout and reopen.".into());
                    };
                    if let Err(error) = start_server(&root) {
                        return fail(format!("Could not start Node.js: {error}"));
                    }
                }
                let deadline = Instant::now() + Duration::from_secs(20);
                while !server_running() {
                    if Instant::now() > deadline {
                        return fail("Rex Desk did not start. Check .local/server-error.log.".into());
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
