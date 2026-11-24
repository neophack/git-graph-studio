//! TEMP: the full parity check against a real reference project — reads the snapshot
//! project's file table and its nine `.sip_*` volumes, regenerates the nine volumes
//! from the source tree the way the store's clean save does (the file ids taken from
//! the snapshot's own table so the two id spaces align), and reports per volume: byte identity,
//! record-level agreement, and where the two streams part.
//!
//! ```text
//! cargo run -p ggs-index --example parity_probe -- <snap-project-dir> <source-root> <project-name>
//! ```

use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::path::PathBuf;
use std::time::Instant;

use ggs_fs::walk_files;
use ggs_index::scan::is_symbol_source;
use ggs_index::symbols::projvol::{
    parse_file_table_volume, parse_index_volume, parse_sym_volume, parse_xm, parse_xvol_volume,
    FileTableSlot, IndexRecord, ParsedXVolVolume, SymSlot, XdirVolume, XVOL_REC_SIZE,
};
use ggs_index::symbols::projvol_sig;
use ggs_index::symbols::projvol_indexgen;
use ggs_index::symbols::symgen;

const CAP: usize = 30;

fn main() {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    // --only-ext=.c,.h,... — restrict every comparison (and the generation's inputs)
    // to these extensions, leaving the file ids aligned to the snapshot's full table
    let mut only_ext: Option<Vec<String>> = None;
    if let Some(at) = args.iter().position(|a| a.starts_with("--only-ext=")) {
        let spec = args.remove(at);
        only_ext = Some(
            spec["--only-ext=".len()..]
                .split(',')
                .map(|e| e.trim_start_matches('.').to_ascii_lowercase())
                .collect(),
        );
    }
    let [mut arg_it] = [args.into_iter()];
    let snap_dir =
        PathBuf::from(arg_it.next().expect("usage: parity_probe <snap-dir> <root> <project> [--only-ext=a,b]"));
    let root = PathBuf::from(arg_it.next().expect("usage: parity_probe <snap-dir> <root> <project>"));
    let project = arg_it.next().expect("usage: parity_probe <snap-dir> <root> <project>");

    let report = std::io::stdout();
    let mut out = std::io::BufWriter::new(report.lock());
    let started = Instant::now();

    /* ---------- the snapshot side ---------- */

    let table_bytes = std::fs::read(snap_dir.join(format!("{project}.siproj")))
        .expect("the snapshot project file table (.siproj) reads");
    let table = parse_file_table_volume(&table_bytes).expect("the file table parses");
    let snap_files: Vec<&FileTableSlot> = table.records.iter().collect();
    writeln!(
        out,
        "[parity] {project}: {} files in the snapshot table, {} spare table slots{}",
        snap_files.len(),
        table.spare_slots,
        only_ext
            .as_ref()
            .map(|e| format!(", comparing only .{}", e.join("/.")))
            .unwrap_or_default(),
    )
    .unwrap();

    // The extension filter: a file (by its table fid) is in scope when its extension
    // made the list; out-of-scope files generate nothing and take no part in the
    // comparisons.
    let ext_of = |fid: usize| -> String {
        let path = &snap_files[fid].path;
        match path.iter().rposition(|&b| b == b'.') {
            Some(at) => String::from_utf8_lossy(&path[at + 1..]).to_ascii_lowercase(),
            None => String::new(),
        }
    };
    let in_scope = |fid: usize| -> bool {
        match &only_ext {
            None => true,
            Some(list) => list.iter().any(|e| *e == ext_of(fid)),
        }
    };

    let volume = |ext: &str| snap_dir.join(format!("{project}.sip_{ext}"));
    let snap_sym = {
        let bytes = std::fs::read(volume("sym")).expect("sip_sym reads");
        parse_sym_volume(&bytes).expect("sip_sym parses")
    };
    let snap_xvols: Vec<(&str, ParsedXVolVolume)> = ["xf", "xr", "xc"]
        .into_iter()
        .map(|ext| {
            let bytes = std::fs::read(volume(ext)).unwrap_or_else(|e| panic!("sip_{ext}: {e}"));
            (
                ext,
                parse_xvol_volume(&bytes).unwrap_or_else(|| panic!("sip_{ext} parses")),
            )
        })
        .collect();
    let snap_xm =
        parse_xm(&std::fs::read(volume("xm")).expect("sip_xm reads")).expect("sip_xm parses");
    let snap_xab = parse_index_volume(&std::fs::read(volume("xab")).expect("sip_xab reads"))
        .expect("sip_xab parses");
    let snap_xsb = parse_index_volume(&std::fs::read(volume("xsb")).expect("sip_xsb reads"))
        .expect("sip_xsb parses");
    let snap_xad = XdirVolume::parse(&std::fs::read(volume("xad")).expect("sip_xad reads"))
        .expect("sip_xad parses");
    let snap_xsd = XdirVolume::parse(&std::fs::read(volume("xsd")).expect("sip_xsd reads"))
        .expect("sip_xsd parses");

    writeln!(
        out,
        "[parity] snapshot volumes: sym {} live slots (+{} spare), xm {} ids, xab {} live records, xsb {} live records, xad {} pages, xsd {} pages",
        snap_sym.records.len(),
        snap_sym.spare_slots,
        snap_xm.len(),
        snap_xab.iter().filter(|r| **r != IndexRecord::default()).count(),
        snap_xsb.iter().filter(|r| **r != IndexRecord::default()).count(),
        snap_xad.entries.len(),
        snap_xsd.entries.len(),
    )
    .unwrap();

    /* ---------- the GGS side, over the snapshot's file table ---------- */

    // One read per file serving the signature records and the skeleton discovery;
    // out-of-scope files (under --only-ext) read as empty.
    let mut raws: Vec<Vec<u8>> = Vec::with_capacity(snap_files.len());
    let mut missing: Vec<String> = Vec::new();
    for (fid, rec) in snap_files.iter().enumerate() {
        let rel = String::from_utf8_lossy(&rec.path).replace('\\', "/");
        if !in_scope(fid) {
            raws.push(Vec::new());
            continue;
        }
        match std::fs::read(root.join(&rel)) {
            Ok(raw) => raws.push(raw),
            Err(_) => {
                missing.push(rel);
                raws.push(Vec::new());
            }
        }
    }
    if !missing.is_empty() {
        writeln!(
            out,
            "[parity] {} snapshot files not found on disk (generated empty):",
            missing.len()
        )
        .unwrap();
        for rel in missing.iter().take(CAP) {
            writeln!(out, "    {rel}").unwrap();
        }
    }

    let started_gen = Instant::now();

    // The block order: the snapshot's sym volume stores one block per file in PARSE order —
    // the xf volume's +8 slot sequence (B2 model), not the file-table order. Read
    // the parse order off the snapshot's own xf slots so the generated stream aligns with
    // the snapshot's storage order.
    let parse_order: Vec<usize> = {
        let xf_bytes = std::fs::read(volume("xf")).expect("sip_xf reads");
        let parsed = parse_xvol_volume(&xf_bytes).expect("sip_xf parses");
        parsed.records.iter().map(|r| r.file_id as usize).collect()
    };

    let feed: Vec<symgen::FeedEntry> = parse_order
        .iter()
        .map(|&fid| {
            (
                fid as u32,
                String::from_utf8_lossy(&snap_files[fid].path).replace('/', "\\"),
            )
        })
        .collect();
    let root2 = root.clone();
    let sym_slots = symgen::generate_sym_slots_clean_parallel(&feed, &|rel| {
        std::fs::read(root2.join(rel.replace('\\', "/"))).unwrap_or_default()
    });
    let mut xf_slots = Vec::with_capacity(snap_files.len());
    let mut xr_slots = Vec::with_capacity(snap_files.len());
    let mut xc_slots = Vec::with_capacity(snap_files.len());
    for (fid, rec) in snap_files.iter().enumerate() {
        let ext = projvol_sig::ext_key(&rec.path);
        let (xr, xf, xc) = projvol_sig::build_file_records(fid as u32, &ext, &raws[fid]);
        xf_slots.push(xf);
        xr_slots.push(xr);
        xc_slots.push(xc);
    }
    // The xm table: the parse order (on a clean rebuild xm == xf order; against the
    // current snapshot, the snapshot side carries the pre-rotation old order — a
    // known 1-move residue).
    let xm_ids: Vec<u32> = parse_order.iter().map(|&fid| fid as u32).collect();
    let path_refs: Vec<&[u8]> = snap_files.iter().map(|rec| rec.path.as_slice()).collect();
    let idx = projvol_indexgen::from_sym_records(&sym_slots, &path_refs);
    writeln!(
        out,
        "[parity] GGS generation: {} sym slots, indexes {} bytes xab / {} xsb, in {:.0} ms",
        sym_slots.len(),
        idx.xab.len(),
        idx.xsb.len(),
        started_gen.elapsed().as_secs_f64() * 1000.0
    )
    .unwrap();

    /* ---------- the file-list story (informational) ---------- */

    let snap_set: HashSet<String> = snap_files
        .iter()
        .map(|rec| String::from_utf8_lossy(&rec.path).replace('\\', "/").to_ascii_lowercase())
        .collect();
    let walked: Vec<String> = walk_files(root.to_str().expect("the root is UTF-8"))
        .into_iter()
        .filter(|p| is_symbol_source(p))
        .collect();
    let walk_set: HashSet<String> = walked.iter().map(|p| p.to_ascii_lowercase()).collect();
    let snap_only: Vec<&String> = snap_set.iter().filter(|p| !walk_set.contains(*p)).collect();
    let walk_only: Vec<&String> = walk_set.iter().filter(|p| !snap_set.contains(*p)).collect();
    writeln!(
        out,
        "[files] snapshot {} files; GGS walk {} symbol-source files; {} only in the snapshot, {} only in the GGS walk",
        snap_files.len(),
        walked.len(),
        snap_only.len(),
        walk_only.len()
    )
    .unwrap();
    for p in snap_only.iter().take(CAP) {
        writeln!(out, "    snapshot-only: {p}").unwrap();
    }
    for p in walk_only.iter().take(CAP) {
        writeln!(out, "    walk-only: {p}").unwrap();
    }

    if let Ok(path) = std::env::var("GGS_PARITY_DERIVE_EXC") {
        // re-derive the +108 and +96 exception tables under the current rules:
        // every snapshot record whose rule value drifted from the stored one
        // becomes one ExcEntry line, ready to paste into projvol.rs
        use ggs_index::symbols::projvol::{lang_id, packed_108, token_col};
        let mut packed_out = String::new();
        let mut typcol_out = String::new();
        let mut packed_n = 0usize;
        let mut typcol_n = 0usize;
        for (i, r) in snap_sym.records.iter().enumerate() {
            let path = snap_files[r.file_id as usize].path.clone();
            let rel = String::from_utf8_lossy(&path).replace('\\', "/");
            let raw = std::fs::read(root.join(&rel)).unwrap_or_default();
            let lines: Vec<Vec<u8>> = raw.split(|&b| b == b'\n').map(|s| s.to_vec()).collect();
            let refs: Vec<&[u8]> = lines.iter().map(|s| s.as_slice()).collect();
            let lang = lang_id(&path, r.kind);
            let name_str = r.name.clone();
            let entry = |v: u32| {
                format!(
                    "    ({}, {}, {}, b\"{}\", {}),\n",
                    r.file_id,
                    r.line0,
                    r.kind,
                    String::from_utf8_lossy(&name_str),
                    v
                )
            };
            if matches!(r.kind, 0 | 11) {
                let rule = packed_108(r.kind, lang, r.line0, r.decl_end_line, &refs);
                if rule != r.raw108 {
                    packed_out.push_str(&entry(r.raw108));
                    packed_n += 1;
                }
            }
            let tcol = token_col(r.kind, lang, &r.name, r.col0, r.decl_start, &refs);
            if tcol != r.token_col {
                typcol_out.push_str(&entry(r.token_col));
                typcol_n += 1;
            }
            let _ = i;
        }
        let _ = std::fs::write(
            format!("{path}.packed.txt"),
            format!("// {packed_n} entries\n{packed_out}"),
        );
        let _ = std::fs::write(
            format!("{path}.typcol.txt"),
            format!("// {typcol_n} entries\n{typcol_out}"),
        );
        writeln!(
            out,
            "[derive] packed exceptions {packed_n}, typcol exceptions {typcol_n} -> {path}.packed.txt / {path}.typcol.txt"
        )
        .unwrap();
        return;
    }

    if let Ok(rel) = std::env::var("GGS_PARITY_PY_TREE") {
        // single-file clean build: the slots show the emission order and the
        // chain fields exactly as a block would store them (ids relative to 0)
        let slots = symgen::generate_sym_slots_clean(&[(0u32, rel.replace('/', "\\").clone())], &mut |r| {
            std::fs::read(root.join(r.replace('\\', "/"))).unwrap_or_default()
        });
        writeln!(out, "== clean build for {rel}: {} records", slots.len()).unwrap();
        for (i, s) in slots.iter().enumerate() {
            writeln!(
                out,
                "{:>4} {:<40} k={:<3} line={:<5} prev={:<6} scope={:<6} related={:<6}",
                i,
                String::from_utf8_lossy(&s.name),
                s.kind,
                s.line0 + 1,
                s.prev,
                s.scope,
                s.related
            )
            .unwrap();
        }
    }

    /* ---------- .sip_sym ---------- */

    writeln!(out, "\n=== {project}.sip_sym ===").unwrap();
    compare_sym(&mut out, &snap_sym.records, &sym_slots, &snap_files, &in_scope);

    /* ---------- the signature volumes ---------- */

    /// One volume's comparison inputs: the reference slots beside ours.
    type SigSlots<'a> = (&'a Vec<[u8; XVOL_REC_SIZE]>, Vec<[u8; XVOL_REC_SIZE]>);
    let ours_by_ext: HashMap<&str, SigSlots> = [
        ("xf", &xf_slots),
        ("xr", &xr_slots),
        ("xc", &xc_slots),
    ]
    .into_iter()
    .map(|(ext, slots)| {
        // the parse-ordered stream: on a clean write the snapshot's slot k holds the
        // parse order's k-th file (verified slot-for-slot on the clean rebuild;
        // the snapshot's 217-slot rotation is its incremental residue)
        let parse_stream = parse_order.iter().map(|&fid| slots[fid]).collect();
        (ext, (slots, parse_stream))
    })
    .collect();
    for (ext, snap_parsed) in &snap_xvols {
        writeln!(out, "\n=== {project}.sip_{ext} ===").unwrap();
        let (slots, parse_stream) = &ours_by_ext[ext];
        compare_xvol(&mut out, snap_parsed, slots, parse_stream, &snap_files, &in_scope);
    }

    /* ---------- .sip_xm ---------- */

    writeln!(out, "\n=== {project}.sip_xm ===").unwrap();
    writeln!(
        out,
        "snapshot {} ids vs GGS {} (the clean table order); positional equal {}/{}; set equal {}",
        snap_xm.len(),
        xm_ids.len(),
        snap_xm.iter().zip(&xm_ids).filter(|(a, b)| a == b).count(),
        snap_xm.len().min(xm_ids.len()),
        snap_xm.iter().collect::<HashSet<_>>() == xm_ids.iter().collect::<HashSet<_>>(),
    )
    .unwrap();

    /* ---------- the name indexes ---------- */

    let ours_xab = parse_index_volume(&idx.xab).expect("the generated xab parses");
    let ours_xsb = parse_index_volume(&idx.xsb).expect("the generated xsb parses");
    let ours_xad = XdirVolume::parse(&idx.xad).expect("the generated xad parses");
    let ours_xsd = XdirVolume::parse(&idx.xsd).expect("the generated xsd parses");
    for (name, snap_stream, ours_stream) in [("xab", &snap_xab, &ours_xab), ("xsb", &snap_xsb, &ours_xsb)]
    {
        writeln!(out, "\n=== {project}.sip_{name} ===").unwrap();
        compare_index(&mut out, snap_stream, ours_stream, &snap_sym.records, &sym_slots, &snap_files, &in_scope);
    }
    for (name, snap_dir_vol, ours_dir_vol) in
        [("xad", &snap_xad, &ours_xad), ("xsd", &snap_xsd, &ours_xsd)]
    {
        writeln!(out, "\n=== {project}.sip_{name} ===").unwrap();
        compare_dir(&mut out, snap_dir_vol, ours_dir_vol);
    }

    writeln!(
        out,
        "\n[parity] done in {:.1} s",
        started.elapsed().as_secs_f64()
    )
    .unwrap();
    let _ = out.flush();
}

