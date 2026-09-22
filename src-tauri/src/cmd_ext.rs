//! Extension management for Git Graph Studio.
//!
//! Studio installs VS Code extensions from `.vsix` files (zip archives with an `extension/`
//! folder holding `package.json` and the compiled entry point). Extensions live under
//! `~/.ggs/extensions/{id}-{version}/` — a user-level directory like `.vscode/extensions`, so
//! installs are easy to inspect and survive app data resets; any extension can be upgraded
//! independently by installing a `.vsix` with a higher version.
//!
//! Studio's own package format, `.ggx` (docs/ggs-development-plan.md §8.2), installs into the
//! same directory: a zip with `manifest.json` (the ggx header: id, version and the page
//! registry / process backend) and `package.json` (the VS Code-style manifest the Extensions
//! view and the contribution points read) at its root, plus `web/`, the localisations, README
//! and licences. A `.ggx` and a `.vsix` of the same id are the same extension: whichever has
//! the higher version wins.
//!
//! The integrated git-graph-rs extension ships as the bundled `.ggx` the installer carries
//! (`extensions/git-graph-rs.ggx` beside the app — prepare.mjs packs it), but the app installs
//! nothing by default: [`ext_install_bundled`] is the one-click Install on the Extensions
//! view's integrated entry, and it installs the package like any user `.ggx` (forward-only,
//! uninstallable). The engine stays linked in-process and the view assets stay the app's own;
//! when no install is present (the default, or a dev run without the package), the listing
//! falls back to the manifest embedded at build time.

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
    #[serde(default)]
    pub permissions: Vec<String>,
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
        self.protocol.as_deref().unwrap_or(crate::ggx_protocol::PROTOCOL_VERSION)
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

/// The id of the git-graph-rs extension — the one Git Graph Studio integrates: its engine is
/// linked into the app, its webview assets are the app's own, and it ships as the bundled
/// `.ggx` the installer carries (installed on first launch, listed like any package).
pub const GRAPH_PACKAGE_ID: &str = "neophack.git-graph-rs";

/// The integrated extension's `package.json`, embedded from the repository's own file at build
/// time (build.rs passes the path): what the built-in entry in the Extensions view is described
/// by, and where the workbench reads the built-in's command contributions from.
const GRAPH_PACKAGE_JSON: &str = include_str!(env!("GITGRAPH_PACKAGE_JSON"));
/// Its `package.nls.json`, the same way — the contribution titles' default localisation.
const GRAPH_PACKAGE_NLS: &str = include_str!(env!("GITGRAPH_NLS_JSON"));

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
    Ok(with_builtin(list_installed(&dir)?))
}

/// The list the Extensions view renders: the integrated git-graph-rs first, then the installs.
/// An installed `.ggx` of the integrated id — the one-click bundled install, or a user's newer
/// upgrade of it — IS the listing now (its version is the package's own); only when no such
/// install exists does the build-time embedded entry stand in (the default: the app installs
/// no plugin until asked). An installed `.vsix` of the id stays hidden behind that fallback: it
/// could never take effect, the engine and view assets being the app's own.
fn with_builtin(mut list: Vec<ExtInfo>) -> Vec<ExtInfo> {
    if let Some(at) = list
        .iter()
        .position(|ext| ext.id == GRAPH_PACKAGE_ID && ext.format == "ggx")
    {
        let integrated = list.remove(at);
        list.insert(0, integrated);
        return list;
    }
    list.retain(|ext| ext.id != GRAPH_PACKAGE_ID);
    list.insert(0, builtin_graph_extension());
    list
}

