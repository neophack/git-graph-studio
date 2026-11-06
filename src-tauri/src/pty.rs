//! The built-in terminal: a portable-pty (ConPTY on Windows) session per terminal tab, its
//! output streamed to the frontend as Tauri events, its input arriving as plain commands.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use tauri::{AppHandle as TauriAppHandle, Emitter, Manager};



struct PtySession {
    /// Distinguishes this session from an earlier one created under the same frontend id: the
    /// reader thread only removes the map entry while it still owns that generation.
    gen: u64,
    /// The shell's name ([`pty_list`]'s answer to another frontend adopting this session).
    name: String,
    /// The session's current size: only a resize that CHANGES it re-broadcasts
    /// `studio://pty-resized-{id}` — a same-size echo from a frontend following the event
    /// back must stay silent, or the two frontends would ping-pong resizes forever.
    cols: u16,
    rows: u16,
    writer: Box<dyn Write + Send>,
    child: Box<dyn portable_pty::Child + Send>,
    /// Kept alive here: dropping the master closes the ConPTY, and a resize needs it.
    master: Box<dyn portable_pty::MasterPty + Send>,
    /// The last [`TAIL_BYTES`] of output: what a second frontend attaching to this terminal
    /// (a remote session, docs/ggs-remote-plan.md §8.6 #5) replays before it follows live.
    tail: std::sync::Arc<Mutex<String>>,
}

impl PtySession {
    /// Adopt a new size; answers whether it actually changed (the resize broadcast's gate).
    fn set_size(&mut self, cols: u16, rows: u16) -> bool {
        size_changed(&mut self.cols, &mut self.rows, cols, rows)
    }
}

/// One live terminal as `pty_list` answers it — the vocabulary of the session sync every
/// frontend's terminal page runs (docs/ggs-remote-plan.md §8.6 #5): the remote's terminal
/// page adopts the PC's terminals instead of spawning its own beside them.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtySessionInfo {
    pub id: u32,
    pub name: String,
}

/// The payload of `studio://pty-resized-{id}`: the session's new size, so every frontend
/// showing the terminal deforms with it (a shared terminal, one geometry).
#[derive(Clone, serde::Serialize)]
struct PtyResize {
    cols: u16,
    rows: u16,
}

/// The resize-broadcast gate: whether adopting `(new_cols, new_rows)` changes the tracked
/// size — only a real change re-broadcasts `studio://pty-resized-{id}`, so a frontend
/// echoing the event back as a same-size resize stays silent (no ping-pong).
fn size_changed(cols: &mut u16, rows: &mut u16, new_cols: u16, new_rows: u16) -> bool {
    if *cols == new_cols && *rows == new_rows {
        return false;
    }
    *cols = new_cols;
    *rows = new_rows;
    true
}

/// Announce the session set changed — a terminal appeared or died. Every frontend holding
/// a terminal page re-lists and adopts or retires sessions (the sync is pull-based: the
/// event carries no payload, [`pty_list`] after it is the truth).
fn emit_sessions_changed(app: &TauriAppHandle) {
    let _ = app.emit("studio://pty-sessions-changed", ());
}

/// How much recent output each terminal keeps for late joiners.
pub const TAIL_BYTES: usize = 64 * 1024;

/// How long the output coalescer gathers further reads into one event before emitting.
/// Under one frame — next to the Relay webview's own 16 ms per-session batching, invisible.
const OUTPUT_COALESCE: std::time::Duration = std::time::Duration::from_millis(8);
/// Gathered output past this emits at once instead of waiting out the coalesce window.
const OUTPUT_FLUSH_BYTES: usize = 32 * 1024;

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

