//! Git Graph Studio: a standalone workbench whose git-graph views arrive as plugins.
//!
//! The app knows no plugin by name: its own git reads and writes run the `git` CLI in this
//! process (`git.rs`), and every plugin that declares a process backend is started by
//! `ext_process.rs` and spoken to over the one wire protocol (`ggs-ext/1`) — this binary
//! never links `git-graph-core`. The Git Graph view's engine, write path and webview all
//! belong to the git-graph-rs VSIX (the extension's own standard build, inside the
//! vscode-git-graph-rs submodule), and the extension store
//! serves the VSIX extensions installed from the Extensions view.

//! The crate is a library plus the binary `Cargo.toml` declares: `git-graph-studio` (the
//! Tauri app). The sidecars (`ggs-node`, `ggs-bash`, `ggs-config`) are their own crates
//! since the restructure's P2; nothing here is feature-gated any more — the app crate
//! always carries tauri.

// The app's own test-only helper (the isolated extension store); the scratch-repo kit
// lives in the ggs-testkit dev-dependency (crates/ggs-testkit).
#[cfg(test)]
mod test_git_helpers;
#[cfg(test)]
mod test_isolated_store;

/// The app's adapters over ggs-base's EventSink / BatchSink — the only place a domain
/// push crosses into tauri (docs/architecture-restructure-plan.md §4.7, P3-1).
pub mod events;
pub mod can_commands;
pub mod viewer_commands;
pub mod cmd_analysis;
/// The app-instance domain: "New Window" spawns another GGS — the multi-open entry every
/// platform shares (macOS needs it most: activating a bundled app's icon only focuses the
/// running instance, so the new one goes through `open -n`).
pub mod cmd_app;
pub mod cmd_assoc;
pub mod cmd_ext;
pub mod cmd_fs;
pub mod cmd_fuzzy;
pub mod cmd_providers;
pub mod cmd_scm;
pub mod cmd_search;
pub mod cmd_symbols;
/// The frame host's child processes (`nodeShims.ts` maps them onto the Node API): one real
/// process surface a sandboxed frame cannot have on its own.
pub mod ext_child;
pub mod ext_gallery;
pub mod ext_process;
/// Which frontend answers a backend's host request, and the registration journal a late
/// frontend replays (docs/ggs-remote-plan.md §8.6 #1).
pub mod mcp;
pub mod measure;
pub mod pty;
/// Remote Access (module 19): this instance's registration with a local `ggs-remote/1`
/// daemon, the remote workbench's assets and the hidden Relay webview.
pub mod remote_host;
#[cfg(test)]
mod stage_bench;
pub mod watcher;

pub use desktop::{ensure_main_window, run};
pub mod state;
pub mod boot;
pub mod cli;
pub mod window;

mod desktop {
    use crate::{
        can_commands, viewer_commands, cmd_analysis, cmd_app, cmd_assoc, cmd_ext, cmd_fs, cmd_fuzzy, cmd_providers,
        cmd_scm, cmd_search, cmd_symbols, ext_child, ext_gallery, ext_process, mcp, measure,
        pty, remote_host,
    };
    use ggs_base::workspace::WorkspaceRoots;
    use crate::cli::{cli_help, launch_path_of, parse_startup_actions, wants_help};
    use crate::window::{apply_webkit_compat, boot_started, revalidate_assets, stamp};
    use std::sync::Mutex;

    /// The user-level `settings.json` (~/.ggs/settings.json): the form writes it, and a hand
    /// edit of it wins on the next launch (M3 3.9's "edited both ways").
    fn settings_file() -> Result<std::path::PathBuf, String> {
        // The `~/.ggs` layout — `GGS_HOME` relocation included — is computed in exactly
        // one place: ggs_base::paths.
        ggs_base::paths::settings_file()
    }

    #[tauri::command]
    fn settings_read() -> Result<Option<String>, String> {
        Ok(std::fs::read_to_string(settings_file()?).ok())
    }

    /// The user's `keybindings.json` (~/.ggs/keybindings.json), same read/write pair.
    fn keybindings_file() -> Result<std::path::PathBuf, String> {
        ggs_base::paths::keybindings_file()
    }

    #[tauri::command]
    fn keybindings_read() -> Result<Option<String>, String> {
        Ok(std::fs::read_to_string(keybindings_file()?).ok())
    }

    #[tauri::command]
    fn keybindings_write(contents: String) -> Result<(), String> {
        // Atomic: a second running instance may be reading or writing the same file.
        ggs_base::fsx::atomic_write(&keybindings_file()?, contents.as_bytes())
    }

    #[tauri::command]
    fn settings_write(contents: String) -> Result<(), String> {
        // Atomic: a second running instance may be reading or writing the same file.
        ggs_base::fsx::atomic_write(&settings_file()?, contents.as_bytes())
    }

    /// Whether this launch is a `--remote-host` one (§8.2): no desktop window at boot.
    fn args_have_remote_host() -> bool {
        std::env::args().skip(1).any(|arg| arg == "--remote-host")
    }

