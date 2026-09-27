//! The N-API host: how a `.node` addon loads in the pretend Node runtime. Boa is the JS
//! engine and THIS process is the embedding host, so the addon's `napi_*` surface binds
//! against us exactly the way it binds against node.exe — napi-rs resolves the symbols
//! from the host image at `napi_register_module_v1` time (`napi-sys`' `find_node_library`
//! probes the executable first), and this module IS that surface: one `#[no_mangle]`
//! export per N-API function, bridging `napi_value` handles to Boa values.
//!
//! What is implemented here is what a napi-rs 3 module actually touches: registration
//! (`napi_create_function` + `napi_set_named_property`), calls (`napi_get_cb_info`, the
//! value constructors and readers, the property set), errors (the pending-exception
//! model), promises (the async functions settle through `napi_create_promise` /
//! `napi_resolve_deferred`), and threadsafe functions — the async completion path, whose
//! calls arrive from the addon's worker threads and are drained on the JS thread
//! (`drain_threadsafe_calls`, hooked into the run loop, woken through the shared
//! condvar). The rest of the N-API catalogue answers as honest stubs — `napi-sys`
//! tolerates a missing symbol by stubbing it, and a stubbed call returns
//! `napi_generic_failure`, which napi-rs surfaces as an error, never a crash.
//!
//! Every entry except the threadsafe-function call/ref/release trio runs on the JS
//! thread (registration from `require`, callbacks from Boa, the tsfn drain); the trio is
//! called from the addon's own workers and touches only the Send registry and queue.
//! One environment serves every addon, one context lives for the process: the handle
//! arena is a plain grow-only Vec of rooted Boa values.

use std::ffi::{c_char, c_void, CStr};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::ThreadId;

use boa_engine::{
    Context, JsError, JsNativeError, JsObject, JsResult, JsString, JsValue, NativeFunction,
};

/* ---------- the environment, the handle arena ---------- */

struct NapiEnv {
    context: *mut Context,
    handles: Vec<JsValue>,
    pending: Option<JsValue>,
}

// One environment per JS thread — a `napi_env` names one Boa context, and a Boa context
// never leaves its thread. A process hosts one JS thread in `ggs-node`, but a test binary
// runs several runtimes side by side: a process-wide environment bound them all to
// whichever context installed first, and an addon then ran against a foreign (or freed)
// heap. The pointer is a leaked Box so a `napi_env` stays valid for the thread's life;
// `release_thread_env` drops its Boa handles while the context is still alive.
thread_local! {
    static ENV: std::cell::Cell<*mut NapiEnv> = const { std::cell::Cell::new(std::ptr::null_mut()) };
}

impl NapiEnv {
    fn handle(&mut self, value: JsValue) -> *mut c_void {
        self.handles.push(value);
        self.handles.len() as *mut c_void // 1-based, so a napi_value is never null
    }
}

/// This thread's environment, when the `env` the addon passed is it.
unsafe fn env_mut<'a>(env: *mut c_void) -> Option<&'a mut NapiEnv> {
    let raw = ENV.with(|slot| slot.get());
    if raw.is_null() || raw as *mut c_void != env {
        return None;
    }
    Some(&mut *raw)
}

unsafe fn any_env<'a>() -> &'a mut NapiEnv {
    let raw = ENV.with(|slot| slot.get());
    assert!(
        !raw.is_null(),
        "the N-API environment is not created on this thread"
    );
    &mut *raw
}

/// Drop this thread's Boa handles, on the thread, while its context is still alive (the
/// run loop's teardown calls this beside its own state drop). The environment itself stays
/// allocated: an addon may still hold the `napi_env` pointer, and a later call through it
/// must find an empty environment, not freed memory.
pub(crate) fn release_thread_env() {
    let raw = ENV.with(|slot| slot.get());
    if raw.is_null() {
        return;
    }
    unsafe {
        (*raw).handles.clear();
        (*raw).pending = None;
    }
    let owner = std::thread::current().id();
    TSFNS
        .lock()
        .unwrap()
        .iter_mut()
        .filter(|slot| slot.as_ref().is_some_and(|tsfn| tsfn.owner == owner))
        .for_each(|slot| *slot = None);
    // The thread is going away: its functions' Boa values die with its context. The
    // finalizers are skipped — they would call back into an environment being torn down.
    RETIRED.lock().unwrap().retain(|tsfn| tsfn.owner != owner);
}

unsafe fn context<'a>() -> &'a mut Context {
    &mut *any_env().context
}

// The value a `napi_value` handle names — every napi_* reader funnels through here.
//
unsafe fn value_of(handle: *mut c_void) -> Option<JsValue> {
    if handle.is_null() {
        return None;
    }
    let index = handle as usize;
    any_env().handles.get(index.checked_sub(1)?).cloned()
}

/* ---------- statuses, the constants the addon's headers expect ---------- */

const NAPI_OK: u32 = 0;
const NAPI_GENERIC_FAILURE: u32 = 1;
const NAPI_INVALID_ARG: u32 = 2;
const NAPI_PENDING_EXCEPTION: u32 = 10;

const NAPI_UNDEFINED: u32 = 0;
const NAPI_NULL: u32 = 1;
const NAPI_BOOLEAN: u32 = 2;
const NAPI_NUMBER: u32 = 3;
const NAPI_STRING: u32 = 4;
const NAPI_SYMBOL: u32 = 5;
const NAPI_OBJECT: u32 = 6;
const NAPI_FUNCTION: u32 = 7;

// `napi_node_version`, spelled so the reader can take every field: three numbers and
// the release string napi-rs turns into a `CStr`.
//
#[repr(C)]
pub struct NodeVersion {
    major: u32,
    minor: u32,
    patch: u32,
    release: *const c_char,
}

// The statics below hand these out across every thread the addon reads them on; the
// pointers name process-lifetime statics.
unsafe impl Sync for NodeVersion {}

// `napi_extended_error_info`: an honest empty answer (no extended info), never a null
// dereference on an error path that reads it.
//
#[repr(C)]
pub struct ExtendedErrorInfo {
    error_message: *const c_char,
    engine_reserved: *mut c_void,
    engine_error_code: u32,
    error_code: u32,
}

unsafe impl Sync for ExtendedErrorInfo {}

macro_rules! ok_or_pending {
    ($env:expr, $work:expr) => {
        // The closure gives the block's `?` operators a Result to unwrap into; a failure
        // becomes the pending exception, the answer N-API expects.
        match (|| -> Result<u32, JsError> { Ok($work) })() {
            Ok(out) => out,
            Err(error) => {
                let value = error_to_value(error);
                if let Some(env) = env_mut($env) {
                    env.pending = Some(value);
                }
                return NAPI_PENDING_EXCEPTION;
            }
        }
    };
}

unsafe fn error_to_value(error: JsError) -> JsValue {
    error.to_opaque(context())
}

/* ---------- registration: the host's entry into the addon ---------- */

// Create (or rebind) this thread's environment to the thread's Boa context. Called on the
// JS thread at bootstrap, before an addon's registration, and by the tsfn drain.
pub(crate) fn install(context: *mut Context) {
    ENV.with(|slot| {
        let raw = slot.get();
        if raw.is_null() {
            slot.set(Box::into_raw(Box::new(NapiEnv {
                context,
                handles: Vec::new(),
                pending: None,
            })));
        } else {
            unsafe { (*raw).context = context };
        }
    });
}

type RegisterFn = unsafe extern "C" fn(*mut c_void, *mut c_void) -> *mut c_void;

// Load the addon and run its `napi_register_module_v1` — the same handshake node.exe
// performs. The exports object the registration builds is the module `require` returns.
//
pub(crate) fn load_and_register(
    library: &libloading::Library,
    context: &mut Context,
) -> Result<JsObject, String> {
    install(context as *mut Context);
    let register: libloading::Symbol<RegisterFn> = unsafe {
        library
            .get(b"napi_register_module_v1\0")
            .map_err(|_| "carries no napi_register_module_v1: not a Node-API addon".to_owned())?
    };
    let env = unsafe { any_env() as *mut NapiEnv as *mut c_void };
    let exports = JsObject::with_object_proto(context.intrinsics());
    let exports_handle = unsafe { any_env().handle(exports.clone().into()) };
    let returned = unsafe { register(env, exports_handle) };
    let module = if returned.is_null() {
        exports
    } else {
        match unsafe { value_of(returned) } {
            Some(value) => value
                .as_object()
                .ok_or("the addon's registration did not answer an object")?,
            None => exports,
        }
    };
    // A failed registration leaves a pending exception: surface it as the load error, the
    // way a throw during require surfaces in Node.
    if let Some(pending) = unsafe { any_env().pending.take() } {
        return Err(format!(
            "the addon's registration threw: {}",
            pending.display()
        ));
    }
    Ok(module)
}

/* ---------- the callbacks the addon registers: the Boa side ---------- */

struct Callback {
    function: unsafe extern "C" fn(*mut c_void, *mut c_void) -> *mut c_void,
    data: *mut c_void,
}

struct CallbackInfo {
    this: *mut c_void,
    argv: Vec<*mut c_void>,
    data: *mut c_void,
}

unsafe impl Send for Callback {}
unsafe impl Send for CallbackInfo {}

