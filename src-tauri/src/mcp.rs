//! The MCP Server page & Desktop UI Bridge command adapters (module 16): the recent-call
//! log, the tool catalogue, and the file-backed UI bridge (`~/.ggs/mcp-bridge/`) that lets
//! Claude Code open locations/diffs/relation graphs in the running workbench and read the
//! active desktop editor context.

use ggs_mcp::protocol::{ui_commands_path, ui_state_path, UiActiveState, UiBridgeCommand};
use ggs_mcp::{catalogue_infos, mcp_log_path, read_mcp_log, McpLogEntry, McpToolInfo};

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

/// Drain pending desktop navigation commands enqueued by `ggs-mcp` (`ui_open_location`,
/// `ui_show_relation_graph`, `ui_open_diff`).
#[tauri::command]
pub async fn mcp_drain_ui_commands() -> Result<Vec<UiBridgeCommand>, String> {
    let path = ui_commands_path();
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return Ok(Vec::new());
    };
    if raw.trim().is_empty() {
        return Ok(Vec::new());
    }
    let _ = std::fs::write(&path, b"");
    let cmds = raw
        .lines()
        .filter_map(|line| serde_json::from_str::<UiBridgeCommand>(line).ok())
        .collect();
    Ok(cmds)
}

/// Publish the running desktop workbench's active editor context so `ggs-mcp` can serve
/// it via the `ggs://ui/active-editor` MCP resource.
#[tauri::command]
pub async fn mcp_publish_ui_state(state: UiActiveState) -> Result<(), String> {
    let path = ui_state_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(&state).map_err(|e| e.to_string())?;
    ggs_base::fsx::atomic_write(&path, json.as_bytes())
}
