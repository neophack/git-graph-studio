//! `fs` over `std::fs`: the sync surface the prelude decorates into the public module.

use std::io::Write as _;
use std::time::{SystemTime, UNIX_EPOCH};

use boa_engine::object::builtins::JsArrayBuffer;
use boa_engine::{Context, JsArgs, JsObject, JsResult, JsValue, NativeFunction};
use serde_json::{json, Value};

use super::support::*;
use crate::node_runtime::{key, native_callable, text};

/// An fs failure in Node's message shape, `CODE: subject: OS message`. The code comes from
/// the error kind, never the message text — OS messages are localized — and the prelude
/// lifts it onto `error.code`, which is what Node callers branch on.
fn io_error(subject: &str, e: &std::io::Error) -> boa_engine::JsError {
    use std::io::ErrorKind;
    let code = match e.kind() {
        ErrorKind::NotFound => "ENOENT",
        ErrorKind::PermissionDenied => "EACCES",
        ErrorKind::AlreadyExists => "EEXIST",
        ErrorKind::DirectoryNotEmpty => "ENOTEMPTY",
        ErrorKind::IsADirectory => "EISDIR",
        ErrorKind::NotADirectory => "ENOTDIR",
        ErrorKind::InvalidInput => "EINVAL",
        _ => "EIO",
    };
    error(format!("{code}: {subject}: {e}"))
}

pub(super) fn fs_module(context: &mut Context) -> JsResult<JsObject> {
    let module = JsObject::with_object_proto(context.intrinsics());
    let natives: &[(&str, usize, NativeFunction)] = &[
        (
            "readFileSync",
            2,
            NativeFunction::from_fn_ptr(fs_read_file_sync),
        ),
        (
            "readFileSyncBytes",
            1,
            NativeFunction::from_fn_ptr(fs_read_file_bytes),
        ),
        (
            "readRangeBytes",
            3,
            NativeFunction::from_fn_ptr(fs_read_range_bytes),
        ),
        (
            "writeFileSync",
            3,
            NativeFunction::from_fn_ptr(fs_write_file_sync),
        ),
        (
            "writeRangeBytes",
            3,
            NativeFunction::from_fn_ptr(fs_write_range_bytes),
        ),
        (
            "writeFileSyncBytes",
            2,
            NativeFunction::from_fn_ptr(fs_write_file_bytes),
        ),
        (
            "appendFileSync",
            3,
            NativeFunction::from_fn_ptr(fs_append_file_sync),
        ),
        ("existsSync", 1, NativeFunction::from_fn_ptr(fs_exists_sync)),
        ("accessSync", 2, NativeFunction::from_fn_ptr(fs_access_sync)),
        ("mkdirSync", 2, NativeFunction::from_fn_ptr(fs_mkdir_sync)),
        ("readdir", 1, NativeFunction::from_fn_ptr(fs_readdir)),
        (
            "readdirDirents",
            1,
            NativeFunction::from_fn_ptr(fs_readdir_dirents),
        ),
        ("stat", 2, NativeFunction::from_fn_ptr(fs_stat)),
        ("rmSync", 3, NativeFunction::from_fn_ptr(fs_rm_sync)),
        ("unlinkSync", 1, NativeFunction::from_fn_ptr(fs_unlink_sync)),
        ("renameSync", 2, NativeFunction::from_fn_ptr(fs_rename_sync)),
        (
            "copyFileSync",
            2,
            NativeFunction::from_fn_ptr(fs_copy_file_sync),
        ),
        (
            "readlinkSync",
            1,
            NativeFunction::from_fn_ptr(fs_readlink_sync),
        ),
        (
            "realpathSync",
            1,
            NativeFunction::from_fn_ptr(fs_realpath_sync),
        ),
    ];
    for (name, _length, function) in natives {
        module.set(
            key(name),
            native_callable(context, name, function.clone()),
            false,
            context,
        )?;
    }
    let constants = JsObject::with_object_proto(context.intrinsics());
    constants.set(key("F_OK"), 0, false, context)?;
    constants.set(key("R_OK"), 4, false, context)?;
    constants.set(key("W_OK"), 2, false, context)?;
    constants.set(key("X_OK"), 1, false, context)?;
    constants.set(key("COPYFILE_EXCL"), 1, false, context)?;
    module.set(key("constants"), constants, false, context)?;
    Ok(module)
}

/// The encodings `readFileSync` answers: textual (decoded here) or a Buffer (bytes for the
/// prelude's `Buffer.from`).
enum Encoding {
    Text(String),
    Buffer,
}

