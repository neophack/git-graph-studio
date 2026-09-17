//! The file-system watcher behind "external changes show up by themselves": one recursive
//! `notify` watch on the open folder, whose raw events are coalesced for a short debounce
//! window and then reported as one `FsChange` batch — the working-tree paths that changed
//! (repo-relative, forward slashes, capped) plus a flag for anything under `.git/`, which the
//! git-derived views (SCM, graph, status bar) refresh on without caring which ref moved.
//!
//! The batch is handed to a callback; `main.rs` forwards it to the webview as the
//! `studio://fs-changed` event and drops the caches it invalidates (file list, symbols).

use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use notify::{RecursiveMode, Watcher as _};
use serde::Serialize;

/// How long after the last raw event a batch is reported. A git checkout or a build touches
/// hundreds of files in a burst; one refresh at the end of the burst is what the UI wants.
pub const DEBOUNCE: Duration = Duration::from_millis(100);
/// A batch never carries more paths than this; the flag says the list is incomplete and the
/// consumer does a full refresh instead of a per-path one.
pub const MAX_PATHS: usize = 200;

/// One coalesced burst of changes under the watched folder.
#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FsChange {
    /// The watched folder the batch came from (a batch from a just-closed folder is stale).
    pub root: String,
    /// Changed working-tree paths, repo-relative with forward slashes, sorted and unique.
    pub paths: Vec<String>,
    /// More paths changed than `paths` lists.
    pub truncated: bool,
    /// Something under `.git/` changed (index, HEAD, refs, a merge in progress…).
    pub git_changed: bool,
}

/// Folders whose churn is noise to every consumer (the Explorer never shows them, the index
/// skips them): a build writing into `target/` must not refresh the SCM view a hundred times.
const NOISE_DIRS: &[&str] = &["node_modules", "target", ".svn", ".hg"];

/// Fold one raw event path into the batch being built. Pure, so the classification is unit
/// tested without a watcher: paths outside the root are dropped, `.git/` sets the flag (its
/// own paths are never listed), noise folders are dropped, everything else is listed.
pub(crate) fn fold_path(batch: &mut FsChange, root: &Path, path: &Path) {
    let Ok(relative) = path.strip_prefix(root) else {
        return;
    };
    let mut parts = relative
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned());
    let Some(first) = parts.next() else { return };
    if first == ".git" {
        // Only the entries that mean the repository's state moved count: HEAD and the refs
        // (a commit, checkout, fetch, merge in progress), the config. `index` / `index.lock`
        // are rewritten by every `git status` the app itself runs - reacting to them made a
        // refresh trigger the next refresh, forever - and `objects/`, `logs/`, hooks and the
        // like are noise to every view.
        let head = parts.next().unwrap_or_default();
        let significant = matches!(
            head.as_str(),
            "HEAD"
                | "ORIG_HEAD"
                | "FETCH_HEAD"
                | "MERGE_HEAD"
                | "CHERRY_PICK_HEAD"
                | "REBASE_HEAD"
                | "REVERT_HEAD"
                | "MERGE_MSG"
                | "packed-refs"
                | "config"
                | "refs"
                | "worktrees"
                | "rebase-merge"
                | "rebase-apply"
        );
        if significant {
            batch.git_changed = true;
        }
        return;
    }
    let all: Vec<String> = std::iter::once(first).chain(parts).collect();
    if all.iter().any(|part| NOISE_DIRS.contains(&part.as_str())) {
        return;
    }
    if batch.paths.len() >= MAX_PATHS {
        batch.truncated = true;
        return;
    }
    let joined = all.join("/");
    if let Err(at) = batch.paths.binary_search(&joined) {
        batch.paths.insert(at, joined);
    }
}

/// A live watch on one folder. Dropping it stops the watcher thread.
pub struct FolderWatcher {
    _watcher: notify::RecommendedWatcher,
    stop: mpsc::Sender<()>,
}

impl FolderWatcher {
    /// Watch `root` recursively, calling `on_change` with each debounced batch from a
    /// background thread. Returns an error when the OS refuses the watch (the app then falls
    /// back to its command-driven refreshes, exactly as before the watcher existed).
    pub fn new(
        root: &str,
        on_change: impl Fn(FsChange) + Send + 'static,
    ) -> Result<FolderWatcher, String> {
        let (raw_tx, raw_rx) = mpsc::channel::<PathBuf>();
        let (stop, stopped) = mpsc::channel::<()>();
        let mut watcher =
            notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
                if let Ok(event) = result {
                    // Pure reads (`Access`) are not changes; everything else is.
                    if matches!(event.kind, notify::EventKind::Access(_)) {
                        return;
                    }
                    for path in event.paths {
                        let _ = raw_tx.send(path);
                    }
                }
            })
            .map_err(|e| format!("Could not create the file watcher: {e}"))?;
        watcher
            .watch(Path::new(root), RecursiveMode::Recursive)
            .map_err(|e| format!("Could not watch {root}: {e}"))?;

        let root_path = PathBuf::from(root);
        std::thread::Builder::new()
            .name("fs-watcher".into())
            .spawn(move || debounce_loop(&root_path, &raw_rx, &stopped, on_change))
            .map_err(|e| format!("Could not start the watcher thread: {e}"))?;
        Ok(FolderWatcher {
            _watcher: watcher,
            stop,
        })
    }
}

