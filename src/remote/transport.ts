// The remote workbench's one connection (docs/ggs-remote-plan.md §6, §9.4): ggs-remote/1
// frames over a binary WebSocket — invokes and their results, Channel messages, events —
// with credit flow control, a heartbeat, leading-edge batching of small uplink frames and
// resume after a dropped network (a phone going to the background, a network change).
import {
	canDeflate,
	CHANNEL_PREFIX,
	decodeFrames,
	encodeFrames,
	encodeRawInvoke,
	Enc,
	encOf,
	FLAG,
	type Frame,
	frameJson,
	frameMsgpack,
	inflate,
	jsonFrame,
	makeFrame,
	msgpackFrame,
	Reassembler,
	T
} from './frame';

export interface Attached {
	instance: string;
	version: string;
	assetBase: string;
	ggsBase: string;
	frontendId: string;
}

export interface InstanceInfo {
	id: string;
	title: string;
	folders: string[];
	version: string;
	visible: boolean;
	remoteSessions: number;
	startedAt: number;
	state: string;
	summary?: { tabs?: { path: string; dirty: boolean; active: boolean }[]; terminals?: number; dirty?: number; scmChanges?: number };
}

export interface Notice {
	kind: string;
	instance?: string;
	stream?: number;
	dirty?: string[];
	message?: string;
}

type Pending = { resolve(value: unknown): void; reject(error: unknown): void };
export type EventHandler = (event: { event: string; id: number; payload: unknown }) => void;

export interface TransportOptions {
	/** The daemon's base path (`/` on the LAN, `/u/<uuid>/` through a Hub). */
	basePath: string;
	instance: string;
	/** Injected for tests; defaults to the real WebSocket. */
	createSocket?: (url: string) => WebSocket;
	/** Injected for tests; defaults to `GET {basePath}api/session`. */
	fetchSession?: () => Promise<{ csrf: string } | null>;
	/** What to do on a terminal close (4401 → login, 4410 → picker). */
	navigate?: (to: 'login' | 'picker', reason: string) => void;
	/** The link dropped and the retry loop took over (frames queue meanwhile) — the
	 *  workbench says so instead of looking merely frozen. */
	onOffline?: () => void;
	/** A retry landed; the queued frames are on their way again. */
	onOnline?: () => void;
	formFactor?: string;
	dataSaver?: boolean;
}

/** Frames up to this size ride the uplink batch window (§6.4: keystrokes). */
const BATCH_MAX = 512;
const BATCH_WINDOW_MS = 16;
const CREDIT_EVERY = 256 * 1024;
const HEARTBEAT_MS = 20_000;
const HIDDEN_HEARTBEAT_MS = 60_000;

export class Transport {
	private ws?: WebSocket;
	private nextStream = 1; // browser-initiated streams are odd
	private readonly pending = new Map<number, Pending>();
	private readonly channels = new Map<number, (message: unknown) => void>();
	private readonly listeners = new Map<number, EventHandler>();
	private readonly listenSpecs = new Map<number, { event: string; target?: unknown }>();
	private readonly windowsHandlers = new Set<(list: InstanceInfo[]) => void>();
	private readonly noticeHandlers = new Set<(notice: Notice) => void>();
	private readonly joiner = new Reassembler();
	private inflateChain: Promise<void> = Promise.resolve();
	private lastSeq = 0;
	private consumed = 0;
	private sid?: string;
	private csrf = '';
	private attachedInfo?: Attached;
	private attachWaiters: ((info: Attached) => void)[] = [];
	private batch: Frame[] = [];
	private batchOpen = false;
	private heartbeat?: ReturnType<typeof setInterval>;
	private retryMs = 500;
	private closedForGood = false;
	readonly stats = { up: 0, down: 0, byType: new Map<number, number>() };
	instances: InstanceInfo[] = [];

	constructor(private readonly options: TransportOptions) {}

	get attached(): Attached | undefined {
		return this.attachedInfo;
	}

	/** Connect, say HELLO and attach to the instance; resolves with ATTACHED. */
	async connect(): Promise<Attached> {
		await this.open(false);
		return new Promise<Attached>((resolve) => {
			if (this.attachedInfo) resolve(this.attachedInfo);
			else this.attachWaiters.push(resolve);
		});
	}

	allocStream(): number {
		const id = this.nextStream;
		this.nextStream += 2;
		return id;
	}

