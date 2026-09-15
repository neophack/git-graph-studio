//! Extension management for Git Graph Studio.
//!
//! Studio installs VS Code extensions from `.vsix` files (zip archives with an `extension/`
//! folder holding `package.json` and the compiled entry point). Extensions live under
//! `~/.ggs/extensions/{id}-{version}/` — a user-level directory like `.vscode/extensions`, so
//! installs are easy to inspect and survive app data resets; any extension can be upgraded
//! independently by installing a `.vsix` with a higher version.
//!
//! Studio's own package format, `.ggx` (docs/ggs-development-plan.md §8.2), installs into the
//! same directory: a zip with `manifest.json` (the ggx header: id, version and the frontend
//! page) and `package.json` (the VS Code-style manifest the Extensions view and the
//! contribution points read) at its root, plus `web/`, the localisations, README and licences.
//! A `.ggx` and a `.vsix` of the same id are the same extension: whichever has the higher
//! version wins.
//!
//! The git-graph-rs extension itself is not an install: its engine is linked into the app and
//! its webview assets are the app's own, so it is listed as a built-in (`builtin_graph_extension`)
//! and an install of its id is refused — its version follows the application.

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
    /// `ggx/1`.
    pub format: String,
    /// `{publisher}.{name}`; must match `package.json`.
    pub id: String,
    pub version: String,
    #[serde(default)]
    pub frontend: Option<GgxFrontend>,
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

pub const GGX_FORMAT: &str = "ggx/1";

/// The id of the git-graph-rs extension — the one Git Graph Studio integrates: its engine is
/// linked into the app, its webview assets are the app's own, and the Extensions view lists it
/// as a built-in rather than an install.
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