// One addon callback as a Boa native function: the `napi_callback_info` is built per
// call, the addon runs, and a pending exception crosses back as the call's error — the
// whole N-API control-flow model in one closure.
//
unsafe fn callback_trampoline(
    callback: &Callback,
    this: &JsValue,
    args: &[JsValue],
    // The context Boa hands the native is the environment's own single context; the
    // bridge reaches it through the environment, which also serves the calls the addon
    // makes from outside a callback (the registration, the tsfn drain).
    _context: &mut Context,
) -> JsResult<JsValue> {
    let env = any_env() as *mut NapiEnv as *mut c_void;
    let this_handle = any_env().handle(this.clone());
    let mut argv = Vec::with_capacity(args.len());
    for argument in args {
        argv.push(any_env().handle(argument.clone()));
    }
    let info = CallbackInfo {
        this: this_handle,
        argv,
        data: callback.data,
    };
    let result = (callback.function)(env, &info as *const CallbackInfo as *mut c_void);
    if let Some(pending) = any_env().pending.take() {
        return Err(JsError::from_opaque(pending));
    }
    if result.is_null() {
        return Ok(JsValue::undefined());
    }
    value_of(result).ok_or_else(|| {
        JsError::from_native(
            JsNativeError::error()
                .with_message("the addon answered an invalid napi_value".to_owned()),
        )
    })
}

/* ---------- threadsafe functions: async completion across threads ---------- */

struct Tsfn {
    /// The JS callback the calls deliver to (rooted; the drain runs on the JS thread).
    js_callback: JsValue,
    maybe_call_to_js:
        Option<unsafe extern "C" fn(*mut c_void, *mut c_void, *mut c_void, *mut c_void)>,
    context: *mut c_void,
    refs: AtomicUsize,
    /// The JS thread that created the function: only its drain delivers the calls (its
    /// context owns `js_callback`), and only it drops the function's Boa values.
    owner: ThreadId,
    /// That thread's run-loop wake, so a worker's call does not wait out an idle tick.
    wake: Option<Wake>,
    /// The addon's `thread_finalize_cb` and its data, run on the owner thread once the
    /// function is retired — where napi-rs frees what it attached to the function.
    finalize: Option<(TsfnFinalizer, SendPtr)>,
}

unsafe impl Send for Tsfn {}

type Wake = Arc<(Mutex<bool>, Condvar)>;

static TSFNS: Mutex<Vec<Option<Tsfn>>> = Mutex::new(Vec::new());
/// Functions retired by their last release, awaiting their owner thread's drain: the
/// release may run on an addon worker, where dropping a Boa value is unsound.
static RETIRED: Mutex<Vec<Tsfn>> = Mutex::new(Vec::new());

/// A raw addon pointer crossing threads: the pointer is opaque to this side (the addon
/// owns what it names), so the wrapper carries only Send.
#[derive(Clone, Copy)]
struct SendPtr(*mut c_void);
unsafe impl Send for SendPtr {}

static TSFN_QUEUE: Mutex<Vec<(usize, SendPtr)>> = Mutex::new(Vec::new());

thread_local! {
    static THREAD_WAKE: std::cell::RefCell<Option<Wake>> = const { std::cell::RefCell::new(None) };
}

/// The calling JS thread's run-loop wake handle — set once at the loop's start, captured
/// by every threadsafe function the thread creates.
pub(crate) fn set_wake(wake: Wake) {
    THREAD_WAKE.with(|slot| *slot.borrow_mut() = Some(wake));
}

fn wake(wake: &Wake) {
    let (flag, condvar) = &**wake;
    let mut guard = flag.lock().unwrap();
    *guard = true;
    condvar.notify_all();
}

/// Deliver this thread's queued threadsafe calls, on the JS thread — the run loop calls
/// this between its jobs and timers, and a request blocked on a pending promise calls it
/// while it waits. Each delivery runs the addon's `maybe_call_to_js` converter (which
/// resolves or rejects the deferred the async call owns). Calls of functions another JS
/// thread owns stay queued for that thread.
pub(crate) fn drain_threadsafe_calls(context: &mut Context) {
    let owner = std::thread::current().id();
    // Functions retired since the last drain are finalized and die here, on their own
    // thread.
    let retired: Vec<Tsfn> = {
        let mut retired = RETIRED.lock().unwrap();
        let (mine, others) = std::mem::take(&mut *retired)
            .into_iter()
            .partition(|tsfn| tsfn.owner == owner);
        *retired = others;
        mine
    };
    if !retired.is_empty() {
        install(context as *mut Context);
        let env = unsafe { any_env() as *mut NapiEnv as *mut c_void };
        for tsfn in &retired {
            if let Some((finalize, data)) = tsfn.finalize {
                unsafe { finalize(env, data.0, tsfn.context) };
            }
        }
        drop(retired);
    }
    let batch: Vec<(usize, SendPtr)> = {
        let functions = TSFNS.lock().unwrap();
        let mut queue = TSFN_QUEUE.lock().unwrap();
        let (mine, others) = std::mem::take(&mut *queue)
            .into_iter()
            .partition(|(id, _)| match functions.get(*id) {
                Some(Some(tsfn)) => tsfn.owner == owner,
                // A call to a retired function is nobody's: drop it with the batch.
                _ => true,
            });
        *queue = others;
        mine
    };
    if batch.is_empty() {
        return;
    }
    install(context as *mut Context);
    for (id, data) in batch {
        // Copy the delivery's parts out and drop the registry lock BEFORE the converter
        // runs: napi-rs's `call_js_cb` re-enters the registry (it releases the function,
        // reads its context), and a std Mutex held across that re-entry deadlocks the JS
        // thread — the promise never settles.
        let delivery = {
            let functions = TSFNS.lock().unwrap();
            match functions.get(id) {
                Some(Some(tsfn)) => Some((
                    tsfn.maybe_call_to_js,
                    tsfn.js_callback.clone(),
                    tsfn.context,
                )),
                _ => None,
            }
        };
        let Some((converter, callback, tsfn_context)) = delivery else {
            continue;
        };
        let env = unsafe { any_env() as *mut NapiEnv as *mut c_void };
        match converter {
            Some(converter) => {
                let callback_handle = unsafe { any_env().handle(callback) };
                unsafe { converter(env, callback_handle, tsfn_context, data.0) };
            }
            // No converter: Node calls the JS function with no arguments.
            None => {
                if let Some(function) = callback.as_object() {
                    let _ = function.call(&JsValue::undefined(), &[], context);
                }
            }
        }
        // A pending exception the delivery raised has nowhere to go (Node reports it as
        // uncaught); clear it so the next delivery's API calls do not see it.
        if let Some(pending) = unsafe { any_env().pending.take() } {
            eprintln!(
                "[ggs-node] a threadsafe-function delivery threw: {}",
                pending.display()
            );
        }
    }
}

/* ---------- the N-API surface ---------- */

fn utf8_or_latin1(ptr: *const c_char, length: isize) -> Option<String> {
    if ptr.is_null() {
        return None;
    }
    unsafe {
        if length == -1 {
            Some(CStr::from_ptr(ptr).to_string_lossy().into_owned())
        } else {
            let bytes = std::slice::from_raw_parts(ptr as *const u8, length as usize);
            Some(String::from_utf8_lossy(bytes).into_owned())
        }
    }
}