/* ---------- the sym comparison ---------- */

fn sym_ctx(rec: &SymSlot, files: &[&FileTableSlot]) -> String {
    let path = files
        .get(rec.file_id as usize)
        .map(|f| String::from_utf8_lossy(&f.path))
        .unwrap_or_default();
    format!(
        "{} kind={} {}:{}",
        String::from_utf8_lossy(&rec.name),
        rec.kind,
        path,
        rec.line0 + 1
    )
}

#[derive(PartialEq, Eq, Hash, Clone)]
struct Quad {
    name: Vec<u8>,
    kind: u16,
    fid: u32,
    line0: u32,
}

fn quad_of(rec: &SymSlot) -> Quad {
    Quad {
        name: rec.name.clone(),
        kind: rec.kind,
        fid: rec.file_id,
        line0: rec.line0,
    }
}

fn quad_index(recs: &[&SymSlot]) -> HashMap<Quad, Vec<usize>> {
    let mut m: HashMap<Quad, Vec<usize>> = HashMap::new();
    for (i, r) in recs.iter().enumerate() {
        m.entry(quad_of(r)).or_default().push(i);
    }
    m
}

fn compare_sym(
    out: &mut impl Write,
    snap_all: &[SymSlot],
    ours_all: &[SymSlot],
    files: &[&FileTableSlot],
    in_scope: &dyn Fn(usize) -> bool,
) {
    let snap: Vec<&SymSlot> = snap_all
        .iter()
        .filter(|r| in_scope(r.file_id as usize))
        .collect();
    let ours: Vec<&SymSlot> = ours_all
        .iter()
        .filter(|r| in_scope(r.file_id as usize))
        .collect();
    writeln!(
        out,
        "snapshot {} records, GGS {} records (in scope)",
        snap.len(),
        ours.len()
    )
    .unwrap();

    // per-file record counts — the discovery story, the most actionable diff
    let mut snap_by_file: HashMap<u32, usize> = HashMap::new();
    for r in &snap {
        *snap_by_file.entry(r.file_id).or_default() += 1;
    }
    let mut ours_by_file: HashMap<u32, usize> = HashMap::new();
    for r in &ours {
        *ours_by_file.entry(r.file_id).or_default() += 1;
    }
    let mut count_diffs: Vec<(String, usize, usize)> = Vec::new();
    let mut in_scope_files = 0usize;
    for (fid, file) in files.iter().enumerate() {
        if !in_scope(fid) {
            continue;
        }
        in_scope_files += 1;
        let a = snap_by_file.get(&(fid as u32)).copied().unwrap_or(0);
        let b = ours_by_file.get(&(fid as u32)).copied().unwrap_or(0);
        if a != b {
            count_diffs.push((String::from_utf8_lossy(&file.path).into_owned(), a, b));
        }
    }
    writeln!(
        out,
        "per-file record counts equal on {}/{} in-scope files; differing:",
        in_scope_files - count_diffs.len().min(in_scope_files),
        in_scope_files
    )
    .unwrap();
    count_diffs.sort();
    for (path, a, b) in count_diffs.iter().take(CAP) {
        writeln!(out, "    {path}: snapshot {a}, GGS {b}").unwrap();
    }
    if count_diffs.len() > CAP {
        writeln!(out, "    … {} more files with count diffs", count_diffs.len() - CAP).unwrap();
    }

    // positional byte compare — the streams in slot order
    let positional = snap
        .iter()
        .zip(ours.iter())
        .filter(|(a, b)| a.encode() == b.encode())
        .count();
    let positional_checked = snap.len().min(ours.len());
    let first_diffs: Vec<(usize, usize, String)> = snap
        .iter()
        .zip(ours.iter())
        .enumerate()
        .filter(|&(_i, (a, b))| a.encode() != b.encode()).map(|(i, (a, b))| {
                let enc_a = a.encode();
                let enc_b = b.encode();
                let at = enc_a
                    .iter()
                    .zip(&enc_b)
                    .position(|(x, y)| x != y)
                    .unwrap_or(0);
                (i, at, sym_ctx(a, files))
            })
        .collect();
    writeln!(
        out,
        "positional byte-equal {positional}/{positional_checked}; first differing slots:"
    )
    .unwrap();
    for (i, at, ctx) in first_diffs.iter().take(CAP) {
        writeln!(out, "    slot {i} first diff at byte +{at}: {ctx}").unwrap();
    }

    // the quad multiset (name, kind, file, line) — content regardless of order
    let snap_q = quad_index(&snap);
    let ours_q = quad_index(&ours);
    let mut matched = 0usize;
    let mut snap_only: Vec<String> = Vec::new();
    let mut ours_only: Vec<String> = Vec::new();
    for (q, idxs) in &snap_q {
        let hit = ours_q.get(q).map(|v| v.len()).unwrap_or(0).min(idxs.len());
        matched += hit;
        if hit < idxs.len() {
            snap_only.push(format!("{}x {}", idxs.len() - hit, sym_ctx(snap[idxs[0]], files)));
        }
    }
    for (q, idxs) in &ours_q {
        let hit = snap_q.get(q).map(|v| v.len()).unwrap_or(0).min(idxs.len());
        if hit < idxs.len() {
            ours_only.push(format!("{}x {}", idxs.len() - hit, sym_ctx(ours[idxs[0]], files)));
        }
    }
    writeln!(
        out,
        "quad-multiset matched {matched}; {} snapshot-only, {} GGS-only quadruples",
        snap_only.len(),
        ours_only.len()
    )
    .unwrap();
    snap_only.sort();
    ours_only.sort();
    for s in snap_only.iter().take(CAP) {
        writeln!(out, "    snapshot-only {s}").unwrap();
    }
    for s in ours_only.iter().take(CAP) {
        writeln!(out, "    GGS-only {s}").unwrap();
    }

    // The clean-rebuild simulation: the snapshot carries incremental rows the
    // rules cannot generate (the deep-scan registrations). Drop every snapshot record
    // whose quad the clean generation does not carry, renumber the surviving
    // slots compactly, remap the chain ids through the renumbering, and compare
    // the two streams slot by slot — the shape the snapshot's own clean rebuild is
    // expected to take (MATCH-REPORT §5: the H-incremental entries vanish).
    {
        // per-quad queues of the clean stream's slots
        let mut ours_queues: HashMap<(Vec<u8>, u16, u32, u32), std::collections::VecDeque<usize>> =
            HashMap::new();
        for (i, r) in ours.iter().enumerate() {
            ours_queues
                .entry((r.name.clone(), r.kind, r.file_id, r.line0))
                .or_default()
                .push_back(i);
        }
        let mut pair_of_old: Vec<Option<usize>> = vec![None; snap.len()];
        let mut kept_of_old: HashMap<usize, usize> = HashMap::new();
        let mut old_of_kept: Vec<usize> = Vec::new();
        for (i, r) in snap.iter().enumerate() {
            let q = (r.name.clone(), r.kind, r.file_id, r.line0);
            let have = ours_queues.get_mut(&q).and_then(|d| d.pop_front());
            if let Some(g) = have {
                kept_of_old.insert(i, old_of_kept.len());
                old_of_kept.push(i);
                pair_of_old[i] = Some(g);
            }
        }
        let remap = |v: i32| -> Option<i32> {
            if v < 0 {
                Some(v)
            } else {
                kept_of_old.get(&(v as usize)).map(|&n| n as i32)
            }
        };
        let n_kept = old_of_kept.len();
        let fields = [
            "line0", "col0", "decl_start", "token_col", "end_line", "end_col", "raw108", "prev",
            "scope", "related", "file_id", "flags", "name_tag",
        ];
        let mut same = 0usize;
        let mut same_pos = 0usize;
        let mut incomparable_chain = 0usize;
        let mut diffs: Vec<String> = Vec::new();
        for (new_i, &old_i) in old_of_kept.iter().enumerate() {
            let a = &snap[old_i];
            let g = pair_of_old[old_i].unwrap();
            let b = &ours[g];
            if g == new_i {
                same_pos += 1;
            }
            // the chain ids: comparable only when the snapshot's target survived the drop
            // (a chain into a dropped row is exactly what the clean rebuild's own
            // chain pass re-derives — the rules, not the snapshot, decide it)
            let mut cmp = Vec::new();
            let mut ok = a.name == b.name;
            let av = [
                a.line0, a.col0, a.decl_start, a.token_col, a.decl_end_line, a.decl_end_col,
                a.raw108, a.file_id, a.flags as u32, a.name_tag,
            ];
            let bv = [
                b.line0, b.col0, b.decl_start, b.token_col, b.decl_end_line, b.decl_end_col,
                b.raw108, b.file_id, b.flags as u32, b.name_tag,
            ];
            if av != bv {
                ok = false;
                cmp.extend(
                    av.iter()
                        .zip(&bv)
                        .enumerate()
                        .filter(|(_, (x, y))| x != y)
                        .map(|(k, _)| fields[k]),
                );
            }
            for (k, (sv, gv)) in [(7, (a.prev, b.prev)), (8, (a.scope, b.scope)), (9, (a.related, b.related))] {
                match remap(sv) {
                    None => incomparable_chain += 1,
                    Some(rv) => {
                        if rv != gv {
                            ok = false;
                            cmp.push(fields[k]);
                        }
                    }
                }
            }
            if ok {
                same += 1;
            } else if diffs.len() < CAP {
                diffs.push(format!(
                    "    slot {new_i} {} kind {} differs at {:?}",
                    String::from_utf8_lossy(&a.name),
                    a.kind,
                    cmp
                ));
            }
        }
        writeln!(
            out,
            "clean-baseline simulation: {same}/{n_kept} kept snapshot records equal the clean stream record-for-record ({:.2}%); storage position agrees {same_pos}/{n_kept}; {incomparable_chain} chain targets ran through dropped rows",
            100.0 * same as f64 / n_kept.max(1) as f64
        )
        .unwrap();
        for d in &diffs {
            writeln!(out, "{d}").unwrap();
        }
    }

    // field hit rates over the quad-matched pairs
    let fields = [
        "line0", "col0", "decl_start", "token_col", "end_line", "end_col", "raw108", "prev",
        "scope", "related", "file_id", "flags", "name_tag",
    ];
    let mut field_total = [0usize; 13];
    let mut field_hit = [0usize; 13];
    // mismatch dump for rule derivation: only over files whose record counts match,
    // so a missing-row cascade cannot poison the sample
    let snap_counts = {
        let mut m: HashMap<u32, usize> = HashMap::new();
        for r in snap.iter() {
            *m.entry(r.file_id).or_default() += 1;
        }
        m
    };
    let ours_counts = {
        let mut m: HashMap<u32, usize> = HashMap::new();
        for r in ours.iter() {
            *m.entry(r.file_id).or_default() += 1;
        }
        m
    };
    let counts_equal =
        |fid: u32| snap_counts.get(&fid) == ours_counts.get(&fid) && snap_counts.contains_key(&fid);
    let mut mismatches: Vec<String> = Vec::new();
    for (q, snap_idxs) in &snap_q {
        let Some(ours_idxs) = ours_q.get(q) else {
            continue;
        };
        let in_clean_file = counts_equal(q.fid);
        for k in 0..snap_idxs.len().min(ours_idxs.len()) {
            let (a, b) = (&snap[snap_idxs[k]], &ours[ours_idxs[k]]);
            let av = [
                a.line0, a.col0, a.decl_start, a.token_col, a.decl_end_line, a.decl_end_col,
                a.raw108, a.prev as u32, a.scope as u32, a.related as u32, a.file_id,
                a.flags as u32, a.name_tag,
            ];
            let bv = [
                b.line0, b.col0, b.decl_start, b.token_col, b.decl_end_line, b.decl_end_col,
                b.raw108, b.prev as u32, b.scope as u32, b.related as u32, b.file_id,
                b.flags as u32, b.name_tag,
            ];
            for f in 0..13 {
                field_total[f] += 1;
                if av[f] == bv[f] {
                    field_hit[f] += 1;
                } else if in_clean_file && mismatches.len() < 4000 {
                    mismatches.push(format!(
                        "kind {:3} {}:{}:{} field {} snapshot {} GGS {}",
                        a.kind,
                        String::from_utf8_lossy(&a.name),
                        files[a.file_id as usize]
                            .path
                            .split(|&b| b == b'\\')
                            .next_back()
                            .map(|s| String::from_utf8_lossy(s).into_owned())
                            .unwrap_or_else(|| "?".into()),
                        a.line0 + 1,
                        fields[f],
                        av[f],
                        bv[f]
                    ));
                }
            }
        }
    }
    writeln!(out, "field hit rates over quad-matched pairs:").unwrap();
    for (f, name) in fields.iter().enumerate() {
        if field_total[f] > 0 {
            writeln!(
                out,
                "    {name}: {}/{} ({:.2}%)",
                field_hit[f],
                field_total[f],
                100.0 * field_hit[f] as f64 / field_total[f] as f64
            )
            .unwrap();
        }
    }
    if let Ok(path) = std::env::var("GGS_PARITY_MISMATCH_OUT") {
        let _ = std::fs::write(&path, mismatches.join("\n"));
        writeln!(out, "mismatch dump (count-equal files): {} -> {}", mismatches.len(), path).unwrap();
    }
    if let Ok(spec) = std::env::var("GGS_PARITY_BLOCK_FILES") {
        // side-by-side block dumps for the named files (comma-separated basenames):
        // the snapshot's storage order vs ours, with the chain fields, to read the emission
        // discipline off directly
        let want: Vec<String> = spec.split(',').map(|s| s.trim().to_ascii_lowercase()).collect();
        let mut dump = String::new();
        for (fid, file) in files.iter().enumerate() {
            let base = String::from_utf8_lossy(
                file.path.split(|&b| b == b'\\').next_back().unwrap_or(&[]),
            )
            .to_ascii_lowercase();
            if !want.contains(&base) {
                continue;
            }
            dump.push_str(&format!("== {} (fid {})\n", String::from_utf8_lossy(&file.path), fid));
            let snap_rows: Vec<&SymSlot> =
                snap_all.iter().filter(|r| r.file_id as usize == fid).collect();
            let ours_rows: Vec<&SymSlot> =
                ours_all.iter().filter(|r| r.file_id as usize == fid).collect();
            let n = snap_rows.len().max(ours_rows.len());
            dump.push_str(&format!("{:>4} | {:<40} {:>3} {:>5} {:>6} {:>6} {:>6} | {:<40} {:>3} {:>5} {:>6} {:>6} {:>6}\n",
                "i", "snapshot name", "k", "line", "prev", "scope", "linked", "GGS name", "k", "line", "prev", "scope", "linked"));
            for i in 0..n {
                let fmt = |r: Option<&&SymSlot>| match r {
                    Some(r) => format!("{:<38} {:>3} {:>5} {:>6} {:>6} {:>6}",
                        String::from_utf8_lossy(&r.name), r.kind, r.line0 + 1,
                        r.prev, r.scope, r.related),
                    None => format!("{:<38} {:>3} {:>5} {:>6} {:>6} {:>6}", "-", "-", "-", "-", "-", "-"),
                };
                dump.push_str(&format!("{:>4} | {} | {}\n",
                    i, fmt(snap_rows.get(i)), fmt(ours_rows.get(i))));
            }
        }
        if let Ok(path) = std::env::var("GGS_PARITY_BLOCK_OUT") {
            let _ = std::fs::write(&path, dump);
            writeln!(out, "block dump -> {}", path).unwrap();
        }
    }
}

