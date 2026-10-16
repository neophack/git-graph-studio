// Remote Access, the cross-frontend operation sync (module 19, docs/ggs-remote-plan.md
// §22.7): a PC on its desktop UI and a phone on its own phone workbench mirror each other's
// OPERATIONS — opens (with their line anchor), closes, active-tab switches and sidebar view
// switches cross as one tiny message each and land on the other side's own workbench.
// Tested at three depths: the sync core over a shared bus (two fakes, the relay's broadcast
// semantics — a message reaches every participant, its sender included), a real EditorArea
// under the sync (the facade, the change hooks, the path-keyed close/reveal), and the wired
// workbench (a file opened from the Explorer crosses through the real event channel, a
// remote message opens a real tab, a remote view switch moves the real sidebar, dispose
// stops the answering), and the extension pages over that wired workbench — stand-ins
// shaped like Claude Code (its activity-bar container and chat webview view, its chat tab)
// and Git Graph (its scm/title launcher and graph panel): their open, close and focus cross
// both ways, a panel's own create never echoes as a switch, and on a phone leaving a side
// page stays local. Plus the traffic bound the design promises: every message serializes
// to well under 200 bytes.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EditorArea } from '../src/features/editor';
import { Workbench } from '../src/workbench';
import { commands } from '../src/platform/commands';
import { attachWorkbenchSync, WORKBENCH_SYNC_EVENT, type SyncedEditorArea, type SyncPresence, type SyncedWorkbench, type WorkbenchSyncMessage } from '../src/remote/workbenchSync';
import { currentPresence } from '../src/remote/presence';
import { setRemoteEnv } from '../src/remote/session';
import { provideHook } from '../src/platform/hooks';
import { installRemoteSessionHooks } from '../src/remote/desktopHooks';

// The remote session's hooks, as boot.ts installs them before the workbench loads: the
// session-aware surfaces below read them through platform/hooks lookups.
installRemoteSessionHooks();
import { backend, emit as mockEmit, listen as mockListen } from './tauriMock';
import { click, flush, until } from './helpers';

vi.mock('mermaid', () => import('./mermaidStub'));
vi.mock('@mermaid-js/layout-elk', () => ({ default: {} }));

/* ---------- The bus: what the Relay does with an app event ---------- */

/** Every participant's handler, a sender's own included — the echo each side must ignore. */
function bus() {
	const handlers = new Set<(message: WorkbenchSyncMessage) => void>();
	const sent: WorkbenchSyncMessage[] = [];
	return {
		sent,
		/** One sender's own messages (the harness injects remote messages through the same
		 *  channel, so `sent` records those too). */
		by: (id: string): WorkbenchSyncMessage[] => sent.filter((message) => message.by === id),
		deps: {
			send: (message: WorkbenchSyncMessage): void => {
				sent.push(message);
				for (const handler of [...handlers]) handler(message);
			},
			receive: (handler: (message: WorkbenchSyncMessage) => void): (() => void) => {
				handlers.add(handler);
				return () => handlers.delete(handler);
			}
		}
	};
}

/** Two spellings of one file, the way the editor area's samePath reads them: slashes
 *  unified, a Windows drive path case-insensitive. */
function sameFile(a: string, b: string): boolean {
	const left = a.replace(/\\/g, '/');
	const right = b.replace(/\\/g, '/');
	if (left === right) return true;
	return /^[A-Za-z]:\//.test(left) && left.toLowerCase() === right.toLowerCase();
}

/** A stand-in workbench: its editor area records what the sync did to it. The
 *  extension-page tabs are the webview panels' (a real tab on the PC, a copy on a phone):
 *  opening one is the create mirror's business (it does not cross), closing one is the
 *  `closeTab` message's. The fake models the real editor's fine print the sync relies on:
 *  path lookups match by samePath, an `inactive` open never takes the focus, an open's
 *  implied activation is superseded by any later one (the editor's openIntent), a failed
 *  open resolves quietly (the editor notifies and returns), and a dirty tab's close waits
 *  on the save dialog until the test settles it. */
function fakeWorkbench(): SyncedWorkbench & {
	opened: { path: string; line?: number; column?: number }[];
	closed: string[];
	revealed: string[];
	views: string[];
	closedTabs: string[];
	tabs(): string[];
	extTabs(): string[];
	activePath(): string | null;
	setActive(path: string): void;
	close(path: string): boolean;
	openExtTab(id: string, activate?: boolean): void;
	clickExtTab(id: string): void;
	activeTabId(): string | null;
	revealedTabs: string[];
	closeTabById(id: string): boolean;
	setHold(hold: Promise<void> | null): void;
	failOpens: Set<string>;
	markDirty(path: string): void;
	settleClose(path: string): void;
	readonly sidebarToggles: number;
} {
	const state = {
		paths: [] as string[],
		active: null as string | null,
		opened: [] as { path: string; line?: number; column?: number }[],
		closed: [] as string[],
		revealed: [] as string[],
		views: [] as string[],
		extTabs: [] as string[],
		closedTabs: [] as string[],
		/** The active extension-page tab, when one holds the focus instead of a file. */
		activeTab: null as string | null,
		revealedTabs: [] as string[],
		sidebarShown: true,
		activeView: 'explorer',
		sidebarToggles: 0,
		/** While set, every open waits on it first — a test's stand-in for a slow file read. */
		hold: null as Promise<void> | null,
		/** Opens of these paths resolve without a tab — the editor's quiet failure. */
		failOpens: new Set<string>(),
		/** Paths whose close waits on the save dialog until settleClose answers it. */
		dirty: new Set<string>(),
		/** The editor's openIntent: only the newest open's landing takes the focus. */
		intent: 0
	};
	const notify = (): void => area.onTabsChange?.();
	const focus = (path: string): void => {
		state.activeTab = null;
		area.onActiveChange?.({ kind: 'file', path, line: 1, column: 1 });
	};
	/** A user or remote-applied activation: supersedes every in-flight open's ticket. */
	const activate = (path: string): void => {
		state.intent++;
		state.active = path;
		focus(path);
	};
	/** An extension page takes the focus: like the real group, the tabs change first (the
	 *  strip re-renders), then the active editor is reported. */
	const focusTab = (id: string, added: boolean): void => {
		state.intent++;
		state.activeTab = id;
		if (added) notify();
		area.onActiveChange?.({ kind: 'extpage', id, line: 1, column: 1 });
	};
	/** Take the tab at `index` out, activating the successor when it was showing. */
	const removeAt = (index: number): void => {
		const [removed] = state.paths.splice(index, 1);
		state.closed.push(removed!);
		if (state.active !== null && sameFile(state.active, removed!)) {
			state.active = state.paths[Math.max(0, index - 1)] ?? null;
			if (state.active !== null) focus(state.active);
		}
		notify();
	};
	const area: SyncedEditorArea = {
		async openFile(path, options) {
			const ticket = options?.inactive === true ? null : ++state.intent;
			if (state.hold !== null) await state.hold;
			if (state.failOpens.has(path)) return; // the editor's quiet failure: notify + return
			const index = state.paths.findIndex((open) => sameFile(open, path));
			if (index < 0) {
				state.paths.push(path);
				state.opened.push({ path, line: options?.line, column: options?.column });
				notify();
			}
			const stored = state.paths[index < 0 ? state.paths.length - 1 : index]!;
			if (ticket !== null && ticket === state.intent) {
				state.active = stored;
				focus(stored);
			}
		},
		openFilePaths: () => [...state.paths],
		openExtPageIds: () => [...state.extTabs],
		get activeInput() {
			if (state.activeTab !== null) return { kind: 'extpage', id: state.activeTab };
			return state.active === null ? null : { kind: 'file', path: state.active };
		},
		onTabsChange: null,
		onActiveChange: null,
		closeFilePath(path) {
			const index = state.paths.findIndex((open) => sameFile(open, path));
			if (index < 0) return false;
			// A dirty tab's close waits on the save dialog: the tab stays until settleClose.
			if (state.dirty.has(state.paths[index]!)) return true;
			removeAt(index);
			return true;
		},
		revealFilePath(path) {
			const stored = state.paths.find((open) => sameFile(open, path));
			if (stored === undefined) return false;
			state.revealed.push(stored);
			activate(stored);
			return true;
		},
		closeById(id) {
			const index = state.extTabs.indexOf(id);
			if (index < 0) return false;
			state.extTabs.splice(index, 1);
			state.closedTabs.push(id);
			if (state.activeTab === id) state.activeTab = null;
			notify();
			return true;
		},
		revealById(id) {
			if (!state.extTabs.includes(id)) return false;
			state.revealedTabs.push(id);
			focusTab(id, false);
			return true;
		}
	};
	return {
		editors: area,
		/** The remote-open boundary's roots: a permissive default so the suite's
		 *  cross-front-end opens behave as before; the confinement test narrows it. */
		openFolders: () => ['C:\\'],
		showView: (view: string) => {
			state.views.push(view);
			state.activeView = view;
			state.sidebarShown = true;
		},
		toggleSidebar: () => {
			state.sidebarToggles++;
			state.sidebarShown = !state.sidebarShown;
		},
		get sidebarShown() {
			return state.sidebarShown;
		},
		get activeSidebarView() {
			return state.activeView;
		},
		get sidebarToggles() {
			return state.sidebarToggles;
		},
		opened: state.opened,
		closed: state.closed,
		revealed: state.revealed,
		views: state.views,
		closedTabs: state.closedTabs,
		tabs: () => [...state.paths],
		extTabs: () => [...state.extTabs],
		activePath: () => state.active,
		setActive: activate,
		close: (path: string) => area.closeFilePath(path),
		openExtTab: (id: string, activateTab = false) => {
			if (state.extTabs.includes(id)) return;
			state.extTabs.push(id);
			if (activateTab) focusTab(id, true);
			else notify();
		},
		clickExtTab: (id: string) => focusTab(id, false),
		activeTabId: () => state.activeTab,
		revealedTabs: state.revealedTabs,
		closeTabById: (id: string) => area.closeById(id),
		setHold: (hold: Promise<void> | null) => {
			state.hold = hold;
		},
		failOpens: state.failOpens,
		markDirty: (path: string) => {
			const stored = state.paths.find((open) => sameFile(open, path));
			if (stored !== undefined) state.dirty.add(stored);
		},
		settleClose: (path: string) => {
			const index = state.paths.findIndex((open) => sameFile(open, path));
			if (index < 0) return;
			state.dirty.delete(state.paths[index]!);
			removeAt(index);
		}
	};
}

