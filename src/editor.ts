// The editor group: a VS Code-style tab strip with breadcrumbs over a stack of editor panes.
// Three kinds of editor live here - text files (CodeMirror 6, with language support loaded on
// demand), diffs (CodeMirror's merge view over two revisions of a file), and the Git Graph
// view (an iframe the graph host owns) - plus the welcome page shown when nothing is open.

import type { Extension } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import type { MergeView } from '@codemirror/merge';
import { invoke } from '@tauri-apps/api/core';

import { hasBookmark, toggleBookmark } from './bookmarks';
import { loadAnalysisPages, loadCanViews, loadCallTree, loadFastView, loadFileHistory, loadFolderCompare, loadHexCompare, loadHexView, loadMerge, loadMergeEditor, loadSnippetRegistry, loadSymbolDbView, loadTextEditor } from './lazy';
// The hex and CAN views are async chunks (lazy.ts): a binary or a CAN trace is the exception
// among opens, and their code would otherwise ride in the first-paint bundle. The fast
// viewer, the folder-compare, merge-conflict, file-history and call-tree views and the
// workspace snippets are the same - each opens with its first use.
import type { FastView } from './fastView';
import type { HexView } from './hexView';
import type { HexCompareView } from './hexCompare';
import type { CanLogView } from './canLogView';
import type { CanRawView } from './canRawView';
import type { EditableDocView } from './docEditView';
import { imageMime, renderMarkdown } from './markdown';
import type { BlameLine, FileHistoryView } from './fileHistory';
import type * as TextEditor from './textEditor';
import type { CallTreeView, WsSymbol } from './callTree';
import { commands } from './commands';
import { menuSection } from './contributions';
import { CompareHost } from './graphHost';
import type { FolderCompareView } from './folderCompare';
import type { MergeToolbar } from './mergeEditor';
import { t } from './i18n';
import { SETTINGS_EVENT, settings } from './settings';
import { basename, dirname, el, icon, joinPath, notify, quickPick, relativeTo, showContextMenu, toPosix, type MenuEntry } from './ui';
import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager';

/** The text editor module once it has been loaded (`textEditor()`): CodeMirror lives in an
 *  async chunk, so the workbench paints without it and the first file open pays for it. The
 *  synchronous call sites (revealing a position, the Find command) only ever run against a
 *  view that exists, which means the module is loaded by then. */
let cm: typeof TextEditor | null = null;

async function textEditor(): Promise<typeof TextEditor> {
	return (cm ??= await loadTextEditor());
}

/** The Code Analysis tabs' labels and icons (module 17): English, like every tab label —
 *  the pages' own text goes through `t()`. */
const ANALYSIS_PAGE_LABELS: Record<import('./analysisTools').AnalysisToolId, string> = {
	callgraph: 'Call Graph',
	metrics: 'Complexity & Hotspots',
	deadcode: 'Dead Code',
	security: 'Security Scan',
	imports: 'Import Graph'
};
const ANALYSIS_PAGE_ICONS: Record<import('./analysisTools').AnalysisToolId, string> = {
	callgraph: 'graph',
	metrics: 'pulse',
	deadcode: 'circle-slash',
	security: 'shield',
	imports: 'type-hierarchy-sub'
};

/** The windowed editor module, loaded on the first large-file open (it drags CodeMirror in,
 *  so like the text editor it stays out of the first-paint bundle). */
let docEditModule: typeof import('./docEditView') | null = null;

async function loadDocEdit(): Promise<typeof import('./docEditView')> {
	return (docEditModule ??= await import('./docEditView'));
}

/** How long after the last keystroke an unsaved buffer is backed up for hot exit. */
const BACKUP_DELAY_MS = 500;
/** Backing a large document up means one whole-document `toString()` plus one whole-file
 *  IPC transfer; at typing cadence that is visible jank, so large documents back up on a
 *  slower clock (and still on save and close). */
const LARGE_BACKUP_DELAY_MS = 3000;
const LARGE_DOC_CHARS = 1024 * 1024;
/** Files past this size open in the windowed editable editor (`docEditView.ts`): the
 *  document lives in the backend's rope and the webview holds a window of lines, so editing
 *  a 100 MB log costs the same as editing a 10 KB one — with no upper size wall. Below it
 *  the full editor is snappier (its extras — minimap, folding, completion — all work).
 *  Minified files (few enormous lines) defeat the line window: a small one takes the full
 *  editor, a large one the read-only indexed view with its Edit button into the full
 *  editor. */
const WINDOWED_EDIT_BYTES = 8 * 1024 * 1024;
/** Past this the fast viewer's Edit button refuses the swap to the whole-file editor: that
 *  editor holds the file as one JavaScript string, and V8 strings cap at 2²⁹ − 24
 *  characters — a byte past this margin would make the decode throw instead of edit. */
const WHOLE_FILE_EDITOR_BYTES = 480 * 1024 * 1024;
/** How long after the last keystroke a Markdown preview follows its source. */
const PREVIEW_DELAY_MS = 300;

/** A symbol the backend's outline extraction found in a document. */
interface OutlineSymbol {
	kind: string;
	name: string;
	line: number;
}

/** The codicon VS Code's outline uses per symbol kind. */
const SYMBOL_ICONS: Record<string, string> = {
	function: 'symbol-method',
	method: 'symbol-method',
	class: 'symbol-class',
	struct: 'symbol-structure',
	interface: 'symbol-interface',
	enum: 'symbol-enum',
	module: 'symbol-module',
	type: 'symbol-parameter'
};

/** What `file_probe` learns from a file's first bytes, before its body is read. */
interface FileProbe {
	size: number;
	binary: boolean;
	/** The head shows minified-style unbroken runs: too few, too huge lines for the
	 *  line-windowed editor, which the open path then routes to the full editor. */
	longLines?: boolean;
}

interface FileContents {
	contents: string | null;
	binary: boolean;
	size: number;
	/** The encoding id the backend decoded the file with (`encodings()`), and its line endings. */
	encoding?: string;
	eol?: 'lf' | 'crlf';
}

/** Read a file's text over the raw IPC channel (`read_file_raw`). The JSON path re-escapes
 *  and re-copies the whole document on both sides of the bridge, which stalled the webview
 *  for seconds on large files; the raw payload is an 8-byte little-endian header length,
 *  the JSON metadata, then the UTF-8 text itself. */
async function readFileRaw(path: string, encoding?: string): Promise<FileContents> {
	const raw = await invoke<ArrayBuffer | Uint8Array>('read_file_raw', { path, encoding });
	const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
	const headerLen = Number(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(0, true));
	const meta = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + headerLen))) as Omit<FileContents, 'contents'>;
	const contents = meta.binary ? null : new TextDecoder().decode(bytes.subarray(8 + headerLen));
	return { ...meta, contents };
}

/** The encodings the status bar offers (mirrors `encoding::ENCODINGS`; the backend's list wins). */
export const ENCODING_LABELS: Record<string, string> = {
	utf8: 'UTF-8', utf8bom: 'UTF-8 with BOM', 'utf-16le': 'UTF-16 LE', 'utf-16be': 'UTF-16 BE',
	gb18030: 'GB18030 (GBK)', big5: 'Big5', shift_jis: 'Shift JIS', 'euc-kr': 'EUC-KR',
	'windows-1252': 'Western (Windows 1252)', 'iso-8859-1': 'Western (ISO 8859-1)'
};

/** One side of a diff: a file at a revision (`*` working tree, `:index` staged, `HEAD`, a hash…),
 *  or nothing (an added/deleted file's missing side). */
export interface DiffSide {
	revision: string;
	path: string;
	/** Shown in the header over the pane, e.g. "HEAD" or "Working Tree". */
	label: string;
	/** False when the file does not exist on this side. */
	exists: boolean;
	/** Set when `path` is an absolute filesystem path, not a repo-relative one at a revision -
	 *  a Beyond Compare-style compare of two files on disk reads it directly. */
	local?: boolean;
}

export type EditorInput =
	| { kind: 'file'; path: string }
	| { kind: 'diff'; id: string; title: string; repo?: string; left: DiffSide; right: DiffSide }
	| { kind: 'folders'; id: string; left: string; right: string }
	| { kind: 'calltree'; id: string; symbol: WsSymbol }
	| { kind: 'symboldb'; id: string }
	| { kind: 'analysis'; id: string; tool: import('./analysisTools').AnalysisToolId }
	| { kind: 'graph' }
	| { kind: 'help'; help: 'welcome' | 'shortcuts' }
	| { kind: 'markdown'; path: string }
	| { kind: 'history'; path: string }
| { kind: 'hex'; path: string }
	| { kind: 'canlog'; path: string }
	| { kind: 'compare'; id: string; title: string; fromHash: string; toHash: string; singleCommit: boolean; repo?: string };

export interface Editor {
	input: EditorInput;
	id: string;
	label: string;
	description?: string;
	iconClass?: string;
	iconSrc?: string;
	pane: HTMLElement;
	/** The symbol outline beside the editor, shown while the "show code outline" setting is on. */
	outline?: HTMLElement;
	view?: EditorView;
	merge?: MergeView;
	diffObserver?: ResizeObserver;
	compare?: CompareHost;
	folderCompare?: FolderCompareView;
	/** An address-aligned hex comparison of two binary files on disk. */
	hexCompare?: HexCompareView;
	callTree?: CallTreeView;
	symbolDatabase?: import('./symbolDbView').SymbolDatabaseView;
	/** A Code Analysis page (module 17) — the view the lazy analysisPages chunk mounts. */
	analysis?: import('./analysisPages').AnalysisPageView;
	mergeToolbar?: MergeToolbar;
	/** A preview's re-render (the Markdown preview follows its source). */
	render?: () => Promise<void>;
	/** Runs when the editor is closed, to release what it holds beyond its own DOM. */
	onClose?: () => void;
	/** The blame gutter is showing. */
	blame?: boolean;
	history?: FileHistoryView;
	/** A binary (or hex-opened) file's hex view, whose edits Ctrl+S writes back in place. */
	hex?: HexView;
	/** A CAN log (.blf / .asc) statistics view, filled when the backend's parse returns. */
	canlog?: CanLogView;
	/** A CAN log's raw frame view — the tab a .blf / .asc opens in, live while it parses. */
	canraw?: CanRawView;
	/** A large file's windowed editable editor — the document lives in the backend's rope
	 *  and only a window of lines is ever in the webview. */
	doc?: EditableDocView;
	/** An enormous file's read-only windowed viewer — past what an editable document can hold. */
	fast?: FastView;
	dirty: boolean;
	/** A file's encoding id and line endings: what it was read with, what a save writes back. */
	encoding?: string;
	eol?: 'lf' | 'crlf';
	languageName?: string;
}

/** One stop in the back/forward navigation history: an editor (by input, so a closed file can
 *  be reopened on the way back) at the position the cursor last had there. */
interface NavEntry {
	input: EditorInput;
	line: number;
	column: number;
}

/** The tab id a navigation entry's editor has while open. */
function inputId(input: EditorInput): string {
	switch (input.kind) {
		case 'file': return 'file:' + input.path;
		case 'diff': return 'diff:' + input.id;
		case 'folders': return 'folders:' + input.id;
		case 'symboldb': return input.id;
		case 'analysis': return 'analysis:' + input.tool;
		case 'calltree': return 'calltree:' + input.id;
		case 'compare': return 'compare:' + input.id;
		case 'graph': return 'graph';
		case 'help': return 'help:' + input.help;
		case 'markdown': return 'markdown:' + input.path;
		case 'history': return 'history:' + input.path;
		case 'hex': return 'hex:' + input.path;
		case 'canlog': return 'canlog:' + input.path;
	}
}

/** Below this width (px) a diff drops the side-by-side layout for a single-column inline view. */
const DIFF_SPLIT_MIN_WIDTH = 720;

/** Every open Markdown preview, across groups: a source's edits refresh its preview wherever
 *  the preview tab lives, and the scroll sync finds its pair without caring which group
 *  holds either side. */
const markdownPreviews = new Set<Editor>();
/** Resolves a file's open editor across every group; the editor area, which owns them, sets
 *  itself as the resolver - a preview split to its own group still follows edits to the
 *  source that stayed behind in the original one. */
export const fileEditorResolver: { find: ((path: string) => Editor | null) | null } = { find: null };
/** While one side of a preview pair is scrolled programmatically (until this timestamp), the
 *  other side ignores the scroll events that causes - without the lock, the two scroll
 *  listeners would bounce each other forever. */
const syncLocks = new Map<string, number>();

/** The px offset from a scroller's top a synced scroll lands its target line at. */
const SYNC_TOP_OFFSET = 4;

const CODE_EXTENSIONS = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'rs', 'py', 'go', 'java', 'c', 'cc', 'cpp', 'h', 'hpp', 'cs', 'rb', 'php', 'sh', 'bash', 'zsh', 'ps1', 'bat', 'cmd', 'html', 'htm', 'css', 'scss', 'less', 'vue', 'svelte', 'toml', 'yaml', 'yml', 'xml', 'sql', 'lua', 'kt', 'swift', 'dart', 'scala', 'clj', 'ex', 'exs', 'erl', 'hs', 'ml', 'r', 'jl', 'nim', 'zig', 'vb', 'pl', 'gradle', 'cmake', 'mk', 'dockerfile', 'tf', 'proto', 'graphql', 'wasm']);
const MEDIA_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'svg', 'webp', 'avif', 'mp3', 'wav', 'ogg', 'mp4', 'webm', 'mov']);
const ARCHIVE_EXTENSIONS = new Set(['zip', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'tar', 'jar', 'vsix']);
const BINARY_EXTENSIONS = new Set(['exe', 'dll', 'so', 'dylib', 'bin', 'o', 'a', 'lib', 'node', 'class', 'pyc', 'wasm']);

/** Tint colors for file icons, mirroring VS Code's Seti icon theme per extension. */
const FILE_ICON_COLORS: Record<string, string> = {
	ts: '#519aba', tsx: '#519aba', md: '#519aba', go: '#519aba', c: '#557c93', cc: '#519aba', cpp: '#519aba',
	h: '#a074c4', hpp: '#a074c4', cs: '#519aba', css: '#519aba', scss: '#cc3e44', less: '#519aba',
	js: '#cbcb41', jsx: '#cbcb41', mjs: '#cbcb41', cjs: '#cbcb41', json: '#cbcb41', jsonc: '#cbcb41',
	py: '#3572a5', rs: '#d5a374', java: '#cc3e44', rb: '#cc3e44', php: '#a074c4', swift: '#ff6f61',
	kt: '#a97bff', dart: '#00b4ab', scala: '#cc3e44', clj: '#63ed69', ex: '#a074c4', exs: '#a074c4',
	erl: '#a074c4', hs: '#a074c4', ml: '#a074c4', r: '#3572a5', jl: '#a074c4', nim: '#ffe95c', zig: '#f69a50',
	vb: '#519aba', pl: '#519aba', gradle: '#00b4ab', cmake: '#6d8086', mk: '#6d8086', makefile: '#6d8086',
	sh: '#89e051', bash: '#89e051', zsh: '#89e051', ps1: '#4e9fdd', bat: '#c9c9c9', cmd: '#c9c9c9',
	html: '#e37933', htm: '#e37933', vue: '#41b883', svelte: '#ff3e00', xml: '#e37933', graphql: '#e37933',
	toml: '#6d8086', yaml: '#a074c4', yml: '#a074c4', sql: '#f29e74', lua: '#519aba', proto: '#a074c4',
	tf: '#519aba', wasm: '#a074c4', svg: '#a074c4', pdf: '#cc3e44', dockerfile: '#38b3f0',
	png: '#a074c4', jpg: '#a074c4', jpeg: '#a074c4', gif: '#a074c4', bmp: '#a074c4', ico: '#a074c4',
	webp: '#a074c4', avif: '#a074c4', mp3: '#a074c4', wav: '#a074c4', ogg: '#a074c4',
	mp4: '#a074c4', webm: '#a074c4', mov: '#a074c4',
	zip: '#a074c4', gz: '#a074c4', tgz: '#a074c4', bz2: '#a074c4', xz: '#a074c4', '7z': '#a074c4',
	rar: '#a074c4', tar: '#a074c4', jar: '#a074c4', vsix: '#a074c4',
	exe: '#a074c4', dll: '#a074c4', so: '#a074c4', dylib: '#a074c4', bin: '#a074c4', o: '#a074c4',
	a: '#a074c4', lib: '#a074c4', node: '#89e051', class: '#cc3e44', pyc: '#519aba',
};

