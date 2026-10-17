// The Relay (docs/ggs-remote-plan.md §8.3): a hidden webview inside the instance that
// executes the remote sessions' invoke / Channel / listen calls with the REAL Tauri API and
// forwards the results over the loopback ggs-remote/1 link. One per instance; the header's
// `session` field tells the sessions apart. Because it runs the same IPC the desktop
// window does, every command, channel and event works remotely with no per-command code.
import { Channel, invoke } from '../platform/ipc/core';
import { emit, emitTo, listen, type UnlistenFn } from '../platform/ipc/core';
import { gateInvoke, gateInvokeCanonical, isPathGated, type Canonicalizer } from './pathGate';
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
/** Terminal output is coalesced per subscription for this long (§6.4) — the trailing
 *  edge only: the first chunk after a quiet gap leaves at once (a key's echo never
 *  waits the window; what follows within it shares one frame). */
const PTY_COALESCE_MS = 16;
/** The gate's policy answers are served while a refresh runs in the background — a
 *  path-carrying invoke never blocks on the policy fetch (the roots change rarely). */
const POLICY_FRESH_MS = 3000;
/** How many consecutive background refresh failures the stale answer survives; past it
 *  the policy expires and the gate goes fail-closed (a broken backend refuses invokes
 *  instead of serving roots that were open minutes ago). */
const POLICY_FAILURE_CEILING = 5;
/** The path-carrying commands that can change the filesystem's shape inside the roots.
 *  Each one's completion drops the canonical table before the next answer serves: the
 *  watcher's `studio://fs-changed` batch is debounced, and a checkout materializing a
 *  symlink into the worktree must not let the next read serve from the pre-checkout
 *  table (§23.6's race, closed at the source). */
const FS_WRITING = new Set([
	'write_file',
	'create_file',
	'create_folder',
	'delete_path',
	'rename_path',
	'patch_file',
	'backup_write',
	'backup_clear',
	'fs_upload_offset',
	'discard_temp_blob',
	'git_commit',
	'git_discard',
	'git_discard_all',
	'git_stage',
	'git_stage_all',
	'git_unstage',
	'git_unstage_all',
	'scm_add_remote',
	'scm_add_tag',
	'scm_amend_last_commit',
	'scm_apply_stash',
	'scm_clone',
	'scm_checkout',
	'scm_create_branch',
	'scm_delete_branch',
	'scm_delete_remote',
	'scm_delete_tag',
	'scm_drop_stash',
	'scm_fetch',
	'scm_merge',
	'scm_pop_stash',
	'scm_pull',
	'scm_push',
	'scm_push_stash',
	'scm_rebase',
	'scm_rename_branch',
	'scm_reset_to_remote',
	'scm_sync',
	'scm_undo_last_commit',
	'gerrit_install_hook',
	'materialize_revision_file',
	'convert_can_log',
	'ext_install_from_vsix',
	'viewer_backup',
	'replace_in_files',
	'copy_into'
]);
/** The commands that move the boundary itself: the policy roots drop with the table. */
const ROOT_CHANGING = new Set(['open_workspace', 'open_single_file']);
/** `ext_fs` is the extension platform's hot READ path (every installed package's file
 *  access rides it — claude-code's activation alone reads hundreds of files), so only its
 *  writing ops drop the canonical table: a blanket drop made every ext read erase the
 *  cache the next path-carrying invoke had just filled, one extra canonical round trip
 *  per read whenever any extension ran. */
const EXT_FS_WRITING = new Set(['write', 'mkdir', 'chmod', 'delete', 'rename']);
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
	/** The gate's raw canonicalizer: one `remote_canonical_paths` round trip for the
	 *  paths it is handed — the symlink-proof half of the boundary (pathGate.ts). The
	 *  engine wraps it with the batched canonical table, so steady-state invokes hit the
	 *  cache and never reach this. Local, like the policy fetch: a session's own invokes
	 *  never reach this command with usable answers (the backend confines them to the
	 *  boundary's areas). */
	canonicalize: Canonicalizer;
}

