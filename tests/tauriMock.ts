// A scripted stand-in for the Tauri runtime: `invoke` is answered by per-command handlers and
// every call is recorded, `listen` keeps the listeners so a test can emit backend events, and
// the dialog / opener / clipboard / window plugins record what they were asked to do.

import { vi } from 'vitest';

type Handler = (args: Record<string, unknown>) => unknown;

export const backend = {
	handlers: new Map<string, Handler>(),
	calls: [] as { command: string; args: Record<string, unknown> }[],
	listeners: new Map<string, ((event: { payload: unknown }) => void)[]>(),
	dialog: { openResult: null as string | null, saveResult: null as string | null },
	opened: [] as string[],
	revealed: [] as string[],
	clipboard: [] as string[],
	clipboardText: '',
	window: { minimized: 0, toggled: 0, closed: 0, maximized: false, resizeHandlers: [] as (() => void)[] },
	dropHandlers: [] as ((event: { payload: { type: string; paths?: string[] } }) => void)[],

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
		this.handlers.clear();
		this.calls.length = 0;
		this.listeners.clear();
		this.dialog.openResult = null;
		this.dialog.saveResult = null;
		this.opened.length = 0;
		this.revealed.length = 0;
		this.clipboard.length = 0;
		this.window = { minimized: 0, toggled: 0, closed: 0, maximized: false, resizeHandlers: [] };
		this.dropHandlers.length = 0;
	}
};

/** The stand-in for Tauri's `Channel`: a handler can push events into a channel it was given
 *  as an argument (`(args.onEvent as Channel<T>).onmessage(event)`), exactly as the backend
 *  does through `tauri::ipc::Channel`. */
export class Channel<T = unknown> {
	onmessage: (event: T) => void = () => undefined;
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

export async function invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
	// `has`, not `get`: a test's handler map may default unknown commands to a null answer
	// by overriding `get` (DefaultingHandlers), and that must not hide the raw bridge below.
	let handler = backend.handlers.has(command) ? backend.handlers.get(command) : undefined;
	let recorded = command;
	// The editor reads text over `read_file_raw`; a test that only scripts `read_file` keeps
	// working: its answer is encoded into the raw payload here, and the call is recorded as
	// the `read_file` it was answered by. The scripted handler is found through `get` too, so
	// a defaulting layer's `read_file` answers as well; one that answers null leaves the
	// command unhandled, exactly as an unscripted one.
	if (!handler && command === 'read_file_raw') {
		const read = backend.handlers.get('read_file');
		if (read) {
			handler = (callArgs) => {
				const file = read(callArgs) as Parameters<typeof encodeRawFile>[0];
				if (file == null) throw new Error('unhandled invoke: read_file_raw');
				return encodeRawFile(file);
			};
			recorded = 'read_file';
		}
	}
	backend.calls.push({ command: recorded, args });
	// A map that overrides `get` with its own defaulting layer still answers; only a truly
	// unhandled command throws.
	handler ??= backend.handlers.get(command);
	if (!handler) throw new Error(`unhandled invoke: ${command}`);
	return (await handler(args)) as T;
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
		onCloseRequested: async () => () => undefined
	})
};

/** The registered drag-drop handlers; a test emits `drop` payloads through `dropFiles`. */
export const webviewApi = {
	getCurrentWebview: () => ({
		onDragDropEvent: async (handler: (event: { payload: { type: string; paths?: string[] } }) => void) => {
			backend.dropHandlers.push(handler);
			return () => undefined;
		}
	})
};
