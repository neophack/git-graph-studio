// A scripted stand-in for the Tauri runtime: `invoke` is answered by per-command handlers and
// every call is recorded, `listen` keeps the listeners so a test can emit backend events, and
// the dialog / opener / clipboard / window plugins record what they were asked to do.

import { vi } from 'vitest';

import { CHANNEL_PREFIX } from '../src/remote/frame';

type Handler = (args: Record<string, unknown>) => unknown;

export const backend = {
	handlers: new Map<string, Handler>(),
	/** §17.3's remote round: when set, every invoke crosses this instead of answering from
	 *  the handler map directly — the remote shims' wire (Transport → frames → RelayEngine),
	 *  with the same recording. */
	wire: null as ((command: string, args: Record<string, unknown>) => Promise<unknown>) | null,
	/** The remote round's channel hook: every Channel constructed while the wire is up
	 *  registers itself with the transport, so streamed events flow both ways. */
	wireChannel: null as ((channel: Channel<unknown>) => void) | null,
	calls: [] as { command: string; args: Record<string, unknown> }[],
	listeners: new Map<string, ((event: { payload: unknown }) => void)[]>(),
	/** Every `emit` the frontend made (Tauri's broadcast, recorded before delivery). */
	emits: [] as { event: string; payload: unknown }[],
	dialog: { openResult: null as string | null, saveResult: null as string | null },
	opened: [] as string[],
	revealed: [] as string[],
	clipboard: [] as string[],
	clipboardText: '',
	window: { minimized: 0, toggled: 0, closed: 0, maximized: false, resizeHandlers: [] as (() => void)[], moveHandlers: [] as (() => void)[] },
	dropHandlers: [] as ((event: { payload: { type: string; paths?: string[]; position?: { x: number; y: number } } }) => void)[],

	on(command: string, handler: Handler): void {
		this.handlers.set(command, handler);
	},
	emit(event: string, payload: unknown): void {
		for (const listener of this.listeners.get(event) ?? []) listener({ payload });
	},
	callsTo(command: string): Record<string, unknown>[] {
		return this.calls.filter((c) => c.command === command).map((c) => c.args);
	},
	reset(): void {
		this.wire = null;
		this.wireChannel = null;
		this.handlers.clear();
		this.calls.length = 0;
		this.listeners.clear();
		this.emits.length = 0;
		this.dialog.openResult = null;
		this.dialog.saveResult = null;
		this.opened.length = 0;
		this.revealed.length = 0;
		this.clipboard.length = 0;
		this.window = { minimized: 0, toggled: 0, closed: 0, maximized: false, resizeHandlers: [], moveHandlers: [] };
		this.dropHandlers.length = 0;
	}
};

/** The stand-in for Tauri's `Channel`: a handler can push events into a channel it was given
 *  as an argument (`(args.onEvent as Channel<T>).onmessage(event)`), exactly as the backend
 *  does through `tauri::ipc::Channel`. Under §17.3's remote round the channel also carries
 *  the wire's stream id: it serializes as the `__GGS_CHAN__<stream>` marker (the shim
 *  Channel's own shape), the RelayEngine revives it, and events pushed relay-side land back
 *  in this channel's `onmessage`. */
export class Channel<T = unknown> {
	onmessage: (event: T) => void = () => undefined;
	/** The remote round's stream id, when the wire carries this channel. */
	wireStream: number | null = null;
	constructor(onmessage?: (event: T) => void) {
		if (onmessage) this.onmessage = onmessage;
		backend.wireChannel?.(this);
	}
	toJSON(): unknown {
		return this.wireStream === null ? undefined : `${CHANNEL_PREFIX}${this.wireStream}`;
	}
	/** Test hook: deliver one event, as the backend's `send` would. */
	send(event: T): void {
		this.onmessage(event);
	}
}

/** Build `read_file_raw`'s payload the way the backend does: an 8-byte little-endian header
 *  length, the JSON metadata, then the UTF-8 text. Shared with the scenario fixtures so both
 *  harnesses bridge a scripted `read_file` into the raw channel. */
export function encodeRawFile(file: { contents: string | null; binary?: boolean; size?: number; encoding?: string; eol?: string } | null): Uint8Array {
	const meta = {
		binary: file?.binary ?? file?.contents == null,
		size: file?.size ?? 0,
		encoding: file?.encoding ?? 'utf8',
		eol: file?.eol ?? 'lf'
	};
	const encoder = new TextEncoder();
	const header = encoder.encode(JSON.stringify(meta));
	const text = encoder.encode(file?.contents ?? '');
	const payload = new Uint8Array(8 + header.length + text.length);
	new DataView(payload.buffer).setBigUint64(0, BigInt(header.length), true);
	payload.set(header, 8);
	payload.set(text, 8 + header.length);
	return payload;
}

