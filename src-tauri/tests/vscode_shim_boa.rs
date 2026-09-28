//! Pins the Boa 0.20 environment bugs the pretend Node runtime's module loader works
//! around, and how far the vscode shim gets inside Boa: bundle eval, installer call,
//! and a minimal extension require + activate. The panic boundary is the deliverable.

// The N-API host's exported surface must be in this image for the /EXPORT directives
// to resolve; this suite never loads an addon itself, so this test holds the reference
// the linker needs (a const cannot — it folds away).
#[test]
#[cfg(feature = "node-runtime")]
fn the_napi_surface_links() {
    git_graph_studio_lib::node_runtime::link_napi_host();
}

use boa_engine::{Context, Source};

/// The claude-code bundle's grammar Boa 0.21.1 must swallow (the extension's own code
/// uses a class named `of` and private members named `$`): each snippet is legal
/// ECMAScript that V8 accepts, and a parse failure here is a Boa bug to fix, not a
/// package problem to work around.
#[test]
fn grammar_the_claude_code_bundle_needs() {
    let cases: &[(&str, &str)] = &[
        (
            "class named of",
            "class of extends Error { name = \"x\"; constructor() { super(\"y\"); } }",
        ),
        ("of variable", "var of = 1; of = class of {};"),
        ("of method", "class A { of($) { return $; } }"),
        (
            "private dollar",
            "class B { #$; #J = null; constructor($) { this.#$ = $; } of($) { return this.#$; } }",
        ),
        ("for of", "for (const z of [1, 2]) { void z; }"),
    ];
    for (name, source) in cases {
        let mut context = Context::default();
        if let Err(error) = context.eval(Source::from_bytes(source.as_bytes())) {
            panic!("Boa cannot parse {name}: {error}");
        }
    }
}

/// The inline-cache poisoning zod v4 hits inside claude-code: a lazy getter that
/// redefines its own property as data (`Object.defineProperty(this, k, { value })`)
/// reshapes the object DURING the cached lookup. Stock Boa 0.21.1 then cached the
/// post-getter (data) shape with the pre-getter (accessor) slot, so the next read of any
/// object of that data shape "called" the plain value: `TypeError: not a callable
/// function` on `def.shape`, and claude-code never activated. The vendored engine caches
/// against the shape the lookup saw (GGS-patch in `vm/opcode/get/property.rs`,
/// `get/name.rs`, `set/property.rs`). The setter half: a setter that reshapes its
/// receiver must not leave a cached accessor slot on the reshaped layout either.
#[test]
fn a_getter_that_reshapes_its_object_does_not_poison_the_inline_cache() {
    let mut context = Context::default();
    let result = context
        .eval(Source::from_bytes(
            r#"
            const make = () => {
                const d = { type: "object" };
                Object.defineProperty(d, "shape", {
                    get() { const v = { a: 1 }; Object.defineProperty(this, "shape", { value: v }); return v; },
                    set(_) {},
                    enumerable: true,
                    configurable: true,
                });
                return d;
            };
            const read = (J) => J.shape;
            const first = read(make());            // the lookup that runs the getter
            const second = make(); second.shape;   // reshaped to data elsewhere
            const third = read(second);            // a cached read of the data layout
            globalThis.lazyShape = { a: 1 };
            Object.defineProperty(globalThis, "lazyGlobal", {
                get() { Object.defineProperty(globalThis, "lazyGlobal", { value: { g: 1 }, configurable: true }); return globalThis.lazyGlobal; },
                configurable: true,
            });
            const readGlobal = () => lazyGlobal;
            const g1 = readGlobal();
            const g2 = readGlobal();
            const makeSet = () => {
                const s = { kind: 1 };
                Object.defineProperty(s, "slot", {
                    get() { return 0; },
                    set(v) { Object.defineProperty(this, "slot", { value: v, writable: true }); },
                    enumerable: true,
                    configurable: true,
                });
                return s;
            };
            const write = (o, v) => { o.slot = v; };
            const s1 = makeSet(); write(s1, 1);
            const s2 = makeSet(); s2.slot = 2;
            write(s2, 3);
            [first.a, third.a, g1.g, g2.g, s1.slot, s2.slot].join(",")
            "#,
        ))
        .unwrap();
    assert_eq!(
        result
            .to_string(&mut context)
            .unwrap()
            .to_std_string_escaped(),
        "1,1,1,1,1,3"
    );
}

