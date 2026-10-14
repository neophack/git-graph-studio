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
    /// The last [`TAIL_BYTES`] of output: what a second frontend attaching to this terminal
    /// (a remote session, docs/ggs-remote-plan.md §8.6 #5) replays before it follows live.
    tail: std::sync::Arc<Mutex<String>>,
}

/// How much recent output each terminal keeps for late joiners.
pub const TAIL_BYTES: usize = 64 * 1024;

/// Append output to a tail buffer, dropping the oldest text past the cap (at a char boundary).
fn push_tail(tail: &Mutex<String>, text: &str) {
    let mut tail = tail.lock().unwrap();
    tail.push_str(text);
    if tail.len() > TAIL_BYTES {
        let mut cut = tail.len() - TAIL_BYTES;
        while !tail.is_char_boundary(cut) {
            cut += 1;
        }
        tail.drain(..cut);
    }
}

/// The live terminal sessions, keyed by the id the frontend assigned the tab.
#[derive(Default)]
pub struct PtyState {
    sessions: HashMap<u32, PtySession>,
}

/// Spawn the shell in the open repository (the session's working directory). `shell`
/// is the Terminal Shell setting's value (`"gitBash"` the default, `"ggsBash"` and
/// `"powershell"` the alternatives); every new terminal re-reads it, so a Settings
/// change reaches the next terminal without a restart.
#[tauri::command]
pub fn pty_create(
    app: TauriAppHandle,
    id: u32,
    cols: u16,
    rows: u16,
    shell: Option<String>,
) -> Result<String, String> {
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

    let (mut command, shell_name) = shell_command(shell.as_deref())?;
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
    let tail = std::sync::Arc::new(Mutex::new(String::new()));
    let reader_tail = tail.clone();
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
                tail,
            },
        );
    }

    // Drain the session on its own thread, forwarding chunks as events; exit ends the stream.
    let event_app = app.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        let mut carry: Vec<u8> = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let payload = decode_pty_chunk(&mut carry, &buf[..n]);
                    if !payload.is_empty() {
                        push_tail(&reader_tail, &payload);
                        let _ =
                            event_app.emit(format!("studio://pty-output-{id}").as_str(), payload);
                    }
                }
            }
        }
        if !carry.is_empty() {
            // Stream end: whatever incomplete sequence remains is terminal damage —
            // flush it lossily (one U+FFFD) rather than dropping it.
            let tail = String::from_utf8_lossy(&carry).into_owned();
            carry.clear();
            let _ = event_app.emit(format!("studio://pty-output-{id}").as_str(), tail);
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

/// The live terminal ids (a frontend attaching to an instance lists the terminals it can
/// join — §8.6 #5).
#[tauri::command]
pub fn pty_list(app: TauriAppHandle) -> Vec<u32> {
    let state = app.state::<Mutex<PtyState>>();
    let mut ids: Vec<u32> = state.lock().unwrap().sessions.keys().copied().collect();
    ids.sort_unstable();
    ids
}

/// The recent output of a terminal, at most `bytes` (default and cap: [`TAIL_BYTES`]) — the
/// replay a joining frontend writes before it follows `studio://pty-output-{id}` live.
#[tauri::command]
pub fn pty_tail(app: TauriAppHandle, id: u32, bytes: Option<usize>) -> Result<String, String> {
    let state = app.state::<Mutex<PtyState>>();
    let sessions = state.lock().unwrap();
    let session = sessions.sessions.get(&id).ok_or("no such terminal")?;
    let tail = session.tail.lock().unwrap();
    let want = bytes.unwrap_or(TAIL_BYTES).min(TAIL_BYTES);
    let mut start = tail.len().saturating_sub(want);
    while !tail.is_char_boundary(start) {
        start += 1;
    }
    Ok(tail[start..].to_owned())
}

/// How many terminals run in this instance (the Remote Access summary, R21).
pub fn session_count(app: &TauriAppHandle) -> u32 {
    app.try_state::<Mutex<PtyState>>()
        .map(|state| state.lock().unwrap().sessions.len() as u32)
        .unwrap_or(0)
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

/// The shell a new terminal opens. Windows: Git Bash — the setting's default — is
/// Git for Windows' own bash, located by `find_git_bash` (the registry, the standard
/// install roots, then the PATH), and where none is installed the bundled GGS Bash
/// stands in (the owner's 2026-10-13 direction; its dialect is Git Bash's, so the
/// stand-in is the same shell to sit in); GGS Bash by name is the sidecar beside the
/// app binary, the same host lookup every extension backend resolves through;
/// PowerShell is the fallback. Everywhere else neither bash of the setting exists
/// (2026-10-13, the owner's direction): the terminal opens the system's own shell —
/// `$SHELL`, `sh` when unset — whatever the stored setting says.
fn shell_command(shell: Option<&str>) -> Result<(CommandBuilder, String), String> {
    if !cfg!(windows) {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "sh".to_owned());
        let name = shell.rsplit('/').next().unwrap_or("sh").to_owned();
        let mut command = CommandBuilder::new(&shell);
        command.env("TERM", "xterm-256color");
        return Ok((command, name));
    }
    if shell == Some("ggsBash") {
        let path = ggs_ext::process::resolve_engine_host("ggs-bash")
            .map_err(|error| format!("GGS Bash is not available: {error}"))?;
        let mut command = CommandBuilder::new(&path);
        command.arg("-i");
        command.env("TERM", "xterm-256color");
        return Ok((command, "ggs-bash".to_owned()));
    }
    if shell == Some("gitBash") {
        if let Some(path) = ggs_git::locate::find_git_bash() {
            let mut command = CommandBuilder::new(&path);
            // Git Bash's own shortcut shape: a login shell, so its profile sets up
            // the prompt and the PATH the way a standalone Git Bash terminal shows
            // them.
            command.arg("--login");
            command.arg("-i");
            command.env("TERM", "xterm-256color");
            return Ok((command, "git-bash".to_owned()));
        }
        // No Git Bash on the machine: GGS Bash stands in rather than failing the
        // terminal outright.
        let path = ggs_ext::process::resolve_engine_host("ggs-bash").map_err(|error| {
            format!("Git Bash was not found on this machine and GGS Bash is not available: {error}")
        })?;
        let mut command = CommandBuilder::new(&path);
        command.arg("-i");
        command.env("TERM", "xterm-256color");
        return Ok((command, "ggs-bash".to_owned()));
    }
    let mut command = CommandBuilder::new("powershell.exe");
    command.arg("-NoLogo");
    Ok((command, "powershell".to_owned()))
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

/// GGS-patch: one terminal-output chunk, carrying the tail of a multi-byte UTF-8
/// sequence that this read split (the kernel splits at arbitrary boundaries; a per-read
/// lossy decode rendered the split sequence as U+FFFD garbage — a CJK filename in `ls`,
/// a localized git message). `carry` keeps the tail bytes across calls; a final call
/// with an empty chunk flushes the tail lossily.
fn decode_pty_chunk(carry: &mut Vec<u8>, chunk: &[u8]) -> String {
    carry.extend_from_slice(chunk);
    let complete = match std::str::from_utf8(carry) {
        Ok(_) => carry.len(),
        Err(error) => error.valid_up_to(),
    };
    let payload = String::from_utf8_lossy(&carry[..complete]).into_owned();
    carry.drain(..complete);
    payload
}

#[cfg(test)]
mod tests {
    use super::{decode_pty_chunk, push_tail, shell_command, TAIL_BYTES};

    #[test]
    fn the_tail_keeps_the_newest_output_at_char_boundaries() {
        let tail = std::sync::Mutex::new(String::new());
        push_tail(&tail, "héllo ");
        push_tail(&tail, &"界".repeat(TAIL_BYTES));
        let kept = tail.lock().unwrap();
        assert!(kept.len() <= TAIL_BYTES);
        assert!(kept.ends_with("界"));
        assert!(kept.chars().all(|c| c == '界'));
    }

    #[test]
    fn the_default_shell_is_the_platform_one_and_the_bashes_are_windows_only() {
        if cfg!(windows) {
            let (.., name) = shell_command(None).unwrap();
            assert_eq!(name, "powershell");
            // GGS Bash resolves exactly where the extension backends find their
            // hosts: `GGS_ENGINE_HOST` is the test override.
            let host = tempfile::TempDir::new().unwrap();
            let binary = host.path().join("ggs-bash.exe");
            std::fs::write(&binary, b"").unwrap();
            std::env::set_var("GGS_ENGINE_HOST", host.path());
            let (_command, name) = shell_command(Some("ggsBash")).unwrap();
            assert_eq!(name, "ggs-bash");
            std::env::remove_var("GGS_ENGINE_HOST");
            // Without the override the sidecar still resolves in a build tree (cargo
            // test builds the bin beside the harness), and names itself.
            let (_command, name) = shell_command(Some("ggsBash")).unwrap();
            assert_eq!(name, "ggs-bash");
            // Git Bash opens when one is found on the machine, and where none is the
            // bundled GGS Bash stands in; only a machine with neither reports the
            // miss.
            match shell_command(Some("gitBash")) {
                Ok((.., name)) => assert!(name == "git-bash" || name == "ggs-bash", "{name}"),
                Err(error) => {
                    assert!(ggs_git::locate::find_git_bash().is_none());
                    assert!(error.contains("Git Bash was not found"), "{error}");
                }
            }
        } else {
            // Off Windows neither bash of the setting exists (2026-10-13, the
            // owner's direction): every choice opens the system's own shell.
            let (.., system) = shell_command(None).unwrap();
            for choice in ["ggsBash", "gitBash", "powershell"] {
                let (.., name) = shell_command(Some(choice)).unwrap();
                assert_eq!(name, system, "{choice} must open the system shell");
            }
        }
    }

    #[test]
    fn a_split_multibyte_sequence_decides_whole() {
        // "你" is three bytes; a kernel split after the first lands it in the next
        // chunk — the output must carry the whole character, no U+FFFD.
        let mut carry = Vec::new();
        let bytes = "你".as_bytes();
        let first = decode_pty_chunk(&mut carry, &bytes[..1]);
        assert_eq!(first, "", "the incomplete sequence holds");
        let second = decode_pty_chunk(&mut carry, &bytes[1..]);
        assert_eq!(second, "你");
        assert!(carry.is_empty());
    }

    #[test]
    fn a_trailing_incomplete_byte_stays_carried_for_the_stream_end_flush() {
        // The stream-end path (the reader loop's tail) flushes the carry lossily; the
        // decoder's job is to keep the incomplete byte out of the per-chunk output.
        let mut carry = Vec::new();
        let _ = decode_pty_chunk(&mut carry, "ok".as_bytes());
        let _ = decode_pty_chunk(&mut carry, &[0xF0]);
        assert_eq!(carry, vec![0xF0]);
        assert_eq!(String::from_utf8_lossy(&carry), "\u{FFFD}");
    }

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