const NOTES = 'C:\\repo\\notes.txt';
const README = 'C:\\repo\\README.md';

describe('the sync core over a shared bus', () => {
	it('opens a file on the other side, anchor included, as exactly one message', async () => {
		const channel = bus();
		const pc = fakeWorkbench();
		const phone = fakeWorkbench();
		attachWorkbenchSync(pc, channel.deps, 'main');
		attachWorkbenchSync(phone, channel.deps, 'remote/1');
		await pc.editors.openFile(NOTES, { line: 42, column: 3 });
		expect(phone.tabs()).toEqual([NOTES]);
		expect(phone.opened).toEqual([{ path: NOTES, line: 42, column: 3 }]);
		expect(phone.activePath()).toBe(NOTES);
		// The open said everything: no follow-up active message for its own activation.
		expect(channel.sent).toEqual([{ by: 'main', k: 'open', path: NOTES, line: 42, column: 3 }]);
	});

	it('ignores a remote-originated open outside the open folders', async () => {
		const channel = bus();
		const pc = fakeWorkbench();
		const REPO = 'C:' + '\\repo';
		const SECRET = 'C:' + '\\Users\\me\\.ggs\\keys\\ai-providers.key';
		const NOTES_IN = REPO + '\\notes.txt';
		pc.openFolders = () => [REPO];
		const phone = fakeWorkbench();
		attachWorkbenchSync(pc, channel.deps, 'main');
		attachWorkbenchSync(phone, channel.deps, 'remote/1');
		channel.deps.send({ by: 'remote/1', k: 'open', path: SECRET });
		await new Promise((r) => setTimeout(r, 10));
		expect(pc.tabs()).toEqual([]);
		expect(pc.opened).toEqual([]);
		// Inside the folders it still crosses — the product behaviour is unchanged.
		channel.deps.send({ by: 'remote/1', k: 'open', path: NOTES_IN });
		await new Promise((r) => setTimeout(r, 10));
		expect(pc.tabs()).toEqual([NOTES_IN]);
	});

	it('re-checks a remote open whose path resolves outside through a symlink', async () => {
		const channel = bus();
		const pc = fakeWorkbench();
		const REPO = 'C:' + '\\repo';
		const LINK = REPO + '\\sneak.key';
		const SECRET = 'C:' + '\\Users\\me\\.ggs\\keys\\ai-providers.key';
		const NEWFILE = REPO + '\\new.txt';
		pc.openFolders = () => [REPO];
		const phone = fakeWorkbench();
		// The canonical answers, the shape `remote_canonical_paths` gives: the link's
		// target, and null for everything else (no answer — the lexical form stands).
		attachWorkbenchSync(pc, channel.deps, 'main', {
			canonicalPath: async (path) => (path === LINK ? SECRET : null)
		});
		attachWorkbenchSync(phone, channel.deps, 'remote/1');
		// Lexically inside the repo, resolved outside: refused.
		channel.deps.send({ by: 'remote/1', k: 'open', path: LINK });
		await new Promise((r) => setTimeout(r, 10));
		expect(pc.opened).toEqual([]);
		// No canonical form (not created yet) and a plain inside-root path both still open.
		channel.deps.send({ by: 'remote/1', k: 'open', path: NEWFILE });
		await new Promise((r) => setTimeout(r, 10));
		expect(pc.tabs()).toEqual([NEWFILE]);
		// A canonicalizer that cannot answer refuses the open too — never degrades open.
		const gatebroken = bus();
		const guarded = fakeWorkbench();
		guarded.openFolders = () => [REPO];
		attachWorkbenchSync(guarded, gatebroken.deps, 'main', {
			canonicalPath: async () => {
				throw new Error('backend gone');
			}
		});
		attachWorkbenchSync(fakeWorkbench(), gatebroken.deps, 'remote/1');
		gatebroken.deps.send({ by: 'remote/1', k: 'open', path: NEWFILE });
		await new Promise((r) => setTimeout(r, 10));
		expect(guarded.opened).toEqual([]);
	});

	it('closes on the other side whatever one side closed', async () => {
		const channel = bus();
		const pc = fakeWorkbench();
		const phone = fakeWorkbench();
		attachWorkbenchSync(pc, channel.deps, 'main');
		attachWorkbenchSync(phone, channel.deps, 'remote/1');
		await pc.editors.openFile(NOTES);
		await pc.editors.openFile(README);
		channel.sent.length = 0;
		phone.close(NOTES);
		await until(() => pc.tabs().length === 1);
		expect(pc.tabs()).toEqual([README]);
		expect(channel.sent).toEqual([{ by: 'remote/1', k: 'close', path: NOTES }]);
	});

	it('switches the active tab on the other side, and opens what it missed', async () => {
		const channel = bus();
		const pc = fakeWorkbench();
		const phone = fakeWorkbench();
		attachWorkbenchSync(pc, channel.deps, 'main');
		attachWorkbenchSync(phone, channel.deps, 'remote/1');
		await pc.editors.openFile(NOTES);
		await pc.editors.openFile(README);
		channel.sent.length = 0;
		pc.setActive(NOTES);
		expect(phone.revealed).toEqual([NOTES]);
		expect(phone.activePath()).toBe(NOTES);
		channel.sent.length = 0;
		// A file the receiver never saw (its page arrived late): activating it opens it —
		// the two sides converge on the same active document.
		channel.sent.length = 0;
		const late = fakeWorkbench();
		attachWorkbenchSync(late, channel.deps, 'remote/2');
		pc.setActive(README);
		expect(late.tabs()).toEqual([README]);
		expect(late.activePath()).toBe(README);
	});

	it('a view switch stays on its own frontend — the sidebar is local layout (G8, K7)', () => {
		const channel = bus();
		const pc = fakeWorkbench();
		const phone = fakeWorkbench();
		attachWorkbenchSync(pc, channel.deps, 'main');
		attachWorkbenchSync(phone, channel.deps, 'remote/1');
		pc.showView('scm');
		expect(pc.views).toEqual(['scm']);
		expect(phone.views).toEqual([]);
		expect(channel.sent).toEqual([]);
	});

	it('ignores its own echo and never ping-pongs', async () => {
		const channel = bus();
		const pc = fakeWorkbench();
		const phone = fakeWorkbench();
		attachWorkbenchSync(pc, channel.deps, 'main');
		attachWorkbenchSync(phone, channel.deps, 'remote/1');
		await pc.editors.openFile(NOTES);
		await phone.close(NOTES);
		// Exactly two user operations, exactly two messages — the broadcast's echo back to
		// each sender, and each applied operation's local hooks, crossed as nothing.
		expect(channel.sent).toEqual([
			{ by: 'main', k: 'open', path: NOTES },
			{ by: 'remote/1', k: 'close', path: NOTES }
		]);
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(channel.sent.length).toBe(2);
	});

	it('stays silent until started, and detaches back to a plain workbench', async () => {
		const channel = bus();
		const pc = fakeWorkbench();
		const phone = fakeWorkbench();
		const pcSync = attachWorkbenchSync(pc, channel.deps, 'main', { startImmediately: false });
		attachWorkbenchSync(phone, channel.deps, 'remote/1');
		await pc.editors.openFile(NOTES);
		await pc.showView('explorer');
		expect(channel.sent).toEqual([]); // a booting workbench announces nothing
		expect(phone.tabs()).toEqual([]);
		pcSync.start();
		await pc.editors.openFile(README);
		expect(phone.tabs()).toEqual([README]);
		pcSync.detach();
		channel.sent.length = 0;
		await pc.editors.openFile(`${NOTES}2`);
		expect(phone.tabs()).toEqual([README]);
		expect(channel.sent).toEqual([]);
	});

	it('still crosses a local close that lands while a remote open is in flight', async () => {
		const channel = bus();
		const pc = fakeWorkbench();
		const phone = fakeWorkbench();
		attachWorkbenchSync(pc, channel.deps, 'main');
		attachWorkbenchSync(phone, channel.deps, 'remote/1');
		await pc.editors.openFile(NOTES);
		channel.sent.length = 0;
		let release!: () => void;
		pc.setHold(new Promise<void>((resolve) => {
			release = resolve;
		}));
		// A remote open arrives and its apply stalls on the hold; meanwhile the user here
		// closes their tab — the close crosses now, not swallowed by the in-flight apply.
		channel.deps.send({ by: 'remote/1', k: 'open', path: README });
		await new Promise((resolve) => setTimeout(resolve, 0));
		pc.close(NOTES);
		expect(channel.by('main')).toEqual([{ by: 'main', k: 'close', path: NOTES }]);
		release();
		pc.setHold(null);
		await new Promise((resolve) => setTimeout(resolve, 0));
		// The stalled apply settled: the remote's file is open here, and its arrival crossed
		// back as nothing (the sender already knows its own open).
		expect(pc.tabs()).toEqual([README]);
		expect(channel.by('main')).toEqual([{ by: 'main', k: 'close', path: NOTES }]);
	});

	it('goes quiet for a session restore: rebuilt tabs stay local, later operations cross', async () => {
		const channel = bus();
		const pc = fakeWorkbench();
		const phone = fakeWorkbench();
		const sync = attachWorkbenchSync(pc, channel.deps, 'main');
		attachWorkbenchSync(phone, channel.deps, 'remote/1');
		sync.localOnly(true);
		await pc.editors.openFile(NOTES);
		await pc.editors.openFile(README);
		expect(channel.sent).toEqual([]);
		expect(phone.tabs()).toEqual([]);
		sync.localOnly(false);
		// A genuine user open crosses again, and the restored baseline is the truth: a
		// restored tab's close is a real operation now.
		const EXTRA = `${NOTES}.x`;
		await pc.editors.openFile(EXTRA);
		expect(channel.sent).toEqual([{ by: 'main', k: 'open', path: EXTRA }]);
		channel.sent.length = 0;
		pc.close(NOTES);
		expect(channel.sent).toEqual([{ by: 'main', k: 'close', path: NOTES }]);
	});

	it('closes an extension page on the other side — a copy closed on a phone closes the PC panel', async () => {
		const channel = bus();
		const pc = fakeWorkbench();
		const phone = fakeWorkbench();
		attachWorkbenchSync(pc, channel.deps, 'main');
		attachWorkbenchSync(phone, channel.deps, 'remote/1');
		// The create mirror opened the panel everywhere: both sides hold the same tab id.
		pc.openExtTab('webview:acme.engine:7');
		phone.openExtTab('webview:acme.engine:7');
		expect(channel.sent).toEqual([]); // an extension page's OPEN never crosses (§22.6 owns it)
		channel.sent.length = 0;
		phone.closeTabById('webview:acme.engine:7');
		expect(pc.extTabs()).toEqual([]);
		expect(pc.closedTabs).toEqual(['webview:acme.engine:7']);
		// Exactly one message, and the PC's applied close crossed back as nothing.
		expect(channel.sent).toEqual([{ by: 'remote/1', k: 'closeTab', id: 'webview:acme.engine:7' }]);
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(channel.sent.length).toBe(1);
	});

	it('closes every copy when the PC closes the real panel', async () => {
		const channel = bus();
		const pc = fakeWorkbench();
		const phone = fakeWorkbench();
		attachWorkbenchSync(pc, channel.deps, 'main');
		attachWorkbenchSync(phone, channel.deps, 'remote/1');
		pc.openExtTab('webview:acme.engine:7');
		phone.openExtTab('webview:acme.engine:7');
		channel.sent.length = 0;
		pc.closeTabById('webview:acme.engine:7');
		expect(phone.closedTabs).toEqual(['webview:acme.engine:7']);
		expect(channel.by('main')).toEqual([{ by: 'main', k: 'closeTab', id: 'webview:acme.engine:7' }]);
	});

	it('brings an extension page forward on the other side when one side focuses it', async () => {
		const channel = bus();
		const pc = fakeWorkbench();
		const phone = fakeWorkbench();
		attachWorkbenchSync(pc, channel.deps, 'main');
		attachWorkbenchSync(phone, channel.deps, 'remote/1');
		await pc.editors.openFile(NOTES);
		// The Git Graph panel and Claude Code's chat tab, opened everywhere by the create
		// mirror in the background.
		pc.openExtTab('webview:acme.graph:1');
		phone.openExtTab('webview:acme.graph:1');
		pc.openExtTab('webview:acme.chat:2');
		phone.openExtTab('webview:acme.chat:2');
		channel.sent.length = 0;
		// The PC user clicks the graph's tab: the phone shows the graph.
		pc.clickExtTab('webview:acme.graph:1');
		expect(channel.sent).toEqual([{ by: 'main', k: 'activeTab', id: 'webview:acme.graph:1' }]);
		expect(phone.activeTabId()).toBe('webview:acme.graph:1');
		// The phone user picks the chat (a later task: the applied reveal has settled): the PC
		// shows the chat - and nothing echoes back.
		await new Promise((resolve) => setTimeout(resolve, 0));
		channel.sent.length = 0;
		phone.clickExtTab('webview:acme.chat:2');
		expect(pc.activeTabId()).toBe('webview:acme.chat:2');
		expect(pc.revealedTabs).toEqual(['webview:acme.chat:2']);
		// Back to a file on the PC: the phone leaves the chat for it.
		await new Promise((resolve) => setTimeout(resolve, 0));
		pc.setActive(NOTES);
		expect(phone.activePath()).toBe(NOTES);
		expect(phone.activeTabId()).toBeNull();
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(channel.sent).toEqual([
			{ by: 'remote/1', k: 'activeTab', id: 'webview:acme.chat:2' },
			{ by: 'main', k: 'active', path: NOTES }
		]);
	});

	it('never echoes a panel create as a switch - the create mirror opens it on every side', async () => {
		const channel = bus();
		const pc = fakeWorkbench();
		const phone = fakeWorkbench();
		attachWorkbenchSync(pc, channel.deps, 'main');
		attachWorkbenchSync(phone, channel.deps, 'remote/1');
		// Opened in the foreground on both sides at once: each side's own activation stays put.
		pc.openExtTab('webview:acme.graph:1', true);
		phone.openExtTab('webview:acme.graph:1', true);
		expect(channel.sent).toEqual([]);
		// The user leaves and comes back: that switch is real and crosses.
		await pc.editors.openFile(NOTES);
		channel.sent.length = 0;
		pc.clickExtTab('webview:acme.graph:1');
		expect(channel.sent).toEqual([{ by: 'main', k: 'activeTab', id: 'webview:acme.graph:1' }]);
		// A cursor move inside the same tab re-reports it: nothing more crosses.
		pc.clickExtTab('webview:acme.graph:1');
		expect(channel.sent.length).toBe(1);
	});

	it('a side bar hide stays on its own frontend — layout never crosses (G8, K7)', async () => {
		const channel = bus();
		const pc = fakeWorkbench();
		const phone = fakeWorkbench();
		attachWorkbenchSync(pc, channel.deps, 'main');
		attachWorkbenchSync(phone, channel.deps, 'remote/1');
		phone.toggleSidebar!();
		expect(phone.sidebarShown).toBe(false);
		expect(pc.sidebarShown).toBe(true);
		expect(channel.sent).toEqual([]);
		// And a stray legacy message of the retired vocabulary changes nothing anywhere
		// (the bus records what the harness itself injects — read past it).
		channel.deps.send({ by: 'remote/1', k: 'sidebar', shown: false } as unknown as WorkbenchSyncMessage);
		expect(pc.sidebarShown).toBe(true);
		// The bus records the harness's own injection — what matters is that nothing
		// ECHOED back from either side after it.
		channel.sent.length = 0;
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(channel.sent).toEqual([]);
	});

	it('crosses every message as well under 200 bytes', async () => {
		const channel = bus();
		const pc = fakeWorkbench();
		const phone = fakeWorkbench();
		attachWorkbenchSync(pc, channel.deps, 'main');
		attachWorkbenchSync(phone, channel.deps, 'remote/1');
		await pc.editors.openFile(NOTES, { line: 1200, column: 40 });
		pc.setActive(NOTES);
		phone.close(NOTES);
		expect(channel.sent.length).toBeGreaterThanOrEqual(2);
		for (const message of channel.sent) {
			expect(JSON.stringify(message).length).toBeLessThan(200);
		}
	});

	it('a failed remote open never rebounds as a close of the sender healthy tab', async () => {
		const channel = bus();
		const pc = fakeWorkbench();
		const phone = fakeWorkbench();
		attachWorkbenchSync(pc, channel.deps, 'main');
		attachWorkbenchSync(phone, channel.deps, 'remote/1');
		await pc.editors.openFile(NOTES);
		// The phone cannot read this one (the editor notifies and returns — no throw).
		phone.failOpens.add(README);
		await pc.editors.openFile(README);
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(phone.tabs()).toEqual([NOTES]);
		// The next tabs diff on the phone must not read the failed open as a close of the
		// PC's healthy tab: the phone opens a file of its own, and nothing about README
		// crosses back.
		channel.sent.length = 0;
		await phone.editors.openFile(`${NOTES}.x`);
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(channel.by('remote/1').filter((m) => m.k === 'close')).toEqual([]);
		// The PC's healthy README stayed open, and the phone's own open synced normally.
		expect(pc.tabs()).toEqual([NOTES, README, `${NOTES}.x`]);
		expect(pc.closed).toEqual([]);
	});

	it('closes a tab whose open was still in flight the moment it lands', async () => {
		const channel = bus();
		const pc = fakeWorkbench();
		const phone = fakeWorkbench();
		attachWorkbenchSync(pc, channel.deps, 'main');
		attachWorkbenchSync(phone, channel.deps, 'remote/1');
		await pc.editors.openFile(NOTES);
		channel.sent.length = 0;
		// The phone's apply of the PC's open stalls on its slow read; the PC's close of the
		// same file crosses meanwhile.
		let release!: () => void;
		phone.setHold(new Promise<void>((resolve) => (release = resolve)));
		await pc.editors.openFile(README);
		await new Promise((resolve) => setTimeout(resolve, 0));
		pc.close(README);
		release();
		phone.setHold(null);
		await until(() => phone.closed.includes(README));
		await new Promise((resolve) => setTimeout(resolve, 5));
		// The landed open was closed right away, and nothing re-announced it: the PC never
		// re-opens its just-closed tab.
		expect(phone.tabs()).toEqual([NOTES]);
		expect(channel.by('remote/1').filter((m) => m.k === 'open')).toEqual([]);
		expect(pc.tabs()).toEqual([NOTES]);
		expect(pc.opened.filter((entry) => entry.path === README)).toHaveLength(1);
	});

	it('an open superseded mid-flight lands in the background, and switching to it crosses', async () => {
		const channel = bus();
		const pc = fakeWorkbench();
		const phone = fakeWorkbench();
		attachWorkbenchSync(pc, channel.deps, 'main');
		attachWorkbenchSync(phone, channel.deps, 'remote/1');
		await phone.editors.openFile(NOTES);
		await phone.editors.openFile(`${NOTES}.y`);
		let release!: () => void;
		phone.setHold(new Promise<void>((resolve) => (release = resolve)));
		const opening = phone.editors.openFile(README);
		await new Promise((resolve) => setTimeout(resolve, 0));
		channel.sent.length = 0;
		// Before README lands the user picks another existing tab — README's implied
		// activation is superseded, so it lands in the background and announces nothing.
		phone.setActive(NOTES);
		expect(channel.by('remote/1')).toEqual([{ by: 'remote/1', k: 'active', path: NOTES }]);
		release();
		phone.setHold(null);
		await opening;
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(phone.activePath()).toBe(NOTES);
		expect(channel.by('remote/1')).toEqual([{ by: 'remote/1', k: 'active', path: NOTES }]);
		// The user's later switch to README is a real switch, not the stale open's echo.
		phone.setActive(README);
		expect(channel.by('remote/1')).toContainEqual({ by: 'remote/1', k: 'active', path: README });
	});

	it('a background open never pends an activation, and the later switch to it crosses', async () => {
		const channel = bus();
		const pc = fakeWorkbench();
		const phone = fakeWorkbench();
		attachWorkbenchSync(pc, channel.deps, 'main');
		attachWorkbenchSync(phone, channel.deps, 'remote/1');
		await phone.editors.openFile(NOTES);
		await phone.editors.openFile(README, { inactive: true });
		expect(phone.activePath()).toBe(NOTES);
		channel.sent.length = 0;
		phone.setActive(README);
		expect(channel.by('remote/1')).toEqual([{ by: 'remote/1', k: 'active', path: README }]);
	});

	it('converges one file across two spellings instead of oscillating close/open', async () => {
		const channel = bus();
		const pc = fakeWorkbench();
		const phone = fakeWorkbench();
		// The phone restored its session before the sync attached, with its own spelling.
		await phone.editors.openFile('c:\\repo\\notes.txt');
		attachWorkbenchSync(pc, channel.deps, 'main');
		attachWorkbenchSync(phone, channel.deps, 'remote/1');
		await pc.editors.openFile(NOTES);
		await new Promise((resolve) => setTimeout(resolve, 5));
		// The phone recognized its restored tab: no duplicate, and nothing bounced back.
		expect(phone.tabs()).toEqual(['c:\\repo\\notes.txt']);
		expect(channel.by('remote/1')).toEqual([]);
		expect(pc.tabs()).toEqual([NOTES]);
		// The PC's close closes the phone's restored spelling, and that is the end of it.
		channel.sent.length = 0;
		pc.close(NOTES);
		await until(() => phone.tabs().length === 0);
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(channel.by('remote/1')).toEqual([]);
		expect(pc.tabs()).toEqual([]);
	});

	it('a dirty tab closed from the other side never drags it to the successor', async () => {
		const channel = bus();
		const pc = fakeWorkbench();
		const phone = fakeWorkbench();
		attachWorkbenchSync(pc, channel.deps, 'main');
		attachWorkbenchSync(pc, channel.deps, 'main');
		const phoneSync = attachWorkbenchSync(phone, channel.deps, 'remote/1');
		await pc.editors.openFile(NOTES);
		await pc.editors.openFile(README);
		pc.setActive(README);
		await new Promise((resolve) => setTimeout(resolve, 5));
		// The phone's user is looking at NOTES (a divergence the sync allows to stand — a
		// session restore's baseline), and their copy is dirty.
		phoneSync.localOnly(true);
		phone.setActive(NOTES);
		phoneSync.localOnly(false);
		phone.markDirty(NOTES);
		channel.sent.length = 0;
		pc.close(NOTES);
		// The phone's close waits on the save dialog: the tab stays meanwhile.
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(phone.tabs()).toEqual([NOTES, README]);
		// The user discards: the close completes and the successor takes the focus locally —
		// but that activation is the close's consequence, never a switch to cross.
		phone.settleClose(NOTES);
		await until(() => !phone.tabs().includes(NOTES));
		await new Promise((resolve) => setTimeout(resolve, 250)); // the hold's poll releases
		expect(channel.by('remote/1').filter((m) => m.k === 'active')).toEqual([]);
		expect(phone.activePath()).toBe(README);
		// The hold has released: the next real switch crosses again.
		await phone.editors.openFile(`${NOTES}.x`);
		channel.sent.length = 0;
		phone.setActive(README);
		expect(channel.by('remote/1')).toEqual([{ by: 'remote/1', k: 'active', path: README }]);
	});
});