    /// Build the desktop window from its tauri.conf.json declaration (with the asset
    /// revalidation hook) — at boot, or later when a `--remote-host` instance is asked to
    /// show itself on the desktop.
    fn build_main_window(
        app: &tauri::AppHandle,
        visible: bool,
    ) -> tauri::Result<tauri::WebviewWindow> {
        let config = app
            .config()
            .app
            .windows
            .first()
            .cloned()
            .expect("tauri.conf.json declares the main window");
        tauri::WebviewWindowBuilder::from_config(app, &config)?
            .visible(visible)
            .on_web_resource_request(revalidate_assets)
            .build()
    }

    /// Show the desktop window, building it first when this instance has none (the Remote
    /// Access daemon's `Show`, the tray's "Open Git Graph Studio").
    pub fn ensure_main_window(app: &tauri::AppHandle) -> tauri::Result<()> {
        use tauri::Manager;
        match app.get_webview_window("main") {
            Some(window) => {
                #[cfg(target_os = "macos")]
                app.set_activation_policy(tauri::ActivationPolicy::Regular)?;
                remote_host::restore_desktop_size(&window);
                window.show()?;
                window.unminimize()?;
                window.set_focus()
            }
            None => {
                #[cfg(target_os = "macos")]
                app.set_activation_policy(tauri::ActivationPolicy::Regular)?;
                build_main_window(app, true).map(|_| ())
            }
        }
    }

