//! The tray (docs/ggs-remote-plan.md §7.9): one menu model built from the daemon's state,
//! rendered by a native backend — tray-icon + tao on Windows/macOS, ksni (StatusNotifierItem
//! over D-Bus, no GTK) on Linux, which falls back to no tray when the desktop has no watcher.
//! Labels follow the app's display language (`~/.ggs/settings.json` `displayLanguage`).

use std::sync::atomic::Ordering;
use std::sync::Arc;

use crate::state::{Daemon, TrayState};

#[cfg(target_os = "linux")]
mod linux;
#[cfg(any(windows, target_os = "macos"))]
mod native;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    CopyLink,
    CopyHubLink(String),
    Pair,
    ChangePassword,
    Disconnect(String),
    DisconnectAll,
    OpenGgs,
    /// Put one registered instance's window on this PC's screen (the daemon's `Show`) — a
    /// hidden one a remote browser drives, or a desktop window behind others.
    ShowWindow(String),
    TogglePause,
    ToggleAutostart,
    Quit,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Entry {
    Label(String),
    Item(String, Action),
    Check(String, bool, Action),
    Sub(String, Vec<Entry>),
    Separator,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IconKind {
    Stopped,
    Listening,
    Active,
    Error,
}

/// Run the tray on this (the main) thread until the daemon stops.
pub fn run(daemon: Arc<Daemon>) {
    #[cfg(any(windows, target_os = "macos"))]
    native::run(daemon);
    #[cfg(target_os = "linux")]
    linux::run(daemon);
}

/// The app's settings file spells the display language (`locale`, `displayLanguage` the
/// older spelling); both tray backends re-read this every second they poll their model, so
/// a language switched in the app relabels the tray within moments of the file's atomic
/// rewrite.
fn zh(daemon: &Daemon) -> bool {
    daemon
        .paths
        .display_language()
        .is_some_and(|l| l == "zh-cn")
}

/// The label set, en / zh-cn.
struct Labels {
    zh: bool,
}

impl Labels {
    fn pick(&self, en: &'static str, zh: &'static str) -> &'static str {
        if self.zh {
            zh
        } else {
            en
        }
    }
}

pub fn first_link(daemon: &Daemon) -> Option<String> {
    let config = daemon.config();
    let scheme = if config.tls.mode == crate::config::TlsMode::None {
        "http"
    } else {
        "https"
    };
    let port = daemon.public_port.load(Ordering::Relaxed);
    let host = crate::tls::link_hosts(&config.effective_bind())
        .into_iter()
        .next()?;
    Some(crate::tls::link_for(scheme, &host, port))
}

