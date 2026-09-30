//! GGS-patch: the fast `JSON.stringify` writer (no replacer, no property list, no gap).
//!
//! Upstream's `SerializeJSONProperty` ran, for EVERY property of every node: a generic
//! `Get` (prototype-chain walk, key conversion), a `toJSON` lookup on the chain, a
//! replacer check, and a per-member `Vec<u16>` plus `JsString` that a final pass joined.
//! A claude-shaped payload pays that per message per field.
//!
//! This writer builds one `Vec<u16>` buffer for the whole tree and reads values straight
//! out of the objects' own storage. It takes the tree only when the shape is boring —
//! plain `Object.prototype` objects, dense `Array.prototype` arrays, primitive leaves —
//! and answers `None` (falling back to the generic serializer) the moment anything
//! unusual appears: accessors, exotics, sparse arrays, cycles, prototypes carrying a
//! `toJSON`.
//!
//! Semantics it replicates exactly: key order (`EnumerableOwnPropertyNames` — integer
//! keys ascending, then insertion order), skipped `undefined`/function members, `null`
//! for them inside arrays, non-finite numbers as `null`, and `Json::quote_json_string`'s
//! quoting verbatim.

use crate::{
    Context, JsObject, JsString, JsValue,
    builtins::json::Json,
    property::{PropertyKey, PropertyNameKind},
};

/// Try to serialize `value` the fast way. `None` means "not fast-able, use the generic
/// path"; `Some(None)` means the root value is omitted (`undefined`, a function) and
/// `JSON.stringify` answers `undefined`.
pub(super) fn fast_stringify(value: &JsValue, context: &mut Context) -> Option<Option<JsString>> {
    // A `toJSON` anywhere on the standard prototypes would have to run for values this
    // writer reads directly (Date carries one, which is why dates never reach here —
    // they are not plain objects). Checked once per call, not per value.
    let intrinsics = context.intrinsics();
    let object_proto = intrinsics.constructors().object().prototype();
    let array_proto = intrinsics.constructors().array().prototype();
    let number_proto = intrinsics.constructors().number().prototype();
    let string_proto = intrinsics.constructors().string().prototype();
    let boolean_proto = intrinsics.constructors().boolean().prototype();
    for prototype in [
        object_proto.clone(),
        array_proto.clone(),
        number_proto,
        string_proto,
        boolean_proto,
    ] {
        if prototype
            .borrow()
            .properties()
            .get(&PropertyKey::from(JsString::from("toJSON")))
            .is_some()
        {
            return None;
        }
    }

    let mut writer = Writer {
        out: Vec::new(),
        object_proto,
        array_proto,
        ancestors: Vec::new(),
    };
    match writer.value(value, false, context) {
        Outcome::Written => Some(Some(JsString::from(&writer.out[..]))),
        Outcome::Omitted => Some(None),
        Outcome::Fallback => None,
    }
}

enum Outcome {
    Written,
    Omitted,
    Fallback,
}

struct Writer {
    out: Vec<u16>,
    object_proto: JsObject,
    array_proto: JsObject,
    ancestors: Vec<JsObject>,
}

impl Writer {
    /// Write `value`. `in_array` selects the array context's `null` for omitted values.
    fn value(&mut self, value: &JsValue, in_array: bool, context: &mut Context) -> Outcome {
        // The primitive leaves — exactly what the generic serializer's steps 5–9 produce.
        if value.is_null() {
            self.out.extend("null".encode_utf16());
            return Outcome::Written;
        }
        if let Some(boolean) = value.as_boolean() {
            self.out
                .extend(if boolean { "true" } else { "false" }.encode_utf16());
            return Outcome::Written;
        }
        if let Some(text) = value.as_string() {
            let quoted = Json::quote_json_string(&text.clone());
            self.out.extend(quoted.iter());
            return Outcome::Written;
        }
        if let Some(number) = value.as_number() {
            if number.is_finite() {
                let text = value
                    .to_string(context)
                    .expect("ToString cannot fail on a number");
                self.out.extend(text.iter());
            } else {
                self.out.extend("null".encode_utf16());
            }
            return Outcome::Written;
        }
        if value.is_undefined() || value.is_symbol() {
            return if in_array {
                self.out.extend("null".encode_utf16());
                Outcome::Written
            } else {
                Outcome::Omitted
            };
        }
        if value.is_bigint() {
            // The generic path throws for bigints; let it do exactly that.
            return Outcome::Fallback;
        }

        let Some(object) = value.as_object() else {
            return Outcome::Fallback;
        };

        // Functions and the boxed primitives serialize as omitted (their `toJSON`-free
        // prototypes were checked at the gate; a callable is never a plain data tree).
        if object.is_callable() {
            return if in_array {
                self.out.extend("null".encode_utf16());
                Outcome::Written
            } else {
                Outcome::Omitted
            };
        }

        // Boxed primitives (Number/String/Boolean objects) unbox like the generic
        // steps 4a–4d; anything else exotic falls back.
        if object.is::<f64>() || object.is::<JsString>() || object.is::<bool>() {
            let unboxed = value.to_primitive(context, crate::value::PreferredType::Default);
            match unboxed {
                Ok(primitive) => return self.value(&primitive, in_array, context),
                Err(_) => return Outcome::Fallback,
            }
        }

        // Cycles and depth: the generic path throws on cycles; falling back hands it
        // the cycle to detect. The guard depth keeps pathological nesting from growing
        // the ancestor list without bound.
        if self.ancestors.len() >= 512 || self.ancestors.contains(&object) {
            return Outcome::Fallback;
        }

        let prototype = object.prototype();
        if prototype.as_ref() == Some(&self.array_proto) {
            return self.array(&object, context);
        }
        if prototype.as_ref() == Some(&self.object_proto) {
            return self.object(&object, context);
        }
        Outcome::Fallback
    }