/// Spawn the shell in the open repository (the session's working directory), or in
/// `cwd` when it names an existing folder — the Explorer's "Open in Integrated
/// Terminal". `shell` is the Terminal Shell setting's value (`"gitBash"` the default,
/// `"ggsBash"` and `"powershell"` the alternatives); every new terminal re-reads it, so
/// a Settings change reaches the next terminal without a restart.
#[tauri::command]
pub fn pty_create(
    app: TauriAppHandle,
    id: u32,
    cols: u16,
    rows: u16,
    shell: Option<String>,
    cwd: Option<String>,
) -> Result<String, String> {
    let workspace = app
        .state::<ggs_base::workspace::WorkspaceRoots>()
        .first()
        .or_else(|| {
            std::env::current_dir()
                .ok()
                .map(|p| p.display().to_string())
        })
        .unwrap_or_else(|| ".".to_string());
    let cwd = resolve_cwd(cwd.as_deref(), &workspace);

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
    let replaced;
    {
        let mut sessions = state.lock().unwrap();
        replaced = sessions.sessions.remove(&id);
        sessions.sessions.insert(
            id,
            PtySession {
                gen,
                name: shell_name.clone(),
                cols,
                rows,
                writer,
                child,
                master: pair.master,
                tail,
            },
        );
    }
    if let Some(mut old) = replaced {
        std::thread::spawn(move || close_session(&mut old));
    }
    // Another frontend's terminal page adopts this session on the announcement (§8.6 #5).
    emit_sessions_changed(&app);

    // Drain the session on its own thread, forwarding output as events; exit ends the
    // stream. The path batches before it emits: a read loop emitting per 8 KiB read turns
    // a chatty command (cargo build, npm install) into thousands of broadcast events a
    // second, and on macOS every broadcast emit is an evaluateJavaScript in EVERY webview
    // on the main thread — the whole UI, relay included, pays for the terminal's noise.
    // The reader stays as tight as ever; a coalescer behind a channel gathers what the
    // next few milliseconds bring (or [`OUTPUT_FLUSH_BYTES`], whichever comes first) into
    // one event. Order is preserved end to end: one channel, one coalescer, and the exit
    // follows the last gathered bytes because the reader's end drops the sender only
    // after its final read.
    let event_app = app.clone();
    let (out_tx, out_rx) = std::sync::mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if out_tx.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
            }
        }
    });
    std::thread::spawn(move || {
        let event_name = format!("studio://pty-output-{id}");
        let mut pending: Vec<u8> = Vec::new();
        let mut carry: Vec<u8> = Vec::new();
        let mut quiet = true;
        while gather_batch(&out_rx, &mut pending, &mut quiet) {
            let payload = decode_pty_chunk(&mut carry, &pending);
            if !payload.is_empty() {
                push_tail(&reader_tail, &payload);
                let _ = event_app.emit(event_name.as_str(), payload);
            }
            pending.clear();
        }
        if !carry.is_empty() {
            // Stream end: whatever incomplete sequence remains is terminal damage —
            // flush it lossily (one U+FFFD) rather than dropping it.
            let tail = String::from_utf8_lossy(&carry).into_owned();
            let _ = event_app.emit(event_name.as_str(), tail);
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
                drop(sessions);
                // The exit event above retires the frontends' own copies; the session-set
                // change retires a terminal page that never held this one (§8.6 #5).
                emit_sessions_changed(&event_app);
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
    // A same-size call (a frontend echoing the event back) resizes nothing and broadcasts
    // nothing; a real change rides the master AND every other frontend showing the
    // terminal (§8.6 #5: the attacher's viewport governs, the creator deforms along).
    let changed = with_session(&app, id, |session| {
        if !session.set_size(cols, rows) {
            return Ok(false);
        }
        session
            .master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("Could not resize the terminal: {e}"))?;
        Ok(true)
    })?;
    if changed {
        let _ = app.emit(
            format!("studio://pty-resized-{id}").as_str(),
            PtyResize { cols, rows },
        );
    }
    Ok(())
}

/// The live terminals (a frontend attaching to an instance lists the terminals it can
/// join — §8.6 #5): the session-sync vocabulary, in list order.
#[tauri::command]
pub fn pty_list(app: TauriAppHandle) -> Vec<PtySessionInfo> {
    let state = app.state::<Mutex<PtyState>>();
    let mut sessions: Vec<PtySessionInfo> = state
        .lock()
        .unwrap()
        .sessions
        .iter()
        .map(|(id, session)| PtySessionInfo {
            id: *id,
            name: session.name.clone(),
        })
        .collect();
    sessions.sort_by_key(|info| info.id);
    sessions
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

/// Gather one output batch from the reader's channel into `pending`: the first chunk
/// blocks (the stream is quiet), the rest ride the coalesce window until it goes quiet
/// again or the batch is big enough to flush. Answers false once the stream ended and
/// nothing more will come.
/// One output batch. `quiet` carries the gap state across batches: the FIRST chunk
/// after a quiet gap leaves at once (the interactive case — a key's echo never waits
/// the window; whatever already queues behind it rides along), and while the stream
/// stays chatty the window keeps gathering as before — a `cargo build` still crosses
/// as far fewer broadcast events. A window that expires with nothing behind it puts
/// the stream back to quiet, so the next burst's head leads again.
fn gather_batch(
    rx: &std::sync::mpsc::Receiver<Vec<u8>>,
    pending: &mut Vec<u8>,
    quiet: &mut bool,
) -> bool {
    match rx.recv() {
        Ok(chunk) => pending.extend_from_slice(&chunk),
        Err(_) => return false,
    }
    let mut gathered = false;
    while pending.len() < OUTPUT_FLUSH_BYTES {
        let chunk = if *quiet && !gathered {
            // Leading edge: nothing is waiting behind the head yet — probe, don't wait.
            rx.try_recv().ok()
        } else {
            rx.recv_timeout(OUTPUT_COALESCE).ok()
        };
        match chunk {
            Some(chunk) => {
                pending.extend_from_slice(&chunk);
                gathered = true;
            }
            None => break,
        }
    }
    // Chunks behind the head mean the stream is busy — the next batch gathers behind
    // the window again; a lone head stays interactive.
    *quiet = !gathered;
    true
}

/// The session's working directory: the requested folder when it exists (the Explorer's
/// "Open in Integrated Terminal"), else the open workspace unchanged — the plain
/// new-terminal behavior this command always had.
fn resolve_cwd(requested: Option<&str>, workspace: &str) -> String {
    match requested {
        Some(folder) if std::fs::metadata(folder).map(|m| m.is_dir()).unwrap_or(false) => {
            folder.to_string()
        }
        _ => workspace.to_string(),
    }
}

/// How long a close waits for the polite exit to land before the hard kill.
const CLOSE_GRACE: std::time::Duration = std::time::Duration::from_millis(1500);

/// Close a session politely: an `exit` on the shell's stdin lets an interactive shell run
/// its own exit path — Git Bash flushes `~/.bash_history`, PowerShell's PSReadLine flushes
/// its history, GGS Bash flushes its own — where a bare kill loses all of it (the command
/// history of every closed terminal, gone since the first build). A busy command leaves
/// the `exit` queued behind it; [`CLOSE_GRACE`] bounds the wait, the kill ends it, and a
/// bounded poll past the kill reaps the child — the signal crosses asynchronously, so a
/// `try_wait` the instant after the kill returned can still answer "running", and the
/// contract "returns with the child reaped" holds once the poll has seen the exit. The
/// poll is bounded, never a blocking wait: the session's reader thread must keep
/// draining the master for the shell to exit at all on macOS (its tty layer holds a
/// slave's close until the output queue is empty — a shell nobody reads wedges inside
/// its own exit, past SIGKILL, and a blocking wait parked the test thread for 47 minutes
/// on CI), and a drain that died must not park this thread forever behind it. The reader
/// thread announces the exit to the frontends exactly as before.
fn close_session(session: &mut PtySession) {
    let _ = session.writer.write_all(b"exit\r");
    let _ = session.writer.flush();
    let deadline = std::time::Instant::now() + CLOSE_GRACE;
    loop {
        match session.child.try_wait() {
            Ok(Some(_)) | Err(_) => return,
            Ok(None) if std::time::Instant::now() >= deadline => break,
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(20)),
        }
    }
    let _ = session.child.kill();
    // A SIGKILLed child answers its wait in milliseconds; the poll is the reaping, and
    // its bound is the backstop, not the expectation.
    let reaping = std::time::Instant::now() + CLOSE_GRACE;
    loop {
        match session.child.try_wait() {
            Ok(Some(_)) | Err(_) => return,
            Ok(None) if std::time::Instant::now() >= reaping => return,
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(20)),
        }
    }
}

