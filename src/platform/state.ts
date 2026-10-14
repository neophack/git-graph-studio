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
	activeView: string;
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

/* ---------- Extension settings (what installed extensions wrote via update()) ---------- */

/** The event `saveExtSetting` dispatches on `document` (detail: the extension id), so the
 *  extension host can push the change into the extension's frame — the `onDidChangeConfiguration`
 *  half of the vscode API. */
export const EXT_SETTINGS_EVENT = 'ggs-ext-settings';

export function extSettings(extId: string): Record<string, unknown> {
	return load<Record<string, unknown>>(`extSettings.${extId}`, {});
}

export function saveExtSetting(extId: string, key: string, value: unknown): void {
	const settings = extSettings(extId);
	settings[key] = value;
	save(`extSettings.${extId}`, settings);
	document.dispatchEvent(new CustomEvent(EXT_SETTINGS_EVENT, { detail: extId }));
}

/* ---------- Extension mementos (ExtensionContext.globalState / workspaceState) ---------- */

/** The persisted memento of one extension and scope, as the activation context preloads and
 *  `state.update` writes through (VS Code keeps globalState machine-wide and workspaceState
 *  per-workspace; Studio persists both per install — one webview storage, one machine). */
export function extMemento(extId: string, scope: 'global' | 'workspace'): Record<string, unknown> {
	return load<Record<string, unknown>>(`extMemento.${scope}.${extId}`, {});
}

/** A null key writes the scope whole (the shape a self-contained page's flush sends — it owns
 *  the entire map); a named key writes or deletes that one entry, undefined deleting. */
export function saveExtMemento(extId: string, scope: 'global' | 'workspace', key: string | null, value: unknown): void {
	if (key === null) {
		save(`extMemento.${scope}.${extId}`, value && typeof value === 'object' ? value : {});
		return;
	}
	const values = extMemento(extId, scope);
	if (value === undefined) delete values[key];
	else values[key] = value;
	save(`extMemento.${scope}.${extId}`, values);
}


/* ---------- Extension secrets (ExtensionContext.secrets) ---------- */

/** One extension's stored secrets. Kept in the workbench's own storage, apart from its
 *  settings and mementos — not an OS keychain (the extension host log says so the first
 *  time an extension stores one). */
export function extSecrets(extId: string): Record<string, string> {
	return load<Record<string, string>>(`extSecrets.${extId}`, {});
}

/** Store (or, with undefined, delete) one secret. */
export function saveExtSecret(extId: string, key: string, value: string | undefined): void {
	const secrets = extSecrets(extId);
	if (value === undefined) delete secrets[key];
	else secrets[key] = value;
	save(`extSecrets.${extId}`, secrets);
}
