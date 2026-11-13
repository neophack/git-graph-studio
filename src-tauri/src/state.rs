//! The app's own state types (the plan's §4.6): what remains of the retired `AppState`
//! god-struct, split per owner. The workspace roots live in `ggs_base::workspace`
//! (`WorkspaceRoots`); the file-list cache, symbol cache, search and transfer
//! generations, symbol index and analysis index live in their engine crates and are
//! `manage()`d directly; the three below are the app's own — the launch context the
//! boot reads, the folder watches, and the deferred-services record.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use crate::watcher::FolderWatcher;

/// One comparison a `ggs <subcommand>` launch opens in its window, serialised to the
/// frontend's boot (`initial_actions`): the same tabs the Explorer's "Compare Two
/// Files/Folders" menu opens, so the command line and the UI show one view.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum StartupAction {
    /// A text diff of two files on disk (a binary pair opens the hex comparison).
    CompareFiles { left: String, right: String },
    /// One file in the hex viewer.
    HexView { path: String },
    /// The address-aligned hex comparison of two files on disk, whatever their content.
    HexCompare { left: String, right: String },
    /// Two folders in the Folder Compare view.
    FolderCompare { left: String, right: String },
}

/// The launch context the boot reads once: the single-file mode a `ggs <file>` launch
/// opens, the comparisons a `ggs <subcommand>` launch opens, the workspace file a
/// `ggs <workspace>.ggs-workspace` launch opens, and whether the frontend has read
/// its context yet (the macOS Finder "Open With" handoff races that read).
#[derive(Default)]
pub struct LaunchState {
    /// Single-file mode (M3: `git-graph-studio <file>`): the one file the window shows,
    /// with no folder open — no side bar, no terminal, no repository views.
    single_file: Mutex<Option<String>>,
    /// The comparisons a `ggs <subcommand> ...` launch opens, applied by the
    /// frontend's boot after it read them once.
    startup_actions: Mutex<Vec<StartupAction>>,
    /// A `ggs <workspace>.ggs-workspace` launch: the workspace FILE the window opens as
    /// its multi-root workspace. A file (not a folder) — it must not fall into
    /// `single_file`, whose viewer would show the JSON instead of the workspace.
    startup_workspace: Mutex<Option<String>>,
    /// Whether the frontend has read its launch context (`boot_context`). Until it has,
    /// a macOS Finder "Open With" handoff still arrives in time to seed that very
    /// context; after it, handoffs cross as the `studio://open-paths` event instead.
    /// Set as the first thing `boot_context` does, before its awaits, so a handoff
    /// racing the boot can never take both roads.
    boot_context_served: AtomicBool,
}

impl LaunchState {
    pub fn single_file(&self) -> Option<String> {
        self.single_file.lock().unwrap().clone()
    }

    pub fn set_single_file(&self, path: Option<String>) {
        *self.single_file.lock().unwrap() = path;
    }

    /// The launch's comparisons, cloned (boot_context answers them without consuming:
    /// a reload asks again and must see the same window).
    pub fn startup_actions(&self) -> Vec<StartupAction> {
        self.startup_actions.lock().unwrap().clone()
    }

    pub fn push_startup_actions(&self, actions: Vec<StartupAction>) {
        self.startup_actions.lock().unwrap().extend(actions);
    }

    pub fn startup_workspace(&self) -> Option<String> {
        self.startup_workspace.lock().unwrap().clone()
    }

    pub fn set_startup_workspace(&self, path: Option<String>) {
        *self.startup_workspace.lock().unwrap() = path;
    }

    pub fn boot_context_served(&self) -> bool {
        self.boot_context_served.load(Ordering::SeqCst)
    }

    /// Mark the context read — the first thing `boot_context` does, before its awaits.
    /// Mark the context read and answer whether it ALREADY had been (swap semantics:
    /// a reload asks again and must be told so). Set as the first thing `boot_context`
    /// does, before its awaits.
    pub fn mark_boot_context_read(&self) -> bool {
        self.boot_context_served.swap(true, Ordering::SeqCst)
    }

    /// The alias `handle_opened` reads.
    pub fn boot_context_read(&self) -> bool {
        self.boot_context_served()
    }
}

/// The watches on the open folders; empty when no folder is open or the OS refused it.
/// One watcher per open root: a plain folder keeps one, a multi-root workspace one per
/// root.
/// The open roots' file watchers, plus the installs the OS refused. A refused install
/// never produces a `FolderWatcher`, so its refusal is recorded here to keep the status
/// bar's dot honest — that is the state where the automatic refreshes do not exist at all.
#[derive(Default)]
pub struct Watchers(Mutex<Vec<FolderWatcher>>, Mutex<Vec<crate::watcher::WatcherStatus>>);

