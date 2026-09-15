//! Git Graph Studio: a standalone shell around the git-graph-rs engine.
//!
//! The read path goes straight to `git-graph-core` (the same in-process gix engine the VS Code
//! extension uses); the write path (branches, tags, stashes, merges, staging, commits, …)
//! shells out to the `git` executable, which is exactly what the extension's own CLI backend
//! does. The engine is linked into this binary — there is no backend process; the graph's
//! webview assets and its manifest are the app's own, and the extension store serves the
//! additional VSIX / `.ggx` extensions installed from the Extensions view.

//! The crate is a library plus one binary: `git-graph-studio` (the Tauri app, the `desktop`
//! feature). The modules that need no window — the engine seam `cmd_graph` and the git runner
//! `git` — are always compiled; everything that needs a window is behind `desktop`.

pub mod cmd_graph;
pub mod git;
#[cfg(test)]
pub mod test_support;

#[cfg(feature = "desktop")]
#[cfg(feature = "desktop")]
pub mod can_log;
#[cfg(feature = "desktop")]
pub mod cmd_ext;
#[cfg(feature = "desktop")]
pub mod cmd_assoc;
#[cfg(feature = "desktop")]
pub mod cmd_fs;
#[cfg(feature = "desktop")]
pub mod cmd_fuzzy;
#[cfg(feature = "desktop")]
pub mod cmd_scm;
#[cfg(feature = "desktop")]
pub mod cmd_search;
#[cfg(feature = "desktop")]
pub mod encoding;
#[cfg(feature = "desktop")]
pub mod measure;
#[cfg(feature = "desktop")]
pub mod pty;
#[cfg(feature = "desktop")]
pub mod scm_ops;
#[cfg(all(test, feature = "desktop"))]
mod stage_bench;
#[cfg(feature = "desktop")]
pub mod viewer;
#[cfg(feature = "desktop")]
pub mod watcher;

#[cfg(feature = "desktop")]
pub use desktop::{run, AppState};

#[cfg(feature = "desktop")]
mod desktop {
    use crate::{can_log, cmd_assoc, cmd_ext, cmd_fs, cmd_fuzzy, cmd_graph, cmd_scm, cmd_search, cmd_symbols, git, mcp, measure, pty, viewer, watcher};
    #[allow(unused_imports)]
    use cmd_graph as _cmd_graph_seam;

    use std::sync::{Arc, Mutex};

    /// The folders the app has open. The standalone shell works with one folder at a time, but the
    /// Git Graph view was built around a repo set, so the state stays a list.
    pub struct AppState {
        pub repos: Mutex<Vec<String>>,
        /// Single-file mode (M3: `git-graph-studio <file>`): the one file the window shows,
        /// with no folder open - no side bar, no terminal, no repository views.
        pub single_file: Mutex<Option<String>>,
        /// Quick Open's file list, cached so repeat opens skip the tree walk (cmd_fs). The Arc
        /// lets the open-folder prefetch thread fill it without borrowing the Tauri state.
        pub file_list_cache: std::sync::Arc<cmd_fs::FileListCache>,
        /// The workspace symbol index, cached per folder (cmd_search). Shared with the watcher
        /// thread, which drops it when a source file changes.
        pub symbol_cache: Arc<cmd_search::SymbolCache>,
        /// The running search's generation, for cancellation (cmd_search).
        pub search: Arc<cmd_search::SearchState>,
        /// The watch on the open folder; `None` when no folder is open or the OS refused it.
        /// One watcher per open root: a plain folder keeps one, a multi-root workspace one per root.
        pub watcher: Mutex<Vec<watcher::FolderWatcher>>,
    }

    impl AppState {
        fn new() -> Self {
            AppState {
                repos: Mutex::new(Vec::new()),
                single_file: Mutex::new(None),
                file_list_cache: Arc::new(cmd_fs::FileListCache::default()),
                symbol_cache: Arc::new(cmd_search::SymbolCache::default()),
                search: Arc::new(cmd_search::SearchState::default()),
                watcher: Mutex::new(Vec::new()),
            }
        }

        pub fn first_repo(&self) -> Option<String> {
            self.repos.lock().unwrap().first().cloned()
        }

        /// The repository a Source Control command acts on: the open repository when the
        /// view names none, otherwise the named one - which must be an open root or a
        /// checkout below one (a submodule the view lists as its own section). Anything
        /// else is refused: the frontend never gets to run git in an arbitrary folder.
        pub fn resolve_repo(&self, repo: Option<String>) -> Result<String, String> {
            let repos = self.repos.lock().unwrap();
            let Some(repo) = repo else {
                return repos
                    .first()
                    .cloned()
                    .ok_or_else(|| "No repository is open".to_string());
            };
            if repos.contains(&repo) {
                return Ok(repo);
            }
            if is_repo_below(&repos, &repo) {
                return Ok(repo);
            }
            Err(format!("{repo} is not a repository of the open folder"))
        }
    }