/* ---------- The presence gate and the catch-up (docs/remote-client-plan.md §7.0) ---------- */

/** A stand-in presence table: `count` is what the roster answers, `became()` fires the
 *  becoming-active handlers the real document events would, and `designate` picks the
 *  responder of a state request. */
function fakePresence(count = 2): SyncPresence & { count: number; became(): void; designate: (requester: string) => boolean } {
	const handlers = new Set<() => void>();
	const presence = {
		count,
		designate: (): boolean => true,
		syncAllowed: (): boolean => presence.count >= 2,
		othersActive: (): boolean => presence.count >= 2,
		isDesignatedResponder: (requester: string): boolean => presence.designate(requester),
		onBecameActive: (handler: () => void): (() => void) => {
			handlers.add(handler);
			return () => handlers.delete(handler);
		},
		isActive: (): boolean => true,
		became: (): void => {
			for (const handler of [...handlers]) handler();
		}
	};
	return presence;
}

describe('the presence gate (§7.0, K11)', () => {
	it('a lone active frontend sends nothing at all — twenty files, switches and closes', async () => {
		const channel = bus();
		const phone = fakeWorkbench();
		const alone = fakePresence(1);
		attachWorkbenchSync(phone, channel.deps, 'remote/1', { presence: alone });
		for (let i = 0; i < 20; i++) await phone.editors.openFile(`${NOTES}.${i}`);
		phone.setActive(`${NOTES}.3`);
		phone.close(`${NOTES}.4`);
		expect(channel.sent).toEqual([]);
	});

	it('two active frontends sync — and the moment one leaves, the gate closes', async () => {
		const channel = bus();
		const pc = fakeWorkbench();
		const phone = fakeWorkbench();
		const pcPresence = fakePresence(2);
		const phonePresence = fakePresence(2);
		attachWorkbenchSync(pc, channel.deps, 'main', { presence: pcPresence });
		attachWorkbenchSync(phone, channel.deps, 'remote/1', { presence: phonePresence });
		await pc.editors.openFile(NOTES);
		expect(phone.tabs()).toEqual([NOTES]);
		channel.sent.length = 0;
		// The PC window hides: both sides see one active frontend, nothing crosses anymore.
		pcPresence.count = 1;
		phonePresence.count = 1;
		await pc.editors.openFile(README);
		pc.setActive(README);
		expect(channel.sent).toEqual([]);
	});

	it('PC and two remotes: every open reaches both other frontends (K10)', async () => {
		const channel = bus();
		const pc = fakeWorkbench();
		const a = fakeWorkbench();
		const b = fakeWorkbench();
		attachWorkbenchSync(pc, channel.deps, 'main', { presence: fakePresence(3) });
		attachWorkbenchSync(a, channel.deps, 'remote/1', { presence: fakePresence(3) });
		attachWorkbenchSync(b, channel.deps, 'remote/2', { presence: fakePresence(3) });
		await a.editors.openFile(NOTES);
		expect(pc.tabs()).toEqual([NOTES]);
		expect(b.tabs()).toEqual([NOTES]);
		channel.sent.length = 0;
		// A remote-to-remote switch crosses the same way: B opens a file of its own (which
		// itself reaches everyone), then switches back — a real switch, not an echo.
		await b.editors.openFile(README);
		await until(() => a.tabs().length === 2 && pc.tabs().length === 2);
		channel.sent.length = 0;
		b.setActive(NOTES);
		expect(a.activePath()).toBe(NOTES);
		expect(pc.activePath()).toBe(NOTES);
		expect(channel.sent.filter((m) => m.k === 'active')).toEqual([{ by: 'remote/2', k: 'active', path: NOTES }]);
	});
});

