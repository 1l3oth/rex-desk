// The Windows installer moves the working payload to payload.old before it writes the new one, and removes the backup
// once the new copy is complete (windows/hooks.nsh). When the installer dies partway (an antivirus lock, a power cut)
// nothing runs its last step, so the app checks at start: a backup that is still there after a while means the install
// never finished. A broken new copy is then replaced by the backup, so Rex Desk opens on the version that worked.
// No dependencies, so it is tested on its own: rustc --edition 2021 --test src/payload_swap.rs
use std::{
    fs,
    path::Path,
    time::{Duration, SystemTime},
};

pub const BACKUP: &str = "payload.old";
pub const MARKER: &str = ".rex-desk-swap";
// How long a running installer may still be writing. A broken copy is put back sooner than a complete one is trusted.
pub const BROKEN_WAIT: Duration = Duration::from_secs(120);
pub const COMPLETE_WAIT: Duration = Duration::from_secs(30 * 60);

#[derive(Debug, PartialEq)]
pub enum Outcome {
    Nothing,
    Waiting,
    Restored,
    KeptNew,
    Failed(String),
}

// A payload Rex Desk can start: its Node and its server are both there.
pub fn complete(payload: &Path, node: &str) -> bool {
    payload.join("node").join(node).is_file() && payload.join("app").join("src").join("server.js").is_file()
}

pub fn recover(folder: &Path, node: &str, now: SystemTime) -> Outcome {
    let (payload, backup) = (folder.join("payload"), folder.join(BACKUP));
    if !backup.is_dir() {
        return Outcome::Nothing;
    }
    let marker = backup.join(MARKER);
    let since = fs::metadata(&marker).or_else(|_| fs::metadata(&backup)).and_then(|meta| meta.modified()).ok();
    let age = since.and_then(|at| now.duration_since(at).ok()).unwrap_or(Duration::ZERO);
    let new_ok = complete(&payload, node);
    if age < if new_ok { COMPLETE_WAIT } else { BROKEN_WAIT } {
        return Outcome::Waiting;
    }
    if new_ok {
        // The copy finished and only the clean-up was lost: keep the new version.
        return match fs::remove_dir_all(&backup) {
            Ok(()) => Outcome::KeptNew,
            Err(error) => Outcome::Failed(format!("could not remove {}: {error}", backup.display())),
        };
    }
    if !complete(&backup, node) {
        return Outcome::Failed("neither the new nor the old payload is complete".into());
    }
    // The broken copy is moved out of the way first, so the swap itself is one rename.
    let broken = folder.join("payload.broken");
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
    let _ = fs::remove_file(payload.join(MARKER));
    let _ = fs::remove_dir_all(&broken);
    Outcome::Restored
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
    fn payload(dir: &Path, version: &str, whole: bool) {
        fs::create_dir_all(dir.join("node")).unwrap();
        fs::create_dir_all(dir.join("app").join("src")).unwrap();
        fs::write(dir.join("app").join("version.txt"), version).unwrap();
        if whole {
            fs::write(dir.join("node").join(NODE), "node").unwrap();
            fs::write(dir.join("app").join("src").join("server.js"), version).unwrap();
        }
    }
    fn version(dir: &Path) -> String {
        fs::read_to_string(dir.join("payload").join("app").join("version.txt")).unwrap()
    }
    fn later(by: Duration) -> SystemTime {
        SystemTime::now() + by
    }

    #[test]
    fn no_backup_means_nothing_to_do() {
        let dir = folder("none");
        payload(&dir.join("payload"), "new", true);
        assert_eq!(recover(&dir, NODE, later(Duration::from_secs(3600))), Outcome::Nothing);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_broken_install_gets_the_old_version_back_after_the_wait() {
        let dir = folder("broken");
        payload(&dir.join(BACKUP), "old", true);
        fs::write(dir.join(BACKUP).join(MARKER), "installing").unwrap();
        payload(&dir.join("payload"), "new", false);
        assert_eq!(recover(&dir, NODE, later(Duration::from_secs(30))), Outcome::Waiting, "an installer may still be writing");
        assert_eq!(recover(&dir, NODE, later(BROKEN_WAIT + Duration::from_secs(1))), Outcome::Restored);
        assert_eq!(version(&dir), "old");
        assert!(complete(&dir.join("payload"), NODE));
        assert!(!dir.join(BACKUP).exists() && !dir.join("payload.broken").exists());
        assert!(!dir.join("payload").join(MARKER).exists());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_new_payload_missing_entirely_gets_the_old_one_back() {
        let dir = folder("missing");
        payload(&dir.join(BACKUP), "old", true);
        assert_eq!(recover(&dir, NODE, later(BROKEN_WAIT + Duration::from_secs(1))), Outcome::Restored);
        assert_eq!(version(&dir), "old");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_complete_install_that_lost_its_clean_up_keeps_the_new_version() {
        let dir = folder("complete");
        payload(&dir.join(BACKUP), "old", true);
        payload(&dir.join("payload"), "new", true);
        assert_eq!(recover(&dir, NODE, later(BROKEN_WAIT + Duration::from_secs(1))), Outcome::Waiting, "a complete copy waits longer");
        assert_eq!(recover(&dir, NODE, later(COMPLETE_WAIT + Duration::from_secs(1))), Outcome::KeptNew);
        assert_eq!(version(&dir), "new");
        assert!(!dir.join(BACKUP).exists());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_broken_backup_is_never_swapped_in() {
        let dir = folder("both-broken");
        payload(&dir.join(BACKUP), "old", false);
        payload(&dir.join("payload"), "new", false);
        assert!(matches!(recover(&dir, NODE, later(BROKEN_WAIT + Duration::from_secs(1))), Outcome::Failed(_)));
        assert_eq!(version(&dir), "new", "nothing is moved");
        fs::remove_dir_all(&dir).unwrap();
    }
}