impl Watchers {
    /// End every watch (a folder close, or the window before a new folder installs its
    /// own: a refused start_watcher, or a reopen racing the install, must not leave the
    /// old folder emitting `studio://fs-changed`). The refusals go with them: they name
    /// the closed folder's roots.
    pub fn clear(&self) {
        self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clear();
        self.1.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clear();
    }

    /// Install one root's watch. A refusal recorded earlier for the same root (the
    /// workspace reopened after the OS once refused the watch) is superseded by it.
    pub fn push(&self, watcher: FolderWatcher) {
        let root = watcher.status().root;
        self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).push(watcher);
        self.1
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .retain(|status| status.root != root);
    }

    /// Record one refused install (the OS answered the watch request with an error). A
    /// second record for the same root replaces the first — only the latest cause shows.
    pub fn record_refusal(&self, status: crate::watcher::WatcherStatus) {
        let mut refused = self.1.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        refused.retain(|entry| entry.root != status.root);
        refused.push(status);
    }

    /// Every watch's live status: the installed watchers' cells, then the refused
    /// installs. The status query folds this over the open roots.
    pub fn status(&self) -> Vec<crate::watcher::WatcherStatus> {
        let mut all: Vec<_> = self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .iter()
            .map(|watcher| watcher.status())
            .collect();
        all.extend(self.1.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).iter().cloned());
        all
    }
}

/// The open folders whose background service (the file watcher — the symbol and analysis
/// indexes load on first use instead) is recorded by `open_folder` / `open_workspace` but only started by
/// `post_first_paint`, once the shell calls it after its first frame with the new
/// folder has painted — so none of them competes with that frame for the CPU.
/// A plain struct (not raw state inline) so the record/take lifecycle — replace on
/// reopen, consume once, clear on close — is unit-testable without a Tauri app.
pub struct DeferredServices(Mutex<Vec<String>>);

impl DeferredServices {
    /// `open_folder` / `open_workspace` record their roots; a rapid reopen replaces the
    /// previous record, so a superseded folder's services can never start late.
    pub fn record(&self, roots: Vec<String>) {
        *self.0.lock().unwrap() = roots;
    }

    /// `post_first_paint` takes the recorded roots, leaving nothing pending: the call is
    /// idempotent, and only services recorded after it wait for the next one.
    pub fn take(&self) -> Vec<String> {
        std::mem::take(&mut *self.0.lock().unwrap())
    }

    /// Closing the folder (or switching to single-file mode) drops any pending roots.
    pub fn clear(&self) {
        self.0.lock().unwrap().clear();
    }
}

impl Default for DeferredServices {
    fn default() -> Self {
        DeferredServices(Mutex::new(Vec::new()))
    }
}

#[cfg(test)]
mod deferred_services_tests {
    use super::DeferredServices;

    #[test]
    fn a_reopen_replaces_the_pending_roots() {
        let pending = DeferredServices::default();
        pending.record(vec!["a".to_owned()]);
        pending.record(vec!["b".to_owned(), "c".to_owned()]);
        assert_eq!(pending.take(), vec!["b".to_owned(), "c".to_owned()]);
        // Consumed: a second first-paint starts nothing until the next open records again.
        assert!(pending.take().is_empty());
    }

    #[test]
    fn clear_drops_a_folder_that_never_reached_its_first_frame() {
        let pending = DeferredServices::default();
        pending.record(vec!["a".to_owned()]);
        pending.clear();
        assert!(pending.take().is_empty());
    }
}

#[cfg(test)]
mod watchers_tests {
    use super::Watchers;
    use crate::watcher::{FolderWatcher, WatcherStatus};

    fn refusal(root: &str, error: &str) -> WatcherStatus {
        WatcherStatus { root: root.to_owned(), running: false, error: Some(error.to_owned()) }
    }

    #[test]
    fn a_refusal_rides_until_the_same_root_installs_or_the_switch_clears() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().display().to_string();
        let watchers = Watchers::default();
        // The OS refused the watch: the refusal is all the status has, and it shows.
        watchers.record_refusal(refusal(&root, "too many watches"));
        let statuses = watchers.status();
        assert_eq!(statuses.len(), 1);
        assert!(!statuses[0].running);
        assert_eq!(statuses[0].error.as_deref(), Some("too many watches"));
        // The workspace reopened and this time the watch installed: it supersedes the
        // refusal, one entry per root.
        let watcher = FolderWatcher::new(&root, |_| {}, |_| {}).unwrap();
        assert!(watcher.status().running);
        watchers.push(watcher);
        let statuses = watchers.status();
        assert_eq!(statuses.len(), 1);
        assert!(statuses[0].running);
        assert_eq!(statuses[0].error, None);
        // A second refusal for the same root replaces the first (only the latest shows).
        watchers.record_refusal(refusal(&root, "first"));
        watchers.record_refusal(refusal(&root, "second"));
        let statuses = watchers.status();
        assert_eq!(statuses.len(), 2, "the installed watch and the refusal both list");
        // The folder switch drops everything, refusals included: they name closed roots.
        watchers.clear();
        assert!(watchers.status().is_empty());
    }
}

