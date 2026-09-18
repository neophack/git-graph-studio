// Persisted app state (localStorage): the layout, the last/recent folders, the Git Graph view's
// per-repository state, its global/workspace view state, and the settings changed through its
// Settings Widget - the split the extension makes between webview state and extension state,
// with localStorage standing in for VS Code's Memento.

const PREFIX = 'ggstudio.';

export function load<T>(key: string, fallback: T): T {
	try {
		const raw = localStorage.getItem(PREFIX + key);
		return raw === null ? fallback : (JSON.parse(raw) as T);
	} catch {
		return fallback;
	}
}

export function save(key: string, value: unknown): void {
	try {
		localStorage.setItem(PREFIX + key, JSON.stringify(value));
	} catch {
		// Storage unavailable (private mode / quota): the state simply does not persist.
	}
}

export interface LayoutState {
	sidebarWidth: number;
	sidebarVisible: boolean;
	activeView: 'explorer' | 'search' | 'scm' | 'extensions' | 'analysis';
	panelHeight: number;
	panelVisible: boolean;
}

export const layout: LayoutState = {
	sidebarWidth: 300,
	sidebarVisible: true,
	activeView: 'explorer',
	panelHeight: 260,
	panelVisible: false,
	...load<Partial<LayoutState>>('layout', {})
};

export function saveLayout(): void {
	save('layout', layout);
}

/* ---------- Folders ---------- */

export function lastFolder(): string | null {
	return load<string | null>('lastFolder', null);
}

export function rememberFolder(path: string | null): void {
	save('lastFolder', path);
	if (path) {
		const recent = recentFolders().filter((p) => p !== path);
		recent.unshift(path);
		save('recentFolders', recent.slice(0, 10));
	}
}

export function recentFolders(): string[] {
	return load<string[]>('recentFolders', []);
}

export function forgetFolder(path: string): void {
	save('recentFolders', recentFolders().filter((p) => p !== path));
}

/* ---------- Workspace snapshots (what a relaunch restores) ---------- */

/** The part of a folder's session that comes back on the next open: the file tabs in order,
 *  which one was active, and the Explorer's expanded folders - VS Code's workspace storage,
 *  kept per folder path. */
/** The editor grid, serialised like VS Code's grid serializer: a split names its axis, its
 *  children's size shares and its children; a cell names the group (by index, in the same
 *  visual order as `groups`) that lives in it. Absent for a single-group layout and in
 *  sessions saved before the grid existed. */
export type EditorGridCell = { group: number } | { axis: 'x' | 'y'; sizes: number[]; children: EditorGridCell[] };

export interface WorkspaceSnapshot {
	openFiles: string[];
	activeFile: string | null;
	expanded: string[];
	/** The editor group layout (M3 3.1): the file tabs of each group, in visual order, and
	 *  which file was active in it. Absent in sessions saved before groups existed. */
	groups?: { files: string[]; active: string | null }[];
	/** The splits around those groups, so a 2x2 grid comes back as a 2x2 grid. */
	editorGrid?: EditorGridCell | null;
}

const SNAPSHOT_FOLDERS = 20;

export function workspaceSnapshot(folder: string): WorkspaceSnapshot | null {
	return load<Record<string, WorkspaceSnapshot>>('workspaces', {})[folder] ?? null;
}

/** Store a folder's snapshot; the least recently stored folders drop off past the cap. */
export function saveWorkspaceSnapshot(folder: string, snapshot: WorkspaceSnapshot): void {
	const all = load<Record<string, WorkspaceSnapshot>>('workspaces', {});
	delete all[folder];
	const entries = Object.entries(all).slice(-(SNAPSHOT_FOLDERS - 1));
	entries.push([folder, snapshot]);
	save('workspaces', Object.fromEntries(entries));
}

/* ---------- Git Graph view state ---------- */

/** The default per-repository state, the counterpart of `DEFAULT_REPO_STATE` in the extension. */
export function defaultRepoState(): Record<string, unknown> {
	return {
		cdvDivider: 0.5,
		cdvHeight: 250,
		columnWidths: null,
		commitOrdering: 'default',
		fileViewType: 0,
		gerritFetchRefs: false,
		gerritFetchLimit: null,
		gerritStatusFilter: { new: true, merged: false, abandoned: false, wip: false },
		hideRemotes: [],
		includeCommitsMentionedByReflogs: 0,
		issueLinkingConfig: null,
		lastImportAt: 0,
		name: null,
		onlyFollowFirstParent: 0,
		onRepoLoadShowCheckedOutBranch: 0,
		onRepoLoadShowSpecificBranches: null,
		pinnedBranches: [],
		pinnedCommits: [],
		pullRequestConfig: null,
		showRemoteBranches: true,
		showRemoteBranchesV2: 0,
		showStashes: 0,
		showTags: 0,
		workspaceFolderIndex: null
	};
}

export function repoState(repo: string): Record<string, unknown> {
	const all = load<Record<string, Record<string, unknown>>>('repoStates', {});
	return { ...defaultRepoState(), ...(all[repo] ?? {}) };
}

export function saveRepoState(repo: string, state: Record<string, unknown>): void {
	const all = load<Record<string, Record<string, unknown>>>('repoStates', {});
	all[repo] = state;
	save('repoStates', all);
}

export const GLOBAL_VIEW_STATE_DEFAULTS = { alwaysAcceptCheckoutCommit: false, issueLinkingConfig: null, pushTagSkipRemoteCheck: false };
export const WORKSPACE_VIEW_STATE_DEFAULTS = { findIsCaseSensitive: false, findIsRegex: false, findOpenCommitDetailsView: false };

export function globalViewState(): Record<string, unknown> {
	return { ...GLOBAL_VIEW_STATE_DEFAULTS, ...load<Record<string, unknown>>('globalViewState', {}) };
}

export function workspaceViewState(): Record<string, unknown> {
	return { ...WORKSPACE_VIEW_STATE_DEFAULTS, ...load<Record<string, unknown>>('workspaceViewState', {}) };
}

/** The `git-graph-rs.*` settings the view's Settings Widget wrote (key -> value). */
export function graphSettings(): Record<string, unknown> {
	return load<Record<string, unknown>>('settings', {});
}

export function saveGraphSetting(key: string, value: unknown): void {
	const settings = graphSettings();
	settings[key] = value;
	save('settings', settings);
}

/* ---------- Extension settings (what installed extensions wrote via update()) ---------- */

export function extSettings(extId: string): Record<string, unknown> {
	return load<Record<string, unknown>>(`extSettings.${extId}`, {});
}

export function saveExtSetting(extId: string, key: string, value: unknown): void {
	const settings = extSettings(extId);
	settings[key] = value;
	save(`extSettings.${extId}`, settings);
}

/* ---------- Code reviews (the Commit Details View's "mark as reviewed") ---------- */

export interface CodeReview {
	id: string;
	lastActive: number;
	lastViewedFile: string | null;
	remainingFiles: string[];
}

export function codeReview(repo: string, id: string): CodeReview | null {
	const reviews = load<Record<string, CodeReview>>('codeReviews', {});
	return reviews[repo + '|' + id] ?? null;
}

export function saveCodeReview(repo: string, review: CodeReview | null, id = review?.id ?? ''): void {
	const reviews = load<Record<string, CodeReview>>('codeReviews', {});
	const key = repo + '|' + id;
	if (review) reviews[key] = review;
	else delete reviews[key];
	save('codeReviews', reviews);
}
