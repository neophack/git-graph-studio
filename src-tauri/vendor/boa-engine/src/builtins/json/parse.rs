//! GGS-patch: the direct JSON text parser (`JSON.parse`'s value builder).
//!
//! Upstream `Json::parse` validated the text with `serde_json`, then re-parsed the whole
//! string as a parenthesised script — a full lexer + parser + `ByteCompiler` pass, and a
//! bytecode run whose every property was its own `DefineOwnPropertyByName` opcode. A
//! claude-shaped payload paid that compile on every message. This parser walks the text
//! once and builds the `JsValue` tree directly, with ECMA-404 as the grammar and JS
//! semantics for the values:
//!
//! - objects are plain `Object.prototype` objects with data properties, insertion
//!   ordered, duplicate keys overwriting in place (the position stays at the first
//!   occurrence — exactly what the object-literal evaluation produced);
//! - arrays are real `Array.prototype` arrays with dense storage;
//! - numbers parse as `f64` with the same correct rounding the lexer applies;
//!   out-of-range exponents become infinity, `-0` stays `-0`;
//! - strings are UTF-16 `JsString`s: `\uXXXX` escapes combine surrogate pairs and lone
//!   surrogates are preserved (JSON text outside escapes is UTF-8, which never carries
//!   surrogate code points);
//! - `__proto__` is an ordinary data property — JSON never assigns prototypes.
//!
//! The reviver path is untouched: it runs over whatever tree this builds.

use crate::{
    Context, JsError, JsNativeError, JsObject, JsResult, JsString, JsValue,
    builtins::array::Array,
    property::PropertyDescriptor,
};

/// Parse `text` (UTF-8, already `ToString`-converted by the caller) into a `JsValue`.
pub(super) fn parse_json_text(text: &str, context: &mut Context) -> JsResult<JsValue> {
    let mut parser = Parser {
        bytes: text.as_bytes(),
        pos: 0,
        depth: 0,
    };
    parser.skip_whitespace();
    let value = parser.parse_value(context)?;
    parser.skip_whitespace();
    if parser.pos != parser.bytes.len() {
        return Err(parser.error("unexpected token after JSON value"));
    }
    Ok(value)
}

struct Parser<'a> {
    bytes: &'a [u8],
    pos: usize,
    /// Container nesting depth. The parser is recursive descent, so an unbounded depth
    /// would overflow the JS thread's stack and take the whole backend down — a hostile
    /// or pathological payload must answer a SyntaxError, never a crash. The cap sits
    /// well above the tree any real producer serialises and matches the stringify
    /// writer's own fast-path guard, so a tree this parser accepts is one the writer
    /// handles without falling back.
    depth: u16,
}

/// The maximum container nesting `JSON.parse` accepts (implementation-defined; V8 and
/// serde_json carry their own, lower or higher).
const MAX_NESTING_DEPTH: u16 = 512;