	/** INVOKE (§6.3): JSON args, or raw bytes with the command in a MessagePack prefix. */
	call(cmd: string, args?: unknown, headers?: Record<string, string>): Promise<unknown> {
		const stream = this.allocStream();
		let frame: Frame;
		if (args instanceof ArrayBuffer || args instanceof Uint8Array) {
			const bytes = args instanceof Uint8Array ? args : new Uint8Array(args);
			frame = makeFrame(T.INVOKE, Enc.Raw, encodeRawInvoke(cmd, bytes, headers), stream);
		} else if (Array.isArray(args) && args.every((n) => typeof n === 'number')) {
			frame = makeFrame(T.INVOKE, Enc.Raw, encodeRawInvoke(cmd, Uint8Array.from(args as number[]), headers), stream);
		} else {
			frame = jsonFrame(T.INVOKE, headers ? { c: cmd, a: args ?? {}, h: headers } : { c: cmd, a: args ?? {} }, stream);
		}
		return new Promise((resolve, reject) => {
			this.pending.set(stream, { resolve, reject });
			this.send(frame);
		});
	}

	registerChannel(stream: number, handler: (message: unknown) => void): void {
		this.channels.set(stream, handler);
	}

	dropChannel(stream: number): void {
		if (this.channels.delete(stream)) this.send(makeFrame(T.CHAN_CLOSE, Enc.Raw, new Uint8Array(0), stream));
	}

	listen(event: string, handler: EventHandler, target?: unknown): number {
		const stream = this.allocStream();
		this.listeners.set(stream, handler);
		this.listenSpecs.set(stream, { event, target });
		this.send(msgpackFrame(T.LISTEN, target === undefined ? { event } : { event, target }, stream));
		return stream;
	}

	unlisten(stream: number): void {
		this.listeners.delete(stream);
		this.listenSpecs.delete(stream);
		this.send(makeFrame(T.UNLISTEN, Enc.Raw, new Uint8Array(0), stream));
	}

	emit(event: string, payload: unknown, target?: unknown): void {
		this.send(jsonFrame(T.EMIT, target === undefined ? { event, payload } : { event, payload, target }));
	}

	onWindows(handler: (list: InstanceInfo[]) => void): () => void {
		this.windowsHandlers.add(handler);
		if (this.instances.length) handler(this.instances);
		return () => this.windowsHandlers.delete(handler);
	}

	onNotice(handler: (notice: Notice) => void): () => void {
		this.noticeHandlers.add(handler);
		return () => this.noticeHandlers.delete(handler);
	}

	/** Control frames of the window switcher (§13). */
	spawn(folder: string | null, visible = false): void {
		this.send(msgpackFrame(T.SPAWN, { folder, visible }));
	}

	closeInstance(instance: string, force = false): void {
		this.send(msgpackFrame(T.INSTANCE_CLOSE, { instance, force }));
	}

	restartInstance(instance: string): void {
		this.send(msgpackFrame(T.INSTANCE_RESTART, { instance }));
	}

	detach(): void {
		this.send(makeFrame(T.DETACH, Enc.Raw));
	}

	/** Stop for good (navigating away). */
	shutdown(): void {
		this.closedForGood = true;
		clearInterval(this.heartbeat);
		this.ws?.close(1000);
	}

	// ---- the socket ----

	private wsUrl(): string {
		const base = new URL(this.options.basePath, location.href);
		const url = new URL('ws', base);
		url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
		return url.href;
	}

	private async fetchSession(): Promise<{ csrf: string } | null> {
		if (this.options.fetchSession) return this.options.fetchSession();
		try {
			const response = await fetch(new URL('api/session', new URL(this.options.basePath, location.href)), { credentials: 'same-origin' });
			if (response.status === 401) return null;
			if (!response.ok) throw new Error(`session ${response.status}`);
			return (await response.json()) as { csrf: string };
		} catch (error) {
			throw error instanceof Error ? error : new Error(String(error));
		}
	}