    /// Whether `path` is a git checkout (a `.git` directory or file) strictly inside one of
    /// `roots`, spelled without `..` segments - the shape a submodule root takes.
    pub fn is_repo_below(roots: &[String], path: &str) -> bool {
        use std::path::{Component, Path};
        let candidate = Path::new(path);
        if candidate
            .components()
            .any(|c| matches!(c, Component::ParentDir | Component::CurDir))
        {
            return false;
        }
        let normalised = |p: &str| p.replace('\\', "/").trim_end_matches('/').to_lowercase();
        let wanted = normalised(path);
        roots.iter().any(|root| {
            let root = normalised(root);
            wanted.len() > root.len() + 1
                && wanted.starts_with(&root)
                && wanted.as_bytes()[root.len()] == b'/'
        }) && candidate.join(".git").exists()
    }

    /// What `open_folder` answers: the folder actually opened, and whether it is (or sits
    /// inside) a Git repository — the shell's "Initialize Repository" affordances key on the
    /// latter.
    #[derive(serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    struct OpenedFolder {
        root: String,
        is_repo: bool,
    }

    /// Open a folder. A git repository resolves to its root (the graph, the SCM view and the
    /// terminal all key off it); any other folder still opens — the explorer and the editor work
    /// without git, and the git-backed views offer to initialise a repository instead.
    #[tauri::command]
    async fn open_folder(
        app: tauri::AppHandle,
        state: tauri::State<'_, AppState>,
        path: String,
    ) -> Result<OpenedFolder, String> {
        if !std::path::Path::new(&path).is_dir() {
            return Err(format!("{path} is not a folder"));
        }
        // The repository root is found on the file system here (the nearest ancestor holding a
        // `.git`), not asked of the engine: opening a folder must never wait for the engine's
        // warm-up, which may still be running on a fresh launch.
        let found_root = find_repo_root(&path);
        let root = found_root.clone().unwrap_or(path);
        let opened = OpenedFolder { is_repo: found_root.is_some(), root: root.clone() };
        // Reopening the repository that is already open (the launch argument being re-opened by
        // the frontend's boot) keeps the engine's warm handle and the backend's caches: closing
        // them here would throw away exactly the work the boot-time warm-up did.
        let already_open = state
            .repos
            .lock()
            .unwrap()
            .first()
            .is_some_and(|open| *open == root);
        state.file_list_cache.invalidate();
        state.symbol_cache.invalidate();
        state.search.cancel();
        // The previous folder's watch ends here, like in open_workspace / close_folder —
        // not when the new one installs below: a refused start_watcher, or a reopen racing
        // the install, must not leave the old folder emitting studio://fs-changed.
        state.watcher.lock().unwrap().clear();
        {
            let mut repos = state.repos.lock().unwrap();
            repos.clear();
            repos.push(root.clone());
        }
        if !already_open {
            cmd_graph::close_engine_repos();
        }
        // Warm Quick Open's file list in the background: by the time the user hits Ctrl+P the
        // walk has usually finished and the picker opens on a cache hit.
        let prefetch_root = root.clone();
        let cache = state.file_list_cache.clone();
        std::thread::spawn(move || {
            let files = cmd_fs::walk_files(&prefetch_root);
            cache.store(&prefetch_root, files);
        });
        // External changes reach the webview through the watcher; a refused watch (an exotic
        // filesystem, too many watches) just means the command-driven refreshes carry on alone.
        // Starting it costs filesystem work that must not sit on the open path — the graph and
        // the SCM view load while it comes up.
        {
            let app = app.clone();
            let file_list = state.file_list_cache.clone();
            let symbols = state.symbol_cache.clone();
            let watch_root = root.clone();
            std::thread::spawn(move || {
                match start_watcher(&app, &file_list, &symbols, &watch_root) {
                    Ok(watch) => {
                        use tauri::Manager;
                        // Only the watcher of the folder that is still open survives a rapid reopen;
                        // installing it drops the previous folder's watchers (their handles close).
                        let state = app.state::<AppState>();
                        let still_open = state
                            .repos
                            .lock()
                            .unwrap()
                            .first()
                            .is_some_and(|open| *open == watch_root);
                        if still_open {
                            *state.watcher.lock().unwrap() = vec![watch];
                        }
                    }
                    Err(error) => eprintln!("[watcher] {error}"),
                }
            });
        }
        Ok(opened)
    }

    /// The nearest ancestor of `path` (itself included) that holds a `.git` directory or file (a
    /// worktree / submodule checkout): what `git rev-parse --show-toplevel` answers, without git.
    pub fn find_repo_root(path: &str) -> Option<String> {
        let mut current = Some(std::path::Path::new(path));
        while let Some(dir) = current {
            if dir.join(".git").exists() {
                return Some(dir.to_string_lossy().trim_start_matches(r"\\?\").to_owned());
            }
            current = dir.parent();
        }
        None
    }

    /// The event the frontend listens to for external file changes; its payload is a `FsChange`.
    const FS_CHANGED_EVENT: &str = "studio://fs-changed";

    fn start_watcher(
        app: &tauri::AppHandle,
        file_list: &std::sync::Arc<cmd_fs::FileListCache>,
        symbols: &std::sync::Arc<cmd_search::SymbolCache>,
        root: &str,
    ) -> Result<watcher::FolderWatcher, String> {
        use tauri::Emitter;
        let app = app.clone();
        let file_list = file_list.clone();
        let symbols = symbols.clone();
        watcher::FolderWatcher::new(root, move |change| {
            // The caches are stale the moment anything changed; the next Quick Open / search /
            // Go to Definition re-walks. The webview decides what to refresh from the batch.
            file_list.invalidate();
            if change.paths.iter().any(|p| cmd_search::is_symbol_source(p)) || change.truncated {
                symbols.invalidate();
            }
            let _ = app.emit(FS_CHANGED_EVENT, change);
        })
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
    struct OpenedWorkspace {
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
    fn strip_jsonc(text: &str) -> String {
        // Kept ranges of the original string are emitted as slices, so multibyte characters
        // pass through untouched - only ASCII comment bytes are ever skipped.
        let bytes = text.as_bytes();
        let mut kept: Vec<&str> = Vec::new();
        let mut segment = 0;
        let mut at = 0;
        let mut in_string = false;
        while at < bytes.len() {
            let byte = bytes[at];
            if in_string {
                if byte == b'\\' && at + 1 < bytes.len() {
                    at += 2;
                    continue;
                }
                if byte == b'"' {
                    in_string = false;
                }
                at += 1;
            } else if byte == b'"' {
                in_string = true;
                at += 1;
            } else if byte == b'/' && bytes.get(at + 1) == Some(&b'/') {
                kept.push(&text[segment..at]);
                while at < bytes.len() && bytes[at] != b'\n' {
                    at += 1;
                }
                segment = at;
            } else if byte == b'/' && bytes.get(at + 1) == Some(&b'*') {
                kept.push(&text[segment..at]);
                at += 2;
                while at + 1 < bytes.len() && !(bytes[at] == b'*' && bytes[at + 1] == b'/') {
                    at += 1;
                }
                at = (at + 2).min(bytes.len());
                segment = at;
            } else {
                at += 1;
            }
        }
        kept.push(&text[segment..]);
        kept.concat()
    }

    /// Open a `.ggs-workspace` file (File > Open Workspace...): every `folders[].path` entry
    /// becomes an open root - relative paths resolve against the file's own folder, missing
    /// folders are skipped (VS Code's behaviour), and an empty result is an error. A root is
    /// NOT collapsed to its repository root, matching VS Code: a workspace folder can be a
    /// subfolder of one repository, or sit beside one.
    #[tauri::command]
    async fn open_workspace(
        app: tauri::AppHandle,
        state: tauri::State<'_, AppState>,
        path: String,
    ) -> Result<OpenedWorkspace, String> {
        let text = std::fs::read_to_string(&path).map_err(|e| format!("read {path}: {e}"))?;
        let parsed: WorkspaceFile = serde_json::from_str(&strip_jsonc(&text))
            .map_err(|e| format!("parse {path}: {e}"))?;
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
            let root = folder.to_string_lossy().trim_start_matches(r"\\?\").to_owned();
            if roots.iter().any(|existing| existing.root == root) {
                continue;
            }
            roots.push(WorkspaceRoot { is_repo: find_repo_root(&root).is_some(), root });
        }
        if roots.is_empty() {
            return Err(format!("{path} names no folder that exists"));
        }

        state.file_list_cache.invalidate();
        state.symbol_cache.invalidate();
        state.search.cancel();
        state.watcher.lock().unwrap().clear();
        *state.repos.lock().unwrap() = roots.iter().map(|root| root.root.clone()).collect();
        cmd_graph::close_engine_repos();

        // Per root: the Quick Open prefetch and the watcher, both off the open path.
        for root in &roots {
            let prefetch_root = root.root.clone();
            let cache = state.file_list_cache.clone();
            std::thread::spawn(move || {
                let files = cmd_fs::walk_files(&prefetch_root);
                cache.store(&prefetch_root, files);
            });
            let app = app.clone();
            let file_list = state.file_list_cache.clone();
            let symbols = state.symbol_cache.clone();
            let watch_root = root.root.clone();
            std::thread::spawn(move || {
                match start_watcher(&app, &file_list, &symbols, &watch_root) {
                    Ok(watch) => {
                        use tauri::Manager;
                        let state = app.state::<AppState>();
                        if state.repos.lock().unwrap().contains(&watch_root) {
                            state.watcher.lock().unwrap().push(watch);
                        }
                    }
                    Err(error) => eprintln!("[watcher] {error}"),
                }
            });
        }
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
            assert!(is_repo_below(&roots, &path(&sub)), "an initialised submodule");
            assert!(!is_repo_below(&roots, &path(&plain)), "a plain folder inside the root");
            assert!(!is_repo_below(&roots, &path(&root)), "the root itself is not below itself");
            assert!(!is_repo_below(&roots, &path(&dir.path().join("elsewhere"))), "outside the root");
            let dotted = root.join("vendor").join("..").join("vendor").join("dep");
            assert!(!is_repo_below(&roots, &path(&dotted)), "no .. segments");
            // Windows spells the root with backslashes; the same checkout named with forward
            // slashes (as the view may pass it back) still qualifies.
            assert!(is_repo_below(&roots, &path(&sub).replace('\\', "/")));
        }

        #[test]
        fn strip_jsonc_removes_line_and_block_comments() {
            assert_eq!(strip_jsonc("a // line\nb"), "a \nb");
            assert_eq!(strip_jsonc("a /* block */ b"), "a  b");
            // A string protects its slashes: URLs inside strings survive.
            assert_eq!(strip_jsonc(r#""see https://example.com""#), r#""see https://example.com""#);
            assert_eq!(strip_jsonc("no comments"), "no comments");
        }

        #[test]
        fn a_workspace_file_parses_its_folders_and_ignores_extra_keys() {
            let parsed: WorkspaceFile = serde_json::from_str(&strip_jsonc(
                "{ \"settings\": {}, \"folders\": [ {\"path\": \"./a\"}, {\"path\": \"b\"}, {\"name\": \"c\", \"path\": \"/abs/c\"} ] }",
            ))
            .unwrap();
            assert_eq!(parsed.folders.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), ["./a", "b", "/abs/c"]);
            // A file without folders opens nothing (the command rejects that separately).
            let empty: WorkspaceFile = serde_json::from_str("{}").unwrap();
            assert!(empty.folders.is_empty());
        }
    }

    /// The user-level `settings.json` (~/.ggs/settings.json): the form writes it, and a hand
    /// edit of it wins on the next launch (M3 3.9's "edited both ways").
    fn settings_file() -> Result<std::path::PathBuf, String> {
        let home = std::env::var_os("HOME")
            .or_else(|| std::env::var_os("USERPROFILE"))
            .map(std::path::PathBuf::from)
            .ok_or_else(|| "no user home directory".to_string())?;
        Ok(home.join(".ggs").join("settings.json"))
    }

    #[tauri::command]
    fn settings_read() -> Result<Option<String>, String> {
        Ok(std::fs::read_to_string(settings_file()?).ok())
    }

    /// The user's `keybindings.json` (~/.ggs/keybindings.json), same read/write pair.
    fn keybindings_file() -> Result<std::path::PathBuf, String> {
        settings_file().map(|path| path.with_file_name("keybindings.json"))
    }

    #[tauri::command]
    fn keybindings_read() -> Result<Option<String>, String> {
        Ok(std::fs::read_to_string(keybindings_file()?).ok())
    }

    #[tauri::command]
    fn keybindings_write(contents: String) -> Result<(), String> {
        let path = keybindings_file()?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
        }
        std::fs::write(&path, contents).map_err(|e| format!("write {}: {e}", path.display()))
    }

    #[tauri::command]
    fn settings_write(contents: String) -> Result<(), String> {
        let path = settings_file()?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
        }
        std::fs::write(&path, contents).map_err(|e| format!("write {}: {e}", path.display()))
    }

    /// The file a `git-graph-studio <file>` launch should show (single-file mode).
    #[tauri::command]
    fn initial_file(state: tauri::State<AppState>) -> Option<String> {
        state.single_file.lock().unwrap().clone()
    }

    /// Single-file mode (File > Open File...): show exactly this file - no folder, no
    /// watcher, no repository views. The frontend hides the side bar and the terminal.
    #[tauri::command]
    fn open_single_file(state: tauri::State<AppState>, path: String) -> Result<(), String> {
        if !std::path::Path::new(&path).is_file() {
            return Err(format!("{path} is not a file"));
        }
        state.watcher.lock().unwrap().clear();
        state.search.cancel();
        state.file_list_cache.invalidate();
        state.symbol_cache.invalidate();
        state.repos.lock().unwrap().clear();
        *state.single_file.lock().unwrap() = Some(path);
        cmd_graph::close_engine_repos();
        Ok(())
    }

    /// Close the open folder (File > Close Folder).
    #[tauri::command]
    fn close_folder(state: tauri::State<AppState>) {
        *state.single_file.lock().unwrap() = None;
        state.watcher.lock().unwrap().clear();
        state.search.cancel();
        state.file_list_cache.invalidate();
        state.symbol_cache.invalidate();
        state.repos.lock().unwrap().clear();
        cmd_graph::close_engine_repos();
    }

    /// Process-start stamp, so boot timings from the frontend are printed against the same clock.
    static BOOT: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();

    fn boot_started() -> std::time::Instant {
        *BOOT.get_or_init(std::time::Instant::now)
    }

    /// One backend boot stamp, in the line format `scripts/boot-bench.mjs` parses:
    /// `[boot] <stage>: +<ms> ms since process start`.
    fn stamp(stage: &str) {
        println!(
            "[boot] {stage}: +{:.0} ms since process start",
            boot_started().elapsed().as_secs_f64() * 1000.0
        );
    }

    #[tauri::command]
    fn boot_stage(stage: String, page_ms: f64) {
        let line = format!(
            "[boot] {stage}: +{:.0} ms since process start (page: {:.0} ms)\n",
            boot_started().elapsed().as_secs_f64() * 1000.0,
            page_ms
        );
        print!("{line}");
        let _ = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(std::env::temp_dir().join("git-graph-studio-boot.log"))
            .and_then(|mut file| std::io::Write::write_all(&mut file, line.as_bytes()));
    }

    /// Lets the webview keep the app's assets between launches. Tauri serves every asset
    /// from the binary with no caching headers, so each launch fetches, parses and compiles
    /// the workbench, CodeMirror and the graph view's bundle afresh. With `no-cache` plus a
    /// content ETag, every request still reaches this handler (an in-process round trip),
    /// but an unchanged asset is answered 304 without its body: the browser reuses its
    /// copy and, for a script, the bytecode it compiled from it on an earlier launch. An
    /// upgraded asset changes its ETag and is fetched whole, so nothing stale ever runs.
    fn revalidate_assets(
        request: tauri::http::Request<Vec<u8>>,
        response: &mut tauri::http::Response<std::borrow::Cow<'static, [u8]>>,
    ) {
        use std::hash::{Hash, Hasher};
        use tauri::http::{header, StatusCode};
        if response.status() != StatusCode::OK {
            return;
        }
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        response.body().hash(&mut hasher);
        let etag = format!("\"{:016x}\"", hasher.finish());
        let unchanged = request
            .headers()
            .get(header::IF_NONE_MATCH)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.split(',').any(|tag| tag.trim() == etag));
        let headers = response.headers_mut();
        headers.insert(header::CACHE_CONTROL, header::HeaderValue::from_static("no-cache"));
        if let Ok(value) = header::HeaderValue::from_str(&etag) {
            headers.insert(header::ETAG, value);
        }
        if unchanged {
            *response.status_mut() = StatusCode::NOT_MODIFIED;
            *response.body_mut() = std::borrow::Cow::Borrowed(&[]);
        }
    }

    #[cfg(test)]
    mod asset_cache_tests {
        use super::*;
        use std::borrow::Cow;
        use tauri::http::{header, Request, Response, StatusCode};

        fn asset(body: &'static [u8]) -> Response<Cow<'static, [u8]>> {
            Response::builder().status(200).body(Cow::Borrowed(body)).unwrap()
        }

        #[test]
        fn an_unchanged_asset_is_answered_304_and_a_changed_one_whole() {
            let body: &[u8] = b"console.log('workbench')";
            let mut first = asset(body);
            revalidate_assets(Request::builder().body(Vec::new()).unwrap(), &mut first);
            assert_eq!(first.status(), StatusCode::OK);
            assert_eq!(first.headers()[header::CACHE_CONTROL], "no-cache");
            let etag = first.headers()[header::ETAG].to_str().unwrap().to_owned();
            assert!(etag.starts_with('"') && etag.ends_with('"'));

            let revalidate = || Request::builder().header(header::IF_NONE_MATCH, &etag).body(Vec::new()).unwrap();
            let mut same = asset(body);
            revalidate_assets(revalidate(), &mut same);
            assert_eq!(same.status(), StatusCode::NOT_MODIFIED);
            assert!(same.body().is_empty());

            let mut changed = asset(b"console.log('workbench v2')");
            revalidate_assets(revalidate(), &mut changed);
            assert_eq!(changed.status(), StatusCode::OK);
            assert_ne!(changed.headers()[header::ETAG], etag.as_str());
            assert!(!changed.body().is_empty());

            // An error response is left alone.
            let mut missing = Response::builder().status(404).body(Cow::Borrowed(&b""[..])).unwrap();
            revalidate_assets(revalidate(), &mut missing);
            assert!(missing.headers().get(header::ETAG).is_none());
        }
    }

    /// WebKitGTK's DMABUF renderer fails on machines whose X server runs on the
    /// NVIDIA proprietary driver: GBM falls back from the broken EGL-GBM image
    /// allocation to KMS dumb buffers, which a render node cannot create
    /// (EACCES), leaving the window black. Disable DMABUF there — but only
    /// there, and only when the user has not chosen a renderer themselves via
    /// `WEBKIT_DISABLE_DMABUF_RENDERER` or an EGL vendor override.
    /// WebKitGTK's DMABUF renderer fails on machines whose X server runs on the
    /// NVIDIA proprietary driver: GBM falls back from the broken EGL-GBM image
    /// allocation to KMS dumb buffers, which a render node cannot create
    /// (EACCES), leaving the window black. Like RustDesk's
    /// `allow-always-software-render` option, the behaviour is driven by a user
    /// setting (`linuxDmabuf` in `~/.ggs/settings.json`, taking effect on the
    /// next launch): `auto` disables DMABUF only when the NVIDIA driver is
    /// detected, `disable` always disables it, `keep` never touches it. An
    /// environment variable set by the user always wins over everything.
    #[cfg(target_os = "linux")]
    fn apply_webkit_compat() {
        if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_some()
            || std::env::var_os("EGL_VENDOR_LIBRARY_FILENAMES").is_some()
        {
            return;
        }
        let settings_text = std::fs::read_to_string(settings_file().unwrap_or_default()).ok();
        let mode = linux_dmabuf_mode(settings_text.as_deref());
        let nvidia = std::path::Path::new("/proc/driver/nvidia/version").exists();
        if should_disable_dmabuf(&mode, nvidia) {
            // Must run before the webview picks its renderer; we are first in
            // `run`, so no threads have spawned yet.
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        }
    }

    #[cfg(not(target_os = "linux"))]
    fn apply_webkit_compat() {}

    /// The `linuxDmabuf` setting as written by the Settings form; anything the
    /// form does not produce (missing file, bad JSON, unknown value) is `auto`.
    #[cfg(target_os = "linux")]
    fn linux_dmabuf_mode(settings: Option<&str>) -> String {
        settings
            .and_then(|text| serde_json::from_str::<serde_json::Value>(text).ok())
            .and_then(|value| value.get("linuxDmabuf").and_then(serde_json::Value::as_str).map(str::to_owned))
            .unwrap_or_else(|| "auto".to_owned())
    }

    /// `auto` disables DMABUF only on NVIDIA-driver machines; `disable` always;
    /// `keep` (and any unknown value) never.
    #[cfg(target_os = "linux")]
    fn should_disable_dmabuf(mode: &str, nvidia_driver: bool) -> bool {
        match mode {
            "disable" => true,
            "auto" => nvidia_driver,
            _ => false,
        }
    }

    #[cfg(all(test, target_os = "linux"))]
    mod webkit_compat_tests {
        use super::{linux_dmabuf_mode, should_disable_dmabuf};

        #[test]
        fn mode_falls_back_to_auto() {
            assert_eq!(linux_dmabuf_mode(None), "auto");
            assert_eq!(linux_dmabuf_mode(Some("not json")), "auto");
            assert_eq!(linux_dmabuf_mode(Some("{}")), "auto");
            assert_eq!(linux_dmabuf_mode(Some(r#"{"linuxDmabuf":"disable"}"#)), "disable");
            assert_eq!(linux_dmabuf_mode(Some(r#"{"linuxDmabuf":42}"#)), "auto");
        }

        #[test]
        fn auto_disables_only_on_nvidia() {
            assert!(should_disable_dmabuf("auto", true));
            assert!(!should_disable_dmabuf("auto", false));
            assert!(should_disable_dmabuf("disable", false));
            assert!(!should_disable_dmabuf("keep", true));
        }
    }

    /// The app's entry point (`main.rs` is a one-line stub around it).
    pub fn run() {
        apply_webkit_compat();
        let _boot = boot_started();
        // `git-graph-studio --measure <folder>` runs the performance probes headless and prints
        // JSON (scripts/measure.mjs folds it into metrics.json); no window is created.
        let args: Vec<String> = std::env::args().collect();
        if args.get(1).map(String::as_str) == Some("--measure") {
            let folder = args.get(2).cloned().unwrap_or_else(|| ".".to_owned());
            match measure::run(&folder) {
                Ok(json) => {
                    println!("{json}");
                    std::process::exit(0);
                }
                Err(error) => {
                    eprintln!("{error}");
                    std::process::exit(1);
                }
            }
        }
        // `git-graph-studio <folder>` opens that folder (a repository resolves to its root).
        let state = AppState::new();
        if let Some(arg) = std::env::args().nth(1) {
            let path = std::path::Path::new(&arg);
            // A plain file opens in single-file mode: the window shows just that file, with
            // no folder wiring at all.
            if path.is_file() {
                let absolute = std::fs::canonicalize(path)
                    .map(|p| p.display().to_string().trim_start_matches(r"\\?\").to_owned())
                    .unwrap_or_else(|_| arg.clone());
                // The file's document (read, decode, rope, outline, the syntax set) builds
                // now, while the window and the webview come up: the page's `viewer_open`
                // then takes it ready-made. A small file never reaches the viewer, so its
                // prewarm is wasted but cheap; a binary file is skipped by the probe.
                viewer::prewarm(absolute.clone());
                *state.single_file.lock().unwrap() = Some(absolute);
            }
            if path.is_dir() {
                let absolute = std::fs::canonicalize(path)
                    .map(|p| {
                        // Windows' canonical form is the \\?\ prefixed one; the app shows paths.
                        p.display()
                            .to_string()
                            .trim_start_matches(r"\\?\")
                            .to_owned()
                    })
                    .unwrap_or(arg);
                // The frontend's boot re-opens this path through `open_folder`, which resolves
                // the repository root once the backend is up.
                state.repos.lock().unwrap().push(absolute);
            }
        }

        stamp("main: args parsed");

        // The engine warms the launch repository before the window exists: opening the
        // repository and answering the view's two first requests (the repository info and
        // the first page of commits) costs around a tenth of a second, and the window takes
        // the better part of one to appear — so those requests are answered from the
        // warm-up's results, and every later one lands on a hot repository handle.
        if let Some(root) = state
            .repos
            .lock()
            .unwrap()
            .first()
            .map(|folder| find_repo_root(folder).unwrap_or_else(|| folder.clone()))
        {
            std::thread::spawn(move || match cmd_graph::warm_first_page(&root) {
                Ok(count) => stamp(&format!("engine ready: first page warmed ({count} commits)")),
                Err(error) => eprintln!("[boot] engine warm-up failed: {error}"),
            });
            // The first file opened in a folder (a restored session's, or the user's first
            // click) builds a viewer document for its outline, and that needs the syntax
            // set - a deserialisation worth a good fraction of a second, best paid now on
            // a spare core rather than on that first open.
            std::thread::spawn(|| {
                viewer::doc::syntax_set();
                stamp("syntax set ready");
            });
        }

        stamp("builder: run");
        tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(state)
        .manage(Mutex::new(pty::PtyState::default()))
        .manage(viewer::ViewerState::default())
        .manage(can_log::CanLogState::default())
        .setup(|app| {
            // Git's output reaches the panel's "Git" channel as it happens.
            use tauri::Emitter;
            let handle = app.handle().clone();
            git::set_log_emitter(move |line| {
                let _ = handle.emit("studio://git-output", line);
            });
            stamp("setup entered");
            // The main window is declared in tauri.conf.json but built here (`create: false`)
            // rather than by Tauri's own setup: this is where the response hook that lets the
            // webview cache the app's assets is attached, and where the window's creation -
            // the WebView2 environment and its browser processes, most of the time between
            // process start and the first frame - gets its own boot stamp.
            let config = app
                .config()
                .app
                .windows
                .first()
                .cloned()
                .expect("tauri.conf.json declares the main window");
            tauri::WebviewWindowBuilder::from_config(app.handle(), &config)?
                .on_web_resource_request(revalidate_assets)
                .build()?;
            stamp("window + webview created");
            Ok(())
        })
        .on_page_load(|_webview, payload| {
            stamp(&format!("page load event ({:?})", payload.event()));
        })
        .invoke_handler(tauri::generate_handler![
            open_folder,
            close_folder,
            boot_stage,
            cmd_fs::list_dir,
            cmd_fs::read_file,
            cmd_fs::read_file_raw,
            cmd_fs::file_probe,
            cmd_fs::file_fingerprint,
            cmd_fs::encodings,
            cmd_fs::read_file_base64,
            cmd_fs::read_file_chunk,
            cmd_fs::patch_file,
            cmd_fs::write_file,
            cmd_fs::read_file_at,
            cmd_fs::repo_head,
            cmd_fs::create_file,
            cmd_fs::create_folder,
            cmd_fs::rename_path,
            cmd_fs::delete_path,
            cmd_fs::session_log_file,
            cmd_fs::backup_write,
            cmd_fs::backup_clear,
            cmd_fs::backup_list,
            cmd_fs::backup_read,
            can_log::can_log_stats,
            can_log::can_intervals,
            can_log::convert_can_log,
            can_log::can_log_open,
            can_log::can_log_frames,
            can_log::can_log_count,
            can_log::can_log_close,
            cmd_fs::initial_repo,
            cmd_fs::repo_submodules,
            cmd_graph::graph_request,
            cmd_scm::scm_status,
            cmd_scm::git_init,
            cmd_scm::git_stage,
            cmd_scm::git_unstage,
            cmd_scm::git_stage_all,
            cmd_scm::git_unstage_all,
            cmd_scm::git_commit,
            cmd_scm::git_discard,
            cmd_scm::git_discard_all,
            cmd_scm::scm_branches,
            cmd_scm::scm_remotes,
            cmd_scm::scm_stashes,
            cmd_scm::scm_tags,
            cmd_scm::scm_pull,
            cmd_scm::scm_push,
            cmd_scm::scm_sync,
            cmd_scm::scm_fetch,
            cmd_scm::scm_checkout,
            cmd_scm::scm_create_branch,
            cmd_scm::scm_amend_last_commit,
            cmd_scm::scm_reset_to_remote,
            cmd_scm::scm_clone,
            cmd_scm::gerrit_install_hook,
            cmd_scm::gerrit_push_ref,
            cmd_scm::git_output_log,
            cmd_scm::scm_blame,
            cmd_scm::git_output_clear,
            cmd_fs::list_files,
            cmd_fuzzy::fuzzy_files,
            open_workspace,
            settings_read,
            initial_file,
            open_single_file,
            settings_write,
            keybindings_read,
            keybindings_write,
            cmd_fuzzy::path_completions,
            cmd_assoc::assoc_list_defaults,
            cmd_assoc::assoc_apply,
            pty::pty_create,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            viewer::viewer_open,
            viewer::viewer_lines,
            viewer::viewer_text,
            viewer::viewer_edit,
            viewer::viewer_save,
            viewer::viewer_reload,
            viewer::viewer_undo,
            viewer::viewer_redo,
            viewer::viewer_backup,
            viewer::viewer_symbols,
            viewer::viewer_close,
            cmd_ext::ext_list,
            cmd_ext::ext_install_from_vsix,
            cmd_ext::ext_uninstall,
            cmd_ext::ext_read_file,
            cmd_ext::ext_read_file_base64,
            cmd_ext::ext_install_from_ggx,
            cmd_search::search_workspace,
            cmd_search::search_cancel,
            cmd_search::replace_in_files,
            cmd_search::compare_dirs,
            cmd_search::workspace_symbols,
            cmd_search::find_references,
            cmd_search::hex_diff
        ])
        .run(tauri::generate_context!())
        .expect("error while running Git Graph Studio");
    }
}

#[cfg(all(test, feature = "desktop"))]
mod repo_root_tests {
    #[test]
    fn finds_the_nearest_ancestor_with_a_git_entry() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        std::fs::create_dir_all(repo.join("src").join("deep")).unwrap();
        std::fs::create_dir_all(repo.join(".git")).unwrap();
        let root =
            crate::desktop::find_repo_root(&repo.join("src").join("deep").display().to_string())
                .unwrap();
        assert_eq!(std::path::Path::new(&root), repo.as_path());
        // A `.git` file (a worktree or submodule checkout) counts too; nothing above is found.
        let worktree = dir.path().join("wt");
        std::fs::create_dir_all(&worktree).unwrap();
        std::fs::write(worktree.join(".git"), "gitdir: ../repo/.git/worktrees/wt").unwrap();
        assert_eq!(
            std::path::Path::new(
                &crate::desktop::find_repo_root(&worktree.display().to_string()).unwrap()
            ),
            worktree.as_path()
        );
        let plain = dir.path().join("plain");
        std::fs::create_dir_all(&plain).unwrap();
        // The temp dir itself is not inside a repository (unless the machine's temp is - skip then).
        if crate::desktop::find_repo_root(&dir.path().display().to_string()).is_none() {
            assert!(crate::desktop::find_repo_root(&plain.display().to_string()).is_none());
        }
    }
}