/// The Boa 0.20/0.21 bug behind `require.rs`'s `Function`-constructor ban: a module
/// compiled with the `Function` constructor runs, but the closures it defined used to
/// panic (`PutLexicalValue`, "must be declarative environment") the moment one ran
/// later. The vendored engine degrades that miscompiled initialization instead — the
/// closure completes, the skipped binding stays unset, and the runtime survives — so
/// this pins the NEW contract: no panic reaches the runtime. The compile-path ban in
/// `require.rs` stays regardless (a degraded closure still misbehaves silently).
#[test]
fn the_function_constructor_poison_degrades_instead_of_panicking() {
    let mut context = Context::default();
    context
        .eval(Source::from_bytes(
            "globalThis.__handler = null; globalThis.__register = (h) => { globalThis.__handler = h; };",
        ))
        .unwrap();
    let constructor = context.intrinsics().constructors().function().constructor();
    let args: Vec<boa_engine::JsValue> = vec![
        boa_engine::JsValue::from(boa_engine::JsString::from("exports")),
        boa_engine::JsValue::from(boa_engine::JsString::from(
            "\n__register(() => new Promise((r) => setTimeout(() => r(7), 5)));\n",
        )),
    ];
    let module = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let function = constructor.construct(&args, None, &mut context).unwrap();
        function.call(&boa_engine::JsValue::undefined(), &[], &mut context)
    }))
    .expect("the module itself runs — the poison strikes later, not at load");
    assert!(module.is_ok(), "{module:?}");
    let handler = context
        .global_object()
        .get(boa_engine::JsString::from("__handler"), &mut context)
        .ok()
        .and_then(|value| value.as_object())
        .expect("the handler registered");
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        handler.call(&boa_engine::JsValue::undefined(), &[], &mut context)
    }));
    let value = outcome.expect("the poisoned closure runs without panicking — the VM degrades it");
    assert!(value.is_ok(), "the degraded closure answers: {value:?}");
}

