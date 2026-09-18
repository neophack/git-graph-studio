//! The performance gate (docs/ggs-development-plan.md §4, M2.8): a synthetic repository of
//! `GGS_PERF_FILES` files (default 5,000, CI runs 20,000; the plan's line is drawn at 100,000) is built with
//! git, then every phase of opening it is timed the way the app runs it - the walk, the text
//! search, the symbol index in this process, and the repository root, the SCM status and the
//! graph's first page through the plugin backend process - and checked against budgets that
//! scale with the file count. Debug builds get an 8× allowance (this runs in `cargo test`);
//! `cargo test --release --test perf -- --nocapture` measures the shipped speed. The numbers
//! are printed as JSON and written to target/studio/perf.json.
//!
//! Run the plan's full-size line with `GGS_PERF_FILES=100000` (a few minutes, mostly git).

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Instant;

use git_graph_studio_lib::{cmd_fs, cmd_search};
use serde_json::json;

fn git(repo: &Path, args: &[&str]) {
    let status = Command::new("git")
        .args(args)
        .current_dir(repo)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_AUTHOR_NAME", "Perf")
        .env("GIT_AUTHOR_EMAIL", "perf@example.com")
        .env("GIT_COMMITTER_NAME", "Perf")
        .env("GIT_COMMITTER_EMAIL", "perf@example.com")
        .stdout(std::process::Stdio::null())
        .status()
        .expect("git runs");
    assert!(status.success(), "git {args:?} failed");
}

/// A tree of `files` source files, 40 per folder, three levels deep, each with a few
/// functions (for the symbol index) and every 10th with a TODO (for the search).
fn synthetic_repo(files: usize) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let started = Instant::now();
    for i in 0..files {
        let folder = root
            .join(format!("mod{}", i / 1600))
            .join(format!("sub{}", (i / 40) % 40));
        std::fs::create_dir_all(&folder).unwrap();
        let ext = ["rs", "ts", "py", "c"][i % 4];
        let todo = if i % 10 == 0 {
            "// TODO: revisit\n"
        } else {
            ""
        };
        let body = match ext {
            "rs" => format!("{todo}pub fn item_{i}() -> u32 {{ {i} }}\nfn helper_{i}(x: u32) -> u32 {{ x + 1 }}\n"),
            "ts" => format!("{todo}export function item{i}(): number {{ return {i}; }}\nclass Thing{i} {{ run(): void {{}} }}\n"),
            "py" => format!("# {}\ndef item_{i}():\n    return {i}\n\nclass Thing{i}:\n    pass\n", if i % 10 == 0 { "TODO: revisit" } else { "module" }),
            _ => format!("{todo}int item_{i}(void) {{ return {i}; }}\nstatic int helper_{i}(int x) {{ return x + 1; }}\n"),
        };
        std::fs::write(folder.join(format!("file{i}.{ext}")), body).unwrap();
    }
    git(root, &["init", "-q", "-b", "main"]);
    git(root, &["add", "-A"]);
    git(root, &["commit", "-q", "-m", "synthetic tree"]);
    // A few more commits so the graph has a history to page.
    for n in 0..6 {
        let i = n * 4; // every fourth file is Rust
        std::fs::write(
            root.join(format!("mod0/sub{}/file{i}.rs", i / 40)),
            format!("pub fn item_{i}() -> u32 {{ {i} + 1 }}\n"),
        )
        .unwrap();
        git(root, &["commit", "-q", "-am", &format!("change {n}")]);
    }
    // The working tree has a change, so the status has something to find.
    std::fs::write(
        root.join("mod0/sub2/file80.rs"),
        "pub fn item_80() -> u32 { 81 }\n",
    )
    .unwrap();
    eprintln!(
        "[perf] synthetic repository of {files} files built in {:.1} s",
        started.elapsed().as_secs_f64()
    );
    dir
}

fn ms(started: Instant) -> f64 {
    (started.elapsed().as_secs_f64() * 1000.0 * 10.0).round() / 10.0
}

