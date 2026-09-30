use boa_macros::js_str;
use indoc::indoc;

use crate::{JsNativeErrorKind, JsValue, TestAction, js_string, run_test_actions};

#[test]
fn json_sanity() {
    run_test_actions([
        TestAction::assert_eq(r#"JSON.parse('{"aaa":"bbb"}').aaa"#, js_str!("bbb")),
        TestAction::assert_eq(
            r#"JSON.stringify({aaa: 'bbb'})"#,
            js_string!(r#"{"aaa":"bbb"}"#),
        ),
    ]);
}

#[test]
fn json_stringify_remove_undefined_values_from_objects() {
    run_test_actions([TestAction::assert_eq(
        r#"JSON.stringify({ aaa: undefined, bbb: 'ccc' })"#,
        js_string!(r#"{"bbb":"ccc"}"#),
    )]);
}

#[test]
fn json_stringify_remove_function_values_from_objects() {
    run_test_actions([TestAction::assert_eq(
        r#"JSON.stringify({ aaa: () => {}, bbb: 'ccc' })"#,
        js_string!(r#"{"bbb":"ccc"}"#),
    )]);
}

#[test]
fn json_stringify_remove_symbols_from_objects() {
    run_test_actions([TestAction::assert_eq(
        r#"JSON.stringify({ aaa: Symbol(), bbb: 'ccc' })"#,
        js_string!(r#"{"bbb":"ccc"}"#),
    )]);
}

#[test]
fn json_stringify_replacer_array_strings() {
    run_test_actions([TestAction::assert_eq(
        r#"JSON.stringify({aaa: 'bbb', bbb: 'ccc', ccc: 'ddd'}, ['aaa', 'bbb'])"#,
        js_string!(r#"{"aaa":"bbb","bbb":"ccc"}"#),
    )]);
}

#[test]
fn json_stringify_replacer_array_numbers() {
    run_test_actions([TestAction::assert_eq(
        r#"JSON.stringify({ 0: 'aaa', 1: 'bbb', 2: 'ccc'}, [1, 2])"#,
        js_string!(r#"{"1":"bbb","2":"ccc"}"#),
    )]);
}

#[test]
fn json_stringify_replacer_function() {
    run_test_actions([TestAction::assert_eq(
        indoc! {r#"
            JSON.stringify({ aaa: 1, bbb: 2}, (key, value) => {
                if (key === 'aaa') {
                    return undefined;
                }

                return value;
            })
        "#},
        js_string!(r#"{"bbb":2}"#),
    )]);
}

#[test]
fn json_stringify_arrays() {
    run_test_actions([TestAction::assert_eq(
        "JSON.stringify(['a', 'b'])",
        js_string!(r#"["a","b"]"#),
    )]);
}

#[test]
fn json_stringify_object_array() {
    run_test_actions([TestAction::assert_eq(
        "JSON.stringify([{a: 'b'}, {b: 'c'}])",
        js_string!(r#"[{"a":"b"},{"b":"c"}]"#),
    )]);
}

#[test]
fn json_stringify_array_converts_undefined_to_null() {
    run_test_actions([TestAction::assert_eq(
        "JSON.stringify([undefined])",
        js_str!("[null]"),
    )]);
}

#[test]
fn json_stringify_array_converts_function_to_null() {
    run_test_actions([TestAction::assert_eq(
        "JSON.stringify([() => {}])",
        js_str!("[null]"),
    )]);
}

#[test]
fn json_stringify_array_converts_symbol_to_null() {
    run_test_actions([TestAction::assert_eq(
        "JSON.stringify([Symbol()])",
        js_str!("[null]"),
    )]);
}
#[test]
fn json_stringify_function_replacer_propagate_error() {
    run_test_actions([TestAction::assert_opaque_error(
        "JSON.stringify({x: 1}, (key, value) => { throw 1 })",
        1,
    )]);
}

#[test]
fn json_stringify_function() {
    run_test_actions([TestAction::assert_eq(
        "JSON.stringify(() => {})",
        JsValue::undefined(),
    )]);
}

#[test]
fn json_stringify_undefined() {
    run_test_actions([TestAction::assert_eq(
        "JSON.stringify(undefined)",
        JsValue::undefined(),
    )]);
}

#[test]
fn json_stringify_symbol() {
    run_test_actions([TestAction::assert_eq(
        "JSON.stringify(Symbol())",
        JsValue::undefined(),
    )]);
}

#[test]
fn json_stringify_no_args() {
    run_test_actions([TestAction::assert_eq(
        "JSON.stringify()",
        JsValue::undefined(),
    )]);
}

#[test]
fn json_stringify_fractional_numbers() {
    run_test_actions([TestAction::assert_eq("JSON.stringify(1.2)", js_str!("1.2"))]);
}

#[test]
fn json_stringify_pretty_print() {
    run_test_actions([TestAction::assert_eq(
        r#"JSON.stringify({a: "b", b: "c"}, undefined, 4)"#,
        js_string!(indoc! {r#"
            {
                "a": "b",
                "b": "c"
            }"#
        }),
    )]);
}

#[test]
fn json_stringify_pretty_print_four_spaces() {
    run_test_actions([TestAction::assert_eq(
        r#"JSON.stringify({a: "b", b: "c"}, undefined, 4.3)"#,
        js_string!(indoc! {r#"
            {
                "a": "b",
                "b": "c"
            }"#
        }),
    )]);
}

#[test]
fn json_stringify_pretty_print_twenty_spaces() {
    run_test_actions([TestAction::assert_eq(
        r#"JSON.stringify({a: "b", b: "c"}, undefined, 20)"#,
        js_string!(indoc! {r#"
            {
                      "a": "b",
                      "b": "c"
            }"#
        }),
    )]);
}

#[test]
fn json_stringify_pretty_print_with_number_object() {
    run_test_actions([TestAction::assert_eq(
        r#"JSON.stringify({a: "b", b: "c"}, undefined, new Number(10))"#,
        js_string!(indoc! {r#"
            {
                      "a": "b",
                      "b": "c"
            }"#
        }),
    )]);
}

#[test]
fn json_stringify_pretty_print_bad_space_argument() {
    run_test_actions([TestAction::assert_eq(
        r#"JSON.stringify({a: "b", b: "c"}, undefined, [])"#,
        js_string!(r#"{"a":"b","b":"c"}"#),
    )]);
}

#[test]
fn json_stringify_pretty_print_with_too_long_string() {
    run_test_actions([TestAction::assert_eq(
        r#"JSON.stringify({a: "b", b: "c"}, undefined, "abcdefghijklmn")"#,
        js_string!(indoc! {r#"
            {
            abcdefghij"a": "b",
            abcdefghij"b": "c"
            }"#
        }),
    )]);
}

#[test]
fn json_stringify_pretty_print_with_string_object() {
    run_test_actions([TestAction::assert_eq(
        r#"JSON.stringify({a: "b", b: "c"}, undefined, new String("abcd"))"#,
        js_string!(indoc! {r#"
            {
            abcd"a": "b",
            abcd"b": "c"
            }"#
        }),
    )]);
}

#[test]
fn json_parse_array_with_reviver() {
    run_test_actions([
        TestAction::run_harness(),
        TestAction::run(indoc! {r#"
                function reviver(k, v){
                    if (typeof v == 'number') {
                        return v * 2;
                    } else {
                        return v;
                    }
                }
            "#}),
        TestAction::assert("arrayEquals(JSON.parse('[1,2,3,4]', reviver), [2,4,6,8])"),
    ]);
}

#[test]
fn json_parse_object_with_reviver() {
    run_test_actions([
        TestAction::run(indoc! {r#"
                var jsonString = JSON.stringify({
                    firstname: "boa",
                    lastname: "snake"
                });

                function dataReviver(key, value) {
                    if (key == 'lastname') {
                        return 'interpreter';
                    } else {
                        return value;
                    }
                }

                var jsonObj = JSON.parse(jsonString, dataReviver);
            "#}),
        TestAction::assert_eq("jsonObj.firstname", js_str!("boa")),
        TestAction::assert_eq("jsonObj.lastname", js_str!("interpreter")),
    ]);
}

#[test]
fn json_parse_sets_prototypes() {
    run_test_actions([
        TestAction::run(indoc! {r#"
                const jsonString = "{\"ob\":{\"ject\":1},\"arr\": [0,1]}";
                const jsonObj = JSON.parse(jsonString);
            "#}),
        TestAction::assert("Object.getPrototypeOf(jsonObj.ob) === Object.prototype"),
        TestAction::assert("Object.getPrototypeOf(jsonObj.arr) === Array.prototype"),
    ]);
}

#[test]
fn json_fields_should_be_enumerable() {
    run_test_actions([
        TestAction::assert(indoc! {r#"
                var a = JSON.parse('{"x":0}');
                a.propertyIsEnumerable('x')
            "#}),
        TestAction::assert(indoc! {r#"
                var b = JSON.parse('[0, 1]');
                b.propertyIsEnumerable('0');
            "#}),
    ]);
}

// GGS-patch: the direct parser's compatibility pins — every edge a claude-shaped
// payload (or an upgraded one) can present, held by the suite so an engine change that
// diverges from V8-visible behavior fails here instead of in the field.
#[test]
fn json_parse_direct_parser_edges() {
    run_test_actions([
        // Insertion-ordered keys, integer keys ascending first — Object.keys' order.
        TestAction::assert(indoc! {r#"
            JSON.stringify(Object.keys(JSON.parse('{"b":1,"a":2,"1":3}')))
                === '["1","b","a"]'
        "#}),
        // `__proto__` is an ordinary data property (JSON never assigns prototypes).
        TestAction::assert(indoc! {r#"
            var o = JSON.parse('{"__proto__": 5, "x": 1}');
            Object.getPrototypeOf(o) === Object.prototype
                && o["__proto__"] === 5
                && Object.keys(o).join() === "__proto__,x"
        "#}),
        // Duplicate keys: the last value wins, the position stays at the first.
        TestAction::assert(indoc! {r#"
            var o = JSON.parse('{"x":1,"x":2}');
            o.x === 2 && Object.keys(o).length === 1
        "#}),
        // Number edges: -0 keeps its sign, out-of-range exponents are Infinity.
        TestAction::assert(indoc! {r#"
            Object.is(JSON.parse('-0'), -0) && JSON.parse('1e999') === Infinity
                && JSON.parse('2e-3') === 0.002
        "#}),
        // Escapes: a surrogate pair combines; a lone surrogate is preserved.
        TestAction::assert(indoc! {r#"
            JSON.parse('"\uD83D\uDE00"') === String.fromCodePoint(0x1F600)
        "#}),
        TestAction::assert(indoc! {r#"
            JSON.parse('"' + String.fromCharCode(92) + 'uD800"').length === 1
        "#}),
        // Malformed texts are SyntaxErrors (never a crash, never a value).
        TestAction::assert_native_error(
            r#"JSON.parse('{"a":}');"#,
            JsNativeErrorKind::Syntax,
            "unexpected token at position 5",
        ),
        TestAction::assert_native_error(
            r"JSON.parse('[1,]');",
            JsNativeErrorKind::Syntax,
            "unexpected token at position 3",
        ),
        TestAction::assert_native_error(
            r"JSON.parse('01');",
            JsNativeErrorKind::Syntax,
            "unexpected token after JSON value at position 1",
        ),
        // Pathological nesting answers a SyntaxError (the parser's depth cap), not a
        // stack overflow — the recursion is bounded on purpose.
        TestAction::assert_native_error(
            r#"JSON.parse('['.repeat(100000) + ']'.repeat(100000));"#,
            JsNativeErrorKind::Syntax,
            "maximum JSON nesting depth exceeded at position 512",
        ),
        TestAction::assert(indoc! {r#"
            var v = JSON.parse('['.repeat(400) + ']'.repeat(400));
            var depth = 0;
            while (Array.isArray(v)) { depth++; v = v[0]; }
            depth === 400
        "#}),
        // The reviver still runs over the direct parser's tree.
        TestAction::assert(indoc! {r#"
            JSON.parse('{"a":1,"b":{"c":2}}', function (k, v) {
                return typeof v === 'number' ? v * 10 : v;
            }).b.c === 20
        "#}),
    ]);
}

// GGS-patch: the fast writer's compatibility pins — the plain-data case must be
// byte-identical to the generic serializer's output, and every bail-out keeps the spec
// shape (dates, cycles, prototype `toJSON`).
#[test]
fn json_stringify_fast_writer_edges() {
    run_test_actions([
        TestAction::assert(indoc! {r#"
            JSON.stringify({b: 1, a: 2, 1: 'x', '-3': true, 0.5: null})
                === '{"1":"x","b":1,"a":2,"-3":true,"0.5":null}'
        "#}),
        TestAction::assert(indoc! {r#"
            JSON.stringify({u: undefined, f: function(){}, s: 1}) === '{"s":1}'
                && JSON.stringify([undefined, function(){}, 1]) === '[null,null,1]'
        "#}),
        TestAction::assert(indoc! {r#"
            JSON.stringify({n: NaN, i: Infinity, z: -0}) === '{"n":null,"i":null,"z":0}'
        "#}),
        TestAction::assert(indoc! {r#"
            JSON.stringify('\u0007') === '"\\u0007"'
        "#}),
        // A `toJSON` on a standard prototype pulls the whole call to the generic path.
        TestAction::assert(indoc! {r#"
            var out;
            try {
                Object.prototype.toJSON = function () { return 'P'; };
                out = JSON.stringify({a: 1});
            } finally {
                delete Object.prototype.toJSON;
            }
            out === '"P"'
        "#}),
        TestAction::assert(indoc! {r#"
            JSON.stringify(new Date(0)) === '"1970-01-01T00:00:00.000Z"'
        "#}),
    ]);
}

#[test]
fn json_parse_with_no_args_throws_syntax_error() {
    // GGS-patch: the direct parser's message replaces `serde_json`'s ("expected value
    // at line 1 column 1"); the kind is the contract, the wording is the engine's own.
    run_test_actions([TestAction::assert_native_error(
        "JSON.parse();",
        JsNativeErrorKind::Syntax,
        "unexpected token at position 0",
    )]);
}
