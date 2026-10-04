//! `child_process` over `std::process`: the spawn/spawnSync halves the prelude's
//! `child_process` module maps onto the Node API shapes.

use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use boa_engine::{Context, JsArgs, JsObject, JsResult, JsValue, NativeFunction};
use serde_json::{json, Value};

use super::support::*;
use crate::node_runtime::{children, key, native_callable, with_state, Job, ProcEntry};

/// The next child handle, unique across every runtime in the process.
static NEXT_PROC: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
/// How long a child's exit waits for its pipes to drain before it is reported anyway (see
/// the exit watcher in [`proc_spawn`]).
const READER_DRAIN: Duration = Duration::from_secs(2);

struct SpawnRequest {
    file: String,
    args: Vec<String>,
    cwd: Option<String>,
    env: Option<serde_json::Map<String, Value>>,
    shell: bool,
}

fn spawn_request(args: &[JsValue], context: &mut Context) -> JsResult<SpawnRequest> {
    let file = string_arg(args, 0, context);
    let args_list = string_array_arg(args, 1, context);
    let options_value = args.get_or_undefined(2).clone();
    let (cwd, env, shell) = match options_value.as_object() {
        None => (None, None, false),
        Some(options) => {
            let cwd = options
                .get(key("cwd"), context)?
                .as_string()
                .map(|s| s.to_std_string_escaped());
            let env = match options.get(key("env"), context)? {
                env if env.is_undefined() || env.is_null() => None,
                env => match crate::node_runtime::json_of(context, &env)
                    .ok()
                    .and_then(|json| json.as_object().cloned())
                {
                    Some(map) if !map.is_empty() => Some(map),
                    Some(_) => Some(serde_json::Map::new()),
                    None => None,
                },
            };
            let shell = options.get(key("shell"), context)?.to_boolean();
            (cwd, env, shell)
        }
    };
    Ok(SpawnRequest {
        file,
        args: args_list,
        cwd,
        env,
        shell,
    })
}

fn build_command(request: &SpawnRequest) -> Command {
    if request.shell {
        let combined = format!("{} {}", request.file, request.args.join(" "));
        let mut command = if cfg!(target_os = "windows") {
            let mut command = Command::new("cmd.exe");
            command.args(["/d", "/s", "/c", &combined]);
            command
        } else {
            let mut command = Command::new("/bin/sh");
            command.args(["-c", &combined]);
            command
        };
        apply_spawn_options(&mut command, request);
        return command;
    }
    let mut command = Command::new(&request.file);
    command.args(&request.args);
    apply_spawn_options(&mut command, request);
    command
}

