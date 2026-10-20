// The sync's participant table (docs/remote-client-plan.md §7.0): which frontends of this
// window are ACTIVE right now — the PC window while it is visible (not hidden, not
// minimized), a remote page while it is connected and in the foreground. Everything the
// sync gates or catches up on reads this one table, and every frontend judges the counts
// locally from what the others announce: no extra round trip, no arbiter.
//
// The messages ride the workbench sync's own channel (`studio://workbench-sync`): a
// `presence` announcement crosses whenever a frontend becomes active or inactive and once
// every heartbeat interval as a keep-alive — a frontend alone on the window still sends
// them, because the OTHERS gate on it (K11: one active frontend sends no intent messages,
// never no messages at all). A frontend arriving in the foreground asks the most recently
// active other for a snapshot; the state exchange itself lives in workbenchSync.ts — this
// module only decides WHO is active and WHO answers.
//
// The PC window's activity has an authoritative second source: the daemon's `visible`
// field, pushed in WINDOWS frames (the window can hide without its page noticing every
// platform's visibilitychange). A remote session feeds that word in through
// `noteExternal`; it overrides whatever stale announcement the table holds.

/** The presence instance of this page's sync, when the real installer created one — the
 *  remote boot feeds the daemon's authoritative PC-visibility word into it (§7.0.1). The
 *  registry lives here so a light module (the boot) can reach it without importing the
 *  sync's heavier graph. */
let installed: Presence | null = null;

export function currentPresence(): Presence | null {
	return installed;
}

/** The daemon's authoritative words that arrived before any table existed (a fresh
 * remote's connect-time WINDOWS frame reaches the boot while its workbench — and with it
 * the sync's table — is still a wire round trip away): remembered here and replayed into
 * the table the moment one registers, so the fresh page's first catch-up already knows
 * whether the PC window is active (§7.0.1). */
const externalWords = new Map<string, boolean>();

/** Feed the daemon's authoritative word on another frontend to the installed table,
 * remembering it for the one that registers later. */
export function noteExternalPresence(by: string, active: boolean): void {
	externalWords.set(by, active);
	installed?.noteExternal(by, active);
}

/** The sync's installer registers its table; `null` on detach. The remembered external
 * words replay into the newcomer — the word the boot fed before the table existed. */
export function registerPresence(instance: Presence | null): void {
	installed = instance;
	if (instance) for (const [by, active] of externalWords) instance.noteExternal(by, active);
}

/** A heartbeat every 60 s; a frontend whose last sign of life is older than 150 s counts
 *  as inactive (§7.0.1). A hidden phone tabs out at ~30 s and resumes within the daemon's
 *  120 s recovery ring, so the TTL tolerates one missed heartbeat without flapping. */
export const PRESENCE_EVERY_MS = 60_000;
export const PRESENCE_TTL_MS = 150_000;
/** How often stale entries are swept from the table — memory cleanup only: every gate
 *  re-checks `at` against the TTL at read time, so an inactive frontend stops counting
 *  at its TTL whatever this sweep's interval is. */
const SWEEP_EVERY_MS = 30_000;

/** The messages this module owns on the sync channel. The snapshot itself is
 *  workbenchSync's shape (`stateSnapshot`); this module only routes the request. */
export type PresenceMessage =
	| { by: string; k: 'presence'; active: boolean; device?: string }
	| { by: string; k: 'stateRequest' };

export interface PresenceDeps {
	send(message: PresenceMessage): void;
	receive(handler: (message: PresenceMessage) => void): () => void;
}

/** One other frontend as this side knows it. */
interface PresenceEntry {
	active: boolean;
	device: string;
	/** When its last sign of life arrived — the recency the catch-up's designated
	 *  responder is picked by. */
	at: number;
}

/**
 * The table. One per frontend (the sync's installer creates it), started with the sync and
 * stopped with it. Activity of SELF follows the document's visibility plus the explicit
 * `setSelfActive` (the desktop's close-to-hide path knows the window is going away even
 * when the page's own event lags); activity of OTHERS follows their announcements, the
 * heartbeat refreshals and the daemon's authoritative word fed through `noteExternal`.
 */
