//! The Windows / macOS tray: tray-icon over a tao event loop on the main thread (Win32's
//! message pump, NSApplication — §7.9). Menu clicks arrive through muda's event handler as
//! user events; the loop wakes once a second to follow the daemon's state and exits when the
//! daemon has stopped. tray-icon re-adds the icon itself when Explorer restarts.

use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};

use tao::event::Event;
use tao::event_loop::{ControlFlow, EventLoopBuilder};
use tray_icon::menu::{
    CheckMenuItem, IsMenuItem, Menu, MenuEvent, MenuId, MenuItem, PredefinedMenuItem, Submenu,
};
use tray_icon::{Icon, TrayIcon, TrayIconBuilder};

use super::{icon_rgba, model, perform, signature, Action, Entry, IconKind};
use crate::state::Daemon;

enum UserEvent {
    Menu(MenuEvent),
}

const ICON_SIZE: u32 = 32;

fn icon(kind: IconKind) -> Option<Icon> {
    let template = cfg!(target_os = "macos");
    Icon::from_rgba(icon_rgba(kind, ICON_SIZE, template), ICON_SIZE, ICON_SIZE).ok()
}

/// Build a muda menu from the model; answers it with the id → action map.
fn build_menu(entries: &[Entry]) -> (Menu, HashMap<MenuId, Action>) {
    let menu = Menu::new();
    let mut actions = HashMap::new();
    fn add(
        parent: &dyn Fn(&dyn IsMenuItem),
        entries: &[Entry],
        actions: &mut HashMap<MenuId, Action>,
    ) {
        for entry in entries {
            match entry {
                Entry::Label(text) => parent(&MenuItem::new(text, false, None)),
                Entry::Item(text, action) => {
                    let item = MenuItem::new(text, true, None);
                    actions.insert(item.id().clone(), action.clone());
                    parent(&item);
                }
                Entry::Check(text, checked, action) => {
                    let item = CheckMenuItem::new(text, true, *checked, None);
                    actions.insert(item.id().clone(), action.clone());
                    parent(&item);
                }
                Entry::Sub(text, children) => {
                    let sub = Submenu::new(text, true);
                    add(
                        &|item: &dyn IsMenuItem| {
                            let _ = sub.append(item);
                        },
                        children,
                        actions,
                    );
                    parent(&sub);
                }
                Entry::Separator => parent(&PredefinedMenuItem::separator()),
            }
        }
    }
    add(
        &|item: &dyn IsMenuItem| {
            let _ = menu.append(item);
        },
        entries,
        &mut actions,
    );
    (menu, actions)
}

pub fn run(daemon: Arc<Daemon>) {
    let mut builder = EventLoopBuilder::<UserEvent>::with_user_event();
    let event_loop = builder.build();
    #[cfg(target_os = "macos")]
    {
        use tao::platform::macos::{ActivationPolicy, EventLoopExtMacOS};
        let mut event_loop = event_loop;
        event_loop.set_activation_policy(ActivationPolicy::Accessory);
        return run_loop(daemon, event_loop);
    }
    #[allow(unreachable_code)]
    run_loop(daemon, event_loop)
}

fn run_loop(daemon: Arc<Daemon>, event_loop: tao::event_loop::EventLoop<UserEvent>) {
    let proxy = event_loop.create_proxy();
    MenuEvent::set_event_handler(Some(move |event| {
        let _ = proxy.send_event(UserEvent::Menu(event));
    }));

    let mut tray: Option<TrayIcon> = None;
    let mut actions: HashMap<MenuId, Action> = HashMap::new();
    let mut last_signature = String::new();

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::WaitUntil(Instant::now() + Duration::from_secs(1));
        match event {
            Event::NewEvents(tao::event::StartCause::Init)
            | Event::NewEvents(tao::event::StartCause::ResumeTimeReached { .. }) => {
                if daemon.stopped.load(Ordering::Relaxed) {
                    tray = None;
                    *control_flow = ControlFlow::Exit;
                    return;
                }
                let (entries, tooltip, kind) = model(&daemon);
                let sig = signature(&entries, &tooltip, kind);
                if sig == last_signature {
                    return;
                }
                last_signature = sig;
                let (menu, map) = build_menu(&entries);
                actions = map;
                match &tray {
                    Some(t) => {
                        t.set_menu(Some(Box::new(menu)));
                        let _ = t.set_tooltip(Some(&tooltip));
                        #[cfg(target_os = "macos")]
                        let _ = t.set_icon_with_as_template(icon(kind), true);
                        #[cfg(not(target_os = "macos"))]
                        let _ = t.set_icon(icon(kind));
                    }
                    None => {
                        let mut b = TrayIconBuilder::new()
                            .with_menu(Box::new(menu))
                            .with_tooltip(&tooltip);
                        if let Some(i) = icon(kind) {
                            b = b.with_icon(i);
                        }
                        #[cfg(target_os = "macos")]
                        {
                            b = b.with_icon_as_template(true);
                        }
                        match b.build() {
                            Ok(t) => tray = Some(t),
                            Err(e) => crate::warn!("tray icon: {e}"),
                        }
                    }
                }
            }
            Event::UserEvent(UserEvent::Menu(menu_event)) => {
                if let Some(action) = actions.get(menu_event.id()).cloned() {
                    perform(&daemon, action);
                    // Rebuild right away: checks and the device list follow the click.
                    last_signature.clear();
                    *control_flow =
                        ControlFlow::WaitUntil(Instant::now() + Duration::from_millis(50));
                }
            }
            Event::LoopDestroyed => {
                tray = None;
            }
            _ => {}
        }
    });
}
