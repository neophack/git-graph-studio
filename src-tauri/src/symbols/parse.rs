//! The tree-sitter parser layer (plan M4.1): the structured extraction behind the symbol
//! index and the whole Code Analysis module. Where the viewer's outline scan (viewer/outline)
//! sees line prefixes, this layer sees the syntax tree — so a declaration carries its column,
//! its range, the class or impl it sits in, its visibility, its parameter count and its
//! cyclomatic complexity, and a file additionally yields its call sites and imports. Each
//! grammar is a Cargo feature (plan §3.1's single sanctioned exception to the pure-Rust
//! rule); a language whose feature is off falls back to the outline scan, which stays the
//! extractor for everything the grammars do not cover.

use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::OnceLock;

use tree_sitter::{Language, Parser, Query, QueryCursor, StreamingIterator, Tree};

/// One declaration as the syntax tree shows it. Everything the analysis layer needs; the
/// persistent store keeps the subset it can afford on disk.
#[derive(Clone, Debug, PartialEq)]
pub struct ParsedSymbol {
    pub kind: &'static str,
    pub name: String,
    /// 0-based line and byte column of the name.
    pub line: usize,
    pub column: usize,
    /// 0-based line the whole declaration ends on.
    pub end_line: usize,
    /// The enclosing type: the impl/trait for a Rust method, the class for a Python or C#
    /// method, the receiver type for Go, the `Class::` prefix of an out-of-line C++ method.
    pub container: Option<String>,
    /// Whether the declaration is reachable from outside its file: `pub` (Rust), an upper
    /// case Go name, an `export` (JS/TS), a non-underscore Python name, `public` (Java/C#),
    /// non-`static` (C/C++). The dead-code report treats the rest as candidates.
    pub exported: bool,
    pub params: usize,
    /// Decision points + 1: the cyclomatic complexity of the declaration's body.
    pub complexity: u32,
    /// How deeply control structures nest inside the body.
    pub nesting: u32,
    /// The declaration's first line, capped — what a call graph node shows on hover.
    pub signature: String,
}

/// One call expression: the callee's spelling and, when the grammar names an object, the
/// receiver expression's last identifier (`self.ctx.load()` → receiver `ctx`).
#[derive(Clone, Debug, PartialEq)]
pub struct CallSite {
    pub name: String,
    pub receiver: Option<String>,
    pub line: usize,
    pub column: usize,
}

/// A file's full analysis extraction. The symbol store consumes `symbols`; the analysis
/// engine consumes all three.
#[derive(Default, Clone, Debug)]
pub struct ParsedFile {
    pub symbols: Vec<ParsedSymbol>,
    pub calls: Vec<CallSite>,
    pub imports: Vec<String>,
}

/// A pathological file cannot stall the pipeline: the extractions stop at these caps.
const MAX_SYMBOLS: usize = 20_000;
const MAX_CALLS: usize = 100_000;

/* ---------- The languages ---------- */

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
enum Lang {
    Rust,
    Python,
    Go,
    JavaScript,
    TypeScript,
    Java,
    C,
    Cpp,
    CSharp,
}

fn lang_of(ext: &str) -> Option<Lang> {
    Some(match ext {
        "rs" => Lang::Rust,
        "py" => Lang::Python,
        "go" => Lang::Go,
        "js" | "jsx" => Lang::JavaScript,
        "ts" | "tsx" => Lang::TypeScript,
        "java" => Lang::Java,
        "c" | "h" => Lang::C,
        "cpp" | "hpp" => Lang::Cpp,
        "cs" => Lang::CSharp,
        _ => return None,
    })
}

/// The grammar of a language, when its feature is compiled in.
fn language(lang: Lang) -> Option<Language> {
    #[cfg(feature = "grammar-rust")]
    if lang == Lang::Rust {
        return Some(tree_sitter_rust::LANGUAGE.into());
    }
    #[cfg(feature = "grammar-python")]
    if lang == Lang::Python {
        return Some(tree_sitter_python::LANGUAGE.into());
    }
    #[cfg(feature = "grammar-go")]
    if lang == Lang::Go {
        return Some(tree_sitter_go::LANGUAGE.into());
    }
    #[cfg(feature = "grammar-javascript")]
    if lang == Lang::JavaScript {
        return Some(tree_sitter_javascript::LANGUAGE.into());
    }
    #[cfg(feature = "grammar-typescript")]
    if lang == Lang::TypeScript {
        return Some(tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into());
    }
    #[cfg(feature = "grammar-java")]
    if lang == Lang::Java {
        return Some(tree_sitter_java::LANGUAGE.into());
    }
    #[cfg(feature = "grammar-c")]
    if lang == Lang::C {
        return Some(tree_sitter_c::LANGUAGE.into());
    }
    #[cfg(feature = "grammar-cpp")]
    if lang == Lang::Cpp {
        return Some(tree_sitter_cpp::LANGUAGE.into());
    }
    #[cfg(feature = "grammar-c-sharp")]
    if lang == Lang::CSharp {
        return Some(tree_sitter_c_sharp::LANGUAGE.into());
    }
    #[allow(unreachable_patterns)]
    None
}

/// Whether `ext` parses with a compiled-in grammar (the outline fallback serves the rest).
pub fn supports(ext: &str) -> bool {
    lang_of(ext).is_some_and(|lang| language(lang).is_some())
}