    /// The app's entry point (`main.rs` is a one-line stub around it).
    pub fn run() {
        apply_webkit_compat();
        // The spawn-env seam: the provider bridge's environment (the bridged backend's
        // config dir, the active provider's endpoint and key) rides into every backend
        // start through this registered source — ext_process itself names no provider
        // knowledge, so the two modules meet only here, in the composition root.
        ggs_ext::process::add_spawn_env_source(cmd_providers::backend_env);
        // The same seam carries git: when the located Git for Windows is not on the
        // PATH (a custom-directory install), its directory rides into every backend's
        // PATH, so an extension's own git discovery finds the same install the app
        // runs — git.rs owns the answer, ext_process stays git-agnostic.
        ggs_ext::process::add_spawn_env_source(ggs_git::runner::backend_env);
        // The app's own executable, for whatever an extension starts on the app's behalf
        // (the Remote Access daemon launches new windows with it). Set before any thread
        // exists; every backend and every frame's `process.env` inherits it.
        if let Ok(exe) = std::env::current_exe() {
            std::env::set_var("GGS_APP_EXE", exe);
        }
        // The host-request seam: a backend's `ggs.hostRequest` is addressed to one frontend —
        // the one whose call claims it (every webview: the desktop window), else the
        // desktop window while it exists, a remote session otherwise — so a request is
        // never answered twice (docs/ggs-remote-plan.md §8.6 #1).
        ext_process::set_host_request_frontend(remote_host::host_request_frontend);
        let _boot = boot_started();
        // `ggs --help` / `ggs -h` prints every launch form; no window is created.
        let args: Vec<String> = std::env::args().collect();
        if wants_help(&args) {
            print!("{}", cli_help());
            std::process::exit(0);
        }
        // `ggs config` / `ggs-config` (either spelling, module 19): the one-command
        // Remote Access setup — password, relay, links — from a command line, no window.
        if args.get(1).map(String::as_str) == Some("config") {
            std::process::exit(ggs_config::run(&args[2..]));
        }
        // `git-graph-studio --measure <folder>` runs the performance probes headless and prints
        // JSON (scripts/measure.mjs folds it into metrics.json); no window is created.
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
        // `git-graph-studio --mcp [folder]` speaks the Model Context Protocol on stdio:
        // an AI assistant's bridge to that folder's symbol index (default: the working
        // directory). No window is created; stderr carries the one startup line.
        if args.get(1).map(String::as_str) == Some("--mcp") {
            let folder = args.get(2).cloned().unwrap_or_else(|| ".".to_owned());
            match ggs_mcp::run(&folder) {
                Ok(code) => std::process::exit(code),
                Err(error) => {
                    eprintln!("{error}");
                    std::process::exit(1);
                }
            }
        }
        // `git-graph-studio <folder>` opens that folder (a repository resolves to its root);
        // a plain file opens in single-file mode. `launch_path_of` is the one normalisation
        // (the path arrives canonicalised, flags never read as paths), and with the app
        // multi-instance this launch's path opens in this launch's window.
        //
        // A comparison launch flag (`ggs --compare|--hex|--hex-compare|--folder-compare ...`)
        // opens its comparison instead: no folder of its own, and its arguments are never read
        // as the launch path. A usage error is reported before any window exists.
        let startup_actions = match parse_startup_actions(&args) {
            Ok(actions) => actions,
            Err(error) => {
                eprintln!("{error}");
                std::process::exit(2);
            }
        };
        let states = crate::state::StateSet::default();
        if startup_actions.is_empty() {
            if let Some(arg) = launch_path_of(&args) {
                let path = std::path::PathBuf::from(&arg);
                if path.is_file() {
                    if arg.to_ascii_lowercase().ends_with(".ggs-workspace") {
                        // A workspace FILE launch opens the multi-root workspace — the
                        // frontend's boot re-opens it through `open_workspace`. Not a
                        // single-file launch: the viewer would show the JSON.
                        stamp(&format!("launch workspace file: {arg}"));
                        states.launch.set_startup_workspace(Some(arg.clone()));
                    } else {
                        // The file's document (read, decode, rope, outline, the syntax set) builds
                        // now, while the window and the webview come up: the page's `viewer_open`
                        // then takes it ready-made. A small file never reaches the so its
                        // prewarm is wasted but cheap; a binary file is skipped by the probe.
                        ggs_text::viewer::prewarm(arg.clone());
                        states.launch.set_single_file(Some(arg.clone()));
                    }
                }
                if path.is_dir() {
                    // The frontend's boot re-opens this path through `open_folder`, which resolves
                    // the repository root once the backend is up.
                    stamp(&format!("launch folder: {arg}"));
                    let mut roots = states.roots.list();
                    roots.push(arg);
                    states.roots.set(roots);
                }
            } else {
                stamp("launch: no path argument");
            }
        } else {
            states.launch.push_startup_actions(startup_actions);
        }

        stamp("main: args parsed");

        // The first file opened in a folder (a restored session's, or the user's first
        // click) builds a viewer document for its outline, and that needs the syntax
        // set - a deserialisation worth a good fraction of a second, best paid now on
        // a spare core rather than on that first open. (The graph engine's own warm-up
        // is a plugin's business now: the backend warms when `notify_workspace` reports
        // the launch folder, right after the backends come up.)
        if !states.roots.list().is_empty() {
            std::thread::spawn(|| {
                ggs_text::viewer::doc::syntax_set();
                stamp("syntax set ready");
            });
        }

        stamp("builder: run");
        // No single-instance plugin: the app is multi-instance (M7 7.7 re-decided
        // 2026-09-17), every launch is its own process and window, and `ggs <path>` (or
        // an "Open with GGS" launch) opens in the window it started. Instances share
        // `~/.ggs` — its writers go through `atomic_write`, so instances cannot corrupt
        // each other's user data.
        tauri::Builder::default()
            .plugin(tauri_plugin_dialog::init())
            .plugin(tauri_plugin_opener::init())
            .plugin(tauri_plugin_clipboard_manager::init())
            .manage(states.roots)
            .manage(states.launch)
            .manage(states.file_list_cache.clone())
            .manage(states.symbol_cache.clone())
            .manage(states.search.clone())
            .manage(states.symbol_index.clone())
            .manage(states.analysis_index.clone())
            .manage(states.watchers)
            .manage(states.deferred)
            .manage(Mutex::new(pty::PtyState::default()))
            .manage(ggs_text::viewer::ViewerState::default())
            .manage(ggs_text::viewer::indexed::IndexedState::default())
            .manage(ggs_can::CanLogState::default())
            // A clone of the app's one host (`ext_process::host()`), not a second,
            // independent `ExtHost`: the folder-open paths and the provider bridge's
            // restarts reach the same running backends through `host()` directly, with no
            // `AppHandle` to fetch Tauri-managed state through, and the two must agree on
            // what is running.
            .manage(ext_process::host().clone())
            // The `ggx` protocol serves an installed package's own files to its sandboxed
            // page iframes (cmd_ext.rs confines every request to the extensions home) — the
            // extension-platform counterpart of the public dir the Git Graph page loads from.
            .register_uri_scheme_protocol("ggs", |ctx, request| {
                cmd_ext::serve_ext_asset(&request, &ctx.app_handle().asset_resolver())
            })
            .setup(|app| {
                // Git's output reaches the panel's "Git" channel as it happens.
                use tauri::Emitter;
                let handle = app.handle().clone();
                ggs_git::runner::set_log_emitter(move |line| {
                    let _ = handle.emit("studio://git-output", line);
                });
                stamp("setup entered");
                // The Dock icon's right-click menu ("New Window", macOS only): AppKit
                // asks the application delegate for it, so the selectors are injected
                // into tao's delegate class here, on the main thread, at every boot.
                #[cfg(target_os = "macos")]
                cmd_app::dock_menu::install();
                // The `ggs` launcher's reachability: append the install directory to the
                // user PATH (idempotent, no length limits - the NSIS hooks no longer write
                // PATH; see cmd_assoc::user_path_apply for the wipe they caused). It runs
                // on the boot thread, off the window's critical path: its WM_SETTINGCHANGE
                // broadcast waits on every top-level window in the session, which on a
                // loaded desktop stalls the setup for hundreds of milliseconds.
                std::thread::spawn(|| {
                    if let Err(reason) = cmd_assoc::user_path_apply() {
                        eprintln!("[boot] user PATH apply: {reason}");
                    }
                });

                // "Install means run" (plan §8.2): every installed package that declares a
                // backend comes up with the app, without waiting for its first command, and
                // the whole set is told the app's open folders — a backend that keeps
                // per-workspace state (the graph engine's warm repository handle) acts on it,
                // the rest answer and forget. Off the main thread — a slow handshake must
                // never hold the window back — and best-effort: a failure is held in the
                // status, not the boot.
                // The bundled package auto-installs on first launch:
                // the installer carries it, the first run makes it a standard uninstallable
                // install; its Extensions-view entry remains for reinstalls, and a
                // deliberate uninstall is remembered and never undone.
                {
                    let handle = app.handle().clone();
                    std::thread::spawn(move || {
                        use tauri::Manager;
                        let Ok(dir) = cmd_ext::extensions_dir(&handle) else {
                            return;
                        };
                        // The bundled package installs on first launch — VS Code's
                        // bundled-extensions behavior: the installer carries it, the first
                        // run makes it a standard (uninstallable) install. A deliberate
                        // uninstall left a dismissal marker and stays uninstalled; an
                        // existing install is only brought current by the refresh below.
                        for installed in cmd_ext::install_missing_bundled(&handle) {
                            match installed {
                                Ok(line) => ggs_ext::log_extensions(&line),
                                Err(reason) => ggs_ext::log_extensions(&format!(
                                    "bundled install failed: {reason}"
                                )),
                            }
                        }
                        // An installed bundled package is brought current before anything
                        // starts from it: a newer bundled version upgrades it forward-only,
                        // the same version from an older build is refreshed by its recorded
                        // build stamp.
                        for refreshed in cmd_ext::refresh_bundled_installs(&handle) {
                            match refreshed {
                                Ok(line) => ggs_ext::log_extensions(&line),
                                Err(reason) => {
                                    ggs_ext::log_extensions(&format!("refresh failed: {reason}"))
                                }
                            }
                        }
                        let host = handle.state::<ggs_ext::process::ExtHost>();
                        // The reader threads forward a real-Node extension host's
                        // `ggs.hostRequest`s through the app's event emitter (the engine's
                        // HostHooks, installed off this handle).
                        ext_process::attach_app(&handle);
                        for started in host.start_all_installed(&dir) {
                            if let Err(reason) = started {
                                eprintln!("[extensions] backend failed to start: {reason}");
                            }
                        }
                        let folders = handle.state::<WorkspaceRoots>().list();
                        ext_process::host().notify_workspace(&folders);
                        cmd_providers::apply_claude_integration(&folders);
                    });
                }
                // The main window is declared in tauri.conf.json but built here (`create: false`)
                // rather than by Tauri's own setup: this is where the response hook that lets the
                // webview cache the app's assets is attached, and where the window's creation -
                // the WebView2 environment and its browser processes, most of the time between
                // process start and the first frame - gets its own boot stamp. A
                // `--remote-host` launch (an instance the Remote Access daemon opened for a
                // remote session, docs/ggs-remote-plan.md §8.2) builds its desktop window
                // hidden: the whole workbench runs on this PC, the remote browsers show its
                // live copy (the replica, §22), and the daemon's Show reveals it.
                let remote_host_only = args_have_remote_host();
                if remote_host_only {
                    #[cfg(target_os = "macos")]
                    app.set_activation_policy(tauri::ActivationPolicy::Accessory);
                    build_main_window(app.handle(), false)?;
                    stamp("remote host mode: hidden desktop window");
                } else {
                    #[cfg_attr(not(all(debug_assertions, target_os = "macos")), allow(unused_variables))]
                    let window = build_main_window(app.handle(), true)?;
                    // The automated harness run needs its timers firing: keep this window awake.
                    #[cfg(all(debug_assertions, target_os = "macos"))]
                    if std::env::var_os("GGS_DEV_HARNESS").is_some() {
                        crate::window::keep_awake_for_probe_runs(&window);
                    }
                    stamp("window + webview created");
                }
                // Remote Access (module 19): register with a local daemon when one runs.
                remote_host::start(app.handle(), remote_host_only);
                Ok(())
            })
            .on_page_load(|webview, payload| {
                stamp(&format!("page load event ({:?})", payload.event()));
                // The dev-only probe hook (scripts/probes/claude-code-sandbox.mjs): a
                // GGS_DEV_HARNESS value names the dev harness page the window opens at boot —
                // the same navigation the Help menu's dev-only entry performs, driven from
                // outside for automated runs. The second load (the harness page) additionally
                // dumps a diagnostic (its URL, the page errors, the harness state) through
                // GGS_DEV_HARNESS_DIAG ("<file>|<url>") — the probe's way to see inside a
                // WKWebView that has no CDP. Debug builds only, so no probe surface ships.
                static LOADS: std::sync::atomic::AtomicU32 =
                    std::sync::atomic::AtomicU32::new(0);
                if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished)
                    && cfg!(debug_assertions)
                {
                    let load = LOADS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    if load == 0 {
                        match std::env::var("GGS_DEV_HARNESS") {
                            Ok(page) => {
                                stamp(&format!("dev harness hook navigating to: {page}"));
                                if let Ok(literal) = serde_json::to_string(&page) {
                                    let _ = webview.eval(format!("window.location.href = {literal};"));
                                }
                            }
                            Err(_) => stamp("dev harness hook: no GGS_DEV_HARNESS in this run"),
                        }
                    } else if load == 1 {
                        if let Ok(diag) = std::env::var("GGS_DEV_HARNESS_DIAG") {
                            if let Some((file, url)) = diag.split_once('|') {
                                stamp("dev harness hook: dumping the page diagnostic");
                                let js = format!(
                                    "(() => {{ const payload = JSON.stringify({{ url: location.href, \
                                     pageErrors: (window.__pageErrors ?? []).slice(0, 30), \
                                     harness: Boolean(window.__harness), \
                                     rows: window.__fullReport ? window.__fullReport.length : null }}); \
                                     try {{ window.__TAURI_INTERNALS__.invoke('write_file', {{ path: {file}, contents: payload }}); }} catch (e) {{}} \
                                     try {{ fetch({url}, {{ method: 'POST', body: payload }}); }} catch (e) {{}} }})();",
                                    file = serde_json::to_string(file).unwrap_or_default(),
                                    url = serde_json::to_string(url).unwrap_or_default()
                                );
                                let _ = webview.eval(&js);
                            }
                        }
                    }
                }
            })
            .invoke_handler(tauri::generate_handler![
                super::boot::open_folder,
                super::boot::close_folder,
                super::window::boot_stage,
                super::window::open_devtools,
                cmd_app::app_new_instance,
                cmd_fs::list_dir,
                cmd_fs::list_dir_page,
                cmd_fs::read_file,
                cmd_fs::read_file_raw,
                cmd_fs::file_probe,
                cmd_fs::file_fingerprint,
                cmd_fs::encodings,
                cmd_fs::read_file_base64,
                cmd_fs::read_file_chunk,
                cmd_fs::patch_file,
                cmd_fs::write_file,
                cmd_fs::fs_write_chunk,
                cmd_fs::fs_upload_offset,
                cmd_fs::read_file_at,
                cmd_fs::materialize_revision_file,
                cmd_fs::discard_temp_blob,
                cmd_fs::repo_head,
                cmd_fs::create_file,
                cmd_fs::create_folder,
                cmd_fs::rename_path,
                cmd_fs::delete_path,
                cmd_fs::copy_into,
                cmd_fs::fs_import,
                cmd_fs::fs_export,
                cmd_fs::fs_transfer_cancel,
                cmd_fs::session_log_file,
                cmd_fs::backup_write,
                cmd_fs::backup_clear,
                cmd_fs::backup_list,
                cmd_fs::backup_read,
                can_commands::can_log_stats,
                can_commands::can_intervals,
                can_commands::convert_can_log,
                can_commands::can_log_open,
                can_commands::can_log_frames,
                can_commands::can_log_count,
                can_commands::can_log_find,
                can_commands::can_log_close,
                cmd_fs::repo_submodules,
                cmd_fs::remote_paths_policy,
                cmd_fs::remote_ext_roots,
                cmd_fs::remote_canonical_paths,
                cmd_scm::scm_status,
                cmd_scm::file_log,
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
                cmd_scm::scm_rename_branch,
                cmd_scm::scm_delete_branch,
                cmd_scm::scm_merge,
                cmd_scm::scm_rebase,
                cmd_scm::scm_add_remote,
                cmd_scm::scm_delete_remote,
                cmd_scm::scm_push_stash,
                cmd_scm::scm_apply_stash,
                cmd_scm::scm_pop_stash,
                cmd_scm::scm_drop_stash,
                cmd_scm::scm_add_tag,
                cmd_scm::scm_delete_tag,
                cmd_scm::scm_undo_last_commit,
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
                super::boot::open_workspace,
                settings_read,
                super::boot::boot_context,
                super::boot::post_first_paint,
                super::boot::open_single_file,
                settings_write,
                keybindings_read,
                keybindings_write,
                cmd_fuzzy::path_completions,
                cmd_assoc::assoc_list_defaults,
                cmd_assoc::assoc_apply,
                cmd_assoc::context_menu_apply,
                pty::pty_create,
                pty::pty_write,
                pty::pty_resize,
                pty::pty_kill,
                viewer_commands::viewer_open,
                viewer_commands::viewer_lines,
                viewer_commands::viewer_highlight,
                viewer_commands::viewer_text,
                viewer_commands::viewer_edit,
                viewer_commands::viewer_find,
                viewer_commands::viewer_replace,
                viewer_commands::viewer_save,
                viewer_commands::viewer_reload,
                viewer_commands::viewer_undo,
                viewer_commands::viewer_redo,
                viewer_commands::viewer_backup,
                viewer_commands::viewer_symbols,
                viewer_commands::viewer_close,
                viewer_commands::indexed_open,
                viewer_commands::indexed_lines,
                viewer_commands::indexed_find,
                viewer_commands::indexed_close,
                cmd_ext::ext_list,
                cmd_ext::ext_uninstall,
                cmd_ext::ext_read_file,
                cmd_ext::ext_read_file_base64,
                cmd_ext::ext_fs,
                cmd_ext::ext_log_append,
                cmd_ext::ext_log_path,
                cmd_ext::ext_storage_paths,
                cmd_ext::ext_page_revision_bytes,
                cmd_ext::ext_page_file_chunk,
                cmd_ext::ext_load_code,
                cmd_ext::ext_node_env,
                cmd_ext::ext_install_from_vsix,
                cmd_ext::ext_install_bundled,
                cmd_providers::provider_list,
                cmd_providers::provider_save,
                cmd_providers::provider_delete,
                cmd_providers::provider_activate,
                cmd_providers::providers_shell_refresh,
                cmd_providers::provider_usage,
                cmd_providers::provider_fetch_models,
                cmd_providers::provider_test_connection,
                cmd_providers::provider_ccswitch_scan,
                cmd_providers::provider_import_ccswitch,
                ext_gallery::ext_gallery_featured,
                ext_gallery::ext_gallery_lookup,
                ext_gallery::ext_gallery_search,
                ext_gallery::ext_gallery_asset,
                ext_gallery::ext_gallery_install,
                ext_process::ext_process_start,
                ext_process::ext_process_run,
                ext_process::ext_process_stop,
                ext_process::ext_process_status,
                ext_process::ext_process_host_respond,
                ext_process::ext_process_invoke,
                ext_process::ext_process_push_event,
                ext_process::ext_process_registrations,
                ext_process::ext_node_runtime,
                ext_child::ext_child_spawn,
                ext_child::ext_child_write,
                ext_child::ext_child_end_stdin,
                ext_child::ext_child_kill,
                ext_child::ext_node_runtime_path,
                ext_child::ext_child_stop_for,
                cmd_search::search_workspace,
                cmd_search::search_cancel,
                cmd_search::replace_in_files,
                cmd_search::compare_dirs,
                cmd_search::workspace_symbols,
                cmd_search::find_references,
                cmd_symbols::symbols_status,
                cmd_symbols::symbols_rebuild,
                cmd_symbols::symbol_lookup,
                cmd_symbols::symbol_references,
                cmd_symbols::symbol_tree,
                cmd_analysis::analysis_status,
                cmd_analysis::analysis_rebuild,
                cmd_analysis::analysis_module_graph,
                cmd_analysis::analysis_module_diagram,
                cmd_analysis::analysis_metrics,
                cmd_analysis::analysis_dead_code,
                cmd_analysis::analysis_security,
                cmd_analysis::analysis_import_graph,
                mcp::mcp_log,
                mcp::mcp_tools,
                cmd_providers::claude_mcp_status,
                cmd_search::hex_diff,
                pty::pty_list,
                pty::pty_tail,
                remote_host::remote_host_set_summary,
                remote_host::remote_host_frontend_gone,
                remote_host::remote_host_status,
                remote_host::remote_host_hide_main,
                remote_host::remote_mirror_fit,
                remote_host::remote_mirror_focus
            ])
            .build(tauri::generate_context!())
            .expect("error while building Git Graph Studio")
            .run(|app, event| {
                // Finder's "Open With" handoff (the bundle's folder declaration and the
                // file associations): macOS hands the running app the paths as file URLs,
                // and the routing decides between this window and a new instance.
                #[cfg(target_os = "macos")]
                if let tauri::RunEvent::Opened { urls } = &event {
                    crate::cli::handle_opened(app, urls);
                }
                // No backend outlives its window: on exit every process this instance spawned
                // is stopped (another instance's backends are not ours to stop) — the warm
                // extension backends and a frame's child processes alike.
                // A `--remote-host` instance has no window most of its life: the Relay
                // closing must not end it — the daemon's idle exit (`Quit`) does.
                if let tauri::RunEvent::ExitRequested { code: None, api, .. } = &event {
                    if remote_host::remote_host_only() {
                        api.prevent_exit();
                    }
                }
                // The desktop window closing while remote sessions are attached keeps the
                // instance up for them (the Relay is a window too); the daemon is told the
                // window is no longer visible.
                if let tauri::RunEvent::WindowEvent {
                    label,
                    event: tauri::WindowEvent::Destroyed,
                    ..
                } = &event
                {
                    if label == "main" {
                        remote_host::send_update(app);
                    }
                    if label == remote_host::RELAY_LABEL {
                        // A destroyed Relay is why a remote session goes dead: the daemon
                        // asks for a rebuild, and this line is the record of the cause.
                        eprintln!("[remote] relay webview destroyed");
                    }
                }
                if let tauri::RunEvent::Exit = event {
                    use tauri::Manager;
                    app.state::<ggs_ext::process::ExtHost>().stop_all();
                    ggs_ext::child::stop_all();
                }
            });
    }
}