macro_rules! napi_fn {
    ($(#[$doc:meta])* $name:ident($($arg:ident: $ty:ty),*) -> $ret:ty $body:block) => {
        $(#[$doc])*
        #[no_mangle]
        pub unsafe extern "C" fn $name($($arg: $ty),*) -> $ret $body
    };
}

napi_fn!(napi_get_version(_env: *mut c_void, result: *mut u32) -> u32 {
    if result.is_null() { return NAPI_INVALID_ARG; }
    *result = 10;
    NAPI_OK
});

napi_fn!(napi_get_node_version(_env: *mut c_void, result: *mut *const NodeVersion) -> u32 {
    // The whole `napi_node_version` shape: napi-rs's detection reads (major, minor,
    // patch) and dereferences `release` — a three-word answer segfaults its reader.
    static VERSION: NodeVersion = NodeVersion {
        major: 24,
        minor: 0,
        patch: 0,
        release: c"ggs-node".as_ptr(),
    };
    if result.is_null() { return NAPI_INVALID_ARG; }
    *result = &VERSION;
    NAPI_OK
});

napi_fn!(napi_get_last_error_info(_env: *mut c_void, result: *mut *const ExtendedErrorInfo) -> u32 {
    static EMPTY: ExtendedErrorInfo = ExtendedErrorInfo {
        error_message: c"no extended error information".as_ptr(),
        engine_reserved: std::ptr::null_mut(),
        engine_error_code: 0,
        error_code: 0,
    };
    if result.is_null() { return NAPI_INVALID_ARG; }
    *result = &EMPTY;
    NAPI_OK
});

/* ----- the value constructors and readers ----- */

napi_fn!(napi_get_undefined(env: *mut c_void, result: *mut *mut c_void) -> u32 {
    let Some(_) = env_mut(env) else { return NAPI_INVALID_ARG };
    if result.is_null() { return NAPI_INVALID_ARG; }
    let value = JsValue::undefined();
    *result = any_env().handle(value);
    NAPI_OK
});

napi_fn!(napi_get_null(env: *mut c_void, result: *mut *mut c_void) -> u32 {
    let Some(_) = env_mut(env) else { return NAPI_INVALID_ARG };
    if result.is_null() { return NAPI_INVALID_ARG; }
    *result = any_env().handle(JsValue::null());
    NAPI_OK
});

napi_fn!(napi_get_global(env: *mut c_void, result: *mut *mut c_void) -> u32 {
    let Some(_) = env_mut(env) else { return NAPI_INVALID_ARG };
    if result.is_null() { return NAPI_INVALID_ARG; }
    let global = context().global_object().clone();
    *result = any_env().handle(global.into());
    NAPI_OK
});

napi_fn!(napi_get_boolean(env: *mut c_void, truthy: bool, result: *mut *mut c_void) -> u32 {
    let Some(_) = env_mut(env) else { return NAPI_INVALID_ARG };
    if result.is_null() { return NAPI_INVALID_ARG; }
    *result = any_env().handle(JsValue::from(truthy));
    NAPI_OK
});

napi_fn!(napi_create_object(env: *mut c_void, result: *mut *mut c_void) -> u32 {
    let Some(_) = env_mut(env) else { return NAPI_INVALID_ARG };
    if result.is_null() { return NAPI_INVALID_ARG; }
    let object = JsObject::with_object_proto(context().intrinsics());
    *result = any_env().handle(object.into());
    NAPI_OK
});

napi_fn!(napi_create_array(env: *mut c_void, result: *mut *mut c_void) -> u32 {
    let Some(_) = env_mut(env) else { return NAPI_INVALID_ARG };
    if result.is_null() { return NAPI_INVALID_ARG; }
    let array = boa_engine::object::builtins::JsArray::new(context());
    *result = any_env().handle(array.into());
    NAPI_OK
});

napi_fn!(napi_create_array_with_length(env: *mut c_void, length: usize, result: *mut *mut c_void) -> u32 {
    let Some(_) = env_mut(env) else { return NAPI_INVALID_ARG };
    if result.is_null() { return NAPI_INVALID_ARG; }
    let array = boa_engine::object::builtins::JsArray::new(context());
    array
        .set(crate::node_runtime::key("length"), JsValue::from(length as u32), false, context())
        .ok();
    *result = any_env().handle(array.into());
    NAPI_OK
});

napi_fn!(napi_create_double(env: *mut c_void, value: f64, result: *mut *mut c_void) -> u32 {
    let Some(_) = env_mut(env) else { return NAPI_INVALID_ARG };
    if result.is_null() { return NAPI_INVALID_ARG; }
    *result = any_env().handle(JsValue::from(value));
    NAPI_OK
});

napi_fn!(napi_create_int32(env: *mut c_void, value: i32, result: *mut *mut c_void) -> u32 {
    let Some(_) = env_mut(env) else { return NAPI_INVALID_ARG };
    if result.is_null() { return NAPI_INVALID_ARG; }
    *result = any_env().handle(JsValue::from(value));
    NAPI_OK
});

napi_fn!(napi_create_uint32(env: *mut c_void, value: u32, result: *mut *mut c_void) -> u32 {
    let Some(_) = env_mut(env) else { return NAPI_INVALID_ARG };
    if result.is_null() { return NAPI_INVALID_ARG; }
    *result = any_env().handle(JsValue::from(value));
    NAPI_OK
});

napi_fn!(napi_create_int64(env: *mut c_void, value: i64, result: *mut *mut c_void) -> u32 {
    let Some(_) = env_mut(env) else { return NAPI_INVALID_ARG };
    if result.is_null() { return NAPI_INVALID_ARG; }
    *result = any_env().handle(JsValue::from(value as f64));
    NAPI_OK
});

napi_fn!(napi_create_string_utf8(env: *mut c_void, text: *const c_char, length: isize, result: *mut *mut c_void) -> u32 {
    let Some(_) = env_mut(env) else { return NAPI_INVALID_ARG };
    if result.is_null() { return NAPI_INVALID_ARG; }
    let Some(text) = utf8_or_latin1(text, length) else { return NAPI_INVALID_ARG };
    *result = any_env().handle(crate::node_runtime::text(text));
    NAPI_OK
});

napi_fn!(napi_create_string_latin1(env: *mut c_void, text: *const c_char, length: isize, result: *mut *mut c_void) -> u32 {
    let Some(_) = env_mut(env) else { return NAPI_INVALID_ARG };
    if result.is_null() { return NAPI_INVALID_ARG; }
    let Some(text) = utf8_or_latin1(text, length) else { return NAPI_INVALID_ARG };
    *result = any_env().handle(crate::node_runtime::text(text));
    NAPI_OK
});

napi_fn!(napi_create_string_utf16(env: *mut c_void, text: *const u16, length: isize, result: *mut *mut c_void) -> u32 {
    let Some(_) = env_mut(env) else { return NAPI_INVALID_ARG };
    if result.is_null() { return NAPI_INVALID_ARG };
    let length = if length == -1 {
        let mut count = 0;
        unsafe {
            while *text.add(count) != 0 {
                count += 1;
            }
        }
        count
    } else {
        length as usize
    };
    let units = unsafe { std::slice::from_raw_parts(text, length) };
    let text = String::from_utf16_lossy(units);
    *result = any_env().handle(crate::node_runtime::text(text));
    NAPI_OK
});

napi_fn!(napi_typeof(env: *mut c_void, value: *mut c_void, result: *mut u32) -> u32 {
    let Some(_) = env_mut(env) else { return NAPI_INVALID_ARG };
    if result.is_null() { return NAPI_INVALID_ARG; }
    let Some(value) = value_of(value) else { return NAPI_INVALID_ARG };
    let kind = if value.is_undefined() {
        NAPI_UNDEFINED
    } else if value.is_null() {
        NAPI_NULL
    } else if value.is_boolean() {
        NAPI_BOOLEAN
    } else if value.is_number() {
        NAPI_NUMBER
    } else if value.is_string() {
        NAPI_STRING
    } else if value.is_symbol() {
        NAPI_SYMBOL
    } else if value.is_object() {
        if value.as_object().is_some_and(|object| object.is_callable()) {
            NAPI_FUNCTION
        } else {
            NAPI_OBJECT
        }
    } else {
        NAPI_OBJECT
    };
    *result = kind;
    NAPI_OK
});

napi_fn!(napi_coerce_to_bool(env: *mut c_void, value: *mut c_void, result: *mut *mut c_void) -> u32 {
    let Some(_) = env_mut(env) else { return NAPI_INVALID_ARG };
    if result.is_null() { return NAPI_INVALID_ARG; }
    let Some(value) = value_of(value) else { return NAPI_INVALID_ARG };
    let truthy = value.to_boolean();
    *result = any_env().handle(JsValue::from(truthy));
    NAPI_OK
});

napi_fn!(napi_coerce_to_number(env: *mut c_void, value: *mut c_void, result: *mut *mut c_void) -> u32 {
    let Some(_) = env_mut(env) else { return NAPI_INVALID_ARG };
    if result.is_null() { return NAPI_INVALID_ARG };
    let Some(value) = value_of(value) else { return NAPI_INVALID_ARG };
    ok_or_pending!(env, {
        let number = value.to_number(context())?;
        *result = any_env().handle(JsValue::from(number));
        NAPI_OK
    })
});

napi_fn!(napi_coerce_to_string(env: *mut c_void, value: *mut c_void, result: *mut *mut c_void) -> u32 {
    let Some(_) = env_mut(env) else { return NAPI_INVALID_ARG };
    if result.is_null() { return NAPI_INVALID_ARG };
    let Some(value) = value_of(value) else { return NAPI_INVALID_ARG };
    ok_or_pending!(env, {
        let text = value.to_string(context())?;
        *result = any_env().handle(JsValue::from(text));
        NAPI_OK
    })
});

napi_fn!(napi_get_value_bool(env: *mut c_void, value: *mut c_void, result: *mut bool) -> u32 {
    let Some(_) = env_mut(env) else { return NAPI_INVALID_ARG };
    let Some(value) = value_of(value) else { return NAPI_INVALID_ARG };
    let Some(truthy) = value.as_boolean() else { return NAPI_INVALID_ARG };
    if !result.is_null() { *result = truthy; }
    NAPI_OK
});

napi_fn!(napi_get_value_double(env: *mut c_void, value: *mut c_void, result: *mut f64) -> u32 {
    let Some(_) = env_mut(env) else { return NAPI_INVALID_ARG };
    let Some(value) = value_of(value) else { return NAPI_INVALID_ARG };
    let Some(number) = value.as_number() else { return NAPI_INVALID_ARG };
    if !result.is_null() { *result = number; }
    NAPI_OK
});

napi_fn!(napi_get_value_int32(env: *mut c_void, value: *mut c_void, result: *mut i32) -> u32 {
    let Some(_) = env_mut(env) else { return NAPI_INVALID_ARG };
    let Some(value) = value_of(value) else { return NAPI_INVALID_ARG };
    let Some(number) = value.as_number() else { return NAPI_INVALID_ARG };
    if !result.is_null() { *result = number as i32; }
    NAPI_OK
});

napi_fn!(napi_get_value_uint32(env: *mut c_void, value: *mut c_void, result: *mut u32) -> u32 {
    let Some(_) = env_mut(env) else { return NAPI_INVALID_ARG };
    let Some(value) = value_of(value) else { return NAPI_INVALID_ARG };
    let Some(number) = value.as_number() else { return NAPI_INVALID_ARG };
    if !result.is_null() { *result = number as u32; }
    NAPI_OK
});

napi_fn!(napi_get_value_int64(env: *mut c_void, value: *mut c_void, result: *mut i64) -> u32 {
    let Some(_) = env_mut(env) else { return NAPI_INVALID_ARG };
    let Some(value) = value_of(value) else { return NAPI_INVALID_ARG };
    let Some(number) = value.as_number() else { return NAPI_INVALID_ARG };
    if !result.is_null() { *result = number as i64; }
    NAPI_OK
});

// The two-call string read: a null buffer asks for the size (in UTF-16 units + the NUL),
// a buffer copies into it. Latin1 shares the shape with its own table.
//
unsafe fn read_value_string(
    env: *mut c_void,
    value: *mut c_void,
    buffer: *mut c_char,
    buffer_size: isize,
    written: *mut usize,
    utf16_units: bool,
) -> u32 {
    let Some(_) = env_mut(env) else {
        return NAPI_INVALID_ARG;
    };
    let Some(value) = value_of(value) else {
        return NAPI_INVALID_ARG;
    };
    ok_or_pending!(env, {
        let text = value.to_string(context())?.to_std_string_escaped();
        if buffer.is_null() {
            let length = if utf16_units {
                text.encode_utf16().count()
            } else {
                text.len()
            };
            if !written.is_null() {
                *written = length;
            }
            return Ok(NAPI_OK);
        }
        let size = buffer_size.max(0) as usize;
        let capacity = size.saturating_sub(1);
        if utf16_units {
            let target = buffer as *mut u16;
            let mut copied = 0usize;
            for unit in text.encode_utf16().take(capacity) {
                *target.add(copied) = unit;
                copied += 1;
            }
            *target.add(copied) = 0;
            if !written.is_null() {
                *written = copied;
            }
        } else {
            let bytes = text.as_bytes();
            let copied = bytes.len().min(capacity);
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), buffer as *mut u8, copied);
            *buffer.add(copied) = 0;
            if !written.is_null() {
                *written = copied;
            }
        }
        NAPI_OK
    })
}

