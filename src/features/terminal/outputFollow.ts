// The terminal page's output-follow state machine (docs/remote-client-plan.md §6.6): the
// sessions' OUTPUT subscriptions are held only while THIS frontend is looking at the
// terminal page. Leaving starts a 30 s grace timer — a quick page hop keeps the stream —
// and after it the subscriptions drop (the frontend carries no terminal traffic); coming
// back re-takes every session's subscription, catching up from the backend's 64 KB tail
// only when the grace actually ran out (a return inside the grace missed nothing).
//
// Standalone and timer-injected so the remote's page-follow drives it through the
// TerminalView and the tests drive it without xterm.

export interface FollowOps<T> {
	/** The live sessions, in list order. */
	sessions(): T[];
	/** Take (or re-take) one session's output subscription; `catchUp` marks a return after
	 *  an actual drop (the tail replay belongs in front). */
	subscribe(session: T, catchUp: boolean): Promise<void> | void;
	/** Drop one session's output subscription (its lifetime listeners stay). */
	drop(session: T): void;
}

export const FOLLOW_GRACE_MS = 30_000;

export class OutputFollow<T> {
	private following = true;
	private timer: number | null = null;
	private dropped = false;

	constructor(private readonly ops: FollowOps<T>) {}

	/** Whether the subscriptions are currently held (they survive the whole grace; only
	 *  the timer running out drops them). */
	get holding(): boolean {
		return !this.dropped;
	}

	/** Whether a return must catch up from the tail (an actual drop happened). */
	get catchUpNeeded(): boolean {
		return this.dropped;
	}

	/** A session appearing NOW starts subscribed only while following. */
	shouldSubscribeNew(): boolean {
		return this.following;
	}

	/** The page shows the terminal (true) or stopped showing it (false). Idempotent;
	 *  repeated `false` never stacks timers, repeated `true` re-subscribes at most once. */
	setFollowing(following: boolean, graceMs: number = FOLLOW_GRACE_MS): void {
		if (following) {
			this.following = true;
			if (this.timer !== null) {
				window.clearTimeout(this.timer);
				this.timer = null;
			}
			if (this.dropped) {
				this.dropped = false;
				for (const session of this.ops.sessions()) void this.ops.subscribe(session, true);
			}
			return;
		}
		this.following = false;
		if (this.timer === null) {
			this.timer = window.setTimeout(() => {
				this.timer = null;
				this.dropped = true;
				for (const session of this.ops.sessions()) this.ops.drop(session);
			}, graceMs);
		}
	}

	/** A session died: nothing to catch up for it. */
	dispose(): void {
		if (this.timer !== null) {
			window.clearTimeout(this.timer);
			this.timer = null;
		}
	}
}
