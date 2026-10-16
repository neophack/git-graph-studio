// The workbench menus: the title bar's menu tree, pruned per the shell's command config
// (docs/remote-client-plan.md §3.2 — the registry's profiles decide; the one runtime case
// left here is the mirror viewer driving the desktop window).

import type { Workbench } from './workbench';

import { commands } from '../platform/commands';
import { t } from '../platform/i18n';
import { hook } from '../platform/hooks';
import * as state from '../platform/state';
import { basename, type MenuEntry } from '../platform/ui/index';

/** The menus concern of Workbench — assigned onto the prototype by the module facade (index.ts). */
export const menusMethods: ThisType<Workbench> = {
	menus() {
		const item = (id: string) => commands.menuItem(id);
		// Who the File menu serves (§3.2, K3/K4): the remote shell never lists the
		// machine-level opens — they are desktop-profile commands. The desktop window
		// itself keeps them, but while a mirror viewer drives it the native dialogs and
		// spawned windows would open only on the PC's screen, so they fold away there
		// too; Open Folder stays (the in-window browse the viewer can see and drive).
		const remote = () => commands.activeProfile() === 'remote';
		const watched = () => (hook('mirror')?.viewersNow() ?? false);
		const hideOpens = () => remote() || watched();
		return [
			{ label: t('menu.file'), entries: (): MenuEntry[] => [
				...(hideOpens() ? [] : [item('workbench.newWindow')]), item('workbench.newFile'), 'separator',
				...(remote() ? [] : [item('workbench.openFolder')]),
				...(hideOpens() ? [] : [item('workbench.openFileStandalone'), item('workbench.openWorkspace')]),
				...(remote() ? [] : [{ label: 'Open Recent', submenu: [
					...state.recentFolders().map((folder) => ({ label: basename(folder), keybinding: folder, run: () => void this.openRecent(folder) })),
					...(state.recentFolders().length > 0 ? ['separator' as const] : []),
					{ label: 'Clear Recently Opened', disabled: state.recentFolders().length === 0, run: () => { state.save('recentFolders', []); } }
				] }]),
				'separator', item('workbench.save'), item('workbench.saveAll'), 'separator',
				item('workbench.closeEditor'),
				...(remote() ? [] : [item('workbench.closeFolder')]), 'separator',
				item('workbench.openSettings'), 'separator',
				...(remote() ? [] : [item('workbench.exit')])
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
				// Opens the PC's own (hidden relay) devtools — a desktop-profile command
				// invisible to a browser user.
				...(commands.visible('help.openDevTools') ? [item('help.openDevTools')] : []),
				'separator', item('help.about')
			] }
		];
	},
};