napi_fn!(napi_get_value_string_utf8(env: *mut c_void, value: *mut c_void, buffer: *mut c_char, buffer_size: isize, written: *mut usize) -> u32 {
    read_value_string(env, value, buffer, buffer_size, written, false)
});

napi_fn!(napi_get_value_string_latin1(env: *mut c_void, value: *mut c_void, buffer: *mut c_char, buffer_size: isize, written: *mut usize) -> u32 {
    read_value_string(env, value, buffer, buffer_size, written, false)
});

napi_fn!(napi_get_value_string_utf16(env: *mut c_void, value: *mut c_void, buffer: *mut c_char, buffer_size: isize, written: *mut usize) -> u32 {
    read_value_string(env, value, buffer, buffer_size, written, true)
});

/* ----- properties ----- */

unsafe fn object_of(handle: *mut c_void) -> Option<JsObject> {
    value_of(handle)?.as_object()
}

napi_fn!(napi_set_named_property(env: *mut c_void, object: *mut c_void, name: *const c_char, value: *mut c_void) -> u32 {
    let Some(_) = env_mut(env) else { return NAPI_INVALID_ARG };
    let Some(name) = utf8_or_latin1(name, -1) else { return NAPI_INVALID_ARG };
    let Some(target) = object_of(object) else { return NAPI_INVALID_ARG };
    let Some(value) = value_of(value) else { return NAPI_INVALID_ARG };
    ok_or_pending!(env, {
        target.set(crate::node_runtime::key(&name), value, false, context())?;
        NAPI_OK
    })
});

napi_fn!(napi_get_named_property(env: *mut c_void, object: *mut c_void, name: *const c_char, result: *mut *mut c_void) -> u32 {
    let Some(_) = env_mut(env) else { return NAPI_INVALID_ARG };
    let Some(name) = utf8_or_latin1(name, -1) else { return NAPI_INVALID_ARG };
    let Some(target) = object_of(object) else { return NAPI_INVALID_ARG };
    if result.is_null() { return NAPI_INVALID_ARG };
    ok_or_pending!(env, {
        let value = target.get(crate::node_runtime::key(&name), context())?;
        *result = any_env().handle(value);
        NAPI_OK
    })
});

napi_fn!(napi_has_named_property(env: *mut c_void, object: *mut c_void, name: *const c_char, result: *mut bool) -> u32 {
    let Some(_) = env_mut(env) else { return NAPI_INVALID_ARG };
    let Some(name) = utf8_or_latin1(name, -1) else { return NAPI_INVALID_ARG };
    let Some(target) = object_of(object) else { return NAPI_INVALID_ARG };
    ok_or_pending!(env, {
        let present = target.has_property(crate::node_runtime::key(&name), context())?;
        if !result.is_null() { *result = present; }
        NAPI_OK
    })
});

napi_fn!(napi_set_property(env: *mut c_void, object: *mut c_void, key: *mut c_void, value: *mut c_void) -> u32 {
    let Some(_) = env_mut(env) else { return NAPI_INVALID_ARG };
    let Some(target) = object_of(object) else { return NAPI_INVALID_ARG };
    let Some(key) = value_of(key) else { return NAPI_INVALID_ARG };
    let Some(value) = value_of(value) else { return NAPI_INVALID_ARG };
    ok_or_pending!(env, {
        let property = key.to_property_key(context())?;
        target.set(property, value, false, context())?;
        NAPI_OK
    })
});

napi_fn!(napi_get_property(env: *mut c_void, object: *mut c_void, key: *mut c_void, result: *mut *mut c_void) -> u32 {
    let Some(_) = env_mut(env) else { return NAPI_INVALID_ARG };
    let Some(target) = object_of(object) else { return NAPI_INVALID_ARG };
    let Some(key) = value_of(key) else { return NAPI_INVALID_ARG };
    if result.is_null() { return NAPI_INVALID_ARG };
    ok_or_pending!(env, {
        let property = key.to_property_key(context())?;
        let value = target.get(property, context())?;
        *result = any_env().handle(value);
        NAPI_OK
    })
});

napi_fn!(napi_has_property(env: *mut c_void, object: *mut c_void, key: *mut c_void, result: *mut bool) -> u32 {
    let Some(_) = env_mut(env) else { return NAPI_INVALID_ARG };
    let Some(target) = object_of(object) else { return NAPI_INVALID_ARG };
    let Some(key) = value_of(key) else { return NAPI_INVALID_ARG };
    ok_or_pending!(env, {
        let property = key.to_property_key(context())?;
        let present = target.has_property(property, context())?;
        if !result.is_null() { *result = present; }
        NAPI_OK
    })
});

napi_fn!(napi_has_own_property(env: *mut c_void, object: *mut c_void, key: *mut c_void, result: *mut bool) -> u32 {
    let Some(_) = env_mut(env) else { return NAPI_INVALID_ARG };
    let Some(target) = object_of(object) else { return NAPI_INVALID_ARG };
    let Some(key) = value_of(key) else { return NAPI_INVALID_ARG };
    ok_or_pending!(env, {
        let property = key.to_property_key(context())?;
        let present = target.has_own_property(property, context())?;
        if !result.is_null() { *result = present; }
        NAPI_OK
    })
});

napi_fn!(napi_delete_property(env: *mut c_void, object: *mut c_void, key: *mut c_void, result: *mut bool) -> u32 {
    let Some(_) = env_mut(env) else { return NAPI_INVALID_ARG };
    let Some(target) = object_of(object) else { return NAPI_INVALID_ARG };
    let Some(key) = value_of(key) else { return NAPI_INVALID_ARG };
    ok_or_pending!(env, {
        let property = key.to_property_key(context())?;
        target.delete_property_or_throw(property, context())?;
        if !result.is_null() { *result = true; }
        NAPI_OK
    })
});

napi_fn!(napi_get_property_names(env: *mut c_void, object: *mut c_void, result: *mut *mut c_void) -> u32 {
    let Some(_) = env_mut(env) else { return NAPI_INVALID_ARG };
    let Some(target) = object_of(object) else { return NAPI_INVALID_ARG };
    if result.is_null() { return NAPI_INVALID_ARG };
    ok_or_pending!(env, {
        let keys: Vec<JsValue> = target
            .own_property_keys(context())?
            .into_iter()
            .map(JsValue::from)
            .collect();
        let array = boa_engine::object::builtins::JsArray::from_iter(keys, context());
        *result = any_env().handle(array.into());
        NAPI_OK
    })
});

napi_fn!(napi_get_array_length(env: *mut c_void, array: *mut c_void, result: *mut u32) -> u32 {
    let Some(_) = env_mut(env) else { return NAPI_INVALID_ARG };
    let Some(target) = object_of(array) else { return NAPI_INVALID_ARG };
    ok_or_pending!(env, {
        let length = target.get(crate::node_runtime::key("length"), context())?;
        if !result.is_null() { *result = length.as_number().unwrap_or(0.0) as u32; }
        NAPI_OK
    })
});

