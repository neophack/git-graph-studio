//! The Node compatibility layer's host half: the code the frame's CommonJS loader runs.
//! The extension's loadable code crosses once at activation (a `postMessage` read cannot
//! answer a synchronous `require`), bounded so a heavy package cannot balloon the IPC
//! message.

use std::collections::BTreeMap;
use std::path::Path;

use serde::Serialize;

/// The extension's loadable code, as one batch: every `.js` / `.cjs` / `.json` file under its
/// install directory (bundled entry points, un-bundled multi-file code and `node_modules`
/// alike), bounded. The frame's `require()` resolves against this map synchronously — a
/// `postMessage` read cannot answer a synchronous `require`, so the whole loadable surface
/// crosses once at activation instead.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExtCodeBundle {
    /// Package-relative paths with `/` separators, keyed as the loader normalizes them.
    pub files: BTreeMap<String, String>,
    /// Binary files the package reads with `fs.readFileSync` (`.wasm` payloads above all),
    /// base64-encoded: the frame's `fs` serves them synchronously from this preload.
    pub blob_files: BTreeMap<String, String>,
    /// The bounds below were hit: code beyond them did not cross, and a `require` of it fails
    /// with the reason (the frame surfaces that error rather than a mystery).
    pub truncated: bool,
    /// The package's binary native modules (`.node`), as package-relative paths — present in
    /// the install, absent from the text map (their bytes are not code to run in the frame).
    /// The frame's `require` of one answers the native-module proxy the host serves over the
    /// package's backend, and its `fs.existsSync` sees the file.
    pub binaries: Vec<String>,
}

/// Read one file inside an installed extension's directory as an extension-dir relative
/// path, or `None` when it is not a loadable text file (the walk's per-file filter). A
/// `.js.map` source map ends in `.map` and never matches; `.json` files this store itself
/// writes (`studio-ext.json`) ride along harmlessly.
fn read_code_file(root: &Path, rel: &Path) -> Option<String> {
    let extension = rel.extension().and_then(|e| e.to_str())?;
    if !matches!(
        extension.to_ascii_lowercase().as_str(),
        "js" | "cjs" | "json"
    ) {
        return None;
    }
    let bytes = std::fs::read(root.join(rel)).ok()?;
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

/// The loader map of `root` (see [`ExtCodeBundle`]): bounded by file count, per-file size
/// and total size — an unbounded eager preload of a heavy package would balloon the IPC
/// message. The `node_modules` subtree is included on purpose: an un-bundled extension's
/// `require('dep')` walks into it exactly like Node's.
///
/// The bounds are generous on purpose (a 2026-era marketplace bundle ships a multi-megabyte
/// `out/client/extension.js` and megabyte-scale unicode tables it genuinely `require`s);
/// the cost is one activation-time IPC crossing, paid by the packages that need it.
pub fn load_code_from(root: &Path) -> Result<ExtCodeBundle, String> {
    const MAX_FILES: usize = 1200;
    const MAX_TOTAL_BYTES: u64 = 64 * 1024 * 1024;
    const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024;
    const MAX_DEPTH: usize = 12;

    struct Bounds {
        max_files: usize,
        max_total_bytes: u64,
        max_file_bytes: u64,
        max_depth: usize,
        total: u64,
        truncated: bool,
    }
    struct Acc<'a> {
        files: &'a mut BTreeMap<String, String>,
        binaries: &'a mut Vec<String>,
        blob_files: &'a mut BTreeMap<String, String>,
        bounds: &'a mut Bounds,
    }
    fn walk(root: &Path, dir: &Path, prefix: &str, depth: usize, acc: &mut Acc) -> Result<(), String> {
        if depth > acc.bounds.max_depth {
            acc.bounds.truncated = true;
            return Ok(());
        }
        let entries = std::fs::read_dir(dir).map_err(|e| format!("read {}: {e}", dir.display()))?;
        for entry in entries.flatten() {
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            if name == ".git" {
                continue;
            }
            let rel = if prefix.is_empty() {
                name.to_owned()
            } else {
                format!("{prefix}/{name}")
            };
            let Ok(meta) = entry.metadata() else { continue };
            if meta.is_dir() {
                walk(root, &entry.path(), &rel, depth + 1, acc)?;
                continue;
            }
            // The binary native modules cross as paths, not text: the frame cannot run their
            // bytes, but `require` of one answers the host-served proxy and `fs` sees the file.
            if rel.to_ascii_lowercase().ends_with(".node") {
                acc.binaries.push(rel);
                continue;
            }
            // `.wasm` payloads a package instantiates: preloaded base64 so the frame's
            // synchronous `readFileSync` answers without a round trip.
            if rel.to_ascii_lowercase().ends_with(".wasm") {
                let bytes = std::fs::read(entry.path()).unwrap_or_default();
                use base64::Engine as _;
                acc.blob_files.insert(
                    rel,
                    base64::engine::general_purpose::STANDARD.encode(&bytes),
                );
                continue;
            }
            // One oversized file is skipped while the walk continues — a bundled `.js` the
            // map can live without must not hide the package's small modules.
            if meta.len() > acc.bounds.max_file_bytes {
                acc.bounds.truncated = true;
                continue;
            }
            // The capacity bounds end the walk: nothing further would fit anyway.
            if acc.files.len() >= acc.bounds.max_files
                || acc.bounds.total >= acc.bounds.max_total_bytes
            {
                acc.bounds.truncated = true;
                return Ok(());
            }
            if let Some(text) = read_code_file(root, Path::new(&rel)) {
                acc.bounds.total += text.len() as u64;
                acc.files.insert(rel, text);
            }
        }
        Ok(())
    }

    let mut files = BTreeMap::new();
    let mut binaries = Vec::new();
    let mut blob_files = BTreeMap::new();
    let mut bounds = Bounds {
        max_files: MAX_FILES,
        max_total_bytes: MAX_TOTAL_BYTES,
        max_file_bytes: MAX_FILE_BYTES,
        max_depth: MAX_DEPTH,
        total: 0,
        truncated: false,
    };
    {
        let mut acc = Acc {
            files: &mut files,
            binaries: &mut binaries,
            blob_files: &mut blob_files,
            bounds: &mut bounds,
        };
        walk(root, root, "", 0, &mut acc)?;
    }
    // A frame keeps a package's `.node` files out of sight entirely: a frame cannot run a
    // NAPI addon (that is the real-Node extension host's job — nodeHost.ts), and hiding
    // the files makes the package's own native-or-CLI fallback — which probes
    // `fs.existsSync` on the binary — honestly answer "absent" and engage.
    Ok(ExtCodeBundle {
        files,
        blob_files,
        truncated: bounds.truncated,
        binaries,
    })
}
