//! Stage-by-stage timing of everything the app does between launch and a usable window, so
//! optimization effort lands on the slowest stage instead of guesses. Run with:
//! `cargo test --release stage_bench -- --ignored --nocapture`
#![cfg(test)]

use std::fs;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use crate::cmd_fs::{cached_file_list, walk_files, FileListCache};
use crate::git::Git;

fn ms(started: Instant) -> f64 {
    started.elapsed().as_secs_f64() * 1000.0
}

/// The repository this crate lives in, as a stand-in for a freshly opened folder.
fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .canonicalize()
        .unwrap()
}

/// The pre-optimization walk: a single-threaded depth-first pass, kept here as the baseline
/// `walk_files` is measured against.
fn serial_walk(root: &str, skipped: &[&str], cap: usize) -> Vec<String> {
    let root_path = PathBuf::from(root);
    let mut files = Vec::new();
    let mut pending = vec![root_path.clone()];
    while let Some(dir) = pending.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(kind) = entry.file_type() else { continue };
            let name = entry.file_name().to_string_lossy().into_owned();
            if kind.is_dir() {
                if !skipped.contains(&name.as_str()) {
                    pending.push(entry.path());
                }
            } else if kind.is_file() {
                if let Ok(relative) = entry.path().strip_prefix(&root_path) {
                    files.push(relative.to_string_lossy().replace('\\', "/"));
                    if files.len() >= cap {
                        return files;
                    }
                }
            }
        }
    }
    files
}

#[test]
#[ignore = "measurement, not an assertion: prints per-stage timings"]
fn stage_timings() {
    let root = repo_root();
    let root_str = root.display().to_string().trim_start_matches(r"\\?\").to_string();
    println!("== stage timings on {root_str} ==");

    // list_dir of the root: the explorer's first paint waits on exactly this.
    let t = Instant::now();
    let entries = fs::read_dir(&root).unwrap().count();
    println!("{:>28} {:>10.1} ms ({} entries)", "list_dir(root)", ms(t), entries);

    // The Quick Open walk: old serial baseline, new parallel walk (cold and OS-warm), cache hit.
    const SKIPPED: &[&str] = &[".git", "node_modules", "target", "out", "dist", ".svn", ".hg", "bower_components"];
    let t = Instant::now();
    let serial = serial_walk(&root_str, SKIPPED, 20_000);
    println!("{:>28} {:>10.1} ms ({} files)", "list_files(serial, cold)", ms(t), serial.len());
    let t = Instant::now();
    let parallel = walk_files(&root_str);
    println!("{:>28} {:>10.1} ms ({} files)", "list_files(parallel, warm)", ms(t), parallel.len());
    let t = Instant::now();
    let _ = walk_files(&root_str);
    println!("{:>28} {:>10.1} ms", "list_files(parallel, warm2)", ms(t));
    let cache = FileListCache::default();
    let t = Instant::now();
    let _ = cached_file_list(&cache, &root_str, Duration::from_secs(5), walk_files);
    println!("{:>28} {:>10.1} ms", "list_files(cache miss)", ms(t));
    let t = Instant::now();
    let _ = cached_file_list(&cache, &root_str, Duration::from_secs(5), walk_files);
    println!("{:>28} {:>10.1} ms", "list_files(cache hit)", ms(t));

    // The SCM refresh and the status-bar branch: separate git subprocesses, as the commands run them.
    let git = Git::new(&root);
    for args in [
        vec!["status", "--porcelain", "--untracked-files=all"],
        vec!["rev-parse", "--short", "HEAD"],
        vec!["symbolic-ref", "--short", "-q", "HEAD"],
        vec!["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
        vec!["rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
    ] {
        let t = Instant::now();
        let _ = git.output(&args);
        println!("{:>28} {:>10.1} ms", format!("git {}", args[0]), ms(t));
    }

    // repo_head as the command runs it now: one `git status --porcelain=v2 --branch`.
    let t = Instant::now();
    let _ = git.output(&["status", "--porcelain=v2", "--branch"]);
    println!("{:>28} {:>10.1} ms", "repo_head(1x git)", ms(t));
}
