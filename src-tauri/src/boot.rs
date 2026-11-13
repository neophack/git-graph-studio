//! The boot's workspace half (module 1's backend): open_folder / open_workspace /
//! open_single_file / close_folder / boot_context / post_first_paint — the folder
//! lifecycle, over the split states (state.rs's FolderSwitch bundles the reset).
//! Extracted from lib.rs's composition root (the restructure's P4-1); the
//! composition root registers the commands.

use ggs_base::workspace::{find_repo_root, WorkspaceRoots};

use crate::cmd_fs::{watcher_reports, WATCHER_STATUS_EVENT};
use crate::state::{FolderSwitch, LaunchState, StartupAction};
#[cfg(test)]
use crate::state::StateSet;
#[cfg(test)]
use ggs_base::workspace::is_repo_below;

/// What `open_folder` answers: the folder actually opened, and whether it is (or sits
/// inside) a Git repository — the shell's "Initialize Repository" affordances key on the
/// latter.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedFolder {
    root: String,
    is_repo: bool,
}

/// Open a folder. A git repository resolves to its root (the graph, the SCM view and the
/// terminal all key off it); any other folder still opens — the explorer and the editor work
/// without git, and the git-backed views offer to initialise a repository instead.
#[tauri::command]
pub async fn open_folder(app: tauri::AppHandle, path: String) -> Result<OpenedFolder, String> {
    open_folder_impl(&FolderSwitch::from_app(&app), &path).await
}

async fn open_folder_impl(folders: &FolderSwitch<'_>, path: &str) -> Result<OpenedFolder, String> {
    if !std::path::Path::new(path).is_dir() {
        return Err(format!("{path} is not a folder"));
    }
    // The repository root is found on the file system here (the nearest ancestor holding a
    // `.git`), not asked of the engine: opening a folder must never wait for the engine's
    // warm-up, which may still be running on a fresh launch.
    let found_root = find_repo_root(path);
    let root = found_root.clone().unwrap_or_else(|| path.to_owned());
    let opened = OpenedFolder {
        is_repo: found_root.is_some(),
        root: root.clone(),
    };
    // Reopening the repository that is already open (the launch argument being re-opened by
    // the frontend's boot) keeps the engine's warm handle and the backend's caches: closing
    // them here would throw away exactly the work the boot-time warm-up did.
    let already_open = folders.roots.first_is(&root);
    folders.reset();
    folders.roots.set(vec![root.clone()]);
    folders.roots.set_workspace(None);
    if !already_open {
        crate::ext_process::host().notify_workspace(std::slice::from_ref(&root));
        crate::cmd_providers::apply_claude_integration(std::slice::from_ref(&root));
        crate::remote_host::notify_folders(std::slice::from_ref(&root));
    }
    // Warm Quick Open's file list in the background: by the time the user hits Ctrl+P the
    // walk has usually finished and the picker opens on a cache hit. This walk is the one
    // background service that stays on the open path - it is cheap, and Quick Open's first
    // keystroke can come at any moment.
    let prefetch_root = root.clone();
    let cache = folders.file_list_cache.clone();
    std::thread::spawn(move || {
        let files = ggs_fs::walk_files(&prefetch_root);
        cache.store(&prefetch_root, files);
    });
    // The file watcher records itself here but starts only with `post_first_paint`, once
    // the shell has painted its first frame with this folder: its recursive scan must not
    // share the CPU with that frame and the graph view's boot. The symbol and analysis
    // indexes are not opened at all - they load on the first query that needs them.
    folders.deferred.record(vec![root.clone()]);
    Ok(opened)
}

/// The event the frontend listens to for external file changes; its payload is a `FsChange`.
const FS_CHANGED_EVENT: &str = "studio://fs-changed";

