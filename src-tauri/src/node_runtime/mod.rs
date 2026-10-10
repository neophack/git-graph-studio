//! The pretend Node runtime (`ggs-node`): the app-bundled sidecar that runs a `ggs/2`
//! package's own JavaScript entry as its backend, so a VSIX that declares
//! `backend: { "kind": "node", "command": "out/main.js" }` runs — CommonJS `require`
//! ([`require`]) and the file/os/process builtins ([`builtins`]) layered by the JS prelude,
//! speaking `ggs-ext/1` on stdio like every other backend (`ext_protocol.rs`), so the
//! process host cannot tell it apart.
//!
//! This runtime needs nothing from the machine: the app never depends on, or spawns, a
//! system Node — every `node` backend hosts HERE, `.node` NAPI addons included (`require`
//! dispatches them to the N-API host, [`napi_host`], the `napi_*` surface bound to this
//! image). Only `GGS_REAL_NODE=1` opts a machine's own runtime in as the host instead
//! (nodeHost.ts, VS Code's own shape). The JS engine is
//! Boa, pure Rust (plan §3.1), and it runs one thread: protocol requests, timers and
//! child-process events all funnel through one job queue, so a package's code never races
//! itself.
//!
//! Dispatch, in order (the first that applies answers):
//! 1. the manifest's activity-bar launcher — the `{openPage}` convention every host speaks;
//! 2. the handler the package registered with `ggs.onRequest(fn)`;
//! 3. `module.exports.dispatch` / `.request` of the entry module.

pub mod alloc;
mod builtins;
mod esm;
mod napi_host;

/// Pull the N-API host's exported surface into a binary that would otherwise link none
/// of it (see `napi_host::force_link`); the export directives name symbols this keeps.
pub fn link_napi_host() {
    napi_host::force_link();
}
mod native;
mod require;

use std::cell::RefCell;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

use boa_engine::{Context, JsValue};
use serde_json::{json, Value};

use crate::ext_protocol::{self as proto, Emitter};

const PRELUDE: &str = include_str!("prelude.js");
/// How long a JS handler's returned promise may take to settle before the request fails.
const PROMISE_TIMEOUT: Duration = Duration::from_secs(30);
/// The same budget, overridable for diagnosis and tests: `GGS_PROMISE_TIMEOUT_SECS`. The
/// conformance probe's e2e section moves a sealed 256 KB tool result through sjcl on the
/// interpreter — ~35 s where real Node takes under one — so its test raises this; every
/// ordinary request keeps the default.
fn promise_timeout() -> Duration {
    std::env::var("GGS_PROMISE_TIMEOUT_SECS")
        .ok()
        .and_then(|text| text.parse::<u64>().ok())
        .filter(|secs| *secs > 0)
        .map(Duration::from_secs)
        .unwrap_or(PROMISE_TIMEOUT)
}
/// The no-timer idle wait: bounded so a missed wake cannot idle a request forever.
const IDLE_TICK: Duration = Duration::from_secs(30);
/// The JS thread's native stack. Boa's parser, compiler and several builtins recurse in
/// Rust once per nesting level of the source or the data; on the 2 MiB default thread a
/// hundred nested closures, two hundred nested parentheses or a 700-deep array handed to
/// `String()` overflowed it — and a stack overflow kills the process outright
/// (0xC00000FD), every request of the backend with it. The size is a reservation: only
/// the pages a deep recursion really touches are committed. The native stack guard
/// (`boa_engine::parser::stack_guard`, armed at the thread's top) turns what is still too
/// deep for this stack into an ordinary `RangeError` / `SyntaxError`.
const JS_THREAD_STACK: usize = 64 * 1024 * 1024;
/// The backend's own request ids start here. Both directions share the one channel, and the
/// app resolves a response line against whatever request it sent with that id — disjoint
/// id spaces are what keep a `host.env` answer from resolving the app's `initialize`.
const HOST_REQUEST_BASE: u64 = 1_000_000_000;
/// How long a `ggs.hostRequest` may wait for the workbench's answer.
const HOST_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// The outstanding `ggs.hostRequest`s of this backend, id → the reply channel the blocked
/// caller waits on. The reader thread routes response lines here.
type PendingHostRequests = Mutex<HashMap<u64, mpsc::Sender<Result<Value, String>>>>;

fn host_requests() -> &'static PendingHostRequests {
    static MAP: OnceLock<PendingHostRequests> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

fn next_host_request_id() -> u64 {
    static NEXT: std::sync::atomic::AtomicU64 =
        std::sync::atomic::AtomicU64::new(HOST_REQUEST_BASE);
    NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
}

/// Ask the workbench for something (`ggs.hostRequest`) and block until its answer crosses
/// back over the reader. Runs on the JS thread; the app's answer arrives on the reader
/// thread, so the wait cannot deadlock the loop it blocks.
pub(crate) fn host_request(emitter: &Emitter, method: &str, args: Value) -> Result<Value, String> {
    let id = next_host_request_id();
    let (tx, rx) = mpsc::channel();
    host_requests().lock().unwrap().insert(id, tx);
    emitter.request(
        id,
        "ggs.hostRequest",
        json!({ "method": method, "args": args }),
    );
    if std::env::var("GGS_TRACE_BOOT").is_ok() {
        eprintln!("[host-request] {method} ({id}) waiting");
    }
    let answer = rx.recv_timeout(HOST_REQUEST_TIMEOUT);
    if std::env::var("GGS_TRACE_BOOT").is_ok() {
        eprintln!("[host-request] {method} ({id}) woke: {}", answer.is_ok());
    }
    let _ = host_requests().lock().unwrap().remove(&id);
    answer.map_err(|_| "the workbench did not answer the host request".to_owned())?
}

/// A timer waiting for its deadline; the callback and its arguments live on the JS thread
/// only (a `JsObject` must never cross threads).
struct Timer {
    id: u64,
    at: Instant,
    interval: Option<Duration>,
    callable: JsValue,
    args: Vec<JsValue>,
}

/// One spawned child, held between spawn and exit. The `Child` sits behind an `Arc<Mutex>`
/// because the exit-watcher thread and a JS-side `kill` meet there — and the watcher's
/// handle lives in [`CHILDREN`], the process-wide table, since only that (not the JS
/// thread's thread-local state) is reachable from the watcher.
pub(crate) struct ProcEntry {
    pub child: Arc<Mutex<std::process::Child>>,
    pub stdin: Option<Mutex<std::process::ChildStdin>>,
    /// The child's own emitter and its two stream emitters (`data`/`end` targets).
    pub emitter: Option<JsValue>,
    pub stdout: Option<JsValue>,
    pub stderr: Option<JsValue>,
}

/// The watcher threads' view of the live children, keyed by handle. The JS thread inserts
/// at spawn; a watcher polls its child here and takes the entry out when it exits.
static CHILDREN: OnceLock<Mutex<HashMap<u64, Arc<Mutex<std::process::Child>>>>> = OnceLock::new();

pub(crate) fn children() -> &'static Mutex<HashMap<u64, Arc<Mutex<std::process::Child>>>> {
    CHILDREN.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The protocol job a pipe reader or the serve loop hands the JS thread.
pub(crate) enum Job {
    Request {
        method: String,
        params: Value,
        reply: mpsc::Sender<Result<Value, String>>,
        /// `initialize` (the first request, always) carries the protocol's writer so
        /// `ggs.log` reaches the host's log; everything after rides on it.
        emitter: Option<Emitter>,
    },
    ProcData {
        handle: u64,
        stream: u8,
        bytes: Vec<u8>,
    },
    ProcExit {
        handle: u64,
        code: Option<i32>,
    },
    /// An event of a native resource (a socket, a listener, a client request — see
    /// `builtins/net.rs`), routed by id to the prelude's `__ggsNativeEvent`.
    Native {
        id: u64,
        event: &'static str,
        data: Value,
        bytes: Option<Vec<u8>>,
    },
    /// The frame program's activation, detached from the `initialize` handshake: the
    /// handshake answers the moment the protocol loop can (a bundle's parse-and-compile
    /// is seconds on the interpreter — VS Code's own `onStartupFinished` runs after the
    /// window, not inside the host's greeting), and this job runs the shim install, the
    /// entry `require` and the `activate` call on this same JS thread. The queue is FIFO,
    /// so every request that arrives while the activation runs orders behind it — a
    /// command dispatched early waits for readiness exactly as a frame's does.
    ActivateFrame {
        params: Value,
    },
    Quit,
}

/// The cross-thread half of the runtime: a job sender plus the wake signal. Cloned into
/// the serve handler and every child-process reader thread.
pub(crate) struct Pump {
    queue: Mutex<mpsc::Sender<Job>>,
    wake: Arc<(Mutex<bool>, Condvar)>,
}

