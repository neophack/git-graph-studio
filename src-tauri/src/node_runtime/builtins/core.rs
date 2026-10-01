//! The `__ggs*` natives the JS prelude layers over: process facts, timers, the log and
//! dispatch registrations, and the addon's raw crossing.

use std::time::{SystemTime, UNIX_EPOCH};

use boa_engine::object::builtins::JsArrayBuffer;
use boa_engine::{Context, JsArgs, JsError, JsNativeError, JsResult, JsValue};
use serde_json::{json, Value};

use super::support::*;
use crate::node_runtime::{key, text, with_state};

/// the codec lives here instead of in byte-shuffling JavaScript (multi-byte text survives).
pub(super) fn utf8_encode(
    _this: &JsValue,
    args: &[JsValue],
    context: &mut Context,
) -> JsResult<JsValue> {
    let text = string_arg(args, 0, context);
    JsArrayBuffer::from_byte_block(crate::node_runtime::byte_block(text.into_bytes()), context)
        .map(JsValue::from)
}

/// UTF-8 bytes → text with lossy replacement, the mirror of [`utf8_encode`].
pub(super) fn utf8_decode(
    _this: &JsValue,
    args: &[JsValue],
    context: &mut Context,
) -> JsResult<JsValue> {
    let value = args.get_or_undefined(0).clone();
    let bytes = bytes_arg(&value, context).ok_or_else(|| error("utf8 decode needs bytes"))?;
    Ok(text(String::from_utf8_lossy(&bytes).into_owned()))
}

/// The `crypto` builtin's random source: `(count) → bytes` from the OS generator — what
/// `randomBytes`, `randomUUID` and `getRandomValues` draw from (uuid-class libraries call
/// them at module load, so a throw here used to kill the whole activation).
pub(super) fn random_bytes(
    _this: &JsValue,
    args: &[JsValue],
    context: &mut Context,
) -> JsResult<JsValue> {
    let count = args.get_or_undefined(0).to_number(context)?;
    if !(0.0..=65536.0).contains(&count) || count.fract() != 0.0 {
        return Err(error(
            "random bytes: the count must be an integer in 0..=65536",
        ));
    }
    let mut bytes = vec![0u8; count as usize];
    getrandom::getrandom(&mut bytes).map_err(|e| error(format!("random bytes: {e}")))?;
    JsArrayBuffer::from_byte_block(crate::node_runtime::byte_block(bytes), context)
        .map(JsValue::from)
}

/// The `crypto` builtin's one native: `(algorithm, bytes) → hex digest`. The JS side's
/// `createHash` accumulates the bytes (the `update` calls) and hands them over here —
/// md5 / sha1 / sha256, the gravatar-class digests the frame host serves too.
/// GGS-patch: PBKDF2-HMAC-SHA256 — `(password, salt, iterations, bits) → key bytes`.
/// The `crypto.pbkdf2Sync` shim wraps this (the KDF behind the remote-Claude bridge's
/// pairing key). Only SHA-256 is provided; other digests throw honestly.
pub(super) fn pbkdf2_sha256(
    _this: &JsValue,
    args: &[JsValue],
    context: &mut Context,
) -> JsResult<JsValue> {
    use base64::Engine as _;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
    use pbkdf2::pbkdf2_hmac;
    use sha2::Sha256;
    let password = string_arg(args, 0, context);
    let salt = B64.decode(string_arg(args, 1, context))
        .map_err(|e| error(&format!("salt: {e}")))?;
    let iterations = args
        .get_or_undefined(2)
        .to_number(context)
        .map(|n| n.max(1.0))
        .unwrap_or(1.0) as u32;
    let bits = args
        .get_or_undefined(3)
        .to_number(context)
        .map(|n| n.max(128.0))
        .unwrap_or(256.0) as usize;
    let mut out = vec![0u8; bits / 8];
    pbkdf2_hmac::<Sha256>(password.as_bytes(), &salt, iterations, &mut out);
    Ok(text(B64.encode(out)))
}

