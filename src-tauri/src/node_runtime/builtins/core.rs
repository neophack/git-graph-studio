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

/// GGS-patch: PBKDF2 — `(password, salt, iterations, keylen, digest) → key bytes`, the
/// password and salt as bytes (Node accepts strings and Buffers; the prelude encodes a
/// string as UTF-8 before the crossing). The digests Node extensions name: sha1, sha256,
/// sha512; anything else throws Node's own "Invalid digest" error.
pub(super) fn pbkdf2(
    _this: &JsValue,
    args: &[JsValue],
    context: &mut Context,
) -> JsResult<JsValue> {
    use pbkdf2::pbkdf2_hmac;
    let password = bytes_arg(args.get_or_undefined(0), context)
        .ok_or_else(|| error("pbkdf2: the password must be bytes"))?;
    let salt = bytes_arg(args.get_or_undefined(1), context)
        .ok_or_else(|| error("pbkdf2: the salt must be bytes"))?;
    let iterations = args.get_or_undefined(2).to_number(context)?;
    let keylen = args.get_or_undefined(3).to_number(context)?;
    if !(1.0..=u32::MAX as f64).contains(&iterations) || iterations.fract() != 0.0 {
        return Err(error("pbkdf2: iterations must be a positive integer"));
    }
    if !(0.0..=(1u64 << 30) as f64).contains(&keylen) || keylen.fract() != 0.0 {
        return Err(error("pbkdf2: keylen must be a non-negative integer"));
    }
    let digest = string_arg(args, 4, context).to_ascii_lowercase();
    let mut out = vec![0u8; keylen as usize];
    match digest.as_str() {
        "sha1" => pbkdf2_hmac::<sha1::Sha1>(&password, &salt, iterations as u32, &mut out),
        "sha256" => pbkdf2_hmac::<sha2::Sha256>(&password, &salt, iterations as u32, &mut out),
        "sha512" => pbkdf2_hmac::<sha2::Sha512>(&password, &salt, iterations as u32, &mut out),
        other => return Err(error(format!("Invalid digest: {other}"))),
    }
    array_buffer(out, context)
}

fn array_buffer(bytes: Vec<u8>, context: &mut Context) -> JsResult<JsValue> {
    JsArrayBuffer::from_byte_block(crate::node_runtime::byte_block(bytes), context)
        .map(JsValue::from)
}

/// The key and IV the GCM natives share, checked the way Node checks them. The IV is the
/// 96-bit form — the only one this runtime derives a counter for; a wrong length is a
/// thrown error, never the aes-gcm crate's slice-length panic.
fn gcm_key_iv(args: &[JsValue], context: &mut Context) -> JsResult<(Vec<u8>, [u8; 12])> {
    let key = bytes_arg(args.get_or_undefined(0), context)
        .ok_or_else(|| error("aes-gcm: the key must be bytes"))?;
    if !matches!(key.len(), 16 | 24 | 32) {
        return Err(error("Invalid key length"));
    }
    let iv = bytes_arg(args.get_or_undefined(1), context)
        .ok_or_else(|| error("aes-gcm: the iv must be bytes"))?;
    let iv: [u8; 12] = iv
        .try_into()
        .map_err(|_| error("aes-gcm: only 12-byte IVs are supported by this runtime"))?;
    Ok((key, iv))
}

/// One AES-GCM operation for whichever key size the bytes carry (128/192/256).
macro_rules! with_gcm {
    ($key:expr, |$cipher:ident| $body:expr) => {{
        use aes_gcm::aead::consts::U12;
        use aes_gcm::KeyInit as _;
        match $key.len() {
            16 => {
                let $cipher = aes_gcm::AesGcm::<aes_gcm::aes::Aes128, U12>::new_from_slice($key)
                    .map_err(|_| error("Invalid key length"))?;
                $body
            }
            24 => {
                let $cipher = aes_gcm::AesGcm::<aes_gcm::aes::Aes192, U12>::new_from_slice($key)
                    .map_err(|_| error("Invalid key length"))?;
                $body
            }
            _ => {
                let $cipher = aes_gcm::AesGcm::<aes_gcm::aes::Aes256, U12>::new_from_slice($key)
                    .map_err(|_| error("Invalid key length"))?;
                $body
            }
        }
    }};
}

/// GGS-patch: AES-GCM seal — `(key, iv, plaintext, aad)` → `ciphertext‖tag` bytes. The
/// prelude's `createCipheriv('aes-*-gcm')` seals once at `final` for the tag (its `update`
/// calls already answered the ciphertext through [`aes_gcm_ctr`]).
pub(super) fn aes_gcm_seal(
    _this: &JsValue,
    args: &[JsValue],
    context: &mut Context,
) -> JsResult<JsValue> {
    use aes_gcm::aead::AeadInPlace as _;
    let (key, iv) = gcm_key_iv(args, context)?;
    let mut buffer = bytes_arg(args.get_or_undefined(2), context).unwrap_or_default();
    let aad = bytes_arg(args.get_or_undefined(3), context).unwrap_or_default();
    let tag = with_gcm!(&key, |cipher| cipher
        .encrypt_in_place_detached((&iv).into(), &aad, &mut buffer)
        .map_err(|_| error("aes-gcm: seal failed"))?);
    buffer.extend_from_slice(&tag);
    array_buffer(buffer, context)
}

