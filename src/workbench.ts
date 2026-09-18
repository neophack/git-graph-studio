// Git Graph Studio's workbench: the title bar (menus, command center, window controls), the
// activity bar, the side bar views (Explorer, Source Control), the editor group, the panel
// (terminal, output) and the status bar, wired together through the command registry - and
// the folder lifecycle (open / reopen last / close) that feeds them all.

import { invoke, Channel } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { openUrl } from '@tauri-apps/plugin-opener';

import { AnalysisView, type AnalysisStatus } from './analysisView';
import type { AnalysisToolId } from './analysisTools';
import { commandForBinding, commands, effectiveBinding, setKeybindingResolver, UNSHIFTED_GLYPHS } from './commands';
import { registerContextProvider } from './contributions';
import { EditorArea } from './editorArea';
import { ENCODING_LABELS } from './editor';
import { Explorer } from './explorer';
import { ExtensionHost, GIT_GRAPH_RS_EXT_ID } from './extHost';
import { ExtensionsPanel } from './extensionsPanel';
import { registerGitCommands } from './gitCommands';
import { GraphHost } from './graphHost';
import { clearBookmarks, listBookmarks, toggleBookmark } from './bookmarks';
import { effectiveKeybinding, loadUserKeybindings, renderKeybindingsEditor } from './keybindings';
import { Panel } from './panel';
import { SearchView } from './searchView';
import { SourceControlView } from './scm';
import { t } from './i18n';
import { openSettingsPanel } from './settingsPanel';
import { SETTINGS_EVENT, settings, updateSetting } from './settings';
import * as state from './state';
import { StatusBar } from './statusbar';
import { TitleBar } from './titlebar';
import { basename, busy, el, icon, notify, quickInput, quickPick, relativeTo, toPosix, tooltip, type MenuEntry, type QuickPickItem, type QuickPickSource } from './ui';
import { FilePickSource } from './filePicker';

type ViewId = 'explorer' | 'search' | 'scm' | 'extensions' | 'analysis';

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

/** The symbol index's progress event (cmd_symbols `SYMBOL_INDEX_EVENT`): what the status
 *  bar's "Indexing symbols n/m" item follows. */
export interface SymbolIndexStatus {
	state: 'empty' | 'building' | 'ready';
	done: number;
	total: number;
	files: number;
	symbols: number;
}

/** What `symbols_rebuild` pushes over its channel before the final answer. */
export type SymbolIndexEvent = { kind: 'progress'; done: number; total: number } | { kind: 'done'; files: number; symbols: number; cancelled: boolean };

/** How long after a refresh a git-only change batch is taken for that refresh's own echo. */
const REFRESH_ECHO_MS = 1500;

/** The manifest's scm/title commands (git-graph-rs.amendLastCommit and friends) that keep their
 *  working implementation under gitCommands.ts's own `gitGraph.*` ids - keyed by the manifest's
 *  English command id (its `.zhCn` sibling shares the same implementation; see the constructor
 *  and contributions.ts's `git-graph-rs:interfaceZhCn` provider, which picks whichever of the
 *  pair the scm/title menu actually shows). */
const GIT_GRAPH_RS_SCM_COMMANDS: Record<string, string> = {
	'git-graph-rs.amendLastCommit': 'gitGraph.amendLastCommit',
	'git-graph-rs.gerritFetchCommitMsgHook': 'gitGraph.gerritFetchCommitMsgHook',
	'git-graph-rs.resetCurrentBranchToRemote': 'gitGraph.resetCurrentBranchToRemote',
	'git-graph-rs.gerritPushRef': 'gitGraph.gerritPushRef'
};

export class Workbench {
	private readonly activityBar = document.getElementById('activitybar')!;
	private readonly sidebar = document.getElementById('sidebar')!;
	private readonly sidebarSash = document.getElementById('sidebarSash')!;
	private readonly editorPart = document.getElementById('editorPart')!;
	private readonly panelElement = document.getElementById('panel')!;
	private readonly panelSash = document.getElementById('panelSash')!;

	private readonly views: Record<ViewId, HTMLElement> = { explorer: el('div', 'view'), search: el('div', 'view'), scm: el('div', 'view'), extensions: el('div', 'view'), analysis: el('div', 'view') };
	private readonly activityItems: Record<string, HTMLElement> = {};
	readonly titleBar: TitleBar;
	readonly explorer: Explorer;
	readonly search: SearchView;
	readonly scm: SourceControlView;
	readonly extensions: ExtensionsPanel;
	readonly analysis: AnalysisView;
	readonly extensionHost: ExtensionHost;
	readonly editors: EditorArea;
	readonly graph: GraphHost;
	readonly panel: Panel;
	readonly statusBar: StatusBar;
	private repoPath: string | null = null;
	/** Whether the open folder is (or sits inside) a Git repository. */
	private isRepo = false;
	/** Single-file mode (`git-graph-studio <file>` / File > Open File...): the window shows
	 *  one file and nothing else - no side bar, no terminal, no repository views. */
	private singleFile: string | null = null;
	/** Boot timing: the first folder open stamps "folder shown" once. */
	private folderShownStamped = false;
	/** Every open root: one entry for a plain folder, one per folder of a `.ggs-workspace`
	 *  (M3 3.8). `repoPath` stays the first root - the single-root seam everything uses. */
	private repoPaths: string[] = [];
	/** The `.ggs-workspace` file the roots came from (null for a plain folder): the session
	 *  snapshot is keyed by it, so a workspace keeps its own tabs. */
	private workspaceFile: string | null = null;
	private activeView: ViewId = state.layout.activeView;
	private refreshTimer: number | null = null;

	constructor() {
		for (const view of Object.values(this.views)) {
			view.style.display = 'none';
			view.style.flex = '1';
			view.style.minHeight = '0';
			view.style.flexDirection = 'column';
			this.sidebar.appendChild(view);
		}
		this.titleBar = new TitleBar(document.getElementById('titlebar')!);
		this.explorer = new Explorer(this.views.explorer);
		this.search = new SearchView(this.views.search);
		this.scm = new SourceControlView(this.views.scm, commands);
		this.analysis = new AnalysisView(this.views.analysis);
		this.extensionHost = new ExtensionHost();
		// The built-in git-graph-rs never runs in the frame host; the commands its manifest
		// declares dispatch to the workbench's own views. The scm/title Amend/Gerrit commands
		// keep their working `gitGraph.*` implementations (gitCommands.ts) - the manifest ids
		// (with their English/Chinese pair, so the menu can pick the locale-appropriate one; see
		// GIT_GRAPH_RS_SCM_COMMANDS below) just forward to them, the same way `.view` and
		// `.filterByFile` already forward to this workbench's own methods.
		this.extensionHost.nativeCommands = new Set([
			'git-graph-rs.view', 'git-graph-rs.filterByFile',
			...Object.keys(GIT_GRAPH_RS_SCM_COMMANDS), ...Object.keys(GIT_GRAPH_RS_SCM_COMMANDS).map((id) => `${id}.zhCn`)
		]);
		this.extensionHost.onNativeCommand = (command) => {
			if (command === 'git-graph-rs.view') {
				this.openGraph();
				return true;
			}
			if (command === 'git-graph-rs.filterByFile') {
				this.showFileHistoryInGraph();
				return true;
			}
			const implementation = GIT_GRAPH_RS_SCM_COMMANDS[command.replace(/\.zhCn$/, '')];
			if (implementation) {
				void commands.execute(implementation);
				return true;
			}
			return false;
		};
		// The context git-graph-rs's own code would set (`isZhCn()`, src/i18n.ts) to pick
		// between its scm/title menu's English/Chinese command pair - resolved live from the
		// extension's own declared interfaceLanguage setting, "auto" following Studio's display
		// language the same way "auto" follows VS Code's there.
		registerContextProvider('git-graph-rs:interfaceZhCn', () => {
			const configured = state.extSettings(GIT_GRAPH_RS_EXT_ID)['interfaceLanguage'];
			return configured === 'zh-cn' || (configured !== 'en' && settings.locale === 'zh-cn');
		});
		// The shipped extensions' menus join the registry now, synchronously from the build-time
		// baked manifest data - before any view renders, so the SCM title bar and every context
		// menu see them on their first pass (installed extensions still register asynchronously
		// via activateInstalled, which then asks for a re-render below).
		this.extensionHost.applyBuiltinContributions();
		this.extensionHost.onContributionsApplied = () => {
			// Late (installed-at-runtime) contributions: the SCM title bar had already rendered
			// its manifest-declared buttons, so it renders again to pick them up. The context
			// menus build lazily at open time and the palette reads the registry on open.
			void this.scm.refresh();
		};
		this.extensions = new ExtensionsPanel(this.views.extensions, this.extensionHost);
		this.editors = new EditorArea(document.getElementById('editorGroup')!);
		this.panel = new Panel(this.panelElement);
		this.statusBar = new StatusBar(document.getElementById('statusbar')!);
		this.graph = new GraphHost({
			openFile: (path) => void this.editors.openFile(path),
			openDiff: (diff) => void this.editors.openDiff({ kind: 'diff', ...diff }),
			openFileAtRevision: (revision, path, title, repo) => void this.editors.openRevision(revision, path, title, repo),
			openCompareTab: (fromHash, toHash, singleCommit, repo) => void this.editors.openCompare({ kind: 'compare', id: `${fromHash}:${toHash}:${singleCommit ? 1 : 0}`, title: compareTitle(fromHash, toHash, singleCommit), fromHash, toHash, singleCommit, repo }),
			showSourceControl: () => this.showView('scm'),
			revealTerminal: () => this.panel.show('terminal'),
			runInTerminal: (command) => void this.panel.runInTerminal(command),
			repoChanged: () => this.scheduleRefresh(0),
			initRepository: () => void this.initializeRepository()
		});
		this.editors.graphElement = this.graph.element;

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
		// The shell is up: the boot splash (index.html) has done its job of filling the
		// window while this module graph was still loading and parsing.
		document.getElementById('boot-splash')?.remove();
		// The title bar and menus are on screen: boot timing's last stamp.
		void invoke('boot_stage', { stage: 'title bar + menus', pageMs: performance.now() }).catch(() => undefined);
	}