#[cfg(test)]
mod launch_path_tests {
    use crate::cli::launch_path_of;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|arg| (*arg).to_owned()).collect()
    }

    #[test]
    fn flags_are_skipped_and_the_last_plain_argument_wins() {
        // A flag never reads as the path; an existing plain argument is canonicalised.
        let argv = args(&["ggs", "--flag", "-x", "Z:/definitely/not/here"]);
        assert_eq!(launch_path_of(&argv), None);
        let exe = std::env::current_exe().unwrap();
        let argv = vec!["ggs".to_owned(), exe.display().to_string()];
        assert!(launch_path_of(&argv).is_some());
    }

    #[test]
    fn headless_mode_arguments_are_not_read_as_paths() {
        // `--mcp`/`--measure` consume their own folder: a forward never names it.
        let argv = args(&["ggs", "--mcp", "Z:/definitely/not/here"]);
        assert_eq!(launch_path_of(&argv), None);
        let argv = args(&["ggs", "--measure", "Z:/definitely/not/here"]);
        assert_eq!(launch_path_of(&argv), None);
    }
}

/// The Finder "Open With" handoff's two halves: the URL classification, and the cold-start
/// seeding that turns a handoff into this window's launch form.
#[cfg(test)]
mod opened_paths_tests {
    use crate::cli::{opened_paths, seed_launch_paths};
    use crate::state::StateSet;

