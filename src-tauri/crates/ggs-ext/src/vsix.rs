//! The `.vsix` half: reading and tolerantly parsing the package's `package.json`
//! (JSONC, the way VS Code's own manifest reader works), the native-`.node` scan,
//! the backend derivation (`resolve_node_binaries`), the archive extraction with its
//! mode keeping, and the version comparison every upgrade rule shares.

use std::io::Read;
use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::store::{BackendDecl, host_platform_key};

#[derive(Deserialize, Debug)]
pub struct VsixManifest {
    pub(crate) name: String,
    pub(crate) publisher: String,
    pub(crate) version: String,
    /// The package's own JS entry (VS Code's extension-host entry). The frame host runs it
    /// for the `vscode` API; the pretend Node runtime runs it as the package's backend when
    /// the install derives one (native binaries, or a main the sandboxed frame cannot host).
    #[serde(default)]
    pub(crate) main: Option<String>,
    #[serde(default)]
    pub(crate) description: Option<String>,
    #[serde(default)]
    pub(crate) icon: Option<String>,
    #[serde(default, rename = "displayName")]
    pub(crate) display_name: Option<String>,
    #[serde(default)]
    pub(crate) categories: Vec<String>,
    #[serde(default)]
    pub(crate) keywords: Vec<String>,
    #[serde(default)]
    pub(crate) repository: Option<RepositoryField>,
    #[serde(default)]
    pub(crate) license: Option<String>,
    #[serde(default)]
    pub(crate) engines: Option<Engines>,
    #[serde(default, rename = "extensionDependencies")]
    pub(crate) extension_dependencies: Vec<String>,
    #[serde(default, rename = "extensionPack")]
    pub(crate) extension_pack: Vec<String>,
    /// VS Code's own declaration of where a package runs. `["workspace"]` says the
    /// package needs workspace-side (process) capabilities — the filesystem beyond the
    /// open folders, real crypto, real children — which this host's sandboxed frame
    /// cannot serve; the install honours it by deriving the ggs-node backend.
    #[serde(default, rename = "extensionKind")]
    pub(crate) extension_kind: Vec<String>,
}

/// `repository` is either a URL string or `{ "type": "git", "url": "..." }`.
#[derive(Deserialize, Debug)]
#[serde(untagged)]
pub(crate) enum RepositoryField {
    Url(String),
    Object { url: Option<String> },
}

impl RepositoryField {
    pub(crate) fn url(&self) -> Option<&str> {
        match self {
            RepositoryField::Url(url) => Some(url),
            RepositoryField::Object { url } => url.as_deref(),
        }
    }
}

#[derive(Deserialize, Debug)]
pub(crate) struct Engines {
    #[serde(rename = "vscode", default)]
    pub(crate) vscode: Option<String>,
}

impl VsixManifest {
    pub(crate) fn url_of(&self) -> Option<&str> {
        self.repository.as_ref().and_then(|r| r.url())
    }

    /// `{publisher}.{name}` — the store's extension id (the gallery's install stop-first
    /// needs it before the install itself).
    pub fn extension_id(&self) -> String {
        format!("{}.{}", self.publisher, self.name)
    }
}

/// `package.json` of an already-unpacked extension directory (`{dir}/package.json`).
pub(crate) fn read_manifest(dir: &Path) -> Option<VsixManifest> {
    let bytes = std::fs::read(dir.join("package.json")).ok()?;
    let manifest: VsixManifest = parse_jsonc_manifest(&bytes).ok()?;
    if manifest.name.is_empty() || manifest.publisher.is_empty() {
        return None;
    }
    Some(manifest)
}

/// Parse `package.json` the way VS Code reads extension manifests: as JSONC — `//` and
/// `/* */` comments plus trailing commas are tolerated (hand-authored packages in the wild
/// carry both; a strict parser refuses a package VS Code itself would run). Stripped before
/// `serde_json` sees it, with string contents preserved untouched.
pub(crate) fn parse_jsonc_manifest(bytes: &[u8]) -> Result<VsixManifest, String> {
    let text = String::from_utf8_lossy(bytes);
    let stripped = strip_trailing_commas(&strip_jsonc_comments(&text));
    let value: serde_json::Value =
        serde_json::from_str(&stripped).map_err(|e| format!("invalid package.json: {e}"))?;
    serde_json::from_value(value).map_err(|e| format!("invalid package.json: {e}"))
}

