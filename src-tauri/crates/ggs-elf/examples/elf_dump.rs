//! The ELF Inspector's real-file probe: `elf_dump <file.elf> [more.elf …]` parses each
//! image through the same `open_doc` the app command runs and prints what the view
//! would show — the header facts, the footprint sums, the segments, the sections and
//! the largest symbols — so a shipping firmware can be checked against a reference
//! reader without opening the app.

use std::path::Path;

fn main() {
    let paths: Vec<String> = std::env::args().skip(1).collect();
    if paths.is_empty() {
        eprintln!("usage: elf_dump <file.elf> [more.elf …]");
        std::process::exit(2);
    }
    for path in paths {
        println!("=== {} ===", path);
        let doc = match ggs_elf::open_doc(Path::new(&path)) {
            Ok(doc) => doc,
            Err(e) => {
                println!("  ERROR: {e}");
                continue;
            }
        };
        println!(
            "  header : {}-bit {}, type {}, machine {}, entry {:#x}, file {}",
            doc.class_bits,
            if doc.little_endian { "LE" } else { "BE" },
            doc.file_type,
            doc.machine_name,
            doc.entry,
            human(doc.total_bytes)
        );
        println!(
            "  footprint: ROM {} · RAM {} (alloc-only sums)",
            human(doc.rom_bytes),
            human(doc.ram_bytes)
        );
        println!(
            "  symbols: {} kept of {} listed; needs: {}",
            doc.symbols.len(),
            doc.symbols_total,
            if doc.needed.is_empty() { "—".to_string() } else { doc.needed.join(", ") }
        );
        println!("  segments ({}):", doc.segments.len());
        for s in &doc.segments {
            println!(
                "    {:<12} {:<3} off {:#010x} vaddr {:#010x} file {:>9} mem {:>9}",
                s.kind,
                s.flags,
                s.offset,
                s.vaddr,
                human(s.file_bytes),
                human(s.mem_bytes)
            );
        }
        println!("  sections ({}):", doc.sections.len());
        for s in &doc.sections {
            let flags = format!("{}{}{}", if s.alloc { "A" } else { "" }, if s.write { "W" } else { "" }, if s.exec { "X" } else { "" });
            println!(
                "    {:<22} {:<12} addr {:#010x} size {:>9} {:<3}",
                if s.name.is_empty() { "(unnamed)" } else { &s.name },
                s.kind,
                s.addr,
                human(s.size),
                flags
            );
        }
        println!("  largest symbols:");
        for sym in doc.symbols.iter().take(15) {
            println!(
                "    {:>9}  {:#010x}  {:<6} {:<6} {}",
                human(sym.size),
                sym.value,
                sym.kind,
                sym.bind,
                sym.name
            );
        }
        println!();
    }
}

fn human(bytes: u64) -> String {
    if bytes >= 1024 * 1024 {
        format!("{:.1} MB", bytes as f64 / 1024.0 / 1024.0)
    } else if bytes >= 1024 {
        format!("{:.1} KB", bytes as f64 / 1024.0)
    } else {
        format!("{bytes} B")
    }
}
