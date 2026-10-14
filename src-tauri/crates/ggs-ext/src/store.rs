//! The extension store over an explicit directory: the installed listing, `.vsix`
//! install / uninstall / forward-only upgrade, the bundled-package scan (pure — over
//! roots the app resolves), and an extension's storage layout. The store directory is
//! always a parameter; the app resolves `~/.ggs/extensions` (and its one-time
//! migration) and passes it in.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::vsix::{
    compare_versions, extract_vsix, read_manifest, read_vsix_manifest, resolve_node_binaries,
    VsixManifest,
};

/// Metadata Studio keeps alongside the unpacked package, so a built-in install survives being
/// listed next to user-installed extensions, and the package format is known without
/// re-reading the archive.
#[derive(Serialize, Deserialize, Clone)]
pub struct StudioExtMeta {
    pub(crate) builtin: bool,
    /// `vsix`, or the legacy `ggx` of installs made while the custom format existed.
    #[serde(default = "default_format")]
    pub(crate) format: String,
    /// The identity (`package_stamp`) of the bundled build this install was unpacked from —
    /// absent for a package installed from anywhere else, and for installs that predate it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) bundled_stamp: Option<String>,
}

pub(crate) fn default_format() -> String {
    "vsix".to_owned()
}

/// The runtime `manifest.json` every installed package carries. There is no package format
/// of its own any more: a VSIX is a VS Code extension, and everything it declares is the
/// standard `package.json` the frame host reads. The manifest is this host's own record of
/// the store identity plus the backend it derived for the package (when it runs one).
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StudioManifest {
    /// `{publisher}.{name}`; matches `package.json`.
    pub id: String,
    pub version: String,
    /// The backend derived at install (`resolve_node_binaries`: the package's `main` as a
    /// Node program, or its engine `.node` where a real Node runtime loads it). Absent for
    /// a package that needs no backend.
    #[serde(default)]
    pub backend: Option<BackendDecl>,
}

/// The backend of a package: a process the extension host spawns on demand — any
/// language that can write JSON lines to stdout qualifies.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BackendDecl {
    /// `process` — the package's own binary, spawned directly — or `node` — the package's
    /// engine `.node` (the same single engine binary the editor's Node runtime loads),
    /// hosted by `ggs-node`, whose N-API host loads it in-process.
    pub kind: String,
    /// The binary to run, relative to the package root (absolute is allowed: it is how the
    /// tests aim at a helper binary). Always present, even when `binaries` is too: it is the
    /// binary the build host packed, so it doubles as the fallback for a platform not listed
    /// in `binaries`. For `kind: "node"` this is the engine `.node` file's path instead.
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    /// The wire protocol the backend speaks. Only `ggs-ext/1` exists — the one protocol,
    /// concurrent on the plugin side, so a command-style plugin and a burst-answering
    /// engine plug in identically. The field is still read so a package packed before the
    /// unification names itself; `ext_process` rejects any value but the default with an
    /// upgrade hint instead of hanging a doomed handshake.
    #[serde(default)]
    pub protocol: Option<String>,
    /// Per-platform binary paths (`{os}-{arch}`, e.g. `win32-x64`), relative to the package
    /// root, for a package built with more than one platform's binary. Optional: a package
    /// packed by this app's own build scripts packs only the host platform's binary and this
    /// map has at most one entry, matching `command`.
    #[serde(default)]
    pub binaries: Option<std::collections::BTreeMap<String, String>>,
}

impl BackendDecl {
    /// The command to run for `platform_key` (see [`host_platform_key`]): `binaries[key]` when
    /// present, else the single `command` field every manifest has.
    pub fn command_for(&self, platform_key: &str) -> &str {
        self.binaries
            .as_ref()
            .and_then(|m| m.get(platform_key))
            .map(String::as_str)
            .unwrap_or(&self.command)
    }
}

/// This host's platform key, in the spelling the packers' `binaries` map uses
/// (`{os}-{arch}`, Node's own `process.platform`/`process.arch` words, since the build scripts
/// run under Node): `win32-x64`, `darwin-arm64`, `linux-x64`, …
pub fn host_platform_key() -> String {
    let os = if cfg!(target_os = "windows") {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    };
    let arch = if cfg!(target_arch = "x86_64") {
        "x64"
    } else if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        std::env::consts::ARCH
    };
    format!("{os}-{arch}")
}

