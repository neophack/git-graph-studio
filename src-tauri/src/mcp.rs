//! The Model Context Protocol server behind `ggs --mcp <folder>` (plan M4's AI bridge):
//! the persistent symbol index served to AI assistants over stdio. One process, one
//! repository, newline-delimited JSON-RPC 2.0 — the transport every MCP client (Claude
//! Desktop, Cline, Cursor, …) launches servers with. The protocol surface is deliberately
//! the small complete set: the `initialize` handshake, `ping`, `tools/list`, `tools/call`.
//!
//! The tools mirror the in-app queries an AI needs to navigate a codebase it cannot load:
//! `symbol_lookup` (where is this declared), `symbol_references` (where is it used —
//! occurrence-narrowed like the app's own Find References), `symbol_tree` (the per-file
//! outline the Symbol Database page shows), `search_symbols` (name search) and
//! `index_status`. stderr carries the one startup line; stdout is protocol only.

use std::io::{BufRead, Write};
use std::sync::Arc;

use serde_json::{json, Value};

use crate::cmd_search::WorkspaceSymbol;
use crate::cmd_symbols::{scan_references, SymbolIndex};

/// The protocol revision we speak; a client asking for another is echoed its own (the
/// tool surface here is stable across the revisions clients ship today).
const PROTOCOL_VERSION: &str = "2025-06-18";
/// How many outline lines `symbol_tree` prints before saying it truncated — a whole
/// monorepo must not flood the model's context.
const TREE_LINE_BUDGET: usize = 4000;

pub struct McpServer {
    root: String,
    index: Arc<SymbolIndex>,
}