    #[test]
    fn file_urls_split_by_kind_and_other_schemes_are_ignored() {
        // The test binary itself is a real file beside a real folder.
        let exe = std::env::current_exe().unwrap();
        let dir = exe.parent().unwrap().to_owned();
        let urls = [
            tauri::Url::from_file_path(&dir).unwrap(),
            tauri::Url::from_file_path(&exe).unwrap(),
            tauri::Url::parse("https://gitgraph.studio/x").unwrap(),
        ];
        let (folders, files) = opened_paths(&urls);
        assert_eq!(folders, vec![dir.display().to_string()]);
        assert_eq!(files, vec![exe.display().to_string()]);
    }

    #[test]
    fn seeding_takes_one_path_and_only_into_an_empty_window() {
        // A folder seeds the launch repository — exactly the argv launch's record.
        let state = StateSet::default();
        let folder = tempfile::tempdir().unwrap();
        let folder = folder.path().display().to_string();
        assert!(seed_launch_paths(
            &state.roots,
            &state.launch,
            std::slice::from_ref(&folder),
            &[]
        ));
        assert_eq!(state.roots.list(), vec![folder]);
        // A window that already has a launch form is never re-seeded.
        assert!(!seed_launch_paths(
            &state.roots,
            &state.launch,
            ["/elsewhere".into()].as_slice(),
            &[]
        ));
        assert_eq!(state.roots.list().len(), 1);

        // A file seeds single-file mode instead.
        let state = StateSet::default();
        let file = std::env::current_exe().unwrap().display().to_string();
        assert!(seed_launch_paths(
            &state.roots,
            &state.launch,
            &[],
            std::slice::from_ref(&file)
        ));
        assert_eq!(state.launch.single_file(), Some(file));

        // Nothing to open seeds nothing.
        let state = StateSet::default();
        assert!(!seed_launch_paths(&state.roots, &state.launch, &[], &[]));
        assert_eq!(state.roots.list().len(), 0);
    }