napi_fn!(napi_set_element(env: *mut c_void, object: *mut c_void, index: u32, value: *mut c_void) -> u32 {
    let Some(_) = env_mut(env) else { return NAPI_INVALID_ARG };
    let Some(target) = object_of(object) else { return NAPI_INVALID_ARG };
    let Some(value) = value_of(value) else { return NAPI_INVALID_ARG };
    ok_or_pending!(env, {
        target.set(index, value, false, context())?;
        NAPI_OK
    })
});

napi_fn!(napi_get_element(env: *mut c_void, object: *mut c_void, index: u32, result: *mut *mut c_void) -> u32 {
    let Some(_) = env_mut(env) else { return NAPI_INVALID_ARG };
    let Some(target) = object_of(object) else { return NAPI_INVALID_ARG };
    if result.is_null() { return NAPI_INVALID_ARG };
    ok_or_pending!(env, {
        let value = target.get(index, context())?;
        *result = any_env().handle(value);
        NAPI_OK
    })
});

napi_fn!(napi_has_element(env: *mut c_void, object: *mut c_void, index: u32, result: *mut bool) -> u32 {
    let Some(_) = env_mut(env) else { return NAPI_INVALID_ARG };
    let Some(target) = object_of(object) else { return NAPI_INVALID_ARG };
    ok_or_pending!(env, {
        let present = target.has_property(index, context())?;
        if !result.is_null() { *result = present; }
        NAPI_OK
    })
});

napi_fn!(napi_delete_element(env: *mut c_void, object: *mut c_void, index: u32, result: *mut bool) -> u32 {
    let Some(_) = env_mut(env) else { return NAPI_INVALID_ARG };
    let Some(target) = object_of(object) else { return NAPI_INVALID_ARG };
    ok_or_pending!(env, {
        let key = JsValue::from(index).to_property_key(context())?;
        target.delete_property_or_throw(key, context())?;
        if !result.is_null() { *result = true; }
        NAPI_OK
    })
});

napi_fn!(napi_get_prototype(env: *mut c_void, object: *mut c_void, result: *mut *mut c_void) -> u32 {
    let Some(_) = env_mut(env) else { return NAPI_INVALID_ARG };
    let Some(target) = object_of(object) else { return NAPI_INVALID_ARG };
    if result.is_null() { return NAPI_INVALID_ARG };
    let prototype = target
        .prototype()
        .map(JsValue::from)
        .unwrap_or_else(JsValue::null);
    *result = any_env().handle(prototype);
    NAPI_OK
});

napi_fn!(napi_instanceof(env: *mut c_void, object: *mut c_void, constructor: *mut c_void, result: *mut bool) -> u32 {
    let Some(_) = env_mut(env) else { return NAPI_INVALID_ARG };
    let Some(value) = value_of(object) else { return NAPI_INVALID_ARG };
    let Some(construct) = value_of(constructor) else { return NAPI_INVALID_ARG };
    ok_or_pending!(env, {
        let truthy = value.instance_of(&construct, context())?;
        if !result.is_null() { *result = truthy; }
        NAPI_OK
    })
});

napi_fn!(napi_strict_equals(_env: *mut c_void, left: *mut c_void, right: *mut c_void, result: *mut bool) -> u32 {
    let (Some(left), Some(right)) = (value_of(left), value_of(right)) else {
        return NAPI_INVALID_ARG;
    };
    if !result.is_null() { *result = left.strict_equals(&right); }
    NAPI_OK
});

/* ----- functions, calls, the callback info ----- */

type NapiCallback = unsafe extern "C" fn(*mut c_void, *mut c_void) -> *mut c_void;

// One addon callback as a Boa function object — shared by `napi_create_function` and
// the method/accessor slots of `napi_define_properties`.
//
unsafe fn bridged_function(name: &str, callback: NapiCallback, data: *mut c_void) -> JsObject {
    let captured = Callback {
        function: callback,
        data,
    };
    let native = NativeFunction::from_closure(
        move |this: &JsValue, args: &[JsValue], context: &mut Context| {
            callback_trampoline(&captured, this, args, context)
        },
    );
    JsObject::from(
        boa_engine::object::FunctionObjectBuilder::new(context().realm(), native)
            .name(JsString::from(name))
            .build(),
    )
}

napi_fn!(napi_create_function(env: *mut c_void, name: *const c_char, _length: isize, callback: Option<NapiCallback>, data: *mut c_void, result: *mut *mut c_void) -> u32 {
    let Some(_) = env_mut(env) else { return NAPI_INVALID_ARG };
    if result.is_null() { return NAPI_INVALID_ARG };
    let Some(callback) = callback else { return NAPI_INVALID_ARG };
    let name = utf8_or_latin1(name, -1).unwrap_or_default();
    let function = bridged_function(&name, callback, data);
    *result = any_env().handle(function.into());
    NAPI_OK
});

// `napi_property_descriptor`, laid out as the addon's headers define it.
//
#[repr(C)]
pub struct PropertyDescriptor {
    utf8name: *const c_char,
    name: *mut c_void,
    method: Option<NapiCallback>,
    getter: Option<NapiCallback>,
    setter: Option<NapiCallback>,
    value: *mut c_void,
    attributes: i32,
    data: *mut c_void,
}

const NAPI_WRITABLE: i32 = 1;
const NAPI_ENUMERABLE: i32 = 2;
const NAPI_CONFIGURABLE: i32 = 4;

napi_fn!(napi_define_properties(env: *mut c_void, object: *mut c_void, count: usize, properties: *const PropertyDescriptor) -> u32 {
    let Some(_) = env_mut(env) else { return NAPI_INVALID_ARG };
    let Some(target) = object_of(object) else { return NAPI_INVALID_ARG };
    if count > 0 && properties.is_null() { return NAPI_INVALID_ARG };
    let properties = if count == 0 { &[][..] } else { std::slice::from_raw_parts(properties, count) };
    ok_or_pending!(env, {
        for property in properties {
            let (key, name) = if !property.utf8name.is_null() {
                let name = utf8_or_latin1(property.utf8name, -1).unwrap_or_default();
                (crate::node_runtime::key(&name), name)
            } else {
                let Some(key) = value_of(property.name) else { return Ok(NAPI_INVALID_ARG) };
                let name = key.to_string(context())?.to_std_string_escaped();
                (key.to_property_key(context())?, name)
            };
            let enumerable = property.attributes & NAPI_ENUMERABLE != 0;
            let configurable = property.attributes & NAPI_CONFIGURABLE != 0;
            let mut descriptor = boa_engine::property::PropertyDescriptor::builder()
                .enumerable(enumerable)
                .configurable(configurable);
            if property.getter.is_some() || property.setter.is_some() {
                // An accessor pair: N-API ignores `writable` for accessors.
                if let Some(getter) = property.getter {
                    descriptor = descriptor.get(bridged_function(&name, getter, property.data));
                }
                if let Some(setter) = property.setter {
                    descriptor = descriptor.set(bridged_function(&name, setter, property.data));
                }
            } else {
                let value = match property.method {
                    Some(method) => bridged_function(&name, method, property.data).into(),
                    None => value_of(property.value).unwrap_or_else(JsValue::undefined),
                };
                descriptor = descriptor
                    .value(value)
                    .writable(property.attributes & NAPI_WRITABLE != 0);
            }
            target.define_property_or_throw(key, descriptor.build(), context())?;
        }
        NAPI_OK
    })
});

napi_fn!(napi_get_cb_info(env: *mut c_void, info: *mut c_void, argc: *mut usize, argv: *mut *mut c_void, this_arg: *mut *mut c_void, data: *mut *mut c_void) -> u32 {
    let Some(_) = env_mut(env) else { return NAPI_INVALID_ARG };
    let Some(info) = (info as *const CallbackInfo).as_ref() else { return NAPI_INVALID_ARG };
    let provided = if argc.is_null() { 0 } else { *argc };
    if !argv.is_null() {
        for (at, handle) in info.argv.iter().take(provided).enumerate() {
            *argv.add(at) = *handle;
        }
    }
    if !argc.is_null() {
        *argc = info.argv.len();
    }
    if !this_arg.is_null() {
        *this_arg = info.this;
    }
    if !data.is_null() {
        *data = info.data;
    }
    NAPI_OK
});

napi_fn!(napi_call_function(env: *mut c_void, receiver: *mut c_void, function: *mut c_void, argc: usize, argv: *mut *mut c_void, result: *mut *mut c_void) -> u32 {
    let Some(_) = env_mut(env) else { return NAPI_INVALID_ARG };
    let Some(function) = object_of(function) else { return NAPI_INVALID_ARG };
    let Some(receiver) = value_of(receiver) else { return NAPI_INVALID_ARG };
    let mut arguments = Vec::with_capacity(argc);
    for at in 0..argc {
        arguments.push(value_of(*argv.add(at)).unwrap_or_else(JsValue::undefined));
    }
    ok_or_pending!(env, {
        let answer = function.call(&receiver, &arguments, context())?;
        if !result.is_null() {
            *result = any_env().handle(answer);
        }
        NAPI_OK
    })
});