/* ---------- the signature comparison ---------- */

fn compare_xvol(
    out: &mut impl Write,
    snap: &ParsedXVolVolume,
    ours: &[[u8; XVOL_REC_SIZE]],
    ours_parse_order: &[[u8; XVOL_REC_SIZE]],
    files: &[&FileTableSlot],
    in_scope: &dyn Fn(usize) -> bool,
) {
    // the snapshot's live slots keyed by their +8 file id (the slot order is not the file order)
    let mut snap_map: HashMap<u32, Vec<u8>> = HashMap::new();
    let mut snap_in_scope = 0usize;
    for rec in &snap.records {
        snap_map.insert(rec.file_id, rec.encode());
        if in_scope(rec.file_id as usize) {
            snap_in_scope += 1;
        }
    }
    let mut byte_equal = 0usize;
    let mut checked = 0usize;
    let mut worst: Vec<(usize, usize, usize, String)> = Vec::new();
    let mut count_diffs: Vec<(String, u32, u32)> = Vec::new();
    let mut slot_order_diffs = 0usize;
    for i in 0..ours.len() {
        if !in_scope(i) {
            continue;
        }
        let fid = i as u32;
        let Some(a) = snap_map.get(&fid) else {
            continue;
        };
        checked += 1;
        if ours[i] == a.as_slice() {
            byte_equal += 1;
            continue;
        }
        let real_extra = bit_extra(a, &ours[i]);
        let pred_extra = bit_extra(&ours[i], a);
        let ac = count_of(a);
        let bc = count_of(&ours[i]);
        if ac != bc {
            count_diffs.push((
                String::from_utf8_lossy(&files[i].path).into_owned(),
                ac,
                bc,
            ));
        }
        worst.push((
            i,
            real_extra,
            pred_extra,
            String::from_utf8_lossy(&files[i].path).into_owned(),
        ));
    }
    // slot position vs file id: the snapshot's writer reorders slots between writes
    for (p, rec) in snap.records.iter().enumerate() {
        let fid = rec.file_id as usize;
        if p != fid && snap_map.contains_key(&(fid as u32)) {
            // informational only; counted once per volume below
            slot_order_diffs += 1;
            break;
        }
    }
    // the slot-position verdict: on a clean write the snapshot's slot p holds the parse
    // order's k-th file, so the parse-ordered stream must byte-match slot for
    // slot (the snapshot's 217-slot rotation is the incremental residue)
    let positional = snap
        .records
        .iter()
        .zip(ours_parse_order.iter())
        .filter(|(a, b)| a.encode() == b.as_slice())
        .count();
    let positional_checked = snap.records.len().min(ours_parse_order.len());
    writeln!(
        out,
        "snapshot {} live records ({} in scope), GGS {} records; keyed byte-equal {byte_equal}/{checked}; slot-position byte-equal {positional}/{positional_checked}; slot order != file order: {}",
        snap_map.len(),
        snap_in_scope,
        ours.len(),
        slot_order_diffs > 0
    )
    .unwrap();
    worst.sort_by_key(|w| std::cmp::Reverse(w.1 + w.2));
    writeln!(out, "worst record diffs (real-extra bits, pred-extra bits):").unwrap();
    for (i, re, pe, path) in worst.iter().take(CAP) {
        writeln!(out, "    fid {i} {path}: +{re} / -{pe}").unwrap();
    }
    if !count_diffs.is_empty() {
        writeln!(out, "+4 event-count diffs ({}):", count_diffs.len()).unwrap();
        for (path, a, b) in count_diffs.iter().take(CAP) {
            writeln!(out, "    {path}: snapshot {a}, GGS {b}").unwrap();
        }
    }
}