/// GGS-patch: AES-256-GCM seal — `(key, iv, plaintext, aad)` → `ciphertext‖tag`, all
/// base64url. The prelude's `createCipheriv('aes-256-gcm', …)` buffers updates and seals
/// once through this.
pub(super) fn aes_gcm_seal(
    _this: &JsValue,
    args: &[JsValue],
    context: &mut Context,
) -> JsResult<JsValue> {
    use aes_gcm::aead::Aead as _;
    use aes_gcm::{Aes256Gcm, KeyInit as _};
    use base64::Engine as _;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
    let mut decode = move |at: usize, what: &str| -> Result<Vec<u8>, JsError> {
        B64.decode(string_arg(args, at, context))
            .map_err(|e| error(&format!("{what}: {e}")))
    };
    let key = decode(0, "key")?;
    let iv = decode(1, "iv")?;
    let plain = decode(2, "plaintext")?;
    let aad = decode(3, "aad")?;
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| error(&format!("key: {e}")))?;
    let nonce = aes_gcm::Nonce::from_slice(&iv);
    let mut ciphertext = cipher
        .encrypt(
            nonce,
            aes_gcm::aead::Payload { msg: &plain, aad: &aad },
        )
        .map_err(|_| error("seal failed"))?;
    // The aead crate appends the tag; split it out so the JS shape is `ct‖tag` chunks
    // the same way Node's getAuthTag presents it.
    let tag = ciphertext.split_off(ciphertext.len().saturating_sub(16));
    let mut out = ciphertext;
    out.extend_from_slice(&tag);
    Ok(text(B64.encode(out)))
}

/// GGS-patch: AES-256-GCM open — `(key, iv, ciphertext‖tag, aad)` → plaintext, or a
/// clean "open failed" error (wrong key/tag), never a panic.
pub(super) fn aes_gcm_open(
    _this: &JsValue,
    args: &[JsValue],
    context: &mut Context,
) -> JsResult<JsValue> {
    use aes_gcm::aead::Aead as _;
    use aes_gcm::{Aes256Gcm, KeyInit as _};
    use base64::Engine as _;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
    let mut decode = move |at: usize, what: &str| -> Result<Vec<u8>, JsError> {
        B64.decode(string_arg(args, at, context))
            .map_err(|e| error(&format!("{what}: {e}")))
    };
    let key = decode(0, "key")?;
    let iv = decode(1, "iv")?;
    let sealed = decode(2, "ciphertext")?;
    let aad = decode(3, "aad")?;
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| error(&format!("key: {e}")))?;
    let nonce = aes_gcm::Nonce::from_slice(&iv);
    let plain = cipher
        .decrypt(
            nonce,
            aes_gcm::aead::Payload {
                msg: &sealed,
                aad: &aad,
            },
        )
        .map_err(|_| error("open failed (wrong key or tampered data)"))?;
    Ok(text(B64.encode(plain)))
}

/// The `crypto` builtin's one native: `(algorithm, bytes) → hex digest`.
pub(super) fn digest_hex(
    _this: &JsValue,
    args: &[JsValue],
    context: &mut Context,
) -> JsResult<JsValue> {
    let algorithm = string_arg(args, 0, context);
    let data =
        bytes_arg(args.get_or_undefined(1), context).ok_or_else(|| error("digest needs bytes"))?;
    let hex = match algorithm.as_str() {
        "md5" => {
            use md5::Digest as _;
            let mut hasher = md5::Md5::new();
            hasher.update(&data);
            hex::encode(hasher.finalize())
        }
        "sha1" => {
            use sha1::Digest as _;
            let mut hasher = sha1::Sha1::new();
            hasher.update(&data);
            hex::encode(hasher.finalize())
        }
        "sha256" => {
            use sha2::Digest as _;
            let mut hasher = sha2::Sha256::new();
            hasher.update(&data);
            hex::encode(hasher.finalize())
        }
        other => {
            return Err(JsError::from_native(
                JsNativeError::error().with_message(format!("unsupported digest: {other}")),
            ))
        }
    };
    Ok(text(hex))
}

pub(super) fn emit_log(
    _this: &JsValue,
    args: &[JsValue],
    context: &mut Context,
) -> JsResult<JsValue> {
    let level = string_arg(args, 0, context);
    let message = string_arg(args, 1, context);
    with_state(|state| state.log(&level, &message));
    Ok(JsValue::undefined())
}

pub(super) fn process_meta(
    _this: &JsValue,
    _args: &[JsValue],
    context: &mut Context,
) -> JsResult<JsValue> {
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
    let argv: Vec<String> = std::env::args().collect();
    let env: serde_json::Map<String, Value> = std::env::vars()
        .map(|(key, value)| (key, Value::from(value)))
        .collect();
    let meta = json!({
        "argv": argv,
        "env": Value::Object(env),
        "pid": std::process::id(),
        "platform": platform,
        "arch": arch,
        "version": "22.0.0-ggs",
        "execPath": std::env::current_exe()
            .map(|p| p.display().to_string())
            .unwrap_or_default(),
    });
    JsValue::from_json(&meta, context)
}

