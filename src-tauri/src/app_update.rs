//! The app's own update channel (2026-11-10, the owner's direction: 软件本身可以 github
//! 下载): Help → Check for App Updates reads THIS application's repository's newest
//! release, and a newer one downloads the installer for THIS platform through the same
//! streaming progress (bytes, the recent speed, the remaining time) and the same
//! download mirror setting the marketplace's GitHub channel rides. Windows launches the
//! NSIS installer and exits so it can replace the running exe; macOS and Linux mount or
//! reveal the downloaded package — their installers keep their own manual step.
//!
//! The GitHub halves are the extension crate's gallery engine ([`ggs_ext::gallery`]):
//! the release fetch, the asset pick's platform rules, the mirror rewrite and the
//! origin-confined streaming download — the app update names its own repository (the
//! same one `help.repository` opens), nothing of any plugin.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde::Serialize;
use tauri::ipc::Channel;

use ggs_ext::gallery::{
    download_to_temp, github_download_url, github_mirror, github_release_raw, version_of_tag,
    GithubAsset, GalleryProgress, GITHUB_API,
};

/// The repository this application updates from — the one `help.repository` opens.
const APP_REPO: &str = "neophack/git-graph-studio";

/// The in-flight app-download's cancel flag — its own flag, not the marketplace's: a
/// plugin install and an app download may run at once, and one must not cancel the other.
#[derive(Clone, Default)]
pub struct AppUpdateState {
    cancelled: Arc<AtomicBool>,
}

/// One available update, as the Help command's dialog and download render it.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdate {
    /// The running app's version.
    pub current: String,
    /// The release's version (the tag's `v` stripped).
    pub version: String,
    /// The release title, when it carries one.
    pub release_name: Option<String>,
    pub published_at: String,
    /// The installer asset for THIS platform.
    pub download_url: String,
    /// The asset's file name.
    pub file_name: String,
}

/// The installer asset of THIS machine's platform, in Tauri's own bundle spellings:
/// NSIS `x64-setup.exe` / `arm64-setup.exe`, DMG `aarch64.dmg` / `x64.dmg`, and on
/// Linux the deb first (`_amd64.deb` / `_arm64.deb`) — the family the app's own
/// `bundle.targets` ships. A platform the release has no package for is the named
/// failure at the door.
fn pick_installer_asset(assets: &[GithubAsset]) -> Option<&GithubAsset> {
    use std::env::consts::{ARCH, OS};
    let wanted: &[&str] = match (OS, ARCH) {
        ("windows", "x86_64") => &["x64-setup.exe"],
        ("windows", "aarch64") => &["arm64-setup.exe"],
        ("macos", "aarch64") => &["aarch64.dmg"],
        ("macos", "x86_64") => &["x64.dmg"],
        ("linux", "x86_64") => &["_amd64.deb"],
        ("linux", "aarch64") => &["_arm64.deb"],
        _ => &[],
    };
    assets
        .iter()
        .find(|asset| wanted.iter().any(|marker| asset.name.contains(marker)))
}

/// Numeric x.y.z comparison (the install rule the store and the view share): anything
/// unparseable sorts below.
fn compare_versions(a: &str, b: &str) -> std::cmp::Ordering {
    let tuple = |v: &str| -> Vec<u64> {
        v.split(['-', '+'])
            .next()
            .unwrap_or("")
            .split('.')
            .map(|part| part.parse::<u64>().unwrap_or(0))
            .collect()
    };
    let (left, right) = (tuple(a), tuple(b));
    for at in 0..left.len().max(right.len()) {
        let (l, r) = (left.get(at).copied().unwrap_or(0), right.get(at).copied().unwrap_or(0));
        if l != r {
            return l.cmp(&r);
        }
    }
    std::cmp::Ordering::Equal
}

