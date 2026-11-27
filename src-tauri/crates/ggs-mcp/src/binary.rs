//! P1 MCP tools: hardcore binary & systems engineering senses for AI agents.
//!
//! Exposes Git Graph Studio's pure-Rust binary parsers over token-bounded MCP tools so
//! Claude Code can inspect CAN traces (`.blf`/`.asc`), DBC databases (`.dbc`), ELF
//! firmware binaries (`.elf`/`.o`/`.so`), Device Trees (`.dts`/`.dtb`), Windows memory
//! dumps (`.dmp`/`.mdmp`), and large CSV/TSV telemetry logs without flooding context.

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

use serde_json::Value;

use ggs_can::{
    frames_of, open_into_doc, stats_of, total_bytes_of, CanFrameFilter, CanLogDoc,
    ProgressReporter,
};
use ggs_csv::{count_of, open_doc as open_csv_doc, rows_of, series_of, sniff, CsvValue};
use ggs_dbc::{decode_message, open_doc as open_dbc_doc};
use ggs_dmp::Dump;
use ggs_dts::{open_doc as open_dts_doc, DtsNode, DtsValue};
use ggs_elf::{open_doc as open_elf_doc, symbols_of};

use crate::McpServer;

impl McpServer {
    /// `can_log_summary`: summarize a `.blf` or `.asc` CAN/CAN-FD trace — duration,
    /// total/error frames, per-channel bus load estimate, busiest IDs, and highest-jitter
    /// periodic IDs.
    pub(crate) fn tool_can_log_summary(&self, args: &Value) -> Result<String, (i64, String)> {
        let path_str = Self::arg_str(args, "path")?.replace('\\', "/");
        let arb_bitrate = args
            .get("arbBitrate")
            .and_then(Value::as_f64)
            .unwrap_or(500_000.0)
            .max(10_000.0);
        let data_bitrate = args
            .get("dataBitrate")
            .and_then(Value::as_f64)
            .unwrap_or(2_000_000.0)
            .max(10_000.0);
        let top = args
            .get("limit")
            .and_then(Value::as_u64)
            .unwrap_or(20)
            .clamp(1, 100) as usize;
        let sort_by = args
            .get("sortBy")
            .and_then(Value::as_str)
            .unwrap_or("count");

        let abs = match self.resolve_repo_path(&path_str) {
            Ok(p) => p,
            Err(msg) => return Ok(msg),
        };
        let total_bytes = total_bytes_of(&abs);
        let mut reporter = ProgressReporter::reporting(total_bytes, |_| {});
        let stats = match stats_of(&abs, &mut reporter) {
            Ok(s) => s,
            Err(e) => return Ok(format!("Failed to parse CAN log '{path_str}': {e}")),
        };

        let mut out = format!(
            "CAN log summary — {path_str} (format: {}, duration: {:.3}s, total frames: {}, error frames: {}, unique IDs: {}{})",
            stats.format,
            stats.duration_s,
            stats.total_frames,
            stats.error_frames,
            stats.messages.len(),
            if stats.messages_truncated > 0 {
                format!(" (+{} truncated)", stats.messages_truncated)
            } else {
                String::new()
            }
        );

        out.push_str(&format!(
            "\nchannels ({} @ arb {:.0} kbps / data {:.0} kbps):",
            stats.channels.len(),
            arb_bitrate / 1000.0,
            data_bitrate / 1000.0
        ));
        for ch in &stats.channels {
            let dur = (ch.last_s - ch.first_s).max(1e-6);
            let load_pct = ((ch.arb_bits / arb_bitrate) + (ch.data_bits / data_bitrate)) / dur * 100.0;
            let fps = ch.frames as f64 / dur;
            out.push_str(&format!(
                "\n  CH{}: {} frames ({:.1} fps), {} errors, est load {:.2}%, {:.1} KiB payload",
                ch.channel,
                ch.frames,
                fps,
                ch.error_frames,
                load_pct,
                ch.payload_bytes as f64 / 1024.0
            ));
        }

        let mut msgs = stats.messages;
        if sort_by == "jitter" {
            msgs.sort_by(|a, b| {
                b.std_cycle_s
                    .partial_cmp(&a.std_cycle_s)
                    .unwrap_or(std::cmp::Ordering::Equal)
            });
        } else if sort_by == "maxCycle" {
            msgs.sort_by(|a, b| {
                b.max_cycle_s
                    .partial_cmp(&a.max_cycle_s)
                    .unwrap_or(std::cmp::Ordering::Equal)
            });
        }
        out.push_str(&format!(
            "\ntop {} message IDs (sorted by {sort_by}):",
            msgs.len().min(top)
        ));
        for m in msgs.iter().take(top) {
            let kind = if m.fd { "FD" } else { "CAN" };
            let ext = if m.extended { "ext" } else { "std" };
            let id_fmt = if m.extended {
                format!("0x{:08X}", m.id)
            } else {
                format!("0x{:03X}", m.id)
            };
            let cycle_info = if m.count >= 2 && m.avg_cycle_s > 0.0 {
                format!(
                    "avg={:.2}ms min={:.2}ms max={:.2}ms jitter={:.2}ms",
                    m.avg_cycle_s * 1000.0,
                    m.min_cycle_s * 1000.0,
                    m.max_cycle_s * 1000.0,
                    m.std_cycle_s * 1000.0
                )
            } else {
                "single-frame".to_owned()
            };
            out.push_str(&format!(
                "\n  CH{} {id_fmt} [{kind}/{ext}] count={} (tx={} rx={})  {cycle_info}",
                m.channel, m.count, m.tx, m.rx
            ));
        }
        Ok(out)
    }