/// The tray's whole state as a menu, a tooltip and an icon.
pub fn model(daemon: &Daemon) -> (Vec<Entry>, String, IconKind) {
    let l = Labels { zh: zh(daemon) };
    let state = daemon.tray.borrow().clone();
    let config = daemon.config();
    let link = first_link(daemon);
    let (status, kind) = match &state {
        TrayState::Stopped => (l.pick("Stopped", "已停止").to_owned(), IconKind::Stopped),
        TrayState::Listening if config.paused => {
            (l.pick("Paused", "已暂停").to_owned(), IconKind::Stopped)
        }
        TrayState::Listening => (
            l.pick("Listening", "监听中").to_owned(),
            IconKind::Listening,
        ),
        TrayState::Active(n) => (
            if l.zh {
                format!("{n} 个远程设备")
            } else {
                format!("{n} remote device(s)")
            },
            IconKind::Active,
        ),
        TrayState::Error(message) => (message.clone(), IconKind::Error),
    };
    let header = match (&link, &state) {
        (Some(link), TrayState::Listening | TrayState::Active(_)) => {
            format!("GGS Remote — {status} ({link})")
        }
        _ => format!("GGS Remote — {status}"),
    };
    let epoch = daemon.auth.epoch();
    let devices = daemon.sessions.lock().unwrap().devices(epoch, None);
    let mut device_items: Vec<Entry> = devices
        .iter()
        .map(|d| {
            Entry::Sub(
                format!("{} ({})", d.device, d.ip),
                vec![Entry::Item(
                    l.pick("Disconnect", "断开").into(),
                    Action::Disconnect(d.id.clone()),
                )],
            )
        })
        .collect();
    if !device_items.is_empty() {
        device_items.push(Entry::Separator);
    }
    device_items.push(Entry::Item(
        l.pick("Disconnect all", "全部断开").into(),
        Action::DisconnectAll,
    ));
    let devices_label = if l.zh {
        format!("已连接设备 ({})", devices.len())
    } else {
        format!("Signed-in devices ({})", devices.len())
    };
    let windows = window_entries(daemon, &l);
    let windows_label = if l.zh {
        format!("窗口 ({})", windows.len())
    } else {
        format!("Windows ({})", windows.len())
    };
    let windows = if windows.is_empty() {
        vec![Entry::Label(
            l.pick("No window is open", "没有打开的窗口").into(),
        )]
    } else {
        windows
    };
    // The Hub relay's corner (§20.9): one line while it is configured, its link to copy.
    let hub = match daemon.hub.snapshot() {
        crate::hub::Status::Online { public_base, .. } => Some((
            l.pick("Server online", "服务器在线").to_owned(),
            Some(public_base),
        )),
        crate::hub::Status::Connecting(_) => Some((
            l.pick("Server: connecting…", "服务器：连接中…").to_owned(),
            None,
        )),
        crate::hub::Status::Rejected(reason) => Some((
            match reason.as_str() {
                "join-key" => l
                    .pick("Server: wrong join key", "服务器：口令不对")
                    .to_owned(),
                "capacity" => l.pick("Server: full", "服务器：已满").to_owned(),
                other => format!("Server: {other}"),
            },
            None,
        )),
        crate::hub::Status::Replaced => Some((
            l.pick(
                "Server: this key connected elsewhere",
                "服务器：此密钥在别处连接",
            )
            .to_owned(),
            None,
        )),
        crate::hub::Status::NoPassword => None,
        crate::hub::Status::Unconfigured => None,
    };
    let mut hub_entries: Vec<Entry> = Vec::new();
    if let Some((label, link)) = hub {
        hub_entries.push(Entry::Label(label));
        if let Some(link) = link {
            hub_entries.push(Entry::Item(
                l.pick("Copy server link", "复制服务器链接").into(),
                Action::CopyHubLink(link),
            ));
        }
        hub_entries.push(Entry::Separator);
    }
    let menu = hub_entries
        .into_iter()
        .chain(vec![
            Entry::Label(header.clone()),
            Entry::Separator,
            Entry::Item(
                l.pick("Copy access link", "复制访问链接").into(),
                Action::CopyLink,
            ),
            Entry::Item(
                l.pick("Show pairing QR code…", "显示配对二维码…").into(),
                Action::Pair,
            ),
            Entry::Item(
                l.pick("Change password…", "修改密码…").into(),
                Action::ChangePassword,
            ),
            Entry::Sub(devices_label, device_items),
            Entry::Separator,
            Entry::Sub(windows_label, windows),
            Entry::Item(
                l.pick("Open Git Graph Studio", "打开 Git Graph Studio")
                    .into(),
                Action::OpenGgs,
            ),
            Entry::Check(
                l.pick("Pause remote access", "暂停远程访问").into(),
                config.paused,
                Action::TogglePause,
            ),
            Entry::Check(
                l.pick("Start at login", "开机启动").into(),
                config.autostart,
                Action::ToggleAutostart,
            ),
            Entry::Separator,
            Entry::Item(l.pick("Quit", "退出").into(), Action::Quit),
        ])
        .collect();
    // Windows caps tray tooltips at 127 characters.
    let tooltip: String = header.chars().take(120).collect();
    (menu, tooltip, kind)
}

/// Every registered instance, oldest first, as a menu item that shows its window: the
/// window's title, marked when it runs hidden (remote browsers drive it, the PC screen does
/// not show it) and with the remote sessions attached to it. A local window and a remote one
/// are the same instance (§22) — showing a hidden one hands the PC user the desktop UI while
/// a phone keeps its own (§22.5).
fn window_entries(daemon: &Daemon, l: &Labels) -> Vec<Entry> {
    daemon
        .registry
        .snapshot()
        .into_iter()
        .map(|info| {
            let mut label = if info.title.trim().is_empty() {
                info.folders
                    .first()
                    .and_then(|f| f.rsplit(['/', '\\']).find(|s| !s.is_empty()))
                    .unwrap_or("Git Graph Studio")
                    .to_owned()
            } else {
                info.title.clone()
            };
            if !info.visible {
                label.push_str(l.pick(" (hidden)", "（后台）"));
            }
            if info.remote_sessions > 0 {
                label.push_str(&if l.zh {
                    format!(" · {} 个远程", info.remote_sessions)
                } else {
                    format!(" · {} remote", info.remote_sessions)
                });
            }
            Entry::Item(label, Action::ShowWindow(info.id))
        })
        .collect()
}

