//! Boa's implementation of ECMAScript's Scripts.
//!
//! This module contains the [`Script`] type, which represents a [**Script Record**][script].
//!
//! More information:
//!  - [ECMAScript reference][spec]
//!
//! [spec]: https://tc39.es/ecma262/#sec-scripts
//! [script]: https://tc39.es/ecma262/#sec-script-records

use std::path::{Path, PathBuf};

use rustc_hash::FxHashMap;

use boa_gc::{Finalize, Gc, GcRefCell, Trace};
use boa_parser::{Parser, Source, source::ReadChar};

use crate::{
    Context, HostDefined, JsResult, JsString, JsValue, Module, SpannedSourceText,
    bytecompiler::{ByteCompiler, global_declaration_instantiation_context},
    js_string,
    realm::Realm,
    spanned_source_text::SourceText,
    vm::{ActiveRunnable, CallFrame, CallFrameFlags, CodeBlock},
};

/// ECMAScript's [**Script Record**][spec].
///
/// [spec]: https://tc39.es/ecma262/#sec-script-records
#[derive(Clone, Trace, Finalize)]
pub struct Script {
    inner: Gc<Inner>,
}

impl std::fmt::Debug for Script {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Script")
            .field("realm", &self.inner.realm.addr())
            .field("code", &self.inner.source)
            .field("loaded_modules", &self.inner.loaded_modules)
            .finish()
    }
}

/// GGS-patch: scripts whose source exceeds this many code units hand their compiled-out AST
/// to [`free_released_sources`] instead of dropping it inline.
const DEFERRED_RELEASE_THRESHOLD: usize = 256 * 1024;

thread_local! {
    // GGS-patch: compiled-out ASTs of large scripts, waiting for the embedder's idle time.
    static RELEASED_SOURCES: std::cell::RefCell<Vec<boa_ast::Script>> =
        const { std::cell::RefCell::new(Vec::new()) };
}

/// GGS-patch: drop the ASTs large scripts released after compiling. Tearing down a
/// multi-megabyte bundle's tree is millions of frees — a tenth of its compile — and none
/// of it has to happen before the script runs, so [`Script::codeblock`] parks the tree
/// here and the embedder frees it when its thread is idle. Answers whether anything was
/// freed. Anything never freed goes with the thread.
pub fn free_released_sources() -> bool {
    let released = RELEASED_SOURCES.with(|released_sources| {
        std::mem::take(&mut *released_sources.borrow_mut())
    });
    let freed = !released.is_empty();
    drop(released);
    freed
}

#[derive(Trace, Finalize)]
struct Inner {
    realm: Realm,
    // GGS-patch: behind a RefCell so the AST can be released once compiled — every
    // function the script creates keeps the script alive (its `ScriptOrModule`), and a
    // multi-megabyte bundle's AST is hundreds of megabytes nothing reads after codegen.
    #[unsafe_ignore_trace]
    source: std::cell::RefCell<boa_ast::Script>,
    // GGS-patch: a large script's AST is released through `free_released_sources` (see
    // there) instead of dropped inside `codeblock`.
    defer_release: bool,
    source_text: SourceText,
    codeblock: GcRefCell<Option<Gc<CodeBlock>>>,
    loaded_modules: GcRefCell<FxHashMap<JsString, Module>>,
    host_defined: HostDefined,
    path: Option<PathBuf>,
}

impl Script {
    /// Gets the realm of this script.
    #[must_use]
    pub fn realm(&self) -> &Realm {
        &self.inner.realm
    }

    /// Returns the [`ECMAScript specification`][spec] defined [`\[\[HostDefined\]\]`][`HostDefined`] field of the [`Module`].
    ///
    /// [spec]: https://tc39.es/ecma262/#script-record
    #[must_use]
    pub fn host_defined(&self) -> &HostDefined {
        &self.inner.host_defined
    }

    /// Gets the loaded modules of this script.
    pub(crate) fn loaded_modules(&self) -> &GcRefCell<FxHashMap<JsString, Module>> {
        &self.inner.loaded_modules
    }