    /// `dbc_lookup`: inspect a `.dbc` CAN database — overview of nodes & messages, or
    /// detailed signal layout & `VAL_` enum tables for a queried message ID, message
    /// name, or signal name.
    pub(crate) fn tool_dbc_lookup(&self, args: &Value) -> Result<String, (i64, String)> {
        let path_str = Self::arg_str(args, "path")?.replace('\\', "/");
        let query = args
            .get("query")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty());
        let limit = args
            .get("limit")
            .and_then(Value::as_u64)
            .unwrap_or(25)
            .clamp(1, 100) as usize;

        let abs = match self.resolve_repo_path(&path_str) {
            Ok(p) => p,
            Err(msg) => return Ok(msg),
        };
        let doc = match open_dbc_doc(&abs) {
            Ok(d) => d,
            Err(e) => return Ok(format!("Failed to parse DBC '{path_str}': {e}")),
        };

        let Some(q) = query else {
            let mut out = format!(
                "DBC overview — {path_str} (version: \"{}\", {} node(s), {} message(s)):",
                doc.version,
                doc.nodes.len(),
                doc.messages.len()
            );
            if !doc.nodes.is_empty() {
                out.push_str(&format!(
                    "\nnodes: {}",
                    doc.nodes.iter().take(30).cloned().collect::<Vec<_>>().join(", ")
                ));
            }
            out.push_str(&format!("\nmessages (showing up to {limit}):"));
            for msg in doc.messages.iter().take(limit) {
                out.push_str(&format!(
                    "\n  0x{:03X} ({}) {}  dlc={} tx={} signals={}",
                    msg.id,
                    msg.id,
                    msg.name,
                    msg.dlc,
                    msg.transmitter,
                    msg.signals.len()
                ));
            }
            if doc.messages.len() > limit {
                out.push_str(&format!(
                    "\n… +{} more message(s) — pass `query` (hex ID, decimal ID, message name, or signal name) to inspect details",
                    doc.messages.len() - limit
                ));
            }
            return Ok(out);
        };

        let parsed_id = parse_can_id(q);
        let q_lower = q.to_lowercase();
        let matched: Vec<_> = doc
            .messages
            .iter()
            .filter(|m| {
                parsed_id.is_some_and(|id| m.id == id)
                    || m.name.to_lowercase().contains(&q_lower)
                    || m.signals
                        .iter()
                        .any(|s| s.name.to_lowercase().contains(&q_lower))
            })
            .collect();

        if matched.is_empty() {
            return Ok(format!(
                "No message or signal matching '{q}' in DBC '{path_str}' ({} messages).",
                doc.messages.len()
            ));
        }