/** Resolve a command to its scripted handler — the one resolution both rounds share: the
 *  desktop `invoke` and the remote round's RelayEngine answer from it. The raw-file bridge
 *  rides here so editors read identically over the wire. */
export function dispatchScripted(command: string, args: Record<string, unknown> = {}): Promise<unknown> {
	// `has`, not `get`: a test's handler map may default unknown commands to a null answer
	// by overriding `get` (DefaultingHandlers), and that must not hide the raw bridge below.
	let handler = backend.handlers.has(command) ? backend.handlers.get(command) : undefined;
	// The editor reads text over `read_file_raw`; a test that only scripts `read_file` keeps
	// working: its answer is encoded into the raw payload here. The scripted handler is found
	// through `get` too, so a defaulting layer's `read_file` answers as well; one that
	// answers null leaves the command unhandled, exactly as an unscripted one.
	if (!handler && command === 'read_file_raw') {
		const read = backend.handlers.get('read_file');
		if (read) {
			handler = (callArgs) => {
				const file = read(callArgs) as Parameters<typeof encodeRawFile>[0];
				if (file == null) throw new Error('unhandled invoke: read_file_raw');
				return encodeRawFile(file);
			};
		}
	}
	// A map that overrides `get` with its own defaulting layer still answers; only a truly
	// unhandled command throws.
	handler ??= backend.handlers.get(command);
	if (!handler) throw new Error(`unhandled invoke: ${command}`);
	return Promise.resolve(handler(args));
}

export async function invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
	// The remote round rides the wire: the call is recorded here (once), answered there.
	if (backend.wire) {
		backend.calls.push({ command, args });
		return backend.wire(command, args) as Promise<T>;
	}
	backend.calls.push({ command: command === 'read_file_raw' && backend.handlers.get('read_file') ? 'read_file' : command, args });
	return (await dispatchScripted(command, args)) as T;
}

export async function listen(event: string, handler: (event: { payload: unknown }) => void): Promise<() => void> {
	const list = backend.listeners.get(event) ?? [];
	list.push(handler);
	backend.listeners.set(event, list);
	return () => {
		const index = list.indexOf(handler);
		if (index !== -1) list.splice(index, 1);
	};
}

/** The stand-in for Tauri's `emit`: recorded, and delivered locally to every listener of the
 *  event — the same broadcast semantics the app's own events ride (a listener receives its
 *  window's emits too, exactly as the real runtime delivers them). */
export async function emit(event: string, payload?: unknown): Promise<void> {
	backend.emits.push({ event, payload });
	backend.emit(event, payload);
}

export const dialog = {
	open: vi.fn(async () => backend.dialog.openResult),
	save: vi.fn(async () => backend.dialog.saveResult)
};

export const opener = {
	openUrl: vi.fn(async (url: string) => { backend.opened.push(url); }),
	revealItemInDir: vi.fn(async (path: string) => { backend.revealed.push(path); })
};

export const clipboard = {
	writeText: vi.fn(async (text: string) => { backend.clipboard.push(text); }),
	readText: vi.fn(async () => backend.clipboardText)
};

export const windowApi = {
	getCurrentWindow: () => ({
		minimize: async () => { backend.window.minimized++; },
		toggleMaximize: async () => { backend.window.toggled++; backend.window.maximized = !backend.window.maximized; },
		close: async () => { backend.window.closed++; },
		isMaximized: async () => backend.window.maximized,
		onResized: async (handler: () => void) => { backend.window.resizeHandlers.push(handler); return () => undefined; },
		onMoved: async (handler: () => void) => { backend.window.moveHandlers.push(handler); return () => undefined; },
		onCloseRequested: async () => () => undefined
	})
};

/** The registered drag-drop handlers; a test emits `drop` payloads through `dropHandlers`. */
export const webviewApi = {
	getCurrentWebview: () => ({
		onDragDropEvent: async (handler: (event: { payload: { type: string; paths?: string[]; position?: { x: number; y: number } } }) => void) => {
			backend.dropHandlers.push(handler);
			return () => undefined;
		}
	})
};
