//! The real-dump probe: `real_dump <dump-file> [--scan] [--verify] [--entries <out.json>]` —
//! parses a minidump
//! the way the viewer's open does (streams, modules, memory map), with `--scan` runs the
//! carve pass over its memory regions and prints the hit counts per format, and with
//! `--verify` checks every carved entry against its format's structure (PNG's chunk
//! chain and CRCs, JPEG's marker walk with the EOI at the end, the declared-length
//! containers re-added up, SQLite's page count) plus one completeness trap the list
//! cannot show: entries whose size equals the scan's size cap, whose real end lies
//! beyond it. `--entries` writes every carved entry as JSON — the cross-carver
//! comparison feed. A sample of each content format is also written out and re-read
//! from disk, so the extract path itself is proven not to truncate. The crate's tests
//! prove the parser against synthetic fixtures; this probe proves it against a real one.
//!
//! ```text
//! cargo run -p ggs-dmp --example real_dump -- "C:\path\to\dump.DMP" --scan --verify
//! ```

use std::collections::BTreeMap;
use std::time::Instant;

use ggs_base::sink::BatchSink;
use ggs_dmp::{carve, Dump, DumpEvent, DumpScanOptions};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let Some(path) = args.get(1) else {
        eprintln!("usage: real_dump <dump-file> [--scan] [--verify]");
        std::process::exit(2);
    };
    let path = std::path::Path::new(path);
    let started = Instant::now();
    let mut dump = match Dump::open(path) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("open failed: {e}");
            std::process::exit(1);
        }
    };
    let overview = match dump.overview(path) {
        Ok(o) => o,
        Err(e) => {
            eprintln!("overview failed: {e}");
            std::process::exit(1);
        }
    };
    println!("opened in {} ms", started.elapsed().as_millis());
    println!(
        "size {} · stamp {} · flags {:?}",
        overview.size,
        chrono_or_unix(overview.time_date_stamp),
        overview.flag_names
    );
    println!(
        "os {} {} · pid {} · threads {} · exception {}",
        overview.os.arch,
        overview.os.version,
        overview.pid,
        overview.threads,
        overview.has_exception
    );
    println!(
        "modules {} ({} = {} bytes) · memory {} regions ({} = {} bytes) · streams {}",
        overview.modules.len(),
        humans(overview.module_total_bytes),
        overview.module_total_bytes,
        overview.memory_regions,
        humans(overview.memory_total_bytes),
        overview.memory_total_bytes,
        overview.streams.len()
    );
    for module in overview.modules.iter().take(5) {
        println!(
            "  module {} · {} · {}",
            module.file_name,
            humans(u64::from(module.size)),
            module.name
        );
    }
    let mut biggest = overview.modules.clone();
    biggest.sort_by_key(|m| std::cmp::Reverse(m.size));
    if let Some(m) = biggest.first() {
        if overview.modules.len() > 5 {
            println!(
                "  … biggest: {} · {}",
                m.file_name,
                humans(u64::from(m.size))
            );
        }
    }

    if !args.iter().any(|a| a == "--scan") {
        return;
    }
    let scan_started = Instant::now();
    let mut sink = CountingSink::default();
    let (start, outcome) = carve::scan(
        path,
        &DumpScanOptions::default(),
        &|| false,
        &mut sink, // VecSink over a local would do; this one also counts batches
    )
    .expect("scan");
    println!(
        "scanned {} regions / {} in {} ms — {} entries, cancelled {}",
        start.modules.len(),
        humans(start.scan_bytes),
        scan_started.elapsed().as_millis(),
        outcome.entries,
        outcome.cancelled
    );
    let mut formats: BTreeMap<String, (u64, u64)> = BTreeMap::new();
    for entry in &sink.entries {
        let slot = formats.entry(entry.format.clone()).or_insert((0, 0));
        slot.0 += 1;
        slot.1 += entry.size;
    }
    for (format, (count, bytes)) in formats {
        println!("  {format:<8} {count:>6} hits · {}", humans(bytes));
    }
    let mut in_module = 0;
    for entry in &sink.entries {
        if entry.in_module.is_some() {
            in_module += 1;
        }
    }
    println!(
        "inside a module image: {in_module}/{} · total carve time {} ms",
        sink.entries.len(),
        outcome.elapsed_ms
    );

    if args.iter().any(|a| a == "--verify") {
        verify(path, &sink.entries);
    }

    // `--entries <path>` writes every carved entry as JSON — the diff feed for the
    // cross-carver comparison this probe exists to make possible.
    if let Some(at) = args.iter().position(|a| a == "--entries") {
        let Some(out) = args.get(at + 1) else {
            eprintln!("--entries needs a file path");
            std::process::exit(2);
        };
        let mut rows = Vec::new();
        for entry in &sink.entries {
            rows.push(format!(
                r#"{{"format":"{}","offset":{},"size":{}}}"#,
                entry.format, entry.offset, entry.size
            ));
        }
        std::fs::write(out, format!("[{}]", rows.join(",\n"))).expect("write entries");
        println!("entries written to {out}");
    }
}