/* ---------- The per-language queries ---------- */

const RUST_QUERY: &str = r#"
(function_item name: (identifier) @def.function)
(struct_item name: (type_identifier) @def.struct)
(enum_item name: (type_identifier) @def.enum)
(trait_item name: (type_identifier) @def.interface)
(mod_item name: (identifier) @def.module)
(type_item name: (type_identifier) @def.type)
(macro_definition name: (identifier) @def.macro)
(union_item name: (type_identifier) @def.struct)
(call_expression function: (identifier) @call)
(call_expression function: (field_expression field: (field_identifier) @call))
(call_expression function: (scoped_identifier name: (identifier) @call))
(macro_invocation macro: (identifier) @call)
(use_declaration) @import
"#;

const PYTHON_QUERY: &str = r#"
(function_definition name: (identifier) @def.function)
(class_definition name: (identifier) @def.class)
(call function: (identifier) @call)
(call function: (attribute attribute: (identifier) @call))
(import_statement (dotted_name) @import)
(import_from_statement module_name: (dotted_name) @import)
(import_from_statement module_name: (relative_import) @import)
"#;

const GO_QUERY: &str = r#"
(function_declaration name: (identifier) @def.function)
(method_declaration name: (field_identifier) @def.method)
(type_declaration (type_spec name: (type_identifier) @def.type))
(call_expression function: (identifier) @call)
(call_expression function: (selector_expression field: (field_identifier) @call))
(import_spec path: (interpreted_string_literal) @import)
"#;

const JAVASCRIPT_QUERY: &str = r#"
(function_declaration name: (identifier) @def.function)
(generator_function_declaration name: (identifier) @def.function)
(class_declaration name: (identifier) @def.class)
(method_definition name: (property_identifier) @def.method)
(lexical_declaration (variable_declarator name: (identifier) @def.function value: [(arrow_function) (function_expression)]))
(import_statement source: (string) @import)
(export_statement source: (string) @import)
(call_expression function: (identifier) @call)
(call_expression function: (member_expression property: (property_identifier) @call))
(call_expression function: (identifier) @call arguments: (arguments (string) @import.req))
(new_expression constructor: (identifier) @call.new)
"#;

/// TypeScript and TSX share one grammar shape (both name classes with a type_identifier).
const TYPESCRIPT_QUERY: &str = r#"
(function_declaration name: (identifier) @def.function)
(generator_function_declaration name: (identifier) @def.function)
(class_declaration name: (type_identifier) @def.class)
(abstract_class_declaration name: (type_identifier) @def.class)
(interface_declaration name: (type_identifier) @def.interface)
(enum_declaration name: (identifier) @def.enum)
(type_alias_declaration name: (type_identifier) @def.type)
(method_definition name: (property_identifier) @def.method)
(lexical_declaration (variable_declarator name: (identifier) @def.function value: [(arrow_function) (function_expression)]))
(import_statement source: (string) @import)
(export_statement source: (string) @import)
(call_expression function: (identifier) @call)
(call_expression function: (member_expression property: (property_identifier) @call))
(call_expression function: (identifier) @call arguments: (arguments (string) @import.req))
(new_expression constructor: (identifier) @call.new)
"#;

const JAVA_QUERY: &str = r#"
(class_declaration name: (identifier) @def.class)
(interface_declaration name: (identifier) @def.interface)
(enum_declaration name: (identifier) @def.enum)
(record_declaration name: (identifier) @def.class)
(method_declaration name: (identifier) @def.method)
(constructor_declaration name: (identifier) @def.method)
(method_invocation name: (identifier) @call)
(object_creation_expression type: (type_identifier) @call.new)
(import_declaration (scoped_identifier) @import)
"#;

const C_QUERY: &str = r#"
(function_definition declarator: (function_declarator declarator: (identifier) @def.function))
(function_definition declarator: (pointer_declarator declarator: (function_declarator declarator: (identifier) @def.function)))
(struct_specifier name: (type_identifier) @def.struct)
(enum_specifier name: (type_identifier) @def.enum)
(type_definition declarator: (type_identifier) @def.type)
(call_expression function: (identifier) @call)
(preproc_include path: (string_literal) @import)
"#;

const CPP_QUERY: &str = r#"
(function_definition declarator: (function_declarator declarator: (identifier) @def.function))
(function_definition declarator: (pointer_declarator declarator: (function_declarator declarator: (identifier) @def.function)))
(function_definition declarator: (function_declarator declarator: (field_identifier) @def.method))
(function_definition declarator: (pointer_declarator declarator: (function_declarator declarator: (field_identifier) @def.method)))
(function_definition declarator: (function_declarator declarator: (qualified_identifier) @def.method))
(function_definition declarator: (pointer_declarator declarator: (function_declarator declarator: (qualified_identifier) @def.method)))
(struct_specifier name: (type_identifier) @def.struct)
(class_specifier name: (type_identifier) @def.class)
(enum_specifier name: (type_identifier) @def.enum)
(type_definition declarator: (type_identifier) @def.type)
(call_expression function: (identifier) @call)
(call_expression function: (field_expression field: (field_identifier) @call))
(call_expression function: (qualified_identifier) @call)
(preproc_include path: (string_literal) @import)
"#;

