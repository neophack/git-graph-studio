// Git Graph Studio's workbench: the title bar (menus, command center, window controls), the
// activity bar, the side bar views (Explorer, Source Control), the editor group, the panel
// (terminal, output) and the status bar, wired together through the command registry - and
// the folder lifecycle (open / reopen last / close) that feeds them all.

import { Channel } from '../platform/ipc/core';
import { bootStage } from '../platform/ipc/app';
import { encodings, listFiles, readFile } from '../platform/ipc/fs';
import { workspaceSymbols } from '../platform/ipc/search';
import { symbolLookup, symbolsRebuild, type SymbolIndexEvent } from '../platform/ipc/symbols';
import { viewerClose, viewerOpen } from '../platform/ipc/viewer';
import { open as openDialog } from '@tauri-apps/plugin-dialog';

import { AnalysisView } from '../features/analysis';
import { commandForBinding, commands, effectiveBinding, setKeybindingResolver, UNSHIFTED_GLYPHS } from '../platform/commands';
import { registerDecorationType } from '../features/editor';
import { setExtensionCompletionProvider } from '../features/editor';
import { setExtensionDefinitionOpener, setExtensionDefinitionProvider, setExtensionHoverProvider } from '../features/editor';
import { languageIdFor } from '../features/extensions';
import { EditorArea } from '../features/editor';
import { ENCODING_LABELS } from '../features/editor';
import type { EditorPlacement } from '../features/editor/types';
import { Explorer } from '../features/explorer';
import { ExtensionHost, extTitle, type ExtInfo, type PageDiffRequest } from '../features/extensions';
import { ExtensionsPanel } from '../features/extensions';
import { clearBookmarks, listBookmarks, toggleBookmark } from '../features/editor';
import { effectiveKeybinding, loadUserKeybindings, renderKeybindingsEditor } from '../platform/keybindings';
import { Panel } from './panel';
import { SearchView } from '../features/search';
import { SourceControlView } from '../features/scm';
import { t } from '../platform/i18n';
import { hook } from '../platform/hooks';
import { SETTINGS_EVENT, settings, THEME_EVENT, updateSetting } from '../platform/settings';
import * as state from '../platform/state';
import { StatusBar } from './statusbar';
import { TitleBar } from './titlebar';
import { basename, busy, el, icon, notify, quickInput, quickPick, type QuickPickItem, type QuickPickSource } from '../platform/ui/index';
import { FilePickSource } from '../features/quickOpen';
import { ExtensionTreeView } from '../features/extensions';
import { extFileDataUrl } from '../platform/extAssets';

import type { MenuDefinition } from './titlebar';

export type ViewId = 'explorer' | 'search' | 'scm' | 'extensions' | 'analysis';

/** One debounced burst of external file changes, as the backend watcher reports it. */
export interface FsChange {
	/** The watched folder the batch came from (a batch from a just-closed folder is stale). */
	root: string;
	/** Changed working-tree paths, repo-relative with forward slashes. */
	paths: string[];
	/** More changed than `paths` lists. */
	truncated: boolean;
	/** Something under `.git/` changed. */
	gitChanged: boolean;
}

/** The backend watcher's event (main.rs `FS_CHANGED_EVENT`). */
export const FS_CHANGED_EVENT = 'studio://fs-changed';

/** The Finder "Open With" handoff's event (lib.rs `handle_opened`): folders and files macOS
 * asked the running app to open — the bundle's folder declaration and the file
 * associations. Only a booted workbench receives it; a handoff that wins the boot race
 * seeds the launch context instead and never crosses here. */
export const OPEN_PATHS_EVENT = 'studio://open-paths';

/** What [`OPEN_PATHS_EVENT`] carries. */
export interface OpenedPaths { folders: string[]; files: string[] }

/** The symbol index's progress event (cmd_symbols `SYMBOL_INDEX_EVENT`): what the status
 *  bar's "Indexing symbols n/m" item follows. */
export type { SymbolIndexEvent, SymbolIndexStatus } from '../platform/ipc/symbols';

/** How long after a refresh a git-only change batch is taken for that refresh's own echo. */
export const REFRESH_ECHO_MS = 1500;


/** Where the Workbench mounts its parts (docs/remote-client-plan.md §3.1): the desktop
 *  frame's own ids by default; the remote shell passes its own containers so the same
 *  services and widgets can live in its layouts without a desktop frame around them. */
export interface WorkbenchMounts {
	titlebar: HTMLElement;
	activitybar: HTMLElement;
	sidebar: HTMLElement;
	sidebarSash: HTMLElement;
	editorGroup: HTMLElement;
	panelSash: HTMLElement;
	panel: HTMLElement;
	statusbar: HTMLElement;
}

/** The desktop frame's mount points — the ids index.html (and remote.html's interim
 *  skeleton) carry. */
function desktopMounts(): WorkbenchMounts {
	return {
		titlebar: document.getElementById('titlebar')!,
		activitybar: document.getElementById('activitybar')!,
		sidebar: document.getElementById('sidebar')!,
		sidebarSash: document.getElementById('sidebarSash')!,
		editorGroup: document.getElementById('editorGroup')!,
		panelSash: document.getElementById('panelSash')!,
		panel: document.getElementById('panel')!,
		statusbar: document.getElementById('statusbar')!
	};
}

export class Workbench {
	public openFolders(): string[] {
		return this.explorer.roots();
	}

	static extPageSerial = 0;

	readonly extPageTabs = new Map<string, string>();

	readonly activityBar: HTMLElement;

	readonly sidebar: HTMLElement;

	readonly sidebarSash: HTMLElement;

	readonly editorPart: HTMLElement;

	readonly panelElement: HTMLElement;

	readonly panelSash: HTMLElement;

	readonly views: Record<ViewId, HTMLElement> = { explorer: el('div', 'view'), search: el('div', 'view'), scm: el('div', 'view'), extensions: el('div', 'view'), analysis: el('div', 'view') };