/// The list format of a bundled offer: a package the installer carries but nothing installed —
/// the Extensions view's one-click Install cue. The app knows no bundled id: whatever packages
/// sit beside the installer ('bundled_packages_in' scans for them) are the offers.
pub const BUNDLED_FORMAT: &str = "bundled";

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExtInfo {
    /// `{publisher}.{name}` identifier.
    pub id: String,
    pub name: String,
    /// `displayName` from the manifest, when the extension declares one.
    pub display_name: Option<String>,
    pub publisher: String,
    pub version: String,
    pub description: String,
    pub builtin: bool,
    /// Absolute path of the extension's icon, when the manifest declares one.
    pub icon: Option<String>,
    /// Absolute path of the unpacked extension directory.
    pub path: String,
    pub categories: Vec<String>,
    pub keywords: Vec<String>,
    /// Repository URL (the manifest's `repository.url`, or the string form).
    pub repository: Option<String>,
    pub license: Option<String>,
    /// The `engines.vscode` constraint, shown like VS Code does ("Requires VS Code ^1.80.0").
    pub engines_vscode: Option<String>,
    pub extension_dependencies: Vec<String>,
    pub extension_pack: Vec<String>,
    /// The README / CHANGELOG file names inside the install, when present (the detail page
    /// renders them as markdown).
    pub readme: Option<String>,
    pub changelog: Option<String>,
    /// `builtin` or `vsix` (a legacy `ggx` still reads, from installs made while the format existed).
    pub format: String,
    /// The packer's page bundle (`webview/index.js`) is present in the install. The host's
    /// prewarm fetches it only when this is set: every other fetch is a guaranteed 404 —
    /// silent under the desktop's `ggs://` protocol, but one red console line per package in
    /// a browser session, where the same URL is an ordinary HTTP request.
    pub page_bundle: bool,
    /// The Studio capabilities the package's `ggs` key declared, as the runtime manifest
    /// the install generated from it.
    pub capabilities: Option<StudioManifest>,
}

impl ExtInfo {
    /// Fill the README / CHANGELOG names by looking for the file names VS Code itself probes
    /// (`README.md` case-insensitively, `CHANGELOG.md`).
    fn with_docs(mut self, dir: &Path) -> ExtInfo {
        self.readme = find_doc(dir, "README");
        self.changelog = find_doc(dir, "CHANGELOG");
        self
    }
}

