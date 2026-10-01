//! The Model Context Protocol server behind `ggs --mcp <folder>` (plan M4's AI bridge):
//! the persistent symbol index and the Code Analysis engine served to AI assistants over
//! stdio. One process, one repository, newline-delimited JSON-RPC 2.0 — the transport
//! every MCP client (Claude Desktop, Cline, Cursor, …) launches servers with. The
//! protocol surface is deliberately the small complete set: the `initialize` handshake,
//! `ping`, `tools/list`, `tools/call`.
//!
//! The tool surface is a progressive-disclosure ladder built for token economy: the
//! model must understand a project it cannot load without ever being handed a flood.
//! `project_overview` draws the whole picture in one bounded answer (totals, the
//! language and kind mixes, the top directories, the hub files and names, the heaviest
//! module edges); `directory_tree` walks the folder hierarchy with per-directory
//! counts, ranked and capped per level; `file_outline` opens one file's declarations
//! (with the containers the flat listings never showed); `read_file` serves explicit
//! line windows. The point tools stay: `symbol_lookup`, `symbol_references`
//! (occurrence-narrowed like the app's own Find References), `search_symbols`,
//! `search_text`, `index_status` — plus the module-17 analysis tools:
//! `analysis_call_graph`, `analysis_call_path`, `analysis_module_graph`,
//! `analysis_metrics`, `analysis_dead_code`, `analysis_security`,
//! `analysis_import_graph` and `analysis_import_cycles`. Every list-shaped tool speaks
//! the same paging contract: `limit` + `offset`, the exact total in the header, and a
//! trailer naming the continuation. stderr carries the one startup line; stdout is
//! protocol only.

use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::analysis::imports::import_graph;
use crate::analysis::metrics::enriched_rows;
use crate::analysis::modules::{module_graph, module_of, FileDep, ModuleEdge, ModuleGraph};
use crate::analysis::security::{scan_file, Finding, Severity};
use crate::analysis::{deadcode, AnalysisData, Direction};
use crate::cmd_analysis::AnalysisIndex;
use crate::cmd_fs::walk_files;
use crate::cmd_search::{search_literal, WorkspaceSymbol};
use crate::cmd_symbols::{scan_references, SymbolIndex};