/// One watcher batch folded into the persistent indexes. A complete batch updates file by
/// file (and persists). A truncated batch (more paths changed than the batch lists — a
/// branch switch, a large checkout) drops the resident stores outright and announces the
/// `Empty` status, exactly as the idle release does: updating with the partial list would
/// leave the index silently wrong until the idle release let the next query repair it, and
/// a resident store is never resumed (`ensure_blocking` early-returns on one) — dropping it
/// sends the next query through the resume path, whose fingerprint pass repairs the gap
/// from disk.
fn apply_index_changes(
    index: &std::sync::Arc<ggs_index::symbols::index::SymbolIndex>,
    analysis: &std::sync::Arc<ggs_analysis::index::AnalysisIndex>,
    sink: std::sync::Arc<dyn ggs_base::sink::EventSink>,
    root: &str,
    change: &crate::watcher::FsChange,
) {
    if change.truncated {
        index.remove(root);
        if let Ok(payload) = serde_json::to_value(index.status(root)) {
            sink.emit(ggs_index::symbols::index::SYMBOL_INDEX_EVENT, payload);
        }
        analysis.remove(root);
        if let Ok(payload) = serde_json::to_value(analysis.status(root)) {
            sink.emit(ggs_analysis::index::ANALYSIS_INDEX_EVENT, payload);
        }
        return;
    }
    index.apply_changes(Some(std::sync::Arc::clone(&sink)), root, change.paths.clone());
    analysis.apply_changes(Some(sink), root, change.paths.clone());
}

#[cfg(test)]
mod index_changes_tests {
    use super::*;
    use crate::watcher::FsChange;
    use ggs_base::sink::EventSink;
    use ggs_index::symbols::index::IndexState;
    use std::sync::{Arc, Mutex};

    #[derive(Default)]
    struct Recorded(Mutex<Vec<(String, serde_json::Value)>>);

    impl Clone for Recorded {
        fn clone(&self) -> Self {
            Recorded(Mutex::new(self.0.lock().unwrap().clone()))
        }
    }

    impl EventSink for Recorded {
        fn emit(&self, event: &str, payload: serde_json::Value) {
            self.0.lock().unwrap().push((event.to_owned(), payload));
        }
    }

    fn seeded(
        root_dir: &std::path::Path,
        home: &std::path::Path,
    ) -> (
        Arc<ggs_index::symbols::index::SymbolIndex>,
        Arc<ggs_analysis::index::AnalysisIndex>,
        String,
    ) {
        std::fs::write(root_dir.join("a.rs"), "fn alpha() { beta(); }\n").unwrap();
        std::fs::write(root_dir.join("b.rs"), "fn beta() {}\n").unwrap();
        let root = root_dir.display().to_string();
        let index = Arc::new(ggs_index::symbols::index::SymbolIndex::with_home(
            home.to_path_buf(),
        ));
        index.build_blocking(None, &root, None).unwrap();
        let analysis = Arc::new(ggs_analysis::index::AnalysisIndex::new());
        analysis.ensure_blocking(None, &root).unwrap();
        (index, analysis, root)
    }

    /// A truncated batch (>200 paths: a branch switch, a large checkout) must not leave the
    /// resident indexes stale: the store drops outright and the `Empty` status is announced,
    /// so the next Go-to-Definition resumes from disk and repairs the gap — instead of the
    /// old shape, where the batch was skipped outright and `ensure_blocking` early-returned
    /// on the resident store until the five-minute idle release.
    #[test]
    fn a_truncated_batch_drops_the_resident_indexes_and_announces_empty() {
        let dir = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let (index, _analysis, root) = seeded(dir.path(), home.path());
        let sink = Arc::new(Recorded::default());
        apply_index_changes(
            &index,
            &_analysis,
            std::sync::Arc::clone(&sink) as Arc<dyn EventSink>,
            &root,
            &FsChange {
                truncated: true,
                ..Default::default()
            },
        );
        assert_eq!(index.status(&root).state, IndexState::Empty);
        assert!(
            index.lookup(&root, "alpha").is_none(),
            "the stale store left memory"
        );
        let events = sink.0.lock().unwrap();
        let names: Vec<&str> = events.iter().map(|(name, _)| name.as_str()).collect();
        assert_eq!(
            names,
            [
                ggs_index::symbols::index::SYMBOL_INDEX_EVENT,
                ggs_analysis::index::ANALYSIS_INDEX_EVENT
            ]
        );
        assert!(events.iter().all(|(_, payload)| payload["state"] == "empty"));
        drop(events);
        // The next query resumes and repairs: the index is never stale for minutes.
        index.ensure_blocking(None, &root).unwrap();
        assert_eq!(index.lookup(&root, "alpha").unwrap().len(), 1);
    }