/// The package's default NLS table (`package.nls.json`), when it ships one: extension
/// manifests keep `"displayName": "%displayName%"` placeholders that only the NLS file
/// resolves — the listing must not show the raw placeholder.
fn read_nls(dir: &Path) -> serde_json::Value {
    std::fs::read_to_string(dir.join("package.nls.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(serde_json::Value::Null)
}

/// VS Code's NLS rule: a value that is exactly one `%key%` resolves through the table; an
/// unknown key (or a plain value) stays verbatim.
fn nls_resolve(value: Option<String>, nls: &serde_json::Value) -> Option<String> {
    let raw = value?;
    if let Some(key) = raw.strip_prefix('%').and_then(|s| s.strip_suffix('%')) {
        if !key.is_empty() && !key.contains('%') {
            if let Some(resolved) = nls.get(key).and_then(serde_json::Value::as_str) {
                return Some(resolved.to_owned());
            }
        }
    }
    Some(raw)
}

/// The first `NAME.md`/`NAME` file in `dir` matching `name` case-insensitively (the usual spellings
/// VS Code's extension editor accepts), relative to the extension directory.
fn find_doc(dir: &Path, name: &str) -> Option<String> {
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        let file_name = entry.file_name();
        let Some(file) = file_name.to_str() else {
            continue;
        };
        let stem = file.split('.').next().unwrap_or("");
        if stem.eq_ignore_ascii_case(name)
            && (file.len() == stem.len()
                || file[stem.len()..].eq_ignore_ascii_case(".md")
                || file[stem.len()..].eq_ignore_ascii_case(".markdown"))
        {
            return Some(file.to_string());
        }
    }
    None
}

/// One bundled package as discovered beside the installer: its 'manifest.json' header and its
/// 'package.json', read straight out of the package zip.
pub struct BundledPackage {
    pub id: String,
    pub path: std::path::PathBuf,
    pub manifest: VsixManifest,
    pub capabilities: StudioManifest,
}

/// The `.vsix` packages in `roots`, by directory scan — the app names no id: the
/// installer's 'extensions/' resource directory first, then a dev run's
/// 'target/studio/bundled' (its versioned packages and the fixed-name copies prepare.mjs
/// assembles for the installer). Unreadable packages are skipped, not fatal — a half-updated
/// directory must not blind the Extensions view. First sighting of an id wins.
///
pub fn bundled_packages_in(roots: &[PathBuf]) -> Vec<BundledPackage> {
    let mut found: Vec<BundledPackage> = Vec::new();
    for root in roots {
        let Ok(entries) = std::fs::read_dir(root) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            // Any `.vsix` beside the installer is a bundled offer — a package is exactly a
            // VS Code extension, and its backend (when it runs one) derives from its own
            // `main` and native binaries. A package whose binaries have no `main` to run
            // them is skipped rather than fatal: discovery must never blind the view.
            if path.extension().and_then(|e| e.to_str()) != Some("vsix") {
                continue;
            }
            let Ok(manifest) = read_vsix_manifest(&path) else {
                continue;
            };
            let backend = resolve_node_binaries(&manifest, &path, crate::real_node_allowed()).ok().flatten();
            let capabilities = StudioManifest {
                id: format!("{}.{}", manifest.publisher, manifest.name),
                version: manifest.version.clone(),
                backend,
            };
            // Same id seen again: the higher version wins, and an exact tie is broken by
            // recency — the later root wins, so the fixed-name copies the installer actually
            // ships (app-resources, the last roots) outrank same-version leftovers a dev
            // tree may still carry from an earlier build. First-sighting would let a stale
            // versioned file shadow the shipped one.
            if let Some(existing) = found
                .iter_mut()
                .find(|package| package.id == capabilities.id)
            {
                if compare_versions(&capabilities.version, &existing.manifest.version)
                    != std::cmp::Ordering::Less
                {
                    existing.path = path;
                    existing.manifest = manifest;
                    existing.capabilities = capabilities;
                }
                continue;
            }
            found.push(BundledPackage {
                id: capabilities.id.clone(),
                path,
                manifest,
                capabilities,
            });
        }
    }
    found
}

/// A bundled package's offer entry: the manifest's own metadata, 'format: "bundled"' (the
/// one-click Install cue), no install directory.
pub fn bundled_offer(package: &BundledPackage) -> ExtInfo {
    let repository_url = package.manifest.url_of().map(str::to_string);
    ExtInfo {
        id: package.id.clone(),
        name: package.manifest.name.clone(),
        display_name: package.manifest.display_name.clone(),
        publisher: package.manifest.publisher.clone(),
        version: package.manifest.version.clone(),
        description: package.manifest.description.clone().unwrap_or_default(),
        builtin: false,
        icon: None,
        path: String::new(),
        categories: package.manifest.categories.clone(),
        keywords: package.manifest.keywords.clone(),
        repository: repository_url,
        license: package.manifest.license.clone(),
        engines_vscode: package
            .manifest
            .engines
            .as_ref()
            .and_then(|e| e.vscode.clone()),
        extension_dependencies: package.manifest.extension_dependencies.clone(),
        extension_pack: package.manifest.extension_pack.clone(),
        readme: None,
        changelog: None,
        format: BUNDLED_FORMAT.to_owned(),
        page_bundle: false,
        capabilities: Some(package.capabilities.clone()),
    }
}

/// The identity of one bundled build: its length and a hash of its bytes. Two builds of
/// the same version (a rebuilt engine, a re-laid-out package) differ here, which the version
/// alone cannot tell.
fn package_stamp(path: &Path) -> Option<String> {
    use std::hash::{Hash, Hasher};
    let bytes = std::fs::read(path).ok()?;
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    bytes.hash(&mut hasher);
    Some(format!("{}-{:016x}", bytes.len(), hasher.finish()))
}