fn apply_spawn_options(command: &mut Command, request: &SpawnRequest) {
    if let Some(cwd) = &request.cwd {
        command.current_dir(cwd);
    }
    if let Some(env) = &request.env {
        command.env_clear();
        for (key, value) in env {
            if let Value::String(value) = value {
                command.env(key, value);
            }
        }
    }
    #[cfg(windows)]
    {
        // Never flash a console window for a package's own children.
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
}

fn make_emitter(context: &mut Context) -> JsResult<JsObject> {
    let maker = context
        .global_object()
        .get(key("__ggsNewEmitter"), context)?
        .as_callable()
        .ok_or_else(|| error("the prelude's emitter maker is missing"))?;
    maker
        .call(&JsValue::undefined(), &[], context)?
        .as_object()
        .ok_or_else(|| error("the prelude's emitter maker did not answer an object"))
}

/// Node's readable-stream flow-control surface (`pause` / `resume` / `destroy`), chainable
/// like the real streams. Extension code calls these without checking — the hex scan drains
/// a child's stderr through `resume()` — and on a bare emitter that call died with a
/// TypeError, which silently ate the scan and left the binary comparison "analysing" forever.
fn stream_chainable(
    this: &JsValue,
    _args: &[JsValue],
    _context: &mut Context,
) -> JsResult<JsValue> {
    Ok(this.clone())
}

fn attach_readable_stream(stream: &JsObject, context: &mut Context) -> JsResult<()> {
    for name in ["pause", "resume", "destroy"] {
        let function = native_callable(
            context,
            name,
            boa_engine::NativeFunction::from_fn_ptr(stream_chainable),
        );
        stream.set(key(name), function, false, context)?;
    }
    Ok(())
}

/// `spawn(file, args, options)`: a real child process, its stdout/stderr piped through
/// reader threads back into the JS thread as `data` events, its exit as `exit`/`close`.
/// The returned object IS an `EventEmitter` (so `.on` works) with `pid`, `stdout`,
/// `stderr`, `stdin` and `kill` attached.
pub(super) fn proc_spawn(
    _this: &JsValue,
    args: &[JsValue],
    context: &mut Context,
) -> JsResult<JsValue> {
    let request = spawn_request(args, context)?;
    let mut command = build_command(&request);
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|e| error(format!("spawn {}: {e}", request.file)))?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let stdin = child.stdin.take();
    let pid = child.id();

    let emitter = make_emitter(context)?;
    let stdout_stream = make_emitter(context)?;
    let stderr_stream = make_emitter(context)?;
    attach_readable_stream(&stdout_stream, context)?;
    attach_readable_stream(&stderr_stream, context)?;

    let child = Arc::new(Mutex::new(child));
    let handle = with_state(|state| {
        // Process-wide, like the CHILDREN table the watchers share: two runtimes in one
        // process (the integration tests) must never reuse each other's handle.
        let handle = NEXT_PROC.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        state.procs.insert(
            handle,
            ProcEntry {
                child: Arc::clone(&child),
                stdin: stdin.map(Mutex::new),
                emitter: Some(emitter.clone().into()),
                stdout: Some(stdout_stream.clone().into()),
                stderr: Some(stderr_stream.clone().into()),
            },
        );
        handle
    });
    children().lock().unwrap().insert(handle, child);

    // The pipe readers: bytes cross as jobs; the JS thread shapes them into `data` events.
    fn pump_reader<S: std::io::Read + Send + 'static>(
        stream: u8,
        source: S,
        handle: u64,
        pump: crate::node_runtime::Pump,
    ) -> std::thread::JoinHandle<()> {
        std::thread::spawn(move || {
            let mut reader = source;
            let mut buffer = [0u8; 8192];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(read) => pump.send_job(Job::ProcData {
                        handle,
                        stream,
                        bytes: buffer[..read].to_vec(),
                    }),
                }
            }
        })
    }
    let mut readers = Vec::new();
    if let Some(source) = stdout {
        readers.push(pump_reader(
            0,
            source,
            handle,
            with_state(|state| state.pump()),
        ));
    }
    if let Some(source) = stderr {
        readers.push(pump_reader(
            1,
            source,
            handle,
            with_state(|state| state.pump()),
        ));
    }
    // The exit watcher polls the child through the process-wide table (the only thing a
    // foreign thread can reach): reap and report; the JS thread answers the events.
    {
        let pump = with_state(|state| state.pump());
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_millis(50));
            let finished = children()
                .lock()
                .unwrap()
                .get(&handle)
                .and_then(|child| child.lock().ok())
                .and_then(|mut child| child.try_wait().ok())
                .flatten();
            if let Some(status) = finished {
                let _ = children().lock().unwrap().remove(&handle);
                // Every byte first: the readers end at the pipes' EOF, and only then may the
                // exit cross. Sent from racing threads, the exit could overtake the output —
                // `proc_exit` retires the handle, so the late `data` was dropped and a fast
                // command (`git --version`) read as empty.
                // Bounded, though: a grandchild that inherited the pipes (a CLI's MCP
                // server, git's credential helper) holds them open after the child is
                // gone, and an unbounded join never sent the exit at all — the awaiting
                // extension hung forever where Node reports the exit at once. Past the
                // drain window the exit crosses and the readers detach.
                let drained_by = std::time::Instant::now() + READER_DRAIN;
                while readers.iter().any(|reader| !reader.is_finished())
                    && std::time::Instant::now() < drained_by
                {
                    std::thread::sleep(Duration::from_millis(10));
                }
                for reader in std::mem::take(&mut readers) {
                    if reader.is_finished() {
                        let _ = reader.join();
                    }
                }
                pump.send_job(Job::ProcExit {
                    handle,
                    code: status.code(),
                });
                break;
            }
        });
    }

    emitter.set(key("__ggsProcHandle"), handle as f64, false, context)?;
    emitter.set(key("pid"), pid, false, context)?;
    emitter.set(key("stdout"), stdout_stream, false, context)?;
    emitter.set(key("stderr"), stderr_stream, false, context)?;
    emitter.set(key("stdin"), stdin_object(handle, context)?, false, context)?;
    emitter.set(
        key("kill"),
        native_callable(
            context,
            "kill",
            NativeFunction::from_fn_ptr(proc_kill_method),
        ),
        false,
        context,
    )?;
    Ok(emitter.into())
}

