// The terminal session-sync planner (docs/ggs-remote-plan.md §8.6 #5, the remote terminal
// page's missing half before 2026-10-18): the terminals that run in the instance — the
// PC's, from a remote session — are one backend list, and every frontend's terminal page
// mirrors it. Pure and standalone (the outputFollow.ts precedent) so the sync's rules are
// testable without xterm:
//
//   - a backend session this frontend does not hold yet is ADOPTED (attached: the same
//     shell, the same output stream — never a second shell spawned beside it);
//   - an ADOPTED session that left the backend list (killed at the PC, exited on its own)
//     is retired here;
//   - a session this frontend CREATED keeps its own owner: its pty_create may still be in
//     flight (the backend list has not met it yet), and its death arrives as the exit
//     event it listened for from birth.

import type { PtySessionInfo } from '../../platform/ipc/pty';

/** The half of a held session the planner reads. `attached` marks one adopted from the
 *  backend's list (the remote's view of a PC terminal); a session created here is owned
 *  by its creator and never retired by the list alone. */
export interface SyncedSession {
	id: number;
	attached: boolean;
}

export interface SyncPlan<T extends SyncedSession> {
	/** Backend sessions this frontend does not hold yet — adopt each. */
	adopt: PtySessionInfo[];
	/** Held adopted sessions the backend no longer lists — retire each. */
	retire: T[];
}

export function planSessionSync<T extends SyncedSession>(held: T[], backend: PtySessionInfo[]): SyncPlan<T> {
	const own = new Set(held.map((session) => session.id));
	const live = new Set(backend.map((info) => info.id));
	return {
		adopt: backend.filter((info) => !own.has(info.id)),
		retire: held.filter((session) => session.attached && !live.has(session.id))
	};
}