/// Remove `// line` and `/* block */` comments that are outside string literals. Operates on
/// `char`s (never bytes) so multi-byte text survives both inside and outside strings.
pub(crate) fn strip_jsonc_comments(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut at = 0;
    let mut in_string = false;
    let mut escaped = false;
    while at < chars.len() {
        let ch = chars[at];
        if in_string {
            out.push(ch);
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_string = false;
            }
            at += 1;
            continue;
        }
        match ch {
            '"' => {
                in_string = true;
                out.push('"');
                at += 1;
            }
            '/' if at + 1 < chars.len() && chars[at + 1] == '/' => {
                while at < chars.len() && chars[at] != '\n' {
                    at += 1;
                }
            }
            '/' if at + 1 < chars.len() && chars[at + 1] == '*' => {
                at += 2;
                while at + 1 < chars.len() && !(chars[at] == '*' && chars[at + 1] == '/') {
                    at += 1;
                }
                at = (at + 2).min(chars.len());
            }
            _ => {
                out.push(ch);
                at += 1;
            }
        }
    }
    out
}

/// Drop commas whose next non-whitespace character is `]` or `}` (JSONC's trailing commas).
pub(crate) fn strip_trailing_commas(text: &str) -> String {
    // String-aware: a comma inside a string literal is content, not syntax — `"\d{2,}"`
    // followed by `}` must keep its comma (dropping it silently rewrote a grammar's
    // regex into a different one, and the manifest still parsed). The same in_string /
    // escaped walk `strip_jsonc_comments` runs.
    let mut out = String::with_capacity(text.len());
    let mut pending_comma = false;
    let mut pending_whitespace = String::new();
    let mut in_string = false;
    let mut escaped = false;
    for ch in text.chars() {
        if in_string {
            out.push(ch);
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_string = false;
            }
            continue;
        }
        if ch == ',' {
            // Held back — with the whitespace that follows it — until the next
            // non-whitespace character says whether it was a trailing comma.
            pending_comma = true;
            pending_whitespace.clear();
            continue;
        }
        if pending_comma {
            if ch.is_whitespace() {
                pending_whitespace.push(ch);
                continue;
            }
            if ch != ']' && ch != '}' {
                // A live comma: it goes back exactly where it was, before the gap.
                out.push(',');
                out.push_str(&pending_whitespace);
            } else {
                // Trailing: the comma goes, the whitespace between stays.
                out.push_str(&pending_whitespace);
            }
            pending_whitespace.clear();
            pending_comma = false;
        }
        if ch == '"' {
            in_string = true;
        }
        out.push(ch);
    }
    if pending_comma {
        out.push(',');
    }
    out
}

/// Read and validate the `extension/package.json` a `.vsix` carries. The `main` entry point
/// is required of a frame-hosted extension (the host runs a compiled bundle); a package that
/// carries only a process backend and pages — the VSIX shape of the retired custom package — needs no `main`.
pub fn read_vsix_manifest(vsix: &Path) -> Result<VsixManifest, String> {
    let file = std::fs::File::open(vsix).map_err(|e| format!("open {}: {e}", vsix.display()))?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("read VSIX: {e}"))?;
    let mut bytes = Vec::new();
    zip.by_name("extension/package.json")
        .map_err(|_| "not a VSIX: missing extension/package.json".to_string())?
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    let manifest: VsixManifest = parse_jsonc_manifest(&bytes)?;
    if manifest.name.is_empty() || manifest.publisher.is_empty() {
        return Err("package.json needs a name and a publisher".to_string());
    }
    // Compatibility is the point of the VSIX path: the store's format is accepted as-is,
    // whatever the package carries — a compiled bundle (`main`, hosted in a frame), a
    // native engine (its `.node` under this host's Node runtime), or neither (themes,
    // snippets, grammars: installed for their contributions alone).
    Ok(manifest)
}