impl Clone for Pump {
    fn clone(&self) -> Self {
        Pump {
            queue: Mutex::new(self.queue.lock().unwrap().clone()),
            wake: Arc::clone(&self.wake),
        }
    }
}

impl Pump {
    pub(crate) fn send_job(&self, job: Job) {
        let _ = self.queue.lock().unwrap().send(job);
        self.wake();
    }

    pub(crate) fn wake(&self) {
        let (flag, condvar) = &*self.wake;
        if let Ok(mut flag) = flag.lock() {
            *flag = true;
        }
        condvar.notify_all();
    }
}

/// The runtime's whole state, owned by the JS thread (Boa values are not `Send`, so
/// everything that holds one lives here, reached through [`with_state`] by the natives).
pub(crate) struct State {
    pump: Pump,
    timers: Vec<Timer>,
    next_timer_id: u64,
    on_request: Option<JsValue>,
    on_workspace: Option<JsValue>,
    emitter: Option<Emitter>,
    package_root: PathBuf,
    launcher: Option<(String, String)>,
    module_cache: HashMap<PathBuf, JsValue>,
    /// The parsed ES-module records by path (builtins under their `ggs-builtin:` key) —
    /// `esm.rs`'s cache; Boa heap values, dropped with the rest of this state.
    esm_cache: HashMap<PathBuf, boa_engine::Module>,
    procs: HashMap<u64, ProcEntry>,
    main_exports: Option<JsValue>,
    /// The entry is a native addon (a `.node`): its `request` export speaks the NAPI
    /// convention — `request(method, paramsJson)` answering a JSON string — not the JS
    /// `(command, messageObject)` convention JS entries use. The dispatch adapts.
    native_entry: bool,
    /// The entry is a real VS Code extension `main` (it `require`s `vscode`): bootstrap
    /// evaluates the shim bundle and `initialize` installs the API, requires the entry and
    /// runs its activation — the package's own program, hosted.
    frame_program: bool,
    /// The installed `vscode` module (the shim's api), for `require('vscode')` and for the
    /// host-event pushes the dispatch routes into `handleHostEvent`.
    vscode_api: Option<JsValue>,
    /// The job queue's receiving end, behind the one lock the JS thread takes (it is the
    /// only receiver): [`settle`] drains child-process arrivals from it while a request
    /// holds the thread — the run loop that would deliver them cannot run.
    job_source: Option<Arc<Mutex<mpsc::Receiver<Job>>>>,
    /// The running activation's promise, parked by [`install_frame_program`] instead of a
    /// blocking settle: an `activate()` that never settles (kimi-code's login probe pends
    /// on the outside world) must not hold the one JS thread hostage. The run loop polls
    /// it; a command with no handler waits for it bounded (see [`run_command`]).
    pending_activation: Option<boa_engine::object::builtins::JsPromise>,
    /// Set once a command has waited the parked activation out to the settle budget and
    /// found it still pending: later commands dispatch at once instead of each paying the
    /// full budget again (the promise itself stays parked for the run loop's poll).
    activation_wait_spent: bool,
    /// The out-of-heap bytes (`alloc::large_live_bytes`) after the last collection the
    /// external pressure forced — the watermark [`collect_on_external_pressure`] paces from.
    external_baseline: usize,
}

thread_local! {
    static STATE: RefCell<Option<State>> = const { RefCell::new(None) };
}

/// Run `f` with the JS thread's state. Panics off it — which is exactly the guard wanted:
/// a native reaching the state from a foreign thread is a bug the runtime should not
/// survive quietly.
pub(crate) fn with_state<T>(f: impl FnOnce(&mut State) -> T) -> T {
    STATE.with(|slot| {
        f(slot
            .borrow_mut()
            .as_mut()
            .expect("the ggs-node state lives on the JS thread"))
    })
}

impl State {
    fn new(pump: Pump, package_root: PathBuf) -> Self {
        State {
            pump,
            timers: Vec::new(),
            next_timer_id: 0,
            on_request: None,
            on_workspace: None,
            emitter: None,
            package_root,
            launcher: None,
            module_cache: HashMap::new(),
            esm_cache: HashMap::new(),
            procs: HashMap::new(),
            main_exports: None,
            native_entry: false,
            frame_program: false,
            vscode_api: None,
            job_source: None,
            pending_activation: None,
            activation_wait_spent: false,
            external_baseline: 0,
        }
    }

    pub(crate) fn pump(&self) -> Pump {
        self.pump.clone()
    }

    /// One `$/log` line to the host — the only writing a builtin ever does (stdout is the
    /// protocol's).
    pub(crate) fn log(&self, level: &str, message: &str) {
        match &self.emitter {
            Some(emitter) => {
                emitter.notification("$/log", json!({ "level": level, "message": message }));
            }
            None => eprintln!("[ggs-node] {level}: {message}"),
        }
    }

    fn add_timer(
        &mut self,
        callable: JsValue,
        millis: f64,
        interval: Option<f64>,
        args: Vec<JsValue>,
    ) -> u64 {
        self.next_timer_id += 1;
        let id = self.next_timer_id;
        self.timers.push(Timer {
            id,
            at: Instant::now() + Duration::from_secs_f64(millis / 1000.0),
            interval: interval.map(|ms| Duration::from_secs_f64(ms / 1000.0)),
            callable,
            args,
        });
        id
    }

    fn cancel_timer(&mut self, id: u64) {
        self.timers.retain(|timer| timer.id != id);
    }

    fn next_deadline(&self) -> Option<Instant> {
        self.timers.iter().map(|timer| timer.at).min()
    }

    /// The due timers, intervals rescheduled in place; the rest stay.
    fn take_due_timers(&mut self, now: Instant) -> Vec<(JsValue, Vec<JsValue>)> {
        let mut due = Vec::new();
        let mut kept = Vec::new();
        for timer in std::mem::take(&mut self.timers) {
            if timer.at <= now {
                due.push((timer.callable.clone(), timer.args.clone()));
                if let Some(interval) = timer.interval {
                    let mut next = timer.at + interval;
                    while next <= now {
                        next += interval;
                    }
                    kept.push(Timer { at: next, ..timer });
                }
            } else {
                kept.push(timer);
            }
        }
        self.timers = kept;
        due
    }

    pub(crate) fn kill_proc(&mut self, handle: u64) {
        if let Some(entry) = self.procs.get(&handle) {
            if let Ok(mut child) = entry.child.lock() {
                let _ = child.kill();
            }
        }
    }

    pub(crate) fn write_stdin(&self, handle: u64, payload: &[u8]) -> Result<(), String> {
        let entry = self.procs.get(&handle).ok_or("no such child process")?;
        let mut stdin = entry
            .stdin
            .as_ref()
            .ok_or("the child's stdin is closed")?
            .lock()
            .unwrap();
        stdin
            .write_all(payload)
            .and_then(|_| stdin.flush())
            .map_err(|e| e.to_string())
    }

    pub(crate) fn close_stdin(&mut self, handle: u64) {
        if let Some(entry) = self.procs.get_mut(&handle) {
            entry.stdin = None;
        }
    }
}

use std::io::Write as _;

/* ---------- the Boa shorthands every file in this module shares ---------- */

/// Bytes as the 64-byte-aligned block an `ArrayBuffer` owns (Boa 0.21's backing store).
pub(crate) fn byte_block(bytes: Vec<u8>) -> boa_engine::builtins::array_buffer::AlignedVec<u8> {
    boa_engine::builtins::array_buffer::AlignedVec::from_slice(64, &bytes)
}

/// A property key from a plain string — Boa's keys are interned `JsString`s.
pub(crate) fn key(name: &str) -> boa_engine::property::PropertyKey {
    boa_engine::JsString::from(name).into()
}

/// A JS string value from a plain Rust string.
pub(crate) fn text(value: impl Into<String>) -> JsValue {
    JsValue::from(boa_engine::JsString::from(value.into().as_str()))
}

/// A named native function as a callable JS object — `NativeFunction` itself is not a
/// `JsValue`, so everything a module exports goes through a builder.
pub(crate) fn native_callable(
    context: &Context,
    name: &str,
    function: boa_engine::NativeFunction,
) -> boa_engine::JsObject {
    boa_engine::JsObject::from(
        boa_engine::object::FunctionObjectBuilder::new(context.realm(), function)
            .name(boa_engine::JsString::from(name))
            .build(),
    )
}

/* ---------- the process entry and the protocol loop ---------- */

