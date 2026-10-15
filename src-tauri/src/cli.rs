//! The command line's parsing half (module 1): the launch path, the comparison flags,
//! the help text, and the macOS "Open With" handoff's path classification. Pure —
//! no window — so the launch forms are testable anywhere.

use crate::state::StartupAction;

/// The path a launch should open: the last argument that is neither a flag nor a flag's
/// value, canonicalised when it exists (flags and the `--mcp` / `--measure` folder
/// arguments never read as paths). The app is multi-instance — every launch is its own
/// process and window — so this decides only what the window it started opens.
pub fn launch_path_of(args: &[String]) -> Option<String> {
    let mut path = None;
    let mut skip_next = false;
    for arg in args.iter().skip(1) {
        if skip_next {
            skip_next = false;
            continue;
        }
        if arg == "--measure" || arg == "--mcp" {
            // These modes take a folder argument of their own and never reach the window.
            skip_next = true;
            continue;
        }
        if arg.starts_with("--") || arg.starts_with('-') {
            continue;
        }
        path = Some(arg.clone());
    }
    path.filter(|arg| std::path::Path::new(arg).exists())
        .map(|arg| {
            std::fs::canonicalize(&arg)
                .map(|p| {
                    p.display()
                        .to_string()
                        .trim_start_matches(r"\\?\")
                        .to_owned()
                })
                .unwrap_or(arg)
        })
}

/// What a macOS Finder "Open With" handoff ([`tauri::RunEvent::Opened`]) carries,
/// classified: the file URLs split into folders and files, everything else (other
/// schemes, paths that no longer exist) ignored. Compiled on every platform so the
/// classification is tested where CI runs it.
#[cfg(any(target_os = "macos", test))]
pub fn opened_paths(urls: &[tauri::Url]) -> (Vec<String>, Vec<String>) {
    let mut folders = Vec::new();
    let mut files = Vec::new();
    for url in urls {
        if url.scheme() != "file" {
            continue;
        }
        let Ok(path) = url.to_file_path() else {
            continue;
        };
        // display(): the handoff's call site is macOS, where paths are UTF-8.
        if path.is_dir() {
            folders.push(path.display().to_string());
        } else if path.is_file() {
            files.push(path.display().to_string());
        }
    }
    (folders, files)
}

/// The cold-start half of the Finder "Open With" handoff: record the opened path the
/// way the argv launch records it (`ggs <folder>` / `ggs <file>` — run()'s branch,
/// a `.ggs-workspace` file seeding the workspace launch, not single-file mode), so
/// the `boot_context` the frontend has not asked for yet opens it as this window's
/// launch form, remembered-folder precedence and all. Answers whether the path was
/// taken: a window whose argv already carried a launch form is left alone, and the
/// handoff crosses as the `studio://open-paths` event instead.
#[cfg(any(target_os = "macos", test))]
pub fn seed_launch_paths(
    roots: &ggs_base::workspace::WorkspaceRoots,
    launch: &crate::state::LaunchState,
    folders: &[String],
    files: &[String],
) -> bool {
    if !roots.list().is_empty()
        || launch.single_file().is_some()
        || launch.startup_workspace().is_some()
    {
        return false;
    }
    if let Some(folder) = folders.first() {
        roots.set(vec![folder.clone()]);
        // The same warm-up the argv launch runs: the first file's outline wants the
        // syntax set, best paid on a spare core now rather than on that first open.
        std::thread::spawn(|| {
            ggs_text::viewer::doc::syntax_set();
            crate::window::stamp("syntax set ready");
        });
    } else if let Some(file) = files.first() {
        if file.to_ascii_lowercase().ends_with(".ggs-workspace") {
            // Run()'s branch verbatim: a workspace FILE opens the multi-root workspace,
            // never `single_file`, whose viewer would show the JSON.
            launch.set_startup_workspace(Some(file.clone()));
        } else {
            ggs_text::viewer::prewarm(file.clone());
            launch.set_single_file(Some(file.clone()));
        }
    } else {
        return false;
    }
    true
}

/// The `studio://open-paths` payload: a Finder handoff crossing to a frontend that
/// has already booted.
#[cfg(target_os = "macos")]
#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct OpenedPaths {
    folders: Vec<String>,
    files: Vec<String>,
}

/// A Finder "Open With" handoff: macOS asked the running app to open folders or files
/// (the bundle's `public.folder` declaration, the file associations). A frontend that
/// has not read its boot context yet — Finder launched the app on this very path —
/// takes the argv-launch seeding; a booted one is told over the event, and the
/// workbench routes it: a folder takes over an empty window and wins a new instance
/// otherwise, a file opens like a drop would.
#[cfg(target_os = "macos")]
pub fn handle_opened(app: &tauri::AppHandle, urls: &[tauri::Url]) {
    use tauri::{Emitter, Manager};
    let (folders, files) = opened_paths(urls);
    if folders.is_empty() && files.is_empty() {
        return;
    }
    let launch = app.state::<crate::state::LaunchState>();
    if !launch.boot_context_read()
        && seed_launch_paths(
            app.state::<ggs_base::workspace::WorkspaceRoots>().inner(),
            launch.inner(),
            &folders,
            &files,
        )
    {
        return;
    }
    let _ = app.emit("studio://open-paths", OpenedPaths { folders, files });
}

