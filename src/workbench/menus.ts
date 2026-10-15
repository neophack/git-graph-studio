// The workbench menus: the title bar's menu tree and the remote-session pruning of desktop-only entries.

import type { Workbench } from './workbench';

import { invoke, Channel } from '../platform/ipc/core';
import { listen } from '../platform/ipc/core';
import { appNewInstance, bootContext, type BootContext, bootStage, closeFolder, openDevtools, openFolder, openSingleFile, openWorkspace, type OpenedRoot, postFirstPaint } from '../platform/ipc/app';
import { backupList, backupRead, type BackupEntry, encodings, listFiles, readFile } from '../platform/ipc/fs';
import { workspaceSymbols } from '../platform/ipc/search';
import { symbolLookup, symbolsRebuild, type SymbolIndexEvent, type SymbolIndexStatus } from '../platform/ipc/symbols';
import { gitInit } from '../platform/ipc/scm';
import { viewerClose, viewerOpen } from '../platform/ipc/viewer';
import { remoteHostHideMain, remoteHostStatus } from '../platform/ipc/remote';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { openUrl } from '@tauri-apps/plugin-opener';
import { AnalysisView, type AnalysisStatus } from '../features/analysis';
import type { AnalysisToolId } from '../features/analysis';
import { mountProviderSwitcher } from '../features/providers';
import { mountProviderPaneGate } from '../features/providers';
import { commandForBinding, commands, effectiveBinding, setKeybindingResolver, UNSHIFTED_GLYPHS } from '../platform/commands';
import { registerDecorationType } from '../features/editor';
import { setExtensionCompletionProvider } from '../features/editor';
import { setExtensionDefinitionOpener, setExtensionDefinitionProvider, setExtensionHoverProvider } from '../features/editor';
import { languageIdFor, registerContextProvider } from '../features/extensions';
import { EditorArea } from '../features/editor';
import { ENCODING_LABELS } from '../features/editor';
import type { EditorPlacement } from '../features/editor/types';
import { Explorer } from '../features/explorer';
import { ExtensionHost, extTitle, type ExtInfo, type PageDiffRequest } from '../features/extensions';
import { ExtensionsPanel } from '../features/extensions';
import { registerGitCommands } from '../features/scm';
import { clearBookmarks, listBookmarks, toggleBookmark } from '../features/editor';
import { effectiveKeybinding, loadUserKeybindings, renderKeybindingsEditor } from '../platform/keybindings';
import { Panel } from './panel';
import { SearchView } from '../features/search';
import { SourceControlView } from '../features/scm';
import { t, tf } from '../platform/i18n';
import { hook } from '../platform/hooks';
import { openSettingsPanel } from './settingsPanel';
import { SETTINGS_EVENT, settings, THEME_EVENT, updateSetting } from '../platform/settings';
import * as state from '../platform/state';
import { StatusBar } from './statusbar';
import { TitleBar } from './titlebar';
import { basename, busy, el, icon, notify, quickInput, quickPick, relativeTo, toPosix, tooltip, type MenuEntry, type QuickPickItem, type QuickPickSource } from '../platform/ui/index';
import { FilePickSource } from '../features/quickOpen';
import { ExtensionTreeView } from '../features/extensions';
import { evaluateWhen, extensionViewContributions } from '../features/extensions';
import { extFileDataUrl } from '../platform/extAssets';

