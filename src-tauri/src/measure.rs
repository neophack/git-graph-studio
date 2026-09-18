//! The headless performance probe behind `git-graph-studio --measure <folder>`: the phases of
//! opening a folder, timed the way the workbench runs them, printed as one JSON object that
//! `scripts/measure.mjs` folds into `metrics.json` next to the size figures. No window, no
//! webview — just the engine's work in this process, so the numbers are comparable across
//! machines and CI.
//!
//! Phases (each in milliseconds):
//! - `resolveRoot`: the repository root lookup `open_folder` does first;
//! - `walkFiles`: the `.gitignore`-aware parallel walk Quick Open and the search use;
//! - `scmStatus`: the engine's working-tree status (the SCM view's list);
//! - `graphFirstPage`: the graph view's default first `loadCommits` page;
//! - `symbolIndex`: the whole-workspace symbol extraction Go to Definition reads;
//! - `searchTodo`: a literal, case-insensitive search for `TODO` across the tree.

use std::time::Instant;

use serde_json::json;

use crate::{cmd_fs, cmd_search};

fn ms(started: Instant) -> f64 {
    (started.elapsed().as_secs_f64() * 1000.0 * 10.0).round() / 10.0
}

/// Run every probe against `folder` and return the JSON report. The git phases go through the
/// in-process engine exactly as the app runs them; a folder that is not a git repository
/// reports `null` for them while the walk, index and search still run.
pub fn run(folder: &str) -> Result<String, String> {
    let path = std::path::Path::new(folder);
    if !path.is_dir() {
        return Err(format!("{folder} is not a folder"));
    }
    let absolute = std::fs::canonicalize(path)
        .map(|p| {
            p.display()
                .to_string()
                .trim_start_matches(r"\\?\")
                .to_owned()
        })
        .unwrap_or_else(|_| folder.to_owned());

    let started = Instant::now();
    let root = crate::cmd_graph::resolve_repo_root(&absolute);
    let resolve_ms = ms(started);
    let is_repo = root.is_some();
    let root = root.unwrap_or(absolute);

    let started = Instant::now();
    let files = cmd_fs::walk_files(&root);
    let walk_ms = ms(started);

    let (scm_ms, scm_changes) = if is_repo {
        let started = Instant::now();
        let changes = crate::cmd_graph::scm_changes(&root)
            .ok()
            .and_then(|v| v.as_array().map(Vec::len));
        (Some(ms(started)), changes)
    } else {
        (None, None)
    };

    let (graph_ms, commits) = if is_repo {
        let started = Instant::now();
        let count = crate::cmd_graph::load_first_page(&root).ok();
        (Some(ms(started)), count)
    } else {
        (None, None)
    };

    let started = Instant::now();
    let symbols = cmd_search::index_symbols_of(&root).len();
    let symbols_ms = ms(started);

    let started = Instant::now();
    let analysis = crate::analysis::AnalysisData::build(
        &root,
        std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(4),
        &|_, _| {},
        &|| false,
    );
    let analysis_ms = ms(started);
    let (analysis_symbols, analysis_calls) = analysis
        .as_ref()
        .map(|data| (data.symbol_count(), data.call_count()))
        .unwrap_or((0, 0));

    let started = Instant::now();
    let search = cmd_search::search_literal(&files, &root, "TODO")?;
    let search_ms = ms(started);

    // The single-file open path: a synthetic large file through the exact steps the editor's
    // open takes - raw read, encoding-decoding to text, the viewer document build (with its
    // syntax setup) and the first highlighted screen. `GGS_PERF_FILE_MB` sizes it (default
    // 32 MB, the plan's line is 1 GB via the viewer's segmented path, which this measures up
    // to the point the webview takes over).
    let (file_mb, read_ms, decode_ms, viewer_ms, viewer_lines) = large_file_probe();

    let report = json!({
        "folder": root,
        "isRepository": is_repo,
        "engine": crate::cmd_graph::engine_version(),
        "files": files.len(),
        "symbols": symbols,
        "analysisSymbols": analysis_symbols,
        "analysisCalls": analysis_calls,
        "commitsFirstPage": commits,
        "largeFileMb": file_mb,
        "scmChanges": scm_changes,
        "searchMatches": search.files.iter().map(|f| f.matches.len()).sum::<usize>(),
        "ms": {
            "resolveRoot": resolve_ms,
            "walkFiles": walk_ms,
            "scmStatus": scm_ms,
            "graphFirstPage": graph_ms,
            "symbolIndex": symbols_ms,
            "analysisBuild": analysis_ms,
            "searchTodo": search_ms,
            "largeFileRead": read_ms,
            "largeFileDecode": decode_ms,
            "largeFileViewer": viewer_ms
        },
        "largeFileLines": viewer_lines
    });
    serde_json::to_string_pretty(&report).map_err(|e| e.to_string())
}

/// The single-file open probe: write a synthetic text file (repeated code-ish lines, so the
/// syntax highlighter has real work), then time the open path's three phases. Returns
/// `(mb, read_ms, decode_ms, viewer_ms, line_count)`.
fn large_file_probe() -> (u64, f64, f64, f64, usize) {
    let mb: u64 = std::env::var("GGS_PERF_FILE_MB")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(32)
        .clamp(1, 2048);
    let dir = tempfile::tempdir().expect("temp dir");
    let path = dir.path().join("large.rs");
    {
        use std::io::Write;
        let mut file = std::fs::File::create(&path).expect("create");
        let line = b"fn worker(index: usize) -> usize { let doubled = index * 2; doubled + 1 } // TODO measure\n";
        let target = mb as usize * 1024 * 1024;
        let mut written = 0usize;
        while written < target {
            file.write_all(line).expect("write");
            written += line.len();
        }
    }

    let started = Instant::now();
    let bytes = std::fs::read(&path).expect("read");
    let read_ms = ms(started);

    let started = Instant::now();
    let decoded = crate::encoding::decode(&bytes, None);
    let text = decoded.text;
    let decode_ms = ms(started);

    // The viewer document the fast view / outline path builds (syntax set-up included).
    let started = Instant::now();
    let mut doc = crate::viewer::doc::ViewerDoc::new(path, &text, "rs");
    let lines = doc.line_count();
    let _highlighted = doc.highlight_lines(0, 100usize.min(lines.saturating_sub(1)));
    let viewer_ms = ms(started);

    (mb, read_ms, decode_ms, viewer_ms, lines)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn measures_a_plain_folder_and_a_repository() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.rs"), "// TODO one\nfn alpha() {}\n").unwrap();
        let plain: serde_json::Value =
            serde_json::from_str(&run(&dir.path().display().to_string()).unwrap()).unwrap();
        assert_eq!(plain["isRepository"], false);
        assert_eq!(plain["files"], 1);
        assert_eq!(plain["symbols"], 1);
        assert_eq!(plain["searchMatches"], 1);
        assert!(plain["ms"]["scmStatus"].is_null());
        assert!(plain["ms"]["walkFiles"].is_number());
        // The large-file probe always reports (a synthetic file, so it needs no repository).
        assert!(plain["ms"]["largeFileRead"].is_number());
        assert!(plain["ms"]["largeFileViewer"].is_number());
        assert!(plain["largeFileLines"].as_u64().unwrap() > 0);

        // A repository is measured for real: the root resolves, the status and the first page
        // come back through the in-process engine.
        let scratch = crate::test_support::Scratch::new("measure");
        let git = scratch.repo("repo");
        crate::test_support::commit(&git, "b.rs", "fn beta() {} // TODO\n", "second");
        let report: serde_json::Value =
            serde_json::from_str(&run(&git.repo.display().to_string()).unwrap()).unwrap();
        assert_eq!(report["isRepository"], true);
        // The helper's initial commit plus the one made here.
        assert_eq!(report["commitsFirstPage"], 2);
        assert!(report["ms"]["graphFirstPage"].is_number());
        assert_eq!(report["files"], 2);
        // The measurements leave the scratch repository open in the global manager; on Windows
        // an mmap'd pack file would outlive the temp directory's removal.
        crate::cmd_graph::close_engine_repos();
    }
}
