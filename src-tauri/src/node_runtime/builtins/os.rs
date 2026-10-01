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
    module.set(
        key("networkInterfaces"),
        native_callable(
            context,
            "networkInterfaces",
            NativeFunction::from_fn_ptr(os_network_interfaces),
        ),
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

/// One interface's address and netmask pair, family-matched by construction.
fn iface_pair(iface: &if_addrs::Interface) -> (std::net::IpAddr, std::net::IpAddr) {
    match &iface.addr {
        if_addrs::IfAddr::V4(v4) => (
            std::net::IpAddr::V4(v4.ip),
            std::net::IpAddr::V4(v4.netmask),
        ),
        if_addrs::IfAddr::V6(v6) => (
            std::net::IpAddr::V6(v6.ip),
            std::net::IpAddr::V6(v6.netmask),
        ),
    }
}

/// Node's `os.networkInterfaces()`: the interface list grouped by name, one
/// `{ address, netmask, family, mac, internal, cidr }` record per address. The LAN
/// addresses are what a package like Claude Remote needs to build its pairing QR.
/// if-addrs has no MAC address — the field stays empty (nothing in-tree reads it), and
/// `internal` is the loopback test, as in Node.
fn os_network_interfaces(
    _this: &JsValue,
    _args: &[JsValue],
    context: &mut Context,
) -> JsResult<JsValue> {
    let mut interfaces: serde_json::Map<String, Value> = serde_json::Map::new();
    for iface in if_addrs::get_if_addrs().unwrap_or_default() {
        let (ip, netmask) = iface_pair(&iface);
        let prefix = match netmask {
            std::net::IpAddr::V4(mask) => u32::from(mask).count_ones(),
            std::net::IpAddr::V6(mask) => u128::from(mask).count_ones(),
        };
        let record = json!({
            "address": ip.to_string(),
            "netmask": netmask.to_string(),
            "family": if ip.is_ipv4() { "IPv4" } else { "IPv6" },
            "mac": "",
            "internal": iface.is_loopback(),
            "cidr": format!("{ip}/{prefix}"),
        });
        interfaces
            .entry(iface.name)
            .or_insert_with(|| Value::Array(Vec::new()))
            .as_array_mut()
            .expect("the entry was just created as an array")
            .push(record);
    }
    JsValue::from_json(&Value::Object(interfaces), context)
}

#[cfg(test)]
mod tests {
    use super::iface_pair;

    /// Every host running the suite has at least a loopback interface; the records carry
    /// Node's field set. A JS-level exercise lives in `tests/node_runtime.rs`.
    #[test]
    fn network_interfaces_answer_node_shaped_records() {
        let ifaces = if_addrs::get_if_addrs().expect("the interface list reads");
        assert!(!ifaces.is_empty());
        for iface in &ifaces {
            assert!(!iface.name.is_empty());
            let (ip, netmask) = iface_pair(iface);
            assert_eq!(
                ip.is_ipv6(),
                netmask.is_ipv6(),
                "an address and its netmask share the family"
            );
        }
    }
}