/** The Relay's frame engine, separated from the socket so it can be driven in tests. */
export class RelayEngine {
	private readonly sessions = new Map<number, SessionState>();
	private readonly joiner = new Reassembler();
	private chain: Promise<void> = Promise.resolve();
	private readonly ptyBuffers = new Map<string, { frameFor: (text: string) => Frame; text: string; timer: ReturnType<typeof setTimeout> }>();
	/** Streams whose UNLISTEN arrived while their LISTEN's round trip was still in flight
	 *  (`session:stream`) — the completing listen unhooks instead of storing. */
	private readonly droppedListens = new Set<string>();
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
			}).catch(() => {
				// One malformed frame is dropped, never wedged: a rejected chain would skip
				// every later frame of every session until the socket died.
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

	/** The gate's policy, served stale while a refresh flies: the open folders (plus a
	 *  single-file launch) every path-carrying remote invoke is confined to, and the
	 *  extension platform's own areas `ext_fs` may also reach. Fetched locally — no
	 *  session header — so the answer is the app's own truth (§23.4's audit fix: app
	 *  commands themselves are unconfined by design; the boundary lives here, where
	 *  remote trust ends). */
	private policyAt: { at: number; roots: string[]; extRoots: string[] } | null = null;
	private policyRefresh: Promise<void> | null = null;
	/** Consecutive refresh failures — see `refreshPolicy`'s fail-closed ceiling. */
	private policyFailures = 0;
	/** Canonical forms the backend answered, keyed by the spelled path (§23.6): the
	 *  re-check of every path-carrying invoke rides this table — a hit costs no round
	 *  trip, so the gate adds microseconds to an invoke, not a second IPC. Dropped
	 *  whenever the filesystem can have moved: the watcher's `studio://fs-changed`
	 *  batch, the completion of every FS_WRITING command, and a roots change. */
	private canonical = new Map<string, string | null>();
	/** Paths whose canonical form a flight is fetching, with their waiters. */
	private canonicalWaiters = new Map<string, { resolve: (form: string | null) => void; reject: (error: unknown) => void }[]>();
	private canonicalFlying = false;
	/** Bumped by every table drop: a flight that departed before the drop still answers
	 *  its waiters but must not seed the table it raced. */
	private canonicalGen = 0;
	private fsWatched = false;

	/** The policy, stale-while-revalidate: fresh answers return without awaiting
	 *  anything, an expired one kicks a single background refresh and still returns at
	 *  once (a transient refresh failure keeps the last answer serving; the first fetch,
	 *  with nothing stale to serve, propagates its error — the gate is fail-closed). */
	private async pathPolicy(): Promise<{ roots: string[]; extRoots: string[] }> {
		if (!this.policyAt) {
			await this.policyFlight();
			return this.policyAt!;
		}
		if (Date.now() - this.policyAt.at >= POLICY_FRESH_MS) void this.policyFlight().catch(() => undefined);
		return this.policyAt;
	}

	/** One refresh in flight at a time. */
	private policyFlight(): Promise<void> {
		if (this.policyRefresh) return this.policyRefresh;
		const flight = this.refreshPolicy().finally(() => {
			if (this.policyRefresh === flight) this.policyRefresh = null;
		});
		this.policyRefresh = flight;
		return flight;
	}

	private async refreshPolicy(): Promise<void> {
		const previous = this.policyAt;
		let roots: string[], extRoots: string[];
		try {
			[roots, extRoots] = await Promise.all([
				this.deps.invoke('remote_paths_policy') as Promise<string[]>,
				this.deps.invoke('remote_ext_roots') as Promise<string[]>,
			]);
		} catch (error) {
			// A run of failed refreshes must not serve the last-known roots forever: past
			// the ceiling the policy expires outright, and the gate goes fail-closed — the
			// next invoke pays a fresh fetch and propagates the failure like the first one
			// always did.
			this.policyFailures += 1;
			if (this.policyAt && this.policyFailures >= POLICY_FAILURE_CEILING) this.policyAt = null;
			throw error;
		}
		this.policyFailures = 0;
		// A ROOT_CHANGING command reset the policy mid-flight (`policyAt` no longer the
		// snapshot this flight departed under): its answer predates the change and must not
		// reinstate the old roots under a fresh lease — discard it; the next invoke fetches
		// under the new state.
		if (this.policyAt !== previous) return;
		const answered = { at: Date.now(), roots: Array.isArray(roots) ? roots : [], extRoots: Array.isArray(extRoots) ? extRoots : [] };
		this.policyAt = answered;
		// Every landed refresh drops the canonical table, moved or not: the watcher's batch
		// is the fast invalidation, this is the self-healing one — a change the watcher
		// never reported (an overflow, a network filesystem under a root, anything under
		// the extension roots it does not watch) stops serving its stale "inside" verdicts
		// within one freshness window instead of forever.
		this.dropCanonical();
	}

	/** The batched, single-flight canonicalizer the gate rides: cache hits answer
	 *  synchronously, misses from any number of concurrent invokes gather into ONE
	 *  `remote_canonical_paths` round trip. A rejection fails every waiter — the gate
	 *  reads it as fail-closed, exactly like the direct call did. */
	private canonicalizeCached(paths: string[]): Promise<(string | null)[]> {
		this.watchFs();
		const waits = [...new Set(paths)].map(
			(path) =>
				new Promise<string | null>((resolve, reject) => {
					const hit = this.canonical.get(path);
					if (hit !== undefined) return resolve(hit);
					const list = this.canonicalWaiters.get(path) ?? [];
					list.push({ resolve, reject });
					this.canonicalWaiters.set(path, list);
				})
		);
		void this.flyCanonical();
		return Promise.all(waits);
	}

	private async flyCanonical(): Promise<void> {
		if (this.canonicalFlying) return;
		this.canonicalFlying = true;
		try {
			while (this.canonicalWaiters.size) {
				// One microtask before the snap: every waiter of the same wave (the
				// invokes that shared one policy fetch, continuations queued in order)
				// joins this flight instead of paying its own round trip.
				await Promise.resolve();
				const batch = [...this.canonicalWaiters];
				this.canonicalWaiters = new Map();
				const gen = this.canonicalGen;
				try {
					const forms = await this.deps.canonicalize(batch.map(([path]) => path));
					for (const [at, [path, waiters]] of batch.entries()) {
						const form = forms[at] ?? null;
						if (gen === this.canonicalGen) this.canonical.set(path, form);
						for (const waiter of waiters) waiter.resolve(form);
					}
				} catch (error) {
					for (const [, waiters] of batch) for (const waiter of waiters) waiter.reject(error);
				}
			}
		} finally {
			this.canonicalFlying = false;
		}
	}

	/** The watcher's batches, one listener for the Relay's whole life: an external
	 *  change (the desktop's own writes included) drops the table the moment it lands. */
	private watchFs(): void {
		if (this.fsWatched) return;
		this.fsWatched = true;
		void this.deps
			.listen('studio://fs-changed', () => this.dropCanonical())
			.catch(() => {
				this.fsWatched = false;
			});
	}

	private dropCanonical(): void {
		this.canonical.clear();
		this.canonicalGen += 1;
	}

	/** Prefetch the policy and the roots' canonical forms, so the first session's first
	 *  path-carrying invoke pays no round trip either (startRelay calls this once). */
	warmup(): void {
		void this.pathPolicy()
			.then((policy) => this.canonicalizeCached([...policy.roots, ...policy.extRoots]))
			.catch(() => undefined);
	}

	/** The lexical gate plus the canonical re-check over the cached table — one spelling
	 *  for both invoke encodings. */
	private async gate(c: string, args: Record<string, unknown> | undefined): Promise<void> {
		const policy = await this.pathPolicy();
		gateInvoke(c, args, policy.roots, policy.extRoots);
		await gateInvokeCanonical(c, args, policy, (paths) => this.canonicalizeCached(paths));
	}

	private async runInvoke(frame: Frame): Promise<void> {
		const { session, stream } = frame;
		const frontend = `remote/${session}`;
		let command = '';
		let extOp: unknown;
		try {
			let result: unknown;
			if (encOf(frame) === Enc.Raw) {
				const { c, h, body } = decodeRawInvoke(frame.payload);
				command = c;
				if (isPathGated(c)) await this.gate(c, body as unknown as Record<string, unknown> | undefined);
				result = await this.deps.invoke(c, body, { headers: { ...(h ?? {}), 'x-ggs-frontend': frontend } });
			} else {
				const { c, a, h } = frameJson<{ c: string; a?: Record<string, unknown>; h?: Record<string, string> }>(frame);
				command = c;
				const args = this.revive(session, a ?? {}) as Record<string, unknown>;
				if (command === 'ext_fs') extOp = args?.op;
				if (isPathGated(c)) await this.gate(c, args);
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
		} finally {
			// A command that can have moved the filesystem invalidates what the table
			// knows: the next answer re-resolves instead of serving a pre-write form (the
			// watcher's own batch arrives later, debounced). A refused or failed write
			// drops too — the cost is one refilling batch, never a wrong answer.
			if (ROOT_CHANGING.has(command)) {
				this.policyAt = null;
				this.dropCanonical();
			} else if (command === 'ext_fs') {
				if (typeof extOp === 'string' && EXT_FS_WRITING.has(extOp)) this.dropCanonical();
			} else if (FS_WRITING.has(command)) {
				this.dropCanonical();
			}
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
		// The payload is the session's own bytes: decode defensively (runInvoke's shape) —
		// a non-map or a non-string event is one dropped frame, never a thrown chain step.
		let decoded: { event?: unknown; target?: unknown };
		try {
			decoded = frameMsgpack<{ event?: unknown; target?: unknown }>(frame) ?? {};
		} catch {
			return;
		}
		if (typeof decoded.event !== 'string') return;
		const { event, target } = decoded as { event: string; target?: unknown };
		const state = this.session(session);
		state.events.set(stream, event);
		const listenKey = `${session}:${stream}`;
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
		// A session that ended while the listen was in flight must not leak it — and a
		// stream that was DROPPED in the same window must not either: dropListener found
		// no listener to call yet, so without this marker the registration would have
		// outlived its subscription (its callback kept forwarding events to a stream
		// nobody reads, until the session itself ended).
		if (!this.sessions.has(session) || this.droppedListens.delete(listenKey)) {
			unlisten();
			return;
		}
		state.listeners.set(stream, unlisten);
	}

	/** Terminal output, leading edge first: the chunk that opens a quiet gap's burst
	 *  leaves at once (a key's echo never waits), what follows within the window shares
	 *  one frame (§6.4). */
	private coalescePty(session: number, stream: number, event: string, id: number, text: string): void {
		const key = `${session}:${stream}`;
		const pending = this.ptyBuffers.get(key);
		if (pending) {
			pending.text += text;
			return;
		}
		const entry = {
			text: '',
			frameFor: (all: string) => jsonFrame(T.EVENT, { event, id, payload: all }, stream, 0, session),
			timer: setTimeout(() => {
				this.ptyBuffers.delete(key);
				// Split like every other egress: a firehose that pushes more than
				// MAX_PAYLOAD through one window makes a frame the daemon refuses — which
				// dropped the link.
				if (entry.text) this.send(splitFrame(entry.frameFor(entry.text)));
			}, PTY_COALESCE_MS)
		};
		this.ptyBuffers.set(key, entry);
		this.send([entry.frameFor(text)]);
	}

	private dropListener(session: number, stream: number): void {
		const state = this.sessions.get(session);
		if (!state) return;
		const unlisten = state.listeners.get(stream);
		// `events` carries the stream while a LISTEN was processed for it; its absence of
		// a stored listener then means the listen round trip is still in flight.
		const listening = state.events.delete(stream);
		state.listeners.delete(stream);
		unlisten?.();
		if (!unlisten && listening) {
			// Mark the in-flight listen so its own completion unhooks instead of adopting
			// the slot of a stream nobody subscribes to anymore.
			this.droppedListens.add(`${session}:${stream}`);
		} else {
			this.droppedListens.delete(`${session}:${stream}`);
		}
	}

	private async relayEmit(frame: Frame): Promise<void> {
		let decoded: { event?: unknown; payload?: unknown; target?: unknown };
		try {
			decoded = frameJson<{ event?: unknown; payload?: unknown; target?: unknown }>(frame) ?? {};
		} catch {
			return;
		}
		if (typeof decoded.event !== 'string') return;
		const { event, payload } = decoded as { event: string; payload?: unknown };
		// The event bridge is a privilege: the desktop trusts what arrives on these
		// channels, so only the two the remote workbench actually speaks cross, the
		// sender's identity is stamped over (a session cannot pose as `main` or as
		// another session), and the destination is always the PC window.
		if (event !== 'studio://mirror-up' && event !== 'studio://workbench-sync') return;
		const stamped =
			payload && typeof payload === 'object' && !Array.isArray(payload)
				? { ...(payload as Record<string, unknown>) }
				: payload;
		if (stamped && typeof stamped === 'object') {
			if ('from' in stamped) stamped.from = `remote/${frame.session}`;
			if ('by' in stamped) stamped.by = `remote/${frame.session}`;
		}
		await this.deps.emitTo('main' as never, event, stamped);
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
		// A failed canonicalization reaches the gate as a rejection, which refuses the
		// invoke — the check never degrades to "all null, lexical stands".
		canonicalize: (paths) => invoke('remote_canonical_paths', { paths }) as Promise<(string | null)[]>,
		send: (bytes) => {
			if (ws.readyState === WebSocket.OPEN) ws.send(bytes);
		},
		bufferedAmount: () => ws.bufferedAmount
	});
	ws.onmessage = (event) => engine.receive(event.data as ArrayBuffer);
	// The gate's policy and the roots' canonical forms land before the first session's
	// first path-carrying invoke can need them.
	engine.warmup();
	// A dropped link is the daemon's to repair: it asks the instance for a fresh Relay.
	ws.onclose = () => undefined;
}

// Re-exported for the tests' frame assertions.
export { msgpackFrame };