const CSHARP_QUERY: &str = r#"
(class_declaration name: (identifier) @def.class)
(struct_declaration name: (identifier) @def.struct)
(interface_declaration name: (identifier) @def.interface)
(enum_declaration name: (identifier) @def.enum)
(record_declaration name: (identifier) @def.class)
(namespace_declaration name: (identifier) @def.module)
(method_declaration name: (identifier) @def.method)
(constructor_declaration name: (identifier) @def.method)
(invocation_expression function: (identifier) @call)
(invocation_expression function: (member_access_expression name: (identifier) @call))
(object_creation_expression type: (identifier) @call.new)
(using_directive) @import
"#;

fn query_text(lang: Lang) -> &'static str {
    match lang {
        Lang::Rust => RUST_QUERY,
        Lang::Python => PYTHON_QUERY,
        Lang::Go => GO_QUERY,
        Lang::JavaScript => JAVASCRIPT_QUERY,
        Lang::TypeScript => TYPESCRIPT_QUERY,
        Lang::Java => JAVA_QUERY,
        Lang::C => C_QUERY,
        Lang::Cpp => CPP_QUERY,
        Lang::CSharp => CSHARP_QUERY,
    }
}

fn query(lang: Lang) -> Option<&'static Query> {
    static QUERIES: OnceLock<HashMap<Lang, Query>> = OnceLock::new();
    let queries = QUERIES.get_or_init(|| {
        let mut map = HashMap::new();
        for lang in [
            Lang::Rust,
            Lang::Python,
            Lang::Go,
            Lang::JavaScript,
            Lang::TypeScript,
            Lang::Java,
            Lang::C,
            Lang::Cpp,
            Lang::CSharp,
        ] {
            if let Some(language) = language(lang) {
                match Query::new(&language, query_text(lang)) {
                    // An embedded query that does not compile is a programming error caught
                    // by this module's tests; the panic keeps it loud instead of silently
                    // emptying a language's extraction.
                    Ok(query) => {
                        map.insert(lang, query);
                    }
                    Err(error) => panic!("the {lang:?} query does not compile: {error:?}"),
                }
            }
        }
        map
    });
    queries.get(&lang)
}

/* ---------- Parsers and the entry points ---------- */

thread_local! {
    /// One parser per language per rayon worker (a parser holds grammar state; sharing it
    /// across threads is neither possible nor wanted).
    static PARSERS: RefCell<HashMap<Lang, Parser>> = RefCell::new(HashMap::new());
}

fn parse_tree(lang: Lang, text: &str) -> Option<Tree> {
    let language = language(lang)?;
    PARSERS.with(|parsers| {
        let mut parsers = parsers.borrow_mut();
        let parser = parsers.entry(lang).or_insert_with(|| {
            let mut parser = Parser::new();
            if parser.set_language(&language).is_err() {
                // A grammar/core ABI mismatch cannot be repaired at runtime; the empty
                // parser below yields no tree and the caller falls back.
                parser = Parser::new();
            }
            parser
        });
        parser.parse(text, None)
    })
}

/// The declarations of a file — what the symbol store indexes. Languages without a compiled
/// grammar fall back to the viewer's outline scan, with the ranges a prefix scan cannot know.
pub fn parse_symbols(text: &str, ext: &str) -> Vec<ParsedSymbol> {
    parse_file(text, ext).symbols
}

/// The declarations, call sites and imports of a file — the Code Analysis engine's input.
pub fn parse_file(text: &str, ext: &str) -> ParsedFile {
    let Some(lang) = lang_of(ext) else {
        return ParsedFile {
            symbols: outline_fallback(text, ext),
            calls: Vec::new(),
            imports: Vec::new(),
        };
    };
    if language(lang).is_none() {
        return ParsedFile {
            symbols: outline_fallback(text, ext),
            calls: Vec::new(),
            imports: Vec::new(),
        };
    }
    let Some(tree) = parse_tree(lang, text) else {
        return ParsedFile::default();
    };
    let Some(query) = query(lang) else {
        return ParsedFile::default();
    };
    let mut out = ParsedFile::default();
    let mut cursor = QueryCursor::new();
    let mut matches = cursor.matches(query, tree.root_node(), text.as_bytes());
    while let Some(match_) = matches.next() {
        // One match carries one def capture, or a call (with an optional require source);
        // imports are their own patterns. Copy positions out before `next()` lends the
        // match again.
        let mut call: Option<(String, Option<String>, usize, usize)> = None;
        let mut require_source: Option<String> = None;
        for cap in match_.captures {
            let node = cap.node;
            let capture = query.capture_names()[cap.index as usize];
            let text_of = |node: tree_sitter::Node| &text[node.byte_range()];
            if let Some(kind) = capture.strip_prefix("def.") {
                if out.symbols.len() < MAX_SYMBOLS {
                    out.symbols.push(symbol_of(lang, kind, node, text));
                }
            } else if capture == "call" || capture == "call.new" {
                let mut name = text_of(node).to_owned();
                let mut receiver = call_receiver(lang, node, text);
                // A C++ qualified call spells `A::f()`; the qualifier is the receiver.
                if lang == Lang::Cpp {
                    let split = name
                        .split_once("::")
                        .map(|(q, t)| (q.to_owned(), t.to_owned()));
                    if let Some((qualifier, tail)) = split {
                        name = tail;
                        receiver = Some(qualifier);
                    }
                }
                call = Some((
                    name,
                    receiver,
                    node.start_position().row,
                    node.start_position().column,
                ));
            } else if capture == "import" {
                out.imports.push(import_of(lang, node, text));
            } else if capture == "import.req" {
                require_source = Some(unquote(text_of(node)));
            }
        }
        if let Some((name, receiver, line, column)) = call {
            // `require('x')` is an import, not a call edge.
            if require_source.is_some() && name == "require" {
                if let Some(source) = require_source {
                    out.imports.push(source);
                }
                continue;
            }
            if out.calls.len() < MAX_CALLS {
                out.calls.push(CallSite {
                    name,
                    receiver,
                    line,
                    column,
                });
            }
        }
    }
    out
}