/** The Seti-theme tint for a file name, or undefined to keep the theme's neutral icon color. */
export function fileIconColor(name: string): string | undefined {
	const dot = name.lastIndexOf('.');
	const ext = dot === -1 ? name.toLowerCase() : name.slice(dot + 1).toLowerCase();
	return FILE_ICON_COLORS[ext];
}

/** A CAN trace (.blf / .asc), which opens in the raw frame view (`canRawView.ts`). */
export function isCanLog(name: string): boolean {
	const dot = name.lastIndexOf('.');
	const ext = dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
	return ext === 'blf' || ext === 'asc';
}

/** The codicon for a file name - the choice VS Code's generic (non-Seti) icon set makes. */
export function fileIcon(name: string): string {
	const dot = name.lastIndexOf('.');
	const ext = dot === -1 ? name.toLowerCase() : name.slice(dot + 1).toLowerCase();
	if (ext === 'md' || ext === 'markdown') return 'markdown';
	if (ext === 'json' || ext === 'jsonc') return 'json';
	if (ext === 'pdf') return 'file-pdf';
	if (MEDIA_EXTENSIONS.has(ext)) return 'file-media';
	if (ARCHIVE_EXTENSIONS.has(ext)) return 'file-zip';
	if (BINARY_EXTENSIONS.has(ext)) return 'file-binary';
	if (CODE_EXTENSIONS.has(ext) || name.toLowerCase() === 'makefile') return 'file-code';
	return 'file';
}

export class EditorGroup {
	private static nextId = 1;
	/** Identifies the group for tab drags between groups (M3 3.1). */
	readonly groupId = EditorGroup.nextId++;
	private readonly container: HTMLElement;
	private readonly tabs: HTMLElement;
	private readonly breadcrumbs: HTMLElement;
	private readonly editors: HTMLElement;
	private readonly welcome: HTMLElement;
	private readonly open: Editor[] = [];
	private active: Editor | null = null;
	/** Editors by last activation, most recent first: closing the active tab returns to the
	 *  one used before it (VS Code's `focusRecentEditorAfterClose`), not to its neighbour. */
	private readonly mru: Editor[] = [];
	private rootPath: string | null = null;
	private readonly navHistory: NavEntry[] = [];
	private navIndex = -1;
	/** True while a back/forward jump itself activates an editor: those moves walk the history
	 *  instead of extending it. */
	private navigating = false;
	/** The graph host hands over its frame element; the group only shows/hides it. */
	graphElement: HTMLElement | null = null;
	/** Whether an empty group shows the welcome page: the area keeps that to its first group,
	 *  so an empty split shows an empty editor (VS Code's behaviour), not a second welcome. */
	showWelcome = true;

	onActiveChange: ((editor: { kind: EditorInput['kind']; path?: string; languageName?: string; encoding?: string; eol?: 'lf' | 'crlf'; line: number; column: number; selected?: number; selections?: number } | null) => void) | null = null;
	onNavigationChange: (() => void) | null = null;
	/** The set or order of open tabs changed (an open, a close, a rename): the workbench snapshots it. */
	onTabsChange: (() => void) | null = null;
	onFileSaved: ((path: string) => void) | null = null;
	/** A windowed editor's save streamed a progress report (`null` clears it); the workbench
	 *  forwards this to the status bar's save item. */
	onSaveProgress: ((progress: { written: number; total: number } | null) => void) | null = null;
	/** Pending auto-save / backup timers per editor id. */
	private readonly autoSaveTimers = new Map<string, number>();
	private readonly backupTimers = new Map<string, number>();
	/** A merge conflict was resolved and staged; the workbench refreshes SCM and the graph. */
	onMergeResolved: (() => void) | null = null;
	/** A view with sync actions (the folder compare) changed files on disk. */
	onExternalFileChange: (() => void) | null = null;
	private welcomeRenderer: ((container: HTMLElement) => void) | null = null;
	/** Fills the welcome page. Assigning it re-renders: the workbench wires its renderer
	 *  after the group was constructed, and the freshly-built shell must not sit blank until
	 *  some later update happens to paint the welcome page. */
	set renderWelcome(renderer: ((container: HTMLElement) => void) | null) {
		this.welcomeRenderer = renderer;
		if (this.active === null) this.update();
	}
	get renderWelcome(): ((container: HTMLElement) => void) | null {
		return this.welcomeRenderer;
	}
	/** Fills a help page's pane (the welcome page, the keyboard shortcuts reference). */
	renderHelp: ((help: 'welcome' | 'shortcuts', container: HTMLElement) => void) | null = null;
	/** A tab was activated or the group was clicked: the editor area focuses it (M3 3.1). */
	onFocus: (() => void) | null = null;
	/** The tab strip's preview button was clicked: the editor area opens the preview beside
	 *  the group (a group cannot split itself). */
	onOpenPreviewToSide: ((path: string) => void) | null = null;

	/** Toggling the outline setting (Settings → Editor) shows or hides it on every open file;
	 *  the tab-size and word-wrap settings reconfigure the open editors in place. */
	private readonly onSettingsChange = (event: Event): void => {
		this.refreshOutlines();
		// The event's detail is the changed setting's key (a string).
		const key = (event as CustomEvent).detail;
		if (key !== 'tabSize' && key !== 'wordWrap' || !cm) return;
		for (const editor of this.open) {
			if (editor.view) cm.reconfigureEditorSettings(editor.view);
			if (editor.merge) {
				cm.reconfigureEditorSettings(editor.merge.a);
				cm.reconfigureEditorSettings(editor.merge.b);
			}
		}
	};