/// Carry out a menu action (from the tray thread; everything here is synchronous).
pub fn perform(daemon: &Arc<Daemon>, action: Action) {
    match action {
        Action::CopyLink => {
            if let Some(link) = first_link(daemon) {
                if let Err(e) = crate::desk::copy_text(&link) {
                    crate::warn!("copy link: {e}");
                }
            }
        }
        Action::CopyHubLink(link) => {
            if let Err(e) = crate::desk::copy_text(&link) {
                crate::warn!("copy server link: {e}");
            }
        }
        Action::Pair | Action::ChangePassword => {
            let ticket = daemon.tickets.lock().unwrap().issue_pair();
            let port = daemon.loopback_port.load(Ordering::Relaxed);
            let anchor = if action == Action::ChangePassword {
                "#change"
            } else {
                ""
            };
            if let Err(e) =
                crate::desk::open_url(&format!("http://127.0.0.1:{port}/pair?t={ticket}{anchor}"))
            {
                crate::warn!("open the pair page: {e}");
            }
        }
        Action::Disconnect(id) => {
            let hash = daemon.sessions.lock().unwrap().remove_by_id(&id);
            if let Some(hash) = hash {
                daemon.revoke(&hash);
            }
        }
        Action::DisconnectAll => {
            if daemon.auth.bump_epoch().is_ok() {
                daemon.credentials_changed("revoked");
            }
        }
        Action::OpenGgs => {
            let latest = daemon
                .registry
                .instances
                .lock()
                .unwrap()
                .values()
                .max_by_key(|i| i.info.started_at)
                .map(|i| i.info.id.clone());
            match latest {
                Some(id) => {
                    daemon
                        .registry
                        .send(&id, crate::control_msg::ToInstance::Show);
                }
                None => {
                    let config = daemon.config();
                    match crate::spawn::pick_spec(None, &config) {
                        Some(spec) => {
                            if let Err(e) = crate::spawn::launch(&spec, None, true) {
                                crate::warn!("{e}");
                            }
                        }
                        None => crate::warn!("no GGS installation is known yet"),
                    }
                }
            }
        }
        Action::ShowWindow(id) => {
            daemon
                .registry
                .send(&id, crate::control_msg::ToInstance::Show);
        }
        Action::TogglePause => {
            let paused = daemon.config().paused;
            crate::http::admin::set_paused(daemon, !paused);
        }
        Action::ToggleAutostart => {
            let next = !daemon.config().autostart;
            match crate::autostart::apply(next) {
                Ok(()) => {
                    let mut config = daemon.config.lock().unwrap();
                    config.autostart = next;
                    let _ = config.save(&daemon.paths);
                }
                Err(e) => crate::warn!("autostart: {e}"),
            }
        }
        Action::Quit => {
            daemon.shutdown.notify_one();
        }
    }
}

/// The tray icon, drawn rather than decoded (no image crate): a rounded square in the state
/// colour carrying the commit-graph mark. `template` draws black on transparent for the
/// macOS menu bar, which tints it itself.
pub fn icon_rgba(kind: IconKind, size: u32, template: bool) -> Vec<u8> {
    let (r, g, b) = match kind {
        IconKind::Stopped => (128, 128, 128),
        IconKind::Listening => (10, 102, 216),
        IconKind::Active => (46, 160, 67),
        IconKind::Error => (198, 40, 40),
    };
    let s = size as f32;
    let mut out = vec![0u8; (size * size * 4) as usize];
    let dot = |cx: f32, cy: f32, rad: f32, x: f32, y: f32| {
        ((x - cx).powi(2) + (y - cy).powi(2)).sqrt() <= rad
    };
    for y in 0..size {
        for x in 0..size {
            let (fx, fy) = (x as f32 + 0.5, y as f32 + 0.5);
            let corner = s * 0.22;
            let inside = {
                let dx = (fx - s / 2.0).abs() - (s / 2.0 - corner);
                let dy = (fy - s / 2.0).abs() - (s / 2.0 - corner);
                dx <= 0.0 || dy <= 0.0 || (dx * dx + dy * dy).sqrt() <= corner
            };
            let mark = dot(s * 0.32, s * 0.28, s * 0.1, fx, fy)
                || dot(s * 0.32, s * 0.72, s * 0.1, fx, fy)
                || dot(s * 0.68, s * 0.46, s * 0.1, fx, fy)
                || ((fx - s * 0.32).abs() <= s * 0.045 && fy >= s * 0.28 && fy <= s * 0.72)
                || (fy - (s * 0.6 - (fx - s * 0.32) * 0.4)).abs() <= s * 0.045
                    && fx >= s * 0.32
                    && fx <= s * 0.68;
            let i = ((y * size + x) * 4) as usize;
            let rgba: [u8; 4] = if template {
                if inside && !mark {
                    [0, 0, 0, 255]
                } else {
                    [0, 0, 0, 0]
                }
            } else if mark && inside {
                [255, 255, 255, 255]
            } else if inside {
                [r, g, b, 255]
            } else {
                [0, 0, 0, 0]
            };
            out[i..i + 4].copy_from_slice(&rgba);
        }
    }
    out
}

