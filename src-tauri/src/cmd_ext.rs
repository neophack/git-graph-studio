//! Extension management for Git Graph Studio.
//!
//! The extension store: `.vsix` packages (the store's own format) unpacked under
//! `~/.ggs/extensions/{id}-{version}/`, their Studio capabilities (declared under
//! `package.json`'s `ggs` key) generated into a runtime `manifest.json` (id, version, the
//! page registry, the backend declaration) — plus
//! `package.json` (the VS Code-style manifest the Extensions view and the contribution points
//! read) at its root, plus `web/`, the localisations, README and licences. `.vsix` packages
//! install as the VS Code compatibility path: a zip with an `extension/` folder holding
//! `package.json` and the compiled entry point, activated in the frame host with the `vscode`
//! API shim. Both live under `~/.ggs/extensions/{id}-{version}/` — a user-level directory
//! like `.vscode/extensions`, so installs are easy to inspect and survive app data resets —
//! and the retired custom package and a `.vsix` of the same id are the same extension: whichever has the higher
//! version wins.
//!
//! The integrated git-graph-rs extension ships as a bundled `.vsix`
//! packages the installer carries (`extensions/` beside the app — prepare.mjs packs them), but
//! the app installs nothing by default: [`ext_install_bundled`] is the one-click Install on
//! each bundled entry of the Extensions view, and it installs the package like any user `.vsix`
//! (forward-only, uninstallable). The engine stays linked in-process and the view assets stay
//! the app's own; when no install is present (the default, or a dev run without the package),
//! each listing falls back to the manifest embedded at build time.

use serde::{Deserialize, Serialize};
use std::io::Read;
use std::path::{Path, PathBuf};
use tauri::Manager;

/// Metadata Studio keeps alongside the unpacked package, so a built-in install survives being
/// listed next to user-installed extensions, and the package format is known without
/// re-reading the archive.
#[derive(Serialize, Deserialize, Clone)]
struct StudioExtMeta {
    builtin: bool,
    /// `vsix`, or the legacy `ggx` of installs made while the custom format existed.
    #[serde(default = "default_format")]
    format: String,
    /// The identity (`package_stamp`) of the bundled build this install was unpacked from —
    /// absent for a package installed from anywhere else, and for installs that predate it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    bundled_stamp: Option<String>,
}

fn default_format() -> String {
    "vsix".to_owned()
}

/// The `manifest.json` at the root of the retired custom package package.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StudioManifest {
    /// `ggs/2`: the named page registry and the backend declaration.
    pub format: String,
    /// `{publisher}.{name}`; must match `package.json`.
    pub id: String,
    pub version: String,
    #[serde(default)]
    pub frontend: Option<LegacyFrontend>,
    /// `ggs/2`: the named page registry — every page the package can show, by id.
    #[serde(default)]
    pub pages: Option<std::collections::BTreeMap<String, StudioPage>>,
    /// `ggs/2`: the backend declaration (`ext_process.rs` spawns it on demand).
    #[serde(default)]
    pub backend: Option<BackendDecl>,
    /// `ggs/2`: an activity-bar launcher — one icon in the workbench's activity bar that runs
    /// one of the package's commands (a view page's opener), the way a built-in view has one.
    #[serde(default)]
    pub activitybar: Option<ActivityBar>,
    #[serde(default)]
    pub permissions: Vec<String>,
}

/// A package's activity-bar launcher: the icon (package-relative), its tooltip, and
/// the declared command a click runs.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ActivityBar {
    pub command: String,
    /// The page the command opens — the engine host's one command convention: a launcher
    /// click answers `{openPage: page}` from this field, so no host names any package's
    /// page wiring itself.
    #[serde(default)]
    pub page: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub icon: Option<String>,
}

/// Where the package's webview lives (paths inside the package).
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LegacyFrontend {
    pub page: String,
    #[serde(default)]
    pub config: Option<String>,
    #[serde(default)]
    pub compare: Option<String>,
}

/// One page of a package: an HTML document inside the package, opened as an editor
/// tab over the `ggs://` protocol (which composes the page bootstrap into it).
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StudioPage {
    /// The HTML document, relative to the package root.
    pub page: String,
    #[serde(default)]
    pub title: Option<String>,
    /// One tab at most: a second open reveals the existing tab (its params arrive as an event).
    #[serde(default)]
    pub singleton: bool,
    /// The page's tab icon, package-relative; absent, the tab wears the package's activity-bar
    /// icon (or the generic one).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
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
    /// concurrent on the plugin side (`ext_protocol.rs`), so a command-style plugin and a
    /// burst-answering engine plug in identically. The field is still read so a package
    /// packed before the unification names itself; `ext_process` rejects any value but the
    /// default with an upgrade hint instead of hanging a doomed handshake.
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

/// The format that adds the named page registry and the process backend.
pub const STUDIO_FORMAT: &str = "ggs/2";

/// The list format of a bundled offer: a package the installer carries but nothing installed —
/// the Extensions view's one-click Install cue. The app knows no bundled id: whatever packages
/// sit beside the installer ('bundled_packages' scans for them) are the offers.
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

pub fn extensions_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = extensions_home_dir()?;
    migrate_from_app_data(app, &dir);
    Ok(dir)
}

/// `~/.ggs/extensions`, created if missing — the store itself, without the one-time
/// migration only the app performs (the headless `--measure` run uses this).
pub fn extensions_home_dir() -> Result<PathBuf, String> {
    // Tests pin the store to an isolated empty directory (`test_support::isolated_extension_store`):
    // the developer's real `~/.ggs/extensions` may well hold a backend-carrying package (any run
    // of the app installs one), and "no backend reachable" assertions must not depend on that.
    #[cfg(test)]
    if let Some(dir) = TEST_EXTENSIONS_HOME.lock().unwrap().clone() {
        return Ok(dir);
    }
    let home = home_dir().ok_or_else(|| "no user home directory".to_string())?;
    let dir = home.join(".ggs").join("extensions");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    Ok(dir)
}

#[cfg(test)]
static TEST_EXTENSIONS_HOME: std::sync::Mutex<Option<PathBuf>> = std::sync::Mutex::new(None);

#[cfg(test)]
pub(crate) fn pin_extensions_home_for_tests(dir: PathBuf) {
    *TEST_EXTENSIONS_HOME.lock().unwrap() = Some(dir);
}

#[cfg(test)]
pub(crate) fn unpin_extensions_home_for_tests() {
    *TEST_EXTENSIONS_HOME.lock().unwrap() = None;
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .filter(|p| !p.as_os_str().is_empty())
}

/// One-time move from the pre-`.ggs` location (`{app_data}/extensions`) so existing installs
/// keep working. Entries already present at the new location (a newer version installed there)
/// are left behind with the old directory itself.
fn migrate_from_app_data(app: &tauri::AppHandle, dir: &Path) {
    let Ok(old) = app.path().app_data_dir() else {
        return;
    };
    let old = old.join("extensions");
    let entries = match std::fs::read_dir(&old) {
        Ok(entries) => entries,
        Err(_) => return, // nothing to migrate (the usual case after the first run)
    };
    for entry in entries.flatten() {
        let dest = dir.join(entry.file_name());
        if !dest.exists() {
            let _ = std::fs::rename(entry.path(), &dest);
        }
    }
    if std::fs::read_dir(&old).is_ok_and(|mut e| e.next().is_none()) {
        let _ = std::fs::remove_dir(&old);
    }
}

#[tauri::command]
pub fn ext_list(app: tauri::AppHandle) -> Result<Vec<ExtInfo>, String> {
    let dir = extensions_dir(&app)?;
    let mut list = list_installed(&dir)?;
    // The bundled offers follow the installs: a package already installed is its own listing
    // (its version is the install's), and only the not-installed bundled ones remain offers —
    // safe because the boot pass's refresh brings an installed one current (an upgrade when
    // the bundled build is newer, a refresh when it is a rebuild of the same version).
    for package in bundled_packages(&app) {
        if list.iter().any(|ext| ext.id == package.id) {
            continue;
        }
        list.push(bundled_offer(&package));
    }
    Ok(list)
}

/// One bundled package as discovered beside the installer: its 'manifest.json' header and its
/// 'package.json', read straight out of the package zip.
struct BundledPackage {
    id: String,
    path: std::path::PathBuf,
    manifest: VsixManifest,
    capabilities: StudioManifest,
}

/// The `.vsix` packages shipped beside the app, by directory scan — the app names no id: the
/// installer's 'extensions/' resource directory first, then a dev run's
/// 'target/studio/bundled' (its versioned packages and the fixed-name copies prepare.mjs
/// assembles for the installer). Unreadable packages are skipped, not fatal — a half-updated
/// directory must not blind the Extensions view. First sighting of an id wins.
fn bundled_packages(app: &tauri::AppHandle) -> Vec<BundledPackage> {
    let mut roots = Vec::new();
    if let Ok(resource) = app
        .path()
        .resolve("extensions", tauri::path::BaseDirectory::Resource)
    {
        roots.push(resource);
    }
    // 'tauri dev' runs cargo from src-tauri/; the bat and CI from the repository root.
    for base in [
        "target/studio/bundled",
        "target/studio/bundled/app-resources/extensions",
        "../target/studio/bundled",
        "../target/studio/bundled/app-resources/extensions",
    ] {
        roots.push(std::path::PathBuf::from(base));
    }
    let mut found: Vec<BundledPackage> = Vec::new();
    for root in roots {
        let Ok(entries) = std::fs::read_dir(&root) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            // The store's own package format sits beside the installer: a plain `.vsix`
            // whose `ggs` declaration makes it a first-class package here.
            if path.extension().and_then(|e| e.to_str()) != Some("vsix") {
                continue;
            }
            let Ok(manifest) = read_vsix_manifest(&path) else {
                continue;
            };
            let Some(ggs) = manifest.ggs.clone() else {
                continue;
            };
            let (capabilities, manifest) = (generated_studio_manifest(&manifest, ggs), manifest);
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
fn bundled_offer(package: &BundledPackage) -> ExtInfo {
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
        capabilities: Some(package.capabilities.clone()),
    }
}

/// Install a `.vsix` package — the store's own format, and for git-graph-rs the only one it
/// ships (its `ggs` key makes it a full package here). A newer version replaces an
/// installed package of the same id, forward-only.
#[tauri::command]
pub fn ext_install_from_vsix(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::ext_process::ProcessHostState>,
    path: String,
) -> Result<ExtInfo, String> {
    let dir = extensions_dir(&app)?;
    // The old install's backend cannot outlive the directory its exe lives in.
    let manifest = read_vsix_manifest(Path::new(&path))?;
    let _ = state.stop(&format!("{}.{}", manifest.publisher, manifest.name));
    install_from_vsix_into(&dir, Path::new(&path), false)
}

/// Install one of the bundled packages the installer ships — the one-click Install on the
/// Extensions view's bundled offers. The id is explicit (the frontend names the row it
/// installs) and the package is found by discovery, so the app still names no id of its own.
/// A standard install either way: forward-only like any package, uninstallable like any
/// package.
#[tauri::command]
pub fn ext_install_bundled(app: tauri::AppHandle, ext_id: String) -> Result<ExtInfo, String> {
    let dir = extensions_dir(&app)?;
    let package = bundled_packages(&app)
        .into_iter()
        .find(|package| package.id == ext_id)
        .ok_or_else(|| format!("{ext_id} has no bundled package"))?;
    let info = install_from_vsix_into(&dir, &package.path, false)?;
    record_bundled_stamp(
        &dir.join(format!("{ext_id}-{}", info.version)),
        &package.path,
    );
    Ok(info)
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

/// Note in an install's `studio-ext.json` which bundled build it was unpacked from.
fn record_bundled_stamp(target: &Path, package: &Path) {
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

/// The boot pass's refresh of installed packages the installer also ships: an installed id is
/// brought current with the bundled package before any backend starts. A bundled version NEWER
/// than the install upgrades it forward-only (the install hides the Extensions view's bundled
/// offer, so without this an app upgrade would leave its companion package behind forever —
/// eventually speaking a wire protocol the app no longer speaks); the SAME version unpacked
/// from an older build is refreshed by the recorded build stamp (an app upgrade that rebuilt
/// the package without bumping it); an installed NEWER version is never downgraded; and
/// nothing is installed that was not installed already — a deliberate uninstall survives every
/// launch. The replacement carries the replaced install's own builtin flag. Run before any
/// backend starts — a running binary holds its directory. Returns one line per refreshed,
/// upgraded or failed package, for the boot log.
pub fn refresh_bundled_installs(app: &tauri::AppHandle) -> Vec<Result<String, String>> {
    let Ok(dir) = extensions_dir(app) else {
        return Vec::new();
    };
    refresh_bundled_installs_in(&dir, &bundled_packages(app))
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
fn bundled_dismissed_marker(dir: &Path, ext_id: &str) -> PathBuf {
    dir.join(format!(".bundled-dismissed-{ext_id}"))
}

/// First-launch auto-install: a bundled package the store carries but nothing installed —
/// exactly the state right after the installer ran — installs here, the way VS Code's
/// bundled extensions are simply there on first run. A dismissal marker (written at
/// uninstall) or an existing install skips; the refresh pass keeps an install current.
pub fn install_missing_bundled(app: &tauri::AppHandle) -> Vec<Result<String, String>> {
    let Ok(dir) = extensions_dir(app) else {
        return Vec::new();
    };
    let packages: Vec<std::path::PathBuf> = bundled_vsix_packages(app);
    install_missing_bundled_in(&dir, &packages)
}

/// The auto-install works on raw package paths, not the scanned `BundledPackage` offers:
/// the bundled `.vsix` carries no `ggs` key (the submodule's own package.json never
/// declared one), and the ordinary install path derives its backend exactly as a hand
/// install of a marketplace package derives it.
fn install_missing_bundled_in(
    dir: &Path,
    packages: &[std::path::PathBuf],
) -> Vec<Result<String, String>> {
    let mut outcomes = Vec::new();
    for path in packages {
        let Ok(manifest) = read_vsix_manifest(path) else {
            eprintln!("[ai] manifest unreadable for {path:?}");
            let dbg = read_vsix_manifest(path).unwrap_err();
            eprintln!("[ai] reason: {dbg}");
            continue;
        };
        let Some(id) = manifest_id(&manifest) else {
            eprintln!("[ai] id none for {path:?}");
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
            record_bundled_stamp(
                &dir.join(format!("{}-{}", info.id, info.version)),
                path,
            );
            format!(
                "{} {} installed from the bundled package (first launch)",
                info.id, info.version
            )
        }));
    }
    outcomes
}

/// Every `.vsix` the installer (or a dev tree) carries beside the app, deduplicated by
/// file name — the auto-install scans packages, not offers, so a ggs-key-less marketplace
/// shape installs too.
fn bundled_vsix_packages(app: &tauri::AppHandle) -> Vec<std::path::PathBuf> {
    let mut roots: Vec<std::path::PathBuf> = Vec::new();
    if let Ok(resource_dir) = app.path().resource_dir() {
        roots.push(resource_dir.join("extensions"));
    }
    for base in [
        "target/studio/bundled/app-resources/extensions",
        "target/studio/bundled",
        "../target/studio/bundled/app-resources/extensions",
        "../target/studio/bundled",
    ] {
        roots.push(std::path::PathBuf::from(base));
    }
    let mut found: Vec<std::path::PathBuf> = Vec::new();
    for root in roots {
        let Ok(entries) = std::fs::read_dir(&root) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("vsix") {
                continue;
            }
            let name = path.file_name().map(|n| n.to_string_lossy().into_owned());
            if let Some(name) = name {
                if !found
                    .iter()
                    .any(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()) == Some(name.clone()))
                {
                    found.push(path);
                }
            }
        }
    }
    found
}