	readonly activityItems: Record<string, HTMLElement> = {};

	activitySpacer: HTMLElement | null = null;

	readonly extContainers = new Map<string, { element: HTMLElement; viewIds: string[] }>();

	extViewsShown = '';

	readonly extTreeViews = new Map<string, ExtensionTreeView>();

	readonly extBuiltinSections: HTMLElement[] = [];

	readonly extWebviewViewDisposers: (() => void)[] = [];

	readonly titleBar: TitleBar;

	readonly explorer: Explorer;

	readonly search: SearchView;

	readonly scm: SourceControlView;

	readonly extensions: ExtensionsPanel;

	readonly analysis: AnalysisView;

	readonly extensionHost: ExtensionHost;

	readonly editors: EditorArea;

	readonly panel: Panel;

	readonly statusBar: StatusBar;

	repoPath: string | null = null;

	isRepo = false;

	singleFile: string | null = null;

	folderShownStamped = false;

	repoPaths: string[] = [];

	workspaceFile: string | null = null;

	activeView: string = state.layout.activeView;

	refreshTimer: number | null = null;

	constructor(mounts: Partial<WorkbenchMounts> = {}) {
		const host: WorkbenchMounts = { ...desktopMounts(), ...mounts };
		this.activityBar = host.activitybar;
		this.sidebar = host.sidebar;
		this.sidebarSash = host.sidebarSash;
		this.editorPart = host.editorGroup.parentElement ?? document.getElementById('editorPart')!;
		this.panelElement = host.panel;
		this.panelSash = host.panelSash;
		for (const view of Object.values(this.views)) {
			view.style.display = 'none';
			view.style.flex = '1';
			view.style.minHeight = '0';
			view.style.flexDirection = 'column';
			this.sidebar.appendChild(view);
		}
		this.titleBar = new TitleBar(host.titlebar);
		this.explorer = new Explorer(this.views.explorer);
		this.search = new SearchView(this.views.search);
		this.scm = new SourceControlView(this.views.scm, commands);
		this.analysis = new AnalysisView(this.views.analysis);
		this.extensionHost = new ExtensionHost();
		// The SCM view's contributed entries (the graph button and the Gerrit actions) run
		// through the host like the palette's — with their menu arguments (the repository a
		// title button stands for, the right-clicked file a history filter names).
		this.scm.onExtensionCommand = (command, args) => void this.extensionHost.executeCommand(command, args ?? []);
				
		this.extensionHost.onContributionsApplied = () => {
			// Late (installed-at-runtime) contributions: the SCM title bar had already rendered
			// its manifest-declared buttons, so it renders again to pick them up. The context
			// menus build lazily at open time and the palette reads the registry on open.
			void this.scm.refresh();
		};
		// A theme switch re-reaches every open extension page (each re-reads its stylesheet).
		document.addEventListener(THEME_EVENT, this.onThemeChangedBound);
		this.extensions = new ExtensionsPanel(this.views.extensions, this.extensionHost);
		// A row's click opens the extension's detail page (VS Code's extension editor) in an
		// editor tab — the panel owns the page's content, the workbench owns the tab.
		this.extensions.onOpenDetail = (ext) => this.openExtensionDetail(ext);
		this.editors = new EditorArea(host.editorGroup);
		this.panel = new Panel(this.panelElement);
		this.statusBar = new StatusBar(host.statusbar);
		// The extension host's webview panels (`window.createWebviewPanel`) ride the same
		// editor-tab path the extension pages do; the status bar and Output view host its items
		// and channels. All wired here: the host owns the data, the views own the DOM.
		this.extensionHost.onOpenWebview = (panelId, title, extId, placement, focus) => this.openWebviewPanel(panelId, title, extId, placement, focus);
		this.extensionHost.onCloseWebviewTab = (tabId) => this.editors.closeById(tabId);
		this.extensionHost.onRevealWebviewTab = (tabId) => this.editors.revealById(tabId);
		this.extensionHost.onRenameWebviewTab = (tabId, title) => this.editors.renameById(tabId, title);
		this.extensionHost.onStatusBarItems = (items) => this.statusBar.setExtensionItems(items);
		this.statusBar.onExtensionCommand = (command, args) => void this.extensionHost.executeCommand(command, args ?? []);
		this.extensionHost.onOutputChannels = (channels) => this.panel.output.setExtensionChannels(channels);
		this.extensionHost.onOutputAppend = (extId, name, line) => this.panel.output.appendLine(name, line);
		this.extensionHost.onOutputClearChannel = (_extId, name) => this.panel.output.clearChannel(name);
		this.extensionHost.onOutputReveal = (_extId, name) => {
			this.panel.show('output');
			this.panel.output.showChannel(name);
		};
		// The extension-contributed sidebar surface: containers / views rebuild on every
		// install / uninstall, and a view's `onDidChangeTreeData` re-fetches just that tree.
		this.extensionHost.onViewsChanged = () => this.applyExtensionViews();
		this.extensionHost.onContextChanged = () => {
			if (this.visibleExtensionViews() !== this.extViewsShown) this.applyExtensionViews();
		};
		this.extensionHost.onTreeRefresh = (viewId) => this.extTreeViews.get(viewId)?.refresh();
		// The editor-facing vscode API: text edits land in an open CodeMirror editor, opens
		// go through the editor area, and the host pushes active-editor and save events.
		this.extensionHost.onApplyEdits = (path, edits) => this.editors.applyTextEdits(path, edits);
		// GGS-patch: extension decorations (editorDecorations.ts) — types register their
		// render options, setDecorations routes per document (null = the active editor).
		this.extensionHost.onDecorateType = (key, options) => registerDecorationType(key, options);
		this.extensionHost.onSetDecorations = (path, key, ranges) => this.editors.setExtensionDecorations(path, key, ranges);
		// GGS-patch: the extensions' completion providers feed the editor's completion UI
		// through the module bridge (see editorCompletions.ts).
		setExtensionCompletionProvider((path, languageId, text, line, character, triggerCharacter) => this.extensionHost.extensionCompletions(path, languageId, text, line, character, triggerCharacter));
		// GGS-patch: the extensions' hover and definition providers feed the editor's
		// hover tooltip and Go-to-Definition through the module bridge (editorHovers.ts).
		setExtensionHoverProvider((path, languageId, text, line, character) => this.extensionHost.extensionHover(path, languageId, text, line, character));
		setExtensionDefinitionProvider((path, languageId, text, line, character) => this.extensionHost.extensionDefinition(path, languageId, text, line, character));
		setExtensionDefinitionOpener({
			open: (path, line, character) => {
				// The same convention the frame host's onOpenFile uses (line 222): the
				// providers' VS Code 0-based position passes through as the tab's anchor.
				void this.editors.openFile(path, line !== undefined ? { line, column: character } : undefined);
			}
		});
		this.extensionHost.onOpenFile = (path, line, column, placement) => void this.editors.openFile(path, line !== undefined ? { line, column } : undefined, placement);
		this.extensionHost.activeText = () => this.editors.activeText();
		// `openTextDocument` reads an open editor's buffer, `TextDocument.save()` saves it,
		// and edits / closes reach the extensions as document events.
		this.extensionHost.documentText = (path) => this.editors.documentText(path);
		this.extensionHost.onSaveFile = (path) => this.editors.saveFile(path);
		this.editors.onDocumentEdited = (path, text) => this.extensionHost.noteDocumentChanged(path, text);
		this.editors.onDocumentClosed = (path) => this.extensionHost.noteDocumentClosed(path);
		this.extensionHost.onTreeMeta = (viewId, meta) => this.extTreeViews.get(viewId)?.setMeta(meta);
		// The page services a self-contained extension page acts through (the graph view's bridge
		// opens diffs and revisions, shows the SCM view, runs the terminal, and nudges the
		// workbench after its own writes — the delegate the graph page acts through).
		this.extensionHost.onOpenDiff = (diff: PageDiffRequest, placement) => void this.editors.openDiff({ kind: 'diff', ...diff }, placement);
		// The tab's id keys the DOCUMENT, not its label: the chat's read-only outputs and code
		// blocks are provider documents whose paths differ while their titles (basenames)
		// collide — an id keyed on the title would reveal the first tab for the second
		// document, showing the wrong content.
		this.extensionHost.onOpenContent = (title, path, text, placement) => void this.editors.openContent({ kind: 'content', id: `ext-content:${path || title}`, title, path, text }, placement);
		this.extensionHost.onOpenFileAtRevision = (revision, path, title, repo) => void this.editors.openRevision(revision, path, title, repo);
		this.extensionHost.onShowView = (id) => this.showView(id as never);
		this.extensionHost.onRevealTerminal = () => this.panel.show('terminal');
		this.extensionHost.onRunInTerminal = (command) => void this.panel.runInTerminal(command);
		this.extensionHost.onRepoChanged = () => this.scheduleRefresh(0);
		this.extensionHost.onForwardKey = (key) => document.dispatchEvent(new KeyboardEvent('keydown', key));

		// The user's keybindings (~/.ggs/keybindings.json) override the registry's defaults
		// everywhere a binding is matched or shown (M3 3.10).
		setKeybindingResolver((id) => effectiveKeybinding(id));
		void loadUserKeybindings();
		this.registerCommands();
		this.buildActivityBar();
		this.titleBar.setMenus(this.menus());
		// A language switch relabels the menus (and the settings dialog relabels itself); the Git
		// Graph view reloads so its "auto" interface language follows the new workbench locale.
		document.addEventListener(SETTINGS_EVENT, this.onSettingsChangedBound);
		// The platform class the styles key on (M7 7.1): macOS draws its own traffic lights
		// over the title bar and needs the left padding for them; its window buttons are
		// ours to hide. Linux and Windows keep the custom-drawn controls.
		if (/Mac/i.test(navigator.userAgent)) document.body.classList.add('mac');
		this.wire();
		this.applyLayout();
		// Cross-frontend operation sync (module 19, §22.7): once booted, every file this
		// workbench opens, closes or switches to — and every view it shows — crosses to the
		// other frontends of this instance (a phone running its own phone workbench while the
		// PC keeps the desktop UI) as one tiny message, and theirs land here. Silent until
		// boot() is through: the boot's own wiring is housekeeping, not a user operation.
		this.workbenchSync = hook('workbenchSync')(this);
		// The shell is up: the boot splash (index.html) has done its job of filling the
		// window while this module graph was still loading and parsing.
		document.getElementById('boot-splash')?.remove();
		// The title bar and menus are on screen: boot timing's last stamp.
		void bootStage('title bar + menus', performance.now()).catch(() => undefined);
	}

