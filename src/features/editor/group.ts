// The EditorGroup class shell: fields, constructor and the group-lifetime methods
// stay here; every other method body lives in the concern files (open/tabs/
// breadcrumbs/navigate/dirty), typed against this class through ThisType and
// assigned onto the prototype by the module facade (index.ts) — one class, unchanged.

import type { EditorView } from '@codemirror/view';
import { loadMergeEditor, loadSnippetRegistry } from '../../platform/lazy';
import type { WsSymbol } from '../search/types';
import { SETTINGS_EVENT } from '../../platform/settings';
import { el, type MenuEntry } from '../../platform/ui/index';
import { editorState } from './editorState';
import type { Editor, EditorInput, NavEntry } from './inputs';

export class EditorGroup {
	static nextId = 1;

	readonly groupId = EditorGroup.nextId++;

	readonly container: HTMLElement;

	readonly tabs: HTMLElement;

	readonly breadcrumbs: HTMLElement;

	readonly editors: HTMLElement;

	readonly welcome: HTMLElement;

	readonly open: Editor[] = [];

	active: Editor | null = null;

	readonly mru: Editor[] = [];

	rootPath: string | null = null;

	readonly navHistory: NavEntry[] = [];

	navIndex = -1;

	navigating = false;

	openIntent = 0;

	showWelcome = true;

	locked = false;

	onToggleGroupLock: (() => void) | null = null;

	onActiveChange: ((editor: { kind: EditorInput['kind']; id?: string; path?: string; languageName?: string; encoding?: string; eol?: 'lf' | 'crlf'; line: number; column: number; selected?: number; selections?: number } | null) => void) | null = null;

	onNavigationChange: (() => void) | null = null;

	onTabsChange: (() => void) | null = null;

	onFileSaved: ((path: string) => void) | null = null;

	onDocumentEdited: ((path: string, text: () => string) => void) | null = null;

	onDocumentClosed: ((path: string) => void) | null = null;

	onSaveProgress: ((progress: { written: number; total: number } | null) => void) | null = null;

	readonly autoSaveTimers = new Map<string, number>();

	readonly backupTimers = new Map<string, number>();

	onMergeResolved: (() => void) | null = null;

	onExternalFileChange: (() => void) | null = null;

	welcomeRenderer: ((container: HTMLElement) => void) | null = null;

	set renderWelcome(renderer: ((container: HTMLElement) => void) | null) {
		this.welcomeRenderer = renderer;
		if (this.active === null) this.update();
	}

	get renderWelcome(): ((container: HTMLElement) => void) | null {
		return this.welcomeRenderer;
	}

	renderHelp: ((help: 'welcome' | 'shortcuts', container: HTMLElement) => void) | null = null;

	renderSelfTest: ((container: HTMLElement) => void) | null = null;

	renderProviders: ((container: HTMLElement) => void | (() => void)) | null = null;

	extOverlayHost: ((placeholder: HTMLElement) => { host: HTMLElement; dispose: () => void }) | null = null;

	onFocus: (() => void) | null = null;

	onEditorClosed: ((editor: Editor) => void) | null = null;

	onOpenPreviewToSide: ((path: string) => void) | null = null;

	onRunInTerminal: ((path: string) => void) | null = null;