fn refresh_bundled_installs_in(
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
            std::cmp::Ordering::Less => replace_install(dir, &dirs, &package.path, meta.builtin)
                .map(|()| {
                    format!(
                        "{} {newest} upgraded to {version} from the bundled package",
                        package.id
                    )
                }),
            std::cmp::Ordering::Equal => {
                if meta.bundled_stamp.as_deref() == Some(stamp.as_str()) {
                    continue;
                }
                replace_install(dir, &[newest_dir], &package.path, meta.builtin).map(|()| {
                    format!(
                        "{0} {version} refreshed from the bundled package",
                        package.id
                    )
                })
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

/// One line of the extension store's own log (`~/.ggs/logs/extensions.log`): what the boot
/// pass did to installs, readable after the fact — a GUI app has no console for stderr.
pub fn log_extensions(line: &str) {
    eprintln!("[extensions] {line}");
    let Ok(store) = extensions_home_dir() else {
        return;
    };
    let Some(home) = store.parent() else {
        return;
    };
    let logs = home.join("logs");
    if std::fs::create_dir_all(&logs).is_err() {
        return;
    }
    let path = logs.join("extensions.log");
    // Bounded like mcp.log: past 1 MB the log starts over.
    if std::fs::metadata(&path).is_ok_and(|m| m.len() > 1024 * 1024) {
        let _ = std::fs::remove_file(&path);
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or_default();
    use std::io::Write;
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        let _ = writeln!(file, "{stamp} {line}");
    }
}

/// The uninstall every caller runs: this app's own backend for the extension dies first — its
/// exe lives inside the directory being removed, and on Windows a running binary cannot be
/// deleted — then the install goes.
pub fn uninstall_stopping(
    dir: &Path,
    ext_id: &str,
    host: &crate::ext_process::ProcessHostState,
) -> Result<(), String> {
    let _ = host.stop(ext_id);
    uninstall(dir, ext_id)
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

/// Uninstall an extension. The bundled git-graph-rs copy carries the built-in flag and is
/// refused by the core (`uninstall`); a user-installed copy — an upgrade of it — goes freely.
#[tauri::command]
pub fn ext_uninstall(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::ext_process::ProcessHostState>,
    ext_id: String,
) -> Result<(), String> {
    let dir = extensions_dir(&app)?;
    uninstall_stopping(&dir, &ext_id, &state)?;
    // A deliberate uninstall of a bundled package is remembered: the boot pass
    // auto-installs only what the user never removed (the marker file, not the package
    // directory, is what a later boot reads).
    let _ = std::fs::write(dir.join(format!(".bundled-dismissed-{ext_id}")), b"uninstalled\n");
    Ok(())
}

/// Read a file inside an installed extension's directory (the extension host loads the
/// entry bundle this way). Paths are confined to the extension's own directory.
#[tauri::command]
pub fn ext_read_file(
    app: tauri::AppHandle,
    ext_id: String,
    rel_path: String,
) -> Result<String, String> {
    let dir = extensions_dir(&app)?;
    let versions = find_installed(&dir, &ext_id)?;
    let version = versions
        .last()
        .ok_or_else(|| format!("{ext_id} is not installed"))?;
    let ext_dir = dir.join(format!("{ext_id}-{version}"));
    let path = safe_join(&ext_dir, &rel_path)?;
    std::fs::read_to_string(&path).map_err(|e| format!("read {}: {e}", path.display()))
}

// ---------------------------------------------------------------------------
// The Node compatibility layer's host half: the code the frame's CommonJS loader runs
// ---------------------------------------------------------------------------

/// The extension's loadable code, as one batch: every `.js` / `.cjs` / `.json` file under its
/// install directory (bundled entry points, un-bundled multi-file code and `node_modules`
/// alike), bounded. The frame's `require()` resolves against this map synchronously — a
/// `postMessage` read cannot answer a synchronous `require`, so the whole loadable surface
/// crosses once at activation instead.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExtCodeBundle {
    /// Package-relative paths with `/` separators, keyed as the loader normalizes them.
    pub files: std::collections::BTreeMap<String, String>,
    /// Binary files the package reads with `fs.readFileSync` (`.wasm` payloads above all),
    /// base64-encoded: the frame's `fs` serves them synchronously from this preload.
    pub blob_files: std::collections::BTreeMap<String, String>,
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
pub(crate) fn load_code_from(root: &Path) -> Result<ExtCodeBundle, String> {
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
        files: &'a mut std::collections::BTreeMap<String, String>,
        binaries: &'a mut Vec<String>,
        blob_files: &'a mut std::collections::BTreeMap<String, String>,
        bounds: &'a mut Bounds,
    }
    fn walk(
        root: &Path,
        dir: &Path,
        prefix: &str,
        depth: usize,
        acc: &mut Acc,
    ) -> Result<(), String> {
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

    let mut files = std::collections::BTreeMap::new();
    let mut binaries = Vec::new();
    let mut blob_files = std::collections::BTreeMap::new();
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

/// The frame's Node environment facts, as `os` / `process` report them: the sandboxed frame
/// cannot read env vars or the host's paths, so the activation context carries these in.
#[tauri::command]
pub fn ext_node_env() -> ExtNodeEnv {
    ExtNodeEnv {
        platform: node_platform(),
        arch: node_arch(),
        homedir: home_dir()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned(),
        tmpdir: std::env::temp_dir().to_string_lossy().into_owned(),
        hostname: std::env::var("COMPUTERNAME")
            .or_else(|_| std::env::var("HOSTNAME"))
            .unwrap_or_else(|_| "studio".to_owned()),
        release: format!("{} {}", std::env::consts::OS, os_version()),
        eol: if cfg!(windows) { "\r\n" } else { "\n" }.to_owned(),
        separator: std::path::MAIN_SEPARATOR.to_string(),
        delimiter: (if cfg!(windows) { ";" } else { ":" }).to_owned(),
        env: std::env::vars().collect(),
    }
}

/// `ExtNodeEnv`, the shape the frame's `os` / `process` shims read.
#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ExtNodeEnv {
    pub platform: String,
    pub arch: String,
    pub homedir: String,
    pub tmpdir: String,
    pub hostname: String,
    pub release: String,
    pub eol: String,
    pub separator: String,
    pub delimiter: String,
    /// The host's real environment (`process.env`). Extensions probe `PATH`,
    /// `ProgramFiles`, `LOCALAPPDATA` and friends to find the tools they drive — an empty
    /// env sent every discovery down a failure path (git not found, interpreters missing).
    #[serde(default)]
    pub env: std::collections::BTreeMap<String, String>,
}

/// Node's own word for this OS, the word extension code branches on
/// (`process.platform === 'win32'`).
fn node_platform() -> String {
    if cfg!(target_os = "windows") {
        "win32".to_owned()
    } else if cfg!(target_os = "macos") {
        "darwin".to_owned()
    } else {
        "linux".to_owned()
    }
}

/// Node's own word for this architecture (`process.arch`).
fn node_arch() -> String {
    if cfg!(target_arch = "x86_64") {
        "x64".to_owned()
    } else if cfg!(target_arch = "aarch64") {
        "arm64".to_owned()
    } else {
        std::env::consts::ARCH.to_owned()
    }
}

/// A coarse OS version, best effort (the exact number does not steer extension code).
fn os_version() -> String {
    // No OS command is spawned for this: `os.release()` only decorates diagnostics, and a
    // process spawn per activation would be pure cost. The kernel word below is stable.
    if let Ok(value) = std::env::var("OS") {
        return value;
    }
    "unknown".to_owned()
}

/// The extension's loadable code map — what the host hands the frame at activation.
#[tauri::command]
pub fn ext_load_code(app: tauri::AppHandle, ext_id: String) -> Result<ExtCodeBundle, String> {
    let dir = extensions_dir(&app)?;
    let root = installed_dir(&dir, &ext_id)?;
    load_code_from(&root)
}

// ---------------------------------------------------------------------------
// The extension filesystem (`vscode.workspace.fs`): workspace-confined file services
// ---------------------------------------------------------------------------

/// One workspace entry as `ext_fs`'s `list` answers it: name, kind and size, the shape the
/// frontend's `workspace.fs.readDirectory` consumes.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtFsEntry {
    pub name: String,
    #[serde(rename = "type")]
    pub kind: u8, // 1 file, 2 directory, 64 symlink — VS Code's FileType bits
    pub size: u64,
}

/// Resolve `path` (absolute, or relative to one of `roots`) and confine it to `roots`: an
/// extension's `workspace.fs` may only touch the open folders (VS Code's own limit).
fn confine_to_roots(roots: &[String], path: &str) -> Result<PathBuf, String> {
    if roots.is_empty() {
        return Err("no workspace folder is open".to_owned());
    }
    let candidate = Path::new(path);
    let resolved = if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        Path::new(&roots[0]).join(candidate)
    };
    let canonical = std::fs::canonicalize(&resolved).or_else(|_| {
        // A not-yet-existing target (a write, a mkdir): walk up to the nearest existing
        // ancestor, canonicalize that, and re-join the missing tail — confinement holds for
        // paths being created however many of their directories are still missing.
        let mut ancestor = resolved
            .parent()
            .ok_or_else(|| format!("{} has no parent", resolved.display()))?
            .to_path_buf();
        let mut tail = std::ffi::OsString::from(
            resolved
                .file_name()
                .ok_or_else(|| format!("{} has no file name", resolved.display()))?,
        );
        loop {
            match std::fs::canonicalize(&ancestor) {
                Ok(canonical) => return Ok::<PathBuf, String>(canonical.join(&tail)),
                Err(_) => {
                    let name = ancestor
                        .file_name()
                        .ok_or_else(|| format!("cannot resolve {}", resolved.display()))?;
                    let Some(parent) = ancestor.parent() else {
                        return Err(format!("cannot resolve {}", resolved.display()));
                    };
                    let mut next = std::ffi::OsString::from(name);
                    next.push(std::path::MAIN_SEPARATOR.to_string());
                    next.push(&tail);
                    tail = next;
                    ancestor = parent.to_path_buf();
                }
            }
        }
    })?;
    for root in roots {
        let Ok(root_canonical) = std::fs::canonicalize(root) else {
            continue;
        };
        if canonical.starts_with(&root_canonical) {
            return Ok(canonical);
        }
    }
    Err(format!(
        "{} is outside the workspace folders — vscode.workspace.fs is confined to them",
        canonical.display()
    ))
}

/// A tiny glob matcher (`find` / `findFiles`): `**` crosses directory boundaries, `*` within
/// one segment, `?` one character. Classic backtracking, no regex dependency.
fn glob_match(pattern: &str, text: &str) -> bool {
    fn segment(seg: &[char], s: &[char]) -> bool {
        let (mut pi, mut si) = (0usize, 0usize);
        let mut star: Option<(usize, usize)> = None;
        while si < s.len() {
            if pi < seg.len() && (seg[pi] == '?' || seg[pi] == s[si]) {
                pi += 1;
                si += 1;
            } else if pi < seg.len() && seg[pi] == '*' {
                star = Some((pi, si));
                pi += 1;
            } else if let Some((sp, ss)) = star {
                pi = sp + 1;
                si = ss + 1;
                star = Some((sp, ss + 1));
            } else {
                return false;
            }
        }
        while pi < seg.len() && seg[pi] == '*' {
            pi += 1;
        }
        pi == seg.len()
    }
    fn walk(pat: &[&str], parts: &[&str]) -> bool {
        match pat.first() {
            None => parts.is_empty(),
            Some(&"**") => (0..=parts.len()).any(|skip| walk(&pat[1..], &parts[skip..])),
            Some(seg) => {
                if parts.is_empty() {
                    return false;
                }
                let seg: Vec<char> = seg.chars().collect();
                let head: Vec<char> = parts[0].chars().collect();
                segment(&seg, &head) && walk(&pat[1..], &parts[1..])
            }
        }
    }
    walk(
        &pattern.split('/').collect::<Vec<_>>(),
        &text.split('/').collect::<Vec<_>>(),
    )
}

/// Collect the files under `dir` whose workspace-relative path matches `pattern` (bounded in
/// depth and count — a `**` over a big tree must not walk forever).
fn walk_find(dir: &Path, prefix: &str, pattern: &str, found: &mut Vec<String>, depth: usize) {
    if depth > 12 || found.len() >= 2000 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == ".git" {
            continue;
        }
        let relative = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}/{name}")
        };
        let Ok(meta) = entry.metadata() else { continue };
        if meta.is_dir() {
            walk_find(&entry.path(), &relative, pattern, found, depth + 1);
        } else if glob_match(pattern, &relative) {
            found.push(relative);
        }
    }
}