/// The repository's newest release as an update offer — `None` when this running
/// version is the newest (or the tag reads as no version at all: nothing to offer).
#[tauri::command]
pub async fn app_update_check(
    app: tauri::AppHandle,
) -> Result<Option<AppUpdate>, String> {
    let current = app.package_info().version.to_string();
    tauri::async_runtime::spawn_blocking(move || -> Result<Option<AppUpdate>, String> {
        let release = github_release_raw(GITHUB_API, APP_REPO)?;
        let Some(version) = version_of_tag(&release.tag_name) else {
            return Ok(None);
        };
        if compare_versions(&version, &current) != std::cmp::Ordering::Greater {
            return Ok(None);
        }
        let asset = pick_installer_asset(&release.assets).ok_or_else(|| {
            format!(
                "{} carries no package for this platform ({})",
                release.tag_name,
                std::env::consts::OS
            )
        })?;
        Ok(Some(AppUpdate {
            current,
            version,
            release_name: release.name.filter(|name| !name.is_empty()),
            published_at: release.published_at,
            download_url: asset.browser_download_url.clone(),
            file_name: asset.name.clone(),
        }))
    })
    .await
    .map_err(|e| format!("the update check was cancelled: {e}"))?
}

/// Download the update's installer through the streaming progress ticks (the same
/// [`GalleryProgress`] shape and ceilings the marketplace downloads ride), then hand it
/// to the platform: Windows launches the NSIS installer detached and exits the app so
/// the update replaces the running exe (a dev run keeps running and reveals the file),
/// macOS and Linux mount or reveal the package for their own manual step. The outcome
/// names which tail ran, so the toast's last word is the truth.
#[tauri::command]
pub async fn app_update_install(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppUpdateState>,
    download_url: String,
    mirror: Option<String>,
    on_progress: Channel<GalleryProgress>,
) -> Result<UpdateInstallOutcome, String> {
    let mirror = github_mirror(mirror)?;
    state.cancelled.store(false, Ordering::Relaxed);
    let cancelled = Arc::clone(&state.cancelled);
    let path = tauri::async_runtime::spawn_blocking(move || -> Result<std::path::PathBuf, String> {
        let url = github_download_url(mirror.as_deref(), &download_url)?;
        let name = download_url
            .rsplit('/')
            .next()
            .filter(|stem| !stem.is_empty())
            .unwrap_or("installer")
            .to_owned();
        download_to_temp(&url, &name, &mut |tick| {
            if cancelled.load(Ordering::Relaxed) {
                return false;
            }
            on_progress.send(tick).is_ok()
        })
    })
    .await
    .map_err(|e| format!("the download was cancelled: {e}"))??;
    finish_update(&app, &path)
}

/// The install toast's Cancel: the in-flight app download stops at its next progress
/// report and its half-written package is removed. Nothing else touches the flag.
#[tauri::command]
pub fn app_update_install_cancel(state: tauri::State<'_, AppUpdateState>) {
    state.cancelled.store(true, Ordering::Relaxed);
}

/// What the platform tail did with the downloaded installer.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInstallOutcome {
    /// Windows (packaged): the installer launched and the app is exiting. Elsewhere:
    /// the package was mounted (macOS) or its folder revealed — the manual step remains.
    pub launched: bool,
    /// The downloaded installer's full path.
    pub path: String,
}