/// The `.node` files a VSIX carries, package-relative (scanned by name — nothing is
/// unpacked or executed to answer this).
fn native_node_files(vsix: &Path) -> Result<Vec<String>, String> {
    let file = std::fs::File::open(vsix).map_err(|e| format!("open {}: {e}", vsix.display()))?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("read VSIX: {e}"))?;
    let mut found = Vec::new();
    for i in 0..zip.len() {
        let entry = zip.by_index(i).map_err(|e| e.to_string())?;
        let name = entry.name().to_owned();
        if name.to_ascii_lowercase().ends_with(".node") {
            if let Some(rel) = name.strip_prefix("extension/") {
                found.push(rel.to_owned());
            }
        }
    }
    Ok(found)
}

/// Whether a VSIX's native `.node` binaries have something here to run them, and the
/// backend to derive when the package declared none. A declared backend (process or node —
/// the package owns its runtime story either way) installs as-is. A plain VSIX with the
/// packers' engine layout (`native/<platform>/`) derives that `.node` as its backend only
/// under the real-Node host (`GGS_REAL_NODE`: there the `.node` IS the backend command,
/// nodeHost.ts loading it as the NAPI addon it is). On the default host the package's JS
/// `main` is the derived backend, and its activation `require`s the engine `.node` right
/// inside ggs-node (the N-API host) — the package's own fallback logic engages only if
/// that load fails. A package with native binaries but no
/// `main` is the named failure at the door — a package that installs and silently never
/// works is the one outcome this refuses to produce.
/// GGS-patch: the frame host's own code-map ceilings (loadcode's `load_code_from` skips a
/// single file past 8 MB and the whole map past 64 MB) — a main past either runs on
/// ggs-node instead of the sandboxed frame.
const FRAME_MAIN_MAX_BYTES: u64 = 8 * 1024 * 1024;
const FRAME_TREE_MAX_BYTES: u64 = 48 * 1024 * 1024;

/// The directory an entry's chunk set lives in (`dist` for `./dist/extension.js`, the
/// package root for a bare `main.js`) — what the frame's code map would have carried.
fn entry_dir_of(main: &str) -> Option<String> {
    let without_file = main.rsplit_once('/')?.0;
    if without_file.is_empty() {
        None
    } else {
        Some(without_file.to_owned())
    }
}