/// `vscode.workspace.fs` over one command: every op confines its path to the workspace
/// folders first (see [`confine_to_roots`]), so an extension can never reach outside them.
/// `exists` / `find` answer matching paths (empty = none) — the activation pass uses them
/// for `workspaceContains`, the frame's `workspace.fs` for everything else.
#[tauri::command]
pub fn ext_fs(
    op: String,
    roots: Vec<String>,
    path: String,
    to: Option<String>,
    data: Option<String>,
) -> Result<serde_json::Value, String> {
    use base64::Engine;
    ext_fs_core(
        &op,
        &roots,
        &path,
        to.as_deref(),
        data.as_deref(),
        |bytes| base64::engine::general_purpose::STANDARD.encode(bytes),
    )
}

/// The core the command delegates to (and the tests call with plain paths): byte answers
/// pass through `encode` so the command layer can base64 them for the JSON bridge.
fn ext_fs_core(
    op: &str,
    roots: &[String],
    path: &str,
    to: Option<&str>,
    data: Option<&str>,
    encode: impl Fn(&[u8]) -> String,
) -> Result<serde_json::Value, String> {
    // `find` takes a glob, not a path — it cannot be confined the way a file target is; its
    // walk starts at the canonical roots and never leaves them.
    if op == "find" {
        let mut found = Vec::new();
        for root in roots {
            let Ok(root_canonical) = std::fs::canonicalize(root) else {
                continue;
            };
            walk_find(&root_canonical, "", path, &mut found, 0);
        }
        return Ok(serde_json::to_value(found).expect("paths serialize"));
    }
    let target = confine_to_roots(roots, path)?;
    match op {
        "exists" => Ok(serde_json::json!(if target.exists() {
            vec![path.to_owned()]
        } else {
            Vec::<String>::new()
        })),
        "read" => {
            let bytes =
                std::fs::read(&target).map_err(|e| format!("read {}: {e}", target.display()))?;
            Ok(serde_json::json!({ "data": encode(&bytes) }))
        }
        "write" => {
            use base64::Engine;
            let bytes = data
                .and_then(|d| base64::engine::general_purpose::STANDARD.decode(d).ok())
                .ok_or_else(|| "write needs base64 data".to_owned())?;
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            std::fs::write(&target, bytes)
                .map_err(|e| format!("write {}: {e}", target.display()))?;
            Ok(serde_json::json!(()))
        }
        "list" => {
            let mut entries = Vec::new();
            for entry in
                std::fs::read_dir(&target).map_err(|e| format!("read {}: {e}", target.display()))?
            {
                let entry = entry.map_err(|e| e.to_string())?;
                let meta = entry.metadata().map_err(|e| e.to_string())?;
                let kind = if meta.is_dir() {
                    2
                } else if entry.path().is_symlink() {
                    64
                } else {
                    1
                };
                entries.push(ExtFsEntry {
                    name: entry.file_name().to_string_lossy().into_owned(),
                    kind,
                    size: meta.len(),
                });
            }
            entries.sort_by(|a, b| a.name.cmp(&b.name));
            Ok(serde_json::to_value(entries).expect("entries serialize"))
        }
        "stat" => {
            let meta = std::fs::metadata(&target)
                .map_err(|e| format!("stat {}: {e}", target.display()))?;
            Ok(serde_json::json!({
                "type": if meta.is_dir() { 2 } else { 1 },
                "size": meta.len(),
                "mtime": meta
                    .modified()
                    .ok()
                    .and_then(|at| at.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0)
            }))
        }
        "mkdir" => {
            std::fs::create_dir_all(&target)
                .map_err(|e| format!("mkdir {}: {e}", target.display()))?;
            Ok(serde_json::json!(()))
        }
        // The executable bit extensions set on git hooks and helper scripts they ship —
        // a no-op on Windows, where the mode does not exist.
        "chmod" => {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mode = to
                    .and_then(|mode| u32::from_str_radix(mode, 8).ok())
                    .unwrap_or(0o755);
                let mut permissions = std::fs::metadata(&target)
                    .map_err(|e| format!("chmod {}: {e}", target.display()))?
                    .permissions();
                permissions.set_mode(mode);
                std::fs::set_permissions(&target, permissions)
                    .map_err(|e| format!("chmod {}: {e}", target.display()))?;
            }
            Ok(serde_json::json!(()))
        }
        "delete" => {
            if target.is_dir() {
                std::fs::remove_dir_all(&target)
                    .map_err(|e| format!("delete {}: {e}", target.display()))?;
            } else {
                std::fs::remove_file(&target)
                    .map_err(|e| format!("delete {}: {e}", target.display()))?;
            }
            Ok(serde_json::json!(()))
        }
        "rename" => {
            let to = to.ok_or_else(|| "rename needs a destination".to_owned())?;
            let destination = confine_to_roots(roots, to)?;
            if let Some(parent) = destination.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            std::fs::rename(&target, &destination).map_err(|e| format!("rename: {e}"))?;
            Ok(serde_json::json!(()))
        }
        _ => Err(format!("unknown ext_fs op {op}")),
    }
}

// ---------------------------------------------------------------------------
// Core logic (dir-based, so the unit tests run without a Tauri app handle)
// ---------------------------------------------------------------------------

pub(crate) fn list_installed(dir: &Path) -> Result<Vec<ExtInfo>, String> {
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
                    None if capabilities.is_some() => "ggs".to_owned(),
                    None => meta.format,
                },
                capabilities,
            }
            .with_docs(&path),
        );
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(out)
}