	constructor(container: HTMLElement) {
		this.container = container;
		container.classList.add('editor-group-container');
		// Any click inside the group makes it the focused one, before the click's own handling.
		container.addEventListener('mousedown', () => this.onFocus?.(), true);
		this.tabs = el('div', 'tabs-container');
		this.tabs.setAttribute('role', 'tablist');
		this.breadcrumbs = el('div', 'breadcrumbs');
		this.editors = el('div', 'editors');
		this.welcome = el('div', 'welcome');
		container.append(this.tabs, this.breadcrumbs, this.editors);
		this.editors.appendChild(this.welcome);
		this.tabs.addEventListener('wheel', (event) => {
			// A vertical wheel scrolls the strip horizontally, like VS Code.
			if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
				this.tabs.scrollLeft += event.deltaY;
				event.preventDefault();
			}
		}, { passive: false });
		document.addEventListener(SETTINGS_EVENT, this.onSettingsChange);
		this.update();
	}

	/** The editor area destroys a group when its layer collapses or the grid is rebuilt:
	 *  drop the document-level listener so a dead group stops reacting to settings changes. */
	dispose(): void {
		document.removeEventListener(SETTINGS_EVENT, this.onSettingsChange);
	}

	setRoot(rootPath: string | null): void {
		this.rootPath = rootPath;
		this.navHistory.length = 0;
		this.navIndex = -1;
		workspaceFileCache.clear();
		// The workspace's `*.code-snippets` join the completion's snippet set.
		void loadSnippetRegistry().then((snippets) => snippets.loadWorkspaceSnippets(rootPath));
		this.onNavigationChange?.();
		this.update();
	}

	get activeInput(): EditorInput | null {
		return this.active?.input ?? null;
	}

	/** The active text editor's CodeMirror view (a file or a read-only revision), if any. */
	get activeView(): EditorView | null {
		return this.active?.view ?? null;
	}

	/** The active text surface's CodeMirror view for seeding a search query (Zed's
	 *  `query_suggestion`): the text editor's own, or the windowed large-file editor's
	 *  loaded window — whichever text the user has in front of them. */
	get seedableView(): EditorView | null {
		return this.active?.view ?? this.active?.doc?.editorView ?? null;
	}

	openEditorIds(): string[] {
		return this.open.map((e) => e.id);
	}

	/** The open file tabs' paths, in tab order (what a relaunch reopens). */
	openFilePaths(): string[] {
		return this.open.flatMap((e) => (e.input.kind === 'file' ? [e.input.path] : []));
	}

	async saveAll(): Promise<void> {
		for (const editor of this.open) if (editor.dirty) await this.save(editor);
	}

	hasDirtyEditors(): boolean {
		return this.open.some((e) => e.dirty);
	}

	/* ---------- Opening ---------- */

	/** Opens a file, optionally placing the cursor at a line (1-based) and column - how
	 *  "Go to Definition" and the back/forward history land where they point. `inactive`
	 *  opens the tab without showing or focusing it (the session restore opens its files in
	 *  parallel this way and activates the remembered one afterwards).
	 *
	 *  Every text file opens directly in the editable CodeMirror editor; binary or unreadable
	 *  files fall back to the read-and-notice path. */
	async openFile(path: string, options: { line?: number; column?: number; inactive?: boolean } = {}): Promise<void> {
		const existing = this.open.find((e) => e.input.kind === 'file' && e.input.path === path);
		if (existing) {
			this.activate(existing);
			if (options.line !== undefined) {
				// A jump into a line of a CAN log (a search hit) lands in the text form — the
				// raw frame view has no text lines to reveal.
				if (existing.canraw) void this.swapCanRawToText(existing).then(() => this.revealIn(existing, options.line!, options.column ?? 1));
				else this.revealIn(existing, options.line, options.column ?? 1);
			}
			return;
		}
		const name = basename(path);
		const editor: Editor = {
			input: { kind: 'file', path },
			id: 'file:' + path,
			label: name,
			iconClass: fileIcon(name),
			pane: el('div', 'editor-pane'),
			dirty: false
		};
		// An image opens in the image preview rather than as bytes in a text editor.
		if (imageMime(name)) {
			await this.mountImagePreview(editor);
			this.add(editor, !options.inactive);
			return;
		}
		// A CAN trace (.blf / .asc) opens in the raw frame view: the backend parses in the
		// background while the viewport browses frames as they arrive. The statistics
		// analysis is a separate tab, opened from that view's Statistics button. A jump to a
		// text position (a search hit) opens the log's text form instead — that is where the
		// line exists.
		if (isCanLog(name)) {
			if (options.line !== undefined) {
				editor.languageName = 'Plain Text';
				editor.pane.classList.add('can-log');
				await this.mountCanTextForm(editor);
				this.add(editor, !options.inactive);
				if (options.inactive) return;
				this.revealIn(editor, options.line, options.column ?? 1);
				// The activation recorded the new editor at 1:1; note where it actually landed.
				if (this.navIndex >= 0 && this.navHistory[this.navIndex]!.input === editor.input) {
					this.navHistory[this.navIndex] = { input: editor.input, line: options.line, column: options.column ?? 1 };
				}
				return;
			}
			editor.languageName = 'CAN Log';
			editor.iconClass = 'pulse';
			const { CanRawView } = await loadCanViews();
			editor.canraw = new CanRawView(path, {
				onAnalyze: () => this.openCanStats(path),
				onEditText: () => void this.swapCanRawToText(editor)
			});
			editor.pane.classList.add('can-log');
			editor.pane.appendChild(editor.canraw.root);
			editor.onClose = () => editor.canraw?.dispose();
			this.add(editor, !options.inactive);
			return;
		}
		// One small probe (the size and a binary sniff of the first bytes) routes the open
		// before any byte of the body is read: a binary file goes straight to the hex viewer,
		// and only an enormous text file (past what an editable document can hold) to the
		// fast viewer - neither is ever read whole here.
		let probe: FileProbe | null = null;
		try {
			probe = await invoke<FileProbe>('file_probe', { path });
		} catch {
			probe = null; // `read_file` below reports the real error
		}
		if (probe?.binary) {
			await this.mountHexView(editor);
			this.add(editor, !options.inactive);
			return;
		}
		// A large text file edits in the windowed editor — no size wall: the document lives
		// in the backend's rope (built in parallel chunks however big the file is) and the
		// webview holds one window of lines. A minified file (few enormous lines that defeat
		// line windows) opens in the read-only fast viewer instead, as does any document the
		// rope backend refuses — both still offer the whole-file editor through the view's
		// Edit button, and only when every editable surface refuses does the plain
		// read-and-mount path below take over.
		if (probe !== null && probe.size > WINDOWED_EDIT_BYTES) {
			const offerWholeEditor = () => void this.swapFastToWholeEditor(editor);
			if (!probe.longLines && (await this.tryMountDocEdit(editor))) {
				this.add(editor, !options.inactive);
				if (options.inactive) return;
				if (options.line !== undefined) {
					this.revealIn(editor, options.line, options.column ?? 1);
					// The activation recorded the new editor at 1:1; note where it actually landed.
					if (this.navIndex >= 0 && this.navHistory[this.navIndex]!.input === editor.input) {
						this.navHistory[this.navIndex] = { input: editor.input, line: options.line, column: options.column ?? 1 };
					}
				}
				return;
			}
			if (await this.tryMountFastView(editor, editor.pane, true, offerWholeEditor)) {
				if (!probe.longLines) notify('info', t('viewer.readOnlyFallback') + basename(path));
				this.add(editor, !options.inactive);
				if (options.inactive) return;
				if (options.line !== undefined) this.revealIn(editor, options.line, options.column ?? 1);
				return;
			}
		}
		let file: FileContents;
		try {
			file = await readFileRaw(path);
		} catch (error) {
			notify('error', String(error));
			return;
		}
		if (file.binary || file.contents === null) {
			// A binary file opens in the hex viewer (M3 3.7) rather than only a notice.
			await this.mountHexView(editor);
		} else {
			editor.encoding = file.encoding ?? 'utf8';
			editor.eol = file.eol ?? 'lf';
			await this.mountTextEditor(editor, file.contents);
			this.attachMergeSupport(editor);
			this.updateOutline(editor);
		}
		this.add(editor, !options.inactive);
		if (options.inactive) return;
		if (options.line !== undefined) {
			this.revealIn(editor, options.line, options.column ?? 1);
			// The activation recorded the new editor at 1:1; note where it actually landed.
			if (this.navIndex >= 0 && this.navHistory[this.navIndex]!.input === editor.input) {
				this.navHistory[this.navIndex] = { input: editor.input, line: options.line, column: options.column ?? 1 };
			}
		}
	}

	/** Mount the fast viewer for a large text file. False when the backend refused it
	 *  (binary, unreadable) — the caller then falls back to its usual read-and-mount path.
	 *  `parent` defaults to the editor pane; the CAN text form passes its wrapper so the
	 *  Frames bar stays above the viewer. `onEdit`, when given, is the view's Edit button:
	 *  the one road out of the read-only view into the whole-file editor. */
	private async tryMountFastView(editor: Editor, parent: HTMLElement = editor.pane, indexed = false, onEdit?: () => void): Promise<boolean> {
		if (editor.input.kind !== 'file') return false;
		const { FastView } = await loadFastView();
		const view = new FastView(parent, onEdit ? { onEdit } : {});
		if (!(await view.openFile(editor.input.path, { indexed }))) {
			view.dispose();
			return false;
		}
		editor.fast = view;
		editor.languageName = view.languageName ?? undefined;
		return true;
	}

	/** Mount the windowed editable editor for a large text file. False when the backend
	 *  refused it — the caller falls back to the full read-and-mount path. */
	private async tryMountDocEdit(editor: Editor, parent: HTMLElement = editor.pane): Promise<boolean> {
		if (editor.input.kind !== 'file') return false;
		const { EditableDocView } = await loadDocEdit();
		const view = new EditableDocView(parent);
		if (!(await view.openFile(editor.input.path))) {
			view.dispose();
			return false;
		}
		view.onChanged = () => {
			if (!editor.dirty) {
				editor.dirty = true;
				this.renderTabs();
			}
			// Hot-exit backups are written backend-side by the view itself; only the
			// delayed auto-save rides through the group like any editor's.
			if (settings.autoSave === 'afterDelay') {
				const pending = this.autoSaveTimers.get(editor.id);
				if (pending !== undefined) window.clearTimeout(pending);
				this.autoSaveTimers.set(editor.id, window.setTimeout(() => {
					this.autoSaveTimers.delete(editor.id);
					void this.save(editor);
				}, Math.max(100, settings.autoSaveDelay)));
			}
		};
		view.onSaveRequest = () => void this.save(editor);
		view.onStatusChange = () => this.emitActive();
		view.onSaveProgress = (progress) => this.onSaveProgress?.(progress);
		editor.doc = view;
		editor.languageName = view.languageName ?? undefined;
		editor.onClose = () => editor.doc?.dispose();
		return true;
	}

	/** The indexed viewer's Edit button: the file crosses the IPC once and the whole-file
	 *  editor — the one surface a minified file's enormous lines edit in — takes the tab
	 *  over from the read-only view. Nothing is disposed until the read has landed, so a
	 *  refused or binary read keeps the view it has; past the JavaScript string ceiling the
	 *  swap is refused outright rather than letting the decode throw. */
	private async swapFastToWholeEditor(editor: Editor): Promise<void> {
		if (editor.input.kind !== 'file' || !editor.fast) return;
		const path = editor.input.path;
		try {
			const probe = await invoke<FileProbe>('file_probe', { path });
			if (probe.size > WHOLE_FILE_EDITOR_BYTES) {
				notify('info', t('viewer.tooLargeWholeFile') + basename(path));
				return;
			}
		} catch {
			// No verdict on the size: the read below answers with the real error.
		}
		let file: FileContents;
		try {
			file = await readFileRaw(path);
		} catch (error) {
			notify('error', String(error));
			return;
		}
		if (file.binary || file.contents === null) {
			// The file changed under the view (the probe saw text, this read does not).
			notify('info', t('viewer.readOnlyFallback') + basename(path));
			return;
		}
		const parent = editor.fast.root.parentElement ?? editor.pane;
		editor.fast.dispose();
		editor.fast = undefined;
		editor.encoding = file.encoding ?? 'utf8';
		editor.eol = file.eol ?? 'lf';
		await this.mountTextEditor(editor, file.contents, parent);
		this.attachMergeSupport(editor);
		this.updateOutline(editor);
		this.emitActive();
	}

	/** The raw view's Text button (or a jump to a text line, like a search hit): the same tab
	 *  becomes the log's plain text form, editable like any text file — large logs included,
	 *  which is the default rather than a read-only detour. Only a minified log (few enormous
	 *  lines) stays read-only in the fast viewer — its Edit button still swaps to the
	 *  whole-file editor — and a slim bar with the path and a Frames button switches the tab
	 *  back. */
	private async swapCanRawToText(editor: Editor): Promise<void> {
		if (editor.input.kind !== 'file' || !editor.canraw) return;
		editor.canraw.dispose();
		editor.canraw = undefined;
		editor.onClose = undefined;
		editor.pane.replaceChildren();
		await this.mountCanTextForm(editor);
		this.emitActive();
	}

	/** Mount a CAN log's plain text form into the editor's pane: the bar with the path and the
	 *  Frames button (which swaps back to the raw frame view), then the editable text editor —
	 *  a large log in the windowed editable editor whatever its size, and only a minified one
	 *  in the read-only fast viewer sharing the same wrapper so the bar stays above it. */
	private async mountCanTextForm(editor: Editor): Promise<void> {
		if (editor.input.kind !== 'file') return;
		const path = editor.input.path;
		const frames = el('button', 'button secondary can-frames', [icon('pulse'), ' Frames']);
		frames.title = 'Switch back to the CAN frame view';
		frames.addEventListener('click', () => void this.swapTextToCanRaw(editor));
		const pathChip = el('span', 'can-path', [path]);
		pathChip.title = path;
		const bar = el('div', 'hex-toolbar can-text-bar', [pathChip, el('span', 'hex-toolbar-sep'), frames]);
		// The bar and the editor share a wrapper: the fast viewer styles itself
		// `position: absolute; inset: 0`, which would otherwise cover the bar outright.
		const wrap = el('div', 'can-text-wrap', [bar]);
		editor.pane.append(wrap);
		let probe: FileProbe | null = null;
		try {
			probe = await invoke<FileProbe>('file_probe', { path });
		} catch {
			probe = null; // `read_file` below reports the real error
		}
		// A large log edits in the windowed editor whatever its size — no read-only wall.
		// A minified one (few enormous lines) or a document the rope backend refuses opens
		// in the indexed fast viewer instead, still offering the whole-file editor through
		// its Edit button.
		if (probe !== null && probe.size > WINDOWED_EDIT_BYTES) {
			if (!probe.longLines && (await this.tryMountDocEdit(editor, wrap))) return;
			if (await this.tryMountFastView(editor, wrap, true, () => void this.swapFastToWholeEditor(editor))) {
				if (!probe.longLines) notify('info', t('viewer.readOnlyFallback') + basename(path));
				return;
			}
		}
		let file: FileContents;
		try {
			file = await readFileRaw(path);
		} catch (error) {
			notify('error', String(error));
			return;
		}
		if (file.binary || file.contents === null) {
			// A binary "text form" (a .blf whose Raw button was pressed) is the hex viewer,
			// inside the wrapper so the path bar with the Frames button stays above it.
			await this.mountHexView(editor, wrap);
		} else {
			editor.encoding = file.encoding ?? 'utf8';
			editor.eol = file.eol ?? 'lf';
			await this.mountTextEditor(editor, file.contents, wrap);
			this.attachMergeSupport(editor);
			this.updateOutline(editor);
		}
	}

	/** The text form's Frames button: back to the raw frame view of the same tab. A dirty
	 * buffer is saved first — the frames re-parse the file on disk, so unsaved text would
	 * otherwise silently not be among them; a failed save (announced by `save` itself)
	 * keeps the text form. */
	private async swapTextToCanRaw(editor: Editor): Promise<void> {
		if (editor.input.kind !== 'file') return;
		if (editor.dirty) {
			await this.save(editor);
			if (!editor.dirty) await this.swapTextToCanRaw(editor);
			return;
		}
		const { CanRawView } = await loadCanViews();
		if (!this.open.includes(editor) || editor.canraw) return; // closed, or swapped meanwhile
		editor.view?.destroy();
		editor.view = undefined;
		editor.fast?.dispose();
		editor.fast = undefined;
		editor.doc?.dispose();
		editor.doc = undefined;
		// The text form of a binary log is the hex viewer (the Raw button's landing); its
		// observer and slab caches must go with the swap back.
		editor.hex?.destroy();
		editor.hex = undefined;
		editor.mergeToolbar = undefined;
		editor.outline?.remove();
		editor.outline = undefined;
		editor.pane.classList.remove('has-outline');
		editor.pane.replaceChildren();
		const path = editor.input.path;
		editor.languageName = 'CAN Log';
		editor.canraw = new CanRawView(path, {
			onAnalyze: () => this.openCanStats(path),
			onEditText: () => void this.swapCanRawToText(editor)
		});
		editor.pane.appendChild(editor.canraw.root);
		editor.onClose = () => editor.canraw?.dispose();
		this.emitActive();
	}

	/** Any file on demand as hex (File: Open in Hex Viewer) - text files included. */
	async openHex(path: string = this.activeInput?.kind === 'file' ? this.activeInput.path : ''): Promise<void> {
		if (!path) return;
		const id = 'hex:' + path;
		const existing = this.open.find((e) => e.id === id);
		if (existing) {
			this.activate(existing);
			return;
		}
		const editor: Editor = {
			input: { kind: 'hex', path },
			id,
			label: `Hex ${basename(path)}`,
			iconClass: 'file-binary',
			pane: el('div', 'editor-pane'),
			dirty: false
		};
		await this.mountHexView(editor);
		this.add(editor);
	}

	/** A CAN log's statistics analysis as its own tab (the raw view's Statistics button):
	 *  the whole-file walk runs on the backend's blocking pool, so the raw tab keeps
	 *  browsing while the numbers fill in here. One analysis tab per file — opening it
	 *  again just activates the existing one. */
	openCanStats(path: string): void {
		const id = 'canlog:' + path;
		const existing = this.open.find((e) => e.id === id);
		if (existing) {
			this.activate(existing);
			return;
		}
		const editor: Editor = {
			input: { kind: 'canlog', path },
			id,
			label: `Stats ${basename(path)}`,
			iconClass: 'pulse',
			pane: el('div', 'editor-pane can-log'),
			dirty: false
		};
		editor.pane.appendChild(el('div', 'can-loading', ['Loading…']));
		this.add(editor);
		// The view's chunk lands after the tab is up; a tab closed meanwhile gets no view.
		void loadCanViews().then(({ CanLogView }) => {
			if (!this.open.includes(editor)) return;
			editor.canlog = new CanLogView(path);
			editor.pane.replaceChildren(editor.canlog.root);
		});
	}

	/* ---------- Previews ---------- */

	/** A binary file's hex viewer: virtual-scrolling rows with byte search, read-only
	 *  until its Edit toggle is switched on; saving patches the changed bytes in place.
	 *  `parent` defaults to the editor's pane — the CAN text form passes its wrapper so the
	 *  path bar stays above the viewer (into the pane itself it would share space with the
	 *  wrapper and land mid-window). */
	private async mountHexView(editor: Editor, parent: HTMLElement = editor.pane): Promise<void> {
		if (editor.input.kind !== 'file' && editor.input.kind !== 'hex') return;
		editor.languageName = 'Hex';
		const { HexView } = await loadHexView();
		const view = new HexView(editor.input.path, {
			onDirtyChange: (dirty) => {
				editor.dirty = dirty;
				this.renderTabs();
			}
		});
		editor.hex = view;
		// The view's observer and slab caches outlive the tab unless they're released.
		editor.onClose = () => view.destroy();
		editor.pane.classList.add('binary-hex');
		parent.appendChild(view.root);
		await view.load();
	}

	/** VS Code's image preview: the image on a transparency checkerboard, zoom in / out /
	 *  fit / 1:1 in a toolbar, and its dimensions and size beneath. */
	private async mountImagePreview(editor: Editor): Promise<void> {
		if (editor.input.kind !== 'file') return;
		const path = editor.input.path;
		editor.languageName = 'Image';
		const image = el('img', 'image-preview-img');
		image.alt = editor.label;
		const status = el('div', 'image-preview-status', ['Loading…']);
		const stage = el('div', 'image-preview-stage', [image]);
		let zoom = 1;
		let fit = true;
		const apply = () => {
			image.style.width = fit ? '' : `${image.naturalWidth * zoom}px`;
			image.classList.toggle('fit', fit);
			zoomLabel.textContent = fit ? 'Fit' : `${Math.round(zoom * 100)}%`;
		};
		const zoomLabel = el('span', 'image-preview-zoom', ['Fit']);
		const button = (label: string, title: string, run: () => void) => {
			const b = el('button', 'button secondary', [label]);
			b.title = title;
			b.addEventListener('click', run);
			return b;
		};
		const toolbar = el('div', 'image-preview-toolbar', [
			button('−', 'Zoom Out', () => { fit = false; zoom = Math.max(0.1, zoom / 1.25); apply(); }),
			zoomLabel,
			button('+', 'Zoom In', () => { fit = false; zoom = Math.min(16, zoom * 1.25); apply(); }),
			button('1:1', 'Actual Size', () => { fit = false; zoom = 1; apply(); }),
			button('Fit', 'Fit to Window', () => { fit = true; apply(); })
		]);
		// The wheel zooms like a desktop image viewer: a notch up zooms in, down zooms out,
		// anchored on the pointer — the image fraction under the cursor stays under it. The
		// Ctrl wheel that would otherwise zoom the whole window is swallowed here too.
		stage.addEventListener('wheel', (e) => {
			if (!e.deltaY) return; // a purely horizontal wheel pans
			e.preventDefault();
			if (!image.naturalWidth) return; // not loaded yet — nothing to scale
			const before = image.getBoundingClientRect();
			const fx = before.width > 0 ? (e.clientX - before.left) / before.width : 0.5;
			const fy = before.height > 0 ? (e.clientY - before.top) / before.height : 0.5;
			// Leaving Fit starts from the fitted scale, so the first notch grows the image
			// as it is on screen rather than jumping to its natural size's zoom.
			if (fit && before.width > 0) zoom = before.width / image.naturalWidth;
			fit = false;
			zoom = e.deltaY < 0 ? Math.min(16, zoom * 1.25) : Math.max(0.1, zoom / 1.25);
			apply();
			const after = image.getBoundingClientRect();
			stage.scrollLeft += after.left + fx * after.width - e.clientX;
			stage.scrollTop += after.top + fy * after.height - e.clientY;
		}, { passive: false });
		editor.pane.classList.add('image-preview');
		editor.pane.append(toolbar, stage, status);
		try {
			const data = await invoke<string>('read_file_base64', { path });
			image.src = `data:${imageMime(editor.label)};base64,${data}`;
			const size = Math.round((data.length * 3) / 4);
			image.addEventListener('load', () => {
				status.textContent = `${image.naturalWidth}×${image.naturalHeight}  ${size < 1024 ? `${size} B` : size < 1024 * 1024 ? `${(size / 1024).toFixed(1)} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`}`;
				apply();
			});
			status.textContent = `${size < 1024 ? `${size} B` : `${(size / 1024).toFixed(1)} KB`}`;
		} catch (error) {
			status.textContent = String(error);
		}
	}

	/** The Markdown preview of a file (Ctrl+Shift+V, or beside its source through the editor
	 *  area's `openMarkdownPreviewToSide`), re-rendered as its editor is edited and after it
	 *  reloads from disk. The preview and the source scroll together: rendered blocks carry
	 *  their source line as `data-line`, and each side maps the other's top line onto itself. */
	async openMarkdownPreview(path: string = this.activeInput?.kind === 'file' ? this.activeInput.path : ''): Promise<void> {
		if (!path) return;
		const id = 'markdown:' + path;
		const existing = this.open.find((e) => e.id === id);
		if (existing) {
			this.activate(existing);
			return;
		}
		const editor: Editor = {
			input: { kind: 'markdown', path },
			id,
			label: `Preview ${basename(path)}`,
			iconClass: 'open-preview',
			pane: el('div', 'editor-pane markdown-preview'),
			dirty: false
		};
		editor.languageName = 'Markdown';
		const pane = editor.pane;
		const article = el('article', 'extension-doc markdown-preview-body');
		pane.appendChild(article);
		const lock = () => syncLocks.set(path, Date.now() + 120);
		const locked = () => (syncLocks.get(path) ?? 0) > Date.now();
		// The preview's own path, read live: a rename of the file retargets this tab.
		const currentPath = () => (editor.input.kind === 'markdown' ? editor.input.path : path);
		const findSource = () => fileEditorResolver.find?.(currentPath())
			?? this.open.find((e) => e.input.kind === 'file' && e.input.path === currentPath())
			?? null;
		const blocks = () => Array.from(article.querySelectorAll<HTMLElement>('[data-line]'));
		// Preview → source: the last rendered block at (or above) the pane's top edge names
		// the source line to bring up.
		pane.addEventListener('scroll', () => {
			if (locked()) return;
			const view = findSource()?.view;
			if (!view) return;
			const paneTop = pane.getBoundingClientRect().top;
			let line: number | null = null;
			for (const block of blocks()) {
				if (block.getBoundingClientRect().top - paneTop > SYNC_TOP_OFFSET) break;
				line = Number(block.dataset.line);
			}
			if (line === null || Number.isNaN(line)) return;
			// The rendered lines are the doc at the last render: edits since then (the
			// re-render is debounced) may have shortened it - clamp to what exists.
			const coords = view.coordsAtPos(view.state.doc.line(Math.min(line + 1, view.state.doc.lines)).from);
			if (!coords) return;
			lock();
			view.scrollDOM.scrollTop += coords.top - view.scrollDOM.getBoundingClientRect().top - SYNC_TOP_OFFSET;
		});
		// Source → preview: attached to whichever editor currently holds the file, so a source
		// opened after the preview (or re-opened after a close) is picked up on the next render.
		let detachSourceScroll: (() => void) | null = null;
		let attachedScroller: HTMLElement | null = null;
		const attachSource = (source: Editor) => {
			const view = source.view;
			if (!view || view.scrollDOM === attachedScroller) return;
			detachSourceScroll?.();
			const handler = () => {
				if (locked() || !article.isConnected) return;
				const block = view.lineBlockAtHeight(view.scrollDOM.scrollTop + SYNC_TOP_OFFSET);
				const line = view.state.doc.lineAt(block.from).number - 1;
				let target: HTMLElement | null = null;
				for (const candidate of blocks()) {
					if (Number(candidate.dataset.line) > line) break;
					target = candidate;
				}
				if (!target) return;
				lock();
				pane.scrollTop += target.getBoundingClientRect().top - pane.getBoundingClientRect().top - SYNC_TOP_OFFSET;
			};
			view.scrollDOM.addEventListener('scroll', handler);
			attachedScroller = view.scrollDOM;
			detachSourceScroll = () => {
				view.scrollDOM.removeEventListener('scroll', handler);
				attachedScroller = null;
				detachSourceScroll = null;
			};
		};
		editor.onClose = () => {
			detachSourceScroll?.();
			markdownPreviews.delete(editor);
			syncLocks.delete(path);
		};
		editor.render = async () => {
			const source = findSource();
			if (source) attachSource(source);
			let text: string;
			if (source?.view) {
				text = source.view.state.doc.toString();
			} else {
				try {
					const file = await readFileRaw(currentPath());
					text = file.contents ?? '';
				} catch (error) {
					article.textContent = String(error);
					return;
				}
			}
			const folder = currentPath().slice(0, Math.max(0, currentPath().length - basename(currentPath()).length - 1));
			const rendered = await renderMarkdown(text, article, async (relative) => {
				const mime = imageMime(relative);
				if (!mime) return null;
				// A markdown link is spelled with forward slashes; the file system path is the folder's.
				const full = joinPath(folder, folder.includes('\\') ? relative.replaceAll('/', '\\') : relative);
				return invoke<string>('read_file_base64', { path: full }).then((data) => `data:${mime};base64,${data}`, () => null);
			});
			if (!rendered) article.textContent = text;
		};
		await editor.render();
		markdownPreviews.add(editor);
		this.add(editor);
	}

	/** The file history tab of a file (Git: Open File History). */
	async openFileHistory(path: string = this.activeInput?.kind === 'file' ? this.activeInput.path : ''): Promise<void> {
		if (!path || !this.rootPath) return;
		const id = 'history:' + path;
		const existing = this.open.find((e) => e.id === id);
		if (existing) {
			this.activate(existing);
			return;
		}
		const { FileHistoryView } = await loadFileHistory();
		const editor: Editor = {
			input: { kind: 'history', path },
			id,
			label: `History ${basename(path)}`,
			iconClass: 'history',
			pane: el('div', 'editor-pane'),
			dirty: false
		};
		editor.history = new FileHistoryView(editor.pane, this.rootPath, relativeTo(this.rootPath, path));
		editor.history.onOpenDiff = (diff) => void this.openDiff({ kind: 'diff', ...diff });
		editor.history.onOpenRevision = (revision, relative, title) => void this.openRevision(revision, relative, title);
		this.add(editor);
	}

	/** Toggle the blame gutter of the active file (Git: Toggle Blame, Ctrl+K Ctrl+B). */
	async toggleBlame(): Promise<void> {
		const editor = this.active;
		if (!editor || editor.input.kind !== 'file' || !editor.view || !this.rootPath || !cm) return;
		if (editor.blame) {
			editor.view.dispatch({ effects: cm.blameSlot.reconfigure([]) });
			editor.blame = false;
			return;
		}
		let lines: BlameLine[];
		try {
			lines = await invoke<BlameLine[]>('scm_blame', { path: relativeTo(this.rootPath, editor.input.path) });
		} catch (error) {
			notify('error', `Blame failed: ${String(error)}`);
			return;
		}
		if (!editor.view || !Array.isArray(lines)) return;
		const { blameLabel } = await loadFileHistory();
		const now = Date.now();
		editor.view.dispatch({ effects: cm.blameSlot.reconfigure(cm.blameGutter(lines.map((line) => ({ label: blameLabel(line, now), title: `${line.hash.slice(0, 8)} ${line.summary}` })))) });
		editor.blame = true;
	}

	/** Every preview of `path` re-renders (the source was edited, saved or reloaded) - in any
	 *  group, so a preview split to the side follows its source across the split. */
	private refreshPreviews(path: string): void {
		for (const editor of markdownPreviews) {
			if (editor.input.kind !== 'markdown' || editor.input.path !== path) continue;
			const timer = this.previewTimers.get(editor.id);
			if (timer !== undefined) window.clearTimeout(timer);
			this.previewTimers.set(editor.id, window.setTimeout(() => {
				this.previewTimers.delete(editor.id);
				void editor.render?.();
			}, PREVIEW_DELAY_MS));
		}
	}

	private readonly previewTimers = new Map<string, number>();

	/* ---------- Symbol outline ---------- */

	/** Re-render the outline of every open file editor after the setting changed. */
	private refreshOutlines(): void {
		for (const editor of this.open) {
			if (editor.input.kind === 'file') this.updateOutline(editor);
		}
	}

	/** Show, refresh, or remove an editor's symbol outline. The symbols come from the backend's
	 *  viewer: the file is opened as a rope document, its outline is read, and the document is
	 *  released again - so no state is kept for a side pane. */
	private updateOutline(editor: Editor): void {
		editor.outline?.remove();
		editor.outline = undefined;
		editor.pane.classList.remove('has-outline');
		if (!settings.showOutline || editor.input.kind !== 'file') return;
		const path = editor.input.path;
		const pane = el('aside', 'editor-outline');
		pane.appendChild(el('div', 'editor-outline-title', [t('outline.title')]));
		pane.appendChild(el('div', 'editor-outline-empty'));
		editor.outline = pane;
		editor.pane.classList.add('has-outline');
		editor.pane.prepend(pane);
		void (async () => {
			let symbols: OutlineSymbol[];
			try {
				const info = await invoke<{ docId: number; symbols: OutlineSymbol[] }>('viewer_open', { path });
				symbols = info.symbols ?? [];
				await invoke('viewer_close', { docId: info.docId }).catch(() => undefined);
			} catch {
				symbols = [];
			}
			// The editor may have closed, or the setting been toggled again, meanwhile.
			if (editor.outline !== pane) return;
			if (symbols.length === 0) {
				pane.remove();
				editor.outline = undefined;
				editor.pane.classList.remove('has-outline');
				return;
			}
			pane.textContent = '';
			pane.appendChild(el('div', 'editor-outline-title', [t('outline.title')]));
			for (const symbol of symbols) {
				const item = el('div', 'editor-outline-item', [icon(SYMBOL_ICONS[symbol.kind] ?? 'symbol-method'), el('span', '', [symbol.name])]);
				item.title = `${symbol.name} — line ${symbol.line + 1}`;
				item.addEventListener('click', () => this.revealIn(editor, symbol.line + 1, 1));
				pane.appendChild(item);
			}
		})();
	}

	/** Reveal a 1-based line in whichever surface an editor currently shows. */
	private revealIn(editor: Editor, line: number, column: number): void {
		if (editor.fast) editor.fast.revealLine(line - 1);
		if (editor.doc) void editor.doc.revealLine(line - 1, column - 1);
		if (editor.view) this.revealPosition(editor.view, line, column);
	}

	/** After every edit: schedule the hot-exit backup (always) and, with auto-save on a delay,
	 *  the save itself. Both coalesce per editor, so a burst of typing costs one write. */
	private onEdited(editor: Editor): void {
		if (editor.input.kind !== 'file') return;
		const path = editor.input.path;
		this.refreshPreviews(path);
		const backup = this.backupTimers.get(editor.id);
		if (backup !== undefined) window.clearTimeout(backup);
		// Backing a large document up is one whole-document `toString()` plus one whole-file
		// transfer: at keystroke cadence that is visible jank, so large documents back up on
		// a slower clock (and still on save and on close).
		const large = (editor.view?.state.doc.length ?? 0) > LARGE_DOC_CHARS;
		this.backupTimers.set(editor.id, window.setTimeout(() => {
			this.backupTimers.delete(editor.id);
			if (!editor.dirty || !editor.view || editor.input.kind !== 'file') return;
			// The path is read when the timer fires, not when the edit was made: a rename
			// in between retargets the backup with the editor.
			void invoke('backup_write', { path: editor.input.path, contents: editor.view.state.doc.toString() }).catch(() => undefined);
		}, large ? LARGE_BACKUP_DELAY_MS : BACKUP_DELAY_MS));
		if (settings.autoSave === 'afterDelay') {
			const pending = this.autoSaveTimers.get(editor.id);
			if (pending !== undefined) window.clearTimeout(pending);
			this.autoSaveTimers.set(editor.id, window.setTimeout(() => {
				this.autoSaveTimers.delete(editor.id);
				void this.save(editor);
			}, Math.max(100, settings.autoSaveDelay)));
		}
	}

	/** The window lost focus: with auto-save on window change (or on focus change, which the
	 *  window's blur implies), every dirty file is saved. */
	onWindowBlur(): void {
		if (settings.autoSave === 'onFocusChange' || settings.autoSave === 'onWindowChange') void this.saveAll();
	}

	/** An editor's text lost the keyboard focus (another tab, the sidebar, the terminal): VS
	 *  Code's `onFocusChange` auto-save writes it then. */
	private onEditorBlur(editor: Editor): void {
		if (settings.autoSave === 'onFocusChange' && editor.dirty) void this.save(editor);
	}

	/** Recover an unsaved buffer of a previous session into its editor (dirty, as it was). */
	async restoreBackup(path: string, contents: string): Promise<boolean> {
		await this.openFile(path);
		const editor = this.open.find((e) => e.input.kind === 'file' && e.input.path === path);
		if (editor?.doc) {
			await editor.doc.replaceText(contents);
			editor.dirty = true;
			this.renderTabs();
			return true;
		}
		if (!editor?.view) return false;
		const current = editor.view.state.doc.toString();
		if (current !== contents) editor.view.dispatch({ changes: { from: 0, to: current.length, insert: contents } });
		editor.dirty = true;
		this.renderTabs();
		return true;
	}

	/** Reopen the active file decoding its bytes as `encoding` (the status bar's "Reopen with
	 *  Encoding"); unsaved changes are saved or dropped after confirmation, as VS Code does. */
	async reopenWithEncoding(encoding: string): Promise<void> {
		const editor = this.active;
		if (!editor || editor.input.kind !== 'file' || !editor.view) return;
		if (editor.dirty) {
			const choice = await askToSave(editor.label);
			if (choice === 'cancel') return;
			if (choice === 'save') {
				await this.save(editor);
				if (editor.dirty) return; // the save failed and was reported
			}
		}
		let file: FileContents;
		try {
			file = await readFileRaw(editor.input.path, encoding);
		} catch (error) {
			notify('error', String(error));
			return;
		}
		if (file.contents === null) return;
		// The read was async: bail when the tab closed or its view was rebuilt meanwhile,
		// so the redecode cannot wipe what is on screen now.
		const view = editor.view;
		if (!view || editor.view !== view || !this.open.includes(editor)) return;
		cm?.replaceDocument(view, file.contents);
		editor.dirty = false;
		editor.encoding = file.encoding ?? encoding;
		editor.eol = file.eol ?? editor.eol;
		this.forgetBackup(editor);
		this.renderTabs();
		this.emitActive();
	}

	/** Save the active file in another encoding from now on ("Save with Encoding"). */
	async saveWithEncoding(encoding: string): Promise<void> {
		const editor = this.active;
		if (!editor || editor.input.kind !== 'file' || !editor.view) return;
		editor.encoding = encoding;
		editor.dirty = true;
		await this.save(editor);
		this.emitActive();
	}

	/** Switch the active file's line endings; the change is written on the next save. */
	setEol(eol: 'lf' | 'crlf'): void {
		const editor = this.active;
		if (!editor || editor.input.kind !== 'file' || !editor.view || editor.eol === eol) return;
		editor.eol = eol;
		editor.dirty = true;
		this.renderTabs();
		this.onEdited(editor);
		this.emitActive();
	}

	/** Run one of the editing commands the Edit menu offers on the active text view. */
	runEditorCommand(command: 'undo' | 'redo' | 'selectAll' | 'find' | 'replace' | 'toggleLineComment' | 'toggleBlockComment'): void {
		// A windowed editor keeps its undo stack in the backend's document; the rest run on
		// its small window view.
		if (this.active?.doc) {
			if (command === 'undo') void this.active.doc.undo();
			else if (command === 'redo') void this.active.doc.redo();
			else if (command === 'find') this.active.doc.openFind();
			else if (command === 'replace') this.active.doc.openReplace();
			else if (command === 'toggleLineComment') this.active.doc.toggleComment('line');
			else if (command === 'toggleBlockComment') this.active.doc.toggleComment('block');
			else this.active.doc.selectAll();
			return;
		}
		// A fast-view tab has no editor at all — find still serves its read-only rope.
		if (this.active?.fast) {
			if (command === 'find') this.active.fast.openFind();
			return;
		}
		const view = this.activeView;
		if (!view || !cm) return;
		const path = this.active?.input.kind === 'file' ? this.active.input.path : this.active?.label ?? '';
		if (command === 'find') cm.openSearchPanel(view);
		else if (command === 'replace') cm.openReplacePanel(view);
		else if (command === 'toggleLineComment') void import('./comments').then(({ toggleLineComment }) => toggleLineComment(view, path));
		else if (command === 'toggleBlockComment') void import('./comments').then(({ toggleBlockComment }) => toggleBlockComment(view, path));
		else cm[command](view);
	}

	/** Build the CodeMirror editor for a file pane (the fallback open path and edit mode).
	 *  `parent` defaults to the editor pane; the CAN text form passes its wrapper so the
	 *  Frames bar stays above the editor. */
	private async mountTextEditor(editor: Editor, contents: string, parent: HTMLElement = editor.pane): Promise<void> {
		const { EditorView, EditorState, baseExtensions, completionExtension, bookmarkGutter, languageSlot, blameSlot, keymap, loadLanguage } = await textEditor();
		editor.languageName = 'Plain Text';
		editor.view = new EditorView({
			state: EditorState.create({
				doc: contents,
				extensions: [
					...baseExtensions(false, editor.input.kind === 'file' ? editor.input.path : editor.label),
					...completionExtension(editor.input.kind === 'file' ? editor.input.path : editor.label),
					bookmarkGutter(editor.input.kind === 'file' ? editor.input.path : ''),
					languageSlot.of([]),
					blameSlot.of([]),
					keymap.of([
					{ key: 'Mod-s', preventDefault: true, run: () => (void this.save(editor), true) }
				]),
					EditorView.domEventHandlers({ blur: () => this.onEditorBlur(editor) }),
					EditorView.updateListener.of((update) => {
						if (update.docChanged && !editor.dirty) {
							editor.dirty = true;
							this.renderTabs();
						}
						if (update.docChanged) {
							editor.mergeToolbar?.update();
							this.onEdited(editor);
						}
						if (update.selectionSet || update.docChanged) this.emitActive();
					})
				]
			}),
			parent
		});
		// The language loads asynchronously: by the time it arrives the editor may have been
		// remounted (a reopen with encoding rebuilds the view), so reconfigure the view that
		// was built here, and only while it is still the editor's current one.
		const view = editor.view;
		void loadLanguage(editor.label).then((language) => {
			if (!language || editor.view !== view) return;
			editor.languageName = language.name;
			view.dispatch({ effects: languageSlot.reconfigure(language.support) });
			this.emitActive();
		});
		this.attachTextServices(editor);
	}

	/** A diff of two revisions of a file, as the SCM view and the Git Graph view request them. */
	async openDiff(input: Extract<EditorInput, { kind: 'diff' }>): Promise<void> {
		const existing = this.open.find((e) => e.input.kind === 'diff' && e.input.id === input.id);
		if (existing) {
			this.activate(existing);
			return;
		}
		// Two files on disk route through a cheap probe first: a binary on either side opens
		// the hex comparison, so a multi-gigabyte pair is never read whole only to be
		// refused as text.
		if (input.left.local && input.right.local) {
			const binary = (path: string) => invoke<FileProbe>('file_probe', { path }).then((probe) => probe.binary).catch(() => false);
			const [leftBinary, rightBinary] = await Promise.all([binary(input.left.path), binary(input.right.path)]);
			if (leftBinary || rightBinary) {
				await this.openHexCompare(input);
				return;
			}
		}
		const read = async (side: DiffSide): Promise<FileContents> => {
			if (!side.exists) return { contents: '', binary: false, size: 0 };
			if (side.local) return readFileRaw(side.path);
			try {
				return await invoke<FileContents>('read_file_at', { revision: side.revision, path: side.path, repo: input.repo });
			} catch (error) {
				// A file missing on one side (deleted / added between the revisions) shows empty.
				if (/not in|not found|no such|does not exist|cannot find/i.test(String(error))) return { contents: '', binary: false, size: 0 };
				throw error;
			}
		};
		let left: FileContents, right: FileContents;
		try {
			[left, right] = await Promise.all([read(input.left), read(input.right)]);
		} catch (error) {
			notify('error', String(error));
			return;
		}
		const name = basename(input.right.path || input.left.path);
		const editor: Editor = {
			input,
			id: 'diff:' + input.id,
			label: input.title,
			iconClass: 'diff',
			pane: el('div', 'editor-pane'),
			dirty: false
		};
		// The diff's ignore options: both texts are normalised before they reach the merge
		// view, and a toggle rebuilds it (the views are cheap to rebuild).
		const ignore = { whitespace: false, case: false };
		const normalize = (text: string): string => {
			let out = text.replace(/\r\n?/g, '\n');
			if (ignore.whitespace) out = out.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).join('\n');
			if (ignore.case) out = out.toLowerCase();
			return out;
		};
		const toolbar = el('div', 'diff-toolbar');
		let lastSplit = true;
		let rebuild: ((split: boolean) => void) | null = null;
		/** Xcode's version editor keeps its change navigation beside the ignore options: the
		 *  prev/next arrows, the "n of m changes" counter, the +A/−D statistics, and a manual
		 *  layout switch. `manualSplit` (undefined = follow the pane width) persists per tab
		 *  for the diff's lifetime. */
		let manualSplit: boolean | undefined;
		const counter = el('span', 'diff-count');
		/** Set once the diff's views exist (the text-diff branch below). */
		let stepChange: (direction: 1 | -1) => void = () => undefined;
		const stats = el('span', 'diff-stats');
		const navButton = (iconName: string, title: string, direction: 1 | -1) => {
			const button = el('button', 'action-btn', [icon(iconName)]);
			button.title = title;
			button.addEventListener('click', () => stepChange(direction));
			toolbar.appendChild(button);
			return button;
		};
		navButton('arrow-up', 'Previous Change', -1);
		navButton('arrow-down', 'Next Change', 1);
		toolbar.appendChild(counter);
		const layoutButton = el('button', 'action-btn toggle', [icon('split-horizontal')]);
		layoutButton.title = 'Switch between side-by-side and inline (follows the pane width until set)';
		layoutButton.addEventListener('click', () => {
			manualSplit = !lastSplit;
			rebuild?.(manualSplit);
		});
		toolbar.appendChild(layoutButton);
		const toggle = (label: string, key: 'whitespace' | 'case') => {
			const button = el('button', 'action-btn toggle' + (ignore[key] ? ' active' : ''), [label]);
			button.title = label === 'Aa' ? 'Ignore case' : 'Ignore whitespace';
			button.addEventListener('click', () => {
				ignore[key] = !ignore[key];
				button.classList.toggle('active', ignore[key]);
				rebuild?.(lastSplit);
			});
			toolbar.appendChild(button);
		};
		toggle('Wh', 'whitespace');
		toggle('Aa', 'case');
		// A local-file compare labels its sides with the full paths; "C:\a.txt (C:\a.txt)" would
		// just repeat itself, so a label that equals the path shows the path alone.
		const sideText = (side: DiffSide): string => side.label === side.path ? side.path : `${side.path} (${side.label})`;
		editor.pane.appendChild(el('div', 'diff-header', [
			el('span', '', [sideText(input.left)]),
			el('span', '', [sideText(input.right)]),
			toolbar,
			stats
		]));
		if (left.binary || right.binary) {
			editor.pane.appendChild(notice('file-binary', 'The file is binary: its two versions cannot be compared as text.'));
		} else {
			editor.languageName = 'Plain Text';
			const host = el('div', 'cm-merge-view');
			editor.pane.appendChild(host);
			// The text editor and the merge views are async chunks, loaded with the first diff.
			const [{ EditorView, EditorState, baseExtensions, keymap, languageSlot, loadLanguage }, { Chunk, MergeView, goToNextChunk, goToPreviousChunk, unifiedMergeView }] = await Promise.all([textEditor(), loadMerge()]);
			// The language support, once loaded, so that a layout switch rebuilds an already
			// highlighted view instead of dropping back to Plain Text until the next open.
			let languageSupport: Extension | null = null;
			/** The change navigation's state: the hunks, which one the cursor is in, and the
			 *  +added/−deleted line statistics the header badge shows. Recomputed per render -
			 *  both layouts expose their chunks (the merge view directly, the unified view via
			 *  a build over its two texts). */
			let chunks: readonly InstanceType<typeof Chunk>[] = [];
			const at = (): number => {
				const view = editor.view ?? editor.merge?.b ?? null;
				if (!view) return 0;
				const head = view.state.selection.main.head;
				let index = 0;
				for (const chunk of chunks) {
					if (chunk.fromB > head) break;
					index++;
				}
				return Math.min(index, chunks.length);
			};
			const refreshChangeInfo = (): void => {
				const aDoc = EditorState.create({ doc: normalize(left.contents ?? '') }).doc;
				const bDoc = editor.view?.state.doc ?? editor.merge?.b.state.doc ?? EditorState.create({ doc: normalize(right.contents ?? '') }).doc;
				chunks = editor.merge?.chunks ?? Chunk.build(aDoc, bDoc);
				let additions = 0;
				let deletions = 0;
				for (const chunk of chunks) {
					for (const change of chunk.changes) {
						if (change.toA > change.fromA) deletions += aDoc.lineAt(chunk.fromA + change.toA - 1).number - aDoc.lineAt(chunk.fromA + change.fromA).number + 1;
						if (change.toB > change.fromB) additions += bDoc.lineAt(chunk.fromB + change.toB - 1).number - bDoc.lineAt(chunk.fromB + change.fromB).number + 1;
					}
				}
				stats.innerHTML = '';
				if (chunks.length > 0) {
					const added = el('span', 'added', [`+${additions}`]);
					const removed = el('span', 'deleted', [`\u2212${deletions}`]);
					stats.append(added, removed, `${chunks.length} change${chunks.length === 1 ? '' : 's'}`);
					stats.title = `${additions} added, ${deletions} deleted lines across ${chunks.length} changes`;
				} else {
					stats.textContent = 'No changes';
					stats.title = 'The two sides are identical';
				}
				updateCounter();
			};
			const updateCounter = (): void => {
				if (chunks.length === 0) {
					counter.textContent = '';
					return;
				}
				counter.textContent = `${Math.min(at() + 1, chunks.length)} / ${chunks.length}`;
			};
			/** Jump to the previous/next change (Xcode's version editor arrows). */
			stepChange = (direction: 1 | -1): void => {
				const view = editor.view ?? editor.merge?.b ?? null;
				if (!view || chunks.length === 0) return;
				const command = direction === 1 ? goToNextChunk : goToPreviousChunk;
				command(view);
				// The command moves the selection; scroll it in and refresh the counter.
				view.dispatch({ effects: EditorView.scrollIntoView(view.state.selection.main.head, { y: 'center' }) });
				updateCounter();
			};
			// VS Code's diff-editor keys: F7 / Shift+F7 step through the changes.
			const diffKeys = keymap.of([{ key: 'F7', run: () => (stepChange(1), true), shift: () => (stepChange(-1), true) }]);
			// Wide panes get the classic side-by-side view; narrow ones a single-column inline
			// view - unless the layout button pinned one. A ResizeObserver rebuilds the editors
			// whenever the pane crosses the threshold.
			const render = (split: boolean) => {
				lastSplit = split;
				editor.merge?.destroy();
				editor.merge = undefined;
				editor.view?.destroy();
				editor.view = undefined;
				host.textContent = '';
				editor.pane.classList.toggle('diff-inline', !split);
				if (split) {
					editor.merge = new MergeView({
						a: { doc: normalize(left.contents ?? ''), extensions: [...baseExtensions(true), languageSlot.of(languageSupport ?? []), diffKeys, EditorView.updateListener.of(() => updateCounter())] },
						b: { doc: normalize(right.contents ?? ''), extensions: [...baseExtensions(true), languageSlot.of(languageSupport ?? []), diffKeys, EditorView.updateListener.of(() => updateCounter())] },
						parent: host,
						collapseUnchanged: { margin: 3, minSize: 4 },
						highlightChanges: true,
						gutter: true
					});
				} else {
					editor.view = new EditorView({
						state: EditorState.create({
							doc: normalize(right.contents ?? ''),
							extensions: [
								...baseExtensions(true),
								languageSlot.of(languageSupport ?? []),
								diffKeys,
								EditorView.updateListener.of(() => updateCounter()),
								unifiedMergeView({
									original: normalize(left.contents ?? ''),
									collapseUnchanged: { margin: 3, minSize: 4 },
									highlightChanges: true,
									gutter: true,
									mergeControls: false
								})
							]
						}),
						parent: host
					});
				}
				refreshChangeInfo();
			};
			rebuild = render;
			let split: boolean | undefined;
			// The first render waits one frame for the pane to be mounted and measurable: the
			// naive build-then-flip cost a full editor construction twice on narrow panes.
			requestAnimationFrame(() => {
				// Dropped as a parallel-open duplicate (or already rendered): nothing to build.
				if (!this.open.includes(editor) || editor.view !== undefined || editor.merge !== undefined) return;
				split = manualSplit ?? (host.clientWidth >= DIFF_SPLIT_MIN_WIDTH || host.clientWidth === 0);
				lastSplit = split;
				render(split);
			});
			editor.diffObserver = new ResizeObserver(() => {
				// A pinned layout stays; the pane width only rules until the user chooses.
				if (manualSplit !== undefined) return;
				const want = host.clientWidth >= DIFF_SPLIT_MIN_WIDTH;
				if (want !== split) {
					split = want;
					lastSplit = want;
					render(want);
				}
			});
			editor.diffObserver.observe(host);
			void loadLanguage(name).then((language) => {
				if (!language) return;
				languageSupport = language.support;
				editor.languageName = language.name;
				const effect = languageSlot.reconfigure(language.support);
				if (editor.merge) {
					editor.merge.a.dispatch({ effects: effect });
					editor.merge.b.dispatch({ effects: effect });
				}
				if (editor.view) editor.view.dispatch({ effects: effect });
				this.emitActive();
			});
		}
		this.add(editor);
	}

	/** The hex comparison of two files on disk, asked for as hex (the CLI's `ggs hex-compare`):
	 *  the same tab the binary pair of "Compare Two Files" opens, without the text probe that
	 *  would route text files to a text diff. */
	async openLocalHexCompare(left: string, right: string): Promise<void> {
		const input: Extract<EditorInput, { kind: 'diff' }> = {
			kind: 'diff',
			id: `paths:${left}::${right}`,
			title: `${basename(left)} ↔ ${basename(right)}`,
			left: { revision: '*', path: left, label: left, exists: true, local: true },
			right: { revision: '*', path: right, label: right, exists: true, local: true }
		};
		const existing = this.open.find((e) => e.input.kind === 'diff' && e.input.id === input.id);
		if (existing) {
			this.activate(existing);
			return;
		}
		await this.openHexCompare(input);
	}

	/** Two binary files on disk: the address-aligned hex comparison, streamed in chunks so
	 *  the pair's size never matters. */
	private async openHexCompare(input: Extract<EditorInput, { kind: 'diff' }>): Promise<void> {
		const editor: Editor = {
			input,
			id: 'diff:' + input.id,
			label: input.title,
			iconClass: 'file-binary',
			pane: el('div', 'editor-pane binary-hex'),
			dirty: false
		};
		const { HexCompareView } = await loadHexCompare();
		const view = new HexCompareView(input.left.path, input.right.path, { left: input.left.path, right: input.right.path });
		editor.hexCompare = view;
		editor.pane.appendChild(view.root);
		editor.onClose = () => view.destroy();
		this.add(editor);
		void view.load().then(() => view.scan());
	}

	/** A file as it was at a revision, read-only (the graph's "View File at this Revision"). */
	async openRevision(revision: string, path: string, title: string, repo?: string): Promise<void> {
		const id = `rev:${revision}:${path}`;
		// The tab id matches what `inputId` computes for the input (a revision shows as a
		// read-only diff-kind editor), or back/forward could never find the open tab.
		const existing = this.open.find((e) => e.id === 'diff:' + id);
		if (existing) {
			this.activate(existing);
			return;
		}
		let file: FileContents;
		try {
			file = await invoke<FileContents>('read_file_at', { revision, path, repo });
		} catch (error) {
			notify('error', String(error));
			return;
		}
		const name = basename(path);
		const editor: Editor = {
			input: { kind: 'diff', id, title, left: { revision, path, label: revision, exists: true }, right: { revision, path, label: revision, exists: true } },
			id: 'diff:' + id,
			label: title,
			iconClass: fileIcon(name),
			pane: el('div', 'editor-pane'),
			dirty: false
		};
		if (file.binary || file.contents === null) {
			editor.pane.appendChild(notice('file-binary', 'The file is binary and cannot be shown in the text editor.'));
		} else {
			const { EditorView, EditorState, baseExtensions, languageSlot, loadLanguage } = await textEditor();
			editor.languageName = 'Plain Text';
			editor.view = new EditorView({
				state: EditorState.create({
					doc: file.contents,
					extensions: [
						...baseExtensions(true),
						languageSlot.of([]),
						EditorView.updateListener.of((update) => {
							if (update.selectionSet) this.emitActive();
						})
					]
				}),
				parent: editor.pane
			});
			void loadLanguage(name).then((language) => {
				if (!language || editor.view === undefined) return;
				editor.languageName = language.name;
				editor.view.dispatch({ effects: languageSlot.reconfigure(language.support) });
				this.emitActive();
			});
			this.attachTextServices(editor);
		}
		this.add(editor);
	}

	/** The Git Graph tab: the host's frame, shown as a pinned-looking editor. */
	openGraph(): void {
		const existing = this.open.find((e) => e.input.kind === 'graph');
		if (existing) {
			this.activate(existing);
			return;
		}
		if (!this.graphElement) return;
		const editor: Editor = {
			input: { kind: 'graph' },
			id: 'graph',
			label: 'Git Graph',
			iconSrc: '/icons/git-graph.svg',
			pane: el('div', 'editor-pane'),
			dirty: false
		};
		editor.pane.appendChild(this.graphElement);
		this.add(editor);
	}

	/** A help page as an editor tab: the Welcome page or the Keyboard Shortcuts reference. */
	openHelp(help: 'welcome' | 'shortcuts'): void {
		const id = 'help:' + help;
		const existing = this.open.find((e) => e.id === id);
		if (existing) {
			this.activate(existing);
			return;
		}
		const editor: Editor = {
			input: { kind: 'help', help },
			id,
			label: help === 'welcome' ? 'Welcome' : 'Keyboard Shortcuts',
			iconClass: help === 'welcome' ? 'book' : 'keyboard',
			pane: el('div', 'editor-pane'),
			dirty: false
		};
		const page = el('div', 'welcome');
		editor.pane.appendChild(page);
		this.renderHelp?.(help, page);
		this.add(editor);
	}

	isGraphOpen(): boolean {
		return this.open.some((e) => e.input.kind === 'graph');
	}

	/** A Commit Comparison tab: the changes of one commit ("Open Changes") or between two of
	 *  them, as the graph's context menu and the commit details request it. */
	openCompare(input: Extract<EditorInput, { kind: 'compare' }>): void {
		const existing = this.open.find((e) => e.input.kind === 'compare' && e.input.id === input.id);
		if (existing) {
			this.activate(existing);
			return;
		}
		const editor: Editor = {
			input,
			id: 'compare:' + input.id,
			label: input.title,
			iconClass: 'diff',
			pane: el('div', 'editor-pane compare-pane'),
			dirty: false
		};
		editor.compare = new CompareHost(editor.pane, { fromHash: input.fromHash, toHash: input.toHash, singleCommit: input.singleCommit, repo: input.repo }, {
			openDiff: (diff) => void this.openDiff({ kind: 'diff', ...diff })
		});
		this.add(editor);
	}

	private add(editor: Editor, activate = true): void {
		// A parallel open of the same target passed the "already open" check while this one
		// was still awaiting its reads: the tab that landed first wins, and the latecomer's
		// views are released unshown instead of duplicating the tab.
		const duplicate = this.open.find((e) => e.id === editor.id);
		if (duplicate) {
			editor.view?.destroy();
			editor.merge?.destroy();
			editor.diffObserver?.disconnect();
			editor.fast?.dispose();
			editor.onClose?.();
			if (activate) this.activate(duplicate);
			return;
		}
		this.open.push(editor);
		this.editors.appendChild(editor.pane);
		if (activate) {
			this.activate(editor);
		} else {
			// An inactive open keeps whatever is showing (the session restore opens in
			// parallel and activates its pick afterwards); the pane waits hidden.
			editor.pane.hidden = true;
			this.update();
		}
	}

	/** Show and focus the last-opened editor (the restore's fallback when its remembered
	 *  active file no longer exists). */
	activateLast(): void {
		const last = this.open[this.open.length - 1];
		if (last) this.activate(last);
	}

	/* ---------- Merge conflicts, folder compare, call tree ---------- */

	/** The conflict-resolution toolbar of a file that carries git conflict markers. A clean
	 *  file's toolbar stays hidden (it only exists once markers are found). */
	private async attachMergeSupport(editor: Editor): Promise<void> {
		if (editor.input.kind !== 'file' || !editor.view) return;
		const { MergeToolbar } = await loadMergeEditor();
		const bar = el('div');
		editor.pane.prepend(bar);
		const toolbar = new MergeToolbar(bar);
		toolbar.onResolved = () => this.onMergeResolved?.();
		toolbar.attach(editor.view, editor.input.path);
		editor.mergeToolbar = toolbar;
	}

	/** A Folder Compare tab: two folders' side-by-side comparison. */
	async openFolderCompare(input: Extract<EditorInput, { kind: 'folders' }>): Promise<void> {
		const existing = this.open.find((e) => e.input.kind === 'folders' && e.input.id === input.id);
		if (existing) {
			this.activate(existing);
			return;
		}
		const { FolderCompareView } = await loadFolderCompare();
		const editor: Editor = {
			input,
			id: 'folders:' + input.id,
			label: 'Folder Compare',
			iconClass: 'diff',
			pane: el('div', 'editor-pane'),
			dirty: false
		};
		editor.folderCompare = new FolderCompareView(editor.pane, { left: input.left, right: input.right });
		editor.folderCompare.onFilesChanged = () => this.onExternalFileChange?.();
		this.add(editor);
	}

	/** The Symbol Database tab of this repository (M4): the whole index as a tree. */
	async openSymbolDatabase(): Promise<void> {
		const id = `symboldb:${this.rootPath ?? ''}`;
		const existing = this.open.find((e) => e.input.kind === 'symboldb' && e.input.id === id);
		if (existing) {
			this.activate(existing);
			return;
		}
		const { SymbolDatabaseView } = await loadSymbolDbView();
		const editor: Editor = {
			input: { kind: 'symboldb', id },
			id,
			label: 'Symbol Database',
			iconClass: 'symbol-structure',
			pane: el('div', 'editor-pane'),
			dirty: false
		};
		editor.symbolDatabase = new SymbolDatabaseView(editor.pane);
		editor.symbolDatabase.onOpen = (path, line) => void this.openFile(joinPath(this.rootPath ?? '', path), { line });
		this.add(editor);
	}

	/** A Code Analysis tab (module 17): one per tool — the streaming reports and the graph
	 *  drawings the lazy analysisPages chunk mounts, like the CAN views after it. */
	async openAnalysisPage(tool: import('./analysisTools').AnalysisToolId): Promise<void> {
		const id = `analysis:${tool}`;
		const existing = this.open.find((e) => e.input.kind === 'analysis' && e.input.id === id);
		if (existing) {
			this.activate(existing);
			return;
		}
		const editor: Editor = {
			input: { kind: 'analysis', id, tool },
			id,
			label: ANALYSIS_PAGE_LABELS[tool],
			iconClass: ANALYSIS_PAGE_ICONS[tool],
			pane: el('div', 'editor-pane'),
			dirty: false
		};
		editor.pane.appendChild(el('div', 'an-loading', ['Loading…']));
		this.add(editor);
		const { createAnalysisPage } = await loadAnalysisPages();
		if (!this.open.includes(editor)) return; // the tab closed while the chunk loaded
		editor.pane.textContent = '';
		editor.analysis = createAnalysisPage(tool, editor.pane);
		editor.analysis.onOpen = (path, line) => void this.openFile(joinPath(this.rootPath ?? '', path), { line });
	}

	/** A Call Tree tab for the symbol under the cursor (or given). */
	async openCallTree(symbol: WsSymbol): Promise<void> {
		const id = `calltree:${symbol.path}:${symbol.line}`;
		const existing = this.open.find((e) => e.input.kind === 'calltree' && e.input.id === id);
		if (existing) {
			this.activate(existing);
			return;
		}
		const { CallTreeView } = await loadCallTree();
		const editor: Editor = {
			input: { kind: 'calltree', id, symbol },
			id,
			label: `Calls — ${symbol.name}`,
			iconClass: 'symbol-method',
			pane: el('div', 'editor-pane'),
			dirty: false
		};
		CallTreeView.repoRoot = this.rootPath;
		editor.callTree = new CallTreeView(editor.pane, symbol);
		editor.callTree.onOpen = (path, line) => void this.openFile(path, { line });
		this.add(editor);
	}

	/* ---------- Activation, closing, saving ---------- */

	private activate(editor: Editor): void {
		if (!this.navigating) {
			// Leaving an editor updates its history stop with the position the cursor reached;
			// arriving at a different editor starts a new stop (dropping any forward stops).
			const leaving = this.active;
			if (leaving && leaving !== editor && this.navIndex >= 0 && this.navHistory[this.navIndex]!.input === leaving.input) {
				this.navHistory[this.navIndex] = this.navEntryOf(leaving);
			}
			if (!leaving || leaving.input !== editor.input) this.pushNav(editor);
		}
		this.active = editor;
		const mruIndex = this.mru.indexOf(editor);
		if (mruIndex !== -1) this.mru.splice(mruIndex, 1);
		this.mru.unshift(editor);
		this.onFocus?.();
		for (const other of this.open) other.pane.hidden = other !== editor;
		if (editor.input.kind === 'graph' && this.graphElement) {
			// The graph may have loaded (or last rendered) while its pane was `hidden` -
			// `display:none` gives its iframe a zero-size viewport, and the shared web/ view
			// only recomputes column widths and its virtual window on a 'resize' event. Toggling
			// `hidden` off does not itself fire one, so ask GraphHost to raise one once the pane
			// has its real size back.
			this.graphElement.dispatchEvent(new CustomEvent('ggs-graph-shown'));
		}
		this.update();
		editor.view?.focus();
		editor.view?.requestMeasure();
		this.tabs.querySelector<HTMLElement>('.tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
	}

	/* ---------- Back / forward navigation ---------- */

	canGoBack(): boolean {
		return this.navIndex > 0;
	}

	canGoForward(): boolean {
		return this.navIndex < this.navHistory.length - 1;
	}

	goBack(): void {
		if (this.navIndex <= 0) return;
		this.navIndex--;
		this.onNavigationChange?.();
		void this.navigate(this.navHistory[this.navIndex]!);
	}

	goForward(): void {
		if (this.navIndex >= this.navHistory.length - 1) return;
		this.navIndex++;
		this.onNavigationChange?.();
		void this.navigate(this.navHistory[this.navIndex]!);
	}

	private navEntryOf(editor: Editor): NavEntry {
		let line = 1, column = 1;
		if (editor.view) {
			const head = editor.view.state.selection.main.head;
			const lineInfo = editor.view.state.doc.lineAt(head);
			line = lineInfo.number;
			column = head - lineInfo.from + 1;
		}
		return { input: editor.input, line, column };
	}

	private pushNav(editor: Editor): void {
		this.navHistory.length = this.navIndex + 1;
		this.navHistory.push(this.navEntryOf(editor));
		if (this.navHistory.length > 100) this.navHistory.splice(0, this.navHistory.length - 100);
		this.navIndex = this.navHistory.length - 1;
		this.onNavigationChange?.();
	}

	/** Walk to a history stop: focus its editor (reopening the tab if it was closed in the
	 *  meantime) and put the cursor back where it was. */
	private async navigate(entry: NavEntry): Promise<void> {
		const existing = this.open.find((e) => e.id === inputId(entry.input));
		this.navigating = true;
		try {
			if (existing) {
				this.activate(existing);
				this.revealIn(existing, entry.line, entry.column);
			} else if (entry.input.kind === 'file') {
				// A CAN tab's raw form has no cursor, so its entry carries no real position —
				// it reopens in the raw frame view, where a line option would force the text form.
				const line = isCanLog(entry.input.path) ? undefined : entry.line;
				await this.openFile(entry.input.path, { line, column: entry.column });
			} else if (entry.input.kind === 'graph') {
				this.openGraph();
			} else if (entry.input.kind === 'help') {
				this.openHelp(entry.input.help);
			}
			// A closed diff / comparison stop is gone with its data: the jump is a no-op.
		} finally {
			this.navigating = false;
		}
	}

	private revealPosition(view: EditorView, line: number, column: number): void {
		cm?.revealPosition(view, line, column);
	}

	activateNext(direction: 1 | -1): void {
		if (!this.active || this.open.length < 2) return;
		const index = this.open.indexOf(this.active);
		this.activate(this.open[(index + direction + this.open.length) % this.open.length]!);
	}

	/* ---------- Moving editors between groups (M3 3.1) ---------- */

	/** Detach an editor for a move into another group. Its view, pane and state survive
	 *  untouched - only this group's tab strip and active editor are updated. */
	moveOut(editor: Editor): Editor | null {
		const index = this.open.indexOf(editor);
		if (index === -1) return null;
		this.open.splice(index, 1);
		this.forget(editor);
		this.activateSuccessor(editor, index);
		return editor;
	}

	/** Drop an editor from the recently-used order once it leaves the group. */
	private forget(editor: Editor): void {
		const mruIndex = this.mru.indexOf(editor);
		if (mruIndex !== -1) this.mru.splice(mruIndex, 1);
	}

	/** After `editor` (which sat at `index`) left the group: if it was showing, activate the
	 *  most recently used remaining editor - VS Code's default - falling back to the tab
	 *  that took its place; otherwise just refresh the strip. */
	private activateSuccessor(editor: Editor, index: number): void {
		if (this.active !== editor) {
			this.update();
			return;
		}
		const next = this.mru.find((candidate) => this.open.includes(candidate)) ?? this.open[Math.min(index, this.open.length - 1)];
		if (next) {
			this.activate(next);
		} else {
			this.active = null;
			this.update();
		}
	}

	/** Take over an editor detached from another group (its pane is re-parented here). */
	moveIn(editor: Editor): void {
		if (this.open.includes(editor)) return;
		this.open.push(editor);
		this.editors.appendChild(editor.pane);
		editor.pane.hidden = false;
		this.activate(editor);
	}

	/** The editor a tab drag carries, set on `dragstart` and read by the drop target group. */
	findEditor(id: string): Editor | null {
		return this.open.find((e) => e.id === id) ?? null;
	}

	/** Reveal an already-open editor's tab (the Markdown preview's side-by-side open). */
	activateById(id: string): void {
		const editor = this.open.find((e) => e.id === id);
		if (editor) this.activate(editor);
	}

	async close(editor: Editor = this.active!): Promise<void> {
		if (!editor) return;
		if (editor.dirty) {
			const choice = await askToSave(editor.label);
			if (choice === 'cancel') return;
			if (choice === 'save') {
				await this.save(editor);
				if (editor.dirty) return; // the save failed and was reported
			}
		}
		const index = this.open.indexOf(editor);
		if (index === -1) return;
		this.open.splice(index, 1);
		if (editor.dirty) this.forgetBackup(editor); // discarded on purpose: nothing to recover
		editor.view?.destroy();
		editor.merge?.destroy();
		editor.diffObserver?.disconnect();
		editor.compare?.dispose();
		editor.folderCompare?.dispose();
		editor.fast?.dispose();
		editor.onClose?.();
		if (editor.input.kind === 'graph') {
			// The frame survives: the host reuses it when the tab is opened again.
			this.graphElement?.remove();
		}
		editor.pane.remove();
		this.forget(editor);
		this.activateSuccessor(editor, index);
	}

	/** The dirty editors' labels (the area's one "save these N files?" prompt lists them). */
	dirtyLabels(): string[] {
		return this.open.filter((e) => e.dirty).map((e) => e.label);
	}

	/** Resolve every dirty editor at once: save them all, or drop their changes - the
	 *  answer to the single prompt VS Code shows before closing several dirty files. */
	async settleDirty(choice: 'save' | 'discard'): Promise<boolean> {
		for (const editor of [...this.open]) {
			if (!editor.dirty) continue;
			if (choice === 'save') {
				await this.save(editor);
				if (editor.dirty) return false; // the save failed and was reported
			} else {
				editor.dirty = false;
				this.forgetBackup(editor);
			}
		}
		return true;
	}

	async closeAll(): Promise<boolean> {
		// Several dirty files get one prompt (VS Code's), not one per file.
		const dirty = this.dirtyLabels();
		if (dirty.length > 1) {
			const choice = await askToSaveMany(dirty);
			if (choice === 'cancel' || !(await this.settleDirty(choice))) return false;
		}
		for (const editor of [...this.open]) {
			await this.close(editor);
			if (this.open.includes(editor)) return false; // cancelled
		}
		return true;
	}

	async closeOthers(keep: Editor): Promise<void> {
		for (const editor of [...this.open]) {
			if (editor !== keep) await this.close(editor);
		}
	}

	/** VS Code's "Close to the Right": every tab after this one. */
	async closeToTheRight(from: Editor): Promise<void> {
		for (const editor of this.open.slice(this.open.indexOf(from) + 1)) await this.close(editor);
	}

	async closeSaved(): Promise<void> {
		for (const editor of [...this.open]) {
			if (!editor.dirty) await this.close(editor);
		}
	}

	async save(editor: Editor | null = this.active): Promise<void> {
		if (!editor || !editor.dirty) return;
		// A hex view's edits are patched byte-by-byte in place, not written as text.
		if (editor.hex) {
			if (!(await editor.hex.save())) notify('error', `Failed to save '${editor.label}'`);
			editor.dirty = editor.hex.isDirty;
			this.renderTabs();
			return;
		}
		// A windowed editor's document lives in the backend: the save writes it from there,
		// so nothing the size of the file ever crosses the IPC.
		if (editor.doc && editor.input.kind === 'file') {
			// A failed save (the view reports the error) leaves the tab dirty and its
			// backup in place, exactly like a failed write_file below.
			if (!(await editor.doc.save())) return;
			editor.dirty = false;
			this.renderTabs();
			this.flashSavedTab(editor);
			this.forgetBackup(editor);
			this.onFileSaved?.(editor.input.path);
			return;
		}
		if (editor.input.kind !== 'file' || !editor.view) return;
		const contents = editor.view.state.doc.toString();
		try {
			await invoke('write_file', { path: editor.input.path, contents, encoding: editor.encoding ?? 'utf8', eol: editor.eol ?? 'lf' });
		} catch (error) {
			notify('error', `Failed to save '${editor.label}': ${String(error)}`);
			return;
		}
		editor.dirty = false;
		this.renderTabs();
		this.flashSavedTab(editor);
		this.forgetBackup(editor);
		this.onFileSaved?.(editor.input.path);
	}

	/** Xcode's save acknowledgement (M7 7.8): the saved tab flashes once. renderTabs rebuilt
	 *  the strip, so the tab is re-found by position among the group's tabs. */
	private flashSavedTab(editor: Editor): void {
		const at = this.open.indexOf(editor);
		if (at < 0) return;
		const tab = this.tabs.children[at] as HTMLElement | undefined;
		if (!tab) return;
		tab.classList.add('just-saved');
		window.setTimeout(() => tab.classList.remove('just-saved'), 200);
	}

	/** A saved or discarded buffer has nothing left to recover. */
	private forgetBackup(editor: Editor): void {
		if (editor.input.kind !== 'file') return;
		const timer = this.backupTimers.get(editor.id);
		if (timer !== undefined) window.clearTimeout(timer);
		this.backupTimers.delete(editor.id);
		const autoSave = this.autoSaveTimers.get(editor.id);
		if (autoSave !== undefined) window.clearTimeout(autoSave);
		this.autoSaveTimers.delete(editor.id);
		void invoke('backup_clear', { path: editor.input.path }).catch(() => undefined);
	}

	/** A file that changed on disk under a clean editor is reloaded in place. */
	async reloadIfClean(path: string): Promise<void> {
		const editor = this.open.find((e) => e.input.kind === 'file' && e.input.path === path);
		if (!editor || editor.dirty) return;
		// A windowed editor's document lives in the backend: it compares the file's stamp
		// there and reloads only when the disk really changed (a save's own watcher echo
		// reads as unchanged, so the cursor never jumps after a save).
		if (editor.doc) {
			await editor.doc.reload();
			return;
		}
		const view = editor.view;
		if (!view) return;
		try {
			const file = await readFileRaw(path);
			if (file.contents === null) return;
			// The read was async: the editor may have been closed, dirtied, or swapped to
			// another surface (hex, fast view) while it was in flight, and a stale
			// whole-document replace would then wipe what is on screen now.
			if (editor.dirty || !this.open.includes(editor) || editor.view !== view) return;
			const current = view.state.doc.toString();
			editor.encoding = file.encoding ?? editor.encoding;
			editor.eol = file.eol ?? editor.eol;
			// The document holds LF (CodeMirror normalises CRLF on insert) while the read
			// carries the file's decoded bytes verbatim: an unchanged CRLF file never compares
			// equal as-is, and every refresh - a window refocus among them - would rebuild the
			// whole document (a full re-highlight) and nudge the view for nothing.
			if (current === file.contents || current === file.contents.replace(/\r\n?/g, '\n')) return;
			cm?.replaceDocument(view, file.contents);
			editor.dirty = false;
			this.renderTabs();
			this.refreshPreviews(path);
		} catch {
			// Deleted meanwhile: the tab keeps its last contents, as VS Code does.
		}
	}

	/** Files the Explorer renamed or deleted: retarget or close their tabs. */
	pathRenamed(from: string, to: string): void {
		for (const editor of this.open) {
			const kind = editor.input.kind;
			// Hex and markdown-preview tabs are views over a file too: they follow the rename.
			if (kind !== 'file' && kind !== 'hex' && kind !== 'markdown') continue;
			const path = editor.input.path;
			if (path !== from && !toPosix(path).startsWith(toPosix(from) + '/')) continue;
			const updated = to + path.slice(from.length);
			const previousId = editor.id;
			const previousInput = editor.input;
			if (kind === 'file') {
				editor.input = { kind: 'file', path: updated };
				editor.label = basename(updated);
				editor.iconClass = fileIcon(editor.label);
			} else if (kind === 'hex') {
				editor.input = { kind: 'hex', path: updated };
				editor.label = `Hex ${basename(updated)}`;
			} else {
				editor.input = { kind: 'markdown', path: updated };
				editor.label = `Preview ${basename(updated)}`;
			}
			editor.id = inputId(editor.input);
			// The history's stops hold the editor's input by identity: Back to a renamed file
			// must land on the new path (a closed tab would otherwise reopen the old one),
			// and the cursor bookkeeping in `activate` matches stops by that identity too.
			for (const entry of this.navHistory) {
				if (entry.input === previousInput) entry.input = editor.input;
			}
			// The hex view caches its own path copy for the byte-patch save.
			editor.hex?.setPath(updated);
			// Timers are keyed by the editor id: pending backup / auto-save / preview
			// refreshes move to the new id so they can still be found and cleared.
			for (const timers of [this.backupTimers, this.autoSaveTimers, this.previewTimers]) {
				const timer = timers.get(previousId);
				if (timer !== undefined) {
					timers.delete(previousId);
					timers.set(editor.id, timer);
				}
			}
		}
		// Stops of tabs closed before the rename hold their own input objects: respelled by
		// path, so Back reopens the file under its new name rather than failing on the old.
		for (const entry of this.navHistory) {
			const kind = entry.input.kind;
			if (kind !== 'file' && kind !== 'hex' && kind !== 'markdown') continue;
			const path = entry.input.path;
			if (path !== from && !toPosix(path).startsWith(toPosix(from) + '/')) continue;
			entry.input = { ...entry.input, path: to + path.slice(from.length) };
		}
		this.update();
	}

	async pathDeleted(path: string): Promise<void> {
		for (const editor of [...this.open]) {
			if (editor.input.kind !== 'file') continue;
			const target = editor.input.path;
			if (target === path || toPosix(target).startsWith(toPosix(path) + '/')) {
				editor.dirty = false;
				await this.close(editor);
			}
		}
	}

	/** Toggle (or remove) the bookmark on the editor's cursor line; the gutter follows on the
	 *  selection update the toggle dispatches. */
	private toggleBookmarkAt(editor: Editor, line: number): void {
		if (editor.input.kind !== 'file' || !editor.view) return;
		toggleBookmark(editor.input.path, line);
		editor.view.dispatch({ selection: { anchor: editor.view.state.selection.main.head } });
	}

	/* ---------- Rendering ---------- */

	/** Re-render the group's strip, breadcrumbs and welcome page; public so the editor area
	 *  can hand the welcome page back to the first group after a collapse. */
	update(): void {
		this.onTabsChange?.();
		this.renderTabs();
		this.renderBreadcrumbs();
		this.welcome.hidden = this.active !== null || !this.showWelcome;
		if (this.active === null && this.showWelcome) {
			this.welcome.innerHTML = '';
			this.renderWelcome?.(this.welcome);
		} else if (this.active === null) {
			this.welcome.innerHTML = '';
		}
		this.emitActive();
	}

	/** Report the active editor to whoever listens (the area, the status bar). Public so the
	 *  editor area can re-report when the focused group changes. */
	emitActive(): void {
		if (!this.onActiveChange) return;
		if (!this.active) {
			this.onActiveChange(null);
			return;
		}
		let line = 1, column = 1, selected = 0, selections = 0;
		if (this.active.doc) {
			// A windowed editor: the line number is offset by the window's first line.
			({ line, column, selected, selections } = this.active.doc.status());
		} else if (this.active.view) {
			const selection = this.active.view.state.selection;
			const head = selection.main.head;
			const lineInfo = this.active.view.state.doc.lineAt(head);
			line = lineInfo.number;
			column = head - lineInfo.from + 1;
			// The status bar's "(N selected)" / "N selections", as VS Code reports them.
			selections = selection.ranges.length;
			selected = selection.ranges.reduce((total, range) => total + (range.to - range.from), 0);
		}
		this.onActiveChange({
			kind: this.active.input.kind,
			path: this.active.input.kind === 'file' ? this.active.input.path : undefined,
			languageName: this.active.languageName,
			encoding: this.active.encoding,
			eol: this.active.eol,
			line,
			column,
			selected,
			selections
		});
	}

	/** VS Code's tab context menu. */
	private tabMenu(editor: Editor): MenuEntry[] {
		const entries: MenuEntry[] = [
			{ label: 'Close', keybinding: 'Ctrl+W', run: () => void this.close(editor) },
			{ label: 'Close Others', run: () => void this.closeOthers(editor) },
			{ label: 'Close to the Right', disabled: this.open.indexOf(editor) === this.open.length - 1, run: () => void this.closeToTheRight(editor) },
			{ label: 'Close Saved', run: () => void this.closeSaved() },
			{ label: 'Close All', keybinding: 'Ctrl+K Ctrl+W', run: () => void this.closeAll() }
		];
		if (editor.input.kind === 'file') {
			const path = editor.input.path;
			entries.push('separator',
				{ label: 'Copy Path', keybinding: 'Shift+Alt+C', run: () => void writeText(path) },
				{ label: 'Copy Relative Path', keybinding: 'Ctrl+K Ctrl+Shift+C', run: () => void writeText(this.rootPath ? relativeTo(this.rootPath, path) : path) });
		}
		entries.push(...menuSection('editor/title/context'));
		return entries;
	}

	/* ---------- The text editor's context menu, Go to Definition ---------- */

	/** The services a text pane gets: the right-click menu and Ctrl+click-as-Go-to-Definition. */
	private attachTextServices(editor: Editor): void {
		const posAt = (event: MouseEvent): number | null => {
			if (!editor.view) return null;
			try {
				return editor.view.posAtCoords({ x: event.clientX, y: event.clientY });
			} catch {
				return null; // no layout yet (the tests' jsdom): fall back to the selection
			}
		};
		editor.pane.addEventListener('contextmenu', (event) => {
			event.preventDefault();
			showContextMenu(event.clientX, event.clientY, this.textMenu(editor, posAt(event)));
		});
		editor.pane.addEventListener('mousedown', (event) => {
			if ((event.ctrlKey || event.metaKey) && event.button === 0 && editor.view) {
				event.preventDefault();
				void this.goToDefinition(editor, posAt(event));
			}
		});
	}

	private textMenu(editor: Editor, pos: number | null): MenuEntry[] {
		const view = editor.view;
		const hasSelection = !!view && !view.state.selection.main.empty;
		const readOnly = !!view && view.state.readOnly;
		const copy = () => {
			if (!view) return;
			const selection = view.state.selection.main;
			if (selection.empty) return;
			void writeText(view.state.sliceDoc(selection.from, selection.to));
		};
		const cut = () => {
			if (!view || readOnly) return;
			const selection = view.state.selection.main;
			if (selection.empty) return;
			void writeText(view.state.sliceDoc(selection.from, selection.to));
			view.dispatch({ changes: { from: selection.from, to: selection.to } });
		};
		const paste = async () => {
			if (!view || readOnly) return;
			try {
				const text = await readText();
				const selection = view.state.selection.main;
				view.dispatch({ changes: { from: selection.from, to: selection.to, insert: text }, selection: { anchor: selection.from + text.length } });
			} catch {
				notify('warning', 'The clipboard could not be read.');
			}
		};
		const currentLine = view ? view.state.doc.lineAt(view.state.selection.main.head).number : null;
		return [
			{ label: 'Go to Definition', keybinding: 'F12', run: () => void this.goToDefinition(editor, pos) },
			{ label: 'Find References', keybinding: 'Shift+F12', run: () => void this.findReferences(editor, pos) },
			{ label: 'Show Call Tree', run: () => void this.openCallTreeAtCursor(editor, pos) },
			'separator',
			{ label: 'Go Back', keybinding: 'Alt+Left', disabled: !this.canGoBack(), run: () => this.goBack() },
			{ label: 'Go Forward', keybinding: 'Alt+Right', disabled: !this.canGoForward(), run: () => this.goForward() },
			'separator',
			{ label: currentLine !== null && hasBookmark(editor.input.kind === 'file' ? editor.input.path : '', currentLine) ? 'Remove Bookmark' : 'Toggle Bookmark', keybinding: 'Ctrl+Alt+B', disabled: currentLine === null, run: () => this.toggleBookmarkAt(editor, currentLine!) },
			'separator',
			{ label: 'Change All Occurrences', keybinding: 'Ctrl+F2', disabled: !view || readOnly, run: () => { if (view) cm?.changeAllOccurrences(view); } },
			'separator',
			{ label: 'Cut', keybinding: 'Ctrl+X', disabled: !hasSelection || readOnly, run: () => cut() },
			{ label: 'Copy', keybinding: 'Ctrl+C', disabled: !hasSelection, run: () => copy() },
			{ label: 'Paste', keybinding: 'Ctrl+V', disabled: readOnly, run: () => void paste() },
			'separator',
			{ label: 'Find', keybinding: 'Ctrl+F', run: () => this.runEditorCommand('find') },
			{ label: 'Command Palette...', keybinding: 'Ctrl+Shift+P', run: () => void commands.execute('workbench.commandPalette') },
			// Extensions' `contributes.menus["editor/context"]` entries.
			...menuSection('editor/context')
		];
	}

	/** A best-effort "Go to Definition": the workspace symbol index first (a language-aware
	 *  answer), then the declaration-pattern scan of this file and the workspace's code files. */
	async goToDefinition(editor: Editor | null = this.active, pos?: number | null): Promise<void> {
		if (!editor?.view) return;
		const view = editor.view;
		const at = pos ?? view.state.selection.main.head;
		const word = view.state.wordAt(at) ?? view.state.wordAt(view.state.selection.main.head);
		if (!word) return;
		const name = view.state.sliceDoc(word.from, word.to);
		const currentPath = editor.input.kind === 'file' ? editor.input.path : null;
		if (this.rootPath && await this.goToIndexedDefinition(name, currentPath, view)) return;
		const pattern = new RegExp(
			'^(?:\\s*(?:export|declare|default|pub|public|private|protected|internal|static|async|abstract|unsafe|extern|virtual|override|final)\\s+)*'
			+ `(?:function|fn|def|class|struct|enum|interface|trait|type|module|impl|const|let|var)\\s+${escapeRegExp(name)}\\b`
		);
		const inThisFile = findDefinition(view.state.doc.toString(), pattern);
		if (inThisFile !== null && (currentPath === null || inThisFile.line !== view.state.doc.lineAt(at).number)) {
			this.revealPosition(view, inThisFile.line, inThisFile.column);
			return;
		}
		if (!this.rootPath) {
			notify('info', inThisFile ? `The definition of '${name}' is in this file.` : `No definition found for '${name}'.`);
			return;
		}
		let files: string[];
		try {
			files = await invoke<string[]>('list_files');
		} catch {
			files = [];
		}
		const candidates = files.filter((f) => looksLikeCode(f) && (currentPath === null || joinPath(this.rootPath!, f) !== currentPath));
		// Same-language files are likelier to hold the definition; the current file's folder
		// first (candidates are workspace-relative, so the folder is compared relatively too).
		const wanted = currentPath ? currentPath.split('.').pop()! : '';
		const folder = currentPath ? dirname(relativeTo(this.rootPath!, currentPath)) : '';
		candidates.sort((a, b) => Number(b.endsWith('.' + wanted)) - Number(a.endsWith('.' + wanted)) || Number(dirname(b) === folder) - Number(dirname(a) === folder));
		for (const relative of candidates.slice(0, MAX_DEFINITION_FILES)) {
			const path = joinPath(this.rootPath, relative);
			const contents = await this.cachedRead(path);
			if (contents === null) continue;
			const hit = findDefinition(contents, pattern);
			if (hit !== null) {
				await this.openFile(path, { line: hit.line, column: hit.column });
				return;
			}
		}
		if (inThisFile !== null) this.revealPosition(view, inThisFile.line, inThisFile.column);
		else notify('info', `No definition found for '${name}'.`);
	}

	/** Try the workspace symbol index for an exact-name definition. The persistent index's
	 *  exact-name lookup (`symbol_lookup`, M4 4.4) answers first - one declaration jumps
	 *  straight there, several offer VS Code's definition list; without an index the
	 *  substring query below is the fallback it always was. A same-file hit that is where
	 *  the cursor already is does not count (that is the declaration itself). */
	private async goToIndexedDefinition(name: string, currentPath: string | null, view: EditorView): Promise<boolean> {
		try {
			const exact = await invoke<WsSymbol[]>('symbol_lookup', { name });
			if (exact.length === 1) return this.jumpToDefinition(exact[0]!, currentPath, view);
			if (exact.length > 1) return this.pickDefinition(exact, currentPath, view);
		} catch {
			// No persistent index yet (or an old backend): the substring query takes over.
		}
		let symbols: WsSymbol[];
		try {
			symbols = await invoke<WsSymbol[]>('workspace_symbols', { query: name, limit: 200 });
		} catch {
			return false;
		}
		const hits = symbols.filter((s) => s.name === name && (s.kind === 'function' || s.kind === 'method' || s.kind === 'class' || s.kind === 'struct' || s.kind === 'interface'));
		const currentRelative = currentPath ? toPosix(relativeTo(this.rootPath!, currentPath)) : null;
		// The current file's own hit is the fallback, not the pick: another file's definition
		// is the useful jump.
		const other = hits.find((s) => s.path !== currentRelative);
		const target = other ?? hits[0];
		if (!target) return false;
		return this.jumpToDefinition(target, currentPath, view);
	}

	/** VS Code's definition list on multiple hits (M4 4.4): a pick that jumps to whichever
	 *  declaration the user means. */
	private async pickDefinition(defs: WsSymbol[], currentPath: string | null, view: EditorView): Promise<boolean> {
		const chosen = await quickPick(
			defs.map((def) => ({ label: def.name, description: `${def.path}:${def.line + 1}`, icon: 'symbol-method', value: `${def.path}\u0000${def.line}` })),
			`${defs.length} definitions`,
			'Definitions'
		);
		if (chosen === null) return true; // dismissed - the gesture is consumed either way
		const [path, line] = chosen.split('\u0000');
		const absolute = joinPath(this.rootPath!, path!);
		if (currentPath && absolute === currentPath) {
			this.revealPosition(view, Number(line) + 1, 1);
			return true;
		}
		await this.openFile(absolute, { line: Number(line) + 1, column: 1 });
		return true;
	}

	/** Jump to one resolved definition: within this file when that is where it lives, into
	 *  another file otherwise. */
	private async jumpToDefinition(target: WsSymbol, currentPath: string | null, view: EditorView): Promise<boolean> {
		const path = joinPath(this.rootPath!, target.path);
		if (currentPath && path === currentPath) {
			// Jump within this file only when it is a different line than the cursor's word.
			this.revealPosition(view, target.line + 1, 1);
			return true;
		}
		await this.openFile(path, { line: target.line + 1, column: 1 });
		return true;
	}

	/** Find References (Shift+F12): every whole-word occurrence of the symbol under the
	 *  cursor, offered as a pick list that jumps to the chosen one. */
	async findReferences(editor: Editor | null = this.active, pos?: number | null): Promise<void> {
		if (!editor?.view) return;
		const view = editor.view;
		const at = pos ?? view.state.selection.main.head;
		const word = view.state.wordAt(at) ?? view.state.wordAt(view.state.selection.main.head);
		if (!word) return;
		const name = view.state.sliceDoc(word.from, word.to);
		let files: { path: string; matches: { line: number; column: number }[] }[];
		try {
			// The index's occurrence list narrows this scan to the files that contain the
			// word (M4); the older full-scan command stays as the fallback.
			files = (await invoke('symbol_references', { name })) ?? [];
		} catch {
			try {
				files = (await invoke('find_references', { name })) ?? [];
			} catch (error) {
				notify('error', String(error));
				return;
			}
		}
		const total = files.reduce((sum, f) => sum + f.matches.length, 0);
		if (total === 0) {
			notify('info', `No references found for '${name}'.`);
			return;
		}
		const items = files.flatMap((file) => file.matches.map((match) => ({
			label: `${file.path}:${match.line}`,
			description: name,
			icon: 'go-to-file',
			value: `${file.path}\u0000${match.line}\u0000${match.column}`
		})));
		const chosen = await quickPick(items.slice(0, 60), `${total} reference(s) to '${name}'`, 'References');
		if (!chosen || !this.rootPath) return;
		const [path, line, column] = chosen.split('\u0000');
		await this.openFile(joinPath(this.rootPath, path!), { line: Number(line), column: Number(column) });
	}

	/** The Call Tree of the function under the cursor. */
	async openCallTreeAtCursor(editor: Editor | null = this.active, pos?: number | null): Promise<void> {
		if (!editor?.view || !this.rootPath) return;
		const view = editor.view;
		const at = pos ?? view.state.selection.main.head;
		const word = view.state.wordAt(at) ?? view.state.wordAt(view.state.selection.main.head);
		if (!word) {
			notify('info', 'Place the cursor on a function name to see its call tree.');
			return;
		}
		const name = view.state.sliceDoc(word.from, word.to);
		let symbols: WsSymbol[];
		try {
			symbols = await invoke<WsSymbol[]>('workspace_symbols', { query: name, limit: 200 });
		} catch (error) {
			notify('error', String(error));
			return;
		}
		const currentPath = editor.input.kind === 'file' ? toPosix(relativeTo(this.rootPath, editor.input.path)) : null;
		const symbol = symbols.find((s) => s.name === name && s.path === currentPath) ?? symbols.find((s) => s.name === name);
		if (!symbol) {
			notify('info', `No function named '${name}' was found in the workspace index.`);
			return;
		}
		await this.openCallTree(symbol);
	}

	/** Go to Symbol in File (Ctrl+Shift+O): the active file's outline as a pick list. */
	async gotoSymbolInFile(): Promise<void> {
		const editor = this.active;
		if (!editor || editor.input.kind !== 'file') return;
		let symbols: OutlineSymbol[];
		try {
			const info = await invoke<{ docId: number; symbols: OutlineSymbol[] }>('viewer_open', { path: editor.input.path });
			symbols = info.symbols ?? [];
			await invoke('viewer_close', { docId: info.docId }).catch(() => undefined);
		} catch {
			symbols = [];
		}
		if (symbols.length === 0) {
			notify('info', 'No symbols were found in this file.');
			return;
		}
		const chosen = await quickPick(
			symbols.map((symbol) => ({ label: symbol.name, description: symbol.kind, icon: SYMBOL_ICONS[symbol.kind] ?? 'symbol-method', value: String(symbol.line) })),
			'Go to symbol in this file',
			'Go to Symbol'
		);
		if (chosen !== null) this.revealIn(editor, Number(chosen) + 1, 1);
	}

	/** VS Code's Go to Line (Ctrl+G / a ":" in Quick Open): the active text editor's line count
	 *  and cursor position, or null when no text editor is active. */
	lineInfo(): { line: number; column: number; lines: number } | null {
		const view = this.active?.view;
		if (!view) return null;
		const head = view.state.selection.main.head;
		const line = view.state.doc.lineAt(head);
		return { line: line.number, column: head - line.from + 1, lines: view.state.doc.lines };
	}

	/** Move the active text editor's cursor to a 1-based line (and column). */
	gotoLine(line: number, column = 1): void {
		const editor = this.active;
		if (editor && (editor.view || editor.doc || editor.fast)) this.revealIn(editor, line, column);
	}

	/** Reads a workspace file for the definition search, cached until the folder changes. The
	 *  cache holds whole file strings, so it is capped - a long session walking a large
	 *  repository must not accumulate every file it ever looked at. */
	private async cachedRead(path: string): Promise<string | null> {
		if (workspaceFileCache.has(path)) return workspaceFileCache.get(path)!;
		try {
			const file = await readFileRaw(path);
			const contents = file.contents !== null && !file.binary && file.contents.length <= 1_000_000 ? file.contents : null;
			cacheWorkspaceFile(path, contents);
			return contents;
		} catch {
			cacheWorkspaceFile(path, null);
			return null;
		}
	}

	private renderTabs(): void {
		this.tabs.innerHTML = '';
		// Two open files with the same name are told apart by their folder, as VS Code does.
		const names = new Map<string, number>();
		for (const editor of this.open) names.set(editor.label, (names.get(editor.label) ?? 0) + 1);
		for (const editor of this.open) {
			const tab = el('div', 'tab' + (editor === this.active ? ' active' : '') + (editor.dirty ? ' dirty' : ''));
			tab.setAttribute('role', 'tab');
			tab.setAttribute('aria-selected', editor === this.active ? 'true' : 'false');
			tab.title = editor.input.kind === 'file' ? editor.input.path : editor.label;
			const iconElement = el('span', 'icon');
			if (editor.iconSrc) {
				const image = el('img');
				image.src = editor.iconSrc;
				image.alt = '';
				iconElement.appendChild(image);
			} else {
				const glyph = icon(editor.iconClass ?? 'file');
				if (editor.input.kind === 'file') glyph.style.color = fileIconColor(editor.label) ?? '';
				iconElement.appendChild(glyph);
			}
			tab.appendChild(iconElement);
			tab.appendChild(el('span', 'label', [editor.label]));
			if (editor.input.kind === 'file' && (names.get(editor.label) ?? 0) > 1) {
				const folder = basename(editor.input.path.slice(0, editor.input.path.length - editor.label.length - 1));
				if (folder) tab.appendChild(el('span', 'description', [folder]));
			}
			const close = el('span', 'close', [icon('close'), icon('circle-filled')]);
			close.title = 'Close';
			close.addEventListener('click', (event) => {
				event.stopPropagation();
				void this.close(editor);
			});
			tab.appendChild(close);
			tab.addEventListener('click', () => this.activate(editor));
			// Tabs drag into other editor groups (M3 3.1): the payload travels in a module-level
			// slot, because DataTransfer's custom types are not readable during dragover.
			tab.draggable = true;
			tab.addEventListener('dragstart', (event) => {
				tabDrag.editor = editor;
				tabDrag.groupId = this.groupId;
				event.dataTransfer?.setData('text/plain', editor.id);
			});
			tab.addEventListener('dragend', () => { tabDrag.editor = null; tabDrag.groupId = null; });
			tab.addEventListener('auxclick', (event) => {
				if (event.button === 1) void this.close(editor);
			});
			tab.addEventListener('contextmenu', (event) => {
				event.preventDefault();
				showContextMenu(event.clientX, event.clientY, this.tabMenu(editor));
			});
			this.tabs.appendChild(tab);
		}
		// A Markdown file's tab strip carries the preview button VS Code shows: it opens the
		// rendered view beside the group (already-open previews are just revealed).
		const active = this.active;
		if (active?.input.kind === 'file' && /\.(md|markdown)$/i.test(active.input.path)) {
			const button = el('button', 'markdown-preview-button', [icon('open-preview')]);
			button.title = 'Open Preview to the Side (Ctrl+K V)';
			button.addEventListener('click', (event) => {
				event.stopPropagation();
				this.onOpenPreviewToSide?.(active.input.kind === 'file' ? active.input.path : '');
			});
			this.tabs.appendChild(el('div', 'tab-actions', [button]));
		}
	}

	private renderBreadcrumbs(): void {
		this.breadcrumbs.innerHTML = '';
		this.breadcrumbs.hidden = this.active === null;
		if (!this.active) return;
		const crumbs: { label: string; iconName?: string; iconColor?: string }[] = [];
		if (this.active.input.kind === 'file') {
			const relative = this.rootPath ? relativeTo(this.rootPath, this.active.input.path) : toPosix(this.active.input.path);
			const parts = relative.split('/').filter((p) => p !== '');
			parts.forEach((part, index) => crumbs.push({ label: part, iconName: index === parts.length - 1 ? fileIcon(part) : 'folder', iconColor: index === parts.length - 1 ? fileIconColor(part) : undefined }));
		} else if (this.active.input.kind === 'diff' || this.active.input.kind === 'compare' || this.active.input.kind === 'folders' || this.active.input.kind === 'calltree') {
			crumbs.push({ label: this.active.label, iconName: 'diff' });
		} else if (this.active.input.kind === 'graph') {
			crumbs.push({ label: 'Git Graph' });
		} else if (this.active.input.kind === 'markdown' || this.active.input.kind === 'history' || this.active.input.kind === 'hex' || this.active.input.kind === 'canlog') {
			// A preview, history or hex tab of a file walks the file's own path, as VS Code's
			// breadcrumbs do for a custom editor over that file.
			const relative = this.rootPath ? relativeTo(this.rootPath, this.active.input.path) : toPosix(this.active.input.path);
			const parts = relative.split('/').filter((p) => p !== '');
			parts.forEach((part, index) => crumbs.push({ label: part, iconName: index === parts.length - 1 ? this.active!.iconClass ?? fileIcon(part) : 'folder', iconColor: index === parts.length - 1 ? fileIconColor(part) : undefined }));
		} else {
			crumbs.push({ label: this.active.label });
		}
		crumbs.forEach((crumb, index) => {
			if (index > 0) this.breadcrumbs.appendChild(icon('chevron-right'));
			const glyph = crumb.iconName ? icon(crumb.iconName) : null;
			if (glyph && crumb.iconColor) glyph.style.color = crumb.iconColor;
			this.breadcrumbs.appendChild(el('span', 'crumb', [glyph, crumb.label]));
		});
	}
}