impl Parser<'_> {
    fn error(&self, message: &str) -> JsError {
        JsNativeError::syntax()
            .with_message(format!(
                "{message} at position {}",
                self.pos.min(self.bytes.len())
            ))
            .into()
    }

    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.pos).copied()
    }

    fn skip_whitespace(&mut self) {
        while let Some(b' ' | b'\t' | b'\r' | b'\n') = self.peek() {
            self.pos += 1;
        }
    }

    fn expect(&mut self, byte: u8) -> JsResult<()> {
        if self.peek() == Some(byte) {
            self.pos += 1;
            Ok(())
        } else {
            Err(self.error(&format!("expected '{}'", byte as char)))
        }
    }

    fn parse_value(&mut self, context: &mut Context) -> JsResult<JsValue> {
        match self.peek() {
            Some(b'{') => self.parse_object(context),
            Some(b'[') => self.parse_array(context),
            Some(b'"') => Ok(JsString::from(self.parse_string()?).into()),
            Some(b't') => self.parse_literal("true", JsValue::new(true)),
            Some(b'f') => self.parse_literal("false", JsValue::new(false)),
            Some(b'n') => self.parse_literal("null", JsValue::null()),
            Some(b'-' | b'0'..=b'9') => self.parse_number(),
            _ => Err(self.error("unexpected token")),
        }
    }

    fn parse_literal(&mut self, text: &str, value: JsValue) -> JsResult<JsValue> {
        if self.bytes[self.pos..].starts_with(text.as_bytes()) {
            self.pos += text.len();
            Ok(value)
        } else {
            Err(self.error("unexpected token"))
        }
    }

    fn parse_object(&mut self, context: &mut Context) -> JsResult<JsValue> {
        self.depth += 1;
        if self.depth > MAX_NESTING_DEPTH {
            return Err(self.error("maximum JSON nesting depth exceeded"));
        }
        let result = self.parse_object_inner(context);
        self.depth -= 1;
        result
    }

    fn parse_object_inner(&mut self, context: &mut Context) -> JsResult<JsValue> {
        self.expect(b'{')?;
        let object = JsObject::with_object_proto(context.intrinsics());
        self.skip_whitespace();
        if self.peek() == Some(b'}') {
            self.pos += 1;
            return Ok(object.into());
        }
        loop {
            self.skip_whitespace();
            if self.peek() != Some(b'"') {
                return Err(self.error("expected a property name"));
            }
            let key = self.parse_string()?;
            self.skip_whitespace();
            self.expect(b':')?;
            self.skip_whitespace();
            let value = self.parse_value(context)?;
            // A data property, own, enumerable — the object-literal evaluation's shape
            // (`__proto__` included: JSON never assigns prototypes). The object is a
            // fresh plain object, so the direct insert IS the ordinary define.
            let property = PropertyDescriptor::builder()
                .value(value)
                .writable(true)
                .enumerable(true)
                .configurable(true)
                .build();
            object.borrow_mut().insert(key, property);
            self.skip_whitespace();
            match self.peek() {
                Some(b',') => self.pos += 1,
                Some(b'}') => {
                    self.pos += 1;
                    return Ok(object.into());
                }
                _ => return Err(self.error("expected ',' or '}'")),
            }
        }
    }

    fn parse_array(&mut self, context: &mut Context) -> JsResult<JsValue> {
        self.depth += 1;
        if self.depth > MAX_NESTING_DEPTH {
            return Err(self.error("maximum JSON nesting depth exceeded"));
        }
        let result = self.parse_array_inner(context);
        self.depth -= 1;
        result
    }

    fn parse_array_inner(&mut self, context: &mut Context) -> JsResult<JsValue> {
        self.expect(b'[')?;
        self.skip_whitespace();
        let mut elements: Vec<JsValue> = Vec::new();
        if self.peek() == Some(b']') {
            self.pos += 1;
        } else {
            loop {
                self.skip_whitespace();
                let value = self.parse_value(context)?;
                elements.push(value);
                self.skip_whitespace();
                match self.peek() {
                    Some(b',') => self.pos += 1,
                    Some(b']') => {
                        self.pos += 1;
                        break;
                    }
                    _ => return Err(self.error("expected ',' or ']'")),
                }
            }
        }
        let length = elements.len() as u64;
        let array = Array::array_create(length, None, context)
            .map_err(|e| JsNativeError::typ().with_message(e.to_string()))?;
        array
            .borrow_mut()
            .properties_mut()
            .override_indexed_properties(elements.into_iter().collect());
        Ok(array.into())
    }

    /// Parse a JSON string (the cursor sits on the opening quote). Returns the decoded
    /// UTF-16 code units.
    fn parse_string(&mut self) -> JsResult<JsString> {
        self.expect(b'"')?;
        let start = self.pos;
        // Fast scan: a run with no escapes and no multi-byte UTF-8 can be borrowed from
        // the input; anything else falls to the collecting loop.
        while let Some(byte) = self.peek() {
            match byte {
                b'"' => {
                    let slice = &self.bytes[start..self.pos];
                    let text = std::str::from_utf8(slice)
                        .map_err(|_| self.error("invalid UTF-8 in JSON string"))?;
                    self.pos += 1;
                    return Ok(JsString::from(text));
                }
                b'\\' => {
                    return self.parse_string_escaped(start);
                }
                0x00..=0x1F => return Err(self.error("control character in JSON string")),
                0x80..=0xFF => {
                    return self.parse_string_escaped(start);
                }
                _ => self.pos += 1,
            }
        }
        Err(self.error("unterminated JSON string"))
    }

    /// The slow path: an escape sequence or multi-byte UTF-8 inside the string.
    fn parse_string_escaped(&mut self, start: usize) -> JsResult<JsString> {
        // Rewind to the run's start and decode into UTF-16 units (JS string semantics:
        // `\uD800\uDC00` combine; lone surrogates are preserved).
        self.pos = start;
        let mut units: Vec<u16> = Vec::new();
        loop {
            match self.peek() {
                Some(b'"') => {
                    self.pos += 1;
                    return Ok(JsString::from(&units[..]));
                }
                Some(b'\\') => {
                    self.pos += 1;
                    let Some(escape) = self.peek() else {
                        return Err(self.error("unterminated JSON string"));
                    };
                    self.pos += 1;
                    match escape {
                        b'"' => units.push(b'"' as u16),
                        b'\\' => units.push(b'\\' as u16),
                        b'/' => units.push(b'/' as u16),
                        b'b' => units.push(0x0008),
                        b'f' => units.push(0x000C),
                        b'n' => units.push(b'\n' as u16),
                        b'r' => units.push(b'\r' as u16),
                        b't' => units.push(b'\t' as u16),
                        b'u' => {
                            let high = self.parse_hex4()?;
                            if (0xD800..=0xDBFF).contains(&high)
                                && self.bytes[self.pos..].starts_with(b"\\u")
                            {
                                let saved = self.pos;
                                self.pos += 2;
                                let low = self.parse_hex4()?;
                                if (0xDC00..=0xDFFF).contains(&low) {
                                    // A valid pair: the UTF-16 units themselves are
                                    // the encoding — push both unchanged.
                                    units.push(high);
                                    units.push(low);
                                } else {
                                    // A high surrogate followed by a non-low escape:
                                    // emit both as-is.
                                    self.pos = saved;
                                    units.push(high);
                                }
                            } else {
                                units.push(high);
                            }
                        }
                        _ => return Err(self.error("invalid escape in JSON string")),
                    }
                }
                Some(byte) if byte <= 0x1F => {
                    return Err(self.error("control character in JSON string"));
                }
                Some(byte) if byte < 0x80 => {
                    units.push(u16::from(byte));
                    self.pos += 1;
                }
                Some(_) => {
                    // Multi-byte UTF-8: decode one scalar and push its units.
                    let rest = &self.bytes[self.pos..];
                    let text = match std::str::from_utf8(&rest[..rest.len().min(4)]) {
                        Ok(text) => text,
                        Err(e) if e.valid_up_to() > 0 => {
                            std::str::from_utf8(&rest[..e.valid_up_to()])
                                .expect("valid prefix")
                        }
                        Err(_) => return Err(self.error("invalid UTF-8 in JSON string")),
                    };
                    let scalar = text.chars().next().expect("at least one char");
                    self.pos += scalar.len_utf8();
                    let mut buffer = [0u16; 2];
                    units.extend_from_slice(scalar.encode_utf16(&mut buffer));
                }
                None => return Err(self.error("unterminated JSON string")),
            }
        }
    }

    fn parse_hex4(&mut self) -> JsResult<u16> {
        if self.pos + 4 > self.bytes.len() {
            return Err(self.error("truncated \\u escape"));
        }
        let mut value = 0u16;
        for _ in 0..4 {
            let digit = self.bytes[self.pos];
            self.pos += 1;
            value = value * 16
                + u16::from(match digit {
                    b'0'..=b'9' => digit - b'0',
                    b'a'..=b'f' => digit - b'a' + 10,
                    b'A'..=b'F' => digit - b'A' + 10,
                    _ => return Err(self.error("invalid hex digit in \\u escape")),
                });
        }
        Ok(value)
    }

    fn parse_number(&mut self) -> JsResult<JsValue> {
        let start = self.pos;
        if self.peek() == Some(b'-') {
            self.pos += 1;
        }
        // Integer part: 0 | [1-9][0-9]*
        match self.peek() {
            Some(b'0') => self.pos += 1,
            Some(b'1'..=b'9') => {
                while matches!(self.peek(), Some(b'0'..=b'9')) {
                    self.pos += 1;
                }
            }
            _ => return Err(self.error("invalid JSON number")),
        }
        // Fraction
        if self.peek() == Some(b'.') {
            self.pos += 1;
            if !matches!(self.peek(), Some(b'0'..=b'9')) {
                return Err(self.error("invalid JSON number"));
            }
            while matches!(self.peek(), Some(b'0'..=b'9')) {
                self.pos += 1;
            }
        }
        // Exponent
        if matches!(self.peek(), Some(b'e' | b'E')) {
            self.pos += 1;
            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.pos += 1;
            }
            if !matches!(self.peek(), Some(b'0'..=b'9')) {
                return Err(self.error("invalid JSON number"));
            }
            while matches!(self.peek(), Some(b'0'..=b'9')) {
                self.pos += 1;
            }
        }
        let text = std::str::from_utf8(&self.bytes[start..self.pos])
            .map_err(|_| self.error("invalid JSON number"))?;
        // Rust's float parser is correctly rounded, as the ECMAScript literal lexer is;
        // out-of-range exponents saturate to infinity in both.
        let number: f64 = text.parse().map_err(|_| self.error("invalid JSON number"))?;
        Ok(JsValue::new(number))
    }
}