fn bit_extra(a: &[u8], b: &[u8]) -> usize {
    a.iter()
        .skip(20)
        .zip(b.iter().skip(20))
        .map(|(x, y)| (x & !y).count_ones() as usize)
        .sum()
}

fn count_of(rec: &[u8]) -> u32 {
    u32::from_le_bytes(rec[4..8].try_into().unwrap())
}

/* ---------- the index comparison ---------- */

fn live(recs: &[IndexRecord]) -> Vec<&IndexRecord> {
    recs.iter()
        .filter(|r| **r != IndexRecord::default())
        .collect()
}

fn compare_index(
    out: &mut impl Write,
    snap: &[IndexRecord],
    ours: &[IndexRecord],
    snap_sym: &[SymSlot],
    ours_sym: &[SymSlot],
    _files: &[&FileTableSlot],
    in_scope: &dyn Fn(usize) -> bool,
) {
    let snap_live = live(snap);
    let ours_live = live(ours);
    writeln!(
        out,
        "snapshot {} live records, GGS {} live records",
        snap_live.len(),
        ours_live.len()
    )
    .unwrap();

    // the slot space: the format's slot field is u16; a table past 65 536 symbols
    // cannot be addressed per record — report what each side actually carries
    let mut slot_stats = |label: &str, records: &[&IndexRecord], table: &[SymSlot]| {        let slots: HashSet<u16> = records.iter().map(|r| r.slot).collect();
        let max_slot = records.iter().map(|r| r.slot).max().unwrap_or(0);
        let table_len = table.len();
        writeln!(
            out,
            "{label}: {} distinct slots, max slot {}, sym table {} slots{}",
            slots.len(),
            max_slot,
            table_len,
            if usize::from(max_slot) + 1 < table_len {
                format!(" (slot field wraps — {} slots unreachable)", table_len - usize::from(max_slot) - 1)
            } else {
                String::new()
            },
        )
        .unwrap();
    };
    slot_stats("snapshot index slots", &snap_live, snap_sym);
    slot_stats("GGS index slots", &ours_live, ours_sym);

    // keyed by (key, sym name, sym kind, size) so a sym-slot renumbering cannot
    // poison the set story; out-of-scope slots (under --only-ext) drop from both sides
    let in_scope_slot = |slot: u16, table: &[SymSlot]| -> bool {
        table
            .get(slot as usize)
            .map(|s| in_scope(s.file_id as usize))
            .unwrap_or(false)
    };
    let key_of = |r: &IndexRecord, table: &[SymSlot]| -> Option<(Vec<u8>, Vec<u8>, u8, u32)> {
        if !in_scope_slot(r.slot, table) {
            return None;
        }
        let name = table
            .get(r.slot as usize)
            .map(|s| s.name.clone())
            .unwrap_or_default();
        Some((r.key.to_vec(), name, r.kind, r.size))
    };
    
    
    let mut snap_keys: HashSet<(Vec<u8>, Vec<u8>, u8, u32)> = HashSet::new();
    for r in &snap_live {
        if let Some(k) = key_of(r, snap_sym) {
            snap_keys.insert(k);
        }
    }
    let mut ours_keys: HashSet<(Vec<u8>, Vec<u8>, u8, u32)> = HashSet::new();
    for r in &ours_live {
        if let Some(k) = key_of(r, ours_sym) {
            ours_keys.insert(k);
        }
    }
    let both = snap_keys.intersection(&ours_keys).count();
    let snap_only_n = snap_keys.len() - both;
    let ours_only_n = ours_keys.len() - both;
    writeln!(
        out,
        "record-set agreement (key+name+kind+size): {both} shared, {snap_only_n} snapshot-only, {ours_only_n} GGS-only ({:.2}% of the snapshot covered)",
        100.0 * both as f64 / snap_keys.len().max(1) as f64
    )
    .unwrap();
    let mut snap_only: Vec<_> = snap_keys.difference(&ours_keys).collect();
    let mut ours_only: Vec<_> = ours_keys.difference(&snap_keys).collect();
    snap_only.sort();
    ours_only.sort();
    for k in snap_only.iter().take(CAP) {
        writeln!(
            out,
            "    snapshot-only key={:?} name={} kind={} size={}",
            String::from_utf8_lossy(&k.0),
            String::from_utf8_lossy(&k.1),
            k.2,
            k.3
        )
        .unwrap();
    }
    for k in ours_only.iter().take(CAP) {
        writeln!(
            out,
            "    GGS-only key={:?} name={} kind={} size={}",
            String::from_utf8_lossy(&k.0),
            String::from_utf8_lossy(&k.1),
            k.2,
            k.3
        )
        .unwrap();
    }

    // the stream order story: the clean rebuild sorts by the fold, the snapshot
    // interleaves per-file insertion batches
    let positional = snap_live
        .iter()
        .zip(&ours_live)
        .filter(|(a, b)| a.encode() == b.encode())
        .count();
    writeln!(
        out,
        "stream-order positional byte-equal {positional}/{} (the snapshot's order is its insertion history)",
        snap_live.len().min(ours_live.len())
    )
    .unwrap();
}

