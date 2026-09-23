//! Extension management for Git Graph Studio.
//!
//! Studio's own package format is `.ggx` (docs/crabcode-development-plan.md §8.2): a zip with
//! `manifest.json` (the ggx header: id, version and the page registry / process backend) and
//! `package.json` (the VS Code-style manifest the Extensions view and the contribution points
//! read) at its root, plus `web/`, the localisations, README and licences. `.vsix` packages
//! install as the VS Code compatibility path: a zip with an `extension/` folder holding
//! `package.json` and the compiled entry point, activated in the frame host with the `vscode`
//! API shim. Both live under `~/.ggs/extensions/{id}-{version}/` — a user-level directory
//! like `.vscode/extensions`, so installs are easy to inspect and survive app data resets —
//! and a `.ggx` and a `.vsix` of the same id are the same extension: whichever has the higher
//! version wins.
//!
//! The integrated git-graph-rs extension and the GGX Demo sample both ship as bundled `.ggx`
//! packages the installer carries (`extensions/` beside the app — prepare.mjs packs them), but
//! the app installs nothing by default: [`ext_install_bundled`] is the one-click Install on
//! each bundled entry of the Extensions view, and it installs the package like any user `.ggx`
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
#[derive(Serialize, Deserialize)]
struct StudioExtMeta {
    builtin: bool,
    /// `vsix` (the default for installs made before the field existed) or `ggx`.
    #[serde(default = "default_format")]
    format: String,
    /// The identity (`package_stamp`) of the bundled `.ggx` this install was unpacked from —
    /// absent for a package installed from anywhere else, and for installs that predate it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    bundled_stamp: Option<String>,
}

fn default_format() -> String {
    "vsix".to_owned()
}

/// The `manifest.json` at the root of a `.ggx` package.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GgxManifest {
    /// `ggx/1` (a frontend page) or `ggx/2` (the named page registry and a process backend).
    pub format: String,
    /// `{publisher}.{name}`; must match `package.json`.
    pub id: String,
    pub version: String,
    #[serde(default)]
    pub frontend: Option<GgxFrontend>,
    /// `ggx/2`: the named page registry — every page the package can show, by id.
    #[serde(default)]
    pub pages: Option<std::collections::BTreeMap<String, GgxPage>>,
    /// `ggx/2`: the process backend declaration (`ext_process.rs` spawns it on demand).
    #[serde(default)]
    pub backend: Option<GgxBackend>,
    /// `ggx/2`: an activity-bar launcher — one icon in the workbench's activity bar that runs
    /// one of the package's commands (a view page's opener), the way a built-in view has one.
    #[serde(default)]
    pub activitybar: Option<GgxActivityBar>,
    #[serde(default)]
    pub permissions: Vec<String>,
}

/// A `ggx/2` package's activity-bar launcher: the icon (package-relative), its tooltip, and
/// the declared command a click runs.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GgxActivityBar {
    pub command: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub icon: Option<String>,
}

/// Where the package's webview lives (paths inside the package).
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GgxFrontend {
    pub page: String,
    #[serde(default)]
    pub config: Option<String>,
    #[serde(default)]
    pub compare: Option<String>,
}

/// One page of a `ggx/2` package: an HTML document inside the package, opened as an editor
/// tab over the `ggx://` protocol (which composes the page bootstrap into it).
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GgxPage {
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

/// The backend of a `ggx/2` package: a binary the process extension host spawns on demand —
/// any language that can write JSON lines to stdout qualifies.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GgxBackend {
    /// `process` — the only backend kind this app speaks.
    pub kind: String,
    /// The binary to run, relative to the package root (absolute is allowed: it is how the
    /// tests aim at a helper binary). Always present, even when `binaries` is too: it is the
    /// binary the build host packed, so it doubles as the fallback for a platform not listed
    /// in `binaries`.
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    /// The wire protocol the backend speaks: `ggs-ext/1` (the default, `serve_plugin`'s
    /// one-request-at-a-time command protocol) or `ggx-rpc/1` (`backend_rpc.rs`'s
    /// thread-per-request protocol, for a backend that answers bursts of concurrent reads —
    /// the git-graph engine backend).
    #[serde(default)]
    pub protocol: Option<String>,
    /// Per-platform binary paths (`{os}-{arch}`, e.g. `win32-x64`), relative to the package
    /// root, for a package built with more than one platform's binary. Optional: a package
    /// built by this app's own `build-ggx.mjs` packs only the host platform's binary and this
    /// map has at most one entry, matching `command`.
    #[serde(default)]
    pub binaries: Option<std::collections::BTreeMap<String, String>>,
}