/// The binary's entry (`src/bin/ggs_node.rs`): `ggs-node <entry.js>` runs the package's
/// main as its backend, over real stdio.
pub fn run() {
    // Parity with `ggs-ext/1`'s convention (`ext_process.rs`): a backend that keeps
    // per-instance state can tell two concurrently running windows apart.
    let instance = std::env::var("GGS_INSTANCE_ID").unwrap_or_default();
    eprintln!(
        "[ggs-node] starting (pid {}, instance {instance})",
        std::process::id()
    );
    let Some(entry) = std::env::args().nth(1).map(PathBuf::from) else {
        eprintln!("[ggs-node] usage: ggs-node <entry.js>");
        std::process::exit(2);
    };
    serve_on(
        entry,
        std::io::BufReader::new(std::io::stdin()),
        std::io::stdout(),
    );
    // The interpreter's instruction ranking (see boa-engine's opcode_stats), when asked for.
    boa_engine::vm::opcode_stats::print_totals();
    eprintln!("[ggs-node] stopped");
}

/// The runtime over an arbitrary reader/writer pair — the whole protocol loop, the JS
/// thread included, in-process. This is what the integration test drives.
pub fn serve_on<R: std::io::BufRead, W: std::io::Write + Send + 'static>(
    entry: PathBuf,
    reader: R,
    writer: W,
) {
    let (tx, rx) = mpsc::channel();
    let wake: Arc<(Mutex<bool>, Condvar)> = Arc::new((Mutex::new(false), Condvar::new()));
    let pump = Pump {
        queue: Mutex::new(tx),
        wake: Arc::clone(&wake),
    };
    let package_root = find_package_root(&entry);
    let js_pump = pump.clone();
    let serve_pump = pump.clone();
    let js_thread = std::thread::Builder::new()
        .name("ggs-node-js".to_owned())
        .stack_size(JS_THREAD_STACK)
        .spawn(move || {
            boa_engine::parser::stack_guard::arm(JS_THREAD_STACK);
            STATE.with(|slot| *slot.borrow_mut() = Some(State::new(js_pump, package_root)));
            js_main(rx, wake, entry);
            boa_engine::parser::stack_guard::disarm();
        })
        .expect("the ggs-node JS thread spawns");
    let responses_pump = pump.clone();
    proto::serve_plugin_on_with_responses(
        reader,
        writer,
        move |method, params, emitter| {
            let (reply_tx, reply_rx) = mpsc::channel();
            // `initialize` is the protocol's first request by construction; its emitter is the
            // one `ggs.log` writes through for the rest of the run.
            let carried = (method == "initialize").then(|| emitter.clone());
            serve_pump.send_job(Job::Request {
                method: method.to_owned(),
                params: params.clone(),
                reply: reply_tx,
                emitter: carried,
            });
            Some(reply_rx.recv().unwrap_or_else(|_| {
                // The reply sender died unanswered: a panic the run loop contained (logged
                // there), or a JS thread that is gone.
                Err(format!(
                    "the ggs-node runtime dropped {method} — a contained runtime fault or a stopped runtime (see the backend log)"
                ))
            }))
        },
        move |id, answer| {
            // An answer to this backend's own `ggs.hostRequest`: wake the JS thread that
            // blocked on it.
            if id >= HOST_REQUEST_BASE {
                if std::env::var("GGS_TRACE_BOOT").is_ok() {
                    eprintln!("[host-request] answer for {id} routed");
                }
                if let Some(tx) = host_requests().lock().unwrap().remove(&id) {
                    let _ = tx.send(answer);
                } else if std::env::var("GGS_TRACE_BOOT").is_ok() {
                    eprintln!("[host-request] answer for {id} had no waiter");
                }
                let _ = responses_pump;
            }
        },
    );
    pump.send_job(Job::Quit);
    let _ = js_thread.join();
}

/* ---------- the JS thread: bootstrap, then the one event loop ---------- */

fn js_main(rx: mpsc::Receiver<Job>, wake: Arc<(Mutex<bool>, Condvar)>, entry: PathBuf) {
    // This thread does all the heavy lifting (every parse, compile and run): its small
    // allocations skip the shared pool's lock (a no-op where `GgsAlloc` is not installed).
    alloc::enable_thread_cache();
    // The addons' threadsafe functions wake THIS loop: the handle is per JS thread.
    napi_host::set_wake(Arc::clone(&wake));
    let jobs = Arc::new(Mutex::new(rx));
    with_state(|state| state.job_source = Some(Arc::clone(&jobs)));
    // The module loader is Node's resolution over Boa's module machinery (`esm.rs`).
    let mut context = Context::builder()
        .module_loader(std::rc::Rc::new(esm::NodeModuleLoader))
        .build()
        .expect("a Boa context builds");
    // No AST optimizer: its one pass (constant folding) is a full extra walk over every
    // script's tree — a tenth of a multi-megabyte bundle's parse — to fold the literal
    // arithmetic a minifier already folded.
    context.set_optimizer_options(boa_engine::optimizer::OptimizerOptions::empty());
    if std::env::var("GGS_VM_TRACE").is_ok() {
        context.set_trace(true);
    }
    // Declared after the context, so it drops BEFORE it — on the normal exit and on an
    // unwind alike. The state's Boa values live in this context's heap and must die with
    // it, never in the TLS destructor that runs after this function is gone (dropping them
    // over a freed heap aborted the process intermittently).
    let _teardown = StateTeardown;
    let booted = contained(&mut context, "the bootstrap", |context| {
        bootstrap(context, &entry)
    });
    match booted {
        Some(Ok(())) => {}
        Some(Err(error)) => {
            with_state(|state| state.log("error", &format!("bootstrap failed: {error}")));
            // The backend must still answer its handshake (a failed preload is not a dead
            // backend); a bootstrap failure is a runtime defect, so serving nothing is right.
            return;
        }
        None => return,
    }
    // GGS-patch: every step below runs package code (a job, a timer callback, an addon
    // completion, a promise reaction, the activation's flush) and each runs under
    // `contained`. Only the queued jobs used to: a Rust panic inside a timer or a promise
    // job — Boa's compiler has edges (Kimi Code's chunk tripped "binding must exist"), a
    // native can trip an expect — unwound out of the JS thread, and the teardown that
    // followed dropped Boa values over a dead heap: the backend aborted. A contained
    // panic fails what it was running (a request answers an error) and the VM is put back
    // at its resting depth; the runtime keeps serving.
    loop {
        // 1. Everything queued.
        let mut quit = false;
        while let Some(job) = next_job(&jobs) {
            if contained(&mut context, "a runtime job", |context| {
                execute_job(context, job)
            }) == Some(true)
            {
                quit = true;
            }
        }
        if quit {
            break;
        }
        // 2. Due timers, each its own step: one throwing or panicking callback does not
        //    skip the others that fell due with it.
        let due = with_state(|state| state.take_due_timers(Instant::now()));
        for (callable, args) in due {
            if let Some(object) = callable.as_object() {
                contained(&mut context, "a timer callback", |context| {
                    let _ = object.call(&JsValue::undefined(), &args, context);
                });
            }
        }
        // 3. Threadsafe-function arrivals (an addon's async completions, queued from its
        //    worker threads and woken here): delivered before the microtasks they settle.
        contained(&mut context, "a native addon completion", |context| {
            napi_host::drain_threadsafe_calls(context);
        });
        // 4. Settled promise jobs (microtasks).
        contained(&mut context, "a promise job", |context| {
            let _ = context.run_jobs();
        });
        // 4½. The parked activation promise (see `install_frame_program`): its settlement
        //     runs the registration flush; a rejection is logged. A pending one stays.
        contained(&mut context, "the activation poll", poll_activation);
        // 5. Idle housekeeping (the queue was drained above): a large module's parse tree,
        //    parked by the compiler so tearing it down — millions of frees — never delayed
        //    the module's first run. A no-op when nothing is parked.
        contained(&mut context, "the parse-tree release", |_| {
            boa_engine::script::free_released_sources();
        });
        // 5½. Out-of-heap pressure: collect when the strings and buffers the JS heap holds
        //     have grown, even though the heap's own boxes have not (see the function).
        contained(&mut context, "the external-pressure collection", |_| {
            collect_on_external_pressure();
        });
        // 6. Sleep until a job, a timer deadline, or the idle tick.
        let deadline = with_state(|state| state.next_deadline());
        let (flag, condvar) = &*wake;
        let mut guard = flag.lock().unwrap();
        // A job that arrives without its wake is taken here, and must still run: dropping
        // it would drop its reply channel and fail the request as a stopped runtime.
        let mut arrived = None;
        loop {
            if *guard {
                *guard = false;
                break;
            }
            if let Some(job) = next_job(&jobs) {
                arrived = Some(job);
                break;
            }
            let timeout = deadline
                .map(|at| at.saturating_duration_since(Instant::now()))
                .unwrap_or(IDLE_TICK);
            let (next_guard, waited) = condvar.wait_timeout(guard, timeout).unwrap();
            guard = next_guard;
            if waited.timed_out() {
                break;
            }
        }
        drop(guard);
        if let Some(job) = arrived {
            if contained(&mut context, "a runtime job", |context| {
                execute_job(context, job)
            }) == Some(true)
            {
                break;
            }
        }
    }
    // `_teardown` drops the state here, before the context — and so do a live child
    // process's waiters: `Quit` means the backend is going away either way.
}

