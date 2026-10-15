// The boot path: first paint, command registration, the wiring pass (including the window-level drag-drop routing), deferred services and backup recovery.

import type { Workbench } from './workbench';

import { listen } from '../platform/ipc/core';
import { appNewInstance, bootContext, type BootContext, openDevtools } from '../platform/ipc/app';
import { backupList, backupRead, type BackupEntry } from '../platform/ipc/fs';
import { type SymbolIndexStatus } from '../platform/ipc/symbols';
import { remoteHostHideMain, remoteHostStatus } from '../platform/ipc/remote';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { openUrl } from '@tauri-apps/plugin-opener';
import { type AnalysisStatus } from '../features/analysis';
import type { AnalysisToolId } from '../features/analysis';
import { commands } from '../platform/commands';
import { registerGitCommands } from '../features/scm';
import { tf } from '../platform/i18n';
import { hook } from '../platform/hooks';
import { openSettingsPanel } from './settingsPanel';
import { settings, updateSetting } from '../platform/settings';
import * as state from '../platform/state';
import { basename, notify } from '../platform/ui/index';
import { FS_CHANGED_EVENT, FsChange, OPEN_PATHS_EVENT, OpenedPaths, joinRepo, quoteShellPath, whenIdle } from './workbench';

/** The boot concern of Workbench — assigned onto the prototype by the module facade (index.ts). */
export const bootMethods: ThisType<Workbench> = {
	registerCommands(): void {
		const hasRepo = () => this.repoPath !== null;
		const editorView = () => this.editors.activeView;
		const hasEditor = () => editorView() !== null;
		const register = commands.register.bind(commands);

		register({ id: 'workbench.openFolder', title: 'Open Folder...', category: 'File', keybinding: 'Ctrl+O', run: () => this.pickFolder() });
		// A second workbench is a second instance (no single-instance plugin — every launch
		// its own process, backends and watcher), so "New Window" asks the backend to spawn
		// one; the new window boots like a fresh launch. On Windows and Linux a second launch
		// of the app already is a new instance; on macOS this is the discoverable way to
		// multi-open, where clicking the app's icon again only focuses the running window.
		register({ id: 'workbench.newWindow', title: 'New Window', category: 'File', keybinding: 'Ctrl+Shift+N', run: () => void appNewInstance().catch((error) => notify('error', tf('workbench.newWindowFailed', String(error)))) });
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
		// VS Code's canonical spellings of the same focus commands — extensions call these
		// (claude-code hands the focus back to the code with them after opening its chat).
		// Palette-hidden: the rows above already carry the keybindings.
		register({ id: 'workbench.action.focusFirstEditorGroup', title: 'Focus First Editor Group', category: 'View', paletteHidden: () => true, run: () => this.editors.focusIndex(0) });
		register({ id: 'workbench.action.focusSecondEditorGroup', title: 'Focus Second Editor Group', category: 'View', paletteHidden: () => true, run: () => this.editors.focusIndex(1) });
		register({ id: 'workbench.action.focusThirdEditorGroup', title: 'Focus Third Editor Group', category: 'View', paletteHidden: () => true, run: () => this.editors.focusIndex(2) });
		// The rest of VS Code's editor-group management (the palette's Editor Group family):
		// focus by number up to eight, focus by adjacency, focus spatially, move the active
		// editor between groups, and the layout commands.
		for (const [nth, word] of [[4, 'Fourth'], [5, 'Fifth'], [6, 'Sixth'], [7, 'Seventh'], [8, 'Eighth']] as const) {
			register({ id: `workbench.action.focus${word}EditorGroup`, title: `Focus ${word} Editor Group`, category: 'View', keybinding: `Ctrl+${nth}`, run: () => this.editors.focusIndex(nth - 1) });
		}
		register({ id: 'workbench.action.focusLastEditorGroup', title: 'Focus Last Editor Group', category: 'View', run: () => this.editors.focusLast() });
		register({ id: 'workbench.action.focusNextGroup', title: 'Focus Next Editor Group', category: 'View', keybinding: 'Ctrl+K Ctrl+Right', run: () => this.editors.focusSequence(1) });
		register({ id: 'workbench.action.focusPreviousGroup', title: 'Focus Previous Editor Group', category: 'View', keybinding: 'Ctrl+K Ctrl+Left', run: () => this.editors.focusSequence(-1) });
		register({ id: 'workbench.action.focusAboveGroup', title: 'Focus Editor Group Above', category: 'View', keybinding: 'Ctrl+K Ctrl+Up', run: () => this.editors.focusDirection('up') });
		register({ id: 'workbench.action.focusBelowGroup', title: 'Focus Editor Group Below', category: 'View', keybinding: 'Ctrl+K Ctrl+Down', run: () => this.editors.focusDirection('down') });
		register({ id: 'workbench.action.focusLeftGroup', title: 'Focus Editor Group on the Left', category: 'View', run: () => this.editors.focusDirection('left') });
		register({ id: 'workbench.action.focusRightGroup', title: 'Focus Editor Group on the Right', category: 'View', run: () => this.editors.focusDirection('right') });
		register({ id: 'workbench.splitEditor', title: 'Split Editor', category: 'View', keybinding: 'Ctrl+\\', run: () => this.editors.splitEditor('right') });
		register({ id: 'workbench.action.splitEditorOrthogonal', title: 'Split Editor Orthogonal', category: 'View', keybinding: 'Ctrl+K Ctrl+\\', run: () => this.editors.splitEditorOrthogonal() });
		register({ id: 'workbench.action.splitEditorLeft', title: 'Split Editor Left', category: 'View', run: () => this.editors.splitEditor('left') });
		register({ id: 'workbench.action.splitEditorRight', title: 'Split Editor Right', category: 'View', run: () => this.editors.splitEditor('right') });
		register({ id: 'workbench.action.splitEditorUp', title: 'Split Editor Up', category: 'View', run: () => this.editors.splitEditor('up') });
		register({ id: 'workbench.action.splitEditorDown', title: 'Split Editor Down', category: 'View', run: () => this.editors.splitEditor('down') });
		register({ id: 'workbench.action.moveEditorToNextGroup', title: 'Move Editor into Next Group', category: 'View', keybinding: 'Ctrl+Alt+Right', run: () => this.editors.moveEditorToSequence(1) });
		register({ id: 'workbench.action.moveEditorToPreviousGroup', title: 'Move Editor into Previous Group', category: 'View', keybinding: 'Ctrl+Alt+Left', run: () => this.editors.moveEditorToSequence(-1) });
		register({ id: 'workbench.action.moveEditorToLeftGroup', title: 'Move Editor into Left Group', category: 'View', run: () => this.editors.moveEditorToDirection('left') });
		register({ id: 'workbench.action.moveEditorToRightGroup', title: 'Move Editor into Right Group', category: 'View', run: () => this.editors.moveEditorToDirection('right') });
		register({ id: 'workbench.action.moveEditorToAboveGroup', title: 'Move Editor into Above Group', category: 'View', run: () => this.editors.moveEditorToDirection('up') });
		register({ id: 'workbench.action.moveEditorToBelowGroup', title: 'Move Editor into Below Group', category: 'View', run: () => this.editors.moveEditorToDirection('down') });
		register({ id: 'workbench.action.evenEditorWidths', title: 'Even Editor Group Widths', category: 'View', run: () => this.editors.evenEditorWidths() });
		register({ id: 'workbench.action.toggleMaximizeEditorGroup', title: 'Toggle Maximized Editor Group', category: 'View', run: () => this.editors.toggleMaximizedGroup() });
		register({ id: 'workbench.action.minimizeOtherEditorGroups', title: 'Minimize Other Editor Groups', category: 'View', run: () => this.editors.minimizeOtherGroups() });
		register({ id: 'workbench.action.joinAllGroups', title: 'Join All Editor Groups', category: 'View', run: () => this.editors.joinAllGroups() });
		register({ id: 'workbench.action.resetEditorGroups', title: 'Reset Editor Groups', category: 'View', run: () => void this.editors.resetEditorGroups() });
		register({ id: 'workbench.action.closeEditorsInGroup', title: 'Close All Editors in Group', category: 'View', keybinding: 'Ctrl+K W', run: () => void this.editors.activeGroup.closeAll() });
		register({ id: 'workbench.action.closeEditorsInOtherGroups', title: 'Close Editors in Other Groups', category: 'View', run: () => void this.editors.closeOtherGroups() });
		// The group lock (claude-code locks its chat's group right after opening it, as it
		// does in VS Code — a locked group keeps its editors, placed opens land elsewhere).
		register({ id: 'workbench.action.lockEditorGroup', title: 'Lock Editor Group', category: 'View', enabled: () => !this.editors.activeGroup.locked, run: () => this.editors.setGroupLock(this.editors.activeGroup, true) });
		register({ id: 'workbench.action.unlockEditorGroup', title: 'Unlock Editor Group', category: 'View', enabled: () => this.editors.activeGroup.locked, run: () => this.editors.setGroupLock(this.editors.activeGroup, false) });
		register({ id: 'workbench.action.reopenClosedEditor', title: 'Reopen Closed Editor', category: 'View', keybinding: 'Ctrl+Shift+T', run: () => this.editors.reopenClosed() });
		register({ id: 'workbench.openSettings', title: 'Settings', category: 'Preferences', keybinding: 'Ctrl+,', run: () => openSettingsPanel() });
		register({ id: 'workbench.exit', title: 'Exit', category: 'File', keybinding: 'Alt+F4', run: () => getCurrentWindow().close() });

		register({ id: 'editor.undo', title: 'Undo', category: 'Edit', keybinding: 'Ctrl+Z', enabled: hasEditor, run: () => this.editors.runEditorCommand('undo') });
		register({ id: 'editor.redo', title: 'Redo', category: 'Edit', keybinding: 'Ctrl+Y', enabled: hasEditor, run: () => this.editors.runEditorCommand('redo') });
		register({ id: 'editor.cut', title: 'Cut', category: 'Edit', keybinding: 'Ctrl+X', enabled: hasEditor, run: () => void document.execCommand('cut') });
		register({ id: 'editor.copy', title: 'Copy', category: 'Edit', keybinding: 'Ctrl+C', enabled: hasEditor, run: () => void document.execCommand('copy') });
		// A browser forbids execCommand('paste'): the remote workbench reads the clipboard
		// through the plugin (its shim falls back to a paste box) and inserts directly.
		register({ id: 'editor.paste', title: 'Paste', category: 'Edit', keybinding: 'Ctrl+V', enabled: hasEditor, run: () => (hook('session').remote() ? void this.editors.pasteFromClipboard() : void document.execCommand('paste')) });
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
		// The `.py` tab-strip run button's palette twin (VS Code's Run Python File): the
		// terminal opens with the file's interpreter line.
		register({ id: 'python.runFile', title: 'Python: Run File in Terminal', category: 'Python', enabled: () => this.editors.activeInput?.kind === 'file' && /\.py$/i.test(this.editors.activeInput.path), run: () => { const input = this.editors.activeInput; if (input?.kind === 'file') void this.runPythonFile(input.path); } });
		register({ id: 'workbench.openHexViewer', title: 'File: Open in Hex Viewer', category: 'File', enabled: () => this.editors.activeInput?.kind === 'file', run: () => void this.editors.openHex(this.editors.activeInput!.kind === 'file' ? this.editors.activeInput.path : '') });
		register({ id: 'workbench.compareFolders', title: 'Compare Two Folders...', category: 'File', enabled: hasRepo, run: () => void this.compareFolders() });
		register({ id: 'workbench.gotoSymbolInFile', title: 'Go to Symbol in File...', category: 'Go', keybinding: 'Ctrl+Shift+O', enabled: () => this.editors.activeInput?.kind === 'file', run: () => void this.editors.gotoSymbolInFile() });
		register({ id: 'workbench.gotoSymbolInWorkspace', title: 'Go to Symbol in Workspace...', category: 'Go', keybinding: 'Ctrl+T', enabled: hasRepo, run: () => void this.gotoWorkspaceSymbol() });
		register({ id: 'workbench.gotoLine', title: 'Go to Line/Column...', category: 'Go', keybinding: 'Ctrl+G', enabled: () => this.editors.activeView !== null, run: () => this.quickOpen(':') });
		register({ id: 'editor.findReferences', title: 'Find References', category: 'Go', keybinding: 'Shift+F12', enabled: () => this.editors.activeView !== null, run: () => void this.editors.findReferences() });
		register({ id: 'symbols.rebuild', title: 'Rebuild Symbol Index', category: 'Go', enabled: hasRepo, run: () => void this.rebuildSymbolIndex() });
		register({ id: 'editor.callTree', title: 'Show Call Tree', category: 'Go', enabled: () => this.editors.activeView !== null, run: () => void this.editors.openCallTreeAtCursor() });
		register({ id: 'editor.formatDocument', title: 'Format Document', category: 'Editor', keybinding: 'Ctrl+Shift+I', enabled: () => this.editors.activeView !== null, run: () => void this.formatActiveDocument() });
		register({ id: 'editor.toggleBookmark', title: 'Toggle Bookmark', category: 'Edit', keybinding: 'Ctrl+Alt+B', enabled: () => this.editors.activeInput?.kind === 'file', run: () => void this.toggleBookmark() });
		register({ id: 'editor.listBookmarks', title: 'List Bookmarks', category: 'Edit', keybinding: 'Ctrl+Alt+K', run: () => void this.listBookmarks() });
		register({ id: 'extensions.installFromVsix', title: 'Install Extension from VSIX...', category: 'Extensions', run: () => { this.showView('extensions'); void this.extensions.installFromVsixCommand(); } });
		register({ id: 'extensions.checkForUpdates', title: 'Check for Extension Updates', category: 'Extensions', run: () => { this.showView('extensions'); void this.extensions.checkForUpdates(); } });
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
		register({ id: 'help.selfTest', title: 'Run Module Self-Tests', category: 'Help', run: () => this.editors.openSelfTest() });
		register({ id: 'ai.providers', title: 'Manage Model Providers', category: 'AI', run: () => this.editors.openProviders() });
		register({ id: 'help.repository', title: 'Report Issue / Project Page', category: 'Help', run: () => void openUrl('https://github.com/neophack/git-graph-studio') });
		register({ id: 'help.about', title: 'About', category: 'Help', run: () => notify('info', `Git Graph Studio ${__APP_VERSION__} - a standalone workbench whose views arrive as plugins.`) });
		register({ id: 'help.openDevTools', title: 'Open Developer Tools', category: 'Help', run: () => void openDevtools().catch((e) => console.error('open_devtools failed:', e)) });
		// Dev builds only (vite strips the branch from the bundle; vitest is excluded so the
		// command sweep never navigates): the dev harness page — the full functional pass
		// (?full=1) runs every module's self-tests plus the two marketplace extensions end
		// to end against THIS window's real backend, the only mode that catches
		// packaged-only regressions on any platform.
		if (import.meta.env.DEV && !import.meta.env.VITEST) {
			register({ id: 'help.devHarness', title: 'Open Dev Harness (Full Test)', category: 'Help', run: () => { window.location.href = '/dev/dev-harness.html?full=1&run=' + Date.now(); } });
		}

		registerGitCommands(commands, {
			repoPath: () => this.repoPath,
			repoChanged: () => this.scheduleRefresh(0),
			openFolder: (path) => this.openFolder(path),
			showOutput: () => this.panel.show('output'),
			commit: (options) => this.scm.commit(options)
		});
	},

	wire(): void {
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
		// A `.py` file's tab-strip run button: the terminal opens with the file's run line
		// (the editor area reaches no panel).
		this.editors.onRunInTerminal = (path) => void this.runPythonFile(path);

		this.explorer.onFileOpened = (path) => void this.editors.openFile(path);
		this.explorer.onOpenInDirection = (path, direction) => this.editors.openInDirection(path, direction);
		this.explorer.onOpenHex = (path) => void this.editors.openHex(path);
		this.explorer.onOpenFolder = () => void this.pickFolder();
		this.explorer.onPathRenamed = (from, to) => this.editors.pathRenamed(from, to);
		this.explorer.onPathDeleted = (path) => this.editors.pathDeleted(path);
		this.explorer.onOpenInTerminal = (folder) => void this.panel.runInTerminal(`cd ${quoteShellPath(folder)}`);
		// "Module Analysis" over the picked folder(s): a scoped Module Analysis tab,
		// one per folder set (the blank-area pick on the root is the workspace page).
		this.explorer.onModuleAnalysis = (folders) => void this.editors.openAnalysisPage('modules', folders);
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
		this.scm.onCount = (count) => this.setScmBadge(count);
		this.scm.onConflicts = (count) => this.statusBar.setConflicts(count);
		this.scm.onChanged = () => {
			void this.explorer.refresh();
		};
		// The Analysis sidebar's tool rows open their result pages in the editor area.
		this.analysis.onOpenTool = (tool: AnalysisToolId) => void this.editors.openAnalysisPage(tool);

		// The refresh's own repo_head feeds the bar (one subprocess serves both views); a failed
		// fetch falls back to the bar fetching the head itself.
		this.scm.onHead = (head) => {
			if (head) this.statusBar.applyHead(head);
			else void this.statusBar.refreshHead();
		};

		this.editors.onActiveChange = (editor) => {
			this.scheduleSnapshot();
			this.statusBar.setEditor(editor);
			this.followContextSymbol(editor);
			if (editor?.kind === 'file' && editor.path && state.layout.sidebarVisible && this.activeView === 'explorer') {
				void this.explorer.reveal(editor.path);
			}
			// The extension frames learn the active editor, and an editor of a declared
			// language wakes the extensions listening for it.
			if (editor?.kind === 'file' && editor.path) this.extensionHost.noteLanguageOpened(editor.path);
			this.extensionHost.noteActiveEditor(editor);
		};
		this.editors.onNavigationChange = () => this.titleBar.setNavigation(this.editors.canGoBack(), this.editors.canGoForward());
		// The session snapshot (tabs, active tab, expanded folders) follows every change, coalesced.
		this.editors.onTabsChange = () => this.scheduleSnapshot();
		this.explorer.onExpandedChange = () => this.scheduleSnapshot();
		this.editors.onFileSaved = (path) => {
			this.scheduleRefresh(0);
			this.extensionHost.noteDocumentSaved(path);
		};
		this.editors.onSaveProgress = (progress) => this.statusBar.setSaveProgress(progress);
		this.editors.renderWelcome = (container) => this.renderWelcome(container);
		this.editors.renderHelp = (help, container) => (help === 'welcome' ? this.renderWelcome(container) : this.renderShortcuts(container));
		// The self-test page is a lazy chunk (it carries every module's suites): the pane
		// mounts it on open, and the first open starts the run by itself.
		this.editors.renderSelfTest = (container) => {
			void import('../features/selftest').then((page) => page.mountSelfTestPage(container, this));
		};
		// The Model Providers page is a lazy chunk of the same shape.
		this.editors.renderProviders = (container) => {
			void import('../features/providers').then((page) => page.mountProvidersPage(container));
		};

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
			// Remote Access's replica (docs/ggs-remote-plan.md §22): while a remote browser
			// watches this window, or the instance is a remote host, closing only hides it —
			// the workbench, its terminals and the extension pages (a Claude Code turn in
			// flight) keep running for the browser.
			if (!hook('session').remote() && (await this.keepRunningHidden())) {
				event.preventDefault();
				void remoteHostHideMain().catch(() => undefined);
				return;
			}
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
		// dragged onto the window arrive here. Over the Explorer they copy into the folder
		// under the cursor (VS Code's own explorer drop); anywhere else each one opens like
		// "Open File..." would. The remote shim synthesizes these events from a browser
		// DragEvent after uploading into the open folder (already CSS pixels, no Explorer
		// routing of its own), so there a drop only opens, as it always has.
		void getCurrentWebview().onDragDropEvent((event) => {
			const payload = event.payload;
			if (hook('session').remote()) {
				if (payload.type === 'drop') for (const path of payload.paths) void this.editors.openFile(path);
				return;
			}
			if (payload.type === 'leave') {
				this.explorer.endExternalDrag();
				return;
			}
			// Tauri reports the position in physical pixels; the tree hit-tests CSS pixels.
			const x = payload.position.x / window.devicePixelRatio;
			const y = payload.position.y / window.devicePixelRatio;
			if (payload.type === 'drop') {
				void this.explorer.dropExternalFiles(x, y, payload.paths).then((consumed) => {
					if (!consumed) for (const path of payload.paths) void this.editors.openFile(path);
				});
			} else {
				// 'enter' and 'over': the drop ring follows the cursor.
				this.explorer.noteExternalDrag(x, y);
			}
		}).then((unlisten) => this.trackUnlisten(unlisten)).catch(() => undefined);
		// macOS Finder's "Open With" handoff, once the backend knows this window has booted.
		void listen<OpenedPaths>(OPEN_PATHS_EVENT, (event) => void this.onOpenPaths(event.payload)).then((unlisten) => this.trackUnlisten(unlisten)).catch(() => undefined);
		// Remote Access (module 19): what this window shows, for the window picker's cards.
		const stopSummary = hook('summaryReporter')({ tabs: () => this.editors.contentSummary(), scmChanges: () => this.scmChangeCount });
		this.trackUnlisten(stopSummary);
		// The replica host: remote browsers show this window's live copy (§22).
		const mirror = hook('mirror');
		if (!hook('session').remote() && mirror) this.trackUnlisten(mirror.install());
	},

	async keepRunningHidden(): Promise<boolean> {
		const mirror = hook('mirror');
		if (mirror && await mirror.viewersActive()) return true;
		const status = await remoteHostStatus().catch(() => null);
		return status?.remoteHostOnly === true;
	},

	async boot(): Promise<void> {
		try {
			await this.bootInner();
		} finally {
			this.workbenchSync?.start();
		}
	},

	async bootInner(): Promise<void> {
		// One round trip instead of three: the launch form (a file, comparison actions, or the
		// folder argument) decides everything the boot does next. A plain-folder launch is
		// opened inside this very call (the backend opens it during the splash), so when the
		// folder the boot picks matches, the answer is applied directly - no second round trip.
		const context = await bootContext()
			.catch((): BootContext => ({ file: null, actions: [], repo: null, workspace: null, reloaded: false, opened: null, openedFor: null }));
		// A `ggs <file>` launch shows exactly that file, alone.
		if (context.file) {
			await this.openFileStandalone(context.file);
			return;
		}
		// A `ggs <workspace>.ggs-workspace` launch opens that multi-root workspace. A page
		// reload is past its launch: the window may have switched folders since, and what it
		// holds now is the remembered folder below.
		if (context.workspace && !context.reloaded) {
			await this.openWorkspace(context.workspace);
			return;
		}
		// A `ggs compare|hex|hex-compare|folder-compare ...` launch opens its comparison as the
		// window's first tab, over no folder of its own - the same tabs the Explorer's
		// "Compare Two Files/Folders" menu opens.
		if (context.actions.length > 0) {
			this.statusBar.setRepo(false);
			for (const action of context.actions) {
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
			// A `ggs <folder>` launch is explicit: it beats everything the last session
			// remembered (VS Code's own precedence — `code <dir>` opens <dir>, whatever was
			// open before). Only a no-argument launch falls back to the remembered folder —
			// or to the remembered `.ggs-workspace` file, whose multi-root set must not
			// reopen as its first root. A page reload is no launch: the backend still holds
			// the window's open roots, `repo` being a workspace's FIRST root, so there the
			// remembered workspace file wins - its other roots would drop otherwise.
			const remembered = state.lastFolder();
			const rememberedWorkspace = remembered !== null && remembered.toLowerCase().endsWith('.ggs-workspace');
			const last = context.reloaded && rememberedWorkspace ? remembered : context.repo ?? remembered;
			if (last) {
				if (last.toLowerCase().endsWith('.ggs-workspace')) {
					await this.openWorkspace(last);
				} else {
					if (context.opened !== null && context.openedFor === last) {
						// The backend already opened this very folder inside `boot_context`:
						// apply the answer directly instead of spending another round trip.
						await this.applyRoots([context.opened.root], context.opened.isRepo, null);
					} else {
						await this.openFolder(last);
					}
				}
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
	},

	async recoverBackups(): Promise<void> {
		if (!this.repoPath) return;
		let backups: BackupEntry[];
		try {
			backups = await backupList();
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
				const contents = await backupRead(backup.path);
				if (await this.editors.restoreBackup(backup.path, contents)) restored++;
			} catch {
				// A backup that cannot be read is left in place for the next launch.
			}
		}
		if (restored > 0) notify('info', `Recovered ${restored} unsaved file${restored === 1 ? '' : 's'} from the last session. Save to keep the changes.`);
	},
};