pub(super) fn process_cwd(
    _this: &JsValue,
    _args: &[JsValue],
    _context: &mut Context,
) -> JsResult<JsValue> {
    let cwd = std::env::current_dir()
        .map(|p| p.display().to_string())
        .unwrap_or_default();
    Ok(text(cwd))
}

pub(super) fn process_now(
    _this: &JsValue,
    _args: &[JsValue],
    _context: &mut Context,
) -> JsResult<JsValue> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0);
    Ok(JsValue::from(millis))
}

pub(super) fn set_timeout(
    _this: &JsValue,
    args: &[JsValue],
    context: &mut Context,
) -> JsResult<JsValue> {
    let function = args
        .get_or_undefined(0)
        .as_callable()
        .ok_or_else(|| error("setTimeout needs a function"))?;
    let millis = args.get_or_undefined(1).as_number().unwrap_or(0.0).max(0.0);
    let repeat = args.get_or_undefined(2).as_boolean().unwrap_or(false);
    let call_args = value_array_arg(args, 3, context);
    let id = with_state(|state| {
        state.add_timer(function.into(), millis, repeat.then_some(millis), call_args)
    });
    with_state(|state| state.pump().wake());
    Ok(JsValue::from(id as f64))
}

pub(super) fn clear_timeout(
    _this: &JsValue,
    args: &[JsValue],
    _context: &mut Context,
) -> JsResult<JsValue> {
    let id = args.get_or_undefined(0).as_number().unwrap_or(0.0) as u64;
    with_state(|state| state.cancel_timer(id));
    Ok(JsValue::undefined())
}

/// The blocking host-request crossing the vscode shim's bridge drives: `(method,
/// argsJson) -> resultJson`. Blocks the JS thread by design — the answer arrives on the
/// reader thread, so the wait never blocks the loop it depends on.
pub(super) fn ggs_host_request(
    _this: &JsValue,
    args: &[JsValue],
    context: &mut Context,
) -> JsResult<JsValue> {
    let method = string_arg(args, 0, context);
    let args_json = string_arg(args, 1, context);
    let emitter = with_state(|state| state.emitter.clone());
    let Some(emitter) = emitter else {
        return Err(JsError::from_native(
            JsNativeError::error().with_message("no host is attached to this backend yet"),
        ));
    };
    let parsed: Value = serde_json::from_str(&args_json).unwrap_or(Value::Null);
    match crate::node_runtime::host_request(&emitter, &method, parsed) {
        // The answer crosses as a JSON STRING — the shim's bridge parses it, exactly like
        // the wire it mirrors (an object here would String()-ify into "[object Object]").
        Ok(value) => Ok(text(
            serde_json::to_string(&value).unwrap_or_else(|_| "null".to_owned()),
        )),
        Err(message) => Err(JsError::from_native(
            JsNativeError::error().with_message(message),
        )),
    }
}

pub(super) fn on_request(
    _this: &JsValue,
    args: &[JsValue],
    _context: &mut Context,
) -> JsResult<JsValue> {
    let function = args
        .get_or_undefined(0)
        .as_callable()
        .ok_or_else(|| error("ggs.onRequest needs a function"))?;
    with_state(|state| state.on_request = Some(function.into()));
    Ok(JsValue::undefined())
}

pub(super) fn on_workspace_changed(
    _this: &JsValue,
    args: &[JsValue],
    _context: &mut Context,
) -> JsResult<JsValue> {
    let function = args
        .get_or_undefined(0)
        .as_callable()
        .ok_or_else(|| error("ggs.onWorkspaceChanged needs a function"))?;
    with_state(|state| state.on_workspace = Some(function.into()));
    Ok(JsValue::undefined())
}

/// The initialize handshake's facts, merged into the `ggs.env` the prelude built.
pub(super) fn set_env(
    _this: &JsValue,
    args: &[JsValue],
    context: &mut Context,
) -> JsResult<JsValue> {
    let env = args.get_or_undefined(0).clone();
    let ggs = context.global_object().get(key("ggs"), context)?;
    let ggs = ggs
        .as_object()
        .ok_or_else(|| error("the prelude's ggs is missing"))?;
    let existing = ggs.get(key("env"), context)?;
    let target = existing
        .as_object()
        .ok_or_else(|| error("ggs.env is not an object"))?;
    if let Some(entries) = crate::node_runtime::json_of(context, &env)
        .ok()
        .as_ref()
        .and_then(Value::as_object)
        .cloned()
    {
        for (key, value) in entries {
            let js_value = JsValue::from_json(&value, context)?;
            target.set(
                boa_engine::JsString::from(key.as_str()),
                js_value,
                false,
                context,
            )?;
        }
    }
    Ok(JsValue::undefined())
}