/// The protocol revision we speak; a client asking for another is echoed its own (the
/// tool surface here is stable across the revisions clients ship today).
const PROTOCOL_VERSION: &str = "2025-06-18";
/// The hard ceiling every list tool's `limit` clamps to — one answer must never flood
/// the model's context; paging (`offset`) reaches the rest.
const LIST_LIMIT_MAX: u64 = 400;
/// Rows a list tool shows when the caller passes no `limit` (some tools override with
/// a default of their own where rows are heavy).
const LIST_LIMIT_DEFAULT: usize = 50;
/// `symbol_references`' default page: hit positions are cheap, but a common name has
/// thousands — the header still states the exact total.
const REFERENCES_LIMIT_DEFAULT: usize = 100;
/// `analysis_module_graph`'s default page: each edge also prints its top file pairs,
/// so an edge row costs several lines.
const MODULE_EDGES_LIMIT_DEFAULT: usize = 25;
/// Lines one `read_file` answer may carry, and the default window when the caller
/// gives no range — a first look's worth, not the whole file (token economy: the answer
/// says how to continue, and an explicit `startLine`/`endLine` window serves up to the
/// budget).
const READ_LINE_BUDGET: usize = 4000;
const READ_DEFAULT_LINES: usize = 400;
/// The largest file `read_file` serves whole — bigger ones belong to the app's viewers.
const MAX_READ_BYTES: usize = 2_000_000;
/// `project_overview`'s Top-N caps: the answer stays bounded by these on any workspace
/// size — top directories, hub files, hub names, heaviest module edges.
const OVERVIEW_DIRS: usize = 12;
const OVERVIEW_TOP: usize = 10;
const OVERVIEW_EDGES: usize = 8;
/// `directory_tree`: levels below `path`, and rows per level (subdirectories and files
/// each cap separately, the remainder named).
const DIR_DEFAULT_DEPTH: u64 = 1;
const DIR_MAX_DEPTH: u64 = 4;
const DIR_DEFAULT_TOP: usize = 15;
const DIR_MAX_TOP: u64 = 50;
/// `file_outline`'s default page — one file's declarations, a generated monster's
/// among them.
const OUTLINE_LIMIT_DEFAULT: usize = 200;
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
            // A byte cut can land inside a multi-byte character (a CJK path, an emoji in
            // any argument) — `truncate` panics on a non-boundary and the panic unwinds
            // out of `run`, killing the whole MCP server mid-session. Cut on a boundary.
            let mut cut = 120.min(brief.len());
            while !brief.is_char_boundary(cut) {
                cut -= 1;
            }
            brief.truncate(cut);
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
                "serverInfo": { "name": "git-graph-studio", "version": env!("CARGO_PKG_VERSION") },
                "instructions": MCP_INSTRUCTIONS
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
            "project_overview" => self.tool_overview(),
            "directory_tree" => self.tool_directory_tree(&args),
            "file_outline" => self.tool_file_outline(&args),
            "symbol_lookup" => self.tool_lookup(&args),
            "symbol_references" => self.tool_references(&args),
            "search_symbols" => self.tool_search(&args),
            "read_file" => self.tool_read_file(&args),
            "search_text" => self.tool_search_text(&args),
            "index_status" => Ok(self.tool_status()),
            "analysis_call_graph" => self.tool_call_graph(&args),
            "analysis_call_path" => self.tool_call_path(&args),
            "analysis_module_graph" => self.tool_module_graph(&args),
            "analysis_metrics" => self.tool_metrics(&args),
            "analysis_dead_code" => self.tool_dead_code(&args),
            "analysis_security" => self.tool_security(&args),
            "analysis_import_graph" => self.tool_import_graph(&args),
            "analysis_import_cycles" => self.tool_import_cycles(&args),
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

    /// The paging pair every list tool reads: `limit` clamped to the tool's default and
    /// the shared ceiling, `offset` from zero. Pages stay stable because every tool's
    /// row order is deterministic (path, then line — the index's own order).
    fn page_args(args: &Value, default_limit: usize) -> (usize, usize) {
        let limit = args
            .get("limit")
            .and_then(Value::as_u64)
            .unwrap_or(default_limit as u64)
            .clamp(1, LIST_LIMIT_MAX) as usize;
        let offset = args.get("offset").and_then(Value::as_u64).unwrap_or(0) as usize;
        (limit, offset)
    }

    /// The shared trailer when a page stops short of the total: the exact remainder and
    /// the one argument that reaches it.
    fn more_trailer(total: usize, offset: usize, shown: usize) -> String {
        format!(
            "{n}… +{remaining} more — repeat with offset = {next}",
            n = '\n',
            remaining = total - offset - shown,
            next = offset + shown
        )
    }

    fn tool_lookup(&self, args: &Value) -> Result<String, (i64, String)> {
        let name = Self::arg_str(args, "name")?;
        let defs = self.index.lookup(&self.root, &name).unwrap_or_default();
        Ok(match defs.as_slice() {
            [] => format!("No symbol named '{name}' is declared in the index."),
            defs => {
                let mut out = format!("{n} declaration(s) of '{name}':", n = defs.len());
                for def in defs {
                    // The container halves the guesswork a same-named fan-out leaves:
                    // "beta in Thing" is a different animal from plain "beta".
                    let container = def
                        .container
                        .as_deref()
                        .map(|c| format!(" in {c}"))
                        .unwrap_or_default();
                    out.push_str(&format!(
                        "{n}{kind} {name}{container} — {path}:{line}",
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
        let prefix = args
            .get("pathPrefix")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .replace('\\', "/");
        let (limit, offset) = Self::page_args(args, REFERENCES_LIMIT_DEFAULT);
        let narrow = self.index.files_containing(&self.root, &name);
        let files = scan_references(&self.root, &name, narrow)
            .map_err(|error| (-32603, format!("reference scan failed: {error}")))?;
        let total: usize = files
            .iter()
            .filter(|file| prefix.is_empty() || file.path.starts_with(&prefix))
            .map(|file| file.matches.len())
            .sum();
        if total == 0 {
            return Ok(format!(
                "No whole-word occurrences of '{name}'{} in the workspace's code files.",
                if prefix.is_empty() {
                    String::new()
                } else {
                    format!(" under '{prefix}'")
                }
            ));
        }
        let scope = if prefix.is_empty() {
            String::new()
        } else {
            format!(" under '{prefix}'")
        };
        let mut out = format!("{total} occurrence(s) of '{name}'{scope}:");
        let mut shown = 0usize;
        let mut skipped = 0usize;
        'hits: for file in files {
            if !prefix.is_empty() && !file.path.starts_with(&prefix) {
                continue;
            }
            for hit in &file.matches {
                if skipped < offset {
                    skipped += 1;
                    continue;
                }
                if shown >= limit {
                    break 'hits;
                }
                out.push_str(&format!(
                    "{n}{path}:{line}:{column}",
                    n = '\n',
                    path = file.path,
                    line = hit.line,
                    column = hit.column
                ));
                shown += 1;
            }
        }
        if offset + shown < total {
            out.push_str(&Self::more_trailer(total, offset, shown));
            if prefix.is_empty() {
                out.push_str(" — or narrow with pathPrefix");
            }
        }
        Ok(out)
    }

    /// `project_overview`: the whole project in one bounded answer — the ladder's entry
    /// rung. Whatever the workspace's size, the answer stays within the Top-N caps:
    /// totals, the language and kind mixes, the directories that carry the code, the
    /// hub files and names, the heaviest module edges — each line naming the tool that
    /// drills in next. An AI's cheapest path to the lay of the land.
    fn tool_overview(&self) -> Result<String, (i64, String)> {
        let status = self.index.status(&self.root);
        let files = self.index.files_with_counts(&self.root).unwrap_or_default();
        let mut out = format!(
            "{root}{n}index {state} — {files} indexed file(s), {symbols} symbol(s)",
            n = '\n',
            root = self.root,
            state = serde_json::to_string(&status.state).unwrap_or_default(),
            files = status.files,
            symbols = status.symbols
        );
        if files.is_empty() {
            out.push_str(
                "\nNo indexed source files — the directory and symbol tools answer \
                 empty until the index lands.",
            );
            return Ok(out);
        }
        // The language mix by file suffix, the kind mix from the store's kind bytes —
        // two of the cheapest aggregates the index serves.
        let mut by_suffix: HashMap<&str, usize> = HashMap::new();
        for (path, count) in &files {
            let suffix = path.rsplit_once('.').map(|(_, s)| s).unwrap_or("none");
            *by_suffix.entry(suffix).or_default() += count;
        }
        let mut langs: Vec<(&str, usize)> = by_suffix.into_iter().collect();
        langs.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(b.0)));
        let mix = |rows: Vec<(&str, usize)>| {
            rows.iter()
                .take(5)
                .map(|(name, count)| format!("{name} {count}"))
                .collect::<Vec<_>>()
                .join(" · ")
        };
        out.push_str(&format!(
            "{n}languages (symbols): {langs}",
            n = '\n',
            langs = mix(langs)
        ));
        let kinds = self.index.kind_counts(&self.root).unwrap_or_default();
        out.push_str(&format!(
            "{n}kinds: {kinds}",
            n = '\n',
            kinds = kinds
                .iter()
                .map(|(kind, count)| format!("{kind} {count}"))
                .collect::<Vec<_>>()
                .join(" · ")
        ));
        // Top directories by the symbols inside (first path segment; "(root)" for the
        // files directly under the workspace root).
        let mut dirs: HashMap<&str, (usize, usize)> = HashMap::new();
        for (path, count) in &files {
            let dir = path.split_once('/').map(|(d, _)| d).unwrap_or("(root)");
            let entry = dirs.entry(dir).or_default();
            entry.0 += 1;
            entry.1 += count;
        }
        let mut dir_rows: Vec<(&str, (usize, usize))> = dirs.into_iter().collect();
        dir_rows.sort_by(|a, b| b.1 .1.cmp(&a.1 .1).then_with(|| a.0.cmp(b.0)));
        out.push_str("\ntop directories by symbols (directory_tree drills in):");
        for (dir, (file_count, symbols)) in dir_rows.iter().take(OVERVIEW_DIRS) {
            out.push_str(&format!(
                "{n}  {dir} — {files} file(s), {symbols} symbol(s)",
                n = '\n',
                files = file_count
            ));
        }
        // The hub files: where the declarations concentrate.
        let mut hub_files: Vec<&(String, usize)> = files.iter().collect();
        hub_files.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        out.push_str("\nhub files by declarations (file_outline opens one):");
        for (path, count) in hub_files.iter().take(OVERVIEW_TOP) {
            out.push_str(&format!("{n}  {path} — {count} symbol(s)", n = '\n'));
        }
        // The hub names: what the codebase keeps spelling — the overview's proxy for
        // "important", straight from the occurrence lists.
        let hub_names = self
            .index
            .top_names_by_refs(&self.root, OVERVIEW_TOP)
            .unwrap_or_default();
        if !hub_names.is_empty() {
            out.push_str(
                "\nhub names by files containing them (symbol_references lists every site):",
            );
            for (name, count) in &hub_names {
                out.push_str(&format!("{n}  {name} — {count} file(s)", n = '\n'));
            }
        }
        // The analysis half, one lock: the heaviest module edges and the dead-code
        // candidate count — both cheap over the built tables, and both degrade to a
        // note when the analysis has not landed.
        match self.analysis_data() {
            Err(_) => {
                out.push_str("\nanalysis: still building — the analysis tools answer once it lands")
            }
            Ok(data) => {
                let data = data.lock().unwrap();
                let graph = module_graph(&data, &[]);
                if graph.edges.is_empty() {
                    out.push_str("\nmodule graph: no cross-file calls");
                } else {
                    out.push_str(&format!(
                        "{n}module graph: {modules} module(s), {pairs} file pair(s), {calls} cross-file call(s) — heaviest edges (analysis_module_graph lists all):",
                        n = '\n',
                        modules = graph.modules.len(),
                        pairs = graph.total_file_edges,
                        calls = graph.total_calls
                    ));
                    for edge in graph.edges.iter().take(OVERVIEW_EDGES) {
                        out.push_str(&format!(
                            "{n}  {from} → {to}  {calls} call(s)",
                            n = '\n',
                            from = edge.from,
                            to = edge.to,
                            calls = edge.calls
                        ));
                    }
                }
                out.push_str(&format!(
                    "{n}dead code: {dead} candidate(s) (analysis_dead_code lists them)",
                    n = '\n',
                    dead = deadcode::dead_rows(&data, false).len()
                ));
            }
        }
        out.push_str(
            "\ndrill down: directory_tree(path, depth) → file_outline(path) → read_file(path, startLine)",
        );
        Ok(out)
    }

    /// `directory_tree`: the folder hierarchy with per-directory counts — the ladder's
    /// second rung. Subdirectories rank by the symbols in their subtree, files by their
    /// declarations; each level caps at `top` rows and names the remainder, so the
    /// answer's size is the caller's choice, never the workspace's.
    fn tool_directory_tree(&self, args: &Value) -> Result<String, (i64, String)> {
        let asked = args
            .get("path")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .replace('\\', "/");
        let depth = args
            .get("depth")
            .and_then(Value::as_u64)
            .unwrap_or(DIR_DEFAULT_DEPTH)
            .clamp(1, DIR_MAX_DEPTH) as usize;
        let top = args
            .get("top")
            .and_then(Value::as_u64)
            .unwrap_or(DIR_DEFAULT_TOP as u64)
            .clamp(1, DIR_MAX_TOP) as usize;
        // A directory prefix ends in '/' (the root's is "") — a bare "src" must not
        // half-match "src-extra.rs".
        let prefix = if asked.is_empty() {
            String::new()
        } else {
            format!("{}/", asked.trim_end_matches('/'))
        };
        let files = self.index.files_with_counts(&self.root).unwrap_or_default();
        let scoped: Vec<&(String, usize)> = files
            .iter()
            .filter(|(path, _)| path.starts_with(&prefix))
            .collect();
        if scoped.is_empty() {
            return Ok(format!("The index has no files under '{prefix}'."));
        }
        let symbols: usize = scoped.iter().map(|(_, count)| count).sum();
        let label = if prefix.is_empty() {
            "(root)".to_owned()
        } else {
            prefix.trim_end_matches('/').to_owned()
        };
        let mut out = format!("{label} — {} file(s), {symbols} symbol(s):", scoped.len());
        render_dir_level(&mut out, &scoped, &prefix, depth, top, "");
        Ok(out)
    }

    /// `file_outline`: one file's declarations — kind, name, 1-based line, how many
    /// files reference the name, and the container (a method's class) the index has
    /// always carried but the flat listings never showed. Bounded by its own page.
    fn tool_file_outline(&self, args: &Value) -> Result<String, (i64, String)> {
        let path = Self::arg_str(args, "path")?.replace('\\', "/");
        let (limit, offset) = Self::page_args(args, OUTLINE_LIMIT_DEFAULT);
        let Some(rows) = self.index.file_symbols(&self.root, &path) else {
            return Ok(format!(
                "The index has no file at '{path}' — directory_tree lists what is there."
            ));
        };
        if rows.is_empty() {
            return Ok(format!("{path} declares no symbols the parsers recognize."));
        }
        let mut out = format!("{path} — {} symbol(s):", rows.len());
        let mut shown = 0usize;
        for row in rows.iter().skip(offset) {
            if shown >= limit {
                break;
            }
            let container = row
                .container
                .as_deref()
                .map(|c| format!("  in {c}"))
                .unwrap_or_default();
            out.push_str(&format!(
                "{n}  {kind} {name}  line {line}{container}  refs {refs}",
                n = '\n',
                kind = row.kind,
                name = row.name,
                line = row.line + 1,
                refs = row.refs
            ));
            shown += 1;
        }
        if offset + shown < rows.len() {
            out.push_str(&Self::more_trailer(rows.len(), offset, shown));
        }
        Ok(out)
    }

    fn tool_search(&self, args: &Value) -> Result<String, (i64, String)> {
        let query = Self::arg_str(args, "query")?.to_lowercase();
        let kind = args
            .get("kind")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .filter(|kind| !kind.is_empty());
        let (limit, offset) = Self::page_args(args, LIST_LIMIT_DEFAULT);
        let symbols = self.index.all_symbols(&self.root).unwrap_or_default();
        let hits: Vec<&WorkspaceSymbol> = symbols
            .iter()
            .filter(|symbol| {
                symbol.name.to_lowercase().contains(&query)
                    && kind.as_deref().is_none_or(|want| symbol.kind == want)
            })
            .collect();
        if hits.is_empty() {
            let kind_note = kind
                .as_deref()
                .map(|kind| format!(" of kind '{kind}'"))
                .unwrap_or_default();
            return Ok(format!("No symbol name contains '{query}'{kind_note}."));
        }
        let mut out = format!("{} symbol(s) matching '{query}':", hits.len());
        let mut shown = 0usize;
        for hit in hits.iter().skip(offset) {
            if shown >= limit {
                break;
            }
            out.push_str(&format!(
                "{n}{kind} {hit_name} — {path}:{line}",
                n = '\n',
                kind = hit.kind,
                hit_name = hit.name,
                path = hit.path,
                line = hit.line + 1
            ));
            shown += 1;
        }
        if offset + shown < hits.len() {
            out.push_str(&Self::more_trailer(hits.len(), offset, shown));
        }
        Ok(out)
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
        // Token economy: a read without any line range takes a look, not the whole
        // file — the default window is the first look's worth, and the answer says how
        // to continue. An explicit startLine (open-ended) or window still serves up to
        // READ_LINE_BUDGET.
        let no_range = end.is_none() && args.get("startLine").is_none();
        let window_cap = if no_range {
            READ_DEFAULT_LINES
        } else {
            READ_LINE_BUDGET
        };
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
            .take(window_cap)
            .collect();
        let last = begin + window.len() - 1;
        let mut out = format!("{path} — lines {begin}–{last} of {total}:");
        for line in &window {
            out.push('\n');
            out.push_str(line.trim_end_matches('\r'));
        }
        // The window was cut short by the cap (not by the caller's own endLine): say
        // so, and where to continue.
        if last < stop {
            out.push_str(&format!(
                "{n}… truncated — {last} of {total} lines shown; continue with startLine = {}",
                last + 1,
                n = '\n'
            ));
        }
        Ok(out)
    }

    /// `search_text`: a literal, case-insensitive search across the repository's files —
    /// the app's Workspace Search, paged like every list tool.
    fn tool_search_text(&self, args: &Value) -> Result<String, (i64, String)> {
        let query = Self::arg_str(args, "query")?;
        let prefix = args
            .get("path")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .replace('\\', "/");
        let (limit, offset) = Self::page_args(args, LIST_LIMIT_DEFAULT);
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
        let mut skipped = 0usize;
        let mut shown = 0usize;
        'files: for file in &outcome.files {
            for hit in &file.matches {
                if skipped < offset {
                    skipped += 1;
                    continue;
                }
                if shown >= limit {
                    break 'files;
                }
                out.push_str(&format!(
                    "{n}{path}:{line}: {text}",
                    n = '\n',
                    path = file.path,
                    line = hit.line,
                    text = hit.text.trim_end_matches('\r')
                ));
                shown += 1;
            }
        }
        if offset + shown < total {
            out.push_str(&Self::more_trailer(total, offset, shown));
        }
        Ok(out)
    }

    /* ---------- The module-17 analysis tools ---------- */

    fn tool_module_graph(&self, args: &Value) -> Result<String, (i64, String)> {
        let module = args
            .get("module")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let (limit, offset) = Self::page_args(args, MODULE_EDGES_LIMIT_DEFAULT);
        let data = self.analysis_data()?;
        let graph: ModuleGraph = {
            let data = data.lock().unwrap();
            module_graph(&data, &[])
        };
        if graph.edges.is_empty() {
            return Ok("No cross-file calls in the analysis.".to_owned());
        }
        // The edges arrive ranked by call count — the architecture's busiest routes
        // first, so a page of them is the most informative page there is.
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
            "{modules} module(s), {pairs} file dependency pair(s), {calls} cross-file call(s); {shown} of {total} module edge(s):",
            modules = graph.modules.len(),
            pairs = graph.total_file_edges,
            calls = graph.total_calls,
            shown = edges.len().min(offset + limit).saturating_sub(offset),
            total = edges.len()
        );
        let mut shown = 0usize;
        for edge in edges.iter().skip(offset) {
            if shown >= limit {
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
            shown += 1;
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
            }
        }
        if offset + shown < edges.len() {
            out.push_str(&Self::more_trailer(edges.len(), offset, shown));
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
        // A walk is not a flat list — there is no offset to page. `limit` bounds the
        // node and edge lists (the header keeps the true counts), and maxDepth remains
        // the real lever when a hub function's neighbourhood outruns the cap.
        let limit = args
            .get("limit")
            .and_then(Value::as_u64)
            .unwrap_or(LIST_LIMIT_MAX)
            .clamp(1, LIST_LIMIT_MAX) as usize;
        let cut_note = |out: &mut String, what: &str, total: usize, shown: usize| {
            if shown < total {
                out.push_str(&format!(
                        "{n}… +{more} more {what} — narrow with maxDepth, or raise limit (cap {LIST_LIMIT_MAX})",
                        n = '\n',
                        more = total - shown
                    ));
            }
        };
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
        let mut shown = 0usize;
        for node in graph.nodes.iter().take(limit) {
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
            shown += 1;
        }
        cut_note(&mut out, "node(s)", graph.nodes.len(), shown);
        let mut shown = 0usize;
        for edge in graph.edges.iter().take(limit) {
            out.push_str(&format!(
                "{n}{from_name} → {to_name}  at {path}:{line}",
                n = '\n',
                from_name = edge.from.name,
                to_name = edge.to.name,
                path = edge.call_path,
                line = edge.call_line + 1
            ));
            shown += 1;
        }
        cut_note(&mut out, "edge(s)", graph.edges.len(), shown);
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
        let prefix = args
            .get("path")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .replace('\\', "/");
        let data = self.analysis_data()?;
        let rows = {
            let data = data.lock().unwrap();
            enriched_rows(&data, &|_| 0, data.root())
        };
        let mut rows = rows;
        // The hotspot ranking is repository-wide by design; `path` scopes it when the
        // task is one area's hotspots, not the whole world's.
        rows.retain(|row| prefix.is_empty() || row.path.starts_with(&prefix));
        rows.sort_by(|a, b| {
            b.hotspot
                .cmp(&a.hotspot)
                .then(b.complexity.cmp(&a.complexity))
        });
        if rows.is_empty() {
            let scope = if prefix.is_empty() {
                String::new()
            } else {
                format!(" under '{prefix}'")
            };
            return Ok(format!("The analysis has no functions to measure{scope}."));
        }
        let scope = if prefix.is_empty() {
            String::new()
        } else {
            format!(" under '{prefix}'")
        };
        let mut out = format!(
            "Top {shown} of {total} function(s){scope} by hotspot (complexity × references):",
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
        let prefix = args
            .get("path")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .replace('\\', "/");
        let (limit, offset) = Self::page_args(args, LIST_LIMIT_DEFAULT);
        let data = self.analysis_data()?;
        let rows = {
            let data = data.lock().unwrap();
            deadcode::dead_rows(&data, include_exported)
        };
        let rows: Vec<_> = rows
            .into_iter()
            .filter(|row| prefix.is_empty() || row.path.starts_with(&prefix))
            .collect();
        if rows.is_empty() {
            let scope = if prefix.is_empty() {
                String::new()
            } else {
                format!(" under '{prefix}'")
            };
            return Ok(format!(
                "No uncalled declarations found{scope} (exported declarations are excluded \
                 unless includeExported is true)."
            ));
        }
        let scope = if prefix.is_empty() {
            String::new()
        } else {
            format!(" under '{prefix}'")
        };
        let mut out = format!(
            "{total} declaration(s) no call site in this repository spells{scope}:",
            total = rows.len()
        );
        let mut shown = 0usize;
        for row in rows.iter().skip(offset) {
            if shown >= limit {
                break;
            }
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
            shown += 1;
        }
        if offset + shown < rows.len() {
            out.push_str(&Self::more_trailer(rows.len(), offset, shown));
        }
        Ok(out)
    }

    fn tool_security(&self, args: &Value) -> Result<String, (i64, String)> {
        // The severity filter speaks the report's own words ("error", "warning", "info").
        let severity = args
            .get("severity")
            .and_then(Value::as_str)
            .and_then(|asked| match asked.to_lowercase().as_str() {
                "error" => Some(Severity::Error),
                "warning" => Some(Severity::Warning),
                "info" => Some(Severity::Info),
                _ => None,
            });
        let severity_name = |severity: Severity| {
            serde_json::to_string(&severity)
                .unwrap_or_default()
                .trim_matches('"')
                .to_owned()
        };
        let scope = severity
            .map(|want| format!(" of severity '{}'", severity_name(want)))
            .unwrap_or_default();
        let (limit, offset) = Self::page_args(args, LIST_LIMIT_DEFAULT);
        let data = self.analysis_data()?;
        let mut findings: Vec<Finding> = Vec::new();
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
                    if severity.is_none_or(|want| finding.severity == want) {
                        findings.push(finding);
                    }
                }
            }
        }
        if findings.is_empty() {
            return Ok(format!("No security rule findings{scope}."));
        }
        // Errors first, then warnings, then info — the page's order, and the order an
        // AI should triage in; within a severity the file order stays deterministic.
        findings.sort_by_key(|finding| match finding.severity {
            Severity::Error => 0,
            Severity::Warning => 1,
            Severity::Info => 2,
        });
        let mut out = format!("{total} finding(s){scope}:", total = findings.len());
        let mut shown = 0usize;
        for finding in findings.iter().skip(offset) {
            if shown >= limit {
                break;
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
            shown += 1;
        }
        if offset + shown < findings.len() {
            out.push_str(&Self::more_trailer(findings.len(), offset, shown));
        }
        Ok(out)
    }

    /// `analysis_import_graph`: the full file dependency graph — every import resolved
    /// to a workspace file, not only the cycles.
    fn tool_import_graph(&self, args: &Value) -> Result<String, (i64, String)> {
        let prefix = args
            .get("path")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .replace('\\', "/");
        let (limit, offset) = Self::page_args(args, LIST_LIMIT_DEFAULT);
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
        let mut shown = 0usize;
        for (from, to) in edges.iter().skip(offset) {
            if shown >= limit {
                break;
            }
            out.push_str(&format!("{n}{from} → {to}", n = '\n'));
            shown += 1;
        }
        if offset + shown < edges.len() {
            out.push_str(&Self::more_trailer(edges.len(), offset, shown));
        }
        Ok(out)
    }

    fn tool_import_cycles(&self, args: &Value) -> Result<String, (i64, String)> {
        let (limit, offset) = Self::page_args(args, MODULE_EDGES_LIMIT_DEFAULT);
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
        let mut shown = 0usize;
        for cycle in graph.cycles.iter().skip(offset) {
            if shown >= limit {
                break;
            }
            out.push_str(&format!("\n{}", cycle.join(" → ")));
            shown += 1;
        }
        if offset + shown < graph.cycles.len() {
            out.push_str(&Self::more_trailer(graph.cycles.len(), offset, shown));
        }
        Ok(out)
    }
}

