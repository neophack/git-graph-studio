// `@tauri-apps/api/core` for the remote workbench (docs/ggs-remote-plan.md §9.3): `invoke`
// crosses the WebSocket as an INVOKE frame; a `Channel` is a stream id the Relay swaps for a
// real Channel; `convertFileSrc('…', 'ggs')` points at the daemon's token-guarded package
// path. The export list mirrors the real module, so the alias swap is transparent.
import { CHANNEL_PREFIX } from '../frame';
import { remoteEnv, transport } from '../session';

export const SERIALIZE_TO_IPC_FN = '__TAURI_TO_IPC_KEY__';

export type InvokeArgs = Record<string, unknown> | number[] | ArrayBuffer | Uint8Array;
export interface InvokeOptions {
	headers: HeadersInit;
}
export type PermissionState = 'granted' | 'denied' | 'prompt' | 'prompt-with-rationale';

function headerRecord(headers: HeadersInit | undefined): Record<string, string> | undefined {
	if (!headers) return undefined;
	const out: Record<string, string> = {};
	new Headers(headers).forEach((value, key) => {
		out[key] = value;
	});
	return Object.keys(out).length ? out : undefined;
}

export async function invoke<T>(cmd: string, args?: InvokeArgs, options?: InvokeOptions): Promise<T> {
	return (await transport().call(cmd, args, headerRecord(options?.headers))) as T;
}

// A Channel nobody references anymore releases its stream on both ends.
const finalizer = typeof FinalizationRegistry === 'function' ? new FinalizationRegistry<number>((stream) => remoteEnv()?.transport.dropChannel(stream)) : undefined;

export class Channel<T = unknown> {
	id: number;
	#handler: (response: T) => void = () => undefined;

	constructor(onmessage?: (response: T) => void) {
		this.id = transport().allocStream();
		if (onmessage) this.#handler = onmessage;
		const handler = (message: unknown) => this.#handler(message as T);
		transport().registerChannel(this.id, handler);
		finalizer?.register(this, this.id);
	}

	set onmessage(handler: (response: T) => void) {
		this.#handler = handler;
	}

	get onmessage(): (response: T) => void {
		return this.#handler;
	}

	[SERIALIZE_TO_IPC_FN](): string {
		return `${CHANNEL_PREFIX}${this.id}`;
	}

	toJSON(): string {
		return `${CHANNEL_PREFIX}${this.id}`;
	}
}

/** `convertFileSrc` (§9.3): the `ggs` protocol maps onto the daemon's package path (the
 *  resource token is the credential a sandboxed frame can carry); other protocols read the
 *  file through a one-time download ticket, which the shim cannot mint synchronously — they
 *  resolve to the ggs path's sibling `file/` route the daemon does not serve, so a caller
 *  sees a clean 404 instead of a wrong file.
 *
 *  The daemon answers the base root-relative (`/w/<inst>/ggs/<tok>/`); it is made absolute
 *  against this page's origin here, because the URL travels into webview HTML that a
 *  sandboxed `srcdoc` iframe parses — there a root-relative reference resolves against no
 *  http base at all and Chrome turned it into `file:///w/…` ("Not allowed to load local
 *  resource"), so no extension webview ever loaded its scripts or styles remotely. */
export function convertFileSrc(filePath: string, protocol = 'asset'): string {
	const env = remoteEnv();
	if (!env) return `${protocol}://localhost/${encodeURIComponent(filePath)}`;
	const base = new URL(env.attached.ggsBase, location.href).href;
	if (protocol === 'ggs') return `${base}${encodeURIComponent(filePath)}`;
	return `${base}file/${encodeURIComponent(filePath)}`;
}

export function isTauri(): boolean {
	return true;
}

const callbacks = new Map<number, (response: unknown) => void>();
let nextCallback = 1;

export function transformCallback<T = unknown>(callback?: (response: T) => void, once = false): number {
	const id = nextCallback++;
	callbacks.set(id, (response) => {
		if (once) callbacks.delete(id);
		callback?.(response as T);
	});
	return id;
}

export class PluginListener {
	constructor(
		public plugin: string,
		public event: string,
		public channelId: number
	) {}
	async unregister(): Promise<void> {
		transport().dropChannel(this.channelId);
	}
}

export async function addPluginListener<T>(plugin: string, event: string, cb: (payload: T) => void): Promise<PluginListener> {
	const channel = new Channel<T>(cb);
	await invoke(`plugin:${plugin}|registerListener`, { event, handler: channel });
	return new PluginListener(plugin, event, channel.id);
}

export async function checkPermissions<T>(_plugin: string): Promise<T> {
	return 'granted' as T;
}

export async function requestPermissions<T>(_plugin: string): Promise<T> {
	return 'granted' as T;
}

export class Resource {
	#rid: number;
	get rid(): number {
		return this.#rid;
	}
	constructor(rid: number) {
		this.#rid = rid;
	}
	async close(): Promise<void> {
		await invoke('plugin:resources|close', { rid: this.#rid });
	}
}
