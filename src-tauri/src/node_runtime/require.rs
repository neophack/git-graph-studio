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
    Context, JsError, JsNativeError, JsObject, JsResult, JsValue, NativeFunction, Script, Source,
};


use crate::node_runtime::{key, text, with_state};
use boa_engine::JsArgs;

/// The deepest single-frame register file a module may compile to before its wrapper is
/// recompiled with every binding escaping (see `evaluate_module`): the VM stack limit is
/// 10 240 slots shared by every frame, and Boa 0.21.1 checks it only between calls — one
/// huge frame reads past it unchecked. Real module code's functions sit in the tens;
/// only a mega bundle wrapper ever approaches this.
const REGISTER_LOCALS_LIMIT: u32 = 4096;

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
        // An ES module answers its namespace (Node 22's `require(esm)`), evaluated to
        // settlement by the ESM half.
        Some(Kind::Js) if super::esm::is_esm(&resolved) => {
            let namespace = super::esm::require_esm(&resolved, context)?;
            with_state(|state| {
                state.module_cache.insert(resolved, namespace.clone());
            });
            Ok(namespace)
        }
        Some(Kind::Js) => {
            let source = std::fs::read_to_string(&resolved).map_err(fs_error(&resolved))?;
            if std::env::var("GGS_TRACE_BOOT").is_ok() {
                std::eprintln!(
                    "[boot] evaluate_module {} ({} bytes, head: {})",
                    resolved.display(),
                    source.len(),
                    source
                        .chars()
                        .take(60)
                        .collect::<String>()
                        .replace(char::is_whitespace, " ")
                );
            }
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

/// The conditions a `require` resolves `exports` under, in Node's own set.
pub(crate) const REQUIRE_CONDITIONS: &[&str] = &["node", "require", "default"];

/// The `require.resolve(specifier)` half: the resolution only, as a string.
pub fn resolve(parent: &Path, specifier: &str) -> Result<PathBuf, String> {
    resolve_with(parent, specifier, REQUIRE_CONDITIONS)
}

/// One resolver for both module systems, differing only in the `exports` / `imports`
/// conditions: relative and absolute specifiers against `parent`, `#` specifiers through
/// the enclosing package's `imports`, bare names through the `node_modules` walk — a
/// package with an `exports` map answers from the map alone (Node's encapsulation), one
/// without falls back to the `main` / `index` / extension guesses.
pub(crate) fn resolve_with(
    parent: &Path,
    specifier: &str,
    conditions: &[&str],
) -> Result<PathBuf, String> {
    let looks_relative = specifier.starts_with("./")
        || specifier.starts_with("../")
        || specifier == "."
        || specifier == ".."
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
    if specifier.starts_with('#') {
        return resolve_package_import(parent, specifier, conditions)
            .ok_or_else(|| not_found(specifier));
    }
    let (name, subpath) = split_package_specifier(specifier);
    let root = with_state(|state| state.package_root.clone());
    let mut dir = Some(parent.to_path_buf());
    while let Some(current) = dir {
        let modules = current.join("node_modules");
        if modules.is_dir() {
            let package = modules.join(name);
            if let Some(exports) = read_manifest(&package).and_then(|m| m.get("exports").cloned()) {
                // The map is the package's whole public surface: a subpath it does not
                // list is not found, however the files lie.
                return resolve_exports(&package, &exports, &subpath, conditions)
                    .ok_or_else(|| not_found(specifier));
            }
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

/// `@scope/name/sub/path` → (`@scope/name`, `./sub/path`); `name` → (`name`, `.`).
fn split_package_specifier(specifier: &str) -> (&str, String) {
    let needed = if specifier.starts_with('@') { 2 } else { 1 };
    let cut = specifier
        .match_indices('/')
        .nth(needed - 1)
        .map(|(at, _)| at)
        .unwrap_or(specifier.len());
    let (name, rest) = specifier.split_at(cut);
    let subpath = if rest.is_empty() {
        ".".to_owned()
    } else {
        format!(".{rest}")
    };
    (name, subpath)
}

fn read_manifest(package: &Path) -> Option<serde_json::Value> {
    let text = std::fs::read_to_string(package.join("package.json")).ok()?;
    serde_json::from_str(&text).ok()
}

/// A `package.json` `exports` map resolved for one subpath: the sugar forms (a string, an
/// array, a bare conditions object) mean the `.` entry; exact keys win, then the `*`
/// pattern with the longest prefix, then the legacy trailing-slash folders.
fn resolve_exports(
    package: &Path,
    exports: &serde_json::Value,
    subpath: &str,
    conditions: &[&str],
) -> Option<PathBuf> {
    let is_subpath_map = exports
        .as_object()
        .is_some_and(|map| map.keys().next().is_some_and(|k| k.starts_with('.')));
    if !is_subpath_map {
        return if subpath == "." {
            resolve_target(package, exports, None, conditions)
        } else {
            None
        };
    }
    let map = exports.as_object()?;
    if let Some(target) = map.get(subpath) {
        return resolve_target(package, target, None, conditions);
    }
    let mut best: Option<(usize, &serde_json::Value, String)> = None;
    for (pattern, target) in map {
        if let Some(star) = pattern.find('*') {
            let (prefix, suffix) = (&pattern[..star], &pattern[star + 1..]);
            if subpath.len() >= prefix.len() + suffix.len()
                && subpath.starts_with(prefix)
                && subpath.ends_with(suffix)
                && best.as_ref().is_none_or(|(len, _, _)| prefix.len() > *len)
            {
                let matched = subpath[prefix.len()..subpath.len() - suffix.len()].to_owned();
                best = Some((prefix.len(), target, matched));
            }
        } else if pattern.ends_with('/') && subpath.starts_with(pattern.as_str()) {
            if let serde_json::Value::String(folder) = target {
                let rest = &subpath[pattern.len()..];
                return resolve_path(&normalize(&package.join(folder).join(rest)));
            }
        }
    }
    let (_, target, matched) = best?;
    resolve_target(package, target, Some(&matched), conditions)
}

/// One `exports` / `imports` target: a path (with its `*` filled), the first resolvable
/// entry of an array, or the first matching condition of an object in its own key order.
fn resolve_target(
    package: &Path,
    target: &serde_json::Value,
    star: Option<&str>,
    conditions: &[&str],
) -> Option<PathBuf> {
    match target {
        serde_json::Value::String(path) => {
            let filled = match star {
                Some(star) => path.replace('*', star),
                None => path.clone(),
            };
            if !filled.starts_with("./") {
                // Package-relative targets only (a bare `imports` target is handled by
                // the caller; `exports` may never name another package).
                return None;
            }
            let full = normalize(&package.join(&filled));
            if full.is_file() {
                Some(full)
            } else {
                resolve_path(&full)
            }
        }
        serde_json::Value::Array(options) => options
            .iter()
            .find_map(|option| resolve_target(package, option, star, conditions)),
        serde_json::Value::Object(map) => map.iter().find_map(|(condition, nested)| {
            (condition == "default" || conditions.contains(&condition.as_str()))
                .then(|| resolve_target(package, nested, star, conditions))
                .flatten()
        }),
        _ => None,
    }
}

/// A `#name` specifier through the nearest enclosing package's `imports` map.
fn resolve_package_import(parent: &Path, specifier: &str, conditions: &[&str]) -> Option<PathBuf> {
    let mut dir = Some(parent);
    while let Some(current) = dir {
        if let Some(manifest) = read_manifest(current) {
            let imports = manifest.get("imports")?.as_object()?;
            let (target, matched) = match imports.get(specifier) {
                Some(target) => (target, None),
                None => imports.iter().find_map(|(pattern, target)| {
                    let star = pattern.find('*')?;
                    let (prefix, suffix) = (&pattern[..star], &pattern[star + 1..]);
                    (specifier.len() >= prefix.len() + suffix.len()
                        && specifier.starts_with(prefix)
                        && specifier.ends_with(suffix))
                    .then(|| {
                        let matched = &specifier[prefix.len()..specifier.len() - suffix.len()];
                        (target, Some(matched.to_owned()))
                    })
                })?,
            };
            // A bare target names a dependency: resolved from this package as an import.
            if let Some(bare) = target.as_str().filter(|t| !t.starts_with("./")) {
                let bare = match &matched {
                    Some(star) => bare.replace('*', star),
                    None => bare.to_owned(),
                };
                return resolve_with(current, &bare, conditions).ok();
            }
            return resolve_target(current, target, matched.as_deref(), conditions);
        }
        dir = current.parent();
    }
    None
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
    for extension in ["js", "json", "mjs", "cjs"] {
        // Appended, never substituted: `./chunk.min` gains `.js`, it does not become
        // `./chunk.js`.
        let mut with_extension = target.as_os_str().to_owned();
        with_extension.push(".");
        with_extension.push(extension);
        let with_extension = PathBuf::from(with_extension);
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

/// A cacheable top-level script (the prelude, the `vscode` shim): a declarations-free
/// source — IIFEs and `globalThis` assignments — whose parse and compile would otherwise
/// be paid on every backend start. The same blob scheme as `evaluate_module`'s wrapper:
/// the compiled tree cached by the source's SHA-256 (namespaced by `tag`), register
/// locals first under the same two guards, `Script::from_compiled` skipping the parse on
/// a hit. A source WITH top-level declarations must not take this path — global
/// declaration instantiation lives inside the compile this skips.
pub(crate) fn evaluate_cached_script(
    tag: &str,
    source: &str,
    context: &mut Context,
) -> JsResult<JsValue> {
    use sha2::Digest as _;
    let cache_key = format!("{tag}{:x}", sha2::Sha256::digest(source.as_bytes()));
    let cached_block = read_bytecode_cache(&cache_key).and_then(|blob| {
        let blob: boa_engine::vm::bytecode_cache::CacheBlob = bincode::deserialize(&blob).ok()?;
        boa_engine::vm::bytecode_cache::from_mirror(blob, source, context.realm().scope())
    });
    if let Some(cached) = cached_block {
        let script = Script::from_compiled(
            boa_engine::gc::Gc::new(*cached),
            None,
            context.realm().clone(),
        );
        return script.evaluate(context);
    }
    Script::reset_uninitialized_local_trip();
    let mut script = Script::parse(Source::from_bytes(source.as_bytes()), None, context)?;
    if script.max_register_count(context) > REGISTER_LOCALS_LIMIT
        || Script::tripped_uninitialized_local()
    {
        script = Script::parse_all_bindings_escaping(Source::from_bytes(source.as_bytes()), None, context)?;
    }
    if let Ok(compiled) = script.codeblock(context) {
        if let Some(cache_path) = bytecode_cache_path(&cache_key) {
            let blob = bincode::serialize(&boa_engine::vm::bytecode_cache::to_mirror(&compiled));
            if let Ok(blob) = blob {
                let tmp = cache_path.with_extension("tmp");
                if std::fs::write(&tmp, &blob).is_ok() {
                    let _ = std::fs::rename(&tmp, &cache_path);
                }
            }
        }
    }
    script.evaluate(context)
}

/// Evaluate one CommonJS module: the Node `(function(exports, require, module, __filename,
/// __dirname) { … })` wrapper, a per-module `require` whose parent directory is this
/// module's, and the cache-before-evaluate insert that makes a require cycle answer with
/// the partial `exports`.
fn evaluate_module(path: &Path, source: &str, context: &mut Context) -> JsResult<JsValue> {
    let dir = path.parent().map(Path::to_path_buf).unwrap_or_default();
    // The wrapper compiles as a script — Node's own shape, a standalone function over its
    // five parameters in the global scope — parsed straight from the UTF-8 source and
    // tagged with the module's path (its stack frames name the file). The vendored Boa's
    // `Script::evaluate` runs on the realm's global environment whatever frame is live
    // (GGS-patch; upstream used the caller's chain, which is why the loader once went
    // through the prelude's indirect eval): a nested `require` from inside a running
    // module compiles exactly as a top-level one, pinned in `tests/vscode_shim_boa.rs`.
    // The indirect-eval route it replaces paid for a multi-megabyte JS string, a
    // concatenation and a UTF-16 re-read of every bundle before its parse began.
    let phase_trace = std::env::var("GGS_TRACE_BOOT").is_ok();
    let compile_started = std::time::Instant::now();
    let wrapper =
        format!("(function (exports, require, module, __filename, __dirname) {{\n{source}\n}})");
    // The module bytecode cache (see `boa_engine::vm::bytecode_cache`): a bundle's source
    // never changes under its installed path, so its compiled tree — parse and bytecode
    // generation are a third of a cold activation — is read back instead of rebuilt. The
    // key is the source's SHA-256 under a wire-format version; any decode failure falls
    // back to the normal compile below, and a hit answers through the exact same
    // `Script::evaluate` path.
    use sha2::Digest as _;
    let cache_key = format!("{:x}", sha2::Sha256::digest(source.as_bytes()));
    let cached_block = read_bytecode_cache(&cache_key).and_then(|blob| {
        let blob: boa_engine::vm::bytecode_cache::CacheBlob = bincode::deserialize(&blob).ok()?;
        boa_engine::vm::bytecode_cache::from_mirror(blob, &wrapper, context.realm().scope())
    });
    if let Some(cached) = cached_block {
        let script = Script::from_compiled(
            boa_engine::gc::Gc::new(*cached),
            Some(path.to_path_buf()),
            context.realm().clone(),
        );
        let function = script
            .evaluate(context)?
            .as_object()
            .ok_or_else(|| internal("the module wrapper evaluated to no function"))?;
        if phase_trace {
            eprintln!(
                "[perf] {} bytecode cache hit ({} ms total, {} bytes source)",
                path.display(),
                compile_started.elapsed().as_millis(),
                source.len()
            );
        }
        let exports = JsObject::with_object_proto(context.intrinsics());
        let module = JsObject::with_object_proto(context.intrinsics());
        module.set(key("exports"), exports.clone(), false, context)?;
        let require_function = make_require_function(&dir, context)?;
        with_state(|state| {
            state
                .module_cache
                .insert(path.to_path_buf(), exports.clone().into());
        });
        let exec_started = std::time::Instant::now();
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
        if phase_trace {
            eprintln!(
                "[perf] {} executed in {} ms",
                path.display(),
                exec_started.elapsed().as_millis()
            );
        }
        let final_exports = module.get(key("exports"), context)?;
        with_state(|state| {
            state
                .module_cache
                .insert(path.to_path_buf(), final_exports.clone());
        });
        return Ok(final_exports);
    }
    // Register locals first, all-escaping as the guarded fallback: the real escape
    // analysis turns every uncaptured local into a register `Move` (an environment store
    // and, in every `for (let …)` loop, a per-iteration environment otherwise — a visible
    // slice of claude-code's activation execution is exactly that). Boa 0.21.1's register
    // path has two known walls, both checked right here at compile time: a binding used
    // before its declaration point would bake a static TDZ throw into the site (wrong for
    // every use that runs after initialization — real bundles carry those), and a register
    // file the VM stack cannot hold reads past the limit's checking point. Either trip
    // recompiles the module with every binding escaping — the mode ggs-node always used.
    // The discarded compile is cold-load-only; the bytecode cache stores what survived.
    Script::reset_uninitialized_local_trip();
    let mut script = Script::parse(
        Source::from_bytes(wrapper.as_bytes()).with_path(path),
        None,
        context,
    )?;
    if script.max_register_count(context) > REGISTER_LOCALS_LIMIT
        || Script::tripped_uninitialized_local()
    {
        script = Script::parse_all_bindings_escaping(
            Source::from_bytes(wrapper.as_bytes()).with_path(path),
            None,
            context,
        )?;
    }
    drop(wrapper);
    // Compile now (evaluate would anyway) and store the tree: the write is best-effort —
    // a full disk or a read-only home degrades to compiling again next start.
    if let Ok(compiled) = script.codeblock(context) {
        if let Some(cache_path) = bytecode_cache_path(&cache_key) {
            let mirror_started = std::time::Instant::now();
            let mirror = boa_engine::vm::bytecode_cache::to_mirror(&compiled);
            let ser_started = std::time::Instant::now();
            let blob = bincode::serialize(&mirror);
            if phase_trace {
                eprintln!(
                    "[perf] cache mirror {} ms, serialize {} ms ({} bytes)",
                    ser_started.duration_since(mirror_started).as_millis(),
                    ser_started.elapsed().as_millis(),
                    blob.as_ref().map_or(0, std::vec::Vec::len)
                );
            }
            if let Ok(blob) = blob {
                let tmp = cache_path.with_extension("tmp");
                if std::fs::write(&tmp, &blob).is_ok() {
                    let _ = std::fs::rename(&tmp, &cache_path);
                }
            }
        }
    }
    let function = script
        .evaluate(context)?
        .as_object()
        .ok_or_else(|| internal("the module wrapper evaluated to no function"))?;
    if phase_trace {
        eprintln!(
            "[perf] {} compiled in {} ms ({} bytes)",
            path.display(),
            compile_started.elapsed().as_millis(),
            source.len()
        );
    }
    let exports = JsObject::with_object_proto(context.intrinsics());
    let module = JsObject::with_object_proto(context.intrinsics());
    module.set(key("exports"), exports.clone(), false, context)?;
    let require_function = make_require_function(&dir, context)?;
    with_state(|state| {
        state
            .module_cache
            .insert(path.to_path_buf(), exports.clone().into());
    });
    let exec_started = std::time::Instant::now();
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
    if phase_trace {
        eprintln!(
            "[perf] {} executed in {} ms",
            path.display(),
            exec_started.elapsed().as_millis()
        );
    }
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

/// The bytecode cache file for a module source hash — `None` when caching is off
/// (`GGS_BYTECODE_CACHE=off`) or the home directory cannot be located.
fn bytecode_cache_path(cache_key: &str) -> Option<std::path::PathBuf> {
    if std::env::var("GGS_BYTECODE_CACHE").as_deref() == Ok("off") {
        return None;
    }
    let root = std::env::var_os("GGS_BYTECODE_CACHE")
        .map(std::path::PathBuf::from)
        .or_else(|| {
            std::env::var_os("USERPROFILE")
                .or_else(|| std::env::var_os("HOME"))
                .map(|home| std::path::PathBuf::from(home).join(".ggs").join("cache").join("bytecode"))
        })?;
    let _ = std::fs::create_dir_all(&root);
    Some(root.join(format!("{cache_key}.gcbc")))
}

/// The cached compiled tree for a module source, if any.
fn read_bytecode_cache(cache_key: &str) -> Option<Vec<u8>> {
    let path = bytecode_cache_path(cache_key)?;
    std::fs::read(path).ok()
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

#[cfg(test)]
mod tests {
    use super::*;

    /// `evaluate_cached_script` (2026-09-28): a declarations-free script must evaluate
    /// identically from the bytecode cache — the second load runs in a fresh `Context`
    /// from the stored blob, exactly as a second process start does — and the blob lands
    /// under the cache root the test points at.
    #[test]
    fn cached_scripts_evaluate_identically_on_the_second_load() {
        use boa_engine::js_string;
        let root = std::env::temp_dir().join(format!("ggs-cache-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("the cache root");
        std::env::set_var("GGS_BYTECODE_CACHE", &root);

        // A loop and a closure: the register-local path's shapes, not just a literal.
        let source = "(function(){ let n = 0; for (let i = 0; i < 4; i++) n += i * 3; globalThis.__probe = n; })()";
        let probe = |context: &mut Context| {
            context
                .global_object()
                .get(js_string!("__probe"), context)
                .expect("the probe global")
                .to_number(context)
                .expect("a number") as i64
        };

        let mut first = Context::default();
        evaluate_cached_script("probe", source, &mut first).expect("the first load compiles");
        assert_eq!(probe(&mut first), 18, "the first (compiled) load sets the probe");

        let mut blobs = std::fs::read_dir(&root)
            .expect("the cache root lists")
            .filter_map(Result::ok)
            .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "gcbc"));
        assert!(blobs.next().is_some(), "the compiled blob was written");

        let mut second = Context::default();
        evaluate_cached_script("probe", source, &mut second).expect("the second load reads the cache");
        assert_eq!(probe(&mut second), 18, "the cached load sets the same probe");

        std::env::remove_var("GGS_BYTECODE_CACHE");
        let _ = std::fs::remove_dir_all(&root);
    }
}