/// The outline scan dressed as parsed symbols — the fallback for a language whose grammar
/// feature is off.
fn outline_fallback(text: &str, ext: &str) -> Vec<ParsedSymbol> {
    crate::viewer::outline_symbols_for(text, ext)
        .into_iter()
        .map(|s| ParsedSymbol {
            kind: match s.kind.as_str() {
                "function" => "function",
                "method" => "method",
                "class" => "class",
                "struct" => "struct",
                "interface" => "interface",
                "enum" => "enum",
                "module" => "module",
                _ => "type",
            },
            name: s.name,
            line: s.line,
            column: 0,
            end_line: s.line,
            container: None,
            exported: true,
            params: 0,
            complexity: 1,
            nesting: 0,
            signature: String::new(),
        })
        .collect()
}

/* ---------- Per-language post-processing ---------- */

fn text_last_segment(text: &str) -> String {
    text.split(|c: char| !(c.is_alphanumeric() || c == '_'))
        .rfind(|s| !s.is_empty())
        .unwrap_or("")
        .to_owned()
}

/// The declaration a captured name node belongs to, its kind normalised, its container,
/// visibility and shape read off the tree around it.
fn symbol_of(
    lang: Lang,
    capture_kind: &'static str,
    name_node: tree_sitter::Node,
    text: &str,
) -> ParsedSymbol {
    let decl = name_node.parent();
    // C/C++ names sit inside declarator chains (`function_definition declarator:
    // (pointer_declarator declarator: (function_declarator declarator: name))`); the body,
    // the `static` and the end of the declaration live on the enclosing function_definition.
    let scope = if matches!(lang, Lang::C | Lang::Cpp) {
        let mut node = decl;
        while let Some(current) = node {
            if current.kind().ends_with("declarator") {
                node = current.parent();
            } else {
                break;
            }
        }
        node.or(decl)
    } else {
        decl
    };
    let raw_name = &text[name_node.byte_range()];
    // A C++ out-of-line definition spells `Class::method`; the container is in the name.
    let (name, name_container) = if raw_name.contains("::") && matches!(lang, Lang::Cpp) {
        let head = raw_name
            .split("::")
            .find(|p| !p.is_empty())
            .unwrap_or(raw_name);
        let tail = raw_name
            .rsplit("::")
            .find(|p| !p.is_empty())
            .unwrap_or(raw_name);
        (tail.to_owned(), Some(head.to_owned()))
    } else {
        (raw_name.to_owned(), None)
    };
    let container = name_container
        .or_else(|| container_of(lang, scope, text))
        .filter(|c| !c.is_empty());
    let kind = match lang {
        Lang::Go if capture_kind == "type" => {
            // Go's `type X …` is struct/interface/type by its right-hand side.
            let type_kind = decl
                .and_then(|d| d.child_by_field_name("type"))
                .map(|t| t.kind())
                .unwrap_or("");
            match type_kind {
                "struct_type" => "struct",
                "interface_type" => "interface",
                _ => "type",
            }
        }
        // A Rust or Python function with a container is a method — the grammars have no
        // separate node for it.
        Lang::Rust | Lang::Python if capture_kind == "function" && container.is_some() => "method",
        _ => capture_kind,
    };
    let (line, column) = {
        let p = name_node.start_position();
        (p.row, p.column)
    };
    let end_line = scope.map(|d| d.end_position().row).unwrap_or(line);
    let params = decl
        .and_then(|d| d.child_by_field_name("parameters"))
        .map(|p| p.named_child_count())
        .unwrap_or(0);
    let (complexity, nesting) = scope
        .map(|d| complexity_of(lang, d, text))
        .unwrap_or((1, 0));
    let signature = scope
        .map(|d| {
            let full = &text[d.byte_range()];
            let head = full.split('\n').next().unwrap_or(full);
            head.chars().take(120).collect::<String>().trim().to_owned()
        })
        .unwrap_or_default();
    let exported = exported_of(lang, scope, &name, text);
    ParsedSymbol {
        kind,
        name,
        line,
        column,
        end_line,
        container,
        exported,
        params,
        complexity,
        nesting,
        signature,
    }
}