	get currentRepo(): string | null {
		return this.repoPath;
	}

	declare registerCommands: () => void ;

	declare menus: () => MenuDefinition[];

	async quickOpen(initial: string): Promise<void> {
		const chosen = await quickInput({
			value: initial,
			placeholder: t('quickopen.placeholder'),
			items: quickOpenItems(this.fileSource(), () => this.editors.lineInfo(), this.symbolSources())
		});
		if (!chosen) return;
		if (chosen.startsWith('command:')) await commands.execute(chosen.slice('command:'.length));
		else if (chosen.startsWith('line:')) {
			const [line, column] = chosen.slice('line:'.length).split(':').map(Number);
			this.editors.gotoLine(line!, column || 1);
		} else if (chosen.startsWith('sym:')) {
			// Quick Open's "#" mode: a workspace symbol, its path relative to its own root.
			const [path, line] = chosen.slice('sym:'.length).split('\u0000');
			const picked = path!;
			await this.editors.openFile(/^([a-zA-Z]:[\\/]|\\|\/)/.test(picked) || !this.repoPath ? picked : joinRepo(this.repoPath, picked), { line: Number(line) + 1 });
		} else if (chosen.startsWith('file:') && this.repoPath) {
			// Multi-root Quick Open hands out absolute paths; a plain folder's are repo-relative.
			const picked = chosen.slice('file:'.length);
			await this.editors.openFile(/^([a-zA-Z]:[\\/]|\\|\/)/.test(picked) ? picked : joinRepo(this.repoPath, picked));
		}
	}