        let mut out = format!(
            "DBC lookup '{q}' in {path_str} — {} matching message(s):",
            matched.len()
        );
        for msg in matched.iter().take(limit.min(10)) {
            out.push_str(&format!(
                "\n\nBO_ 0x{:X} ({}) {}  dlc={} tx={}{}",
                msg.id,
                msg.id,
                msg.name,
                msg.dlc,
                msg.transmitter,
                msg.comment
                    .as_deref()
                    .map(|c| format!("  // {c}"))
                    .unwrap_or_default()
            ));
            for sig in &msg.signals {
                let order = if sig.little_endian { "Intel/LE" } else { "Motorola/BE" };
                let sign = if sig.signed { "signed" } else { "unsigned" };
                let unit = if sig.unit.is_empty() {
                    String::new()
                } else {
                    format!(" [{}]", sig.unit)
                };
                let mux = sig
                    .multiplex
                    .as_deref()
                    .map(|m| format!(" mux={m}"))
                    .unwrap_or_default();
                out.push_str(&format!(
                    "\n  SG_ {} : {}|{} ({order}, {sign}) scale={} offset={}{unit}{mux}",
                    sig.name, sig.start_bit, sig.length, sig.scale, sig.offset
                ));
                if !sig.values.is_empty() {
                    let vals = sig
                        .values
                        .iter()
                        .take(8)
                        .map(|(v, lbl)| format!("{v}={lbl}"))
                        .collect::<Vec<_>>()
                        .join(", ");
                    out.push_str(&format!("\n      VAL: {vals}"));
                }
            }
        }
        Ok(out)
    }

    /// `can_signal_query`: decode frames from a `.blf`/`.asc` log using a `.dbc` file for
    /// a target CAN ID or signal name, returning physical value statistics (count, min,
    /// max, avg, first/last) and bounded sample transitions.
    pub(crate) fn tool_can_signal_query(&self, args: &Value) -> Result<String, (i64, String)> {
        let log_path = Self::arg_str(args, "logPath")?.replace('\\', "/");
        let dbc_path = Self::arg_str(args, "dbcPath")?.replace('\\', "/");
        let id_arg = args.get("id").and_then(Value::as_str);
        let signal_filter = args
            .get("signal")
            .and_then(Value::as_str)
            .map(|s| s.to_lowercase());
        let max_frames = args
            .get("maxFrames")
            .and_then(Value::as_u64)
            .unwrap_or(5000)
            .clamp(10, 50_000) as usize;
        let sample_limit = args
            .get("samples")
            .and_then(Value::as_u64)
            .unwrap_or(15)
            .clamp(1, 50) as usize;

        let abs_log = match self.resolve_repo_path(&log_path) {
            Ok(p) => p,
            Err(msg) => return Ok(msg),
        };
        let abs_dbc = match self.resolve_repo_path(&dbc_path) {
            Ok(p) => p,
            Err(msg) => return Ok(msg),
        };
        let dbc = match open_dbc_doc(&abs_dbc) {
            Ok(d) => d,
            Err(e) => return Ok(format!("Failed to parse DBC '{dbc_path}': {e}")),
        };

        // Resolve target CAN ID from either `id` or `signal` name in the DBC.
        let target_id: Option<u32> = id_arg.and_then(parse_can_id).or_else(|| {
            signal_filter.as_ref().and_then(|sig_q| {
                dbc.messages.iter().find_map(|m| {
                    m.signals
                        .iter()
                        .any(|s| s.name.to_lowercase().contains(sig_q))
                        .then_some(m.id)
                })
            })
        });
        let Some(target_id) = target_id else {
            return Ok(
                "Specify `id` (e.g. \"0x123\") or a `signal` name present in the DBC.".to_owned(),
            );
        };

        let doc = Arc::new(CanLogDoc::new(total_bytes_of(&abs_log)));
        open_into_doc(&abs_log, &doc);

        let filter = CanFrameFilter {
            channels: Vec::new(),
            direction: ggs_can::CanDirection::All,
            kind: ggs_can::CanKind::All,
            id_ranges: vec![(target_id, target_id)],
        };
        let frames = frames_of(&doc, 0, max_frames, Some(&filter));
        let matching: Vec<_> = frames
            .into_iter()
            .filter(|f| f.id == target_id && !f.error)
            .collect();
        if matching.is_empty() {
            return Ok(format!(
                "No non-error frames with ID 0x{target_id:X} found in '{log_path}' (scanned up to {max_frames})."
            ));
        }

        // Accumulate per-signal stats: (count, min, max, sum, unit, first, last, samples)
        struct SigAcc {
            count: u64,
            min: f64,
            max: f64,
            sum: f64,
            unit: String,
            first: (f64, f64),
            last: (f64, f64),
            changes: Vec<(f64, f64, Option<String>)>,
        }
        let mut stats: BTreeMap<String, SigAcc> = BTreeMap::new();
        for frame in &matching {
            let bytes = decode_hex_bytes(&frame.data_hex);
            let Some(decoded) = decode_message(&dbc, frame.id, &bytes) else {
                continue;
            };
            for sig in decoded {
                if let Some(ref sq) = signal_filter {
                    if !sig.name.to_lowercase().contains(sq) {
                        continue;
                    }
                }
                let entry = stats.entry(sig.name.clone()).or_insert_with(|| SigAcc {
                    count: 0,
                    min: f64::INFINITY,
                    max: f64::NEG_INFINITY,
                    sum: 0.0,
                    unit: sig.unit.clone(),
                    first: (frame.t_s, sig.value),
                    last: (frame.t_s, sig.value),
                    changes: Vec::new(),
                });
                let prev_val = entry.last.1;
                entry.count += 1;
                entry.min = entry.min.min(sig.value);
                entry.max = entry.max.max(sig.value);
                entry.sum += sig.value;
                entry.last = (frame.t_s, sig.value);
                if (entry.count == 1 || (sig.value - prev_val).abs() > f64::EPSILON)
                    && entry.changes.len() < sample_limit
                {
                    entry.changes.push((frame.t_s, sig.value, sig.label));
                }
            }
        }

        if stats.is_empty() {
            return Ok(format!(
                "ID 0x{target_id:X} had {} frame(s), but no matching DBC signals decoded.",
                matching.len()
            ));
        }

        let msg_name = dbc
            .messages
            .iter()
            .find(|m| m.id == target_id)
            .map(|m| m.name.as_str())
            .unwrap_or("unknown");
        let mut out = format!(
            "CAN signal decode — {log_path} × {dbc_path} | 0x{target_id:X} ({msg_name}), {} frame(s):",
            matching.len()
        );
        for (name, acc) in &stats {
            let avg = acc.sum / acc.count.max(1) as f64;
            let unit = if acc.unit.is_empty() {
                String::new()
            } else {
                format!(" {}", acc.unit)
            };
            out.push_str(&format!(
                "\n  {name}: n={} min={:.4} max={:.4} avg={:.4}{unit} (t={:.3}s:{:.4} → t={:.3}s:{:.4})",
                acc.count, acc.min, acc.max, avg, acc.first.0, acc.first.1, acc.last.0, acc.last.1
            ));
            if !acc.changes.is_empty() {
                let pts = acc
                    .changes
                    .iter()
                    .take(8)
                    .map(|(t, v, lbl)| match lbl {
                        Some(l) => format!("{t:.3}s={v:.2}({l})"),
                        None => format!("{t:.3}s={v:.2}"),
                    })
                    .collect::<Vec<_>>()
                    .join(", ");
                out.push_str(&format!("\n    transitions: {pts}"));
            }
        }
        Ok(out)
    }

    /// `elf_inspect`: inspect an ELF binary's architecture, ROM/RAM footprint, largest
    /// sections, shared library dependencies, and largest symbols (with optional filter).
    pub(crate) fn tool_elf_inspect(&self, args: &Value) -> Result<String, (i64, String)> {
        let path_str = Self::arg_str(args, "path")?.replace('\\', "/");
        let filter = args
            .get("filter")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty());
        let limit = args
            .get("limit")
            .and_then(Value::as_u64)
            .unwrap_or(25)
            .clamp(1, 100) as usize;

        let abs = match self.resolve_repo_path(&path_str) {
            Ok(p) => p,
            Err(msg) => return Ok(msg),
        };
        let doc = match open_elf_doc(&abs) {
            Ok(d) => d,
            Err(e) => return Ok(format!("Failed to parse ELF '{path_str}': {e}")),
        };

        let endian = if doc.little_endian { "LE" } else { "BE" };
        let mut out = format!(
            "ELF inspect — {path_str} (ELF{}-{endian}, {}, {}, entry=0x{:X})\n\
             footprint: ROM={} B ({:.1} KiB), RAM={} B ({:.1} KiB), file={} B ({:.1} KiB)\n\
             totals: {} segment(s), {} section(s), {} sized symbol(s) (of {} raw)",
            doc.class_bits,
            doc.file_type,
            doc.machine_name,
            doc.entry,
            doc.rom_bytes,
            doc.rom_bytes as f64 / 1024.0,
            doc.ram_bytes,
            doc.ram_bytes as f64 / 1024.0,
            doc.total_bytes,
            doc.total_bytes as f64 / 1024.0,
            doc.segments.len(),
            doc.sections.len(),
            doc.symbols.len(),
            doc.symbols_total
        );
        if !doc.needed.is_empty() {
            out.push_str(&format!("\nneeded libs: {}", doc.needed.join(", ")));
        }

        let mut secs = doc.sections.clone();
        secs.sort_by_key(|s| std::cmp::Reverse(s.size));
        out.push_str("\ntop sections by size:");
        for s in secs.iter().filter(|s| s.size > 0).take(12) {
            let flags = format!(
                "{}{}{}",
                if s.alloc { "A" } else { "-" },
                if s.write { "W" } else { "-" },
                if s.exec { "X" } else { "-" }
            );
            out.push_str(&format!(
                "\n  {:<22} {:>10} B  [{}]  {}  @0x{:X}",
                s.name, s.size, flags, s.kind, s.addr
            ));
        }

        let win = symbols_of(&doc, 0, limit, filter);
        let scope = filter
            .map(|f| format!(" matching '{f}'"))
            .unwrap_or_default();
        out.push_str(&format!(
            "\ntop symbols{scope} ({} of {}):",
            win.lines.len(),
            win.total
        ));
        for sym in &win.lines {
            out.push_str(&format!(
                "\n  {:>9} B  {:<6} {:<6} {}  @0x{:X}",
                sym.size, sym.kind, sym.bind, sym.name, sym.value
            ));
        }
        Ok(out)
    }

    /// `elf_diff`: compare two ELF binaries to pinpoint ROM/RAM regressions, section
    /// deltas, and top growing/shrinking symbols.
    pub(crate) fn tool_elf_diff(&self, args: &Value) -> Result<String, (i64, String)> {
        let before_str = Self::arg_str(args, "beforePath")?.replace('\\', "/");
        let after_str = Self::arg_str(args, "afterPath")?.replace('\\', "/");
        let limit = args
            .get("limit")
            .and_then(Value::as_u64)
            .unwrap_or(20)
            .clamp(1, 100) as usize;

        let abs_before = match self.resolve_repo_path(&before_str) {
            Ok(p) => p,
            Err(msg) => return Ok(msg),
        };
        let abs_after = match self.resolve_repo_path(&after_str) {
            Ok(p) => p,
            Err(msg) => return Ok(msg),
        };
        let before = match open_elf_doc(&abs_before) {
            Ok(d) => d,
            Err(e) => return Ok(format!("Failed to parse before ELF '{before_str}': {e}")),
        };
        let after = match open_elf_doc(&abs_after) {
            Ok(d) => d,
            Err(e) => return Ok(format!("Failed to parse after ELF '{after_str}': {e}")),
        };

        let rom_delta = after.rom_bytes as i64 - before.rom_bytes as i64;
        let ram_delta = after.ram_bytes as i64 - before.ram_bytes as i64;
        let file_delta = after.total_bytes as i64 - before.total_bytes as i64;

        let mut out = format!(
            "ELF diff — {before_str} → {after_str}\n\
             ROM:  {} B → {} B ({:+} B)\n\
             RAM:  {} B → {} B ({:+} B)\n\
             File: {} B → {} B ({:+} B)",
            before.rom_bytes,
            after.rom_bytes,
            rom_delta,
            before.ram_bytes,
            after.ram_bytes,
            ram_delta,
            before.total_bytes,
            after.total_bytes,
            file_delta
        );

        let mut sec_before: HashMap<&str, u64> = HashMap::new();
        for s in &before.sections {
            *sec_before.entry(&s.name).or_default() += s.size;
        }
        let mut sec_after: HashMap<&str, u64> = HashMap::new();
        for s in &after.sections {
            *sec_after.entry(&s.name).or_default() += s.size;
        }
        let mut sec_deltas: Vec<(String, i64, u64, u64)> = Vec::new();
        for (&name, &a_sz) in &sec_after {
            let b_sz = sec_before.get(name).copied().unwrap_or(0);
            let d = a_sz as i64 - b_sz as i64;
            if d != 0 {
                sec_deltas.push((name.to_owned(), d, b_sz, a_sz));
            }
        }
        for (&name, &b_sz) in &sec_before {
            if !sec_after.contains_key(name) && b_sz > 0 {
                sec_deltas.push((name.to_owned(), -(b_sz as i64), b_sz, 0));
            }
        }
        sec_deltas.sort_by_key(|d| std::cmp::Reverse(d.1.abs()));
        if !sec_deltas.is_empty() {
            out.push_str("\nsection deltas:");
            for (name, d, b, a) in sec_deltas.iter().take(12) {
                out.push_str(&format!("\n  {name:<22} {d:>+10} B  ({b} → {a})"));
            }
        }

        let mut sym_before: HashMap<&str, u64> = HashMap::new();
        for s in &before.symbols {
            *sym_before.entry(&s.name).or_default() += s.size;
        }
        let mut sym_after: HashMap<&str, u64> = HashMap::new();
        for s in &after.symbols {
            *sym_after.entry(&s.name).or_default() += s.size;
        }
        let mut sym_deltas: Vec<(String, i64, u64, u64)> = Vec::new();
        for (&name, &a_sz) in &sym_after {
            let b_sz = sym_before.get(name).copied().unwrap_or(0);
            let d = a_sz as i64 - b_sz as i64;
            if d != 0 {
                sym_deltas.push((name.to_owned(), d, b_sz, a_sz));
            }
        }
        for (&name, &b_sz) in &sym_before {
            if !sym_after.contains_key(name) && b_sz > 0 {
                sym_deltas.push((name.to_owned(), -(b_sz as i64), b_sz, 0));
            }
        }
        sym_deltas.sort_by_key(|d| std::cmp::Reverse(d.1.abs()));
        out.push_str(&format!(
            "\ntop symbol size deltas ({} changed total):",
            sym_deltas.len()
        ));
        for (name, d, b, a) in sym_deltas.iter().take(limit) {
            let tag = if *b == 0 {
                "[NEW]"
            } else if *a == 0 {
                "[DEL]"
            } else if *d > 0 {
                "[GROW]"
            } else {
                "[SHRINK]"
            };
            out.push_str(&format!(
                "\n  {d:>+10} B  {tag:<8} {name}  ({b} → {a})"
            ));
        }
        Ok(out)
    }

    /// `dts_inspect`: parse a `.dts`/`.dtsi`/`.dtb` Device Tree, inspect its summary or
    /// search/drill into nodes by name, `compatible` string, or property.
    pub(crate) fn tool_dts_inspect(&self, args: &Value) -> Result<String, (i64, String)> {
        let path_str = Self::arg_str(args, "path")?.replace('\\', "/");
        let query = args
            .get("query")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty());
        let limit = args
            .get("limit")
            .and_then(Value::as_u64)
            .unwrap_or(25)
            .clamp(1, 100) as usize;

        let abs = match self.resolve_repo_path(&path_str) {
            Ok(p) => p,
            Err(msg) => return Ok(msg),
        };
        let doc = match open_dts_doc(&abs) {
            Ok(d) => d,
            Err(e) => return Ok(format!("Failed to parse Device Tree '{path_str}': {e}")),
        };

        let mut out = format!(
            "Device Tree — {path_str} (format: {}, {} node(s), {} properties, {} B)",
            doc.format, doc.nodes, doc.properties, doc.total_bytes
        );
        if let Some(cpu) = doc.boot_cpuid {
            out.push_str(&format!(", boot_cpuid={cpu}"));
        }
        if !doc.mem_reserve.is_empty() {
            out.push_str(&format!(", {} mem_reserve(s)", doc.mem_reserve.len()));
        }

        let mut matches: Vec<(String, &DtsNode)> = Vec::new();
        let q_lower = query.map(str::to_lowercase);
        collect_dts_nodes(&doc.root, "", q_lower.as_deref(), &mut matches);

        if let Some(q) = query {
            out.push_str(&format!("\nnodes matching '{q}' ({} found):", matches.len()));
        } else {
            out.push_str(&format!(
                "\nnodes (showing up to {limit} of {}):",
                matches.len()
            ));
        }
        for (node_path, node) in matches.iter().take(limit) {
            let lbl = node
                .label
                .as_deref()
                .map(|l| format!(" (label: {l})"))
                .unwrap_or_default();
            out.push_str(&format!(
                "\n  {node_path}{lbl}  [{} prop(s), {} child(ren)]",
                node.properties.len(),
                node.children.len()
            ));
            if query.is_some() {
                for prop in node.properties.iter().take(12) {
                    let vals = prop
                        .values
                        .iter()
                        .take(6)
                        .map(|v| match v {
                            DtsValue::Str { text } => format!("\"{text}\""),
                            DtsValue::Cell { text }
                            | DtsValue::Bytes { text }
                            | DtsValue::Ref { text } => text.clone(),
                        })
                        .collect::<Vec<_>>()
                        .join(", ");
                    out.push_str(&format!("\n    {} = {vals}", prop.name));
                }
            }
        }
        Ok(out)
    }

    /// `dmp_summary`: inspect a Windows minidump (`.dmp`/`.mdmp`) — OS/arch/PID/threads/
    /// exception presence, streams, memory regions, loaded modules, and optional VA-to-
    /// module resolution.
    pub(crate) fn tool_dmp_summary(&self, args: &Value) -> Result<String, (i64, String)> {
        let path_str = Self::arg_str(args, "path")?.replace('\\', "/");
        let address = args
            .get("address")
            .and_then(Value::as_str)
            .and_then(parse_hex_u64);
        let module_filter = args
            .get("moduleFilter")
            .and_then(Value::as_str)
            .map(|s| s.to_lowercase());
        let limit = args
            .get("limit")
            .and_then(Value::as_u64)
            .unwrap_or(30)
            .clamp(1, 100) as usize;

        let abs = match self.resolve_repo_path(&path_str) {
            Ok(p) => p,
            Err(msg) => return Ok(msg),
        };
        let mut dump = match Dump::open(&abs) {
            Ok(d) => d,
            Err(e) => return Ok(format!("Failed to open dump '{path_str}': {e}")),
        };
        let ov = match dump.overview(&abs) {
            Ok(o) => o,
            Err(e) => return Ok(format!("Failed to read dump overview '{path_str}': {e}")),
        };

        let mut out = format!(
            "Memory dump — {path_str} ({:.1} MiB)\n\
             OS: {} {} (build {}, {} CPUs) | PID: {} | Threads: {} | Exception stream: {}\n\
             Memory: {} region(s) ({:.1} MiB) | Modules: {} ({:.1} MiB) | Streams: {}",
            ov.size as f64 / (1024.0 * 1024.0),
            ov.os.arch,
            ov.os.version,
            ov.os.build,
            ov.os.processors,
            ov.pid,
            ov.threads,
            ov.has_exception,
            ov.memory_regions,
            ov.memory_total_bytes as f64 / (1024.0 * 1024.0),
            ov.modules.len(),
            ov.module_total_bytes as f64 / (1024.0 * 1024.0),
            ov.streams.len()
        );
        if !ov.flag_names.is_empty() {
            out.push_str(&format!("\nflags: {}", ov.flag_names.join(", ")));
        }
        if let Some(va) = address {
            let owner = ov
                .modules
                .iter()
                .find(|m| va >= m.base && va < m.base.saturating_add(m.size as u64));
            match owner {
                Some(m) => out.push_str(&format!(
                    "\naddress 0x{va:X} → {} + 0x{:X} (base=0x{:X}, size=0x{:X})",
                    m.file_name,
                    va - m.base,
                    m.base,
                    m.size
                )),
                None => out.push_str(&format!(
                    "\naddress 0x{va:X} does not fall inside any loaded module."
                )),
            }
        }
        let mods: Vec<_> = ov
            .modules
            .iter()
            .filter(|m| {
                module_filter.as_ref().is_none_or(|f| {
                    m.file_name.to_lowercase().contains(f) || m.name.to_lowercase().contains(f)
                })
            })
            .collect();
        out.push_str(&format!(
            "\nloaded modules ({} matched, showing up to {limit}):",
            mods.len()
        ));
        for m in mods.iter().take(limit) {
            out.push_str(&format!(
                "\n  0x{:016X}  {:>9} B  {}",
                m.base, m.size, m.file_name
            ));
        }
        Ok(out)
    }

    /// `csv_profile`: profile a CSV/TSV telemetry or data file — delimiter, header,
    /// row/column counts, numeric column min/max/avg stats, and bounded sample rows.
    pub(crate) fn tool_csv_profile(&self, args: &Value) -> Result<String, (i64, String)> {
        let path_str = Self::arg_str(args, "path")?.replace('\\', "/");
        let sample_rows = args
            .get("sampleRows")
            .and_then(Value::as_u64)
            .unwrap_or(5)
            .clamp(0, 30) as usize;

        let abs = match self.resolve_repo_path(&path_str) {
            Ok(p) => p,
            Err(msg) => return Ok(msg),
        };
        let sniffed = match sniff(&abs) {
            Ok(s) => s,
            Err(e) => return Ok(format!("Failed to sniff CSV '{path_str}': {e}")),
        };
        let doc = match open_csv_doc(&abs) {
            Ok(d) => d,
            Err(e) => return Ok(format!("Failed to parse CSV '{path_str}': {e}")),
        };
        ggs_csv::open_into_doc(&abs, &doc);
        let count = count_of(&doc);
        let delim = match sniffed.delimiter {
            b'\t' => "\\t".to_owned(),
            b => (b as char).to_string(),
        };

        let mut out = format!(
            "CSV profile — {path_str} (delimiter='{delim}', hasHeader={}, {} rows, {} cols, {} B)",
            sniffed.has_header,
            count.parsed,
            count.columns.len(),
            count.total_bytes
        );

        let numeric_cols: Vec<usize> = count
            .columns
            .iter()
            .enumerate()
            .filter(|(_, c)| c.numeric)
            .map(|(i, _)| i)
            .take(24)
            .collect();
        let series_stats: HashMap<usize, ggs_csv::CsvColumnStats> = if !numeric_cols.is_empty() {
            series_of(&doc, None, &numeric_cols, None)
                .series
                .into_iter()
                .map(|s| (s.column, s.stats))
                .collect()
        } else {
            HashMap::new()
        };

        out.push_str("\ncolumns:");
        for (i, col) in count.columns.iter().take(40).enumerate() {
            let name = col
                .name
                .clone()
                .unwrap_or_else(|| format!("col_{i}"));
            if let Some(st) = series_stats.get(&i) {
                out.push_str(&format!(
                    "\n  [{i}] {name} (numeric): n={} min={:.4} max={:.4} avg={:.4}",
                    st.count, st.min, st.max, st.avg
                ));
            } else {
                let kind = if col.numeric { "numeric" } else { "text" };
                out.push_str(&format!("\n  [{i}] {name} ({kind})"));
            }
        }

        if sample_rows > 0 {
            let rows = rows_of(&doc, 0, sample_rows, None);
            out.push_str(&format!("\nsample rows ({}):", rows.len()));
            for row in rows {
                let cells = row
                    .cells
                    .iter()
                    .take(12)
                    .map(|c| match c {
                        CsvValue::Num(n) => format!("{n}"),
                        CsvValue::Str(s) => s.clone(),
                    })
                    .collect::<Vec<_>>()
                    .join(" | ");
                out.push_str(&format!("\n  #{}: {cells}", row.index + 1));
            }
        }
        Ok(out)
    }
}

