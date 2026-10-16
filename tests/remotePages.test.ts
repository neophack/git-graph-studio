// The Changes page and the terminal page (module 19, docs/remote-client-plan.md §6.3,
// §6.6, P2): the swipe-revealed row actions (a change row dragged left uncovers its stage
// verb and — unstaged — the discard), the rows' two-line layout marker, the diff editor's
// form rule (the page-stack shells read diffs inline whatever the pane measures), and the
// terminal output follow (a frontend not looking at the terminal page carries no terminal
// traffic: the 30 s grace, the drop, the tail catch-up on return).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installRemoteSessionHooks } from '../src/remote/desktopHooks';
installRemoteSessionHooks();
import { swipeReveal, closeRevealedRow, type RevealAction } from '../src/platform/ui';
import { OutputFollow } from '../src/features/terminal/outputFollow';
import { CommandRegistry } from '../src/platform/commands';
import { SourceControlView } from '../src/features/scm';
import { backend } from './tauriMock';
import { flush } from './helpers';

function pointer(node: HTMLElement, type: 'pointerdown' | 'pointermove' | 'pointerup', x: number, y = 10): void {
	node.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true }));
}

/** A row inside a list host, as the SCM view builds them (a child of a scroller). */
function rowInHost(): { host: HTMLElement; row: HTMLElement } {
	const host = document.createElement('div');
	const row = document.createElement('div');
	row.className = 'row';
	row.textContent = 'a.ts';
	host.appendChild(row);
	document.body.appendChild(host);
	return { host, row };
}

describe('the swipe-revealed row actions (§6.3)', () => {
	beforeEach(() => {
		document.body.replaceChildren();
	});
	afterEach(() => {
		closeRevealedRow();
	});

	it('reveals on a left drag past the threshold, snaps open, and the strip runs its verb', async () => {
		const { host, row } = rowInHost();
		const ran: string[] = [];
		const actions: RevealAction[] = [
			{ icon: 'discard', label: 'Discard', danger: true, run: () => ran.push('discard') },
			{ icon: 'add', label: 'Stage', run: () => ran.push('stage') }
		];
		Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 112 });
		try {
			swipeReveal(row, actions);
			expect(host.querySelector('.ggs-swipe-actions')).not.toBeNull();
			// A left drag (the finger moves −x): the row follows, the lift past the threshold
			// snaps it open.
			pointer(row, 'pointerdown', 200);
			pointer(row, 'pointermove', 160);
			pointer(row, 'pointermove', 120);
			pointer(row, 'pointerup', 120);
			expect(row.classList.contains('revealed')).toBe(true);
			const buttons = [...host.querySelectorAll<HTMLButtonElement>('.ggs-swipe-actions button')];
			expect(buttons).toHaveLength(2);
			expect(buttons[0].classList.contains('danger')).toBe(true);
			buttons[1].click();
			expect(ran).toEqual(['stage']);
			// The verb's run closed the row.
			expect(row.classList.contains('revealed')).toBe(false);
		} finally {
			delete (HTMLElement.prototype as { offsetWidth?: number }).offsetWidth;
		}
	});

	it('closes on a short drag, and the drag does not also click the row', async () => {
		const { row } = rowInHost();
		const ran: string[] = [];
		const clicked: string[] = [];
		row.addEventListener('click', () => clicked.push('row'));
		Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 112 });
		try {
			swipeReveal(row, [{ icon: 'add', label: 'Stage', run: () => ran.push('stage') }]);
			pointer(row, 'pointerdown', 200);
			pointer(row, 'pointermove', 190);
			pointer(row, 'pointerup', 190);
			expect(row.classList.contains('revealed')).toBe(false);
			// A drag that moved cancels the click that ends it (the row's own open).
			pointer(row, 'pointerdown', 200);
			pointer(row, 'pointermove', 170);
			pointer(row, 'pointerup', 170);
			row.click();
			expect(clicked).toEqual([]);
			expect(ran).toEqual([]);
		} finally {
			delete (HTMLElement.prototype as { offsetWidth?: number }).offsetWidth;
		}
	});

	it('a vertical drag never reveals (it scrolls), and one row open closes when another opens', async () => {
		const first = rowInHost();
		const second = rowInHost();
		Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 112 });
		try {
			const disposeA = swipeReveal(first.row, [{ icon: 'add', label: 'Stage', run: () => undefined }]);
			const disposeB = swipeReveal(second.row, [{ icon: 'add', label: 'Stage', run: () => undefined }]);
			pointer(first.row, 'pointerdown', 200);
			pointer(first.row, 'pointermove', 200, 60);
			pointer(first.row, 'pointerup', 200, 60);
			expect(first.row.classList.contains('revealed')).toBe(false);
			// One row open; the second's reveal closes the first.
			pointer(first.row, 'pointerdown', 200);
			pointer(first.row, 'pointermove', 120);
			pointer(first.row, 'pointerup', 120);
			expect(first.row.classList.contains('revealed')).toBe(true);
			pointer(second.row, 'pointerdown', 200);
			pointer(second.row, 'pointermove', 120);
			pointer(second.row, 'pointerup', 120);
			expect(second.row.classList.contains('revealed')).toBe(true);
			expect(first.row.classList.contains('revealed')).toBe(false);
			disposeA();
			disposeB();
			expect(document.querySelector('.ggs-swipe-actions')).toBeNull();
		} finally {
			delete (HTMLElement.prototype as { offsetWidth?: number }).offsetWidth;
		}
	});
});