/// Note in an install's `studio-ext.json` which bundled build it was unpacked from — the
/// app's one-click bundled install and the first-launch auto-install both stamp their
/// installs this way.
pub fn record_bundled_stamp(target: &Path, package: &Path) {
    let meta_path = target.join("studio-ext.json");
    let Some(mut meta) = std::fs::read_to_string(&meta_path)
        .ok()
        .and_then(|s| serde_json::from_str::<StudioExtMeta>(&s).ok())
    else {
        return;
    };
    meta.bundled_stamp = package_stamp(package);
    let _ = std::fs::write(&meta_path, serde_json::to_vec(&meta).unwrap());
}

/// The `studio-ext.json` of an install directory, when it reads.
fn install_meta(ext_dir: &Path) -> Option<StudioExtMeta> {
    let text = std::fs::read_to_string(ext_dir.join("studio-ext.json")).ok()?;
    serde_json::from_str(&text).ok()
}

/// The store id ("publisher.name") a package installs under — read straight off its
/// manifest, before any install exists to answer it.
fn manifest_id(manifest: &VsixManifest) -> Option<String> {
    let publisher = manifest.publisher.trim();
    let name = manifest.name.trim();
    if publisher.is_empty() || name.is_empty() {
        return None;
    }
    Some(format!("{publisher}.{name}"))
}

/// The dismiss marker of a deliberate uninstall: when the user removes a bundled package,
/// this file (not the package directory) is what a later boot reads — auto-install must
/// never resurrect an uninstall the user asked for.
pub(crate) fn bundled_dismissed_marker(dir: &Path, ext_id: &str) -> PathBuf {
    dir.join(format!(".bundled-dismissed-{ext_id}"))
}

/// The auto-install over raw package paths, not the scanned `BundledPackage` offers:
/// the bundled `.vsix` carries no `ggs` key (the submodule's own package.json never
/// declared one), and the ordinary install path derives its backend exactly as a hand
/// install of a marketplace package derives it.
pub fn install_missing_bundled_in(
    dir: &Path,
    packages: &[std::path::PathBuf],
) -> Vec<Result<String, String>> {
    let mut outcomes = Vec::new();
    for path in packages {
        let Ok(manifest) = read_vsix_manifest(path) else {
            continue;
        };
        let Some(id) = manifest_id(&manifest) else {
            continue;
        };
        if find_installed(dir, &id)
            .map(|versions| !versions.is_empty())
            .unwrap_or(false)
        {
            continue;
        }
        if bundled_dismissed_marker(dir, &id).is_file() {
            continue;
        }
        outcomes.push(install_from_vsix_into(dir, path, false).map(|info| {
            record_bundled_stamp(&dir.join(format!("{}-{}", info.id, info.version)), path);
            format!(
                "{} {} installed from the bundled package (first launch)",
                info.id, info.version
            )
        }));
    }
    outcomes
}

/// Every `.vsix` in `roots` (the app resolves the installer's resource directory and a dev
/// tree's bundled output), deduplicated by file name — the auto-install scans packages,
/// not offers, so a ggs-key-less marketplace shape installs too.
pub fn bundled_vsix_packages_in(roots: &[PathBuf]) -> Vec<std::path::PathBuf> {
    let mut found: Vec<std::path::PathBuf> = Vec::new();
    for root in roots {
        let Ok(entries) = std::fs::read_dir(root) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("vsix") {
                continue;
            }
            let name = path.file_name().map(|n| n.to_string_lossy().into_owned());
            if let Some(name) = name {
                if !found.iter().any(|p| {
                    p.file_name().map(|n| n.to_string_lossy().into_owned()) == Some(name.clone())
                }) {
                    found.push(path);
                }
            }
        }
    }
    found
}