	get currentRepo(): string | null {
		return this.repoPath;
	}

	/* ---------- Commands & menus ---------- */

	private registerCommands(): void {
		const hasRepo = () => this.repoPath !== null;
		const editorView = () => this.editors.activeView;
		const hasEditor = () => editorView() !== null;
		const register = commands.register.bind(commands);

		register({ id: 'workbench.openFolder', title: 'Open Folder...', category: 'File', keybinding: 'Ctrl+O', run: () => this.pickFolder() });
		register({ id: 'workbench.openWorkspace', title: 'Open Workspace...', category: 'File', run: () => this.pickWorkspace() });
		register({ id: 'workbench.openFileStandalone', title: 'Open File...', category: 'File', run: () => this.pickSingleFile() });
		register({ id: 'workbench.closeFolder', title: 'Close Folder', category: 'File', enabled: hasRepo, run: () => this.closeFolder() });
		register({ id: 'workbench.newFile', title: 'New File...', category: 'File', keybinding: 'Ctrl+N', enabled: hasRepo, run: () => this.explorer.newFile() });
		register({ id: 'workbench.save', title: 'Save', category: 'File', keybinding: 'Ctrl+S', enabled: () => this.editors.hasDirtyEditors(), run: () => this.editors.save() });
		register({ id: 'workbench.saveAll', title: 'Save All', category: 'File', keybinding: 'Ctrl+K S', enabled: () => this.editors.hasDirtyEditors(), run: () => this.editors.saveAll() });
		register({ id: 'workbench.closeEditor', title: 'Close Editor', category: 'View', keybinding: 'Ctrl+W', enabled: () => this.editors.activeInput !== null, run: () => this.editors.close() });
		register({ id: 'workbench.closeAllEditors', title: 'Close All Editors', category: 'View', keybinding: 'Ctrl+K Ctrl+W', enabled: () => this.editors.activeInput !== null, run: () => void this.editors.closeAll() });
		register({ id: 'workbench.focusFirstEditorGroup', title: 'Focus First Editor Group', category: 'View', keybinding: 'Ctrl+1', run: () => this.editors.focusIndex(0) });
		register({ id: 'workbench.focusSecondEditorGroup', title: 'Focus Second Editor Group', category: 'View', keybinding: 'Ctrl+2', run: () => this.editors.focusIndex(1) });
		register({ id: 'workbench.focusThirdEditorGroup', title: 'Focus Third Editor Group', category: 'View', keybinding: 'Ctrl+3', run: () => this.editors.focusIndex(2) });
		register({ id: 'workbench.splitEditor', title: 'Split Editor', category: 'View', keybinding: 'Ctrl+\\', run: () => this.editors.splitEditor('right') });
		register({ id: 'workbench.splitEditorDown', title: 'Split Editor Down', category: 'View', keybinding: 'Ctrl+K Ctrl+\\', run: () => this.editors.splitEditor('down') });
		register({ id: 'workbench.openSettings', title: 'Settings', category: 'Preferences', keybinding: 'Ctrl+,', run: () => openSettingsPanel() });
		register({ id: 'workbench.exit', title: 'Exit', category: 'File', keybinding: 'Alt+F4', run: () => getCurrentWindow().close() });

		register({ id: 'editor.undo', title: 'Undo', category: 'Edit', keybinding: 'Ctrl+Z', enabled: hasEditor, run: () => this.editors.runEditorCommand('undo') });
		register({ id: 'editor.redo', title: 'Redo', category: 'Edit', keybinding: 'Ctrl+Y', enabled: hasEditor, run: () => this.editors.runEditorCommand('redo') });
		register({ id: 'editor.cut', title: 'Cut', category: 'Edit', keybinding: 'Ctrl+X', enabled: hasEditor, run: () => void document.execCommand('cut') });
		register({ id: 'editor.copy', title: 'Copy', category: 'Edit', keybinding: 'Ctrl+C', enabled: hasEditor, run: () => void document.execCommand('copy') });
		register({ id: 'editor.paste', title: 'Paste', category: 'Edit', keybinding: 'Ctrl+V', enabled: hasEditor, run: () => void document.execCommand('paste') });
		register({ id: 'editor.find', title: 'Find', category: 'Edit', keybinding: 'Ctrl+F', enabled: hasEditor, run: () => this.editors.runEditorCommand('find') });
		register({ id: 'editor.replace', title: 'Replace', category: 'Edit', keybinding: 'Ctrl+H', enabled: hasEditor, run: () => this.editors.runEditorCommand('replace') });
		const hasCommentSurface = () => this.editors.activeView !== null || this.editors.activeInput !== null;
		register({ id: 'editor.toggleLineComment', title: 'Toggle Line Comment', category: 'Edit', keybinding: 'Ctrl+/', enabled: hasCommentSurface, run: () => this.editors.runEditorCommand('toggleLineComment') });
		register({ id: 'editor.toggleBlockComment', title: 'Toggle Block Comment', category: 'Edit', keybinding: 'Shift+Alt+A', enabled: hasCommentSurface, run: () => this.editors.runEditorCommand('toggleBlockComment') });
		register({ id: 'editor.toggleWordWrap', title: 'Toggle Word Wrap', category: 'View', keybinding: 'Alt+Z', run: () => updateSetting('wordWrap', !settings.wordWrap) });
		register({ id: 'editor.selectAll', title: 'Select All', category: 'Selection', keybinding: 'Ctrl+A', enabled: hasEditor, run: () => this.editors.runEditorCommand('selectAll') });

		register({ id: 'workbench.quickOpen', title: 'Go to File...', category: 'Go', keybinding: 'Ctrl+P', enabled: hasRepo, run: () => this.quickOpen('') });
		register({ id: 'workbench.commandPalette', title: 'Command Palette...', category: 'View', keybinding: 'Ctrl+Shift+P', run: () => this.quickOpen('>') });
		register({ id: 'workbench.goBack', title: 'Go Back', category: 'Go', keybinding: 'Alt+Left', enabled: () => this.editors.canGoBack(), run: () => this.editors.goBack() });
		register({ id: 'workbench.goForward', title: 'Go Forward', category: 'Go', keybinding: 'Alt+Right', enabled: () => this.editors.canGoForward(), run: () => this.editors.goForward() });
		register({ id: 'editor.gotoDefinition', title: 'Go to Definition', category: 'Go', keybinding: 'F12', enabled: () => this.editors.activeView !== null, run: () => void this.editors.goToDefinition() });
		register({ id: 'workbench.nextEditor', title: 'Next Editor', category: 'Go', keybinding: 'Ctrl+PageDown', run: () => this.editors.activateNext(1) });
		register({ id: 'workbench.previousEditor', title: 'Previous Editor', category: 'Go', keybinding: 'Ctrl+PageUp', run: () => this.editors.activateNext(-1) });

		register({ id: 'workbench.showExplorer', title: 'Explorer', category: 'View', keybinding: 'Ctrl+Shift+E', run: () => this.showView('explorer') });
		register({ id: 'workbench.showSearch', title: 'Search', category: 'View', keybinding: 'Ctrl+Shift+F', run: () => { this.showView('search'); this.seedSearchQuery(); this.search.focus(); } });
		register({ id: 'workbench.replaceInFiles', title: 'Replace in Files', category: 'Search', keybinding: 'Ctrl+Shift+H', run: () => { this.showView('search'); this.search.focusReplace(); } });
		register({ id: 'workbench.showScm', title: 'Source Control', category: 'View', keybinding: 'Ctrl+Shift+G', run: () => this.showView('scm') });
		register({ id: 'workbench.showExtensions', title: 'Extensions', category: 'View', keybinding: 'Ctrl+Shift+X', run: () => this.showView('extensions') });
		register({ id: 'workbench.showAnalysis', title: 'Analysis', category: 'View', keybinding: 'Ctrl+Shift+A', run: () => this.showView('analysis') });
		register({ id: 'analysis.showModules', title: 'Module Analysis', category: 'Analysis', enabled: hasRepo, run: () => void this.editors.openAnalysisPage('modules') });
		register({ id: 'analysis.showMetrics', title: 'Complexity & Hotspots', category: 'Analysis', enabled: hasRepo, run: () => void this.editors.openAnalysisPage('metrics') });
		register({ id: 'analysis.showDeadCode', title: 'Dead Code', category: 'Analysis', enabled: hasRepo, run: () => void this.editors.openAnalysisPage('deadcode') });
		register({ id: 'analysis.showSecurity', title: 'Security Scan', category: 'Analysis', enabled: hasRepo, run: () => void this.editors.openAnalysisPage('security') });
		register({ id: 'analysis.showImports', title: 'Import Graph', category: 'Analysis', enabled: hasRepo, run: () => void this.editors.openAnalysisPage('imports') });
		register({ id: 'analysis.showMcp', title: 'MCP Server', category: 'Analysis', run: () => void this.editors.openAnalysisPage('mcp') });
		register({ id: 'git.openFileHistory', title: 'Git: Open File History', category: 'Git', enabled: () => hasRepo() && this.editors.activeInput?.kind === 'file', run: () => this.editors.openFileHistory() });
		register({ id: 'git.toggleBlame', title: 'Git: Toggle Blame', category: 'Git', keybinding: 'Ctrl+K Ctrl+B', enabled: () => hasRepo() && this.editors.activeView !== null && this.editors.activeInput?.kind === 'file', run: () => this.editors.toggleBlame() });
		register({ id: 'markdown.showPreview', title: 'Markdown: Open Preview', category: 'View', keybinding: 'Ctrl+Shift+V', enabled: () => this.editors.activeInput?.kind === 'file' && /\.(md|markdown)$/i.test(this.editors.activeInput.path), run: () => this.editors.openMarkdownPreview() });
		register({ id: 'markdown.showPreviewToSide', title: 'Markdown: Open Preview to the Side', category: 'View', keybinding: 'Ctrl+K V', enabled: () => this.editors.activeInput?.kind === 'file' && /\.(md|markdown)$/i.test(this.editors.activeInput.path), run: () => this.editors.openMarkdownPreviewToSide() });
		register({ id: 'workbench.openHexViewer', title: 'File: Open in Hex Viewer', category: 'File', enabled: () => this.editors.activeInput?.kind === 'file', run: () => void this.editors.openHex(this.editors.activeInput!.kind === 'file' ? this.editors.activeInput.path : '') });
		register({ id: 'workbench.compareFolders', title: 'Compare Two Folders...', category: 'File', enabled: hasRepo, run: () => void this.compareFolders() });
		register({ id: 'workbench.gotoSymbolInFile', title: 'Go to Symbol in File...', category: 'Go', keybinding: 'Ctrl+Shift+O', enabled: () => this.editors.activeInput?.kind === 'file', run: () => void this.editors.gotoSymbolInFile() });
		register({ id: 'workbench.gotoSymbolInWorkspace', title: 'Go to Symbol in Workspace...', category: 'Go', keybinding: 'Ctrl+T', enabled: hasRepo, run: () => void this.gotoWorkspaceSymbol() });
		register({ id: 'workbench.gotoLine', title: 'Go to Line/Column...', category: 'Go', keybinding: 'Ctrl+G', enabled: () => this.editors.activeView !== null, run: () => this.quickOpen(':') });
		register({ id: 'editor.findReferences', title: 'Find References', category: 'Go', keybinding: 'Shift+F12', enabled: () => this.editors.activeView !== null, run: () => void this.editors.findReferences() });
		register({ id: 'symbols.rebuild', title: 'Rebuild Symbol Index', category: 'Go', enabled: hasRepo, run: () => void this.rebuildSymbolIndex() });
		register({ id: 'editor.callTree', title: 'Show Call Tree', category: 'Go', enabled: () => this.editors.activeView !== null, run: () => void this.editors.openCallTreeAtCursor() });
		register({ id: 'editor.toggleBookmark', title: 'Toggle Bookmark', category: 'Edit', keybinding: 'Ctrl+Alt+B', enabled: () => this.editors.activeInput?.kind === 'file', run: () => void this.toggleBookmark() });
		register({ id: 'editor.listBookmarks', title: 'List Bookmarks', category: 'Edit', keybinding: 'Ctrl+Alt+K', run: () => void this.listBookmarks() });
		register({ id: 'extensions.installFromVsix', title: 'Install Extension from VSIX...', category: 'Extensions', run: () => { this.showView('extensions'); void this.extensions.installFromVsixCommand(); } });
		register({ id: 'workbench.showGraph', title: 'Git Graph', category: 'View', enabled: hasRepo, run: () => this.openGraph() });
		register({ id: 'git.initRepository', title: 'Initialize Repository', category: 'Git', enabled: () => this.repoPath !== null && !this.isRepo, run: () => void this.initializeRepository() });
		register({ id: 'workbench.toggleSidebar', title: 'Toggle Primary Side Bar', category: 'View', keybinding: 'Ctrl+B', run: () => this.toggleSidebar() });
		register({ id: 'workbench.togglePanel', title: 'Toggle Panel', category: 'View', keybinding: 'Ctrl+J', run: () => this.panel.toggle() });
		register({ id: 'workbench.showOutput', title: 'Output', category: 'View', run: () => this.panel.show('output') });
		register({ id: 'workbench.showContext', title: 'Context', category: 'View', run: () => this.panel.show('context') });
		register({ id: 'workbench.showSymbolDatabase', title: 'Symbol Database', category: 'View', enabled: hasRepo, run: () => void this.editors.openSymbolDatabase() });
		register({ id: 'workbench.focusNextPart', title: 'Focus Next Part', category: 'View', keybinding: 'F6', run: () => this.focusNextPart() });
		register({ id: 'terminal.toggle', title: 'Toggle Terminal', category: 'Terminal', keybinding: 'Ctrl+`', run: () => this.panel.toggle('terminal') });
		register({ id: 'terminal.new', title: 'New Terminal', category: 'Terminal', keybinding: 'Ctrl+Shift+`', run: async () => { this.panel.show('terminal'); await this.panel.terminal.newTerminal(); } });
		register({ id: 'terminal.kill', title: 'Kill the Active Terminal Instance', category: 'Terminal', enabled: () => this.panel.terminal.sessionCount() > 0, run: () => this.panel.terminal.killActive() });
		register({ id: 'help.welcome', title: 'Welcome', category: 'Help', run: () => this.editors.openHelp('welcome') });
		register({ id: 'help.shortcuts', title: 'Keyboard Shortcuts', category: 'Help', keybinding: 'Ctrl+K Ctrl+S', run: () => this.editors.openHelp('shortcuts') });
		register({ id: 'help.repository', title: 'Report Issue / Project Page', category: 'Help', run: () => void openUrl('https://github.com/neophack/vscode-git-graph-rs') });
		register({ id: 'help.about', title: 'About', category: 'Help', run: () => notify('info', `Git Graph Studio ${__APP_VERSION__} - a standalone desktop shell around the git-graph-rs engine.`) });
		register({ id: 'help.openDevTools', title: 'Open Developer Tools', category: 'Help', run: () => void invoke('open_devtools').catch((e) => console.error('open_devtools failed:', e)) });

		registerGitCommands(commands, {
			repoPath: () => this.repoPath,
			repoChanged: () => this.scheduleRefresh(0),
			openFolder: (path) => this.openFolder(path),
			showOutput: () => this.panel.show('output'),
			graphSettings: () => this.graph.actionSettings(),
			commit: (options) => this.scm.commit(options)
		});
	}

