// The terminal session sync (module 11 + docs/ggs-remote-plan.md §8.6 #5 — the remote
// terminal page's missing half): the terminals that run in the instance are one backend
// list, and the terminal page MIRRORS it. A remote session arriving at the terminal page
// adopts the PC's shells (the 64 KB tail replayed, output followed live, input shared)
// instead of spawning a private shell beside them; a terminal opened anywhere appears on
// every open terminal page; one that died retires everywhere; the shared geometry
// (`pty-resized`) deforms every frontend along; and a page reload never kills a shell the
// page had merely adopted. The §6.6 follow's drop/return rides adopted sessions too.
import { beforeEach, describe, expect, it } from 'vitest';

import { TerminalView } from '../src/features/terminal';
import { planSessionSync } from '../src/features/terminal/sessionSync';
import { backend } from './tauriMock';
import { flush, until } from './helpers';

/** The scripted PTY backend: the session table pty_list answers, the tails pty_tail
 *  replays, and the broadcasts the real backend rides every mutation. */
interface Scripted {
	sessions: { id: number; name: string }[];
	tails: Map<number, string>;
}

let pty: Scripted;

/** The fake xterm instances the setup mock records, newest last. */
function terms(): { written: string[]; cols: number; rows: number; type(data: string): void; pressKey(): void }[] {
	return (globalThis as unknown as { __xterms: never[] }).__xterms as never[];
}

function writtenOf(index: number): string {
	return (terms()[index]?.written ?? []).join('');
}

/** The terminal list's row labels, as renderList paints them. */
function rowLabels(view: TerminalView): string[] {
	return Array.from(view.element.querySelectorAll('.terminal-tabs .row .label')).map((label) => label.textContent ?? '');
}

beforeEach(() => {
	pty = { sessions: [], tails: new Map() };
	backend.on('pty_list', () => pty.sessions.map((session) => ({ ...session })));
	backend.on('pty_tail', ({ id }) => pty.tails.get(id as number) ?? '');
	backend.on('pty_write', () => null);
	backend.on('pty_resize', ({ id, cols, rows }) => {
		backend.emit(`studio://pty-resized-${id}`, { cols, rows });
		return null;
	});
	backend.on('pty_create', ({ id }) => {
		pty.sessions.push({ id: id as number, name: 'git-bash' });
		backend.emit('studio://pty-sessions-changed', undefined);
		return 'git-bash';
	});
	backend.on('pty_kill', ({ id }) => {
		pty.sessions = pty.sessions.filter((session) => session.id !== id);
		backend.emit(`studio://pty-exit-${id}`, undefined);
		backend.emit('studio://pty-sessions-changed', undefined);
		return null;
	});
});

describe('the session-sync planner', () => {
	it('adopts backend sessions this frontend does not hold, and only those', () => {
		const plan = planSessionSync(
			[{ id: 1, attached: true }, { id: 2, attached: false }],
			[{ id: 1, name: 'a' }, { id: 2, name: 'b' }, { id: 3, name: 'c' }]
		);
		expect(plan.adopt).toEqual([{ id: 3, name: 'c' }]);
		expect(plan.retire).toEqual([]);
	});

	it('retires an adopted session the backend no longer lists', () => {
		const held = [{ id: 7, attached: true }, { id: 8, attached: true }];
		const plan = planSessionSync(held, [{ id: 8, name: 'b' }]);
		expect(plan.adopt).toEqual([]);
		expect(plan.retire).toEqual([held[0]]);
	});

	it('never retires a session this frontend created — its spawn may still be in flight', () => {
		const held = [{ id: 9, attached: false }];
		const plan = planSessionSync(held, []);
		expect(plan.retire).toEqual([]);
		// A created session IS the backend's once the spawn lands; the exit event owns its end.
		expect(planSessionSync(held, [{ id: 9, name: 'x' }]).adopt).toEqual([]);
	});
});