/// The boot pass's refresh of installed packages the installer also ships: an installed id
/// is brought current with the bundled package before any backend starts. A bundled version
/// NEWER than the install upgrades it forward-only (the install hides the Extensions view's
/// bundled offer, so without this an app upgrade would leave its companion package behind
/// forever — eventually speaking a wire protocol the app no longer speaks); the SAME version
/// unpacked from an older build is refreshed by the recorded build stamp (an app upgrade
/// that rebuilt the package without bumping it); an installed NEWER version is never
/// downgraded; and nothing is installed that was not installed already — a deliberate
/// uninstall survives every launch. The replacement carries the replaced install's own
/// builtin flag. Run before any backend starts — a running binary holds its directory.
/// Returns one line per refreshed, upgraded or failed package, for the boot log.
pub fn refresh_bundled_installs_in(
    dir: &Path,
    packages: &[BundledPackage],
) -> Vec<Result<String, String>> {
    let mut outcomes = Vec::new();
    for package in packages {
        let version = &package.manifest.version;
        let Some(stamp) = package_stamp(&package.path) else {
            continue;
        };
        let Ok(installed) = find_installed(dir, &package.id) else {
            continue;
        };
        let Some(newest) = installed.iter().max_by(|a, b| compare_versions(a, b)) else {
            continue; // not installed — the refresh installs nothing
        };
        let dirs: Vec<PathBuf> = installed
            .iter()
            .map(|v| dir.join(format!("{}-{v}", package.id)))
            .collect();
        let newest_dir = dir.join(format!("{}-{newest}", package.id));
        let Some(meta) = install_meta(&newest_dir) else {
            continue; // an install whose own metadata cannot be read is left as it is
        };
        let outcome = match compare_versions(newest, version) {
            std::cmp::Ordering::Greater => continue,
            std::cmp::Ordering::Less => {
                replace_install(dir, &dirs, &package.path, meta.builtin).map(|()| {
                    format!(
                        "{} {newest} upgraded to {version} from the bundled package",
                        package.id
                    )
                })
            }
            std::cmp::Ordering::Equal => {
                if meta.bundled_stamp.as_deref() == Some(stamp.as_str()) {
                    continue;
                }
                replace_install(dir, &[newest_dir], &package.path, meta.builtin).map(
                    |()| {
                        format!(
                            "{0} {version} refreshed from the bundled package",
                            package.id
                        )
                    },
                )
            }
        };
        outcomes.push(outcome.map_err(|e| format!("{} {newest}: {e}", package.id)));
    }
    outcomes
}