	readonly onSettingsChange = (event: Event): void => {
		this.refreshOutlines();
		// The event's detail is the changed setting's key (a string).
		const key = (event as CustomEvent).detail;
		if (key !== 'tabSize' && key !== 'wordWrap' || !editorState.cm) return;
		for (const editor of this.open) {
			if (editor.view) editorState.cm.reconfigureEditorSettings(editor.view);
			if (editor.merge) {
				editorState.cm.reconfigureEditorSettings(editor.merge.a);
				editorState.cm.reconfigureEditorSettings(editor.merge.b);
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

	dispose(): void {
		document.removeEventListener(SETTINGS_EVENT, this.onSettingsChange);
	}

	setRoot(rootPath: string | null): void {
		this.rootPath = rootPath;
		this.navHistory.length = 0;
		this.navIndex = -1;
		// The workspace's `*.code-snippets` join the completion's snippet set.
		void loadSnippetRegistry().then((snippets) => snippets.loadWorkspaceSnippets(rootPath));
		this.onNavigationChange?.();
		this.update();
	}

	get activeInput(): EditorInput | null {
		return this.active?.input ?? null;
	}

	get activeEditor(): Editor | null {
		return this.active;
	}

	get activeView(): EditorView | null {
		return this.active?.view ?? null;
	}

	get seedableView(): EditorView | null {
		return this.active?.view ?? this.active?.doc?.editorView ?? null;
	}

	openEditorIds(): string[] {
		return this.open.map((e) => e.id);
	}

	openIdsOfKind(kind: EditorInput['kind']): string[] {
		return this.open.filter((e) => e.input.kind === kind).map((e) => e.id);
	}

	openTabInputs(): { id: string; input: EditorInput }[] {
		return this.open.map((e) => ({ id: e.id, input: e.input }));
	}

	openFilePaths(): string[] {
		return this.open.flatMap((e) => (e.input.kind === 'file' ? [e.input.path] : []));
	}

	declare saveAll: () => Promise<void> ;

	declare hasDirtyEditors: () => boolean ;

	contentSummary(): { path: string; dirty: boolean; active: boolean }[] {
		const out: { path: string; dirty: boolean; active: boolean }[] = [];
		for (const editor of this.open) {
			const input = editor.input;
			const path = input.kind === 'file' || input.kind === 'markdown' || input.kind === 'history' ? input.path : null;
			if (path) out.push({ path, dirty: editor.dirty, active: editor === this.active });
		}
		return out;
	}

	declare openContent: (input: Extract<EditorInput, { kind: 'content' }>) => Promise<void> ;

	declare openFile: (path: string, options?: { line?: number; column?: number; inactive?: boolean }) => Promise<void> ;

	declare tryMountFastView: (editor: Editor, parent?: HTMLElement, indexed?: boolean, onEdit?: () => void) => Promise<boolean>;

	declare tryMountDocEdit: (editor: Editor, parent?: HTMLElement) => Promise<boolean> ;

	declare swapFastToWholeEditor: (editor: Editor) => Promise<void> ;

	declare swapCanRawToText: (editor: Editor) => Promise<void> ;

	declare mountCanTextForm: (editor: Editor) => Promise<void> ;

	declare swapTextToCanRaw: (editor: Editor) => Promise<void> ;

	declare openHex: (path?: string) => Promise<void>;

	declare openCanStats: (path: string) => void ;

	declare mountHexView: (editor: Editor, parent?: HTMLElement) => Promise<void> ;

	declare mountImagePreview: (editor: Editor) => Promise<void> ;

	declare openMarkdownPreview: (path?: string) => Promise<void>;

	declare openFileHistory: (path?: string) => Promise<void>;

	declare toggleBlame: () => Promise<void> ;

	declare refreshPreviews: (path: string) => void ;

	readonly previewTimers = new Map<string, number>();

	declare refreshOutlines: () => void ;

	declare updateOutline: (editor: Editor) => void ;

	declare revealIn: (editor: Editor, line: number, column: number) => void ;

	declare onEdited: (editor: Editor) => void ;

	declare onWindowBlur: () => void ;

	declare onEditorBlur: (editor: Editor) => void ;

	declare restoreBackup: (path: string, contents: string) => Promise<boolean> ;

	declare reopenWithEncoding: (encoding: string) => Promise<void> ;

	declare saveWithEncoding: (encoding: string) => Promise<void> ;

	declare setEol: (eol: 'lf' | 'crlf') => void ;

	declare runEditorCommand: (command: 'undo' | 'redo' | 'selectAll' | 'find' | 'replace' | 'toggleLineComment' | 'toggleBlockComment') => void ;

	declare bufferAtSavedState: (editor: Editor) => boolean ;

	declare mountTextEditor: (editor: Editor, contents: string, parent?: HTMLElement) => Promise<void> ;

	declare openBinaryNoticeDiff: (input: Extract<EditorInput, { kind: 'diff' }>, intent?: number) => void ;

	declare openDiff: (input: Extract<EditorInput, { kind: 'diff' }>) => Promise<void> ;

	declare openLocalHexCompare: (left: string, right: string) => Promise<void> ;

	declare openHexCompare: (input: Extract<EditorInput, { kind: 'diff' }>, paths?: { left: string; right: string }, intent?: number) => Promise<void> ;

	declare openRevision: (revision: string, path: string, title: string, repo?: string) => Promise<void> ;

	declare openHelp: (help: 'welcome' | 'shortcuts') => void ;

	declare openSelfTest: () => void ;

	declare openProviders: () => void ;

	beginOpen(): number {
		return ++this.openIntent;
	}

	holdsIntent(intent: number | undefined): boolean {
		return intent === undefined || intent === this.openIntent;
	}

	declare add: (editor: Editor, activate?: boolean, intent?: number) => void;

	declare activateLast: () => void ;

	async attachMergeSupport(editor: Editor): Promise<void> {
		if (editor.input.kind !== 'file' || !editor.view) return;
		const { MergeToolbar } = await loadMergeEditor();
		const bar = el('div');
		editor.pane.prepend(bar);
		const toolbar = new MergeToolbar(bar);
		toolbar.onResolved = () => this.onMergeResolved?.();
		toolbar.attach(editor.view, editor.input.path);
		editor.mergeToolbar = toolbar;
	}

	declare openFolderCompare: (input: Extract<EditorInput, { kind: 'folders' }>) => Promise<void> ;

	declare openSymbolDatabase: () => Promise<void> ;

	declare openAnalysisPage: (
		tool: import('../analysis').AnalysisToolId,
		folders?: string[]
	) => Promise<void> ;

	declare openCallTree: (symbol: WsSymbol) => Promise<void> ;

	declare openExtPage: (
		input: Extract<EditorInput, { kind: 'extpage' }>,
		mount: (pane: HTMLElement) => (() => void) | void,
		iconSrc?: string | null
	) => Promise<void> ;

	declare openExtDetail: (
		input: Extract<EditorInput, { kind: 'extdetail' }>,
		mount: (pane: HTMLElement) => (() => void) | void
	) => void ;

	declare activate: (editor: Editor) => void ;

	declare canGoBack: () => boolean ;

	declare canGoForward: () => boolean ;

	declare goBack: () => void ;

	declare goForward: () => void ;

	declare navEntryOf: (editor: Editor) => NavEntry ;

	declare pushNav: (editor: Editor) => void ;

	declare navigate: (entry: NavEntry) => Promise<void> ;

	declare revealPosition: (view: EditorView, line: number, column: number) => void ;

	declare activateNext: (direction: 1 | -1) => void ;

	declare moveOut: (editor: Editor) => Editor | null ;

	declare forget: (editor: Editor) => void ;

	declare activateSuccessor: (editor: Editor, index: number) => void ;

	declare moveIn: (editor: Editor) => void ;

	declare findEditor: (id: string) => Editor | null ;

	declare activateById: (id: string) => void ;

	declare renameById: (id: string, title: string) => boolean ;

	declare setIconSrc: (id: string, iconSrc: string) => boolean ;

	declare hasEditor: (id: string) => boolean ;

	declare editorForPath: (path: string) => Editor | null ;

	declare fileViewFor: (path: string) => EditorView | null ;

	declare saveByPath: (path: string) => Promise<boolean> ;

	declare closeById: (id: string) => boolean ;

	declare close: (editor?: Editor) => Promise<void>;

	declare dirtyLabels: () => string[] ;

	declare settleDirty: (choice: 'save' | 'discard') => Promise<boolean> ;

	declare closeAll: () => Promise<boolean> ;

	declare closeOthers: (keep: Editor) => Promise<void> ;

	declare closeToTheRight: (from: Editor) => Promise<void> ;

	declare closeSaved: () => Promise<void> ;

	declare save: (editor?: Editor | null) => Promise<void>;

	declare flashSavedTab: (editor: Editor) => void ;

	declare forgetBackup: (editor: Editor) => void ;

	declare reloadIfClean: (path: string) => Promise<void> ;

	/** The §7.3 save conflict: the disk moved under this tab's unsaved changes — the bar
	 *  (compare / use disk / keep mine) shows until one of the three settles it. */
	declare markSaveConflict: (path: string) => Promise<void> ;
	declare renderSaveConflictBar: (editor: Editor, file: import('../../platform/ipc/fs').FileContents) => void ;
	declare clearSaveConflict: (editor: Editor) => void ;
	declare flashReloadedTab: (editor: Editor) => void ;

	declare pathRenamed: (from: string, to: string) => void ;

	declare pathDeleted: (path: string) => Promise<void> ;

	declare toggleBookmarkAt: (editor: Editor, line: number) => void ;

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
			id: this.active.id,
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

	declare tabMenu: (editor: Editor) => MenuEntry[] ;

	declare attachTextServices: (editor: Editor) => void ;

	declare textMenu: (editor: Editor, pos: number | null) => MenuEntry[] ;

	declare goToDefinition: (editor?: Editor | null, pos?: number | null) => Promise<void>;

	declare goToIndexedDefinition: (name: string, currentPath: string | null, view: EditorView) => Promise<boolean> ;

	declare pickDefinition: (defs: WsSymbol[], currentPath: string | null, view: EditorView) => Promise<boolean> ;

	declare jumpToDefinition: (target: WsSymbol, currentPath: string | null, view: EditorView) => Promise<boolean> ;

	declare findReferences: (editor?: Editor | null, pos?: number | null) => Promise<void>;

	declare openCallTreeAtCursor: (editor?: Editor | null, pos?: number | null) => Promise<void> ;

	declare gotoSymbolInFile: () => Promise<void> ;

	declare lineInfo: () => { line: number; column: number; lines: number } | null ;

	declare gotoLine: (line: number, column?: number) => void;

	declare cachedRead: (path: string) => Promise<string | null> ;

	declare renderTabs: () => void ;

	declare renderBreadcrumbs: () => void ;
}
