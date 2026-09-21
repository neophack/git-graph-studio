//! The File Associations service (Command System / settings): registers GGS as an
//! "open with" application for the file extensions the user picked in Settings, per
//! platform. Windows writes HKCU ProgIds plus the RegisteredApplications capability
//! entry (Win10/11's signed UserChoice means a third-party app cannot silently force
//! the *default* - it registers into the "Open with" list and Default Apps, where one
//! confirmation makes it the default). Linux maps each extension to a custom MIME
//! type and writes the desktop entry, the MIME package and `mimeapps.list`. macOS
//! offers no runtime registration - associations are declared at bundle time
//! (`bundle.fileAssociations`) and chosen in Finder.
//!
//! The same file owns the Explorer context-menu entry (`context_menu_apply`): the
//! "Open with Git Graph Studio" verb Zed's Windows 10 install writes - static shell
//! verbs under HKCU, no admin rights, no shell-extension DLL.

use serde::Serialize;

/// One entry of the extension catalogue the Settings dialog shows: the extension
/// without the dot, the MIME type Linux registers for it, and whether it is checked
/// by default (the formats GGS is built around: the CAN traces, `.ggx`, the viewers).
#[derive(Serialize)]
pub struct AssocExt {
    pub ext: String,
    pub mime: String,
    pub recommended: bool,
}

/// The catalogue, shared by every platform; `mime` only matters on Linux.
const CATALOG: &[(&str, &str, bool)] = &[
    ("blf", "application/x-vector-blf", true),
    ("asc", "application/x-vector-asc", true),
    ("ggx", "application/x-ggs-extension", true),
    ("bin", "application/octet-stream", true),
    ("hex", "application/x-hex", true),
    ("log", "text/plain", false),
    ("md", "text/markdown", false),
    ("json", "application/json", false),
    ("xml", "application/xml", false),
    ("yaml", "application/yaml", false),
    ("yml", "application/yaml", false),
    ("toml", "application/toml", false),
    ("ini", "text/plain", false),
    ("cfg", "text/plain", false),
    ("csv", "text/csv", false),
    ("txt", "text/plain", false),
    ("diff", "text/x-diff", false),
    ("patch", "text/x-diff", false),
    ("c", "text/x-c", false),
    ("h", "text/x-c", false),
    ("cpp", "text/x-c++", false),
    ("hpp", "text/x-c++", false),
    ("rs", "text/x-rust", false),
    ("ts", "text/typescript", false),
    ("js", "text/javascript", false),
    ("py", "text/x-python", false),
];

/// The extension catalogue the Settings dialog renders; `recommended` entries are
/// checked by default.
#[tauri::command]
pub fn assoc_list_defaults() -> Vec<AssocExt> {
    CATALOG
        .iter()
        .map(|(ext, mime, recommended)| AssocExt {
            ext: (*ext).to_string(),
            mime: (*mime).to_string(),
            recommended: *recommended,
        })
        .collect()
}

/// What `assoc_apply` reports back: a message key the frontend resolves with `t()`
/// plus a platform detail line.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssocResult {
    pub message_key: String,
    pub detail: String,
}

/// Make the given extensions (no leading dot) the ones GGS is registered to open, and
/// unregister any catalogue extension that is not in the list. Idempotent.
#[tauri::command]
pub fn assoc_apply(extensions: Vec<String>) -> Result<AssocResult, String> {
    // Only catalogue extensions, normalised: the settings file is hand-editable, so a
    // stray entry must not reach the platform registration.
    let selected: Vec<String> = extensions
        .into_iter()
        .map(|e| e.trim().trim_start_matches('.').to_ascii_lowercase())
        .filter(|e| CATALOG.iter().any(|(c, _, _)| c == e))
        .collect();
    #[cfg(target_os = "windows")]
    return windows_impl::apply(&selected).map(|()| AssocResult {
        message_key: "assoc.applied.windows".into(),
        detail: String::new(),
    });
    #[cfg(target_os = "linux")]
    return apply_linux(&selected).map(|detail| AssocResult {
        message_key: "assoc.applied.linux".into(),
        detail,
    });
    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    {
        let _ = selected;
        Ok(AssocResult {
            message_key: "assoc.applied.macos".into(),
            detail: String::new(),
        })
    }
}