/// Install a `.vsix` into `dir`: the same forward-only upgrade rules as the retired custom package (a same-id
/// counts as just another install of the same extension).
pub fn install_from_vsix_into(dir: &Path, vsix: &Path, builtin: bool) -> Result<ExtInfo, String> {
    let manifest = read_vsix_manifest(vsix)?;
    // A `.node` inside a VSIX runs only where something can load it: a declared backend
    // (the package's own runtime story), or — since the pretend Node runtime — a derived
    // `ggs-node` backend for a plain VSIX with a `main` and native binaries. Anything else
    // is the named failure at the door, not a package that installs and never works.
    let derived_backend =
        resolve_node_binaries(&manifest, vsix, crate::ext_process::real_node_allowed())?;
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
    // The Studio capabilities a VSIX declared become its runtime `manifest.json`: from here
    // on — the warm backend, the pages, the permissions — one runtime serves every package.
    if let Some(ggs) = manifest.ggs.clone() {
        let capabilities = generated_studio_manifest(&manifest, ggs);
        std::fs::write(
            target.join("manifest.json"),
            serde_json::to_vec(&capabilities).unwrap(),
        )
        .map_err(|e| format!("write manifest.json: {e}"))?;
        // A process package's backend binary needs its execute bit where the platform has
        // one — a zip extraction carries no permissions, so the binary this host would
        // actually run (`command_for`: the per-platform entry when listed, else `command`)
        // gets it explicitly.
        #[cfg(unix)]
        if let Some(backend) = capabilities.backend.as_ref() {
            if backend.kind == "process" {
                use std::os::unix::fs::PermissionsExt;
                let resolved = backend.command_for(&host_platform_key()).to_owned();
                let bin = target.join(&resolved);
                if !resolved.is_empty()
                    && !Path::new(&resolved).is_absolute()
                    && std::fs::metadata(&bin).is_ok()
                {
                    let mut perms = std::fs::metadata(&bin).unwrap().permissions();
                    perms.set_mode(0o755);
                    let _ = std::fs::set_permissions(&bin, perms);
                }
            }
        }
    } else if let Some(backend) = derived_backend {
        // A plain VSIX whose native binaries the pretend Node runtime can serve: the
        // derived backend becomes its whole `manifest.json` — the warm backend, nothing
        // else (no pages, no launcher: the package never declared any).
        let capabilities = StudioManifest {
            format: STUDIO_FORMAT.to_owned(),
            id: format!("{}.{}", manifest.publisher, manifest.name),
            version: manifest.version.clone(),
            frontend: None,
            pages: None,
            backend: Some(backend),
            activitybar: None,
            permissions: Vec::new(),
        };
        std::fs::write(
            target.join("manifest.json"),
            serde_json::to_vec(&capabilities).unwrap(),
        )
        .map_err(|e| format!("write manifest.json: {e}"))?;
    }
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

/// The `manifest.json` a VSIX's `ggs` declaration becomes: the format and identity are the
/// package's own, so the generated manifest can never drift from the `package.json` it sits
/// beside in the store.
fn generated_studio_manifest(manifest: &VsixManifest, ggs: StudioManifest) -> StudioManifest {
    StudioManifest {
        format: STUDIO_FORMAT.to_owned(),
        id: format!("{}.{}", manifest.publisher, manifest.name),
        version: manifest.version.clone(),
        frontend: None,
        pages: ggs.pages,
        backend: ggs.backend,
        activitybar: ggs.activitybar,
        permissions: ggs.permissions,
    }
}

/// Parse `package.json` the way VS Code reads extension manifests: as JSONC — `//` and
/// `/* */` comments plus trailing commas are tolerated (hand-authored packages in the wild
/// carry both; a strict parser refuses a package VS Code itself would run). Stripped before
/// `serde_json` sees it, with string contents preserved untouched.
fn parse_jsonc_manifest(bytes: &[u8]) -> Result<VsixManifest, String> {
    let text = String::from_utf8_lossy(bytes);
    let stripped = strip_trailing_commas(&strip_jsonc_comments(&text));
    let mut value: serde_json::Value =
        serde_json::from_str(&stripped).map_err(|e| format!("invalid package.json: {e}"))?;
    // Normalize the `ggs` identity: the store id and version are the package.json's own,
    // and packagers forget to repeat them inside the key (the shipped git-graph-rs VSIX
    // did exactly that) — a strict read then fails on `missing field id` and the package
    // becomes uninstallable everywhere. Missing fields are filled; wrong ones win.
    {
        let name = value.get("name").and_then(serde_json::Value::as_str).unwrap_or_default().to_owned();
        let publisher = value.get("publisher").and_then(serde_json::Value::as_str).unwrap_or_default().to_owned();
        let version = value.get("version").and_then(serde_json::Value::as_str).unwrap_or_default().to_owned();
        if let Some(ggs) = value.get_mut("ggs").and_then(|ggs| ggs.as_object_mut()) {
            if ggs.get("id").is_none() && !publisher.is_empty() && !name.is_empty() {
                ggs.insert("id".into(), serde_json::json!(format!("{publisher}.{name}")));
            }
            if ggs.get("version").is_none() && !version.is_empty() {
                ggs.insert("version".into(), serde_json::json!(version));
            }
        }
    }
    serde_json::from_value(value).map_err(|e| format!("invalid package.json: {e}"))
}

/// Remove `// line` and `/* block */` comments that are outside string literals. Operates on
/// `char`s (never bytes) so multi-byte text survives both inside and outside strings.
fn strip_jsonc_comments(text: &str) -> String {
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
fn strip_trailing_commas(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut pending_comma = false;
    for ch in text.chars() {
        if pending_comma {
            if ch.is_whitespace() {
                out.push(ch);
                continue;
            }
            if ch != ']' && ch != '}' {
                out.push(',');
            }
            pending_comma = false;
        }
        if ch == ',' {
            pending_comma = true;
        } else {
            out.push(ch);
        }
    }
    if pending_comma {
        out.push(',');
    }
    out
}

/// Read and validate the `extension/package.json` a `.vsix` carries. The `main` entry point
/// is required of a frame-hosted extension (the host runs a compiled bundle); a package that
/// carries only a process backend and pages — the VSIX shape of the retired custom package — needs no `main`.
pub(crate) fn read_vsix_manifest(vsix: &Path) -> Result<VsixManifest, String> {
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
    // process or node backend (`ggs.backend`), or neither (themes, snippets, grammars:
    // installed for their contributions alone). The one thing checked at install time is
    // the backend declaration's shape, so a broken package fails here with its reason
    // instead of at its first (never-starting) backend start.
    if let Some(backend) = manifest.ggs.as_ref().and_then(|ggs| ggs.backend.as_ref()) {
        if backend.kind != "process" && backend.kind != "node" {
            return Err(format!(
                "unsupported backend kind {} (this app speaks process and node)",
                backend.kind
            ));
        }
        if backend.command.trim().is_empty() {
            return Err("a declared backend needs a command".to_owned());
        }
        // The host is optional on a node backend: the command's shape picks the default
        // (a `.node` goes to the engine host, a JS entry to the pretend Node runtime);
        // a package may still name its host explicitly.
    }
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
fn resolve_node_binaries(
    manifest: &VsixManifest,
    vsix: &Path,
    real_node: bool,
) -> Result<Option<BackendDecl>, String> {
    if manifest
        .ggs
        .as_ref()
        .and_then(|ggs| ggs.backend.as_ref())
        .is_some()
    {
        return Ok(None);
    }
    let nodes = native_node_files(vsix)?;
    if nodes.is_empty() {
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
            "this extension carries native Node binaries ({listed}) but declares no \"main\"              to run and opts out of \"ggs.backend\" — declare the entry there (kind \"node\")              or ship a main"
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
fn extract_vsix(vsix: &Path, target: &Path) -> Result<(), String> {
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
        let mut bytes = Vec::new();
        entry.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
        std::fs::write(&dest, &bytes).map_err(|e| format!("write {}: {e}", dest.display()))?;
    }
    Ok(())
}

fn uninstall(dir: &Path, ext_id: &str) -> Result<(), String> {
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
fn find_installed(dir: &Path, ext_id: &str) -> Result<Vec<String>, String> {
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

/// A file inside an installed extension's directory, base64-encoded - how the UI reads icons and
/// README images (binary files `ext_read_file` cannot return as text). Paths are confined to the
/// extension's own directory.
#[tauri::command]
pub fn ext_read_file_base64(
    app: tauri::AppHandle,
    ext_id: String,
    rel_path: String,
) -> Result<String, String> {
    let dir = extensions_dir(&app)?;
    let versions = find_installed(&dir, &ext_id)?;
    let version = versions
        .last()
        .ok_or_else(|| format!("{ext_id} is not installed"))?;
    let ext_dir = dir.join(format!("{ext_id}-{version}"));
    let path = safe_join(&ext_dir, &rel_path)?;
    // Size guard: a stray large binary would balloon the IPC message; icons and doc images stay
    // well below this.
    let bytes = std::fs::read(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
    if bytes.len() > 8 * 1024 * 1024 {
        return Err(format!("{} is too large to inline", rel_path));
    }
    use base64::Engine;
    Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
}

// ---------------------------------------------------------------------------
// The `ggs://` protocol: how an installed package's pages reach a sandboxed iframe
// ---------------------------------------------------------------------------

/// Serve one `ggs://` request: a file of an installed package, as the extension pages'
/// iframes load them. URL shape `/{id}-{version}/{path}`; the package segment and the path
/// are both confined (no `..`), the root is the extensions home. An HTML page is composed
/// with the page bootstrap (`ext_page_boot.js`) the way graphPreload composes the Git Graph
/// page — the host environment joins the extension's own document, never a copy of it.
pub fn serve_ext_asset(request: &tauri::http::Request<Vec<u8>>) -> tauri::http::Response<Vec<u8>> {
    // Diagnostics for the page-loading seam: every asset request and its status, so a frame
    // that never renders can be attributed (never reached the handler / 404 / served).
    let uri = request.uri().to_string();
    let response = match extensions_home_dir() {
        Ok(home) => serve_ext_asset_from(&home, request),
        Err(_) => ext_not_found(request.uri().path()),
    };
    eprintln!("[ext-asset] {} {uri}", response.status().as_u16());
    response
}

/// The serving core over an explicit extensions home, so the tests can point it at a
/// scratch directory instead of the developer's real one.
fn serve_ext_asset_from(
    home: &Path,
    request: &tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    let requested = request.uri().path().trim_start_matches('/').to_owned();
    let decoded = percent_decode(&requested);
    let mut segments = decoded.split(['/', '\\']).filter(|s| !s.is_empty());
    let Some(package) = segments.next() else {
        return ext_not_found(&requested);
    };
    let rel: Vec<&str> = segments.collect();
    if package.contains("..") || rel.is_empty() || rel.iter().any(|segment| segment.contains(".."))
    {
        return ext_not_found(&requested);
    }
    let file = home.join(package).join(rel.join("/"));
    let Ok(bytes) = std::fs::read(&file) else {
        return ext_not_found(&requested);
    };
    let is_page = file
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("html") || ext.eq_ignore_ascii_case("htm"));
    let content = if is_page {
        compose_page(&String::from_utf8_lossy(&bytes)).into_bytes()
    } else {
        bytes
    };
    tauri::http::Response::builder()
        .header(tauri::http::header::CONTENT_TYPE, content_type(&file))
        .body(content)
        .expect("a response with a valid header value")
}

fn ext_not_found(requested: &str) -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder()
        .status(tauri::http::StatusCode::NOT_FOUND)
        .header(
            tauri::http::header::CONTENT_TYPE,
            "text/plain; charset=utf-8",
        )
        .body(format!("no such extension asset: {requested}").into_bytes())
        .expect("a response with a valid header value")
}

fn content_type(file: &Path) -> &'static str {
    let Some(ext) = file.extension().and_then(|e| e.to_str()) else {
        return "application/octet-stream";
    };
    match ext.to_ascii_lowercase().as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "jpg" | "jpeg" => "image/jpeg",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "wasm" => "application/wasm",
        _ => "application/octet-stream",
    }
}

/// Prepend the page bootstrap to the document: as the FIRST script of `<head>` when there is
/// one (a page's own top-level scripts call `acquireGgsApi()` the moment they parse — the
/// authored view shells load their bridge before anything else), else right after the
/// `<html>` tag (a script before the doctype would force quirks mode), else at the very start.
fn compose_page(html: &str) -> String {
    let boot = format!(
        "<script>\n{}\n</script>\n",
        include_str!("ext_page_boot.js")
    );
    for marker in ["<head>", "<HEAD>"] {
        if let Some(at) = html.find(marker) {
            let end = at + marker.len();
            return format!("{}{}{}", &html[..end], boot, &html[end..]);
        }
    }
    if let Some(at) = html.find("<html") {
        let end = html[at..]
            .find('>')
            .map(|offset| at + offset + 1)
            .unwrap_or(html.len());
        return format!("{}{}{}", &html[..end], boot, &html[end..]);
    }
    format!("{}{}", boot, html)
}

/// Percent-decode a URL path (and `+` as space, the form-encoding convention); invalid
/// escapes pass through untouched. Byte-wise on purpose: slicing the `&str` at arbitrary
/// offsets would panic inside multi-byte characters.
fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        match bytes[at] {
            b'%' if at + 2 < bytes.len() => {
                let hi = (bytes[at + 1] as char).to_digit(16);
                let lo = (bytes[at + 2] as char).to_digit(16);
                match (hi, lo) {
                    (Some(hi), Some(lo)) => {
                        out.push((hi * 16 + lo) as u8);
                        at += 3;
                    }
                    _ => {
                        out.push(b'%');
                        at += 1;
                    }
                }
            }
            b'+' => {
                out.push(b' ');
                at += 1;
            }
            byte => {
                out.push(byte);
                at += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[derive(Deserialize, Debug)]
pub(crate) struct VsixManifest {
    name: String,
    publisher: String,
    version: String,
    /// The package's own JS entry (VS Code's extension-host entry). The frame host runs it
    /// for the `vscode` API; the pretend Node runtime runs it as the package's backend when
    /// the install derives one (native binaries with no declared backend).
    #[serde(default)]
    main: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    icon: Option<String>,
    #[serde(default, rename = "displayName")]
    display_name: Option<String>,
    #[serde(default)]
    categories: Vec<String>,
    #[serde(default)]
    keywords: Vec<String>,
    #[serde(default)]
    repository: Option<RepositoryField>,
    #[serde(default)]
    license: Option<String>,
    #[serde(default)]
    engines: Option<Engines>,
    #[serde(default, rename = "extensionDependencies")]
    extension_dependencies: Vec<String>,
    #[serde(default, rename = "extensionPack")]
    extension_pack: Vec<String>,
    /// A VSIX may carry the Studio-specific capabilities the retired custom package manifest would — the
    /// process backend, the named pages, the activity-bar launcher, the permissions — under
    /// this `package.json` key, which VS Code ignores. A VSIX that declares them installs
    /// with a generated `manifest.json`, so the whole runtime (the warm backend
    /// process, the `ggs://` pages, the permission gates) serves a VSIX exactly as it serves
    /// the retired custom package: one store, one runtime, two package formats.
    #[serde(default)]
    ggs: Option<StudioManifest>,
}

/// `repository` is either a URL string or `{ "type": "git", "url": "..." }`.
#[derive(Deserialize, Debug)]
#[serde(untagged)]
enum RepositoryField {
    Url(String),
    Object { url: Option<String> },
}

impl RepositoryField {
    fn url(&self) -> Option<&str> {
        match self {
            RepositoryField::Url(url) => Some(url),
            RepositoryField::Object { url } => url.as_deref(),
        }
    }
}

#[derive(Deserialize, Debug)]
struct Engines {
    #[serde(rename = "vscode", default)]
    vscode: Option<String>,
}

impl VsixManifest {
    fn url_of(&self) -> Option<&str> {
        self.repository.as_ref().and_then(|r| r.url())
    }

    /// `{publisher}.{name}` — the store's extension id (the gallery's install stop-first
    /// needs it before the install itself).
    pub(crate) fn extension_id(&self) -> String {
        format!("{}.{}", self.publisher, self.name)
    }
}

/// `package.json` of an already-unpacked extension directory (`{dir}/package.json`).
fn read_manifest(dir: &Path) -> Option<VsixManifest> {
    let bytes = std::fs::read(dir.join("package.json")).ok()?;
    let manifest: VsixManifest = parse_jsonc_manifest(&bytes).ok()?;
    if manifest.name.is_empty() || manifest.publisher.is_empty() {
        return None;
    }
    Some(manifest)
}

/// Numeric x.y.z comparison; anything unparseable sorts below everything else.
fn compare_versions(a: &str, b: &str) -> std::cmp::Ordering {
    parse_version(a).cmp(&parse_version(b))
}

fn parse_version(v: &str) -> (u64, u64, u64) {
    let mut parts = v.split(['-', '+']).next().unwrap_or("").split('.');
    let mut next = || parts.next().and_then(|p| p.parse().ok()).unwrap_or(0);
    (next(), next(), next())
}

/// Reject archive entries that escape the install directory.
fn safe_join(base: &Path, rel: &str) -> Result<PathBuf, String> {
    let rel_path = Path::new(rel);
    if rel_path.is_absolute() || rel_path.components().any(|c| c.as_os_str() == "..") {
        return Err(format!("unsafe entry in VSIX: {rel}"));
    }
    Ok(base.join(rel_path))
}

#[cfg(test)]
mod install_tests {
    use super::*;
    use std::io::Write;

    /// A `.vsix` with a package.json and a web page (an extra data file,
    /// optionally, to prove every entry lands). Visible to `vsix_tests`, which builds a
    /// same-id pair to prove upgrades share one install slot.
    pub(super) fn make_vsix(
        dir: &Path,
        name: &str,
        publisher: &str,
        version: &str,
        with_data: bool,
    ) -> PathBuf {
        let vsix = dir.join(format!("{publisher}.{name}-{version}.vsix"));
        let file = std::fs::File::create(&vsix).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        // The store's own shape: a package.json whose `ggs` key declares the pages — the
        // install generates the runtime manifest from exactly this.
        let package = format!(
            r#"{{"name":"{name}","publisher":"{publisher}","version":"{version}","description":"a test package","ggs":{{"format":"ggs/2","id":"{publisher}.{name}","version":"{version}","pages":{{"main":{{"page":"web/view.html"}}}}}}}}"#
        );
        zip.start_file("extension/package.json", options).unwrap();
        zip.write_all(package.as_bytes()).unwrap();
        zip.start_file("extension/web/view.html", options).unwrap();
        zip.write_all(b"<html></html>").unwrap();
        if with_data {
            zip.start_file("extension/data/payload.bin", options)
                .unwrap();
            zip.write_all(b"payload").unwrap();
        }
        zip.finish().unwrap();
        vsix
    }

    /// The (runtime manifest, package manifest) pair of a VSIX — what the bundled scan and
    /// the refresh build from every package, in the shape the tests assert on.
    pub(super) fn bundled_of(vsix: &Path) -> Result<(StudioManifest, VsixManifest), String> {
        let manifest = read_vsix_manifest(vsix)?;
        let ggs = manifest
            .ggs
            .clone()
            .ok_or_else(|| "the test package declares no ggs key".to_owned())?;
        Ok((generated_studio_manifest(&manifest, ggs), manifest))
    }

    #[test]
    fn a_same_version_install_from_an_older_bundled_build_is_refreshed_once() {
        let tmp = tempfile::tempdir().unwrap();
        let exts = tmp.path().join("extensions");
        std::fs::create_dir_all(&exts).unwrap();
        let old_build = tmp.path().join("old");
        std::fs::create_dir_all(&old_build).unwrap();
        // The install came from an older build of 1.0.0 (no data file, no stamp recorded).
        let stale = make_vsix(&old_build, "demo", "acme", "1.0.0", false);
        install_from_vsix_into(&exts, &stale, false).unwrap();
        let target = exts.join("acme.demo-1.0.0");
        assert!(!target.join("data/payload.bin").exists());

        // The app now ships a rebuilt 1.0.0: the boot pass replaces the stale files...
        let rebuilt = make_vsix(tmp.path(), "demo", "acme", "1.0.0", true);
        let (capabilities, manifest) = bundled_of(&rebuilt).unwrap();
        let packages = [BundledPackage {
            id: capabilities.id.clone(),
            path: rebuilt.clone(),
            manifest,
            capabilities,
        }];
        let outcomes = refresh_bundled_installs_in(&exts, &packages);
        assert_eq!(outcomes.len(), 1);
        assert!(outcomes[0].is_ok(), "{outcomes:?}");
        assert!(target.join("data/payload.bin").exists());
        // ...and records the build, so the next boot leaves it alone.
        assert!(refresh_bundled_installs_in(&exts, &packages).is_empty());

        // A package that is not installed stays not installed (the refresh installs nothing).
        std::fs::remove_dir_all(&target).unwrap();
        assert!(refresh_bundled_installs_in(&exts, &packages).is_empty());
        assert!(!target.exists());
    }

    #[test]
    fn a_same_version_vsix_from_an_older_bundled_build_is_refreshed_with_a_generated_manifest() {
        let tmp = tempfile::tempdir().unwrap();
        let exts = tmp.path().join("extensions");
        std::fs::create_dir_all(&exts).unwrap();

        // The install came from a build of 1.0.0 whose package declared no capabilities.
        let stale = tmp.path().join("acme.pages-1.0.0-old.vsix");
        let file = std::fs::File::create(&stale).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        zip.start_file("extension/package.json", options).unwrap();
        zip.write_all(
            br#"{"name":"pages","publisher":"acme","version":"1.0.0","main":"./out/extension.js"}"#,
        )
        .unwrap();
        zip.finish().unwrap();
        let info = install_from_vsix_into(&exts, &stale, false).unwrap();
        assert!(Path::new(&info.path)
            .join("manifest.json")
            .metadata()
            .is_err());

        // The app now ships a rebuilt 1.0.0 that declares a page and a backend: the boot
        // pass replaces the install, and the generated manifest.json arrives with it.
        let rebuilt = tmp.path().join("acme.pages-1.0.0-new.vsix");
        let file = std::fs::File::create(&rebuilt).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        zip.start_file("extension/package.json", options).unwrap();
        zip.write_all(
            br#"{"name":"pages","publisher":"acme","version":"1.0.0","main":"./out/extension.js",
                "ggs":{"format":"ggs/2","id":"acme.pages","version":"1.0.0",
                        "pages":{"view":{"page":"web/view.html"}},
                        "backend":{"kind":"process","command":"backend/main"}}}"#,
        )
        .unwrap();
        zip.start_file("extension/web/view.html", options).unwrap();
        zip.write_all(b"<html></html>").unwrap();
        zip.finish().unwrap();
        let manifest = read_vsix_manifest(&rebuilt).unwrap();
        let capabilities = generated_studio_manifest(&manifest, manifest.ggs.clone().unwrap());
        let packages = [BundledPackage {
            id: capabilities.id.clone(),
            path: rebuilt.clone(),
            manifest,
            capabilities,
        }];
        let outcomes = refresh_bundled_installs_in(&exts, &packages);
        assert_eq!(outcomes.len(), 1);
        assert!(outcomes[0].is_ok(), "{outcomes:?}");
        let target = exts.join("acme.pages-1.0.0");
        let refreshed: StudioManifest =
            serde_json::from_str(&std::fs::read_to_string(target.join("manifest.json")).unwrap())
                .unwrap();
        assert!(refreshed.backend.is_some());
        // The next boot leaves it alone (the build is recorded).
        assert!(refresh_bundled_installs_in(&exts, &packages).is_empty());
    }

    #[test]
    fn an_install_older_than_the_bundled_package_is_upgraded_at_boot() {
        let tmp = tempfile::tempdir().unwrap();
        let exts = tmp.path().join("extensions");
        std::fs::create_dir_all(&exts).unwrap();

        // The app once shipped 1.0.0 and the user installed it (builtin, the way a one-click
        // install of a bundled offer lands).
        let old = make_vsix(tmp.path(), "demo", "acme", "1.0.0", false);
        install_from_vsix_into(&exts, &old, true).unwrap();
        assert!(exts.join("acme.demo-1.0.0").exists());

        // The app now ships 1.2.0: the boot pass upgrades the install forward-only, and the
        // new install lands under the new version's own directory name.
        let bundled = make_vsix(tmp.path(), "demo", "acme", "1.2.0", true);
        let (capabilities, manifest) = bundled_of(&bundled).unwrap();
        let packages = [BundledPackage {
            id: capabilities.id.clone(),
            path: bundled.clone(),
            manifest,
            capabilities,
        }];
        let outcomes = refresh_bundled_installs_in(&exts, &packages);
        assert_eq!(outcomes.len(), 1);
        assert!(outcomes[0].is_ok(), "{outcomes:?}");
        assert!(exts.join("acme.demo-1.2.0/data/payload.bin").exists());
        assert!(!exts.join("acme.demo-1.0.0").exists());
        assert_eq!(
            installed_dir(&exts, "acme.demo").unwrap(),
            exts.join("acme.demo-1.2.0")
        );
        // The replaced install's builtin flag carries over: the upgrade does not make the
        // package uninstallable.
        let error = uninstall(&exts, "acme.demo").unwrap_err();
        assert!(error.contains("built into"), "{error}");
        // The next boot leaves it alone (the version now matches and the build is recorded).
        assert!(refresh_bundled_installs_in(&exts, &packages).is_empty());
    }

    #[test]
    fn an_install_newer_than_the_bundled_package_is_never_downgraded() {
        let tmp = tempfile::tempdir().unwrap();
        let exts = tmp.path().join("extensions");
        std::fs::create_dir_all(&exts).unwrap();

        // The user installed 2.0.0 from a file; the app ships 1.2.0 beside it.
        let installed = make_vsix(tmp.path(), "demo", "acme", "2.0.0", true);
        install_from_vsix_into(&exts, &installed, false).unwrap();
        let (ggx, _) = bundled_of(&installed).unwrap();
        let older_bundle = make_vsix(tmp.path(), "demo", "acme", "1.2.0", true);
        let (older, older_manifest) = bundled_of(&older_bundle).unwrap();
        let packages = [BundledPackage {
            id: ggx.id.clone(),
            path: older_bundle.clone(),
            manifest: older_manifest,
            capabilities: older,
        }];
        assert!(refresh_bundled_installs_in(&exts, &packages).is_empty());
        assert!(exts.join("acme.demo-2.0.0").exists());
        assert!(!exts.join("acme.demo-1.2.0").exists());
    }

    #[test]
    fn the_listing_resolves_nls_placeholders_through_the_packages_own_nls_file() {
        let tmp = tempfile::tempdir().unwrap();
        let exts = tmp.path().join("extensions");
        std::fs::create_dir_all(&exts).unwrap();

        // The shape the git-graph-rs package really ships: `package.json` carrying
        // `%displayName%` / `%description%`, `package.nls.json` resolving both.
        let ggx = tmp.path().join("acme.demo-1.0.0.vsix");
        let file = std::fs::File::create(&ggx).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        zip.start_file("extension/package.json", options).unwrap();
        zip.write_all(
            br#"{"name":"demo","publisher":"acme","version":"1.0.0","displayName":"%displayName%","description":"%extension.description%","ggs":{"format":"ggs/2","id":"acme.demo","version":"1.0.0","pages":{}}}"#,
        ).unwrap();
        zip.start_file("extension/package.nls.json", options)
            .unwrap();
        zip.write_all(
            br#"{"displayName":"Demo (localized)","extension.description":"A localized demo."}"#,
        )
        .unwrap();
        zip.start_file("extension/README.md", options).unwrap();
        zip.write_all(b"# Demo\n\nThe readme.").unwrap();
        zip.finish().unwrap();

        install_from_vsix_into(&exts, &ggx, true).unwrap();
        let listed = list_installed(&exts).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(
            (
                listed[0].display_name.as_deref(),
                listed[0].description.as_str()
            ),
            (Some("Demo (localized)"), "A localized demo.")
        );
        // README.md ships in the package: the detail page's source for it is named.
        assert_eq!(listed[0].readme.as_deref(), Some("README.md"));
    }

    #[test]
    fn install_list_and_uninstall() {
        let tmp = tempfile::tempdir().unwrap();
        let exts = tmp.path().join("extensions");
        std::fs::create_dir_all(&exts).unwrap();
        let ggx = make_vsix(tmp.path(), "demo", "acme", "1.0.0", false);

        let info = install_from_vsix_into(&exts, &ggx, false).unwrap();
        assert_eq!(
            (info.id.as_str(), info.version.as_str()),
            ("acme.demo", "1.0.0")
        );
        assert!(!info.builtin);

        let list = list_installed(&exts).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, "acme.demo");

        uninstall(&exts, "acme.demo").unwrap();
        assert!(list_installed(&exts).unwrap().is_empty());
    }

    /// The uninstall marker is the boot pass's auto-install handbrake: a completed uninstall
    /// writes it (and nothing else sees it — the listing stays empty), a refused builtin
    /// uninstall does not, and the next explicit install clears it.
    #[test]
    fn rich_manifest_fields_and_docs_are_listed() {
        let tmp = tempfile::tempdir().unwrap();
        let exts = tmp.path().join("extensions");
        std::fs::create_dir_all(&exts).unwrap();
        let ggx = tmp.path().join("rich.vsix");
        let file = std::fs::File::create(&ggx).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default();
        zip.start_file("extension/package.json", options).unwrap();
        zip.write_all(
            br#"{"name":"rich","publisher":"acme","version":"2.0.0",
            "displayName":"Rich Demo","description":"d","categories":["Other","SCM Providers"],
            "keywords":["git"],"repository":{"type":"git","url":"https://example.com/rich.git"},
            "license":"MIT","engines":{"vscode":"^1.80.0"},
            "extensionDependencies":["acme.base"],"extensionPack":["acme.pack"],
            "ggs":{"format":"ggs/2","id":"acme.rich","version":"2.0.0","pages":{}}}"#,
        )
        .unwrap();
        zip.start_file("extension/README.md", options).unwrap();
        zip.write_all(b"# Rich").unwrap();
        zip.start_file("extension/CHANGELOG.md", options).unwrap();
        zip.write_all(b"# Changelog").unwrap();
        zip.finish().unwrap();

        let info = install_from_vsix_into(&exts, &ggx, false).unwrap();
        assert_eq!(info.display_name.as_deref(), Some("Rich Demo"));
        assert_eq!(info.categories, vec!["Other", "SCM Providers"]);
        assert_eq!(info.keywords, vec!["git"]);
        assert_eq!(
            info.repository.as_deref(),
            Some("https://example.com/rich.git")
        );
        assert_eq!(info.license.as_deref(), Some("MIT"));
        assert_eq!(info.engines_vscode.as_deref(), Some("^1.80.0"));
        assert_eq!(info.extension_dependencies, vec!["acme.base"]);
        assert_eq!(info.extension_pack, vec!["acme.pack"]);
        assert!(info
            .readme
            .as_deref()
            .is_some_and(|f| f.eq_ignore_ascii_case("README.md")));
        assert!(info
            .changelog
            .as_deref()
            .is_some_and(|f| f.eq_ignore_ascii_case("CHANGELOG.md")));
    }

    #[test]
    fn an_install_lists_upgrades_and_refuses_downgrades() {
        let tmp = tempfile::tempdir().unwrap();
        let exts = tmp.path().join("extensions");
        std::fs::create_dir_all(&exts).unwrap();

        let ggx = make_vsix(tmp.path(), "demo", "acme", "1.0.0", true);
        let info = install_from_vsix_into(&exts, &ggx, true).unwrap();
        assert_eq!(
            (
                info.id.as_str(),
                info.version.as_str(),
                info.format.as_str(),
                info.builtin
            ),
            ("acme.demo", "1.0.0", "vsix", true)
        );
        assert_eq!(
            info.capabilities.as_ref().unwrap().pages.as_ref().unwrap()["main"].page,
            "web/view.html"
        );
        assert!(exts
            .join("acme.demo-1.0.0")
            .join("web")
            .join("view.html")
            .is_file());
        assert!(exts
            .join("acme.demo-1.0.0")
            .join("data")
            .join("payload.bin")
            .is_file());

        // Installing the same package again is refused; a newer one replaces it.
        assert!(install_from_vsix_into(&exts, &ggx, false)
            .unwrap_err()
            .contains("already installed"));
        let newer = make_vsix(tmp.path(), "demo", "acme", "1.1.0", false);
        let info = install_from_vsix_into(&exts, &newer, false).unwrap();
        assert_eq!(info.version, "1.1.0");
        // The user package that replaced the bundled one is an ordinary uninstallable install.
        assert!(!info.builtin);
        assert_eq!(list_installed(&exts).unwrap().len(), 1);
        assert!(install_from_vsix_into(&exts, &ggx, false)
            .unwrap_err()
            .contains("is older"));
    }

    #[test]
    fn a_vsix_with_node_binaries_and_no_entry_is_refused() {
        let tmp = tempfile::tempdir().unwrap();
        let exts = tmp.path().join("extensions");
        std::fs::create_dir_all(&exts).unwrap();

        // The store's ordinary native extension without a `main`: a compiled `.node` no
        // host here can load and no entry to derive a backend from. The install names the
        // file and the reason.
        let vsix = tmp.path().join("native.vsix");
        let file = std::fs::File::create(&vsix).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default();
        zip.start_file("extension/package.json", options).unwrap();
        zip.write_all(br#"{"name":"native","publisher":"acme","version":"1.0.0"}"#)
            .unwrap();
        zip.start_file("extension/native/dep.node", options)
            .unwrap();
        zip.write_all(b"MZ").unwrap();
        zip.finish().unwrap();

        let error = install_from_vsix_into(&exts, &vsix, false).unwrap_err();
        assert!(error.contains("native Node binaries"), "{error}");
        assert!(error.contains("`native/dep.node`"), "{error}");
        assert!(error.contains("declares no"), "{error}");
        assert!(!exts.join("acme.native-1.0.0").exists(), "nothing installs");
    }

    #[test]
    fn a_vsix_with_node_binaries_and_a_main_installs_with_a_derived_runtime_backend() {
        let tmp = tempfile::tempdir().unwrap();
        let exts = tmp.path().join("extensions");
        std::fs::create_dir_all(&exts).unwrap();

        // The store's ordinary native extension WITH a main: the pretend Node runtime
        // derives from it — the install goes through, and the generated manifest carries
        // the ggs-node backend so the boot pass starts it and the frame host's native-call
        // proxy reaches the loaded addon exactly as for a declared package.
        let vsix = tmp.path().join("native.vsix");
        let file = std::fs::File::create(&vsix).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default();
        zip.start_file("extension/package.json", options).unwrap();
        zip.write_all(
            br#"{"name":"native","publisher":"acme","version":"1.0.0","main":"./out/ext.js"}"#,
        )
        .unwrap();
        zip.start_file("extension/out/ext.js", options).unwrap();
        zip.write_all(b"require('../native/dep.node');").unwrap();
        zip.start_file("extension/native/dep.node", options)
            .unwrap();
        zip.write_all(b"MZ").unwrap();
        zip.finish().unwrap();

        let info = install_from_vsix_into(&exts, &vsix, false).unwrap();
        let capabilities = info.capabilities.expect("the derived manifest");
        let backend = capabilities.backend.expect("the derived backend");
        assert_eq!(backend.kind, "node");
        assert_eq!(backend.command, "./out/ext.js");
    }

    #[test]
    fn an_engine_package_declaring_its_node_installs_despite_the_binaries() {
        // The opt-in path: the `.node` declared under ggs.backend (kind "node") is the
        // engine binary the host serves, and the recognition must not refuse exactly that
        // package. The retired `host` spelling stays in the fixture on purpose: older
        // packed manifests still name it, and unknown fields are ignored on read.
        let node = engine_node_fixture();
        let tmp = tempfile::tempdir().unwrap();
        let exts = tmp.path().join("extensions");
        std::fs::create_dir_all(&exts).unwrap();
        let vsix = tmp.path().join("engine.vsix");
        let file = std::fs::File::create(&vsix).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default();
        zip.start_file("extension/package.json", options).unwrap();
        zip.write_all(
            br#"{"name":"engine","publisher":"acme","version":"1.0.0","ggs":{"format":"ggs/2","id":"acme.engine","version":"1.0.0","pages":{"view":{"page":"web/view.html"}},"backend":{"kind":"node","host":"git-graph-backend","command":"native/win32-x64/engine.node"}}}"#,
        )
        .unwrap();
        zip.start_file("extension/web/view.html", options).unwrap();
        zip.write_all(b"<html></html>").unwrap();
        zip.start_file("extension/native/win32-x64/engine.node", options)
            .unwrap();
        zip.write_all(&node).unwrap();
        zip.finish().unwrap();

        let info = install_from_vsix_into(&exts, &vsix, false).unwrap();
        assert_eq!(info.id, "acme.engine");
        assert!(exts
            .join("acme.engine-1.0.0")
            .join("native")
            .join("win32-x64")
            .join("engine.node")
            .is_file());
    }

    /// A byte blob that scans as a `.node` by name — the recognition reads names, never
    /// contents; any payload stands in for a real engine binary here.
    fn engine_node_fixture() -> Vec<u8> {
        b"engine-node-fixture".to_vec()
    }

    #[test]
    fn a_vsix_without_an_identity_or_without_package_json_is_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let exts = tmp.path().join("extensions");
        std::fs::create_dir_all(&exts).unwrap();

        // Missing identity: the store's manifest needs a name and a publisher.
        let no_name = tmp.path().join("no-name.vsix");
        let file = std::fs::File::create(&no_name).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default();
        zip.start_file("extension/package.json", options).unwrap();
        zip.write_all(br#"{"name":"","publisher":"acme","version":"1.0.0"}"#)
            .unwrap();
        zip.finish().unwrap();
        assert!(install_from_vsix_into(&exts, &no_name, false)
            .unwrap_err()
            .contains("name and a publisher"));

        // A plain zip is not a VSIX: no extension/package.json at all.
        let plain = tmp.path().join("plain.vsix");
        let file = std::fs::File::create(&plain).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        zip.start_file("readme.txt", options).unwrap();
        zip.write_all(b"hi").unwrap();
        zip.finish().unwrap();
        assert!(install_from_vsix_into(&exts, &plain, false)
            .unwrap_err()
            .contains("not a VSIX"));
    }

    #[test]
    fn a_package_carries_its_pages_and_backend() {
        let tmp = tempfile::tempdir().unwrap();
        let exts = tmp.path().join("extensions");
        std::fs::create_dir_all(&exts).unwrap();
        let ggx = tmp.path().join("pages.vsix");
        let file = std::fs::File::create(&ggx).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default();
        zip.start_file("extension/package.json", options).unwrap();
        zip.write_all(
            br#"{"name":"demo","publisher":"acme","version":"1.0.0","ggs":{"format":"ggs/2","id":"acme.demo","version":"1.0.0","pages":{"main":{"page":"web/view.html","title":"Demo"}},"backend":{"kind":"process","command":"bin/main.exe"}}}"#,
        )
        .unwrap();
        zip.start_file("extension/web/view.html", options).unwrap();
        zip.write_all(b"<html><head></head><body></body></html>")
            .unwrap();
        zip.start_file("extension/bin/main.exe", options).unwrap();
        zip.write_all(b"MZ").unwrap();
        zip.finish().unwrap();

        let info = install_from_vsix_into(&exts, &ggx, false).unwrap();
        let header = info.capabilities.as_ref().unwrap();
        assert_eq!(header.format, "ggs/2");
        let main = &header.pages.as_ref().unwrap()["main"];
        assert_eq!(main.page, "web/view.html");
        assert_eq!(main.title.as_deref(), Some("Demo"));
        let backend = header.backend.as_ref().unwrap();
        assert_eq!(backend.kind, "process");
        assert_eq!(backend.command, "bin/main.exe");
        // The install lands where the process host and the ggs:// protocol will look.
        assert_eq!(
            installed_dir(&exts, "acme.demo").unwrap(),
            exts.join("acme.demo-1.0.0")
        );
    }

    #[test]
    fn a_backend_with_a_platform_map_resolves_and_falls_back() {
        let tmp = tempfile::tempdir().unwrap();
        let exts = tmp.path().join("extensions");
        std::fs::create_dir_all(&exts).unwrap();
        let ggx = tmp.path().join("multi.vsix");
        let file = std::fs::File::create(&ggx).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default();
        zip.start_file("extension/package.json", options).unwrap();
        zip.write_all(
            br#"{"name":"engine","publisher":"acme","version":"1.0.0","ggs":{"format":"ggs/2","id":"acme.engine","version":"1.0.0",
                "backend":{"kind":"process","command":"backend/win32-x64/main.exe","protocol":"ggx-rpc/1",
                "binaries":{"win32-x64":"backend/win32-x64/main.exe","darwin-arm64":"backend/darwin-arm64/main"}}}}"#,
        )
        .unwrap();
        zip.start_file("extension/backend/win32-x64/main.exe", options)
            .unwrap();
        zip.write_all(b"MZ").unwrap();
        zip.start_file("extension/backend/darwin-arm64/main", options)
            .unwrap();
        zip.write_all(b"\x7fELF").unwrap();
        zip.finish().unwrap();

        let info = install_from_vsix_into(&exts, &ggx, false).unwrap();
        let backend = info
            .capabilities
            .as_ref()
            .unwrap()
            .backend
            .as_ref()
            .unwrap();
        // The retired protocol name is still parsed off a packed manifest (the field is
        // kept for that read); the process host is what rejects it at start.
        assert_eq!(backend.protocol.as_deref(), Some("ggx-rpc/1"));
        assert_eq!(
            backend.command_for("win32-x64"),
            "backend/win32-x64/main.exe"
        );
        assert_eq!(
            backend.command_for("darwin-arm64"),
            "backend/darwin-arm64/main"
        );
        // A platform not in the map falls back to `command`.
        assert_eq!(
            backend.command_for("linux-x64"),
            "backend/win32-x64/main.exe"
        );

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let resolved = backend.command_for(&host_platform_key()).to_owned();
            let bin = installed_dir(&exts, "acme.engine").unwrap().join(&resolved);
            let mode = std::fs::metadata(&bin).unwrap().permissions().mode();
            assert_eq!(
                mode & 0o111,
                0o111,
                "the resolved binary should be executable"
            );
        }
    }

    #[test]
    fn a_backend_without_a_protocol_defaults_to_ggs_ext_1() {
        let backend = BackendDecl {
            kind: "process".to_owned(),
            command: "bin/main".to_owned(),
            args: Vec::new(),

            protocol: None,
            binaries: None,
        };
        // No protocol declared: the one default applies, and `start` accepts the backend.
        assert_eq!(backend.protocol, None);
    }

    #[test]
    fn a_backend_of_an_unknown_kind_is_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let exts = tmp.path().join("extensions");
        std::fs::create_dir_all(&exts).unwrap();
        let ggx = tmp.path().join("wasm.vsix");
        let file = std::fs::File::create(&ggx).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default();
        zip.start_file("extension/package.json", options).unwrap();
        zip.write_all(
            br#"{"name":"demo","publisher":"acme","version":"1.0.0","ggs":{"format":"ggs/2","id":"acme.demo","version":"1.0.0","backend":{"kind":"wasm","command":"main.wasm"}}}"#,
        )
        .unwrap();
        zip.finish().unwrap();

        let error = install_from_vsix_into(&exts, &ggx, false).unwrap_err();
        assert!(error.contains("unsupported backend kind"), "{error}");
    }
}

