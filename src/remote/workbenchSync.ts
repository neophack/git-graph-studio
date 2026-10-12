// Cross-frontend operation sync (docs/ggs-remote-plan.md §22.7): when the PC keeps its
// desktop UI while a phone runs its own phone workbench (§22.5), the two frontends would
// each keep their own tabs and views — a file opened on the PC never appeared on the phone.
// This module makes the OPERATIONS correspond one-to-one instead: every file a frontend
// opens, closes or switches to, and every sidebar view it shows, crosses as one tiny intent
// message and is performed on the other frontends' own workbenches. Paths and ids only —
// never content, never DOM: the receiving side opens the document through its own editor
// area (one file read it would have paid anyway), so the wire cost of a synced open is the
// message itself, well under 200 bytes.
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

import { emit as tauriEmit, listen as tauriListen } from '@tauri-apps/api/event';
import type { EditorPlacement } from '../editor';
import type { ActiveEditorInfo, EditorArea } from '../editorArea';
import { phoneShell } from './nav';
import { frontendId } from './session';

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
	| { by: string; k: 'activeTab'; id: string }
	| { by: string; k: 'sidebar'; shown: false };

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
}

/** The workbench surface the sync rides on. */
export interface SyncedWorkbench {
	editors: SyncedEditorArea | EditorArea;
	showView(view: string, focus?: boolean): void;
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
 *  (whose tab id is the same on every frontend), null while anything else (a diff, the
 *  welcome) holds the focus — those keep their frontend's own layout, they do not sync. */
function activeKeyOf(input: { kind: string; path?: string; id?: string } | null): string | null {
	if (input?.kind === 'file') return input.path ? `file:${input.path}` : null;
	if (input?.kind === 'extpage') return input.id ? `tab:${input.id}` : null;
	return null;
}

/** Wire one workbench into the sync: local operations cross as messages, remote messages
 *  land as local operations. Wraps the editor area's open facade and the change hooks, and
 *  the workbench's view switch; composes with whatever handlers were already set. */
export function attachWorkbenchSync(
	workbench: SyncedWorkbench,
	deps: WorkbenchSyncDeps,
	by: string,
	options: { startImmediately?: boolean; sidebarHideCrosses?: () => boolean } = {}
): AttachedWorkbenchSync {
	const sidebarHideCrosses = options.sidebarHideCrosses ?? (() => true);
	// The real EditorArea satisfies this surface structurally; the cast keeps every read and
	// write below on one type.
	const editors = workbench.editors as SyncedEditorArea;
	/** What the other frontends believe about this one's open files. Local operations
	 *  announce into it, remote operations pre-mark it, and the tabs diff announces exactly
	 *  the difference — so an echo can never re-announce, and a local change landing while a
	 *  remote operation is still in flight still crosses. */
	let announced = new Set(editors.openFilePaths());
	/** The same contract for extension-page tabs: what the others believe is open here. A
	 *  tab ADDED needs no message (the backend's create mirror opened it everywhere); a tab
	 *  REMOVED locally is a close that must cross. */
	let announcedTabs = new Set(editors.openExtPageIds());
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
	 *  that activation is not a separate switch. The activation consumes the entry; an open
	 *  that never lands leaves it, harmless (the next open of the same path re-announces). */
	const pendingOpens = new Set<string>();
	/** Paths whose remote open is still in flight: pre-marked announced, tab not landed —
	 *  a tabs diff meanwhile must read them as pending, not as closed. */
	const applyingOpens = new Set<string>();
	/** Announcements are allowed only while live (booted, not detached) and not local-only. */
	let live = options.startImmediately !== false;
	let quiet = false;
	let detachListener: (() => void) | null = null;

	const announce = (message: WorkbenchSyncMessage): void => {
		if (live && !quiet) deps.send(message);
	};
	/** A remote operation: pre-mark what it will change, run it raw (never through the local
	 *  wrappers), and un-mark an open that failed. A close the user refuses leaves the tab
	 *  open and unannounced — the next tabs diff announces it back, and the two sides settle
	 *  on "kept open", exactly the refused close's meaning. */
	const run = async (step: () => unknown, own: { add?: string; remove?: string; removeTab?: string } = {}): Promise<void> => {
		if (own.add !== undefined) {
			announced.add(own.add);
			applyingOpens.add(own.add);
		}
		if (own.remove !== undefined) announced.delete(own.remove);
		if (own.removeTab !== undefined) announcedTabs.delete(own.removeTab);
		applying++;
		try {
			await step();
		} catch {
			if (own.add !== undefined) announced.delete(own.add);
		} finally {
			applying--;
			if (own.add !== undefined) applyingOpens.delete(own.add);
		}
	};

	// A local file open crosses with its anchor, the moment the user asked for it, and marks
	// the path announced — the tabs diff must not repeat it. Everything user-facing opens
	// through this facade (explorer, quick open, SCM, search, extensions); a session restore
	// opens through its groups directly and stays local.
	const rawOpenFile = editors.openFile.bind(editors) as typeof editors.openFile;
	editors.openFile = (path, options, placement) => {
		announce({ by, k: 'open', path, line: options?.line, column: options?.column });
		announced.add(path);
		pendingOpens.add(path);
		return rawOpenFile(path, options, placement);
	};

	// The tabs diff catches closes from wherever they came (the tab strip's own close
	// button, closeAll, a path deleted on disk) and any open that bypassed the facade — and
	// the extension pages' closes: a copy closed on a phone closes the PC's panel, a panel
	// closed on the PC closes every copy (their tab ids are the same on every frontend).
	const prevOnTabsChange = editors.onTabsChange;
	editors.onTabsChange = () => {
		prevOnTabsChange?.();
		const now = new Set(editors.openFilePaths());
		const nowTabs = new Set(editors.openExtPageIds());
		const active = editors.activeInput;
		// A tab arriving as the active one whose activation has not been reported yet: that
		// coming report is the create's own (when the report came first, it was read fresh
		// there already).
		for (const id of nowTabs) if (!announcedTabs.has(id) && active?.kind === 'extpage' && active.id === id && activeKey !== `tab:${id}`) freshTabs.add(id);
		for (const id of freshTabs) if (!nowTabs.has(id)) freshTabs.delete(id);
		if (live && !quiet) {
			for (const path of now) if (!announced.has(path)) deps.send({ by, k: 'open', path });
			for (const path of announced) if (!now.has(path) && !applyingOpens.has(path)) deps.send({ by, k: 'close', path });
			for (const id of announcedTabs) if (!nowTabs.has(id)) deps.send({ by, k: 'closeTab', id });
		}
		announced = new Set([...now, ...applyingOpens]);
		announcedTabs = nowTabs;
	};

	// A file tab or an extension page taking the focus crosses as one message — the open's
	// own activation does not (its open message, or the panel's create mirror, already said
	// so). The hook fires on every cursor move too: only a change of the active tab counts.
	const prevOnActiveChange = editors.onActiveChange;
	editors.onActiveChange = (editor) => {
		prevOnActiveChange?.(editor);
		const key = activeKeyOf(editor);
		if (key !== null && key.startsWith('file:') && pendingOpens.has(key.slice(5))) {
			pendingOpens.delete(key.slice(5));
		} else if (key !== null && key !== activeKey) {
			const crosses = applying === 0 && live && !quiet;
			if (key.startsWith('file:')) {
				if (crosses) announce({ by, k: 'active', path: key.slice(5) });
			} else {
				// Fresh: the tabs diff saw it arrive as the active tab, or has not seen it at all
				// yet (the group's focus re-reports the new tab before its strip re-renders).
				const id = key.slice(4);
				if (freshTabs.has(id) || !announcedTabs.has(id)) freshTabs.delete(id);
				else if (crosses) announce({ by, k: 'activeTab', id });
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

	const attached: AttachedWorkbenchSync = {
		start(): void {
			if (detachListener !== null) return;
			live = true;
			detachListener = deps.receive((message) => {
				if (!message || message.by === by) return;
				switch (message.k) {
					case 'open':
						void run(() => rawOpenFile(message.path, message.line !== undefined ? { line: message.line, column: message.column } : undefined), { add: message.path });
						break;
					case 'close':
						void run(() => editors.closeFilePath(message.path), { remove: message.path });
						break;
					case 'closeTab':
						void run(() => editors.closeById(message.id), { removeTab: message.id });
						break;
					case 'activeTab':
						// A tab not open here (its create mirror still in flight, or a copy this
						// side never had) stays a no-op: the create opens it in the foreground.
						void run(() => editors.revealById(message.id));
						break;
					case 'sidebar':
						if (rawToggleSidebar && workbench.sidebarShown !== false) void run(() => rawToggleSidebar.call(workbench));
						break;
					case 'active':
						// Not open here (a missed open, or opened before this page arrived): opening
						// it is the convergence — the active file is the same on both sides.
						void run(() => (editors.revealFilePath(message.path) ? undefined : rawOpenFile(message.path)), { add: message.path });
						break;
					case 'view':
						void run(() => rawShowView.call(workbench, message.id));
						break;
				}
			});
		},
		localOnly(local: boolean): void {
			quiet = local;
			if (local) return;
			// Leaving local-only absorbs whatever changed: this frontend's own restored tabs
			// are its baseline, nothing to announce and nothing to close on the others.
			announced = new Set(editors.openFilePaths());
			announcedTabs = new Set(editors.openExtPageIds());
			activeKey = activeKeyOf(editors.activeInput);
			pendingOpens.clear();
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
	}, frontendId(), { startImmediately: false, sidebarHideCrosses: () => !phoneShell() });
}