/* ---------- The call log the MCP page reads ---------- */

/// One level of `directory_tree`'s walk: the subdirectories (each with its subtree's
/// file and symbol counts, most symbols first) and the files directly inside, each list
/// capped at `top` rows with the remainder named. `depth` levels recurse, the deeper
/// ones indented under their directory row.
fn render_dir_level(
    out: &mut String,
    scoped: &[&(String, usize)],
    prefix: &str,
    depth: usize,
    top: usize,
    indent: &str,
) {
    let mut dirs: std::collections::BTreeMap<String, (usize, usize)> =
        std::collections::BTreeMap::new();
    let mut direct: Vec<(&String, usize)> = Vec::new();
    for (path, count) in scoped {
        match path[prefix.len()..].split_once('/') {
            Some((segment, _)) => {
                let stats = dirs.entry(format!("{prefix}{segment}")).or_default();
                stats.0 += 1;
                stats.1 += *count;
            }
            None => direct.push((path, *count)),
        }
    }
    let mut dir_rows: Vec<(&String, &(usize, usize))> = dirs.iter().collect();
    dir_rows.sort_by(|a, b| (b.1).1.cmp(&(a.1).1).then_with(|| a.0.cmp(b.0)));
    for (index, (dir, (files, symbols))) in dir_rows.iter().enumerate() {
        if index >= top {
            let more = dir_rows.len() - index;
            out.push_str(&format!(
                "{n}{indent}… +{more} more — raise top or drill with path",
                n = '\n'
            ));
            break;
        }
        out.push_str(&format!(
            "{n}{indent}{name}/ — {files} file(s), {symbols} symbol(s)",
            n = '\n',
            name = &dir[prefix.len()..]
        ));
        if depth > 1 {
            let child_prefix = format!("{dir}/");
            let child: Vec<&(String, usize)> = scoped
                .iter()
                .filter(|(path, _)| path.starts_with(&child_prefix))
                .copied()
                .collect();
            render_dir_level(
                out,
                &child,
                &child_prefix,
                depth - 1,
                top,
                &format!("{indent}  "),
            );
        }
    }
    direct.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(b.0)));
    for (index, (path, count)) in direct.iter().enumerate() {
        if index >= top {
            out.push_str(&format!(
                "{n}{indent}… +{more} more file(s) — raise top or narrow with path",
                n = '\n',
                more = direct.len() - index
            ));
            break;
        }
        out.push_str(&format!(
            "{n}{indent}{file} — {count} symbol(s)",
            n = '\n',
            file = &path[prefix.len()..]
        ));
    }
}

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
            "name": "project_overview",
            "description": "The whole project in one bounded answer: totals, the language and kind mixes, the top directories with file/symbol counts, the hub files and hub names, the heaviest module edges and the dead-code count. START HERE — whatever the repository's size, this answer stays small, and every line names the tool that drills in.",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "directory_tree",
            "description": "The folder hierarchy with per-directory file and symbol counts: subdirectories ranked by the symbols in their subtree, files by their declarations, each level capped at `top` rows with the remainder named. The drill-down from project_overview.",
            "inputSchema": { "type": "object", "properties": {
                "path": { "type": "string", "description": "Directory to walk (repo-relative; default the root)" },
                "depth": { "type": "number", "description": "Directory levels below path (1-4, default 1)" },
                "top": { "type": "number", "description": "Rows per level (1-50, default 15)" }
            } }
        },
        {
            "name": "file_outline",
            "description": "One file's declarations: kind, name, 1-based line, how many files reference the name, and the enclosing type (a method's class) when the index carries one.",
            "inputSchema": { "type": "object", "properties": {
                "path": { "type": "string", "description": "Repo-relative file path" },
                "limit": { "type": "number", "description": "Rows per page (1-400, default 200)" },
                "offset": { "type": "number", "description": "Skip this many rows (paging)" }
            }, "required": ["path"] }
        },
        {
            "name": "symbol_lookup",
            "description": "Every declaration of exactly this symbol name in the repository: kind, container, file and 1-based line. Start here to find where something is defined.",
            "inputSchema": { "type": "object", "properties": { "name": { "type": "string", "description": "The exact symbol name" } }, "required": ["name"] }
        },
        {
            "name": "symbol_references",
            "description": "Every whole-word occurrence of this symbol name across the repository's code files, as file:line:column — the Find References of the app. The header states the exact total; `limit`/`offset` page through it, `pathPrefix` narrows it.",
            "inputSchema": { "type": "object", "properties": {
                "name": { "type": "string", "description": "The exact symbol name" },
                "pathPrefix": { "type": "string", "description": "Repo-relative path prefix to narrow to, e.g. \"src/\"" },
                "limit": { "type": "number", "description": "Hits per page (1-400, default 100)" },
                "offset": { "type": "number", "description": "Skip this many hits (paging)" }
            }, "required": ["name"] }
        },
        {
            "name": "search_symbols",
            "description": "Symbol names containing the query (case-insensitive), with kind, file and line; optional `kind` filters (function, method, class, struct, interface, enum, module, type, macro). The header states the total; `limit`/`offset` page.",
            "inputSchema": { "type": "object", "properties": {
                "query": { "type": "string" },
                "kind": { "type": "string", "description": "Only this symbol kind" },
                "limit": { "type": "number", "description": "Hits per page (1-400, default 50)" },
                "offset": { "type": "number", "description": "Skip this many hits (paging)" }
            }, "required": ["query"] }
        },
        {
            "name": "read_file",
            "description": "One repository file's text (UTF-8, up to 2 MB). Without a line range the first 400 lines answer (enough for a first look); pass startLine/endLine (1-based, inclusive) for more — windows cap at 4000 lines.",
            "inputSchema": { "type": "object", "properties": { "path": { "type": "string", "description": "Repo-relative file path" }, "startLine": { "type": "number", "description": "First line to show (1-based)" }, "endLine": { "type": "number", "description": "Last line to show (inclusive)" } }, "required": ["path"] }
        },
        {
            "name": "search_text",
            "description": "A literal, case-insensitive text search across the repository's files — every hit as path:line: text. The header states the exact total; `limit`/`offset` page, `path` narrows the scan.",
            "inputSchema": { "type": "object", "properties": {
                "query": { "type": "string" },
                "path": { "type": "string", "description": "Repo-relative path prefix to narrow to" },
                "limit": { "type": "number", "description": "Hits per page (1-400, default 50)" },
                "offset": { "type": "number", "description": "Skip this many hits (paging)" }
            }, "required": ["query"] }
        },
        {
            "name": "index_status",
            "description": "Which repository is indexed, its state, and the file / symbol counts.",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "analysis_call_graph",
            "description": "The call graph around every declaration of a name: callers or callees up to maxDepth (default 2), with each edge's call site. Resolution is name-based with receiver hints — same-named declarations fan out. `limit` caps the node and edge lists.",
            "inputSchema": { "type": "object", "properties": { "name": { "type": "string" }, "direction": { "type": "string", "enum": ["callers", "callees"], "description": "Which way to walk (default callees)" }, "maxDepth": { "type": "number", "description": "Levels to walk (1-6, default 2)" }, "limit": { "type": "number", "description": "Node and edge cap (1-400, default 400)" } }, "required": ["name"] }
        },
        {
            "name": "analysis_call_path",
            "description": "A shortest chain of calls between two declarations, by name: how control reaches `to` from `from`, as function — file:line steps.",
            "inputSchema": { "type": "object", "properties": { "from": { "type": "string", "description": "The starting function's name" }, "to": { "type": "string", "description": "The target function's name" } }, "required": ["from", "to"] }
        },
        {
            "name": "analysis_module_graph",
            "description": "The workspace's cross-file calls as module dependencies, edges ranked by call count (the busiest routes first) with the file pairs that carry them. Optional `module` narrows to that module's edges; `limit`/`offset` page.",
            "inputSchema": { "type": "object", "properties": {
                "module": { "type": "string", "description": "A module (directory) name to narrow to, e.g. \"src\"; the workspace root is \"\"" },
                "limit": { "type": "number", "description": "Edges per page (1-400, default 25)" },
                "offset": { "type": "number", "description": "Skip this many edges (paging)" }
            } }
        },
        {
            "name": "analysis_metrics",
            "description": "Functions ranked by hotspot (cyclomatic complexity × references): complexity, cognitive complexity, maintainability index, lines, parameters and nesting per function. Optional `path` scopes the ranking to one area.",
            "inputSchema": { "type": "object", "properties": {
                "limit": { "type": "number", "description": "How many top functions to list (1-200, default 20)" },
                "path": { "type": "string", "description": "Repo-relative path prefix to scope to" }
            } }
        },
        {
            "name": "analysis_dead_code",
            "description": "Functions and methods no call site in the repository spells — conservative candidates, not verdicts; exported declarations are excluded unless includeExported is true. Optional `path` scopes; `limit`/`offset` page.",
            "inputSchema": { "type": "object", "properties": {
                "includeExported": { "type": "boolean", "description": "Also list exported declarations (default false)" },
                "path": { "type": "string", "description": "Repo-relative path prefix to scope to" },
                "limit": { "type": "number", "description": "Rows per page (1-400, default 50)" },
                "offset": { "type": "number", "description": "Skip this many rows (paging)" }
            } }
        },
        {
            "name": "analysis_security",
            "description": "The rule-based security scan: hardcoded secrets, dangerous and weak-crypto APIs, each finding with severity and CWE — errors first. Optional `severity` filters (error, warning, info); `limit`/`offset` page.",
            "inputSchema": { "type": "object", "properties": {
                "severity": { "type": "string", "enum": ["error", "warning", "info"], "description": "Only this severity" },
                "limit": { "type": "number", "description": "Rows per page (1-400, default 50)" },
                "offset": { "type": "number", "description": "Skip this many rows (paging)" }
            } }
        },
        {
            "name": "analysis_import_graph",
            "description": "The full file dependency graph — every import resolved to a workspace file, as from → to edges (import statements, not calls; analysis_module_graph maps the calls). Optional `path` prefix narrows; `limit`/`offset` page.",
            "inputSchema": { "type": "object", "properties": {
                "path": { "type": "string", "description": "Repo-relative path prefix to narrow to" },
                "limit": { "type": "number", "description": "Edges per page (1-400, default 50)" },
                "offset": { "type": "number", "description": "Skip this many edges (paging)" }
            } }
        },
        {
            "name": "analysis_import_cycles",
            "description": "The file dependency graph's strongly-connected components — every import cycle, as chains of file names. `limit`/`offset` page.",
            "inputSchema": { "type": "object", "properties": {
                "limit": { "type": "number", "description": "Cycles per page (1-400, default 25)" },
                "offset": { "type": "number", "description": "Skip this many cycles (paging)" }
            } }
        }
    ])
}

