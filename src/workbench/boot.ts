// The boot path: first paint, command registration, the wiring pass (including the window-level drag-drop routing), deferred services and backup recovery.

import type { Workbench } from './workbench';

import { listen } from '../platform/ipc/core';
import { appNewInstance, bootContext, type BootContext, openDevtools, windowCloseAck } from '../platform/ipc/app';
import { backupList, backupRead, type BackupEntry, type WatcherReport } from '../platform/ipc/fs';
import {
	symbolLookup,
	symbolMacroExpand,
	symbolsBaseProjectsGet,
	symbolsBaseProjectsSet,
	symbolsConditionsGet,
	symbolsConditionsSet,
	symbolsVolumeStats,
	type SymbolIndexStatus
} from '../platform/ipc/symbols';
import { clearWordHighlights, toggleWordHighlight } from '../features/editor';
import { type RemoteHostStatus, remoteHostHideMain, remoteHostStatus } from '../platform/ipc/remote';
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { openPath, openUrl } from '@tauri-apps/plugin-opener';
import { resolveTerminalPath } from '../features/terminal/links';
import { setHoverRelationsOpener } from '../features/editor/hoverRelations';
import { openRenameDialog } from '../features/search';
import { type AnalysisStatus } from '../features/analysis';
import type { AnalysisToolId } from '../features/analysis';
import { commands } from '../platform/commands';
import { registerGitCommands } from '../features/scm';
import { registerZhCnText, t, tf } from '../platform/i18n';
import { hook } from '../platform/hooks';
import { openSettingsPanel } from './settingsPanel';
import { checkForAppUpdate } from './appUpdate';
import { settings, updateSetting } from '../platform/settings';
import * as state from '../platform/state';
import { basename, notify, relativeTo, toPosix } from '../platform/ui/index';
import { FS_CHANGED_EVENT, FsChange, OPEN_PATHS_EVENT, OpenedPaths, joinRepo, whenIdle } from './workbench';

/** The close decision's pure half (§17.2, G13): the window hides instead of the instance
 *  exiting while a `--remote-host` launch runs, or the daemon reports any remote session
 *  attached to it (the `Sessions` pushes, §17.4 — a session's own workbench counts exactly
 *  as much as a PC-screen viewer). Pure so the lifecycle test drives it directly. */
export function closeHidesWindow(status: Pick<RemoteHostStatus, 'remoteHostOnly' | 'remoteSessions'> | null | undefined): boolean {
	if (!status) return false;
	return status.remoteHostOnly === true || (status.remoteSessions ?? 0) > 0;
}

/** The close-to-hide notice (K15): one OS notification saying the instance is still
 *  running for the remotes, suppressible as the `remoteHideNotice` setting (the notice's
 *  own "don't tell me again"). A notification the OS refuses (or a permission never
 *  granted) simply never shows — nothing may block the close. */
async function notifyCloseHidden(): Promise<void> {
	if (!settings.remoteHideNotice) return;
	try {
		let granted = await isPermissionGranted();
		if (!granted) granted = (await requestPermission()) === 'granted';
		if (!granted) return;
		sendNotification({ title: t('remote.hideNotice.title'), body: t('remote.hideNotice.body') });
	} catch {
		// The plugin's own failure path (§17.2: "or do nothing").
	}
}