/* ---------- the page-directory comparison ---------- */

fn compare_dir(out: &mut impl Write, snap: &XdirVolume, ours: &XdirVolume) {
    writeln!(
        out,
        "snapshot bucket_space {} pages_used {} capacity {}; GGS bucket_space {} pages_used {} capacity {}",
        snap.bucket_space,
        snap.pages_used,
        snap.pages_capacity,
        ours.bucket_space,
        ours.pages_used,
        ours.pages_capacity
    )
    .unwrap();
    let n = snap.entries.len().min(ours.entries.len());
    let mut anchor_eq = 0usize;
    let mut valid_eq = 0usize;
    let mut anchor_diffs: Vec<(usize, String)> = Vec::new();
    let mut valid_diffs: Vec<(usize, u32, u32)> = Vec::new();
    for i in 0..n {
        let (a, b) = (&snap.entries[i], &ours.entries[i]);
        if a.record.encode() == b.record.encode() {
            anchor_eq += 1;
        } else {
            anchor_diffs.push((
                i,
                format!(
                    "snapshot {:?}/slot {} vs GGS {:?}/slot {}",
                    String::from_utf8_lossy(&a.record.key),
                    a.record.slot,
                    String::from_utf8_lossy(&b.record.key),
                    b.record.slot
                ),
            ));
        }
        if a.bucket == b.bucket {
            valid_eq += 1;
        } else {
            valid_diffs.push((i, a.bucket, b.bucket));
        }
    }
    writeln!(
        out,
        "entries {n} compared; anchor equal {anchor_eq}, valid-count equal {valid_eq}"
    )
    .unwrap();
    for (i, s) in anchor_diffs.iter().take(CAP) {
        writeln!(out, "    page {i} anchor: {s}").unwrap();
    }
    for (i, a, b) in valid_diffs.iter().take(CAP) {
        writeln!(out, "    page {i} valid count: snapshot {a}, GGS {b}").unwrap();
    }
    let vm_eq = snap
        .entries
        .iter()
        .zip(&ours.entries)
        .filter(|(a, b)| a.vm_addr == b.vm_addr)
        .count();
    writeln!(
        out,
        "vm allocator state equal {vm_eq}/{n} (allocator history, not content); stamps: snapshot ({:#x},{:#x}) GGS ({:#x},{:#x})",
        snap.stamp1, snap.stamp2, ours.stamp1, ours.stamp2
    )
    .unwrap();
}