pub fn resolve_node_binaries(
    manifest: &VsixManifest,
    vsix: &Path,
    real_node: bool,
) -> Result<Option<BackendDecl>, String> {
    let nodes = native_node_files(vsix)?;
    if nodes.is_empty() {
        // GGS-patch: a main-only package whose loadable code the sandboxed frame cannot
        // host derives a `ggs-node` backend anyway — the sidecar reads its files straight
        // from the install directory (no code map, no caps) and serves the same vscode
        // shim as a frame. Three shapes cannot be hosted by a frame, all read from
        // the VSIX's own entries (the install directory does not exist yet here):
        //
        //   too big     the frame host's code map skips the file outright (Kimi Code's
        //               8.8 MB `extension.js` crossed no route before this rule and
        //               activation failed on a missing module);
        //   listening   the package's loadable code opens listening sockets through a
        //               qualified call (`http.createServer(…)` — the frame's http/net
        //               shims are client halves over the host bridge, nothing there can
        //               ACCEPT a connection). The call may sit in the entry or in a
        //               module it requires — so the scan reads every `.js` / `.cjs`
        //               file the frame's own code map would carry, the `node_modules`
        //               tree included;
        //   crypto      the package's code calls a crypto CONSTRUCTOR the frame's shim
        //               refuses outright (`crypto.createHmac(…)`, `createCipheriv(…)`,
        //               … — the frame serves the digests and the randoms, but these
        //               answer `callThrowsFn` at invocation; Claude Remote 2.0 dropped
        //               its LAN server and crossed NO route before this rule — it
        //               installed `backend: null`, landed in a frame, and its
        //               activation died on `crypto.createHmac is not supported`. The
        //               same qualified-form discipline: only `crypto.createHmac` counts,
        //               `h = crypto.createHmac` bound-and-called-later rides too, but a
        //               minified alias (`n(...)`) never carries the qualified form.
        //
        // Only QUALIFIED calls count: a minified bundle aliases the module
        // (`l.createServer` — ms-python's named-pipe transport) and never carries the
        // qualified form, so client-only bundles stay in their frame; a hand-written
        // server says `http.createServer`. A false positive only lands a package on
        // the fuller runtime — the frame is the degraded host, not the other way round.
        // A package that DECLARES its side needs no scan: VS Code's `extensionKind:
        // ["workspace"]` is the package's own word that it runs where processes live
        // (Claude Remote 2.0 — its crypto and the session store outside the workspace
        // cannot be served by a frame, and its minified require alias hid the call from
        // the qualified-form scan besides).
        if manifest
            .extension_kind
            .iter()
            .any(|kind| kind.eq_ignore_ascii_case("workspace"))
        {
            if let Some(main) = manifest
                .main
                .as_deref()
                .filter(|main| !main.trim().is_empty())
            {
                return Ok(Some(BackendDecl {
                    kind: "node".to_owned(),
                    command: main.to_owned(),
                    args: Vec::new(),
                    protocol: None,
                    binaries: None,
                }));
            }
        }
        if let Some(main) = manifest
            .main
            .as_deref()
            .filter(|main| !main.trim().is_empty())
        {
            let main_rel = format!("extension/{}", main.trim_start_matches("./"));
            let entry_dir = entry_dir_of(main.trim_start_matches("./"));
            let (mut entry_bytes, mut tree_bytes) = (0u64, 0u64);
            // Every loadable code file's text, for the socket scan below — the entry, its
            // siblings and the `node_modules` tree alike, each within the frame map's own
            // per-file bound (a file past it never crosses to the frame, so a socket call
            // there cannot run in one either).
            let mut code_text = String::new();
            let file =
                std::fs::File::open(vsix).map_err(|e| format!("open {}: {e}", vsix.display()))?;
            let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("read VSIX: {e}"))?;
            for i in 0..zip.len() {
                let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
                let name = entry.name().to_owned();
                let Some(rel) = name.strip_prefix("extension/").map(|r| r.to_owned()) else {
                    continue; // [Content_Types].xml, extension.vsixmanifest, …
                };
                if name == main_rel {
                    entry_bytes = entry.size();
                } else if !rel.is_empty()
                    && entry_dir.as_deref().is_some_and(|dir| rel.starts_with(dir))
                {
                    tree_bytes += entry.size();
                }
                if entry.is_dir() {
                    continue;
                }
                let lower = rel.to_ascii_lowercase();
                if (lower.ends_with(".js") || lower.ends_with(".cjs"))
                    && entry.size() <= FRAME_MAIN_MAX_BYTES
                {
                    // Best effort: a binary or non-UTF-8 file simply misses the socket rule.
                    let mut text = String::new();
                    let _ = entry.read_to_string(&mut text);
                    code_text.push_str(&text);
                    // A file boundary never fuses two halves into a qualified call.
                    code_text.push('\n');
                }
            }
            let too_big = entry_bytes > FRAME_MAIN_MAX_BYTES || tree_bytes > FRAME_TREE_MAX_BYTES;
            const QUALIFIED_SERVER_CALLS: [&str; 5] = [
                "http.createServer",
                "https.createServer",
                "net.createServer",
                "tls.createServer",
                "dgram.createServer",
            ];
            // The crypto constructors the frame's shim answers with an honest throw —
            // the digests (`createHash`) and the randoms ARE served in a frame and stay
            // off this list, so packages that only hash keep their frame.
            const QUALIFIED_CRYPTO_CALLS: [&str; 5] = [
                "crypto.createHmac",
                "crypto.createCipheriv",
                "crypto.createDecipheriv",
                "crypto.createSign",
                "crypto.createVerify",
            ];
            let needs_process_runtime = QUALIFIED_SERVER_CALLS
                .iter()
                .chain(QUALIFIED_CRYPTO_CALLS.iter())
                .any(|call| code_text.contains(call));
            if too_big || needs_process_runtime {
                return Ok(Some(BackendDecl {
                    kind: "node".to_owned(),
                    command: main.to_owned(),
                    args: Vec::new(),
                    protocol: None,
                    binaries: None,
                }));
            }
        }
        return Ok(None);
    }
    let platform = host_platform_key();
    if real_node {
        if let Some(node) = platform_engine_node(&nodes, &platform) {
            // The `.node` IS the backend: a real Node runtime loads it as the NAPI addon
            // it is (nodeHost.ts).
            return Ok(Some(BackendDecl {
                kind: "node".to_owned(),
                command: node.clone(),
                args: Vec::new(),

                protocol: None,
                binaries: Some(std::collections::BTreeMap::from([(platform, node)])),
            }));
        }
    }
    let Some(main) = manifest
        .main
        .as_deref()
        .filter(|main| !main.trim().is_empty())
    else {
        let listed = nodes
            .iter()
            .map(|n| format!("`{n}`"))
            .collect::<Vec<_>>()
            .join(", ");
        return Err(format!(
            "this extension carries native Node binaries ({listed}) but declares no \"main\" entry to run them with — ship a \"main\" in its package.json"
        ));
    };
    Ok(Some(BackendDecl {
        kind: "node".to_owned(),
        command: main.to_owned(),
        args: Vec::new(),

        protocol: None,
        binaries: None,
    }))
}