fn stdin_object(handle: u64, context: &mut Context) -> JsResult<JsObject> {
    let object = JsObject::with_object_proto(context.intrinsics());
    object.set(
        key("write"),
        native_callable(
            context,
            "write",
            NativeFunction::from_fn_ptr(proc_stdin_write_method),
        ),
        false,
        context,
    )?;
    object.set(
        key("end"),
        native_callable(
            context,
            "end",
            NativeFunction::from_fn_ptr(proc_stdin_end_method),
        ),
        false,
        context,
    )?;
    object.set(key("__ggsProcHandle"), handle as f64, false, context)?;
    Ok(object)
}

fn proc_kill_method(this: &JsValue, _args: &[JsValue], context: &mut Context) -> JsResult<JsValue> {
    let handle = this
        .as_object()
        .and_then(|object| object.get(key("__ggsProcHandle"), context).ok())
        .and_then(|value| value.as_number())
        .unwrap_or(0.0) as u64;
    with_state(|state| state.kill_proc(handle));
    Ok(JsValue::undefined())
}

fn proc_stdin_write_method(
    this: &JsValue,
    args: &[JsValue],
    context: &mut Context,
) -> JsResult<JsValue> {
    let handle = this
        .as_object()
        .and_then(|object| object.get(key("__ggsProcHandle"), context).ok())
        .and_then(|value| value.as_number())
        .unwrap_or(0.0) as u64;
    let payload = if let Some(bytes) = bytes_arg(args.get_or_undefined(0), context) {
        bytes
    } else {
        string_arg(args, 0, context).into_bytes()
    };
    with_state(|state| state.write_stdin(handle, &payload)).map_err(error)?;
    Ok(JsValue::undefined())
}

fn proc_stdin_end_method(
    this: &JsValue,
    _args: &[JsValue],
    context: &mut Context,
) -> JsResult<JsValue> {
    let handle = this
        .as_object()
        .and_then(|object| object.get(key("__ggsProcHandle"), context).ok())
        .and_then(|value| value.as_number())
        .unwrap_or(0.0) as u64;
    with_state(|state| state.close_stdin(handle));
    Ok(JsValue::undefined())
}

/// `spawnSync(file, args, options)`: run to completion, answer
/// `{ status, stdoutBytes, stderrBytes, error }` (the prelude shapes the Buffers).
pub(super) fn proc_spawn_sync(
    _this: &JsValue,
    args: &[JsValue],
    context: &mut Context,
) -> JsResult<JsValue> {
    let request = spawn_request(args, context)?;
    let mut command = build_command(&request);
    command.stdin(Stdio::null());
    let output = command
        .output()
        .map_err(|e| error(format!("spawnSync {}: {e}", request.file)))?;
    let result = json!({
        "status": output.status.code(),
        "signal": Value::Null,
        "stdoutBytes": output.stdout,
        "stderrBytes": output.stderr,
        "error": Value::Null,
    });
    JsValue::from_json(&result, context)
}
