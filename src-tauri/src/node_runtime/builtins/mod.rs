//! The runtime's Node builtins, implemented natively: `fs` over `std::fs` (the runtime is a
//! real process, so file access is real — no bridge, and no confinement beyond what any
//! process the app spawns has), `path`, `os`, the `process` facts, `child_process` over
//! `std::process`, and the timer/log/dispatch natives the JS prelude layers its surfaces
//! over. Everything the prelude shapes better in JS (Buffer, EventEmitter, util, the
//! `vscode` stub) lives in `prelude.js` instead.
//!
//! One rule binds the whole module: **stdout is the `ggs-ext/1` protocol.** A builtin that
//! writes (`console.*`, `process.stdout`) goes to the log emitter, never to fd 1.
//! The per-domain implementations sit beside this file: [`child`], [`fs`], [`path`],
//! [`os`], [`core`] (the prelude's natives), [`support`] (shared helpers).

mod child;
mod core;
mod fs;
mod net;
mod os;
mod path;
mod support;

use std::path::{Path, PathBuf};

use boa_engine::{Context, JsObject, JsResult, JsValue, NativeFunction};

use crate::node_runtime::{key, with_state};
use support::error;

/* ---------- the registry: what `require` answers for a core name ---------- */

/// One core module by name. Built once and cached under a pseudo path, so every `require`
/// of a builtin returns the same object a second time.
pub fn builtin_module(name: &str, context: &mut Context) -> JsResult<Option<JsValue>> {
    const NAMES: &[&str] = &[
        "fs",
        "fs/promises",
        "path",
        "os",
        "events",
        "util",
        "buffer",
        "process",
        "child_process",
        "timers",
        "crypto",
        "url",
        "http",
        "https",
        "vscode",
        "console",
    ];
    let normalized = name.strip_prefix("node:").unwrap_or(name);
    if !NAMES.contains(&normalized) {
        // The smaller core modules are assembled in the prelude (`module`, `assert`,
        // `stream`, …) and registered by name in its `__ggsBuiltins` table.
        return prelude_builtin(normalized, context);
    }
    let cache_key = format!("ggs-builtin:{normalized}");
    if let Some(cached) = with_state(|state| state.module_cache.get(Path::new(&cache_key)).cloned())
    {
        return Ok(Some(cached));
    }
    let value = match normalized {
        // The prelude's shaped module (sync, callback and promise forms, Stats objects,
        // error codes) — never the raw natives table it is built over.
        "fs" => global_object(context, "fs")?,
        "fs/promises" => global_object(context, "fs")?
            .as_object()
            .ok_or_else(|| error("the fs module is not an object"))?
            .get(key("promises"), context)?,
        "path" => path::path_module(context)?.into(),
        "os" => os::os_module(context)?.into(),
        "events" => global_object(context, "EventEmitter")?,
        "util" => global_object(context, "util")?,
        "buffer" => buffer_module(context)?,
        "process" => global_object(context, "process")?,
        "child_process" => global_object(context, "child_process")?,
        "timers" => timers_module(context)?,
        "crypto" => global_object(context, "crypto")?,
        "url" => global_object(context, "url")?,
        "http" => global_object(context, "http")?,
        "https" => global_object(context, "https")?,
        "vscode" => global_object(context, "vscode")?,
        "console" => global_object(context, "console")?,
        _ => return Ok(None),
    };
    with_state(|state| {
        state
            .module_cache
            .insert(PathBuf::from(cache_key), value.clone());
    });
    Ok(Some(value))
}

/// A core module the prelude registered in `__ggsBuiltins` — relative paths and package
/// names never match (the table holds core names only), so this answers `None` for them.
fn prelude_builtin(name: &str, context: &mut Context) -> JsResult<Option<JsValue>> {
    if name.starts_with('.') || name.starts_with('/') || name.contains(':') {
        return Ok(None);
    }
    let table = global_object(context, "__ggsBuiltins")?;
    let Some(table) = table.as_object() else {
        return Ok(None);
    };
    if !table.has_own_property(key(name), context)? {
        return Ok(None);
    }
    Ok(Some(table.get(key(name), context)?))
}

fn global_object(context: &mut Context, name: &str) -> JsResult<JsValue> {
    context.global_object().get(key(name), context)
}

/* ---------- the native registration, one call at bootstrap ---------- */

