//! The MCP Server page's two command adapters (module 16): the recent-call log and the
//! tool catalogue, both over ggs-mcp's own halves. The server itself is headless —
//! `ggs --mcp <folder>` dispatches to `ggs_mcp::run` from the composition root.

use ggs_mcp::{catalogue_infos, read_mcp_log, mcp_log_path, McpLogEntry, McpToolInfo};

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
