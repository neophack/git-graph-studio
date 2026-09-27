//! Shared helpers for the builtin modules: argument coercion, byte extraction, and the
//! Buffer factory every binary payload crosses through.

use boa_engine::object::builtins::{JsArrayBuffer, JsTypedArray};
use boa_engine::{Context, JsArgs, JsError, JsNativeError, JsResult, JsValue};

use crate::node_runtime::key;

pub(crate) fn error(message: impl Into<String>) -> JsError {
    JsError::from_native(JsNativeError::error().with_message(message.into()))
}

pub(crate) fn string_arg(args: &[JsValue], at: usize, context: &mut Context) -> String {
    args.get_or_undefined(at)
        .to_string(context)
        .map(|s| s.to_std_string_escaped())
        .unwrap_or_default()
}

pub(super) fn opt_string_arg(args: &[JsValue], at: usize, context: &mut Context) -> Option<String> {
    let value = args.get_or_undefined(at);
    if value.is_undefined() || value.is_null() {
        return None;
    }
    value
        .to_string(context)
        .ok()
        .map(|s| s.to_std_string_escaped())
}

/// The string elements of a JS array argument (`spawn`'s argv).
pub(super) fn string_array_arg(args: &[JsValue], at: usize, context: &mut Context) -> Vec<String> {
    let Some(object) = args.get_or_undefined(at).as_object() else {
        return Vec::new();
    };
    let length = object
        .get(key("length"), context)
        .ok()
        .and_then(|value| value.as_number())
        .unwrap_or(0.0) as usize;
    (0..length)
        .filter_map(|index| {
            object
                .get(index, context)
                .ok()
                .and_then(|value| value.as_string().map(|s| s.to_std_string_escaped()))
        })
        .collect()
}

/// The extra `setTimeout` arguments, carried as a JS array by the prelude.
pub(super) fn value_array_arg(args: &[JsValue], at: usize, context: &mut Context) -> Vec<JsValue> {
    let Some(object) = args.get_or_undefined(at).as_object() else {
        return Vec::new();
    };
    let length = object
        .get(key("length"), context)
        .ok()
        .and_then(|value| value.as_number())
        .unwrap_or(0.0) as usize;
    (0..length)
        .filter_map(|index| object.get(index, context).ok())
        .collect()
}

/// Extract bytes from a Buffer/Uint8Array/ArrayBuffer argument.
pub(super) fn bytes_arg(value: &JsValue, context: &mut Context) -> Option<Vec<u8>> {
    let object = value.as_object()?;
    let typed = JsTypedArray::from_object(object.clone()).ok()?;
    let buffer_value = typed.buffer(context).ok()?;
    let buffer_object = buffer_value.as_object()?;
    let buffer = JsArrayBuffer::from_object(buffer_object.clone()).ok()?;
    let data = buffer.data()?;
    let offset = typed.byte_offset(context).ok()?;
    let length = typed.byte_length(context).ok()?;
    Some(data.get(offset..offset + length)?.to_vec())
}

/// A Buffer for bytes crossing back into JS, built through the prelude's `Buffer.from`.
pub(super) fn buffer_value(bytes: Vec<u8>, context: &mut Context) -> JsResult<JsValue> {
    let array_buffer =
        JsArrayBuffer::from_byte_block(crate::node_runtime::byte_block(bytes), context)?;
    let global = context.global_object();
    let buffer = global.get(key("Buffer"), context)?;
    let from = buffer
        .as_object()
        .ok_or_else(|| error("the prelude's Buffer is missing"))?
        .get(key("from"), context)?;
    let from = from
        .as_callable()
        .ok_or_else(|| error("Buffer.from is missing"))?;
    from.call(&buffer, &[array_buffer.into()], context)
}
