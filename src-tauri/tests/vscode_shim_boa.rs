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
#[test]
fn the_git_graph_extension_entry_evaluates_in_boa() {
    let entry = std::path::Path::new(&std::env::var("USERPROFILE").unwrap())
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
