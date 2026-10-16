// The folder lifecycle: open/close/switch, workspace and single-file opens, recents, session snapshots and restore, dispose, and the fs-change refresh reactions.

import type { Workbench } from './workbench';

import { appNewInstance, bootStage, closeFolder, openFolder, openSingleFile, openWorkspace, type OpenedRoot, postFirstPaint } from '../platform/ipc/app';
import { gitInit } from '../platform/ipc/scm';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { ExtensionHost } from '../features/extensions';
import { tf } from '../platform/i18n';
import { hook } from '../platform/hooks';
import { SETTINGS_EVENT, THEME_EVENT } from '../platform/settings';
import * as state from '../platform/state';
import { basename, notify } from '../platform/ui/index';
import { FsChange, OpenedPaths, REFRESH_ECHO_MS, joinRepo, whenIdle } from './workbench';

/** The lifecycle concern of Workbench — assigned onto the prototype by the module facade (index.ts). */
export const lifecycleMethods: ThisType<Workbench> = {
	async openFolder(path: string): Promise<void> {
		if (!(await this.settleOutgoing())) return;
		await this.openFolderSettled(path);
	},

	async openFolderSettled(path: string): Promise<void> {
		let opened: OpenedRoot;
		try {
			opened = await openFolder(path);
		} catch (error) {
			notify('error', String(error));
			state.forgetFolder(path);
			return;
		}
		await this.applyRoots([opened.root], opened.isRepo, null);
	},

	async settleOutgoing(): Promise<boolean> {
		this.saveSnapshot();
		return !this.editors.hasDirtyEditors() || (await this.editors.closeAll());
	},

	async openRecent(path: string): Promise<void> {
		if (path.toLowerCase().endsWith('.ggs-workspace')) await this.openWorkspace(path);
		else await this.openFolder(path);
	},

	async onOpenPaths(payload: OpenedPaths): Promise<void> {
		const workspaces: string[] = [];
		const documents: string[] = [];
		for (const file of payload.files) {
			(file.toLowerCase().endsWith('.ggs-workspace') ? workspaces : documents).push(file);
		}
		for (const path of [...payload.folders, ...workspaces]) {
			if (this.repoPath !== null || this.singleFile !== null) {
				await appNewInstance(path).catch((error) => notify('error', tf('workbench.newWindowFailed', String(error))));
			} else if (path.toLowerCase().endsWith('.ggs-workspace')) {
				await this.openWorkspace(path);
			} else {
				await this.openFolder(path);
			}
		}
		// Decided after the folders: one of them may have just become this window's content,
		// and its files belong in it rather than in a standalone window.
		let standalone = this.repoPath === null && this.singleFile === null;
		for (const file of documents) {
			if (standalone) {
				await this.openFileStandalone(file);
				standalone = false;
			} else {
				await this.editors.openFile(file);
			}
		}
	},

	async pickFolder(): Promise<void> {
		const elsewhere = hook('folderOpen');
		if (elsewhere && (await elsewhere((path) => this.openFolder(path), this.openFolders()))) return;
		let selected: string | string[] | null;
		try {
			selected = await openDialog({ directory: true, multiple: false, title: 'Open Folder' });
		} catch (error) {
			notify('error', `Could not open the folder picker: ${String(error)}`);
			return;
		}
		if (!selected) return;
		await this.openFolder(Array.isArray(selected) ? selected[0]! : selected);
	},

	async pickWorkspace(): Promise<void> {
		let selected: string | string[] | null;
		try {
			selected = await openDialog({ multiple: false, title: 'Open Workspace', filters: [{ name: 'Git Graph Studio Workspace', extensions: ['ggs-workspace'] }] });
		} catch (error) {
			notify('error', `Could not open the workspace picker: ${String(error)}`);
			return;
		}
		if (!selected) return;
		await this.openWorkspace(Array.isArray(selected) ? selected[0]! : selected);
	},

	async pickSingleFile(): Promise<void> {
		let selected: string | string[] | null;
		try {
			selected = await openDialog({ multiple: false, title: 'Open File' });
		} catch (error) {
			notify('error', `Could not open the file picker: ${String(error)}`);
			return;
		}
		if (!selected) return;
		const file = Array.isArray(selected) ? selected[0]! : selected;
		try {
			await openSingleFile(file);
		} catch (error) {
			notify('error', String(error));
			return;
		}
		await this.openFileStandalone(file);
	},

	async openFileStandalone(path: string): Promise<void> {
		if (!(await this.settleOutgoing())) return;
		await this.editors.closeAll();
		this.singleFile = path;
		this.repoPath = null;
		this.repoPaths = [];
		this.workspaceFile = null;
		this.isRepo = false;
		this.filePicks = null;
		ExtensionHost.workspaceFolders = []; // no folder: extensions see no workspace either
		// No folder: every repository view stands down (the editors too, or their breadcrumbs
		// and relative paths would still be spelled against the folder just left).
		this.explorer.setRoot(null);
		this.editors.setRoot(null);
		this.search.setEnabled(false);
		this.search.setRoots([]);
		this.scm.setRepo(null);
		this.statusBar.setRepo(false);
		this.extensionHost.noteWorkspaceChanged([]);
		// The window is the file: hide the side bar and the terminal, like a single-file editor.
		state.layout.sidebarVisible = false;
		this.sidebar.hidden = true;
		this.sidebarSash.hidden = true;
		if (this.panel.isVisible()) this.panel.toggle();
		for (const id of ['explorer', 'search', 'scm', 'analysis', 'extensions']) this.activityItems[id]?.classList.remove('active');
		state.saveLayout();
		document.title = `${basename(path)} - Git Graph Studio`;
		this.titleBar.setFolderName(basename(path));
		await this.editors.openFile(path);
		// Boot timing: how long a single-file launch took to show its file.
		void bootStage('single file shown', performance.now()).catch(() => undefined);
	},

	async openWorkspace(path: string): Promise<void> {
		if (!(await this.settleOutgoing())) return;
		let opened: { roots: OpenedRoot[] };
		try {
			opened = await openWorkspace(path);
		} catch (error) {
			notify('error', String(error));
			return;
		}
		const roots = opened.roots;
		if (roots.length === 0) return;
		if (roots.length === 1) {
			// A one-folder workspace is just that folder. Not openFolder(): the settling and the
			// outgoing snapshot already happened above - its saveSnapshot would record the
			// just-emptied editor area over the session that was saved.
			await this.openFolderSettled(roots[0]!.root);
			return;
		}
		await this.applyRoots(roots.map((entry) => entry.root), roots.some((entry) => entry.isRepo), path);
	},

	async applyRoots(roots: string[], anyRepo: boolean, workspaceFile: string | null): Promise<void> {
		await this.editors.closeAll();
		this.repoPaths = roots;
		this.workspaceFile = workspaceFile;
		this.repoPath = roots[0]!;
		this.isRepo = anyRepo;
		this.filePicks = null;
		const root = this.repoPath;
		state.rememberFolder(workspaceFile ?? root);
		const shownName = workspaceFile ? basename(workspaceFile).replace(/\.ggs-workspace$/i, '') : basename(root);
		document.title = `${shownName} - Git Graph Studio`;
		this.titleBar.setFolderName(shownName);
		const snapshot = state.workspaceSnapshot(workspaceFile ?? root);
		// The Explorer gets every root (a virtual top level when there are several), the
		// Search view runs its query root by root, and the SCM view and the graph keep the
		// first root as the active one (their own pickers can switch).
		this.explorer.setRoots(this.repoPaths, snapshot?.expanded ?? []);
		// Boot timing: the folder counts as shown once its tree is listed (the graph's first
		// page has its own stamp; the SCM status settles after both).
		if (!this.folderShownStamped) {
			this.folderShownStamped = true;
			void this.explorer.whenRendered().then(() => bootStage('folder shown', performance.now())).catch(() => undefined);
		}
		this.search.setEnabled(true);
		this.search.setRoots(this.repoPaths.length > 1 ? this.repoPaths : []);
		this.editors.setRoot(root);
		this.scm.setRepo(root, anyRepo);
		this.statusBar.setRepo(anyRepo); // a plain folder shows no repository items
		// The graph view starts loading now, in parallel: its iframe boot and its first data
		// request run on their own while the SCM view and the status bar settle below. A
		// folder that is not a repository gets the placeholder with the Initialize button.
		// The graph view (when its plugin is installed) learns the folder and reloads through
		// the page event; nothing of the app opens it automatically — the command does.
		this.extensionHost.noteWorkspaceChanged([root]);
		// The last session's editors come back once the main thread next idles (within a
		// second at most): their CodeMirror chunk and language modes would otherwise load
		// and parse in the same burst as the graph view's boot, and the graph tab is the one
		// on screen first.
		if (snapshot && (snapshot.openFiles.length > 0 || snapshot.activeFile)) whenIdle(() => void this.restoreSnapshot(root, snapshot), 1000);
		ExtensionHost.workspaceFolders = [...this.repoPaths];
		// `git status` is the slowest part of opening a folder, and the tree above renders
		// without it: the SCM refresh and the branch head it fetches wait for the first painted
		// frame, so the full-tree scan and the head subprocess no longer compete with the graph
		// view's boot for the CPU. The same signal starts the backend's own deferred services
		// (the symbol/analysis indexes and the file watcher).
		requestAnimationFrame(() => {
			void postFirstPaint().catch(() => undefined);
			if (anyRepo) void this.scm.refresh();
		});
		if (state.layout.sidebarVisible) this.showView(this.activeView);
	},

	async initializeRepository(): Promise<void> {
		if (this.repoPath === null || this.isRepo) return;
		try {
			await gitInit();
		} catch (error) {
			notify('error', `Could not initialize the repository: ${String(error)}`);
			return;
		}
		notify('info', 'Initialized the Git repository.');
		await this.openFolder(this.repoPath);
	},

	async closeFolder(): Promise<void> {
		this.saveSnapshot();
		if (!(await this.editors.closeAll())) return;
		await closeFolder().catch(() => undefined);
		this.repoPath = null;
		this.repoPaths = [];
		this.workspaceFile = null;
		this.singleFile = null;
		this.isRepo = false;
		state.rememberFolder(null);
		document.title = 'Git Graph Studio';
		this.titleBar.setFolderName(null);
		this.explorer.setRoot(null);
		this.search.setEnabled(false);
		this.editors.setRoot(null);
		this.scm.setRepo(null);
		this.statusBar.setRepo(false);
		this.extensionHost.noteWorkspaceChanged([]);
		ExtensionHost.workspaceFolders = [];
	},

	scheduleSnapshot(): void {
		if (!this.repoPath || this.restoring) return;
		if (this.snapshotTimer !== null) window.clearTimeout(this.snapshotTimer);
		this.snapshotTimer = window.setTimeout(() => {
			this.snapshotTimer = null;
			this.saveSnapshot();
		}, 250);
	},

	saveSnapshot(): void {
		if (!this.repoPath || this.restoring) return;
		if (this.snapshotTimer !== null) {
			window.clearTimeout(this.snapshotTimer);
			this.snapshotTimer = null;
		}
		const active = this.editors.activeInput;
		// A workspace keeps its own session, keyed by its file (a plain folder by its path).
		state.saveWorkspaceSnapshot(this.workspaceFile ?? this.repoPath, {
			openFiles: this.editors.openFilePaths(),
			activeFile: active?.kind === 'file' ? active.path : null,
			expanded: this.explorer.expandedFolders(),
			groups: this.editors.groupSessions(),
			editorGrid: this.editors.gridLayout()
		});
	},

	async restoreSnapshot(root: string, snapshot: state.WorkspaceSnapshot): Promise<void> {
		// A fast folder switch (A then B within the idle delay) fires A's restore on B's
		// workbench: rebuilding A's grid - or clearing the restore flags B's own restore may
		// hold - would tear B's layout. The stale restore does not run at all.
		if (this.repoPath !== root) return;
		this.restoring = true;
		// The restore rebuilds THIS frontend's own tabs: they are its session, not
		// operations the other frontends should mirror (module 19's sync pauses for it).
		this.workbenchSync?.localOnly(true);
		try {
			const groups = snapshot.groups && snapshot.groups.length > 0
				? snapshot.groups
				: [{ files: snapshot.openFiles, active: snapshot.activeFile }];
			// The grid builder holds empty layers open until every session's files are in.
			const restored = this.editors.applyGridLayout(snapshot.editorGrid ?? null);
			for (const [index, session] of groups.entries()) {
				// Without a saved grid (pre-grid sessions, or a single group) the sessions
				// open as a row of splits, as they always did.
				const group = restored.length > 0
					? restored[Math.min(index, restored.length - 1)]!
					: index === 0 ? this.editors.groupAt(0) : this.editors.split('right');
				if (this.repoPath !== root) return; // the folder changed under the restore
				await Promise.all(session.files.map((path) => group.openFile(path, { inactive: true })));
				if (this.repoPath !== root) return;
				if (session.active) await group.openFile(session.active);
				else group.activateLast();
			}
		} finally {
			this.editors.restoringLayout = false;
			this.restoring = false;
			this.workbenchSync?.localOnly(false);
		}
	},

	dispose(): void {
		this.disposed = true;
		this.workbenchSync?.detach();
		this.workbenchSync = null;
		document.removeEventListener('keydown', this.onKeyDownBound);
		document.removeEventListener(SETTINGS_EVENT, this.onSettingsChangedBound);
		window.removeEventListener('focus', this.onWindowFocusBound);
		window.removeEventListener('blur', this.onWindowBlurBound);
		for (const unlisten of this.unlisteners.splice(0)) unlisten();
		// A pending debounce must not fire into the next workbench's session.
		if (this.snapshotTimer !== null) {
			window.clearTimeout(this.snapshotTimer);
			this.snapshotTimer = null;
		}
		if (this.refreshTimer !== null) {
			window.clearTimeout(this.refreshTimer);
			this.refreshTimer = null;
		}
		if (this.contextTimer !== null) {
			window.clearTimeout(this.contextTimer);
			this.contextTimer = null;
		}
		document.removeEventListener(THEME_EVENT, this.onThemeChangedBound);
	},

	onFsChanged(change: FsChange): void {
		if (!this.repoPath) return;
		// A batch from a folder that is no longer open (the watcher's last debounced burst
		// crossing a folder switch) belongs to the old project: its paths are relative to
		// another root and would be joined onto the new one.
		if (!this.repoPaths.includes(change.root)) return;
		// A batch that names no working-tree file and lands right after a refresh of our own
		// is ambiguous: it is that refresh's echo (the git commands it ran touching
		// `.git/`) — acting on it would refresh again, and again — or a real external git
		// operation (a terminal commit, a branch switch), whose burst never comes again, so
		// dropping it lost the update until some file happened to change. The re-check
		// reads the live status and refreshes only when it differs from the last one; the
		// in-flight flag folds a commit's burst of `.git` batches into one re-check.
		if (change.paths.length === 0 && !change.truncated && performance.now() - this.lastRefreshAt < REFRESH_ECHO_MS) {
			this.recheckSwallowedBatch();
			return;
		}
		if (!change.truncated) {
			for (const relative of change.paths) {
				const path = joinRepo(change.root, relative);
				// A clean tab reloads silently; a dirty one the disk moved under is a save
				// conflict (§7.3) — another frontend of this window saved it (each edit
				// buffer is its own, K7), or any other writer did.
				void this.editors.reloadIfClean(path);
				void this.editors.markSaveConflict(path);
			}
		} else {
			// The batch names only some of what changed (a checkout, a build): every clean tab
			// under that root re-reads its file, or a tab left behind shows the old contents
			// the moment it is switched to. reloadIfClean skips the ones that did not change;
			// the dirty ones fall to the conflict check.
			const root = change.root.replace(/[\\/]+$/, '').toLowerCase();
			for (const path of this.editors.openFilePaths()) {
				if (path.toLowerCase().startsWith(root)) {
					void this.editors.reloadIfClean(path);
					void this.editors.markSaveConflict(path);
				}
			}
		}
		this.scheduleRefresh(0);
	},

	recheckSwallowedBatch(): void {
		if (this.recheckInFlight) return;
		this.recheckInFlight = true;
		void this.scm
			.statusDiffers()
			.catch(() => true)
			.then((differs) => {
				this.recheckInFlight = false;
				if (differs) this.scheduleRefresh(0);
			});
	},

	scheduleRefresh(delay: number): void {
		// A hidden window's timers are throttled by the webview (to seconds, eventually to
		// a minute) — and the background window is exactly where external work happens: the
		// terminal commits, another editor saves, a build finishes. Hidden runs the refresh
		// on the microtask queue (never throttled), one burst coalesced into one refresh.
		if (document.hidden) {
			// A visible-path timer pending from before the window hid would fire a second
			// refresh on top of the one this path runs now.
			if (this.refreshTimer !== null) {
				window.clearTimeout(this.refreshTimer);
				this.refreshTimer = null;
			}
			if (this.hiddenRefreshQueued) return;
			this.hiddenRefreshQueued = true;
			queueMicrotask(() => {
				this.hiddenRefreshQueued = false;
				this.runScheduledRefresh();
			});
			return;
		}
		if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
		this.refreshTimer = window.setTimeout(() => {
			this.refreshTimer = null;
			this.runScheduledRefresh();
		}, delay);
	},

	runScheduledRefresh(): void {
		if (!this.repoPath) return;
		// While a sash drag is in progress, defer: refreshes mid-drag make the tree and
		// the editors churn under the pointer for no benefit. It re-fires after mouseup.
		// Hidden skips the deferral — the churn is invisible, and the deferral would
		// re-enter the microtask scheduler (scheduleRefresh's hidden path) in a cycle
		// that never yields to the event loop: a wedged queue, a dead window. A drag
		// whose mouseup was lost to the hiding window is exactly when the class sticks.
		if (!document.hidden && document.body.classList.contains('resizing')) {
			this.scheduleRefresh(200);
			return;
		}
		this.lastRefreshAt = performance.now();
		void this.scm.refresh(); // its repo_head feeds the status bar (see scm.onHead)
		void this.explorer.refresh();
		const active = this.editors.activeInput;
		if (active?.kind === 'file') void this.editors.reloadIfClean(active.path);
	},
};