/// Swap the installed directories `stale` for a fresh unpack of `package`, never leaving a
/// half-deleted install behind: the package is unpacked into a scratch directory first (a
/// dot-name the listing ignores), then the stale directories are renamed away and the new one
/// is renamed in — under its own `{id}-{version}` name, which in an upgrade differs from the
/// stale ones (the listing derives an install's version from its directory name). On Windows
/// a directory holding a running binary refuses the rename as a whole — the install app's
/// upgrade launches the new app while the old one's backend is still exiting — so the swap
/// retries for a few seconds before giving up (the next boot tries again: the recorded build
/// still differs, the version still differs). `builtin` carries the replaced install's own
/// flag.
fn replace_install(
    dir: &Path,
    stale: &[PathBuf],
    package: &Path,
    builtin: bool,
) -> Result<(), String> {
    let scratch = dir.join(format!(".refresh-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&scratch);
    std::fs::create_dir_all(&scratch).map_err(|e| format!("create {}: {e}", scratch.display()))?;
    let result = (|| {
        // Unpacked exactly as a one-click install would: the `.vsix`'s `ggs` key becomes
        // the runtime manifest.
        let info = install_from_vsix_into(&scratch, package, builtin)?;
        let staged = scratch.join(format!("{}-{}", info.id, info.version));
        record_bundled_stamp(&staged, package);
        let mut moved: Vec<(PathBuf, PathBuf)> = Vec::new();
        for (index, old) in stale.iter().enumerate() {
            let aside = scratch.join(format!("stale-{index}"));
            let mut attempt = 0;
            loop {
                match std::fs::rename(old, &aside) {
                    Ok(()) => {
                        moved.push((old.clone(), aside));
                        break;
                    }
                    Err(_) if attempt < 20 => {
                        attempt += 1;
                        std::thread::sleep(std::time::Duration::from_millis(250));
                    }
                    Err(e) => return Err(format!("the install is in use ({e}); close every Git Graph Studio window and start it again")),
                }
            }
        }
        let target = dir.join(format!("{}-{}", info.id, info.version));
        if let Err(e) = std::fs::rename(&staged, &target) {
            // Put the old installs back rather than leave none.
            for (old, aside) in &moved {
                let _ = std::fs::rename(aside, old);
            }
            return Err(format!("move the new install into place: {e}"));
        }
        Ok(())
    })();
    let _ = std::fs::remove_dir_all(&scratch);
    result
}

/// An extension's own storage directories — VS Code's `globalStorageUri`, `storageUri`
/// and `logUri`. They live under a `~/.ggs` home, never inside the install directory an
/// upgrade or uninstall replaces.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExtStoragePaths {
    pub global: String,
    /// Per workspace (keyed by a stable hash of the first folder); absent with no folder
    /// open — VS Code's `storageUri` is undefined then too.
    pub workspace: Option<String>,
    pub log: String,
}

/// FNV-1a over the workspace path: a stable directory key across runs and Rust versions.
fn workspace_key(workspace: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in workspace.replace('\\', "/").to_lowercase().bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{hash:016x}")
}

/// The storage layout under a `~/.ggs` home, created on demand.
pub fn ext_storage_paths_in(
    home: &Path,
    ext_id: &str,
    workspace: Option<&str>,
) -> Result<ExtStoragePaths, String> {
    if ext_id.is_empty()
        || ext_id.contains(['/', '\\', ':'])
        || ext_id.contains("..")
        || ext_id == "."
    {
        return Err(format!("invalid extension id {ext_id:?}"));
    }
    let data = home.join("extension-data").join(ext_id);
    let global = data.join("global");
    let log = home.join("logs").join("extensions").join(ext_id);
    let workspace = workspace
        .filter(|path| !path.is_empty())
        .map(|path| data.join("workspace").join(workspace_key(path)));
    for dir in [Some(&global), Some(&log), workspace.as_ref()]
        .into_iter()
        .flatten()
    {
        std::fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    }
    let text = |path: &Path| path.to_string_lossy().into_owned();
    Ok(ExtStoragePaths {
        global: text(&global),
        workspace: workspace.as_deref().map(text),
        log: text(&log),
    })
}

/// The ids of the installed packages that declare a process backend — what the boot pass
/// starts (`ext_process::start_all_installed`): "installed and process-backed" is exactly
/// "runs with the app". Both process kinds count: a package's own binary (`process`) and an
/// engine `.node` served by an app-bundled host (`node`).
pub fn process_backed_ids(dir: &Path) -> Vec<String> {
    list_installed(dir)
        .unwrap_or_default()
        .into_iter()
        .filter(|ext| {
            ext.capabilities.as_ref().is_some_and(|g| {
                g.backend
                    .as_ref()
                    .is_some_and(|b| b.kind == "process" || b.kind == "node")
            })
        })
        .map(|ext| ext.id)
        .collect()
}

pub fn list_installed(dir: &Path) -> Result<Vec<ExtInfo>, String> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(dir).map_err(|e| format!("read {}: {e}", dir.display()))? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let manifest = match read_manifest(&path) {
            Some(m) => m,
            None => continue, // leftover/partial install; invisible until replaced
        };
        // A VSIX with Studio capabilities carries a `manifest.json` too (generated on
        // install), so the stored format — not the file's presence — is the format's truth;
        // the content guess is only for a directory whose meta never got written.
        let stored_meta = std::fs::read_to_string(path.join("studio-ext.json"))
            .ok()
            .and_then(|s| serde_json::from_str::<StudioExtMeta>(&s).ok());
        let meta = stored_meta.clone().unwrap_or(StudioExtMeta {
            builtin: false,
            format: default_format(),
            bundled_stamp: None,
        });
        let capabilities: Option<StudioManifest> =
            std::fs::read_to_string(path.join("manifest.json"))
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok());
        let icon = manifest
            .icon
            .as_ref()
            .map(|rel| path.join(rel).to_string_lossy().into_owned());
        let (repository, license, engines_vscode) = (
            manifest.url_of().map(str::to_string),
            manifest.license,
            manifest.engines.and_then(|e| e.vscode),
        );
        let nls = read_nls(&path);
        let display_name = nls_resolve(manifest.display_name, &nls);
        let description = nls_resolve(manifest.description, &nls);
        out.push(
            ExtInfo {
                id: format!("{}.{}", manifest.publisher, manifest.name),
                name: manifest.name,
                display_name,
                publisher: manifest.publisher,
                version: manifest.version,
                description: description.unwrap_or_default(),
                builtin: meta.builtin,
                icon,
                path: path.to_string_lossy().into_owned(),
                categories: manifest.categories,
                keywords: manifest.keywords,
                repository,
                license,
                engines_vscode,
                extension_dependencies: manifest.extension_dependencies,
                extension_pack: manifest.extension_pack,
                readme: None,
                changelog: None,
                format: match stored_meta {
                    Some(ref read_meta) => read_meta.format.clone(),
                    None => meta.format,
                },
                page_bundle: path.join("webview").join("index.js").is_file(),
                capabilities,
            }
            .with_docs(&path),
        );
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(out)
}

