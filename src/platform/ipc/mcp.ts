// The typed IPC seam of the MCP Server page & Desktop UI Bridge (plan §5.6): the tool
// catalogue, the rotated call log, the automatic Claude integration's registration state,
// and the bidirectional MCP <-> Workbench UI bridge.
import { invoke } from './core';

export interface McpToolInfo {
	name: string;
	description: string;
}

export interface McpLogEntry {
	time: number;
	tool: string;
	ok: boolean;
	ms: number;
	args: string;
}

/** The automatic Claude integration's state: whether the redirected Claude
 *  configuration carries the GGS analysis server. */
export interface ClaudeMcpStatus {
	registered: boolean;
	folder: string | null;
	command: string | null;
}

export interface UiActiveState {
	workspace: string;
	path: string;
	line: number;
	column: number;
	symbol: string | null;
	selection: string | null;
	updatedAtMs: number;
}

export type UiBridgeCommand =
	| { action: 'openLocation'; root: string; path: string; line: number; column: number; ts: number }
	| { action: 'showRelationGraph'; root: string; symbol: string; direction: string; ts: number }
	| { action: 'openDiff'; root: string; leftPath: string; rightPath: string | null; ts: number };

export const mcpTools = () => invoke<McpToolInfo[]>('mcp_tools');
export const mcpLog = () => invoke<McpLogEntry[]>('mcp_log');
export const mcpDrainUiCommands = () => invoke<UiBridgeCommand[]>('mcp_drain_ui_commands');
export const mcpPublishUiState = (state: UiActiveState) => invoke<void>('mcp_publish_ui_state', { state });
export const claudeMcpStatus = () => invoke<ClaudeMcpStatus | null>('claude_mcp_status');
