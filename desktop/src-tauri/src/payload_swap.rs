// The Windows installer moves the working payload to payload.old before it writes the new one (windows/hooks.nsh). Once
// every file of the new copy is checked against the list the build wrote (.rex-desk-files), the installer writes the
// completion marker and drops the backup. When the installer dies partway (an antivirus lock, a power cut) nothing runs
// that last step, so the app checks at start: a backup next to a payload without the marker means the install never
// finished, and the backup goes back so Rex Desk opens on the version that worked.
// The installer holds a named lock (LOCK) from before it touches the payload until it is done; the app only looks while
// it holds the same lock, so it never swaps folders under a running installer, and the installer waits for a swap the
// app has started. Windows frees the lock when the installer dies, so a dead install is put back on the next start.
// No dependencies, so it is tested on its own: rustc --edition 2021 --test src/payload_swap.rs
use std::{fs, path::Path};

pub const BACKUP: &str = "payload.old";
pub const BROKEN: &str = "payload.broken";
// Written by the installer, and only after the new copy matched the file list. Never part of the build itself.
pub const FINISHED: &str = ".rex-desk-complete";
pub const LOCK: &str = "Local\\RexDeskPayloadSwap";

#[derive(Debug, PartialEq)]
pub enum Outcome {
    Nothing,
    Waiting,
    Restored,
    KeptNew,
    Failed(String),
}

// A copy the installer finished and checked.
pub fn finished(payload: &Path) -> bool {
    payload.join(FINISHED).is_file()
}

// A backup worth putting back: one the installer finished, or one from a version older than the marker that has its Node
// and its server (it was the copy that ran).
pub fn usable(payload: &Path, node: &str) -> bool {
    finished(payload) || (payload.join("node").join(node).is_file() && payload.join("app").join("src").join("server.js").is_file())
}

pub fn recover(folder: &Path, node: &str) -> Outcome {
    recover_with(folder, node, LOCK)
}

pub fn recover_with(folder: &Path, node: &str, lock: &str) -> Outcome {
    if !folder.join(BACKUP).is_dir() {
        return Outcome::Nothing;
    }
    // An installer is still writing (or the lock cannot be checked): leave everything as it is.
    let Some(_held) = lock::take(lock) else {
        return Outcome::Waiting;
    };
    recover_now(folder, node)
}

fn recover_now(folder: &Path, node: &str) -> Outcome {
    let (payload, backup) = (folder.join("payload"), folder.join(BACKUP));
    if !backup.is_dir() {
        return Outcome::Nothing;
    }
    if finished(&payload) {
        // The copy finished and only the clean-up was lost: keep the new version. A backup that cannot be removed yet (a
        // file in it held open) does not stop Rex Desk, since the copy in use is the checked one; the next start or the
        // next installer removes it.
        let _ = fs::remove_dir_all(&backup);
        return Outcome::KeptNew;
    }
    if !usable(&backup, node) {
        return Outcome::Failed("neither the new nor the old payload is complete".into());
    }
    // The broken copy is moved out of the way first, so the swap itself is one rename. Nothing is deleted until the old
    // copy is back in place; when a rename fails, the backup stays where it is for the next try.
    let broken = folder.join(BROKEN);
    let _ = fs::remove_dir_all(&broken);
    if payload.exists() {
        if let Err(error) = fs::rename(&payload, &broken) {
            return Outcome::Failed(format!("could not move the broken payload: {error}"));
        }
    }
    if let Err(error) = fs::rename(&backup, &payload) {
        let _ = fs::rename(&broken, &payload);
        return Outcome::Failed(format!("could not put the old payload back: {error}"));
    }
    let _ = fs::remove_dir_all(&broken);
    Outcome::Restored
}

