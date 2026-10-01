//! The ES-module half of the pretend Node runtime: Boa's module machinery driven by Node's
//! own rules, so a package whose code is ESM — a `"type": "module"` extension `main`
//! (prettier-vscode's), the `.mjs` files a library ships (prettier's own `index.mjs` and
//! its plugin chunks), a dynamic `import()` of either — loads the way node.exe loads it.
//!
//! - **Which files are ESM**: `.mjs` always, `.cjs` never, `.js` when the nearest
//!   `package.json` says `"type": "module"` ([`is_esm`]).
//! - **Resolution**: `node:` and bare builtin names answer the builtin registry; `file://`
//!   URLs and relative / absolute paths resolve from the importing module's directory;
//!   bare names walk `node_modules` with the `package.json` `exports` map under the
//!   `import` conditions (`require.rs` owns the walk — one resolver, two condition sets).
//! - **Interop both ways**: an import of a CommonJS module, a JSON file or a builtin is a
//!   synthetic module whose `default` is the `module.exports` value and whose named
//!   exports are its own keys (Node's cjs-module-lexer answers the same names for the
//!   bundles packages actually ship); a `require` of an ES module evaluates it to
//!   settlement and answers its namespace — Node 22's `require(esm)`.
//! - **`import.meta`**: `url`, `filename`, `dirname` and `resolve()`.
//!
//! Parsed modules are cached per path in the runtime state, which the JS thread drops
//! with its context (the `Module` records live in the Boa heap).

use std::path::{Path, PathBuf};

use boa_engine::module::{Module, ModuleLoader, Referrer, SyntheticModuleInitializer};
use boa_engine::{Context, JsError, JsNativeError, JsObject, JsResult, JsString, JsValue, Source};

use crate::node_runtime::{key, require, settle, text, with_state};

/// The conditions an `import` resolves `exports` under, in Node's own set.
pub(crate) const IMPORT_CONDITIONS: &[&str] = &["node", "import", "default"];

/// The loader the JS thread's context is built with.
pub(crate) struct NodeModuleLoader;

impl ModuleLoader for NodeModuleLoader {
    // Boa's hook is async; every load here is synchronous file I/O, so the future is
    // ready at its first poll.
    async fn load_imported_module(
        self: std::rc::Rc<Self>,
        referrer: Referrer,
        specifier: JsString,
        context: &std::cell::RefCell<&mut Context>,
    ) -> JsResult<Module> {
        // A module's imports resolve from its own directory; a script's (the CommonJS
        // wrapper is a direct eval, so it has no path of its own) from the package root.
        let base = referrer
            .path()
            .and_then(Path::parent)
            .map(Path::to_path_buf)
            .unwrap_or_else(|| with_state(|state| state.package_root.clone()));
        load(
            &base,
            &specifier.to_std_string_escaped(),
            &mut context.borrow_mut(),
        )
    }

    fn init_import_meta(
        self: std::rc::Rc<Self>,
        import_meta: &JsObject,
        module: &Module,
        context: &mut Context,
    ) {
        let Some(path) = module.path() else {
            return;
        };
        let Ok(init) = context
            .global_object()
            .get(key("__ggsInitImportMeta"), context)
        else {
            return;
        };
        if let Some(init) = init.as_callable() {
            let _ = init.call(
                &JsValue::undefined(),
                &[import_meta.clone().into(), text(path.display().to_string())],
                context,
            );
        }
    }
}

/// Whether a JavaScript file is an ES module by Node's rules.
pub(crate) fn is_esm(path: &Path) -> bool {
    match path.extension().and_then(|e| e.to_str()) {
        Some("mjs") => true,
        Some("js") => nearest_package_type(path).as_deref() == Some("module"),
        _ => false,
    }
}

/// The `type` of the nearest `package.json` above a file — the first one found decides,
/// whatever it says (Node's package scope).
fn nearest_package_type(path: &Path) -> Option<String> {
    let mut dir = path.parent();
    while let Some(current) = dir {
        let manifest = current.join("package.json");
        if manifest.is_file() {
            let value = std::fs::read_to_string(&manifest)
                .ok()
                .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())?;
            return value
                .get("type")
                .and_then(|t| t.as_str())
                .map(str::to_owned);
        }
        dir = current.parent();
    }
    None
}

/// One import: a builtin, else a resolved file as the module kind its path decides.
fn load(base: &Path, specifier: &str, context: &mut Context) -> JsResult<Module> {
    if let Some(value) = crate::node_runtime::builtins::builtin_module(specifier, context)? {
        let name = specifier.strip_prefix("node:").unwrap_or(specifier);
        let cache_key = PathBuf::from(format!("ggs-builtin:{name}"));
        if let Some(cached) = with_state(|state| state.esm_cache.get(&cache_key).cloned()) {
            return Ok(cached);
        }
        let module = synthetic(value, None, context)?;
        with_state(|state| state.esm_cache.insert(cache_key, module.clone()));
        return Ok(module);
    }
    let resolved = resolve_import(base, specifier)
        .map_err(|message| JsError::from_native(JsNativeError::error().with_message(message)))?;
    load_path(&resolved, context)
}