/// Register every `__ggs*` native the prelude and the loader bind over.
pub fn register_natives(context: &mut Context) -> JsResult<()> {
    let natives: &[(&str, usize, NativeFunction)] = &[
        (
            "__ggsEmitLog",
            2,
            NativeFunction::from_fn_ptr(core::emit_log),
        ),
        (
            "__ggsUtf8Encode",
            1,
            NativeFunction::from_fn_ptr(core::utf8_encode),
        ),
        (
            "__ggsUtf8Decode",
            1,
            NativeFunction::from_fn_ptr(core::utf8_decode),
        ),
        (
            "__ggsDigestHex",
            2,
            NativeFunction::from_fn_ptr(core::digest_hex),
        ),
        (
            "__ggsRandomBytes",
            1,
            NativeFunction::from_fn_ptr(core::random_bytes),
        ),
        (
            "__ggsProcessMeta",
            0,
            NativeFunction::from_fn_ptr(core::process_meta),
        ),
        (
            "__ggsProcessCwd",
            0,
            NativeFunction::from_fn_ptr(core::process_cwd),
        ),
        (
            "__ggsProcessNow",
            0,
            NativeFunction::from_fn_ptr(core::process_now),
        ),
        (
            "__ggsSetTimeout",
            4,
            NativeFunction::from_fn_ptr(core::set_timeout),
        ),
        (
            "__ggsClearTimeout",
            1,
            NativeFunction::from_fn_ptr(core::clear_timeout),
        ),
        (
            "__ggsOnRequest",
            1,
            NativeFunction::from_fn_ptr(core::on_request),
        ),
        (
            "__ggsOnWorkspaceChanged",
            1,
            NativeFunction::from_fn_ptr(core::on_workspace_changed),
        ),
        ("__ggsSetEnv", 1, NativeFunction::from_fn_ptr(core::set_env)),
        (
            "__ggsHostRequest",
            2,
            NativeFunction::from_fn_ptr(core::ggs_host_request),
        ),
        (
            "__ggsChildProcessSpawn",
            3,
            NativeFunction::from_fn_ptr(child::proc_spawn),
        ),
        (
            "__ggsChildProcessSpawnSync",
            3,
            NativeFunction::from_fn_ptr(child::proc_spawn_sync),
        ),
        (
            "__ggsNetListen",
            2,
            NativeFunction::from_fn_ptr(net::listen),
        ),
        (
            "__ggsNetCloseServer",
            1,
            NativeFunction::from_fn_ptr(net::close_server),
        ),
        (
            "__ggsNetConnect",
            2,
            NativeFunction::from_fn_ptr(net::connect),
        ),
        ("__ggsNetWrite", 2, NativeFunction::from_fn_ptr(net::write)),
        (
            "__ggsDnsLookup",
            1,
            NativeFunction::from_fn_ptr(net::dns_lookup),
        ),
        (
            "__ggsPbkdf2Sha256",
            4,
            NativeFunction::from_fn_ptr(core::pbkdf2_sha256),
        ),
        (
            "__ggsAesGcmSeal",
            4,
            NativeFunction::from_fn_ptr(core::aes_gcm_seal),
        ),
        (
            "__ggsAesGcmOpen",
            4,
            NativeFunction::from_fn_ptr(core::aes_gcm_open),
        ),
        ("__ggsNetEnd", 1, NativeFunction::from_fn_ptr(net::end)),
        (
            "__ggsNetDestroy",
            1,
            NativeFunction::from_fn_ptr(net::destroy),
        ),
        (
            "__ggsNetSetNoDelay",
            2,
            NativeFunction::from_fn_ptr(net::set_no_delay),
        ),
        (
            "__ggsHttpRequest",
            2,
            NativeFunction::from_fn_ptr(net::http_request),
        ),
        (
            "__ggsHttpAbort",
            1,
            NativeFunction::from_fn_ptr(net::http_abort),
        ),
    ];
    for (name, length, function) in natives {
        context.register_global_callable((*name).into(), *length, function.clone())?;
    }
    // The prelude reads the raw fs module under __ggsFs and shapes it into the public one.
    context
        .global_object()
        .set(key("__ggsFs"), fs::fs_module(context)?, false, context)?;
    crate::node_runtime::require::register_natives(context)?;
    Ok(())
}

/* ---------- buffer / timers: thin module builders over the prelude's globals ---------- */

fn buffer_module(context: &mut Context) -> JsResult<JsValue> {
    let module = JsObject::with_object_proto(context.intrinsics());
    let buffer = global_object(context, "Buffer")?;
    module.set(key("Buffer"), buffer, false, context)?;
    // GGS-patch: Blob / File ride on the Buffer global the prelude assembled (Node 18+
    // exports them from `node:buffer`; a missing named export was a module load failure
    // for packages that import them — Kimi Code's chunks do).
    for name in ["Blob", "File"] {
        if let Some(value) = global_object(context, "Buffer")?
            .as_object()
            .map(|object| object.get(key(name), context))
            .transpose()?
            .filter(|value| !value.is_undefined())
        {
            module.set(key(name), value, false, context)?;
        }
    }
    module.set(
        key("kMaxLength"),
        JsValue::from(2_147_483_647.0),
        false,
        context,
    )?;
    Ok(module.into())
}

fn timers_module(context: &mut Context) -> JsResult<JsValue> {
    let module = JsObject::with_object_proto(context.intrinsics());
    for name in [
        "setTimeout",
        "setInterval",
        "clearTimeout",
        "clearInterval",
        "setImmediate",
        "clearImmediate",
    ] {
        let function = global_object(context, name)?;
        module.set(key(name), function, false, context)?;
    }
    Ok(module.into())
}