#[test]
fn opening_a_large_repository_stays_within_the_budgets() {
    let files: usize = std::env::var("GGS_PERF_FILES")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(5_000);
    let repo = synthetic_repo(files);
    let root = repo.path().display().to_string();
    // Debug builds of the walk / search / index are several times slower than the shipped
    // profile; the budgets below are the plan's release lines with that allowance.
    let allowance = if cfg!(debug_assertions) { 8.0 } else { 1.0 };
    let per_file = files as f64 / 100_000.0;

    let started = Instant::now();
    let list = cmd_fs::walk_files(&root);
    let walk_ms = ms(started);
    assert_eq!(list.len(), files, "the walk lists every file");

    // The floor of every content phase: reading every file once, in parallel, with nothing
    // done to the bytes. On Windows this is dominated by the filesystem and the antivirus
    // (tens of microseconds per file), so the search and the index are budgeted as multiples
    // of it rather than as absolute times the machine may not be able to deliver.
    let started = Instant::now();
    let bytes: usize = {
        use rayon::prelude::*;
        list.par_iter()
            .map(|relative| {
                std::fs::read(Path::new(&root).join(relative))
                    .map(|b| b.len())
                    .unwrap_or(0)
            })
            .sum()
    };
    let raw_read_ms = ms(started);
    assert!(bytes > 0);

    let started = Instant::now();
    let search = cmd_search::search_literal(&list, &root, "TODO").unwrap();
    let search_ms = ms(started);
    let hits: usize = search.files.iter().map(|f| f.matches.len()).sum();
    // Every 10th file carries a TODO, minus the few the extra commits rewrote.
    assert!(
        hits >= files / 10 - 8,
        "every 10th file carries a TODO ({hits} found)"
    );

    let started = Instant::now();
    let symbols = cmd_search::index_symbols_of(&root);
    let index_ms = ms(started);
    assert!(
        symbols.len() >= files,
        "at least one symbol per file ({} found)",
        symbols.len()
    );

    // The Code Analysis build (module 17): the same tree-sitter parse plus the call-edge
    // derivation — budgeted like the symbol index, with room for the edge pass.
    let started = Instant::now();
    let analysis = git_graph_studio_lib::analysis::AnalysisData::build(
        &root,
        std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(4),
        &|_, _| {},
        &|| false,
    )
    .expect("the analysis builds");
    let analysis_ms = ms(started);
    assert!(
        analysis.symbol_count() >= files,
        "at least one symbol per file in the analysis"
    );

    // The engine phases run in-process, exactly as the app runs them (the engine is linked
    // into the app; there is no backend process).
    let started = Instant::now();
    let resolved = git_graph_studio_lib::cmd_graph::resolve_repo_root(&format!("{root}/mod0"));
    let root_ms = ms(started);
    assert!(resolved.is_some());

    let started = Instant::now();
    let status = git_graph_studio_lib::cmd_graph::scm_changes(&root).unwrap();
    let status_ms = ms(started);
    assert_eq!(
        status.as_array().map(Vec::len),
        Some(1),
        "one modified file"
    );

    let started = Instant::now();
    let commits = git_graph_studio_lib::cmd_graph::load_first_page(&root).unwrap();
    let first_page_ms = ms(started);
    assert_eq!(commits, 8, "7 commits plus the uncommitted-changes row");

    let started = Instant::now();
    let commits_again = git_graph_studio_lib::cmd_graph::load_first_page(&root).unwrap();
    let warm_page_ms = ms(started);
    assert_eq!(commits_again, 8);

    let report = json!({
        "files": files,
        "profile": if cfg!(debug_assertions) { "debug" } else { "release" },
        "ms": {
            "walkFiles": walk_ms,
            "rawReadAllFiles": raw_read_ms,
            "searchTodo": search_ms,
            "symbolIndex": index_ms,
            "analysisBuild": analysis_ms,
            "repoRoot": root_ms,
            "scmStatus": status_ms,
            "graphFirstPage": first_page_ms,
            "graphFirstPageWarm": warm_page_ms
        }
    });
    let text = serde_json::to_string_pretty(&report).unwrap();
    eprintln!("[perf] {text}");
    let out = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../target/studio");
    if std::fs::create_dir_all(&out).is_ok() {
        let _ = std::fs::write(out.join("perf.json"), &text);
    }

    // The plan's section-4 lines, scaled to the file count (100,000 files = the line itself).
    let budget =
        |per_100k_ms: f64, floor_ms: f64| (per_100k_ms * per_file).max(floor_ms) * allowance;
    assert!(walk_ms <= budget(1500.0, 300.0), "walk {walk_ms} ms");
    // Content phases: no more than a small multiple of the raw read (plus a CPU floor).
    assert!(
        search_ms <= (2.0 * raw_read_ms + 300.0) * allowance,
        "search {search_ms} ms against a raw read of {raw_read_ms} ms"
    );
    assert!(
        index_ms <= (3.0 * raw_read_ms + 1500.0) * allowance,
        "symbol index {index_ms} ms against a raw read of {raw_read_ms} ms"
    );
    assert!(
        analysis_ms <= (4.0 * raw_read_ms + 2500.0) * allowance,
        "analysis build {analysis_ms} ms against a raw read of {raw_read_ms} ms"
    );
    assert!(root_ms <= budget(1000.0, 300.0), "repo root {root_ms} ms");
    assert!(
        status_ms <= budget(3000.0, 500.0),
        "scm status {status_ms} ms"
    );
    assert!(
        first_page_ms <= budget(1500.0, 500.0),
        "graph first page {first_page_ms} ms"
    );
    assert!(
        warm_page_ms <= 150.0 * allowance,
        "warm graph first page {warm_page_ms} ms"
    );
}
