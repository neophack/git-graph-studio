// Cross-frontend operation sync (docs/ggs-remote-plan.md §22.7): when the PC keeps its
// desktop UI while a phone runs its own phone workbench (§22.5), the two frontends would
// each keep their own tabs and views — a file opened on the PC never appeared on the phone.
// This module makes the OPERATIONS correspond one-to-one instead: every file a frontend
// opens, closes or switches to, and every sidebar view it shows, crosses as one tiny intent
// message and is performed on the other frontends' own workbenches. Paths and ids only —
// never content, never DOM: the receiving side opens the document through its own editor
// area (one file read it would have paid anyway). A file open/close/active message is well
// under 200 bytes; the tabs that cross whole (a diff, a file history) carry their input —
// revisions, paths and labels, never text.
//
// Both sides run the same shared workbench code (src/workbench.ts), so one module serves
// both: the desktop emits through the real Tauri broadcast (which the Relay forwards to
// exactly the sessions that LISTEN — a mirror-mode page runs no workbench, subscribes to
// nothing of this, and pays nothing), the phone's own-UI workbench through the WebSocket
// shim of the same `@tauri-apps/api/event` surface. Every message carries its sender's
// frontend id; a frontend ignores its own echoes. Remote operations run through the RAW
// open/view functions — the wrappers exist for local operations — and pre-mark the
// `announced` set, so what a remote operation changed never crosses back, while a LOCAL
// change landing mid-apply still crosses: no ping-pong, no swallowed operations.
//
// The sync stays silent until the workbench's boot is through (a boot's own view wiring is
// housekeeping, and a reloaded phone page must not pull the PC's sidebar around), and goes
// local-only while a session restore rebuilds this frontend's own tabs.

import { emit as tauriEmit, invoke, listen as tauriListen } from '../platform/ipc/core';
import { inputId, type EditorInput } from '../features/editor';
import type { EditorPlacement } from '../features/editor/types';
import type { ActiveEditorInfo, EditorArea } from '../features/editor';
import { phoneShell } from './nav';
import { frontendId, remoteEnv } from './session';
import { withinRoots } from './pathGate';

export const WORKBENCH_SYNC_EVENT = 'studio://workbench-sync';

/** One operation crossing the frontends: what its user opened, closed, switched to, or the
 *  sidebar view they showed. `line` / `column` preserve an open's anchor (a search result's
 *  jump); `by` is the sender's frontend id (`main`, `remote/<n>`).
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
 *  `sidebar` is the side bar hidden: the PC closing its Claude Code (or any) view takes a
 *  phone off that side page. Only a side-by-side workbench announces it — on a phone the
 *  side view is a full-screen page whose dismissal is navigation (every file tap closes it),
 *  and the PC's layout must not flicker with it. */
export type WorkbenchSyncMessage =
	| { by: string; k: 'open'; path: string; line?: number; column?: number }
	| { by: string; k: 'close'; path: string }
	| { by: string; k: 'active'; path: string }
	| { by: string; k: 'view'; id: string }
	| { by: string; k: 'closeTab'; id: string }
	| { by: string; k: 'activeTab'; id: string; input?: SyncedTabInput }
	| { by: string; k: 'openTab'; input: SyncedTabInput }
	| { by: string; k: 'sidebar'; shown: false };

/** The tab inputs that cross whole: diffs between revisions or files on disk, and file
 *  histories. */
export type SyncedTabInput = Extract<EditorInput, { kind: 'diff' } | { kind: 'history' }>;

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
	showView(view: string, focus?: boolean): void;
	/** The folders this window has open — the boundary a remote-originated `open` must
	 *  land inside (the relay gates invokes the same way; this is the receiver's half,
	 *  so a forged direct emit has nowhere to land either). Optional: without it,
	 *  remote-originated opens are simply ignored. */
	openFolders?(): string[];
	/** The side bar's hide toggle, its state and its view — optional: a workbench without
	 *  them syncs no side-bar hides. */
	toggleSidebar?(): void;
	readonly sidebarShown?: boolean;
	readonly activeSidebarView?: string;
}

export interface WorkbenchSyncDeps {
	send(message: WorkbenchSyncMessage): void;
	receive(handler: (message: WorkbenchSyncMessage) => void): () => void;
}

/** A wired sync: `start()` opens the channel (the workbench's boot calls it — housekeeping
 *  before that stays local), `localOnly(true)` pauses announcements while this frontend
 *  rebuilds its own tabs (a session restore), `detach()` restores the unwrapped workbench. */
