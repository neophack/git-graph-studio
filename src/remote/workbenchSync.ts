// Cross-frontend operation sync (docs/ggs-remote-plan.md §22.7, docs/remote-client-plan.md
// §7): when the PC keeps its desktop UI while a phone runs its own workbench, the two
// frontends would each keep their own tabs — a file opened on the PC never appeared on the
// phone. This module makes the OPERATIONS correspond one-to-one instead: every file a
// frontend opens, closes or switches to crosses as one tiny intent message and is performed
// on the other frontends' own workbenches. Paths and ids only — never content, never DOM:
// the receiving side opens the document through its own editor area (one file read it would
// have paid anyway). A file open/close/active message is well under 200 bytes; the tabs
// that cross whole (a diff, a file history) carry their input — revisions, paths and
// labels, never text.
//
// The sync is GATED on the presence table (§7.0, remote/presence.ts): intent messages cross
// only while at least two frontends are active (K11 — a lone frontend, typically the PC
// window closed with one remote working, sends nothing at all), and a frontend becoming
// active first CATCHES UP (K14): it asks for a snapshot of the open tabs, merges by union
// (background opens, never a close, unsaved buffers survive) and takes the recently active
// side's tab as its own. What is NOT synced anymore (K7): sidebar view switches and side
// bar hides — each frontend's layout is its own (G8, the `view` / `sidebar` messages are
// gone).
//
// Both sides run the same shared workbench code, so one module serves both: the desktop
// emits through the real Tauri broadcast (which the Relay forwards to exactly the sessions
// that LISTEN — a mirror-mode page runs no workbench, subscribes to nothing of this, and
// pays nothing), a remote session through the WebSocket shim of the same event surface.
// Every message carries its sender's frontend id; a frontend ignores its own echoes.
// Remote operations run through the RAW open functions — the wrappers exist for local
// operations — and pre-mark the `announced` set, so what a remote operation changed never
// crosses back, while a LOCAL change landing mid-apply still crosses: no ping-pong, no
// swallowed operations.
//
// The sync stays silent until the workbench's boot is through (a boot's own wiring is
// housekeeping, and a reloaded phone page must not pull the PC around), and goes local-only
// while a session restore rebuilds this frontend's own tabs.

import { emit as tauriEmit, invoke, listen as tauriListen } from '../platform/ipc/core';
import { hook } from '../platform/hooks';
import { inputId, type EditorInput } from '../features/editor';
import type { EditorPlacement } from '../features/editor/types';
import type { ActiveEditorInfo, EditorArea } from '../features/editor';
import { frontendId, remoteEnv } from './session';
import { withinRoots } from './pathGate';
import { Presence, registerPresence } from './presence';

export const WORKBENCH_SYNC_EVENT = 'studio://workbench-sync';

/** How long a catch-up waits for its snapshot before giving up (the designated responder
 *  may be gone, or the roster skewed): the joiner then simply starts announcing. */
const CATCH_UP_WINDOW_MS = 10_000;

/** One operation crossing the frontends: what its user opened, closed or switched to.
 *  `line` / `column` preserve an open's anchor (a search result's jump); `by` is the
 *  sender's frontend id (`main`, `remote/<n>`); `inactive` opens a tab without taking the
 *  focus — the catch-up's union opens ride it.
 *
 *  `closeTab` is the extension pages' close: a webview panel's tab id
 *  (`webview:<extId>:<panelId>`) is the same on every frontend — the PC's real tab and a
 *  remote page's copy — so closing it anywhere closes it everywhere (the PC's close reaches
 *  the extension through its own disposer, and the backend's dispose mirror then clears
 *  every remaining copy). `activeTab` is the same tab id taking the focus — Git Graph's or
 *  Claude Code's page chosen on one side comes forward on the other.
 *
 *  `openTab` is a re-openable tab that is neither a file nor an extension page: a Source
 *  Control change's diff, a history entry's diff, a file history. Its input crosses whole —
 *  revisions and repository paths, never text: a diff whose side carries its own content
 *  (an extension's provider text) stays on its frontend — and the receiving side opens it
 *  through its own editor area, so its tab id (`diff:<id>`, `history:<path>`) is the same
 *  on both sides and `closeTab` / `activeTab` key it exactly like an extension page. An
 *  `activeTab` for such a tab carries its input too, so a side that missed the open
 *  converges by opening it.
 *
 *  `stateRequest` / `stateSnapshot` are the catch-up protocol (§7.0.3): a frontend becoming
 *  active asks; the most recently active OTHER frontend (the presence table picks it)
 *  answers with the open tabs' ids — paths and inputs, never contents — and its active
 *  tab. The receiver merges by union and follows the active tab. */
