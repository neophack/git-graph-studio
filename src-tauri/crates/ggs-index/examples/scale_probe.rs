//! TEMP: scaling probe for the nine-volume save's full-set work — feeds the first K
//! files of a walk through `generate_sym_slots_clean` and times it, so the curve
//! (linear vs quadratic) names the complexity directly.
//!
//! ```text
//! cargo run -p ggs-index --example scale_probe -- <root> <k1> <k2> ...
//! ```

use std::time::Instant;

use ggs_fs::walk_files;
use ggs_index::scan::is_symbol_source;
use ggs_index::symbols::symgen;

fn main() {
    let mut args = std::env::args().skip(1);
    let root = args.next().expect("usage: scale_probe <root> <k...>");
    let ks: Vec<usize> = args.map(|v| v.parse().expect("k")).collect();

    let mut files: Vec<String> = walk_files(&root)
        .into_iter()
        .filter(|p| is_symbol_source(p))
        .collect();
    files.sort();

    for k in ks {
        let feed: Vec<(u32, String)> = files
            .iter()
            .take(k)
            .enumerate()
            .map(|(fid, p)| (fid as u32, p.replace('/', "\\")))
            .collect();
        let root2 = root.clone();
        let started = Instant::now();
        let slots = symgen::generate_sym_slots_clean(&feed, &mut |rel| {
            std::fs::read(std::path::Path::new(&root2).join(rel.replace('\\', "/")))
                .unwrap_or_default()
        });
        let ms = started.elapsed().as_millis();
        println!("[scale] k={} slots={} in {} ms", k, slots.len(), ms);
    }
}
