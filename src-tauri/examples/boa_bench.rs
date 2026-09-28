//! Local parse/compile benchmark for the ggs-node Boa fork (scratch, never committed).
//! `boa_bench <file.js> [parse|compile|lexer] [iterations]`
use boa_engine::{Context, Script, Source};
use std::time::Instant;

#[global_allocator]
static ALLOC: git_graph_studio_lib::node_runtime::alloc::GgsAlloc =
    git_graph_studio_lib::node_runtime::alloc::GgsAlloc;

fn main() {
    // Link the library (build.rs exports its napi_* symbols from every binary).
    if std::env::var_os("BOA_BENCH_NEVER").is_some() {
        git_graph_studio_lib::node_runtime::run();
    }
    if std::env::var_os("BOA_SIZES").is_some() {
        use boa_engine::ast::*;
        eprintln!("Expression {}", std::mem::size_of::<Expression>());
        eprintln!("Statement {}", std::mem::size_of::<Statement>());
        eprintln!(
            "StatementListItem {}",
            std::mem::size_of::<StatementListItem>()
        );
        eprintln!("Declaration {}", std::mem::size_of::<Declaration>());
        eprintln!(
            "PropertyAccess {}",
            std::mem::size_of::<expression::access::PropertyAccess>()
        );
        eprintln!("Call {}", std::mem::size_of::<expression::Call>());
        eprintln!(
            "FunctionExpression {}",
            std::mem::size_of::<function::FunctionExpression>()
        );
        eprintln!("If {}", std::mem::size_of::<statement::If>());
        eprintln!(
            "Token {}",
            std::mem::size_of::<boa_engine::parser::lexer::Token>()
        );
        eprintln!(
            "Identifier {}",
            std::mem::size_of::<expression::Identifier>()
        );
        eprintln!(
            "Literal {}",
            std::mem::size_of::<expression::literal::Literal>()
        );
        eprintln!(
            "RegExpLiteral {}",
            std::mem::size_of::<expression::RegExpLiteral>()
        );
        eprintln!(
            "ArrayLiteral {}",
            std::mem::size_of::<expression::literal::ArrayLiteral>()
        );
        eprintln!(
            "ObjectLiteral {}",
            std::mem::size_of::<expression::literal::ObjectLiteral>()
        );
        eprintln!("Spread {}", std::mem::size_of::<expression::Spread>());
        eprintln!(
            "FunctionExpression {}",
            std::mem::size_of::<function::FunctionExpression>()
        );
        eprintln!(
            "ArrowFunction {}",
            std::mem::size_of::<function::ArrowFunction>()
        );
        eprintln!(
            "AsyncArrowFunction {}",
            std::mem::size_of::<function::AsyncArrowFunction>()
        );
        eprintln!(
            "GeneratorExpression {}",
            std::mem::size_of::<function::GeneratorExpression>()
        );
        eprintln!(
            "AsyncFunctionExpression {}",
            std::mem::size_of::<function::AsyncFunctionExpression>()
        );
        eprintln!(
            "AsyncGeneratorExpression {}",
            std::mem::size_of::<function::AsyncGeneratorExpression>()
        );
        eprintln!(
            "TemplateLiteral {}",
            std::mem::size_of::<expression::literal::TemplateLiteral>()
        );
        eprintln!("New {}", std::mem::size_of::<expression::New>());
        eprintln!("SuperCall {}", std::mem::size_of::<expression::SuperCall>());
        eprintln!(
            "ImportCall {}",
            std::mem::size_of::<expression::ImportCall>()
        );
        eprintln!("Optional {}", std::mem::size_of::<expression::Optional>());
        eprintln!(
            "TaggedTemplate {}",
            std::mem::size_of::<expression::TaggedTemplate>()
        );
        eprintln!(
            "Assign {}",
            std::mem::size_of::<expression::operator::Assign>()
        );
        eprintln!(
            "Unary {}",
            std::mem::size_of::<expression::operator::Unary>()
        );
        eprintln!(
            "Update {}",
            std::mem::size_of::<expression::operator::Update>()
        );
        eprintln!(
            "Binary {}",
            std::mem::size_of::<expression::operator::Binary>()
        );
        eprintln!(
            "BinaryInPrivate {}",
            std::mem::size_of::<expression::operator::BinaryInPrivate>()
        );
        eprintln!(
            "Conditional {}",
            std::mem::size_of::<expression::operator::Conditional>()
        );
        eprintln!("Await {}", std::mem::size_of::<expression::Await>());
        eprintln!("Yield {}", std::mem::size_of::<expression::Yield>());
        eprintln!(
            "Parenthesized {}",
            std::mem::size_of::<expression::Parenthesized>()
        );
        eprintln!(
            "FormalParameterList {}",
            std::mem::size_of::<function::FormalParameterList>()
        );
        eprintln!("Block {}", std::mem::size_of::<statement::Block>());
        eprintln!(
            "VarDeclaration {}",
            std::mem::size_of::<declaration::VarDeclaration>()
        );
        eprintln!(
            "DoWhileLoop {}",
            std::mem::size_of::<statement::iteration::DoWhileLoop>()
        );
        eprintln!(
            "WhileLoop {}",
            std::mem::size_of::<statement::iteration::WhileLoop>()
        );
        eprintln!(
            "ForLoop {}",
            std::mem::size_of::<statement::iteration::ForLoop>()
        );
        eprintln!(
            "ForInLoop {}",
            std::mem::size_of::<statement::iteration::ForInLoop>()
        );
        eprintln!(
            "ForOfLoop {}",
            std::mem::size_of::<statement::iteration::ForOfLoop>()
        );
        eprintln!("Switch {}", std::mem::size_of::<statement::Switch>());
        eprintln!(
            "Continue {}",
            std::mem::size_of::<statement::iteration::Continue>()
        );
        eprintln!(
            "Break {}",
            std::mem::size_of::<statement::iteration::Break>()
        );
        eprintln!("Return {}", std::mem::size_of::<statement::Return>());
        eprintln!("Labelled {}", std::mem::size_of::<statement::Labelled>());
        eprintln!("Throw {}", std::mem::size_of::<statement::Throw>());
        eprintln!("Try {}", std::mem::size_of::<statement::Try>());
        eprintln!("With {}", std::mem::size_of::<statement::With>());

        return;
    }
    if let Ok(path) = std::env::var("BOA_RUN") {
        run_both(&path);
        return;
    }
    if std::env::var_os("BENCH_NO_CACHE").is_none() {
        git_graph_studio_lib::node_runtime::alloc::enable_thread_cache();
    }
    let mut args = std::env::args().skip(1);
    let path = args.next().expect("a JS file");
    let mode = args.next().unwrap_or_else(|| "parse".into());
    let iters: usize = args.next().map(|s| s.parse().unwrap()).unwrap_or(5);
    let src = std::fs::read_to_string(&path).unwrap();
    let wrapped =
        format!("(function (exports, require, module, __filename, __dirname) {{\n{src}\n}})");
    for i in 0..iters {
        if mode == "read" {
            // The raw ReadChar layer over the whole input: the floor any lexer work adds to.
            use boa_engine::parser::source::{ReadChar, UTF8Input};
            let t = Instant::now();
            let mut reader = UTF8Input::from_slice(wrapped.as_bytes());
            let mut code_units = 0usize;
            while reader.next_char().unwrap().is_some() {
                code_units += 1;
            }
            eprintln!(
                "[bench] iter {i}: read-only {code_units} chars {:?}",
                t.elapsed()
            );
            continue;
        }
        if mode == "lexer" {
            use boa_engine::interner::Interner;
            let t = Instant::now();
            let mut lexer = boa_engine::parser::Lexer::from(wrapped.as_bytes());
            let mut interner = Interner::default();
            let mut tokens = 0usize;
            while lexer.next(&mut interner).unwrap().is_some() {
                tokens += 1;
            }
            eprintln!(
                "[bench] iter {i}: lexer-only {tokens} tokens {:?}",
                t.elapsed()
            );
            continue;
        }
        let mut context = Context::default();
        context.set_optimizer_options(boa_engine::optimizer::OptimizerOptions::empty());
        let t = Instant::now();
        let script = Script::parse_all_bindings_escaping(
            Source::from_bytes(wrapped.as_bytes()),
            None,
            &mut context,
        )
        .unwrap();
        let parsed = t.elapsed();
        if mode == "compile" {
            script.codeblock(&mut context).unwrap();
        }
        let total = t.elapsed();
        drop(script);
        let dropped = t.elapsed();
        eprintln!(
            "[bench] iter {i}: parse+analyze {parsed:?}, +compile {total:?}, +drop {dropped:?}"
        );
    }
    eprintln!("[bench] done");
    if std::env::var_os("BENCH_HOLD").is_some() {
        std::thread::sleep(std::time::Duration::from_secs(20));
    }
}

/// `BOA_RUN=<file.js> boa_bench x`: evaluate a file in both scope-analysis modes.
#[allow(dead_code)]
pub fn run_both(path: &str) {
    let src = std::fs::read_to_string(path).unwrap();
    for escaping in [false, true] {
        let mut context = Context::default();
        let parsed = if escaping {
            Script::parse_all_bindings_escaping(
                Source::from_bytes(src.as_bytes()),
                None,
                &mut context,
            )
        } else {
            Script::parse(Source::from_bytes(src.as_bytes()), None, &mut context)
        };
        let result = parsed.and_then(|s| s.evaluate(&mut context));
        match result {
            Ok(v) => eprintln!("[run] escaping={escaping}: ok {}", v.display()),
            Err(e) => eprintln!("[run] escaping={escaping}: ERR {e}"),
        }
    }
}