/// The out-of-heap growth that forces a collection even when the baseline is small.
const EXTERNAL_PRESSURE_FLOOR: usize = 64 * 1024 * 1024;

/// Collect the JS heap when the memory it holds OUTSIDE itself has grown. Boa paces its
/// collector by the bytes of its own boxes, and a box is small while what it holds is not:
/// a ~200-byte promise pinning an 80 K-character commit list counts as 200 bytes, so a
/// git-graph session's results, or claude-code's message payloads, piled up by the
/// gigabyte before the box count reached the next collection — and on a machine near its
/// commit limit the next refused allocation aborted the backend (0xC0000409). This is
/// V8's external-memory accounting in miniature: the global allocator counts the live
/// large blocks (`alloc::large_live_bytes`), and once they grow by half their post-
/// collection watermark (at least [`EXTERNAL_PRESSURE_FLOOR`]) the heap is collected and
/// the watermark re-read. A no-op where `GgsAlloc` is not installed (the count stays 0).
fn collect_on_external_pressure() {
    let live = alloc::large_live_bytes();
    let Some(baseline) = STATE.with(|slot| {
        slot.try_borrow_mut().ok().and_then(|mut state| {
            let state = state.as_mut()?;
            // Memory released by refcount lowers the watermark with it.
            if live < state.external_baseline {
                state.external_baseline = live;
            }
            Some(state.external_baseline)
        })
    }) else {
        return;
    };
    let step = (baseline / 2).max(EXTERNAL_PRESSURE_FLOOR);
    if live < baseline.saturating_add(step) {
        return;
    }
    boa_engine::gc::force_collect();
    let after = alloc::large_live_bytes();
    STATE.with(|slot| {
        if let Ok(mut state) = slot.try_borrow_mut() {
            if let Some(state) = state.as_mut() {
                state.external_baseline = after;
            }
        }
    });
    if std::env::var("GGS_TRACE_BOOT").is_ok() {
        eprintln!(
            "[gc] external pressure: {} MiB live out of the heap, {} MiB after the collection",
            live >> 20,
            after >> 20
        );
    }
}

/// Drops the JS thread's state when `js_main` leaves, however it leaves (see its use).
struct StateTeardown;

impl Drop for StateTeardown {
    fn drop(&mut self) {
        drop_js_state();
    }
}

/// A panic payload as text — the `&str` / `String` a `panic!` carries, or a placeholder.
pub(crate) fn panic_message(payload: &(dyn std::any::Any + Send)) -> String {
    payload
        .downcast_ref::<&str>()
        .map(|text| (*text).to_owned())
        .or_else(|| payload.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "a non-text panic payload".to_owned())
}

/// Run one step of the JS thread with a Rust panic contained: the step's work is lost
/// (a request it was answering fails — its reply sender drops unanswered), the VM goes
/// back to the depth it had before the step, the N-API arena releases what the step's
/// abandoned callbacks created, and the runtime goes on serving. `None` means the step
/// panicked.
fn contained<T>(
    context: &mut Context,
    what: &str,
    step: impl FnOnce(&mut Context) -> T,
) -> Option<T> {
    let checkpoint = context.vm_checkpoint();
    let handles = napi_host::handle_mark();
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| step(context))) {
        Ok(value) => Some(value),
        Err(payload) => {
            context.unwind_vm_to(checkpoint);
            napi_host::release_handles_to(handles);
            let message = panic_message(payload.as_ref());
            // The state is reachable unless the panic was its own teardown.
            let logged = STATE.with(|slot| {
                slot.try_borrow()
                    .map(|state| {
                        if let Some(state) = state.as_ref() {
                            state.log(
                                "error",
                                &format!(
                                    "{what} panicked ({message}); its work failed and the runtime recovered"
                                ),
                            );
                            true
                        } else {
                            false
                        }
                    })
                    .unwrap_or(false)
            });
            if !logged {
                eprintln!("[ggs-node] {what} panicked ({message})");
            }
            None
        }
    }
}

/// Take one queued job. The queue lock is released before the job runs: a `while let` over
/// `jobs.lock().unwrap().try_recv()` keeps the guard alive through the loop body, and a
/// request that pumps the queue while it waits (`deliver_child_jobs`) then deadlocks the
/// JS thread on its own lock.
fn next_job(jobs: &Mutex<mpsc::Receiver<Job>>) -> Option<Job> {
    jobs.lock().unwrap().try_recv().ok()
}

/// Drop the JS thread's state, on the JS thread, while the context is still alive.
fn drop_js_state() {
    STATE.with(|slot| *slot.borrow_mut() = None);
    napi_host::release_thread_env();
}

fn execute_job(context: &mut Context, job: Job) -> bool {
    match job {
        Job::Quit => true,
        Job::Request {
            method,
            params,
            reply,
            emitter,
        } => {
            if let Some(emitter) = emitter {
                with_state(|state| state.emitter = Some(emitter));
            }
            let _ = reply.send(handle_request(context, &method, &params));
            false
        }
        Job::ProcData {
            handle,
            stream,
            bytes,
        } => {
            proc_data(context, handle, stream, bytes);
            false
        }
        Job::ProcExit { handle, code } => {
            proc_exit(context, handle, code);
            false
        }
        Job::ActivateFrame { params } => {
            // A failed activation no longer fails a handshake that already answered:
            // the failure surfaces through the extension host log instead (the emitter
            // the initialize request carried is live by now), the shape VS Code's own
            // async activations take.
            if let Err(error) = install_frame_program(context, &params) {
                with_state(|state| state.log("error", &format!("activation failed: {error}")));
            }
            false
        }
        Job::Native {
            id,
            event,
            data,
            bytes,
        } => {
            native_event(context, id, event, &data, bytes);
            false
        }
    }
}

/// Register the natives, run the prelude, then `require` the package's entry — best
/// effort: a failed preload is logged and the backend stays up (its default dispatch and
/// its `.node`s remain servable).
/// GGS-patch: Node's own `main` resolution (2026-10-01). A VSIX's `package.json` `main`
/// is frequently extension-less — `./out/extension` meaning `out/extension.js` — and
/// VS Code loads those exactly as Node loads a directory's main: try the path as given,
/// then with the JavaScript extensions, then its `index.js`. Without this the bare
/// path failed the first file read, the entry fell back to the non-frame-program
/// CommonJS route (no `vscode` shim), and the package reported "cannot find module" —
/// a whole class of popular extensions (`vscodevim.vim`, `todo-tree`,
/// `indent-rainbow`, …) never even activated. Resolved once, at bootstrap, before the
/// frame-program detection reads the file.
fn resolve_entry(entry: &Path) -> PathBuf {
    if entry.is_file() {
        return entry.to_path_buf();
    }
    let mut candidates: Vec<PathBuf> = vec![];
    let as_string = entry.to_string_lossy().to_string();
    for extension in ["js", "cjs", "mjs", "node"] {
        candidates.push(PathBuf::from(format!("{as_string}.{extension}")));
    }
    candidates.push(entry.join("index.js"));
    candidates.push(entry.join("index.cjs"));
    candidates
        .into_iter()
        .find(|candidate| candidate.is_file())
        .unwrap_or_else(|| entry.to_path_buf())
}

fn bootstrap(context: &mut Context, entry: &Path) -> Result<(), String> {
    builtins::register_natives(context).map_err(|e| e.to_string())?;
    napi_host::install(context as *mut Context);
    // The prelude is declarations-free (IIFEs and `globalThis` assignments), so it rides
    // the module bytecode cache like any bundle: parse and compile once per machine, a
    // blob read on every start (see `require::evaluate_cached_script`).
    require::evaluate_cached_script("prelude", PRELUDE, context)
        .map_err(|e| format!("the prelude failed: {e}"))?;
    // A VS Code extension's main is a real frame program: it `require`s 'vscode' and runs
    // on the API. Only the fact is established here — the shim bundle's evaluation waits
    // for the activation job (`initialize`'s), so a handshake that must turn around in
    // milliseconds never pays it. Without the shim bundle on disk the activation job logs
    // the honest skip.
    // Both module systems count: `require('vscode')` and an ES module's
    // `import … from "vscode"` (prettier-vscode's `main` is ESM).
    let entry = resolve_entry(entry);
    let frame_program = std::fs::read_to_string(&entry)
        .map(|source| {
            source.contains("require(\"vscode\")")
                || source.contains("require('vscode')")
                || source.contains("from \"vscode\"")
                || source.contains("from 'vscode'")
        })
        .unwrap_or(false);
    if frame_program {
        with_state(|state| state.frame_program = true);
        return Ok(());
    }
    let specifier = entry.display().to_string();
    let parent = entry
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));
    if entry.extension().and_then(|e| e.to_str()) == Some("node") {
        with_state(|state| state.native_entry = true);
    }
    match require::require(&parent, &specifier, context) {
        Ok(exports) => {
            if let Some(exports) = exports.as_object() {
                with_state(|state| state.main_exports = Some(exports.clone().into()));
            }
            Ok(())
        }
        Err(error) => {
            with_state(|state| {
                state.log("warn", &format!("the entry module did not load: {error}"))
            });
            Ok(())
        }
    }
}