describe('the catch-up (§7.0.3, K14)', () => {
	it('a frontend becoming active asks, the designated other answers, and the joiner follows it', async () => {
		const channel = bus();
		const pc = fakeWorkbench();
		const remote = fakeWorkbench();
		// The remote worked ALONE (gated): three tabs of its own, one of them active.
		const remotePresence = fakePresence(1);
		const remoteSync = attachWorkbenchSync(remote, channel.deps, 'remote/1', { presence: remotePresence });
		remoteSync.localOnly(true);
		await remote.editors.openFile(NOTES);
		await remote.editors.openFile(README);
		await remote.editors.openFile(`${NOTES}.x`);
		remote.setActive(README);
		remoteSync.localOnly(false);
		expect(channel.sent).toEqual([]);
		// The PC window comes back: it is active, it asks. The remote answers (it is now the
		// designated responder, and both count two actives).
		const pcPresence = fakePresence(2);
		remotePresence.count = 2;
		attachWorkbenchSync(pc, channel.deps, 'main', { presence: pcPresence, startImmediately: false }).start();
		await until(() => channel.sent.some((m) => m.k === 'stateSnapshot'));
		await until(() => pc.tabs().length === 3);
		// The union: every remote tab opened on the PC, in the background — the PC's own
		// active follows the remote's (K14).
		expect(pc.tabs().sort()).toEqual([`${NOTES}.x`, NOTES, README].sort());
		expect(pc.activePath()).toBe(README);
		// The joiner's own tabs the answerer lacks cross back as background opens — here
		// the PC had none, so nothing crossed back.
		expect(remote.tabs()).toEqual([NOTES, README, `${NOTES}.x`]);
		// No tab ever closed over the catch-up, and after it the two sides sync normally.
		channel.sent.length = 0;
		await pc.editors.openFile(`${NOTES}.y`);
		expect(remote.tabs()).toContain(`${NOTES}.y`);
	});

	it('the joiner pushes its own tabs back, and never closes anything over a snapshot', async () => {
		const channel = bus();
		const pc = fakeWorkbench();
		const remote = fakeWorkbench();
		// The PC is the established one (two tabs, one active); the remote worked alone
		// with a tab of its own the PC lacks.
		const pcPresence = fakePresence(2);
		const remotePresence = fakePresence(1);
		const pcSync = attachWorkbenchSync(pc, channel.deps, 'main', { presence: pcPresence });
		const remoteSync = attachWorkbenchSync(remote, channel.deps, 'remote/1', { presence: remotePresence });
		pcSync.localOnly(true);
		await pc.editors.openFile(NOTES);
		await pc.editors.openFile(README);
		pc.setActive(NOTES);
		pcSync.localOnly(false);
		const SOLO = `${NOTES}.solo`;
		remoteSync.localOnly(true);
		await remote.editors.openFile(SOLO);
		remoteSync.localOnly(false);
		channel.sent.length = 0;
		// The remote becomes active (both sides now count two): it asks, the PC answers.
		remotePresence.count = 2;
		remotePresence.became();
		await until(() => channel.sent.some((m) => m.k === 'stateSnapshot'));
		await until(() => remote.tabs().length === 3);
		expect(remote.tabs().sort()).toEqual([SOLO, NOTES, README].sort());
		expect(remote.activePath()).toBe(NOTES);
		// The union runs both ways: the remote's own tab crossed back as a background open.
		await until(() => pc.tabs().includes(SOLO));
		// Nothing closed anywhere over the catch-up.
		expect(pc.tabs().sort()).toEqual([SOLO, NOTES, README].sort());
	});

	it('a snapshot from a remote opens only paths inside this window folders', async () => {
		const channel = bus();
		const pc = fakeWorkbench();
		pc.openFolders = () => ['C:\\repo'];
		const presence = fakePresence(2);
		const sync = attachWorkbenchSync(pc, channel.deps, 'main', { presence, startImmediately: false });
		sync.start();
		// The awaiting window is armed by the start's own catch-up request.
		await until(() => channel.sent.some((m) => m.k === 'stateRequest'));
		channel.deps.send({
			by: 'remote/1',
			k: 'stateSnapshot',
			to: 'main',
			files: ['C:\\repo\\in.txt', 'C:\\Users\\me\\.ggs\\keys\\ai-providers.key'],
			tabs: [],
			extTabs: [],
			active: { kind: 'file', path: 'C:\\repo\\in.txt' }
		});
		await until(() => pc.tabs().includes('C:\\repo\\in.txt'));
		expect(pc.tabs()).toEqual(['C:\\repo\\in.txt']);
	});

	it('only the designated responder answers — the freshest active frontend', async () => {
		const channel = bus();
		const a = fakeWorkbench();
		const b = fakeWorkbench();
		const joiner = fakeWorkbench();
		const aPresence = fakePresence(3);
		const bPresence = fakePresence(3);
		// B heard from A more recently than A heard from B: B answers, A stays quiet.
		aPresence.designate = (): boolean => false;
		bPresence.designate = (): boolean => true;
		attachWorkbenchSync(a, channel.deps, 'remote/1', { presence: aPresence });
		attachWorkbenchSync(b, channel.deps, 'remote/2', { presence: bPresence });
		attachWorkbenchSync(joiner, channel.deps, 'remote/3', { presence: fakePresence(3), startImmediately: false }).start();
		await until(() => channel.sent.some((m) => m.k === 'stateSnapshot'));
		expect(channel.sent.filter((m) => m.k === 'stateSnapshot').every((m) => m.by === 'remote/2')).toBe(true);
		expect(channel.sent.filter((m) => m.k === 'stateSnapshot')).toHaveLength(1);
	});
});