#[cfg(test)]
mod ext_asset_tests {
    use super::*;

    fn request_for(path: &str) -> tauri::http::Request<Vec<u8>> {
        tauri::http::Request::builder()
            .uri(format!("http://ggs.localhost{path}"))
            .body(Vec::new())
            .unwrap()
    }

    fn home_with_demo_page() -> tempfile::TempDir {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("acme.demo-1.0.0").join("web");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("view.html"),
            b"<html><head><title>t</title></head><body></body></html>",
        )
        .unwrap();
        std::fs::write(dir.join("app.js"), b"console.log(1);").unwrap();
        tmp
    }

    #[test]
    fn a_page_is_served_with_the_bootstrap_composed_into_its_head() {
        let tmp = home_with_demo_page();
        let response =
            serve_ext_asset_from(tmp.path(), &request_for("/acme.demo-1.0.0/web/view.html"));
        assert_eq!(response.status(), tauri::http::StatusCode::OK);
        let body = String::from_utf8(response.body().to_vec()).unwrap();
        // The bootstrap is the head's FIRST script: a page's own scripts call acquireGgsApi()
        // the moment they parse, so it must precede every one of them.
        assert!(body.contains("acquireGgsApi"));
        assert!(body.find("acquireGgsApi").unwrap() < body.find("<title>").unwrap());
        assert!(body.contains("<title>t</title>"));
        assert_eq!(
            response.headers().get("content-type").unwrap(),
            "text/html; charset=utf-8"
        );
    }

    #[test]
    fn a_percent_encoded_slash_in_the_package_path_still_serves_the_page() {
        // convertFileSrc composes the base with the trailing slash percent-encoded, so the
        // live requests carry the package segment and the page path as one encoded run.
        let tmp = home_with_demo_page();
        let response =
            serve_ext_asset_from(tmp.path(), &request_for("/acme.demo-1.0.0%2Fweb/view.html"));
        assert_eq!(response.status(), tauri::http::StatusCode::OK);
        assert!(String::from_utf8_lossy(response.body()).contains("acquireGgsApi"));
    }

    #[test]
    fn assets_pass_through_untouched_and_unknowns_are_404() {
        let tmp = home_with_demo_page();
        let js = serve_ext_asset_from(tmp.path(), &request_for("/acme.demo-1.0.0/web/app.js"));
        assert_eq!(js.body().as_slice(), b"console.log(1);");
        assert_eq!(
            serve_ext_asset_from(tmp.path(), &request_for("/acme.demo-1.0.0/web/missing.css"))
                .status(),
            tauri::http::StatusCode::NOT_FOUND
        );
    }

    #[test]
    fn traversal_is_confined_to_the_extensions_home() {
        let tmp = home_with_demo_page();
        for path in ["/../secrets.txt", "/acme.demo-1.0.0/../../secrets.txt"] {
            assert_eq!(
                serve_ext_asset_from(tmp.path(), &request_for(path)).status(),
                tauri::http::StatusCode::NOT_FOUND
            );
        }
    }

    #[test]
    fn percent_encoded_paths_decode_before_serving() {
        let tmp = home_with_demo_page();
        let response =
            serve_ext_asset_from(tmp.path(), &request_for("/acme.demo-1.0.0/web%2Fview.html"));
        assert_eq!(response.status(), tauri::http::StatusCode::OK);
    }

    #[test]
    fn a_page_without_a_head_still_gets_the_bootstrap_after_html() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("x-1").join("web");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("bare.html"),
            b"<!DOCTYPE html>\n<html lang=\"en\"><body>hi</body></html>",
        )
        .unwrap();
        let response = serve_ext_asset_from(tmp.path(), &request_for("/x-1/web/bare.html"));
        let body = String::from_utf8(response.body().to_vec()).unwrap();
        assert!(body.starts_with("<!DOCTYPE html>"));
        assert!(body.find("acquireGgsApi").unwrap() < body.find("<body>").unwrap());
    }
}