/// The platform directory names the packers lay engine binaries under, keyed by the host
/// platform key (`{os}-{arch}`) — the same table prepare.mjs builds the bundled engine
/// with, because the VSIX layout is the packer's decision, not the installer's.
fn platform_engine_directory(platform: &str) -> Option<&'static str> {
    match platform {
        "win32-x64" => Some("win32-x64-msvc"),
        "win32-arm64" => Some("win32-arm64-msvc"),
        "linux-x64" => Some("linux-x64-gnu"),
        "linux-arm64" => Some("linux-arm64-gnu"),
        "darwin-x64" => Some("darwin-x64"),
        "darwin-arm64" => Some("darwin-arm64"),
        _ => None,
    }
}

/// The package's engine `.node` for `platform`: the one under `native/<directory>/`, the
/// layout the packers lay engines in. Any other `.node` a package carries is a dependency
/// addon of its own `main`, never a backend.
fn platform_engine_node(nodes: &[String], platform: &str) -> Option<String> {
    let directory = platform_engine_directory(platform)?;
    let needle = format!("native/{directory}/");
    nodes
        .iter()
        .find(|node| node.replace('\\', "/").contains(&needle))
        .cloned()
}

/// Unpack a `.vsix`: everything under `extension/` lands at the install root; the OPC
/// housekeeping files VSIXs carry at the archive root (`[Content_Types].xml`, …) are skipped.
pub(crate) fn extract_vsix(vsix: &Path, target: &Path) -> Result<(), String> {
    let file = std::fs::File::open(vsix).map_err(|e| format!("open {}: {e}", vsix.display()))?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("read VSIX: {e}"))?;
    std::fs::create_dir_all(target).map_err(|e| e.to_string())?;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
        if entry.is_dir() {
            continue;
        }
        let Some(rel) = entry.name().strip_prefix("extension/") else {
            continue;
        };
        let dest = safe_join(target, rel)?;
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        #[cfg(unix)]
        let mode = entry.unix_mode();
        let mut bytes = Vec::new();
        entry.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
        std::fs::write(&dest, &bytes).map_err(|e| format!("write {}: {e}", dest.display()))?;
        // The executable bit the archive recorded — a package's own CLI (claude-code's
        // `resources/native-binary/claude`) loses it otherwise, and its spawn fails with
        // EACCES on Linux and macOS. VS Code's extractor applies the same mode.
        #[cfg(unix)]
        if let Some(mode) = mode.filter(|mode| mode & 0o111 != 0) {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(
                &dest,
                std::fs::Permissions::from_mode((mode & 0o777) | 0o600),
            )
            .map_err(|e| format!("chmod {}: {e}", dest.display()))?;
        }
    }
    Ok(())
}