/* ---------- A real editor area under the sync ---------- */

describe('a real editor area under the sync', () => {
	beforeEach(() => {
		backend.on('read_file', () => ({ contents: 'one two one\nthree\n', binary: false, size: 12, encoding: 'utf8', eol: 'lf' }));
	});

	it('applies a remote open, close and reveal on real tabs', async () => {
		const container = document.createElement('div');
		document.body.appendChild(container);
		const area = new EditorArea(container);
		// openFolders: the remote-open gate refuses a file outside the window's roots — without
		// it the remote open below never applied and the open/active waits were vacuous.
		const workbench: SyncedWorkbench = { editors: area, openFolders: () => ['C:\\repo'] };
		const channel = bus();
		attachWorkbenchSync(workbench, channel.deps, 'main');
		// Remote open: a real tab lands, active, content read once.
		const activeOf = (): string | null => {
			const input = area.activeInput;
			return input?.kind === 'file' ? input.path ?? null : null;
		};
		channel.deps.send({ by: 'remote/1', k: 'open', path: NOTES, line: 2 });
		await until(() => activeOf() === NOTES);
		// Local open (the facade): crosses to the other side with its anchor.
		await area.openFile(README, { line: 7 });
		expect(channel.sent.some((m) => m.k === 'open' && m.path === README && m.line === 7)).toBe(true);
		// Remote active: the real tab of the other file activates.
		channel.deps.send({ by: 'remote/1', k: 'active', path: NOTES });
		await until(() => activeOf() === NOTES);
		// Remote close: the tab really closes.
		channel.deps.send({ by: 'remote/1', k: 'close', path: NOTES });
		await until(() => !area.openFilePaths().includes(NOTES));
		expect(area.openFilePaths()).toEqual([README]);
		container.remove();
	});

	it('closes an extension page tab on the other side, its id the key', async () => {
		const containerA = document.createElement('div');
		const containerB = document.createElement('div');
		document.body.append(containerA, containerB);
		const areaA = new EditorArea(containerA);
		const areaB = new EditorArea(containerB);
		const channel = bus();
		attachWorkbenchSync({ editors: areaA }, channel.deps, 'main');
		attachWorkbenchSync({ editors: areaB }, channel.deps, 'remote/1');
		const input = { kind: 'extpage', id: 'webview:acme.engine:7', title: 'Claude Code', extId: 'acme.engine', pageId: 'webview' } as const;
		await areaA.openExtPage({ ...input }, () => undefined);
		await areaB.openExtPage({ ...input }, () => undefined);
		channel.sent.length = 0;
		areaB.closeById('webview:acme.engine:7');
		await until(() => !areaA.openExtPageIds().includes('webview:acme.engine:7'));
		expect(channel.by('remote/1')).toEqual([{ by: 'remote/1', k: 'closeTab', id: 'webview:acme.engine:7' }]);
		containerA.remove();
		containerB.remove();
	});

	it('focuses an extension page tab on the other side, its id the key', async () => {
		const containerA = document.createElement('div');
		const containerB = document.createElement('div');
		document.body.append(containerA, containerB);
		const areaA = new EditorArea(containerA);
		const areaB = new EditorArea(containerB);
		const channel = bus();
		attachWorkbenchSync({ editors: areaA }, channel.deps, 'main');
		attachWorkbenchSync({ editors: areaB }, channel.deps, 'remote/1');
		const input = { kind: 'extpage', id: 'webview:acme.graph:3', title: 'Git Graph', extId: 'acme.graph', pageId: 'webview' } as const;
		await areaA.openExtPage({ ...input }, () => undefined);
		await areaB.openExtPage({ ...input }, () => undefined);
		// The panel's create: its own activation crossed as nothing.
		expect(channel.sent).toEqual([]);
		await areaA.openFile(NOTES);
		await until(() => areaB.activeInput?.kind === 'file');
		channel.sent.length = 0;
		// The PC user clicks the graph's tab in the strip: the other side shows the graph.
		click([...containerA.querySelectorAll<HTMLElement>('.tab')].find((tab) => tab.textContent?.includes('Git Graph')) ?? null);
		await until(() => areaB.activeInput?.kind === 'extpage');
		expect(channel.sent).toEqual([{ by: 'main', k: 'activeTab', id: 'webview:acme.graph:3' }]);
		containerA.remove();
		containerB.remove();
	});

	it('opens, focuses and closes a Source Control change diff on the other side', async () => {
		backend.on('read_file_at', () => ({ contents: 'one\n', binary: false, size: 4 }));
		const containerA = document.createElement('div');
		const containerB = document.createElement('div');
		document.body.append(containerA, containerB);
		const areaA = new EditorArea(containerA);
		const areaB = new EditorArea(containerB);
		const channel = bus();
		attachWorkbenchSync({ editors: areaA }, channel.deps, 'main');
		attachWorkbenchSync({ editors: areaB }, channel.deps, 'remote/1');
		const diff = {
			kind: 'diff',
			id: 'scm:worktree:notes.txt',
			title: 'notes.txt (Working Tree)',
			left: { revision: 'HEAD', path: 'notes.txt', label: 'HEAD', exists: true },
			right: { revision: '*', path: 'notes.txt', label: 'Working Tree', exists: true }
		} as const;
		const diffTab = 'diff:scm:worktree:notes.txt';
		const tabsOf = (area: EditorArea): string[] => area.openTabInputs().map((tab) => tab.id);
		// The PC clicks a change in Source Control: the phone opens the same diff, active.
		await areaA.openDiff({ ...diff, left: { ...diff.left }, right: { ...diff.right } });
		await until(() => tabsOf(areaB).includes(diffTab));
		expect(areaB.activeInput?.kind).toBe('diff');
		expect(channel.by('main')).toEqual([{ by: 'main', k: 'openTab', input: diff }]);
		// And the applied open crossed back as nothing.
		expect(channel.by('remote/1')).toEqual([]);
		// A file in front, then the diff tab chosen again on the phone: the PC shows the diff.
		await areaA.openFile(NOTES);
		await until(() => areaB.activeInput?.kind === 'file');
		channel.sent.length = 0;
		areaB.revealById(diffTab);
		await until(() => areaA.activeInput?.kind === 'diff');
		expect(channel.by('remote/1')).toEqual([{ by: 'remote/1', k: 'activeTab', id: diffTab, input: diff }]);
		// The phone closes the diff: the PC's closes too.
		channel.sent.length = 0;
		areaB.closeById(diffTab);
		await until(() => !tabsOf(areaA).includes(diffTab));
		// (The neighbour taking the focus crosses as its own switch.)
		expect(channel.by('remote/1')).toContainEqual({ by: 'remote/1', k: 'closeTab', id: diffTab });
		expect(channel.by('main')).toEqual([]);
		containerA.remove();
		containerB.remove();
	});

	it('opens a file history on the other side, and a missed diff converges on its focus', async () => {
		backend.on('file_log', () => []);
		backend.on('read_file_at', () => ({ contents: 'one\n', binary: false, size: 4 }));
		const containerA = document.createElement('div');
		const containerB = document.createElement('div');
		document.body.append(containerA, containerB);
		const areaA = new EditorArea(containerA);
		const areaB = new EditorArea(containerB);
		areaA.setRoot('C:\\repo');
		areaB.setRoot('C:\\repo');
		const channel = bus();
		attachWorkbenchSync({ editors: areaA }, channel.deps, 'main');
		attachWorkbenchSync({ editors: areaB }, channel.deps, 'remote/1');
		await areaB.openFileHistory(NOTES);
		await until(() => areaA.openTabInputs().some((tab) => tab.id === `history:${NOTES}`));
		expect(channel.by('remote/1')).toEqual([{ by: 'remote/1', k: 'openTab', input: { kind: 'history', path: NOTES } }]);
		// A diff this side never saw (opened before it arrived): its focus opens it here.
		const diff = { kind: 'diff', id: 'rev:abc:notes.txt', title: 'notes.txt (abc)', left: { revision: 'abc', path: 'notes.txt', label: 'abc', exists: true }, right: { revision: 'abc', path: 'notes.txt', label: 'abc', exists: true } } as const;
		channel.deps.send({ by: 'remote/2', k: 'activeTab', id: `diff:${diff.id}`, input: diff });
		await until(() => areaA.openTabInputs().some((tab) => tab.id === `diff:${diff.id}`) && areaB.openTabInputs().some((tab) => tab.id === `diff:${diff.id}`));
		expect(channel.by('main')).toEqual([]);
		expect(channel.by('remote/1')).toHaveLength(1);
		containerA.remove();
		containerB.remove();
	});

	it('keeps a diff of provider text on its own frontend', async () => {
		const container = document.createElement('div');
		document.body.appendChild(container);
		const area = new EditorArea(container);
		const channel = bus();
		attachWorkbenchSync({ editors: area }, channel.deps, 'main');
		await area.openDiff({ kind: 'diff', id: 'ext:1', title: 'a ↔ b', left: { revision: '', path: 'a', label: 'a', exists: true, content: 'x\n' }, right: { revision: '', path: 'b', label: 'b', exists: true, content: 'y\n' } });
		await until(() => area.openTabInputs().length === 1);
		expect(channel.sent).toEqual([]);
		container.remove();
	});

	it('closes a tab from its own strip and the close crosses', async () => {
		const container = document.createElement('div');
		document.body.appendChild(container);
		const area = new EditorArea(container);
		const workbench: SyncedWorkbench = { editors: area };
		const channel = bus();
		attachWorkbenchSync(workbench, channel.deps, 'main');
		await area.openFile(NOTES);
		channel.sent.length = 0;
		// The strip's own close button — the diff's catch, not the facade.
		const close = container.querySelector<HTMLElement>('.tab .close');
		expect(close).not.toBeNull();
		click(close);
		await until(() => area.openFilePaths().length === 0);
		expect(channel.sent).toEqual([{ by: 'main', k: 'close', path: NOTES }]);
		container.remove();
	});
});