impl GgxBackend {
    /// `ggs-ext/1` when `protocol` is absent — every manifest written before this field
    /// existed, and every third-party command-style plugin, speaks it.
    pub fn protocol_or_default(&self) -> &str {
        self.protocol
            .as_deref()
            .unwrap_or(crate::ggx_protocol::PROTOCOL_VERSION)
    }

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

/// This host's platform key, in the spelling `build-ggx.mjs`'s `binaries` map uses
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

pub const GGX_FORMAT: &str = "ggx/1";
/// The format that adds the named page registry and the process backend.
pub const GGX2_FORMAT: &str = "ggx/2";

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
    /// `builtin`, `vsix` or `ggx`.
    pub format: String,
    /// The `.ggx` header, for packages installed from one.
    pub ggx: Option<GgxManifest>,
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
    // (its version is the install's), and only the not-installed bundled ones remain offers.
    for package in bundled_packages(&app) {
        if list.iter().any(|ext| ext.id == package.id) {
            continue;
        }
        list.push(bundled_offer(&package));
    }
    Ok(list)
}

/// One bundled package as discovered beside the installer: its 'manifest.json' header and its
/// 'package.json', read straight out of the '.ggx' zip.
struct BundledPackage {
    id: String,
    path: std::path::PathBuf,
    manifest: VsixManifest,
    ggx: GgxManifest,
}

/// The '.ggx' packages shipped beside the app, by directory scan — the app names no id: the
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
            if path.extension().and_then(|e| e.to_str()) != Some("ggx") {
                continue;
            }
            let Ok((ggx, manifest)) = read_ggx_manifest(&path) else {
                continue;
            };
            if found
                .iter()
                .any(|package: &BundledPackage| package.id == ggx.id)
            {
                continue;
            }
            found.push(BundledPackage {
                id: ggx.id.clone(),
                path,
                manifest,
                ggx,
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
        ggx: Some(package.ggx.clone()),
    }
}

/// Install a `.vsix` package — the VS Code compatibility path. A newer version replaces an
/// installed `.vsix` or `.ggx` of the same id (the integrated git-graph-rs is refused: its
/// engine and view assets are the app's own, so a package of that id could never take effect).
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

/// Install a `.ggx` package (Studio's own format; a newer version replaces an installed
/// `.vsix` or `.ggx` of the same id).
#[tauri::command]
pub fn ext_install_from_ggx(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::ext_process::ProcessHostState>,
    path: String,
) -> Result<ExtInfo, String> {
    let dir = extensions_dir(&app)?;
    // Same as the VSIX install above: the old install's backend cannot outlive the directory
    // its exe lives in.
    let (header, _) = read_ggx_manifest(Path::new(&path))?;
    let _ = state.stop(&header.id);
    install_from_ggx_into(&dir, Path::new(&path), false)
}

/// Install one of the bundled '.ggx' packages the installer ships — the one-click Install
/// on the Extensions view's bundled offers. The id is explicit (the frontend names the row it
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
    let info = install_from_ggx_into(&dir, &package.path, false)?;
    record_bundled_stamp(
        &dir.join(format!("{ext_id}-{}", info.version)),
        &package.path,
    );
    Ok(info)
}

/// The identity of one bundled `.ggx` build: its length and a hash of its bytes. Two builds of
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
fn record_bundled_stamp(target: &Path, ggx: &Path) {
    let meta_path = target.join("studio-ext.json");
    let Some(mut meta) = std::fs::read_to_string(&meta_path)
        .ok()
        .and_then(|s| serde_json::from_str::<StudioExtMeta>(&s).ok())
    else {
        return;
    };
    meta.bundled_stamp = package_stamp(ggx);
    let _ = std::fs::write(&meta_path, serde_json::to_vec(&meta).unwrap());
}

/// The boot pass's refresh of installed packages the installer also ships at the SAME version:
/// forward-only installs refuse an equal version, so without this an install unpacked from an
/// older build of that version (an app upgrade that rebuilt the package without bumping it)
/// would keep its stale files and backend forever — a backend missing the protocol the app now
/// speaks. Only `.ggx` installs whose recorded bundled build differs are replaced (older and
/// newer versions are left to the forward-only rules; nothing is installed that was not
/// installed already). Run before any backend starts — a running binary holds its directory.
/// Returns one line per refreshed or failed package, for the boot log.
pub fn refresh_bundled_installs(app: &tauri::AppHandle) -> Vec<Result<String, String>> {
    let Ok(dir) = extensions_dir(app) else {
        return Vec::new();
    };
    refresh_bundled_installs_in(&dir, &bundled_packages(app))
}