	/** The title bar menus, laid out as VS Code's (File, Edit, Selection, View, Go, Terminal, Help). */
	menus() {
		const item = (id: string) => commands.menuItem(id);
		return [
			{ label: t('menu.file'), entries: (): MenuEntry[] => [
				item('workbench.newFile'), 'separator',
				item('workbench.openFolder'), item('workbench.openFileStandalone'), item('workbench.openWorkspace'),
				{ label: 'Open Recent', submenu: [
					...state.recentFolders().map((folder) => ({ label: basename(folder), keybinding: folder, run: () => void this.openRecent(folder) })),
					...(state.recentFolders().length > 0 ? ['separator' as const] : []),
					{ label: 'Clear Recently Opened', disabled: state.recentFolders().length === 0, run: () => { state.save('recentFolders', []); } }
				] },
				'separator', item('workbench.save'), item('workbench.saveAll'), 'separator',
				item('workbench.closeEditor'), item('workbench.closeFolder'), 'separator',
				item('workbench.openSettings'), 'separator', item('workbench.exit')
			] },
			{ label: t('menu.edit'), entries: (): MenuEntry[] => [item('editor.undo'), item('editor.redo'), 'separator', item('editor.cut'), item('editor.copy'), item('editor.paste'), 'separator', item('editor.find'), item('editor.replace'), item('workbench.showSearch'), item('workbench.replaceInFiles'), 'separator', item('editor.toggleLineComment'), item('editor.toggleBlockComment'), 'separator', item('editor.toggleBookmark'), item('editor.listBookmarks')] },
			{ label: t('menu.selection'), entries: (): MenuEntry[] => [item('editor.selectAll')] },
				{ label: t('menu.view'), entries: (): MenuEntry[] => [
			item('workbench.commandPalette'), 'separator',
			item('workbench.showExplorer'), item('workbench.showSearch'), item('workbench.showScm'), item('workbench.showGraph'), item('workbench.showOutput'), item('workbench.showContext'), item('workbench.showSymbolDatabase'), 'separator',
			{ label: t('menu.analysis'), submenu: [
				item('analysis.showModules'), item('analysis.showMetrics'), item('analysis.showDeadCode'), item('analysis.showSecurity'), item('analysis.showImports'), item('analysis.showMcp')
			] },
			'separator', item('editor.toggleWordWrap'), 'separator', item('markdown.showPreview'), item('markdown.showPreviewToSide'), item('git.openFileHistory'), item('git.toggleBlame'), 'separator',
				{ label: 'Editor Layout', submenu: [
				item('workbench.splitEditor'), item('workbench.splitEditorDown'), 'separator', item('workbench.focusFirstEditorGroup'), item('workbench.focusSecondEditorGroup'), item('workbench.focusThirdEditorGroup')
				] },
				{ label: 'Appearance', submenu: [
					{ label: 'Primary Side Bar', checked: state.layout.sidebarVisible, keybinding: 'Ctrl+B', run: () => this.toggleSidebar() },
					{ label: 'Panel', checked: this.panel.isVisible(), keybinding: 'Ctrl+J', run: () => this.panel.toggle() }
				] },
				'separator', item('workbench.closeEditor'), item('workbench.closeAllEditors')
			] },
			{ label: t('menu.go'), entries: (): MenuEntry[] => [item('workbench.quickOpen'), 'separator', item('workbench.gotoSymbolInFile'), item('workbench.gotoSymbolInWorkspace'), item('editor.gotoDefinition'), item('editor.findReferences'), item('editor.callTree'), item('workbench.gotoLine'), item('symbols.rebuild'), 'separator', item('workbench.goBack'), item('workbench.goForward'), 'separator', item('workbench.nextEditor'), item('workbench.previousEditor')] },
			{ label: t('menu.terminal'), entries: (): MenuEntry[] => [item('terminal.new'), item('terminal.toggle'), 'separator', item('terminal.kill')] },
			{ label: t('menu.help'), entries: (): MenuEntry[] => [item('help.welcome'), item('help.shortcuts'), 'separator', item('help.repository'), 'separator', item('help.openDevTools'), 'separator', item('help.about')] }
		];
	}