/* ---------- The wired workbench ---------- */

/** Every command not scripted here answers `null` (a write that succeeded). */
class DefaultingHandlers extends Map<string, (args: Record<string, unknown>) => unknown> {
	override get(command: string) {
		return super.get(command) ?? (() => null);
	}
}

const REPO = 'C:\\repo';

/** The scripted backend every wired workbench boots against. */
function workbenchHandlers(extra: [string, (args: Record<string, unknown>) => unknown][] = []): DefaultingHandlers {
	return new DefaultingHandlers([
		['boot_context', () => ({ file: null, actions: [], repo: REPO, roots: [{ root: REPO, isRepo: true }], workspaceFile: null })],
		['open_folder', ({ path }) => ({ root: path, isRepo: true })],
		['boot_stage', () => null],
		['list_dir', () => [{ name: 'notes.txt', path: NOTES, isDir: false, size: 12 }, { name: 'README.md', path: README, isDir: false, size: 4 }]],
		['list_files', () => ['notes.txt', 'README.md']],
		['read_file', ({ path }) => ({ contents: path === README ? '# Hi\n' : 'one two one\nthree\n', binary: false, size: 12, encoding: 'utf8', eol: 'lf' })],
		// The remote-open gate's canonical forms: identity (the workbench sync's re-check
		// asks for them; the boundary semantics live in the pathGate suite).
		['remote_canonical_paths', ({ paths }) => paths],
		['repo_head', () => ({ branch: 'main', shortHash: 'abc1234', ahead: 0, behind: 0, upstream: 'origin/main' })],
		['scm_status', () => []],
		['scm_branches', () => [{ name: 'main', remote: false, current: true, upstream: null }]],
		['scm_remotes', () => []],
		['scm_tags', () => []],
		['scm_stashes', () => []],
		['workspace_symbols', () => []],
		['analysis_status', () => ({ state: 'idle' })],
		['ext_list', () => []],
		['keybindings_read', () => null],
		['settings_read', () => null],
		['backup_list', () => []],
		['git_output_log', () => []],
		['graph_request', ({ message }) => ({ command: (message as { command: string }).command, error: null, errors: [null], commits: [] })],
		...extra
	] as [string, (args: Record<string, unknown>) => unknown][]);
}