fn encoding_arg(args: &[JsValue], at: usize, context: &mut Context) -> JsResult<Encoding> {
    let value = args.get_or_undefined(at);
    if value.is_undefined() || value.is_null() {
        return Ok(Encoding::Text("utf8".to_owned()));
    }
    let name = match value.as_string() {
        Some(text) => text.to_std_string_escaped(),
        None => match value
            .as_object()
            .and_then(|object| object.get(key("encoding"), context).ok())
        {
            Some(encoding) if !encoding.is_undefined() && !encoding.is_null() => {
                encoding.to_string(context)?.to_std_string_escaped()
            }
            _ => return Ok(Encoding::Text("utf8".to_owned())),
        },
    };
    match name.as_str() {
        "buffer" => Ok(Encoding::Buffer),
        "utf8" | "utf-8" | "ascii" | "latin1" | "binary" | "hex" | "base64" => {
            Ok(Encoding::Text(name))
        }
        _ => Err(error(format!("Unknown encoding: {name}"))),
    }
}

fn decode(bytes: Vec<u8>, encoding: &str) -> String {
    match encoding {
        "base64" => base64_encode(&bytes),
        "hex" => hex::encode(&bytes),
        _ => String::from_utf8_lossy(&bytes).into_owned(),
    }
}

/// The fs module answers byte payloads for the prelude's `'buffer'` path; for the textual
/// encodings this runtime decodes in place (base64/hex in `decode`).
fn base64_encode(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn fs_read_file_sync(
    _this: &JsValue,
    args: &[JsValue],
    context: &mut Context,
) -> JsResult<JsValue> {
    let path = string_arg(args, 0, context);
    let encoding = encoding_arg(args, 1, context)?;
    let bytes = std::fs::read(&path).map_err(|e| io_error(&path, &e))?;
    match encoding {
        Encoding::Buffer => buffer_value(bytes, context),
        Encoding::Text(encoding) => Ok(text(decode(bytes, &encoding))),
    }
}

fn fs_read_file_bytes(
    _this: &JsValue,
    args: &[JsValue],
    context: &mut Context,
) -> JsResult<JsValue> {
    let path = string_arg(args, 0, context);
    let bytes = std::fs::read(&path).map_err(|e| io_error(&path, &e))?;
    JsArrayBuffer::from_byte_block(crate::node_runtime::byte_block(bytes), context)
        .map(JsValue::from)
}

/// `readRangeBytes(path, position, length)`: at most `length` bytes from `position` — the
/// fd-style `read` and `createReadStream` of the prelude page through a file with it, so a
/// multi-gigabyte file is never loaded whole. Short at the end of the file, empty past it.
fn fs_read_range_bytes(
    _this: &JsValue,
    args: &[JsValue],
    context: &mut Context,
) -> JsResult<JsValue> {
    use std::io::{Read as _, Seek as _, SeekFrom};
    let path = string_arg(args, 0, context);
    let position = args.get_or_undefined(1).to_number(context)?.max(0.0) as u64;
    let length = args.get_or_undefined(2).to_number(context)?.max(0.0) as u64;
    let mut file = std::fs::File::open(&path).map_err(|e| io_error(&path, &e))?;
    file.seek(SeekFrom::Start(position))
        .map_err(|e| io_error(&path, &e))?;
    let mut bytes = Vec::new();
    file.take(length)
        .read_to_end(&mut bytes)
        .map_err(|e| io_error(&path, &e))?;
    JsArrayBuffer::from_byte_block(crate::node_runtime::byte_block(bytes), context)
        .map(JsValue::from)
}

/// The write half of the prelude's descriptors: `bytes` at `position`, or at the end when
/// the position is null / undefined (an append-mode handle). The file must exist - the
/// prelude's open created or truncated it per the flags. Answers the bytes written.
fn fs_write_range_bytes(
    _this: &JsValue,
    args: &[JsValue],
    context: &mut Context,
) -> JsResult<JsValue> {
    use std::io::{Seek as _, SeekFrom};
    let path = string_arg(args, 0, context);
    let bytes = bytes_arg(args.get_or_undefined(1), context)
        .ok_or_else(|| error("writeRangeBytes needs a Buffer or Uint8Array"))?;
    let position = args.get_or_undefined(2);
    let mut file = if position.is_null_or_undefined() {
        std::fs::OpenOptions::new().append(true).open(&path)
    } else {
        std::fs::OpenOptions::new().write(true).open(&path)
    }
    .map_err(|e| io_error(&path, &e))?;
    if !position.is_null_or_undefined() {
        let at = position.to_number(context)?.max(0.0) as u64;
        file.seek(SeekFrom::Start(at))
            .map_err(|e| io_error(&path, &e))?;
    }
    file.write_all(&bytes).map_err(|e| io_error(&path, &e))?;
    Ok(JsValue::from(bytes.len() as f64))
}

fn fs_write_file_sync(
    _this: &JsValue,
    args: &[JsValue],
    context: &mut Context,
) -> JsResult<JsValue> {
    let path = string_arg(args, 0, context);
    let data = args.get_or_undefined(1).clone();
    let payload = match bytes_arg(&data, context) {
        Some(bytes) => bytes,
        None => string_arg(args, 1, context).into_bytes(),
    };
    if let Some(parent) = std::path::Path::new(&path).parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::write(&path, payload).map_err(|e| io_error(&path, &e))?;
    Ok(JsValue::undefined())
}

fn fs_write_file_bytes(
    _this: &JsValue,
    args: &[JsValue],
    context: &mut Context,
) -> JsResult<JsValue> {
    let path = string_arg(args, 0, context);
    let bytes = bytes_arg(args.get_or_undefined(1), context)
        .ok_or_else(|| error("writeFileSyncBytes needs a Buffer or Uint8Array"))?;
    if let Some(parent) = std::path::Path::new(&path).parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::write(&path, bytes).map_err(|e| io_error(&path, &e))?;
    Ok(JsValue::undefined())
}

fn fs_append_file_sync(
    _this: &JsValue,
    args: &[JsValue],
    context: &mut Context,
) -> JsResult<JsValue> {
    let path = string_arg(args, 0, context);
    let data = string_arg(args, 1, context);
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| io_error(&path, &e))?;
    file.write_all(data.as_bytes())
        .map_err(|e| io_error(&path, &e))?;
    Ok(JsValue::undefined())
}