    /// A complete batch still updates the index file by file — the truncated branch is the
    /// only path that changed.
    #[test]
    fn a_complete_batch_updates_the_index_file_by_file() {
        let dir = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let (index, _analysis, root) = seeded(dir.path(), home.path());
        std::fs::write(dir.path().join("a.rs"), "fn alpha2() { beta(); }\n").unwrap();
        apply_index_changes(
            &index,
            &_analysis,
            Arc::new(Recorded::default()),
            &root,
            &FsChange {
                paths: vec!["a.rs".to_owned()],
                ..Default::default()
            },
        );
        // apply_changes is a background thread; wait for it to land.
        let mut landed = false;
        for _ in 0..100 {
            if index
                .lookup(&root, "alpha2")
                .is_some_and(|hits| !hits.is_empty())
            {
                landed = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert!(landed, "the watcher batch reached the index");
        assert_eq!(index.lookup(&root, "alpha").unwrap().len(), 0);
    }
}

fn start_watcher(
    app: &tauri::AppHandle,
    file_list: &std::sync::Arc<ggs_fs::FileListCache>,
    symbols: &std::sync::Arc<ggs_index::symbols::cache::SymbolCache>,
    index: &std::sync::Arc<ggs_index::symbols::index::SymbolIndex>,
    analysis: &std::sync::Arc<ggs_analysis::index::AnalysisIndex>,
    root: &str,
) -> Result<crate::watcher::FolderWatcher, String> {
    use tauri::Emitter;
    let app = app.clone();
    let file_list = file_list.clone();
    let symbols = symbols.clone();
    let index = std::sync::Arc::clone(index);
    let analysis = std::sync::Arc::clone(analysis);
    let watch_root = root.to_owned();
    let degrade_app = app.clone();
    crate::watcher::FolderWatcher::new(
        root,
        move |change| {
            // The caches are stale the moment anything changed; the next Quick Open / search /
            // Go to Definition re-walks. The webview decides what to refresh from the batch.
            file_list.invalidate();
            if change.paths.iter().any(|p| ggs_index::scan::is_symbol_source(p)) || change.truncated {
                symbols.invalidate();
            }
            let sink = std::sync::Arc::new(crate::events::TauriEvents(app.clone()));
            apply_index_changes(&index, &analysis, sink, &watch_root, &change);
            let _ = app.emit(FS_CHANGED_EVENT, change);
        },
        move |_| {
            // The watch died mid-life (a buffer overflow, the tree removed): the automatic
            // refreshes stop at exactly this moment, and the status bar's dot flips then.
            let _ = degrade_app.emit(
                WATCHER_STATUS_EVENT,
                watcher_reports(&FolderSwitch::from_app(&degrade_app)),
            );
        },
    )
}

#[cfg(test)]
mod open_folder_impl_tests {
use crate::test_git_helpers::ScratchGit;
    use super::*;

    /// Opening a subfolder of a repository resolves to the repository root - both in the
    /// answer the frontend applies and in the root `post_first_paint` will later start
    /// services for (a service started against the subfolder would watch the wrong tree).
    #[test]
    fn opening_a_repo_subfolder_resolves_and_records_the_repo_root() {
        let scratch = ggs_testkit::Scratch::new("open-folder-subdir");
        let git = scratch.repo("repo");
        let sub = git.repo.join("src");
        std::fs::create_dir_all(&sub).unwrap();
        let state = StateSet::default();
        let opened = tauri::async_runtime::block_on(open_folder_impl(
            &state.switch(),
            &sub.display().to_string(),
        ))
        .unwrap();
        let root = git.repo.display().to_string();
        assert!(opened.is_repo);
        assert_eq!(opened.root, root);
        assert_eq!(state.roots.list(), vec![root.clone()]);
        // The subfolder never reaches DeferredServices: the resolved root does, so
        // `post_first_paint` starts the watcher on the right tree.
        assert_eq!(state.deferred.take(), vec![root]);
    }

    /// A folder with no `.git` ancestor opens in place - no root resolution, still recorded
    /// for its background services (Quick Open and the symbol index work without git).
    #[test]
    fn opening_a_plain_folder_reports_no_repository_and_still_defers_its_services() {
        let scratch = ggs_testkit::Scratch::new("open-folder-plain");
        let plain = scratch.path("plain");
        std::fs::create_dir_all(&plain).unwrap();
        let state = StateSet::default();
        let opened = tauri::async_runtime::block_on(open_folder_impl(
            &state.switch(),
            &plain.display().to_string(),
        ))
        .unwrap();
        assert!(!opened.is_repo);
        assert_eq!(opened.root, plain.display().to_string());
        assert_eq!(
            state.deferred.take(),
            vec![plain.display().to_string()]
        );
    }

    /// A path that is not a folder at all (missing, or a file) is refused before anything in
    /// the app's state changes - a failed open must not clear the folder that is still open.
    #[test]
    fn opening_a_path_that_is_not_a_folder_leaves_the_open_state_untouched() {
        let scratch = ggs_testkit::Scratch::new("open-folder-missing");
        let state = StateSet::default();
        state.roots.set(vec!["C:\\already\\open".to_owned()]);
        state
            .deferred
            .record(vec!["C:\\already\\open".to_owned()]);
        let missing = scratch.path("does-not-exist");
        let result = tauri::async_runtime::block_on(open_folder_impl(
            &state.switch(),
            &missing.display().to_string(),
        ));
        assert!(result.is_err());
        assert_eq!(
            state.roots.list(),
            vec!["C:\\already\\open".to_owned()]
        );
        assert_eq!(
            state.deferred.take(),
            vec!["C:\\already\\open".to_owned()]
        );
    }

    /// A rapid reopen of a different folder replaces the previous one - both in `repos` and
    /// in the pending deferred-services record, so a superseded folder's watcher and index
    /// build never start against a root the app has already moved on from.
    #[test]
    fn reopening_a_different_folder_replaces_the_previous_one_everywhere() {
        let scratch = ggs_testkit::Scratch::new("open-folder-reopen");
        let first = scratch.repo("first");
        let second = scratch.repo("second");
        let state = StateSet::default();
        tauri::async_runtime::block_on(open_folder_impl(
            &state.switch(),
            &first.repo.display().to_string(),
        ))
        .unwrap();
        tauri::async_runtime::block_on(open_folder_impl(
            &state.switch(),
            &second.repo.display().to_string(),
        ))
        .unwrap();
        let second_root = second.repo.display().to_string();
        assert_eq!(state.roots.list(), vec![second_root.clone()]);
        assert_eq!(state.deferred.take(), vec![second_root]);
    }
}

/// One open root's background service: the file watcher, off the calling thread. Shared
/// by `post_first_paint` so the folder and workspace open paths start identical services.
/// The symbol and analysis indexes are NOT built here: a large tree's indexes are the
/// heaviest memory the app holds, so they load on the first query that needs them (the
/// command adapters' `ensure_*`) and `index_lease` releases them once idle.
fn start_root_services(app: &tauri::AppHandle, root: &str) {
    use tauri::{Emitter, Manager};
    let symbol_index = app
        .state::<std::sync::Arc<ggs_index::symbols::index::SymbolIndex>>()
        .inner()
        .clone();
    let analysis_index = app
        .state::<std::sync::Arc<ggs_analysis::index::AnalysisIndex>>()
        .inner()
        .clone();
    // External changes reach the webview through the watcher; a refused watch (an exotic
    // filesystem, too many watches) just means the command-driven refreshes carry on alone.
    let app = app.clone();
    let file_list = app
        .state::<std::sync::Arc<ggs_fs::FileListCache>>()
        .inner()
        .clone();
    let symbols = app
        .state::<std::sync::Arc<ggs_index::symbols::cache::SymbolCache>>()
        .inner()
        .clone();
    let index = symbol_index;
    let analysis = analysis_index;
    let watch_root = root.to_owned();
    std::thread::spawn(move || {
        // The status bar's dot rides every transition: the install's answer (running or
        // refused) is its flip away from starting, a degrade pushes its own.
        let emit_status = |app: &tauri::AppHandle| {
            let _ = app.emit(WATCHER_STATUS_EVENT, watcher_reports(&FolderSwitch::from_app(app)));
        };
        match start_watcher(&app, &file_list, &symbols, &index, &analysis, &watch_root) {
            Ok(watch) => {
                // Only the watcher of a root that is still open survives a rapid reopen;
                // installing it drops the previous root's watchers (their handles close).
                let switch = FolderSwitch::from_app(&app);
                if switch.roots.list().contains(&watch_root) {
                    switch.watchers.push(watch);
                    emit_status(&app);
                }
            }
            Err(error) => {
                eprintln!("[watcher] {error}");
                // A refusal for a root that was switched away while the install was in
                // flight records nothing: it would name a folder nobody has open.
                let switch = FolderSwitch::from_app(&app);
                if switch.roots.list().contains(&watch_root) {
                    switch.watchers.record_refusal(crate::watcher::WatcherStatus {
                        root: watch_root.clone(),
                        running: false,
                        error: Some(error),
                    });
                    emit_status(&app);
                }
            }
        }
    });
}

/// The shell's first frame with the newly opened folder has painted: start the background
/// service `open_folder` / `open_workspace` recorded (the file watcher), so its watch
/// scan never shares the CPU with that frame and the graph view's boot. Idempotent - a
/// no-op when nothing waits (every folder open is followed by one call, later ones only
/// after a reopen, when a fresh set was recorded).
#[tauri::command]
pub fn post_first_paint(app: tauri::AppHandle) {
    let roots = FolderSwitch::from_app(&app).deferred.take();
    for root in roots {
        start_root_services(&app, &root);
    }
}

/// One root of an opened `.ggs-workspace`: the folder's path, and whether it sits inside
/// (or is) a git repository - the graph and the SCM view key off that per root.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceRoot {
    root: String,
    is_repo: bool,
}

/// The result of opening a workspace file: its roots in file order.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedWorkspace {
    roots: Vec<WorkspaceRoot>,
}