	filePicks: FilePickSource | null = null;

	fileSource(): FilePickSource {
		if (!this.filePicks) {
			// A multi-root workspace concatenates its roots' lists as absolute paths, so the
			// picker's rows open directly; a plain folder keeps the repo-relative spelling and
			// lets the backend scorer answer (it only knows the first root's list, which is
			// why the workspace scans in the page instead).
			const multiRoot = this.repoPaths.length > 1;
			this.filePicks = new FilePickSource(async () => {
				if (multiRoot) {
					const lists = await Promise.all(this.repoPaths.map((root) => listFiles(root).catch(() => [] as string[])));
					return lists.flatMap((files, index) => files.map((file) => joinRepo(this.repoPaths[index]!, file)));
				}
				return listFiles().catch(() => [] as string[]);
			}, { backend: !multiRoot });
		}
		void this.filePicks.refresh();
		return this.filePicks;
	}

	fileSymbolsCache: { path: string; at: number; symbols: { name: string; kind: string; line: number }[] } | null = null;

	workspaceSymbolsCache: { at: number; symbols: { name: string; kind: string; path: string; line: number }[] } | null = null;

	symbolSources() {
		return {
			fileSymbols: async () => {
				const input = this.editors.activeInput;
				const path = input?.kind === 'file' ? input.path : null;
				if (!path) return [];
				if (this.fileSymbolsCache && this.fileSymbolsCache.path === path && Date.now() - this.fileSymbolsCache.at < 5000) {
					return this.fileSymbolsCache.symbols;
				}
				let symbols: { name: string; kind: string; line: number }[] = [];
				try {
					const info = await viewerOpen(path);
					symbols = info.symbols ?? [];
					await viewerClose(info.docId).catch(() => undefined);
				} catch {
					symbols = [];
				}
				this.fileSymbolsCache = { path, at: Date.now(), symbols };
				return symbols;
			},
			workspaceSymbols: async () => {
				if (this.workspaceSymbolsCache && Date.now() - this.workspaceSymbolsCache.at < 30000) return this.workspaceSymbolsCache.symbols;
				let symbols: { name: string; kind: string; path: string; line: number }[] = [];
				try {
					// A multi-root workspace indexes each root; a symbol's path is relative to its own.
					const roots = this.repoPaths.length > 1 ? this.repoPaths : [null];
					const perRoot = await Promise.all(roots.map((root) => workspaceSymbols('', 10000, root)));
					symbols = perRoot.flatMap((list, index) => (list ?? []).map((symbol) => ({ ...symbol, path: roots[index] ? joinRepo(roots[index]!, symbol.path) : symbol.path })));
				} catch {
					symbols = [];
				}
				this.workspaceSymbolsCache = { at: Date.now(), symbols };
				return symbols;
			}
		};
	}

	async rebuildSymbolIndex(): Promise<void> {
		busy(true);
		try {
			const onEvent = new Channel<SymbolIndexEvent>();
			onEvent.onmessage = (event) => {
				if (event.kind === 'progress') this.statusBar.setSymbols({ state: 'building', done: event.done, total: event.total, files: 0, symbols: 0 });
			};
			// The rebuild's resolved status is the answer — take it over the last progress
			// event: the channel's events carry done/total only, so leaving the item at
			// its last "building N/N" stranded the counter until some later event happened
			// to repaint it.
			const status = await symbolsRebuild(onEvent);
			if (status) this.statusBar.setSymbols(status);
			notify('info', t('symbols.rebuildDone'));
		} catch (error) {
			notify('error', String(error));
		} finally {
			busy(false);
		}
	}

	scmChangeCount = 0;

	setScmBadge(count: number): void {
		this.scmChangeCount = count;
		const item = this.activityItems['scm'];
		if (!item) return;
		item.querySelector('.badge')?.remove();
		if (count > 0) item.appendChild(el('span', 'badge', [count > 999 ? '999+' : String(count)]));
	}

	declare buildActivityBar: () => void ;

	declare applyLayout: () => void ;

	declare installSash: (sash: HTMLElement, axis: 'horizontal' | 'vertical', onMove: (delta: number, start: number) => void, startValue: () => number) => void ;

	declare isExtensionView: (view: string) => boolean ;

	declare showView: (view: ViewId | string, focus?: boolean) => void;

	lastVisibleExtViews: string[] = [];

	seedSearchQuery(): void {
		const view = this.editors.seedableView;
		if (!view) return;
		const selection = view.state.selection.main;
		if (!selection.empty && view.state.doc.lineAt(selection.from).number === view.state.doc.lineAt(selection.to).number) {
			this.search.seedQuery(view.state.sliceDoc(selection.from, selection.to));
			return;
		}
		const word = view.state.wordAt(selection.head);
		if (word) this.search.seedQuery(view.state.sliceDoc(word.from, word.to));
	}

	get sidebarShown(): boolean {
		return state.layout.sidebarVisible;
	}

	get activeSidebarView(): string {
		return this.activeView;
	}

	declare toggleView: (view: ViewId | string) => void ;

	declare toggleSidebar: () => void ;

	declare visibleExtensionViews: () => string ;

	declare applyExtensionViews: () => void ;

	async formatActiveDocument(): Promise<void> {
		const input = this.editors.activeInput;
		if (input?.kind !== 'file') return;
		const path = input.path;
		const text = this.editors.activeText();
		if (text === null) return;
		const languageId = languageIdFor(path) ?? 'plaintext';
		const formatted = await this.extensionHost.formatDocument(path, languageId, text, 4, true);
		if (!formatted) notify('info', t('editor.noFormatter'));
	}