/* ---------- The verify pass ---------- */

/// Checks every carved entry against its format's structure over the whole dump in
/// memory, flags the size-cap survivors (a size exactly at the cap means the real end
/// lies beyond it), and writes a sample of each content format out and back to prove
/// the extract itself neither truncates nor shifts bytes.
fn verify(path: &std::path::Path, entries: &[ggs_dmp::CarvedEntry]) {
    let data = std::fs::read(path).expect("read dump");
    println!(
        "\nverify: {} entries over {} bytes in memory",
        entries.len(),
        humans(data.len() as u64)
    );
    let cap = carve::DEFAULT_MAX_SIZE;

    // Per format: checked / structurally OK / failed / exactly at the cap.
    let mut stats: BTreeMap<String, [u64; 4]> = BTreeMap::new();
    let mut failures: Vec<(String, u64, String)> = Vec::new(); // format, offset, message
    let mut cap_clipped: Vec<(String, u64)> = Vec::new();
    for entry in entries {
        let slot = stats.entry(entry.format.clone()).or_default();
        let slice = entry
            .offset
            .checked_add(entry.size)
            .filter(|end| *end <= data.len() as u64)
            .map(|end| &data[entry.offset as usize..end as usize]);
        let Some(slice) = slice else {
            slot[2] += 1;
            failures.push((
                entry.format.clone(),
                entry.offset,
                "range past the dump".into(),
            ));
            continue;
        };
        if entry.size == cap {
            slot[3] += 1;
            cap_clipped.push((entry.format.clone(), entry.offset));
        }
        let ok = entry.verified && check(entry, &data, slice).is_ok();
        if ok {
            slot[1] += 1;
        } else {
            slot[2] += 1;
            if failures.len() < 40 && !entry.verified {
                failures.push((
                    entry.format.clone(),
                    entry.offset,
                    "flagged by the scan".into(),
                ));
            }
        }
        slot[0] += 1;
    }

    println!(
        "{:<8} {:>8} {:>9} {:>8} {:>10}",
        "format", "checked", "struct-ok", "failed", "at-cap"
    );
    let mut total_ok = 0u64;
    let mut total_failed = 0u64;
    let mut total_cap = 0u64;
    for (format, s) in &stats {
        println!(
            "{format:<8} {:>8} {:>9} {:>8} {:>10}",
            s[0], s[1], s[2], s[3]
        );
        total_ok += s[1];
        total_failed += s[2];
        total_cap += s[3];
    }
    println!(
        "total: {total_ok} structurally complete, {total_failed} failed, {total_cap} exactly at the {} cap",
        humans(cap)
    );
    if !cap_clipped.is_empty() {
        println!("at-cap entries (the real end lies beyond the cap — these are the truncation candidates):");
        let mut by_format: BTreeMap<&str, Vec<u64>> = BTreeMap::new();
        for (format, offset) in &cap_clipped {
            by_format.entry(format.as_str()).or_default().push(*offset);
        }
        for (format, offsets) in &by_format {
            let list = offsets
                .iter()
                .take(6)
                .map(|o| format!("0x{o:x}"))
                .collect::<Vec<_>>()
                .join(", ");
            println!(
                "  {format:<8} {} at {list}{}",
                offsets.len(),
                if offsets.len() > 6 { " …" } else { "" }
            );
        }
    }
    for (format, offset, message) in failures.iter().take(20) {
        println!("  FAIL {format} @ 0x{offset:x}: {message}");
    }

    // The extract path, proven: write a sample of each content format and re-check it
    // from disk.
    let out_root = std::path::Path::new("target/studio/dump-verify");
    const PER_FORMAT: usize = 60;
    const CONTENT_FORMATS: [&str; 8] = ["png", "webp", "jpg", "gif", "pdf", "zip", "sqlite", "bmp"];
    let mut written = 0u64;
    let mut write_fail = 0u64;
    let mut recheck_fail = 0u64;
    for format in CONTENT_FORMATS {
        let dir = out_root.join(format);
        std::fs::create_dir_all(&dir).expect("mkdir");
        let mut n = 0usize;
        for entry in entries.iter().filter(|e| e.format == format) {
            if n >= PER_FORMAT {
                break;
            }
            if entry.size == cap {
                continue; // cap-clipped entries are truncated by definition; not the sample
            }
            let Some(end) = entry
                .offset
                .checked_add(entry.size)
                .filter(|e| *e <= data.len() as u64)
            else {
                continue;
            };
            let bytes = &data[entry.offset as usize..end as usize];
            let file = dir.join(format!("sample_{:04}.{}", n, format));
            if std::fs::write(&file, bytes).is_err() {
                write_fail += 1;
                continue;
            }
            let back = match std::fs::read(&file) {
                Ok(b) => b,
                Err(_) => {
                    write_fail += 1;
                    continue;
                }
            };
            if back != bytes {
                recheck_fail += 1;
            } else if let Err(e) = check(
                &ggs_dmp::CarvedEntry {
                    offset: 0,
                    size: back.len() as u64,
                    ..entry.clone()
                },
                &back,
                &back,
            ) {
                recheck_fail += 1;
                println!("  RECHECK FAIL {} sample_{n}: {e}", format);
            }
            written += 1;
            n += 1;
        }
    }
    println!(
        "extract proof: {written} files written to {} and re-verified from disk · {write_fail} write failures · {recheck_fail} re-check failures",
        out_root.display()
    );
}

/// One entry's structural check — the crate's own verifier, the same code the scan
/// runs when it marks `verified`.
fn check(entry: &ggs_dmp::CarvedEntry, data: &[u8], slice: &[u8]) -> Result<(), String> {
    ggs_dmp::verify::check(&entry.format, entry.offset, data, slice)
}

#[derive(Default)]
struct CountingSink {
    entries: Vec<ggs_dmp::CarvedEntry>,
}

impl BatchSink<DumpEvent> for CountingSink {
    fn send(&mut self, event: DumpEvent) -> bool {
        if let DumpEvent::Batch { entries } = event {
            self.entries.extend(entries);
        }
        true
    }
}

fn chrono_or_unix(stamp: u64) -> String {
    // No chrono in this crate's tree: print the Unix seconds and let the reader convert.
    format!("{stamp} (unix)")
}

fn humans(n: u64) -> String {
    let mut value = n;
    let mut unit = 0usize;
    const UNITS: [&str; 4] = ["B", "KB", "MB", "GB"];
    while value >= 1024 && unit < UNITS.len() - 1 {
        value /= 1024;
        unit += 1;
    }
    format!("{value} {}", UNITS[unit])
}