/// A `.ggs-workspace` file, VS Code's `.code-workspace` shape: `{ "folders": [{ "path":
/// "./relative/or/absolute" }, ...] }` (extra keys ignored; JSON with comments allowed).
#[derive(serde::Deserialize)]
struct WorkspaceFile {
    #[serde(default)]
    folders: Vec<WorkspaceFolderEntry>,
}

#[derive(serde::Deserialize)]
struct WorkspaceFolderEntry {
    path: String,
}

/// Strip // and /* */ comments (outside strings, so a URL inside one survives) so a
/// commented workspace file still parses.
/// Open a `.ggs-workspace` file (File > Open Workspace...): every `folders[].path` entry
/// becomes an open root - relative paths resolve against the file's own folder, missing
/// folders are skipped (VS Code's behaviour), and an empty result is an error. A root is
/// NOT collapsed to its repository root, matching VS Code: a workspace folder can be a
/// subfolder of one repository, or sit beside one.
#[tauri::command]
pub async fn open_workspace(
    app: tauri::AppHandle,
    path: String,
) -> Result<OpenedWorkspace, String> {
    let folders = FolderSwitch::from_app(&app);
    let text = std::fs::read_to_string(&path).map_err(|e| format!("read {path}: {e}"))?;
    let parsed: WorkspaceFile =
        serde_json::from_str(&ggs_base::jsonc::strip(&text)).map_err(|e| format!("parse {path}: {e}"))?;
    let base = std::path::Path::new(&path)
        .parent()
        .map(std::path::Path::to_path_buf)
        .unwrap_or_default();
    let mut roots: Vec<WorkspaceRoot> = Vec::new();
    for entry in &parsed.folders {
        let raw = std::path::Path::new(&entry.path);
        let folder = if raw.is_absolute() {
            raw.to_path_buf()
        } else {
            base.join(raw)
        };
        if !folder.is_dir() {
            continue; // skipped, as VS Code skips a missing workspace folder
        }
        let root = folder
            .to_string_lossy()
            .trim_start_matches(r"\\?\")
            .to_owned();
        if roots.iter().any(|existing| existing.root == root) {
            continue;
        }
        roots.push(WorkspaceRoot {
            is_repo: find_repo_root(&root).is_some(),
            root,
        });
    }
    if roots.is_empty() {
        return Err(format!("{path} names no folder that exists"));
    }

    folders.reset();
    let root_paths: Vec<String> = roots.iter().map(|root| root.root.clone()).collect();
    folders.roots.set(root_paths.clone());
    folders.roots.set_workspace(Some(path.clone()));
    crate::ext_process::host().notify_workspace(&[]);
    crate::cmd_providers::apply_claude_integration(&[]);
    crate::remote_host::notify_folders(&root_paths);

    // The Quick Open prefetch stays on the open path (cheap, and the first Ctrl+P can come
    // at any moment); the watchers wait for the first painted frame,
    // exactly as in `open_folder` - see `post_first_paint`.
    for root in &roots {
        let prefetch_root = root.root.clone();
        let cache = folders.file_list_cache.clone();
        std::thread::spawn(move || {
            let files = ggs_fs::walk_files(&prefetch_root);
            cache.store(&prefetch_root, files);
        });
    }
    folders
        .deferred
        .record(roots.iter().map(|root| root.root.clone()).collect());
    Ok(OpenedWorkspace { roots })
}

#[cfg(test)]
mod workspace_tests {
    use super::*;

    #[test]
    fn a_command_may_name_an_open_root_or_a_checkout_below_it_only() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("repo");
        let sub = root.join("vendor").join("dep");
        let plain = root.join("plain");
        std::fs::create_dir_all(sub.join(".git")).unwrap();
        std::fs::create_dir_all(&plain).unwrap();
        let roots = vec![root.to_string_lossy().into_owned()];
        let path = |p: &std::path::Path| p.to_string_lossy().into_owned();
        assert!(
            is_repo_below(&roots, &path(&sub)),
            "an initialised submodule"
        );
        assert!(
            !is_repo_below(&roots, &path(&plain)),
            "a plain folder inside the root"
        );
        assert!(
            !is_repo_below(&roots, &path(&root)),
            "the root itself is not below itself"
        );
        assert!(
            !is_repo_below(&roots, &path(&dir.path().join("elsewhere"))),
            "outside the root"
        );
        let dotted = root.join("vendor").join("..").join("vendor").join("dep");
        assert!(!is_repo_below(&roots, &path(&dotted)), "no .. segments");
        // Windows spells the root with backslashes; the same checkout named with forward
        // slashes (as the view may pass it back) still qualifies.
        assert!(is_repo_below(&roots, &path(&sub).replace('\\', "/")));
    }

    #[test]
    fn strip_jsonc_removes_line_and_block_comments() {
        assert_eq!(ggs_base::jsonc::strip("a // line\nb"), "a \nb");
        assert_eq!(ggs_base::jsonc::strip("a /* block */ b"), "a  b");
        // A string protects its slashes: URLs inside strings survive.
        assert_eq!(
            ggs_base::jsonc::strip(r#""see https://example.com""#),
            r#""see https://example.com""#
        );
        assert_eq!(ggs_base::jsonc::strip("no comments"), "no comments");
    }

    #[test]
    fn a_workspace_file_parses_its_folders_and_ignores_extra_keys() {
        let parsed: WorkspaceFile = serde_json::from_str(&ggs_base::jsonc::strip(
            "{ \"settings\": {}, \"folders\": [ {\"path\": \"./a\"}, {\"path\": \"b\"}, {\"name\": \"c\", \"path\": \"/abs/c\"} ] }",
        ))
        .unwrap();
        assert_eq!(
            parsed
                .folders
                .iter()
                .map(|f| f.path.as_str())
                .collect::<Vec<_>>(),
            ["./a", "b", "/abs/c"]
        );
        // A file without folders opens nothing (the command rejects that separately).
        let empty: WorkspaceFile = serde_json::from_str("{}").unwrap();
        assert!(empty.folders.is_empty());
    }
}

/// The launch form the frontend's boot decides on, in one round trip instead of three
/// serial `initial_*` asks: a `ggs <file>` launch's file, a comparison launch's actions,
/// or the folder argument's repository. At most one of the three is set (a file launch
/// and a comparison launch record no folder).
///
/// `opened` / `openedFor`: when the launch form can only open a folder (`ggs <folder>`,
/// no file, no comparison), the folder is opened right here - one IPC round trip fewer
/// on the boot's critical path, and the open happens during the splash instead of after
/// it. The frontend's own folder choice can differ (a launch of a `.ggs-workspace` file
/// opens it as a workspace through `workspace` below), so it applies this only when
/// `openedFor` matches the folder it picked, and re-opens the plain way otherwise.
///
/// `reloaded`: this window's page asked before - a webview reload, not a launch. The
/// state above is then what the window holds NOW (a multi-root workspace's first root
/// as `repo`), so the frontend lets the remembered folder win and nothing is opened
/// eagerly: opening that first root would collapse the workspace before the frontend
/// re-opens it.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootContext {
    file: Option<String>,
    actions: Vec<StartupAction>,
    repo: Option<String>,
    workspace: Option<String>,
    reloaded: bool,
    opened: Option<OpenedFolder>,
    opened_for: Option<String>,
    /// The window's CURRENT roots, each with its own `isRepo` — the restore set a
    /// frontend that did not open them itself applies (a remote session, whose
    /// `open_folder` the gate refuses; docs/remote-client-plan.md §3.3).
    roots: Vec<OpenedFolder>,
    /// The `.ggs-workspace` file the current roots came from, if any.
    workspace_file: Option<String>,
}