    /// Abstract operation [`ParseScript ( sourceText, realm, hostDefined )`][spec].
    ///
    /// Parses the provided `src` as an ECMAScript script, returning an error if parsing fails.
    ///
    /// [spec]: https://tc39.es/ecma262/#sec-parse-script
    pub fn parse<R: ReadChar>(
        src: Source<'_, R>,
        realm: Option<Realm>,
        context: &mut Context,
    ) -> JsResult<Self> {
        Self::parse_inner(src, realm, false, context)
    }

    /// GGS-patch: [`Script::parse`] with every binding kept in its environment — no
    /// register locals (see `boa_ast::Script::analyze_scope_all_escaping` for the
    /// miscompile this avoids). ggs-node compiles CommonJS module wrappers this way.
    ///
    /// # Errors
    ///
    /// Will return an error if an error happens during parsing.
    pub fn parse_all_bindings_escaping<R: ReadChar>(
        src: Source<'_, R>,
        realm: Option<Realm>,
        context: &mut Context,
    ) -> JsResult<Self> {
        Self::parse_inner(src, realm, true, context)
    }

    fn parse_inner<R: ReadChar>(
        src: Source<'_, R>,
        realm: Option<Realm>,
        all_bindings_escaping: bool,
        context: &mut Context,
    ) -> JsResult<Self> {
        let path = src.path().map(Path::to_path_buf);
        let mut parser = Parser::new(src);
        if all_bindings_escaping {
            parser.set_all_bindings_escaping();
        }
        parser.set_identifier(context.next_parser_identifier());
        if context.is_strict() {
            parser.set_strict();
        }
        let scope = context.realm().scope().clone();
        // GGS-patch: phase timing behind GGS_PHASE_TRACE — the compile-side diagnosis of
        // slow big-bundle loads (see node_runtime's activation profiling).
        let ggs_parse_started = std::time::Instant::now();
        let (mut code, source) = parser.parse_script_with_source(&scope, context.interner_mut())?;
        if std::env::var_os("GGS_PHASE_TRACE").is_some() {
            eprintln!("[phase] parse_script_with_source {:?}", ggs_parse_started.elapsed());
        }
        if !context.optimizer_options().is_empty() {
            context.optimize_statement_list(code.statements_mut());
        }

        let defer_release = source.cur_linear_position().pos() > DEFERRED_RELEASE_THRESHOLD;
        let source_text = SourceText::new(source);

        Ok(Self {
            inner: Gc::new(Inner {
                realm: realm.unwrap_or_else(|| context.realm().clone()),
                source: std::cell::RefCell::new(code),
                defer_release,
                source_text,
                codeblock: GcRefCell::default(),
                loaded_modules: GcRefCell::default(),
                host_defined: HostDefined::default(),
                path,
            }),
        })
    }

    /// Compiles the codeblock of this script.
    ///
    /// This is a no-op if this has been called previously.
    pub fn codeblock(&self, context: &mut Context) -> JsResult<Gc<CodeBlock>> {
        let mut codeblock = self.inner.codeblock.borrow_mut();

        if let Some(codeblock) = &*codeblock {
            return Ok(codeblock.clone());
        }

        let mut annex_b_function_names = Vec::new();
        // GGS-patch: phase timing behind GGS_PHASE_TRACE (see Script::parse above).
        let ggs_compile_started = std::time::Instant::now();

        // GGS-patch: identifier strings memoized for this one compile (one interner).
        let memo = boa_ast::JsStringMemo::enter();
        let source = self.inner.source.borrow();
        global_declaration_instantiation_context(
            &mut annex_b_function_names,
            &source,
            self.inner.realm.scope(),
            context,
        )?;

        let spanned_source_text = SpannedSourceText::new_source_only(self.get_source());
        let mut compiler = ByteCompiler::new(
            js_string!("<main>"),
            source.strict(),
            false,
            self.inner.realm.scope().clone(),
            self.inner.realm.scope().clone(),
            false,
            false,
            context.interner_mut(),
            false,
            spanned_source_text,
            self.path().map(Path::to_owned).into(),
        );

        #[cfg(feature = "annex-b")]
        {
            compiler.annex_b_function_names = annex_b_function_names;
        }

        // TODO: move to `Script::evaluate` to make this operation infallible.
        compiler.global_declaration_instantiation(&source);
        compiler.compile_statement_list(source.statements(), true, false);

        let cb = Gc::new(compiler.finish());
        drop(memo);
        drop(source);
        // GGS-patch: the bytecode is all a script runs from now on (see `Inner::source`).
        let released = self.inner.source.take();
        if self.inner.defer_release && std::env::var_os("GGS_NO_DEFER").is_none() {
            RELEASED_SOURCES.with(|released_sources| released_sources.borrow_mut().push(released));
        } else {
            drop(released);
        }
        if std::env::var_os("GGS_PHASE_TRACE").is_some() {
            eprintln!("[phase] codeblock compile {:?}", ggs_compile_started.elapsed());
        }

        *codeblock = Some(cb.clone());

        Ok(cb)
    }