// The same named mutex the installer takes with CreateMutexW and WaitForSingleObject. Windows releases it when its owner
// exits, so a lock left by a dead installer is taken here as abandoned, which is fine.
#[cfg(windows)]
mod lock {
    use std::ffi::c_void;
    type Handle = *mut c_void;
    #[link(name = "kernel32")]
    extern "system" {
        fn CreateMutexW(attributes: *mut c_void, initial_owner: i32, name: *const u16) -> Handle;
        fn WaitForSingleObject(handle: Handle, milliseconds: u32) -> u32;
        fn ReleaseMutex(handle: Handle) -> i32;
        fn CloseHandle(handle: Handle) -> i32;
    }
    const WAIT_OBJECT_0: u32 = 0;
    const WAIT_ABANDONED: u32 = 0x80;

    pub struct Held(Handle);
    impl Drop for Held {
        fn drop(&mut self) {
            unsafe {
                ReleaseMutex(self.0);
                CloseHandle(self.0);
            }
        }
    }

    pub fn take(name: &str) -> Option<Held> {
        let wide: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
        unsafe {
            let handle = CreateMutexW(std::ptr::null_mut(), 0, wide.as_ptr());
            if handle.is_null() {
                return None;
            }
            match WaitForSingleObject(handle, 0) {
                WAIT_OBJECT_0 | WAIT_ABANDONED => Some(Held(handle)),
                _ => {
                    CloseHandle(handle);
                    None
                }
            }
        }
    }
}

