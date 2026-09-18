//! The Model Context Protocol server behind `ggs --mcp <folder>` (plan M4's AI bridge):
//! the persistent symbol index and the Code Analysis engine served to AI assistants over
//! stdio. One process, one repository, newline-delimited JSON-RPC 2.0 — the transport
//! every MCP client (Claude Desktop, Cline, Cursor, …) launches servers with. The
//! protocol surface is deliberately the small complete set: the `initialize` handshake,
//! `ping`, `tools/list`, `tools/call`.
//!
//! The tools mirror the in-app queries an AI needs to navigate a codebase it cannot load:
//! `symbol_lookup` (where is this declared), `symbol_references` (where is it used —
//! occurrence-narrowed like the app's own Find References), `symbol_tree` (the per-file
//! outline the Symbol Database page shows), `search_symbols` (name search), `read_file`
//! and `search_text` (the file contents and the workspace text search), `index_status` —
//! plus the module-17 analysis tools: `analysis_module_graph` (the module and file call
//! dependencies), `analysis_call_graph`, `analysis_call_path`, `analysis_metrics`,
//! `analysis_dead_code`, `analysis_security`, `analysis_import_graph` and
//! `analysis_import_cycles`. stderr carries the one startup line; stdout is protocol
//! only.

use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::analysis::imports::import_graph;
use crate::analysis::metrics::enriched_rows;
use crate::analysis::modules::{module_graph, module_of, FileDep, ModuleEdge, ModuleGraph};
use crate::analysis::security::scan_file;
use crate::analysis::{deadcode, AnalysisData, Direction};
use crate::cmd_analysis::AnalysisIndex;
use crate::cmd_fs::walk_files;
use crate::cmd_search::{search_literal, WorkspaceSymbol};
use crate::cmd_symbols::{scan_references, SymbolIndex};

/// The protocol revision we speak; a client asking for another is echoed its own (the
/// tool surface here is stable across the revisions clients ship today).
const PROTOCOL_VERSION: &str = "2025-06-18";
/// How many outline lines `symbol_tree` prints before saying it truncated — a whole
/// monorepo must not flood the model's context.
const TREE_LINE_BUDGET: usize = 4000;
/// The same budget for the analysis reports.
const REPORT_LINE_BUDGET: usize = 400;
/// Lines one `read_file` answer may carry.
const READ_LINE_BUDGET: usize = 4000;
/// The largest file `read_file` serves whole — bigger ones belong to the app's viewers.
const MAX_READ_BYTES: usize = 2_000_000;
/// Past this size the call log is trimmed to its newest [`LOG_KEEP_BYTES`], so a
/// long-lived bridge cannot grow it without bound.
const LOG_ROTATE_BYTES: usize = 1_000_000;
const LOG_KEEP_BYTES: usize = 256_000;

pub struct McpServer {
    root: String,
    index: Arc<SymbolIndex>,
    analysis: Arc<AnalysisIndex>,
    /// Where this server appends its call log (JSON lines; the MCP page reads it).
    log_path: std::path::PathBuf,
}