export class Presence {
	private readonly roster = new Map<string, PresenceEntry>();
	private readonly becameActiveHandlers = new Set<() => void>();
	private readonly rosterHandlers = new Set<() => void>();
	private readonly timers: ReturnType<typeof setInterval>[] = [];
	private detachReceive: (() => void) | null = null;
	private detachVisibility: (() => void) | null = null;
	// 'hidden' is the only state that means "not looking" (a backgrounded tab, a hidden
	// window, the bfcase); 'prerender' is a page still becoming visible — it counts as
	// active, and the heartbeat corrects if the page never shows.
	private selfActive = typeof document !== 'undefined' ? document.visibilityState !== 'hidden' : true;
	private selfAt = Date.now();
	private started = false;

	constructor(
		private readonly by: string,
		private readonly deps: PresenceDeps,
		private readonly options: { device?: () => string } = {}
	) {}

	/** Whether intent messages may cross right now (§7.0 rule 1): at least two active
	 *  frontends, this one included. Without the table the caller's own judgement stands. */
	syncAllowed(): boolean {
		return this.activeCount() >= 2;
	}

	/** This frontend's own activity right now. */
	isActive(): boolean {
		return this.selfActive;
	}

	/** Any OTHER frontend is active — the catch-up's precondition (7.0.3). */
	othersActive(): boolean {
		const now = Date.now();
		for (const entry of this.roster.values()) if (entry.active && now - entry.at <= PRESENCE_TTL_MS) return true;
		return false;
	}

	/** Any OTHER frontend is live — a roster entry within its TTL, whether active or not:
	 *  its socket is up (or was, within the heartbeat's reach), and the daemon holds what
	 *  such a page cannot take now and replays it on return. Closes cross on this word
	 *  (2026-10-19: the PC's closes must not wait for a sleeping phone's wake); opens and
	 *  active switches stay gated on `syncAllowed` — they disturb, a close converges. */
	othersLive(): boolean {
		const now = Date.now();
		for (const entry of this.roster.values()) if (now - entry.at <= PRESENCE_TTL_MS) return true;
		return false;
	}

	/** The active frontends this side sees, itself included. */
	activeCount(): number {
		let count = this.selfActive ? 1 : 0;
		const now = Date.now();
		for (const entry of this.roster.values()) if (entry.active && now - entry.at <= PRESENCE_TTL_MS) count += 1;
		return count;
	}

	/** Whether THIS frontend should answer `requester`'s state request: it must be active
	 *  itself, and among the active frontends that are neither the requester nor itself it
	 *  must be the most recently active one (§7.0 rule 3) — so exactly one snapshot crosses,
	 *  from the frontend whose state is freshest. Recency ties break on the id, keeping the
	 *  choice deterministic on both sides of the exchange. */
	isDesignatedResponder(requester: string): boolean {
		if (!this.selfActive || requester === this.by) return false;
		const now = Date.now();
		const alive = (entry: PresenceEntry): boolean => entry.active && now - entry.at <= PRESENCE_TTL_MS;
		let bestAt = this.selfAt;
		let bestId = this.by;
		for (const [id, entry] of this.roster) {
			if (id === requester || !alive(entry)) continue;
			if (entry.at > bestAt || (entry.at === bestAt && id > bestId)) {
				bestAt = entry.at;
				bestId = id;
			}
		}
		return bestId === this.by;
	}

	/** The catch-up trigger: this frontend just became active. */
	onBecameActive(handler: () => void): () => void {
		this.becameActiveHandlers.add(handler);
		return () => this.becameActiveHandlers.delete(handler);
	}

	/** The roster changed (someone joined, left or flipped) — the gate re-evaluated its
	 *  answer; a UI badge or a test watches this. */
	onRosterChange(handler: () => void): () => void {
		this.rosterHandlers.add(handler);
		return () => this.rosterHandlers.delete(handler);
	}