describe('the wired workbench', () => {
	let workbench: Workbench;

	beforeEach(async () => {
		(window as unknown as { markdownIt: unknown }).markdownIt = { render: (text: string) => `<p>${text}</p>` };
		backend.handlers = workbenchHandlers();
		workbench = new Workbench();
		await workbench.boot();
		await flush(10);
		// The gate (7.0) needs a second active frontend: the catch-up at start saw none
		// (correctly skipping it); the table gets one now, as WINDOWS frames would. The
		// boot's own emits (the presence announce among them) go before the tests read.
		currentPresence()?.noteExternal('remote/9', true);
		backend.emits.length = 0;
	});

	it('a file opened from the Explorer crosses the real event channel', async () => {
		const notesRow = (): Element | null =>
			[...document.querySelectorAll('.tree .row')].find((row) => row.textContent?.includes('notes.txt')) ?? null;
		await until(() => notesRow() !== null);
		click(notesRow());
		await until(() => workbench.editors.openFilePaths().length > 0);
		const sent = backend.emits.filter((e) => e.event === WORKBENCH_SYNC_EVENT).map((e) => e.payload);
		expect(sent).toContainEqual({ by: 'main', k: 'open', path: NOTES });
	});

	it('a remote open lands as a real active tab', async () => {
		backend.emit(WORKBENCH_SYNC_EVENT, { by: 'remote/1', k: 'open', path: README });
		await until(() => workbench.editors.openFilePaths().includes(README));
		const active = workbench.editors.activeInput;
		expect(active?.kind === 'file' && active.path).toBe(README);
		// And the applied open crossed back as nothing.
		expect(backend.emits.filter((e) => e.event === WORKBENCH_SYNC_EVENT && (e.payload as { by: string }).by === 'main')).toEqual([]);
	});

	it('a view switch is local layout — neither direction crosses (G8)', async () => {
		// The retired vocabulary arriving from the wire changes nothing: the sidebar keeps
		// its own view.
		backend.emit(WORKBENCH_SYNC_EVENT, { by: 'remote/1', k: 'view', id: 'scm' });
		await flush(5);
		expect(document.querySelector('.activity-item.active')?.getAttribute('data-view')).not.toBe('scm');
		backend.emits.length = 0;
		click(document.querySelector('.activity-item[data-view="search"]'));
		await until(() => document.querySelector('.activity-item.active')?.getAttribute('data-view') === 'search');
		await flush(5);
		expect(backend.emits.filter((e) => e.event === WORKBENCH_SYNC_EVENT)).toEqual([]);
	});

	it('a copy closed on the phone closes the PC panel — and the extension learns it', async () => {
		// The phone half: a bare real editor area carrying the panel's COPY tab (what a
		// remote page's workbench holds), synced over the same real event channel.
		const phoneHost = document.createElement('div');
		document.body.appendChild(phoneHost);
		const phoneArea = new EditorArea(phoneHost);
		const pushes: { event?: string; panelId?: number }[] = [];
		const phoneSync = attachWorkbenchSync({ editors: phoneArea }, {
			send: (message) => void mockEmit(WORKBENCH_SYNC_EVENT, message),
			receive: (handler) => {
				let unlisten: (() => void) | null = null;
				void mockListen(WORKBENCH_SYNC_EVENT, (event) => handler(event.payload as WorkbenchSyncMessage)).then((off) => {
					unlisten = off;
				});
				return () => unlisten?.();
			}
		}, 'remote/1');
		// The extension's frame answers the host's pushes: what the real shim carries to the
		// backend as `ext_process_push_event` (and the backend mirrors back to every frontend).
		workbench.extensionHost['frames'].set('acme.engine', {
			send: (message: { event?: string; panelId?: number }) => {
				backend.calls.push({ command: 'ext_process_push_event', args: { extensionId: 'acme.engine', event: message.event, panelId: message.panelId } });
			},
			pendingCalls: new Set()
		} as never);
		// The panel's create, replayed to this frontend the way a missed or mirrored create
		// reaches it: the record lands and the tab opens with the real mount.
		backend.emit('ext-host-state', { extId: 'acme.engine', method: 'webview.create', args: [7, 'chat', 'Claude Code', 1, false], served: 'remote/9', caller: null });
		await until(() => workbench.editors.openExtPageIds().includes('webview:acme.engine:7'));
		// The phone holds its copy of the same tab id (§22.6's copy tab).
		await phoneArea.openExtPage({ kind: 'extpage', id: 'webview:acme.engine:7', title: 'Claude Code', extId: 'acme.engine', pageId: 'webview' }, () => undefined);
		expect(phoneArea.openExtPageIds()).toEqual(['webview:acme.engine:7']);
		// The phone closes its copy: the PC's real panel closes, and the extension's frame
		// hears webviewDisposed — the dispose the backend then mirrors to every frontend.
		backend.emits.length = 0;
		phoneArea.closeById('webview:acme.engine:7');
		await until(() => !workbench.editors.openExtPageIds().includes('webview:acme.engine:7'));
		const pushes2 = backend.callsTo('ext_process_push_event').map((call) => ({ event: call.event, panelId: call.panelId }));
		expect(pushes2).toContainEqual({ event: 'webviewDisposed', panelId: 7 });
		// The applied close crossed back as nothing, and the phone's own copy is gone.
		expect(backend.emits.filter((entry) => entry.event === WORKBENCH_SYNC_EVENT && (entry.payload as { by: string }).by === 'main')).toEqual([]);
		expect(phoneArea.openExtPageIds()).toEqual([]);
		phoneSync.detach();
		phoneHost.remove();
	});

	it('hides the PC-only and keyboard-only menu entries from a browser session', async () => {
		const labelsOf = (menu: string): string[] =>
			(workbench.menus().find((m) => m.label === menu)?.entries() ?? [])
				.filter((entry) => typeof entry !== 'string')
				.map((entry) => (entry as { label: string }).label);
		// Desktop baseline: everything stands.
		expect(labelsOf('File')).toContain('New Window');
		expect(labelsOf('Help')).toContain('Keyboard Shortcuts');
		expect(labelsOf('Help')).toContain('Open Developer Tools');
		expect(labelsOf('View')).toContain('Editor Layout');
		// A real browser session runs the REMOTE profile (its composition root switches
		// before the workbench registers, §3.2): no machine-level vocabulary at all — no
		// window spawn, no devtools, and no opens of any kind (K4: a session switches
		// between the windows the PC already opened).
		setRemoteEnv({ transport: {} as never, attached: { frontendId: 'remote/1' } as never, basePath: '/' });
		commands.setActiveProfile('remote');
		try {
			expect(labelsOf('File')).not.toContain('New Window');
			expect(labelsOf('Help')).not.toContain('Open Developer Tools');
			expect(labelsOf('File')).not.toContain('Open Folder...');
			expect(labelsOf('File')).not.toContain('Open File...');
			expect(labelsOf('File')).not.toContain('Open Workspace...');
			expect(labelsOf('File')).not.toContain('Open Recent');
			expect(labelsOf('File')).not.toContain('Close Folder');
			expect(labelsOf('File')).not.toContain('Exit');
		} finally {
			commands.setActiveProfile('desktop');
			setRemoteEnv(undefined);
		}
		// The PC window while a mirror viewer drives it: the native-dialog and new-window
		// entries hide (only the PC's screen would show them); Open Recent opens in place.
		provideHook('mirror', { install: () => () => undefined, viewersActive: async () => true, viewersNow: () => true });
		try {
			expect(labelsOf('File')).not.toContain('New Window');
			expect(labelsOf('File')).not.toContain('Open File...');
			expect(labelsOf('File')).toContain('Open Folder...');
			expect(labelsOf('File')).toContain('Open Recent');
		} finally {
			provideHook('mirror', null);
		}
		expect(labelsOf('File')).toContain('Open File...');
		// The phone form factor adds the keyboard page and the split-layout submenu.
		const root = document.documentElement;
		root.setAttribute('data-remote-shell', '');
		root.dataset['formFactor'] = 'phone';
		root.setAttribute('data-page-stack', '');
		try {
			expect(labelsOf('Help')).not.toContain('Keyboard Shortcuts');
			expect(labelsOf('View')).not.toContain('Editor Layout');
			expect(labelsOf('View')).toContain('Explorer');
		} finally {
			root.removeAttribute('data-remote-shell');
			delete root.dataset['formFactor'];
			root.removeAttribute('data-page-stack');
		}
	});


	it('stops answering once disposed', async () => {
		workbench.dispose();
		backend.emit(WORKBENCH_SYNC_EVENT, { by: 'remote/1', k: 'open', path: NOTES });
		await flush(5);
		expect(workbench.editors.openFilePaths()).toEqual([]);
	});
});

/* ---------- The extension pages: Claude Code and Git Graph ---------- */

/** Two installed packages shaped like the real ones, backend-hosted (every webview of theirs
 *  lives in the desktop window): Claude Code's activity-bar container with its chat webview
 *  view, plus the chat's editor-tab panel; Git Graph's `scm/title` navigation launcher — the
 *  "View Git Graph" button — whose command opens the graph panel. */
const CLAUDE = 'anthropic.claude-code';
const GRAPH = 'neophack.git-graph-rs';
const CLAUDE_CONTAINER = `ext-container:${CLAUDE}.claude-sidebar`;
const CLAUDE_TAB = `webview:${CLAUDE}:7`;
const GRAPH_TAB = `webview:${GRAPH}:3`;

function extInfo(id: string, displayName: string): Record<string, unknown> {
	const [publisher, name] = id.split('.');
	return {
		id, name, displayName, publisher, version: '1.0.0', description: displayName, builtin: false, icon: null,
		path: `/ext/${id}-1.0.0`, categories: [], keywords: [], repository: null, license: null, enginesVscode: '^1.80.0',
		extensionDependencies: [], extensionPack: [], readme: null, changelog: null, format: 'vsix',
		capabilities: { format: 'ggs/2', id, version: '1.0.0', pages: {}, backend: { kind: 'node', host: 'ggs-node', command: 'out/main.js' }, permissions: [] }
	};
}

const MANIFESTS: Record<string, unknown> = {
	[CLAUDE]: {
		main: './extension.js',
		activationEvents: ['onStartupFinished'],
		contributes: {
			viewsContainers: { activitybar: [{ id: 'claude-sidebar', title: 'Claude Code', icon: 'claude.svg' }] },
			views: { 'claude-sidebar': [{ type: 'webview', id: 'claudeVSCodeSidebar', name: 'Claude Code' }] }
		}
	},
	[GRAPH]: {
		main: './extension.js',
		activationEvents: ['onStartupFinished'],
		contributes: {
			commands: [{ command: 'git-graph.view', title: 'View Git Graph (git log)', icon: '$(git-commit)' }],
			menus: { 'scm/title': [{ command: 'git-graph.view', group: 'navigation' }] }
		}
	}
};

/** What the backend's mirror delivers when a panel is created (wherever the click was): the
 *  desktop window serves it, and every frontend applies it — the PC opens the real tab. */
function mirroredCreate(extId: string, panelId: number, title: string): void {
	backend.emit('ext-host-state', { extId, method: 'webview.create', args: [panelId, 'webview', title, 1, false], served: 'remote/9', caller: null });
}

/** The workbench-sync messages this frontend sent. */
function sentByMain(): WorkbenchSyncMessage[] {
	return backend.emits.filter((e) => e.event === WORKBENCH_SYNC_EVENT).map((e) => e.payload as WorkbenchSyncMessage).filter((m) => m.by === 'main');
}

function claudeItem(): HTMLElement | null {
	return document.querySelector<HTMLElement>(`.activity-item[data-view="${CLAUDE_CONTAINER}"]`);
}

function sidebarHidden(): boolean {
	return document.getElementById('sidebar')?.hidden === true;
}

function tabEl(title: string): HTMLElement | null {
	return [...document.querySelectorAll<HTMLElement>('#editorGroup .tab')].find((tab) => tab.textContent?.includes(title)) ?? null;
}

function activeExtTab(workbench: Workbench): string | null {
	const input = workbench.editors.activeInput;
	return input?.kind === 'extpage' ? input.id : null;
}

/** Mark <html> as the remote shell on its phone form factor (what responsive.ts sets). */
function phoneForm(on: boolean): void {
	const root = document.documentElement;
	if (on) {
		root.setAttribute('data-remote-shell', '');
		root.dataset['formFactor'] = 'phone';
		// The page-stack marker (§5.1–§5.3) the navigation gates read; responsive.ts keeps
		// it beside the form factor.
		root.setAttribute('data-page-stack', '');
	} else {
		root.removeAttribute('data-remote-shell');
		delete root.dataset['formFactor'];
		root.removeAttribute('data-page-stack');
	}
}