/// Numeric x.y.z comparison; anything unparseable sorts below everything else.
pub fn compare_versions(a: &str, b: &str) -> std::cmp::Ordering {
    parse_version(a).cmp(&parse_version(b))
}

fn parse_version(v: &str) -> (u64, u64, u64) {
    let mut parts = v.split(['-', '+']).next().unwrap_or("").split('.');
    let mut next = || parts.next().and_then(|p| p.parse().ok()).unwrap_or(0);
    (next(), next(), next())
}

/// Reject archive entries that escape the install directory.
pub fn safe_join(base: &Path, rel: &str) -> Result<PathBuf, String> {
    let rel_path = Path::new(rel);
    if rel_path.is_absolute() || rel_path.components().any(|c| c.as_os_str() == "..") {
        return Err(format!("unsafe entry in VSIX: {rel}"));
    }
    Ok(base.join(rel_path))
}

#[cfg(test)]
mod backend_derivation_tests {
    use super::*;
    use std::io::Write as _;

    /// A plain VSIX: a package.json with `main`, plus the named `.node` binaries.
    fn make_plain_vsix_with_nodes(dir: &Path, nodes: &[(&str, &Path)]) -> PathBuf {
        let vsix = dir.join("acme.engine-1.0.0.vsix");
        let file = std::fs::File::create(&vsix).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        zip.start_file("extension/package.json", options).unwrap();
        zip.write_all(
            br#"{"name":"engine","publisher":"acme","version":"1.0.0","main":"./out/extension.js"}"#,
        )
        .unwrap();
        zip.start_file("extension/out/extension.js", options)
            .unwrap();
        zip.write_all(b"// the package's main\n").unwrap();
        for (relative, source) in nodes {
            zip.start_file(format!("extension/{relative}"), options)
                .unwrap();
            let bytes = std::fs::read(source).unwrap();
            zip.write_all(&bytes).unwrap();
        }
        zip.finish().unwrap();
        vsix
    }

    #[test]
    fn the_derived_backend_is_the_platform_engine_node() {
        let tmp = tempfile::tempdir().unwrap();
        // Any bytes stand in for the binary: the derivation reads names, and a real Node
        // runtime (nodeHost.ts) loads the addon as the NAPI module it is. The fixture rides
        // the HOST platform's directory — CI runs this on Linux and Windows alike, and the
        // packers' name comes from the same table the derivation matches with.
        let relative = format!(
            "native/{}/git-graph.node",
            platform_engine_directory(&host_platform_key())
                .expect("the host platform is one the packers lay engines under")
        );
        let node = tmp.path().join("engine.node");
        std::fs::write(&node, b"engine-node-fixture").unwrap();
        let vsix = make_plain_vsix_with_nodes(tmp.path(), &[(&relative, &node)]);
        let manifest = read_vsix_manifest(&vsix).unwrap();
        let derived = resolve_node_binaries(&manifest, &vsix, true)
            .unwrap()
            .expect("a backend");
        assert_eq!(derived.kind, "node");
        assert_eq!(derived.command_for(&host_platform_key()), relative);
        assert!(derived.binaries.is_some());
        // Under the default host (ggs-node, Boa) the engine `.node` cannot load: the
        // package's own JS `main` is the backend instead, and its fallback logic runs.
        let derived = resolve_node_binaries(&manifest, &vsix, false)
            .unwrap()
            .expect("a backend");
        assert_eq!(derived.command, "./out/extension.js");
        assert!(derived.binaries.is_none());
    }