impl McpServer {
    /// Build (or resume from `~/.ggs/index/`) the folder's symbol index and analysis,
    /// then serve.
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
        let analysis = Arc::new(AnalysisIndex::new());
        analysis.build_blocking(None, &root, None)?;
        Ok(McpServer {
            root,
            index,
            analysis,
            log_path: mcp_log_path(),
        })
    }

    /// A test seam: an index and analysis over homes the caller controls (never the
    /// developer's), and a call log the caller points at.
    #[cfg(test)]
    fn with_parts(
        root: &str,
        index: Arc<SymbolIndex>,
        analysis: Arc<AnalysisIndex>,
        log_path: std::path::PathBuf,
    ) -> McpServer {
        McpServer {
            root: root.to_owned(),
            index,
            analysis,
            log_path,
        }
    }

    /// One JSON line into the call log: the tool, the outcome, the duration, a brief of
    /// the arguments. Best-effort — a bridge whose log cannot be written still serves.
    fn log_call(&self, tool: &str, args: &Value, ok: bool, elapsed: std::time::Duration) {
        let mut brief = args.to_string();
        if brief.len() > 120 {
            brief.truncate(120);
            brief.push('…');
        }
        append_log(
            &self.log_path,
            json!({
                "time": now_millis(),
                "tool": tool,
                "ok": ok,
                "ms": elapsed.as_millis() as u64,
                "args": brief,
            })
            .to_string(),
        );
    }

    /// The analysis behind the analysis tools, when it has landed.
    fn analysis_data(&self) -> Result<Arc<Mutex<AnalysisData>>, (i64, String)> {
        self.analysis
            .analysis(&self.root)
            .ok_or((-32603, "the analysis index is still building".to_owned()))
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
        let started = std::time::Instant::now();
        let outcome = match name {
            "symbol_lookup" => self.tool_lookup(&args),
            "symbol_references" => self.tool_references(&args),
            "symbol_tree" => self.tool_tree(&args),
            "search_symbols" => self.tool_search(&args),
            "read_file" => self.tool_read_file(&args),
            "search_text" => self.tool_search_text(&args),
            "index_status" => Ok(self.tool_status()),
            "analysis_module_graph" => self.tool_module_graph(&args),
            "analysis_call_graph" => self.tool_call_graph(&args),
            "analysis_call_path" => self.tool_call_path(&args),
            "analysis_metrics" => self.tool_metrics(&args),
            "analysis_dead_code" => self.tool_dead_code(&args),
            "analysis_security" => self.tool_security(),
            "analysis_import_graph" => self.tool_import_graph(&args),
            "analysis_import_cycles" => self.tool_import_cycles(),
            other => Err((-32602, format!("unknown tool: {other}"))),
        };
        self.log_call(name, &args, outcome.is_ok(), started.elapsed());
        // Tool failures are in-band (isError), protocol errors above are not — the MCP
        // convention a model can read and recover from.
        let text = outcome?;
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

    /// `read_file`: one repository file's text, optionally a line window (1-based,
    /// inclusive). Failures stay in-band — a model can read the answer and recover. The
    /// path may never leave the served repository.
    fn tool_read_file(&self, args: &Value) -> Result<String, (i64, String)> {
        let path = Self::arg_str(args, "path")?.replace('\\', "/");
        let start = args
            .get("startLine")
            .and_then(Value::as_u64)
            .unwrap_or(1)
            .max(1) as usize;
        let end = args
            .get("endLine")
            .and_then(Value::as_u64)
            .map(|v| v.max(1) as usize);
        let Ok(root) = std::path::Path::new(&self.root).canonicalize() else {
            return Ok(format!(
                "The served folder '{}' is not readable.",
                self.root
            ));
        };
        let Ok(canonical) = root.join(&path).canonicalize() else {
            return Ok(format!("No readable file at '{path}'."));
        };
        if !canonical.starts_with(&root) {
            return Ok("The path escapes the served repository.".to_owned());
        }
        let Ok(bytes) = std::fs::read(&canonical) else {
            return Ok(format!("No readable file at '{path}'."));
        };
        if bytes.len() > MAX_READ_BYTES {
            return Ok(format!(
                "{path} is {} bytes; read_file serves files up to {MAX_READ_BYTES} — use search_text to locate passages, or the app's viewers",
                bytes.len()
            ));
        }
        let text = String::from_utf8_lossy(&bytes);
        let lines: Vec<&str> = text.split('\n').collect();
        if lines.is_empty() {
            return Ok(format!("{path} — empty file."));
        }
        let total = lines.len();
        let begin = start.clamp(1, total);
        let stop = end.unwrap_or(total).clamp(begin, total);
        let window: Vec<&str> = lines[begin - 1..stop]
            .iter()
            .copied()
            .take(READ_LINE_BUDGET)
            .collect();
        let last = begin + window.len() - 1;
        let mut out = format!("{path} — lines {begin}–{last} of {total}:");
        for line in &window {
            out.push('\n');
            out.push_str(line.trim_end_matches('\r'));
        }
        if last < stop {
            out.push_str(&format!(
                "{n}… truncated at {READ_LINE_BUDGET} lines; continue with startLine = {}",
                last + 1,
                n = '\n'
            ));
        }
        Ok(out)
    }

    /// `search_text`: a literal, case-insensitive search across the repository's files —
    /// the app's Workspace Search, answer-capped.
    fn tool_search_text(&self, args: &Value) -> Result<String, (i64, String)> {
        let query = Self::arg_str(args, "query")?;
        let prefix = args
            .get("path")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .replace('\\', "/");
        let files: Vec<String> = walk_files(&self.root)
            .into_iter()
            .filter(|file| prefix.is_empty() || file.starts_with(&prefix))
            .collect();
        let outcome = search_literal(&files, &self.root, &query)
            .map_err(|error| (-32603, format!("search failed: {error}")))?;
        let total: usize = outcome.files.iter().map(|file| file.matches.len()).sum();
        if total == 0 {
            return Ok(format!(
                "No occurrences of '{query}' in {} scanned file(s).",
                outcome.scanned
            ));
        }
        let mut out = format!(
            "{total} occurrence(s) of '{query}' in {} file(s):",
            outcome.files.len()
        );
        let mut lines = 0usize;
        'files: for file in &outcome.files {
            for hit in &file.matches {
                if lines >= REPORT_LINE_BUDGET {
                    out.push_str("\n… truncated; narrow with the path argument");
                    break 'files;
                }
                out.push_str(&format!(
                    "{n}{path}:{line}: {text}",
                    n = '\n',
                    path = file.path,
                    line = hit.line,
                    text = hit.text.trim_end_matches('\r')
                ));
                lines += 1;
            }
        }
        Ok(out)
    }

    /* ---------- The module-17 analysis tools ---------- */

    fn tool_module_graph(&self, args: &Value) -> Result<String, (i64, String)> {
        let module = args
            .get("module")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let data = self.analysis_data()?;
        let graph: ModuleGraph = {
            let data = data.lock().unwrap();
            module_graph(&data)
        };
        if graph.edges.is_empty() {
            return Ok("No cross-file calls in the analysis.".to_owned());
        }
        let edges: Vec<&ModuleEdge> = graph
            .edges
            .iter()
            .filter(|edge| {
                module
                    .as_deref()
                    .is_none_or(|want| edge.from == want || edge.to == want)
            })
            .collect();
        // The top file pairs under each module edge, so one answer sketches the shape of
        // the dependency; the per-site detail stays with `analysis_call_graph`.
        let mut by_module: HashMap<(&str, &str), Vec<&FileDep>> = HashMap::new();
        for dep in &graph.file_edges {
            by_module
                .entry((module_of(&dep.from), module_of(&dep.to)))
                .or_default()
                .push(dep);
        }
        let mut out = format!(
            "{modules} module(s), {pairs} file dependency pair(s), {calls} cross-file call(s); {shown} module edge(s):",
            modules = graph.modules.len(),
            pairs = graph.total_file_edges,
            calls = graph.total_calls,
            shown = edges.len()
        );
        let mut lines = 0usize;
        for edge in edges {
            if lines >= REPORT_LINE_BUDGET {
                out.push_str("\n… truncated; narrow with the module argument");
                break;
            }
            out.push_str(&format!(
                "{n}{from} → {to}  {calls} call(s), {files} file pair(s)",
                n = '\n',
                from = edge.from,
                to = edge.to,
                calls = edge.calls,
                files = edge.files
            ));
            lines += 1;
            for dep in by_module
                .get(&(edge.from.as_str(), edge.to.as_str()))
                .into_iter()
                .flatten()
                .take(3)
            {
                out.push_str(&format!(
                    "{n}  {from} → {to}  {calls} call(s)",
                    n = '\n',
                    from = dep.from,
                    to = dep.to,
                    calls = dep.calls
                ));
                lines += 1;
            }
        }
        Ok(out)
    }

    fn tool_call_graph(&self, args: &Value) -> Result<String, (i64, String)> {
        let name = Self::arg_str(args, "name")?;
        let direction = match args.get("direction").and_then(Value::as_str) {
            Some("callers") => Direction::Callers,
            _ => Direction::Callees,
        };
        let depth = args
            .get("maxDepth")
            .and_then(Value::as_u64)
            .unwrap_or(2)
            .clamp(1, 6) as u32;
        let data = self.analysis_data()?;
        let data = data.lock().unwrap();
        let graph = data.call_graph(&name, None, direction, depth);
        if graph.nodes.is_empty() {
            return Ok(format!("No symbol named '{name}' is in the analysis."));
        }
        let mut out = format!(
            "{n} node(s) around '{name}' ({direction}, depth ≤ {depth}), {edges} edge(s):",
            n = graph.nodes.len(),
            direction = match direction {
                Direction::Callers => "callers",
                Direction::Callees => "callees",
            },
            edges = graph.edges.len(),
            depth = depth
        );
        for node in &graph.nodes {
            let container = node
                .container
                .as_deref()
                .map(|c| format!("{c}."))
                .unwrap_or_default();
            out.push_str(&format!(
                "{n}depth {depth}  {kind} {container}{name} — {path}:{line}  (complexity {complexity})",
                n = '\n',
                depth = node.depth,
                kind = node.kind,
                name = node.name,
                path = node.path,
                line = node.line + 1,
                complexity = node.complexity
            ));
        }
        for edge in graph.edges.iter().take(REPORT_LINE_BUDGET) {
            out.push_str(&format!(
                "{n}{from_name} → {to_name}  at {path}:{line}",
                n = '\n',
                from_name = edge.from.name,
                to_name = edge.to.name,
                path = edge.call_path,
                line = edge.call_line + 1
            ));
        }
        Ok(out)
    }

    fn tool_call_path(&self, args: &Value) -> Result<String, (i64, String)> {
        let from = Self::arg_str(args, "from")?;
        let to = Self::arg_str(args, "to")?;
        let data = self.analysis_data()?;
        let data = data.lock().unwrap();
        match data.call_path(&from, &to) {
            None => Ok(format!("No call chain leads from '{from}' to '{to}'.")),
            Some(chain) => {
                let mut out = format!(
                    "A shortest chain from '{from}' to '{to}' ({n} step(s)):",
                    n = chain.len().saturating_sub(1)
                );
                for node in &chain {
                    out.push_str(&format!(
                        "{n}{kind} {name} — {path}:{line}",
                        n = '\n',
                        kind = node.kind,
                        name = node.name,
                        path = node.path,
                        line = node.line + 1
                    ));
                }
                Ok(out)
            }
        }
    }

    fn tool_metrics(&self, args: &Value) -> Result<String, (i64, String)> {
        let limit = args
            .get("limit")
            .and_then(Value::as_u64)
            .unwrap_or(20)
            .clamp(1, 200) as usize;
        let data = self.analysis_data()?;
        let rows = {
            let data = data.lock().unwrap();
            enriched_rows(&data, &|_| 0, data.root())
        };
        let mut rows = rows;
        rows.sort_by(|a, b| {
            b.hotspot
                .cmp(&a.hotspot)
                .then(b.complexity.cmp(&a.complexity))
        });
        if rows.is_empty() {
            return Ok("The analysis has no functions to measure.".to_owned());
        }
        let mut out = format!(
            "Top {shown} of {total} function(s) by hotspot (complexity × references):",
            shown = limit.min(rows.len()),
            total = rows.len()
        );
        for row in rows.iter().take(limit) {
            let container = row
                .container
                .as_deref()
                .map(|c| format!("{c}."))
                .unwrap_or_default();
            // The big-code-analysis columns, when they were measured — cognitive
            // complexity and the maintainability index lead the AI's eye to the
            // functions a refactor pays off on.
            let rich = match (row.cognitive, row.mi) {
                (Some(cognitive), Some(mi)) => format!("  cognitive {cognitive}  MI {mi}"),
                _ => String::new(),
            };
            out.push_str(&format!(
                "{n}complexity {complexity}{rich}  {lines} lines  {params} params  nesting {nesting}  {kind} {container}{name} — {path}:{line}",
                n = '\n',
                complexity = row.complexity,
                lines = row.lines,
                params = row.params,
                nesting = row.nesting,
                kind = row.kind,
                name = row.name,
                path = row.path,
                line = row.line + 1
            ));
        }
        Ok(out)
    }

    fn tool_dead_code(&self, args: &Value) -> Result<String, (i64, String)> {
        let include_exported = args
            .get("includeExported")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let data = self.analysis_data()?;
        let rows = {
            let data = data.lock().unwrap();
            deadcode::dead_rows(&data, include_exported)
        };
        if rows.is_empty() {
            return Ok("No uncalled declarations found.".to_owned());
        }
        let mut out = format!(
            "{total} declaration(s) no call site in this repository spells (first {shown}; exported declarations are excluded unless includeExported is true):",
            total = rows.len(),
            shown = rows.len().min(REPORT_LINE_BUDGET)
        );
        for row in rows.iter().take(REPORT_LINE_BUDGET) {
            out.push_str(&format!(
                "{n}{kind} {name} — {path}:{line}  ({lines} lines{exported})",
                n = '\n',
                kind = row.kind,
                name = row.name,
                path = row.path,
                line = row.line + 1,
                lines = row.lines,
                exported = if row.exported { ", exported" } else { "" }
            ));
        }
        Ok(out)
    }

    fn tool_security(&self) -> Result<String, (i64, String)> {
        let data = self.analysis_data()?;
        let mut out = String::new();
        let mut total = 0usize;
        {
            let data = data.lock().unwrap();
            for file in data.files() {
                let Ok(text) =
                    std::fs::read_to_string(std::path::Path::new(&self.root).join(&file.path))
                else {
                    continue;
                };
                let ext = file.path.rsplit_once('.').map(|(_, e)| e).unwrap_or("");
                for finding in scan_file(&file.path, ext, &text, &file.calls) {
                    total += 1;
                    if total > REPORT_LINE_BUDGET {
                        continue;
                    }
                    out.push_str(&format!(
                        "{n}[{severity}] {message} ({rule}, {cwe}) — {path}:{line}",
                        n = '\n',
                        severity = serde_json::to_string(&finding.severity)
                            .unwrap_or_default()
                            .trim_matches('"'),
                        message = finding.message,
                        rule = finding.rule_id,
                        cwe = finding.cwe,
                        path = finding.path,
                        line = finding.line + 1
                    ));
                }
            }
        }
        if total == 0 {
            return Ok("No security rule findings.".to_owned());
        }
        Ok(format!("{total} finding(s):{out}"))
    }

    /// `analysis_import_graph`: the full file dependency graph — every import resolved
    /// to a workspace file, not only the cycles.
    fn tool_import_graph(&self, args: &Value) -> Result<String, (i64, String)> {
        let prefix = args
            .get("path")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .replace('\\', "/");
        let data = self.analysis_data()?;
        let graph = {
            let data = data.lock().unwrap();
            import_graph(&data)
        };
        let edges: Vec<&(String, String)> = graph
            .edges
            .iter()
            .filter(|(from, to)| {
                prefix.is_empty() || from.starts_with(&prefix) || to.starts_with(&prefix)
            })
            .collect();
        if edges.is_empty() {
            let scope = if prefix.is_empty() {
                String::new()
            } else {
                format!(" under '{prefix}'")
            };
            return Ok(format!("No import dependencies{scope}."));
        }
        let mut out = format!(
            "{count} file dependency edge(s) (from → to; {cycles} cycle(s)):",
            count = edges.len(),
            cycles = graph.cycles.len()
        );
        for (from, to) in edges.iter().take(REPORT_LINE_BUDGET) {
            out.push_str(&format!("{n}{from} → {to}", n = '\n'));
        }
        if edges.len() > REPORT_LINE_BUDGET {
            out.push_str("\n… truncated; narrow with the path argument");
        }
        Ok(out)
    }

    fn tool_import_cycles(&self) -> Result<String, (i64, String)> {
        let data = self.analysis_data()?;
        let graph = {
            let data = data.lock().unwrap();
            import_graph(&data)
        };
        if graph.cycles.is_empty() {
            return Ok(format!(
                "No import cycles among the {edges} dependency edge(s).",
                edges = graph.edges.len()
            ));
        }
        let mut out = format!(
            "{count} import cycle(s) among {edges} dependency edge(s):",
            count = graph.cycles.len(),
            edges = graph.edges.len()
        );
        for cycle in graph.cycles.iter().take(REPORT_LINE_BUDGET) {
            out.push_str(&format!("\n{}", cycle.join(" → ")));
        }
        Ok(out)
    }
}