/// The integrated git-graph-rs as the Extensions view lists it when no package install
/// exists (a dev run without the bundled `.ggx`): an embedded manifest, versioned by that
/// manifest's own `package.json`, no install directory, nothing to activate in a frame.
fn builtin_graph_extension() -> ExtInfo {
    let manifest: VsixManifest = serde_json::from_str(GRAPH_PACKAGE_JSON)
        .expect("the embedded git-graph-rs package.json is well-formed");
    // Read before the field moves below hand ownership to the entry.
    let repository_url = manifest.url_of().map(str::to_string);
    // The embedded manifest carries `%displayName%` placeholders like any VS Code extension;
    // the embedded NLS table resolves them the way the installed package's own does.
    let nls: serde_json::Value =
        serde_json::from_str(GRAPH_PACKAGE_NLS).unwrap_or(serde_json::Value::Null);
    let display_name = nls_resolve(manifest.display_name, &nls);
    let description = nls_resolve(manifest.description, &nls);
    ExtInfo {
        id: GRAPH_PACKAGE_ID.to_owned(),
        name: manifest.name,
        display_name,
        publisher: manifest.publisher,
        version: manifest.version.clone(),
        description: description.unwrap_or_default(),
        builtin: true,
        icon: None,
        path: String::new(),
        categories: manifest.categories,
        keywords: manifest.keywords,
        repository: repository_url,
        license: manifest.license,
        engines_vscode: manifest.engines.and_then(|e| e.vscode),
        extension_dependencies: manifest.extension_dependencies,
        extension_pack: manifest.extension_pack,
        readme: None,
        changelog: None,
        format: "builtin".to_owned(),
        ggx: None,
    }
}

/// Install a `.ggx` package (Studio's own format — the only format installs accept; a newer
/// version replaces an installed `.vsix` or `.ggx` of the same id).
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