/// The first `NAME.md`/`NAME` file in `dir` matching `name` case-insensitively (the usual spellings
/// VS Code's extension editor accepts), relative to the extension directory.
fn find_doc(dir: &Path, name: &str) -> Option<String> {
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        let file_name = entry.file_name();
        let Some(file) = file_name.to_str() else { continue };
        let stem = file.split('.').next().unwrap_or("");
        if stem.eq_ignore_ascii_case(name)
            && (file.len() == stem.len() || file[stem.len()..].eq_ignore_ascii_case(".md")
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
    let home = home_dir().ok_or_else(|| "no user home directory".to_string())?;
    let dir = home.join(".ggs").join("extensions");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    Ok(dir)
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

/// The list the Extensions view renders: the integrated git-graph-rs as a built-in entry
/// first, then the installs — an installed copy of the integrated one (left by an earlier
/// version of the app) is inert and stays off the list.
fn with_builtin(mut list: Vec<ExtInfo>) -> Vec<ExtInfo> {
    list.retain(|ext| ext.id != GRAPH_PACKAGE_ID);
    list.insert(0, builtin_graph_extension());
    list
}

/// The integrated git-graph-rs as the Extensions view lists it: a built-in whose engine is
/// linked into the app (the version shown is the engine's) and whose manifest is embedded —
/// no install directory, nothing to activate in a frame.
fn builtin_graph_extension() -> ExtInfo {
    let manifest: VsixManifest = serde_json::from_str(GRAPH_PACKAGE_JSON)
        .expect("the embedded git-graph-rs package.json is well-formed");
    // Read before the field moves below hand ownership to the entry.
    let repository_url = manifest.url_of().map(str::to_string);
    ExtInfo {
        id: GRAPH_PACKAGE_ID.to_owned(),
        name: manifest.name,
        display_name: manifest.display_name,
        publisher: manifest.publisher,
        version: crate::cmd_graph::engine_version().to_owned(),
        description: manifest.description.unwrap_or_default(),
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

/// Refuse an install of the integrated extension: its engine and webview are the app's own, so
/// a package of the same id could never take effect.
fn refuse_integrated(manifest: &VsixManifest) -> Result<(), String> {
    let id = format!("{}.{}", manifest.publisher, manifest.name);
    if id == GRAPH_PACKAGE_ID {
        Err(format!(
            "{id} is built into Git Graph Studio; its version follows the application"
        ))
    } else {
        Ok(())
    }
}

#[tauri::command]
pub fn ext_install_from_vsix(app: tauri::AppHandle, path: String) -> Result<ExtInfo, String> {
    let dir = extensions_dir(&app)?;
    install_from_vsix_into(&dir, Path::new(&path), false)
}

/// Install a `.ggx` package (Studio's own format). A newer version replaces an installed
/// `.vsix` or `.ggx` of the same id.
#[tauri::command]
pub fn ext_install_from_ggx(app: tauri::AppHandle, path: String) -> Result<ExtInfo, String> {
    let dir = extensions_dir(&app)?;
    install_from_ggx_into(&dir, Path::new(&path), false)
}

#[tauri::command]
pub fn ext_uninstall(app: tauri::AppHandle, ext_id: String) -> Result<(), String> {
    if ext_id == GRAPH_PACKAGE_ID {
        return Err(format!("{ext_id} is part of the application and cannot be uninstalled"));
    }
    let dir = extensions_dir(&app)?;
    uninstall(&dir, &ext_id)
}

/// Read a file inside an installed extension's directory (the extension host loads the entry
/// bundle this way). Paths are confined to the extension's own directory.
#[tauri::command]
pub fn ext_read_file(
    app: tauri::AppHandle,
    ext_id: String,
    rel_path: String,
) -> Result<String, String> {
    if ext_id == GRAPH_PACKAGE_ID {
        // The integrated built-in has no install directory: its manifest files are embedded,
        // and nothing else of it is read through the store (the graph's assets are the app's
        // own, its engine is in-process).
        return match rel_path.as_str() {
            "package.json" => Ok(GRAPH_PACKAGE_JSON.to_owned()),
            "package.nls.json" => Ok(GRAPH_PACKAGE_NLS.to_owned()),
            _ => Err(format!("{rel_path} is not part of the built-in {GRAPH_PACKAGE_ID}")),
        };
    }
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
            .unwrap_or(StudioExtMeta { builtin: false, format: default_format() });
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
        out.push(ExtInfo {
            id: format!("{}.{}", manifest.publisher, manifest.name),
            name: manifest.name,
            display_name: manifest.display_name.clone(),
            publisher: manifest.publisher,
            version: manifest.version,
            description: manifest.description.unwrap_or_default(),
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
            format: if ggx.is_some() { "ggx".to_owned() } else { meta.format },
            ggx,
        }.with_docs(&path));
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(out)
}

fn install_from_vsix_into(dir: &Path, vsix: &Path, builtin: bool) -> Result<ExtInfo, String> {
    let manifest = read_vsix_manifest(vsix)?;
    refuse_integrated(&manifest)?;
    let id = format!("{}.{}", manifest.publisher, manifest.name);
    let target = dir.join(format!("{id}-{}", manifest.version));

    // Upgrade rule: same id installs only forward. A downgrade is an explicit error, not a
    // silent replacement.
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
    let meta = StudioExtMeta { builtin, format: "vsix".to_owned() };
    std::fs::write(
        target.join("studio-ext.json"),
        serde_json::to_vec(&meta).unwrap(),
    )
    .map_err(|e| format!("write meta: {e}"))?;

    let list = list_installed(dir)?;
    list.into_iter()
        .find(|e| e.id == id && e.version == manifest.version)
        .ok_or_else(|| "installed extension not listed after install".to_string())
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
    let header: GgxManifest = serde_json::from_slice(&read(&mut zip, "manifest.json")?).map_err(|e| format!("invalid manifest.json: {e}"))?;
    if header.format != GGX_FORMAT {
        return Err(format!("unsupported package format {} (this app reads {GGX_FORMAT})", header.format));
    }
    let manifest: VsixManifest = serde_json::from_slice(&read(&mut zip, "package.json")?).map_err(|e| format!("invalid package.json: {e}"))?;
    if manifest.name.is_empty() || manifest.publisher.is_empty() {
        return Err("package.json needs a name and a publisher".to_string());
    }
    let id = format!("{}.{}", manifest.publisher, manifest.name);
    if header.id != id {
        return Err(format!("manifest.json names {} but package.json is {id}", header.id));
    }
    if header.version != manifest.version {
        return Err(format!("manifest.json is version {} but package.json is {}", header.version, manifest.version));
    }
    Ok((header, manifest))
}

/// Install a `.ggx` into `dir`: the same upgrade rules as a VSIX (forward only, a same-id
/// `.vsix` counts as an older install of the same extension), every entry extracted at the
/// package root, the platform's backend binary made executable.
pub(crate) fn install_from_ggx_into(dir: &Path, ggx: &Path, builtin: bool) -> Result<ExtInfo, String> {
    let (header, manifest) = read_ggx_manifest(ggx)?;
    refuse_integrated(&manifest)?;
    let id = header.id.clone();
    let target = dir.join(format!("{id}-{}", manifest.version));
    for existing in find_installed(dir, &id)? {
        match compare_versions(&existing, &manifest.version) {
            std::cmp::Ordering::Greater => {
                return Err(format!("{id} {existing} is already installed; {id} {} is older", manifest.version))
            }
            std::cmp::Ordering::Equal => {
                // The same version from a .vsix is replaced by the .ggx (it carries more);
                // the same .ggx again is a no-op error, as for a VSIX.
                let old_meta: Option<StudioExtMeta> = std::fs::read_to_string(target.join("studio-ext.json")).ok().and_then(|s| serde_json::from_str(&s).ok());
                if old_meta.map(|m| m.format == "ggx").unwrap_or(false) {
                    return Err(format!("{id} {existing} is already installed"));
                }
                std::fs::remove_dir_all(&target).map_err(|e| format!("remove old {id} {existing}: {e}"))?;
            }
            std::cmp::Ordering::Less => {
                std::fs::remove_dir_all(dir.join(format!("{id}-{existing}"))).map_err(|e| format!("remove old {id} {existing}: {e}"))?;
            }
        }
    }
    extract_ggx(ggx, &target)?;
    let meta = StudioExtMeta { builtin, format: "ggx".to_owned() };
    std::fs::write(target.join("studio-ext.json"), serde_json::to_vec(&meta).unwrap()).map_err(|e| format!("write meta: {e}"))?;
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
            .unwrap_or(StudioExtMeta { builtin: false, format: default_format() });
        if meta.builtin {
            return Err(format!(
                "{ext_id} is built into Git Graph Studio and cannot be uninstalled"
            ));
        }
        std::fs::remove_dir_all(&path).map_err(|e| format!("remove {}: {e}", path.display()))?;
    }
    Ok(())
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

/// A file inside an installed extension's directory, base64-encoded - how the UI reads icons and
/// README images (binary files `ext_read_file` cannot return as text). Paths are confined to the
/// extension's own directory.
#[tauri::command]
pub fn ext_read_file_base64(
    app: tauri::AppHandle,
    ext_id: String,
    rel_path: String,
) -> Result<String, String> {
    if ext_id == GRAPH_PACKAGE_ID {
        return Err(format!("{ext_id} is built into the application; it has no installed files"));
    }
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
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
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

/// `package.json` of an already-unpacked extension directory (`{dir}/package.json`).
fn read_manifest(dir: &Path) -> Option<VsixManifest> {
    let bytes = std::fs::read(dir.join("package.json")).ok()?;
    let manifest: VsixManifest = serde_json::from_slice(&bytes).ok()?;
    if manifest.name.is_empty() || manifest.publisher.is_empty() {
        return None;
    }
    Some(manifest)
}

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
            continue; // VSIXs carry [Content_Types].xml and the manifest at the root; skip them
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
    let mut parts = v
        .split(['-', '+'])
        .next()
        .unwrap_or("")
        .split('.');
    let mut next = || parts.next().and_then(|p| p.parse().ok()).unwrap_or(0);
    (next(), next(), next())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// Build a minimal VSIX in `dir` and return its path.
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
        assert!(!info.builtin);
        assert!(Path::new(&info.path).join("out/extension.js").is_file());

        let list = list_installed(&exts).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, "acme.demo");

        uninstall(&exts, "acme.demo").unwrap();
        assert!(list_installed(&exts).unwrap().is_empty());
    }

    #[test]
    fn rich_manifest_fields_and_docs_are_listed() {
        let tmp = tempfile::tempdir().unwrap();
        let exts = tmp.path().join("extensions");
        std::fs::create_dir_all(&exts).unwrap();
        let vsix = tmp.path().join("rich.vsix");
        let file = std::fs::File::create(&vsix).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default();
        let manifest = r#"{"name":"rich","publisher":"acme","version":"2.0.0","main":"./out/ext.js",
            "displayName":"Rich Demo","description":"d","categories":["Other","SCM Providers"],
            "keywords":["git"],"repository":{"type":"git","url":"https://example.com/rich.git"},
            "license":"MIT","engines":{"vscode":"^1.80.0"},
            "extensionDependencies":["acme.base"],"extensionPack":["acme.pack"]}"#;
        zip.start_file("extension/package.json", options).unwrap();
        zip.write_all(manifest.as_bytes()).unwrap();
        zip.start_file("extension/out/ext.js", options).unwrap();
        zip.write_all(b"exports.activate = function() {};").unwrap();
        zip.start_file("extension/README.md", options).unwrap();
        zip.write_all(b"# Rich").unwrap();
        zip.start_file("extension/CHANGELOG.md", options).unwrap();
        zip.write_all(b"# Changelog").unwrap();
        zip.finish().unwrap();

        let info = install_from_vsix_into(&exts, &vsix, false).unwrap();
        assert_eq!(info.display_name.as_deref(), Some("Rich Demo"));
        assert_eq!(info.categories, vec!["Other", "SCM Providers"]);
        assert_eq!(info.keywords, vec!["git"]);
        assert_eq!(info.repository.as_deref(), Some("https://example.com/rich.git"));
        assert_eq!(info.license.as_deref(), Some("MIT"));
        assert_eq!(info.engines_vscode.as_deref(), Some("^1.80.0"));
        assert_eq!(info.extension_dependencies, vec!["acme.base"]);
        assert_eq!(info.extension_pack, vec!["acme.pack"]);
        assert!(info.readme.as_deref().is_some_and(|f| f.eq_ignore_ascii_case("README.md")));
        assert!(info.changelog.as_deref().is_some_and(|f| f.eq_ignore_ascii_case("CHANGELOG.md")));

        // A string repository field resolves to the URL too.
        assert_eq!(
            RepositoryField::Url("https://x".into()).url(),
            Some("https://x")
        );
        // README without extension / different case is still found.
        let doc_dir = tmp.path().join("docs");
        std::fs::create_dir_all(&doc_dir).unwrap();
        std::fs::write(doc_dir.join("Readme.MD"), b"x").unwrap();
        assert_eq!(find_doc(&doc_dir, "README").as_deref(), Some("Readme.MD"));
        assert_eq!(find_doc(&doc_dir, "CHANGELOG"), None);
    }

    #[test]
    fn upgrade_replaces_old_version() {
        let tmp = tempfile::tempdir().unwrap();
        let exts = tmp.path().join("extensions");
        std::fs::create_dir_all(&exts).unwrap();
        install_from_vsix_into(
            &exts,
            &make_vsix(tmp.path(), "demo", "acme", "1.0.0"),
            false,
        )
        .unwrap();
        install_from_vsix_into(
            &exts,
            &make_vsix(tmp.path(), "demo", "acme", "1.2.0"),
            false,
        )
        .unwrap();

        let list = list_installed(&exts).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].version, "1.2.0");
    }

    #[test]
    fn same_or_older_version_is_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let exts = tmp.path().join("extensions");
        std::fs::create_dir_all(&exts).unwrap();
        install_from_vsix_into(
            &exts,
            &make_vsix(tmp.path(), "demo", "acme", "1.2.0"),
            false,
        )
        .unwrap();

        let again = install_from_vsix_into(
            &exts,
            &make_vsix(tmp.path(), "demo", "acme", "1.2.0"),
            false,
        );
        assert!(again.is_err());
        let older = install_from_vsix_into(
            &exts,
            &make_vsix(tmp.path(), "demo", "acme", "1.1.9"),
            false,
        );
        assert!(older.unwrap_err().contains("older"));
    }

    #[test]
    fn builtin_cannot_be_uninstalled() {
        let tmp = tempfile::tempdir().unwrap();
        let exts = tmp.path().join("extensions");
        std::fs::create_dir_all(&exts).unwrap();
        let vsix = make_vsix(tmp.path(), "graph", "neophack", "1.0.23");
        let info = install_from_vsix_into(&exts, &vsix, true).unwrap();
        assert!(info.builtin);

        let err = uninstall(&exts, "neophack.graph").unwrap_err();
        assert!(err.contains("cannot be uninstalled"), "{err}");
    }

    #[test]
    fn builtin_upgrades_via_user_vsix() {
        let tmp = tempfile::tempdir().unwrap();
        let exts = tmp.path().join("extensions");
        std::fs::create_dir_all(&exts).unwrap();
        install_from_vsix_into(
            &exts,
            &make_vsix(tmp.path(), "graph", "neophack", "1.0.23"),
            true,
        )
        .unwrap();
        install_from_vsix_into(
            &exts,
            &make_vsix(tmp.path(), "graph", "neophack", "1.1.0"),
            false,
        )
        .unwrap();

        let list = list_installed(&exts).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].version, "1.1.0");
    }

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
    fn vsix_without_manifest_is_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("plain.zip");
        let file = std::fs::File::create(&path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        zip.start_file("readme.txt", zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(b"hi").unwrap();
        zip.finish().unwrap();

        let err = install_from_vsix_into(&tmp.path().join("extensions"), &path, false).unwrap_err();
        assert!(err.contains("not a VSIX"));
    }

    #[test]
    fn vsix_without_main_is_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("nomain.vsix");
        let file = std::fs::File::create(&path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        zip.start_file(
            "extension/package.json",
            zip::write::SimpleFileOptions::default(),
        )
        .unwrap();
        zip.write_all(br#"{"name":"x","publisher":"y","version":"1.0.0"}"#)
            .unwrap();
        zip.finish().unwrap();

        let err = install_from_vsix_into(&tmp.path().join("extensions"), &path, false).unwrap_err();
        assert!(err.contains("no `main`"));
    }

    #[test]
    fn traversal_entries_are_rejected() {
        assert!(safe_join(Path::new("/base"), "../escape").is_err());
        assert!(safe_join(Path::new("/base"), "ok/file.js").is_ok());
    }
}

#[cfg(test)]
mod ggx_tests {
    use super::*;
    use std::io::Write;

    /// A `.ggx` with the header, a package.json and a web page (an extra data file,
    /// optionally, to prove every entry lands).
    fn make_ggx(dir: &Path, version: &str, with_data: bool, format: &str) -> PathBuf {
        let ggx = dir.join(format!("acme.demo-{version}.ggx"));
        let file = std::fs::File::create(&ggx).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        let header = format!(r#"{{"format":"{format}","id":"acme.demo","version":"{version}","frontend":{{"page":"web/view.html"}}}}"#);
        zip.start_file("manifest.json", options).unwrap();
        zip.write_all(header.as_bytes()).unwrap();
        zip.start_file("package.json", options).unwrap();
        zip.write_all(format!(r#"{{"name":"demo","publisher":"acme","version":"{version}","description":"a ggx"}}"#).as_bytes()).unwrap();
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
    fn a_ggx_installs_lists_and_upgrades_a_vsix_of_the_same_id() {
        let tmp = tempfile::tempdir().unwrap();
        let exts = tmp.path().join("extensions");
        std::fs::create_dir_all(&exts).unwrap();

        let ggx = make_ggx(tmp.path(), "1.0.0", true, GGX_FORMAT);
        let info = install_from_ggx_into(&exts, &ggx, true).unwrap();
        assert_eq!((info.id.as_str(), info.version.as_str(), info.format.as_str(), info.builtin), ("acme.demo", "1.0.0", "ggx", true));
        assert_eq!(info.ggx.as_ref().unwrap().frontend.as_ref().unwrap().page, "web/view.html");
        assert!(exts.join("acme.demo-1.0.0").join("web").join("view.html").is_file());
        assert!(exts.join("acme.demo-1.0.0").join("data").join("payload.bin").is_file());

        // Installing the same package again is refused; a newer one replaces it.
        assert!(install_from_ggx_into(&exts, &ggx, false).unwrap_err().contains("already installed"));
        let newer = make_ggx(tmp.path(), "1.1.0", false, GGX_FORMAT);
        let info = install_from_ggx_into(&exts, &newer, false).unwrap();
        assert_eq!(info.version, "1.1.0");
        assert_eq!(list_installed(&exts).unwrap().len(), 1);
        assert!(install_from_ggx_into(&exts, &ggx, false).unwrap_err().contains("is older"));
    }

    #[test]
    fn a_ggx_with_the_wrong_format_or_mismatched_ids_is_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let exts = tmp.path().join("extensions");
        std::fs::create_dir_all(&exts).unwrap();
        let bad = make_ggx(tmp.path(), "1.0.0", false, "ggx/9");
        assert!(install_from_ggx_into(&exts, &bad, false).unwrap_err().contains("unsupported package format"));

        let ggx = tmp.path().join("mismatch.ggx");
        let file = std::fs::File::create(&ggx).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default();
        zip.start_file("manifest.json", options).unwrap();
        zip.write_all(br#"{"format":"ggx/1","id":"acme.other","version":"1.0.0"}"#).unwrap();
        zip.start_file("package.json", options).unwrap();
        zip.write_all(br#"{"name":"demo","publisher":"acme","version":"1.0.0"}"#).unwrap();
        zip.finish().unwrap();
        assert!(install_from_ggx_into(&exts, &ggx, false).unwrap_err().contains("names acme.other"));

        // A plain zip is not a package.
        let plain = tmp.path().join("plain.ggx");
        let file = std::fs::File::create(&plain).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        zip.start_file("readme.txt", options).unwrap();
        zip.write_all(b"hi").unwrap();
        zip.finish().unwrap();
        assert!(install_from_ggx_into(&exts, &plain, false).unwrap_err().contains("not a .ggx"));
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
        assert_eq!((builtin.id.as_str(), builtin.builtin, builtin.format.as_str()), (GRAPH_PACKAGE_ID, true, "builtin"));
        assert_eq!(builtin.version, crate::cmd_graph::engine_version());
        assert!(!builtin.name.is_empty() && !builtin.publisher.is_empty());

        // An installed copy of the integrated extension (left by an earlier app version) is
        // hidden behind the built-in entry.
        let tmp = tempfile::tempdir().unwrap();
        let exts = tmp.path().join("extensions");
        std::fs::create_dir_all(exts.join("someone.else-1.0.0")).unwrap();
        let stray = exts.join(format!("{GRAPH_PACKAGE_ID}-9.9.9"));
        std::fs::create_dir_all(&stray).unwrap();
        let mut other_manifest = std::fs::File::create(exts.join("someone.else-1.0.0").join("package.json")).unwrap();
        write!(other_manifest, r#"{{"name":"else","publisher":"someone","version":"1.0.0"}}"#).unwrap();
        let mut stray_manifest = std::fs::File::create(stray.join("package.json")).unwrap();
        write!(stray_manifest, r#"{{"name":"git-graph-rs","publisher":"neophack","version":"9.9.9"}}"#).unwrap();
        let list = with_builtin(list_installed(&exts).unwrap());
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].id, GRAPH_PACKAGE_ID);
        assert_eq!(list[1].id, "someone.else");
    }

    #[test]
    fn installing_a_package_of_the_integrated_extension_is_refused() {
        let tmp = tempfile::tempdir().unwrap();
        let exts = tmp.path().join("extensions");
        std::fs::create_dir_all(&exts).unwrap();
        let ggx = tmp.path().join("integrated.ggx");
        let file = std::fs::File::create(&ggx).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default();
        zip.start_file("manifest.json", options).unwrap();
        zip.write_all(format!(r#"{{"format":"ggx/1","id":"{GRAPH_PACKAGE_ID}","version":"99.0.0"}}"#).as_bytes()).unwrap();
        zip.start_file("package.json", options).unwrap();
        zip.write_all(br#"{"name":"git-graph-rs","publisher":"neophack","version":"99.0.0","main":"out/extension.js"}"#).unwrap();
        zip.finish().unwrap();
        let error = install_from_ggx_into(&exts, &ggx, false).unwrap_err();
        assert!(error.contains("built into Git Graph Studio"), "{error}");
        assert_eq!(list_installed(&exts).unwrap().len(), 0);
    }
}
