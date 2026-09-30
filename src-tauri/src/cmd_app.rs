//! The app-instance domain: launching another GGS window. The workbench is deliberately
//! multi-instance (no single-instance plugin — lib.rs's builder note; every launch is its
//! own process and window, and the `~/.ggs` writers all go through `atomic_write`), and
//! this module is the in-app entry point for it: the File menu's "New Window" starts a
//! sibling process that boots like a fresh `ggs` launch. Windows and Linux give that for
//! free to any second launch; macOS does not — activating a bundled app's icon only
//! focuses the running instance — so there the new instance goes through Launch Services
//! (`open -n <bundle>`), the same escape hatch `open -n` hands the command line, and the
//! Dock icon's right-click menu ([`dock_menu`]) offers it where a Mac user reaches first.

use std::path::{Path, PathBuf};
use std::process::Stdio;

/// How a new instance is started from this one, decided from where this process's own
/// executable lives.
#[derive(Debug, PartialEq, Eq)]
pub enum NewInstancePlan {
    /// `open -n <bundle>`: a packaged macOS run (the executable sits at
    /// `<bundle>.app/Contents/MacOS/ggs`) reaches Launch Services, the only spawner that
    /// gives the new instance proper Dock and activation behaviour.
    OpenNew { bundle: PathBuf },
    /// The executable itself, spawned detached: Windows and Linux always (a second
    /// process is a second instance there), and a macOS dev run whose executable is not
    /// inside a bundle.
    SpawnExe { exe: PathBuf },
}

/// Decide [`NewInstancePlan`] for an executable path. The rule is purely syntactic: an
/// executable at `<bundle>.app/Contents/MacOS/<name>` is a packaged macOS build (that
/// layout only exists once the bundle is in place, so no liveness check is needed);
/// anything else — the deb/rpm `/usr/bin/ggs`, the NSIS install, a `tauri dev` target
/// binary — is spawned as itself, which on every platform starts an independent
/// instance.
pub fn new_instance_plan(exe: &Path) -> NewInstancePlan {
    #[cfg(target_os = "macos")]
    if let Some(bundle) = exe.parent().and_then(Path::parent).and_then(Path::parent) {
        if bundle
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("app"))
        {
            return NewInstancePlan::OpenNew {
                bundle: bundle.to_owned(),
            };
        }
    }
    NewInstancePlan::SpawnExe {
        exe: exe.to_owned(),
    }
}

/// Start another instance of this app — the shared body of the File menu's "New Window"
/// and the Dock menu's item. The child gets null stdio (it shares nothing of this
/// window's pipes) and is reaped on a spare thread — `open -n` exits as soon as Launch
/// Services has taken the handoff, and a dropped `Child` is never waited.
fn spawn_new_instance() -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| format!("locate this app's executable: {e}"))?;
    let mut command = match new_instance_plan(&exe) {
        NewInstancePlan::OpenNew { bundle } => {
            let mut open = std::process::Command::new("open");
            open.arg("-n").arg(bundle);
            open
        }
        NewInstancePlan::SpawnExe { exe } => std::process::Command::new(exe),
    };
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("start a new window: {e}"))?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

/// File > New Window: start another instance of this app, the multi-open entry every
/// platform shares.
#[tauri::command]
pub fn app_new_instance() -> Result<(), String> {
    spawn_new_instance()
}

