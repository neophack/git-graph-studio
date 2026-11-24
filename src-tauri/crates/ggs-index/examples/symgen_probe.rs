//! TEMP: per-file hang locator for the nine-volume save path — walks a root and runs the
//! save path's per-file work (signature records + the symgen skeleton scan) one file at
//! a time under a watchdog, timing each file so a hang names its file exactly.
//!
//! ```text
//! cargo run -p ggs-index --example symgen_probe -- <root> [per-file-timeout-secs]
//! ```

use std::io::Write;
use std::time::{Duration, Instant};

use ggs_fs::walk_files;
use ggs_index::scan::is_symbol_source;
use ggs_index::symbols::projvol_sig;
use ggs_index::symbols::symgen;

fn main() {
    let mut args = std::env::args().skip(1);
    let root = args.next().expect("usage: symgen_probe <root> [timeout-secs]");
    let timeout = args
        .next()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(20);

    let started = Instant::now();
    let mut files: Vec<String> = walk_files(&root)
        .into_iter()
        .filter(|p| is_symbol_source(p))
        .collect();
    files.sort();
    eprintln!(
        "[probe] {} files, walk+filter in {:.0} ms",
        files.len(),
        started.elapsed().as_secs_f64() * 1000.0
    );

    let mut hung: Vec<String> = Vec::new();
    let mut slowest: Vec<(u128, String)> = Vec::new();
    let mut done = 0usize;
    for path in files.iter() {
        let meta = std::fs::metadata(std::path::Path::new(&root).join(path));
        let size = meta.map(|m| m.len()).unwrap_or(0);
        let rel = path.clone();
        let root_thread = root.clone();
        let (tx, rx) = std::sync::mpsc::channel::<()>();
        std::thread::spawn(move || {
            let raw = std::fs::read(std::path::Path::new(&root_thread).join(&rel))
                .unwrap_or_default();
            let rel_bs = rel.replace('/', "\\");
            let ext = projvol_sig::ext_key(rel_bs.as_bytes());
            let _ = projvol_sig::build_file_records(0, &ext, &raw);
            let feed: Vec<(u32, String)> = vec![(0u32, rel_bs.clone())];
            let _ = symgen::generate_sym_slots_clean(&feed, &mut |_| raw.clone());
            let _ = tx.send(());
        });
        let file_started = Instant::now();
        match rx.recv_timeout(Duration::from_secs(timeout)) {
            Ok(()) => {
                let ms = file_started.elapsed().as_millis();
                done += 1;
                slowest.push((ms, path.clone()));
                slowest.sort_by_key(|(ms, _)| std::cmp::Reverse(*ms));
                slowest.truncate(10);
                if done.is_multiple_of(250) || ms > 1000 {
                    eprintln!("[probe] {}/{} {} ({} bytes) in {} ms", done, files.len(), path, size, ms);
                    let _ = std::io::stderr().flush();
                }
            }
            Err(_) => {
                eprintln!(
                    "[probe] HANG >{}s: {} ({} bytes)",
                    timeout, path, size
                );
                let _ = std::io::stderr().flush();
                hung.push(path.clone());
            }
        }
    }

    eprintln!("[probe] done: {} hung, slowest:", hung.len());
    for (ms, path) in &slowest {
        eprintln!("[probe]   {} ms  {}", ms, path);
    }
    for path in &hung {
        eprintln!("[probe]   HANG {}", path);
    }
}