	async runPythonFile(path: string): Promise<void> {
		this.panel.show('terminal');
		const python = /^win/i.test(navigator.platform ?? '') ? 'python' : 'python3';
		await this.panel.terminal.run(`${python} "${path.replace(/"/g, '\\"')}"`);
	}

	openWebviewPanel(panelId: number, title: string, extId: string, placement?: EditorPlacement, focus?: boolean): void {
		// The tab opens at once — the open must not wait on the package icon's read: the
		// extension may act on the group the panel lands in the moment the create returns
		// (claude-code locks the column its chat just opened in), and a delayed open would
		// leave that act aiming at whatever group was focused before. The icon joins the
		// existing tab when its data URL arrives; until then the tab wears the globe.
		this.editors.openExtPage(
			{ kind: 'extpage', id: this.extensionHost.webviewTabId(extId, panelId), title, extId, pageId: 'webview' },
			(pane) => this.extensionHost.mountWebview(extId, panelId, pane),
			null,
			placement,
			focus
		);
		const iconPath = this.extensionHost.packageIcon(extId);
		if (iconPath) {
			void extFileDataUrl(extId, iconPath)
				.catch(() => null)
				.then((iconSrc) => {
					if (iconSrc) this.editors.setIconSrc(this.extensionHost.webviewTabId(extId, panelId), iconSrc);
				});
		}
	}

	openExtensionDetail(ext: ExtInfo): void {
		this.editors.openExtDetail(
			{ kind: 'extdetail', id: `extdetail:${ext.id}`, title: extTitle(ext), extId: ext.id },
			(pane) => this.extensions.mountDetail(ext, pane)
		);
	}

	async compareFolders(): Promise<void> {
		const left = await openDialog({ directory: true, multiple: false, title: 'Choose the left folder' });
		if (!left) return;
		const right = await openDialog({ directory: true, multiple: false, title: 'Choose the right folder' });
		if (!right) return;
		const leftPath = Array.isArray(left) ? left[0]! : left;
		const rightPath = Array.isArray(right) ? right[0]! : right;
		this.editors.openFolderCompare({
			kind: 'folders',
			id: `${leftPath}::${rightPath}`,
			left: leftPath,
			right: rightPath
		});
	}

	async gotoWorkspaceSymbol(): Promise<void> {
		if (!this.repoPath) return;
		let symbols: { kind: string; name: string; path: string; line: number }[];
		try {
			// A multi-root workspace indexes each root; a symbol's path is relative to its own.
			const roots = this.repoPaths.length > 1 ? this.repoPaths : [null];
			const perRoot = await Promise.all(roots.map((root) => workspaceSymbols('', 10000, root)));
			symbols = perRoot.flatMap((list, index) => (list ?? []).map((symbol) => ({ ...symbol, path: roots[index] ? joinRepo(roots[index]!, symbol.path) : symbol.path })));
		} catch (error) {
			notify('error', String(error));
			return;
		}
		if (symbols.length === 0) {
			notify('info', 'The workspace symbol index is empty for this folder.');
			return;
		}
		const chosen = await quickInput({
			placeholder: 'Go to symbol in workspace',
			items: (query) => {
				const q = query.toLowerCase();
				return symbols
					.filter((s) => s.name.toLowerCase().includes(q))
					.slice(0, 60)
					.map((s) => ({ label: s.name, description: s.path, detail: `${s.kind} — line ${s.line + 1}`, icon: 'symbol-method', value: `${s.path}\u0000${s.line}` }));
			}
		});
		if (!chosen) return;
		const [path, line] = chosen.split('\u0000');
		const picked = path!;
		void this.editors.openFile(/^([a-zA-Z]:[\\/]|\\|\/)/.test(picked) || !this.repoPath ? picked : joinRepo(this.repoPath, picked), { line: Number(line) + 1 });
	}

	toggleBookmark(): void {
		const input = this.editors.activeInput;
		if (input?.kind !== 'file') return;
		const view = this.editors.activeView;
		if (!view) return;
		const line = view.state.doc.lineAt(view.state.selection.main.head).number;
		toggleBookmark(input.path, line);
		// A selection-only update re-runs the gutter markers.
		view.dispatch({ selection: { anchor: view.state.selection.main.head } });
	}

	async listBookmarks(): Promise<void> {
		const bookmarks = listBookmarks();
		if (bookmarks.length === 0) {
			notify('info', 'No bookmarks yet. Right-click a line (or Ctrl+Alt+B) to add one.');
			return;
		}
		const chosen = await quickPick(
			[
				...bookmarks.map((mark) => ({ label: `${basename(mark.path)}:${mark.line}`, description: mark.path, icon: 'bookmark', value: `${mark.path}\u0000${mark.line}` })),
				{ label: 'Clear All Bookmarks', icon: 'clear-all', value: '\u0000clear' }
			],
			'Jump to a bookmark',
			'Bookmarks'
		);
		if (!chosen) return;
		const [path, line] = chosen.split('\u0000');
		if (line === 'clear') {
			clearBookmarks();
			notify('info', 'All bookmarks were cleared.');
			return;
		}
		void this.editors.openFile(path!, { line: Number(line) });
	}

	declare wire: () => void ;

	declare keepRunningHidden: () => Promise<boolean> ;

	contextTimer: number | null = null;

	readonly onThemeChangedBound = () => this.extensionHost.noteThemeChanged();

	contextGeneration = 0;

	followContextSymbol(editor: { kind: string; path?: string; line: number; column: number } | null): void {
		// The view only follows while it is the one being looked at (or pinned to a symbol);
		// anything else leaves it as it is - never a background query per keystroke.
		if (!this.panel.context.isPinned() && this.panel.activeView() !== 'context') return;
		if (this.contextTimer !== null) window.clearTimeout(this.contextTimer);
		const generation = ++this.contextGeneration;
		this.contextTimer = window.setTimeout(() => {
			this.contextTimer = null;
			if (generation !== this.contextGeneration) return;
			void this.resolveContextSymbol(editor);
		}, 150);
	}

