//! `os`: the platform facts a package's code reads to branch on the machine it runs on.

use boa_engine::{Context, JsObject, JsResult, JsValue, NativeFunction};
use serde_json::{json, Value};

use crate::node_runtime::{key, native_callable, text};

pub(super) fn os_module(context: &mut Context) -> JsResult<JsObject> {
    let module = JsObject::with_object_proto(context.intrinsics());
    let platform = if cfg!(target_os = "windows") {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    };
    let arch = if cfg!(target_arch = "x86_64") {
        "x64"
    } else if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        std::env::consts::ARCH
    };
    module.set(key("platform"), text(platform), false, context)?;
    module.set(key("arch"), text(arch), false, context)?;
    module.set(
        key("EOL"),
        text(if cfg!(target_os = "windows") {
            "\r\n"
        } else {
            "\n"
        }),
        false,
        context,
    )?;
    module.set(key("endianness"), text("LE"), false, context)?;
    module.set(
        key("homedir"),
        native_callable(context, "homedir", NativeFunction::from_fn_ptr(os_home)),
        false,
        context,
    )?;
    module.set(
        key("tmpdir"),
        native_callable(context, "tmpdir", NativeFunction::from_fn_ptr(os_tmp)),
        false,
        context,
    )?;
    module.set(
        key("hostname"),
        native_callable(
            context,
            "hostname",
            NativeFunction::from_fn_ptr(os_hostname),
        ),
        false,
        context,
    )?;
    module.set(
        key("type"),
        native_callable(context, "type", NativeFunction::from_fn_ptr(os_type)),
        false,
        context,
    )?;
    module.set(
        key("cpus"),
        native_callable(context, "cpus", NativeFunction::from_fn_ptr(os_cpus)),
        false,
        context,
    )?;
    module.set(
        key("arch"),
        native_callable(context, "arch", NativeFunction::from_fn_ptr(os_arch)),
        false,
        context,
    )?;
    module.set(
        key("release"),
        native_callable(context, "release", NativeFunction::from_fn_ptr(os_release)),
        false,
        context,
    )?;
    Ok(module)
}

fn os_home(_this: &JsValue, _args: &[JsValue], _context: &mut Context) -> JsResult<JsValue> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_default();
    Ok(text(home))
}

fn os_tmp(_this: &JsValue, _args: &[JsValue], _context: &mut Context) -> JsResult<JsValue> {
    Ok(text(std::env::temp_dir().display().to_string()))
}

fn os_hostname(_this: &JsValue, _args: &[JsValue], _context: &mut Context) -> JsResult<JsValue> {
    let name = std::env::var("COMPUTERNAME").unwrap_or_else(|_| "localhost".to_owned());
    Ok(text(name))
}

fn os_type(_this: &JsValue, _args: &[JsValue], _context: &mut Context) -> JsResult<JsValue> {
    let name = if cfg!(target_os = "windows") {
        "Windows_NT"
    } else if cfg!(target_os = "macos") {
        "Darwin"
    } else {
        "Linux"
    };
    Ok(text(name))
}

/// Node's architecture names (`x64`, `arm64`), not Rust's (`x86_64`, `aarch64`).
fn os_arch(_this: &JsValue, _args: &[JsValue], _context: &mut Context) -> JsResult<JsValue> {
    let name = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        other => other,
    };
    Ok(text(name))
}

/// The kernel/OS version — cosmetic in every consumer here (a version-string line); the
/// family name is the honest floor without a platform-version crate.
fn os_release(_this: &JsValue, _args: &[JsValue], _context: &mut Context) -> JsResult<JsValue> {
    Ok(text(std::env::consts::OS))
}

fn os_cpus(_this: &JsValue, _args: &[JsValue], context: &mut Context) -> JsResult<JsValue> {
    let count = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(1);
    let cpus: Vec<Value> = (0..count)
        .map(|_| json!({ "model": "cpu", "speed": 0 }))
        .collect();
    JsValue::from_json(&Value::Array(cpus), context)
}