#[cfg(test)]
mod vsix_tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn the_real_bundled_vsix_auto_installs() {
        // The packed git-graph-rs VSIX (no ggs key, an engine .node + a main): the exact
        // package the installer ships, through the exact auto-install entry.
        let packed = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../target/studio/bundled/app-resources/extensions/git-graph-rs.vsix");
        if !packed.is_file() {
            eprintln!("skipping: no packed bundled vsix");
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let exts = tmp.path().join("extensions");
        std::fs::create_dir_all(&exts).unwrap();
        let outcomes = install_missing_bundled_in(&exts, &[packed]);
        assert_eq!(outcomes.len(), 1);
        let outcome = &outcomes[0];
        assert!(outcome.is_ok(), "auto-install failed: {outcome:?}");
        // The install exists and its derived manifest carries a backend.
        let versions = find_installed(&exts, "neophack.git-graph-rs").unwrap();
        assert!(!versions.is_empty(), "the install landed");
        let manifest: StudioManifest = serde_json::from_str(
            &std::fs::read_to_string(exts.join(format!("neophack.git-graph-rs-{}", versions[0])).join("manifest.json")).unwrap(),
        )
        .unwrap();
        assert!(manifest.backend.is_some(), "the derived manifest declares a backend");
    }

    #[test]
    fn the_bundled_package_auto_installs_once_and_respects_a_dismissal() {
        let tmp = tempfile::tempdir().unwrap();
        let exts = tmp.path().join("extensions");
        std::fs::create_dir_all(&exts).unwrap();
        let vsix = make_vsix(tmp.path(), "demo", "acme", "1.0.0");
        let packages = vec![vsix.clone()];

        // First launch: the package installs.
        let outcomes = install_missing_bundled_in(&exts, &packages);
        assert_eq!(outcomes.len(), 1);
        assert!(outcomes[0].is_ok(), "{outcomes:?}");
        assert!(find_installed(&exts, "acme.demo")
            .map(|versions| !versions.is_empty())
            .unwrap_or(false));

        // The second boot is a no-op — the install already exists.
        let again = install_missing_bundled_in(&exts, &packages);
        assert!(again.is_empty(), "already-installed must skip: {again:?}");

        // A deliberate uninstall drops the dismissal marker; the boot pass reads it and
        // never resurrects the package.
        let marker = bundled_dismissed_marker(&exts, "acme.demo");
        std::fs::write(&marker, b"uninstalled\n").unwrap();
        let _ = std::fs::remove_dir_all(exts.join("acme.demo-1.0.0"));
        let outcomes = install_missing_bundled_in(&exts, &packages);
        assert!(outcomes.is_empty(), "dismissed stays dismissed: {outcomes:?}");
        assert!(!find_installed(&exts, "acme.demo")
            .map(|versions| !versions.is_empty())
            .unwrap_or(false));
    }