napi_fn!(napi_new_instance(env: *mut c_void, constructor: *mut c_void, argc: usize, argv: *mut *mut c_void, result: *mut *mut c_void) -> u32 {
    let Some(_) = env_mut(env) else { return NAPI_INVALID_ARG };
    let Some(constructor) = object_of(constructor) else { return NAPI_INVALID_ARG };
    let mut arguments = Vec::with_capacity(argc);
    for at in 0..argc {
        arguments.push(value_of(*argv.add(at)).unwrap_or_else(JsValue::undefined));
    }
    ok_or_pending!(env, {
        let answer = constructor.construct(&arguments, None, context())?;
        if !result.is_null() {
            *result = any_env().handle(JsValue::from(answer));
        }
        NAPI_OK
    })
});

napi_fn!(napi_get_new_target(_env: *mut c_void, _info: *mut c_void, result: *mut *mut c_void) -> u32 {
    // The trampoline serves plain functions, never class constructors: no new.target.
    if !result.is_null() { *result = std::ptr::null_mut(); }
    NAPI_OK
});

/* ----- exceptions ----- */

unsafe fn throw_message(env: *mut c_void, message: Option<String>, kind: &str) -> u32 {
    let Some(slot) = env_mut(env) else {
        return NAPI_INVALID_ARG;
    };
    let message = message.unwrap_or_else(|| "an addon error".to_owned());
    let native = match kind {
        "TypeError" => JsNativeError::typ(),
        "RangeError" => JsNativeError::range(),
        _ => JsNativeError::error(),
    }
    .with_message(message);
    let value = JsValue::from(native.to_opaque(context()));
    slot.pending = Some(value);
    NAPI_OK
}

napi_fn!(napi_throw_error(env: *mut c_void, _code: *const c_char, message: *const c_char) -> u32 {
    throw_message(env, utf8_or_latin1(message, -1), "Error")
});

napi_fn!(napi_throw_type_error(env: *mut c_void, _code: *const c_char, message: *const c_char) -> u32 {
    throw_message(env, utf8_or_latin1(message, -1), "TypeError")
});

napi_fn!(napi_throw_range_error(env: *mut c_void, _code: *const c_char, message: *const c_char) -> u32 {
    throw_message(env, utf8_or_latin1(message, -1), "RangeError")
});

napi_fn!(napi_create_error(env: *mut c_void, _code: *mut c_void, message: *mut c_void, result: *mut *mut c_void) -> u32 {
    let Some(_) = env_mut(env) else { return NAPI_INVALID_ARG };
    if result.is_null() { return NAPI_INVALID_ARG };
    let text = value_of(message)
        .and_then(|value| value.as_string().map(|text| text.to_std_string_escaped()))
        .unwrap_or_default();
    let error = JsValue::from(JsNativeError::error().with_message(text).to_opaque(context()));
    *result = any_env().handle(error);
    NAPI_OK
});

napi_fn!(napi_create_type_error(env: *mut c_void, _code: *mut c_void, message: *mut c_void, result: *mut *mut c_void) -> u32 {
    let Some(_) = env_mut(env) else { return NAPI_INVALID_ARG };
    if result.is_null() { return NAPI_INVALID_ARG };
    let text = value_of(message)
        .and_then(|value| value.as_string().map(|text| text.to_std_string_escaped()))
        .unwrap_or_default();
    let error = JsValue::from(JsNativeError::typ().with_message(text).to_opaque(context()));
    *result = any_env().handle(error);
    NAPI_OK
});

napi_fn!(napi_create_range_error(env: *mut c_void, _code: *mut c_void, message: *mut c_void, result: *mut *mut c_void) -> u32 {
    let Some(_) = env_mut(env) else { return NAPI_INVALID_ARG };
    if result.is_null() { return NAPI_INVALID_ARG };
    let text = value_of(message)
        .and_then(|value| value.as_string().map(|text| text.to_std_string_escaped()))
        .unwrap_or_default();
    let error = JsValue::from(JsNativeError::range().with_message(text).to_opaque(context()));
    *result = any_env().handle(error);
    NAPI_OK
});

napi_fn!(napi_throw(env: *mut c_void, error: *mut c_void) -> u32 {
    let Some(slot) = env_mut(env) else { return NAPI_INVALID_ARG };
    let Some(value) = value_of(error) else { return NAPI_INVALID_ARG };
    slot.pending = Some(value);
    NAPI_OK
});

napi_fn!(napi_is_exception_pending(env: *mut c_void, result: *mut bool) -> u32 {
    let Some(slot) = env_mut(env) else { return NAPI_INVALID_ARG };
    if !result.is_null() {
        *result = slot.pending.is_some();
    }
    NAPI_OK
});

napi_fn!(napi_get_and_clear_last_exception(env: *mut c_void, result: *mut *mut c_void) -> u32 {
    let Some(slot) = env_mut(env) else { return NAPI_INVALID_ARG };
    if result.is_null() { return NAPI_INVALID_ARG };
    let pending = slot.pending.take().unwrap_or_else(JsValue::undefined);
    *result = any_env().handle(pending);
    NAPI_OK
});

napi_fn!(napi_is_error(_env: *mut c_void, value: *mut c_void, result: *mut bool) -> u32 {
    let Some(value) = value_of(value) else { return NAPI_INVALID_ARG };
    let truthy = value
        .as_object()
        .and_then(|object| {
            let name = object.get(crate::node_runtime::key("name"), context()).ok()?;
            name.as_string().map(|text| text.to_std_string_escaped())
        })
        .is_some_and(|name| name.ends_with("Error"));
    if !result.is_null() { *result = truthy; }
    NAPI_OK
});

/* ----- promises: the async functions' settlement ----- */

struct Deferred {
    resolve: JsObject,
    reject: JsObject,
}

napi_fn!(napi_create_promise(env: *mut c_void, deferred: *mut *mut c_void, promise: *mut *mut c_void) -> u32 {
    let Some(_) = env_mut(env) else { return NAPI_INVALID_ARG };
    if deferred.is_null() || promise.is_null() { return NAPI_INVALID_ARG };
    ok_or_pending!(env, {
        let mut settle: Option<(JsObject, JsObject)> = None;
        let made = boa_engine::object::builtins::JsPromise::new(
            |resolvers: &boa_engine::builtins::promise::ResolvingFunctions, _context| {
                settle = Some((
                    resolvers.resolve.clone().into(),
                    resolvers.reject.clone().into(),
                ));
                Ok(JsValue::undefined())
            },
            context(),
        );
        let Some((resolve, reject)) = settle else {
            return Err(JsError::from_native(
                JsNativeError::error().with_message("the promise executor never ran".to_owned()),
            ));
        };
        *deferred = Box::into_raw(Box::new(Deferred { resolve, reject })) as *mut c_void;
        *promise = any_env().handle(made.into());
        NAPI_OK
    })
});

unsafe fn settle_deferred(
    env: *mut c_void,
    deferred: *mut c_void,
    value: *mut c_void,
    resolve: bool,
) -> u32 {
    let Some(_) = env_mut(env) else {
        return NAPI_INVALID_ARG;
    };
    let Some(settle) = (deferred as *mut Deferred).as_ref() else {
        return NAPI_INVALID_ARG;
    };
    let Some(value) = value_of(value) else {
        return NAPI_INVALID_ARG;
    };
    let function = if resolve {
        &settle.resolve
    } else {
        &settle.reject
    };
    let _ = function.call(&JsValue::undefined(), &[value], context());
    NAPI_OK
}

napi_fn!(napi_resolve_deferred(env: *mut c_void, deferred: *mut c_void, value: *mut c_void) -> u32 {
    settle_deferred(env, deferred, value, true)
});

napi_fn!(napi_reject_deferred(env: *mut c_void, deferred: *mut c_void, value: *mut c_void) -> u32 {
    settle_deferred(env, deferred, value, false)
});

napi_fn!(napi_is_promise(env: *mut c_void, value: *mut c_void, result: *mut bool) -> u32 {
    let Some(_) = env_mut(env) else { return NAPI_INVALID_ARG };
    let Some(value) = value_of(value) else { return NAPI_INVALID_ARG };
    // An object whose constructor name says Promise — what a registration-time probe asks.
    let truthy = value
        .as_object()
        .and_then(|object| {
            let constructor = object.get(crate::node_runtime::key("constructor"), context()).ok()?;
            constructor
                .as_object()
                .and_then(|named| named.get(crate::node_runtime::key("name"), context()).ok())
                .and_then(|name| name.as_string().map(|text| text.to_std_string_escaped()))
                .map(|name| name == "Promise")
        })
        .unwrap_or(false);
    if !result.is_null() { *result = truthy; }
    NAPI_OK
});

/* ----- handle scopes, references: the arena makes them administrative ----- */

napi_fn!(napi_open_handle_scope(env: *mut c_void, result: *mut *mut c_void) -> u32 {
    let Some(_) = env_mut(env) else { return NAPI_INVALID_ARG };
    if !result.is_null() {
        *result = std::ptr::dangling_mut::<c_void>(); // a token scope: the arena roots every handle
    }
    NAPI_OK
});