/// Install the bundled git-graph-rs `.ggx` the installer ships — the one-click Install on the
/// Extensions view's integrated entry. The app installs no plugin by default; this is the ask.
/// A standard install: forward-only like any package, uninstallable like any package — the
/// integrated entry simply becomes a normal package of its id.
#[tauri::command]
pub fn ext_install_bundled(app: tauri::AppHandle) -> Result<ExtInfo, String> {
    let dir = extensions_dir(&app)?;
    let package = bundled_ggx_path(&app)?;
    install_from_ggx_into(&dir, &package, false)
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

/// Read a file inside an installed extension's directory (the extension host loads the entry
/// bundle this way). Paths are confined to the extension's own directory. For the integrated
/// git-graph-rs, the installed `.ggx` copy wins; only with no install (a dev run without the
/// bundled package) do the embedded manifest files answer.
#[tauri::command]
pub fn ext_read_file(
    app: tauri::AppHandle,
    ext_id: String,
    rel_path: String,
) -> Result<String, String> {
    let dir = extensions_dir(&app)?;
    if find_installed(&dir, &ext_id)?.is_empty() && ext_id == GRAPH_PACKAGE_ID {
        return match rel_path.as_str() {
            "package.json" => Ok(GRAPH_PACKAGE_JSON.to_owned()),
            "package.nls.json" => Ok(GRAPH_PACKAGE_NLS.to_owned()),
            _ => Err(format!(
                "{rel_path} is not part of the built-in {GRAPH_PACKAGE_ID}"
            )),
        };
    }
    let versions = find_installed(&dir, &ext_id)?;
    let version = versions
        .last()
        .ok_or_else(|| format!("{ext_id} is not installed"))?;
    let ext_dir = dir.join(format!("{ext_id}-{version}"));
    let path = safe_join(&ext_dir, &rel_path)?;
    std::fs::read_to_string(&path).map_err(|e| format!("read {}: {e}", path.display()))
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
pub fn install_from_ggx_into(
    dir: &Path,
    ggx: &Path,
    builtin: bool,
) -> Result<ExtInfo, String> {
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
    };
    std::fs::write(
        target.join("studio-ext.json"),
        serde_json::to_vec(&meta).unwrap(),
    )
    .map_err(|e| format!("write meta: {e}"))?;
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

fn uninstall(dir: &Path, ext_id: &str) -> Result<(), String> {
    let versions = find_installed(dir, ext_id)?;
    if versions.is_empty() {
        return Err(format!("{ext_id} is not installed"));
    }
    for version in versions {
        let path = dir.join(format!("{ext_id}-{version}"));
        let meta: StudioExtMeta = std::fs::read_to_string(path.join("studio-ext.json"))
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or(StudioExtMeta {
                builtin: false,
                format: default_format(),
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

/// Where the bundled package lives: the installer's resource dir in a packaged app; the
/// build's own versioned copy (`target/studio/bundled/`) in a dev run.
fn bundled_ggx_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Ok(resource) =
        app.path()
            .resolve("extensions/git-graph-rs.ggx", tauri::path::BaseDirectory::Resource)
    {
        if resource.is_file() {
            return Ok(resource);
        }
    }
    // `tauri dev` runs cargo from src-tauri/; the bat and CI from the repository root.
    for base in ["target/studio/bundled", "../target/studio/bundled"] {
        let found = newest_ggx_under(Path::new(base));
        if let Some((_, path)) = found {
            return Ok(path);
        }
    }
    Err("the bundled git-graph-rs package is not present (run scripts/prepare.mjs)".to_owned())
}

/// The newest `git-graph-rs-<version>.ggx` under `dir`, as `(version, path)`.
fn newest_ggx_under(dir: &Path) -> Option<(String, PathBuf)> {
    let entries = std::fs::read_dir(dir).ok()?;
    let mut newest: Option<(String, PathBuf)> = None;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.starts_with("git-graph-rs-") || !name.ends_with(".ggx") {
            continue;
        }
        let version = name["git-graph-rs-".len()..name.len() - ".ggx".len()].to_owned();
        if newest
            .as_ref()
            .is_some_and(|(best, _)| compare_versions(best, &version) != std::cmp::Ordering::Less)
        {
            continue;
        }
        newest = Some((version, entry.path()));
    }
    newest
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
fn serve_ggx_asset_from(home: &Path, request: &tauri::http::Request<Vec<u8>>) -> tauri::http::Response<Vec<u8>> {
    let requested = request.uri().path().trim_start_matches('/').to_owned();
    let decoded = percent_decode(&requested);
    let mut segments = decoded.split(['/', '\\']).filter(|s| !s.is_empty());
    let Some(package) = segments.next() else {
        return ggx_not_found(&requested);
    };
    let rel: Vec<&str> = segments.collect();
    if package.contains("..") || rel.is_empty() || rel.iter().any(|segment| segment.contains("..")) {
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
        .header(tauri::http::header::CONTENT_TYPE, "text/plain; charset=utf-8")
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

/// Prepend the page bootstrap to the document: inside `<head>` when there is one (before
/// `</head>`, so the page's own scripts still load last), else right after the `<html>` tag
/// (a script before the doctype would force quirks mode), else at the very start.
fn compose_page(html: &str) -> String {
    let boot = format!("<script>\n{}\n</script>\n", include_str!("ext_page_boot.js"));
    for marker in ["</head>", "</HEAD>"] {
        if let Some(at) = html.find(marker) {
            return format!("{}{}{}", &html[..at], boot, &html[at..]);
        }
    }
    if let Some(at) = html.find("<html") {
        let end = html[at..]
            .find('>')
            .map(|offset| at + offset + 1)
            .unwrap_or(html.len());
        return format!("{}{}{}", &html[..end], boot, &html[end..]);
    }
    format!("{}{}", html, boot)
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

#[derive(Deserialize)]
struct VsixManifest {
    name: String,
    publisher: String,
    version: String,
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
}

/// `repository` is either a URL string or `{ "type": "git", "url": "..." }`.
#[derive(Deserialize)]
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

#[derive(Deserialize)]
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

/// Reject archive entries that escape the install directory.
fn safe_join(base: &Path, rel: &str) -> Result<PathBuf, String> {
    let rel_path = Path::new(rel);
    if rel_path.is_absolute() || rel_path.components().any(|c| c.as_os_str() == "..") {
        return Err(format!("unsafe entry in VSIX: {rel}"));
    }
    Ok(base.join(rel_path))
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_comparison() {
        assert_eq!(
            compare_versions("1.2.0", "1.10.0"),
            std::cmp::Ordering::Less
        );
        assert_eq!(
            compare_versions("2.0.0", "1.99.99"),
            std::cmp::Ordering::Greater
        );
        assert_eq!(
            compare_versions("1.0.0", "1.0.0"),
            std::cmp::Ordering::Equal
        );
        assert_eq!(
            compare_versions("1.0.0-beta", "1.0.0"),
            std::cmp::Ordering::Equal
        );
        assert_eq!(compare_versions("junk", "0.0.1"), std::cmp::Ordering::Less);
    }

    #[test]
    fn traversal_entries_are_rejected() {
        assert!(safe_join(Path::new("/base"), "../escape").is_err());
        assert!(safe_join(Path::new("/base"), "ok/file.js").is_ok());
    }

    /// The pure halves of the listing battery: a string repository field resolves to its URL,
    /// and the README/CHANGELOG probe accepts the spellings VS Code's extension editor does.
    #[test]
    fn repository_fields_and_doc_names_resolve() {
        assert_eq!(
            RepositoryField::Url("https://x".into()).url(),
            Some("https://x")
        );
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("Readme.MD"), b"x").unwrap();
        assert_eq!(
            find_doc(tmp.path(), "README").as_deref(),
            Some("Readme.MD")
        );
        assert_eq!(find_doc(tmp.path(), "CHANGELOG"), None);
    }
}

#[cfg(test)]
mod ggx_tests {
    use super::*;
    use std::io::Write;

    /// A `.ggx` with the header, a package.json and a web page (an extra data file,
    /// optionally, to prove every entry lands).
    fn make_ggx(dir: &Path, name: &str, publisher: &str, version: &str, with_data: bool, format: &str) -> PathBuf {
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
        zip.write_all(br#"{"format":"ggx/2","id":"acme.demo","version":"1.0.0","pages":{}}"#).unwrap();
        zip.start_file("package.json", options).unwrap();
        zip.write_all(
            br#"{"name":"demo","publisher":"acme","version":"1.0.0","displayName":"%displayName%","description":"%extension.description%"}"#,
        ).unwrap();
        zip.start_file("package.nls.json", options).unwrap();
        zip.write_all(br#"{"displayName":"Demo (localized)","extension.description":"A localized demo."}"#).unwrap();
        zip.start_file("README.md", options).unwrap();
        zip.write_all(b"# Demo\n\nThe readme.").unwrap();
        zip.finish().unwrap();

        install_from_ggx_into(&exts, &ggx, true).unwrap();
        let listed = list_installed(&exts).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(
            (listed[0].display_name.as_deref(), listed[0].description.as_str()),
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

    #[test]
    fn builtin_installs_refuse_uninstall() {
        let tmp = tempfile::tempdir().unwrap();
        let exts = tmp.path().join("extensions");
        std::fs::create_dir_all(&exts).unwrap();
        let ggx = make_ggx(tmp.path(), "graph", "neophack", "1.0.23", false, GGX_FORMAT);
        let info = install_from_ggx_into(&exts, &ggx, true).unwrap();
        assert!(info.builtin);

        let err = uninstall(&exts, "neophack.graph").unwrap_err();
        assert!(err.contains("cannot be uninstalled"), "{err}");
    }

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
        zip.write_all(b"<html><head></head><body></body></html>").unwrap();
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
        zip.start_file("backend/win32-x64/main.exe", options).unwrap();
        zip.write_all(b"MZ").unwrap();
        zip.start_file("backend/darwin-arm64/main", options).unwrap();
        zip.write_all(b"\x7fELF").unwrap();
        zip.finish().unwrap();

        let info = install_from_ggx_into(&exts, &ggx, false).unwrap();
        let backend = info.ggx.as_ref().unwrap().backend.as_ref().unwrap();
        assert_eq!(backend.protocol_or_default(), "ggx-rpc/1");
        assert_eq!(backend.command_for("win32-x64"), "backend/win32-x64/main.exe");
        assert_eq!(backend.command_for("darwin-arm64"), "backend/darwin-arm64/main");
        // A platform not in the map falls back to `command`.
        assert_eq!(backend.command_for("linux-x64"), "backend/win32-x64/main.exe");

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let resolved = backend.command_for(&host_platform_key()).to_owned();
            let bin = installed_dir(&exts, "acme.engine").unwrap().join(&resolved);
            let mode = std::fs::metadata(&bin).unwrap().permissions().mode();
            assert_eq!(mode & 0o111, 0o111, "the resolved binary should be executable");
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
        assert_eq!(backend.protocol_or_default(), crate::ggx_protocol::PROTOCOL_VERSION);
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
        std::fs::write(dir.join("view.html"), b"<html><head><title>t</title></head><body></body></html>").unwrap();
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
        // The bootstrap lands inside <head> (after the title, before the page's own body);
        // the document itself arrives intact.
        assert!(body.contains("acquireGgsApi"));
        assert!(body.find("acquireGgsApi").unwrap() < body.find("</head>").unwrap());
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
mod integrated_tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn the_integrated_extension_is_listed_as_a_builtin_and_cannot_be_installed_over() {
        // The built-in entry comes from the embedded manifest, versioned by the engine.
        let list = with_builtin(Vec::new());
        assert_eq!(list.len(), 1);
        let builtin = &list[0];
        assert_eq!(
            (
                builtin.id.as_str(),
                builtin.builtin,
                builtin.format.as_str()
            ),
            (GRAPH_PACKAGE_ID, true, "builtin")
        );
        let embedded: serde_json::Value = serde_json::from_str(GRAPH_PACKAGE_JSON).unwrap();
        assert_eq!(builtin.version, embedded["version"].as_str().unwrap());
        assert!(!builtin.name.is_empty() && !builtin.publisher.is_empty());

        // An installed copy of the integrated extension (left by an earlier app version) is
        // hidden behind the built-in entry.
        let tmp = tempfile::tempdir().unwrap();
        let exts = tmp.path().join("extensions");
        std::fs::create_dir_all(exts.join("someone.else-1.0.0")).unwrap();
        let stray = exts.join(format!("{GRAPH_PACKAGE_ID}-9.9.9"));
        std::fs::create_dir_all(&stray).unwrap();
        let mut other_manifest =
            std::fs::File::create(exts.join("someone.else-1.0.0").join("package.json")).unwrap();
        write!(
            other_manifest,
            r#"{{"name":"else","publisher":"someone","version":"1.0.0"}}"#
        )
        .unwrap();
        let mut stray_manifest = std::fs::File::create(stray.join("package.json")).unwrap();
        write!(
            stray_manifest,
            r#"{{"name":"git-graph-rs","publisher":"neophack","version":"9.9.9"}}"#
        )
        .unwrap();
        let list = with_builtin(list_installed(&exts).unwrap());
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].id, GRAPH_PACKAGE_ID);
        assert_eq!(list[1].id, "someone.else");
    }

    #[test]
    fn a_newer_ggx_of_the_integrated_extension_installs_as_an_upgrade() {
        let tmp = tempfile::tempdir().unwrap();
        let exts = tmp.path().join("extensions");
        std::fs::create_dir_all(&exts).unwrap();
        let ggx = tmp.path().join("integrated.ggx");
        let file = std::fs::File::create(&ggx).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default();
        zip.start_file("manifest.json", options).unwrap();
        zip.write_all(
            format!(r#"{{"format":"ggx/2","id":"{GRAPH_PACKAGE_ID}","version":"99.0.0"}}"#)
                .as_bytes(),
        )
        .unwrap();
        zip.start_file("package.json", options).unwrap();
        zip.write_all(br#"{"name":"git-graph-rs","publisher":"neophack","version":"99.0.0","main":"out/extension.js"}"#).unwrap();
        zip.finish().unwrap();

        // The integrated id installs like any other now — the listing follows the package.
        let info = install_from_ggx_into(&exts, &ggx, false).unwrap();
        assert_eq!(info.id, GRAPH_PACKAGE_ID);
        assert_eq!(info.version, "99.0.0");
        assert!(!info.builtin);
        let list = with_builtin(list_installed(&exts).unwrap());
        assert_eq!(list[0].id, GRAPH_PACKAGE_ID);
        assert_eq!(list[0].format, "ggx");
        assert_eq!(list[0].version, "99.0.0");
        // The same package again is the usual same-version error, not a refusal.
        assert!(install_from_ggx_into(&exts, &ggx, false)
            .unwrap_err()
            .contains("already installed"));
    }

    /// A `.ggx` of the integrated extension's id at `version`, with a web page.
    fn integrated_ggx(dir: &Path, version: &str) -> PathBuf {
        let ggx = dir.join(format!("git-graph-rs-{version}.ggx"));
        let file = std::fs::File::create(&ggx).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default();
        zip.start_file("manifest.json", options).unwrap();
        zip.write_all(
            format!(
                r#"{{"format":"ggx/2","id":"{GRAPH_PACKAGE_ID}","version":"{version}","pages":{{"view":{{"page":"web/view.html"}}}}}}"#
            )
            .as_bytes(),
        )
        .unwrap();
        zip.start_file("package.json", options).unwrap();
        zip.write_all(
            format!(
                r#"{{"name":"git-graph-rs","publisher":"neophack","version":"{version}","description":"the integrated one"}}"#
            )
            .as_bytes(),
        )
        .unwrap();
        zip.start_file("web/view.html", options).unwrap();
        zip.write_all(b"<html></html>").unwrap();
        zip.finish().unwrap();
        ggx
    }

    #[test]
    fn the_bundled_ggx_installs_as_a_standard_package() {
        // ext_install_bundled is a thin wrapper over extensions_dir + bundled_ggx_path + this
        // core (the first two need an app handle); the model it installs under is what matters:
        // the integrated id becomes a normal, uninstallable package, and with it gone the
        // embedded built-in entry stands in again — nothing is installed by default.
        let tmp = tempfile::tempdir().unwrap();
        let exts = tmp.path().join("extensions");
        std::fs::create_dir_all(&exts).unwrap();
        let package = integrated_ggx(tmp.path(), "1.0.25");

        let info = install_from_ggx_into(&exts, &package, false).unwrap();
        assert_eq!(info.id, GRAPH_PACKAGE_ID);
        assert!(!info.builtin);
        let list = with_builtin(list_installed(&exts).unwrap());
        assert_eq!(list.len(), 1);
        assert_eq!(
            (list[0].id.as_str(), list[0].format.as_str(), list[0].version.as_str()),
            (GRAPH_PACKAGE_ID, "ggx", "1.0.25")
        );
        assert!(!list[0].builtin); // a standard install: uninstall is allowed
        uninstall(&exts, GRAPH_PACKAGE_ID).unwrap();
        // The fallback listing: embedded manifest, its own version, no install directory.
        let fallback = &with_builtin(list_installed(&exts).unwrap())[0];
        assert_eq!((fallback.id.as_str(), fallback.format.as_str()), (GRAPH_PACKAGE_ID, "builtin"));
        let embedded: serde_json::Value = serde_json::from_str(GRAPH_PACKAGE_JSON).unwrap();
        assert_eq!(fallback.version, embedded["version"].as_str().unwrap());
        assert!(uninstall(&exts, GRAPH_PACKAGE_ID).unwrap_err().contains("not installed"));
    }

    #[test]
    fn a_users_newer_ggx_upgrades_the_installed_integrated_copy() {
        let tmp = tempfile::tempdir().unwrap();
        let exts = tmp.path().join("extensions");
        std::fs::create_dir_all(&exts).unwrap();
        assert!(install_from_ggx_into(&exts, &integrated_ggx(tmp.path(), "1.0.25"), false).is_ok());

        // A newer package of the same id upgrades it, and the listing follows the version.
        let upgrade = integrated_ggx(tmp.path(), "1.0.26");
        let info = install_from_ggx_into(&exts, &upgrade, false).unwrap();
        assert_eq!(info.version, "1.0.26");
        let list = with_builtin(list_installed(&exts).unwrap());
        assert_eq!(list[0].version, "1.0.26");
        uninstall(&exts, GRAPH_PACKAGE_ID).unwrap();
        assert!(list_installed(&exts).unwrap().is_empty());
    }
}