/// Kill the shell (the "trash" action): politely first — an interactive shell writes its
/// command history on its own exit — then hard past the grace. The reader thread notices
/// the exit and emits it.
#[tauri::command]
pub fn pty_kill(app: TauriAppHandle, id: u32) -> Result<(), String> {
    let session = {
        let state = app.state::<Mutex<PtyState>>();
        let mut guard = state.lock().unwrap();
        guard.sessions.remove(&id)
    };
    if let Some(mut session) = session {
        emit_sessions_changed(&app);
        // Off the command: the close waits out the shell's own exit, and the caller —
        // often a page already unloading — answers at once.
        std::thread::spawn(move || close_session(&mut session));
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
        let path = ggs_base::sidecar::resolve_host("ggs-bash")
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
        let path = ggs_base::sidecar::resolve_host("ggs-bash").map_err(|error| {
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
/// with an empty chunk flushes the tail lossily. A hard-invalid byte (binary output
/// through the terminal) is never held: it leaves as one U+FFFD, because holding it
/// would wedge the decoder with every later byte piling up behind.
fn decode_pty_chunk(carry: &mut Vec<u8>, chunk: &[u8]) -> String {
    carry.extend_from_slice(chunk);
    let mut payload = String::new();
    loop {
        let (complete, invalid) = match std::str::from_utf8(carry) {
            Ok(_) => (carry.len(), 0),
            Err(error) => match error.error_len() {
                None => (error.valid_up_to(), 0),
                Some(len) => (error.valid_up_to(), len),
            },
        };
        payload.push_str(&String::from_utf8_lossy(&carry[..complete]));
        carry.drain(..complete + invalid);
        if invalid == 0 {
            return payload;
        }
        payload.push('\u{FFFD}');
    }
}

#[cfg(test)]
mod tests {
    use super::{close_session, decode_pty_chunk, gather_batch, push_tail, resolve_cwd, shell_command, size_changed, PtySession, TAIL_BYTES};

    #[test]
    fn a_same_size_resize_is_no_change_and_a_real_one_is() {
        // The broadcast gate (§8.6 #5): a frontend echoing `pty-resized` back as a resize
        // of the size it just adopted must not answer "changed" — the two frontends would
        // ping-pong the event forever. Only a genuinely different size does.
        let mut cols = 80u16;
        let mut rows = 24u16;
        assert!(size_changed(&mut cols, &mut rows, 100, 30));
        assert_eq!((cols, rows), (100, 30));
        assert!(!size_changed(&mut cols, &mut rows, 100, 30));
        // One dimension differing is still a real resize.
        assert!(size_changed(&mut cols, &mut rows, 100, 24));
        assert_eq!((cols, rows), (100, 24));
        assert!(size_changed(&mut cols, &mut rows, 80, 24));
        assert_eq!((cols, rows), (80, 24));
    }

    #[test]
    fn a_burst_of_small_reads_crosses_as_far_fewer_batches() {
        // The coalescer's whole point (see the reader thread): a shell that answers one
        // read per token must not become one broadcast event per read. A burst that
        // lands within the coalesce window gathers into fewer batches — and the stream
        // end still delivers whatever remains. Asserting "far fewer", not an exact
        // count, keeps the test honest under a loaded machine.
        let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
        const CHUNKS: usize = 200;
        for i in 0..CHUNKS {
            tx.send(format!("line {i}\n").into_bytes()).unwrap();
        }
        drop(tx);
        let mut batches = 0;
        let mut bytes = Vec::new();
        let mut pending = Vec::new();
        let mut quiet = true;
        while gather_batch(&rx, &mut pending, &mut quiet) {
            batches += 1;
            bytes.append(&mut pending);
            pending.clear();
        }
        assert!(batches < CHUNKS / 4, "{batches} batches for {CHUNKS} reads");
        let text = String::from_utf8(bytes).unwrap();
        assert_eq!(text.lines().count(), CHUNKS);
        assert!(text.ends_with("line 199\n"));
    }

    #[test]
    fn a_quiet_stream_still_delivers_each_chunk() {
        // No burst, just two reads spaced past the coalesce window: each is its own
        // batch, nothing coalesced away and nothing held back.
        let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
        tx.send(b"first".to_vec()).unwrap();
        let mut pending = Vec::new();
        let mut quiet = true;
        assert!(gather_batch(&rx, &mut pending, &mut quiet));
        assert_eq!(pending, b"first");
        pending.clear();
        std::thread::sleep(super::OUTPUT_COALESCE * 2);
        tx.send(b"second".to_vec()).unwrap();
        assert!(gather_batch(&rx, &mut pending, &mut quiet));
        assert_eq!(pending, b"second");
        drop(tx);
        assert!(!gather_batch(&rx, &mut pending, &mut quiet));
    }

    #[test]
    fn a_quiet_streams_first_chunk_leaves_without_waiting_the_window() {
        // The leading edge (the 2026-10-16 response-latency pass): after a quiet gap the
        // head emits at once instead of gathering behind the 8 ms window. Prove it by
        // racing: the gather thread reports it started (the head was queued before it),
        // the follower is sent 2 ms later — inside the old 8 ms window (which would have
        // swallowed it into the head's batch), far behind the new leading edge (which
        // has already left with the head alone). The start signal keeps the race
        // scheduling-free: no sleep has to guess when the thread begins.
        let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
        let (started_tx, started_rx) = std::sync::mpsc::channel::<()>();
        let (batch_tx, batch_rx) = std::sync::mpsc::channel::<Vec<u8>>();
        tx.send(b"echo".to_vec()).unwrap();
        let gather = std::thread::spawn(move || {
            started_tx.send(()).unwrap();
            let mut pending = Vec::new();
            let mut quiet = true;
            while gather_batch(&rx, &mut pending, &mut quiet) {
                batch_tx.send(pending.clone()).unwrap();
                pending.clear();
            }
        });
        started_rx.recv().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(2));
        tx.send(b"later".to_vec()).unwrap();
        drop(tx);
        gather.join().unwrap();
        let mut batches: Vec<Vec<u8>> = Vec::new();
        while let Ok(batch) = batch_rx.recv() {
            batches.push(batch);
        }
        assert_eq!(batches, vec![b"echo".to_vec(), b"later".to_vec()]);
    }

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

    #[test]
    fn a_stray_invalid_byte_never_wedges_the_decoder() {
        // Binary output through the terminal (a `cat` of a binary, a stray continuation
        // byte) is a hard-invalid sequence, not an incomplete tail: before the
        // error_len() branch it stuck at the carry's head forever — every later chunk
        // joined it and nothing was emitted again.
        let mut carry = Vec::new();
        let first = decode_pty_chunk(&mut carry, &[b'a', 0x80, b'b']);
        assert_eq!(first, "a\u{FFFD}b");
        let second = decode_pty_chunk(&mut carry, "still alive 你".as_bytes());
        assert_eq!(second, "still alive 你");
        assert!(carry.is_empty());
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
        assert!(status.is_none(),
            "the shell exited: {status:?}; output: {output:?}"
        );
        assert!(!output.is_empty(), "no prompt arrived");
        let _ = child.kill();
    }

    #[test]
    fn the_spawn_cwd_is_the_requested_folder_when_it_exists_and_the_workspace_otherwise() {
        // "Open in Integrated Terminal" names the folder; a path the disk lost (a deleted
        // directory, another machine's drive) falls back to the open workspace unchanged —
        // the plain new-terminal behavior.
        let workspace = tempfile::TempDir::new().unwrap();
        let folder = tempfile::TempDir::new().unwrap();
        let ws = workspace.path().to_str().unwrap().to_owned();
        let folder = folder.path().to_str().unwrap().to_owned();
        let file = folder.clone() + "/plain.txt";
        std::fs::write(&file, b"").unwrap();
        assert_eq!(resolve_cwd(Some(&folder), &ws), folder);
        assert_eq!(resolve_cwd(None, &ws), ws);
        assert_eq!(resolve_cwd(Some("Z:\\no-such-folder-ggs"), &ws), ws);
        // A file is not a folder: the workspace stands in.
        assert_eq!(resolve_cwd(Some(&file), &ws), ws);
    }

    #[test]
    fn the_polite_close_lands_the_shell_dead_within_its_grace() {
        // Every shell closes through close_session now: the `exit` lets an interactive
        // shell run its own exit path (the command history's flush), the kill is the
        // backstop. Either way the session's child is reaped and the function returns.
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
        let child = pair.slave.spawn_command(command).unwrap();
        drop(pair.slave);
        let writer = pair.master.take_writer().unwrap();
        // The master is drained for the shell's whole life, as the session's reader
        // thread drains it in production: macOS's tty layer holds a slave's close until
        // its output queue is empty, so a shell whose prompt and echoed `exit` nobody
        // reads wedges inside its own exit — past the polite `exit`, past SIGHUP, past
        // SIGKILL (already exiting, it has nothing left to deliver to) — and no wait
        // ever reaps it. Linux discards the queue on close and never showed it.
        let mut reader = pair.master.try_clone_reader().unwrap();
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            while !matches!(reader.read(&mut buf), Ok(0) | Err(_)) {}
        });
        let mut session = PtySession {
            gen: 0,
            name: "test".to_owned(),
            cols: 80,
            rows: 24,
            writer,
            child,
            master: pair.master,
            tail: std::sync::Arc::new(std::sync::Mutex::new(String::new())),
        };
        close_session(&mut session);
        let status = session.child.try_wait().unwrap();
        assert!(status.is_some(), "the shell outlived the close grace");
    }
}