/// Walk up from a declaration to the type that contains it. A Go method's container is its
/// own receiver, so the declaration node itself is checked before walking.
fn container_of(lang: Lang, decl: Option<tree_sitter::Node>, text: &str) -> Option<String> {
    let mut node = decl?;
    let mut started = false;
    loop {
        let container = match (lang, node.kind()) {
            (Lang::Rust, "impl_item") => node
                .child_by_field_name("type")
                .map(|t| text[t.byte_range()].to_owned())
                .map(|t| t.rsplit("::").next().unwrap_or(&t).to_owned()),
            (Lang::Rust, "trait_item")
            | (Lang::Python, "class_definition")
            | (Lang::JavaScript, "class_declaration")
            | (Lang::JavaScript, "abstract_class_declaration")
            | (Lang::JavaScript, "class_expression")
            | (Lang::TypeScript, "class_declaration")
            | (Lang::TypeScript, "abstract_class_declaration")
            | (Lang::TypeScript, "class_expression")
            | (Lang::Java, "class_declaration")
            | (Lang::Java, "interface_declaration")
            | (Lang::Java, "enum_declaration")
            | (Lang::Java, "record_declaration")
            | (Lang::Cpp, "class_specifier")
            | (Lang::CSharp, "class_declaration")
            | (Lang::CSharp, "struct_declaration")
            | (Lang::CSharp, "interface_declaration")
            | (Lang::CSharp, "record_declaration") => node
                .child_by_field_name("name")
                .map(|n| text[n.byte_range()].to_owned()),
            (Lang::Go, "method_declaration") if !started => node
                .child_by_field_name("receiver")
                .map(|r| text[r.byte_range()].to_owned())
                .map(|r| text_last_segment(&r)),
            _ => None,
        };
        if container.is_some() {
            return container;
        }
        started = true;
        node = node.parent()?;
    }
}

fn exported_of(lang: Lang, decl: Option<tree_sitter::Node>, name: &str, text: &str) -> bool {
    let Some(decl) = decl else {
        return true;
    };
    match lang {
        // `pub` is the declaration's first child when present (the grammar gives it no
        // field name).
        Lang::Rust => decl
            .child(0)
            .is_some_and(|first| first.kind() == "visibility_modifier"),
        Lang::Go => name.chars().next().is_some_and(char::is_uppercase),
        Lang::Python => !name.starts_with('_'),
        Lang::JavaScript | Lang::TypeScript => {
            let parent = decl.parent();
            parent.is_some_and(|p| p.kind() == "export_statement")
                || parent
                    .and_then(|p| p.parent())
                    .is_some_and(|p| p.kind() == "export_statement")
        }
        Lang::Java | Lang::CSharp => decl.child(0).is_some_and(|first| {
            first.kind() == "modifiers" && text[first.byte_range()].contains("public")
        }),
        Lang::C | Lang::Cpp => !text[decl.byte_range()].trim_start().starts_with("static"),
    }
}

/// The receiver of a call, read off the callee's parent expression: `self.svc.load()` and
/// `client.send(m)` and `fmt.Println(x)` all yield the object spelling nearest the callee
/// (its last identifier — `self.ctx.load()` reports `ctx`).
fn call_receiver(lang: Lang, name_node: tree_sitter::Node, text: &str) -> Option<String> {
    let parent = name_node.parent()?;
    let object_field = match (lang, parent.kind()) {
        (Lang::Rust, "field_expression") => "value",
        (Lang::Rust, "scoped_identifier") => "path",
        (Lang::Cpp, "field_expression") => "argument",
        (_, "attribute") => "object",                    // Python
        (_, "selector_expression") => "operand",         // Go
        (_, "member_expression") => "object",            // JavaScript / TypeScript
        (_, "method_invocation") => "object",            // Java
        (_, "member_access_expression") => "expression", // C#
        _ => return None,
    };
    parent
        .child_by_field_name(object_field)
        .map(|object| text_last_segment(&text[object.byte_range()]))
        .filter(|receiver| !receiver.is_empty())
}

/// Count the decision points and the deepest control nesting of a declaration's body: the
/// cyclomatic ingredients of the Complexity report.
fn complexity_of(lang: Lang, decl: tree_sitter::Node, text: &str) -> (u32, u32) {
    let mut decisions = 0u32;
    let mut max_nesting = 0u32;
    let mut cursor = decl.walk();
    let mut depth = 0u32;
    loop {
        let node = cursor.node();
        let kind = node.kind();
        if is_control(lang, kind) {
            decisions += 1;
            depth += 1;
            max_nesting = max_nesting.max(depth);
        } else if is_decision(lang, kind) {
            decisions += 1;
        } else if matches!(
            kind,
            "binary_expression"
                | "boolean_operator"
                | "conditional_expression"
                | "ternary_expression"
                | "conditional_expression_statement"
        ) {
            // A short-circuiting or conditional operator adds a path; the plain arithmetic
            // ones do not.
            let operator = node
                .child_by_field_name("operator")
                .map(|op| &text[op.byte_range()])
                .unwrap_or("");
            if matches!(operator, "&&" | "||" | "and" | "or" | "??" | "?")
                || kind == "conditional_expression"
                || kind == "ternary_expression"
            {
                decisions += 1;
            }
        }
        // Do not descend into nested declarations: a method's complexity is its own. The
        // root declaration itself is always entered (it is the walk's starting point, not
        // a nested one).
        let descend = node.id() == decl.id() || !is_nested_decl(lang, kind);
        if descend && cursor.goto_first_child() {
            continue;
        }
        loop {
            if cursor.goto_next_sibling() {
                break;
            }
            if !cursor.goto_parent() {
                return (decisions + 1, max_nesting);
            }
            if is_control(lang, cursor.node().kind()) {
                depth = depth.saturating_sub(1);
            }
        }
    }
}