fn refresh_bundled_installs_in(
    dir: &Path,
    packages: &[BundledPackage],
) -> Vec<Result<String, String>> {
    let mut outcomes = Vec::new();
    for package in packages {
        let version = &package.manifest.version;
        let target = dir.join(format!("{}-{version}", package.id));
        let Ok(text) = std::fs::read_to_string(target.join("studio-ext.json")) else {
            continue; // not installed at this version
        };
        let Ok(meta) = serde_json::from_str::<StudioExtMeta>(&text) else {
            continue;
        };
        if meta.format != "ggx" {
            continue;
        }
        let Some(stamp) = package_stamp(&package.path) else {
            continue;
        };
        if meta.bundled_stamp.as_deref() == Some(stamp.as_str()) {
            continue;
        }
        let refreshed = replace_install(dir, &target, &package.path, meta.builtin).map(|()| {
            format!(
                "{} {version} refreshed from the bundled package",
                package.id
            )
        });
        outcomes.push(refreshed.map_err(|e| format!("{} {version}: {e}", package.id)));
    }
    outcomes
}

/// Swap `target` (an install) for a fresh unpack of `ggx`, never leaving a half-deleted
/// install behind: the package is unpacked into a scratch directory first (a dot-name the
/// listing ignores), then the old directory is renamed away and the new one renamed in. On
/// Windows a directory holding a running binary refuses the rename as a whole — the install
/// app's upgrade launches the new app while the old one's backend is still exiting — so the
/// swap retries for a few seconds before giving up (the next boot tries again: the recorded
/// build still differs).
fn replace_install(dir: &Path, target: &Path, ggx: &Path, builtin: bool) -> Result<(), String> {
    let scratch = dir.join(format!(".refresh-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&scratch);
    std::fs::create_dir_all(&scratch).map_err(|e| format!("create {}: {e}", scratch.display()))?;
    let result = (|| {
        let info = install_from_ggx_into(&scratch, ggx, builtin)?;
        let staged = scratch.join(format!("{}-{}", info.id, info.version));
        record_bundled_stamp(&staged, ggx);
        let stale = scratch.join("stale");
        let mut attempt = 0;
        loop {
            match std::fs::rename(target, &stale) {
                Ok(()) => break,
                Err(_) if attempt < 20 => {
                    attempt += 1;
                    std::thread::sleep(std::time::Duration::from_millis(250));
                }
                Err(e) => return Err(format!("the install is in use ({e}); close every Git Graph Studio window and start it again")),
            }
        }
        if let Err(e) = std::fs::rename(&staged, target) {
            // Put the old install back rather than leave none.
            let _ = std::fs::rename(&stale, target);
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
/// "runs with the app".
pub fn process_backed_ids(dir: &Path) -> Vec<String> {
    list_installed(dir)
        .unwrap_or_default()
        .into_iter()
        .filter(|ext| {
            ext.ggx
                .as_ref()
                .is_some_and(|g| g.backend.as_ref().is_some_and(|b| b.kind == "process"))
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
    uninstall_stopping(&dir, &ext_id, &state)
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

fn list_installed(dir: &Path) -> Result<Vec<ExtInfo>, String> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(dir).map_err(|e| format!("read {}: {e}", dir.display()))? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let manifest = match read_manifest(&path) {
            Some(m) => m,
            None => continue, // leftover/partial install; invisible until replaced
        };
        let meta: StudioExtMeta = std::fs::read_to_string(path.join("studio-ext.json"))
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or(StudioExtMeta {
                builtin: false,
                format: default_format(),
                bundled_stamp: None,
            });
        let ggx: Option<GgxManifest> = std::fs::read_to_string(path.join("manifest.json"))
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
                format: if ggx.is_some() {
                    "ggx".to_owned()
                } else {
                    meta.format
                },
                ggx,
            }
            .with_docs(&path),
        );
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(out)
}

/// Read and validate the `manifest.json` + `package.json` pair of a `.ggx`.
fn read_ggx_manifest(ggx: &Path) -> Result<(GgxManifest, VsixManifest), String> {
    let file = std::fs::File::open(ggx).map_err(|e| format!("open {}: {e}", ggx.display()))?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("read .ggx: {e}"))?;
    let read = |zip: &mut zip::ZipArchive<std::fs::File>, name: &str| -> Result<Vec<u8>, String> {
        let mut bytes = Vec::new();
        zip.by_name(name)
            .map_err(|_| format!("not a .ggx package: missing {name}"))?
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        Ok(bytes)
    };
    let header: GgxManifest = serde_json::from_slice(&read(&mut zip, "manifest.json")?)
        .map_err(|e| format!("invalid manifest.json: {e}"))?;
    if header.format != GGX_FORMAT && header.format != GGX2_FORMAT {
        return Err(format!(
            "unsupported package format {} (this app reads {GGX_FORMAT} and {GGX2_FORMAT})",
            header.format
        ));
    }
    if let Some(backend) = &header.backend {
        if backend.kind != "process" {
            return Err(format!(
                "unsupported backend kind {} (this app speaks process)",
                backend.kind
            ));
        }
        if backend.command.trim().is_empty() {
            return Err("a declared backend needs a command".to_owned());
        }
    }
    let manifest: VsixManifest = serde_json::from_slice(&read(&mut zip, "package.json")?)
        .map_err(|e| format!("invalid package.json: {e}"))?;
    if manifest.name.is_empty() || manifest.publisher.is_empty() {
        return Err("package.json needs a name and a publisher".to_string());
    }
    let id = format!("{}.{}", manifest.publisher, manifest.name);
    if header.id != id {
        return Err(format!(
            "manifest.json names {} but package.json is {id}",
            header.id
        ));
    }
    if header.version != manifest.version {
        return Err(format!(
            "manifest.json is version {} but package.json is {}",
            header.version, manifest.version
        ));
    }
    Ok((header, manifest))
}

/// Install a `.ggx` into `dir`: the same upgrade rules as a VSIX (forward only, a same-id
/// `.vsix` counts as an older install of the same extension), every entry extracted at the
/// package root, the backend binary (a `ggx/2` process package) made executable where that
/// is a permission bit. Public so the process-host integration test can install a helper
/// package the way the app does.
pub fn install_from_ggx_into(dir: &Path, ggx: &Path, builtin: bool) -> Result<ExtInfo, String> {
    let (header, manifest) = read_ggx_manifest(ggx)?;
    let id = header.id.clone();
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
                // The same version from a .vsix is replaced by the .ggx (it carries more);
                // the same .ggx again is a no-op error, as for a VSIX.
                let old_meta: Option<StudioExtMeta> =
                    std::fs::read_to_string(target.join("studio-ext.json"))
                        .ok()
                        .and_then(|s| serde_json::from_str(&s).ok());
                if old_meta.map(|m| m.format == "ggx").unwrap_or(false) {
                    return Err(format!("{id} {existing} is already installed"));
                }
                std::fs::remove_dir_all(&target)
                    .map_err(|e| format!("remove old {id} {existing}: {e}"))?;
            }
            std::cmp::Ordering::Less => {
                std::fs::remove_dir_all(dir.join(format!("{id}-{existing}")))
                    .map_err(|e| format!("remove old {id} {existing}: {e}"))?;
            }
        }
    }
    extract_ggx(ggx, &target)?;
    // A `ggx/2` process package's backend needs its execute bit where the platform has one
    // (zip extraction does not carry permissions) — whichever binary this host would actually
    // run (`command_for`: a per-platform `binaries` entry if this host's key is listed, else
    // the single `command`).
    #[cfg(unix)]
    if let Some(backend) = header.backend.as_ref() {
        if backend.kind == "process" {
            let resolved = backend.command_for(&host_platform_key()).to_owned();
            if !Path::new(&resolved).is_absolute() {
                use std::os::unix::fs::PermissionsExt;
                let bin = target.join(&resolved);
                if let Ok(meta) = std::fs::metadata(&bin) {
                    let mut perms = meta.permissions();
                    perms.set_mode(0o755);
                    let _ = std::fs::set_permissions(&bin, perms);
                }
            }
        }
    }
    let meta = StudioExtMeta {
        builtin,
        format: "ggx".to_owned(),
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
        .ok_or_else(|| "installed package not listed after install".to_string())
}

fn extract_ggx(ggx: &Path, target: &Path) -> Result<(), String> {
    let file = std::fs::File::open(ggx).map_err(|e| format!("open {}: {e}", ggx.display()))?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("read .ggx: {e}"))?;
    std::fs::create_dir_all(target).map_err(|e| e.to_string())?;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
        if entry.is_dir() {
            continue;
        }
        let dest = safe_join(target, entry.name())?;
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut bytes = Vec::new();
        entry.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
        std::fs::write(&dest, &bytes).map_err(|e| format!("write {}: {e}", dest.display()))?;
    }
    Ok(())
}

/// Install a `.vsix` into `dir`: the same forward-only upgrade rules as a `.ggx` (a same-id
/// `.ggx` counts as just another install of the same extension).
fn install_from_vsix_into(dir: &Path, vsix: &Path, builtin: bool) -> Result<ExtInfo, String> {
    let manifest = read_vsix_manifest(vsix)?;
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

/// Read and validate the `extension/package.json` a `.vsix` carries. The `main` entry point
/// is required: the frame host only runs extensions with a compiled bundle.
fn read_vsix_manifest(vsix: &Path) -> Result<VsixManifest, String> {
    let file = std::fs::File::open(vsix).map_err(|e| format!("open {}: {e}", vsix.display()))?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("read VSIX: {e}"))?;
    let mut bytes = Vec::new();
    zip.by_name("extension/package.json")
        .map_err(|_| "not a VSIX: missing extension/package.json".to_string())?
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    let manifest: VsixManifest =
        serde_json::from_slice(&bytes).map_err(|e| format!("invalid package.json: {e}"))?;
    if manifest.name.is_empty() || manifest.publisher.is_empty() {
        return Err("package.json needs a name and a publisher".to_string());
    }
    if manifest.main.as_deref().unwrap_or("").is_empty() {
        return Err(format!(
            "{} has no `main` entry point; Studio only hosts extensions with a compiled bundle",
            manifest.name
        ));
    }
    Ok(manifest)
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
/// backend from, and the root the `ggx://` protocol serves a package's files out of.
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
// The `ggx://` protocol: how an installed package's pages reach a sandboxed iframe
// ---------------------------------------------------------------------------

/// Serve one `ggx://` request: a file of an installed package, as the extension pages'
/// iframes load them. URL shape `/{id}-{version}/{path}`; the package segment and the path
/// are both confined (no `..`), the root is the extensions home. An HTML page is composed
/// with the page bootstrap (`ext_page_boot.js`) the way graphPreload composes the Git Graph
/// page — the host environment joins the extension's own document, never a copy of it.
pub fn serve_ggx_asset(request: &tauri::http::Request<Vec<u8>>) -> tauri::http::Response<Vec<u8>> {
    match extensions_home_dir() {
        Ok(home) => serve_ggx_asset_from(&home, request),
        Err(_) => ggx_not_found(request.uri().path()),
    }
}

/// The serving core over an explicit extensions home, so the tests can point it at a
/// scratch directory instead of the developer's real one.
fn serve_ggx_asset_from(
    home: &Path,
    request: &tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    let requested = request.uri().path().trim_start_matches('/').to_owned();
    let decoded = percent_decode(&requested);
    let mut segments = decoded.split(['/', '\\']).filter(|s| !s.is_empty());
    let Some(package) = segments.next() else {
        return ggx_not_found(&requested);
    };
    let rel: Vec<&str> = segments.collect();
    if package.contains("..") || rel.is_empty() || rel.iter().any(|segment| segment.contains(".."))
    {
        return ggx_not_found(&requested);
    }
    let file = home.join(package).join(rel.join("/"));
    let Ok(bytes) = std::fs::read(&file) else {
        return ggx_not_found(&requested);
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

fn ggx_not_found(requested: &str) -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder()
        .status(tauri::http::StatusCode::NOT_FOUND)
        .header(
            tauri::http::header::CONTENT_TYPE,
            "text/plain; charset=utf-8",
        )
        .body(format!("no such ggx asset: {requested}").into_bytes())
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
struct VsixManifest {
    name: String,
    publisher: String,
    version: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    icon: Option<String>,
    /// The compiled entry point (`./out/extension.js`) — required of a `.vsix` (the frame
    /// host runs it), meaningless to a `.ggx` (whose program is its backend and pages).
    #[serde(default)]
    main: Option<String>,
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
}

/// `package.json` of an already-unpacked extension directory (`{dir}/package.json`).
fn read_manifest(dir: &Path) -> Option<VsixManifest> {
    let bytes = std::fs::read(dir.join("package.json")).ok()?;
    let manifest: VsixManifest = serde_json::from_slice(&bytes).ok()?;
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
mod ggx_tests {
    use super::*;
    use std::io::Write;

    /// A `.ggx` with the header, a package.json and a web page (an extra data file,
    /// optionally, to prove every entry lands). Visible to `vsix_tests`, which builds a
    /// same-id `.ggx`/`.vsix` pair to prove the two formats share one install slot.
    pub(super) fn make_ggx(
        dir: &Path,
        name: &str,
        publisher: &str,
        version: &str,
        with_data: bool,
        format: &str,
    ) -> PathBuf {
        let ggx = dir.join(format!("{publisher}.{name}-{version}.ggx"));
        let file = std::fs::File::create(&ggx).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        let header = format!(
            r#"{{"format":"{format}","id":"{publisher}.{name}","version":"{version}","frontend":{{"page":"web/view.html"}}}}"#
        );
        zip.start_file("manifest.json", options).unwrap();
        zip.write_all(header.as_bytes()).unwrap();
        zip.start_file("package.json", options).unwrap();
        zip.write_all(format!(r#"{{"name":"{name}","publisher":"{publisher}","version":"{version}","description":"a ggx"}}"#).as_bytes()).unwrap();
        zip.start_file("web/view.html", options).unwrap();
        zip.write_all(b"<html></html>").unwrap();
        if with_data {
            zip.start_file("data/payload.bin", options).unwrap();
            zip.write_all(b"payload").unwrap();
        }
        zip.finish().unwrap();
        ggx
    }

    #[test]
    fn a_same_version_install_from_an_older_bundled_build_is_refreshed_once() {
        let tmp = tempfile::tempdir().unwrap();
        let exts = tmp.path().join("extensions");
        std::fs::create_dir_all(&exts).unwrap();
        let old_build = tmp.path().join("old");
        std::fs::create_dir_all(&old_build).unwrap();
        // The install came from an older build of 1.0.0 (no data file, no stamp recorded).
        let stale = make_ggx(&old_build, "demo", "acme", "1.0.0", false, GGX_FORMAT);
        install_from_ggx_into(&exts, &stale, false).unwrap();
        let target = exts.join("acme.demo-1.0.0");
        assert!(!target.join("data/payload.bin").exists());

        // The app now ships a rebuilt 1.0.0: the boot pass replaces the stale files...
        let rebuilt = make_ggx(tmp.path(), "demo", "acme", "1.0.0", true, GGX_FORMAT);
        let (ggx, manifest) = read_ggx_manifest(&rebuilt).unwrap();
        let packages = [BundledPackage {
            id: ggx.id.clone(),
            path: rebuilt.clone(),
            manifest,
            ggx,
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
    fn the_listing_resolves_nls_placeholders_through_the_packages_own_nls_file() {
        let tmp = tempfile::tempdir().unwrap();
        let exts = tmp.path().join("extensions");
        std::fs::create_dir_all(&exts).unwrap();

        // The shape the git-graph-rs package really ships: `package.json` carrying
        // `%displayName%` / `%description%`, `package.nls.json` resolving both.
        let ggx = tmp.path().join("acme.demo-1.0.0.ggx");
        let file = std::fs::File::create(&ggx).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        zip.start_file("manifest.json", options).unwrap();
        zip.write_all(br#"{"format":"ggx/2","id":"acme.demo","version":"1.0.0","pages":{}}"#)
            .unwrap();
        zip.start_file("package.json", options).unwrap();
        zip.write_all(
            br#"{"name":"demo","publisher":"acme","version":"1.0.0","displayName":"%displayName%","description":"%extension.description%"}"#,
        ).unwrap();
        zip.start_file("package.nls.json", options).unwrap();
        zip.write_all(
            br#"{"displayName":"Demo (localized)","extension.description":"A localized demo."}"#,
        )
        .unwrap();
        zip.start_file("README.md", options).unwrap();
        zip.write_all(b"# Demo\n\nThe readme.").unwrap();
        zip.finish().unwrap();

        install_from_ggx_into(&exts, &ggx, true).unwrap();
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
        let ggx = make_ggx(tmp.path(), "demo", "acme", "1.0.0", false, GGX_FORMAT);

        let info = install_from_ggx_into(&exts, &ggx, false).unwrap();
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
        let ggx = tmp.path().join("rich.ggx");
        let file = std::fs::File::create(&ggx).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default();
        zip.start_file("manifest.json", options).unwrap();
        zip.write_all(br#"{"format":"ggx/2","id":"acme.rich","version":"2.0.0","pages":{}}"#)
            .unwrap();
        zip.start_file("package.json", options).unwrap();
        zip.write_all(
            br#"{"name":"rich","publisher":"acme","version":"2.0.0",
            "displayName":"Rich Demo","description":"d","categories":["Other","SCM Providers"],
            "keywords":["git"],"repository":{"type":"git","url":"https://example.com/rich.git"},
            "license":"MIT","engines":{"vscode":"^1.80.0"},
            "extensionDependencies":["acme.base"],"extensionPack":["acme.pack"]}"#,
        )
        .unwrap();
        zip.start_file("README.md", options).unwrap();
        zip.write_all(b"# Rich").unwrap();
        zip.start_file("CHANGELOG.md", options).unwrap();
        zip.write_all(b"# Changelog").unwrap();
        zip.finish().unwrap();

        let info = install_from_ggx_into(&exts, &ggx, false).unwrap();
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
    fn a_ggx_installs_lists_upgrades_and_refuses_downgrades() {
        let tmp = tempfile::tempdir().unwrap();
        let exts = tmp.path().join("extensions");
        std::fs::create_dir_all(&exts).unwrap();

        let ggx = make_ggx(tmp.path(), "demo", "acme", "1.0.0", true, GGX_FORMAT);
        let info = install_from_ggx_into(&exts, &ggx, true).unwrap();
        assert_eq!(
            (
                info.id.as_str(),
                info.version.as_str(),
                info.format.as_str(),
                info.builtin
            ),
            ("acme.demo", "1.0.0", "ggx", true)
        );
        assert_eq!(
            info.ggx.as_ref().unwrap().frontend.as_ref().unwrap().page,
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
        assert!(install_from_ggx_into(&exts, &ggx, false)
            .unwrap_err()
            .contains("already installed"));
        let newer = make_ggx(tmp.path(), "demo", "acme", "1.1.0", false, GGX_FORMAT);
        let info = install_from_ggx_into(&exts, &newer, false).unwrap();
        assert_eq!(info.version, "1.1.0");
        // The user package that replaced the bundled one is an ordinary uninstallable install.
        assert!(!info.builtin);
        assert_eq!(list_installed(&exts).unwrap().len(), 1);
        assert!(install_from_ggx_into(&exts, &ggx, false)
            .unwrap_err()
            .contains("is older"));
    }

    #[test]
    fn a_ggx_with_the_wrong_format_or_mismatched_ids_is_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let exts = tmp.path().join("extensions");
        std::fs::create_dir_all(&exts).unwrap();
        let bad = make_ggx(tmp.path(), "demo", "acme", "1.0.0", false, "ggx/9");
        assert!(install_from_ggx_into(&exts, &bad, false)
            .unwrap_err()
            .contains("unsupported package format"));

        let ggx = tmp.path().join("mismatch.ggx");
        let file = std::fs::File::create(&ggx).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default();
        zip.start_file("manifest.json", options).unwrap();
        zip.write_all(br#"{"format":"ggx/1","id":"acme.other","version":"1.0.0"}"#)
            .unwrap();
        zip.start_file("package.json", options).unwrap();
        zip.write_all(br#"{"name":"demo","publisher":"acme","version":"1.0.0"}"#)
            .unwrap();
        zip.finish().unwrap();
        assert!(install_from_ggx_into(&exts, &ggx, false)
            .unwrap_err()
            .contains("names acme.other"));

        // A plain zip is not a package.
        let plain = tmp.path().join("plain.ggx");
        let file = std::fs::File::create(&plain).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        zip.start_file("readme.txt", options).unwrap();
        zip.write_all(b"hi").unwrap();
        zip.finish().unwrap();
        assert!(install_from_ggx_into(&exts, &plain, false)
            .unwrap_err()
            .contains("not a .ggx"));
    }

    #[test]
    fn a_ggx2_package_carries_its_pages_and_process_backend() {
        let tmp = tempfile::tempdir().unwrap();
        let exts = tmp.path().join("extensions");
        std::fs::create_dir_all(&exts).unwrap();
        let ggx = tmp.path().join("pages.ggx");
        let file = std::fs::File::create(&ggx).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default();
        zip.start_file("manifest.json", options).unwrap();
        zip.write_all(
            br#"{"format":"ggx/2","id":"acme.demo","version":"1.0.0","pages":{"main":{"page":"web/view.html","title":"Demo"}},"backend":{"kind":"process","command":"bin/main.exe"}}"#,
        )
        .unwrap();
        zip.start_file("package.json", options).unwrap();
        zip.write_all(br#"{"name":"demo","publisher":"acme","version":"1.0.0"}"#)
            .unwrap();
        zip.start_file("web/view.html", options).unwrap();
        zip.write_all(b"<html><head></head><body></body></html>")
            .unwrap();
        zip.start_file("bin/main.exe", options).unwrap();
        zip.write_all(b"MZ").unwrap();
        zip.finish().unwrap();

        let info = install_from_ggx_into(&exts, &ggx, false).unwrap();
        let header = info.ggx.as_ref().unwrap();
        assert_eq!(header.format, "ggx/2");
        let main = &header.pages.as_ref().unwrap()["main"];
        assert_eq!(main.page, "web/view.html");
        assert_eq!(main.title.as_deref(), Some("Demo"));
        let backend = header.backend.as_ref().unwrap();
        assert_eq!(backend.kind, "process");
        assert_eq!(backend.command, "bin/main.exe");
        // The install lands where the process host and the ggx:// protocol will look.
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
        let ggx = tmp.path().join("multi.ggx");
        let file = std::fs::File::create(&ggx).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default();
        zip.start_file("manifest.json", options).unwrap();
        zip.write_all(
            br#"{"format":"ggx/2","id":"acme.engine","version":"1.0.0",
                "backend":{"kind":"process","command":"backend/win32-x64/main.exe","protocol":"ggx-rpc/1",
                "binaries":{"win32-x64":"backend/win32-x64/main.exe","darwin-arm64":"backend/darwin-arm64/main"}}}"#,
        )
        .unwrap();
        zip.start_file("package.json", options).unwrap();
        zip.write_all(br#"{"name":"engine","publisher":"acme","version":"1.0.0"}"#)
            .unwrap();
        zip.start_file("backend/win32-x64/main.exe", options)
            .unwrap();
        zip.write_all(b"MZ").unwrap();
        zip.start_file("backend/darwin-arm64/main", options)
            .unwrap();
        zip.write_all(b"\x7fELF").unwrap();
        zip.finish().unwrap();

        let info = install_from_ggx_into(&exts, &ggx, false).unwrap();
        let backend = info.ggx.as_ref().unwrap().backend.as_ref().unwrap();
        assert_eq!(backend.protocol_or_default(), "ggx-rpc/1");
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
        let backend = GgxBackend {
            kind: "process".to_owned(),
            command: "bin/main".to_owned(),
            args: Vec::new(),
            protocol: None,
            binaries: None,
        };
        assert_eq!(
            backend.protocol_or_default(),
            crate::ggx_protocol::PROTOCOL_VERSION
        );
    }

    #[test]
    fn a_backend_of_an_unknown_kind_is_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let exts = tmp.path().join("extensions");
        std::fs::create_dir_all(&exts).unwrap();
        let ggx = tmp.path().join("wasm.ggx");
        let file = std::fs::File::create(&ggx).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default();
        zip.start_file("manifest.json", options).unwrap();
        zip.write_all(
            br#"{"format":"ggx/2","id":"acme.demo","version":"1.0.0","backend":{"kind":"wasm","command":"main.wasm"}}"#,
        )
        .unwrap();
        zip.start_file("package.json", options).unwrap();
        zip.write_all(br#"{"name":"demo","publisher":"acme","version":"1.0.0"}"#)
            .unwrap();
        zip.finish().unwrap();

        let error = install_from_ggx_into(&exts, &ggx, false).unwrap_err();
        assert!(error.contains("unsupported backend kind"), "{error}");
    }
}

#[cfg(test)]
mod ggx_asset_tests {
    use super::*;

    fn request_for(path: &str) -> tauri::http::Request<Vec<u8>> {
        tauri::http::Request::builder()
            .uri(format!("http://ggx.localhost{path}"))
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
            serve_ggx_asset_from(tmp.path(), &request_for("/acme.demo-1.0.0/web/view.html"));
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
    fn assets_pass_through_untouched_and_unknowns_are_404() {
        let tmp = home_with_demo_page();
        let js = serve_ggx_asset_from(tmp.path(), &request_for("/acme.demo-1.0.0/web/app.js"));
        assert_eq!(js.body().as_slice(), b"console.log(1);");
        assert_eq!(
            serve_ggx_asset_from(tmp.path(), &request_for("/acme.demo-1.0.0/web/missing.css"))
                .status(),
            tauri::http::StatusCode::NOT_FOUND
        );
    }

    #[test]
    fn traversal_is_confined_to_the_extensions_home() {
        let tmp = home_with_demo_page();
        for path in ["/../secrets.txt", "/acme.demo-1.0.0/../../secrets.txt"] {
            assert_eq!(
                serve_ggx_asset_from(tmp.path(), &request_for(path)).status(),
                tauri::http::StatusCode::NOT_FOUND
            );
        }
    }

    #[test]
    fn percent_encoded_paths_decode_before_serving() {
        let tmp = home_with_demo_page();
        let response =
            serve_ggx_asset_from(tmp.path(), &request_for("/acme.demo-1.0.0/web%2Fview.html"));
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
        let response = serve_ggx_asset_from(tmp.path(), &request_for("/x-1/web/bare.html"));
        let body = String::from_utf8(response.body().to_vec()).unwrap();
        assert!(body.starts_with("<!DOCTYPE html>"));
        assert!(body.find("acquireGgsApi").unwrap() < body.find("<body>").unwrap());
    }
}

#[cfg(test)]
mod vsix_tests {
    use super::*;
    use std::io::Write;

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
        let ggx =
            super::ggx_tests::make_ggx(tmp.path(), "demo", "acme", "1.0.0", false, GGX_FORMAT);
        assert!(install_from_ggx_into(&exts, &ggx, false).is_ok());

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
        assert!(read_vsix_manifest(&nobundle)
            .unwrap_err()
            .contains("no `main` entry point"));
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