impl McpServer {
    /// Build (or resume from `~/.ggs/index/`) the folder's symbol index, then serve.
    pub fn start(folder: &str) -> Result<McpServer, String> {
        let root = std::fs::canonicalize(folder)
            .map_err(|e| format!("{folder}: {e}"))?
            .display()
            .to_string()
            .trim_start_matches(r"\\?\")
            .to_owned();
        let index = Arc::new(SymbolIndex::new());
        // A server start is what the client is waiting on: every core, like an explicit
        // rebuild, not the background half-budget.
        index.build_blocking(None, &root, None)?;
        Ok(McpServer { root, index })
    }

    /// A test seam: an index over a home the caller controls (never the developer's).
    #[cfg(test)]
    fn with_index(root: &str, index: Arc<SymbolIndex>) -> McpServer {
        McpServer {
            root: root.to_owned(),
            index,
        }
    }

    /// One received line becomes at most one response line. Notifications (no `id`) and
    /// blank lines answer nothing; a broken line answers the JSON-RPC parse error.
    pub fn handle_line(&self, line: &str) -> Option<String> {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            return None;
        }
        let message: Value = match serde_json::from_str(trimmed) {
            Ok(value) => value,
            Err(error) => {
                return Some(error_response(
                    Value::Null,
                    -32700,
                    &format!("parse error: {error}"),
                ))
            }
        };
        let id = message.get("id").cloned()?;
        let method = message
            .get("method")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let outcome = match method.as_str() {
            "initialize" => Ok(json!({
                "protocolVersion": message
                    .pointer("/params/protocolVersion")
                    .and_then(Value::as_str)
                    .unwrap_or(PROTOCOL_VERSION),
                "capabilities": { "tools": { "listChanged": false } },
                "serverInfo": { "name": "git-graph-studio", "version": env!("CARGO_PKG_VERSION") }
            })),
            "ping" => Ok(json!({})),
            "tools/list" => Ok(json!({ "tools": tool_catalogue() })),
            "tools/call" => self.call(message.get("params")),
            other => Err((-32601, format!("method not found: {other}"))),
        };
        Some(match outcome {
            Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }).to_string(),
            Err((code, text)) => error_response(id, code, &text),
        })
    }

    fn call(&self, params: Option<&Value>) -> Result<Value, (i64, String)> {
        let name = params
            .and_then(|params| params.get("name"))
            .and_then(Value::as_str)
            .ok_or((-32602, "missing tool name".to_owned()))?;
        let args = params
            .and_then(|params| params.get("arguments"))
            .cloned()
            .unwrap_or_else(|| json!({}));
        let text = match name {
            "symbol_lookup" => self.tool_lookup(&args)?,
            "symbol_references" => self.tool_references(&args)?,
            "symbol_tree" => self.tool_tree(&args)?,
            "search_symbols" => self.tool_search(&args)?,
            "index_status" => self.tool_status(),
            other => return Err((-32602, format!("unknown tool: {other}"))),
        };
        // Tool failures are in-band (isError), protocol errors above are not — the MCP
        // convention a model can read and recover from.
        Ok(json!({ "content": [ { "type": "text", "text": text } ], "isError": false }))
    }

    fn arg_str(args: &Value, key: &str) -> Result<String, (i64, String)> {
        args.get(key)
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or((-32602, format!("missing string argument: {key}")))
    }

    fn tool_lookup(&self, args: &Value) -> Result<String, (i64, String)> {
        let name = Self::arg_str(args, "name")?;
        let defs = self.index.lookup(&self.root, &name).unwrap_or_default();
        Ok(match defs.as_slice() {
            [] => format!("No symbol named '{name}' is declared in the index."),
            defs => {
                let mut out = format!("{n} declaration(s) of '{name}':", n = defs.len());
                for def in defs {
                    out.push_str(&format!(
                        "{n}{kind} {name} — {path}:{line}",
                        n = '\n',
                        kind = def.kind,
                        path = def.path,
                        line = def.line + 1
                    ));
                }
                out
            }
        })
    }

    fn tool_references(&self, args: &Value) -> Result<String, (i64, String)> {
        let name = Self::arg_str(args, "name")?;
        let narrow = self.index.files_containing(&self.root, &name);
        let files = scan_references(&self.root, &name, narrow)
            .map_err(|error| (-32603, format!("reference scan failed: {error}")))?;
        let total: usize = files.iter().map(|file| file.matches.len()).sum();
        if total == 0 {
            return Ok(format!(
                "No whole-word occurrences of '{name}' in the workspace's code files."
            ));
        }
        let mut out = format!("{total} occurrence(s) of '{name}':");
        for file in files {
            for hit in &file.matches {
                out.push_str(&format!(
                    "{n}{path}:{line}:{column}",
                    n = '\n',
                    path = file.path,
                    line = hit.line,
                    column = hit.column
                ));
            }
        }
        Ok(out)
    }

    fn tool_tree(&self, args: &Value) -> Result<String, (i64, String)> {
        let prefix = args
            .get("path")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .replace('\\', "/");
        let (symbols, counts) = self
            .index
            .symbols_with_refs(&self.root)
            .unwrap_or_else(|| (Vec::new(), Default::default()));
        let mut out = String::new();
        let mut lines = 0usize;
        let mut current: Option<&str> = None;
        for symbol in &symbols {
            if !prefix.is_empty() && !symbol.path.starts_with(&prefix) {
                continue;
            }
            if current != Some(symbol.path.as_str()) {
                current = Some(symbol.path.as_str());
                out.push('\n');
                out.push_str(&symbol.path);
                lines += 1;
            }
            let refs = counts.get(&symbol.name).copied().unwrap_or(0);
            out.push_str(&format!(
                "{n}  {kind} {name}  line {line}  refs {refs}",
                n = '\n',
                kind = symbol.kind,
                name = symbol.name,
                line = symbol.line + 1,
                refs = refs
            ));
            lines += 1;
            if lines >= TREE_LINE_BUDGET {
                out.push_str("\n… truncated at 4000 lines; narrow with the path argument");
                break;
            }
        }
        if out.is_empty() {
            return Ok(format!("The index has no symbols under '{prefix}'."));
        }
        Ok(out.trim_start_matches('\n').to_owned())
    }

    fn tool_search(&self, args: &Value) -> Result<String, (i64, String)> {
        let query = Self::arg_str(args, "query")?.to_lowercase();
        let limit = args
            .get("limit")
            .and_then(Value::as_u64)
            .unwrap_or(50)
            .clamp(1, 500) as usize;
        let symbols = self.index.all_symbols(&self.root).unwrap_or_default();
        let hits: Vec<&WorkspaceSymbol> = symbols
            .iter()
            .filter(|symbol| symbol.name.to_lowercase().contains(&query))
            .take(limit)
            .collect();
        Ok(match hits.as_slice() {
            [] => format!("No symbol name contains '{query}'."),
            hits => {
                let mut out = format!("{n} symbol(s) matching '{query}':", n = hits.len());
                for hit in hits {
                    out.push_str(&format!(
                        "{n}{kind} {hit_name} — {path}:{line}",
                        n = '\n',
                        kind = hit.kind,
                        hit_name = hit.name,
                        path = hit.path,
                        line = hit.line + 1
                    ));
                }
                out
            }
        })
    }

    fn tool_status(&self) -> String {
        let status = self.index.status(&self.root);
        format!(
			"root {root}{n}state {state}{n}indexed files {files}{n}symbols {symbols}{n}index: ~/.ggs/index/",
			root = self.root,
			n = '\n',
			state = serde_json::to_string(&status.state).unwrap_or_default(),
			files = status.files,
			symbols = status.symbols
		)
    }
}