fn is_control(lang: Lang, kind: &str) -> bool {
    match lang {
        Lang::Rust => matches!(
            kind,
            "if_expression"
                | "while_expression"
                | "while_let_expression"
                | "for_expression"
                | "loop_expression"
                | "infinite_loop_expression"
        ),
        Lang::Python => matches!(
            kind,
            "if_statement"
                | "while_statement"
                | "for_statement"
                | "try_statement"
                | "match_statement"
        ),
        Lang::Go => matches!(
            kind,
            "if_statement"
                | "for_statement"
                | "expression_switch_statement"
                | "type_switch_statement"
                | "select_statement"
        ),
        Lang::JavaScript | Lang::TypeScript => matches!(
            kind,
            "if_statement"
                | "for_statement"
                | "for_in_statement"
                | "while_statement"
                | "do_statement"
                | "switch_statement"
                | "try_statement"
        ),
        Lang::Java => matches!(
            kind,
            "if_statement"
                | "while_statement"
                | "do_statement"
                | "for_statement"
                | "enhanced_for_statement"
                | "switch_expression"
                | "switch_statement"
                | "try_statement"
        ),
        Lang::C => matches!(
            kind,
            "if_statement"
                | "while_statement"
                | "do_statement"
                | "for_statement"
                | "switch_statement"
        ),
        Lang::Cpp => matches!(
            kind,
            "if_statement"
                | "while_statement"
                | "do_statement"
                | "for_statement"
                | "for_range_loop"
                | "switch_statement"
                | "try_statement"
        ),
        Lang::CSharp => matches!(
            kind,
            "if_statement"
                | "while_statement"
                | "do_statement"
                | "for_statement"
                | "for_each_statement"
                | "switch_statement"
                | "switch_expression"
                | "try_statement"
        ),
    }
}

/// Decision points that are not themselves control structures.
fn is_decision(lang: Lang, kind: &str) -> bool {
    match lang {
        Lang::Rust => matches!(kind, "match_arm" | "catch_clause"),
        Lang::Python => matches!(
            kind,
            "elif_clause" | "except_clause" | "if_clause" | "case_clause"
        ),
        Lang::Go => matches!(
            kind,
            "expression_case" | "type_case" | "comm_clause" | "default_case"
        ),
        Lang::JavaScript | Lang::TypeScript => matches!(kind, "case_clause" | "catch_clause"),
        Lang::Java => matches!(
            kind,
            "switch_block_statement_group" | "switch_rule" | "catch_clause"
        ),
        Lang::C => matches!(kind, "case" | "case_clause" | "labeled_statement"),
        Lang::Cpp => matches!(kind, "case_clause" | "catch_clause"),
        Lang::CSharp => matches!(
            kind,
            "switch_section" | "switch_expression_arm" | "catch_clause" | "when_clause"
        ),
    }
}

fn is_nested_decl(lang: Lang, kind: &str) -> bool {
    match lang {
        Lang::Rust => matches!(
            kind,
            "function_item"
                | "struct_item"
                | "enum_item"
                | "trait_item"
                | "mod_item"
                | "type_item"
                | "macro_definition"
        ),
        Lang::Python => matches!(kind, "function_definition" | "class_definition"),
        Lang::Go => matches!(
            kind,
            "function_declaration" | "method_declaration" | "type_declaration"
        ),
        Lang::JavaScript | Lang::TypeScript => matches!(
            kind,
            "function_declaration"
                | "generator_function_declaration"
                | "class_declaration"
                | "abstract_class_declaration"
                | "method_definition"
                | "lexical_declaration"
                | "class_expression"
        ),
        Lang::Java => matches!(
            kind,
            "method_declaration"
                | "constructor_declaration"
                | "class_declaration"
                | "interface_declaration"
                | "enum_declaration"
                | "record_declaration"
        ),
        Lang::C => matches!(
            kind,
            "function_definition" | "struct_specifier" | "enum_specifier" | "type_definition"
        ),
        Lang::Cpp => matches!(
            kind,
            "function_definition"
                | "struct_specifier"
                | "class_specifier"
                | "enum_specifier"
                | "type_definition"
        ),
        Lang::CSharp => matches!(
            kind,
            "method_declaration"
                | "constructor_declaration"
                | "class_declaration"
                | "struct_declaration"
                | "interface_declaration"
                | "enum_declaration"
                | "record_declaration"
                | "namespace_declaration"
        ),
    }
}

fn import_of(lang: Lang, node: tree_sitter::Node, text: &str) -> String {
    let raw = &text[node.byte_range()];
    match lang {
        Lang::Rust => raw
            .trim_start_matches("use ")
            .trim_end_matches(';')
            .split('{')
            .next()
            .unwrap_or(raw)
            .trim()
            .to_owned(),
        Lang::Go => unquote(raw),
        Lang::JavaScript | Lang::TypeScript | Lang::C | Lang::Cpp => unquote(raw),
        Lang::CSharp => raw
            .trim_start_matches("using ")
            .trim_end_matches(';')
            .trim()
            .to_owned(),
        _ => raw.trim().to_owned(),
    }
}

