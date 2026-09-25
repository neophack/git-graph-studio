//! The CommonJS half of the pretend Node runtime: `require` resolved and evaluated the way
//! Node resolves it — relative and absolute specifiers against the requiring module, bare
//! names through `node_modules` walks, `package.json` `main` entries, `index` fallbacks,
//! the `.js` / `.json` extensions — with a module cache that answers cycles the
//! way Node does (a mid-execution require of the cycle sees the partial `exports`).
//!
//! Two deliberate confinements, both visible to the caller: bare-specifier walks stop at the
//! package root (a package's `node_modules` never escapes its install directory), and only
//! the builtins `builtins.rs` registers resolve as core modules — `require('vscode')`
//! answers with the frame-host stub, everything else unknown is Node's `MODULE_NOT_FOUND`
//! message.

use std::path::{Path, PathBuf};

use boa_engine::{
    Context, JsError, JsNativeError, JsObject, JsResult, JsValue, NativeFunction,
};

use crate::node_runtime::{key, text, with_state};
use boa_engine::JsArgs;

/// The extension→kind table `require` dispatches on, in Node's own order. A `.node` is a
/// native addon: it loads through its NAPI registration (`native.rs` + `napi_host.rs` —
/// this process is the N-API host), never by evaluation — the module that answers is the
/// exports object its registration builds.
#[derive(PartialEq, Eq, Clone, Copy, Debug)]
enum Kind {
    Js,
    Json,
    Node,
}

fn kind_of(path: &Path) -> Option<Kind> {
    match path.extension()?.to_str()? {
        "js" | "cjs" | "mjs" => Some(Kind::Js),
        "json" => Some(Kind::Json),
        "node" => Some(Kind::Node),
        _ => None,
    }
}

/// The entry `require(parent, specifier)` — the parent is the requiring module's directory,
/// bound into its own closure by the prelude's `__ggsMakeRequire`.
pub fn require(parent: &Path, specifier: &str, context: &mut Context) -> JsResult<JsValue> {
    if let Some(builtin) = super::builtins::builtin_module(specifier, context)? {
        return Ok(builtin);
    }
    let resolved = resolve(parent, specifier).map_err(not_found_error)?;
    if let Some(cached) = with_state(|state| state.module_cache.get(&resolved).cloned()) {
        return Ok(cached);
    }
    match kind_of(&resolved) {
        Some(Kind::Json) => {
            let text = std::fs::read_to_string(&resolved).map_err(fs_error(&resolved))?;
            let value: serde_json::Value =
                serde_json::from_str(&text).map_err(|e| parse_error(&resolved, e))?;
            JsValue::from_json(&value, context)
        }
        Some(Kind::Js) => {
            let source = std::fs::read_to_string(&resolved).map_err(fs_error(&resolved))?;
            evaluate_module(&resolved, &source, context)
        }
        Some(Kind::Node) => {
            let (_index, module) = super::native::load(&resolved, context).map_err(|message| {
                JsError::from_native(
                    JsNativeError::error()
                        .with_message(format!("{}: {message}", resolved.display())),
                )
            })?;
            with_state(|state| {
                state.module_cache.insert(resolved, module.clone().into());
            });
            Ok(module.into())
        }
        None => Err(not_found_error(not_found(specifier))),
    }
}

/// The `require.resolve(specifier)` half: the resolution only, as a string.
pub fn resolve(parent: &Path, specifier: &str) -> Result<PathBuf, String> {
    let looks_relative = specifier.starts_with("./")
        || specifier.starts_with("../")
        || specifier.starts_with('/')
        || specifier.starts_with('\\')
        || Path::new(specifier)
            .components()
            .next()
            .is_some_and(|first| {
                matches!(
                    first,
                    std::path::Component::Prefix(_) | std::path::Component::RootDir
                )
            });
    if looks_relative {
        let target = normalize(&parent.join(specifier));
        return resolve_path(&target).ok_or_else(|| not_found(specifier));
    }
    let root = with_state(|state| state.package_root.clone());
    let mut dir = Some(parent.to_path_buf());
    while let Some(current) = dir {
        let modules = current.join("node_modules");
        if modules.is_dir() {
            if let Some(path) = resolve_path(&normalize(&modules.join(specifier))) {
                return Ok(path);
            }
        }
        if current == root {
            break;
        }
        dir = current.parent().map(Path::to_path_buf);
    }
    Err(not_found(specifier))
}

fn not_found(specifier: &str) -> String {
    format!("Cannot find module '{specifier}'")
}

fn not_found_error(message: String) -> JsError {
    JsError::from_native(JsNativeError::error().with_message(message))
}

fn fs_error(path: &Path) -> impl Fn(std::io::Error) -> JsError + '_ {
    move |error| {
        JsError::from_native(
            JsNativeError::error().with_message(format!("{}: {error}", path.display())),
        )
    }
}

fn parse_error(path: &Path, error: serde_json::Error) -> JsError {
    JsError::from_native(
        JsNativeError::error().with_message(format!("{}: {error}", path.display())),
    )
}

/// One resolved path, exact or with an added extension, or as a directory (`package.json`
/// `main`, then `index`).
fn resolve_path(target: &Path) -> Option<PathBuf> {
    if target.is_file() {
        return if kind_of(target).is_some() {
            Some(target.to_path_buf())
        } else {
            None
        };
    }
    // The extension-append guesses never reach `.node`: a native addon's specifier
    // carries its extension (`require('./native/<platform>/git-graph.node')`).
    for extension in ["js", "json"] {
        let mut with_extension = target.to_path_buf();
        with_extension.set_extension(extension);
        if with_extension.is_file() {
            return Some(with_extension);
        }
    }
    if target.is_dir() {
        if let Ok(manifest) = std::fs::read_to_string(target.join("package.json")) {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&manifest) {
                if let Some(main) = value.get("main").and_then(|m| m.as_str()) {
                    let entry = normalize(&target.join(main));
                    if entry.is_file() {
                        return Some(entry);
                    }
                    if let Some(resolved) = resolve_path(&entry) {
                        return Some(resolved);
                    }
                }
            }
        }
        for name in ["index.js", "index.json"] {
            let index = target.join(name);
            if index.is_file() {
                return Some(index);
            }
        }
    }
    None
}