napi_fn!(napi_close_handle_scope(env: *mut c_void, _scope: *mut c_void) -> u32 {
    let Some(_) = env_mut(env) else { return NAPI_INVALID_ARG };
    NAPI_OK
});

napi_fn!(napi_open_escapable_handle_scope(env: *mut c_void, result: *mut *mut c_void) -> u32 {
    let Some(_) = env_mut(env) else { return NAPI_INVALID_ARG };
    if !result.is_null() {
        *result = std::ptr::dangling_mut::<c_void>();
    }
    NAPI_OK
});

napi_fn!(napi_close_escapable_handle_scope(env: *mut c_void, _scope: *mut c_void) -> u32 {
    let Some(_) = env_mut(env) else { return NAPI_INVALID_ARG };
    NAPI_OK
});

napi_fn!(napi_escape_handle(env: *mut c_void, _scope: *mut c_void, value: *mut c_void, result: *mut *mut c_void) -> u32 {
    let Some(_) = env_mut(env) else { return NAPI_INVALID_ARG };
    if !result.is_null() {
        *result = value;
    }
    NAPI_OK
});

struct Reference {
    value: JsValue,
    count: usize,
}

napi_fn!(napi_create_reference(env: *mut c_void, value: *mut c_void, count: u32, result: *mut *mut c_void) -> u32 {
    let Some(_) = env_mut(env) else { return NAPI_INVALID_ARG };
    let Some(value) = value_of(value) else { return NAPI_INVALID_ARG };
    if result.is_null() { return NAPI_INVALID_ARG };
    let reference = Box::into_raw(Box::new(Reference { value, count: count as usize })) as *mut c_void;
    *result = reference;
    NAPI_OK
});

napi_fn!(napi_delete_reference(_env: *mut c_void, reference: *mut c_void) -> u32 {
    if reference.is_null() { return NAPI_INVALID_ARG };
    unsafe { drop(Box::from_raw(reference as *mut Reference)); }
    NAPI_OK
});

napi_fn!(napi_reference_ref(env: *mut c_void, reference: *mut c_void, result: *mut u32) -> u32 {
    let Some(_) = env_mut(env) else { return NAPI_INVALID_ARG };
    let Some(slot) = (reference as *mut Reference).as_mut() else { return NAPI_INVALID_ARG };
    slot.count += 1;
    if !result.is_null() { *result = slot.count as u32; }
    NAPI_OK
});

napi_fn!(napi_reference_unref(env: *mut c_void, reference: *mut c_void, result: *mut u32) -> u32 {
    let Some(_) = env_mut(env) else { return NAPI_INVALID_ARG };
    let Some(slot) = (reference as *mut Reference).as_mut() else { return NAPI_INVALID_ARG };
    slot.count = slot.count.saturating_sub(1);
    if !result.is_null() { *result = slot.count as u32; }
    NAPI_OK
});

napi_fn!(napi_get_reference_value(env: *mut c_void, reference: *mut c_void, result: *mut *mut c_void) -> u32 {
    let Some(_) = env_mut(env) else { return NAPI_INVALID_ARG };
    let Some(slot) = (reference as *const Reference).as_ref() else { return NAPI_INVALID_ARG };
    if result.is_null() { return NAPI_INVALID_ARG };
    *result = any_env().handle(slot.value.clone());
    NAPI_OK
});

/* ----- threadsafe functions ----- */

type TsfnConverter = unsafe extern "C" fn(*mut c_void, *mut c_void, *mut c_void, *mut c_void);
type TsfnFinalizer = unsafe extern "C" fn(*mut c_void, *mut c_void, *mut c_void);

napi_fn!(napi_create_threadsafe_function(
    env: *mut c_void,
    js_function: *mut c_void,
    _async_resource: *mut c_void,
    _async_resource_name: *const c_char,
    _max_queue_size: usize,
    initial_thread_count: usize,
    thread_finalize_data: *mut c_void,
    thread_finalize_cb: Option<TsfnFinalizer>,
    tsfn_context: *mut c_void,
    maybe_call_to_js: Option<TsfnConverter>,
    result: *mut *mut c_void
) -> u32 {
    let Some(_) = env_mut(env) else { return NAPI_INVALID_ARG };
    if result.is_null() || initial_thread_count == 0 { return NAPI_INVALID_ARG };
    let js_callback = if js_function.is_null() {
        JsValue::undefined()
    } else {
        value_of(js_function).unwrap_or_else(JsValue::undefined)
    };
    let mut functions = TSFNS.lock().unwrap();
    let id = functions.len();
    functions.push(Some(Tsfn {
        js_callback,
        maybe_call_to_js,
        context: tsfn_context,
        refs: AtomicUsize::new(initial_thread_count),
        owner: std::thread::current().id(),
        wake: THREAD_WAKE.with(|slot| slot.borrow().clone()),
        finalize: thread_finalize_cb.map(|callback| (callback, SendPtr(thread_finalize_data))),
    }));
    *result = (id + 1) as *mut c_void;
    NAPI_OK
});

napi_fn!(napi_get_threadsafe_function_context(_func: *mut c_void, result: *mut *mut c_void) -> u32 {
    let id = (_func as usize).checked_sub(1).unwrap_or(usize::MAX);
    let functions = TSFNS.lock().unwrap();
    let Some(Some(tsfn)) = functions.get(id) else { return NAPI_INVALID_ARG };
    if !result.is_null() { *result = tsfn.context; }
    NAPI_OK
});

// The call any addon worker thread makes to hand a completion to the JS thread. Callable
// from any thread: the queue and the wake are the only shared state it touches.
//
napi_fn!(napi_call_threadsafe_function(func: *mut c_void, data: *mut c_void, _mode: napi_threadsafe_function_call_mode) -> u32 {
    let id = (func as usize).checked_sub(1).unwrap_or(usize::MAX);
    let owner_wake = {
        let functions = TSFNS.lock().unwrap();
        match functions.get(id) {
            Some(Some(tsfn)) => tsfn.wake.clone(),
            _ => return NAPI_GENERIC_FAILURE,
        }
    };
    TSFN_QUEUE.lock().unwrap().push((id, SendPtr(data)));
    if let Some(owner_wake) = owner_wake {
        wake(&owner_wake);
    }
    NAPI_OK
});

napi_fn!(napi_acquire_threadsafe_function(func: *mut c_void) -> u32 {
    let id = (func as usize).checked_sub(1).unwrap_or(usize::MAX);
    let functions = TSFNS.lock().unwrap();
    let Some(Some(tsfn)) = functions.get(id) else { return NAPI_GENERIC_FAILURE };
    tsfn.refs.fetch_add(1, Ordering::SeqCst);
    NAPI_OK
});

napi_fn!(napi_release_threadsafe_function(func: *mut c_void, _mode: napi_threadsafe_function_release_mode) -> u32 {
    let id = (func as usize).checked_sub(1).unwrap_or(usize::MAX);
    let mut functions = TSFNS.lock().unwrap();
    let Some(Some(tsfn)) = functions.get(id) else { return NAPI_GENERIC_FAILURE };
    if tsfn.refs.fetch_sub(1, Ordering::SeqCst) <= 1 {
        // The last release retires the slot. The function's Boa value and its finalizer
        // belong to the owner thread: they wait in RETIRED for its next drain (this release
        // may run on an addon worker), and the owner is woken to get there.
        if let Some(tsfn) = functions[id].take() {
            let owner_wake = tsfn.wake.clone();
            RETIRED.lock().unwrap().push(tsfn);
            if let Some(owner_wake) = owner_wake {
                wake(&owner_wake);
            }
        }
    }
    NAPI_OK
});

// `napi_(un)ref_threadsafe_function` are rooting hints — whether the function keeps the
// event loop alive — never lifetime operations. Treating them as such retired functions
// whose completions were still in flight; the hints are pure no-ops here (this host's
// loop runs for the process anyway), and only `napi_release_threadsafe_function`'s last
// thread count retires a slot.
//
napi_fn!(napi_ref_threadsafe_function(_env: *mut c_void, _func: *mut c_void) -> u32 {
    NAPI_OK
});

napi_fn!(napi_unref_threadsafe_function(_env: *mut c_void, _func: *mut c_void) -> u32 {
    NAPI_OK
});

// `napi-sys` binds this beside the N-API catalogue; napi-rs's runtime probes it. A host
// without libuv answers a dummy loop and a no-op run — the threadsafe queue above is the
// event loop here.
//
#[no_mangle]
pub unsafe extern "C" fn napi_get_uv_event_loop(_env: *mut c_void, loop_: *mut *mut c_void) -> u32 {
    if !loop_.is_null() {
        *loop_ = std::ptr::dangling_mut::<c_void>();
    }
    NAPI_OK
}

#[no_mangle]
pub extern "C" fn uv_run(_loop: *mut c_void, _mode: i32) -> i32 {
    0
}

#[no_mangle]
pub extern "C" fn uv_default_loop() -> *mut c_void {
    std::ptr::dangling_mut::<c_void>()
}

/* ----- the long tail: honest stubs, so a probe degrades instead of crashing ----- */