/// The Dock icon's right-click menu: "New Window", the multi-open affordance a Mac user
/// reaches for first. AppKit asks the application delegate for `applicationDockMenu:`;
/// the delegate is tao's (Tauri's windowing layer) and ships no such method, so at boot
/// [`install`] injects the two selectors into its class with `class_addMethod` — purely
/// additive: the delegate object, its identity and every method it already answers stay
/// untouched, and if a future tao ships its own dock menu the add simply fails (logged)
/// and theirs wins.
#[cfg(target_os = "macos")]
pub mod dock_menu {
    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, Imp, Sel};
    use objc2::{ffi, sel, MainThreadMarker, MainThreadOnly};
    use objc2_app_kit::{NSApplication, NSMenu, NSMenuItem};

    /// Install the Dock menu at boot (main thread only — call from tauri's setup). Logs
    /// the outcome: both `class_addMethod` results plus one built menu's label, so a
    /// broken injection is a boot-log line, not a silently absent Dock menu.
    pub fn install() {
        let Some(mtm) = MainThreadMarker::new() else {
            eprintln!("[boot] dock menu: not on the main thread; skipped");
            return;
        };
        // AppKit against the live delegate, on the main thread it requires.
        unsafe {
            let app = NSApplication::sharedApplication(mtm);
            let Some(delegate) = app.delegate() else {
                eprintln!("[boot] dock menu: no application delegate; skipped");
                return;
            };
            let delegate_ptr = Retained::as_ptr(&delegate).cast::<AnyObject>();
            let class = ffi::object_getClass(delegate_ptr).cast_mut();
            let menu_imp: Imp = std::mem::transmute::<
                extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject) -> *mut AnyObject,
                Imp,
            >(dock_menu_imp);
            let action_imp: Imp = std::mem::transmute::<
                extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject),
                Imp,
            >(new_window_imp);
            // The ObjC type encodings of the two signatures, self and _cmd included:
            // `@:@` — an object back, an object argument; `v@:@` — nothing back.
            let menu_added = ffi::class_addMethod(
                class,
                sel!(applicationDockMenu:),
                menu_imp,
                c"@:@".as_ptr(),
            );
            let action_added = ffi::class_addMethod(
                class,
                sel!(ggsNewWindow:),
                action_imp,
                c"v@:@".as_ptr(),
            );
            let title = item_title();
            drop(build_menu(delegate_ptr.cast_mut(), &title, mtm));
            eprintln!(
                "[boot] dock menu: \"{title}\" (applicationDockMenu: {}, ggsNewWindow: {})",
                menu_added.as_bool(),
                action_added.as_bool()
            );
        }
    }

    /// `-[delegate applicationDockMenu:]` — asked at every right-click of the Dock icon,
    /// so the menu (and its label's language) is rebuilt fresh each time.
    extern "C-unwind" fn dock_menu_imp(
        delegate: *mut AnyObject,
        _cmd: Sel,
        _sender: *mut AnyObject,
    ) -> *mut AnyObject {
        // AppKit asks on the main thread; NSMenu is main-thread-only in AppKit's model.
        let Some(mtm) = MainThreadMarker::new() else {
            return std::ptr::null_mut();
        };
        unsafe { Retained::autorelease_return(build_menu(delegate, &item_title(), mtm)).cast() }
    }

    /// `-[delegate ggsNewWindow:]` — the Dock item's action, the same spawn the File
    /// menu's "New Window" runs.
    extern "C-unwind" fn new_window_imp(
        _target: *mut AnyObject,
        _cmd: Sel,
        _sender: *mut AnyObject,
    ) {
        if let Err(reason) = super::spawn_new_instance() {
            eprintln!("[dock] new window: {reason}");
        }
    }

    /// The one-item menu: "New Window", targeted at the application delegate itself (the
    /// object whose class carries the injected action).
    unsafe fn build_menu(
        delegate: *mut AnyObject,
        title: &str,
        mtm: MainThreadMarker,
    ) -> Retained<NSMenu> {
        use objc2_foundation::NSString;

        let menu = NSMenu::initWithTitle(NSMenu::alloc(mtm), &NSString::from_str(""));
        let item = NSMenuItem::initWithTitle_action_keyEquivalent(
            NSMenuItem::alloc(mtm),
            &NSString::from_str(title),
            Some(sel!(ggsNewWindow:)),
            &NSString::from_str(""),
        );
        unsafe { item.setTarget(Some(&*delegate)) };
        menu.addItem(&item);
        menu
    }

    /// The Dock item's label follows the app's display language — the persisted
    /// `~/.ggs/settings.json` `locale`, the same store the Settings dialog writes — so
    /// the Dock menu and the File menu never disagree.
    fn item_title() -> String {
        title_for_locale(stored_locale().as_deref())
    }

    /// The two labels the app's locales spell it (`zh-cn` and everything else).
    fn title_for_locale(locale: Option<&str>) -> String {
        if locale == Some("zh-cn") {
            "新建窗口".to_owned()
        } else {
            "New Window".to_owned()
        }
    }

    /// The persisted display language, mirroring lib.rs's settings path (`HOME` /
    /// `USERPROFILE` + `~/.ggs/settings.json`); unreadable or unparseable means English.
    fn stored_locale() -> Option<String> {
        let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))?;
        let contents = std::fs::read_to_string(
            std::path::Path::new(&home)
                .join(".ggs")
                .join("settings.json"),
        )
        .ok()?;
        serde_json::from_str::<serde_json::Value>(&contents)
            .ok()?
            .get("locale")?
            .as_str()
            .map(str::to_owned)
    }

    #[cfg(test)]
    mod tests {
        use super::title_for_locale;

        #[test]
        fn the_label_follows_the_display_language() {
            assert_eq!(title_for_locale(Some("zh-cn")), "新建窗口");
            assert_eq!(title_for_locale(Some("en")), "New Window");
            assert_eq!(title_for_locale(None), "New Window");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "macos")]
    #[test]
    fn a_packaged_macos_exe_opens_through_launch_services() {
        assert_eq!(
            new_instance_plan(Path::new(
                "/Applications/Git Graph Studio.app/Contents/MacOS/ggs"
            )),
            NewInstancePlan::OpenNew {
                bundle: PathBuf::from("/Applications/Git Graph Studio.app")
            }
        );
    }

    #[test]
    fn an_unbundled_exe_spawns_directly() {
        // The forms that are never inside a bundle: the deb/rpm `/usr/bin/ggs`, the NSIS
        // install, and a macOS `tauri dev` run's target binary.
        let exe = if cfg!(target_os = "windows") {
            r"C:\Program Files\Git Graph Studio\ggs.exe"
        } else if cfg!(target_os = "macos") {
            "/build/target/debug/ggs"
        } else {
            "/usr/bin/ggs"
        };
        assert_eq!(
            new_instance_plan(Path::new(exe)),
            NewInstancePlan::SpawnExe {
                exe: PathBuf::from(exe)
            }
        );
    }
}