/// Collapse `.` and `..` segments lexically — resolution runs on paths the runtime was
/// handed, never on user text, so a plain lexical walk is the whole job.
fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

fn string_arg(args: &[JsValue], at: usize, context: &mut Context) -> String {
    args.get_or_undefined(at)
        .to_string(context)
        .map(|s| s.to_std_string_escaped())
        .unwrap_or_default()
}

/// Evaluate one CommonJS module: the Node `(function(exports, require, module, __filename,
/// __dirname) { … })` wrapper, a per-module `require` whose parent directory is this
/// module's, and the cache-before-evaluate insert that makes a require cycle answer with
/// the partial `exports`.
fn evaluate_module(path: &Path, source: &str, context: &mut Context) -> JsResult<JsValue> {
    let dir = path.parent().map(Path::to_path_buf).unwrap_or_default();
    // The wrapper is compiled by the prelude's `__ggsCompileModule` — a DIRECT eval inside
    // the helper's own frame — never the `Function` constructor and never a Rust-side
    // `context.eval`. Both of those are Boa 0.20 environment bugs (pinned in
    // `tests/vscode_shim_boa.rs`): the `Function` constructor compiles the module's nested
    // functions with binding locators that panic (`PutLexicalValue`, "must be declarative
    // environment") the moment one of the module's closures runs later — e.g. a handler
    // answering a request with `new Promise((resolve) => setTimeout(() => resolve(…)))` —
    // and a script `eval` from inside a running frame (a nested `require`) hands the
    // wrapper the caller's environment chain, whose depth the wrapper's own locators
    // never assumed. The direct eval compiles against the helper's scope and the wrapper
    // captures that same chain, so the locators are consistent wherever the load runs.
    let compiler = context
        .global_object()
        .get(key("__ggsCompileModule"), context)?;
    let compiler = compiler.as_callable().ok_or_else(|| {
        internal("the prelude's module compiler is missing (the prelude did not run)")
    })?;
    let function = compiler
        .call(&JsValue::undefined(), &[text(source)], context)?
        .as_object()
        .cloned()
        .ok_or_else(|| internal("the module compiler answered no function"))?;
    let exports = JsObject::with_object_proto(context.intrinsics());
    let module = JsObject::with_object_proto(context.intrinsics());
    module.set(key("exports"), exports.clone(), false, context)?;
    let require_function = make_require_function(&dir, context)?;
    with_state(|state| {
        state
            .module_cache
            .insert(path.to_path_buf(), exports.clone().into());
    });
    let result = function.call(
        &JsValue::undefined(),
        &[
            exports.clone().into(),
            require_function.into(),
            module.clone().into(),
            text(path.display().to_string()),
            text(dir.display().to_string()),
        ],
        context,
    );
    result?;
    // The module may have replaced `module.exports` wholesale — that is what the cache and
    // the caller take.
    let final_exports = module.get(key("exports"), context)?;
    with_state(|state| {
        state
            .module_cache
            .insert(path.to_path_buf(), final_exports.clone());
    });
    Ok(final_exports)
}

/// One module's own `require`, bound to this module's directory through the prelude's
/// closure (so a function the module exports and calls later still requires from home),
/// with `resolve` and `cache` attached the way Node's carries them.
fn make_require_function(parent: &Path, context: &mut Context) -> JsResult<JsObject> {
    let maker = context
        .global_object()
        .get(key("__ggsMakeRequire"), context)?;
    let maker = maker
        .as_callable()
        .ok_or_else(|| internal("the prelude's require maker is missing"))?;
    let parent_value = text(parent.display().to_string());
    let function = maker.call(&JsValue::undefined(), &[parent_value], context)?;
    function
        .as_object()
        .cloned()
        .ok_or_else(|| internal("the prelude's require maker did not answer a function"))
}

fn internal(message: &str) -> JsError {
    JsError::from_native(JsNativeError::error().with_message(message.to_owned()))
}

/// The two natives the prelude's `__ggsMakeRequire` binds its closures over: the module
/// half of `require`/`require.resolve`, with the parent directory as their first argument.
pub(crate) fn register_natives(context: &mut Context) -> JsResult<()> {
    context.register_global_callable(
        "__ggsRequire".into(),
        2,
        NativeFunction::from_fn_ptr(require_native),
    )?;
    context.register_global_callable(
        "__ggsResolve".into(),
        2,
        NativeFunction::from_fn_ptr(resolve_native),
    )?;
    Ok(())
}

fn require_native(_this: &JsValue, args: &[JsValue], context: &mut Context) -> JsResult<JsValue> {
    let parent = PathBuf::from(string_arg(args, 0, context));
    let specifier = string_arg(args, 1, context);
    require(&parent, &specifier, context)
}

fn resolve_native(_this: &JsValue, args: &[JsValue], context: &mut Context) -> JsResult<JsValue> {
    let parent = PathBuf::from(string_arg(args, 0, context));
    let specifier = string_arg(args, 1, context);
    let resolved = resolve(&parent, &specifier).map_err(not_found_error)?;
    Ok(text(resolved.display().to_string()))
}