	private async open(resume: boolean): Promise<void> {
		const session = await this.fetchSession();
		if (!session) {
			this.navigate('login', 'expired');
			return;
		}
		this.csrf = session.csrf;
		const ws = (this.options.createSocket ?? ((url) => new WebSocket(url)))(this.wsUrl());
		ws.binaryType = 'arraybuffer';
		this.ws = ws;
		await new Promise<void>((resolve, reject) => {
			ws.onopen = () => {
				this.sendNow([
					msgpackFrame(T.HELLO, {
						proto: 1,
						client: 'web',
						ver: '1',
						caps: { deflate: canDeflate(), sw: 'serviceWorker' in navigator, clipboard: Boolean(navigator.clipboard) },
						formFactor: this.options.formFactor ?? 'desktop',
						dataSaver: this.options.dataSaver ?? false,
						resume: resume && this.sid ? { sid: this.sid, lastSeq: this.lastSeq } : undefined,
						csrf: this.csrf
					})
				]);
				resolve();
			};
			ws.onerror = () => reject(new Error('websocket error'));
		});
		ws.onmessage = (event) => this.onMessage(event.data as ArrayBuffer);
		ws.onclose = (event) => this.onClose(event.code, event.reason);
		ws.onerror = null;
		this.startHeartbeat();
	}

	private navigate(to: 'login' | 'picker', reason: string): void {
		this.closedForGood = true;
		if (this.options.navigate) return this.options.navigate(to, reason);
		const base = new URL(this.options.basePath, location.href);
		location.replace(new URL(to === 'login' ? `login?reason=${encodeURIComponent(reason)}` : `windows?reason=${encodeURIComponent(reason)}`, base).href);
	}

	private startHeartbeat(): void {
		clearInterval(this.heartbeat);
		const every = typeof document !== 'undefined' && document.visibilityState === 'hidden' ? HIDDEN_HEARTBEAT_MS : HEARTBEAT_MS;
		this.heartbeat = setInterval(() => this.ping(), every);
	}

	ping(): void {
		this.send(msgpackFrame(T.PING, { ackSeq: this.lastSeq }));
	}