/// Install a `.vsix` into `dir`: the same forward-only upgrade rules as the retired custom
/// package (a same-id counts as just another install of the same extension).
///
pub fn install_from_vsix_into(dir: &Path, vsix: &Path, builtin: bool) -> Result<ExtInfo, String> {
    let manifest = read_vsix_manifest(vsix)?;
    // A `.node` inside a VSIX runs only where something can load it: a declared backend
    // (the package's own runtime story), or — since the pretend Node runtime — a derived
    // `ggs-node` backend for a plain VSIX with a `main` and native binaries. Anything else
    // is the named failure at the door, not a package that installs and never works.
    let derived_backend = resolve_node_binaries(&manifest, vsix, crate::real_node_allowed())?;
    let id = format!("{}.{}", manifest.publisher, manifest.name);
    let target = dir.join(format!("{id}-{}", manifest.version));
    for existing in find_installed(dir, &id)? {
        match compare_versions(&existing, &manifest.version) {
            std::cmp::Ordering::Greater => {
                return Err(format!(
                    "{id} {existing} is already installed; {id} {} is older",
                    manifest.version
                ))
            }
            std::cmp::Ordering::Equal => {
                return Err(format!("{id} {existing} is already installed"))
            }
            std::cmp::Ordering::Less => {
                std::fs::remove_dir_all(dir.join(format!("{id}-{existing}")))
                    .map_err(|e| format!("remove old {id} {existing}: {e}"))?;
            }
        }
    }
    extract_vsix(vsix, &target)?;
    // The package's runtime manifest: identity plus the backend derived from the package
    // itself (`resolve_node_binaries` — native binaries, or a main the sandboxed frame
    // cannot host: oversized, or opening listening sockets). The extension runs where VS
    // Code would run it — its own entry; a package with neither entry nor binaries needs
    // no backend at all (the frame host serves it whole).
    let capabilities = StudioManifest {
        id: format!("{}.{}", manifest.publisher, manifest.name),
        version: manifest.version.clone(),
        backend: derived_backend,
    };
    std::fs::write(
        target.join("manifest.json"),
        serde_json::to_vec(&capabilities).unwrap(),
    )
    .map_err(|e| format!("write manifest.json: {e}"))?;
    let meta = StudioExtMeta {
        builtin,
        format: "vsix".to_owned(),
        bundled_stamp: None,
    };
    std::fs::write(
        target.join("studio-ext.json"),
        serde_json::to_vec(&meta).unwrap(),
    )
    .map_err(|e| format!("write meta: {e}"))?;
    // An explicit install revives the boot pass's auto-install (upgrade) pass for this id.
    list_installed(dir)?
        .into_iter()
        .find(|e| e.id == id && e.version == manifest.version)
        .ok_or_else(|| "installed extension not listed after install".to_string())
}

/// Re-apply the executable bit to an installed package's native CLI binaries —
/// claude-code's `resources/native-binary/`, the one exec-carrying layout this
/// store's packages use. Installs unpacked before the extractor kept the
/// archive's modes (2026-09-27) landed 0644, and claude-code rides in no build
/// since 2026-09-28, so the boot stamp-refresh never re-extracts them: without
/// this repair the binary's spawn fails with EACCES (the SDK reports it as a
/// libc mismatch) forever. Called at every backend start — the one hook every
/// installed package crosses at every boot. Idempotent; a no-op where the
/// package or platform has no such binaries.
#[cfg(unix)]
pub fn repair_exec_bits(ext_dir: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let dir = ext_dir.join("resources").join("native-binary");
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(meta) = std::fs::metadata(&path) else {
            continue;
        };
        if !meta.is_file() {
            continue;
        }
        let mode = meta.permissions().mode();
        if mode & 0o111 == 0 {
            let _ = std::fs::set_permissions(
                &path,
                std::fs::Permissions::from_mode((mode & 0o777) | 0o111),
            );
        }
    }
}

