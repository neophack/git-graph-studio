//! The built-in terminal: a portable-pty (ConPTY on Windows) session per terminal tab, its
//! output streamed to the frontend as Tauri events, its input arriving as plain commands.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use tauri::{AppHandle as TauriAppHandle, Emitter, Manager};

use crate::AppState;

struct PtySession {
    /// Distinguishes this session from an earlier one created under the same frontend id: the
    /// reader thread only removes the map entry while it still owns that generation.
    gen: u64,
    writer: Box<dyn Write + Send>,
    child: Box<dyn portable_pty::Child + Send>,
    /// Kept alive here: dropping the master closes the ConPTY, and a resize needs it.
    master: Box<dyn portable_pty::MasterPty + Send>,
}

/// The live terminal sessions, keyed by the id the frontend assigned the tab.
#[derive(Default)]
pub struct PtyState {
    sessions: HashMap<u32, PtySession>,
}

/// Spawn the shell in the open repository (the session's working directory).
#[tauri::command]
pub fn pty_create(app: TauriAppHandle, id: u32, cols: u16, rows: u16) -> Result<String, String> {
    let cwd = app
        .state::<AppState>()
        .first_repo()
        .or_else(|| {
            std::env::current_dir()
                .ok()
                .map(|p| p.display().to_string())
        })
        .unwrap_or_else(|| ".".to_string());

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Could not open a terminal: {e}"))?;

    // PowerShell is the Windows default; every other platform takes the user's shell.
    let (mut command, shell_name) = if cfg!(windows) {
        let mut c = CommandBuilder::new("powershell.exe");
        c.arg("-NoLogo");
        (c, "powershell".to_owned())
    } else {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "sh".to_owned());
        let name = shell.rsplit('/').next().unwrap_or("sh").to_owned();
        let mut c = CommandBuilder::new(shell);
        c.env("TERM", "xterm-256color");
        (c, name)
    };
    command.cwd(&cwd);

    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|e| format!("Could not start the shell: {e}"))?;
    let writer = pair.master.take_writer().map_err(|e| format!("{e}"))?;
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("Could not read the terminal output: {e}"))?;
    // The slave is only needed for the spawn above; keeping it open can keep the master's
    // read side from reporting EOF once the shell exits.
    drop(pair.slave);

    let state = app.state::<Mutex<PtyState>>();
    // Insert (replacing any half-dead session left under this id) before spawning the reader
    // thread, so an instantly-exiting shell cannot remove the entry after this insert.
    static GEN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let gen = GEN.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    {
        let mut sessions = state.lock().unwrap();
        if let Some(mut old) = sessions.sessions.remove(&id) {
            let _ = old.child.kill();
        }
        sessions.sessions.insert(
            id,
            PtySession {
                gen,
                writer,
                child,
                master: pair.master,
            },
        );
    }

    // Drain the session on its own thread, forwarding chunks as events; exit ends the stream.
    let event_app = app.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let payload = String::from_utf8_lossy(&buf[..n]).into_owned();
                    let _ = event_app.emit(format!("studio://pty-output-{id}").as_str(), payload);
                }
            }
        }
        let _ = event_app.emit(format!("studio://pty-exit-{id}").as_str(), ());
        if let Some(state) = event_app.try_state::<Mutex<PtyState>>() {
            let mut sessions = state.lock().unwrap();
            // Only reap this generation: a newer session may already own the id.
            if sessions
                .sessions
                .get(&id)
                .map(|s| s.gen == gen)
                .unwrap_or(false)
            {
                sessions.sessions.remove(&id);
            }
        }
    });
    Ok(shell_name)
}

#[tauri::command]
pub fn pty_write(app: TauriAppHandle, id: u32, data: String) -> Result<(), String> {
    with_session(&app, id, |session| {
        session
            .writer
            .write_all(data.as_bytes())
            .and_then(|_| session.writer.flush())
            .map_err(|e| format!("Could not write to the terminal: {e}"))
    })
}

#[tauri::command]
pub fn pty_resize(app: TauriAppHandle, id: u32, cols: u16, rows: u16) -> Result<(), String> {
    with_session(&app, id, |session| {
        session
            .master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("Could not resize the terminal: {e}"))
    })
}

/// Kill the shell (the "trash" action). The reader thread notices the exit and emits it.
#[tauri::command]
pub fn pty_kill(app: TauriAppHandle, id: u32) -> Result<(), String> {
    let state = app.state::<Mutex<PtyState>>();
    let mut guard = state.lock().unwrap();
    if let Some(mut session) = guard.sessions.remove(&id) {
        let _ = session.child.kill();
    }
    Ok(())
}

fn with_session<T>(
    app: &TauriAppHandle,
    id: u32,
    work: impl FnOnce(&mut PtySession) -> Result<T, String>,
) -> Result<T, String> {
    let state = app.state::<Mutex<PtyState>>();
    let mut guard = state.lock().unwrap();
    match guard.sessions.get_mut(&id) {
        Some(session) => work(session),
        None => Err("The terminal has exited".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use portable_pty::{native_pty_system, CommandBuilder, PtySize};
    use std::io::Read;

    #[test]
    fn the_shell_stays_alive_and_prints_a_prompt() {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let mut command = if cfg!(windows) {
            let mut c = CommandBuilder::new("powershell.exe");
            c.arg("-NoLogo");
            c
        } else {
            CommandBuilder::new("sh")
        };
        command.cwd(std::env::temp_dir());
        let mut child = pair.slave.spawn_command(command).unwrap();
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let _ = tx.send(String::from_utf8_lossy(&buf[..n]).into_owned());
                    }
                }
            }
        });
        let mut output = String::new();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(8);
        while std::time::Instant::now() < deadline {
            if let Ok(chunk) = rx.recv_timeout(std::time::Duration::from_millis(200)) {
                output.push_str(&chunk);
            }
            if output.contains('>') || output.contains('$') {
                break;
            }
        }
        let status = child.try_wait().unwrap();
        assert!(
            status.is_none(),
            "the shell exited: {status:?}; output: {output:?}"
        );
        assert!(!output.is_empty(), "no prompt arrived");
        let _ = child.kill();
    }
}
