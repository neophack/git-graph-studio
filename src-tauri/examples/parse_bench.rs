//! TEMP: per-file parse timing across src/ggs_bash, sorted — finds the pathological
//! file behind the analysisBuild regression (1150 → 2520 ms).
use std::time::Instant;

fn main() {
    let dir = std::path::Path::new("src/ggs_bash");
    let mut rows: Vec<(String, u64, u128, usize)> = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).unwrap() {
            let entry = entry.unwrap();
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            let Some(ext) = path.extension().and_then(|e| e.to_str()) else {
                continue;
            };
            if ext != "rs" {
                continue;
            }
            let text = std::fs::read_to_string(&path).unwrap();
            let bytes = text.len() as u64;
            let started = Instant::now();
            let parsed = git_graph_studio_lib::symbols::parse::parse_file(&text, "rs");
            let micros = started.elapsed().as_micros();
            rows.push((
                path.file_name().unwrap().to_string_lossy().to_string(),
                bytes,
                micros,
                parsed.symbols.len() + parsed.calls.len(),
            ));
        }
    }
    rows.sort_by_key(|r| std::cmp::Reverse(r.2));
    println!(
        "{:<24} {:>9} {:>10} {:>8}",
        "file", "bytes", "parse µs", "defs"
    );
    for (name, bytes, micros, defs) in &rows {
        println!("{:<24} {:>9} {:>10} {:>8}", name, bytes, micros, defs);
    }
    let total: u128 = rows.iter().map(|r| r.2).sum();
    println!("{:-<52}", "");
    println!(
        "{:<24} {:>9} {:>10} {:>8}",
        "TOTAL",
        rows.iter().map(|r| r.1).sum::<u64>(),
        total,
        rows.iter().map(|r| r.3).sum::<usize>()
    );
}