    /// Evaluates this script and returns its result.
    ///
    /// Note that this won't run any scheduled promise jobs; you need to call [`Context::run_jobs`]
    /// on the context or [`JobExecutor::run_jobs`] on the provided queue to run them.
    ///
    /// [`JobExecutor::run_jobs`]: crate::job::JobExecutor::run_jobs
    pub fn evaluate(&self, context: &mut Context) -> JsResult<JsValue> {
        // GGS-patch: script code runs in the realm's global environment (ScriptEvaluation),
        // never on top of whatever frame happens to be running. Upstream builds the frame
        // over the caller's environment stack, so a script evaluated from inside a native
        // call made by JS (ggs-node's nested `require`) ran its global-depth locators
        // against the caller's chain. Indirect eval's own discipline: pop to the global
        // environment for the run, restore the caller's stack after.
        let saved = context.vm.environments.pop_to_global();
        let result = match self.prepare_run(context) {
            Ok(()) => {
                let record = context.run();
                context.vm.pop_frame();
                record.consume()
            }
            Err(error) => Err(error),
        };
        context.vm.environments.truncate(0);
        context.vm.environments.extend(saved);
        result
    }

    /// Evaluates this script and returns its result, periodically yielding to the executor
    /// in order to avoid blocking the current thread.
    ///
    /// This uses an implementation defined amount of "clock cycles" that need to pass before
    /// execution is suspended. See [`Script::evaluate_async_with_budget`] if you want to also
    /// customize this parameter.
    #[allow(clippy::future_not_send)]
    pub async fn evaluate_async(&self, context: &mut Context) -> JsResult<JsValue> {
        self.evaluate_async_with_budget(context, 256).await
    }

    /// Evaluates this script and returns its result, yielding to the executor each time `budget`
    /// number of "clock cycles" pass.
    ///
    /// Note that "clock cycle" is in quotation marks because we can't determine exactly how many
    /// CPU clock cycles a VM instruction will take, but all instructions have a "cost" associated
    /// with them that depends on their individual complexity. We'd recommend benchmarking with
    /// different budget sizes in order to find the ideal yielding time for your application.
    #[allow(clippy::future_not_send)]
    pub async fn evaluate_async_with_budget(
        &self,
        context: &mut Context,
        budget: u32,
    ) -> JsResult<JsValue> {
        self.prepare_run(context)?;

        let record = context.run_async_with_budget(budget).await;

        context.vm.pop_frame();
        record.consume()
    }

    fn prepare_run(&self, context: &mut Context) -> JsResult<()> {
        let codeblock = self.codeblock(context)?;

        let env_fp = context.vm.environments.len() as u32;
        context.vm.push_frame_with_stack(
            CallFrame::new(
                codeblock,
                Some(ActiveRunnable::Script(self.clone())),
                context.vm.environments.clone(),
                self.inner.realm.clone(),
            )
            .with_env_fp(env_fp)
            .with_flags(CallFrameFlags::EXIT_EARLY),
            JsValue::undefined(),
            JsValue::null(),
        );

        // TODO: Here should be https://tc39.es/ecma262/#sec-globaldeclarationinstantiation

        self.realm().resize_global_env();

        Ok(())
    }

    pub(super) fn path(&self) -> Option<&Path> {
        self.inner.path.as_deref()
    }

    pub(super) fn get_source(&self) -> SourceText {
        self.inner.source_text.clone()
    }
}