	/** Announce and listen. Idempotent. */
	start(): void {
		if (this.started) return;
		this.started = true;
		this.detachReceive = this.deps.receive((message) => this.receive(message));
		// The heartbeat is the table's clock: it refreshes everyone else's TTL for this
		// frontend and re-asserts its activity even when nothing else crosses (K11's
		// corollary — presence is the one message family that is never gated).
		this.timers.push(setInterval(() => this.announce(), PRESENCE_EVERY_MS));
		this.timers.push(setInterval(() => this.sweep(), SWEEP_EVERY_MS));
		if (typeof document !== 'undefined') {
			document.addEventListener('visibilitychange', this.onVisibility);
			window.addEventListener('focus', this.onFocus);
			this.detachVisibility = () => {
				document.removeEventListener('visibilitychange', this.onVisibility);
				window.removeEventListener('focus', this.onFocus);
			};
		}
		this.announce();
	}

	stop(): void {
		for (const timer of this.timers) clearInterval(timer);
		this.timers.length = 0;
		this.detachReceive?.();
		this.detachReceive = null;
		this.detachVisibility?.();
		this.detachVisibility = null;
		this.started = false;
	}

	/** This frontend's own activity, set explicitly (the desktop hiding its window on
	 *  close — the page may learn it late, or never, depending on the platform). */
	setSelfActive(active: boolean): void {
		this.applySelf(active);
	}

	/** The daemon's authoritative word on another frontend (the PC window's `visible`,
	 *  read from WINDOWS frames): it overrides a stale announcement. */
	noteExternal(by: string, active: boolean): void {
		const entry = this.roster.get(by);
		const now = Date.now();
		if (entry) {
			if (entry.active !== active) {
				entry.active = active;
				entry.at = now;
				this.rosterChanged();
			}
			return;
		}
		this.roster.set(by, { active, device: '', at: now });
		this.rosterChanged();
	}

	/** The catch-up request itself (§7.0 rule 3): the freshly active frontend asks the
	 *  others; the designated one answers. Sent through the raw channel — the gate has
	 *  nothing to say about the protocol that establishes it. */
	requestState(): void {
		this.deps.send({ by: this.by, k: 'stateRequest' });
	}

	private announce(): void {
		this.selfAt = Date.now();
		this.deps.send({ by: this.by, k: 'presence', active: this.selfActive, device: this.options.device?.() });
	}

	private receive(message: PresenceMessage): void {
		if (!message || message.by === this.by) return;
		// The wire is the workbench sync's shared channel, so the sync's own operation
		// messages (open, close, active, stateSnapshot, …) arrive here too — and none of
		// them carries an `active` boolean. Feeding one into the table would write
		// `active: undefined` over the sender's entry and drop it from every count until
		// its next heartbeat: only a `presence` announcement feeds the table (a
		// `stateRequest` is workbenchSync's to answer, and the rest are its to apply).
		if (message.k !== 'presence') return;
		const entry = this.roster.get(message.by);
		const now = Date.now();
		const wasActive = entry?.active ?? false;
		const wasLive = entry !== undefined && now - entry.at <= PRESENCE_TTL_MS;
		if (entry) {
			entry.active = message.active;
			entry.device = message.device ?? entry.device;
			entry.at = now;
		} else {
			this.roster.set(message.by, { active: message.active, device: message.device ?? '', at: now });
		}
		// A heartbeat from an inactive frontend refreshes its TTL but not its activity;
		// an arrival (new remote, page back from the background) does change the count.
		if (message.active !== wasActive || !wasLive) this.rosterChanged();
	}

	private applySelf(active: boolean): void {
		if (active === this.selfActive) return;
		this.selfActive = active;
		// Becoming active is the catch-up's trigger; becoming inactive only re-gates.
		if (active) {
			this.announce();
			for (const handler of [...this.becameActiveHandlers]) handler();
		} else {
			this.announce();
			this.rosterChanged();
		}
	}

	private readonly onVisibility = (): void => {
		this.applySelf(document.visibilityState !== 'hidden');
	};

	/** Focus implies visible — a shown window whose visibilitychange never fired (a
	 *  platform gap on restore-from-hide) still re-enters the table as active. */
	private readonly onFocus = (): void => {
		if (!this.selfActive) this.applySelf(true);
	};

	private sweep(): void {
		const now = Date.now();
		let changed = false;
		for (const [id, entry] of this.roster) {
			if (now - entry.at > PRESENCE_TTL_MS) {
				this.roster.delete(id);
				changed = true;
			}
		}
		if (changed) this.rosterChanged();
	}

	private rosterChanged(): void {
		for (const handler of [...this.rosterHandlers]) handler();
	}
}
