// The typed IPC seam of the MCP Server page (plan §5.6): the tool catalogue, the rotated
// call log, and the automatic Claude integration's registration state — the ggs-mcp
// crate's two page commands plus the providers crate's claude_mcp_status behind the
// app's adapters.
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

export const mcpTools = () => invoke<McpToolInfo[]>('mcp_tools');
export const mcpLog = () => invoke<McpLogEntry[]>('mcp_log');
export const claudeMcpStatus = () => invoke<ClaudeMcpStatus | null>('claude_mcp_status');