/// The borrowed bundle every folder-switch flow touches: the caches a switch
/// invalidates, the watches it ends, the deferred-services record it replaces. Built
/// from the managed pieces (`from_app`) by the lifecycle commands and from a
/// [`StateSet`] by the boot tests — the one place the split states meet, so no command
/// sees more than its own slice.
pub struct FolderSwitch<'a> {
    pub roots: &'a ggs_base::workspace::WorkspaceRoots,
    pub file_list_cache: &'a std::sync::Arc<ggs_fs::FileListCache>,
    pub symbol_cache: &'a std::sync::Arc<ggs_index::symbols::cache::SymbolCache>,
    pub search: &'a std::sync::Arc<ggs_index::search::SearchState>,
    pub symbol_index: &'a std::sync::Arc<ggs_index::symbols::index::SymbolIndex>,
    pub analysis_index: &'a std::sync::Arc<ggs_analysis::index::AnalysisIndex>,
    pub watchers: &'a Watchers,
    pub deferred: &'a DeferredServices,
}

impl FolderSwitch<'_> {
    /// Fetch every managed piece off the app (the lifecycle commands' one assembly).
    pub fn from_app(app: &tauri::AppHandle) -> FolderSwitch<'_> {
        use tauri::Manager;
        FolderSwitch {
            roots: app.state::<ggs_base::workspace::WorkspaceRoots>().inner(),
            file_list_cache: app
                .state::<std::sync::Arc<ggs_fs::FileListCache>>()
                .inner(),
            symbol_cache: app
                .state::<std::sync::Arc<ggs_index::symbols::cache::SymbolCache>>()
                .inner(),
            search: app.state::<std::sync::Arc<ggs_index::search::SearchState>>().inner(),
            symbol_index: app
                .state::<std::sync::Arc<ggs_index::symbols::index::SymbolIndex>>()
                .inner(),
            analysis_index: app
                .state::<std::sync::Arc<ggs_analysis::index::AnalysisIndex>>()
                .inner(),
            watchers: app.state::<Watchers>().inner(),
            deferred: app.state::<DeferredServices>().inner(),
        }
    }

    /// The reset every folder switch runs: the caches go stale, the running search and
    /// the index builds cancel, the resident indexes leave memory (the old folder's would
    /// otherwise stay behind the new one for the life of the process), the old folder's
    /// watches end (a refused start_watcher, or a reopen racing the install, must not
    /// leave the old folder emitting `studio://fs-changed`), and any pending deferred
    /// roots drop.
    pub fn reset(&self) {
        self.file_list_cache.invalidate();
        self.symbol_cache.invalidate();
        self.search.cancel();
        self.symbol_index.cancel();
        self.analysis_index.cancel();
        self.symbol_index.clear();
        self.analysis_index.clear();
        self.watchers.clear();
        self.deferred.clear();
    }
}

/// An owning set of the split states — what `run()` manages piece by piece and what
/// the boot tests construct standalone (`set.switch()` borrows the whole lifecycle
/// bundle).
#[derive(Default)]
pub struct StateSet {
    pub roots: ggs_base::workspace::WorkspaceRoots,
    pub launch: LaunchState,
    pub file_list_cache: std::sync::Arc<ggs_fs::FileListCache>,
    pub symbol_cache: std::sync::Arc<ggs_index::symbols::cache::SymbolCache>,
    pub search: std::sync::Arc<ggs_index::search::SearchState>,
    pub symbol_index: std::sync::Arc<ggs_index::symbols::index::SymbolIndex>,
    pub analysis_index: std::sync::Arc<ggs_analysis::index::AnalysisIndex>,
    pub watchers: Watchers,
    pub deferred: DeferredServices,
}

impl StateSet {
    pub fn switch(&self) -> FolderSwitch<'_> {
        FolderSwitch {
            roots: &self.roots,
            file_list_cache: &self.file_list_cache,
            symbol_cache: &self.symbol_cache,
            search: &self.search,
            symbol_index: &self.symbol_index,
            analysis_index: &self.analysis_index,
            watchers: &self.watchers,
            deferred: &self.deferred,
        }
    }
}