/// Add or remove the Explorer's "Open with Git Graph Studio" right-click entry. Windows
/// only - Zed's static shell verb under the per-user HKCU classes (no admin rights, no
/// shell-extension DLL; Windows 11 lists it under "Show more options", exactly like VS
/// Code's entry). The label is the localized title the menu should show, resolved by the
/// caller; the other platforms report an explanatory no-op. Idempotent, and re-applied
/// at every boot by the frontend, so the verb always names the executable's current path.
#[tauri::command]
pub fn context_menu_apply(on: bool, label: String) -> Result<AssocResult, String> {
    #[cfg(target_os = "windows")]
    {
        let hkcu = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER);
        let classes = windows_impl::create_key(&hkcu, "Software\\Classes", "")?;
        windows_impl::apply_context_menu(&classes, on, &label)?;
        Ok(AssocResult {
            message_key: if on {
                "contextmenu.applied.on".into()
            } else {
                "contextmenu.applied.off".into()
            },
            detail: String::new(),
        })
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (on, label);
        Ok(AssocResult {
            message_key: "contextmenu.applied.unsupported".into(),
            detail: String::new(),
        })
    }
}

/* ---------- Windows: HKCU ProgIds + RegisteredApplications ---------- */

#[cfg(target_os = "windows")]
mod windows_impl {
    use super::CATALOG;
    use winreg::enums::{HKEY_CURRENT_USER, KEY_SET_VALUE};
    use winreg::RegKey;

    const PROGID_PREFIX: &str = "GGS.";
    const APP_NAME: &str = "Git Graph Studio";
    const CAPABILITIES_PATH: &str = "Software\\Git Graph Studio\\Capabilities";

    fn progid(ext: &str) -> String {
        format!("{PROGID_PREFIX}{ext}.1")
    }

    /// The Explorer context-menu verb's key name under `<target>\shell`: a fixed id (the
    /// display title is the key's default value, so re-applying with a new language
    /// re-titles it), ours alone to create and delete.
    pub const CONTEXT_VERB: &str = "GitGraphStudio";
    /// The targets the verb is registered for, each with the placeholder its command
    /// receives: `%1` on `*` (the clicked file), `%V` on the folder targets (a background
    /// click has no `%1` at all - `%V` is the folder the user right-clicked inside).
    pub const CONTEXT_TARGETS: &[(&str, &str)] = &[
        ("*", "%1"),
        ("Directory", "%V"),
        ("Directory\\Background", "%V"),
        ("Drive", "%V"),
    ];

    /// Register (`on`) or remove the context-menu verbs under `classes` (the real HKCU
    /// `Software\Classes`, or a test key). Removal deletes only the verb's own subtree -
    /// `<target>\shell` is shared with every other application's verbs and stays.
    pub fn apply_context_menu(classes: &RegKey, on: bool, label: &str) -> Result<(), String> {
        for (target, argument) in CONTEXT_TARGETS {
            let verb = format!("{target}\\shell\\{CONTEXT_VERB}");
            if on {
                let exe = std::env::current_exe()
                    .map_err(|e| e.to_string())?
                    .to_string_lossy()
                    .into_owned();
                create_key(classes, &verb, label)?;
                let icon = create_key(classes, &format!("{verb}\\Icon"), "")?;
                icon.set_value("", &exe)
                    .map_err(|e| format!("registry Icon {verb}: {e}"))?;
                let command = create_key(classes, &format!("{verb}\\command"), "")?;
                command
                    .set_value("", &format!("\"{exe}\" \"{argument}\""))
                    .map_err(|e| format!("registry command {verb}: {e}"))?;
            } else {
                let _ = classes.delete_subkey_all(&verb);
            }
        }
        Ok(())
    }