/* ---------- Helpers ---------- */

/** The tab being dragged between editor groups: filled on `dragstart`, consumed on drop. */
export const tabDrag: { editor: Editor | null; groupId: number | null } = { editor: null, groupId: null };

function notice(iconName: string, text: string): HTMLElement {
	return el('div', 'editor-notice', [icon(iconName), el('span', '', [text])]);
}

/** How many workspace files "Go to Definition" reads through before giving up. */
const MAX_DEFINITION_FILES = 3000;

const workspaceFileCache = new Map<string, string | null>();
/** How many workspace files the definition search keeps cached (whole file strings). */
const WORKSPACE_CACHE_MAX = 64;

function cacheWorkspaceFile(path: string, contents: string | null): void {
	// Refresh the insertion order, then drop the oldest entry past the cap.
	workspaceFileCache.delete(path);
	workspaceFileCache.set(path, contents);
	if (workspaceFileCache.size > WORKSPACE_CACHE_MAX) {
		workspaceFileCache.delete(workspaceFileCache.keys().next().value!);
	}
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The line and column a declaration of the pattern starts at, or null if the text has none. */
function findDefinition(text: string, pattern: RegExp): { line: number; column: number } | null {
	const lines = text.split('\n');
	for (let i = 0; i < lines.length; i++) {
		const match = lines[i]!.match(pattern);
		if (match) return { line: i + 1, column: match[0].length - match[0].trimStart().length + 1 };
	}
	return null;
}

function looksLikeCode(path: string): boolean {
	const name = basename(path).toLowerCase();
	const dot = name.lastIndexOf('.');
	const ext = dot === -1 ? name : name.slice(dot + 1);
	return CODE_EXTENSIONS.has(ext) || name === 'makefile';
}

/** VS Code's prompt before closing several dirty files at once: one question listing them,
 *  with Save All / Don't Save / Cancel. */
export function askToSaveMany(labels: string[]): Promise<'save' | 'discard' | 'cancel'> {
	return new Promise((resolve) => {
		let settled = false;
		const settle = (value: 'save' | 'discard' | 'cancel') => {
			if (!settled) {
				settled = true;
				resolve(value);
			}
		};
		const list = labels.length > 6 ? `${labels.slice(0, 6).join(', ')} and ${labels.length - 6} more` : labels.join(', ');
		notify('warning', `Do you want to save the changes to the following ${labels.length} files? ${list}. Your changes will be lost if you don't save them.`, [
			{ label: 'Save All', run: () => settle('save') },
			{ label: "Don't Save", run: () => settle('discard') },
			{ label: 'Cancel', run: () => settle('cancel') }
		], () => settle('cancel'));
	});
}

/** VS Code's "Do you want to save the changes?" prompt, rendered as a notification. */
function askToSave(label: string): Promise<'save' | 'discard' | 'cancel'> {
	return new Promise((resolve) => {
		let settled = false;
		const settle = (value: 'save' | 'discard' | 'cancel') => {
			if (!settled) {
				settled = true;
				resolve(value);
			}
		};
		// The toast's own close button (or any other dismissal) also cancels.
		notify('warning', `Do you want to save the changes you made to ${label}? Your changes will be lost if you don't save them.`, [
			{ label: 'Save', run: () => settle('save') },
			{ label: "Don't Save", run: () => settle('discard') },
			{ label: 'Cancel', run: () => settle('cancel') }
		], () => settle('cancel'));
	});
}