/// GGS-patch: AES-GCM open — `(key, iv, ciphertext, tag, aad)` → plaintext bytes, or
/// Node's own authentication error (wrong key, tag or AAD; tampered data), never a panic.
pub(super) fn aes_gcm_open(
    _this: &JsValue,
    args: &[JsValue],
    context: &mut Context,
) -> JsResult<JsValue> {
    use aes_gcm::aead::AeadInPlace as _;
    const AUTH_FAILED: &str = "Unsupported state or unable to authenticate data";
    let (key, iv) = gcm_key_iv(args, context)?;
    let mut buffer = bytes_arg(args.get_or_undefined(2), context).unwrap_or_default();
    let tag = bytes_arg(args.get_or_undefined(3), context).unwrap_or_default();
    let aad = bytes_arg(args.get_or_undefined(4), context).unwrap_or_default();
    let tag: [u8; 16] = tag.try_into().map_err(|_| error(AUTH_FAILED))?;
    with_gcm!(&key, |cipher| cipher
        .decrypt_in_place_detached((&iv).into(), &aad, &mut buffer, (&tag).into())
        .map_err(|_| error(AUTH_FAILED))?);
    array_buffer(buffer, context)
}

/// GGS-patch: GCM's keystream — `(key, iv, offset, data)` → `data` XOR the AES-CTR stream
/// GCM encrypts with (96-bit IV: counter block `iv‖2` for the first byte), started at
/// `offset` bytes into the message. This is what lets the prelude's `update()` answer its
/// ciphertext (or plaintext) as it goes, as Node's does, instead of all at `final()` —
/// code that keeps only `update`'s output (Node's GCM `final` answers nothing) works.
pub(super) fn aes_gcm_ctr(
    _this: &JsValue,
    args: &[JsValue],
    context: &mut Context,
) -> JsResult<JsValue> {
    use aes_gcm::aes::cipher::{BlockEncrypt, KeyInit};
    let (key, iv) = gcm_key_iv(args, context)?;
    let offset = args.get_or_undefined(2).to_number(context)?;
    if !(0.0..=(1u64 << 36) as f64).contains(&offset) || offset.fract() != 0.0 {
        return Err(error("aes-gcm: bad stream offset"));
    }
    let offset = offset as u64;
    let mut data = bytes_arg(args.get_or_undefined(3), context).unwrap_or_default();
    // GCM's inc32: the low 32 bits count, wrapping; the first data block is J0 + 1 = 2.
    let mut counter = 2u32.wrapping_add((offset / 16) as u32);
    let mut skip = (offset % 16) as usize;
    let mut at = 0usize;
    macro_rules! stream {
        ($aes:ty) => {{
            let aes = <$aes>::new_from_slice(&key).map_err(|_| error("Invalid key length"))?;
            while at < data.len() {
                let mut block = aes_gcm::aes::Block::default();
                block[..12].copy_from_slice(&iv);
                block[12..].copy_from_slice(&counter.to_be_bytes());
                aes.encrypt_block(&mut block);
                for byte in &block[skip..] {
                    if at == data.len() {
                        break;
                    }
                    data[at] ^= byte;
                    at += 1;
                }
                skip = 0;
                counter = counter.wrapping_add(1);
            }
        }};
    }
    match key.len() {
        16 => stream!(aes_gcm::aes::Aes128),
        24 => stream!(aes_gcm::aes::Aes192),
        _ => stream!(aes_gcm::aes::Aes256),
    }
    array_buffer(data, context)
}

/// Buffer's base64 / base64url rendering — `(bytes, url) → text`. The JS loop it replaces
/// built the string a character at a time, quadratic on the interpreter's flat strings: a
/// few hundred KB (a sealed RPC answer, an image) never finished.
pub(super) fn base64_encode(
    _this: &JsValue,
    args: &[JsValue],
    context: &mut Context,
) -> JsResult<JsValue> {
    use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
    use base64::Engine as _;
    let bytes =
        bytes_arg(args.get_or_undefined(0), context).ok_or_else(|| error("base64: needs bytes"))?;
    let url = args.get_or_undefined(1).to_boolean();
    Ok(text(if url {
        URL_SAFE_NO_PAD.encode(bytes)
    } else {
        STANDARD.encode(bytes)
    }))
}

/// `Buffer.from(text, 'base64' | 'base64url')` — `(text) → bytes`, Node's lenient decode:
/// both alphabets, padding optional, characters outside the alphabet skipped, the first
/// pad ends the data, dangling bits of a final partial group dropped.
pub(super) fn base64_decode(
    _this: &JsValue,
    args: &[JsValue],
    context: &mut Context,
) -> JsResult<JsValue> {
    use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};
    use base64::Engine as _;
    const LENIENT: GeneralPurpose = GeneralPurpose::new(
        &base64::alphabet::STANDARD,
        GeneralPurposeConfig::new()
            .with_decode_allow_trailing_bits(true)
            .with_decode_padding_mode(DecodePaddingMode::RequireNone),
    );
    let input = string_arg(args, 0, context);
    let mut clean: Vec<u8> = Vec::with_capacity(input.len());
    for byte in input.bytes() {
        match byte {
            b'=' => break,
            b'-' => clean.push(b'+'),
            b'_' => clean.push(b'/'),
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'+' | b'/' => clean.push(byte),
            _ => {}
        }
    }
    if clean.len() % 4 == 1 {
        clean.pop(); // six bits make no byte
    }
    let bytes = LENIENT.decode(&clean).unwrap_or_default();
    array_buffer(bytes, context)
}

/// The `crypto` builtin's hash native: `(algorithm, bytes) → hex digest`. The JS side's
/// `createHash` accumulates the bytes (the `update` calls) and hands them over here —
/// md5 / sha1 / sha256, the gravatar-class digests the frame host serves too.
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