    pub fn create_key(parent: &RegKey, path: &str, default: &str) -> Result<RegKey, String> {
        let (key, _) = parent
            .create_subkey(path)
            .map_err(|e| format!("registry create {path}: {e}"))?;
        if !default.is_empty() {
            key.set_value("", &default)
                .map_err(|e| format!("registry default {path}: {e}"))?;
        }
        Ok(key)
    }

    /// Register (`on`) or remove one extension's ProgId and its `OpenWithProgids` entry.
    /// Unregistering only deletes *our* value from `.{ext}` - other applications'
    /// entries there are theirs; the key itself goes only when empty.
    pub fn apply_extension(classes: &RegKey, ext: &str, on: bool) -> Result<(), String> {
        let id = progid(ext);
        if on {
            let exe = std::env::current_exe()
                .map_err(|e| e.to_string())?
                .to_string_lossy()
                .into_owned();
            let progid_key = create_key(classes, &id, &format!("{APP_NAME} {ext} file"))?;
            progid_key
                .set_value("", &format!("{APP_NAME} {ext} file"))
                .map_err(|e| format!("registry default {id}: {e}"))?;
            let icon = create_key(classes, &format!("{id}\\DefaultIcon"), "")?;
            icon.set_value("", &exe)
                .map_err(|e| format!("registry DefaultIcon: {e}"))?;
            let command = create_key(classes, &format!("{id}\\shell\\open\\command"), "")?;
            command
                .set_value("", &format!("\"{exe}\" \"%1\""))
                .map_err(|e| format!("registry command: {e}"))?;
            let ext_key = classes
                .open_subkey_with_flags(format!(".{ext}"), KEY_SET_VALUE)
                .or_else(|_| classes.create_subkey(format!(".{ext}")).map(|(k, _)| k))
                .map_err(|e| format!("registry .{ext}: {e}"))?;
            ext_key
                .set_value(&id, &"")
                .map_err(|e| format!("registry OpenWithProgids: {e}"))?;
        } else {
            if let Ok(ext_key) = classes.open_subkey_with_flags(format!(".{ext}"), KEY_SET_VALUE) {
                let _ = ext_key.delete_value(&id);
                // ERROR_KEY_REFERENCED_MISSING etc. are fine; an empty key leaves quietly.
                let _ = classes.delete_subkey(format!(".{ext}"));
            }
            for sub in [
                "shell\\open\\command",
                "shell\\open",
                "shell",
                "DefaultIcon",
            ] {
                let _ = classes.delete_subkey(format!("{id}\\{sub}"));
            }
            let _ = classes.delete_subkey(&id);
        }
        Ok(())
    }

    /// The full registration against the real HKCU: per-extension ProgIds plus the
    /// RegisteredApplications capability entry (Default Apps lists exactly the
    /// selection, so unchecking an extension also withdraws it there).
    pub fn apply(selected: &[String]) -> Result<(), String> {
        let hkcu = &RegKey::predef(HKEY_CURRENT_USER);
        let classes = create_key(hkcu, "Software\\Classes", "")?;
        for (ext, _, _) in CATALOG {
            apply_extension(&classes, ext, selected.iter().any(|s| s == ext))?;
        }
        let capabilities = create_key(hkcu, CAPABILITIES_PATH, "")?;
        capabilities
            .set_value("ApplicationName", &APP_NAME)
            .map_err(|e| format!("registry ApplicationName: {e}"))?;
        capabilities
            .set_value(
                "ApplicationDescription",
                &"Git Graph Studio - repositories, editors, viewers and the CAN Trace Analyzer",
            )
            .map_err(|e| format!("registry ApplicationDescription: {e}"))?;
        let file_assocs = create_key(&capabilities, "FileAssociations", "")?;
        // The previous selection's entries go first - a re-apply with fewer extensions
        // must not leave a stale capability pointing at a removed ProgId.
        for (name, _) in file_assocs.enum_values().flatten() {
            let _ = file_assocs.delete_value(name);
        }
        for ext in selected {
            file_assocs
                .set_value(format!(".{ext}"), &progid(ext))
                .map_err(|e| format!("registry FileAssociations: {e}"))?;
        }
        let registered = create_key(hkcu, "Software\\RegisteredApplications", "")?;
        registered
            .set_value(APP_NAME, &CAPABILITIES_PATH)
            .map_err(|e| format!("registry RegisteredApplications: {e}"))?;
        Ok(())
    }
}