	/** VS Code's quick open: files by default, commands with a leading ">". */
	/** VS Code's quick open: files by default, commands with a leading ">". The picker opens at
	 *  once — the file list is fetched from the backend in the background and the results fill
	 *  in as it lands, so a cold cache never delays the input. */
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

	/** The Quick Open file index: kept across picker opens (the pre-lowered entries are built
	 *  once per file list, not once per open), and re-listed in the background on every open so
	 *  changes made outside the app show up. */
	private filePicks: FilePickSource | null = null;

	private fileSource(): FilePickSource {
		if (!this.filePicks) {
			// A multi-root workspace concatenates its roots' lists as absolute paths, so the
			// picker's rows open directly; a plain folder keeps the repo-relative spelling and
			// lets the backend scorer answer (it only knows the first root's list, which is
			// why the workspace scans in the page instead).
			const multiRoot = this.repoPaths.length > 1;
			this.filePicks = new FilePickSource(async () => {
				if (multiRoot) {
					const lists = await Promise.all(this.repoPaths.map((root) => invoke<string[]>('list_files', { repo: root }).catch(() => [] as string[])));
					return lists.flatMap((files, index) => files.map((file) => joinRepo(this.repoPaths[index]!, file)));
				}
				return invoke<string[]>('list_files').catch(() => [] as string[]);
			}, { backend: !multiRoot });
		}
		void this.filePicks.refresh();
		return this.filePicks;
	}

	/* ---------- Symbol sources (Quick Open's @ and # modes, M4 4.9) ---------- */

	/** The active file's outline, cached briefly so the picker's per-keystroke queries do not
	 *  re-open a backend document each time. */
	private fileSymbolsCache: { path: string; at: number; symbols: { name: string; kind: string; line: number }[] } | null = null;

	/** The whole-workspace list, cached like Go to Symbol in Workspace keeps its copy. */
	private workspaceSymbolsCache: { at: number; symbols: { name: string; kind: string; path: string; line: number }[] } | null = null;