	async resolveContextSymbol(editor: { kind: string; path?: string; line: number; column: number } | null): Promise<void> {
		const view = this.editors.activeView;
		if (!editor || editor.kind !== 'file' || !view || !this.repoPath) {
			this.panel.context.show(null);
			return;
		}
		const line = view.state.doc.line(Math.min(Math.max(1, editor.line), view.state.doc.lines));
		const at = Math.min(Math.max(line.from, line.from + editor.column - 1), line.to);
		const word = view.state.wordAt(at);
		if (!word) {
			this.panel.context.show(null);
			return;
		}
		const name = view.state.sliceDoc(word.from, word.to);
		let defs: { kind: string; name: string; path: string; line: number }[] = [];
		try {
			defs = (await symbolLookup(name)) ?? [];
		} catch {
			defs = [];
		}
		if (defs.length !== 1) {
			this.panel.context.show(null, defs.length > 1 ? `${defs.length} ${t('symbols.context.ambiguous')}` : undefined);
			return;
		}
		const def = defs[0]!;
		const absolute = /^([a-zA-Z]:[\\/]|\\|\/)/.test(def.path) ? def.path : joinRepo(this.repoPath, def.path);
		let fragment = '';
		try {
			const file = await readFile(absolute);
			const lines = (file?.contents ?? '').split('\n');
			const from = Math.max(0, def.line - 2);
			// The declaration and what follows it, until the column-0 brace that closes it.
			let to = Math.min(lines.length, def.line + 80);
			for (let i = def.line + 1; i < Math.min(lines.length, def.line + 80); i++) {
				if (lines[i] === '}') { to = i + 1; break; }
			}
			fragment = lines.slice(from, to).join('\n');
		} catch {
			fragment = '';
		}

		this.panel.context.show({ kind: def.kind, name: def.name, path: absolute, line: def.line, fragment });

	}

	/** F6 (M7 7.4): cycle the keyboard through the workbench's parts - activity bar, side
	 *  bar, editor, panel - starting from the one that holds the focus. */
	focusNextPart(): void {

		const parts: (() => boolean)[] = [
			() => {
				const first = this.activityBar.querySelector<HTMLElement>('.activity-item');
				first?.focus();
				return document.activeElement === first;
			},

			() => {
				this.showView(this.activeView);
				const body = this.sidebar.querySelector<HTMLElement>('.view-pane:not([hidden]) [tabindex]');
				body?.focus();
				return !!body && document.activeElement === body;
			},

			() => {
				this.editors.focusActiveEditor();
				return this.editors.activeView !== null;
			},

			() => {
				if (!this.panel.isVisible()) this.panel.show('terminal');
				this.panel.terminal.focus();
				return true;
			}

		];
		const holds = (element: HTMLElement | null): boolean => !!element && (this.activityBar.contains(element) || this.sidebar.contains(element) || this.editorPart.contains(element) || this.panelElement.contains(element));
		const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		let start = 0;
		if (active && holds(active)) {
			if (this.editorPart.contains(active) && !this.panelElement.contains(active)) start = 2;
			else if (this.panelElement.contains(active)) start = 3;
			else if (this.sidebar.contains(active)) start = 1;
			else start = 0;
		}

		for (let step = 1; step <= parts.length; step++) {
			if (parts[(start + step) % parts.length]!()) return;
		}

	}

	/** Keybindings: the registry's, except the editing ones CodeMirror handles themselves. */
	chordPending: string | null = null;

	readonly onKeyDownBound = (event: KeyboardEvent): void => this.onKeyDown(event);

	readonly onWindowFocusBound = (): void => this.scheduleRefresh(0);

	readonly onWindowBlurBound = (): void => this.editors.onWindowBlur();

	readonly onSettingsChangedBound = (event: Event): void => {
		this.titleBar.setMenus(this.menus());
	};

	unlisteners: (() => void)[] = [];

	disposed = false;

	workbenchSync: { start(): void; localOnly(local: boolean): void; noteWindowHidden(): void; detach(): void } | null = null;

	trackUnlisten(unlisten: () => void): void {
		if (this.disposed) unlisten();
		else this.unlisteners.push(unlisten);
	}

	declare dispose: () => void ;