/// The launch flags that open a comparison: `ggs --compare <a> <b>`,
/// `ggs --hex <file>`, `ggs --hex-compare <a> <b>`, `ggs --folder-compare <dirA> <dirB>`.
/// They are flagged (`--`) the way `--mcp` / `--measure` are, so they can never be read
/// as the path a plain `ggs <path>` launch opens; the flag is the first argument and each
/// takes exactly the paths of its kind, canonicalised as `launch_path_of` canonicalises.
/// A wrong count, a missing path or the wrong kind is a usage error the caller reports
/// before any window exists. `Ok(vec![])` for a launch without such a flag - the plain
/// `<path>` forms apply.
pub fn parse_startup_actions(args: &[String]) -> Result<Vec<StartupAction>, String> {
    let Some(sub) = args.get(1).map(String::as_str) else {
        return Ok(Vec::new());
    };
    // Missing paths are reported as missing; only an existing path of the wrong kind is
    // "not a file" / "not a directory". The canonical form is the same `launch_path_of`
    // produces (a `\\?\` device path reads as one outside the API it came from).
    let canonical = |raw: &str, want_dir: bool| -> Result<String, String> {
        let path = std::path::Path::new(raw);
        if !path.exists() {
            return Err(format!("ggs {sub}: {raw}: no such file or directory"));
        }
        if want_dir && !path.is_dir() {
            return Err(format!("ggs {sub}: {raw}: not a directory"));
        }
        if !want_dir && !path.is_file() {
            return Err(format!("ggs {sub}: {raw}: not a file"));
        }
        std::fs::canonicalize(path)
            .map(|p| {
                p.display()
                    .to_string()
                    .trim_start_matches(r"\\?\")
                    .to_owned()
            })
            .map_err(|_| format!("ggs {sub}: {raw}: could not be resolved"))
    };
    let usage = |takes: &str| format!("usage: ggs {sub} {takes}");
    let path_at = |index: usize, takes: &str| -> Result<&String, String> {
        args.get(index).ok_or_else(|| usage(takes))
    };
    let pair = |want_dir: bool| -> Result<(String, String), String> {
        let (left, right) = (path_at(2, "<left> <right>")?, path_at(3, "<left> <right>")?);
        if args.len() > 4 {
            return Err(usage("<left> <right>"));
        }
        Ok((canonical(left, want_dir)?, canonical(right, want_dir)?))
    };
    match sub {
        "--compare" => {
            let (left, right) = pair(false)?;
            Ok(vec![StartupAction::CompareFiles { left, right }])
        }
        "--hex-compare" => {
            let (left, right) = pair(false)?;
            Ok(vec![StartupAction::HexCompare { left, right }])
        }
        "--hex" => {
            let raw = path_at(2, "<file>")?;
            if args.len() > 3 {
                return Err(usage("<file>"));
            }
            Ok(vec![StartupAction::HexView {
                path: canonical(raw, false)?,
            }])
        }
        "--folder-compare" => {
            let (left, right) = pair(true)?;
            Ok(vec![StartupAction::FolderCompare { left, right }])
        }
        _ => Ok(Vec::new()),
    }
}

/// `ggs --help` / `ggs -h`: print every launch form and exit before any window exists.
pub fn wants_help(args: &[String]) -> bool {
    matches!(args.get(1).map(String::as_str), Some("--help") | Some("-h"))
}

/// The `--help` text: every launch form, the flagged commands indented like the plain
/// ones (the README's command-line section carries the same list).
pub fn cli_help() -> String {
    [
        format!("Git Graph Studio {}", env!("CARGO_PKG_VERSION")),
        String::new(),
        "Usage: ggs [flag] [paths]".to_owned(),
        String::new(),
        "  ggs                                  open the app (the last folder, as at a normal launch)".to_owned(),
        "  ggs <path>                           open that folder (a file opens in single-file".to_owned(),
        "                                       mode; a .ggs-workspace file opens as the".to_owned(),
        "                                       workspace)".to_owned(),
        "  ggs --compare <left> <right>         open a text diff of two files (a binary pair opens".to_owned(),
        "                                       the hex comparison)".to_owned(),
        "  ggs --hex <file>                     open the file in the hex viewer".to_owned(),
        "  ggs --hex-compare <left> <right>     open the hex comparison of two files".to_owned(),
        "  ggs --folder-compare <left> <right>  open two folders in the Folder Compare view".to_owned(),
        "  ggs config [--password pw] [--server url] [--join-key key]".to_owned(),
        "                                       set up Remote Access from a command line (also".to_owned(),
        "                                       as the ggs-config binary): password, relay, links".to_owned(),
        "  ggs --mcp [path]                     serve that repository's symbol database over MCP".to_owned(),
        "  ggs --measure <path>                 run the performance probes headless (JSON on stdout)".to_owned(),
        "  ggs --help, ggs -h                   show this help".to_owned(),
    ]
    .join("\n")
        + "\n"
}
