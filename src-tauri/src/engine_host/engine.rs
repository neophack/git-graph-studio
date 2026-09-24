//! The engine host's one link to the Git engine: the package's `git-graph.node`, loaded over
//! its plain C ABI and spoken to as JSON — never linked, never named as a crate.
//!
//! The `.node` the editor's Node runtime `require`s and this host `LoadLibrary`s is the same
//! file: the extension's package ships exactly one engine binary, and the C ABI exports
//! (`git_graph_capi_*`, the `git-graph-capi` crate compiled into the addon) serve every host
//! that cannot load a Node extension module. The wire contract is the addon's own single
//! dispatch surface — `{"method", "params"}` in, the method's JSON document out, failures in
//! band as `{"error": "Kind: message"}` — documented in `vscode-git-graph-rs/native/core/src/
//! dispatch.rs`, so both runtimes answer identically by construction.
//!
//! The library handle is process-global and lives for the backend's whole run (the engine's
//! warm repository handles live inside it); every request is one C call, safe to make from
//! any of the protocol's request threads.

use std::ffi::{c_char, CStr, CString};
use std::sync::OnceLock;

use libloading::Library;
use serde_json::{json, Value};

/// The one engine call this host makes: one request document in, one answer document out.
type RequestFn = unsafe extern "C" fn(*const c_char, *const c_char) -> *mut c_char;
/// Releases a pointer the library handed out (never null from a successful call).
type FreeFn = unsafe extern "C" fn(*mut c_char);

/// The loaded engine: the library handle (which must outlive every call) and its two
/// functions. `Send + Sync` by construction — a `Library` is, and the functions are plain
/// fn pointers into it.
pub struct Engine {
    _library: Library,
    request: RequestFn,
    free: FreeFn,
    version: &'static str,
}

impl std::fmt::Debug for Engine {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Engine")
            .field("version", &self.version)
            .finish()
    }
}

/// The engine, loaded once. The `.node` path comes from `argv[1]` (how the app's process host
/// spawns this backend: the package's own engine file), or `GGS_ENGINE_NODE` (a probe or a
/// test aiming at any C-ABI engine build). A load failure is remembered — the answer is the
/// same on every retry, and each caller deserves the same one-line reason.
static ENGINE: OnceLock<Result<Engine, String>> = OnceLock::new();

/// The engine file this host was spawned to serve (argv[1], or `GGS_ENGINE_NODE`).
pub fn node_path() -> Option<std::path::PathBuf> {
    std::env::args()
        .nth(1)
        .or_else(|| std::env::var("GGS_ENGINE_NODE").ok())
        .map(std::path::PathBuf::from)
}

/// The installed package the engine file belongs to: the nearest ancestor directory
/// carrying the generated `manifest.json` (the package root, wherever the packer chose to
/// put the `.node` inside it — `native/<platform>/`, `bin/`, the root, …). The manifest's
/// launcher is the one command convention the host answers from it.
pub fn package_root() -> Option<std::path::PathBuf> {
    let mut dir = node_path()?.parent()?.to_path_buf();
    for _ in 0..4 {
        if dir.join("manifest.json").is_file() {
            return Some(dir);
        }
        dir = dir.parent()?.to_path_buf();
    }
    None
}

pub fn engine() -> Result<&'static Engine, String> {
    ENGINE.get_or_init(load).as_ref().map_err(Clone::clone)
}

fn load() -> Result<Engine, String> {
    let path = node_path()
        .ok_or_else(|| "the engine .node path is neither argv[1] nor GGS_ENGINE_NODE".to_owned())?;
    let library = unsafe {
        Library::new(&path)
            .map_err(|e| format!("could not load the engine {}: {e}", path.display()))?
    };
    // The symbol names are the C ABI's stable contract (`native/capi/src/lib.rs`); a .node
    // built without them answers `require` but not a host — named plainly rather than as a
    // naked dlsym error.
    let request = unsafe {
        *library
            .get::<RequestFn>(b"git_graph_capi_request\0")
            .map_err(|_| "the engine file exports no git_graph_capi_request".to_owned())?
    };
    let free = unsafe {
        *library
            .get::<FreeFn>(b"git_graph_capi_string_free\0")
            .map_err(|_| "the engine file exports no git_graph_capi_string_free".to_owned())?
    };
    let version = unsafe {
        let probe = library
            .get::<unsafe extern "C" fn() -> *mut c_char>(b"git_graph_capi_version\0")
            .map_err(|_| "the engine file exports no git_graph_capi_version".to_owned())?;
        let ptr = probe();
        if ptr.is_null() {
            return Err("the engine's version probe answered null".to_owned());
        }
        let text = CStr::from_ptr(ptr).to_string_lossy().into_owned();
        free(ptr);
        text.leak()
    };
    Ok(Engine {
        _library: library,
        request,
        free,
        version,
    })
}

impl Engine {
    /// One engine request: the method and its parameters, answered with the method's own
    /// JSON document. A failure — unknown method, parameters that do not fit, a repository
    /// that cannot be opened — is `Err` with the engine's `Kind: message` string, exactly
    /// what a typed call would throw.
    pub fn request(&self, repo: &str, method: &str, params: Value) -> Result<Value, String> {
        let document = json!({ "method": method, "params": params }).to_string();
        let value = self.request_raw(repo, &document).map_err(|error| format!("{method}: {error}"))?;
        if let Some(error) = value.get("error").and_then(Value::as_str) {
            return Err(error.to_owned());
        }
        Ok(value)
    }

    /// One request document verbatim — the single dispatch surface as the Node addon's
    /// `request` export spells it, and as the frame host's native-module proxy forwards it.
    /// An in-band failure (`{"error": "Kind: message"}`) stays INSIDE the answer document:
    /// the caller's failure path is the document's own error field, exactly the contract the
    /// engine's own dispatch table (documented in the package's `native/core/src/dispatch.rs`)
    /// answers every front end with; only a transport failure (malformed JSON, a null
    /// answer) is `Err`.
    pub fn request_raw(&self, repo: &str, request: &str) -> Result<Value, String> {
        let repo =
            CString::new(repo).map_err(|_| "the repository path is not valid UTF-8".to_owned())?;
        let document =
            CString::new(request).map_err(|_| "the request is not valid UTF-8".to_owned())?;
        let answer = unsafe { (self.request)(repo.as_ptr(), document.as_ptr()) };
        if answer.is_null() {
            return Err("the engine answered nothing".to_owned());
        }
        let text = unsafe { CStr::from_ptr(answer) }
            .to_string_lossy()
            .into_owned();
        unsafe { (self.free)(answer) };
        serde_json::from_str(&text).map_err(|e| format!("malformed answer: {e}"))
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::engine;

    /// The host is loadable and answers over the C ABI. Skipped (not failed) when no engine
    /// file is in reach: the .node is built by the submodule's addon script, which
    /// `prepare.mjs` runs but a bare `cargo test` need not have.
    #[test]
    fn the_engine_answers_over_the_c_abi() {
        if engine().is_err() {
            eprintln!("skipping: no engine .node in reach (argv[1] / GGS_ENGINE_NODE)");
            return;
        }
        let engine = engine().unwrap();
        assert!(!engine
            .request("", "engineVersion", serde_json::Value::Null)
            .is_err());
        // A repository-shaped path that is not one answers in band, with the kind prefix.
        let nowhere = std::env::temp_dir().join("ggs-engine-nowhere");
        let error = engine
            .request(&nowhere.display().to_string(), "repoRoot", json!({}))
            .unwrap_err();
        assert!(error.starts_with("NotARepository: "), "{error}");
    }
}