fn fs_exists_sync(_this: &JsValue, args: &[JsValue], _context: &mut Context) -> JsResult<JsValue> {
    let path = string_arg(args, 0, _context);
    Ok(JsValue::from(std::path::Path::new(&path).exists()))
}

fn fs_access_sync(_this: &JsValue, args: &[JsValue], _context: &mut Context) -> JsResult<JsValue> {
    let path = string_arg(args, 0, _context);
    let _mode = args.get_or_undefined(1).as_number().unwrap_or(0.0);
    if !std::path::Path::new(&path).exists() {
        return Err(error(format!(
            "ENOENT: no such file or directory, access '{path}'"
        )));
    }
    Ok(JsValue::undefined())
}

fn fs_mkdir_sync(_this: &JsValue, args: &[JsValue], _context: &mut Context) -> JsResult<JsValue> {
    let path = string_arg(args, 0, _context);
    let recursive = args.get_or_undefined(1).to_boolean();
    let result = if recursive {
        std::fs::create_dir_all(&path)
    } else {
        std::fs::create_dir(&path)
    };
    result.map_err(|e| io_error(&path, &e))?;
    Ok(JsValue::undefined())
}

fn fs_readdir(_this: &JsValue, args: &[JsValue], context: &mut Context) -> JsResult<JsValue> {
    let path = string_arg(args, 0, context);
    let entries = std::fs::read_dir(&path).map_err(|e| io_error(&path, &e))?;
    let names: Vec<Value> = entries
        .filter_map(|entry| entry.ok())
        .map(|entry| Value::String(entry.file_name().to_string_lossy().into_owned()))
        .collect();
    JsValue::from_json(&Value::Array(names), context)
}

fn fs_readdir_dirents(
    _this: &JsValue,
    args: &[JsValue],
    context: &mut Context,
) -> JsResult<JsValue> {
    let path = string_arg(args, 0, context);
    let entries = std::fs::read_dir(&path).map_err(|e| io_error(&path, &e))?;
    let dirents: Vec<Value> = entries
        .filter_map(|entry| entry.ok())
        .map(|entry| {
            let kind = entry.file_type().ok();
            let kind = if kind.as_ref().is_some_and(|t| t.is_dir()) {
                "dir"
            } else if kind.as_ref().is_some_and(|t| t.is_symlink()) {
                "symlink"
            } else {
                "file"
            };
            json!({ "name": entry.file_name().to_string_lossy(), "kind": kind })
        })
        .collect();
    JsValue::from_json(&Value::Array(dirents), context)
}