/** The boot concern of Workbench — assigned onto the prototype by the module facade (index.ts). */
export const bootMethods: ThisType<Workbench> = {
	registerCommands(): void {
		const hasRepo = () => this.repoPath !== null;
		const editorView = () => this.editors.activeView;
		const hasEditor = () => editorView() !== null;
		const register = commands.register.bind(commands);

		// The two shells' command configs (docs/remote-client-plan.md §3.2): the desktop
		// app owns the machine-level vocabulary — opening folders and files through the
		// native dialogs, spawning windows, closing the workspace, exiting the app, the
		// devtools. The remote shell never lists or keys these (K3/K4); its own vocabulary
		// (transfers, the window switcher) registers from the remote shell with
		// profiles: ['remote'].
		const desktopOnly = { profiles: ['desktop'] as const };
		// VS Code's Windows defaults: Ctrl+O opens a file, the folder lives behind the
		// Ctrl+K Ctrl+O chord — the same chord prefix the rest of this registry spells.
		register({ ...desktopOnly, id: 'workbench.openFolder', title: 'Open Folder...', category: 'File', keybinding: 'Ctrl+K Ctrl+O', run: () => this.pickFolder() });
		// A second workbench is a second instance (no single-instance plugin — every launch
		// its own process, backends and watcher), so "New Window" asks the backend to spawn
		// one; the new window boots like a fresh launch. On Windows and Linux a second launch
		// of the app already is a new instance; on macOS this is the discoverable way to
		// multi-open, where clicking the app's icon again only focuses the running window.
		register({ ...desktopOnly, id: 'workbench.newWindow', title: 'New Window', category: 'File', keybinding: 'Ctrl+Shift+N', run: () => void appNewInstance().catch((error) => notify('error', tf('workbench.newWindowFailed', String(error)))) });
		register({ ...desktopOnly, id: 'workbench.openWorkspace', title: 'Open Workspace...', category: 'File', run: () => this.pickWorkspace() });
		register({ ...desktopOnly, id: 'workbench.openFileStandalone', title: 'Open File...', category: 'File', keybinding: 'Ctrl+O', run: () => this.pickSingleFile() });
		register({ ...desktopOnly, id: 'workbench.closeFolder', title: 'Close Folder', category: 'File', enabled: hasRepo, run: () => this.closeFolder() });
		register({ id: 'workbench.newFile', title: 'New File...', category: 'File', keybinding: 'Ctrl+N', enabled: hasRepo, run: () => this.explorer.newFile() });
		register({ id: 'workbench.save', title: 'Save', category: 'File', keybinding: 'Ctrl+S', enabled: () => this.editors.hasDirtyEditors(), run: () => this.editors.save() });
		// The tab context menu's Save As, as a palette row and Ctrl+Shift+S: it runs the active
		// editor group's own saveAs — the same path the tab menu's row takes.
		register({ id: 'file.saveAs', title: 'Save As...', category: 'File', keybinding: 'Ctrl+Shift+S', enabled: () => this.editors.activeInput?.kind === 'file', run: () => void this.editors.activeGroup.saveAs() });
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
		register({ ...desktopOnly, id: 'workbench.exit', title: 'Exit', category: 'File', keybinding: 'Alt+F4', run: () => getCurrentWindow().close() });

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
		register({ id: 'editor.toggleSymbolHover', title: 'Toggle Symbol Hover', category: 'View', run: () => updateSetting('symbolHover', !settings.symbolHover) });
		register({ id: 'editor.selectAll', title: 'Select All', category: 'Selection', keybinding: 'Ctrl+A', enabled: hasEditor, run: () => this.editors.runEditorCommand('selectAll') });
		// VS Code's line-editing family: join, sort, the case transforms, trim. None carries
		// a free VS Code-matching single key here (Ctrl+J toggles the panel; VS Code's own
		// spellings are chords the registry's chord matcher owns), so they are palette rows.
		// They run on a whole-document CodeMirror view only — the enablement says so.
		register({ id: 'editor.joinLines', title: 'Join Lines', category: 'Edit', enabled: hasEditor, run: () => this.editors.runEditorCommand('joinLines') });
		register({ id: 'editor.sortLinesAscending', title: 'Sort Lines Ascending', category: 'Edit', enabled: hasEditor, run: () => this.editors.runEditorCommand('sortLinesAscending') });
		register({ id: 'editor.sortLinesDescending', title: 'Sort Lines Descending', category: 'Edit', enabled: hasEditor, run: () => this.editors.runEditorCommand('sortLinesDescending') });
		register({ id: 'editor.transformToUppercase', title: 'Transform to Uppercase', category: 'Edit', enabled: hasEditor, run: () => this.editors.runEditorCommand('transformToUppercase') });
		register({ id: 'editor.transformToLowercase', title: 'Transform to Lowercase', category: 'Edit', enabled: hasEditor, run: () => this.editors.runEditorCommand('transformToLowercase') });
		register({ id: 'editor.transformToTitlecase', title: 'Transform to Title Case', category: 'Edit', enabled: hasEditor, run: () => this.editors.runEditorCommand('transformToTitleCase') });
		register({ id: 'editor.trimTrailingWhitespace', title: 'Trim Trailing Whitespace', category: 'Edit', enabled: hasEditor, run: () => this.editors.runEditorCommand('trimTrailingWhitespace') });
		// VS Code's line-motion family and multi-cursor keys, the editor's own keymap bound
		// beside them (textEditor.ts). The arrow keys answer only while the editor itself is
		// focused — Alt+Up/Down and Ctrl+Alt+Up/Down mean other things to an input's history,
		// a terminal shell, and a GPU driver's display rotation, and the focused editor is
		// VS Code's own editorFocus context for them.
		const hasFocusedEditor = () => editorView() !== null && document.activeElement instanceof Element && document.activeElement.closest('.cm-editor') !== null;
		register({ id: 'editor.moveLineUp', title: 'Move Line Up', category: 'Edit', keybinding: 'Alt+Up', enabled: hasFocusedEditor, run: () => this.editors.runEditorCommand('moveLineUp') });
		register({ id: 'editor.moveLineDown', title: 'Move Line Down', category: 'Edit', keybinding: 'Alt+Down', enabled: hasFocusedEditor, run: () => this.editors.runEditorCommand('moveLineDown') });
		register({ id: 'editor.copyLineUp', title: 'Copy Line Up', category: 'Edit', keybinding: 'Shift+Alt+Up', enabled: hasFocusedEditor, run: () => this.editors.runEditorCommand('copyLineUp') });
		register({ id: 'editor.copyLineDown', title: 'Copy Line Down', category: 'Edit', keybinding: 'Shift+Alt+Down', enabled: hasFocusedEditor, run: () => this.editors.runEditorCommand('copyLineDown') });
		register({ id: 'editor.deleteLine', title: 'Delete Line', category: 'Edit', keybinding: 'Ctrl+Shift+K', enabled: hasEditor, run: () => this.editors.runEditorCommand('deleteLine') });
		register({ id: 'editor.goToBracket', title: 'Go to Bracket', category: 'Go', keybinding: 'Ctrl+Shift+\\', enabled: hasEditor, run: () => this.editors.runEditorCommand('goToBracket') });
		register({ id: 'editor.addCursorAbove', title: 'Add Cursor Above', category: 'Selection', keybinding: 'Ctrl+Alt+Up', enabled: hasFocusedEditor, run: () => this.editors.runEditorCommand('addCursorAbove') });
		register({ id: 'editor.addCursorBelow', title: 'Add Cursor Below', category: 'Selection', keybinding: 'Ctrl+Alt+Down', enabled: hasFocusedEditor, run: () => this.editors.runEditorCommand('addCursorBelow') });
		// VS Code's Duplicate Selection (editor.action.duplicateSelection): no default
		// keybinding in VS Code either — the row lives in the editor's context menu and here.
		register({ id: 'editor.duplicateSelection', title: 'Duplicate Selection', category: 'Edit', enabled: hasEditor, run: () => this.editors.runEditorCommand('duplicateSelection') });
		register({ id: 'editor.expandSelection', title: 'Expand Selection', category: 'Selection', keybinding: 'Shift+Alt+Right', enabled: hasEditor, run: () => this.editors.runEditorCommand('expandSelection') });
		register({ id: 'editor.shrinkSelection', title: 'Shrink Selection', category: 'Selection', keybinding: 'Shift+Alt+Left', enabled: hasEditor, run: () => this.editors.runEditorCommand('shrinkSelection') });
		// The new titles' zh-cn twins. Every older command's pair sits in i18n.ts's own
		// table; these register beside the commands that own them, through the same public
		// seam the manifest translations ride (`registerZhCnText`), so the localization
		// sweep sees the labels translated without reaching into that table from here.
		registerZhCnText({
			'Save As...': '另存为...',
			'Join Lines': '联接行',
			'Sort Lines Ascending': '升序排列行',
			'Sort Lines Descending': '降序排列行',
			'Transform to Uppercase': '转换为大写',
			'Transform to Lowercase': '转换为小写',
			'Transform to Title Case': '转换为标题大小写',
			'Trim Trailing Whitespace': '删除尾随空格',
			// The line-motion family's titles double as the editor context menu's row labels.
			'Move Line Up': '上移行',
			'Move Line Down': '下移行',
			'Copy Line Up': '向上复制行',
			'Copy Line Down': '向下复制行',
			'Delete Line': '删除行',
			'Go to Bracket': '转到括号',
			'Add Cursor Above': '在上面添加光标',
			'Add Cursor Below': '在下面添加光标',
			'Duplicate Selection': '重复选择',
			'Toggle Line Comment': '切换行注释',
			'Toggle Block Comment': '切换块注释',
			'Format Document': '格式化文档',
			'Expand Selection': '扩展选择',
			'Shrink Selection': '缩小选择',
			'Open Previous Recently Used Editor': '打开上一个最近使用的编辑器',
			'Open Next Recently Used Editor': '打开下一个最近使用的编辑器',
			'Go to Definition': '转到定义',
			'Peek Definition': '速览定义',
			'Find References': '查找引用'
		});

		register({ id: 'workbench.quickOpen', title: 'Go to File...', category: 'Go', keybinding: 'Ctrl+P', enabled: hasRepo, run: () => this.quickOpen('') });
		register({ id: 'workbench.commandPalette', title: 'Command Palette...', category: 'View', keybinding: 'Ctrl+Shift+P', run: () => this.quickOpen('>') });
		register({ id: 'workbench.goBack', title: 'Go Back', category: 'Go', keybinding: 'Alt+Left', enabled: () => this.editors.canGoBack(), run: () => this.editors.goBack() });
		register({ id: 'workbench.goForward', title: 'Go Forward', category: 'Go', keybinding: 'Alt+Right', enabled: () => this.editors.canGoForward(), run: () => this.editors.goForward() });
		register({ id: 'editor.gotoDefinition', title: 'Go to Definition', category: 'Go', keybinding: 'F12', enabled: () => this.editors.activeView !== null, run: () => void this.editors.goToDefinition() });
		register({ id: 'editor.peekDefinition', title: 'Peek Definition', category: 'Go', keybinding: 'Alt+F12', enabled: () => this.editors.activeView !== null, run: () => void this.editors.peekDefinition() });
		register({ id: 'workbench.nextEditor', title: 'Next Editor', category: 'Go', keybinding: 'Ctrl+PageDown', run: () => this.editors.activateNext(1) });
		register({ id: 'workbench.previousEditor', title: 'Previous Editor', category: 'Go', keybinding: 'Ctrl+PageUp', run: () => this.editors.activateNext(-1) });
		// Ctrl+Tab: the most-recently-used walk within the focused group (the mru the tabs
		// maintain is one group's). Repeats while Ctrl is held walk further; Shift reverses.
		// Unconditioned like next/previousEditor — the walk itself answers nothing with a
		// single editor open.
		register({ id: 'workbench.openPreviousRecentlyUsed', title: 'Open Previous Recently Used Editor', category: 'Go', keybinding: 'Ctrl+Tab', run: () => this.editors.activeGroup.cycleMru(-1) });
		register({ id: 'workbench.openNextRecentlyUsed', title: 'Open Next Recently Used Editor', category: 'Go', keybinding: 'Ctrl+Shift+Tab', run: () => this.editors.activeGroup.cycleMru(1) });

		register({ id: 'workbench.showExplorer', title: 'Explorer', category: 'View', keybinding: 'Ctrl+Shift+E', run: () => this.showView('explorer') });
		register({ id: 'workbench.showSearch', title: 'Search', category: 'View', keybinding: 'Ctrl+Shift+F', run: () => { this.showView('search'); this.seedSearchQuery(); this.search.focus(); } });
		// The Search view's new title's zh-cn twin (the localization sweep reads it here).
		registerZhCnText({
			'Toggle Search Details': '切换搜索详细信息'
		});
		register({ id: 'workbench.replaceInFiles', title: 'Replace in Files', category: 'Search', keybinding: 'Ctrl+Shift+H', run: () => { this.showView('search'); this.search.focusReplace(); } });
		register({ id: 'search.toggleQueryDetails', title: 'Toggle Search Details', category: 'Search', keybinding: 'Ctrl+Shift+J', run: () => { this.showView('search'); this.search.toggleFilters(); } });
		register({ id: 'workbench.showScm', title: 'Source Control', category: 'View', keybinding: 'Ctrl+Shift+G', run: () => this.showView('scm') });
		register({ id: 'workbench.showExtensions', title: 'Extensions', category: 'View', keybinding: 'Ctrl+Shift+X', run: () => this.showView('extensions') });
		register({ id: 'workbench.showAnalysis', title: 'Analysis', category: 'View', keybinding: 'Ctrl+Shift+A', run: () => this.showView('analysis') });
		register({ id: 'workbench.showSymbolWindow', title: 'Symbol Window', category: 'View', keybinding: 'Alt+L', run: () => this.showView('symbolWindow') });
		// The Symbol Window's and its relation graph's own commands: the relation
		// window's three-view cycle, the outline tree's expand set and the sort cycle.
		register({ id: 'relations.nextView', title: 'Next Relation Window View', category: 'View', run: () => this.symbolWindow.cycleRelationView() });
		register({ id: 'symbols.outlineExpandAll', title: 'Expand All', category: 'View', run: () => this.symbolWindow.expandAll() });
		register({ id: 'symbols.outlineCollapseAll', title: 'Collapse All', category: 'View', run: () => this.symbolWindow.collapseAll() });
		register({ id: 'symbols.outlineExpandSpecial', title: 'Expand Special…', category: 'View', run: () => void this.symbolWindow.expandSpecial() });
		register({ id: 'symbols.outlineSort', title: 'Sort Symbol Window', category: 'View', run: () => this.symbolWindow.cycleSort() });
		// The new view's and its activity-bar tooltip's zh-cn twins (the localization sweep
		// reads the command title through trText, as it does every registry title).
		registerZhCnText({
			'Symbol Window': '符号窗口',
			'Symbols (Alt+L)': '符号 (Alt+L)',
			'Next Relation Window View': '下一个关系窗口视图',
			'Expand All': '全部展开',
			'Collapse All': '全部折叠',
			'Expand Special…': '特殊展开…',
			'Sort Symbol Window': '排序符号窗口'
		});
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
		// The HTML tab-strip button's palette twin: the system's default browser renders
		// the page the editor has no preview for.
		register({ id: 'file.openInBrowser', title: 'File: Open in Default Browser', category: 'File', enabled: () => this.editors.activeInput?.kind === 'file' && /\.(html?|xhtml)$/i.test(this.editors.activeInput.path), run: () => { const input = this.editors.activeInput; if (input?.kind === 'file') void openPath(input.path).catch((e) => notify('error', String(e))); } });
		register({ id: 'workbench.openHexViewer', title: 'File: Open in Hex Viewer', category: 'File', enabled: () => this.editors.activeInput?.kind === 'file', run: () => void this.editors.openHex(this.editors.activeInput!.kind === 'file' ? this.editors.activeInput.path : '') });
		register({ id: 'workbench.compareFolders', title: 'Compare Two Folders...', category: 'File', enabled: hasRepo, run: () => void this.compareFolders() });
		register({ id: 'workbench.gotoSymbolInFile', title: 'Go to Symbol in File...', category: 'Go', keybinding: 'Ctrl+Shift+O', enabled: () => this.editors.activeInput?.kind === 'file', run: () => void this.editors.gotoSymbolInFile() });
		register({ id: 'workbench.gotoSymbolInWorkspace', title: 'Go to Symbol in Workspace...', category: 'Go', keybinding: 'Ctrl+T', enabled: hasRepo, run: () => void this.gotoWorkspaceSymbol() });
		register({ id: 'workbench.gotoLine', title: 'Go to Line/Column...', category: 'Go', keybinding: 'Ctrl+G', enabled: () => this.editors.activeView !== null, run: () => this.quickOpen(':') });
		register({ id: 'editor.findReferences', title: 'Find References', category: 'Go', keybinding: 'Shift+F12', enabled: () => this.editors.activeView !== null, run: () => void this.editors.findReferences() });
		register({ id: 'symbols.rebuild', title: 'Rebuild Symbol Index', category: 'Go', enabled: hasRepo, run: () => void this.rebuildSymbolIndex() });
		// The rename dialog opens with the cursor's word prefilled as the read-only current
		// name (a rename always names the whole symbol); no default keybinding — F2 is the
		// Explorer tree's own inline file rename, and its keydown bubbles to the document
		// unclaimed, so a registry F2 here would fire both renames on one press. The site
		// rows' jumps join the workspace root exactly like the relations page's.
		register({
			id: 'symbols.rename',
			title: 'Rename Symbol',
			category: 'Go',
			enabled: hasRepo,
			run: () => {
				const view = editorView();
				let word = '';
				if (view) {
					const position = view.state.selection.main.head;
					const line = view.state.doc.lineAt(position);
					const found = view.state.wordAt(Math.min(Math.max(line.from, position), line.to));
					if (found) word = view.state.sliceDoc(found.from, found.to);
				}
				openRenameDialog({ old: word }, {
					onOpen: (path, line) => {
						if (this.repoPath) void this.editors.openFile(/^([a-zA-Z]:[\\/]|\\|\/)/.test(path) || !this.repoPath ? path : joinRepo(this.repoPath, path), { line });
					}
				});
			}
		});
		registerZhCnText({ 'Rename Symbol': '重命名符号' });
		register({
			id: 'symbols.switchDeclDef',
			title: 'Switch Between Declaration and Definition',
			category: 'Go',
			keybinding: 'Ctrl+F12',
			enabled: () => this.editors.activeView !== null,
			run: () => {
				const view = editorView();
				if (!view) return;
				const position = view.state.selection.main.head;
				const line = view.state.doc.lineAt(position);
				const found = view.state.wordAt(Math.min(Math.max(line.from, position), line.to));
				if (!found) return;
				const name = view.state.sliceDoc(found.from, found.to);
				const active = this.editors.activeGroup.activeEditor;
				const current = active && active.input.kind === 'file' ? active.input.path ?? '' : '';
				if (!name || !current || !this.repoPath) return;
				void (async () => {
					let defs: { path: string; line: number }[];
					try {
						defs = (await symbolLookup(name)) ?? [];
					} catch {
						return;
					}
					// A definition in another file outranks the cursor's own file — the same-stem
					// pair first (a.c beside a.h, app.ts beside app.d.ts), then any other file —
					// so a body lands on its prototype and a prototype lands on its body.
					const toAbs = (path: string) => (/^([a-zA-Z]:[\\/]|\\|\/)/.test(path) ? path : joinRepo(this.repoPath!, path));
					const key = (path: string) => toAbs(path).replaceAll('\\', '/').toLowerCase();
					const here = key(current);
					const stem = (path: string) => path.replace(/\.[^.]+$/, '');
					const others = defs.filter((def) => key(def.path) !== here);
					const target = others.find((def) => stem(key(def.path)) === stem(here)) ?? others[0];
					if (!target) return;
					void this.editors.openFile(toAbs(target.path), { line: target.line + 1 });
				})();
			}
		});
		registerZhCnText({ 'Switch Between Declaration and Definition': '声明与定义互切' });
		register({ id: 'editor.callTree', title: 'Show Call Tree', category: 'Go', enabled: () => this.editors.activeView !== null, run: () => void this.editors.openCallTreeAtCursor() });
		register({ id: 'editor.formatDocument', title: 'Format Document', category: 'Editor', keybinding: 'Ctrl+Shift+I', enabled: () => this.editors.activeView !== null, run: () => void this.formatActiveDocument() });
		register({ id: 'editor.toggleBookmark', title: 'Toggle Bookmark', category: 'Edit', keybinding: 'Ctrl+Alt+B', enabled: () => this.editors.activeInput?.kind === 'file', run: () => void this.toggleBookmark() });
		register({ id: 'editor.listBookmarks', title: 'List Bookmarks', category: 'Edit', keybinding: 'Ctrl+Alt+K', run: () => void this.listBookmarks() });
		register({
			id: 'editor.toggleWordHighlight',
			title: 'Toggle Highlight Word',
			category: 'Edit',
			keybinding: 'F8',
			enabled: hasEditor,
			run: () => {
				const view = editorView();
				if (!view) return;
				const head = view.state.selection.main.head;
				const sel = view.state.selection.main;
				const word = !sel.empty
					? view.state.sliceDoc(sel.from, sel.to)
					: (() => {
						const w = view.state.wordAt(head);
						return w ? view.state.sliceDoc(w.from, w.to) : '';
					})();
				if (!word) return;
				toggleWordHighlight(word);
			}
		});
		register({
			id: 'editor.clearWordHighlights',
			title: 'Clear All Word Highlights',
			category: 'Edit',
			run: () => clearWordHighlights()
		});
		register({
			id: 'editor.expandMacro',
			title: 'Preview Macro Expansion',
			category: 'Go',
			enabled: () => hasRepo() && hasEditor(),
			run: () => {
				const view = editorView();
				if (!view) return;
				const head = view.state.selection.main.head;
				const w = view.state.wordAt(head);
				if (!w) return;
				const name = view.state.sliceDoc(w.from, w.to);
				const lineText = view.state.doc.lineAt(head).text;
				void symbolMacroExpand(name, lineText)
					.then((res) => {
						if (!res) notify('info', `No macro definition found for '${name}'.`);
						else notify('info', `${res.name} → ${res.expanded}`);
					})
					.catch((e) => notify('error', String(e)));
			}
		});
		register({
			id: 'symbols.configureConditions',
			title: 'Configure Conditional Compilation Macros...',
			category: 'Go',
			enabled: hasRepo,
			run: () => {
				void (async () => {
					// `?? fallback` beside the `.catch`: an unscripted harness answer resolves null
					// (DefaultingHandlers), and the real backend's Err rejects — both fall back.
					const cur = (await symbolsConditionsGet().catch(() => null)) ?? { macros: {} as Record<string, number | null> };
					const initial = Object.entries(cur.macros)
						.map(([k, v]) => (v === null ? `!${k}` : `${k}=${v}`))
						.join(', ');
					const raw = window.prompt('Preprocessor macros (e.g. DEBUG=1, WIN32=0, !LEGACY):', initial);
					// jsdom's unimplemented prompt answers undefined; only null/undefined cancel.
					if (raw === null || raw === undefined) return;
					const macros: Record<string, number | null> = {};
					for (const part of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
						if (part.startsWith('!')) {
							const k = part.slice(1).trim();
							if (k) macros[k] = null;
						} else if (part.includes('=')) {
							const [k, v] = part.split('=');
							if (k?.trim()) macros[k.trim()] = Number.parseInt(v?.trim() ?? '1', 10) || 0;
						} else {
							macros[part] = 1;
						}
					}
					await symbolsConditionsSet({ macros });
					notify('info', `Saved ${Object.keys(macros).length} conditional compilation macro(s).`);
				})();
			}
		});
		register({
			id: 'symbols.configureBaseProjects',
			title: 'Configure Read-Only Base / SDK Projects...',
			category: 'Go',
			enabled: hasRepo,
			run: () => {
				void (async () => {
					const cur = (await symbolsBaseProjectsGet().catch(() => null)) ?? ([] as string[]);
					const raw = window.prompt('Read-only Base / SDK project folders (comma-separated):', cur.join(', '));
					if (raw === null || raw === undefined) return;
					const paths = raw.split(',').map((s) => s.trim()).filter(Boolean);
					await symbolsBaseProjectsSet(paths);
					notify('info', `Saved ${paths.length} read-only base project(s).`);
				})();
			}
		});
		register({
			id: 'symbols.volumeStats',
			title: 'Show 9-Volume Index Stats',
			category: 'Go',
			enabled: hasRepo,
			run: () => {
				void symbolsVolumeStats()
					.then((s) => {
						if (!s.present) notify('info', '9-volume index is not built yet.');
						else notify('info', `9-volume index: ${s.symRecords} syms, ${s.sigFiles} sig files, ${s.xabPages} xab / ${s.xsbPages} xsb pages (${(s.totalBytes / 1024).toFixed(1)} KiB).`);
					})
					.catch((e) => notify('error', String(e)));
			}
		});
		registerZhCnText({
			'Toggle Highlight Word': '切换词高亮',
			'Clear All Word Highlights': '清除所有词高亮',
			'Preview Macro Expansion': '预览宏展开',
			'Configure Conditional Compilation Macros...': '配置条件编译宏...',
			'Configure Read-Only Base / SDK Projects...': '配置只读基础 / SDK 工程...',
			'Show 9-Volume Index Stats': '查看 9 文件索引统计'
		});
		register({ id: 'extensions.installFromVsix', title: 'Install Extension from VSIX...', category: 'Extensions', run: () => { this.showView('extensions'); void this.extensions.installFromVsixCommand(); } });
		register({ id: 'extensions.checkForUpdates', title: 'Check for Extension Updates', category: 'Extensions', run: () => { this.showView('extensions'); void this.extensions.checkForUpdates(); } });
		register({ id: 'git.initRepository', title: 'Initialize Repository', category: 'Git', enabled: () => this.repoPath !== null && !this.isRepo, run: () => void this.initializeRepository() });
		register({ id: 'workbench.toggleSidebar', title: 'Toggle Primary Side Bar', category: 'View', keybinding: 'Ctrl+B', run: () => this.toggleSidebar() });
		register({ id: 'workbench.togglePanel', title: 'Toggle Panel', category: 'View', keybinding: 'Ctrl+J', run: () => this.panel.toggle() });
		// The window/view modes (the Appearance menu): the fullscreen toggle, the zoom ladder
		// and zen mode. The layouts behind them live in layout.ts; where the webview/window
		// API lacks the method (the browser shim, the tests' mock) they answer nothing.
		register({ id: 'view.toggleFullScreen', title: 'Toggle Full Screen', category: 'View', keybinding: 'F11', run: () => this.toggleFullScreen() });
		register({ id: 'view.zoomIn', title: 'Zoom In', category: 'View', keybinding: 'Ctrl+=', run: () => this.zoomWorkbench('in') });
		register({ id: 'view.zoomOut', title: 'Zoom Out', category: 'View', keybinding: 'Ctrl+-', run: () => this.zoomWorkbench('out') });
		register({ id: 'view.zoomReset', title: 'Reset Zoom', category: 'View', keybinding: 'Ctrl+0', run: () => this.zoomWorkbench('reset') });
		register({ id: 'view.zenMode', title: 'Toggle Zen Mode', category: 'View', keybinding: 'Ctrl+K Z', run: () => this.toggleZenMode() });
		register({ id: 'workbench.showOutput', title: 'Output', category: 'View', run: () => this.panel.show('output') });
		register({ id: 'workbench.showContext', title: 'Context', category: 'View', run: () => this.panel.show('context') });
		register({ id: 'workbench.showDefinition', title: 'Definition', category: 'View', run: () => this.panel.show('definition') });
		register({ id: 'workbench.showReferences', title: 'References', category: 'View', run: () => this.panel.show('references') });
		// The panel page's zh-cn twin (the localization sweep reads the command title
		// through trText, as it does every registry title).
		registerZhCnText({ 'Definition': '定义', 'References': '引用' });
		register({ id: 'workbench.showSymbolDatabase', title: 'Symbol Database', category: 'View', enabled: hasRepo, run: () => void this.editors.openSymbolDatabase() });
		register({ id: 'workbench.focusNextPart', title: 'Focus Next Part', category: 'View', keybinding: 'F6', run: () => this.focusNextPart() });
		register({ id: 'terminal.toggle', title: 'Toggle Terminal', category: 'Terminal', keybinding: 'Ctrl+`', run: () => this.panel.toggle('terminal') });
		register({ id: 'terminal.new', title: 'New Terminal', category: 'Terminal', keybinding: 'Ctrl+Shift+`', run: async () => { this.panel.show('terminal'); await this.panel.terminal.newTerminal(); } });
		register({ id: 'terminal.kill', title: 'Kill the Active Terminal Instance', category: 'Terminal', enabled: () => this.panel.terminal.sessionCount() > 0, run: () => this.panel.terminal.killActive() });
		// Ctrl+Click on a printed path lands here: the layer reports the path raw (MSYS
		// `/c/...`, `src/foo.ts:12`, a drive spelling) and THIS window resolves it — the
		// MSYS mapping unmaps, a relative path joins the open workspace root — before the
		// editor group opens it at the printed line/column. An unwired frontend (the remote
		// shell has no editor group) copies the path instead, inside the terminal module.
		this.panel.terminal.onOpenFile = (path, line, column) => {
			void this.editors.openFile(resolveTerminalPath(path, this.repoPath), { line, column });
		};
		// The four commands' zh-cn titles, through the same merge the extension manifests use
		// (i18n's registerZhCnText — the registry's titles localize at render, and the
		// localization sweep fails any title the table cannot answer).
		registerZhCnText({
			'Find in Terminal': '在终端中查找',
			'Clear Terminal': '清空终端',
			'Select All in Terminal': '在终端中全选',
			'Run Selected Text in Terminal': '在终端中运行选中文本'
		});
		register({ id: 'terminal.find', title: 'Find in Terminal', category: 'Terminal', enabled: () => this.panel.terminal.sessionCount() > 0, run: () => { this.panel.show('terminal'); this.panel.terminal.showFind(); } });
		register({ id: 'terminal.clear', title: 'Clear Terminal', category: 'Terminal', enabled: () => this.panel.terminal.sessionCount() > 0, run: () => this.panel.terminal.clearActive() });
		register({ id: 'terminal.selectAll', title: 'Select All in Terminal', category: 'Terminal', enabled: () => this.panel.terminal.sessionCount() > 0, run: () => this.panel.terminal.selectAllActive() });
		// Ctrl+Shift+Enter is free: no other command binds Enter anywhere.
		register({ id: 'terminal.runSelectedText', title: 'Run Selected Text in Terminal', category: 'Terminal', keybinding: 'Ctrl+Shift+Enter', enabled: () => this.panel.terminal.sessionCount() > 0, run: () => void this.panel.terminal.runSelectedText() });
		register({ id: 'help.welcome', title: 'Welcome', category: 'Help', run: () => this.editors.openHelp('welcome') });
		register({ id: 'help.shortcuts', title: 'Keyboard Shortcuts', category: 'Help', keybinding: 'Ctrl+K Ctrl+S', run: () => this.editors.openHelp('shortcuts') });
		register({ id: 'help.selfTest', title: 'Run Module Self-Tests', category: 'Help', run: () => this.editors.openSelfTest() });
		register({ id: 'ai.providers', title: 'Manage Model Providers', category: 'AI', run: () => this.editors.openProviders() });
		register({ id: 'help.repository', title: 'Report Issue / Project Page', category: 'Help', run: () => void openUrl('https://github.com/neophack/git-graph-studio') });
		// The app's own update check (2026-11-10, the owner's direction: the app itself
		// should be downloadable from GitHub): the repository's newest release, this
		// platform's installer downloaded
		// through the streaming progress toast, then launched (Windows) or revealed.
		registerZhCnText({ 'Check for App Updates': '检查应用更新' });
		register({ id: 'help.checkForUpdates', title: 'Check for App Updates', category: 'Help', run: () => void checkForAppUpdate() });
		register({ id: 'help.about', title: 'About', category: 'Help', run: () => notify('info', `Git Graph Studio ${__APP_VERSION__} - a standalone workbench whose views arrive as plugins.`) });
		register({ ...desktopOnly, id: 'help.openDevTools', title: 'Open Developer Tools', category: 'Help', run: () => void openDevtools().catch((e) => console.error('open_devtools failed:', e)) });
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
			commit: (options) => this.scm.commit(options),
			undoCommit: () => this.scm.undoCommit()
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
		// A replace consults the open-and-dirty paths before writing: a dirty tab never
		// auto-reloads, so the view names those files before the disk write lands.
		this.search.dirtyFilePaths = () => this.editors.contentSummary().filter((s) => s.dirty).map((s) => s.path);
		this.editors.onMergeResolved = () => this.scheduleRefresh(0);
		this.editors.onExternalFileChange = () => this.scheduleRefresh(0);
		// A `.py` file's tab-strip run button: the terminal opens with the file's run line
		// (the editor area reaches no panel).
		this.editors.onRunInTerminal = (path) => void this.runPythonFile(path);

		this.explorer.onFileOpened = (path) => void this.editors.openFile(path);
		this.explorer.onOpenInDirection = (path, direction) => this.editors.openInDirection(path, direction);
		this.explorer.onOpenHex = (path) => void this.editors.openHex(path);
		this.explorer.onOpenMarkdownPreview = (path, toSide) => void (toSide ? this.editors.openMarkdownPreviewToSide(path) : this.editors.openMarkdownPreview(path));
		this.explorer.onOpenFolder = () => void this.pickFolder();
		this.explorer.onPathRenamed = (from, to) => this.editors.pathRenamed(from, to);
		this.explorer.onPathDeleted = (path) => this.editors.pathDeleted(path);
		// The shell spawns IN the folder (pty_create's cwd), VS Code's own shape — no `cd`
		// line typed into a shell that started at the root.
		this.explorer.onOpenInTerminal = (folder) => void this.panel.openTerminal(folder);
		// "Find in Folder": the Search view opens with the folder's own include glob seeded
		// (`src/**` spells the folder's subtree; the root's search is the whole workspace,
		// so its include clears) and the query box focused — VS Code's Find in Folder flow.
		this.explorer.onFindInFolder = (folder) => {
			this.showView('search');
			const roots = this.repoPaths.length > 0 ? this.repoPaths : this.repoPath ? [this.repoPath] : [];
			const root = roots.find((candidate) => relativeTo(candidate, folder) !== folder) ?? this.repoPath;
			const relative = root ? relativeTo(root, folder) : '';
			this.search.seedInclude(relative === '' ? '' : `${toPosix(relative)}/**`);
			this.search.focus();
		};
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
		this.scm.onOpenHistory = (path) => void this.editors.openFileHistory(path);
		this.scm.onReveal = (path) => void this.explorer.reveal(path);
		// The change's diff is a user act (a row tap on the phone's Source Control page as
		// much as a click on the PC's): its open crosses the wire for its reads, and a
		// foreign page hold live at the landing would swallow the activation's own
		// `revealEditorPage` — the page this tap asked for would stay back, and to its
		// user the phone "never opened the diff" (2026-10-18). The landing pulls the page
		// forward ungated, the same cut the webview ops' own-act reveal makes; off a
		// page-stack shell the ungated reveal is a no-op.
		this.scm.onOpenDiff = (diff) => void this.editors.openDiff({ kind: 'diff', ...diff }).then(() =>
			(hook('navigation').revealEditorPageUngated ?? hook('navigation').revealEditorPage)()
		);
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
			// A focus move between groups changes `tabGroups`' active group without a tab change.
			this.extensionHost.noteTabsChanged();
			this.statusBar.setEditor(editor);
			this.followContextSymbol(editor);
			// The Relations page follows the same payload; its own gate (the page being the
			// active one, the content not pinned) lives inside followDefinitionSymbol.
			this.followDefinitionSymbol(editor);
			// The Symbol Window follows the active editor's file and cursor line; no editor
			// clears it. The payload's line is the status bar's Ln (1-based — the base the
			// context window's `doc.line` reads), and the view's contract is 0-based.
			if (editor?.kind === 'file' && editor.path) this.symbolWindow.setFile(editor.path, editor.line - 1);
			else this.symbolWindow.setFile(null);
			if (editor?.kind === 'file' && editor.path) {
				// explorer.autoReveal: the active file reveals in the tree when the Explorer is
				// watching; opened elsewhere, the reveal is owed the moment the view returns
				// (layout.ts's showView/toggleSidebar run it). The same open feeds the picker's
				// recently-opened rows.
				this.noteRecentFile(editor.path);
				if (state.layout.sidebarVisible && this.activeView === 'explorer') void this.explorer.reveal(editor.path);
				else this.pendingReveal = editor.path;
			}
			// The extension frames learn the active editor, and an editor of a declared
			// language wakes the extensions listening for it.
			if (editor?.kind === 'file' && editor.path) this.extensionHost.noteLanguageOpened(editor.path);
			this.extensionHost.noteActiveEditor(editor);
		};
		// The Symbol Window's "current function" locals read the active text editor's live
		// buffer through this hook — null whenever the cursor is not in a text editor. The
		// relation graph under the outline relativizes the editor's path through the open
		// repo, so its root reaches the index in the repo-relative vocabulary it speaks.
		this.symbolWindow.provideText = () => { const editor = this.editors.activeGroup.activeEditor; return editor && editor.input.kind === 'file' && editor.view ? editor.view.state.doc.toString() : null; };
		this.symbolWindow.provideRepo = () => this.repoPath;
		this.editors.onNavigationChange = () => this.titleBar.setNavigation(this.editors.canGoBack(), this.editors.canGoForward());
		// The session snapshot (tabs, active tab, expanded folders) follows every change, coalesced.
		// The session snapshot follows every change, coalesced — and so does every extension's
		// `window.tabGroups` (the push dedupes a re-render that moved nothing).
		this.editors.onTabsChange = () => {
			this.scheduleSnapshot();
			this.extensionHost.noteTabsChanged();
		};
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
			// The context window's feed speaks absolute paths, its chain browse the index's
			// repo-relative ones — an open joins the root, an absolute path passes through.
			const path = /^([a-zA-Z]:[\\/]|\\|\/)/.test(definition.path) || !this.repoPath
				? definition.path
				: joinRepo(this.repoPath, definition.path);
			void this.editors.openFile(path, { line: definition.line + 1 });
		};
		// The Definition page's jump: the header's location button opens the definition at
		// the 1-based line; the index speaks repo-relative paths, so an open joins the
		// workspace root.
		this.panel.definition.onOpenDefinition = (path, line) => {
			void this.editors.openFile(/^([a-zA-Z]:[\\/]|\\|\/)/.test(path) || !this.repoPath ? path : joinRepo(this.repoPath, path), { line });
		};
		// The References page's jump: a highlighted site line — or the row's double click —
		// opens the site at the 1-based line and column; the index speaks repo-relative
		// paths, so an open joins the workspace root.
		this.panel.references.onOpen = (path, line, column) => {
			void this.editors.openFile(/^([a-zA-Z]:[\\/]|\\|\/)/.test(path) || !this.repoPath ? path : joinRepo(this.repoPath, path), { line, column });
		};
		// Both pages' file reads: the index speaks repo-relative paths and the backend's
		// read_file needs the absolute spelling, so the views resolve through the open
		// root (an absolute path passes through).
		const resolveSymbolPath = (path: string): string =>
			/^([a-zA-Z]:[\\/]|\\|\/)/.test(path) || !this.repoPath ? path : joinRepo(this.repoPath, path);
		this.panel.definition.resolvePath = resolveSymbolPath;
		this.panel.references.resolvePath = resolveSymbolPath;
		this.panel.context.resolvePath = resolveSymbolPath;
		// The Symbol Window's jumps: an outline row, an import, a current-function local,
		// and the relation graph's card click open the target at the 1-based line. The
		// outline's rows speak the editor's absolute path, the graph's cards the index's
		// repo-relative one — an open joins the root, an absolute path passes through.
		this.symbolWindow.onOpen = (path, line) => {
			void this.editors.openFile(resolveSymbolPath(path), { line });
		};
		// The relation graph's plain click shows its jump in the Definition page — the
		// code page stays where it stands (2026-11-23, the owner's direction: a relation
		// click shows the jump in the definition, the code page does not jump, and the
		// definition's right-click syncs the position to the code page). The pin rides
		// FIRST:
		// the page's own activation below (show's shown()) re-resolves the cursor's
		// symbol through the debounced follow, whose gate the pin is — without it every
		// activation would clobber the symbol the card named. The page's right-click
		// carries the sync into the code page from there.
		this.symbolWindow.onShowDefinition = (subject) => {
			this.panel.definition.setPinned(true);
			this.panel.show('definition');
			this.panel.definition.setDefinition(subject);
		};
		// The hover card's relations click: the card's symbol — the index's own
		// { kind, name, path, line } vocabulary — becomes the Symbol Window's relation
		// graph's pinned root, and the sidebar shows it.
		setHoverRelationsOpener((sym) => {
			this.showView('symbolWindow');
			this.symbolWindow.openGraphRoot(sym);
		});
		// The page's own activation re-resolves the cursor symbol right away (the debounced
		// follow only rides editor changes): the live selection is the payload.
		this.panel.definition.onNeedRoot = () => {
			const view = this.editors.activeView;
			const input = this.editors.activeInput;
			if (input?.kind !== 'file' || !view) return;
			const position = view.state.selection.main.head;
			const line = view.state.doc.lineAt(position);
			this.followDefinitionSymbol({ kind: 'file', path: input.path, line: line.number, column: position - line.from + 1 });
		};
		// The References page's activation re-resolves the cursor symbol through the same
		// live-selection payload the definition page hands over.
		this.panel.references.onNeedRoot = this.panel.definition.onNeedRoot;
		// The Context page's activation re-resolves through the context follow (whose own
		// gate reads the context pin), and unpinning re-follows right away — the relation
		// graph's unpin convention.
		const reResolveContext = () => {
			const view = this.editors.activeView;
			const input = this.editors.activeInput;
			if (input?.kind !== 'file' || !view) return;
			const position = view.state.selection.main.head;
			const line = view.state.doc.lineAt(position);
			this.followContextSymbol({ kind: 'file', path: input.path, line: line.number, column: position - line.from + 1 });
		};
		this.panel.context.onNeedRoot = reResolveContext;
		this.panel.context.onPinChange = (pinned) => {
			if (!pinned) reResolveContext();
		};

		document.addEventListener('keydown', this.onKeyDownBound);
		// External changes arrive from the backend's file watcher; the focus refresh stays as
		// the fallback for the filesystems the watcher cannot cover.
		void listen<FsChange>(FS_CHANGED_EVENT, (event) => this.onFsChanged(event.payload)).then((unlisten) => this.trackUnlisten(unlisten)).catch(() => undefined);
		// The status bar's watcher dot follows the backend's own pushes (an install's
		// answer, a refusal, a mid-life degrade) between the folder opens' queries.
		void listen<WatcherReport[]>('studio://watcher-status', (event) => this.noteWatcherStatus(event.payload)).then((unlisten) => this.trackUnlisten(unlisten)).catch(() => undefined);
		// The symbol index's builds report from the backend (an open's resume, a watcher's
		// incremental update, this command's own rebuild): the status item follows them all.
		void listen<SymbolIndexStatus>('studio://symbol-index', (event) => this.statusBar.setSymbols(event.payload)).then((unlisten) => this.trackUnlisten(unlisten)).catch(() => undefined);
		void listen<AnalysisStatus>('studio://analysis-index', (event) => {
			this.analysis.noteStatus(event.payload);
			// The open analysis pages follow the build too: a page whose report waits on
			// a cold build shows its live progress instead of a bare spinner.
			this.editors.noteAnalysisStatus(event.payload);
		}).then((unlisten) => this.trackUnlisten(unlisten)).catch(() => undefined);
		window.addEventListener('focus', this.onWindowFocusBound);
		window.addEventListener('blur', this.onWindowBlurBound);
		void getCurrentWindow().onCloseRequested(async (event) => {
			// The close watchdog's ack (window.rs), and it travels before anything below
			// awaits: Tauri hands the whole close decision to the page (it prevents the
			// native close the moment this listener exists, and the wrapper performs the
			// destroy itself), so a dead webview leaves the X button inert — the backend
			// destroys or hides the window when a request goes unacked. A live page acks
			// in the same tick the event arrives.
			void windowCloseAck().catch(() => undefined);
			// The PC window lifecycle (docs/remote-client-plan.md §17): while ANY remote
			// session is connected — its own workbench, not only a PC-screen replica viewer —
			// or the instance is a remote host, closing only HIDES the window. The
			// workbench, its terminals and the extension pages (a Claude Code turn in
			// flight) keep running for the remotes (G13, K12): killing the whole instance
			// on a window close is exactly what the lifecycle forbids.
			if (!hook('session').remote() && (await this.keepRunningHidden())) {
				event.preventDefault();
				// The presence table hears it from its owner at once (§7.0): whatever the
				// page's own visibility events do, the sync's gate closes now.
				this.workbenchSync?.noteWindowHidden();
				void remoteHostHideMain()
					.then(() => notifyCloseHidden())
					.catch(() => undefined);
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
		return closeHidesWindow(status);
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
			.catch((): BootContext => ({ file: null, actions: [], repo: null, workspace: null, reloaded: false, opened: null, openedFor: null, roots: [], workspaceFile: null, blank: false }));
		// A `ggs <file>` launch shows exactly that file, alone.
		if (context.file) {
			await this.openFileStandalone(context.file);
		} else if (hook('session').remote()) {
			// A remote session never opens folders itself — `open_folder` is refused at its
			// gate (docs/remote-client-plan.md §3.3, R0): the instance's current roots arrive
			// in the boot context (the workspace file they came from included) and apply
			// directly — exactly the reopen the desktop's own boot resolves to, minus the
			// invoke. Launch actions and workspaces are the PC's launch vocabulary; a session
			// attaches to what the window already holds.
			const roots = context.roots ?? [];
			if (roots.length > 0) {
				await this.applyRoots(roots.map((entry) => entry.root), roots.some((entry) => entry.isRepo), context.workspaceFile ?? null);
			} else {
				this.statusBar.setRepo(false);
			}
		} else if (context.workspace && !context.reloaded) {
			// A `ggs <workspace>.ggs-workspace` launch opens that multi-root workspace. A page
			// reload is past its launch: the window may have switched folders since, and what it
			// holds now is the remembered folder below.
			await this.openWorkspace(context.workspace);
		} else if (context.actions.length > 0) {
			// A `ggs compare|hex|hex-compare|folder-compare ...` launch opens its comparison as
			// the window's first tab, over no folder of its own - the same tabs the Explorer's
			// "Compare Two Files/Folders" menu opens.
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
			// A `ggs --new-window` launch (the taskbar jump list's and the File menu's
			// New Window) opens blank: the remembered folder stays closed, whatever a
			// plain argumentless launch would restore.
			const remembered = context.blank ? null : state.lastFolder();
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
		// The shell's own recent list follows the page's: the Windows taskbar jump list
		// re-renders at boot (a launch that opened no folder still answers it, so its
		// New Window task exists from the very first run). Folder opens re-sync through
		// `rememberFolder` themselves; this is the boot's one guaranteed pass.
		state.syncJumpList();
		// The rest of the boot is not what the user is waiting for, and it all shares the one
		// main thread with the explorer's first listing and the graph view's boot: the
		// terminal (its xterm chunk and a shell process), the extension host (its frame and
		// every installed bundle) and the backup recovery run once that first burst is
		// through - at the next idle moment, or within two seconds regardless. Every launch
		// form above falls through here: a file or workspace launch needs the extensions and
		// the panel restore as much as a folder launch does.
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
