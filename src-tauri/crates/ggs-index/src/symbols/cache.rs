//! The in-memory symbol cache: the whole-workspace rebuild that serves the window before
//! the persistent index lands (and the `--measure` probe's fresh build). One file per
//! rayon task; read errors are skipped - the index is best-effort.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use rayon::prelude::*;

use crate::scan::SYMBOL_EXTENSIONS;
use crate::symbols::parse;
use crate::symbols::WorkspaceSymbol;

/// How long the symbol index stays fresh between queries.
const SYMBOL_TTL: Duration = Duration::from_secs(30);

/// The per-root symbol index cache (a multi-root workspace keeps one slot per root): which
/// folder each index was built for, when, and the symbols.
#[derive(Default)]
pub struct SymbolCache(Mutex<HashMap<String, (Instant, Vec<WorkspaceSymbol>)>>);

impl SymbolCache {
    /// Drop the index: a source file changed on disk, or the folder was switched.
    pub fn invalidate(&self) {
        self.0.lock().unwrap().clear();
    }
}

/// Build the whole-workspace symbol list, one file per rayon task. Files the extractor does
/// not know contribute nothing, and read errors are skipped - the index is best-effort.
fn index_symbols(root: &str) -> Vec<WorkspaceSymbol> {
    let files: Vec<String> = ggs_fs::walk_files(root)
        .into_iter()
        .filter(|file| {
            let ext = file.rsplit('.').next().unwrap_or("");
            SYMBOL_EXTENSIONS.contains(&ext)
        })
        .collect();
    let indexed: Vec<Vec<WorkspaceSymbol>> = files
        .into_par_iter()
        .map(|relative| {
            let path = PathBuf::from(root).join(&relative);
            let Ok(text) = fs::read_to_string(&path) else {
                return Vec::new();
            };
            let ext = relative.rsplit('.').next().unwrap_or("").to_owned();
            parse::parse_symbols(&text, &ext)
                .into_iter()
                .map(|s| WorkspaceSymbol {
                    kind: s.kind.to_owned(),
                    name: s.name,
                    path: relative.clone(),
                    line: s.line,
                    column: s.column,
                    end_line: s.end_line,
                    container: s.container,
                })
                .collect()
        })
        .collect();
    let mut all: Vec<WorkspaceSymbol> = indexed.into_iter().flatten().collect();
    all.sort_by(|a, b| a.path.cmp(&b.path).then(a.line.cmp(&b.line)));
    all
}

/// The whole-workspace symbol index of a folder, built fresh (the `--measure` probe).
pub fn index_symbols_of(root: &str) -> Vec<WorkspaceSymbol> {
    index_symbols(root)
}

/// Serve the symbol index from the per-folder cache when it is fresh; otherwise rebuild it.
pub fn cached_symbols(root: &str, cache: &SymbolCache) -> Vec<WorkspaceSymbol> {
    {
        let cached = cache.0.lock().unwrap();
        if let Some((at, symbols)) = cached.get(root) {
            if at.elapsed() < SYMBOL_TTL {
                return symbols.clone();
            }
        }
    }
    let symbols = index_symbols(root);
    cache
        .0
        .lock()
        .unwrap()
        .insert(root.to_owned(), (Instant::now(), symbols.clone()));
    symbols
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn index_symbols_extracts_rust_functions() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("lib.rs"),
            "pub fn alpha() {}\nfn beta() {}\n",
        )
        .unwrap();
        let symbols = index_symbols(&dir.path().display().to_string());
        let names: Vec<&str> = symbols.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, ["alpha", "beta"]);
        assert_eq!(symbols[0].path, "lib.rs");
        assert_eq!(symbols[0].line, 0);
        assert_eq!(symbols[0].kind, "function");
    }

    #[test]
    fn cached_symbols_rebuild_after_the_ttl_only() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("lib.rs"), "fn alpha() {}\n").unwrap();
        let root = dir.path().display().to_string();
        let cache = SymbolCache::default();
        let first = cached_symbols(&root, &cache);
        assert_eq!(first.len(), 1);
        // Within the TTL the cache serves the same list even after the file changed.
        std::fs::write(dir.path().join("lib.rs"), "fn beta() {}\n").unwrap();
        let cached = cached_symbols(&root, &cache);
        assert_eq!(cached[0].name, "alpha");
        cache.invalidate();
        let rebuilt = cached_symbols(&root, &cache);
        assert_eq!(rebuilt[0].name, "beta");
    }
}