    fn array(&mut self, object: &JsObject, context: &mut Context) -> Outcome {
        let length = {
            let borrowed = object.borrow();
            let Some(elements) = borrowed.properties().to_dense_indexed_properties() else {
                return Outcome::Fallback;
            };
            // The array's own `length` drives the element count (trailing holes included).
            let length = borrowed
                .properties()
                .get(&PropertyKey::from(JsString::from("length")))
                .and_then(|descriptor| descriptor.value().cloned())
                .and_then(|value| value.as_number())
                .unwrap_or_default();
            let length = if length.is_finite() && length >= 0.0 {
                length as usize
            } else {
                return Outcome::Fallback;
            };
            if elements.len() != length {
                // Sparse or over-long: holes must read as `null`, but a length beyond
                // the dense storage (or a shrunk array) belongs to the generic path.
                return Outcome::Fallback;
            }
            length
        };

        self.out.push(b'[' as u16);
        self.ancestors.push(object.clone());
        let outcome = (|| {
            for index in 0..length {
                if index > 0 {
                    self.out.push(b',' as u16);
                }
                let element = object
                    .borrow()
                    .properties()
                    .get_dense_property(index as u32)
                    .unwrap_or_default();
                match self.value(&element, true, context) {
                    Outcome::Written | Outcome::Omitted => {}
                    fallback => return fallback,
                }
            }
            Outcome::Written
        })();
        self.ancestors.pop();
        if matches!(outcome, Outcome::Written) {
            self.out.push(b']' as u16);
        }
        outcome
    }

    fn object(&mut self, object: &JsObject, context: &mut Context) -> Outcome {
        // `EnumerableOwnPropertyNames(value, key)` — the spec's own ordering, reused.
        let keys = match object.enumerable_own_property_names(PropertyNameKind::Key, context) {
            Ok(keys) => keys,
            Err(_) => return Outcome::Fallback,
        };

        self.out.push(b'{' as u16);
        self.ancestors.push(object.clone());
        let mut written_any = false;
        let outcome = (|| {
            for key in &keys {
                let Ok(name) = key.to_string(context) else {
                    return Outcome::Fallback;
                };
                // Own storage, read directly — no chain walk, no key re-conversion.
                let property = {
                    let borrowed = object.borrow();
                    let descriptor = borrowed.properties().get(&PropertyKey::from(name.clone()));
                    match descriptor {
                        Some(descriptor) => match descriptor.value() {
                            Some(value) => value.clone(),
                            // An accessor (or odd descriptor) must run through the
                            // generic `Get`.
                            None => return Outcome::Fallback,
                        },
                        None => return Outcome::Fallback,
                    }
                };
                // The member is only written when the value serializes to something.
                let member_start = self.out.len();
                if written_any {
                    self.out.push(b',' as u16);
                }
                let quoted = Json::quote_json_string(&name.clone());
                self.out.extend(quoted.iter());
                self.out.push(b':' as u16);
                match self.value(&property, false, context) {
                    Outcome::Written => written_any = true,
                    Outcome::Omitted => {
                        // Undo the member — omitted values leave no comma behind.
                        self.out.truncate(member_start);
                    }
                    fallback => return fallback,
                }
            }
            Outcome::Written
        })();
        self.ancestors.pop();
        if matches!(outcome, Outcome::Written) {
            self.out.push(b'}' as u16);
        }
        outcome
    }
}
