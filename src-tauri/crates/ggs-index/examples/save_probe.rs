//! TEMP: the watcher save path's A/B timing — one batch's incremental volume write
//! (the dirty-aware reuse) against the full derivation the previous code paid on
//! every batch, over a synthetic tree of N files in the temp dir (nothing lands in
//! any source tree).
//!
//! ```text
//! cargo run -p ggs-index --release --example save_probe -- [files] [batches]
//! ```

use std::path::Path;
use std::time::Instant;

use ggs_index::symbols::index::SymbolIndex;
use ggs_index::symbols::store::SymbolStore;

fn unit_body(i: usize) -> String {
    let mut body = String::new();
    for k in 0..12 {
        body.push_str(&format!(
            "struct Kind{i}_{k} {{ int field_a; int field_b; float field_c; }};\nvoid api_{i}_{k}(Kind{i}_{k} s, int n) {{ use(s.field_a + n); }}\nint helper_{i}_{k}(int x) {{ return x * {k} + 1; }}\n",
        ));
    }
    body.push_str(&format!(
        "int main_{i}(void) {{ Kind{i}_0 t; api_{i}_0(t, 1); return helper_{i}_1(2); }}\n"
    ));
    body
}

fn main() {
    let mut args = std::env::args().skip(1);
    let files_n: usize = args.next().and_then(|v| v.parse().ok()).unwrap_or(2000);
    let batches: usize = args.next().and_then(|v| v.parse().ok()).unwrap_or(5);

    let tree = std::env::temp_dir().join(format!("ggs-save-probe-tree-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&tree);
    std::fs::create_dir_all(tree.join("src")).unwrap();
    for i in 0..files_n {
        std::fs::write(
            tree.join("src").join(format!("unit_{i:05}.cpp")),
            unit_body(i),
        )
        .unwrap();
    }
    let root = tree.display().to_string();
    let home = std::env::temp_dir().join(format!("ggs-save-probe-home-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&home);
    std::fs::create_dir_all(&home).unwrap();

    let started = Instant::now();
    let mut store =
        SymbolStore::build(&root, SymbolIndex::index_threads(false), &|_, _| {}, &|| false)
            .expect("build");
    println!(
        "[build] {files_n} files, {} names in {} ms",
        store.stats().names,
        started.elapsed().as_millis()
    );

    let started = Instant::now();
    store.save(&home).unwrap();
    println!("[full save] {} ms", started.elapsed().as_millis());

    let fingerprints = store.fingerprints();
    let mut incremental_total = 0u128;
    let mut full_total = 0u128;
    for batch in 0..batches {
        let path = fingerprints[files_n / 3 + batch].0.clone();
        let full = Path::new(&root).join(&path);
        let existing = std::fs::read_to_string(&full).unwrap_or_default();
        std::fs::write(&full, format!("{existing}// probe touch {batch}\n")).unwrap();

        store.apply_changes(&[path]);

        let started = Instant::now();
        let snapshot = store.save_snapshot();
        SymbolStore::write_volumes(&snapshot, &home).unwrap();
        incremental_total += started.elapsed().as_millis();

        let started = Instant::now();
        let snapshot = store.save_snapshot_full();
        SymbolStore::write_volumes(&snapshot, &home).unwrap();
        full_total += started.elapsed().as_millis();
    }
    println!(
        "[batch] incremental avg {} ms vs full-derivation avg {} ms over {batches} batches",
        incremental_total / batches as u128,
        full_total / batches as u128
    );
    let _ = std::fs::remove_dir_all(&tree);
    let _ = std::fs::remove_dir_all(&home);
}