/* ---------- Linux: desktop entry, MIME package, mimeapps.list ---------- */

#[cfg(target_os = "linux")]
mod linux_impl {
    use std::path::Path;

    /// Rewrite `mimeapps.list`'s `[Default Applications]` so it contains exactly the
    /// selected GGS MIME types (unchecking an extension must remove its default, not
    /// just stop mentioning it).
    fn set_mime_defaults(
        config: &Path,
        selected: &[String],
        desktop_id: &str,
    ) -> Result<(), String> {
        let list = config.join("mimeapps.list");
        let existing = std::fs::read_to_string(&list).unwrap_or_default();
        let mut lines: Vec<String> = Vec::new();
        let mut in_defaults = false;
        let mut seen_defaults = false;
        for line in existing.lines() {
            if line.starts_with('[') {
                if in_defaults {
                    for ext in selected {
                        lines.push(format!("application/x-ggs-{ext}={desktop_id}"));
                    }
                }
                in_defaults = line == "[Default Applications]";
                if in_defaults {
                    seen_defaults = true;
                }
                lines.push(line.to_string());
            } else if !in_defaults || !line.starts_with("application/x-ggs-") {
                lines.push(line.to_string());
            }
        }
        if !seen_defaults {
            lines.push("[Default Applications]".into());
            for ext in selected {
                lines.push(format!("application/x-ggs-{ext}={desktop_id}"));
            }
        }
        std::fs::write(&list, lines.join("\n") + "\n").map_err(|e| format!("mimeapps.list: {e}"))
    }

    /// The whole Linux registration under `data`/`config` (XDG data / config dirs;
    /// the tests pass temp dirs): the `ggs.desktop` entry, the MIME package mapping
    /// every catalogued extension, and the per-user defaults.
    pub fn apply(selected: &[String], data: &Path, config: &Path) -> Result<String, String> {
        let apps = data.join("applications");
        let mime_packages = data.join("mime/packages");
        for dir in [apps.as_path(), mime_packages.as_path(), config] {
            std::fs::create_dir_all(dir).map_err(|e| format!("mkdir {}: {e}", dir.display()))?;
        }

        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let mimetypes: Vec<String> = selected
            .iter()
            .map(|e| format!("application/x-ggs-{e}"))
            .collect();
        let desktop = format!(
			"[Desktop Entry]\nType=Application\nName=Git Graph Studio\nExec={} %f\nTerminal=false\nNoDisplay=true\nMimeType={}\n",
			exe.to_string_lossy(),
			mimetypes.join(";")
		);
        std::fs::write(apps.join("ggs.desktop"), desktop)
            .map_err(|e| format!("ggs.desktop: {e}"))?;

        // Every catalogued extension gets a MIME type and a glob; unselected ones
        // simply have no default entry in mimeapps.list.
        let mut package = String::from("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<mime-info xmlns=\"http://www.freedesktop.org/standards/shared-mime-info\">\n");
        for (ext, _, _) in super::CATALOG {
            package.push_str(&format!("\t<mime-type type=\"application/x-ggs-{ext}\">\n\t\t<comment>Git Graph Studio {ext} file</comment>\n\t\t<glob pattern=\"*.{ext}\"/>\n\t</mime-type>\n"));
        }
        package.push_str("</mime-info>\n");
        std::fs::write(mime_packages.join("ggs.xml"), package)
            .map_err(|e| format!("ggs.xml: {e}"))?;

        set_mime_defaults(config, selected, "ggs.desktop")?;

        // Refresh the caches when the tools exist; a missing one is not an error.
        let _ = std::process::Command::new("update-mime-database")
            .arg(mime_packages.parent().unwrap())
            .status();
        let _ = std::process::Command::new("update-desktop-database")
            .arg(&apps)
            .status();
        Ok(format!("{} extension(s)", selected.len()))
    }
}

