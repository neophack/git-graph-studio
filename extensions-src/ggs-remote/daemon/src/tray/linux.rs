//! The Linux tray: a StatusNotifierItem over D-Bus (ksni, pure Rust — no GTK, no
//! libappindicator). Without a `StatusNotifierWatcher` (GNOME without the AppIndicator
//! extension) the daemon runs trayless and logs it; the extension page and the CLI manage it
//! then (§7.9).

use ksni::blocking::TrayMethods;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use super::{icon_rgba, model, perform, signature, Action, Entry, IconKind};
use crate::state::Daemon;

struct GgsTray {
    daemon: Arc<Daemon>,
    entries: Vec<Entry>,
    tooltip: String,
    kind: IconKind,
}

fn to_ksni(entries: &[Entry]) -> Vec<ksni::MenuItem<GgsTray>> {
    use ksni::menu::{CheckmarkItem, StandardItem, SubMenu};
    entries
        .iter()
        .map(|entry| match entry {
            Entry::Label(text) => StandardItem {
                label: text.clone(),
                enabled: false,
                ..Default::default()
            }
            .into(),
            Entry::Item(text, action) => {
                let action = action.clone();
                StandardItem {
                    label: text.clone(),
                    activate: Box::new(move |tray: &mut GgsTray| run_action(tray, action.clone())),
                    ..Default::default()
                }
                .into()
            }
            Entry::Check(text, checked, action) => {
                let action = action.clone();
                CheckmarkItem {
                    label: text.clone(),
                    checked: *checked,
                    activate: Box::new(move |tray: &mut GgsTray| run_action(tray, action.clone())),
                    ..Default::default()
                }
                .into()
            }
            Entry::Sub(text, children) => SubMenu {
                label: text.clone(),
                submenu: to_ksni(children),
                ..Default::default()
            }
            .into(),
            Entry::Separator => ksni::MenuItem::Separator,
        })
        .collect()
}

fn run_action(tray: &mut GgsTray, action: Action) {
    perform(&tray.daemon, action);
    let (entries, tooltip, kind) = model(&tray.daemon);
    tray.entries = entries;
    tray.tooltip = tooltip;
    tray.kind = kind;
}

impl ksni::Tray for GgsTray {
    fn id(&self) -> String {
        "ggs-remote".into()
    }
    fn title(&self) -> String {
        "GGS Remote".into()
    }
    fn icon_pixmap(&self) -> Vec<ksni::Icon> {
        // ARGB32 in network byte order, from the shared RGBA drawing.
        let size = 32u32;
        let rgba = icon_rgba(self.kind, size, false);
        let data = rgba
            .chunks(4)
            .flat_map(|p| [p[3], p[0], p[1], p[2]])
            .collect();
        vec![ksni::Icon {
            width: size as i32,
            height: size as i32,
            data,
        }]
    }
    fn tool_tip(&self) -> ksni::ToolTip {
        ksni::ToolTip {
            title: self.tooltip.clone(),
            ..Default::default()
        }
    }
    fn menu(&self) -> Vec<ksni::MenuItem<Self>> {
        to_ksni(&self.entries)
    }
}

pub fn run(daemon: Arc<Daemon>) {
    let (entries, tooltip, kind) = model(&daemon);
    let tray = GgsTray {
        daemon: daemon.clone(),
        entries,
        tooltip,
        kind,
    };
    let handle = match tray.spawn() {
        Ok(handle) => Some(handle),
        Err(e) => {
            crate::warn!("no system tray available ({e}); running without one");
            None
        }
    };
    let mut last = String::new();
    while !daemon.stopped.load(Ordering::Relaxed) {
        std::thread::sleep(Duration::from_secs(1));
        let Some(handle) = &handle else { continue };
        let (entries, tooltip, kind) = model(&daemon);
        let sig = signature(&entries, &tooltip, kind);
        if sig != last {
            last = sig;
            handle.update(move |tray: &mut GgsTray| {
                tray.entries = entries;
                tray.tooltip = tooltip;
                tray.kind = kind;
            });
        }
    }
    if let Some(handle) = handle {
        let _ = handle.shutdown();
    }
}
