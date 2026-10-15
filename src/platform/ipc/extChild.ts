// The typed IPC seam of the extension host's child processes (plan §5.6): the real
// process surface a sandboxed frame cannot have — one spawn with streamed stdout/stderr
// and the exit over a Channel, the stdin writes, the kills — plus the machine's node
// path the `fork` bridge probes. The ggs-ext crate's child engine behind the app's
// ext_child adapters; nodeShims maps the Node child_process shapes onto these.
import { invoke, type Channel } from './core';

/** What a frame asks to spawn (Node's spawn shape as it crosses the bridge). */
export interface ExtChildSpec {
	file: string;
	args?: string[];
	cwd?: string;
	env?: Record<string, string> | null;
	shell?: boolean;
}

/** One streamed child event: a stdout/stderr chunk (base64) or the exit. */
export interface ExtChildEvent {
	handle: number;
	event: string;
	data?: string;
	code?: number | null;
}

export const extChildSpawn = (extId: string, spec: ExtChildSpec, onEvent: Channel<ExtChildEvent>) =>
	invoke<number>('ext_child_spawn', { extId, spec, onEvent });
export const extChildWrite = (handle: number, data: string) => invoke<void>('ext_child_write', { handle, data });
export const extChildEndStdin = (handle: number) => invoke<void>('ext_child_end_stdin', { handle });
export const extChildKill = (handle: number) => invoke<void>('ext_child_kill', { handle });
export const extChildStopFor = (extId: string) => invoke<void>('ext_child_stop_for', { extId });
/** The machine's node (a real language-server process), or null when it has none. */
export const extNodeRuntimePath = () => invoke<string | null>('ext_node_runtime_path');