export type WorkbenchSyncMessage =
	| { by: string; k: 'open'; path: string; line?: number; column?: number; inactive?: boolean }
	| { by: string; k: 'close'; path: string }
	| { by: string; k: 'active'; path: string }
	| { by: string; k: 'closeTab'; id: string }
	| { by: string; k: 'activeTab'; id: string; input?: SyncedTabInput }
	| { by: string; k: 'openTab'; input: SyncedTabInput }
	| { by: string; k: 'stateRequest' }
	| { by: string; k: 'stateSnapshot'; to: string; files: string[]; tabs: SyncedTabInput[]; extTabs: string[]; active: SnapshotActive | null };

/** The active tab of a snapshot: a file by its path, or a tab that crosses whole (an
 *  extension page, a diff, a history) by the tab id every frontend keys it by. */
export type SnapshotActive = { kind: 'file'; path: string } | { kind: 'tab'; id: string };

/** The tab inputs that cross whole: diffs between revisions or files on disk, and file
 *  histories. */
export type SyncedTabInput = Extract<EditorInput, { kind: 'diff' } | { kind: 'history' }>;

/** The presence surface the sync rides on — the real Presence satisfies it, and a test
 *  fakes it. */
export interface SyncPresence {
	/** Intent messages may cross: at least two active frontends (K11). */
	syncAllowed(): boolean;
	/** Any OTHER frontend is active right now — the catch-up's precondition (§7.0.3: no
	 *  other active frontend, skip). */
	othersActive(): boolean;
	/** This frontend is the one to answer `requester`'s state request (§7.0.3). */
	isDesignatedResponder(requester: string): boolean;
	/** This frontend just became active — the catch-up's trigger. */
	onBecameActive(handler: () => void): () => void;
	/** The roster changed — someone joined, left or flipped. Optional: a presence without
	 *  it simply never roster-triggers a catch-up. */
	onRosterChange?(handler: () => void): () => void;
	/** This frontend is active right now. */
	isActive(): boolean;
}

/** Whether an open tab's input crosses as `openTab`: a diff only when both sides are read
 *  from the repository or the disk (an extension's provider text is that frontend's own,
 *  and can be any size). */
function syncedTabInput(input: EditorInput): SyncedTabInput | null {
	if (input.kind === 'history') return input;
	if (input.kind === 'diff' && input.left.content === undefined && input.right.content === undefined) return input;
	return null;
}

/** The sync sets' path key: the editor area keys its tabs by samePath (slashes unified, a
 *  Windows drive path case-insensitive), so the sync's bookkeeping must too — one file
 *  restored as `c:\repo\a.ts` here and opened as `C:\repo\a.ts` there must not oscillate
 *  close/open between the spellings. Messages still carry the sender's own spelling; the
 *  receiving side's path lookups (closeFilePath, revealFilePath) match by samePath. */
function keyOf(path: string): string {
	const key = path.replace(/\\/g, '/');
	return /^[A-Za-z]:\//.test(key) ? key.toLowerCase() : key;
}

/** The editor-area surface the sync rides on — the real `EditorArea` satisfies it
 *  structurally, and a test can fake it. */
export interface SyncedEditorArea {
	openFile(path: string, options?: { line?: number; column?: number; inactive?: boolean }, placement?: EditorPlacement): Promise<void>;
	openFilePaths(): string[];
	readonly activeInput: { kind: string; path?: string; id?: string } | null;
	onTabsChange: (() => void) | null;
	onActiveChange: ((editor: ActiveEditorInfo | null) => void) | null;
	closeFilePath(path: string): boolean;
	revealFilePath(path: string): boolean;
	openExtPageIds(): string[];
	closeById(id: string): boolean;
	revealById(id: string): boolean;
	/** The open tabs' ids and inputs, and the opens of the tabs that cross whole — optional:
	 *  an area without them syncs no diff or history tabs. */
	openTabInputs?(): { id: string; input: EditorInput }[];
	openDiff?(input: Extract<EditorInput, { kind: 'diff' }>): Promise<void>;
	openFileHistory?(path: string): Promise<void>;
}

/** The workbench surface the sync rides on. */
export interface SyncedWorkbench {
	editors: SyncedEditorArea | EditorArea;
	/** The folders this window has open — the boundary a remote-originated `open` must
	 *  land inside (the relay gates invokes the same way; this is the receiver's half,
	 *  so a forged direct emit has nowhere to land either). Optional: without it,
	 *  remote-originated opens are simply ignored. */
	openFolders?(): string[];
}

export interface WorkbenchSyncDeps {
	send(message: WorkbenchSyncMessage): void;
	receive(handler: (message: WorkbenchSyncMessage) => void): () => void;
}

/** A wired sync: `start()` opens the channel (the workbench's boot calls it — housekeeping
 *  before that stays local), `localOnly(true)` pauses announcements while this frontend
 *  rebuilds its own tabs (a session restore), `detach()` restores the unwired workbench. */
export interface AttachedWorkbenchSync {
	start(): void;
	localOnly(local: boolean): void;
	/** The desktop's close-to-hide path: this frontend is going invisible — the presence
	 *  table must say so at once, whatever the page's own visibility events do (§17). */
	noteWindowHidden(): void;
	detach(): void;
}