describe('the change rows on the page-stack shells (§6.3)', () => {
	const REPO = 'C:\\repo';
	const change = (path: string, extra: Record<string, unknown> = {}) => ({ path, oldPath: null, staged: null, unstaged: null, untracked: false, ...extra });

	afterEach(() => {
		closeRevealedRow();
		delete document.documentElement.removeAttribute('data-page-stack');
		document.body.replaceChildren();
	});

	async function bootView(changes: ReturnType<typeof change>[]): Promise<void> {
		backend.on('scm_status', () => changes);
		backend.on('repo_head', () => ({ branch: 'main', shortHash: 'abc1234', ahead: 0, behind: 0, upstream: 'origin/main' }));
		for (const command of ['git_stage', 'git_unstage', 'git_discard']) backend.on(command, () => null);
		const sidebar = document.createElement('div');
		sidebar.id = 'sidebar';
		document.body.appendChild(sidebar);
		const view = new SourceControlView(sidebar, new CommandRegistry());
		view.setRepo(REPO);
		await view.refresh();
		// The strips build on the frame after the rows land; wait that frame explicitly —
		// under a loaded worker a plain timer flush can beat the rAF.
		await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
		await flush();
	}

	it('carry the swipe strip — the unstaged group with discard + stage, the staged with unstage', async () => {
		document.documentElement.setAttribute('data-page-stack', '');
		await bootView([
			change('README.md', { unstaged: 'modified' }),
			change('staged.ts', { staged: 'modified' })
		]);
		// The rows share one list container, so their strips land there together: the
		// staged row's unstage, then the unstaged row's discard + stage.
		const strips = document.querySelectorAll('.scm-rows .ggs-swipe-actions');
		expect(strips).toHaveLength(2);
		const labels = [...document.querySelectorAll('.ggs-swipe-actions button')].map((button) => button.getAttribute('aria-label'));
		expect(labels).toEqual(['Unstage Changes', 'Discard Changes', 'Stage Changes']);
		expect(document.querySelector('.ggs-swipe-actions button.danger')!.getAttribute('aria-label')).toBe('Discard Changes');
		// The strip's stage verb is the row's own handler: git_stage with the path.
		([...document.querySelectorAll('.ggs-swipe-actions button')].find((button) => button.getAttribute('aria-label') === 'Stage Changes') as HTMLElement).click();
		await flush();
		expect(backend.callsTo('git_stage')).toEqual([{ paths: ['README.md'] }]);
	});

	it('a desktop build carries no strip — the gesture belongs to the touch shells', async () => {
		await bootView([change('README.md', { unstaged: 'modified' })]);
		expect(document.querySelector('.ggs-swipe-actions')).toBeNull();
	});
});

describe('the terminal output follow (§6.6)', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	interface FakeSession {
		id: number;
	}

	function machine(): { follow: OutputFollow<FakeSession>; log: string[]; sessions: FakeSession[] } {
		const log: string[] = [];
		const sessions: FakeSession[] = [{ id: 1 }, { id: 2 }];
		const follow = new OutputFollow<FakeSession>({
			sessions: () => sessions,
			subscribe: (session, catchUp) => log.push(`take:${session.id}:${catchUp ? 'tail' : 'live'}`),
			drop: (session) => log.push(`drop:${session.id}`)
		});
		return { follow, log, sessions };
	}

	it('leaving holds the stream through the 30 s grace, then drops; returning re-takes with the tail', () => {
		const { follow, log } = machine();
		follow.setFollowing(false);
		// Inside the grace nothing dropped.
		vi.advanceTimersByTime(29_000);
		expect(log).toEqual([]);
		expect(follow.holding).toBe(true);
		// The grace runs out: both sessions' subscriptions drop.
		vi.advanceTimersByTime(1_000);
		expect(log).toEqual(['drop:1', 'drop:2']);
		expect(follow.holding).toBe(false);
		// The return re-takes both, catching up from the tail (an actual drop happened).
		follow.setFollowing(true);
		expect(log).toEqual(['drop:1', 'drop:2', 'take:1:tail', 'take:2:tail']);
		expect(follow.holding).toBe(true);
	});

	it('a page hop inside the grace keeps the stream — no drop, no catch-up', () => {
		const { follow, log } = machine();
		follow.setFollowing(false);
		vi.advanceTimersByTime(5_000);
		follow.setFollowing(true);
		vi.advanceTimersByTime(60_000);
		expect(log).toEqual([]);
		// The timer was cancelled by the return: nothing ever drops.
		expect(follow.holding).toBe(true);
	});

	it('a session created while away starts unsubscribed, and the return takes it with the tail', () => {
		const { follow, log } = machine();
		follow.setFollowing(false);
		vi.advanceTimersByTime(31_000);
		expect(follow.shouldSubscribeNew()).toBe(false);
		follow.setFollowing(true);
		expect(log).toEqual(['drop:1', 'drop:2', 'take:1:tail', 'take:2:tail']);
		// While following, a new session subscribes at birth.
		expect(follow.shouldSubscribeNew()).toBe(true);
	});

	it('repeated false never stacks timers (one drop per session however many flips)', () => {
		const { follow, log } = machine();
		follow.setFollowing(false);
		follow.setFollowing(false);
		follow.setFollowing(false);
		vi.advanceTimersByTime(31_000);
		expect(log).toEqual(['drop:1', 'drop:2']);
	});
});