    #[test]
    fn an_engine_node_for_another_platform_leaves_the_main_as_the_derived_backend() {
        let tmp = tempfile::tempdir().unwrap();
        // A directory the host never matches — the host's own OS flipped, so the same test
        // says "foreign platform" on every runner (CI's Linux host met the hardcoded
        // linux-x64-gnu name as its own).
        let other = if cfg!(target_os = "windows") {
            "linux-x64-gnu"
        } else {
            "win32-x64-msvc"
        };
        let relative = format!("native/{other}/git-graph.node");
        let node = tmp.path().join("other.node");
        std::fs::write(&node, b"other-engine-fixture").unwrap();
        let vsix = make_plain_vsix_with_nodes(tmp.path(), &[(&relative, &node)]);
        let manifest = read_vsix_manifest(&vsix).unwrap();
        let derived = resolve_node_binaries(&manifest, &vsix, true)
            .unwrap()
            .expect("a backend");
        assert_eq!(derived.command, "./out/extension.js");
        assert!(derived.binaries.is_none());
    }

    #[test]
    fn the_engine_node_picks_the_platform_directory_only() {
        let nodes = |list: &[&str]| -> Vec<String> { list.iter().map(|s| s.to_string()).collect() };
        // The platform directory the packers lay engines under is the pick; anything else
        // is a dependency addon of the package's own main.
        assert_eq!(
            platform_engine_node(
                &nodes(&[
                    "native/win32-x64-msvc/git-graph.node",
                    "native/linux-x64-gnu/git-graph.node"
                ]),
                "linux-x64",
            )
            .as_deref(),
            Some("native/linux-x64-gnu/git-graph.node")
        );
        assert_eq!(
            platform_engine_node(
                &nodes(&["native/darwin-arm64/git-graph.node"]),
                "darwin-arm64"
            )
            .as_deref(),
            Some("native/darwin-arm64/git-graph.node")
        );
        // A binary outside the platform layout is a dependency, never the engine.
        assert_eq!(
            platform_engine_node(&nodes(&["bin/engine.node"]), "win32-x64").as_deref(),
            None
        );
        // Two binaries, neither for this platform: no pick (the main stays the backend).
        assert_eq!(
            platform_engine_node(
                &nodes(&[
                    "native/win32-x64-msvc/git-graph.node",
                    "native/linux-x64-gnu/git-graph.node"
                ]),
                "darwin-x64",
            ),
            None
        );
    }
}


#[cfg(test)]
mod crypto_derivation_tests {
    use crate::install_from_vsix_into;
    use std::io::Write as _;

    #[test]
    fn a_package_that_calls_crypto_createhmac_derives_the_node_backend() {
        // Claude Remote 2.0's shape: no LAN server left, but its E2E layer says
        // `crypto.createHmac(…)` qualified — the frame's crypto shim refuses the call at
        // invocation, so the install derives the process backend. Before this rule the
        // package installed `backend: null` and its activation died on
        // "crypto.createHmac is not supported by the … extension host".
        let tmp = tempfile::tempdir().unwrap();
        let exts = tmp.path().join("extensions");
        std::fs::create_dir_all(&exts).unwrap();
        let vsix = tmp.path().join("remote2.vsix");
        let file = std::fs::File::create(&vsix).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default();
        zip.start_file("extension/package.json", options).unwrap();
        zip.write_all(
            br#"{"name":"remote2","publisher":"ggs","version":"2.0.1","main":"./extension.js"}"#,
        )
        .unwrap();
        zip.start_file("extension/extension.js", options).unwrap();
        zip.write_all(b"module.exports = { activate: () => {} };")
            .unwrap();
        zip.start_file("extension/crypto.js", options).unwrap();
        zip.write_all(
            // The qualified form, exactly as the real crypto.js spells it — an aliased
            // require (nodeCrypto.createHmac) is the minified shape the rule leaves alone.
            b"const crypto = require('crypto');
const mac = crypto.createHmac('sha256', key).update(data).digest();
module.exports = { mac };",
        )
        .unwrap();
        zip.finish().unwrap();

        let info = install_from_vsix_into(&exts, &vsix, false).unwrap();
        let backend = info
            .capabilities
            .as_ref()
            .unwrap()
            .backend
            .as_ref()
            .expect("the crypto-writing module derives the node backend");
        assert_eq!(backend.kind, "node");
        assert_eq!(backend.command, "./extension.js");
    }