#[cfg(not(windows))]
mod lock {
    pub struct Held;
    pub fn take(_name: &str) -> Option<Held> {
        Some(Held)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    const NODE: &str = "node.exe";

    fn folder(name: &str) -> PathBuf {
        let base = std::env::var("REX_SWAP_TEST_DIR").map(PathBuf::from).unwrap_or_else(|_| std::env::temp_dir());
        let dir = base.join(format!("rex-swap-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }
    fn lock_name(name: &str) -> String {
        format!("Local\\RexDeskPayloadSwapTest-{name}-{}", std::process::id())
    }
    // whole: Node and server there. marked: the installer wrote its completion marker.
    fn payload(dir: &Path, version: &str, whole: bool, marked: bool) {
        fs::create_dir_all(dir.join("node")).unwrap();
        fs::create_dir_all(dir.join("app").join("src")).unwrap();
        fs::write(dir.join("app").join("version.txt"), version).unwrap();
        if whole {
            fs::write(dir.join("node").join(NODE), "node").unwrap();
            fs::write(dir.join("app").join("src").join("server.js"), version).unwrap();
        }
        if marked {
            fs::write(dir.join(FINISHED), "complete").unwrap();
        }
    }
    fn version(dir: &Path) -> String {
        fs::read_to_string(dir.join("payload").join("app").join("version.txt")).unwrap()
    }

    #[test]
    fn no_backup_means_nothing_to_do() {
        let dir = folder("none");
        payload(&dir.join("payload"), "new", true, true);
        assert_eq!(recover_with(&dir, NODE, &lock_name("none")), Outcome::Nothing);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_broken_install_gets_the_old_version_back_at_once() {
        let dir = folder("broken");
        payload(&dir.join(BACKUP), "old", true, true);
        payload(&dir.join("payload"), "new", false, false);
        assert_eq!(recover_with(&dir, NODE, &lock_name("broken")), Outcome::Restored);
        assert_eq!(version(&dir), "old");
        assert!(finished(&dir.join("payload")));
        assert!(!dir.join(BACKUP).exists() && !dir.join(BROKEN).exists());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn node_and_server_alone_do_not_make_a_new_copy_finished() {
        let dir = folder("unmarked");
        payload(&dir.join(BACKUP), "old", true, true);
        payload(&dir.join("payload"), "new", true, false);
        assert_eq!(recover_with(&dir, NODE, &lock_name("unmarked")), Outcome::Restored, "no marker: the installer never checked it");
        assert_eq!(version(&dir), "old");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_backup_from_before_the_marker_is_still_put_back() {
        let dir = folder("legacy");
        payload(&dir.join(BACKUP), "old", true, false);
        payload(&dir.join("payload"), "new", false, false);
        assert_eq!(recover_with(&dir, NODE, &lock_name("legacy")), Outcome::Restored);
        assert_eq!(version(&dir), "old");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_new_payload_missing_entirely_gets_the_old_one_back() {
        let dir = folder("missing");
        payload(&dir.join(BACKUP), "old", true, true);
        assert_eq!(recover_with(&dir, NODE, &lock_name("missing")), Outcome::Restored);
        assert_eq!(version(&dir), "old");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_finished_install_that_lost_its_clean_up_keeps_the_new_version() {
        let dir = folder("complete");
        payload(&dir.join(BACKUP), "old", true, true);
        payload(&dir.join("payload"), "new", true, true);
        assert_eq!(recover_with(&dir, NODE, &lock_name("complete")), Outcome::KeptNew);
        assert_eq!(version(&dir), "new");
        assert!(!dir.join(BACKUP).exists());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn a_backup_that_cannot_be_removed_does_not_stop_a_finished_copy() {
        use std::os::windows::fs::OpenOptionsExt;
        let dir = folder("stuck");
        payload(&dir.join(BACKUP), "old", true, true);
        payload(&dir.join("payload"), "new", true, true);
        // A file in the backup held open with no sharing, as a virus scanner may.
        let held = fs::OpenOptions::new().read(true).share_mode(0).open(dir.join(BACKUP).join("app").join("version.txt")).unwrap();
        assert_eq!(recover_with(&dir, NODE, &lock_name("stuck")), Outcome::KeptNew);
        assert_eq!(version(&dir), "new");
        drop(held);
        assert_eq!(recover_with(&dir, NODE, &lock_name("stuck")), Outcome::KeptNew, "removed on the next start");
        assert!(!dir.join(BACKUP).exists());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_broken_backup_is_never_swapped_in() {
        let dir = folder("both-broken");
        payload(&dir.join(BACKUP), "old", false, false);
        payload(&dir.join("payload"), "new", false, false);
        assert!(matches!(recover_with(&dir, NODE, &lock_name("both-broken")), Outcome::Failed(_)));
        assert_eq!(version(&dir), "new", "nothing is moved");
        assert!(dir.join(BACKUP).exists());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn nothing_moves_while_an_installer_holds_the_lock() {
        use std::{sync::mpsc, thread};
        let dir = folder("locked");
        payload(&dir.join(BACKUP), "old", true, true);
        payload(&dir.join("payload"), "new", false, false);
        let name = lock_name("locked");
        // The installer: another thread that holds the lock until told to stop, like the NSIS install thread.
        let (held_tx, held_rx) = mpsc::channel();
        let (stop_tx, stop_rx) = mpsc::channel::<()>();
        let holder = {
            let name = name.clone();
            thread::spawn(move || {
                let held = lock::take(&name).expect("installer takes the lock");
                held_tx.send(()).unwrap();
                stop_rx.recv().unwrap();
                drop(held);
            })
        };
        held_rx.recv().unwrap();
        assert_eq!(recover_with(&dir, NODE, &name), Outcome::Waiting);
        assert_eq!(version(&dir), "new", "nothing moved under the installer");
        assert!(dir.join(BACKUP).exists());
        stop_tx.send(()).unwrap();
        holder.join().unwrap();
        assert_eq!(recover_with(&dir, NODE, &name), Outcome::Restored);
        assert_eq!(version(&dir), "old");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn a_lock_left_by_a_dead_installer_does_not_block() {
        use std::thread;
        let dir = folder("dead");
        payload(&dir.join(BACKUP), "old", true, true);
        payload(&dir.join("payload"), "new", false, false);
        let name = lock_name("dead");
        // The owner thread ends without releasing: Windows marks the mutex abandoned, as when the installer is killed.
        let owner = name.clone();
        thread::spawn(move || std::mem::forget(lock::take(&owner).unwrap())).join().unwrap();
        assert_eq!(recover_with(&dir, NODE, &name), Outcome::Restored);
        assert_eq!(version(&dir), "old");
        fs::remove_dir_all(&dir).unwrap();
    }
}