#[cfg(target_os = "linux")]
fn apply_linux(selected: &[String]) -> Result<String, String> {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    let data = std::env::var("XDG_DATA_HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| std::path::Path::new(&home).join(".local/share"));
    let config = std::env::var("XDG_CONFIG_HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| std::path::Path::new(&home).join(".config"));
    linux_impl::apply(selected, &data, &config)
}

/* ---------- Tests: a HKCU test key (Windows) and scratch dirs (Linux) ---------- */

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalogue_marks_the_recommended_extensions() {
        let catalog = assoc_list_defaults();
        let recommended: Vec<&str> = catalog
            .iter()
            .filter(|e| e.recommended)
            .map(|e| e.ext.as_str())
            .collect();
        assert_eq!(recommended, ["blf", "asc", "ggx", "bin", "hex"]);
        assert!(catalog.iter().any(|e| e.ext == "json" && !e.recommended));
    }

    #[test]
    fn apply_filters_out_unknown_extensions() {
        // The platform-specific halves are not exercised here (they touch the real
        // user configuration); this covers the normalisation the halves rely on.
        let raw = [" .BLF", "nope", "asc", ".ggx"];
        let selected: Vec<String> = raw
            .iter()
            .map(|e| e.trim().trim_start_matches('.').to_ascii_lowercase())
            .filter(|e| CATALOG.iter().any(|(c, _, _)| c == e))
            .collect();
        assert_eq!(selected, ["blf", "asc", "ggx"]);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_registration_writes_and_removes_progid() {
        use winreg::enums::HKEY_CURRENT_USER;
        let base_path = format!("Software\\Classes\\ggs-assoc-test-{}", std::process::id());
        let hkcu = winreg::RegKey::predef(HKEY_CURRENT_USER);
        let (base, _) = hkcu.create_subkey(&base_path).unwrap();
        windows_impl::apply_extension(&base, "blf", true).unwrap();
        assert!(base.open_subkey("GGS.blf.1\\shell\\open\\command").is_ok());
        windows_impl::apply_extension(&base, "blf", false).unwrap();
        assert!(base.open_subkey("GGS.blf.1").is_err());
        hkcu.delete_subkey_all(&base_path).unwrap();
    }

    /// The context-menu verb covers every target Zed's does, with the right placeholder:
    /// `%1` for files, `%V` for folders, folder backgrounds and drive roots. The title is
    /// the verb key's default value; removal takes the whole subtree away again.
    #[cfg(target_os = "windows")]
    #[test]
    fn windows_context_menu_writes_and_removes_the_verbs() {
        use winreg::enums::HKEY_CURRENT_USER;
        let base_path = format!("Software\\Classes\\ggs-assoc-ctxmenu-test-{}", std::process::id());
        let hkcu = winreg::RegKey::predef(HKEY_CURRENT_USER);
        let (base, _) = hkcu.create_subkey(&base_path).unwrap();
        windows_impl::apply_context_menu(&base, true, "Open with Git Graph Studio").unwrap();
        let command = |target: &str| {
            base.open_subkey(format!("{target}\\shell\\GitGraphStudio\\command"))
                .unwrap()
                .get_value::<String, _>("")
                .unwrap()
        };
        assert!(
            command("*").ends_with("\" \"%1\""),
            "files arrive as %1: {}",
            command("*")
        );
        for target in ["Directory", "Directory\\Background", "Drive"] {
            assert!(
                command(target).ends_with("\" \"%V\""),
                "{target} arrives as %V: {}",
                command(target)
            );
        }
        let verb = base.open_subkey("Directory\\shell\\GitGraphStudio").unwrap();
        assert_eq!(
            verb.get_value::<String, _>("").unwrap(),
            "Open with Git Graph Studio"
        );
        windows_impl::apply_context_menu(&base, false, "").unwrap();
        for (target, _) in windows_impl::CONTEXT_TARGETS {
            assert!(
                base.open_subkey(format!("{target}\\shell\\GitGraphStudio"))
                    .is_err(),
                "{target} verb removed"
            );
        }
        hkcu.delete_subkey_all(&base_path).unwrap();
    }

    /// The context menu is a Windows feature; the command answers a no-op elsewhere
    /// instead of failing, so the same toggle works on every platform.
    #[cfg(not(target_os = "windows"))]
    #[test]
    fn context_menu_reports_the_noop_off_windows() {
        let result = context_menu_apply(true, "Open with Git Graph Studio".into()).unwrap();
        assert_eq!(result.message_key, "contextmenu.applied.unsupported");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_registration_writes_all_three_files() {
        let data = tempfile::tempdir().unwrap();
        let config = tempfile::tempdir().unwrap();
        linux_impl::apply(&["blf".into(), "asc".into()], data.path(), config.path()).unwrap();
        let desktop =
            std::fs::read_to_string(data.path().join("applications/ggs.desktop")).unwrap();
        assert!(desktop.contains("application/x-ggs-blf;application/x-ggs-asc"));
        let xml = std::fs::read_to_string(data.path().join("mime/packages/ggs.xml")).unwrap();
        assert!(xml.contains("<glob pattern=\"*.blf\"/>"));
        let list = std::fs::read_to_string(config.path().join("mimeapps.list")).unwrap();
        assert!(list.contains("application/x-ggs-blf=ggs.desktop"));
        // Unchecking removes the defaults again.
        linux_impl::apply(&[], data.path(), config.path()).unwrap();
        let list = std::fs::read_to_string(config.path().join("mimeapps.list")).unwrap();
        assert!(!list.contains("application/x-ggs-"));
    }

    /// `mimeapps.list` is shared with every other application: rewriting the defaults
    /// must keep foreign default entries and unrelated sections exactly as they were.
    #[cfg(target_os = "linux")]
    #[test]
    fn linux_registration_preserves_foreign_mimeapps_entries() {
        let data = tempfile::tempdir().unwrap();
        let config = tempfile::tempdir().unwrap();
        let list = config.path().join("mimeapps.list");
        std::fs::write(
			&list,
			"[Default Applications]\ntext/plain=other.desktop\n[Added Associations]\napplication/pdf=other.desktop\n",
		)
		.unwrap();
        linux_impl::apply(&["blf".into()], data.path(), config.path()).unwrap();
        let rewritten = std::fs::read_to_string(&list).unwrap();
        assert!(
            rewritten.contains("text/plain=other.desktop"),
            "foreign default kept: {rewritten}"
        );
        assert!(rewritten.contains("application/x-ggs-blf=ggs.desktop"));
        assert!(rewritten.contains("[Added Associations]"));
        assert!(
            rewritten.contains("application/pdf=other.desktop"),
            "foreign section untouched: {rewritten}"
        );
        // Unchecking withdraws only GGS's own defaults.
        linux_impl::apply(&[], data.path(), config.path()).unwrap();
        let rewritten = std::fs::read_to_string(&list).unwrap();
        assert!(!rewritten.contains("application/x-ggs-"));
        assert!(rewritten.contains("text/plain=other.desktop"));
        assert!(rewritten.contains("application/pdf=other.desktop"));
    }

    /// On macOS the registration is the bundle's own declaration, decided at build time
    /// (tauri.conf.json); at runtime `assoc_apply` only reports that no-op.
    #[cfg(target_os = "macos")]
    #[test]
    fn macos_registration_reports_the_bundle_noop() {
        let result = assoc_apply(vec!["blf".into()]).unwrap();
        assert_eq!(result.message_key, "assoc.applied.macos");
        assert_eq!(result.detail, "");
    }
}