/// The compiled `vscode` shim for frame programs: `GGS_VSCODE_SHIM` first, then beside the
/// app's own binary and the dev target layouts (`target/studio/`, where `prepare.mjs`
/// writes it next to `node-host.cjs`; `debug/deps/` for the cargo test binary).
fn find_vscode_shim() -> Option<PathBuf> {
    if let Ok(named) = std::env::var("GGS_VSCODE_SHIM") {
        let path = PathBuf::from(named);
        if path.is_file() {
            return Some(path);
        }
    }
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    [
        dir.join("vscode-shim.cjs"),
        dir.join("..").join("vscode-shim.cjs"),
        dir.join("..").join("..").join("vscode-shim.cjs"),
        dir.join("..").join("..").join("..").join("vscode-shim.cjs"),
        dir.join("..")
            .join("..")
            .join("..")
            .join("bundled")
            .join("app-resources")
            .join("vscode-shim.cjs"),
    ]
    .into_iter()
    .find(|candidate| candidate.is_file())
}

/* ---------- the protocol's three methods ---------- */

fn handle_request(context: &mut Context, method: &str, params: &Value) -> Result<Value, String> {
    match method {
        // The start handshake carries the app's open folders: they become `ggs.env`, the
        // package root moves to the extension path the host names, and the manifest's
        // launcher becomes the command list — engine-host parity throughout.
        "initialize" => {
            with_state(|state| {
                if let Some(path) = params.get("extensionPath").and_then(Value::as_str) {
                    let path = PathBuf::from(path);
                    if path.is_dir() {
                        state.package_root = path;
                    }
                }
                state.launcher = read_launcher(&state.package_root);
            });
            merge_env(context, params);
            // A frame program activates as the very next job, not inside the handshake: a
            // real bundle's parse-and-compile is seconds on the interpreter, and the
            // handshake — the app's `ext_process_start`, the Extensions view's status —
            // answers in the time the protocol loop needs to turn around. The single JS
            // thread keeps every later request ordered behind the activation (FIFO), so a
            // command that beats readiness waits for it, never races it.
            let frame_program = with_state(|state| state.frame_program);
            if frame_program {
                let pump = with_state(|state| state.pump());
                pump.send_job(Job::ActivateFrame {
                    params: params.clone(),
                });
            }
            let (launcher, package_root) = with_state(|state| {
                (
                    state.launcher.as_ref().map(|(command, _)| command.clone()),
                    state.package_root.clone(),
                )
            });
            let mut commands: Vec<String> = launcher.into_iter().collect();
            for command in contributed_commands(&package_root) {
                if !commands.contains(&command) {
                    commands.push(command);
                }
            }
            Ok(json!({
                "protocolVersion": proto::PROTOCOL_VERSION,
                "capabilities": { "commands": commands }
            }))
        }
        // The app's report of its open folders — a request by the wire's shape, answered
        // null (the response is dropped) and turned into the JS-side event.
        "workspaceChanged" => {
            merge_env(
                context,
                &json!({ "workspaceFolders": params.get("folders").cloned().unwrap_or(Value::Null) }),
            );
            let handler = with_state(|state| state.on_workspace.clone());
            if let Some(handler) = handler.and_then(|value| value.as_object()) {
                let folders =
                    JsValue::from_json(params.get("folders").unwrap_or(&Value::Null), context)
                        .map_err(|e| e.to_string())?;
                let _ = handler.call(&JsValue::undefined(), &[folders], context);
            }
            Ok(Value::Null)
        }
        // The one RPC verb: dispatch order documented at the module head.
        "runCommand" => {
            let command = params
                .get("command")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            let args = params.get("args").cloned().unwrap_or_else(|| json!([]));
            run_command(context, &command, &args)
        }
        // A host push (theme, configuration, webview messages, watcher batches): the same
        // event objects a frame's `__studioExtEvent` carries, into the shim's emitters.
        "ggs.hostEvent" => {
            let api = with_state(|state| state.vscode_api.clone());
            if let Some(api) = api.and_then(|value| value.as_object()) {
                if let Ok(handler) = api.get(key("handleHostEvent"), context) {
                    if let Some(handler) = handler.as_object() {
                        let event =
                            JsValue::from_json(params, context).map_err(|e| e.to_string())?;
                        let _ = handler.call(&JsValue::undefined(), &[event], context);
                    }
                }
            }
            Ok(Value::Null)
        }
        // Any other method is host vocabulary the shim's dispatcher serves — a content
        // provider's `docProvider.provide` above all: the host asks the registering
        // extension for a provider-scheme document's text when a diff or a content tab
        // renders it. The same dispatch a frame's mailbox runs, with the method as the
        // command name and the params' `args` as the arguments.
        other => {
            let args = params.get("args").cloned().unwrap_or_else(|| json!([]));
            run_command(context, other, &args)
        }
    }
}

/// Install the hosted frame program — the activation job the (already answered) handshake
/// queued: the compiled shim bundle evaluates first (deferred from bootstrap so the
/// handshake stays milliseconds), the shim installer builds the `vscode` API around the
/// blocking host-request bridge, the entry `require`s `vscode` from it, and its `activate`
/// runs to settlement — the package's own program, hosted.
fn install_frame_program(context: &mut Context, params: &Value) -> Result<(), String> {
    let trace = std::env::var("GGS_TRACE_BOOT").is_ok();
    match find_vscode_shim().map(|path| std::fs::read_to_string(&path)) {
        Some(Ok(source)) => {
            if trace {
                eprintln!(
                    "[boot] evaluating the vscode shim bundle ({} bytes)",
                    source.len()
                );
            }
            // The shim is a strict-mode IIFE with no top-level declarations — the
            // bytecode cache applies (see `require::evaluate_cached_script`).
            require::evaluate_cached_script("vscode-shim", &source, context)
                .map_err(|e| format!("the vscode shim failed: {e}"))?;
        }
        Some(Err(e)) => {
            return Err(format!("the vscode shim is unreadable ({e})"));
        }
        None => {
            return Err(
                "the entry is a workbench frame program and no vscode shim ships with this host"
                    .to_owned(),
            );
        }
    }
    let extension_id = params
        .get("extensionId")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_owned();
    let extension_path = with_state(|state| state.package_root.display().to_string());
    let folders: Vec<String> = params
        .get("workspaceFolders")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    let global = context.global_object().clone();
    let install = global
        .get(key("__ggsVscodeShimInstall"), context)
        .map_err(|e| e.to_string())?
        .as_object()
        .ok_or("the vscode shim exposes no installer")?
        .clone();
    let args = JsValue::from_json(
        &json!({
            "extensionId": extension_id,
            "extensionPath": extension_path,
            "workspaceFolders": folders,
        }),
        context,
    )
    .map_err(|e| e.to_string())?;
    let installed = install
        .call(&JsValue::undefined(), &[args], context)
        .map_err(|e| e.to_string())?;
    if trace {
        eprintln!("[boot] the shim install call returned");
    }
    let installed = settle(context, installed).map_err(|e| e.to_string())?;
    if trace {
        eprintln!("[boot] the shim install settled");
    }
    let Some(installed) = installed.as_object() else {
        return Err("the vscode shim installer answered nothing".to_owned());
    };
    let api = installed
        .get(key("api"), context)
        .map_err(|e| e.to_string())?;
    with_state(|state| state.vscode_api = Some(api.clone()));
    let package_root = with_state(|state| state.package_root.display().to_string());
    let entry = PathBuf::from(&package_root)
        .join(find_entry(&package_root))
        .display()
        .to_string();
    let parent = PathBuf::from(&package_root);
    let exports = require::require(&parent, &entry, context).map_err(|e| e.to_string())?;
    if trace {
        eprintln!("[boot] the entry module loaded");
    }
    let activate = installed
        .get(key("activate"), context)
        .map_err(|e| e.to_string())?;
    let Some(activate) = activate.as_object() else {
        return Err("the vscode shim exposes no activate".to_owned());
    };
    let exports_value = exports.clone();
    let settled = activate
        .call(&JsValue::undefined(), &[exports_value], context)
        .map_err(|e| e.to_string())?;
    if trace {
        eprintln!("[boot] the activate call returned");
    }
    // GGS-patch: the activation promise is PARKED, not settled inline. settle() held the
    // one JS thread until the promise settled — an `activate()` that never does (kimi-code's
    // awaits its login probe, which pends without the outside world) starved every later
    // request into timeouts. VS Code's own policy: the host keeps serving while activate()
    // runs. The run loop polls the promise (see `poll_activation`); a command that finds no
    // handler waits for it bounded (see `run_command`).
    let promise = boa_engine::object::builtins::JsPromise::from_result(
        Ok::<_, boa_engine::JsError>(settled),
        context,
    );
    if trace {
        eprintln!("[boot] activation promise parked");
    }
    // Whatever the activation's synchronous part registered crosses now: a promise that
    // never settles would otherwise keep its commands queued in the shim forever.
    flush_registrations(context);
    with_state(|state| state.pending_activation = Some(promise));
    Ok(())
}