impl Drop for FolderWatcher {
    fn drop(&mut self) {
        let _ = self.stop.send(());
    }
}

/// Collect raw paths until the stream has been quiet for `DEBOUNCE`, then report the batch.
/// Ends when the watcher is dropped (the raw sender closes) or `stopped` fires.
fn debounce_loop(
    root: &Path,
    raw: &mpsc::Receiver<PathBuf>,
    stopped: &mpsc::Receiver<()>,
    on_change: impl Fn(FsChange),
) {
    loop {
        // Idle: block until the first event of a burst.
        let first = match raw.recv() {
            Ok(path) => path,
            Err(_) => return,
        };
        if stopped.try_recv().is_ok() {
            return;
        }
        let mut batch = FsChange::default();
        fold_path(&mut batch, root, &first);
        // Burst: keep folding until the stream is quiet for the debounce window.
        let mut quiet_since = Instant::now();
        loop {
            match raw.recv_timeout(DEBOUNCE.saturating_sub(quiet_since.elapsed())) {
                Ok(path) => {
                    fold_path(&mut batch, root, &path);
                    quiet_since = Instant::now();
                }
                Err(mpsc::RecvTimeoutError::Timeout) => break,
                Err(mpsc::RecvTimeoutError::Disconnected) => return,
            }
        }
        if !batch.paths.is_empty() || batch.git_changed || batch.truncated {
            batch.root = root.to_string_lossy().into_owned();
            on_change(batch);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a path under `root` from forward-slash segments with the platform's separator,
    /// so the test sees the same `Path` shapes the OS watcher hands over on Linux, macOS
    /// and Windows alike.
    fn under(root: &Path, relative: &str) -> PathBuf {
        relative
            .split('/')
            .fold(root.to_path_buf(), |p, seg| p.join(seg))
    }

    #[test]
    fn folds_paths_relative_flags_git_and_drops_noise() {
        let root = &std::env::temp_dir().join("repo");
        let elsewhere = &std::env::temp_dir().join("elsewhere");
        let mut batch = FsChange::default();
        fold_path(&mut batch, root, &under(root, "src/b.rs"));
        fold_path(&mut batch, root, &under(root, "src/a.rs"));
        fold_path(&mut batch, root, &under(root, "src/a.rs"));
        fold_path(&mut batch, root, &under(root, ".git/refs/heads/main"));
        fold_path(&mut batch, root, &under(root, "target/debug/x.o"));
        fold_path(&mut batch, root, &under(root, "node_modules/m/index.js"));
        fold_path(&mut batch, root, &under(elsewhere, "c.rs"));
        assert_eq!(batch.paths, ["src/a.rs", "src/b.rs"]);
        assert!(batch.git_changed);
        assert!(!batch.truncated);

        // The index (rewritten by every `git status`), loose objects and reflogs never count
        // as a repository change: they are what the app's own reads and writes produce.
        let mut quiet = FsChange::default();
        for noise in [
            "index",
            "index.lock",
            "objects/ab/cdef",
            "logs/HEAD",
            "hooks/pre-commit",
            "COMMIT_EDITMSG",
        ] {
            fold_path(&mut quiet, root, &under(root, &format!(".git/{noise}")));
        }
        assert!(!quiet.git_changed);
        assert!(quiet.paths.is_empty());
        for signal in [
            "HEAD",
            "MERGE_HEAD",
            "packed-refs",
            "refs/remotes/origin/main",
        ] {
            let mut change = FsChange::default();
            fold_path(&mut change, root, &under(root, &format!(".git/{signal}")));
            assert!(change.git_changed, "{signal}");
        }
    }

    #[test]
    fn caps_the_listed_paths_and_marks_the_batch_truncated() {
        let root = Path::new("/r");
        let mut batch = FsChange::default();
        for i in 0..(MAX_PATHS + 5) {
            fold_path(&mut batch, root, &root.join(format!("f{i}")));
        }
        assert_eq!(batch.paths.len(), MAX_PATHS);
        assert!(batch.truncated);
    }

    #[test]
    fn a_real_watch_reports_a_debounced_batch() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().display().to_string();
        // The subfolder exists before the watch starts: inotify only covers a directory
        // created under a live watch once `notify` has registered it, which happens
        // asynchronously, so a file written into a brand-new folder can slip past the
        // recursive watch on Linux. That gap is `notify`'s, not what this test checks.
        std::fs::create_dir_all(dir.path().join("src")).unwrap();
        let (tx, rx) = mpsc::channel();
        let watcher = FolderWatcher::new(&root, move |change| {
            let _ = tx.send(change);
        })
        .unwrap();
        // The OS watch is registered asynchronously on some platforms; give it a moment.
        std::thread::sleep(Duration::from_millis(200));
        std::fs::write(dir.path().join("src").join("main.rs"), b"fn main() {}").unwrap();
        std::fs::write(dir.path().join("README.md"), b"#").unwrap();

        let batch = rx
            .recv_timeout(Duration::from_secs(5))
            .expect("a change batch within 5 s");
        assert!(
            batch.paths.iter().any(|p| p == "src/main.rs"),
            "got {:?}",
            batch.paths
        );
        assert!(
            batch.paths.iter().any(|p| p == "README.md"),
            "got {:?}",
            batch.paths
        );
        assert!(!batch.git_changed);
        drop(watcher);
    }
}