fn parse_can_id(s: &str) -> Option<u32> {
    let s = s.trim();
    if let Some(hex) = s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")) {
        u32::from_str_radix(hex, 16).ok()
    } else if s.chars().all(|c| c.is_ascii_digit()) {
        s.parse::<u32>().ok()
    } else {
        u32::from_str_radix(s, 16).ok()
    }
}

fn parse_hex_u64(s: &str) -> Option<u64> {
    let s = s.trim();
    let hex = s
        .strip_prefix("0x")
        .or_else(|| s.strip_prefix("0X"))
        .unwrap_or(s);
    u64::from_str_radix(hex, 16).ok()
}

fn decode_hex_bytes(hex_str: &str) -> Vec<u8> {
    hex_str
        .split_whitespace()
        .filter_map(|tok| u8::from_str_radix(tok, 16).ok())
        .collect()
}

fn collect_dts_nodes<'a>(
    node: &'a DtsNode,
    parent_path: &str,
    query_lower: Option<&str>,
    out: &mut Vec<(String, &'a DtsNode)>,
) {
    let my_path = if parent_path.is_empty() {
        if node.name.is_empty() || node.name == "/" {
            "/".to_owned()
        } else {
            format!("/{}", node.name)
        }
    } else if parent_path == "/" {
        format!("/{}", node.name)
    } else {
        format!("{parent_path}/{}", node.name)
    };

    let matched = match query_lower {
        None => true,
        Some(q) => {
            my_path.to_lowercase().contains(q)
                || node
                    .label
                    .as_deref()
                    .is_some_and(|l| l.to_lowercase().contains(q))
                || node.properties.iter().any(|p| {
                    p.name.to_lowercase().contains(q)
                        || p.values.iter().any(|v| match v {
                            DtsValue::Str { text }
                            | DtsValue::Cell { text }
                            | DtsValue::Bytes { text }
                            | DtsValue::Ref { text } => text.to_lowercase().contains(q),
                        })
                })
        }
    };
    if matched {
        out.push((my_path.clone(), node));
    }
    for child in &node.children {
        collect_dts_nodes(child, &my_path, query_lower, out);
    }
}
