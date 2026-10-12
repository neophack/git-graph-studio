// The Relay (docs/ggs-remote-plan.md §8.3): a hidden webview inside the instance that
// executes the remote sessions' invoke / Channel / listen calls with the REAL Tauri API and
// forwards the results over the loopback ggs-remote/1 link. One per instance; the header's
// `session` field tells the sessions apart. Because it runs the same IPC the desktop
// window does, every command, channel and event works remotely with no per-command code.
import { Channel, invoke } from '@tauri-apps/api/core';
import { emit, emitTo, listen, type UnlistenFn } from '@tauri-apps/api/event';
import {
	CHANNEL_PREFIX,
	decodeFrames,
	decodeRawInvoke,
	Enc,
	encodeFrames,
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
	splitFrame,
	T
} from './frame';

const HOST_REQUEST_EVENT = 'ext-host-request';
/** Terminal output is coalesced per subscription for this long (§6.4). */
const PTY_COALESCE_MS = 16;
/** Above this many buffered bytes the socket is given time to drain (§8.3). */
const HIGH_WATER = 8 << 20;
const MAX_DEPTH = 4;

interface SessionState {
	listeners: Map<number, UnlistenFn>;
	channels: Map<number, Channel<unknown>>;
	/** Listen subscriptions by event name (the host-request routing needs them). */
	events: Map<number, string>;
	attachedAt: number;
}

export interface RelayDeps {
	invoke: typeof invoke;
	listen: typeof listen;
	emit: typeof emit;
	emitTo: typeof emitTo;
	createChannel: (onmessage: (message: unknown) => void) => Channel<unknown>;
	send: (bytes: Uint8Array) => void;
	bufferedAmount: () => number;
}

/** The Relay's frame engine, separated from the socket so it can be driven in tests. */
export class RelayEngine {
	private readonly sessions = new Map<number, SessionState>();
	private readonly joiner = new Reassembler();
	private chain: Promise<void> = Promise.resolve();
	private readonly ptyBuffers = new Map<string, { frameFor: (text: string) => Frame; text: string; timer: ReturnType<typeof setTimeout> }>();
	private queue: Uint8Array[] = [];
	private draining = false;

	constructor(private readonly deps: RelayDeps) {}

	/** One WebSocket message from the daemon. */
	receive(data: ArrayBuffer | Uint8Array): void {
		let frames: Frame[];
		try {
			frames = decodeFrames(data);
		} catch {
			return;
		}
		for (const frame of frames) {
			this.chain = this.chain.then(async () => {
				const whole = this.joiner.push(frame.flags & FLAG.COMPRESSED ? await inflate(frame) : frame);
				if (whole) await this.handle(whole);
			});
		}
	}

	private session(id: number): SessionState {
		let state = this.sessions.get(id);
		if (!state) {
			state = { listeners: new Map(), channels: new Map(), events: new Map(), attachedAt: Date.now() };
			this.sessions.set(id, state);
		}
		return state;
	}

	private async handle(frame: Frame): Promise<void> {
		switch (frame.type) {
			case T.INVOKE:
				return void this.runInvoke(frame);
			case T.LISTEN:
				return this.addListener(frame);
			case T.UNLISTEN:
				return this.dropListener(frame.session, frame.stream);
			case T.EMIT:
				return this.relayEmit(frame);
			case T.CANCEL:
			case T.CHAN_CLOSE:
				this.session(frame.session).channels.delete(frame.stream);
				return;
			case T.SESSION_END:
				return this.dropSession(frame.session);
			case T.PING:
				// The daemon's UI-level heartbeat (§7.8): answering proves this page's loop runs.
				this.send([makeFrame(T.PONG, Enc.Raw, new Uint8Array(0), frame.stream)]);
				return;
		}
	}