	private symbolSources() {
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
					const info = await invoke<{ docId: number; symbols: { name: string; kind: string; line: number }[] | null }>('viewer_open', { path });
					symbols = info.symbols ?? [];
					await invoke('viewer_close', { docId: info.docId }).catch(() => undefined);
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
					const perRoot = await Promise.all(roots.map((root) => invoke<{ name: string; kind: string; path: string; line: number }[] | null>('workspace_symbols', { query: '', limit: 10000, repo: root })));
					symbols = perRoot.flatMap((list, index) => (list ?? []).map((symbol) => ({ ...symbol, path: roots[index] ? joinRepo(roots[index]!, symbol.path) : symbol.path })));
				} catch {
					symbols = [];
				}
				this.workspaceSymbolsCache = { at: Date.now(), symbols };
				return symbols;
			}
		};
	}

	/** Rebuild the symbol index on demand (the status item's click): a channel-fed progress
	 *  into the status bar, a busy cursor while it runs (M7 7.8). */
	private async rebuildSymbolIndex(): Promise<void> {
		busy(true);
		try {
			const onEvent = new Channel<SymbolIndexEvent>();
			onEvent.onmessage = (event) => {
				if (event.kind === 'progress') this.statusBar.setSymbols({ state: 'building', done: event.done, total: event.total, files: 0, symbols: 0 });
			};
			await invoke<SymbolIndexStatus | null>('symbols_rebuild', { onEvent });
			notify('info', t('symbols.rebuildDone'));
		} catch (error) {
			notify('error', String(error));
		} finally {
			busy(false);
		}
	}

	/* ---------- Layout ---------- */

	/** VS Code-style pending-changes badge on the Source Control activity bar item. */
	private setScmBadge(count: number): void {
		const item = this.activityItems['scm'];
		if (!item) return;
		item.querySelector('.badge')?.remove();
		if (count > 0) item.appendChild(el('span', 'badge', [count > 999 ? '999+' : String(count)]));
	}

	private buildActivityBar(): void {
		const add = (id: string, content: HTMLElement, title: string, onClick: () => void) => {
			const item = el('div', 'activity-item', [content]);
			item.title = title;
			item.setAttribute('role', 'button');
			// Focusable for F6's cycle, with the workbench's delayed tooltip (M7).
			item.tabIndex = 0;
			tooltip(item, () => title);
			item.addEventListener('click', onClick);
			this.activityItems[id] = item;
			this.activityBar.appendChild(item);
			return item;
		};
		add('explorer', icon('files'), 'Explorer (Ctrl+Shift+E)', () => this.toggleView('explorer'));
		add('search', icon('search'), 'Search (Ctrl+Shift+F)', () => this.toggleView('search'));
		add('scm', icon('source-control'), 'Source Control (Ctrl+Shift+G)', () => this.toggleView('scm'));
		add('analysis', icon('graph'), 'Analysis (Ctrl+Shift+A)', () => this.toggleView('analysis'));
		const graphIcon = el('img');
		graphIcon.src = '/icons/git-graph.svg';
		graphIcon.alt = '';
		add('graph', graphIcon, 'Git Graph', () => this.openGraph());
		this.activityBar.appendChild(el('div', 'activity-spacer'));
		add('terminal', icon('terminal'), 'Terminal (Ctrl+`)', () => this.panel.toggle('terminal'));
		add('open', icon('folder-opened'), 'Open Folder... (Ctrl+O)', () => void this.pickFolder());
	}

	private applyLayout(): void {
		this.sidebar.style.width = `${state.layout.sidebarWidth}px`;
		this.panelElement.style.height = `${state.layout.panelHeight}px`;
		// showView reveals the side bar - right for a user gesture, but the boot applies the
		// saved layout: a bar hidden with Ctrl+B stays hidden across the restart.
		const sidebarVisible = state.layout.sidebarVisible;
		this.showView(this.activeView, false);
		if (!sidebarVisible) {
			state.layout.sidebarVisible = false;
			this.sidebar.hidden = true;
			this.sidebarSash.hidden = true;
			state.saveLayout();
		}
		if (!state.layout.sidebarVisible) this.activityItems[this.activeView]?.classList.remove('active');
		for (const id of ['explorer', 'search', 'scm', 'analysis']) this.activityItems[id]?.classList.toggle('active', state.layout.sidebarVisible && id === this.activeView);
		this.installSash(this.sidebarSash, 'horizontal', (delta, start) => {
			state.layout.sidebarWidth = Math.max(170, Math.min(window.innerWidth - 400, start + delta));
			this.sidebar.style.width = `${state.layout.sidebarWidth}px`;
		}, () => state.layout.sidebarWidth);
		this.installSash(this.panelSash, 'vertical', (delta, start) => {
			state.layout.panelHeight = Math.max(100, Math.min(window.innerHeight - 200, start - delta));
			this.panelElement.style.height = `${state.layout.panelHeight}px`;
		}, () => state.layout.panelHeight);
	}

	private installSash(sash: HTMLElement, axis: 'horizontal' | 'vertical', onMove: (delta: number, start: number) => void, startValue: () => number): void {
		sash.addEventListener('mousedown', (event) => {
			event.preventDefault();
			const origin = axis === 'horizontal' ? event.clientX : event.clientY;
			const start = startValue();
			sash.classList.add('active');
			document.body.classList.add('resizing');
			document.body.style.cursor = axis === 'horizontal' ? 'ew-resize' : 'ns-resize';
			// Each applied delta forces a layout of the whole workbench (the graph iframe and
			// the editors re-measure), so the moves are coalesced to one per animation frame -
			// a high-resolution mouse otherwise fires far more `mousemove`s than frames.
			let latest = origin;
			let pending = 0;
			const raf = window.requestAnimationFrame?.bind(window) ?? ((callback: () => void) => window.setTimeout(callback, 16));
			const move = (e: MouseEvent) => {
				latest = axis === 'horizontal' ? e.clientX : e.clientY;
				if (pending) return;
				pending = raf(() => {
					pending = 0;
					onMove(latest - origin, start);
				});
			};
			const up = () => {
				if (pending) { window.cancelAnimationFrame?.(pending); pending = 0; }
				onMove(latest - origin, start);
				document.removeEventListener('mousemove', move);
				document.removeEventListener('mouseup', up);
				sash.classList.remove('active');
				document.body.classList.remove('resizing');
				document.body.style.cursor = '';
				state.saveLayout();
			};
			document.addEventListener('mousemove', move);
			document.addEventListener('mouseup', up);
		});
	}

	showView(view: ViewId, focus = true): void {
		this.activeView = view;
		state.layout.activeView = view;
		state.layout.sidebarVisible = true;
		this.sidebar.hidden = false;
		this.sidebarSash.hidden = false;
		for (const [id, element] of Object.entries(this.views)) element.style.display = id === view ? 'flex' : 'none';
		for (const [id, item] of Object.entries(this.activityItems)) if (id === 'explorer' || id === 'search' || id === 'scm' || id === 'analysis') item.classList.toggle('active', id === view);
		state.saveLayout();
		if (view === 'scm') void this.scm.refresh();
		if (view === 'extensions') void this.extensions.refresh();
		if (view === 'analysis') void this.analysis.refresh();
		if (focus) this.views[view].querySelector<HTMLElement>('[tabindex]')?.focus();
	}

	/** Zed's `query_suggestion` (SeedQuery::Always): the Search view opens with the active
	 *  editor's single-line selection — else the word at its caret — as its query, so
	 *  Ctrl+Shift+F is find-usages without the retyping. The view escapes the seed when the
	 *  search is a regex; no editor (or no word under the caret) keeps the previous query. */
	private seedSearchQuery(): void {
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

	get activeSidebarView(): ViewId {
		return this.activeView;
	}

	private toggleView(view: ViewId): void {
		if (this.activeView === view && state.layout.sidebarVisible) this.toggleSidebar();
		else this.showView(view);
	}

	toggleSidebar(): void {
		state.layout.sidebarVisible = !state.layout.sidebarVisible;
		this.sidebar.hidden = !state.layout.sidebarVisible;
		this.sidebarSash.hidden = !state.layout.sidebarVisible;
		for (const id of ['explorer', 'search', 'scm', 'analysis']) this.activityItems[id]?.classList.toggle('active', state.layout.sidebarVisible && id === this.activeView);
		state.saveLayout();
	}

	/** Open the Git Graph view - on `repo` (a repository header's graph icon in the Source
	 *  Control view: the open repository's or a submodule's) with its repository dropdown
	 *  switched to that repository. */
	openGraph(repo?: string): void {
		if (!this.repoPath) {
			notify('info', 'Open a folder containing a Git repository to view its Git Graph.', [{ label: 'Open Folder', run: () => void this.pickFolder() }]);
			return;
		}
		this.editors.openGraph();
		if (repo) this.graph.switchRepo(repo);
	}

	/** Git Graph RS: Show File History in Git Graph - the view filtered to `explicitPath` (the
	 *  Source Control view's own context menu, which names the resource it was opened on
	 *  directly, VS Code's menu argument having no equivalent here), else the explorer's
	 *  selection (a Studio extension over VS Code, which passes one file: every selected entry
	 *  joins into the view's comma-separated path filter), or the active editor's file when
	 *  nothing is selected. */
	private showFileHistoryInGraph(explicitPath?: string): void {
		const files = explicitPath ? [explicitPath] : this.explorer.selectedPaths;
		if (files.length === 0 && this.editors.activeInput?.kind === 'file') files.push(this.editors.activeInput.path);
		if (files.length === 0 || !this.repoPath) {
			notify('info', 'Select a file in the Explorer (or open it in the editor) to show its history in Git Graph.');
			return;
		}
		this.openGraph();
		const filter = [...new Set(files.map((file) => toPosix(relativeTo(this.repoPath!, file))))].join(',');
		this.graph.filterByFile(filter);
	}

	/* ---------- Wiring ---------- */

	/** Beyond Compare's headline flow: pick two folders, compare them in an editor tab. */
	private async compareFolders(): Promise<void> {
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

	/** Go to Symbol in Workspace (Ctrl+T): the whole symbol index as a pick list. */
	private async gotoWorkspaceSymbol(): Promise<void> {
		if (!this.repoPath) return;
		let symbols: { kind: string; name: string; path: string; line: number }[];
		try {
			// A multi-root workspace indexes each root; a symbol's path is relative to its own.
			const roots = this.repoPaths.length > 1 ? this.repoPaths : [null];
			const perRoot = await Promise.all(roots.map((root) => invoke<{ kind: string; name: string; path: string; line: number }[]>('workspace_symbols', { query: '', limit: 10000, repo: root })));
			symbols = perRoot.flatMap((list, index) => list.map((symbol) => ({ ...symbol, path: roots[index] ? joinRepo(roots[index]!, symbol.path) : symbol.path })));
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

	/** Toggle the bookmark on the active editor's cursor line. */
	private toggleBookmark(): void {
		const input = this.editors.activeInput;
		if (input?.kind !== 'file') return;
		const view = this.editors.activeView;
		if (!view) return;
		const line = view.state.doc.lineAt(view.state.selection.main.head).number;
		toggleBookmark(input.path, line);
		// A selection-only update re-runs the gutter markers.
		view.dispatch({ selection: { anchor: view.state.selection.main.head } });
	}

	private async listBookmarks(): Promise<void> {
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

	private wire(): void {
		this.titleBar.onCommandCenter = () => void this.quickOpen('');
		this.titleBar.onBack = () => this.editors.goBack();
		this.titleBar.onForward = () => this.editors.goForward();

		// The Search view needs the open repo; its matches open in the editor group.
		this.search.setEnabled(this.repoPath !== null);
		this.search.onOpenMatch = (relative, line, column) => {
			if (this.repoPath) void this.editors.openFile(joinRepo(this.repoPath, relative), { line, column });
		};
		this.editors.onMergeResolved = () => this.scheduleRefresh(0);
		this.editors.onExternalFileChange = () => this.scheduleRefresh(0);

		this.explorer.onFileOpened = (path) => void this.editors.openFile(path);
		this.explorer.onOpenInDirection = (path, direction) => this.editors.openInDirection(path, direction);
		this.explorer.onOpenHex = (path) => void this.editors.openHex(path);
		this.explorer.onOpenFolder = () => void this.pickFolder();
		this.explorer.onPathRenamed = (from, to) => this.editors.pathRenamed(from, to);
		this.explorer.onPathDeleted = (path) => this.editors.pathDeleted(path);
		this.explorer.onOpenInTerminal = (folder) => void this.panel.runInTerminal(`cd ${quoteShellPath(folder)}`);
		// Two selected files (or folders) compare in an editor tab: files as a text diff of
		// their on-disk contents, folders in the Folder Compare view.
		this.explorer.onCompare = (left, right, isDir) => {
			if (isDir) {
				this.editors.openFolderCompare({ kind: 'folders', id: `${left}::${right}`, left, right });
				return;
			}
			void this.editors.openDiff({
				kind: 'diff',
				id: `paths:${left}::${right}`,
				title: `${basename(left)} ↔ ${basename(right)}`,
				left: { revision: '*', path: left, label: left, exists: true, local: true },
				right: { revision: '*', path: right, label: right, exists: true, local: true }
			});
		};

		this.scm.onStatus = (status) => this.explorer.setStatus(status);
		this.extensions.onChanged = () => this.scheduleRefresh(0);
		this.scm.onOpenFile = (path) => void this.editors.openFile(path);
		this.scm.onOpenDiff = (diff) => void this.editors.openDiff({ kind: 'diff', ...diff });
		// The Analysis sidebar's tool rows open their result pages in the editor area.
		this.analysis.onOpenTool = (tool: AnalysisToolId) => void this.editors.openAnalysisPage(tool);
		this.scm.onOpenGraph = (repo) => this.openGraph(repo);
		this.scm.onShowFileHistory = (path) => this.showFileHistoryInGraph(path);
		this.scm.onCount = (count) => this.setScmBadge(count);
		this.scm.onConflicts = (count) => this.statusBar.setConflicts(count);
		this.statusBar.onConflictsClick = () => this.showView('scm');
		this.scm.onChanged = () => {
			this.graph.refresh();
			void this.statusBar.refreshHead();
			void this.explorer.refresh();
		};

		this.editors.onActiveChange = (editor) => {
			this.scheduleSnapshot();
			this.statusBar.setEditor(editor);
			this.followContextSymbol(editor);
			this.activityItems['graph']?.classList.toggle('active', editor?.kind === 'graph');
			if (editor?.kind === 'file' && editor.path && state.layout.sidebarVisible && this.activeView === 'explorer') {
				void this.explorer.reveal(editor.path);
			}
		};
		this.editors.onNavigationChange = () => this.titleBar.setNavigation(this.editors.canGoBack(), this.editors.canGoForward());
		// The session snapshot (tabs, active tab, expanded folders) follows every change, coalesced.
		this.editors.onTabsChange = () => this.scheduleSnapshot();
		this.explorer.onExpandedChange = () => this.scheduleSnapshot();
		this.editors.onFileSaved = () => this.scheduleRefresh(0);
		this.editors.onSaveProgress = (progress) => this.statusBar.setSaveProgress(progress);
		this.editors.renderWelcome = (container) => this.renderWelcome(container);
		this.editors.renderHelp = (help, container) => (help === 'welcome' ? this.renderWelcome(container) : this.renderShortcuts(container));

		this.panel.terminal.onCommandEntered = () => this.scheduleRefresh(300);
		this.panel.onVisibilityChange = (visible) => {
			this.panelSash.hidden = !visible;
			state.layout.panelVisible = visible;
			state.saveLayout();
			this.activityItems['terminal']?.classList.toggle('active', visible);
		};
		this.panel.onMaximizeChange = (maximized) => this.editorPart.classList.toggle('panel-maximized', maximized);

		// Clicking the repo name opens Source Control; the branch offers a switch (branches
		// and tags); the sync item pulls then pushes (git.sync).
		this.statusBar.onRepoClick = () => this.showView('scm');
		this.statusBar.onBranchClick = () => void commands.execute('git.checkout');
		this.statusBar.onSyncClick = () => void commands.execute('git.sync');
		this.statusBar.onGraphClick = () => this.openGraph();
		this.statusBar.onEncodingClick = () => void this.pickEncoding();
		this.statusBar.onEolClick = () => void this.pickEol();
		this.statusBar.onIndentClick = () => void this.pickIndent();
		this.statusBar.onSymbolsClick = () => void commands.execute('symbols.rebuild');
		this.panel.context.onOpenDefinition = (definition) => {
			void this.editors.openFile(definition.path, { line: definition.line + 1 });
		};

		document.addEventListener('keydown', this.onKeyDownBound);
		// External changes arrive from the backend's file watcher; the focus refresh stays as
		// the fallback for the filesystems the watcher cannot cover.
		void listen<FsChange>(FS_CHANGED_EVENT, (event) => this.onFsChanged(event.payload)).then((unlisten) => this.trackUnlisten(unlisten)).catch(() => undefined);
		// The symbol index's builds report from the backend (an open's resume, a watcher's
		// incremental update, this command's own rebuild): the status item follows them all.
		void listen<SymbolIndexStatus>('studio://symbol-index', (event) => this.statusBar.setSymbols(event.payload)).then((unlisten) => this.trackUnlisten(unlisten)).catch(() => undefined);
		void listen<AnalysisStatus>('studio://analysis-index', (event) => this.analysis.noteStatus(event.payload)).then((unlisten) => this.trackUnlisten(unlisten)).catch(() => undefined);
		window.addEventListener('focus', this.onWindowFocusBound);
		window.addEventListener('blur', this.onWindowBlurBound);
		void getCurrentWindow().onCloseRequested(async (event) => {
			// The window is destroyed right after this handler resolves - long before the
			// debounced snapshot would fire - so the session is saved first, and before the
			// dirty editors settle (closeFolder's order).
			this.saveSnapshot();
			if (this.editors.hasDirtyEditors()) {
				const closed = await this.editors.closeAll();
				if (!closed) event.preventDefault();
			}
		}).then((unlisten) => this.trackUnlisten(unlisten)).catch(() => undefined);
		// Tauri captures webview drag-and-drop itself (the DOM never sees the drop), so files
		// dragged onto the window arrive here; each one opens like "Open File..." would.
		void getCurrentWebview().onDragDropEvent((event) => {
			if (event.payload.type === 'drop') {
				for (const path of event.payload.paths) void this.editors.openFile(path);
			}
		}).then((unlisten) => this.trackUnlisten(unlisten)).catch(() => undefined);
	}

	/** The Context Window's debounce (M4 4.7): the symbol under the cursor settles for this
	 *  long before its definition is resolved - a pass over the code must not spam the panel. */
	private contextTimer: number | null = null;
	private contextGeneration = 0;

	private followContextSymbol(editor: { kind: string; path?: string; line: number; column: number } | null): void {
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

	private async resolveContextSymbol(editor: { kind: string; path?: string; line: number; column: number } | null): Promise<void> {
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
			defs = (await invoke<{ kind: string; name: string; path: string; line: number }[]>('symbol_lookup', { name })) ?? [];
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
			const file = await invoke<{ contents: string } | null>('read_file', { path: absolute });
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
	private focusNextPart(): void {
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
	private chordPending: string | null = null;

	/** The window/document-level handlers, bound once so `dispose` can take them off again. */
	private readonly onKeyDownBound = (event: KeyboardEvent): void => this.onKeyDown(event);
	private readonly onWindowFocusBound = (): void => this.scheduleRefresh(0);
	private readonly onWindowBlurBound = (): void => this.editors.onWindowBlur();
	private readonly onSettingsChangedBound = (event: Event): void => {
		this.titleBar.setMenus(this.menus());
		if ((event as CustomEvent).detail === 'locale' && this.graph.loaded) this.graph.load(this.repoPath, this.isRepo);
	};
	/** The Tauri listeners' unlisten functions (they land asynchronously, maybe after dispose). */
	private unlisteners: (() => void)[] = [];
	private disposed = false;

	/** Keep a listener's unlisten for dispose(); one that lands after dispose() fires at once. */
	private trackUnlisten(unlisten: () => void): void {
		if (this.disposed) unlisten();
		else this.unlisteners.push(unlisten);
	}

	/** Tear the workbench's window-level listeners down (the UI harness builds a fresh
	 *  workbench per flow; without this, every instance kept answering every keystroke, every
	 *  backend event and every window focus). */
	dispose(): void {
		this.disposed = true;
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
	}

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

	/* ---------- Encoding and line endings (the status bar's pickers) ---------- */

	/** VS Code's encoding flow: first "Reopen with Encoding" or "Save with Encoding", then the
	 *  encoding itself (the backend's list, the current one marked). */
	private async pickEncoding(): Promise<void> {
		const input = this.editors.activeInput;
		if (input?.kind !== 'file') return;
		const action = await quickPick([
			{ label: 'Reopen with Encoding', description: 'Reopen the file decoding it differently', value: 'reopen' },
			{ label: 'Save with Encoding', description: 'Write the file in another encoding from now on', value: 'save' }
		], 'Select Action', basename(input.path));
		if (!action) return;
		const list = await invoke<[string, string][]>('encodings').catch(() => Object.entries(ENCODING_LABELS));
		const encoding = await quickPick(list.map(([id, label]) => ({ label, value: id })), 'Select File Encoding' + (action === 'reopen' ? ' to Reopen File' : ' to Save with'));
		if (!encoding) return;
		if (action === 'reopen') await this.editors.reopenWithEncoding(encoding);
		else await this.editors.saveWithEncoding(encoding);
	}

	/** The status bar's indent item: VS Code's "Select Indentation" (the tab-size setting). */
	private async pickIndent(): Promise<void> {
		const chosen = await quickPick([
			{ label: 'Indent Using Spaces', description: 'The tab size applies to every editor', value: 'header' },
			...[2, 4, 8].map((size) => ({ label: String(size), description: settings.tabSize === size ? 'current' : undefined, value: String(size) }))
		], 'Select Indentation', 'Indentation');
		if (chosen === '2' || chosen === '4' || chosen === '8') updateSetting('tabSize', Number(chosen));
	}

	private async pickEol(): Promise<void> {
		if (this.editors.activeInput?.kind !== 'file') return;
		const eol = await quickPick([{ label: 'LF', description: 'Unix', value: 'lf' }, { label: 'CRLF', description: 'Windows', value: 'crlf' }], 'Select End of Line Sequence');
		if (eol === 'lf' || eol === 'crlf') this.editors.setEol(eol);
	}

	/* ---------- The session snapshot ---------- */

	private snapshotTimer: number | null = null;
	/** Set while a snapshot is being restored, so the restore's own tab churn is not saved
	 *  back over the snapshot half-way through. */
	private restoring = false;

	private scheduleSnapshot(): void {
		if (!this.repoPath || this.restoring) return;
		if (this.snapshotTimer !== null) window.clearTimeout(this.snapshotTimer);
		this.snapshotTimer = window.setTimeout(() => {
			this.snapshotTimer = null;
			this.saveSnapshot();
		}, 250);
	}

	/** Write the folder's session to storage now (a close or a switch must not lose the last change). */
	private saveSnapshot(): void {
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
	}

	/** Reopen the folder's last session: the file tabs in order, the active one last so it
	 *  ends up on top; a file that vanished meanwhile is skipped (openFile reports it). The
	 *  files of a group open in parallel (their reads overlap) but as inactive tabs, so the
	 *  tab order is still the snapshot's and only the remembered active one is shown. The
	 *  saved grid comes back as it was - a 2x2 layout reopens as 2x2; sessions saved before
	 *  the grid existed (or single-group ones) fall back to a row of splits (M3 3.1). */
	private async restoreSnapshot(root: string, snapshot: state.WorkspaceSnapshot): Promise<void> {
		// A fast folder switch (A then B within the idle delay) fires A's restore on B's
		// workbench: rebuilding A's grid - or clearing the restore flags B's own restore may
		// hold - would tear B's layout. The stale restore does not run at all.
		if (this.repoPath !== root) return;
		this.restoring = true;
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
		}
	}

	/** Something changed on disk outside the app (a build, a checkout in another terminal,
	 *  another editor): clean tabs of the changed files reload in place, and the git-derived
	 *  views refresh. A dirty tab keeps the user's edits - the save then prompts, as VS Code does. */
	onFsChanged(change: FsChange): void {
		if (!this.repoPath) return;
		// A batch from a folder that is no longer open (the watcher's last debounced burst
		// crossing a folder switch) belongs to the old project: its paths are relative to
		// another root and would be joined onto the new one.
		if (!this.repoPaths.includes(change.root)) return;
		// A batch that names no working-tree file and lands right after a refresh of our own
		// is that refresh's echo (the git commands it ran touching `.git/`): acting on it would
		// refresh again, and again. Real external changes keep coming after the window.
		if (change.paths.length === 0 && !change.truncated && performance.now() - this.lastRefreshAt < REFRESH_ECHO_MS) return;
		if (!change.truncated) {
			for (const relative of change.paths) void this.editors.reloadIfClean(joinRepo(change.root, relative));
		} else {
			// The batch names only some of what changed (a checkout, a build): every clean tab
			// under that root re-reads its file, or a tab left behind shows the old contents
			// the moment it is switched to. reloadIfClean skips the ones that did not change.
			const root = change.root.replace(/[\\/]+$/, '').toLowerCase();
			for (const path of this.editors.openFilePaths()) {
				if (path.toLowerCase().startsWith(root)) void this.editors.reloadIfClean(path);
			}
		}
		this.scheduleRefresh(0);
	}

	/** When the last git-derived refresh ran (`scheduleRefresh`'s timer fired). */
	private lastRefreshAt = -Infinity;

	/** Refresh everything git-derived: the SCM view (which colours the Explorer), the graph,
	 *  the status bar, the tree, and clean editors whose files changed. Coalesced. */
	scheduleRefresh(delay: number): void {
		if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
		this.refreshTimer = window.setTimeout(() => {
			this.refreshTimer = null;
			if (!this.repoPath) return;
			// While a sash drag is in progress, defer: refreshes mid-drag make the tree and
			// the editors churn under the pointer for no benefit. It re-fires after mouseup.
			if (document.body.classList.contains('resizing')) {
				this.scheduleRefresh(200);
				return;
			}
			this.lastRefreshAt = performance.now();
			void this.scm.refresh();
			this.graph.refresh();
			void this.statusBar.refreshHead();
			void this.explorer.refresh();
			const active = this.editors.activeInput;
			if (active?.kind === 'file') void this.editors.reloadIfClean(active.path);
		}, delay);
	}

	/* ---------- Folders ---------- */

	async openFolder(path: string): Promise<void> {
		if (!(await this.settleOutgoing())) return;
		await this.openFolderSettled(path);
	}

	/** The post-settling half of openFolder (openWorkspace's one-folder case lands here too:
	 *  its settling - and the outgoing folder's snapshot - already happened). */
	private async openFolderSettled(path: string): Promise<void> {
		let opened: { root: string; isRepo: boolean };
		try {
			opened = await invoke<{ root: string; isRepo: boolean }>('open_folder', { path });
		} catch (error) {
			notify('error', String(error));
			state.forgetFolder(path);
			return;
		}
		await this.applyRoots([opened.root], opened.isRepo, null);
	}

	/** Save the outgoing folder's session, then settle its dirty editors. The snapshot comes
	 *  first: settling closes the tabs, and a snapshot taken afterwards would record an empty
	 *  session over the folder's real one (closeFolder's order). False when the user cancelled. */
	private async settleOutgoing(): Promise<boolean> {
		this.saveSnapshot();
		return !this.editors.hasDirtyEditors() || (await this.editors.closeAll());
	}

	/** Open a recent entry: a `.ggs-workspace` file as a workspace, a folder as a folder -
	 *  both land in the recents list, and confusing them failed the open. */
	async openRecent(path: string): Promise<void> {
		if (path.toLowerCase().endsWith('.ggs-workspace')) await this.openWorkspace(path);
		else await this.openFolder(path);
	}

	async pickFolder(): Promise<void> {
		let selected: string | string[] | null;
		try {
			selected = await openDialog({ directory: true, multiple: false, title: 'Open Folder' });
		} catch (error) {
			notify('error', `Could not open the folder picker: ${String(error)}`);
			return;
		}
		if (!selected) return;
		await this.openFolder(Array.isArray(selected) ? selected[0]! : selected);
	}

	/** File > Open Workspace...: pick a `.ggs-workspace`, open its folders as roots. */
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
	}

	/** Open a `.ggs-workspace` file: the backend resolves and registers its roots; the shell
	 *  wires itself the same way a plain folder does, with the first root as the active one. */
	/** File > Open File...: pick one file, show it alone. */
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
			await invoke('open_single_file', { path: file });
		} catch (error) {
			notify('error', String(error));
			return;
		}
		await this.openFileStandalone(file);
	}

	/**
	 * Single-file mode: the window becomes just this file - the side bar and the terminal are
	 * hidden, no folder is open (no repository views, no watcher, no graph), and the file's
	 * editor opens at once. `git-graph-studio <file>` boots straight here.
	 */
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
		this.graph.unload();
		// The window is the file: hide the side bar and the terminal, like a single-file editor.
		state.layout.sidebarVisible = false;
		this.sidebar.hidden = true;
		this.sidebarSash.hidden = true;
		if (this.panel.isVisible()) this.panel.toggle();
		for (const id of ['explorer', 'search', 'scm', 'analysis']) this.activityItems[id]?.classList.remove('active');
		state.saveLayout();
		document.title = `${basename(path)} - Git Graph Studio`;
		this.titleBar.setFolderName(basename(path));
		await this.editors.openFile(path);
		// Boot timing: how long a single-file launch took to show its file.
		void invoke('boot_stage', { stage: 'single file shown', pageMs: performance.now() }).catch(() => undefined);
	}

	async openWorkspace(path: string): Promise<void> {
		if (!(await this.settleOutgoing())) return;
		let opened: { roots: { root: string; isRepo: boolean }[] };
		try {
			opened = await invoke<{ roots: { root: string; isRepo: boolean }[] }>('open_workspace', { path });
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
	}

	/** Wire the shell to a set of open roots (a plain folder passes one; the workspace file,
	 *  when there is one, keys the session snapshot). The first root is the active repository
	 *  seam; the graph and the SCM view can switch to the others through their own pickers.
	 *  The caller has already saved the outgoing folder's snapshot and settled its dirty
	 *  editors - before the backend switched folders. */
	private async applyRoots(roots: string[], anyRepo: boolean, workspaceFile: string | null): Promise<void> {
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
			void this.explorer.whenRendered().then(() => invoke('boot_stage', { stage: 'folder shown', pageMs: performance.now() })).catch(() => undefined);
		}
		this.search.setEnabled(true);
		this.search.setRoots(this.repoPaths.length > 1 ? this.repoPaths : []);
		this.editors.setRoot(root);
		this.scm.setRepo(root, anyRepo);
		this.statusBar.setRepo(anyRepo); // a plain folder shows no repository items
		// The graph view starts loading now, in parallel: its iframe boot and its first data
		// request run on their own while the SCM view and the status bar settle below. A
		// folder that is not a repository gets the placeholder with the Initialize button.
		this.graph.load(root, anyRepo);
		this.editors.openGraph();
		// The last session's editors come back once the main thread next idles (within a
		// second at most): their CodeMirror chunk and language modes would otherwise load
		// and parse in the same burst as the graph view's boot, and the graph tab is the one
		// on screen first.
		if (snapshot && (snapshot.openFiles.length > 0 || snapshot.activeFile)) whenIdle(() => void this.restoreSnapshot(root, snapshot), 1000);
		ExtensionHost.workspaceFolders = [...this.repoPaths];
		// `git status` is the slowest part of opening a folder, and the tree above renders
		// without it: the SCM view and the branch name settle here in the background while
		// the explorer is already usable (the view's own refresh also fetches the branch head
		// that steers its commit button).
		if (anyRepo) void this.scm.refresh();
		if (state.layout.sidebarVisible) this.showView(this.activeView);
	}

	/** `git init` in the open folder (the placeholder's and the SCM view's button, and the
	 *  command palette). Re-opens the folder afterwards, which now resolves to a repository:
	 *  the graph loads, the watcher starts, the status bar finds its branch. */
	async initializeRepository(): Promise<void> {
		if (this.repoPath === null || this.isRepo) return;
		try {
			await invoke('git_init');
		} catch (error) {
			notify('error', `Could not initialize the repository: ${String(error)}`);
			return;
		}
		notify('info', 'Initialized the Git repository.');
		await this.openFolder(this.repoPath);
	}

	async closeFolder(): Promise<void> {
		this.saveSnapshot();
		if (!(await this.editors.closeAll())) return;
		await invoke('close_folder').catch(() => undefined);
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
		this.graph.unload();
		ExtensionHost.workspaceFolders = [];
	}

	private renderWelcome(container: HTMLElement): void {
		const inner = el('div', 'welcome-inner');
		const logo = el('img');
		logo.src = '/icons/icon.png';
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
			start.appendChild(link('git-branch', 'Open Git Graph', basename(this.repoPath), () => this.openGraph()));
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

	/** The Keyboard Shortcuts page: the keybindings editor (search, record, conflicts). */
	private renderShortcuts(container: HTMLElement): void {
		// The pane takes the keyboard focus itself, so the recorder's keydown listener (on the
		// container) hears the keystroke that becomes the new binding.
		container.tabIndex = 0;
		renderKeybindingsEditor(container);
		container.focus();
	}

	/* ---------- Boot ---------- */

	async boot(): Promise<void> {
		// A `ggs <file>` launch shows exactly that file, alone.
		const launchFile = await invoke<string | null>('initial_file').catch(() => null);
		if (launchFile) {
			await this.openFileStandalone(launchFile);
			return;
		}
		// A `ggs compare|hex|hex-compare|folder-compare ...` launch opens its comparison as the
		// window's first tab, over no folder of its own - the same tabs the Explorer's
		// "Compare Two Files/Folders" menu opens.
		const actions = await invoke<{ type: string; left?: string; right?: string; path?: string }[]>('initial_actions').catch(() => null);
		if (actions !== null && actions.length > 0) {
			this.statusBar.setRepo(false);
			for (const action of actions) {
				if (action.type === 'compareFiles' && action.left && action.right) {
					await this.editors.openDiff({
						kind: 'diff',
						id: `paths:${action.left}::${action.right}`,
						title: `${basename(action.left)} ↔ ${basename(action.right)}`,
						left: { revision: '*', path: action.left, label: action.left, exists: true, local: true },
						right: { revision: '*', path: action.right, label: action.right, exists: true, local: true }
					});
				} else if (action.type === 'hexView' && action.path) {
					await this.editors.openHex(action.path);
				} else if (action.type === 'hexCompare' && action.left && action.right) {
					await this.editors.openLocalHexCompare(action.left, action.right);
				} else if (action.type === 'folderCompare' && action.left && action.right) {
					await this.editors.openFolderCompare({ kind: 'folders', id: `${action.left}::${action.right}`, left: action.left, right: action.right });
				}
			}
		} else {
			const current = await invoke<string | null>('initial_repo').catch(() => null);
			// The backend re-opens its launch folder (a workspace's first root); the recents may
			// hold the workspace file itself, which must win - opening the root as a plain folder
			// would drop the workspace's other roots.
			const remembered = state.lastFolder();
			const last = remembered !== null && remembered.toLowerCase().endsWith('.ggs-workspace') ? remembered : current ?? remembered;
			if (last) {
				if (last.toLowerCase().endsWith('.ggs-workspace')) await this.openWorkspace(last);
				else await this.openFolder(last);
			} else {
				this.statusBar.setRepo(false);
			}
		}
		// The rest of the boot is not what the user is waiting for, and it all shares the one
		// main thread with the explorer's first listing and the graph view's boot: the
		// terminal (its xterm chunk and a shell process), the extension host (its frame and
		// every installed bundle) and the backup recovery run once that first burst is
		// through - at the next idle moment, or within two seconds regardless.
		whenIdle(() => {
			if (state.layout.panelVisible) this.panel.show('terminal');
			// Extensions activate after the workbench is up: their commands join the registry
			// late, which the palette and menus pick up on their next render.
			void this.extensionHost.activateInstalled();
			void this.recoverBackups();
		});
	}

	/** Hot exit: unsaved buffers a previous session left behind (a crash, a kill) come back
	 *  into their editors, dirty, and the user is told. Backups of files outside the open
	 *  folder wait for that folder to be opened. */
	async recoverBackups(): Promise<void> {
		if (!this.repoPath) return;
		let backups: { path: string; savedAt: number }[];
		try {
			backups = await invoke('backup_list');
		} catch {
			return;
		}
		if (!Array.isArray(backups)) return;
		const separator = this.repoPath.includes('\\') ? '\\' : '/';
		const root = this.repoPath.replace(/[\\/]+$/, '').toLowerCase() + separator;
		const here = backups.filter((b) => b.path.toLowerCase().startsWith(root));
		let restored = 0;
		for (const backup of here) {
			try {
				const contents = await invoke<string>('backup_read', { path: backup.path });
				if (await this.editors.restoreBackup(backup.path, contents)) restored++;
			} catch {
				// A backup that cannot be read is left in place for the next launch.
			}
		}
		if (restored > 0) notify('info', `Recovered ${restored} unsaved file${restored === 1 ? '' : 's'} from the last session. Save to keep the changes.`);
	}
}

/** Run `work` when the main thread next idles (at most `timeoutMs` later); synchronously
 *  where the browser has no idle callbacks (jsdom), so tests see the same end state. */
function whenIdle(work: () => void, timeoutMs = 2000): void {
	if (typeof requestIdleCallback === 'function') requestIdleCallback(() => work(), { timeout: timeoutMs });
	else work();
}

function joinRepo(root: string, relative: string): string {
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

/** The tab title of a Commit Comparison ("Commit <hash>" for the Open Changes presentation). */
function compareTitle(fromHash: string, toHash: string, singleCommit: boolean): string {
	const abbrev = (hash: string) => (hash === '' || hash === '*' ? 'Present' : hash.length > 8 ? hash.slice(0, 8) : hash);
	return singleCommit ? `Commit ${abbrev(toHash)}` : `Compare ${abbrev(fromHash)} ↔ ${abbrev(toHash)}`;
}

export function bootWorkbench(): Promise<void> {
	return new Workbench().boot();
}