fn unquote(text: &str) -> String {
    text.trim()
        .trim_matches(|c| c == '"' || c == '\'' || c == '`')
        .trim()
        .to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kinds(file: &ParsedFile) -> Vec<(&str, &str)> {
        file.symbols
            .iter()
            .map(|s| (s.kind, s.name.as_str()))
            .collect()
    }

    #[test]
    fn rust_symbols_and_calls() {
        let text = r#"use std::sync::Arc;
pub struct Config { pub a: u32 }
impl Config {
    pub async fn reload(&self, n: u32) -> u32 { helper(n) + self.tune() + 1 }
    fn tune(&self) -> u32 { if n() > 1 && n() < 9 { 2 } else { 1 } }
}
pub type Alias = u32;
macro_rules! sq { ($e:expr) => { $e * $e } }
"#;
        let file = parse_file(text, "rs");
        assert_eq!(
            kinds(&file),
            vec![
                ("struct", "Config"),
                ("method", "reload"),
                ("method", "tune"),
                ("type", "Alias"),
                ("macro", "sq"),
            ]
        );
        let reload = &file.symbols[1];
        assert_eq!(
            (reload.line, reload.column),
            (3, 17),
            "4 spaces + `pub async fn `"
        );
        assert_eq!(reload.end_line, 3);
        assert_eq!(reload.container.as_deref(), Some("Config"));
        assert!(reload.exported);
        assert_eq!(reload.params, 2);
        let tune = &file.symbols[2];
        assert!(!tune.exported);
        // if + && → complexity 3; the if nests one level.
        assert_eq!(tune.complexity, 3);
        assert_eq!(tune.nesting, 1);

        let names: Vec<(&str, Option<&str>)> = file
            .calls
            .iter()
            .map(|c| (c.name.as_str(), c.receiver.as_deref()))
            .collect();
        assert!(names.contains(&("helper", None)), "{names:?}");
        assert!(names.contains(&("tune", Some("self"))), "{names:?}");
        assert_eq!(file.imports, vec!["std::sync::Arc"]);
    }

    #[test]
    fn rust_trait_default_methods_get_the_trait_as_container() {
        let file = parse_file("trait Runner { fn go(&self) {} }\n", "rs");
        assert_eq!(
            kinds(&file),
            vec![("interface", "Runner"), ("method", "go")]
        );
        assert_eq!(file.symbols[1].container.as_deref(), Some("Runner"));
    }

    #[test]
    fn python_async_def_and_class_methods() {
        let text = "import os\nfrom . import sibling\nfrom lib.helpers import tool\n\n\nclass Bot:\n    def __init__(self):\n        self.name = 'x'\n\n    async def run(self):\n        return helper()\n\n\ndef top(a, b=1):\n    return self.call()\n";
        let file = parse_file(text, "py");
        assert_eq!(
            kinds(&file),
            vec![
                ("class", "Bot"),
                ("method", "__init__"),
                ("method", "run"),
                ("function", "top")
            ]
        );
        let run = &file.symbols[2];
        assert_eq!(run.container.as_deref(), Some("Bot"));
        assert!(run.exported, "public by Python convention (no underscore)");
        let init = &file.symbols[1];
        assert!(!init.exported, "__init__ is underscore-private");
        assert_eq!(file.imports, vec!["os", ".", "lib.helpers"]);
        assert!(file.calls.iter().any(|c| c.name == "helper"));
        assert!(file
            .calls
            .iter()
            .any(|c| c.name == "call" && c.receiver.as_deref() == Some("self")));
    }

    #[test]
    fn go_methods_receivers_and_type_kinds() {
        let text = "package main\n\nimport \"fmt\"\n\ntype Server struct{}\ntype Reader interface {\n\tRead() error\n}\n\nfunc (s *Server) Handle(n int) {}\nfunc main() { fmt.Println(1) }\n";
        let file = parse_file(text, "go");
        assert_eq!(
            kinds(&file),
            vec![
                ("struct", "Server"),
                ("interface", "Reader"),
                ("method", "Handle"),
                ("function", "main")
            ]
        );
        let handle = &file.symbols[2];
        assert_eq!(handle.container.as_deref(), Some("Server"));
        assert!(handle.exported, "an upper-case Go name is exported");
        assert!(!file.symbols[3].exported);
        assert_eq!(file.imports, vec!["fmt"]);
        assert!(file
            .calls
            .iter()
            .any(|c| c.name == "Println" && c.receiver.as_deref() == Some("fmt")));
    }

    #[test]
    fn typescript_symbols_calls_and_exports() {
        let text = "import { a } from './mod';\nexport const arrow = (x: number) => x + 1;\ninterface Props { n: number }\nenum Mode { A, B }\nexport default class Svc extends Base {\n  async load(): Promise<void> { this.tick(); other(); }\n  tick(): void {}\n}\n";
        let file = parse_file(text, "ts");
        assert_eq!(
            kinds(&file),
            vec![
                ("function", "arrow"),
                ("interface", "Props"),
                ("enum", "Mode"),
                ("class", "Svc"),
                ("method", "load"),
                ("method", "tick"),
            ]
        );
        assert!(file.symbols[0].exported, "export const arrow");
        let load = &file.symbols[4];
        assert_eq!(load.container.as_deref(), Some("Svc"));
        assert!(file
            .calls
            .iter()
            .any(|c| c.name == "tick" && c.receiver.as_deref() == Some("this")));
        assert!(file
            .calls
            .iter()
            .any(|c| c.name == "other" && c.receiver.is_none()));
        assert_eq!(file.imports, vec!["./mod"]);
    }

    #[test]
    fn javascript_arrow_require_and_member_calls() {
        let text = "const util = require('./util');\nconst handler = function (e) { bus.emit(e); };\nfunction go() { plain(); obj.run(); new Thing(); }\n";
        let file = parse_file(text, "js");
        let names: Vec<(&str, &str)> = file
            .symbols
            .iter()
            .map(|s| (s.kind, s.name.as_str()))
            .collect();
        assert!(names.contains(&("function", "handler")), "{names:?}");
        assert!(names.contains(&("function", "go")), "{names:?}");
        assert_eq!(file.imports, vec!["./util"]);
        let calls: Vec<&CallSite> = file.calls.iter().filter(|c| c.name != "require").collect();
        let names: Vec<(&str, Option<&str>)> = calls
            .iter()
            .map(|c| (c.name.as_str(), c.receiver.as_deref()))
            .collect();
        assert!(names.contains(&("emit", Some("bus"))), "{names:?}");
        assert!(names.contains(&("run", Some("obj"))), "{names:?}");
        assert!(
            names.contains(&("Thing", None)),
            "{names:?} (the new-expression call)"
        );
    }

    #[test]
    fn java_classes_methods_and_constructors() {
        let text = "import com.x.Y;\npublic class S implements Runnable {\n  private int n;\n  public S() { this(1); }\n  public void run(Task t) { t.go(); make(); Y.z(); }\n}\n";
        let file = parse_file(text, "java");
        assert_eq!(
            kinds(&file),
            vec![("class", "S"), ("method", "S"), ("method", "run")]
        );
        assert_eq!(file.symbols[1].container.as_deref(), Some("S"));
        assert!(file.symbols[2].exported);
        assert!(file
            .calls
            .iter()
            .any(|c| c.name == "go" && c.receiver.as_deref() == Some("t")));
        assert!(file
            .calls
            .iter()
            .any(|c| c.name == "z" && c.receiver.as_deref() == Some("Y")));
        assert_eq!(file.imports, vec!["com.x.Y"]);
    }

    #[test]
    fn c_functions_typedefs_and_includes() {
        let text = "#include \"local.h\"\ntypedef struct Point { int x; } Point;\nstatic int helper(void) { return 1; }\nint compute(Point *p) { return helper() + p->x; }\n";
        let file = parse_file(text, "c");
        assert_eq!(
            kinds(&file),
            vec![
                ("struct", "Point"),
                ("type", "Point"),
                ("function", "helper"),
                ("function", "compute")
            ]
        );
        assert!(!file.symbols[2].exported, "static functions are file-local");
        assert!(file.symbols[3].exported);
        assert_eq!(file.imports, vec!["local.h"]);
        assert!(file.calls.iter().any(|c| c.name == "helper"));
    }

    #[test]
    fn cpp_out_of_line_methods_and_qualified_calls() {
        let text = "class Widget { void go(); };\nvoid Widget::go() { srv.call(); helper(); }\n";
        let file = parse_file(text, "cpp");
        assert_eq!(kinds(&file), vec![("class", "Widget"), ("method", "go")]);
        let go = &file.symbols[1];
        assert_eq!(go.container.as_deref(), Some("Widget"));
        assert!(file
            .calls
            .iter()
            .any(|c| c.name == "call" && c.receiver.as_deref() == Some("srv")));
        assert!(file.calls.iter().any(|c| c.name == "helper"));
    }

    #[test]
    fn csharp_namespaces_classes_and_invocations() {
        let text = "using System.IO;\nnamespace N {\n  class S {\n    public int Run() { helper(); client.Send(m); return 1; }\n  }\n}\n";
        let file = parse_file(text, "cs");
        assert_eq!(
            kinds(&file),
            vec![("module", "N"), ("class", "S"), ("method", "Run")]
        );
        assert_eq!(file.symbols[2].container.as_deref(), Some("S"));
        assert!(file
            .calls
            .iter()
            .any(|c| c.name == "Send" && c.receiver.as_deref() == Some("client")));
        assert_eq!(file.imports, vec!["System.IO"]);
    }

    #[test]
    fn complexity_counts_decisions_and_nesting() {
        let rust = parse_file("fn deep(a: u32) -> u32 {\n    if a > 0 {\n        if a > 1 {\n            for _ in 0..a { b(); }\n        }\n    }\n    match a { 1 => 1, _ => 0 }\n}\n", "rs");
        let deep = &rust.symbols[0];
        assert_eq!(deep.complexity, 6, "1 + if + if + for + two match arms");
        assert_eq!(deep.nesting, 3);

        let py = parse_file(
            "def f(x):\n    if x and x > 1:\n        return 1\n    return 0\n",
            "py",
        );
        assert_eq!(py.symbols[0].complexity, 3, "1 + if + and");
    }

    #[test]
    fn the_outline_fallback_serves_unparsed_languages() {
        // "rb" is not a grammar language: the outline scan serves nothing for it either, but
        // the fallback path itself is what this exercises (a disabled grammar feature hits
        // the same branch with a language the outline knows).
        let file = parse_file("def unseen\n", "rb");
        assert!(file.symbols.is_empty());
        assert!(file.calls.is_empty());
    }
}