/// Poll the parked activation promise. Registrations queued since the last pass cross
/// either way — a pending activation keeps registering as its awaits resolve, and VS Code
/// makes every command live the moment `registerCommand` returns. A rejection is logged
/// like a failed activation (what it registered before throwing stays, as in VS Code); a
/// settled promise leaves the slot.
fn poll_activation(context: &mut Context) {
    let Some(promise) = with_state(|state| state.pending_activation.take()) else {
        return;
    };
    flush_registrations(context);
    match promise.state() {
        boa_engine::builtins::promise::PromiseState::Pending => {
            with_state(|state| state.pending_activation = Some(promise));
        }
        boa_engine::builtins::promise::PromiseState::Fulfilled(_) => {}
        boa_engine::builtins::promise::PromiseState::Rejected(reason) => {
            let message = reason
                .to_string(context)
                .map(|text| text.to_std_string_escaped())
                .unwrap_or_else(|_| "the activation rejected".to_owned());
            with_state(|state| state.log("error", &format!("activation failed: {message}")));
        }
    }
}

/// The queued command registrations cross as one batch (`commands.registerBatch`): the
/// flush hook the API layer left on globalThis. It runs when `activate()` returns and on
/// every run-loop pass while the activation is parked — one batch per pass, not one pipe
/// round trip per `registerCommand` — and a pass with nothing queued sends nothing.
fn flush_registrations(context: &mut Context) {
    if let Ok(flush) = context
        .global_object()
        .get(key("__ggsFlushRegistrations"), context)
    {
        if let Some(flush) = flush.as_object() {
            let _ = flush.call(&JsValue::undefined(), &[], context);
        }
    }
}

/// Wait out the parked activation, bounded like every handler promise: driven by the same
/// pump [`settle`] runs (timers, threadsafe calls, child jobs), so an activation awaiting
/// the outside world still reaches its settle. A rejection is consumed (logged by the
/// poll); a timeout leaves the promise parked — its later settlement must still flush — and
/// spends the wait, so the next command does not block for the budget again.
fn wait_out_activation(context: &mut Context) {
    let Some(promise) = with_state(|state| {
        if state.activation_wait_spent {
            None
        } else {
            state.pending_activation.clone()
        }
    }) else {
        return;
    };
    let _ = settle(context, promise.clone().into());
    if matches!(
        promise.state(),
        boa_engine::builtins::promise::PromiseState::Pending
    ) {
        with_state(|state| {
            state.activation_wait_spent = true;
            state.log(
                "warn",
                "the activation has not settled within the wait budget; commands now dispatch without waiting for it",
            );
        });
    }
    poll_activation(context);
}

/// The package's entry specifier the way Node resolves it: `package.json`'s `main`, with
/// the extensionless spelling gaining `.js`.
fn find_entry(package_root: &str) -> String {
    let manifest = std::fs::read_to_string(Path::new(package_root).join("package.json"))
        .map(|text| serde_json::from_str::<Value>(&text).unwrap_or(Value::Null))
        .unwrap_or(Value::Null);
    manifest
        .get("main")
        .and_then(Value::as_str)
        .map(|main| main.trim_start_matches("./").to_owned())
        .unwrap_or_else(|| "index.js".to_owned())
}

/// Merge a JSON object into the `ggs.env` object the prelude built (mutating, never
/// replacing — a package that captured `ggs.env` early still sees the workspace arrive).
fn merge_env(context: &mut Context, params: &Value) {
    let ggs = match context.global_object().get(key("ggs"), context) {
        Ok(ggs) => ggs,
        Err(_) => return,
    };
    let Some(ggs) = ggs.as_object() else {
        return;
    };
    let env = match ggs.get(key("env"), context) {
        Ok(env) => env,
        Err(_) => return,
    };
    let Some(env) = env.as_object() else {
        return;
    };
    let Some(entries) = params.as_object() else {
        return;
    };
    for (key, value) in entries {
        let Ok(js_value) = JsValue::from_json(value, context) else {
            continue;
        };
        let _ = env.set(
            boa_engine::JsString::from(key.as_str()),
            js_value,
            false,
            context,
        );
    }
}

/// The manifest's activity-bar launcher: `(command, page)` — the one command convention
/// every host answers, read from the installed package beside its entry.
fn read_launcher(package_root: &Path) -> Option<(String, String)> {
    let manifest: Value =
        serde_json::from_str(&std::fs::read_to_string(package_root.join("manifest.json")).ok()?)
            .ok()?;
    let launcher = manifest.get("activitybar")?;
    Some((
        launcher.get("command")?.as_str()?.to_owned(),
        launcher.get("page")?.as_str()?.to_owned(),
    ))
}