/// A cheap fingerprint of the menu so the backends rebuild only on change.
pub fn signature(menu: &[Entry], tooltip: &str, kind: IconKind) -> String {
    format!("{menu:?}|{tooltip}|{kind:?}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_language_follows_the_app_settings_file() {
        let dir = tempfile::tempdir().unwrap();
        let paths = crate::paths::Paths::at(dir.path().join("remote"), dir.path().to_path_buf());
        paths.ensure().unwrap();
        let daemon = Daemon::new(paths.clone(), crate::config::Config::default()).unwrap();
        assert!(!zh(&daemon), "no settings file means English");
        std::fs::write(
            paths.settings(),
            r#"{ "theme": "dark-modern", "locale": "zh-cn" }"#,
        )
        .unwrap();
        assert!(zh(&daemon), "the app's own key is locale");
        std::fs::write(paths.settings(), r#"{ "locale": "en" }"#).unwrap();
        assert!(!zh(&daemon));
        std::fs::write(paths.settings(), r#"{ "displayLanguage": "zh-cn" }"#).unwrap();
        assert!(zh(&daemon), "the older spelling still answers");
    }

    #[test]
    fn the_windows_menu_lists_every_instance_and_shows_the_picked_one() {
        use crate::control_msg::{LaunchSpec, ToInstance};
        use crate::registry::Registration;
        let dir = tempfile::tempdir().unwrap();
        let paths = crate::paths::Paths::at(dir.path().join("remote"), dir.path().to_path_buf());
        paths.ensure().unwrap();
        let daemon = Daemon::new(paths, crate::config::Config::default()).unwrap();
        let windows = |daemon: &Daemon| {
            let (menu, _, _) = model(daemon);
            menu.into_iter()
                .find_map(|entry| match entry {
                    Entry::Sub(label, children) if label.starts_with("Windows") => {
                        Some((label, children))
                    }
                    _ => None,
                })
                .expect("the tray carries a Windows submenu")
        };
        let (label, children) = windows(&daemon);
        assert_eq!(label, "Windows (0)");
        assert!(matches!(&children[..], [Entry::Label(_)]));

        let register = |id: &str, title: &str, visible: bool| {
            let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
            daemon.registry.register(
                Registration {
                    instance_id: id.into(),
                    pid: 1,
                    version: "0".into(),
                    title: title.into(),
                    folders: vec![r"C:\work\repo".into()],
                    visible,
                    remote_host: !visible,
                    launch: LaunchSpec::default(),
                    sandboxed: false,
                },
                tx,
            );
            rx
        };
        let _desk = register("a", "repo — Git Graph Studio", true);
        let mut hidden = register("b", "", false);
        let (label, children) = windows(&daemon);
        assert_eq!(label, "Windows (2)");
        let items: Vec<(String, Action)> = children
            .into_iter()
            .filter_map(|entry| match entry {
                Entry::Item(label, action) => Some((label, action)),
                _ => None,
            })
            .collect();
        let labels: Vec<&str> = items.iter().map(|(label, _)| label.as_str()).collect();
        assert!(labels.contains(&"repo — Git Graph Studio"));
        // A window without a title falls back to its folder's name, marked hidden.
        assert!(labels.contains(&"repo (hidden)"));
        let (_, show) = items
            .iter()
            .find(|(label, _)| label == "repo (hidden)")
            .unwrap();
        assert_eq!(show, &Action::ShowWindow("b".into()));
        perform(&daemon, show.clone());
        assert!(matches!(hidden.try_recv(), Ok(ToInstance::Show)));
    }

    #[test]
    fn icons_have_the_right_shape() {
        let rgba = icon_rgba(IconKind::Active, 32, false);
        assert_eq!(rgba.len(), 32 * 32 * 4);
        // The centre-left of the mark is white, a corner is transparent.
        assert_eq!(rgba[3], 0);
        let template = icon_rgba(IconKind::Listening, 32, true);
        assert!(template
            .chunks(4)
            .all(|p| p[0] == 0 && p[1] == 0 && p[2] == 0));
    }
}