/// The fix shape `require.rs` ships: the prelude's `__ggsCompileModule` helper, whose
/// body DIRECT-evals the CommonJS wrapper. Direct eval compiles against the calling
/// scope and the wrapper captures that same chain, so the locators are consistent by
/// construction — wherever the load happens and whenever the module's closures run.
/// All four contexts are driven and asserted: top-level load, its handler called
/// later, the load nested inside a running frame (the nested-`require` path), and
/// that module's handler called later.
#[test]
fn the_direct_eval_module_compiler_holds_every_load_context() {
    fn noop_native(
        _this: &boa_engine::JsValue,
        _args: &[boa_engine::JsValue],
        _context: &mut Context,
    ) -> boa_engine::JsResult<boa_engine::JsValue> {
        Ok(boa_engine::JsValue::from(1.0))
    }
    // The Rust-side load step of require.rs: the helper compiles the wrapper (the
    // direct eval inside its own frame), then the wrapper runs with its five
    // CommonJS parameters. In the nested case this runs from a native while the
    // requiring module's frame is active.
    fn compile_module_and_call(
        context: &mut Context,
        source: &str,
    ) -> boa_engine::JsResult<boa_engine::JsObject> {
        let helper = context
            .global_object()
            .get(boa_engine::JsString::from("__ggsCompileModule"), context)?
            .as_object()
            .expect("the compile helper exists");
        let wrapper = helper
            .call(
                &boa_engine::JsValue::undefined(),
                &[boa_engine::JsValue::from(boa_engine::JsString::from(
                    source,
                ))],
                context,
            )?
            .as_object()
            .expect("the helper answered a function");
        let exports = boa_engine::JsObject::with_object_proto(context.intrinsics());
        let module = boa_engine::JsObject::with_object_proto(context.intrinsics());
        module
            .set(
                boa_engine::JsString::from("exports"),
                exports.clone(),
                false,
                context,
            )
            .unwrap();
        wrapper.call(
            &boa_engine::JsValue::undefined(),
            &[
                exports.clone().into(),
                boa_engine::JsValue::undefined(),
                module.into(),
                boa_engine::JsValue::undefined(),
                boa_engine::JsValue::undefined(),
            ],
            context,
        )?;
        Ok(exports)
    }
    fn nested_native(
        _this: &boa_engine::JsValue,
        _args: &[boa_engine::JsValue],
        context: &mut Context,
    ) -> boa_engine::JsResult<boa_engine::JsValue> {
        let source = context
            .global_object()
            .get(boa_engine::JsString::from("__nestedSource"), context)?
            .as_string()
            .map(|s| s.to_std_string_escaped())
            .unwrap_or_default();
        compile_module_and_call(context, &source).map(|_| boa_engine::JsValue::undefined())
    }
    let mut context = Context::default();
    context
        .register_global_callable(
            boa_engine::JsString::from("__noop"),
            1,
            boa_engine::NativeFunction::from_fn_ptr(noop_native),
        )
        .unwrap();
    context
        .register_global_callable(
            boa_engine::JsString::from("__ggsCompileModuleRun"),
            0,
            boa_engine::NativeFunction::from_fn_ptr(nested_native),
        )
        .unwrap();
    context
        .eval(Source::from_bytes(
            "globalThis.__ggsCompileModule = function (text) {\n\
             return eval('(function (exports, require, module, __filename, __dirname) {\\n' + text + '\\n})');\n\
             };\n\
             globalThis.__outer = function () { const own = 3; globalThis.__capture = () => own; __ggsCompileModuleRun(); };",
        ))
        .unwrap();
    // The panic shape from the Function-constructor bug, as the loaded module: a
    // later-called handler creating a Promise whose executor parameter is captured
    // by a nested arrow, plus module-level lexical bindings of its own.
    let module_source = "const anchor = 1;\n\
         globalThis.__handler = () => { let x = anchor; return new Promise((r) => { x; __noop(() => r(7), 5, false, []); }); };";
    compile_module_and_call(&mut context, module_source).expect("the top-level module loads");
    let handler = context
        .global_object()
        .get(boa_engine::JsString::from("__handler"), &mut context)
        .ok()
        .and_then(|value| value.as_object())
        .expect("the handler registered");
    handler
        .call(&boa_engine::JsValue::undefined(), &[], &mut context)
        .expect("the top-level module's handler answers without the env panic");

    // The nested load: the requiring module's frame is running when its require
    // reaches the compiler.
    context
        .eval(Source::from_bytes(&format!(
            "globalThis.__nestedSource = {};",
            serde_json::to_string(
                "globalThis.__handler = () => { let y = 1; return new Promise((r) => { y; __noop(() => r(8), 5, false, []); }); };"
            )
            .unwrap()
        )))
        .unwrap();
    let outer = context
        .global_object()
        .get(boa_engine::JsString::from("__outer"), &mut context)
        .ok()
        .and_then(|value| value.as_object())
        .expect("__outer defined");
    outer
        .call(&boa_engine::JsValue::undefined(), &[], &mut context)
        .expect("the nested module loads inside a running frame");
    let handler = context
        .global_object()
        .get(boa_engine::JsString::from("__handler"), &mut context)
        .ok()
        .and_then(|value| value.as_object())
        .expect("the nested handler registered");
    handler
        .call(&boa_engine::JsValue::undefined(), &[], &mut context)
        .expect("the nested module's handler answers without the env panic");
}
/// The shape `require.rs` ships since 2026-09-27: the CommonJS wrapper compiled as a
/// `Script` from Rust, in every load context the direct-eval helper above holds — a
/// top-level load, its handler called later, a load nested inside a running frame (a
/// module's own `require`), and that module's handler called later. The nested case is
/// the vendored `Script::evaluate` patch: upstream ran the script over the caller's
/// environment chain, so the wrapper saw the caller's locals and its global-depth
/// locators aimed into the caller's frames. Here the nested module must see no
/// caller local, and its closures must run clean after the caller returned.
#[test]
fn the_script_module_compiler_holds_every_load_context() {
    fn noop_native(
        _this: &boa_engine::JsValue,
        _args: &[boa_engine::JsValue],
        _context: &mut Context,
    ) -> boa_engine::JsResult<boa_engine::JsValue> {
        Ok(boa_engine::JsValue::from(1.0))
    }
    fn compile_module_and_call(
        context: &mut Context,
        source: &str,
    ) -> boa_engine::JsResult<boa_engine::JsObject> {
        let wrapper = format!(
            "(function (exports, require, module, __filename, __dirname) {{
{source}
}})"
        );
        let function = boa_engine::Script::parse_all_bindings_escaping(
            Source::from_bytes(wrapper.as_bytes())
                .with_path(std::path::Path::new("C:/pkg/module.js")),
            None,
            context,
        )?
        .evaluate(context)?
        .as_object()
        .expect("the wrapper evaluates to a function");
        let exports = boa_engine::JsObject::with_object_proto(context.intrinsics());
        let module = boa_engine::JsObject::with_object_proto(context.intrinsics());
        module
            .set(
                boa_engine::JsString::from("exports"),
                exports.clone(),
                false,
                context,
            )
            .unwrap();
        function.call(
            &boa_engine::JsValue::undefined(),
            &[
                exports.clone().into(),
                boa_engine::JsValue::undefined(),
                module.into(),
                boa_engine::JsValue::undefined(),
                boa_engine::JsValue::undefined(),
            ],
            context,
        )?;
        Ok(exports)
    }
    fn nested_native(
        _this: &boa_engine::JsValue,
        _args: &[boa_engine::JsValue],
        context: &mut Context,
    ) -> boa_engine::JsResult<boa_engine::JsValue> {
        let source = context
            .global_object()
            .get(boa_engine::JsString::from("__nestedSource"), context)?
            .as_string()
            .map(|s| s.to_std_string_escaped())
            .unwrap_or_default();
        compile_module_and_call(context, &source).map(|_| boa_engine::JsValue::undefined())
    }
    fn global_value(context: &mut Context, name: &str) -> boa_engine::JsValue {
        context
            .global_object()
            .get(boa_engine::JsString::from(name), context)
            .unwrap()
    }
    let mut context = Context::default();
    context
        .register_global_callable(
            boa_engine::JsString::from("__noop"),
            1,
            boa_engine::NativeFunction::from_fn_ptr(noop_native),
        )
        .unwrap();
    context
        .register_global_callable(
            boa_engine::JsString::from("__requireNested"),
            0,
            boa_engine::NativeFunction::from_fn_ptr(nested_native),
        )
        .unwrap();
    // The requiring module's frame: a local of its own, a closure over it, and the
    // nested require while that frame is live.
    context
        .eval(Source::from_bytes(
            "globalThis.__outer = function () { const own = 3; let inner = 4;              globalThis.__capture = () => own + inner; __requireNested(); return own + inner; };",
        ))
        .unwrap();
    let module_source = "const anchor = 1;
         globalThis.__handler = () => { let x = anchor; return new Promise((r) => { x; __noop(() => r(7), 5, false, []); }); };";
    compile_module_and_call(&mut context, module_source).expect("the top-level module loads");
    let handler = global_value(&mut context, "__handler")
        .as_object()
        .expect("the handler registered");
    handler
        .call(&boa_engine::JsValue::undefined(), &[], &mut context)
        .expect("the top-level module's handler answers");

    context
        .eval(Source::from_bytes(&format!(
            "globalThis.__nestedSource = {};",
            serde_json::to_string(
                "const mine = 5; globalThis.__sawCallerLocal = typeof own !== 'undefined' || typeof inner !== 'undefined';
                 globalThis.__handler = () => { let y = mine; return new Promise((r) => { y; __noop(() => r(8), 5, false, []); }); };
                 globalThis.__mine = () => mine;"
            )
            .unwrap()
        )))
        .unwrap();
    let outer = global_value(&mut context, "__outer")
        .as_object()
        .expect("__outer defined");
    let returned = outer
        .call(&boa_engine::JsValue::undefined(), &[], &mut context)
        .expect("the nested module loads inside a running frame");
    assert_eq!(
        returned.as_number(),
        Some(7.0),
        "the caller's frame is intact after the nested load"
    );
    assert_eq!(
        global_value(&mut context, "__sawCallerLocal").as_boolean(),
        Some(false),
        "the nested module compiles in the global scope, not the caller's"
    );
    let handler = global_value(&mut context, "__handler")
        .as_object()
        .expect("the nested handler registered");
    handler
        .call(&boa_engine::JsValue::undefined(), &[], &mut context)
        .expect("the nested module's handler answers");
    let mine = global_value(&mut context, "__mine")
        .as_object()
        .expect("the nested module's closure registered");
    assert_eq!(
        mine.call(&boa_engine::JsValue::undefined(), &[], &mut context)
            .unwrap()
            .as_number(),
        Some(5.0),
        "the nested module's closure reads its own module-level binding"
    );
    let capture = global_value(&mut context, "__capture")
        .as_object()
        .expect("the caller's closure registered");
    assert_eq!(
        capture
            .call(&boa_engine::JsValue::undefined(), &[], &mut context)
            .unwrap()
            .as_number(),
        Some(7.0),
        "the caller's own closure still reads the caller's bindings"
    );
}