/** The active tab's sync key: `file:<path>` for a file, `tab:<id>` for an extension page
 *  or a tab that crosses whole (whose tab id is the same on every frontend), null while
 *  anything else (a content tab, the welcome) holds the focus — those keep their
 *  frontend's own layout, they do not sync. */
function activeKeyOf(input: { kind: string; path?: string; id?: string } | null): string | null {
	if (input?.kind === 'file') return input.path ? `file:${input.path}` : null;
	if (input?.kind === 'extpage') return input.id ? `tab:${input.id}` : null;
	const synced = input ? syncedTabInput(input as EditorInput) : null;
	return synced ? `tab:${inputId(synced)}` : null;
}

/** Wire one workbench into the sync: local operations cross as messages, remote messages
 *  land as local operations. Wraps the editor area's open facade and the change hooks,
 *  and composes with whatever handlers were already set. */
export function attachWorkbenchSync(
	workbench: SyncedWorkbench,
	deps: WorkbenchSyncDeps,
	by: string,
	options: { startImmediately?: boolean; presence?: SyncPresence; canonicalPath?: (path: string) => Promise<string | null> } = {}
): AttachedWorkbenchSync {
	const presence = options.presence;
	// The real EditorArea satisfies this surface structurally; the cast keeps every read and
	// write below on one type.
	const editors = workbench.editors as SyncedEditorArea;
	/** What the other frontends believe about this one's open files. Local operations
	 *  announce into it, remote operations pre-mark it, and the tabs diff announces exactly
	 *  the difference — so an echo can never re-announce, and a local change landing while a
	 *  remote operation is still in flight still crosses. Keyed by `keyOf` (one file's two
	 *  spellings are one entry), valued by the spelling to announce with — this side's own
	 *  while the tab is local, the message's for a remote open still in flight. */
	let announced = new Map(editors.openFilePaths().map((path) => [keyOf(path), path]));
	/** The open tabs that cross whole, by tab id. */
	const syncedTabs = (): Map<string, SyncedTabInput> => {
		const tabs = new Map<string, SyncedTabInput>();
		for (const { id, input } of editors.openTabInputs?.() ?? []) {
			const synced = syncedTabInput(input);
			if (synced) tabs.set(id, synced);
		}
		return tabs;
	};
	const openTabIds = (): Set<string> => new Set([...editors.openExtPageIds(), ...syncedTabs().keys()]);
	let announcedTabs = openTabIds();
	/** Tab ids whose remote `openTab` is still in flight: pre-marked announced, tab not landed. */
	const applyingTabs = new Set<string>();
	let activeKey = activeKeyOf(editors.activeInput);
	/** Extension-page tabs that just appeared as the active tab — a panel's create (the
	 *  backend's mirror opens it on every frontend at once): its own activation is not a
	 *  switch, or a create on one side would echo back as a reveal from the other and yank
	 *  away whatever its user chose meanwhile. A tab joining in the background is never
	 *  fresh, so its first real activation crosses. */
	const freshTabs = new Set<string>();
	/** Remote operations being applied right now: their own activations must not cross as
	 *  active switches (their message already said so). The depth is PAIRED with a page
	 *  hold: while a remote operation is landing, the tab it activates opens in the
	 *  background — the phone's page keeps its place (each frontend's layout is its own,
	 *  K7; the phone user's own opens run outside these walls and still navigate,
	 *  2026-10-16: 文件页面会被其他页面顶到最前). */
	let applying = 0;
	let navHold: (() => void) | null = null;
	const beginApply = (): void => {
		applying++;
		if (applying === 1) navHold = hook('navigation').holdPage();
	};
	const endApply = (): void => {
		if (applying === 0) return;
		applying--;
		if (applying === 0 && navHold !== null) {
			navHold();
			navHold = null;
		}
	};
	/** Paths a local open already announced, waiting for the activation their open implies —
	 *  that activation is not a separate switch. The activation consumes the entry; any
	 *  activation also clears the rest, whose implied activation it superseded (the editor's
	 *  openIntent lets only the newest open take the focus) — a stale entry would swallow
	 *  the user's next real switch to that tab. Background opens never wait here. */
	const pendingOpens = new Set<string>();
	/** Paths whose open is still in flight — a remote open's pre-mark, or a local facade
	 *  open's own. A tabs diff meanwhile must read them as pending, not as closed; a remote
	 *  close naming one queues in `pendingCloses` instead of finding no tab and getting
	 *  lost (which would re-open the other side's just-closed tab when the open lands). */
	const applyingOpens = new Set<string>();
	/** Closes that arrived while their open was still in flight: applied when it lands. */
	const pendingCloses = new Set<string>();
	const pendingTabCloses = new Set<string>();
	/** Announcements are allowed only while live (booted, not detached), not local-only —
	 *  and gated on the presence table (§7.0: fewer than two active frontends, nothing
	 *  crosses). Without a presence the caller's own judgement stands. */
	let live = options.startImmediately !== false;
	let quiet = false;
	/** The session restore's own page hold: the tabs it rebuilds are housekeeping, not the
	 *  user's acts — its active-tab activation must not drag a phone off the page it is on
	 *  a second after boot. Taken by `localOnly(true)`, released by `localOnly(false)` and
	 *  `detach()`. */
	let restoreHold: (() => void) | null = null;
	let awaitingSnapshot = false;
	let catchUpTimer: ReturnType<typeof setTimeout> | null = null;
	let detachListener: (() => void) | null = null;

	const canSend = (): boolean => live && !quiet && (presence ? presence.syncAllowed() : true);
	const announce = (message: WorkbenchSyncMessage): void => {
		if (canSend()) deps.send(message);
	};
	/** Whether an announced open really landed — the editor reports a failed open as a
	 *  notification, not a rejection, so a resolved promise proves nothing. Without this
	 *  check the pre-mark would rebound at the next tabs diff as a close of the other
	 *  side's healthy tab. */
	const landedFile = (key: string): boolean => editors.openFilePaths().some((path) => keyOf(path) === key);
	const landedTab = (id: string): boolean => openTabIds().has(id);

	/** A remote close applied to the ACTIVE tab keeps suppressing activations until the tab
	 *  is really gone: the editor's close settles asynchronously when a dirty tab asks to
	 *  save, and the successor activation that fires then is the close's consequence, not
	 *  this user's switch — letting it cross would drag the other side off the tab the
	 *  sender's own `active` message just chose. A user gesture releases the hold only when
	 *  the tab survived it (a Cancel; a Discard's gesture precedes the close itself, and
	 *  the poll wins that race), and a cap bounds the worst case. */
	const holdUntilClosed = (stillOpen: () => boolean): void => {
		if (!stillOpen()) return;
		beginApply();
		let released = false;
		const release = (): void => {
			if (released) return;
			released = true;
			endApply();
			clearInterval(poll);
			clearTimeout(cap);
			window.removeEventListener('pointerdown', onGesture, true);
			window.removeEventListener('keydown', onGesture, true);
		};
		const poll = setInterval(() => {
			if (!stillOpen()) release();
		}, 100);
		const cap = setTimeout(release, 120_000);
		const onGesture = (): void => {
			setTimeout(() => {
				if (stillOpen()) release();
			}, 150);
		};
		window.addEventListener('pointerdown', onGesture, true);
		window.addEventListener('keydown', onGesture, true);
	};

	/** Apply a close that crossed: its removal was pre-marked before this ran, so the tabs
	 *  diff never echoes it. The editor's close only looks synchronous — it settles in a
	 *  later task (a dirty tab's save dialog whenever the user answers) — so the applying
	 *  guard outlives the call itself, and an active tab's close holds it until the tab is
	 *  really gone. */
	const closeNow = async (key: string): Promise<void> => {
		beginApply();
		try {
			const wasActive = activeKey !== null && activeKey.startsWith('file:') && keyOf(activeKey.slice(5)) === key;
			if (!editors.closeFilePath(key)) return;
			// A clean close settles within a task; a dirty one waits on the save dialog.
			await new Promise((resolve) => setTimeout(resolve, 0));
			if (wasActive) holdUntilClosed(() => landedFile(key));
		} finally {
			endApply();
		}
	};
	const closeTabNow = async (id: string): Promise<void> => {
		beginApply();
		try {
			const wasActive = activeKey === `tab:${id}`;
			if (!editors.closeById(id)) return;
			await new Promise((resolve) => setTimeout(resolve, 0));
			if (wasActive) holdUntilClosed(() => landedTab(id));
		} finally {
			endApply();
		}
	};

	/** A remote operation: pre-mark what it will change, run it raw (never through the local
	 *  wrappers), and un-mark an open that failed — thrown or verified (the editor swallows
	 *  an open's failure as a notification, so the landing itself is checked). A close the
	 *  user refuses leaves the tab open and unannounced — the next tabs diff announces it
	 *  back, and the two sides settle on "kept open", exactly the refused close's meaning. */
	const run = async (step: () => unknown, own: { add?: string; spell?: string; remove?: string; addTab?: string; removeTab?: string } = {}): Promise<void> => {
		if (own.add !== undefined) {
			announced.set(own.add, own.spell ?? own.add);
			applyingOpens.add(own.add);
		}
		if (own.addTab !== undefined) {
			announcedTabs.add(own.addTab);
			applyingTabs.add(own.addTab);
		}
		if (own.remove !== undefined) announced.delete(own.remove);
		if (own.removeTab !== undefined) announcedTabs.delete(own.removeTab);
		beginApply();
		let failed = false;
		try {
			await step();
			if (own.add !== undefined && !landedFile(own.add)) failed = true;
			if (own.addTab !== undefined && !landedTab(own.addTab)) failed = true;
		} catch {
			failed = true;
		} finally {
			endApply();
			if (own.add !== undefined) {
				applyingOpens.delete(own.add);
				if (failed) {
					announced.delete(own.add);
					pendingCloses.delete(own.add);
				} else if (pendingCloses.delete(own.add)) {
					// Its close arrived while the open was in flight: close what just landed.
					announced.delete(own.add);
					void closeNow(own.add);
				}
			}
			if (own.addTab !== undefined) {
				applyingTabs.delete(own.addTab);
				if (failed) {
					announcedTabs.delete(own.addTab);
					pendingTabCloses.delete(own.addTab);
				} else if (pendingTabCloses.delete(own.addTab)) {
					announcedTabs.delete(own.addTab);
					void closeTabNow(own.addTab);
				}
			}
		}
	};
	/** Open a tab that crosses whole through this frontend's own editor area. */
	const openSyncedTab = (input: SyncedTabInput): Promise<void> | undefined =>
		input.kind === 'diff' ? editors.openDiff?.(input) : editors.openFileHistory?.(input.path);

	// A local file open crosses with its anchor, the moment the user asked for it, and marks
	// the path announced — the tabs diff must not repeat it. Everything user-facing opens
	// through this facade (explorer, quick open, SCM, search, extensions); a session restore
	// opens through its groups directly and stays local. The settle check matters as much as
	// the announcement: a failed open (the editor notifies and returns) must un-mark what it
	// pre-marked, or the next tabs diff reads it as a close and shuts the other side's tab.
	const rawOpenFile = editors.openFile.bind(editors) as typeof editors.openFile;
	editors.openFile = (path, options, placement) => {
		const key = keyOf(path);
		announce({ by, k: 'open', path, line: options?.line, column: options?.column });
		announced.set(key, path);
		applyingOpens.add(key);
		if (options?.inactive !== true) pendingOpens.add(key);
		const settle = (): void => {
			applyingOpens.delete(key);
			if (!landedFile(key)) {
				announced.delete(key);
				pendingOpens.delete(key);
				pendingCloses.delete(key);
			} else if (pendingCloses.delete(key)) {
				announced.delete(key);
				void closeNow(key);
			}
		};
		const opened = rawOpenFile(path, options, placement);
		void Promise.resolve(opened).then(settle, settle);
		return opened;
	};

	// The tabs diff catches closes from wherever they came (the tab strip's own close
	// button, closeAll, a path deleted on disk) and any open that bypassed the facade — and
	// the extension pages' closes: a copy closed on a phone closes the PC's panel, a panel
	// closed on the PC closes every copy (their tab ids are the same on every frontend).
	const prevOnTabsChange = editors.onTabsChange;
	editors.onTabsChange = () => {
		prevOnTabsChange?.();
		const nowPaths = editors.openFilePaths();
		const now = new Map(nowPaths.map((path) => [keyOf(path), path]));
		const synced = syncedTabs();
		const nowTabs = new Set([...editors.openExtPageIds(), ...synced.keys()]);
		const active = editors.activeInput;
		// A tab arriving as the active one whose activation has not been reported yet: that
		// coming report is the create's own (when the report came first, it was read fresh
		// there already).
		for (const id of nowTabs) if (!announcedTabs.has(id) && active?.kind === 'extpage' && active.id === id && activeKey !== `tab:${id}`) freshTabs.add(id);
		for (const id of freshTabs) if (!nowTabs.has(id)) freshTabs.delete(id);
		if (canSend()) {
			for (const [key, path] of now) if (!announced.has(key)) deps.send({ by, k: 'open', path });
			for (const [key, spelling] of announced) if (!now.has(key) && !applyingOpens.has(key)) deps.send({ by, k: 'close', path: spelling });
			// A diff or a file history opened here (a Source Control change clicked, a history
			// entry): the other side opens the same tab. An extension page's tab needs no
			// message — its create mirror opened it everywhere.
			for (const [id, input] of synced) if (!announcedTabs.has(id)) deps.send({ by, k: 'openTab', input });
			for (const id of announcedTabs) if (!nowTabs.has(id) && !applyingTabs.has(id)) deps.send({ by, k: 'closeTab', id });
		}
		announced = new Map([...now, ...[...applyingOpens].map((key) => [key, announced.get(key) ?? key] as [string, string])]);
		announcedTabs = new Set([...nowTabs, ...applyingTabs]);
	};

	// A file tab or an extension page taking the focus crosses as one message — the open's
	// own activation does not (its open message, or the panel's create mirror, already said
	// so). The hook fires on every cursor move too: only a change of the active tab counts.
	const prevOnActiveChange = editors.onActiveChange;
	editors.onActiveChange = (editor) => {
		prevOnActiveChange?.(editor);
		// A diff or history reports its tab id, not its input: its key is read off the full
		// input the area holds, the one form `activeKeyOf` keys it by.
		const key = editor?.kind === 'diff' || editor?.kind === 'history' ? activeKeyOf(editors.activeInput) : activeKeyOf(editor);
		if (key !== null && key.startsWith('file:')) {
			// The open's own activation is consumed silently; either way this activation
			// superseded every other in-flight open's implied one (the editor's openIntent
			// lets only the newest open take the focus), so their entries go too — a stale
			// entry would swallow the user's next real switch to that tab.
			const implied = pendingOpens.delete(keyOf(key.slice(5)));
			pendingOpens.clear();
			if (!implied && key !== activeKey && applying === 0 && canSend()) announce({ by, k: 'active', path: key.slice(5) });
		} else if (key !== null && key !== activeKey) {
			pendingOpens.clear();
			const crosses = applying === 0 && canSend();
			// Fresh: the tabs diff saw it arrive as the active tab, or has not seen it at all
			// yet (the group's focus re-reports the new tab before its strip re-renders).
			const id = key.slice(4);
			if (freshTabs.has(id) || !announcedTabs.has(id)) freshTabs.delete(id);
			else if (crosses) {
				const input = editors.activeInput ? syncedTabInput(editors.activeInput as EditorInput) : null;
				announce(input && inputId(input) === id ? { by, k: 'activeTab', id, input } : { by, k: 'activeTab', id });
			}
		}
		activeKey = key;
	};

	/** The snapshot this frontend answers a state request with: the open tabs' ids — paths
	 *  and inputs, never contents — and the active tab (§7.0.3). */
	const snapshotMessage = (to: string): WorkbenchSyncMessage => ({
		by,
		k: 'stateSnapshot',
		to,
		files: editors.openFilePaths(),
		tabs: [...syncedTabs().values()],
		extTabs: editors.openExtPageIds(),
		active: (() => {
			const input = editors.activeInput;
			if (!input) return null;
			if (input.kind === 'file') return input.path ? { kind: 'file', path: input.path } : null;
			const key = activeKeyOf(input);
			return key !== null && key.startsWith('tab:') ? { kind: 'tab', id: key.slice(4) } : null;
		})()
	});

	/** Merge a snapshot on the freshly active frontend (§7.0.3): tabs take the UNION — the
	 *  other side's open here in the background, mine pushed back as background opens — no
	 *  tab closes over it and an unsaved buffer always survives; the active tab follows the
	 *  recently active side (the answerer), which is K14's "the PC reopening follows the
	 *  remote" and its symmetric cases. A snapshot from a remote passes the same
	 *  open-boundary gate an `open` message does: only paths inside this window's folders
	 *  land (lexical check plus the canonical re-check when the backend serves it). */
	const mergeSnapshot = (message: Extract<WorkbenchSyncMessage, { k: 'stateSnapshot' }>): void => {
		const remoteOrigin = message.by !== 'main';
		const roots = workbench.openFolders?.() ?? [];
		const gateFile = async (path: string): Promise<boolean> => {
			if (!remoteOrigin) return true;
			if (!withinRoots(path, roots)) return false;
			if (!options.canonicalPath) return true;
			try {
				const form = await options.canonicalPath(path);
				return form !== null && withinRoots(form, roots);
			} catch {
				return false;
			}
		};
		void (async () => {
			const haveFiles = new Set(editors.openFilePaths().map((path) => keyOf(path)));
			for (const path of message.files) {
				const key = keyOf(path);
				if (haveFiles.has(key) || applyingOpens.has(key)) continue;
				if (!(await gateFile(path))) continue;
				await run(() => rawOpenFile(path, { inactive: true }), { add: key, spell: path });
			}
			for (const input of message.tabs) {
				const id = inputId(input);
				if (openTabIds().has(id) || applyingTabs.has(id)) continue;
				await run(() => openSyncedTab(input), { addTab: id });
			}
			// My tabs the other side lacks cross back — the union runs both ways, so the
			// side that stayed active gains the returning frontend's work as background
			// tabs instead of learning them one operation at a time.
			for (const path of editors.openFilePaths()) {
				if (!message.files.some((theirs) => keyOf(theirs) === keyOf(path))) announce({ by, k: 'open', path, inactive: true });
			}
			const theirs = new Set(message.tabs.map((input) => inputId(input)));
			for (const [id, input] of syncedTabs()) if (!theirs.has(id)) announce({ by, k: 'openTab', input });
			// The active tab LAST, after the union's background opens: the editor's
			// openIntent lets only the newest open take the focus, so this one wins it.
			const active = message.active;
			if (active?.kind === 'file') {
				if (!editors.revealFilePath(active.path) && await gateFile(active.path)) {
					await run(() => rawOpenFile(active.path), { add: keyOf(active.path), spell: active.path });
				}
			} else if (active?.kind === 'tab' && !editors.revealById(active.id)) {
				const input = message.tabs.find((entry) => inputId(entry) === active.id);
				if (input) await run(() => openSyncedTab(input), { addTab: active.id });
			}
		})();
	};

	/** Ask the others for a snapshot and accept one within the window: the joiner merges,
	 *  then starts announcing (§7.0.3). No other active frontend — the typical lone remote
	 *  — skips the whole exchange. */
	const catchUp = (): void => {
		if (!live || quiet) return;
		if (presence && !presence.othersActive()) return;
		awaitingSnapshot = true;
		if (catchUpTimer !== null) clearTimeout(catchUpTimer);
		catchUpTimer = setTimeout(() => {
			awaitingSnapshot = false;
			catchUpTimer = null;
		}, CATCH_UP_WINDOW_MS);
		deps.send({ by, k: 'stateRequest' });
	};
	presence?.onBecameActive(() => catchUp());
	// The catch-up's other half (§7.0.3): a frontend that STARTED alone — its start's own
	// catch-up skipped, the table naming no other active frontend yet (a fresh remote's
	// roster is empty until the PC's heartbeat or a WINDOWS word lands) — asks the moment
	// the roster first names one. The awaiting window keeps a heartbeat-seconds-later
	// arrival from stacking a second request.
	presence?.onRosterChange?.(() => {
		if (!awaitingSnapshot) catchUp();
	});

	/** One crossed message, applied: the receive handler's body, kept whole so the
	 *  remote-open gate can call back into it after its async canonical re-check. */
	const applyMessage = (message: WorkbenchSyncMessage): void => {
		switch (message.k) {
			case 'open': {
				const key = keyOf(message.path);
				// An open of it is already landing here (a local one, or the message's
				// own earlier copy): it satisfies this message.
				if (applyingOpens.has(key)) break;
				const openOptions = message.line !== undefined
					? { line: message.line, column: message.column, inactive: message.inactive === true }
					: message.inactive === true ? { inactive: true } : undefined;
				void run(() => rawOpenFile(message.path, openOptions), { add: key, spell: message.path });
				break;
			}
			case 'close': {
				const key = keyOf(message.path);
				// Its open is still in flight: close it the moment it lands — closing now
				// would find no tab, and the landing would re-announce the open, re-opening
				// the sender's just-closed tab.
				if (applyingOpens.has(key)) {
					pendingCloses.add(key);
					break;
				}
				void run(() => closeNow(key), { remove: key });
				break;
			}
			case 'closeTab':
				if (applyingTabs.has(message.id)) {
					pendingTabCloses.add(message.id);
					break;
				}
				void run(() => closeTabNow(message.id), { removeTab: message.id });
				break;
			case 'activeTab': {
				// A tab not open here (its create mirror still in flight, or a copy this
				// side never had) stays a no-op: the create opens it in the foreground. A
				// tab that crosses whole carries its input, and opening it converges —
				// unless its open is already landing here, in which case that open
				// activates it (opening again would read the same revisions twice).
				const input = message.input;
				const inFlight = applyingTabs.has(message.id);
				void run(() => {
					if (editors.revealById(message.id)) return undefined;
					return !inFlight && input ? openSyncedTab(input) : undefined;
				}, inFlight || !input ? {} : { addTab: message.id });
				break;
			}
			case 'openTab':
				void run(() => openSyncedTab(message.input), { addTab: inputId(message.input) });
				break;
			case 'active': {
				// Not open here (a missed open, or opened before this page arrived): opening
				// it is the convergence — the active file is the same on both sides. An open
				// already landing here activates it itself.
				const key = keyOf(message.path);
				const inFlight = applyingOpens.has(key);
				void run(() => {
					if (editors.revealFilePath(message.path)) return undefined;
					return inFlight ? undefined : rawOpenFile(message.path);
				}, inFlight ? {} : { add: key, spell: message.path });
				break;
			}
			case 'stateRequest':
			case 'stateSnapshot':
				break; // routed in the receive handler, never applied as an operation
		}
	};

	const attached: AttachedWorkbenchSync = {
		start(): void {
			if (detachListener !== null) return;
			live = true;
			detachListener = deps.receive((message) => {
				if (!message || message.by === by) return;
				// The catch-up protocol rides ahead of the operations: the designated
				// responder answers a request, the joiner merges the snapshot addressed to
				// it. Both are presence-shaped, not operations — the open-boundary gate
				// below guards the snapshot's own file opens (mergeSnapshot re-checks every
				// path it opens).
				if (message.k === 'stateRequest') {
					if (presence && presence.isDesignatedResponder(message.by)) announce(snapshotMessage(message.by));
					return;
				}
				if (message.k === 'stateSnapshot') {
					if (message.to === by && awaitingSnapshot) {
						awaitingSnapshot = false;
						if (catchUpTimer !== null) {
							clearTimeout(catchUpTimer);
							catchUpTimer = null;
						}
						mergeSnapshot(message);
					}
					return;
				}
				// A remote-originated file open is the product (the phone opens, the PC
				// follows) — but only inside the folders this window has open: a forged or
				// curious session must not make the PC render ~/.ggs into the mirror. The
				// lexical answer stands only until the path resolves — a repository entry
				// that is really a symlink to ~/.ggs passes `withinRoots` while its reads
				// land outside — so a supplied `canonicalPath` re-checks the resolution
				// against the same `remote_canonical_paths` the Relay's own gate rides:
				// refused when it resolves outside the roots; a null answer (the backend's
				// confinement, or nothing to resolve) keeps the lexical one. The check
				// is async — one round trip is the cost of a refused open, and the
				// announced/applying machinery already tolerates operations landing out
				// of order.
				const remoteOrigin = message.by !== 'main';
				const remoteOpensFile =
					remoteOrigin && (message.k === 'open' || message.k === 'active') && typeof message.path === 'string';
				if (remoteOpensFile) {
					const roots = workbench.openFolders?.() ?? [];
					if (!withinRoots(message.path, roots)) return;
					if (options.canonicalPath) {
						void options
							.canonicalPath(message.path)
							.then((form) => {
								if (form === null || withinRoots(form, roots)) applyMessage(message);
							})
							.catch(() => undefined); // an unanswerable check refuses the open
						return;
					}
				}
				applyMessage(message);
			});
			// A frontend that is already active when the channel opens catches up at once
			// (§7.0.3's "a new remote connecting"): the boot's own wiring is done, its
			// restored tabs are its baseline, and the merge only adds.
			if (presence?.isActive()) catchUp();
		},
		localOnly(local: boolean): void {
			quiet = local;
			if (local) {
				if (restoreHold === null) restoreHold = hook('navigation').holdPage();
				return;
			}
			restoreHold?.();
			restoreHold = null;
			// Leaving local-only absorbs whatever changed: this frontend's own restored tabs
			// are its baseline, nothing to announce and nothing to close on the others.
			announced = new Map(editors.openFilePaths().map((path) => [keyOf(path), path]));
			announcedTabs = openTabIds();
			activeKey = activeKeyOf(editors.activeInput);
			pendingOpens.clear();
			pendingCloses.clear();
			pendingTabCloses.clear();
			freshTabs.clear();
		},
		noteWindowHidden(): void {
			// The presence table is told by its owner (installWorkbenchSync wires it in);
			// nothing else of the sync changes — the gate simply closes.
		},
		detach(): void {
			detachListener?.();
			detachListener = null;
			live = false;
			restoreHold?.();
			restoreHold = null;
			if (navHold !== null) {
				navHold();
				navHold = null;
			}
			applying = 0;
			editors.openFile = rawOpenFile;
			editors.onTabsChange = prevOnTabsChange;
			editors.onActiveChange = prevOnActiveChange;
		}
	};
	if (live) attached.start();
	return attached;
}