    #[test]
    fn a_workspace_file_seeds_the_workspace_launch_not_single_file() {
        // The cold-start handoff mirrors the argv launch's `.ggs-workspace` branch: the
        // file opens as the multi-root workspace, never as the JSON in the single-file
        // viewer (the bug 76f73bb fixed for `ggs <workspace>.ggs-workspace`).
        let state = StateSet::default();
        let temp = tempfile::tempdir().unwrap();
        let ws_file = temp.path().join("team.ggs-workspace");
        std::fs::write(&ws_file, br#"{"folders": [{"path": "."}]}"#).unwrap();
        let ws = ws_file.display().to_string();
        assert!(seed_launch_paths(
            &state.roots,
            &state.launch,
            &[],
            std::slice::from_ref(&ws)
        ));
        assert_eq!(state.launch.startup_workspace(), Some(ws.clone()));
        assert_eq!(state.launch.single_file(), None);

        // A window whose launch already carried a workspace file is never re-seeded.
        assert!(!seed_launch_paths(
            &state.roots,
            &state.launch,
            ["/elsewhere".into()].as_slice(),
            &[]
        ));
        assert_eq!(state.roots.list().len(), 0);
        assert_eq!(state.launch.startup_workspace().as_deref(), Some(ws.as_str()));
    }
}

#[cfg(test)]
mod startup_action_tests {
    use crate::cli::parse_startup_actions;
    use crate::state::StartupAction;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|arg| (*arg).to_owned()).collect()
    }

    /// A scratch tree with two files and a folder, so the parser's existence and kind checks
    /// run against the real filesystem (paths arrive canonicalised, `\\?\`-prefix trimmed).
    fn scratch() -> (tempfile::TempDir, String, String, String) {
        let temp = tempfile::tempdir().unwrap();
        let a = temp.path().join("a.bin");
        let b = temp.path().join("b.bin");
        std::fs::write(&a, b"a").unwrap();
        std::fs::write(&b, b"b").unwrap();
        let sub = temp.path().join("sub");
        std::fs::create_dir_all(&sub).unwrap();
        let show = |path: &std::path::Path| path.display().to_string();
        (temp, show(&a), show(&b), show(&sub))
    }

    #[test]
    fn a_launch_without_a_subcommand_has_no_actions() {
        assert!(parse_startup_actions(&args(&["ggs"])).unwrap().is_empty());
        assert!(parse_startup_actions(&args(&["ggs", "--flag", "Z:/x"]))
            .unwrap()
            .is_empty());
        let exe = std::env::current_exe().unwrap();
        assert!(
            parse_startup_actions(&args(&["ggs", &exe.display().to_string()]))
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn each_subcommand_builds_its_action_from_canonical_paths() {
        let (_dir, a, b, sub) = scratch();
        // `fs::canonicalize` on Windows may answer in 8.3 short-path form, so the expected
        // paths are canonicalised the same way rather than compared to the built-up strings.
        let canon = |raw: &str| {
            std::fs::canonicalize(raw)
                .unwrap()
                .display()
                .to_string()
                .trim_start_matches(r"\\?\")
                .to_owned()
        };
        assert_eq!(
            parse_startup_actions(&args(&["ggs", "--compare", &a, &b])).unwrap(),
            vec![StartupAction::CompareFiles {
                left: canon(&a),
                right: canon(&b)
            }]
        );
        assert_eq!(
            parse_startup_actions(&args(&["ggs", "--hex-compare", &a, &b])).unwrap(),
            vec![StartupAction::HexCompare {
                left: canon(&a),
                right: canon(&b)
            }]
        );
        assert_eq!(
            parse_startup_actions(&args(&["ggs", "--hex", &a])).unwrap(),
            vec![StartupAction::HexView { path: canon(&a) }]
        );
        assert_eq!(
            parse_startup_actions(&args(&["ggs", "--folder-compare", &sub, &sub])).unwrap(),
            vec![StartupAction::FolderCompare {
                left: canon(&sub),
                right: canon(&sub)
            }]
        );
    }

    #[test]
    fn wrong_counts_missing_paths_and_wrong_kinds_are_usage_errors() {
        let (_dir, a, b, sub) = scratch();
        let missing = "Z:/definitely/not/here";
        assert!(parse_startup_actions(&args(&["ggs", "--compare", &a]))
            .unwrap_err()
            .starts_with("usage: ggs --compare"));
        assert!(parse_startup_actions(&args(&["ggs", "--hex", &a, &b]))
            .unwrap_err()
            .starts_with("usage: ggs --hex"));
        assert!(
            parse_startup_actions(&args(&["ggs", "--compare", &a, missing]))
                .unwrap_err()
                .contains("no such file or directory")
        );
        assert!(parse_startup_actions(&args(&["ggs", "--hex", missing]))
            .unwrap_err()
            .contains("no such file or directory"));
        assert!(
            parse_startup_actions(&args(&["ggs", "--compare", &sub, &b]))
                .unwrap_err()
                .contains("not a file")
        );
        assert!(
            parse_startup_actions(&args(&["ggs", "--folder-compare", &a, &b]))
                .unwrap_err()
                .contains("not a directory")
        );
    }

    #[test]
    fn help_is_a_flag_and_bare_names_are_paths_not_subcommands() {
        use crate::cli::{cli_help, wants_help};
        assert!(wants_help(&args(&["ggs", "--help"])));
        assert!(wants_help(&args(&["ggs", "-h"])));
        assert!(!wants_help(&args(&["ggs", "help"])));
        assert!(!wants_help(&args(&["ggs", "--compare"])));
        // A bare `compare` is a path like any other (a folder named "compare" opens as one);
        // only the flagged forms build actions, so flags can never be read as paths.
        assert!(
            parse_startup_actions(&args(&["ggs", "compare", "Z:/a", "Z:/b"]))
                .unwrap()
                .is_empty()
        );
        assert!(parse_startup_actions(&args(&["ggs", "hex", "Z:/a"]))
            .unwrap()
            .is_empty());
        // The help names every launch form.
        for line in [
            "--compare",
            "--hex-compare",
            "--folder-compare",
            "--mcp",
            "--measure",
            "--help",
        ] {
            assert!(cli_help().contains(line), "help text names {line}");
        }
    }
}

#[cfg(test)]
mod repo_root_tests {
    #[test]
    fn finds_the_nearest_ancestor_with_a_git_entry() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        std::fs::create_dir_all(repo.join("src").join("deep")).unwrap();
        std::fs::create_dir_all(repo.join(".git")).unwrap();
        let root =
            ggs_base::workspace::find_repo_root(&repo.join("src").join("deep").display().to_string())
                .unwrap();
        assert_eq!(std::path::Path::new(&root), repo.as_path());
        // A `.git` file (a worktree or submodule checkout) counts too; nothing above is found.
        let worktree = dir.path().join("wt");
        std::fs::create_dir_all(&worktree).unwrap();
        std::fs::write(worktree.join(".git"), "gitdir: ../repo/.git/worktrees/wt").unwrap();
        assert_eq!(
            std::path::Path::new(
                &ggs_base::workspace::find_repo_root(&worktree.display().to_string()).unwrap()
            ),
            worktree.as_path()
        );
        let plain = dir.path().join("plain");
        std::fs::create_dir_all(&plain).unwrap();
        // The temp dir itself is not inside a repository (unless the machine's temp is - skip then).
        if ggs_base::workspace::find_repo_root(&dir.path().display().to_string()).is_none() {
            assert!(ggs_base::workspace::find_repo_root(&plain.display().to_string()).is_none());
        }
    }
}