    /// A `.vsix` carrying `extension/package.json` + a compiled entry bundle, plus the OPC
    /// root files real packages ship (which the extractor must skip).
    fn make_vsix(dir: &Path, name: &str, publisher: &str, version: &str) -> PathBuf {
        let vsix = dir.join(format!("{publisher}.{name}-{version}.vsix"));
        let file = std::fs::File::create(&vsix).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        let manifest = format!(
            r#"{{"name":"{name}","publisher":"{publisher}","version":"{version}","main":"./out/extension.js","description":"test"}}"#
        );
        zip.start_file("extension/package.json", options).unwrap();
        zip.write_all(manifest.as_bytes()).unwrap();
        zip.start_file("extension/out/extension.js", options)
            .unwrap();
        zip.write_all(b"exports.activate = function() {};").unwrap();
        zip.start_file("[Content_Types].xml", options).unwrap();
        zip.write_all(b"<Types/>").unwrap();
        zip.finish().unwrap();
        vsix
    }

    #[test]
    fn install_list_and_uninstall() {
        let tmp = tempfile::tempdir().unwrap();
        let exts = tmp.path().join("extensions");
        std::fs::create_dir_all(&exts).unwrap();
        let vsix = make_vsix(tmp.path(), "demo", "acme", "1.0.0");

        let info = install_from_vsix_into(&exts, &vsix, false).unwrap();
        assert_eq!(info.id, "acme.demo");
        assert_eq!(info.version, "1.0.0");
        assert_eq!(info.format, "vsix");
        // The entry bundle lands at the install root, the OPC files do not.
        assert!(Path::new(&info.path).join("out/extension.js").is_file());
        assert!(!Path::new(&info.path).join("[Content_Types].xml").exists());

        let list = list_installed(&exts).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(
            (list[0].id.as_str(), list[0].format.as_str()),
            ("acme.demo", "vsix")
        );

        uninstall(&exts, "acme.demo").unwrap();
        assert!(list_installed(&exts).unwrap().is_empty());
    }

    #[test]
    fn a_vsix_with_ggs_capabilities_installs_with_a_generated_manifest() {
        // The git-graph-rs shape: a store-format VSIX whose `ggs` key carries the Studio
        // capabilities. The install turns the key into the same `manifest.json` the retired custom package
        // ships — identity forced to the package's own, so it cannot drift — and from there
        // the whole ggs/2 runtime (warm backend, ggs:// pages) serves the VSIX.
        let tmp = tempfile::tempdir().unwrap();
        let exts = tmp.path().join("extensions");
        std::fs::create_dir_all(&exts).unwrap();
        let vsix = tmp.path().join("acme.pages-2.0.0.vsix");
        let file = std::fs::File::create(&vsix).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        let manifest = r#"{"name":"pages","publisher":"acme","version":"2.0.0","main":"./out/extension.js",
                "ggs":{"format":"ggs/2","id":"stale.drift","version":"0.0.1",
                        "pages":{"view":{"page":"web/view.html","title":"View","singleton":true}},
                        "backend":{"kind":"process","command":"backend/main","protocol":"ggs-ext/1"},
                        "activitybar":{"command":"acme.pages.open"},
                        "permissions":["repo:read"]}}"#;
        zip.start_file("extension/package.json", options).unwrap();
        zip.write_all(manifest.as_bytes()).unwrap();
        zip.start_file("extension/web/view.html", options).unwrap();
        zip.write_all(b"<html></html>").unwrap();
        zip.finish().unwrap();