	/** Swap channel placeholders for real Channels that forward as CHAN_DATA (§6.3). */
	private revive(session: number, value: unknown, depth = 0): unknown {
		if (typeof value === 'string' && value.startsWith(CHANNEL_PREFIX)) {
			const stream = Number(value.slice(CHANNEL_PREFIX.length));
			const state = this.session(session);
			const channel = this.deps.createChannel((message) => {
				if (!state.channels.has(stream)) return;
				if (message instanceof ArrayBuffer || message instanceof Uint8Array) {
					const bytes = message instanceof Uint8Array ? message : new Uint8Array(message);
					this.send([makeFrame(T.CHAN_DATA, Enc.Raw, bytes, stream, 0, session)]);
				} else {
					this.send([jsonFrame(T.CHAN_DATA, message, stream, 0, session)]);
				}
			});
			state.channels.set(stream, channel);
			return channel;
		}
		if (depth >= MAX_DEPTH || value === null || typeof value !== 'object') return value;
		if (Array.isArray(value)) return value.map((item) => this.revive(session, item, depth + 1));
		const out: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value)) out[key] = this.revive(session, item, depth + 1);
		return out;
	}

	private async runInvoke(frame: Frame): Promise<void> {
		const { session, stream } = frame;
		const frontend = `remote/${session}`;
		try {
			let result: unknown;
			if (encOf(frame) === Enc.Raw) {
				const { c, h, body } = decodeRawInvoke(frame.payload);
				result = await this.deps.invoke(c, body, { headers: { ...(h ?? {}), 'x-ggs-frontend': frontend } });
			} else {
				const { c, a, h } = frameJson<{ c: string; a?: Record<string, unknown>; h?: Record<string, string> }>(frame);
				const args = this.revive(session, a ?? {}) as Record<string, unknown>;
				result = await this.deps.invoke(c, args, { headers: { ...(h ?? {}), 'x-ggs-frontend': frontend } });
			}
			if (result instanceof ArrayBuffer || result instanceof Uint8Array) {
				const bytes = result instanceof Uint8Array ? result : new Uint8Array(result);
				this.send(splitFrame(makeFrame(T.RESULT, Enc.Raw, bytes, stream, 0, session)));
			} else {
				this.send(splitFrame(jsonFrame(T.RESULT, result ?? null, stream, 0, session)));
			}
		} catch (error) {
			this.send([jsonFrame(T.RESULT, { message: typeof error === 'string' ? error : String(error) }, stream, FLAG.ERROR, session)]);
		}
	}

	/** The session that answers the backends' host requests no one session claims (no
	 *  desktop window shows, no session's call or webview is behind them): the most
	 *  recently attached one listening for them (§8.6 #1). */
	private hostRequestOwner(): number | undefined {
		let owner: number | undefined;
		let latest = -1;
		for (const [id, state] of this.sessions) {
			if ([...state.events.values()].includes(HOST_REQUEST_EVENT) && state.attachedAt > latest) {
				latest = state.attachedAt;
				owner = id;
			}
		}
		return owner;
	}

	/** Which session answers a host request addressed to `frontend`: exactly the session a
	 *  `remote/<n>` address names — one user's click never lands in another user's page —
	 *  or, for the remote side at large (or a session that just left), the owner. */
	private hostRequestTarget(frontend: string | undefined): number | undefined {
		if (frontend !== undefined && frontend !== 'remote' && !frontend.startsWith('remote/')) return undefined;
		if (frontend?.startsWith('remote/')) {
			const named = Number(frontend.slice('remote/'.length));
			if ([...(this.sessions.get(named)?.events.values() ?? [])].includes(HOST_REQUEST_EVENT)) return named;
		}
		return this.hostRequestOwner();
	}

	private async addListener(frame: Frame): Promise<void> {
		const { session, stream } = frame;
		const { event, target } = frameMsgpack<{ event: string; target?: unknown }>(frame);
		const state = this.session(session);
		state.events.set(stream, event);
		const pty = event.startsWith('studio://pty-output-');
		const unlisten = await this.deps.listen(
			event,
			(e) => {
				if (!this.sessions.get(session)?.listeners.has(stream)) return;
				if (event === HOST_REQUEST_EVENT && this.hostRequestTarget((e.payload as { frontend?: string })?.frontend) !== session) return;
				if (pty && typeof e.payload === 'string') return this.coalescePty(session, stream, e.event, e.id, e.payload);
				// Split like a result: an event can outgrow one frame (the replica's snapshot of
				// the PC window, §22), and the daemon refuses a frame past MAX_PAYLOAD.
				this.send(splitFrame(jsonFrame(T.EVENT, { event: e.event, id: e.id, payload: e.payload }, stream, 0, session)));
			},
			target ? { target: target as never } : undefined
		);
		// A session that ended while the listen was in flight must not leak it.
		if (!this.sessions.has(session)) {
			unlisten();
			return;
		}
		state.listeners.set(stream, unlisten);
	}

	/** Terminal output in 16 ms batches: many small writes become one EVENT (§6.4). */
	private coalescePty(session: number, stream: number, event: string, id: number, text: string): void {
		const key = `${session}:${stream}`;
		const pending = this.ptyBuffers.get(key);
		if (pending) {
			pending.text += text;
			return;
		}
		const entry = {
			text,
			frameFor: (all: string) => jsonFrame(T.EVENT, { event, id, payload: all }, stream, 0, session),
			timer: setTimeout(() => {
				this.ptyBuffers.delete(key);
				this.send([entry.frameFor(entry.text)]);
			}, PTY_COALESCE_MS)
		};
		this.ptyBuffers.set(key, entry);
	}

	private dropListener(session: number, stream: number): void {
		const state = this.sessions.get(session);
		state?.listeners.get(stream)?.();
		state?.listeners.delete(stream);
		state?.events.delete(stream);
	}

	private async relayEmit(frame: Frame): Promise<void> {
		const { event, payload, target } = frameJson<{ event: string; payload?: unknown; target?: unknown }>(frame);
		if (target) await this.deps.emitTo(target as never, event, payload);
		else await this.deps.emit(event, payload);
	}

	/** The daemon ended a session (sign-out, kick, resume timeout): drop everything of it. */
	dropSession(session: number): void {
		const state = this.sessions.get(session);
		if (!state) return;
		for (const unlisten of state.listeners.values()) unlisten();
		this.sessions.delete(session);
		this.joiner.dropSession(session);
		void this.deps.invoke('remote_host_frontend_gone', { frontend: `remote/${session}` }).catch(() => undefined);
	}

	sessionCount(): number {
		return this.sessions.size;
	}

	private send(frames: Frame[]): void {
		this.queue.push(encodeFrames(frames));
		this.drain();
	}

	/** Respect the socket's buffer: past the high-water mark, wait for it to drain. */
	private drain(): void {
		if (this.draining) return;
		while (this.queue.length) {
			if (this.deps.bufferedAmount() > HIGH_WATER) {
				this.draining = true;
				setTimeout(() => {
					this.draining = false;
					this.drain();
				}, 20);
				return;
			}
			this.deps.send(this.queue.shift()!);
		}
	}
}

/** The page entry: connect with the one-time token the instance injected, then run. */
export function startRelay(): void {
	const config = (window as unknown as { __GGS_RELAY__?: { url: string; token: string } }).__GGS_RELAY__;
	if (!config) return;
	const ws = new WebSocket(`${config.url}?t=${encodeURIComponent(config.token)}`);
	ws.binaryType = 'arraybuffer';
	const engine = new RelayEngine({
		invoke,
		listen,
		emit,
		emitTo,
		createChannel: (onmessage) => new Channel<unknown>(onmessage),
		send: (bytes) => {
			if (ws.readyState === WebSocket.OPEN) ws.send(bytes);
		},
		bufferedAmount: () => ws.bufferedAmount
	});
	ws.onmessage = (event) => engine.receive(event.data as ArrayBuffer);
	// A dropped link is the daemon's to repair: it asks the instance for a fresh Relay.
	ws.onclose = () => undefined;
}

// Re-exported for the tests' frame assertions.
export { msgpackFrame };