fn tool_catalogue() -> Value {
    json!([
        {
            "name": "symbol_lookup",
            "description": "Every declaration of exactly this symbol name in the repository: kind, file and 1-based line. Start here to find where something is defined.",
            "inputSchema": { "type": "object", "properties": { "name": { "type": "string", "description": "The exact symbol name" } }, "required": ["name"] }
        },
        {
            "name": "symbol_references",
            "description": "Every whole-word occurrence of this symbol name across the repository's code files, as file:line:column — the Find References of the app.",
            "inputSchema": { "type": "object", "properties": { "name": { "type": "string", "description": "The exact symbol name" } }, "required": ["name"] }
        },
        {
            "name": "symbol_tree",
            "description": "The symbol database as a per-file outline: each file's declarations with kind, line and how many files reference the name. Optional `path` prefix narrows it (for example \"src/\").",
            "inputSchema": { "type": "object", "properties": { "path": { "type": "string", "description": "Repo-relative path prefix to narrow to" } } }
        },
        {
            "name": "search_symbols",
            "description": "Symbol names containing the query (case-insensitive), up to `limit` (default 50) hits with kind, file and line.",
            "inputSchema": { "type": "object", "properties": { "query": { "type": "string" }, "limit": { "type": "number", "description": "Maximum hits (1-500, default 50)" } }, "required": ["query"] }
        },
        {
            "name": "index_status",
            "description": "Which repository is indexed, its state, and the file / symbol counts.",
            "inputSchema": { "type": "object", "properties": {} }
        }
    ])
}

fn error_response(id: Value, code: i64, message: &str) -> String {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } }).to_string()
}