describe('the terminal page mirrors the instance\'s terminals (§8.6 #5)', () => {
	it('adopts the PC\'s shells — tail replayed, output live, never a spawn of its own', async () => {
		pty.sessions = [{ id: 7, name: 'git-bash' }, { id: 9, name: 'powershell' }];
		pty.tails.set(7, 'MINGW64 $ ');
		pty.tails.set(9, 'PS> ');
		const view = new TerminalView();
		await view.shown();
		expect(backend.callsTo('pty_create')).toEqual([]); // the bug this fixes: no private shell
		expect(view.sessionCount()).toBe(2);
		expect(rowLabels(view)).toEqual(['git-bash', 'powershell']);
		expect(writtenOf(0)).toContain('MINGW64 $ ');
		expect(writtenOf(1)).toContain('PS> ');
		// Live output reaches the adopted terms.
		backend.emit('studio://pty-output-7', 'cargo build\r\n');
		await flush();
		expect(writtenOf(0)).toContain('cargo build\r\n');
		// Typing writes the shared shell.
		terms()[0]!.type('ls\r');
		expect(backend.callsTo('pty_write')).toContainEqual({ id: 7, data: 'ls\r' });
	});

	it('an empty instance keeps the old behaviour — the first shown terminal is created', async () => {
		const view = new TerminalView();
		await view.shown();
		expect(backend.callsTo('pty_create')).toHaveLength(1);
		expect(view.sessionCount()).toBe(1);
		// The spawn's own sessions-changed announcement must not adopt the fresh session a
		// second time.
		await flush();
		expect(view.sessionCount()).toBe(1);
	});

	it('a terminal opened at the PC appears on an open terminal page', async () => {
		pty.sessions = [{ id: 5, name: 'git-bash' }];
		const view = new TerminalView();
		await view.shown();
		pty.sessions.push({ id: 11, name: 'powershell' });
		pty.tails.set(11, 'PS> ');
		backend.emit('studio://pty-sessions-changed', undefined);
		await until(() => view.sessionCount() === 2);
		expect(rowLabels(view)).toEqual(['git-bash', 'powershell']);
		expect(writtenOf(1)).toContain('PS> ');
		// The arrival did not steal the active terminal.
		expect(backend.callsTo('pty_create')).toEqual([]);
	});

	it('a terminal killed at the PC retires here — exit message and list both settle', async () => {
		pty.sessions = [{ id: 7, name: 'git-bash' }];
		const view = new TerminalView();
		await view.shown();
		pty.sessions = [];
		backend.emit('studio://pty-exit-7', undefined);
		backend.emit('studio://pty-sessions-changed', undefined);
		await until(() => view.sessionCount() === 0);
	});

	it('the shared geometry deforms the local terminal, and the echo does not loop', async () => {
		pty.sessions = [{ id: 7, name: 'git-bash' }];
		const view = new TerminalView();
		await view.shown();
		backend.emit('studio://pty-resized-7', { cols: 120, rows: 40 });
		expect(terms()[0]!.cols).toBe(120);
		expect(terms()[0]!.rows).toBe(40);
		// The adoption's echo rides the debounce and lands as a same-size resize — one
		// pty_resize, no ping-pong (the backend's change gate answers this shape too).
		await until(() => backend.callsTo('pty_resize').length > 0);
		expect(backend.callsTo('pty_resize')).toContainEqual({ id: 7, cols: 120, rows: 40 });
		const resizes = backend.callsTo('pty_resize').length;
		await flush();
		expect(backend.callsTo('pty_resize').length).toBe(resizes);
	});

	it('a page reload kills only the shells this frontend created — an adopted one lives', async () => {
		pty.sessions = [{ id: 7, name: 'git-bash' }];
		const view = new TerminalView();
		await view.shown(); // adopted 7
		// window-level unload handlers outlive the views of earlier tests in this file — the
		// assertion that matters is WHICH shells die: never the adopted one.
		window.dispatchEvent(new Event('beforeunload'));
		expect(backend.callsTo('pty_kill').map((args) => args.id)).not.toContain(7);

		pty.sessions = []; // an instance with nothing running: the view creates its own
		const own = new TerminalView();
		await own.shown();
		const created = backend.callsTo('pty_create').at(-1)!.id as number;
		window.dispatchEvent(new Event('beforeunload'));
		expect(backend.callsTo('pty_kill').map((args) => args.id)).toContain(created);
	});

	it('killing an adopted terminal is the deliberate act that kills the shared shell', async () => {
		pty.sessions = [{ id: 7, name: 'git-bash' }];
		const view = new TerminalView();
		await view.shown();
		await view.killActive();
		expect(backend.callsTo('pty_kill')).toContainEqual({ id: 7 });
		expect(view.sessionCount()).toBe(0);
	});
});

describe('the page follow over adopted sessions (§6.6)', () => {
	it('leaving drops the output subscription after the grace, returning catches up from the tail', async () => {
		pty.sessions = [{ id: 7, name: 'git-bash' }];
		pty.tails.set(7, 'the replayed tail');
		const view = new TerminalView();
		await view.shown();
		expect(view.outputSubscribed(7)).toBe(true);
		view.setOutputFollow(false, 0);
		await flush();
		expect(view.outputSubscribed(7)).toBe(false);
		// Away: output crosses unheard.
		backend.emit('studio://pty-output-7', 'while away');
		await flush();
		expect(writtenOf(0)).not.toContain('while away');
		view.setOutputFollow(true);
		await until(() => view.outputSubscribed(7));
		expect(writtenOf(0)).toContain('the replayed tail');
	});
});