	/** A page that comes back to the foreground checks the link at once (§9.4). */
	onVisibility(visible: boolean): void {
		this.startHeartbeat();
		if (!visible) return;
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
			void this.reconnect();
			return;
		}
		this.ping();
	}

	private onClose(code: number, reason: string): void {
		clearInterval(this.heartbeat);
		if (this.closedForGood) return;
		if (code === 4401) return this.navigate('login', reason || 'expired');
		if (code === 4410) return this.navigate('picker', 'instance-exited');
		if (code === 4403 || code === 4409) return this.navigate('login', reason || 'expired');
		void this.reconnect();
	}

	private async reconnect(): Promise<void> {
		if (this.closedForGood) return;
		this.options.onOffline?.();
		const wait = this.retryMs;
		this.retryMs = Math.min(this.retryMs * 2, 8000);
		await new Promise((r) => setTimeout(r, wait));
		try {
			await this.open(true);
			this.options.onOnline?.();
		} catch {
			void this.reconnect();
		}
	}

	// ---- uplink ----

	private send(frame: Frame): void {
		this.stats.up += frame.payload.length + 20;
		const small = frame.payload.length <= BATCH_MAX && (frame.type === T.INVOKE || frame.type === T.EMIT);
		if (!small) {
			this.flushBatch();
			this.sendNow([frame]);
			return;
		}
		if (!this.batchOpen) {
			// Leading edge: the first keystroke goes at once; the ones that follow within the
			// window share one message (§6.4).
			this.batchOpen = true;
			this.sendNow([frame]);
			setTimeout(() => {
				this.batchOpen = false;
				this.flushBatch();
			}, BATCH_WINDOW_MS);
			return;
		}
		this.batch.push(frame);
	}

	private flushBatch(): void {
		if (!this.batch.length) return;
		const frames = this.batch;
		this.batch = [];
		this.sendNow(frames);
	}

	private sendNow(frames: Frame[]): void {
		if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(encodeFrames(frames));
		else for (const f of frames) this.queueOffline(f);
	}

	private offline: Frame[] = [];
	private queueOffline(frame: Frame): void {
		// Workload frames wait for the reconnect; control frames are re-derived after it.
		if (frame.type === T.INVOKE || frame.type === T.LISTEN || frame.type === T.UNLISTEN || frame.type === T.EMIT || frame.type === T.CHAN_CLOSE) {
			this.offline.push(frame);
		}
	}

	// ---- downlink ----

	private onMessage(data: ArrayBuffer): void {
		let frames: Frame[];
		try {
			frames = decodeFrames(data);
		} catch {
			return;
		}
		this.stats.down += data.byteLength;
		for (const frame of frames) {
			this.stats.byType.set(frame.type, (this.stats.byType.get(frame.type) ?? 0) + frame.payload.length);
			if (frame.seq) {
				this.lastSeq = frame.seq;
				this.consumed += frame.payload.length;
				if (this.consumed >= CREDIT_EVERY) {
					this.sendNow([msgpackFrame(T.CREDIT, { bytes: this.consumed, ackSeq: this.lastSeq })]);
					this.consumed = 0;
				}
			}
			if (frame.flags & FLAG.COMPRESSED) {
				// Inflation is asynchronous: chain it so frames stay in sequence order.
				this.inflateChain = this.inflateChain.then(async () => this.dispatch(await inflate(frame)));
			} else {
				this.inflateChain = this.inflateChain.then(() => this.dispatch(frame));
			}
		}
	}

	private dispatch(raw: Frame): void {
		const frame = this.joiner.push(raw);
		if (!frame) return;
		switch (frame.type) {
			case T.HELLO_ACK: {
				const ack = frameMsgpack<{ sid: string; resumed: boolean }>(frame);
				const reattach = !ack.resumed;
				this.sid = ack.sid;
				this.retryMs = 500;
				if (reattach && this.attachedInfo) {
					// The daemon lost this session (resume window passed): what was in flight
					// is gone; reload so every view rebuilds its state from the backend.
					for (const p of this.pending.values()) p.reject(new Error('connection lost'));
					this.pending.clear();
					if (typeof location !== 'undefined' && !this.options.createSocket) location.reload();
					return;
				}
				if (!this.attachedInfo) this.sendNow([msgpackFrame(T.ATTACH, { instance: this.options.instance })]);
				// Frames queued while offline go out now.
				const offline = this.offline;
				this.offline = [];
				if (offline.length) this.sendNow(offline);
				return;
			}
			case T.ATTACHED: {
				this.attachedInfo = frameMsgpack<Attached>(frame);
				for (const waiter of this.attachWaiters.splice(0)) waiter(this.attachedInfo);
				return;
			}
			case T.RESULT: {
				const pending = this.pending.get(frame.stream);
				if (!pending) return;
				this.pending.delete(frame.stream);
				if (frame.flags & FLAG.ERROR) {
					let message = 'remote call failed';
					try {
						const body = frameJson<{ message?: string }>(frame);
						message = body.message ?? message;
					} catch {
						/* not JSON */
					}
					pending.reject(message);
				} else if (encOf(frame) === Enc.Raw) {
					pending.resolve(frame.payload.buffer.slice(frame.payload.byteOffset, frame.payload.byteOffset + frame.payload.byteLength));
				} else {
					pending.resolve(frame.payload.length ? frameJson(frame) : null);
				}
				return;
			}
			case T.CHAN_DATA: {
				const handler = this.channels.get(frame.stream);
				if (!handler) return;
				handler(encOf(frame) === Enc.Raw ? frame.payload.buffer.slice(frame.payload.byteOffset, frame.payload.byteOffset + frame.payload.byteLength) : frameJson(frame));
				return;
			}
			case T.CHAN_CLOSE:
				this.channels.delete(frame.stream);
				return;
			case T.EVENT: {
				const handler = this.listeners.get(frame.stream);
				if (handler) handler(frameJson(frame));
				return;
			}
			case T.WINDOWS: {
				this.instances = frameMsgpack<{ instances: InstanceInfo[] }>(frame).instances ?? [];
				for (const handler of this.windowsHandlers) handler(this.instances);
				return;
			}
			case T.NOTICE: {
				const notice = frameMsgpack<Notice>(frame);
				for (const handler of this.noticeHandlers) handler(notice);
				return;
			}
			case T.SPAWNED: {
				const spawned = frameMsgpack<{ instance: string }>(frame);
				for (const handler of this.noticeHandlers) handler({ kind: 'spawned', instance: spawned.instance });
				return;
			}
			case T.PONG:
				return;
			case T.CLOSE: {
				const close = frameMsgpack<{ code: number; reason: string }>(frame);
				if (close.code === 4410) this.navigate('picker', close.reason);
				else if (close.code === 4401) this.navigate('login', close.reason);
				return;
			}
		}
	}
}

/** The daemon base path of a workbench URL: everything before `w/<inst>/v/<ver>/`. */
export function basePathOf(pathname: string): string {
	const match = /^(.*\/)w\/[^/]+\/v\/[^/]+\/[^/]*$/.exec(pathname);
	return match ? match[1] : '/';
}

/** The instance id of a workbench URL. */
export function instanceOf(pathname: string): string | null {
	const match = /\/w\/([^/]+)\/v\/[^/]+\//.exec(pathname);
	return match ? decodeURIComponent(match[1]) : null;
}

export { CHANNEL_PREFIX };