macro_rules! napi_stub {
    ($($name:ident),*) => {
        $(#[no_mangle]
        pub unsafe extern "C" fn $name() -> u32 {
            eprintln!("[ggs-node] Node-API symbol {} is not served by this host", stringify!($name));
            NAPI_GENERIC_FAILURE
        })*
    };
}

// Env cleanup hooks run at environment teardown; this host's environment lives for the
// process, so registering one is accepted and never fired — the honest no-op.
//
napi_fn!(napi_add_env_cleanup_hook(_env: *mut c_void, _hook: *mut c_void, _arg: *mut c_void) -> u32 {
    NAPI_OK
});

napi_fn!(napi_remove_env_cleanup_hook(_env: *mut c_void, _hook: *mut c_void, _arg: *mut c_void) -> u32 {
    NAPI_OK
});

napi_stub!(
    napi_create_symbol,
    napi_create_external,
    napi_create_external_arraybuffer,
    napi_create_external_buffer,
    napi_create_arraybuffer,
    napi_create_buffer,
    napi_create_buffer_copy,
    napi_create_typedarray,
    napi_create_dataview,
    napi_get_arraybuffer_info,
    napi_get_buffer_info,
    napi_get_typedarray_info,
    napi_get_dataview_info,
    napi_detach_arraybuffer,
    napi_is_detached_arraybuffer,
    napi_is_array,
    napi_is_arraybuffer,
    napi_is_buffer,
    napi_is_dataview,
    napi_is_typedarray,
    napi_adjust_external_memory,
    napi_define_class,
    napi_wrap,
    napi_unwrap,
    napi_remove_wrap,
    napi_get_value_external,
    napi_run_script,
    napi_make_callback,
    napi_open_callback_scope,
    napi_close_callback_scope,
    napi_create_async_work,
    napi_delete_async_work,
    napi_queue_async_work,
    napi_cancel_async_work,
    napi_async_init,
    napi_async_destroy,
    napi_make_callback_external_buffers,
    napi_fatal_error,
    napi_fatal_exception,
    napi_module_register,
    napi_set_instance_data,
    napi_get_instance_data,
    napi_object_freeze,
    napi_object_seal,
    napi_get_all_property_names,
    napi_object_get_own_property_names
);

// The integer types the threadsafe-function release/call modes expect — spelled here so
// the signatures above read the way the addon's headers define them.
#[allow(non_camel_case_types)]
type napi_threadsafe_function_call_mode = i32;
#[allow(non_camel_case_types)]
type napi_threadsafe_function_release_mode = i32;

/// One table naming every exported function, so a binary that links this module without
/// touching any of it (the app exe beside ggs-node, the test exes that never load an
/// addon) still pulls the object out of the rlib: the `/EXPORT` directives alone cannot
/// resolve a symbol nothing references. Call `force_link` from such a target; ggs-node
/// itself and any real host reach the functions directly.
pub fn force_link() {
    #[allow(clippy::items_after_statements)]
    let surface: [usize; 134] = [
        napi_acquire_threadsafe_function as *const () as usize,
        napi_add_env_cleanup_hook as *const () as usize,
        napi_adjust_external_memory as *const () as usize,
        napi_async_destroy as *const () as usize,
        napi_async_init as *const () as usize,
        napi_call_function as *const () as usize,
        napi_call_threadsafe_function as *const () as usize,
        napi_cancel_async_work as *const () as usize,
        napi_close_callback_scope as *const () as usize,
        napi_close_escapable_handle_scope as *const () as usize,
        napi_close_handle_scope as *const () as usize,
        napi_coerce_to_bool as *const () as usize,
        napi_coerce_to_number as *const () as usize,
        napi_coerce_to_string as *const () as usize,
        napi_create_array as *const () as usize,
        napi_create_array_with_length as *const () as usize,
        napi_create_arraybuffer as *const () as usize,
        napi_create_async_work as *const () as usize,
        napi_create_buffer as *const () as usize,
        napi_create_buffer_copy as *const () as usize,
        napi_create_dataview as *const () as usize,
        napi_create_double as *const () as usize,
        napi_create_error as *const () as usize,
        napi_create_external as *const () as usize,
        napi_create_external_arraybuffer as *const () as usize,
        napi_create_external_buffer as *const () as usize,
        napi_create_function as *const () as usize,
        napi_create_int32 as *const () as usize,
        napi_create_int64 as *const () as usize,
        napi_create_object as *const () as usize,
        napi_create_promise as *const () as usize,
        napi_create_range_error as *const () as usize,
        napi_create_reference as *const () as usize,
        napi_create_string_latin1 as *const () as usize,
        napi_create_string_utf16 as *const () as usize,
        napi_create_string_utf8 as *const () as usize,
        napi_create_symbol as *const () as usize,
        napi_create_threadsafe_function as *const () as usize,
        napi_create_type_error as *const () as usize,
        napi_create_typedarray as *const () as usize,
        napi_create_uint32 as *const () as usize,
        napi_define_class as *const () as usize,
        napi_define_properties as *const () as usize,
        napi_delete_async_work as *const () as usize,
        napi_delete_element as *const () as usize,
        napi_delete_property as *const () as usize,
        napi_delete_reference as *const () as usize,
        napi_detach_arraybuffer as *const () as usize,
        napi_escape_handle as *const () as usize,
        napi_fatal_error as *const () as usize,
        napi_fatal_exception as *const () as usize,
        napi_get_all_property_names as *const () as usize,
        napi_get_and_clear_last_exception as *const () as usize,
        napi_get_array_length as *const () as usize,
        napi_get_arraybuffer_info as *const () as usize,
        napi_get_boolean as *const () as usize,
        napi_get_buffer_info as *const () as usize,
        napi_get_cb_info as *const () as usize,
        napi_get_dataview_info as *const () as usize,
        napi_get_element as *const () as usize,
        napi_get_global as *const () as usize,
        napi_get_instance_data as *const () as usize,
        napi_get_last_error_info as *const () as usize,
        napi_get_named_property as *const () as usize,
        napi_get_new_target as *const () as usize,
        napi_get_node_version as *const () as usize,
        napi_get_null as *const () as usize,
        napi_get_property as *const () as usize,
        napi_get_property_names as *const () as usize,
        napi_get_prototype as *const () as usize,
        napi_get_reference_value as *const () as usize,
        napi_get_threadsafe_function_context as *const () as usize,
        napi_get_typedarray_info as *const () as usize,
        napi_get_undefined as *const () as usize,
        napi_get_uv_event_loop as *const () as usize,
        napi_get_value_bool as *const () as usize,
        napi_get_value_double as *const () as usize,
        napi_get_value_external as *const () as usize,
        napi_get_value_int32 as *const () as usize,
        napi_get_value_int64 as *const () as usize,
        napi_get_value_string_latin1 as *const () as usize,
        napi_get_value_string_utf16 as *const () as usize,
        napi_get_value_string_utf8 as *const () as usize,
        napi_get_value_uint32 as *const () as usize,
        napi_get_version as *const () as usize,
        napi_has_element as *const () as usize,
        napi_has_named_property as *const () as usize,
        napi_has_own_property as *const () as usize,
        napi_has_property as *const () as usize,
        napi_instanceof as *const () as usize,
        napi_is_array as *const () as usize,
        napi_is_arraybuffer as *const () as usize,
        napi_is_buffer as *const () as usize,
        napi_is_dataview as *const () as usize,
        napi_is_detached_arraybuffer as *const () as usize,
        napi_is_error as *const () as usize,
        napi_is_exception_pending as *const () as usize,
        napi_is_promise as *const () as usize,
        napi_is_typedarray as *const () as usize,
        napi_make_callback as *const () as usize,
        napi_make_callback_external_buffers as *const () as usize,
        napi_module_register as *const () as usize,
        napi_new_instance as *const () as usize,
        napi_object_freeze as *const () as usize,
        napi_object_get_own_property_names as *const () as usize,
        napi_object_seal as *const () as usize,
        napi_open_callback_scope as *const () as usize,
        napi_open_escapable_handle_scope as *const () as usize,
        napi_open_handle_scope as *const () as usize,
        napi_queue_async_work as *const () as usize,
        napi_ref_threadsafe_function as *const () as usize,
        napi_reference_ref as *const () as usize,
        napi_reference_unref as *const () as usize,
        napi_reject_deferred as *const () as usize,
        napi_release_threadsafe_function as *const () as usize,
        napi_remove_env_cleanup_hook as *const () as usize,
        napi_remove_wrap as *const () as usize,
        napi_resolve_deferred as *const () as usize,
        napi_run_script as *const () as usize,
        napi_set_element as *const () as usize,
        napi_set_instance_data as *const () as usize,
        napi_set_named_property as *const () as usize,
        napi_set_property as *const () as usize,
        napi_strict_equals as *const () as usize,
        napi_throw as *const () as usize,
        napi_throw_error as *const () as usize,
        napi_throw_range_error as *const () as usize,
        napi_throw_type_error as *const () as usize,
        napi_typeof as *const () as usize,
        napi_unref_threadsafe_function as *const () as usize,
        napi_unwrap as *const () as usize,
        napi_wrap as *const () as usize,
        uv_default_loop as *const () as usize,
        uv_run as *const () as usize,
    ];
    std::hint::black_box(&surface);
}