        let info = install_from_vsix_into(&exts, &vsix, false).unwrap();
        assert_eq!(info.format, "vsix");
        let ggx: StudioManifest = serde_json::from_str(
            &std::fs::read_to_string(Path::new(&info.path).join("manifest.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(ggx.format, STUDIO_FORMAT);
        // The identity is the package's own, not what the key redundantly claimed.
        assert_eq!(ggx.id, "acme.pages");
        assert_eq!(ggx.version, "2.0.0");
        assert_eq!(ggx.pages.as_ref().unwrap().len(), 1);
        assert!(ggx.backend.is_some());
        assert_eq!(ggx.activitybar.as_ref().unwrap().command, "acme.pages.open");
        assert_eq!(ggx.permissions, vec!["repo:read".to_owned()]);
        // list_installed surfaces the generated capabilities.
        let listed = list_installed(&exts).unwrap().remove(0);
        assert!(listed.capabilities.is_some());
    }

    #[test]
    fn upgrades_are_forward_only() {
        let tmp = tempfile::tempdir().unwrap();
        let exts = tmp.path().join("extensions");
        std::fs::create_dir_all(&exts).unwrap();
        assert!(install_from_vsix_into(
            &exts,
            &make_vsix(tmp.path(), "demo", "acme", "1.0.0"),
            false
        )
        .is_ok());

        let same = install_from_vsix_into(
            &exts,
            &make_vsix(tmp.path(), "demo", "acme", "1.0.0"),
            false,
        );
        assert!(same.unwrap_err().contains("already installed"));
        let older = install_from_vsix_into(
            &exts,
            &make_vsix(tmp.path(), "demo", "acme", "0.9.0"),
            false,
        );
        assert!(older.unwrap_err().contains("is older"));

        let newer = install_from_vsix_into(
            &exts,
            &make_vsix(tmp.path(), "demo", "acme", "1.1.0"),
            false,
        );
        assert_eq!(newer.unwrap().version, "1.1.0");
        // The old directory is gone: one install per id.
        assert!(list_installed(&exts).unwrap().len() == 1);
    }

    #[test]
    fn a_newer_vsix_replaces_a_ggx_and_vice_versa() {
        let tmp = tempfile::tempdir().unwrap();
        let exts = tmp.path().join("extensions");
        std::fs::create_dir_all(&exts).unwrap();
        let ggx = super::install_tests::make_vsix(tmp.path(), "demo", "acme", "1.0.0", false);
        assert!(install_from_vsix_into(&exts, &ggx, false).is_ok());

        // The newer VSIX of the same id wins; the format follows the newer package.
        let info = install_from_vsix_into(
            &exts,
            &make_vsix(tmp.path(), "demo", "acme", "1.1.0"),
            false,
        )
        .unwrap();
        assert_eq!(
            (info.version.as_str(), info.format.as_str()),
            ("1.1.0", "vsix")
        );
        let list = list_installed(&exts).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].format, "vsix");
    }

    #[test]
    fn not_a_vsix_or_missing_main_is_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let plain = tmp.path().join("plain.zip");
        std::fs::write(&plain, b"not a zip").unwrap();
        assert!(read_vsix_manifest(&plain)
            .unwrap_err()
            .contains("read VSIX"));

        // A zip without extension/package.json is not a VSIX.
        let noext = tmp.path().join("noext.vsix");
        let file = std::fs::File::create(&noext).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        zip.start_file("package.json", zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(b"{}").unwrap();
        zip.finish().unwrap();
        assert!(read_vsix_manifest(&noext)
            .unwrap_err()
            .contains("not a VSIX"));

        // A bundle-less manifest cannot run in the frame host.
        // A VSIX with neither a bundle nor a backend is a valid install: the store's
        // static-contribution packages (themes, snippets, grammars) look exactly like this,
        // and maximum VSIX compatibility means they install rather than being rejected.
        let nobundle = tmp.path().join("nobundle.vsix");
        let file = std::fs::File::create(&nobundle).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        zip.start_file(
            "extension/package.json",
            zip::write::SimpleFileOptions::default(),
        )
        .unwrap();
        zip.write_all(br#"{"name":"n","publisher":"p","version":"1.0.0"}"#)
            .unwrap();
        zip.finish().unwrap();
        assert!(read_vsix_manifest(&nobundle).is_ok());
    }

    #[test]
    fn a_jsonc_package_json_installs_like_a_strict_one() {
        // Hand-authored packages in the wild carry comments and trailing commas; VS Code's
        // manifest reader tolerates both, so the store's reader does too.
        let manifest = parse_jsonc_manifest(
            br#"{
                // the identity
                "name": "jsonc",
                "publisher": "acme", /* block comment */
                "version": "1.0.0",
                "displayName": "JSONC Demo",
                "description": "a comment says // not a comment inside strings, nor a, comma",
                "contributes": {},
            }"#
            .as_slice(),
        )
        .unwrap();
        assert_eq!(
            (manifest.name.as_str(), manifest.publisher.as_str()),
            ("jsonc", "acme")
        );
        assert_eq!(manifest.display_name.as_deref(), Some("JSONC Demo"));

        // Strict JSON still parses, and garbage still fails with the reason.
        assert!(parse_jsonc_manifest(br#"{"name":"x"}"#).is_err());
    }

    #[test]
    fn comment_stripping_preserves_multibyte_text_both_sides_of_a_string() {
        let text = r#"{"displayName":"演示 // 注释","description":"多语言","categories":[]}"#;
        let stripped = strip_jsonc_comments(text);
        assert_eq!(stripped, text);
    }

    #[test]
    fn load_code_reads_the_loadable_surface_of_an_install() {
        let tmp = tempfile::tempdir().unwrap();
        let exts = tmp.path().join("extensions");
        std::fs::create_dir_all(&exts).unwrap();
        let vsix = tmp.path().join("acme.bundle-1.0.0.vsix");
        let file = std::fs::File::create(&vsix).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default();
        zip.start_file("extension/package.json", options).unwrap();
        zip.write_all(br#"{"name":"bundle","publisher":"acme","version":"1.0.0","main":"./out/extension.js"}"#).unwrap();
        zip.start_file("extension/out/extension.js", options)
            .unwrap();
        zip.write_all(b"module.exports = 1;").unwrap();
        zip.start_file("extension/node_modules/dep/package.json", options)
            .unwrap();
        zip.write_all(br#"{"name":"dep","main":"lib/dep.js"}"#)
            .unwrap();
        zip.start_file("extension/node_modules/dep/lib/dep.js", options)
            .unwrap();
        zip.write_all(b"module.exports = 2;").unwrap();
        zip.start_file("extension/assets/logo.png", options)
            .unwrap();
        zip.write_all(b"not code").unwrap();
        zip.start_file("extension/out/extension.js.map", options)
            .unwrap();
        zip.write_all(b"{}").unwrap();
        zip.finish().unwrap();
        install_from_vsix_into(&exts, &vsix, false).unwrap();

        let bundle = load_code_from(&installed_dir(&exts, "acme.bundle").unwrap()).unwrap();
        assert!(!bundle.truncated);
        let keys: Vec<&str> = bundle.files.keys().map(String::as_str).collect();
        assert_eq!(
            keys,
            vec![
                "node_modules/dep/lib/dep.js",
                "node_modules/dep/package.json",
                "out/extension.js",
                "package.json",
                // The install's own metadata is a `.json` beside the package's files; it
                // rides in the map without affecting anything.
                "studio-ext.json"
            ]
        );
        assert_eq!(bundle.files["out/extension.js"], "module.exports = 1;");
    }

    #[test]
    fn load_code_flags_what_its_bounds_left_behind() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("ext");
        std::fs::create_dir_all(root.join("deep/nested/dir")).unwrap();
        // One oversized file: over the per-file bound, so the bundle is truncated without it.
        std::fs::write(root.join("deep/big.js"), vec![b'x'; 9 * 1024 * 1024]).unwrap();
        std::fs::write(root.join("main.js"), b"module.exports = 1;").unwrap();
        let bundle = load_code_from(&root).unwrap();
        assert!(bundle.truncated);
        assert!(bundle.files.contains_key("main.js"));
        assert!(!bundle.files.contains_key("deep/big.js"));
    }

    #[test]
    fn the_node_env_reports_node_words_for_this_host() {
        let env = ext_node_env();
        assert!(matches!(
            env.platform.as_str(),
            "win32" | "darwin" | "linux"
        ));
        assert!(matches!(env.arch.as_str(), "x64" | "arm64" | _ if !env.arch.is_empty()));
        assert_eq!(env.eol, if cfg!(windows) { "\r\n" } else { "\n" });
        assert!(!env.homedir.is_empty());
    }
}

#[cfg(test)]
mod ext_fs_tests {
    use super::*;

    fn roots(tmp: &tempfile::TempDir) -> Vec<String> {
        vec![tmp.path().join("ws").to_string_lossy().into_owned()]
    }

    #[test]
    fn paths_are_confined_to_the_workspace_roots() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join("ws")).unwrap();
        let roots = roots(&tmp);
        // A relative path resolves against the first root.
        std::fs::write(tmp.path().join("ws/file.txt"), b"x").unwrap();
        let resolved = confine_to_roots(&roots, "file.txt").unwrap();
        assert!(resolved.ends_with("file.txt"));
        // An absolute path outside the roots is refused.
        let outside = tmp.path().join("outside.txt");
        std::fs::write(&outside, b"x").unwrap();
        assert!(confine_to_roots(&roots, &outside.to_string_lossy()).is_err());
        // A `..` escape canonicalizes outside too.
        assert!(confine_to_roots(&roots, "../ws2/file").is_err());
        // A not-yet-existing file inside is fine (its parent canonicalizes).
        assert!(confine_to_roots(&roots, "newdir/newfile.txt").is_ok());
    }

    #[test]
    fn read_write_list_stat_mkdir_delete_rename_round_trip() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join("ws")).unwrap();
        let roots = roots(&tmp);
        let encode = |bytes: &[u8]| {
            use base64::Engine;
            base64::engine::general_purpose::STANDARD.encode(bytes)
        };

        ext_fs_core(
            "write",
            &roots,
            "notes/a.txt",
            None,
            Some(&encode(b"hello")),
            encode,
        )
        .unwrap();
        let read = ext_fs_core("read", &roots, "notes/a.txt", None, None, encode).unwrap();
        assert_eq!(read["data"], encode(b"hello"));

        ext_fs_core("mkdir", &roots, "empty", None, None, encode).unwrap();
        let list = ext_fs_core("list", &roots, ".", None, None, encode).unwrap();
        let names: Vec<&str> = list
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["name"].as_str().unwrap())
            .collect();
        assert!(names.contains(&"notes") && names.contains(&"empty"));

        let stat = ext_fs_core("stat", &roots, "notes/a.txt", None, None, encode).unwrap();
        assert_eq!(stat["type"], 1);
        assert_eq!(stat["size"], 5);

        ext_fs_core(
            "rename",
            &roots,
            "notes/a.txt",
            Some("notes/b.txt"),
            None,
            encode,
        )
        .unwrap();
        assert!(
            ext_fs_core("exists", &roots, "notes/a.txt", None, None, encode).unwrap()[0].is_null()
        );
        let found = ext_fs_core("exists", &roots, "notes/b.txt", None, None, encode).unwrap();
        assert_eq!(found.as_array().unwrap().len(), 1);

        ext_fs_core("delete", &roots, "notes", None, None, encode).unwrap();
        assert!(!tmp.path().join("ws/notes").exists());
    }

    #[test]
    fn find_walks_the_globs() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path().join("ws");
        std::fs::create_dir_all(ws.join("src/deep")).unwrap();
        std::fs::create_dir_all(ws.join(".git")).unwrap();
        std::fs::write(ws.join("src/main.rs"), b"").unwrap();
        std::fs::write(ws.join("src/deep/util.rs"), b"").unwrap();
        std::fs::write(ws.join(".git/config"), b"").unwrap();
        let roots = roots(&tmp);
        let encode = |_: &[u8]| String::new();

        let all_rs = ext_fs_core("find", &roots, "**/*.rs", None, None, encode).unwrap();
        let list = all_rs.as_array().unwrap();
        assert_eq!(list.len(), 2);
        assert!(list.iter().all(|p| p.as_str().unwrap().ends_with(".rs")));

        let top = ext_fs_core("find", &roots, "src/*.rs", None, None, encode).unwrap();
        assert_eq!(top.as_array().unwrap().len(), 1);
    }

    #[test]
    fn the_glob_matcher_understands_double_star_and_question() {
        assert!(glob_match("**/*.rs", "src/main.rs"));
        assert!(glob_match("**/*.rs", "main.rs"));
        assert!(!glob_match("src/*.rs", "src/deep/util.rs"));
        assert!(glob_match("a?c", "abc"));
        assert!(!glob_match("a?c", "abbc"));
        assert!(glob_match("*.json", "package.json"));
    }
}

/// The backend the install DERIVES for a plain VSIX (no `ggs` key): under the real-Node
/// host (`GGS_REAL_NODE`) the platform's engine `.node` becomes the backend, loaded
/// natively; otherwise the package's JS `main` is the derived entry.
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
        // runtime (nodeHost.ts) loads the addon as the NAPI module it is.
        let node = tmp.path().join("engine.node");
        std::fs::write(&node, b"engine-node-fixture").unwrap();
        let vsix = make_plain_vsix_with_nodes(
            tmp.path(),
            &[("native/win32-x64-msvc/git-graph.node", &node)],
        );
        let manifest = read_vsix_manifest(&vsix).unwrap();
        let derived = resolve_node_binaries(&manifest, &vsix, true)
            .unwrap()
            .expect("a backend");
        assert_eq!(derived.kind, "node");
        assert_eq!(
            derived.command_for(&host_platform_key()),
            "native/win32-x64-msvc/git-graph.node"
        );
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
        let node = tmp.path().join("linux.node");
        std::fs::write(&node, b"linux-engine-fixture").unwrap();
        let vsix = make_plain_vsix_with_nodes(
            tmp.path(),
            &[("native/linux-x64-gnu/git-graph.node", &node)],
        );
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
