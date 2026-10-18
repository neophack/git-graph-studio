// The typed IPC seam of the process extension host (plan §5.6): starting a declared
// backend (eagerly at boot/install, lazily on first command), running commands over the
// ggs-ext/1 wire, the compacted registration journal an attaching frontend replays, the
// host-request respond bridge and the remembered status — the ggs-ext crate's process
// module behind the app's ext_process adapters.
import { invoke } from './core';

/** What `ext_process_status` reports for one extension's backend: running (pid > 0) or
 *  remembered-dead (pid 0, `lastError` saying why) — the Extensions view's status lines. */
export interface ExtProcessInfo {
	extensionId: string;
	pid: number;
	commands: string[];
	protocolVersion: string;
	startCount: number;
	lastError: string | null;
}

export const extProcessStart = (extId: string) => invoke<void>('ext_process_start', { extId });
export const extProcessStop = (extId: string) => invoke<void>('ext_process_stop', { extId });
export const extProcessStatus = () => invoke<ExtProcessInfo[] | null>('ext_process_status');
/** The bundled ggs-node sidecar's path (the default `node`-backend host). */
export const extNodeRuntime = () => invoke<string | null>('ext_node_runtime');
export const extProcessRun = (extId: string, command: string | number, args: unknown[]) =>
	invoke<unknown>('ext_process_run', { extId, command, args });
export const extProcessInvoke = (extId: string, method: string, args: unknown) =>
	invoke<unknown>('ext_process_invoke', { extId, method, args });
export const extProcessRegistrations = (extId: string) =>
	invoke<{ method: string; args: unknown[] }[] | null>('ext_process_registrations', { extId });
export const extProcessPushEvent = (extId: string, event: unknown) =>
	invoke<void>('ext_process_push_event', { extId, event });
export const extProcessHostRespond = (extId: string, id: number, ok: boolean, result: unknown) =>
	invoke<void>('ext_process_host_respond', { extId, id, ok, result });
/** Tell the backend this frontend hosts its own live page of a webview stream (its own
 *  instance of a per-frontend webview — the remote's Git Graph): the backend mirrors its
 *  webview traffic to exactly the frontends hosting one, addressed per frontend. A panel's
 *  registration answers the panel's banked html — the latest setHtml the backend delivered
 *  while it lives, stranded when it arrived before this registration did (the page mounted
 *  empty and no mirror re-delivered it). */
export const extWebviewHosted = (extId: string, stream: string, hosted: boolean) =>
	invoke<string | null>('ext_webview_hosted', { extId, stream, hosted });
