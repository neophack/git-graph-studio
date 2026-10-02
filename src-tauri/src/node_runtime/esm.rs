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

use std::cell::Cell;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

use boa_engine::module::{Module, ModuleLoader, Referrer, SyntheticModuleInitializer};
use boa_engine::{
    Context, JsError, JsNativeError, JsObject, JsResult, JsString, JsValue, Script, Source,
};

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

thread_local! {
    /// Set while [`require_esm`] reloads a module graph after its register-local compile
    /// failed: every ES module parsed meanwhile — the root and each import the loader
    /// parses — keeps all its bindings in their environments. The register-or-escaping
    /// choice is made by the parse's scope analysis, so the reload has to reach the
    /// loader's parses too, not just the root's.
    static FORCE_ESCAPING: Cell<bool> = const { Cell::new(false) };
}

/// Run `body` with [`FORCE_ESCAPING`] set, clearing it again whatever `body` answers.
fn with_forced_escaping<T>(body: impl FnOnce() -> T) -> T {
    struct Reset;
    impl Drop for Reset {
        fn drop(&mut self) {
            FORCE_ESCAPING.with(|flag| flag.set(false));
        }
    }
    FORCE_ESCAPING.with(|flag| flag.set(true));
    let _reset = Reset;
    body()
}

/// The resolved file as a module record, cached by path: an ES module parsed from its
/// source, anything else loaded through `require` and wrapped.
fn load_path(path: &Path, context: &mut Context) -> JsResult<Module> {
    if let Some(cached) = with_state(|state| state.esm_cache.get(path).cloned()) {
        return Ok(cached);
    }
    let module = if is_esm(path) {
        let bytes = std::fs::read(path).map_err(|error| {
            JsError::from_native(
                JsNativeError::error().with_message(format!("{}: {error}", path.display())),
            )
        })?;
        // GGS-patch: only the PARSE happens here — Boa compiles a module's bytecode when
        // the graph links (`SourceTextModule::initialize_environment`), so the compile's
        // walls (a panic, a baked static TDZ throw) are checked by `require_esm` around
        // `link`, which reloads the graph through FORCE_ESCAPING. What this parse guards
        // is its own scope analysis: an error or a panic there degrades to the
        // all-escaping parse rather than failing the import.
        let parsed = if FORCE_ESCAPING.with(Cell::get) {
            parse_esm(&bytes, path, true, context)
        } else {
            match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                parse_esm(&bytes, path, false, context)
            })) {
                Ok(Ok(parsed)) => Ok(parsed),
                Ok(Err(error)) => parse_esm(&bytes, path, true, context).map_err(|_| error),
                Err(_panic) => {
                    with_state(|state| {
                        state.log(
                            "warn",
                            &format!(
                                "{}: the register-local module parse panicked; reparsing all-escaping",
                                path.display()
                            ),
                        );
                    });
                    parse_esm(&bytes, path, true, context)
                }
            }
        };
        parsed.map_err(|error| {
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

/// One ES-module parse, register-local or all-escaping.
fn parse_esm(bytes: &[u8], path: &Path, escaping: bool, context: &mut Context) -> JsResult<Module> {
    let source = Source::from_bytes(bytes).with_path(path);
    if escaping {
        Module::parse_all_bindings_escaping(source, None, context)
    } else {
        Module::parse(source, None, context)
    }
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
///
/// GGS-patch: the register-local compile has walls the CommonJS path checks in
/// `require.rs`, and the module path checks them here, around `link` — where Boa compiles
/// every module of the graph:
///
/// - **panic**: the compile can PANIC inside the bytecompiler (Kimi Code's 8.8 MB entry
///   tripped "binding must exist" in its var instantiation);
/// - **baked TDZ**: a register-local binding used before its declaration point compiles
///   to a static TDZ throw, wrong for every use that runs after initialization.
///
/// Either one discards the modules this call added and reloads the graph with every
/// binding escaping (FORCE_ESCAPING) before anything has evaluated. As a backstop, an
/// evaluation that still throws "access of uninitialized binding" reloads the same way
/// and evaluates once more — the second attempt is a different image, never the one that
/// just threw; a module of the failed graph that had already evaluated runs again.
pub(crate) fn require_esm(path: &Path, context: &mut Context) -> JsResult<JsValue> {
    let fail = |message: String| {
        JsError::from_native(
            JsNativeError::error().with_message(format!("{}: {message}", path.display())),
        )
    };
    let known: HashSet<PathBuf> = with_state(|state| state.esm_cache.keys().cloned().collect());

    let module = load_path(path, context)?;
    let (module, escaping) = match load_and_link(&module, context).map_err(fail)? {
        Linked::Clean => (module, false),
        Linked::Degraded(why) => {
            with_state(|state| {
                state.log(
                    "warn",
                    &format!(
                        "{}: the register-local module compile {why}; recompiling all-escaping",
                        path.display()
                    ),
                );
            });
            (reload_escaping(path, &known, context).map_err(fail)?, true)
        }
    };

    let promise = module.evaluate(context);
    let evaluated = settle(context, promise.into());
    let module = match evaluated {
        Err(message) if !escaping && message.contains("access of uninitialized binding") => {
            let module = reload_escaping(path, &known, context).map_err(fail)?;
            let promise = module.evaluate(context);
            settle(context, promise.into()).map_err(fail)?;
            module
        }
        other => {
            other.map_err(fail)?;
            module
        }
    };
    Ok(module.namespace(context).into())
}

/// How a module graph's link went.
enum Linked {
    /// Compiled register-local without tripping a wall.
    Clean,
    /// The register-local compile hit a wall; the reason, for the log.
    Degraded(&'static str),
}

/// Load a module's imports, then link the graph — compiling every module in it — with the
/// register-local walls checked: a panic or a tripped static TDZ throw answers
/// [`Linked::Degraded`]; a genuine link error (a missing export) is an error.
fn load_and_link(module: &Module, context: &mut Context) -> Result<Linked, String> {
    let promise = module.load(context);
    settle(context, promise.into())?;
    Script::reset_uninitialized_local_trip();
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| module.link(context))) {
        Err(_panic) => Ok(Linked::Degraded("panicked")),
        Ok(Err(error)) => Err(error.to_string()),
        Ok(Ok(())) if Script::tripped_uninitialized_local() => Ok(Linked::Degraded(
            "used a binding before its declaration point",
        )),
        Ok(Ok(())) => Ok(Linked::Clean),
    }
}

/// Forget every module the failed attempt added (anything not in `known`) and the root
/// itself (cached by an earlier call, it is the very image that failed), then load and
/// link `path`'s graph again with every binding escaping.
fn reload_escaping(
    path: &Path,
    known: &HashSet<PathBuf>,
    context: &mut Context,
) -> Result<Module, String> {
    with_state(|state| {
        state
            .esm_cache
            .retain(|cached, _| cached != path && known.contains(cached));
    });
    let module = with_forced_escaping(|| {
        let module = load_path(path, context).map_err(|error| error.to_string())?;
        let promise = module.load(context);
        settle(context, promise.into())?;
        Ok::<_, String>(module)
    })?;
    module.link(context).map_err(|error| error.to_string())?;
    Ok(module)
}