    #[test]
    fn a_package_declaring_extension_kind_workspace_derives_the_node_backend() {
        // The declaration beats the scan: Claude Remote 2.0's minified require alias
        // (`nodeCrypto.createHmac`) hides the call from the qualified-form rule, but the
        // package's own VS Code-standard word — `extensionKind: ["workspace"]`, "I need
        // the side where processes live" — derives the backend outright.
        let tmp = tempfile::tempdir().unwrap();
        let exts = tmp.path().join("extensions");
        std::fs::create_dir_all(&exts).unwrap();
        let vsix = tmp.path().join("workspace-side.vsix");
        let file = std::fs::File::create(&vsix).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default();
        zip.start_file("extension/package.json", options).unwrap();
        zip.write_all(
            br#"{"name":"wside","publisher":"ggs","version":"1.0.0","main":"./extension.js","extensionKind":["workspace"]}"#,
        )
        .unwrap();
        zip.start_file("extension/extension.js", options).unwrap();
        zip.write_all(b"const n = require('crypto'); n.createHmac('sha256', k);")
            .unwrap();
        zip.finish().unwrap();

        let info = install_from_vsix_into(&exts, &vsix, false).unwrap();
        let backend = info
            .capabilities
            .as_ref()
            .unwrap()
            .backend
            .as_ref()
            .expect("the declared workspace side derives the node backend");
        assert_eq!(backend.kind, "node");
        assert_eq!(backend.command, "./extension.js");
    }

    #[test]
    fn a_package_declaring_extension_kind_ui_stays_in_its_frame() {
        let tmp = tempfile::tempdir().unwrap();
        let exts = tmp.path().join("extensions");
        std::fs::create_dir_all(&exts).unwrap();
        let vsix = tmp.path().join("ui-side.vsix");
        let file = std::fs::File::create(&vsix).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default();
        zip.start_file("extension/package.json", options).unwrap();
        zip.write_all(
            br#"{"name":"uiside","publisher":"ggs","version":"1.0.0","main":"./extension.js","extensionKind":["ui"]}"#,
        )
        .unwrap();
        zip.start_file("extension/extension.js", options).unwrap();
        zip.write_all(b"module.exports = { activate: () => {} };")
            .unwrap();
        zip.finish().unwrap();

        let info = install_from_vsix_into(&exts, &vsix, false).unwrap();
        assert!(
            info.capabilities.as_ref().unwrap().backend.is_none(),
            "a declared ui side never derives a backend"
        );
    }

    #[test]
    fn a_package_that_only_hashes_stays_in_its_frame() {
        // `createHash` (and the randoms) ARE served by the frame's crypto shim — a
        // package that only digests keeps its frame; only the refused constructors
        // derive a backend.
        let tmp = tempfile::tempdir().unwrap();
        let exts = tmp.path().join("extensions");
        std::fs::create_dir_all(&exts).unwrap();
        let vsix = tmp.path().join("hashy.vsix");
        let file = std::fs::File::create(&vsix).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default();
        zip.start_file("extension/package.json", options).unwrap();
        zip.write_all(
            br#"{"name":"hashy","publisher":"ggs","version":"1.0.0","main":"./extension.js"}"#,
        )
        .unwrap();
        zip.start_file("extension/extension.js", options).unwrap();
        zip.write_all(
            b"const crypto = require('crypto');\nconst hex = crypto.createHash('sha256').update('x').digest('hex');\nmodule.exports = { activate: () => {}, hex };",
        )
        .unwrap();
        zip.finish().unwrap();

        let info = install_from_vsix_into(&exts, &vsix, false).unwrap();
        assert!(
            info.capabilities.as_ref().unwrap().backend.is_none(),
            "hashing alone never derives a backend"
        );
    }
}
