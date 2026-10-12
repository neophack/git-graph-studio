//! The daemon's directory, `~/.ggs/remote/` (docs/ggs-remote-plan.md §7.2), and the local
//! control endpoint's name. `GGS_REMOTE_HOME` relocates the whole tree (tests, a second
//! hermetic daemon); `GGS_HOME` relocates `~/.ggs` the way the app's own probes do.

use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub struct Paths {
    pub root: PathBuf,
    /// `~/.ggs` — the app's user-data root, read for `settings.json`'s display language.
    pub ggs_home: PathBuf,
}

impl Paths {
    pub fn resolve() -> std::io::Result<Paths> {
        let ggs_home = match std::env::var_os("GGS_HOME") {
            Some(home) => PathBuf::from(home),
            None => home_dir()
                .ok_or_else(|| std::io::Error::other("no home directory"))?
                .join(".ggs"),
        };
        let root = match std::env::var_os("GGS_REMOTE_HOME") {
            Some(root) => PathBuf::from(root),
            None => ggs_home.join("remote"),
        };
        Ok(Paths::at(root, ggs_home))
    }

    pub fn at(root: PathBuf, ggs_home: PathBuf) -> Paths {
        Paths { root, ggs_home }
    }

    pub fn ensure(&self) -> std::io::Result<()> {
        for dir in [
            self.root.clone(),
            self.root.join("tls"),
            self.cache_dir(),
            self.root.join("bin"),
            self.hub_dir(),
        ] {
            std::fs::create_dir_all(&dir)?;
            restrict_dir(&dir);
        }
        Ok(())
    }

    pub fn config(&self) -> PathBuf {
        self.root.join("config.json")
    }
    pub fn auth(&self) -> PathBuf {
        self.root.join("auth.json")
    }
    pub fn sessions(&self) -> PathBuf {
        self.root.join("sessions.json")
    }
    /// The recently opened folders (the picker's "recent paths" list).
    pub fn recent(&self) -> PathBuf {
        self.root.join("recent.json")
    }
    pub fn admin_token(&self) -> PathBuf {
        self.root.join("admin.token")
    }
    pub fn loopback(&self) -> PathBuf {
        self.root.join("loopback.json")
    }
    pub fn lock(&self) -> PathBuf {
        self.root.join("daemon.lock")
    }
    pub fn tls_dir(&self) -> PathBuf {
        self.root.join("tls")
    }
    /// The Hub client's corner (§20.2): `hub.json` names the server, `device.key` is this
    /// PC's identity — the key its link's UUID derives from.
    pub fn hub_dir(&self) -> PathBuf {
        self.root.join("hub")
    }
    pub fn hub_config(&self) -> PathBuf {
        self.hub_dir().join("hub.json")
    }
    pub fn hub_device_key(&self) -> PathBuf {
        self.hub_dir().join("device.key")
    }
    pub fn cache_dir(&self) -> PathBuf {
        self.root.join("cache")
    }
    pub fn log(&self) -> PathBuf {
        self.ggs_home.join("logs").join("remote.log")
    }
    pub fn settings(&self) -> PathBuf {
        self.ggs_home.join("settings.json")
    }

    /// The app's display language as `~/.ggs/settings.json` spells it — `locale` (the key
    /// `settings_write` persists), `displayLanguage` accepted as the older spelling:
    /// `Some("zh-cn")` / `Some("en")`, `None` when the file or the key is absent. The tray
    /// labels and the daemon pages' language both follow it (2026-10-12, the owner's
    /// direction for the pages), falling back to the browser's language.
    pub fn display_language(&self) -> Option<String> {
        let bytes = std::fs::read(self.settings()).ok()?;
        let value = serde_json::from_slice::<serde_json::Value>(&bytes).ok()?;
        let lang = value
            .get("locale")
            .or_else(|| value.get("displayLanguage"))?
            .as_str()?;
        Some(if lang.eq_ignore_ascii_case("zh-cn") {
            "zh-cn".into()
        } else {
            "en".into()
        })
    }
    pub fn secret(&self) -> PathBuf {
        self.root.join("server.secret")
    }

    /// The control endpoint (§7.2): a socket file under the root on Unix; on Windows a named
    /// pipe whose name is derived from the user name, so two OS users never share one. The
    /// app derives the same name (`remote_host.rs`), which is the whole contract.
    pub fn control_endpoint(&self) -> String {
        control_endpoint_name(&self.root)
    }
}

/// The control endpoint for a given remote root: sha256(user name ‖ 0 ‖ root path), first 6
/// bytes in hex. A relocated root (tests, `GGS_REMOTE_HOME`) gets its own pipe name, so a
/// hermetic daemon never collides with the user's real one.
pub fn control_endpoint_name(root: &Path) -> String {
    #[cfg(windows)]
    {
        use sha2::{Digest, Sha256};
        let user = std::env::var("USERNAME").unwrap_or_default();
        let mut hasher = Sha256::new();
        hasher.update(user.as_bytes());
        hasher.update([0u8]);
        hasher.update(root.to_string_lossy().as_bytes());
        let digest = hasher.finalize();
        let hex: String = digest.iter().take(6).map(|b| format!("{b:02x}")).collect();
        format!("ggsr1-control-{hex}")
    }
    #[cfg(not(windows))]
    {
        root.join("control.sock").to_string_lossy().into_owned()
    }
}

pub fn home_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    let var = "USERPROFILE";
    #[cfg(not(windows))]
    let var = "HOME";
    std::env::var_os(var)
        .map(PathBuf::from)
        .filter(|p| !p.as_os_str().is_empty())
}

/// 0700 on Unix. On Windows the directory sits under `%USERPROFILE%`, readable only by the
/// user and administrators by default (§7.2 states why no ACL is written).
pub fn restrict_dir(_dir: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(_dir, std::fs::Permissions::from_mode(0o700));
    }
}

/// Write a private file atomically (temp sibling + rename) at 0600.
pub fn write_private(path: &Path, contents: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let tmp = path.with_file_name(format!(".{name}.{}.tmp", std::process::id()));
    std::fs::write(&tmp, contents)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))?;
    }
    std::fs::rename(&tmp, path)
}
