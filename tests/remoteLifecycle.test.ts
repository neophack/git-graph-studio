// The PC window lifecycle's unit half (docs/remote-client-plan.md §17, L1; §18.7's
// `tests/remoteLifecycle.test.ts` begins here): the close decision — G13's whole fix is
// that a window close with remote sessions attached HIDES instead of exiting — and the
// presence table the sync gates and catches up on (§7.0.1). The end-to-end halves (T1–T18)
// arrive with L2's probe; these units drive the decisions directly.
import { afterEach, describe, expect, it, vi } from 'vitest';

import { closeHidesWindow } from '../src/workbench/boot';
import { PRESENCE_EVERY_MS, PRESENCE_TTL_MS, Presence, type PresenceMessage } from '../src/remote/presence';

/* ---------- The close decision (§17.2, G13) ---------- */

describe('closeHidesWindow', () => {
	it('no daemon answer: the close exits as it always did', () => {
		expect(closeHidesWindow(null)).toBe(false);
		expect(closeHidesWindow(undefined)).toBe(false);
	});

	it('a --remote-host instance hides, whatever the sessions', () => {
		expect(closeHidesWindow({ remoteHostOnly: true, remoteSessions: 0 })).toBe(true);
	});

	it('any remote session the daemon reports keeps the instance alive — the G13 fix', () => {
		// Before L1 only a PC-screen viewer or a remote-host launch hid the window: a
		// remote running its OWN workbench connected, the PC user clicked ×, and the whole
		// instance — terminals, claude-code, a streaming reply — died under it.
		expect(closeHidesWindow({ remoteHostOnly: false, remoteSessions: 1 })).toBe(true);
		expect(closeHidesWindow({ remoteHostOnly: false, remoteSessions: 2 })).toBe(true);
		expect(closeHidesWindow({ remoteHostOnly: false, remoteSessions: 0 })).toBe(false);
		// An old daemon that never learned to say: the word's absence changes nothing.
		expect(closeHidesWindow({ remoteHostOnly: false })).toBe(false);
	});
});

/* ---------- The presence table (§7.0.1) ---------- */

/** A two-wire bus: messages flow to every OTHER participant (the sender's echo never
 *  reaches it — the page's own channel semantics), tests read what crossed. */
function bus() {
	const handlers = new Set<(message: PresenceMessage) => void>();
	const sent: PresenceMessage[] = [];
	return {
		sent,
		deps: {
			send: (message: PresenceMessage): void => {
				sent.push(message);
				for (const handler of [...handlers]) handler(message);
			},
			receive: (handler: (message: PresenceMessage) => void): (() => void) => {
				handlers.add(handler);
				return () => handlers.delete(handler);
			}
		}
	};
}

afterEach(() => {
	vi.useRealTimers();
});

describe('Presence', () => {
	it('announces itself at start and on every heartbeat — alone included', () => {
		vi.useFakeTimers();
		const channel = bus();
		const presence = new Presence('remote/1', channel.deps, { device: () => 'phone' });
		presence.start();
		expect(channel.sent).toEqual([{ by: 'remote/1', k: 'presence', active: true, device: 'phone' }]);
		// K11's corollary: presence is the one family that is never gated — a lone
		// frontend still heartbeats, because the others gate on hearing it.
		vi.advanceTimersByTime(PRESENCE_EVERY_MS * 3);
		expect(channel.sent.filter((m) => m.k === 'presence')).toHaveLength(4);
		presence.stop();
	});

	it('a lone active frontend is not allowed to sync; a second one opens the gate', () => {
		const channel = bus();
		const lone = new Presence('remote/1', channel.deps);
		lone.start();
		expect(lone.syncAllowed()).toBe(false);
		expect(lone.othersActive()).toBe(false);
		channel.deps.send({ by: 'main', k: 'presence', active: true, device: 'PC' });
		expect(lone.syncAllowed()).toBe(true);
		expect(lone.othersActive()).toBe(true);
		// The PC went away again: the gate closes with it.
		channel.deps.send({ by: 'main', k: 'presence', active: false, device: 'PC' });
		expect(lone.syncAllowed()).toBe(false);
		lone.stop();
	});

	it('an inactive heartbeat refreshes the TTL but not the count', () => {
		const channel = bus();
		const remote = new Presence('remote/1', channel.deps);
		remote.start();
		channel.deps.send({ by: 'main', k: 'presence', active: false });
		expect(remote.syncAllowed()).toBe(false);
	});

	it('a frontend whose last sign of life outlived the TTL stops counting', () => {
		vi.useFakeTimers();
		const channel = bus();
		const remote = new Presence('remote/1', channel.deps);
		remote.start();
		channel.deps.send({ by: 'main', k: 'presence', active: true });
		expect(remote.syncAllowed()).toBe(true);
		// Past the TTL and past a sweep: the entry is gone.
		vi.advanceTimersByTime(PRESENCE_TTL_MS + PRESENCE_EVERY_MS);
		expect(remote.syncAllowed()).toBe(false);
		remote.stop();
	});

	it('the daemon-visible word overrides a stale announcement (the PC authoritative source)', () => {
		const channel = bus();
		const remote = new Presence('remote/1', channel.deps);
		remote.start();
		// The PC announced itself active, then hid without a word crossing (its page's
		// own visibility event lagged or never fired): WINDOWS said visible: false.
		channel.deps.send({ by: 'main', k: 'presence', active: true });
		expect(remote.syncAllowed()).toBe(true);
		remote.noteExternal('main', false);
		expect(remote.syncAllowed()).toBe(false);
		remote.noteExternal('main', true);
		expect(remote.syncAllowed()).toBe(true);
		remote.stop();
	});

	it('the most recently active other frontend is the designated responder', () => {
		vi.useFakeTimers();
		const channel = bus();
		const a = new Presence('remote/1', channel.deps);
		const b = new Presence('remote/2', channel.deps);
		a.start();
		b.start();
		// B spoke last (its start's announce arrived after A's): B names itself, A names
		// B — exactly one of the pair answers a third frontend's request.
		expect(b.isDesignatedResponder('remote/9')).toBe(true);
		expect(a.isDesignatedResponder('remote/9')).toBe(false);
		// A hides and shows again (its close-to-hide path, then the tray's show): A's own
		// announcements re-tick its clock past B's word, and the designation flips —
		// still exactly one.
		vi.advanceTimersByTime(50);
		a.setSelfActive(false);
		a.setSelfActive(true);
		expect(a.isDesignatedResponder('remote/9')).toBe(true);
		expect(b.isDesignatedResponder('remote/9')).toBe(false);
		// A frontend never answers its own request, and an inactive one never answers.
		expect(a.isDesignatedResponder('remote/1')).toBe(false);
		a.setSelfActive(false);
		expect(a.isDesignatedResponder('remote/2')).toBe(false);
		a.stop();
		b.stop();
	});

	it('becoming active fires the catch-up trigger; becoming inactive does not', () => {
		const channel = bus();
		const pc = new Presence('main', channel.deps);
		const became: number[] = [];
		pc.start();
		pc.onBecameActive(() => became.push(1));
		pc.setSelfActive(false);
		expect(became).toHaveLength(0);
		pc.setSelfActive(true);
		expect(became).toHaveLength(1);
		pc.setSelfActive(true);
		expect(became).toHaveLength(1);
		pc.stop();
	});
});