#[cfg(windows)]
pub fn repair_exec_bits(_ext_dir: &Path) {}

/// The uninstall core (the app's `uninstall_stopping` stops the backend first — its exe
/// lives inside the directory being removed). The bundled git-graph-rs copy carries the
/// built-in flag and is refused; a user-installed copy — an upgrade of it — goes freely.
pub fn uninstall(dir: &Path, ext_id: &str) -> Result<(), String> {
    let versions = find_installed(dir, ext_id)?;
    if versions.is_empty() {
        return Err(format!("{ext_id} is not installed"));
    }
    for version in &versions {
        let path = dir.join(format!("{ext_id}-{version}"));
        let meta: StudioExtMeta = std::fs::read_to_string(path.join("studio-ext.json"))
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or(StudioExtMeta {
                builtin: false,
                format: default_format(),
                bundled_stamp: None,
            });
        if meta.builtin {
            return Err(format!(
                "{ext_id} is built into Git Graph Studio and cannot be uninstalled"
            ));
        }
        std::fs::remove_dir_all(&path).map_err(|e| removal_error(&path, &e))?;
    }
    Ok(())
}

/// The remove error, with the multi-instance hint when the directory is held: another GGS
/// window running this extension's backend keeps its exe open, and a running binary cannot be
/// deleted on Windows (`ERROR_ACCESS_DENIED` 5, `ERROR_SHARING_VIOLATION` 32).
fn removal_error(path: &Path, error: &std::io::Error) -> String {
    let base = format!("remove {}: {error}", path.display());
    match error.raw_os_error() {
        Some(5) | Some(32) => format!(
            "{base} — another Git Graph Studio window may be running this extension's backend; close it and try again"
        ),
        _ => base,
    }
}

/// Versions of `ext_id` currently installed (normally zero or one).
pub fn find_installed(dir: &Path, ext_id: &str) -> Result<Vec<String>, String> {
    let prefix = format!("{ext_id}-");
    let mut versions = Vec::new();
    for entry in std::fs::read_dir(dir).map_err(|e| format!("read {}: {e}", dir.display()))? {
        let entry = entry.map_err(|e| e.to_string())?;
        let file_name = entry.file_name();
        let Some(name) = file_name.to_str() else {
            continue;
        };
        if let Some(version) = name.strip_prefix(&prefix) {
            versions.push(version.to_string());
        }
    }
    Ok(versions)
}

/// The newest installed directory of `ext_id` — what the process extension host spawns a
/// backend from, and the root the `ggs://` protocol serves a package's files out of.
pub fn installed_dir(dir: &Path, ext_id: &str) -> Result<PathBuf, String> {
    let mut versions = find_installed(dir, ext_id)?;
    versions.sort_by(|a, b| compare_versions(a, b));
    let version = versions
        .last()
        .ok_or_else(|| format!("{ext_id} is not installed"))?;
    Ok(dir.join(format!("{ext_id}-{version}")))
}

#[cfg(test)]
mod ext_storage_tests {
    use super::*;

    #[test]
    fn storage_paths_live_under_the_home_and_key_the_workspace() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = ext_storage_paths_in(tmp.path(), "acme.demo", Some(r"C:\Repo")).unwrap();
        assert!(Path::new(&paths.global).ends_with("extension-data/acme.demo/global"));
        assert!(Path::new(&paths.log).ends_with("logs/extensions/acme.demo"));
        let workspace = paths.workspace.clone().unwrap();
        assert!(Path::new(&workspace).is_dir());
        // The key ignores separator and case spelling: one workspace, one directory.
        let again = ext_storage_paths_in(tmp.path(), "acme.demo", Some("c:/repo")).unwrap();
        assert_eq!(again.workspace, paths.workspace);
        assert_eq!(
            ext_storage_paths_in(tmp.path(), "acme.demo", None)
                .unwrap()
                .workspace,
            None
        );
    }

    #[test]
    fn storage_paths_refuse_ids_that_would_escape() {
        let tmp = tempfile::tempdir().unwrap();
        for bad in ["", ".", "..", "a/b", r"a\b", "c:x", "acme..x"] {
            assert!(
                ext_storage_paths_in(tmp.path(), bad, None).is_err(),
                "{bad} should be refused"
            );
        }
    }
}