/// The downloaded installer's platform tail (see [`app_update_install`]).
fn finish_update(app: &tauri::AppHandle, path: &std::path::Path) -> Result<UpdateInstallOutcome, String> {
    let shown = path.to_string_lossy().into_owned();
    // Windows, packaged: launch the NSIS installer detached and step the app out of its
    // way — the update replaces the running exe. A dev run keeps running.
    #[cfg(windows)]
    if !cfg!(debug_assertions) {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        std::process::Command::new(path)
            .creation_flags(DETACHED_PROCESS)
            .spawn()
            .map_err(|e| format!("launch the installer: {e}"))?;
        app.exit(0);
        return Ok(UpdateInstallOutcome { launched: true, path: shown });
    }
    // Windows, dev: nothing to install over — the file shows in Explorer instead.
    #[cfg(windows)]
    if cfg!(debug_assertions) {
        let _ = std::process::Command::new("explorer").arg(format!("/select,{shown}")).spawn();
        return Ok(UpdateInstallOutcome { launched: false, path: shown });
    }
    // macOS mounts the .dmg, Linux hands the .deb/.rpm to its package installer.
    let opener = if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
    let _ = std::process::Command::new(opener).arg(path).spawn();
    Ok(UpdateInstallOutcome { launched: false, path: shown })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn asset(name: &str) -> GithubAsset {
        GithubAsset {
            name: name.to_owned(),
            browser_download_url: format!("https://github.com/neophack/git-graph-studio/releases/download/v0.2.0/{name}"),
        }
    }

    /// The platform pick answers one of Tauri's own bundle spellings and never an
    /// other-platform build's.
    #[test]
    fn the_installer_pick_matches_this_platform() {
        use std::env::consts::{ARCH, OS};
        let assets = [
            asset("bundled-extension.vsix"),
            asset("Git Graph Studio_0.2.0_x64-setup.exe"),
            asset("Git Graph Studio_0.2.0_arm64-setup.exe"),
            asset("Git Graph Studio_0.2.0_aarch64.dmg"),
            asset("Git Graph Studio_0.2.0_x64.dmg"),
            asset("ggs_0.2.0_amd64.deb"),
            asset("ggs_0.2.0_arm64.deb"),
            asset("ggs_0.2.0_x86_64.rpm"),
        ];
        let picked = pick_installer_asset(&assets).expect("this platform ships in the list");
        let ok = match (OS, ARCH) {
            ("windows", "x86_64") => picked.name.contains("x64-setup.exe"),
            ("windows", "aarch64") => picked.name.contains("arm64-setup.exe"),
            ("macos", "aarch64") => picked.name.contains("aarch64.dmg"),
            ("macos", "x86_64") => picked.name.contains("x64.dmg"),
            ("linux", "x86_64") => picked.name.contains("_amd64.deb"),
            ("linux", "aarch64") => picked.name.contains("_arm64.deb"),
            _ => false,
        };
        assert!(ok, "{} is not this platform's installer ({OS} {ARCH})", picked.name);
    }

    #[test]
    fn a_platform_the_release_lacks_is_no_pick() {
        let mac_only = [asset("Git Graph Studio_0.2.0_aarch64.dmg")];
        // Only asserting on the platforms this machine is NOT: the pick must refuse them.
        if !(cfg!(target_os = "macos")) {
            assert!(pick_installer_asset(&mac_only).is_none());
        }
        let empty: [GithubAsset; 0] = [];
        assert!(pick_installer_asset(&empty).is_none());
    }

    /// The version gate: strictly newer offers, the same or older does not.
    #[test]
    fn only_a_newer_release_is_an_update() {
        assert_eq!(compare_versions("0.2.0", "0.1.16"), std::cmp::Ordering::Greater);
        assert_eq!(compare_versions("0.1.16", "0.1.16"), std::cmp::Ordering::Equal);
        assert_eq!(compare_versions("0.1.15", "0.1.16"), std::cmp::Ordering::Less);
        assert_eq!(compare_versions("1.0.0", "0.9.9"), std::cmp::Ordering::Greater);
        // Unparseable sorts below: a weird tag never downgrades the gate into offering.
        assert_eq!(compare_versions("", "0.1.16"), std::cmp::Ordering::Less);
        assert_eq!(compare_versions("0.1.16-beta.1", "0.1.16"), std::cmp::Ordering::Equal);
    }

    #[test]
    fn the_version_gate_reads_the_tag_through_version_of_tag() {
        assert_eq!(version_of_tag("v0.2.0").as_deref(), Some("0.2.0"));
    }
}