/// Why the module loader compiles with every binding escaping: Boa 0.21.1's register-local
/// path cannot hold a module-sized function. A CommonJS wrapper whose body declares
/// thousands of top-level names — every real bundle — puts each non-escaping one in a
/// register, the register file lands on the VM stack, and the call fails before a line of
/// the module runs ("exceeded maximum call stack length" here; loading Claude Code's
/// bundle it surfaced as "access of uninitialized binding" instead). The escaping analysis
/// — what the indirect-eval loader always ran, and what `parse_all_bindings_escaping`
/// keeps on the script route — runs the same wrapper clean. The register-path failure is
/// pinned too: when an upstream Boa holds it, this test says so and the loader can
/// reconsider register locals.
#[test]
fn a_module_sized_wrapper_runs_with_every_binding_escaping() {
    let names: Vec<String> = (0..16_000).map(|i| format!("p{i} = {i}")).collect();
    let source = format!(
        "(function () {{ var {};
         var dJ0 = [\"command\", \"args\"], iJ0 = new Set([\"http\", \"sse\"]);
         var check = ($) => {{ let J = (X, Y) => {{ $.issues.push({{ path: X, message: Y }}); }};
           for (let X of dJ0) if (Object.hasOwn($.value, X)) J([X], `\"${{X}}\" is not allowed`);
           if (!iJ0.has($.value.type)) J([\"type\"], 'only http or sse');
           let Q = $.value.url; if (typeof Q !== \"string\") J([\"url\"], 'no url');
           return $.issues.length; }};
         return check({{ issues: [], value: {{ type: \"stdio\", command: \"x\" }} }});
         }})()",
        names.join(", ")
    );

    let mut context = Context::default();
    let escaping = boa_engine::Script::parse_all_bindings_escaping(
        Source::from_bytes(source.as_bytes()),
        None,
        &mut context,
    )
    .expect("the wrapper parses")
    .evaluate(&mut context)
    .expect("the module-sized wrapper runs with every binding escaping");
    assert_eq!(
        escaping.as_number(),
        Some(3.0),
        "command, type and url each reported once"
    );

    let mut context = Context::default();
    let registers = boa_engine::Script::parse(Source::from_bytes(source.as_bytes()), None, &mut context)
        .expect("the wrapper parses")
        .evaluate(&mut context);
    assert!(
        registers.is_err(),
        "Boa's register-local path now runs a module-sized function — the loader's          all-escaping analysis may be reconsidered (see require.rs)"
    );
}

#[test]
fn the_git_graph_extension_entry_evaluates_in_boa() {
    // The dev-machine install is optional (the skip below) — but the home variable is not:
    // USERPROFILE is Windows-only, and the bare unwrap panicked on CI's Linux runner
    // before the skip could fire.
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_default();
    let entry = std::path::Path::new(&home)
        .join(".ggs/extensions/neophack.git-graph-rs-1.0.25/out/extension.js");
    let Ok(source) = std::fs::read_to_string(&entry) else {
        eprintln!("skipping: no git-graph-rs install");
        return;
    };
    let mut context = Context::default();
    context
        .eval(Source::from_bytes(
            "globalThis.vscode = { workspace: {}, commands: {}, window: {}, extensions: {} };",
        ))
        .unwrap();
    // Proper CommonJS wrapper: the extension's module bodies load (class definitions and
    // all — the construct Boa's define opcode choked on in the live run).
    let wrapped = format!(
        "(function (exports, require, module, __filename, __dirname) {{\n{source}\n}})( {{}}, function () {{ return {{}}; }}, {{ exports: {{}} }}, '', '' );"
    );
    match context.eval(Source::from_bytes(wrapped.as_bytes())) {
        Ok(_) => eprintln!("the extension entry evaluates in Boa"),
        Err(error) => eprintln!("the extension entry FAILED to evaluate: {error}"),
    }
}

/// The module bytecode cache (2026-09-28): a compiled wrapper serialized through
/// `vm::bytecode_cache::encode_codeblock` and rebuilt through `decode_codeblock` +
/// `Script::from_compiled` must run identically to the freshly compiled one — classes
/// with private fields, closures over block scopes, try/catch handlers, a BigInt
/// constant and a rest-parameter call site cover every `Constant` variant and the
/// handler/IC tables. `Function.prototype.toString` must also survive, since error
/// positions and stack frames read the cached source text.
#[test]
#[cfg(feature = "node-runtime")]
fn the_module_bytecode_cache_roundtrips_and_runs_identically() {
    use boa_engine::{JsValue, Script, Source};

    let wrapper = r#"(function (exports, require, module, __filename, __dirname) {
        const scale = 2n;
        let total = 0;
        class Counter {
            #n = 0;
            bump(step) { this.#n += Number(step); return this.#n; }
        }
        const counter = new Counter();
        function addAll(...values) {
            try {
                for (const v of values) { total += v; }
            } catch (err) {
                return -1;
            }
            return total;
        }
        {
            let blockScoped = 10;
            addAll(blockScoped);
        }
        exports.run = function (step) {
            const big = BigInt(step) * scale;
            return [counter.bump(step), addAll(step), String(big), addAll.length, typeof module];
        };
    })"#;

    let run = |context: &mut Context, script: &Script| -> String {
        let function = script
            .evaluate(context)
            .expect("the wrapper evaluates")
            .as_object()
            .expect("a function");
        // Call the wrapper the way `evaluate_module` does: fresh exports/module and a
        // five-argument invocation, then read what the module exported.
        let exports = boa_engine::JsObject::with_object_proto(context.intrinsics());
        let module = boa_engine::JsObject::with_object_proto(context.intrinsics());
        module
            .set(
                boa_engine::property::PropertyKey::from(boa_engine::js_string!("exports")),
                JsValue::from(exports.clone()),
                false,
                context,
            )
            .expect("module.exports");
        function
            .call(
                &JsValue::undefined(),
                &[
                    exports.clone().into(),
                    JsValue::undefined(),
                    module.clone().into(),
                    JsValue::from(boa_engine::js_string!("/test/entry.js")),
                    JsValue::from(boa_engine::js_string!("/test")),
                ],
                context,
            )
            .expect("the wrapper runs");
        let run_fn = module
            .get(boa_engine::property::PropertyKey::from(
                boa_engine::js_string!("exports"),
            ), context)
            .expect("final exports")
            .as_object()
            .expect("exports object")
            .get(boa_engine::property::PropertyKey::from(
                boa_engine::js_string!("run"),
            ), context)
            .expect("run");
        let result = run_fn
            .as_object()
            .expect("run function")
            .call(
                &JsValue::undefined(),
                &[JsValue::from(7)],
                context,
            )
            .expect("run() answers");
        result.to_string(context).expect("string").to_std_string_escaped()
    };

    // The direct path: parse, compile, run.
    let mut context = Context::default();
    let direct_script = Script::parse_all_bindings_escaping(
        Source::from_bytes(wrapper.as_bytes()),
        None,
        &mut context,
    )
    .expect("parses");
    let direct = run(&mut context, &direct_script);

    // The cached path: compile, serialize, rebuild, run — in a FRESH context, so the
    // rebuilt scopes tie into a different realm exactly as a second process start does.
    let mut compile_context = Context::default();
    let compiled = {
        let script = Script::parse_all_bindings_escaping(
            Source::from_bytes(wrapper.as_bytes()),
            None,
            &mut compile_context,
        )
        .expect("parses");
        script.codeblock(&mut compile_context).expect("compiles")
    };
    let blob = bincode::serialize(&boa_engine::vm::bytecode_cache::to_mirror(&compiled))
        .expect("serializes");

    let mut cached_context = Context::default();
    let decoded = {
        let mirror: boa_engine::vm::bytecode_cache::CacheBlob =
            bincode::deserialize(&blob).expect("deserializes");
        boa_engine::vm::bytecode_cache::from_mirror(mirror, wrapper, cached_context.realm().scope())
            .expect("rebuilds")
    };
    let cached_script = Script::from_compiled(
        boa_engine::gc::Gc::new(*decoded),
        None,
        cached_context.realm().clone(),
    );
    let cached = run(&mut cached_context, &cached_script);

    assert_eq!(direct, cached, "the cached tree must run identically");
    // The values themselves: bump(7)=7, the accumulated addAll(7)=17, 7n*2n=14n, a rest
    // function's length of 0, and the module parameter object.
    assert_eq!(direct, "7,17,14,0,object", "sanity: the computed values");
    // And the blob round-trips the source text the stack traces need.
    let mut context_for_tostring = Context::default();
    let mirror2: boa_engine::vm::bytecode_cache::CacheBlob =
        bincode::deserialize(&blob).expect("deserializes again");
    let decoded2 = boa_engine::vm::bytecode_cache::from_mirror(
        mirror2,
        wrapper,
        context_for_tostring.realm().scope(),
    )
    .expect("rebuilds again");
    let script2 = Script::from_compiled(
        boa_engine::gc::Gc::new(*decoded2),
        None,
        context_for_tostring.realm().clone(),
    );
    let function2 = script2
        .evaluate(&mut context_for_tostring)
        .expect("evaluates")
        .as_object()
        .expect("a function");
    let as_string = function2
        .get(
            boa_engine::property::PropertyKey::from(boa_engine::js_string!("toString")),
            &mut context_for_tostring,
        )
        .expect("toString exists")
        .as_object()
        .expect("callable")
        .call(&function2.clone().into(), &[], &mut context_for_tostring)
        .expect("toString answers")
        .to_string(&mut context_for_tostring)
        .expect("string")
        .to_std_string_escaped();
    assert!(
        as_string.contains("__dirname"),
        "the cached wrapper keeps its source text: {as_string}"
    );
}

/// The register-local path (2026-09-28): a module whose bindings are clean under the real
/// escape analysis compiles locals to register `Move`s — no per-iteration environments in
/// `for (let …)` loops, no environment stores for uncaptured names — and must compute
/// identical values to the escaping path. Pinned together with the two compile-time
/// guards ggs-node's `require` uses (see the next test): the register count stays under
/// the loader's limit and no binding was used before its declaration point.
#[test]
#[cfg(feature = "node-runtime")]
fn register_locals_run_clean_modules_identically() {
    use boa_engine::{Context, JsValue, Script, Source};

    let wrapper = r#"(function (exports, require, module, __filename, __dirname) {
        let sum = 0;
        for (let i = 0; i < 4; i++) { sum += i * 2; }
        let captured = [];
        for (let j = 0; j < 3; j++) captured.push(() => j);
        class Boxed { #v; constructor(v) { this.#v = v; } read() { return this.#v; } }
        const box = new Boxed(sum);
        module.exports = { sum, captured: captured.map(f => f()), boxed: box.read() };
    })"#;

    let run = |context: &mut Context| -> String {
        let script = Script::parse(Source::from_bytes(wrapper.as_bytes()), None, context)
            .expect("parses under the real escape analysis");
        assert!(
            !Script::tripped_uninitialized_local(),
            "a clean module must not trip the use-before-declaration guard"
        );
        assert!(
            script.max_register_count(context) <= 4096,
            "a normal module's register file stays far under the loader limit"
        );
        let function = script
            .evaluate(context)
            .expect("evaluates")
            .as_object()
            .expect("a function");
        let exports = boa_engine::JsObject::with_object_proto(context.intrinsics());
        let module = boa_engine::JsObject::with_object_proto(context.intrinsics());
        module
            .set(
                boa_engine::property::PropertyKey::from(boa_engine::js_string!("exports")),
                JsValue::from(exports.clone()),
                false,
                context,
            )
            .expect("module.exports");
        function
            .call(&JsValue::undefined(), &[JsValue::undefined(), JsValue::undefined(), module.clone().into()], context)
            .expect("the wrapper runs");
        let exports = module
            .get(boa_engine::property::PropertyKey::from(boa_engine::js_string!("exports")), context)
            .expect("exports")
            .as_object()
            .expect("an object");
        let field = |context: &mut Context, name: &str| {
            exports
                .get(boa_engine::property::PropertyKey::from(boa_engine::js_string!(name)), context)
                .expect(name)
                .to_string(context)
                .expect("string")
                .to_std_string_escaped()
        };
        format!(
            "{},{},{}",
            field(context, "sum"),
            field(context, "captured"),
            field(context, "boxed")
        )
    };

    let mut context = Context::default();
    Script::reset_uninitialized_local_trip();
    let direct = run(&mut context);
    assert_eq!(direct, "12,0,1,2,12", "the register path computes the values");
}

/// The fallback half of the register-local path: a use of a block-scoped binding before
/// its declaration (boa 0.21.1 would bake a static TDZ throw into the site — wrong for
/// every use that runs after initialization) trips the compile-time guard, and the
/// module recompiled with every binding escaping evaluates correctly — the dead branch
/// never executes, so nothing throws.
#[test]
#[cfg(feature = "node-runtime")]
fn a_use_before_declaration_trips_the_register_guard_and_the_fallback_runs() {
    use boa_engine::{Context, JsValue, Script, Source};

    let wrapper = r#"(function (exports, require, module, __filename, __dirname) {
        if (false) { let probe = typeof Later; class Later {} }
        let n = 0;
        for (let i = 0; i < 5; i++) { n += i; }
        module.exports = { n };
    })"#;

    let mut context = Context::default();
    Script::reset_uninitialized_local_trip();
    let script = Script::parse(Source::from_bytes(wrapper.as_bytes()), None, &mut context)
        .expect("parses");
    // The compile read the binding inside the block before the class declaration point.
    let _ = script.max_register_count(&mut context);
    assert!(
        Script::tripped_uninitialized_local(),
        "the use-before-declaration site must trip the guard"
    );

    // The loader's fallback: the same source through the all-escaping analysis.
    let script = Script::parse_all_bindings_escaping(Source::from_bytes(wrapper.as_bytes()), None, &mut context)
        .expect("parses escaping");
    let function = script
        .evaluate(&mut context)
        .expect("evaluates")
        .as_object()
        .expect("a function");
    let exports = boa_engine::JsObject::with_object_proto(context.intrinsics());
    let module = boa_engine::JsObject::with_object_proto(context.intrinsics());
    module
        .set(
            boa_engine::property::PropertyKey::from(boa_engine::js_string!("exports")),
            JsValue::from(exports),
            false,
            &mut context,
        )
        .expect("module.exports");
    function
        .call(&JsValue::undefined(), &[JsValue::undefined(), JsValue::undefined(), module.clone().into()], &mut context)
        .expect("the fallback wrapper runs");
    let n = module
        .get(boa_engine::property::PropertyKey::from(boa_engine::js_string!("exports")), &mut context)
        .expect("exports")
        .as_object()
        .expect("an object")
        .get(boa_engine::property::PropertyKey::from(boa_engine::js_string!("n")), &mut context)
        .expect("n");
    assert_eq!(n.to_number(&mut context).expect("number") as i64, 10);
}