/// The package's standard `contributes.commands` ids — the command surface the handshake
/// reports (no Studio-specific manifest field needed). Empty when package.json is absent
/// or unreadable: the report is informational, the workbench routes by the manifest.
fn contributed_commands(package_root: &Path) -> Vec<String> {
    let Ok(text) = std::fs::read_to_string(package_root.join("package.json")) else {
        return Vec::new();
    };
    let Ok(manifest) = serde_json::from_str::<Value>(&text) else {
        return Vec::new();
    };
    manifest
        .pointer("/contributes/commands")
        .and_then(Value::as_array)
        .map(|declared| {
            declared
                .iter()
                .filter_map(|entry| entry.get("command").and_then(Value::as_str))
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

fn run_command(context: &mut Context, command: &str, args: &Value) -> Result<Value, String> {
    let args = args.as_array().cloned().unwrap_or_default();

    // 1. The launcher convention: the manifest's command opens the page it names.
    if let Some((declared, page)) = with_state(|state| state.launcher.clone()) {
        if declared == command {
            let params = args
                .first()
                .cloned()
                .filter(|value| !value.is_null())
                .unwrap_or_else(|| json!({}));
            return Ok(json!({ "openPage": page, "params": params }));
        }
    }

    // 2. The registered handler: `ggs.onRequest(fn)` — the package's own code answering.
    let handler = with_state(|state| state.on_request.clone());
    if let Some(handler) = handler.and_then(|value| value.as_object()) {
        let call = |context: &mut Context| -> Result<JsValue, String> {
            let args_value = JsValue::from_json(&Value::Array(args.clone()), context)
                .map_err(|e| e.to_string())?;
            handler
                .call(&JsValue::undefined(), &[text(command), args_value], context)
                .map_err(|e| e.to_string())
        };
        // GGS-patch: a command that lands while the activation is still parked and finds
        // no handler waits the activation out (bounded) and dispatches once more — the
        // handler may be registered by an `await` still in flight. A command whose
        // handler is already live never waits: an activation that never settles
        // (kimi-code's) must not hold every command hostage (see `install_frame_program`).
        let result = match call(context) {
            Err(message)
                if message.contains(&format!("no handler registered for {command}"))
                    && with_state(|state| {
                        state.pending_activation.is_some() && !state.activation_wait_spent
                    }) =>
            {
                wait_out_activation(context);
                call(context)?
            }
            other => other?,
        };
        let settled = settle(context, result)?;
        return js_to_json(context, settled);
    }

    // 4. The entry module's own `dispatch` / `request` export: `(command, message)`. A
    //    native-addon entry (the engine `.node`) speaks the NAPI convention —
    //    `request(method, paramsJson)` answering a JSON string — and the process host's
    //    `runCommand` envelope (`{command, args: [params]}`) names one engine method to
    //    translate onto it: `loadCommits` minus its `command` field is the params.
    let main_exports = with_state(|state| state.main_exports.clone());
    let native_entry = with_state(|state| state.native_entry);
    if native_entry {
        if let Some(exports) = main_exports.as_ref().and_then(|value| value.as_object()) {
            if let Ok(function) = exports.get(key("request"), context) {
                if let Some(function) = function.as_object() {
                    let mut method = command.to_string();
                    let mut params = args.first().cloned().unwrap_or(Value::Null);
                    if command == "runCommand" {
                        if let Some(payload) = params.get("command").and_then(Value::as_str) {
                            method = payload.to_string();
                            if let Some(object) = params.as_object_mut() {
                                object.remove("command");
                            }
                        }
                    }
                    // The addon's `request(repo, envelopeJson)` convention: the repo (empty
                    // for engine-level calls) first, then the whole
                    // `{method, params}` envelope as a JSON string.
                    let repo_arg = params
                        .get("repo")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    let envelope = json!({ "method": method, "params": params }).to_string();
                    let result = function
                        .call(
                            &JsValue::undefined(),
                            &[text(repo_arg), text(envelope)],
                            context,
                        )
                        .map_err(|e| e.to_string())?;
                    let settled = settle(context, result)?;
                    if let Some(string) = settled.as_string() {
                        let parsed: Value = serde_json::from_str(&string.to_std_string_escaped())
                            .unwrap_or(Value::Null);
                        return Ok(parsed);
                    }
                    return js_to_json(context, settled);
                }
            }
        }
    }
    if let Some(exports) = main_exports.and_then(|value| value.as_object()) {
        for name in ["dispatch", "request"] {
            let Ok(function) = exports.get(key(name), context) else {
                continue;
            };
            let Some(function) = function.as_object() else {
                continue;
            };
            let command_value = text(command);
            let message = args.first().cloned().unwrap_or(Value::Null);
            let message_value = JsValue::from_json(&message, context).map_err(|e| e.to_string())?;
            let result = function
                .call(
                    &JsValue::undefined(),
                    &[command_value, message_value],
                    context,
                )
                .map_err(|e| e.to_string())?;
            let settled = settle(context, result)?;
            return js_to_json(context, settled);
        }
    }

    // 3. Nothing answered: the honest failure, naming the surfaces this host serves. A
    //    package's `.node` loads right here (the N-API host — `native.rs` +
    //    `napi_host.rs`); what cannot answer is a package whose backend commands have no
    //    handler registered. The real-Node host (nodeHost.ts, `GGS_REAL_NODE=1`) serves
    //    the same protocol when the opt-in is set.
    Err(format!(
        "no handler registered for {command} (ggs.onRequest or module.exports.dispatch          answers backend commands)"
    ))
}

/// Deliver the child-process arrivals queued while a request holds the JS thread (see
/// [`settle`]); requests and quit orders go back on the queue for the run loop.
fn deliver_child_jobs(context: &mut Context) {
    let source = with_state(|state| state.job_source.clone());
    let Some(source) = source else {
        return;
    };
    let mut backlog = Vec::new();
    // Take the arrivals first, then run them with the lock released: `proc_data` runs the
    // package's JS, which may settle a nested request that pumps this same queue.
    let arrived: Vec<Job> = {
        let Ok(queue) = source.lock() else {
            return;
        };
        std::iter::from_fn(|| queue.try_recv().ok()).collect()
    };
    for job in arrived {
        match job {
            Job::ProcData {
                handle,
                stream,
                bytes,
            } => proc_data(context, handle, stream, bytes),
            Job::ProcExit { handle, code } => proc_exit(context, handle, code),
            Job::Native {
                id,
                event,
                data,
                bytes,
            } => native_event(context, id, event, &data, bytes),
            other => backlog.push(other),
        }
    }
    if !backlog.is_empty() {
        with_state(|state| {
            for job in backlog {
                state.pump().send_job(job);
            }
        });
    }
}

/// Settle a handler result: a plain value passes through; a thenable is adopted into a
/// promise and pumped (microtasks and timers) until it settles or the timeout says the
/// handler never will.
pub(crate) fn settle(context: &mut Context, value: JsValue) -> Result<JsValue, String> {
    let thenable = value
        .as_object()
        .map(|object| {
            object
                .get(key("then"), context)
                .map(|then| then.is_callable())
                .unwrap_or(false)
        })
        .unwrap_or(false);
    if !thenable {
        return Ok(value);
    }
    let promise = boa_engine::object::builtins::JsPromise::from_result(
        Ok::<JsValue, boa_engine::JsError>(value),
        context,
    );
    let timeout = promise_timeout();
    let deadline = Instant::now() + timeout;
    let trace = std::env::var("GGS_TRACE_BOOT").is_ok();
    let mut waited = 0usize;
    loop {
        if trace && waited.is_multiple_of(50) {
            eprintln!("[settle] pending (iteration {waited})");
        }
        waited += 1;
        match promise.state() {
            boa_engine::builtins::promise::PromiseState::Pending => {
                if Instant::now() > deadline {
                    return Err(format!(
                        "the handler's promise did not settle within {} s",
                        timeout.as_secs()
                    ));
                }
                // The event loop is blocked inside this request, so its timer step never
                // runs: fire whatever fell due, then settle microtasks and yield.
                let now = Instant::now();
                let due = with_state(|state| state.take_due_timers(now));
                if trace && !due.is_empty() {
                    eprintln!("[settle] {} timer(s) due", due.len());
                }
                for (callable, args) in due {
                    if let Some(object) = callable.as_object() {
                        if trace {
                            eprintln!("[settle] firing a timer");
                        }
                        let _ = object.call(&JsValue::undefined(), &args, context);
                        if trace {
                            eprintln!("[settle] the timer returned");
                        }
                    }
                }
                // Likewise the addon completions: a NAPI async export settles only when
                // its threadsafe call is delivered, and the loop's own drain step cannot
                // run while this request holds the thread.
                if trace {
                    eprintln!("[settle] draining tsfn");
                }
                napi_host::drain_threadsafe_calls(context);
                if trace {
                    eprintln!("[settle] draining child jobs");
                }
                // And likewise the child processes: an activation that spawns (the git
                // extension's `git --version` probe) awaits events only this loop would
                // deliver. Child arrivals are delivered here; anything else goes back on
                // the queue for the loop, after this request finishes.
                deliver_child_jobs(context);
                if trace {
                    eprintln!("[settle] running jobs");
                }
                let _ = context.run_jobs();
                // A long request (an activation, a big engine read) may allocate far more
                // out of the heap than the run loop's idle pass ever sees.
                collect_on_external_pressure();
                if trace {
                    eprintln!("[settle] sleeping");
                }
                std::thread::sleep(Duration::from_millis(2));
            }
            boa_engine::builtins::promise::PromiseState::Fulfilled(value) => return Ok(value),
            boa_engine::builtins::promise::PromiseState::Rejected(reason) => {
                let message = reason
                    .to_string(context)
                    .map(|text| text.to_std_string_escaped())
                    .unwrap_or_else(|_| "the handler's promise rejected".to_owned());
                return Err(message);
            }
        }
    }
}

fn js_to_json(context: &mut Context, value: JsValue) -> Result<Value, String> {
    json_of(context, &value)
}

/// A JS value as JSON, with the language's own `JSON.stringify` semantics: `undefined`
/// members and functions drop out, `undefined` in an array reads `null`, `toJSON` runs.
/// Boa 0.20's `JsValue::to_json` instead hits a `todo!()` on any nested `undefined` —
/// a panic that took the whole JS thread down on an ordinary command result.
pub(crate) fn json_of(context: &mut Context, value: &JsValue) -> Result<Value, String> {
    if value.is_undefined() {
        return Ok(Value::Null);
    }
    let json = context.intrinsics().objects().json();
    let stringify = json
        .get(key("stringify"), context)
        .map_err(|e| e.to_string())?;
    let stringify = stringify
        .as_callable()
        .ok_or_else(|| "JSON.stringify is missing".to_owned())?;
    let text = stringify
        .call(&json.clone().into(), std::slice::from_ref(value), context)
        .map_err(|e| e.to_string())?;
    match text.as_string() {
        Some(text) => {
            serde_json::from_str(&text.to_std_string_escaped()).map_err(|e| e.to_string())
        }
        // A function or symbol at the top: nothing to serialize.
        None => Ok(Value::Null),
    }
}

/* ---------- the child-process events (from the pipe readers) ---------- */

fn proc_data(context: &mut Context, handle: u64, stream: u8, bytes: Vec<u8>) {
    let target = with_state(|state| {
        state.procs.get(&handle).and_then(|entry| match stream {
            0 => entry.stdout.clone(),
            _ => entry.stderr.clone(),
        })
    });
    let Some(target) = target.and_then(|value| value.as_object()) else {
        return;
    };
    let Ok(data) = builtins_buffer(context, bytes) else {
        return;
    };
    emit_on(context, &target, "data", &[data]);
}

fn proc_exit(context: &mut Context, handle: u64, code: Option<i32>) {
    let entry = with_state(|state| state.procs.remove(&handle));
    let Some(entry) = entry else {
        return;
    };
    children().lock().unwrap().remove(&handle);
    let code_value = match code {
        Some(code) => JsValue::from(code),
        None => JsValue::null(),
    };
    if let Some(emitter) = entry.emitter.as_ref().and_then(JsValue::as_object) {
        emit_on(context, &emitter, "exit", std::slice::from_ref(&code_value));
        emit_on(context, &emitter, "close", &[code_value]);
    }
    for stream in [&entry.stdout, &entry.stderr] {
        if let Some(stream) = stream.as_ref().and_then(JsValue::as_object) {
            // Node closes each stdio stream after the data: 'end' for the readers, then
            // 'close' when the fd is gone — resolveSpawnOutput-style collectors wait on it.
            emit_on(context, &stream, "end", &[]);
            emit_on(context, &stream, "close", &[]);
        }
    }
}

/// Hand one native resource event to the prelude's router: `(id, event, data, bytes)`,
/// `bytes` a Buffer when the event carries a payload. A throw from the package's own
/// listener is logged, never allowed to take the runtime down.
fn native_event(context: &mut Context, id: u64, event: &str, data: &Value, bytes: Option<Vec<u8>>) {
    let global = context.global_object();
    let Ok(router) = global.get(key("__ggsNativeEvent"), context) else {
        return;
    };
    let Some(router) = router.as_callable() else {
        return;
    };
    let payload = match bytes {
        Some(bytes) => match builtins_buffer(context, bytes) {
            Ok(buffer) => buffer,
            Err(()) => return,
        },
        None => JsValue::undefined(),
    };
    let data = JsValue::from_json(data, context).unwrap_or_default();
    let args = [
        JsValue::from(id as f64),
        JsValue::from(boa_engine::JsString::from(event)),
        data,
        payload,
    ];
    if let Err(error) = router.call(&JsValue::undefined(), &args, context) {
        with_state(|state| state.log("warn", &format!("a {event} listener threw: {error}")));
    }
    let _ = context.run_jobs();
}

fn builtins_buffer(context: &mut Context, bytes: Vec<u8>) -> Result<JsValue, ()> {
    // The same Buffer the prelude built, through its `from` (kept local so the byte
    // shaping for pipe data does not round-trip through the natives table).
    let global = context.global_object();
    let buffer = global.get(key("Buffer"), context).map_err(|_| ())?;
    let from = buffer
        .as_object()
        .ok_or(())?
        .get(key("from"), context)
        .map_err(|_| ())?;
    let from = from.as_object().ok_or(())?;
    let bytes = boa_engine::object::builtins::JsArrayBuffer::from_byte_block(
        crate::node_runtime::byte_block(bytes),
        context,
    )
    .map_err(|_| ())?;
    from.call(&buffer, &[bytes.into()], context).map_err(|_| ())
}

/// `emitter.emit(event, ...args)` — the method called with the emitter as `this`.
fn emit_on(context: &mut Context, emitter: &boa_engine::JsObject, event: &str, args: &[JsValue]) {
    let Ok(emit) = emitter.get(key("emit"), context) else {
        return;
    };
    let Some(emit) = emit.as_object() else {
        return;
    };
    let mut call_args = vec![text(event)];
    call_args.extend_from_slice(args);
    let _ = emit.call(&emitter.clone().into(), &call_args, context);
}

/// The nearest ancestor of `entry` carrying the generated `manifest.json` — the package
/// root wherever the packer put the entry inside it.
fn find_package_root(entry: &Path) -> PathBuf {
    let mut dir = entry
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));
    for _ in 0..6 {
        if dir.join("manifest.json").is_file() {
            return dir;
        }
        let Some(parent) = dir.parent() else {
            break;
        };
        dir = parent.to_path_buf();
    }
    entry
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A Rust panic deep inside JS execution — here a native that panics under a hundred
    /// JS frames — is contained, and the VM goes back to its resting depth. Before the
    /// unwind, every abandoned frame stayed pushed and charged against the 512-frame
    /// recursion budget: twenty contained panics at depth 100 would leave no budget for
    /// any later call, so the full-depth recursion at the end fails without it.
    #[test]
    fn a_contained_panic_puts_the_vm_back_at_rest() {
        let mut context = Context::default();
        context
            .register_global_callable(
                boa_engine::JsString::from("fault"),
                0,
                boa_engine::NativeFunction::from_fn_ptr(|_, _, _| panic!("a native fault")),
            )
            .unwrap();
        context
            .eval(boa_engine::Source::from_bytes(
                "function deep(n) { return n ? deep(n - 1) + 0 : fault(); }
                 function depth(n) { return n ? depth(n - 1) + 1 : 0; }",
            ))
            .unwrap();
        let deep = context
            .global_object()
            .get(key("deep"), &mut context)
            .unwrap()
            .as_object()
            .unwrap()
            .clone();
        let rest = context.vm_checkpoint();
        for _ in 0..20 {
            let outcome = contained(&mut context, "a test call", |context| {
                deep.call(&JsValue::undefined(), &[JsValue::from(100)], context)
            });
            assert!(outcome.is_none(), "the native's panic was contained");
            assert_eq!(context.vm_checkpoint(), rest, "the VM is back at rest");
        }
        let depth = context
            .eval(boa_engine::Source::from_bytes("depth(400)"))
            .expect("the whole recursion budget is still there");
        assert_eq!(depth.as_number(), Some(400.0));
    }

    /// A promise job that fails fails alone: the executor used to bail on the first error
    /// and clear every queue, stranding each other continuation the program had pending.
    #[test]
    fn a_failing_promise_job_leaves_the_others_queued_and_run() {
        let mut context = Context::default();
        context.enqueue_job(
            boa_engine::job::PromiseJob::new(|_| {
                Err(boa_engine::JsNativeError::error()
                    .with_message("this job fails")
                    .into())
            })
            .into(),
        );
        context.enqueue_job(
            boa_engine::job::PromiseJob::new(|context| {
                context
                    .global_object()
                    .set(key("ran"), true, false, context)?;
                Ok(JsValue::undefined())
            })
            .into(),
        );
        assert!(context.run_jobs().is_err(), "the failure is still reported");
        let ran = context
            .global_object()
            .get(key("ran"), &mut context)
            .unwrap();
        assert_eq!(ran.as_boolean(), Some(true), "the job behind it ran");
    }

    #[test]
    fn the_package_root_walks_up_to_the_manifest() {
        let tmp = tempfile::tempdir().unwrap();
        let package = tmp.path().join("pkg");
        std::fs::create_dir_all(package.join("out/nested")).unwrap();
        std::fs::write(package.join("manifest.json"), "{}").unwrap();
        let entry = package.join("out").join("nested").join("main.js");
        assert_eq!(find_package_root(&entry), package);
        // A package without a manifest answers with the entry's own directory.
        let bare = tmp.path().join("bare.js");
        assert_eq!(find_package_root(&bare), tmp.path());
    }

    /// The compile-path benchmark: `GGS_COMPILE_PROBE=<file.js>` compiles the file's
    /// CommonJS wrapper through BOTH compilation routes — the script route
    /// (`Context::eval` → `Script::parse`, the module loader's) and the indirect-eval
    /// route it used before (`(0, eval)(src)`) — and prints both totals. Run it against a
    /// real bundle under the optimized profile: `GGS_COMPILE_PROBE=<extension.js> cargo
    /// test --profile ggs-node --features node-runtime --lib compile_paths -- --nocapture
    /// --exact`. The diagnosis instrument of the slow-big-bundle investigation
    /// (2026-09-27): the eval route re-read the bundle as a UTF-16 JS string before its
    /// parse began, and the script route won; whatever wins here is what a load pays.
    #[test]
    fn compile_paths_probe() {
        let Ok(path) = std::env::var("GGS_COMPILE_PROBE") else {
            return; // an ordinary test run has nothing to benchmark
        };
        let source = std::fs::read_to_string(&path).expect("GGS_COMPILE_PROBE is readable");
        let wrapper = format!(
            "(function (exports, require, module, __filename, __dirname) {{\n{source}\n}})"
        );
        let mut context = Context::default();
        // The script route, twice: the second is the steady-state number (allocator warm).
        for round in 1..=2 {
            let started = std::time::Instant::now();
            let value = context
                .eval(boa_engine::Source::from_bytes(wrapper.as_bytes()))
                .expect("the script route compiles");
            eprintln!(
                "[probe] script route round {round}: {:?} ({})",
                started.elapsed(),
                value.type_of()
            );
        }
        // The indirect-eval route (the loader's), through a global so the string literal
        // never re-parses the bundle as script source.
        let quoted = serde_json::to_string(&wrapper).unwrap();
        let script = format!("var __probeSource = {quoted}; (0, eval)(__probeSource)");
        for round in 1..=2 {
            let started = std::time::Instant::now();
            let value = context
                .eval(boa_engine::Source::from_bytes(script.as_bytes()))
                .expect("the eval route compiles");
            eprintln!(
                "[probe] eval route round {round}: {:?} ({})",
                started.elapsed(),
                value.type_of()
            );
        }
    }
}