/** The sync wired to the app's own event channel: out as the Tauri broadcast every frontend
 *  listens to (the Relay carries it to the sessions that subscribed), in through the same
 *  `listen` the workbench's other backend events use. The presence table rides the same
 *  channel with its own message kinds. Silent until `start()`. */
export function installWorkbenchSync(workbench: SyncedWorkbench): AttachedWorkbenchSync {
	const by = frontendId();
	const wire = <T>(): { send(message: T): void; receive(handler: (message: T) => void): () => void } => ({
		send: (message) => void tauriEmit(WORKBENCH_SYNC_EVENT, message).catch(() => undefined),
		receive: (handler) => {
			let unlisten: (() => void) | null = null;
			let detached = false;
			void tauriListen<T>(WORKBENCH_SYNC_EVENT, (event) => handler(event.payload))
				.then((off) => {
					if (detached) off();
					else unlisten = off;
				})
				.catch(() => undefined);
			return () => {
				detached = true;
				unlisten?.();
			};
		}
	});
	const presence = new Presence(by, wire(), {
		// The device label is informational (a badge, a conflict message): the remote names
		// its form, the desktop is the PC.
		device: () => (remoteEnv() ? document.documentElement.dataset['device'] ?? 'remote' : 'PC')
	});
	registerPresence(presence);
	const attached = attachWorkbenchSync(workbench, wire(), by, {
		startImmediately: false,
		presence,
		// The remote-open gate's canonical re-check (pathGate.ts's symlink note): one path
		// per call. The backend confines the answers to the boundary's own areas, so a
		// session's own copy of this command is no oracle — and on a phone the call simply
		// crosses the wire like any other invoke.
		canonicalPath: async (path) => {
			const forms = (await invoke('remote_canonical_paths', { paths: [path] })) as (string | null)[];
			return forms[0] ?? null;
		}
	});
	const baseStart = attached.start.bind(attached);
	attached.start = (): void => {
		baseStart();
		presence.start();
	};
	const baseDetach = attached.detach.bind(attached);
	attached.detach = (): void => {
		presence.stop();
		baseDetach();
		registerPresence(null);
	};
	attached.noteWindowHidden = (): void => {
		presence.setSelfActive(false);
	};
	return attached;
}