	onKeyDown(event: KeyboardEvent): void {
		if (this.chordPending) {
			// A modifier going down on its own (the Ctrl of "Ctrl+K Ctrl+S") is not the
			// chord's second key yet.
			if (['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)) return;
			const chord = this.chordPending;
			this.chordPending = null;
			// Escape cancels the chord outright (VS Code's behaviour), not "Ctrl+K Escape".
			if (event.key === 'Escape') return;
			// The second key is spelled the way bindings spell keys ("Left", not "ArrowLeft";
			// the unshifted glyph behind a shifted one), with every modifier, so a user chord
			// such as "Ctrl+K Alt+Left" resolves like a single-key binding does.
			const key = event.shiftKey ? (UNSHIFTED_GLYPHS[event.key] ?? event.key) : event.key;
			const named = key.replace(/^Arrow/, '');
			const spelled = named.length === 1 ? named.toUpperCase() : named === ' ' ? 'Space' : named;
			const full = `${chord} ${event.ctrlKey || event.metaKey ? 'Ctrl+' : ''}${event.shiftKey ? 'Shift+' : ''}${event.altKey ? 'Alt+' : ''}${spelled}`;
			const command = commandForBinding(full);
			if (command) {
				event.preventDefault();
				void commands.execute(command.id);
			}
			return;
		}
		if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k' && !event.shiftKey && !event.altKey) {
			event.preventDefault();
			this.chordPending = 'Ctrl+K';
			return;
		}
		// A keydown can arrive with `document` itself as the target (no focused element): it has
		// no `closest` - and no editor focus either, so a null target is not "in an editor".
		const target = event.target instanceof HTMLElement ? event.target : null;
		const inEditor = target !== null && target.closest('.cm-editor, input, textarea') !== null;
		const command = commands.forKeyEvent(event);
		if (!command) return;
		// Text editing keys stay with the focused editor / input.
		if (inEditor && ['editor.undo', 'editor.redo', 'editor.cut', 'editor.copy', 'editor.paste', 'editor.selectAll', 'editor.find', 'editor.replace'].includes(command.id)) return;
		event.preventDefault();
		void commands.execute(command.id);
	}

	async pickEncoding(): Promise<void> {
		const input = this.editors.activeInput;
		if (input?.kind !== 'file') return;
		const action = await quickPick([
			{ label: 'Reopen with Encoding', description: 'Reopen the file decoding it differently', value: 'reopen' },
			{ label: 'Save with Encoding', description: 'Write the file in another encoding from now on', value: 'save' }
		], 'Select Action', basename(input.path));
		if (!action) return;
		const list = await encodings().catch(() => Object.entries(ENCODING_LABELS));
		const encoding = await quickPick(list.map(([id, label]) => ({ label, value: id })), 'Select File Encoding' + (action === 'reopen' ? ' to Reopen File' : ' to Save with'));
		if (!encoding) return;
		if (action === 'reopen') await this.editors.reopenWithEncoding(encoding);
		else await this.editors.saveWithEncoding(encoding);
	}

	async pickIndent(): Promise<void> {
		const chosen = await quickPick([
			{ label: 'Indent Using Spaces', description: 'The tab size applies to every editor', value: 'header' },
			...[2, 4, 8].map((size) => ({ label: String(size), description: settings.tabSize === size ? 'current' : undefined, value: String(size) }))
		], 'Select Indentation', 'Indentation');
		if (chosen === '2' || chosen === '4' || chosen === '8') updateSetting('tabSize', Number(chosen));
	}

	async pickEol(): Promise<void> {
		if (this.editors.activeInput?.kind !== 'file') return;
		const eol = await quickPick([{ label: 'LF', description: 'Unix', value: 'lf' }, { label: 'CRLF', description: 'Windows', value: 'crlf' }], 'Select End of Line Sequence');
		if (eol === 'lf' || eol === 'crlf') this.editors.setEol(eol);
	}

	snapshotTimer: number | null = null;

	restoring = false;

	declare scheduleSnapshot: () => void ;

	declare saveSnapshot: () => void ;

	declare restoreSnapshot: (root: string, snapshot: state.WorkspaceSnapshot) => Promise<void> ;

	declare onFsChanged: (change: FsChange) => void ;

	lastRefreshAt = -Infinity;

	recheckInFlight = false;

	declare recheckSwallowedBatch: () => void ;

	hiddenRefreshQueued = false;

	declare scheduleRefresh: (delay: number) => void ;

	declare runScheduledRefresh: () => void ;

	declare openFolder: (path: string) => Promise<void> ;

	declare openFolderSettled: (path: string) => Promise<void> ;

	declare settleOutgoing: () => Promise<boolean> ;

	declare openRecent: (path: string) => Promise<void> ;

	declare onOpenPaths: (payload: OpenedPaths) => Promise<void> ;

	declare pickFolder: () => Promise<void> ;

	declare pickWorkspace: () => Promise<void> ;

	declare pickSingleFile: () => Promise<void> ;

	declare openFileStandalone: (path: string) => Promise<void> ;

	declare openWorkspace: (path: string) => Promise<void> ;

	declare applyRoots: (roots: string[], anyRepo: boolean, workspaceFile: string | null) => Promise<void> ;

	declare initializeRepository: () => Promise<void> ;

	declare closeFolder: () => Promise<void> ;

	renderWelcome(container: HTMLElement): void {
		const inner = el('div', 'welcome-inner');
		const logo = el('img');
		logo.src = import.meta.env.BASE_URL + 'icons/icon.png';
		logo.alt = '';
		inner.appendChild(el('div', 'welcome-header', [
			logo,
			el('div', '', [el('h1', '', ['Git Graph Studio']), el('p', '', ['View a Git repository as a graph, browse and edit its files, stage and commit - in one window.'])])
		]));

		const link = (iconName: string, label: string, description: string | null, run: () => void) => {
			const anchor = el('a', 'link', [icon(iconName), el('span', '', [label]), description ? el('span', 'description', [description]) : null]);
			anchor.addEventListener('click', run);
			return anchor;
		};
		const start = el('div', '', [el('h2', '', ['Start'])]);
		start.appendChild(link('folder-opened', 'Open Folder...', null, () => void this.pickFolder()));
		start.appendChild(link('repo-clone', 'Clone Git Repository...', null, () => void commands.execute('git.clone')));
		if (this.repoPath) {
			start.appendChild(link('source-control', 'Source Control', null, () => this.showView('scm')));
			start.appendChild(link('terminal', 'New Terminal', null, () => this.panel.show('terminal')));
			start.appendChild(link('close', 'Close Folder', null, () => void this.closeFolder()));
		}
		inner.appendChild(start);

		const recent = el('div', '', [el('h2', '', ['Recent'])]);
		const folders = state.recentFolders().filter((f) => f !== this.repoPath);
		if (folders.length === 0) {
			recent.appendChild(el('p', 'empty', ['No recent folders']));
		} else {
			for (const folder of folders) recent.appendChild(link('folder', basename(folder), folder, () => void this.openRecent(folder)));
		}
		inner.appendChild(recent);

		const help = el('div', '', [el('h2', '', ['Keyboard Shortcuts'])]);
		for (const id of ['workbench.quickOpen', 'workbench.commandPalette', 'workbench.openFolder', 'workbench.toggleSidebar', 'workbench.showExplorer', 'workbench.showScm', 'terminal.toggle', 'workbench.save', 'workbench.closeEditor', 'editor.find']) {
			const command = commands.get(id)!;
			help.appendChild(el('div', 'shortcut', [el('span', '', [command.title]), el('kbd', '', [effectiveBinding(id, command.keybinding) ?? ''])]));
		}
		inner.appendChild(help);
		container.appendChild(inner);
	}

	renderShortcuts(container: HTMLElement): void {
		// The pane takes the keyboard focus itself, so the recorder's keydown listener (on the
		// container) hears the keystroke that becomes the new binding.
		container.tabIndex = 0;
		renderKeybindingsEditor(container);
		container.focus();
	}

	declare boot: () => Promise<void> ;

	declare bootInner: () => Promise<void> ;

	declare recoverBackups: () => Promise<void> ;

}

export function whenIdle(work: () => void, timeoutMs = 2000): void {
	if (typeof requestIdleCallback === 'function') requestIdleCallback(() => work(), { timeout: timeoutMs });
	else work();
}

export function joinRepo(root: string, relative: string): string {
	const separator = root.includes('\\') ? '\\' : '/';
	return root.replace(/[\\/]+$/, '') + separator + relative.replaceAll('/', separator);
}

/** Quick Open's modes in one source, as VS Code switches them: a leading ">" filters the
 *  command palette (a small list, filtered in place), a leading ":" is Go to Line/Column
 *  (the picker's one row narrates the jump), "@" is Go to Symbol in File and "#" Go to
 *  Symbol in Workspace (M4 4.9); anything else goes to the chunked file scan, including
 *  mid-session - backspacing out of a prefix returns to files. */
export interface SymbolSources {
	fileSymbols(): Promise<{ name: string; kind: string; line: number }[]>;
	workspaceSymbols(): Promise<{ name: string; kind: string; path: string; line: number }[]>;
}

function quickOpenItems(files: FilePickSource, lineInfo: () => { line: number; column: number; lines: number } | null, symbols: SymbolSources): QuickPickSource {
	return {
		query: async (query, onPartial, isCancelled) => {
			if (query.startsWith(':')) return gotoLineItems(query.slice(1), lineInfo());
			if (query.startsWith('@')) return fileSymbolItems(query.slice(1), await symbols.fileSymbols());
			if (query.startsWith('#')) return workspaceSymbolItems(query.slice(1), await symbols.workspaceSymbols());
			if (!query.startsWith('>')) return files.query(query, onPartial, isCancelled);
			const q = query.slice(1).trim().toLowerCase();
			const items = commands.paletteItems()
				.filter((command) => command.label.toLowerCase().includes(q))
				.map((command) => ({ ...command, value: 'command:' + command.value }))
				.slice(0, 60);
			return items;
		}
	};
}

/** The "@" mode's rows: the file's outline filtered by name; a pick jumps by line (the
 *  picker's `line:` dispatch already lands in the active editor). */
export function fileSymbolItems(typed: string, symbols: { name: string; kind: string; line: number }[]): QuickPickItem[] {
	if (symbols.length === 0) return [{ label: t('quickopen.noSymbols'), value: '' }];
	const q = typed.trim().toLowerCase();
	return symbols
		.filter((symbol) => symbol.name.toLowerCase().includes(q))
		.slice(0, 60)
		.map((symbol) => ({ label: symbol.name, description: symbol.kind, icon: 'symbol-method', value: `line:${symbol.line + 1}` }));
}

/** The "#" mode's rows: the whole workspace's declarations; a pick opens the file at the
 *  declaration (the `sym:` dispatch absolutises the path like Ctrl+T does). */
export function workspaceSymbolItems(typed: string, symbols: { name: string; kind: string; path: string; line: number }[]): QuickPickItem[] {
	if (symbols.length === 0) return [{ label: t('quickopen.noWorkspaceSymbols'), value: '' }];
	const q = typed.trim().toLowerCase();
	return symbols
		.filter((symbol) => symbol.name.toLowerCase().includes(q))
		.slice(0, 60)
		.map((symbol) => ({ label: symbol.name, description: symbol.path, icon: 'symbol-method', value: `sym:${symbol.path}\u0000${symbol.line}` }));
}

/** The single row of Go to Line/Column, worded as VS Code words it: the cursor position and
 *  the valid range until a number is typed, then the jump the typed "line[:column]" makes. */
export function gotoLineItems(typed: string, info: { line: number; column: number; lines: number } | null): QuickPickItem[] {
	if (!info) return [{ label: 'Open a text editor first to go to a line.', value: '' }];
	const match = /^\s*(\d+)?(?:[:,](\d+)?)?\s*$/.exec(typed);
	const line = match?.[1] ? Number(match[1]) : null;
	const column = match?.[2] ? Number(match[2]) : null;
	if (line === null || !match) {
		return [{ label: `Current Line: ${info.line}, Character: ${info.column}. Type a line number between 1 and ${info.lines} to navigate to.`, value: '' }];
	}
	const target = Math.max(1, Math.min(info.lines, line));
	const label = column !== null
		? `Go to line ${target} and character ${column}.`
		: `Go to line ${target}.`;
	return [{ label, value: `line:${target}:${column ?? 1}` }];
}

/** Quote a path for a `cd` typed into the integrated shell. Single quotes are literal in
 *  PowerShell (the Windows shell the terminal spawns) and in POSIX shells alike - a double-
 *  quoted `$` or backtick would be expanded by PowerShell, and backslash-escaping it is a
 *  POSIX-only spelling. The quote itself is doubled for PowerShell, closed-escaped-reopened
 *  for POSIX; a Windows path (a backslash or a drive) tells the two apart. */
export function quoteShellPath(path: string): string {
	if (/^[\w./:\\-]+$/.test(path)) return path;
	const windows = path.includes('\\') || /^[a-zA-Z]:/.test(path);
	return `'${windows ? path.replaceAll("'", "''") : path.replaceAll("'", "'\\''")}'`;
}

/** The booted instance — the dev harness reaches the self-test suites through it
 *  (`registerSelfTestSuites` wants the live workbench; a second boot is not one). */
export let currentWorkbench: Workbench | null = null;

export function bootWorkbench(): Promise<void> {
	const workbench = new Workbench();
	currentWorkbench = workbench;
	return workbench.boot();
}