export interface AttachedWorkbenchSync {
	start(): void;
	localOnly(local: boolean): void;
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
 *  land as local operations. Wraps the editor area's open facade and the change hooks, and
 *  the workbench's view switch; composes with whatever handlers were already set. */
export function attachWorkbenchSync(
	workbench: SyncedWorkbench,
	deps: WorkbenchSyncDeps,
	by: string,
	options: { startImmediately?: boolean; sidebarHideCrosses?: () => boolean; canonicalPath?: (path: string) => Promise<string | null> } = {}
): AttachedWorkbenchSync {
	const sidebarHideCrosses = options.sidebarHideCrosses ?? (() => true);
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
	/** The same contract for extension-page tabs: what the others believe is open here. A
	 *  tab ADDED needs no message (the backend's create mirror opened it everywhere); a tab
	 *  REMOVED locally is a close that must cross. */
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
	 *  active switches (their message already said so). */
	let applying = 0;
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
	/** Announcements are allowed only while live (booted, not detached) and not local-only. */
	let live = options.startImmediately !== false;
	let quiet = false;
	let detachListener: (() => void) | null = null;

	const announce = (message: WorkbenchSyncMessage): void => {
		if (live && !quiet) deps.send(message);
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
		applying++;
		let released = false;
		const release = (): void => {
			if (released) return;
			released = true;
			applying--;
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
		applying++;
		try {
			const wasActive = activeKey !== null && activeKey.startsWith('file:') && keyOf(activeKey.slice(5)) === key;
			if (!editors.closeFilePath(key)) return;
			// A clean close settles within a task; a dirty one waits on the save dialog.
			await new Promise((resolve) => setTimeout(resolve, 0));
			if (wasActive) holdUntilClosed(() => landedFile(key));
		} finally {
			applying--;
		}
	};
	const closeTabNow = async (id: string): Promise<void> => {
		applying++;
		try {
			const wasActive = activeKey === `tab:${id}`;
			if (!editors.closeById(id)) return;
			await new Promise((resolve) => setTimeout(resolve, 0));
			if (wasActive) holdUntilClosed(() => landedTab(id));
		} finally {
			applying--;
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
		applying++;
		let failed = false;
		try {
			await step();
			if (own.add !== undefined && !landedFile(own.add)) failed = true;
			if (own.addTab !== undefined && !landedTab(own.addTab)) failed = true;
		} catch {
			failed = true;
		} finally {
			applying--;
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
		if (live && !quiet) {
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
			if (!implied && key !== activeKey && applying === 0 && live && !quiet) announce({ by, k: 'active', path: key.slice(5) });
		} else if (key !== null && key !== activeKey) {
			pendingOpens.clear();
			const crosses = applying === 0 && live && !quiet;
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

	// Which sidebar view is showing — Explorer, Source Control, an extension's container:
	// the phone navigates its own page for it, the PC its own sidebar.
	const rawShowView = workbench.showView;
	workbench.showView = (view: string, focus?: boolean) => {
		announce({ by, k: 'view', id: view });
		return rawShowView.call(workbench, view, focus);
	};

	// The side bar hidden (an activity item clicked twice, Ctrl+B): the other side leaves the
	// view it was showing for this one. Showing it again is a view switch.
	const rawToggleSidebar = workbench.toggleSidebar;
	if (rawToggleSidebar) {
		workbench.toggleSidebar = () => {
			rawToggleSidebar.call(workbench);
			if (applying > 0) return;
			if (workbench.sidebarShown === false) {
				if (sidebarHideCrosses()) announce({ by, k: 'sidebar', shown: false });
			} else if (workbench.activeSidebarView !== undefined) {
				announce({ by, k: 'view', id: workbench.activeSidebarView });
			}
		};
	}

	/** One crossed message, applied: the receive handler's body, kept whole so the
	 *  remote-open gate can call back into it after its async canonical re-check. */
	const applyMessage = (message: WorkbenchSyncMessage): void => {
		switch (message.k) {
			case 'open': {
				const key = keyOf(message.path);
				// An open of it is already landing here (a local one, or the message's
				// own earlier copy): it satisfies this message.
				if (applyingOpens.has(key)) break;
				void run(() => rawOpenFile(message.path, message.line !== undefined ? { line: message.line, column: message.column } : undefined), { add: key, spell: message.path });
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
			case 'sidebar':
				if (rawToggleSidebar && workbench.sidebarShown !== false) void run(() => rawToggleSidebar.call(workbench));
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
			case 'view':
				void run(() => rawShowView.call(workbench, message.id));
				break;
		}
	};

	const attached: AttachedWorkbenchSync = {
		start(): void {
			if (detachListener !== null) return;
			live = true;
			detachListener = deps.receive((message) => {
				if (!message || message.by === by) return;
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
		},
		localOnly(local: boolean): void {
			quiet = local;
			if (local) return;
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
		detach(): void {
			detachListener?.();
			detachListener = null;
			live = false;
			editors.openFile = rawOpenFile;
			editors.onTabsChange = prevOnTabsChange;
			editors.onActiveChange = prevOnActiveChange;
			workbench.showView = rawShowView;
			if (rawToggleSidebar) workbench.toggleSidebar = rawToggleSidebar;
		}
	};
	if (live) attached.start();
	return attached;
}

/** The sync wired to the app's own event channel: out as the Tauri broadcast every frontend
 *  listens to (the Relay carries it to the sessions that subscribed), in through the same
 *  `listen` the workbench's other backend events use. Silent until `start()`. */
export function installWorkbenchSync(workbench: SyncedWorkbench): AttachedWorkbenchSync {
	return attachWorkbenchSync(workbench, {
		send: (message) => void tauriEmit(WORKBENCH_SYNC_EVENT, message).catch(() => undefined),
		receive: (handler) => {
			let unlisten: (() => void) | null = null;
			let detached = false;
			void tauriListen<WorkbenchSyncMessage>(WORKBENCH_SYNC_EVENT, (event) => handler(event.payload))
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
	}, frontendId(), {
		startImmediately: false,
		// A phone session's side-page dismissal is navigation, never a layout change to
		// cross — but only a real browser session's: the PC's own window wearing the phone
		// shell for a mirror viewer (phoneShell() reads the live DOM marker) keeps crossing,
		// or every own-UI session attached beside the viewer would miss the hide.
		sidebarHideCrosses: () => !(remoteEnv() && phoneShell()),
		// The remote-open gate's canonical re-check (pathGate.ts's symlink note): one path
		// per call. The backend confines the answers to the boundary's own areas, so a
		// session's own copy of this command is no oracle — and on a phone the call simply
		// crosses the wire like any other invoke.
		canonicalPath: async (path) => {
			const forms = (await invoke('remote_canonical_paths', { paths: [path] })) as (string | null)[];
			return forms[0] ?? null;
		}
	});
}