/** The menus concern of Workbench — assigned onto the prototype by the module facade (index.ts). */
export const menusMethods: ThisType<Workbench> = {
	menus() {
		const item = (id: string) => commands.menuItem(id);
		return [
			{ label: t('menu.file'), entries: (): MenuEntry[] => [
				// A browser session spawns a PC-side window it cannot see — the remote's own
				// New Window lives in its window switcher, so the desktop entry hides here.
				...(hook('session').remote() ? [] : [item('workbench.newWindow')]), item('workbench.newFile'), 'separator',
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
			item('workbench.showExplorer'), item('workbench.showSearch'), item('workbench.showScm'), item('workbench.showOutput'), item('workbench.showContext'), item('workbench.showSymbolDatabase'), 'separator',
			{ label: t('menu.analysis'), submenu: [
				item('analysis.showModules'), item('analysis.showMetrics'), item('analysis.showDeadCode'), item('analysis.showSecurity'), item('analysis.showImports'), item('analysis.showMcp')
			] },
			'separator', item('editor.toggleWordWrap'), 'separator', item('markdown.showPreview'), item('markdown.showPreviewToSide'), item('git.openFileHistory'), item('git.toggleBlame'), 'separator',
				// The phone shell's CSS keeps one editor group on screen — the split/move
				// layout commands are noise there (they stay on the desktop and tablet).
				...(hook('navigation').phoneShell() ? [] : [{ label: 'Editor Layout', submenu: [
					item('workbench.splitEditor'), item('workbench.action.splitEditorOrthogonal'), 'separator',
					item('workbench.action.splitEditorLeft'), item('workbench.action.splitEditorRight'), item('workbench.action.splitEditorUp'), item('workbench.action.splitEditorDown'), 'separator',
					item('workbench.action.moveEditorToNextGroup'), item('workbench.action.moveEditorToPreviousGroup'),
					{ label: 'Move Editor into Group', submenu: [
						item('workbench.action.moveEditorToLeftGroup'), item('workbench.action.moveEditorToRightGroup'), item('workbench.action.moveEditorToAboveGroup'), item('workbench.action.moveEditorToBelowGroup')
					] }, 'separator',
					item('workbench.focusFirstEditorGroup'), item('workbench.focusSecondEditorGroup'), item('workbench.focusThirdEditorGroup'), item('workbench.action.focusLastEditorGroup'), 'separator',
					item('workbench.action.evenEditorWidths'), item('workbench.action.toggleMaximizeEditorGroup'), item('workbench.action.minimizeOtherEditorGroups'), item('workbench.action.joinAllGroups'), item('workbench.action.resetEditorGroups'), 'separator',
					item('workbench.action.closeEditorsInGroup'), item('workbench.action.closeEditorsInOtherGroups'), 'separator',
					item('workbench.action.lockEditorGroup'), item('workbench.action.unlockEditorGroup'), item('workbench.action.reopenClosedEditor')
				] } as MenuEntry]),
				{ label: 'Appearance', submenu: [
					{ label: 'Primary Side Bar', checked: state.layout.sidebarVisible, keybinding: 'Ctrl+B', run: () => this.toggleSidebar() },
					{ label: 'Panel', checked: this.panel.isVisible(), keybinding: 'Ctrl+J', run: () => this.panel.toggle() }
				] },
				'separator', item('workbench.closeEditor'), item('workbench.closeAllEditors')
			] },
			{ label: t('menu.go'), entries: (): MenuEntry[] => [item('workbench.quickOpen'), 'separator', item('workbench.gotoSymbolInFile'), item('workbench.gotoSymbolInWorkspace'), item('editor.gotoDefinition'), item('editor.findReferences'), item('editor.callTree'), item('workbench.gotoLine'), item('symbols.rebuild'), 'separator', item('workbench.goBack'), item('workbench.goForward'), 'separator', item('workbench.nextEditor'), item('workbench.previousEditor')] },
			{ label: t('menu.terminal'), entries: (): MenuEntry[] => [item('terminal.new'), item('terminal.toggle'), 'separator', item('terminal.kill')] },
			{ label: t('menu.help'), entries: (): MenuEntry[] => [
				item('help.welcome'),
				// A phone has no keyboard to bind — the shortcuts page is a desktop read.
				...(hook('navigation').phoneShell() ? [] : [item('help.shortcuts')]),
				item('help.selfTest'), ...((import.meta.env.DEV && !import.meta.env.VITEST) ? [item('help.devHarness')] : []), 'separator', item('help.repository'), 'separator',
				// Opens the PC's own (hidden relay) devtools — invisible to a browser user.
				...(hook('session').remote() ? [] : [item('help.openDevTools')]),
				'separator', item('help.about')
			] }
		];
	},
};