fn fs_stat(_this: &JsValue, args: &[JsValue], context: &mut Context) -> JsResult<JsValue> {
    let path = string_arg(args, 0, context);
    // The second argument asks for lstat: the link itself, never its target - a caller
    // guarding against a planted symlink (claude-code's transcript probe) must see one.
    let metadata = if args.get_or_undefined(1).to_boolean() {
        std::fs::symlink_metadata(&path)
    } else {
        std::fs::metadata(&path)
    }
    .map_err(|e| io_error(&path, &e))?;
    let kind = if metadata.is_symlink() {
        "symlink"
    } else if metadata.is_dir() {
        "dir"
    } else {
        "file"
    };
    let millis = |time: std::option::Option<SystemTime>| {
        time.and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs_f64() * 1000.0)
            .unwrap_or(0.0)
    };
    let stat = json!({
        "kind": kind,
        "size": metadata.len(),
        "mtimeMs": millis(metadata.modified().ok()),
        "ctimeMs": millis(metadata.created().ok()),
        "birthtimeMs": millis(metadata.created().ok()),
    });
    JsValue::from_json(&stat, context)
}

fn fs_rm_sync(_this: &JsValue, args: &[JsValue], _context: &mut Context) -> JsResult<JsValue> {
    let path = string_arg(args, 0, _context);
    let recursive = args.get_or_undefined(1).to_boolean();
    let force = args.get_or_undefined(2).to_boolean();
    let target = std::path::Path::new(&path);
    let result = if target.is_dir() && recursive {
        std::fs::remove_dir_all(target)
    } else if target.is_dir() {
        std::fs::remove_dir(target)
    } else if target.exists() {
        std::fs::remove_file(target)
    } else if force {
        return Ok(JsValue::undefined());
    } else {
        return Err(error(format!(
            "ENOENT: no such file or directory, rm '{path}'"
        )));
    };
    result.map_err(|e| io_error(&path, &e))?;
    Ok(JsValue::undefined())
}

fn fs_unlink_sync(_this: &JsValue, args: &[JsValue], _context: &mut Context) -> JsResult<JsValue> {
    let path = string_arg(args, 0, _context);
    std::fs::remove_file(&path).map_err(|e| io_error(&path, &e))?;
    Ok(JsValue::undefined())
}

fn fs_rename_sync(_this: &JsValue, args: &[JsValue], _context: &mut Context) -> JsResult<JsValue> {
    let from = string_arg(args, 0, _context);
    let to = string_arg(args, 1, _context);
    std::fs::rename(&from, &to).map_err(|e| io_error(&format!("{from} -> {to}"), &e))?;
    Ok(JsValue::undefined())
}

fn fs_copy_file_sync(
    _this: &JsValue,
    args: &[JsValue],
    _context: &mut Context,
) -> JsResult<JsValue> {
    let from = string_arg(args, 0, _context);
    let to = string_arg(args, 1, _context);
    std::fs::copy(&from, &to).map_err(|e| io_error(&format!("{from} -> {to}"), &e))?;
    Ok(JsValue::undefined())
}

fn fs_realpath_sync(
    _this: &JsValue,
    args: &[JsValue],
    _context: &mut Context,
) -> JsResult<JsValue> {
    let path = string_arg(args, 0, _context);
    let canonical = std::fs::canonicalize(&path).map_err(|e| io_error(&path, &e))?;
    // Windows canonical paths carry the `\\?\` prefix Node never shows.
    let canonical_text = canonical.display().to_string();
    let stripped = canonical_text
        .strip_prefix(r"\\?\")
        .map(str::to_owned)
        .unwrap_or(canonical_text);
    Ok(text(stripped))
}

/// `readlink`: the link's own target, as written. A path that is not a link fails - Node's
/// EINVAL, which callers (claude-code's settings writer) take as "write the path itself".
fn fs_readlink_sync(
    _this: &JsValue,
    args: &[JsValue],
    context: &mut Context,
) -> JsResult<JsValue> {
    let path = string_arg(args, 0, context);
    let metadata = std::fs::symlink_metadata(&path).map_err(|e| io_error(&path, &e))?;
    if !metadata.is_symlink() {
        return Err(error(format!("EINVAL: invalid argument, readlink '{path}'")));
    }
    let target = std::fs::read_link(&path).map_err(|e| io_error(&path, &e))?;
    Ok(text(target.display().to_string()))
}