describe('the extension pages across frontends — Claude Code and Git Graph', () => {
	let workbench: Workbench;

	beforeEach(async () => {
		(window as unknown as { markdownIt: unknown }).markdownIt = { render: (text: string) => `<p>${text}</p>` };
		backend.handlers = workbenchHandlers([
			['ext_list', () => [extInfo(CLAUDE, 'Claude Code'), extInfo(GRAPH, 'Git Graph')]],
			['ext_read_file', ({ extId, relPath }) => {
				if (relPath === 'package.json' && MANIFESTS[extId as string]) return JSON.stringify(MANIFESTS[extId as string]);
				throw new Error('no such file');
			}],
			['ext_process_start', ({ extId }) => ({ extensionId: extId, pid: 4242, commands: [], protocolVersion: 'ggs-ext/1', startCount: 1, lastError: null })],
			['ext_process_registrations', () => []]
		]);
		workbench = new Workbench();
		await workbench.boot();
		await flush(10);
		await until(() => claudeItem() !== null, 200);
		expect(claudeItem()).not.toBeNull();
		backend.emits.length = 0;
		// The sync's gate needs a second ACTIVE frontend before anything crosses: feed
		// the table one, as the daemon's WINDOWS frames would the PC's visibility.
		currentPresence()?.noteExternal('remote/9', true);
		backend.emits.length = 0;
	});

	afterEach(() => {
		phoneForm(false);
		setRemoteEnv(undefined);
		workbench.dispose();
	});

	/* -- Claude Code's sidebar page -- */

	it('opening the Claude Code view is local layout — nothing crosses (G8)', async () => {
		click(claudeItem());
		await until(() => workbench.activeSidebarView === CLAUDE_CONTAINER);
		expect(workbench.activeSidebarView).toBe(CLAUDE_CONTAINER);
		await flush(5);
		expect(sentByMain()).toEqual([]);
	});

	it('a retired view or sidebar message from the wire changes nothing and echoes nothing', async () => {
		backend.emit(WORKBENCH_SYNC_EVENT, { by: 'remote/1', k: 'view', id: CLAUDE_CONTAINER });
		backend.emit(WORKBENCH_SYNC_EVENT, { by: 'remote/1', k: 'sidebar', shown: false });
		await flush(5);
		expect(workbench.activeSidebarView).not.toBe(CLAUDE_CONTAINER);
		expect(sidebarHidden()).toBe(false);
		expect(sentByMain()).toEqual([]);
	});

	it('closing the Claude Code view hides the bar locally — the layout never crosses (G8)', async () => {
		click(claudeItem());
		await until(() => workbench.activeSidebarView === CLAUDE_CONTAINER);
		backend.emits.length = 0;
		// The second click on the active item hides the side bar (VS Code's toggle).
		click(claudeItem());
		await until(() => sidebarHidden());
		expect(sidebarHidden()).toBe(true);
		// Shown again with Ctrl+B's command: still only this frontend's own.
		backend.emits.length = 0;
		await commands.execute('workbench.toggleSidebar');
		await until(() => !sidebarHidden());
		await flush(5);
		expect(sentByMain()).toEqual([]);
	});

	it('on a phone, leaving the Claude Code page stays local — it is navigation, not layout', async () => {
		// A real phone session: the shell marker, the phone form factor, and the remote env.
		phoneForm(true);
		setRemoteEnv({ transport: {} as never, attached: { frontendId: 'remote/1' } as never, basePath: '/' });
		click(claudeItem());
		await until(() => workbench.activeSidebarView === CLAUDE_CONTAINER);
		backend.emits.length = 0;
		// The phone's back step / Editor tab: the side page closes, the PC keeps its side bar.
		await commands.execute('workbench.toggleSidebar');
		await flush(5);
		expect(sidebarHidden()).toBe(true);
		expect(sentByMain()).toEqual([]);
	});

	it('the phone bottom tab for Claude Code opens the view locally — a page is navigation (G8)', async () => {
		phoneForm(true);
		const { extensionContainers, goTo } = await import('../src/remote/pages');
		expect(extensionContainers().map((container) => [container.id, container.title])).toContainEqual([CLAUDE_CONTAINER, 'Claude Code']);
		await goTo(CLAUDE_CONTAINER);
		await until(() => workbench.activeSidebarView === CLAUDE_CONTAINER);
		// Tapping it again shows the page, never toggles it away — and nothing ever crosses.
		await goTo(CLAUDE_CONTAINER);
		await flush(5);
		expect(sentByMain()).toEqual([]);
		expect(sidebarHidden()).toBe(false);
	});

	/* -- Claude Code's chat tab and the Git Graph panel -- */

	it('a Claude Code chat tab created anywhere opens on the PC without echoing as a switch', async () => {
		mirroredCreate(CLAUDE, 7, 'Claude Code');
		await until(() => workbench.editors.openExtPageIds().includes(CLAUDE_TAB));
		expect(activeExtTab(workbench)).toBe(CLAUDE_TAB);
		await flush(5);
		expect(sentByMain().filter((m) => m.k === 'activeTab')).toEqual([]);
	});

	it('focusing the Claude Code chat tab on the PC brings it forward on the other side', async () => {
		mirroredCreate(CLAUDE, 7, 'Claude Code');
		await until(() => workbench.editors.openExtPageIds().includes(CLAUDE_TAB));
		await workbench.editors.openFile(NOTES);
		await until(() => workbench.editors.activeInput?.kind === 'file');
		backend.emits.length = 0;
		click(tabEl('Claude Code'));
		await until(() => sentByMain().length > 0);
		expect(activeExtTab(workbench)).toBe(CLAUDE_TAB);
		expect(sentByMain()).toEqual([{ by: 'main', k: 'activeTab', id: CLAUDE_TAB }]);
	});

	it('the other side focusing the Claude Code chat brings the PC tab forward — and back to a file', async () => {
		mirroredCreate(CLAUDE, 7, 'Claude Code');
		await until(() => workbench.editors.openExtPageIds().includes(CLAUDE_TAB));
		await workbench.editors.openFile(NOTES);
		await until(() => workbench.editors.activeInput?.kind === 'file');
		backend.emits.length = 0;
		backend.emit(WORKBENCH_SYNC_EVENT, { by: 'remote/1', k: 'activeTab', id: CLAUDE_TAB });
		await until(() => activeExtTab(workbench) === CLAUDE_TAB);
		expect(activeExtTab(workbench)).toBe(CLAUDE_TAB);
		backend.emit(WORKBENCH_SYNC_EVENT, { by: 'remote/1', k: 'active', path: NOTES });
		await until(() => workbench.editors.activeInput?.kind === 'file');
		const active = workbench.editors.activeInput;
		expect(active?.kind === 'file' && active.path).toBe(NOTES);
		// Both applied switches crossed back as nothing.
		await flush(5);
		expect(sentByMain()).toEqual([]);
	});

	it('the other side closing the Claude Code chat closes the PC tab, and a PC close crosses', async () => {
		mirroredCreate(CLAUDE, 7, 'Claude Code');
		mirroredCreate(GRAPH, 3, 'Git Graph');
		await until(() => workbench.editors.openExtPageIds().length === 2);
		backend.emits.length = 0;
		backend.emit(WORKBENCH_SYNC_EVENT, { by: 'remote/1', k: 'closeTab', id: CLAUDE_TAB });
		await until(() => !workbench.editors.openExtPageIds().includes(CLAUDE_TAB));
		expect(workbench.editors.openExtPageIds()).toEqual([GRAPH_TAB]);
		await flush(5);
		expect(sentByMain()).toEqual([]);
		// The PC user closes the graph from its own tab strip: the close crosses.
		click(tabEl('Git Graph')?.querySelector('.close'));
		await until(() => sentByMain().length > 0);
		expect(sentByMain()).toEqual([{ by: 'main', k: 'closeTab', id: GRAPH_TAB }]);
	});

	it('switching between the Git Graph and Claude Code pages crosses each switch once', async () => {
		mirroredCreate(GRAPH, 3, 'Git Graph');
		mirroredCreate(CLAUDE, 7, 'Claude Code');
		await until(() => workbench.editors.openExtPageIds().length === 2);
		await flush(5);
		backend.emits.length = 0;
		click(tabEl('Git Graph'));
		await until(() => activeExtTab(workbench) === GRAPH_TAB);
		click(tabEl('Claude Code'));
		await until(() => activeExtTab(workbench) === CLAUDE_TAB);
		// Re-clicking the tab already showing is no switch.
		click(tabEl('Claude Code'));
		await flush(5);
		expect(sentByMain()).toEqual([
			{ by: 'main', k: 'activeTab', id: GRAPH_TAB },
			{ by: 'main', k: 'activeTab', id: CLAUDE_TAB }
		]);
	});

	it('the phone Git Graph tab brings the open graph forward on the other side', async () => {
		phoneForm(true);
		mirroredCreate(GRAPH, 3, 'Git Graph');
		await until(() => workbench.editors.openExtPageIds().includes(GRAPH_TAB));
		await workbench.editors.openFile(NOTES);
		await until(() => workbench.editors.activeInput?.kind === 'file');
		const { goTo, launchers } = await import('../src/remote/pages');
		const graph = launchers().find((launcher) => launcher.extId === GRAPH);
		expect(graph?.id).toBe('launch:git-graph.view');
		backend.emits.length = 0;
		// Already open: the tab is revealed (no second run of the launcher) — and the switch
		// crosses, so the PC shows the graph too.
		await goTo(graph!.id);
		await until(() => sentByMain().some((m) => m.k === 'activeTab'));
		expect(activeExtTab(workbench)).toBe(GRAPH_TAB);
		expect(sentByMain()).toEqual([{ by: 'main', k: 'activeTab', id: GRAPH_TAB }]);
		expect(backend.callsTo('ext_process_run_command').length + backend.callsTo('ext_process_invoke').filter((c) => c.method === 'runCommand').length).toBe(0);
	});
});
