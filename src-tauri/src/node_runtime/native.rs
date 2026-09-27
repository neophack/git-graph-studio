//! The `.node` half of the pretend Node runtime: how a package's native addon loads here.
//! The host process IS the N-API embedding host — `napi_host.rs` implements and exports
//! the `napi_*` surface the way node.exe does — so loading an addon is the Node handshake
//! itself: dlopen the library, call `napi_register_module_v1(env, exports)`, and hand the
//! exports object back as the module `require` answers. The addon's NAPI registration
//! resolves the symbols from this process (napi-rs probes the host image first), and the
//! functions it registers run as Boa natives over the bridge.
//!
//! The libraries load once and are never unloaded: a Rust cdylib may own thread-local
//! storage whose destructor runs at unload and crashes a foreign host, so the handle
//! lives for the process's lifetime.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use boa_engine::{Context, JsObject};

use super::napi_host;

struct Addon {
    #[allow(dead_code)] // held forever — see the module doc
    library: libloading::Library,
}

struct AddonState {
    by_path: HashMap<PathBuf, usize>,
    loaded: Vec<Addon>,
}

fn addons() -> &'static Mutex<AddonState> {
    static ADDONS: std::sync::OnceLock<Mutex<AddonState>> = std::sync::OnceLock::new();
    ADDONS.get_or_init(|| {
        Mutex::new(AddonState {
            by_path: HashMap::new(),
            loaded: Vec::new(),
        })
    })
}

/// Load the addon at `path` and run its NAPI registration against the context. The path
/// is canonicalised so two spellings of one file are one addon, the way Node's require
/// cache reads them. The exports object the registration builds is the answer — the
/// module's own functions, bridged.
///
/// Within one context the require cache (require.rs) answers repeats before this runs.
/// Another context — another JS thread — registers the same image again against its own
/// environment, exactly as Node registers an addon once per worker's env: the library
/// handle is re-opened (the OS keeps one image) and the new exports belong to that context.
pub(crate) fn load(path: &Path, context: &mut Context) -> Result<(usize, JsObject), String> {
    let canonical = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    unsafe {
        let library = libloading::Library::new(&canonical)
            .map_err(|error| format!("could not load {}: {error}", canonical.display()))?;
        let exports = napi_host::load_and_register(&library, context)?;
        let mut state = addons().lock().unwrap();
        let index = match state.by_path.get(&canonical) {
            // The image is already held: this handle is one more reference to it, dropped
            // here without unloading (the first handle keeps it for the process).
            Some(index) => *index,
            None => {
                let index = state.loaded.len();
                state.loaded.push(Addon { library });
                state.by_path.insert(canonical, index);
                index
            }
        };
        Ok((index, exports))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A dual-export engine `.node` (its NAPI registration is what this host serves): the
    /// submodule's own engine layout first — the dev and CI fixture — then any installed
    /// package's. Skipped when neither is on the machine.
    fn engine_fixture() -> Option<PathBuf> {
        let candidate = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../vscode-git-graph-rs/native/win32-x64-msvc/git-graph.node");
        if candidate.is_file() {
            return Some(candidate);
        }
        let home = std::env::var("USERPROFILE")
            .or_else(|_| std::env::var("HOME"))
            .ok()?;
        let dir = PathBuf::from(home).join(".ggs/extensions");
        let dir = std::fs::read_dir(&dir).ok()?;
        for entry in dir.flatten() {
            let candidate = entry.path().join("native/win32-x64-msvc/git-graph.node");
            if candidate.is_file() {
                return Some(candidate);
            }
        }
        None
    }

    /// The whole chain in one Boa context: the addon loads, its `napi_register_module_v1`
    /// runs against the N-API bridge, and the engine's own exports answer — the sync
    /// `engineVersion` and an async `request` whose promise settles through the
    /// threadsafe-function drain.
    #[test]
    fn the_engine_registers_and_serves_over_napi() {
        let Some(engine) = engine_fixture() else {
            eprintln!("skipping: no engine .node on this machine");
            return;
        };
        let mut context = Context::default();
        super::super::builtins::register_natives(&mut context).expect("the builtins register");
        let (_index, exports) =
            load(&engine, &mut context).expect("the engine registers over N-API");
        // The sync export answers the engine's version.
        let version = exports
            .get(crate::node_runtime::key("engineVersion"), &mut context)
            .expect("engineVersion is exported")
            .as_object()
            .and_then(|function| {
                function
                    .call(
                        &JsObject::with_object_proto(context.intrinsics()).into(),
                        &[],
                        &mut context,
                    )
                    .ok()
            })
            .and_then(|value| value.as_string().map(|text| text.to_std_string_escaped()))
            .unwrap_or_default();
        assert!(
            version.starts_with("1."),
            "the engine's own export answered: {version}"
        );
        // The async export settles through the threadsafe-function drain: the worker's
        // call queues, the drain delivers it, the deferred resolves, run_jobs settles the
        // promise chain.
        let request = exports
            .get(crate::node_runtime::key("request"), &mut context)
            .expect("request is exported");
        let promise = request
            .as_object()
            .and_then(|function| {
                function
                    .call(
                        &JsObject::with_object_proto(context.intrinsics()).into(),
                        &[
                            crate::node_runtime::text(""),
                            crate::node_runtime::text(
                                "{\"method\":\"engineVersion\",\"params\":{}}",
                            ),
                        ],
                        &mut context,
                    )
                    .ok()
            })
            .unwrap_or_else(boa_engine::JsValue::undefined);
        assert!(promise.is_object(), "the async export answered a promise");
        // Attach the collector once, then drain the threadsafe queue and settle jobs
        // until the worker's completion resolves the promise.
        let then = promise
            .as_object()
            .and_then(|object| {
                object
                    .get(crate::node_runtime::key("then"), &mut context)
                    .ok()
                    .and_then(|then| then.as_object())
            })
            .expect("a promise carries then");
        then.call(
            &promise,
            &[make_answer_collector(&mut context)],
            &mut context,
        )
        .expect("the collector attaches");
        let _ = context.run_jobs();
        for _ in 0..50 {
            napi_host::drain_threadsafe_calls(&mut context);
            let _ = context.run_jobs();
            let answer = context
                .eval(boa_engine::Source::from_bytes(
                    "typeof globalThis.__ggsAnswer === 'undefined' ? '' : globalThis.__ggsAnswer",
                ))
                .map(|value| {
                    value
                        .as_string()
                        .map(|text| text.to_std_string_escaped())
                        .unwrap_or_default()
                })
                .unwrap_or_default();
            if !answer.is_empty() {
                assert!(answer.contains("1."), "the request seam answered: {answer}");
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        panic!("the async request never settled through the threadsafe drain");
    }

    /// `(answer) => { globalThis.__ggsAnswer = answer; }` as a native callable.
    fn make_answer_collector(context: &mut Context) -> boa_engine::JsValue {
        use boa_engine::JsArgs;
        let native = unsafe {
            boa_engine::NativeFunction::from_closure(
                |_this: &boa_engine::JsValue,
                 args: &[boa_engine::JsValue],
                 context: &mut Context| {
                    let answer = args.get_or_undefined(0).clone();
                    let global = context.global_object().clone();
                    global.set(
                        crate::node_runtime::key("__ggsAnswer"),
                        answer,
                        false,
                        context,
                    )?;
                    Ok(boa_engine::JsValue::undefined())
                },
            )
        };
        boa_engine::JsValue::from(
            boa_engine::object::FunctionObjectBuilder::new(context.realm(), native).build(),
        )
    }
}