/// The resolved file as a module record, cached by path: an ES module parsed from its
/// source, anything else loaded through `require` and wrapped.
fn load_path(path: &Path, context: &mut Context) -> JsResult<Module> {
    if let Some(cached) = with_state(|state| state.esm_cache.get(path).cloned()) {
        return Ok(cached);
    }
    let module = if is_esm(path) {
        let source = std::fs::read(path).map_err(|error| {
            JsError::from_native(
                JsNativeError::error().with_message(format!("{}: {error}", path.display())),
            )
        })?;
        // GGS-patch: the register-local compile of a big third-party module can PANIC
        // inside Boa's scope analysis (Kimi Code's 8.8 MB entry tripped "binding must
        // exist" in the bytecompiler's var instantiation). The panic unwinds through
        // the JS thread's job — contained since the job-level guard — but the module
        // still failed. The degrade: re-parse with every binding kept in its
        // environment (the module twin of the CommonJS path's all-escaping recompile),
        // and the compile degrades instead of the package dying.
        Module::parse(Source::from_bytes(&source).with_path(path), None, context)
            .or_else(|_| {
                Module::parse_all_bindings_escaping(
                    Source::from_bytes(&source).with_path(path),
                    None,
                    context,
                )
            })
            .map_err(|error| {
                JsError::from_native(
                    JsNativeError::syntax().with_message(format!("{}: {error}", path.display())),
                )
            })?
    } else {
        let parent = path.parent().map(Path::to_path_buf).unwrap_or_default();
        let exports = require::require(&parent, &path.display().to_string(), context)?;
        synthetic(exports, Some(path.to_path_buf()), context)?
    };
    with_state(|state| state.esm_cache.insert(path.to_path_buf(), module.clone()));
    Ok(module)
}

/// An import specifier resolved to a file: `file://` URLs, paths, then the package walk
/// under the import conditions.
fn resolve_import(base: &Path, specifier: &str) -> Result<PathBuf, String> {
    if let Some(rest) = specifier.strip_prefix("file://") {
        return Ok(file_url_path(rest));
    }
    require::resolve_with(base, specifier, IMPORT_CONDITIONS)
}

/// The path of a `file://` URL's remainder (`/C:/a%20b/x.mjs` → `C:\a b\x.mjs`).
fn file_url_path(rest: &str) -> PathBuf {
    let rest = rest.split(['?', '#']).next().unwrap_or_default();
    let decoded = percent_decode(rest);
    // `file:///C:/x` on Windows — the drive follows the root slash; elsewhere the path is
    // the whole remainder (`file:///usr/x` → `/usr/x`).
    let bytes = decoded.as_bytes();
    let path = if bytes.len() >= 3 && bytes[0] == b'/' && bytes[2] == b':' {
        decoded[1..].to_owned()
    } else {
        decoded
    };
    PathBuf::from(path)
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(&text[i + 1..i + 3], 16) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// A synthetic module over a value: `default` is the value, and every own enumerable
/// string key of an object value is a named export (a `default` key stays the value's —
/// Node's CommonJS interop).
fn synthetic(value: JsValue, path: Option<PathBuf>, context: &mut Context) -> JsResult<Module> {
    let mut names = vec![JsString::from("default")];
    if value.is_object() {
        // `Object.keys` — own, enumerable, string-keyed: exactly the export candidates.
        let object_ctor = context.global_object().get(key("Object"), context)?;
        let keys_fn = object_ctor
            .as_object()
            .map(|ctor| ctor.get(key("keys"), context))
            .transpose()?
            .unwrap_or_default();
        if let Some(keys_fn) = keys_fn.as_callable() {
            #[allow(clippy::cloned_ref_to_slice_refs)]
            // a one-element hand slice reads clearer here
            let listed = keys_fn.call(&JsValue::undefined(), &[value.clone()], context)?;
            if let Some(listed) = listed.as_object() {
                let length = listed.get(key("length"), context)?.to_length(context)?;
                for index in 0..length {
                    let name = listed.get(index, context)?.to_string(context)?;
                    if name.to_std_string_escaped() != "default" {
                        names.push(name);
                    }
                }
            }
        }
    }
    let initializer = SyntheticModuleInitializer::from_copy_closure_with_captures(
        |module, (value, names): &(JsValue, Vec<JsString>), context| {
            module.set_export(&JsString::from("default"), value.clone())?;
            if let Some(object) = value.as_object() {
                for name in names.iter().skip(1) {
                    let member = object.get(name.clone(), context)?;
                    module.set_export(name, member)?;
                }
            }
            Ok(())
        },
        (value, names.clone()),
    );
    Ok(Module::synthetic(&names, initializer, path, None, context))
}

/// `require(esm)`: the module loaded, linked and evaluated to settlement (top-level
/// `await` included — the pump runs timers and child events meanwhile), answering its
/// namespace object.
pub(crate) fn require_esm(path: &Path, context: &mut Context) -> JsResult<JsValue> {
    let module = load_path(path, context)?;
    let promise = module.load_link_evaluate(context);
    let result = settle(context, promise.into());
    // GGS-patch: "access of uninitialized binding" on an ESM entry is usually the
    // register-local compile's static TDZ throw firing on a use that runs AFTER
    // initialization (the vendor note: wrong for every such site) — real Node runs the
    // same file. The scripts path already recompiles all-escaping on that trip; the
    // module path now does too: re-parse with every binding in its environment, replace
    // the cache entry, and evaluate once more.
    if let Err(message) = &result {
        if message.contains("access of uninitialized binding") {
            with_state(|state| {
                state.esm_cache.remove(path);
            });
            let module = load_path(path, context)?;
            let promise = module.load_link_evaluate(context);
            settle(context, promise.into()).map_err(|retried| {
                JsError::from_native(
                    JsNativeError::error().with_message(format!("{}: {retried}", path.display())),
                )
            })?;
            return Ok(module.namespace(context).into());
        }
    }
    result.map_err(|message| {
        JsError::from_native(
            JsNativeError::error().with_message(format!("{}: {message}", path.display())),
        )
    })?;
    Ok(module.namespace(context).into())
}