fn error_response(id: Value, code: i64, message: &str) -> String {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } }).to_string()
}

/// The workflow guidance the initialize handshake hands the model: what this server
/// indexes and which tool serves which step of a code task. This is the lever that
/// turns the tool catalogue from available to actually used well — written for token
/// economy: start small, drill down, page deliberately, never ask for a flood.
const MCP_INSTRUCTIONS: &str = "\
Git Graph Studio's symbol index and analysis engine over this repository. The index is \
persistent and already warm — the desktop app shares it — so lookups answer in \
milliseconds; prefer these tools over reading files blind or grepping.\n\n\
HOW TO SEE THE PROJECT (cheapest first): `project_overview` draws the whole picture in \
one small answer — totals, languages, the directories that carry the code, the hub \
files and names, the heaviest module edges. Drill from there: `directory_tree` \
(path, depth) walks the hierarchy with per-directory counts, `file_outline` (path) \
opens one file's declarations, `read_file` (path, startLine) serves an exact line \
window. Never page a whole workspace when a bounded level answers first.\n\n\
PAGING: every list tool takes `limit` and `offset`. The header always states the exact \
total and a truncated answer ends with the offset that reaches the rest — follow it \
instead of re-counting, and narrow with the path/kind/severity filters before paging \
far.\n\n\
Suggested workflow:\n\
- BEFORE editing: `symbol_lookup` / `symbol_references` to map a name's declarations \
and every use; `analysis_call_graph` (callers/callees) to see the blast radius of a \
change; `analysis_metrics` (path-scoped) to find the file's hotspots before touching \
them.\n\
- Planning a refactor: `analysis_module_graph` for the module dependencies a move \
would cut across (edges arrive busiest-first), `analysis_import_cycles` for the \
tangles worth breaking while you are there.\n\
- AFTER editing: re-run `analysis_metrics` on your changed functions, `\
analysis_dead_code` for what your change orphaned, `analysis_security` for secrets \
and dangerous APIs you may have introduced.\n\
- Navigation beats guessing: `search_symbols` for fuzzy names, `read_file` with a \
line window to confirm a site before editing it. Resolution is name-based with \
receiver hints — same-named declarations fan out, so confirm the file before you edit.";

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

    #[test]
    fn the_call_log_survives_a_multibyte_brief() {
        // The brief used to truncate at a raw byte: a long CJK argument put the cut
        // inside a multi-byte character, String::truncate PANICKED, and the panic
        // unwound out of `run` — the whole MCP server died mid-session.
        let (dir, server) = scratch_server();
        let query = "仓颉".repeat(40); // 240 bytes — the 120-byte cut lands inside a char
        let line = format!(
            r#"{{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{{"name":"search_text","arguments":{{"query":"{query}"}}}}}}"#
        );
        let answer = reply(&server, &line);
        // Whatever the tool answered, the server lived — and the log records the call.
        assert!(
            answer["result"].is_object() || answer["error"].is_object(),
            "{answer}"
        );
        let log = std::fs::read_to_string(&server.log_path).expect("the call log");
        assert!(log.contains("search_text"), "{log}");
        let _ = &dir;
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
        // The workflow guidance rides the handshake — the lever that turns the tool
        // catalogue from available to used well.
        let instructions = response["result"]["instructions"]
            .as_str()
            .unwrap_or_default();
        assert!(instructions.contains("BEFORE editing"), "{instructions}");
        assert!(
            instructions.contains("analysis_dead_code"),
            "{instructions}"
        );
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
                "project_overview",
                "directory_tree",
                "file_outline",
                "symbol_lookup",
                "symbol_references",
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
    fn lookup_references_outline_search_and_status_answer_over_the_index() {
        let (_dir, server) = scratch_server();
        let lookup = call(&server, "symbol_lookup", json!({ "name": "beta" }));
        assert!(lookup.contains("function beta — src/lib.rs:2"), "{lookup}");

        let references = call(&server, "symbol_references", json!({ "name": "alpha" }));
        assert!(references.contains("src/lib.rs:1:8"), "{references}");
        assert!(
            references.contains("other.rs:1:4") && references.contains("other.rs:1:14"),
            "{references}"
        );

        // file_outline: one file's declarations, containers and ref counts included.
        let outline = call(&server, "file_outline", json!({ "path": "src/lib.rs" }));
        assert!(outline.contains("src/lib.rs — 3 symbol(s):"), "{outline}");
        assert!(
            outline.contains("function alpha  line 1  refs 2"),
            "{outline}"
        );
        assert!(
            outline.contains("function beta  line 2  refs 2"),
            "{outline}"
        );
        let missing = call(&server, "file_outline", json!({ "path": "missing.rs" }));
        assert!(missing.contains("The index has no file at"), "{missing}");

        let search = call(&server, "search_symbols", json!({ "query": "ALP" }));
        assert!(
            search.contains("alpha") && search.contains("src/lib.rs"),
            "{search}"
        );

        let status = call(&server, "index_status", json!({}));
        assert!(status.contains("state \"ready\""), "{status}");
        assert!(status.contains("symbols 5"), "{status}");
    }

    /// Token economy's entry rung: whatever the workspace's size, `project_overview`
    /// answers the whole picture within the Top-N caps — totals, mixes, directories,
    /// hubs, module edges, dead count — each line naming its drill-down.
    #[test]
    fn project_overview_answers_the_whole_picture_in_one_bounded_answer() {
        let (_dir, server) = scratch_server();
        let overview = call(&server, "project_overview", json!({}));
        assert!(
            overview.contains("index \"ready\" — 3 indexed file(s), 5 symbol(s)"),
            "{overview}"
        );
        assert!(overview.contains("languages (symbols): rs 5"), "{overview}");
        assert!(overview.contains("kinds: function 5"), "{overview}");
        assert!(
            overview.contains("top directories by symbols"),
            "{overview}"
        );
        assert!(
            overview.contains("src — 2 file(s), 4 symbol(s)"),
            "{overview}"
        );
        assert!(
            overview.contains("(root) — 1 file(s), 1 symbol(s)"),
            "{overview}"
        );
        assert!(overview.contains("hub files by declarations"), "{overview}");
        assert!(overview.contains("src/lib.rs — 3 symbol(s)"), "{overview}");
        assert!(
            overview.contains("hub names by files containing them"),
            "{overview}"
        );
        assert!(overview.contains("alpha — 2 file(s)"), "{overview}");
        assert!(overview.contains("module graph:"), "{overview}");
        assert!(overview.contains("src → src"), "{overview}");
        assert!(overview.contains("dead code: 1 candidate(s)"), "{overview}");
        assert!(
            overview.contains("drill down: directory_tree"),
            "{overview}"
        );
        assert!(
            overview.lines().count() <= 80,
            "the answer stays bounded: {} lines",
            overview.lines().count()
        );
    }

    /// The ladder's second rung: per-directory counts, children ranked by symbols,
    /// depth expanding below the asked path — and a miss answers helpful text.
    #[test]
    fn directory_tree_walks_levels_ranked_and_scoped() {
        let (_dir, server) = scratch_server();
        let root = call(&server, "directory_tree", json!({}));
        assert!(root.contains("(root) — 3 file(s), 5 symbol(s):"), "{root}");
        assert!(root.contains("src/ — 2 file(s), 4 symbol(s)"), "{root}");
        assert!(root.contains("other.rs — 1 symbol(s)"), "{root}");

        let deep = call(
            &server,
            "directory_tree",
            json!({ "path": "src", "depth": 2 }),
        );
        assert!(deep.contains("src — 2 file(s), 4 symbol(s):"), "{deep}");
        // Files rank by declarations: lib.rs (3) before caller.rs (1).
        let lib = deep.find("lib.rs").unwrap();
        let caller = deep.find("caller.rs").unwrap();
        assert!(lib < caller, "{deep}");
        assert!(!deep.contains("other.rs"), "stays under src/: {deep}");

        let missing = call(&server, "directory_tree", json!({ "path": "nope" }));
        assert!(
            missing.contains("The index has no files under"),
            "{missing}"
        );
    }

    /// Each level caps at `top` rows and names the remainder — the caller chooses the
    /// answer's size, never the workspace.
    #[test]
    fn directory_tree_caps_each_level_and_names_the_remainder() {
        let dir = tempfile::tempdir().unwrap();
        for name in ["a", "b", "c"] {
            let folder = dir.path().join(name);
            std::fs::create_dir_all(&folder).unwrap();
            std::fs::write(folder.join("mod.rs"), "fn x() {}\n").unwrap();
        }
        let home = tempfile::tempdir().unwrap();
        let index = Arc::new(SymbolIndex::with_home(home.path().to_owned()));
        let root = dir.path().display().to_string();
        index.build_blocking(None, &root, None).unwrap();
        let analysis = Arc::new(AnalysisIndex::new());
        let log = tempfile::tempdir().unwrap();
        let server = McpServer::with_parts(&root, index, analysis, log.path().join("mcp.log"));

        let capped = call(&server, "directory_tree", json!({ "top": 2 }));
        assert!(
            capped.contains("… +1 more — raise top or drill with path"),
            "{capped}"
        );
        let full = call(&server, "directory_tree", json!({ "top": 3 }));
        assert!(full.contains("c/ —"), "{full}");
        assert!(!full.contains("+1 more"), "{full}");
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
        assert!(narrowed.contains("0 of 0 module edge(s)"), "{narrowed}");

        let metrics = call(&server, "analysis_metrics", json!({ "limit": 10 }));
        assert!(metrics.contains("of 5 function(s)"), "{metrics}");
        assert!(metrics.contains("function alpha"), "{metrics}");
        // The path filter scopes the ranking to one area.
        let scoped = call(&server, "analysis_metrics", json!({ "path": "other.rs" }));
        assert!(
            scoped.contains("of 1 function(s) under 'other.rs'"),
            "{scoped}"
        );

        let dead = call(&server, "analysis_dead_code", json!({}));
        assert!(dead.contains("function orphan — src/lib.rs:3"), "{dead}");
        assert!(!dead.contains("function alpha"), "{dead}");
        assert!(!dead.contains("function beta"), "{dead}");
        let dead_elsewhere = call(&server, "analysis_dead_code", json!({ "path": "other.rs" }));
        assert!(
            dead_elsewhere.contains("No uncalled declarations found under 'other.rs'"),
            "{dead_elsewhere}"
        );

        let security = call(&server, "analysis_security", json!({}));
        assert!(
            security.contains("[error] secret-looking literal"),
            "{security}"
        );
        assert!(security.contains("SEC-003"), "{security}");
        assert!(security.contains("other.rs:2"), "{security}");
        let warnings_only = call(
            &server,
            "analysis_security",
            json!({ "severity": "warning" }),
        );
        assert!(
            warnings_only.contains("No security rule findings of severity 'warning'"),
            "{warnings_only}"
        );

        let cycles = call(&server, "analysis_import_cycles", json!({}));
        assert!(cycles.contains("No import cycles"), "{cycles}");
    }

    /// Token economy: a read without a line range takes a look (400 lines), not the
    /// whole file, and the answer says how to continue; an explicit startLine serves
    /// the rest (its own window capped at the read budget).
    #[test]
    fn read_file_defaults_to_a_look_not_the_whole_file() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("big.rs");
        let body: String = (1..=1000)
            .map(|line| format!("// line {line}"))
            .collect::<Vec<_>>()
            .join("\n");
        std::fs::write(&file, &body).unwrap();
        let home = tempfile::tempdir().unwrap();
        let index = Arc::new(SymbolIndex::with_home(home.path().to_owned()));
        let root = dir.path().display().to_string();
        index.build_blocking(None, &root, None).unwrap();
        let analysis = Arc::new(AnalysisIndex::new());
        let log = tempfile::tempdir().unwrap();
        let server = McpServer::with_parts(&root, index, analysis, log.path().join("mcp.log"));

        let look = call(&server, "read_file", json!({ "path": "big.rs" }));
        assert!(look.contains("lines 1–400 of 1000"), "{}", &look[..200]);
        assert!(look.contains("continue with startLine = 401"), "{look}");
        assert!(
            !look.contains("line 401\n"),
            "the default window stops at 400"
        );

        let rest = call(
            &server,
            "read_file",
            json!({ "path": "big.rs", "startLine": 401 }),
        );
        assert!(rest.contains("lines 401–1000 of 1000"), "{rest}");
        assert!(rest.contains("line 1000"), "{rest}");
    }

    /// `symbol_references` pages a common name's flood: the header states the exact
    /// total, the trailer names the offset that reaches the rest, and the named offset
    /// picks up exactly where the page stopped. `pathPrefix` narrows both the total
    /// and the hits.
    #[test]
    fn symbol_references_pages_the_flood_with_offset_continuation() {
        let dir = tempfile::tempdir().unwrap();
        let mut hot = String::new();
        for line in 1..=420 {
            hot.push_str(&format!("pub fn caller{line}() {{ alpha(); }}\n"));
        }
        std::fs::create_dir_all(dir.path().join("src")).unwrap();
        std::fs::write(dir.path().join("src").join("hot.rs"), &hot).unwrap();
        std::fs::write(dir.path().join("quiet.rs"), "fn quiet() { alpha(); }\n").unwrap();
        let home = tempfile::tempdir().unwrap();
        let index = Arc::new(SymbolIndex::with_home(home.path().to_owned()));
        let root = dir.path().display().to_string();
        index.build_blocking(None, &root, None).unwrap();
        let analysis = Arc::new(AnalysisIndex::new());
        let log = tempfile::tempdir().unwrap();
        let server = McpServer::with_parts(&root, index, analysis, log.path().join("mcp.log"));

        // Files arrive path-sorted (quiet.rs before src/hot.rs), hits in line order —
        // the default page is quiet.rs's one hit plus hot.rs lines 1..99.
        let flooded = call(&server, "symbol_references", json!({ "name": "alpha" }));
        assert!(
            flooded.starts_with("421 occurrence(s)"),
            "{}",
            &flooded[..120]
        );
        assert!(
            flooded.contains("+321 more — repeat with offset = 100"),
            "{flooded}"
        );

        // The named offset continues exactly: hot.rs:100 on, hot.rs:99 and quiet.rs off.
        let next = call(
            &server,
            "symbol_references",
            json!({ "name": "alpha", "offset": 100, "limit": 50 }),
        );
        assert!(next.contains("src/hot.rs:100:"), "{next}");
        assert!(!next.contains("src/hot.rs:99:"), "{next}");
        assert!(!next.contains("quiet.rs"), "{next}");
        assert!(
            next.contains("+271 more — repeat with offset = 150"),
            "{next}"
        );

        let narrowed = call(
            &server,
            "symbol_references",
            json!({ "name": "alpha", "pathPrefix": "src/" }),
        );
        assert!(
            narrowed.starts_with("420 occurrence(s)"),
            "{}",
            &narrowed[..120]
        );
        assert!(narrowed.contains("src/hot.rs:"), "{narrowed}");
        assert!(!narrowed.contains("quiet.rs"), "{narrowed}");

        // The paging contract holds for search_symbols too: total in the header,
        // continuation in the trailer, exact pickup on the offset.
        let symbols = call(
            &server,
            "search_symbols",
            json!({ "query": "caller", "limit": 50 }),
        );
        assert!(
            symbols.starts_with("420 symbol(s) matching 'caller':"),
            "{symbols}"
        );
        assert!(
            symbols.contains("+370 more — repeat with offset = 50"),
            "{symbols}"
        );
        let last = call(
            &server,
            "search_symbols",
            json!({ "query": "caller", "offset": 419 }),
        );
        assert!(last.contains("caller420"), "{last}");
        assert!(!last.contains("more — repeat with offset"), "{last}");
    }
}