/// The `--mcp` entry: read lines from stdin, answer on stdout, log to stderr. Returns the
/// process exit code (0 once stdin ends).
pub fn run(folder: &str) -> Result<i32, String> {
    let server = McpServer::start(folder)?;
    eprintln!(
        "[mcp] git-graph-studio {} serving {}",
        env!("CARGO_PKG_VERSION"),
        server.root
    );
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    for line in stdin.lock().lines() {
        let line = line.map_err(|e| format!("stdin: {e}"))?;
        if let Some(reply) = server.handle_line(&line) {
            writeln!(stdout, "{reply}").map_err(|e| format!("stdout: {e}"))?;
            stdout.flush().map_err(|e| format!("stdout: {e}"))?;
        }
    }
    Ok(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch_server() -> (tempfile::TempDir, McpServer) {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("src").join("lib.rs");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, "pub fn alpha() { beta(); }\nfn beta() {}\n").unwrap();
        std::fs::write(dir.path().join("other.rs"), "fn alpha() { alpha(); }\n").unwrap();
        let home = tempfile::tempdir().unwrap();
        let index = Arc::new(SymbolIndex::with_home(home.path().to_owned()));
        let root = dir.path().display().to_string();
        index.build_blocking(None, &root, None).unwrap();
        (dir, McpServer::with_index(&root, index))
    }

    fn reply(server: &McpServer, line: &str) -> Value {
        serde_json::from_str(&server.handle_line(line).expect("a request answers")).unwrap()
    }

    fn call(server: &McpServer, tool: &str, args: Value) -> String {
        let response = reply(
			server,
			&json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": tool, "arguments": args } }).to_string(),
		);
        assert!(
            response.get("error").is_none(),
            "tool call failed: {response}"
        );
        response["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .to_owned()
    }

    #[test]
    fn the_initialize_handshake_answers_capabilities_and_info() {
        let (_dir, server) = scratch_server();
        let response = reply(
            &server,
            r#"{"jsonrpc":"2.0","id":7,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}"#,
        );
        assert_eq!(response["id"], json!(7));
        assert_eq!(response["result"]["protocolVersion"], "2025-03-26");
        assert_eq!(response["result"]["serverInfo"]["name"], "git-graph-studio");
        assert!(response["result"]["capabilities"]["tools"].is_object());
    }

    #[test]
    fn notifications_and_blank_lines_answer_nothing() {
        let (_dir, server) = scratch_server();
        assert!(server.handle_line("").is_none());
        assert!(server
            .handle_line(r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#)
            .is_none());
    }

    #[test]
    fn broken_lines_and_unknown_methods_answer_protocol_errors() {
        let (_dir, server) = scratch_server();
        let parsed: Value =
            serde_json::from_str(&server.handle_line("{ not json").unwrap()).unwrap();
        assert_eq!(parsed["error"]["code"], -32700);
        let parsed: Value = serde_json::from_str(
            &server
                .handle_line(r#"{"jsonrpc":"2.0","id":2,"method":"resources/list"}"#)
                .unwrap(),
        )
        .unwrap();
        assert_eq!(parsed["error"]["code"], -32601);
        let parsed: Value = serde_json::from_str(
            &server
                .handle_line(
                    r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"nope"}}"#,
                )
                .unwrap(),
        )
        .unwrap();
        assert_eq!(parsed["error"]["code"], -32602);
    }

    #[test]
    fn tools_list_names_the_catalogue() {
        let (_dir, server) = scratch_server();
        let response = reply(&server, r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#);
        let names: Vec<&str> = response["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|tool| tool["name"].as_str().unwrap())
            .collect();
        assert_eq!(
            names,
            [
                "symbol_lookup",
                "symbol_references",
                "symbol_tree",
                "search_symbols",
                "index_status"
            ]
        );
    }

    #[test]
    fn lookup_references_tree_search_and_status_answer_over_the_index() {
        let (_dir, server) = scratch_server();
        let lookup = call(&server, "symbol_lookup", json!({ "name": "beta" }));
        assert!(lookup.contains("function beta — src/lib.rs:2"), "{lookup}");

        let references = call(&server, "symbol_references", json!({ "name": "alpha" }));
        assert!(references.contains("src/lib.rs:1:8"), "{references}");
        assert!(
            references.contains("other.rs:1:4") && references.contains("other.rs:1:14"),
            "{references}"
        );

        let tree = call(&server, "symbol_tree", json!({ "path": "src/" }));
        assert!(tree.contains("src/lib.rs"), "{tree}");
        assert!(tree.contains("function alpha  line 1  refs 2"), "{tree}");
        let narrowed = call(&server, "symbol_tree", json!({ "path": "other.rs" }));
        assert!(!narrowed.contains("src/lib.rs"), "{narrowed}");

        let search = call(&server, "search_symbols", json!({ "query": "ALP" }));
        assert!(
            search.contains("alpha") && search.contains("src/lib.rs"),
            "{search}"
        );

        let status = call(&server, "index_status", json!({}));
        assert!(status.contains("state \"ready\""), "{status}");
        assert!(status.contains("symbols 3"), "{status}");
    }

    #[test]
    fn empty_answers_stay_helpful_text_not_errors() {
        let (_dir, server) = scratch_server();
        assert!(call(&server, "symbol_lookup", json!({ "name": "missing" }))
            .contains("No symbol named"));
        assert!(
            call(&server, "symbol_references", json!({ "name": "missing" }))
                .contains("No whole-word occurrences")
        );
        assert!(call(&server, "search_symbols", json!({ "query": "zzz" }))
            .contains("No symbol name contains"));
    }
}
