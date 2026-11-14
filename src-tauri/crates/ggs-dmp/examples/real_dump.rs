//! The real-dump probe: `real_dump <dump-file> [--scan]` — parses a minidump the way the
//! viewer's open does (streams, modules, memory map) and, with `--scan`, runs the carve
//! pass over its memory regions and prints the hit counts per format. The crate's tests
//! prove the parser against synthetic fixtures; this probe proves it against a real one.
//!
//! ```text
//! cargo run -p ggs-dmp --example real_dump -- "C:\path\to\dump.DMP" --scan
//! ```

use std::collections::BTreeMap;
use std::time::Instant;

use ggs_base::sink::BatchSink;
use ggs_dmp::{carve, Dump, DumpEvent, DumpScanOptions};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let Some(path) = args.get(1) else {
        eprintln!("usage: real_dump <dump-file> [--scan]");
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
        overview.os.arch, overview.os.version, overview.pid, overview.threads, overview.has_exception
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
        println!("  module {} · {} · {}", module.file_name, humans(u64::from(module.size)), module.name);
    }
    let mut biggest = overview.modules.clone();
    biggest.sort_by_key(|m| std::cmp::Reverse(m.size));
    if let Some(m) = biggest.first() {
        if overview.modules.len() > 5 {
            println!("  … biggest: {} · {}", m.file_name, humans(u64::from(m.size)));
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