/* ---------- The call log the MCP page reads ---------- */

/// One logged MCP call (a line of `~/.ggs/logs/mcp.log`).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct McpLogEntry {
    /// Unix epoch milliseconds — the page formats them for the user.
    pub time: u64,
    pub tool: String,
    pub ok: bool,
    pub ms: u64,
    /// A brief of the arguments (capped), for the row's tooltip.
    pub args: String,
}

/// One tool of the catalogue, for the page's setup section.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct McpToolInfo {
    pub name: String,
    pub description: String,
}

/// The MCP call log's path under the GGS user home (plan Appendix B: logs live there).
pub fn mcp_log_path() -> std::path::PathBuf {
    crate::cmd_symbols::ggs_home().join("logs").join("mcp.log")
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Append one line to the log, trimming it to the newest tail first when it has
/// outgrown [`LOG_ROTATE_BYTES`] — best-effort, never a reason to fail a call.
fn append_log(path: &std::path::Path, mut line: String) {
    line.push('\n');
    let _ = std::fs::create_dir_all(path.parent().unwrap_or(path));
    if let Ok(bytes) = std::fs::read(path) {
        if bytes.len() > LOG_ROTATE_BYTES {
            let _ = std::fs::write(path, trim_log(&bytes));
        }
    }
    let _ = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .and_then(|mut file| std::io::Write::write_all(&mut file, line.as_bytes()));
}

/// The newest [`LOG_KEEP_BYTES`] of the log, cut at a line boundary so entries stay
/// whole (a log already within the budget passes through unchanged).
fn trim_log(bytes: &[u8]) -> &[u8] {
    if bytes.len() <= LOG_KEEP_BYTES {
        return bytes;
    }
    let keep_from = bytes.len().saturating_sub(LOG_KEEP_BYTES);
    let start = bytes[keep_from..]
        .iter()
        .position(|&b| b == b'\n')
        .map(|at| keep_from + at + 1)
        .unwrap_or(keep_from);
    &bytes[start..]
}

/// The log's newest `limit` entries, oldest first; unreadable lines are skipped, a
/// missing log is simply empty.
pub fn read_mcp_log(path: &std::path::Path, limit: usize) -> Vec<McpLogEntry> {
    let Ok(bytes) = std::fs::read(path) else {
        return Vec::new();
    };
    let text = String::from_utf8_lossy(&bytes);
    let mut entries: Vec<McpLogEntry> = text
        .lines()
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect();
    if entries.len() > limit {
        entries.drain(..entries.len() - limit);
    }
    entries
}

/// The catalogue as the page lists it (the same objects `tools/list` serves).
fn catalogue_infos() -> Vec<McpToolInfo> {
    tool_catalogue()
        .as_array()
        .map(|tools| {
            tools
                .iter()
                .map(|tool| McpToolInfo {
                    name: tool["name"].as_str().unwrap_or_default().to_owned(),
                    description: tool["description"].as_str().unwrap_or_default().to_owned(),
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The bridge's recent calls for the MCP page's log list — newest first, capped.
#[tauri::command]
pub async fn mcp_log() -> Result<Vec<McpLogEntry>, String> {
    let mut entries = read_mcp_log(&mcp_log_path(), 500);
    entries.reverse();
    Ok(entries)
}

/// The MCP tool catalogue for the MCP page's setup section.
#[tauri::command]
pub async fn mcp_tools() -> Result<Vec<McpToolInfo>, String> {
    Ok(catalogue_infos())
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
            "name": "read_file",
            "description": "One repository file's text (UTF-8, up to 2 MB), optionally a line window: startLine/endLine are 1-based and inclusive. Answers cap at 4000 lines.",
            "inputSchema": { "type": "object", "properties": { "path": { "type": "string", "description": "Repo-relative file path" }, "startLine": { "type": "number", "description": "First line to show (1-based)" }, "endLine": { "type": "number", "description": "Last line to show (inclusive)" } }, "required": ["path"] }
        },
        {
            "name": "search_text",
            "description": "A literal, case-insensitive text search across the repository's files — every hit as path:line: text. Optional `path` prefix narrows the scan.",
            "inputSchema": { "type": "object", "properties": { "query": { "type": "string" }, "path": { "type": "string", "description": "Repo-relative path prefix to narrow to" } }, "required": ["query"] }
        },
        {
            "name": "index_status",
            "description": "Which repository is indexed, its state, and the file / symbol counts.",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "analysis_call_graph",
            "description": "The call graph around every declaration of a name: callers or callees up to maxDepth (default 2), with each edge's call site. Resolution is name-based with receiver hints — same-named declarations fan out.",
            "inputSchema": { "type": "object", "properties": { "name": { "type": "string" }, "direction": { "type": "string", "enum": ["callers", "callees"], "description": "Which way to walk (default callees)" }, "maxDepth": { "type": "number", "description": "Levels to walk (1-6, default 2)" } }, "required": ["name"] }
        },
        {
            "name": "analysis_call_path",
            "description": "A shortest chain of calls between two declarations, by name: how control reaches `to` from `from`, as function — file:line steps.",
            "inputSchema": { "type": "object", "properties": { "from": { "type": "string", "description": "The starting function's name" }, "to": { "type": "string", "description": "The target function's name" } }, "required": ["from", "to"] }
        },
        {
            "name": "analysis_module_graph",
            "description": "The workspace's cross-file calls as module dependencies: which directory (module) depends on which, with the file pairs that carry the calls and their call counts. Optional `module` narrows to that module's edges.",
            "inputSchema": { "type": "object", "properties": { "module": { "type": "string", "description": "A module (directory) name to narrow to, e.g. \"src\"; the workspace root is \"\"" } } }
        },
        {
            "name": "analysis_metrics",
            "description": "Functions ranked by hotspot (cyclomatic complexity × references): complexity, cognitive complexity, maintainability index, lines, parameters and nesting per function.",
            "inputSchema": { "type": "object", "properties": { "limit": { "type": "number", "description": "How many top functions to list (1-200, default 20)" } } }
        },
        {
            "name": "analysis_dead_code",
            "description": "Functions and methods no call site in the repository spells — conservative candidates, not verdicts; exported declarations are excluded unless includeExported is true.",
            "inputSchema": { "type": "object", "properties": { "includeExported": { "type": "boolean", "description": "Also list exported declarations (default false)" } } }
        },
        {
            "name": "analysis_security",
            "description": "The rule-based security scan: hardcoded secrets, dangerous and weak-crypto APIs, each finding with severity and CWE.",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "analysis_import_graph",
            "description": "The full file dependency graph — every import resolved to a workspace file, as from → to edges (import statements, not calls; analysis_module_graph maps the calls). Optional `path` prefix narrows it.",
            "inputSchema": { "type": "object", "properties": { "path": { "type": "string", "description": "Repo-relative path prefix to narrow to" } } }
        },
        {
            "name": "analysis_import_cycles",
            "description": "The file dependency graph's strongly-connected components — every import cycle, as chains of file names.",
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
    // The session's first log row — the page shows when (and from where) the bridge ran.
    server.log_call(
        "(start)",
        &json!({ "root": server.root, "version": env!("CARGO_PKG_VERSION") }),
        true,
        std::time::Duration::ZERO,
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
        std::fs::write(
            &file,
            "pub fn alpha() { beta(); }\nfn beta() {}\nfn orphan() {}\n",
        )
        .unwrap();
        std::fs::write(
            dir.path().join("other.rs"),
            "fn alpha() { alpha(); }\nlet password = \"hunter2-super-secret-value\";\n",
        )
        .unwrap();
        // The one cross-file call: the module graph's material.
        std::fs::write(
            dir.path().join("src").join("caller.rs"),
            "pub fn entry() { beta(); }\n",
        )
        .unwrap();
        let home = tempfile::tempdir().unwrap();
        let index = Arc::new(SymbolIndex::with_home(home.path().to_owned()));
        let root = dir.path().display().to_string();
        index.build_blocking(None, &root, None).unwrap();
        let analysis = Arc::new(AnalysisIndex::new());
        analysis.build_blocking(None, &root, None).unwrap();
        let log = tempfile::tempdir().unwrap();
        let server = McpServer::with_parts(&root, index, analysis, log.path().join("mcp.log"));
        (dir, server)
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
                "read_file",
                "search_text",
                "index_status",
                "analysis_call_graph",
                "analysis_call_path",
                "analysis_module_graph",
                "analysis_metrics",
                "analysis_dead_code",
                "analysis_security",
                "analysis_import_graph",
                "analysis_import_cycles"
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
        assert!(status.contains("symbols 5"), "{status}");
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

    #[test]
    fn read_and_search_tools_serve_files_and_text() {
        let (_dir, server) = scratch_server();
        let read = call(&server, "read_file", json!({ "path": "src/lib.rs" }));
        assert!(read.contains("src/lib.rs — lines 1–4 of 4"), "{read}");
        assert!(read.contains("pub fn alpha()"), "{read}");
        // A line window shows just those lines, 1-based and inclusive.
        let window = call(
            &server,
            "read_file",
            json!({ "path": "src/lib.rs", "startLine": 2, "endLine": 2 }),
        );
        assert!(window.contains("lines 2–2 of"), "{window}");
        assert!(!window.contains("pub fn alpha"), "{window}");
        // Failures stay in-band text, and the path may never leave the repository — the
        // escape probe points at a file that really exists outside the root.
        assert!(call(&server, "read_file", json!({ "path": "missing.rs" }))
            .contains("No readable file"));
        let outside = std::env::temp_dir().join("ggs-mcp-escape-test.txt");
        std::fs::write(&outside, "secret").unwrap();
        let escaped = call(
            &server,
            "read_file",
            json!({ "path": "../ggs-mcp-escape-test.txt" }),
        );
        let _ = std::fs::remove_file(&outside);
        assert!(
            escaped.contains("escapes the served repository"),
            "{escaped}"
        );

        let search = call(&server, "search_text", json!({ "query": "ALPHA" }));
        assert!(search.contains("src/lib.rs:1"), "{search}");
        assert!(search.contains("other.rs:1"), "{search}");
        let narrowed = call(
            &server,
            "search_text",
            json!({ "query": "alpha", "path": "other.rs" }),
        );
        assert!(narrowed.contains("other.rs:1"), "{narrowed}");
        assert!(!narrowed.contains("src/lib.rs"), "{narrowed}");
        assert!(
            call(&server, "search_text", json!({ "query": "zzz-nothing" }))
                .contains("No occurrences")
        );

        let imports = call(&server, "analysis_import_graph", json!({}));
        assert!(imports.contains("No import dependencies"), "{imports}");
    }

    #[test]
    fn tool_calls_land_in_the_log() {
        let (_dir, server) = scratch_server();
        call(&server, "symbol_lookup", json!({ "name": "beta" }));
        let failing = reply(
            &server,
            r#"{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"nope"}}"#,
        );
        assert_eq!(failing["error"]["code"], -32602);
        let entries = read_mcp_log(&server.log_path, 100);
        assert_eq!(entries.len(), 2, "{entries:?}");
        assert_eq!(entries[0].tool, "symbol_lookup");
        assert!(entries[0].ok, "the call answered");
        assert!(entries[0].args.contains("beta"), "{:?}", entries[0].args);
        assert_eq!(entries[1].tool, "nope");
        assert!(!entries[1].ok, "the unknown tool is a logged failure");
        // The page's command shape: newest first.
        let mut newest_first = entries.clone();
        newest_first.reverse();
        assert_eq!(newest_first[0].tool, "nope");
    }

    #[test]
    fn the_log_tail_is_capped_and_line_aligned() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mcp.log");
        for i in 0..12 {
            append_log(
                &path,
                json!({ "time": i, "tool": format!("t{i}"), "ok": true, "ms": 0, "args": "" })
                    .to_string(),
            );
        }
        let entries = read_mcp_log(&path, 5);
        assert_eq!(
            entries.iter().map(|e| e.tool.as_str()).collect::<Vec<_>>(),
            ["t7", "t8", "t9", "t10", "t11"],
            "the limit keeps the newest entries, oldest first"
        );

        // The trim keeps within the budget, cut at a line boundary.
        let line = format!("{}\n", "x".repeat(99));
        let big = line.repeat(4000); // 400_000 bytes of 100-byte lines
        let trimmed = trim_log(big.as_bytes());
        assert!(trimmed.len() <= LOG_KEEP_BYTES);
        assert!(
            trimmed.len() >= LOG_KEEP_BYTES - 100,
            "at most one line lost"
        );
        assert_eq!(trimmed.first(), Some(&b'x'), "cut at a line start");
        assert_eq!(trimmed.last(), Some(&b'\n'), "kept whole lines only");
        assert_eq!(trimmed.len() % 100, 0);
        // A log within the budget passes through unchanged.
        assert_eq!(trim_log(line.as_bytes()), line.as_bytes());
    }

    #[test]
    fn the_analysis_tools_answer_over_the_engine() {
        let (_dir, server) = scratch_server();
        let graph = call(&server, "analysis_call_graph", json!({ "name": "alpha" }));
        assert!(graph.contains("function alpha — src/lib.rs:1"), "{graph}");
        assert!(graph.contains("alpha → beta"), "{graph}");

        let modules = call(&server, "analysis_module_graph", json!({}));
        // The bare recursive `alpha()` in other.rs resolves to both declarations of the
        // name, so its lib.rs target counts as a cross-file call too — the same honest
        // fan-out the per-symbol walk shows.
        assert!(modules.contains("2 file dependency pair(s)"), "{modules}");
        assert!(modules.contains("src → src"), "{modules}");
        assert!(modules.contains("src/caller.rs → src/lib.rs"), "{modules}");
        let narrowed = call(
            &server,
            "analysis_module_graph",
            json!({ "module": "nope" }),
        );
        assert!(narrowed.contains("0 module edge(s)"), "{narrowed}");

        let metrics = call(&server, "analysis_metrics", json!({ "limit": 10 }));
        assert!(metrics.contains("of 5 function(s)"), "{metrics}");
        assert!(metrics.contains("function alpha"), "{metrics}");

        let dead = call(&server, "analysis_dead_code", json!({}));
        assert!(dead.contains("function orphan — src/lib.rs:3"), "{dead}");
        assert!(!dead.contains("function alpha"), "{dead}");
        assert!(!dead.contains("function beta"), "{dead}");

        let security = call(&server, "analysis_security", json!({}));
        assert!(
            security.contains("[error] secret-looking literal"),
            "{security}"
        );
        assert!(security.contains("SEC-003"), "{security}");
        assert!(security.contains("other.rs:2"), "{security}");

        let cycles = call(&server, "analysis_import_cycles", json!({}));
        assert!(cycles.contains("No import cycles"), "{cycles}");
    }
}
