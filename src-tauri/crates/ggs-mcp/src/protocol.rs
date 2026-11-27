//! MCP protocol extensions (Prompts & Resources) and P2 Desktop UI Bridge tools.
//!
//! - `prompts/list` & `prompts/get`: curated expert engineering workflows that Claude Code
//!   surfaces as slash prompts.
//! - `resources/list` & `resources/read`: live workspace overview, index/git status, and
//!   active desktop editor context (`~/.ggs/mcp-bridge/ui-state.json`).
//! - Desktop UI Bridge tools (`ui_open_location`, `ui_show_relation_graph`, `ui_open_diff`):
//!   append JSONL commands to `~/.ggs/mcp-bridge/ui-commands.jsonl` for the running GGS
//!   desktop workbench to pick up and execute, with CLI fallback instructions when headless.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::McpServer;

/// Directory under `~/.ggs/` used for file-based MCP <-> Desktop Workbench IPC.
pub fn bridge_dir() -> PathBuf {
    ggs_base::paths::ggs_home().join("mcp-bridge")
}

/// JSONL queue written by `ggs-mcp` UI tools and consumed by the running desktop workbench.
pub fn ui_commands_path() -> PathBuf {
    bridge_dir().join("ui-commands.jsonl")
}

/// Snapshot written by the running desktop workbench (active file, cursor, selection).
pub fn ui_state_path() -> PathBuf {
    bridge_dir().join("ui-state.json")
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UiActiveState {
    pub workspace: String,
    pub path: String,
    pub line: usize,
    pub column: usize,
    pub symbol: Option<String>,
    pub selection: Option<String>,
    pub updated_at_ms: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", tag = "action")]
pub enum UiBridgeCommand {
    OpenLocation {
        root: String,
        path: String,
        line: usize,
        #[serde(default)]
        column: usize,
        ts: u64,
    },
    ShowRelationGraph {
        root: String,
        symbol: String,
        direction: String,
        ts: u64,
    },
    OpenDiff {
        root: String,
        left_path: String,
        right_path: Option<String>,
        ts: u64,
    },
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn enqueue_ui_command(cmd: &UiBridgeCommand) -> Result<(), String> {
    let path = ui_commands_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut line = serde_json::to_string(cmd).map_err(|e| e.to_string())?;
    line.push('\n');
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .and_then(|mut f| std::io::Write::write_all(&mut f, line.as_bytes()))
        .map_err(|e| e.to_string())
}

/* ---------- MCP Prompts ---------- */

pub(crate) fn prompts_catalogue() -> Value {
    json!([
        {
            "name": "blast-radius",
            "description": "Map the full semantic blast radius of a symbol or current git diff before editing or merging.",
            "arguments": [
                { "name": "target", "description": "Symbol name or git diff target ('working', 'staged', commit/range)", "required": true }
            ]
        },
        {
            "name": "arch-audit",
            "description": "Audit repository architecture: module dependency graph, import cycles, top complexity hotspots, dead code, and security findings.",
            "arguments": [
                { "name": "scope", "description": "Optional repo-relative directory prefix to scope the audit", "required": false }
            ]
        },
        {
            "name": "safe-rename",
            "description": "Safely rename a symbol across the entire workspace using conflict-checked dry-run preview before atomic apply.",
            "arguments": [
                { "name": "oldName", "description": "Current symbol name", "required": true },
                { "name": "newName", "description": "Desired new symbol name", "required": true }
            ]
        },
        {
            "name": "can-triage",
            "description": "End-to-end CAN/CAN-FD log triage: inspect bus load, errors, jitter, decode DBC signals, and locate transmitter/receiver source code.",
            "arguments": [
                { "name": "logPath", "description": "Repo-relative path to .blf or .asc log file", "required": true },
                { "name": "dbcPath", "description": "Optional repo-relative path to .dbc database file", "required": false }
            ]
        },
        {
            "name": "firmware-bloat",
            "description": "Analyze ELF firmware ROM/RAM footprint or compare two builds to pinpoint functions/objects driving size regressions.",
            "arguments": [
                { "name": "elfPath", "description": "Repo-relative path to target ELF binary", "required": true },
                { "name": "baseElfPath", "description": "Optional baseline ELF binary for elf_diff comparison", "required": false }
            ]
        },
        {
            "name": "crash-triage",
            "description": "Triage a Windows minidump (.dmp/.mdmp): inspect OS/process/exception metadata, loaded modules, and correlate with source symbols.",
            "arguments": [
                { "name": "dumpPath", "description": "Repo-relative path to .dmp or .mdmp file", "required": true }
            ]
        }
    ])
}

pub(crate) fn prompt_get(params: Option<&Value>) -> Result<Value, (i64, String)> {
    let name = params
        .and_then(|p| p.get("name"))
        .and_then(Value::as_str)
        .ok_or((-32602, "missing prompt name".to_owned()))?;
    let args = params
        .and_then(|p| p.get("arguments"))
        .cloned()
        .unwrap_or_else(|| json!({}));
    let get_arg = |k: &str| args.get(k).and_then(Value::as_str).unwrap_or("");

    let (desc, text) = match name {
        "blast-radius" => {
            let target = get_arg("target");
            (
                "Semantic blast-radius analysis",
                format!(
                    "Perform a semantic blast-radius analysis for `{target}`:\n\
                     1. If `{target}` is a git target (`working`, `staged`, or commit/range), call `git_diff_impact(target=\"{target}\")`.\n\
                     2. Otherwise call `symbol_context(name=\"{target}\")` and `analysis_call_graph(name=\"{target}\", direction=\"callers\", maxDepth=3)`.\n\
                     3. Summarize affected files, upstream callers, risky hotspots (`analysis_metrics`), and recommended test coverage."
                ),
            )
        }
        "arch-audit" => {
            let scope = get_arg("scope");
            let scope_note = if scope.is_empty() {
                "the entire repository".to_owned()
            } else {
                format!("`{scope}`")
            };
            (
                "Architecture & quality audit",
                format!(
                    "Run a structured architecture audit on {scope_note} using GGS MCP tools:\n\
                     1. Call `project_overview` and `analysis_module_graph` (with scope=\"{scope}\").\n\
                     2. Call `analysis_import_cycles`, `analysis_metrics(path=\"{scope}\")`, `analysis_dead_code(path=\"{scope}\")`, and `analysis_security`.\n\
                     3. Present top architectural risks, circular dependencies, hotspot refactoring candidates, and concrete next steps."
                ),
            )
        }
        "safe-rename" => {
            let old_name = get_arg("oldName");
            let new_name = get_arg("newName");
            (
                "Safe conflict-checked symbol rename",
                format!(
                    "Safely rename `{old_name}` to `{new_name}`:\n\
                     1. Call `symbol_rename(oldName=\"{old_name}\", newName=\"{new_name}\", dryRun=true)`.\n\
                     2. Review all conflicts and affected sites; if there are zero conflicts, apply with `symbol_rename(oldName=\"{old_name}\", newName=\"{new_name}\", dryRun=false)`.\n\
                     3. Verify with `git_diff_impact(target=\"working\")`."
                ),
            )
        }
        "can-triage" => {
            let log_path = get_arg("logPath");
            let dbc_path = get_arg("dbcPath");
            (
                "CAN bus log & source correlation triage",
                format!(
                    "Triage the CAN trace `{log_path}` (DBC: `{dbc_path}`):\n\
                     1. Call `can_log_summary(path=\"{log_path}\")` to identify bus load spikes, error frames, and high-jitter or dropped periodic CAN IDs.\n\
                     2. If a DBC file is provided, call `dbc_lookup` and `can_signal_query` on the anomalous IDs to decode physical values.\n\
                     3. Use `search_text` / `search_symbols` to find the firmware/software handlers for those CAN IDs or signal names and diagnose root cause."
                ),
            )
        }
        "firmware-bloat" => {
            let elf_path = get_arg("elfPath");
            let base_elf = get_arg("baseElfPath");
            (
                "ELF firmware footprint & bloat analysis",
                format!(
                    "Analyze firmware ROM/RAM footprint for `{elf_path}` (baseline: `{base_elf}`):\n\
                     1. Call `elf_inspect(path=\"{elf_path}\")` to review ROM/RAM totals, largest sections, and top symbols.\n\
                     2. If a baseline ELF is provided, call `elf_diff(beforePath=\"{base_elf}\", afterPath=\"{elf_path}\")`.\n\
                     3. Cross-reference the top growing symbols with `symbol_context` and suggest concrete size optimizations."
                ),
            )
        }
        "crash-triage" => {
            let dump_path = get_arg("dumpPath");
            (
                "Windows minidump crash triage",
                format!(
                    "Triage minidump `{dump_path}`:\n\
                     1. Call `dmp_summary(path=\"{dump_path}\")` to inspect OS/arch, PID, thread count, exception presence, and loaded modules.\n\
                     2. Map suspicious modules or crash-related symbols back to the repository with `search_symbols` and `symbol_context`."
                ),
            )
        }
        other => return Err((-32602, format!("unknown prompt: {other}"))),
    };

    Ok(json!({
        "description": desc,
        "messages": [
            {
                "role": "user",
                "content": { "type": "text", "text": text }
            }
        ]
    }))
}

/* ---------- MCP Resources ---------- */

pub(crate) fn resources_catalogue() -> Value {
    json!([
        {
            "uri": "ggs://workspace/overview",
            "name": "Workspace Overview",
            "description": "Bounded project overview: file/symbol counts, language mix, hub files, module graph edges, and dead code count.",
            "mimeType": "text/plain"
        },
        {
            "uri": "ggs://workspace/status",
            "name": "Workspace Index & Git Status",
            "description": "Current symbol index readiness and concise git working-tree status.",
            "mimeType": "text/plain"
        },
        {
            "uri": "ggs://ui/active-editor",
            "name": "Active Desktop Editor Context",
            "description": "The file, cursor line, enclosing symbol, and selection currently focused in the Git Graph Studio desktop app.",
            "mimeType": "application/json"
        }
    ])
}

impl McpServer {
    pub(crate) fn resource_read(&self, params: Option<&Value>) -> Result<Value, (i64, String)> {
        let uri = params
            .and_then(|p| p.get("uri"))
            .and_then(Value::as_str)
            .ok_or((-32602, "missing resource uri".to_owned()))?;

        match uri {
            "ggs://workspace/overview" => {
                let text = self.tool_overview()?;
                Ok(json!({
                    "contents": [{ "uri": uri, "mimeType": "text/plain", "text": text }]
                }))
            }
            "ggs://workspace/status" => {
                let idx = self.tool_status();
                let git = self.tool_git_status().unwrap_or_default();
                let text = format!("{idx}\n\n--- git status ---\n{git}");
                Ok(json!({
                    "contents": [{ "uri": uri, "mimeType": "text/plain", "text": text }]
                }))
            }
            "ggs://ui/active-editor" => {
                let state_path = ui_state_path();
                let text = match std::fs::read_to_string(&state_path) {
                    Ok(raw) if !raw.trim().is_empty() => raw,
                    _ => json!({
                        "connected": false,
                        "note": "No active Git Graph Studio desktop editor state found. Open the repository in Git Graph Studio to stream live cursor/selection context."
                    })
                    .to_string(),
                };
                Ok(json!({
                    "contents": [{ "uri": uri, "mimeType": "application/json", "text": text }]
                }))
            }
            other => Err((-32602, format!("unknown resource uri: {other}"))),
        }
    }

    /* ---------- P2 Desktop UI Bridge Tools ---------- */

    pub(crate) fn tool_ui_open_location(&self, args: &Value) -> Result<String, (i64, String)> {
        let path = Self::arg_str(args, "path")?.replace('\\', "/");
        let line = args.get("line").and_then(Value::as_u64).unwrap_or(1).max(1) as usize;
        let column = args.get("column").and_then(Value::as_u64).unwrap_or(1).max(1) as usize;
        let cmd = UiBridgeCommand::OpenLocation {
            root: self.root.clone(),
            path: path.clone(),
            line,
            column,
            ts: now_millis(),
        };
        enqueue_ui_command(&cmd).map_err(|e| (-32603, format!("failed to enqueue UI command: {e}")))?;
        Ok(format!(
            "Queued desktop navigation to {path}:{line}:{column}. If Git Graph Studio is not currently open, launch it with: ggs \"{}\"",
            self.root
        ))
    }

    pub(crate) fn tool_ui_show_relation_graph(
        &self,
        args: &Value,
    ) -> Result<String, (i64, String)> {
        let symbol = Self::arg_str(args, "symbol")?;
        let direction = args
            .get("direction")
            .and_then(Value::as_str)
            .unwrap_or("callsAndCallers")
            .to_owned();
        let cmd = UiBridgeCommand::ShowRelationGraph {
            root: self.root.clone(),
            symbol: symbol.clone(),
            direction: direction.clone(),
            ts: now_millis(),
        };
        enqueue_ui_command(&cmd).map_err(|e| (-32603, format!("failed to enqueue UI command: {e}")))?;
        Ok(format!(
            "Queued Relation Graph view for '{symbol}' ({direction}) in Git Graph Studio."
        ))
    }

    pub(crate) fn tool_ui_open_diff(&self, args: &Value) -> Result<String, (i64, String)> {
        let left_path = Self::arg_str(args, "leftPath")?.replace('\\', "/");
        let right_path = args
            .get("rightPath")
            .and_then(Value::as_str)
            .map(|p| p.replace('\\', "/"));
        let cmd = UiBridgeCommand::OpenDiff {
            root: self.root.clone(),
            left_path: left_path.clone(),
            right_path: right_path.clone(),
            ts: now_millis(),
        };
        enqueue_ui_command(&cmd).map_err(|e| (-32603, format!("failed to enqueue UI command: {e}")))?;
        match right_path {
            Some(r) => Ok(format!(
                "Queued side-by-side diff ({left_path} vs {r}) in Git Graph Studio. CLI fallback: ggs --compare \"{left_path}\" \"{r}\""
            )),
            None => Ok(format!(
                "Queued git diff view for '{left_path}' in Git Graph Studio."
            )),
        }
    }
}