#[tauri::command]
pub async fn boot_context(app: tauri::AppHandle) -> Result<BootContext, String> {
    use tauri::Manager;
    // First thing, before the awaits: from here on the frontend has its launch context,
    // so a Finder "Open With" handoff must cross as the open-paths event instead of
    // seeding a context that was just read (see `handle_opened`).
    let launch = app.state::<LaunchState>();
    let reloaded = !launch.mark_boot_context_read();
    let file = launch.single_file();
    let actions = launch.startup_actions();
    let workspace = launch.startup_workspace();
    let repo = app.state::<WorkspaceRoots>().first();
    let roots: Vec<OpenedFolder> = app
        .state::<WorkspaceRoots>()
        .list()
        .into_iter()
        .map(|root| {
            let is_repo = find_repo_root(&root).is_some();
            OpenedFolder { is_repo, root }
        })
        .collect();
    let workspace_file = app.state::<WorkspaceRoots>().workspace();
    let (opened, opened_for) =
        if !reloaded && file.is_none() && actions.is_empty() && workspace.is_none() {
            match repo.clone() {
                Some(folder) => (
                    open_folder_impl(&FolderSwitch::from_app(&app), &folder)
                        .await
                        .ok(),
                    Some(folder),
                ),
                None => (None, None),
            }
        } else {
            (None, None)
        };
    Ok(BootContext {
        file,
        actions,
        repo,
        workspace,
        reloaded,
        opened,
        opened_for,
        roots,
        workspace_file,
    })
}

/// Single-file mode (File > Open File...): show exactly this file - no folder, no
/// watcher, no repository views. The frontend hides the side bar and the terminal.
#[tauri::command]
pub fn open_single_file(app: tauri::AppHandle, path: String) -> Result<(), String> {
    use tauri::Manager;
    if !std::path::Path::new(&path).is_file() {
        return Err(format!("{path} is not a file"));
    }
    let folders = FolderSwitch::from_app(&app);
    folders.reset();
    folders.roots.clear();
    app.state::<LaunchState>().set_single_file(Some(path));
    crate::ext_process::host().notify_workspace(&[]);
    crate::cmd_providers::apply_claude_integration(&[]);
    crate::remote_host::notify_folders(&[]);
    Ok(())
}

/// Close the open folder (File > Close Folder).
#[tauri::command]
pub fn close_folder(app: tauri::AppHandle) {
    use tauri::Manager;
    let folders = FolderSwitch::from_app(&app);
    app.state::<LaunchState>().set_single_file(None);
    folders.reset();
    folders.roots.clear();
    crate::ext_process::host().notify_workspace(&[]);
    crate::cmd_providers::apply_claude_integration(&[]);
    crate::remote_host::notify_folders(&[]);
}
