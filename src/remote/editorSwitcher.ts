// The phone's editor page chrome (docs/ggs-remote-plan.md §11.2, "标签页变下拉列表"): a
// 390 px screen has no room for a tab strip, so the strip is hidden and its jobs move here —
// the open editors as a sheet (tap to switch, ✕ to close, Close All in the header; every
// group's tabs, so an editor an extension opened "beside" is one tap away too), the editor's
// actions as a sheet (save, undo, find, go to line, history, the tab's own menu with its
// extension entries), and an empty state with the ways to open something when nothing is.
// Every action goes through the tab's own DOM or the command registry; nothing here reaches
// into the editor's state.
import { commands } from '../commands';
import { t, tf } from '../i18n';
import type { MenuEntry } from '../ui';
import { closeActionSheet, openSheet, sheetButton, showActionSheet } from './actionSheet';
import { commandEntry, relativeFolder } from './appBar';
import { activeTab, clearEditorPlaceholder, currentPage, editorPlaceholderShown, editorTabs, goTo, launcherForTab, onWorkbenchChange } from './pages';

/** One open editor's row: its icon, name (with the unsaved dot), folder, and a close button. */
function editorRow(tab: HTMLElement, rerender: () => void): HTMLElement {
	const row = document.createElement('div');
	row.className = 'ggs-editor-row' + (tab.classList.contains('active') && tab === activeTab() ? ' current' : '');
	row.setAttribute('role', 'button');
	row.tabIndex = 0;
	const glyph = document.createElement('span');
	glyph.className = 'icon';
	const source = tab.querySelector('.icon');
	if (source) glyph.append(...[...source.childNodes].map((node) => node.cloneNode(true)));
	const text = document.createElement('span');
	text.className = 'text';
	const name = document.createElement('span');
	name.className = 'name';
	name.textContent = tab.querySelector('.label')?.textContent ?? '';
	if (tab.classList.contains('dirty')) {
		const dot = document.createElement('span');
		dot.className = 'dirty-dot';
		dot.title = t('remote.editor.unsaved');
		name.appendChild(dot);
	}
	const folder = document.createElement('span');
	folder.className = 'folder';
	folder.textContent = tab.dataset.kind === 'file' ? relativeFolder(tab.title) : tab.title !== name.textContent ? tab.title : '';
	text.append(name, folder);
	const close = sheetButton('close', t('remote.editors.close'), () => {
		tab.querySelector<HTMLElement>('.close')?.click();
		// A dirty file asks first (the save prompt); the list follows whatever happened.
		setTimeout(rerender, 60);
	});
	row.append(glyph, text, close);
	const open = () => {
		closeActionSheet();
		clearEditorPlaceholder();
		tab.click();
	};
	row.addEventListener('click', open);
	row.addEventListener('keydown', (event) => {
		if (event.key === 'Enter' || event.key === ' ') open();
	});
	return row;
}

/** The open editors sheet. */
export function openEditorsSheet(): void {
	const body = document.createElement('div');
	body.className = 'ggs-editor-list';
	const render = () => {
		const tabs = editorTabs();
		body.replaceChildren(...tabs.map((tab) => editorRow(tab, render)));
		if (tabs.length === 0) {
			const empty = document.createElement('div');
			empty.className = 'ggs-sheet-empty';
			empty.textContent = t('remote.editor.noneOpen');
			body.appendChild(empty);
		}
		const subtitle = document.querySelector('.ggs-editors-sheet .subtitle');
		if (subtitle) subtitle.textContent = tf('remote.editors.count', tabs.length);
	};
	const closeAll = sheetButton('close-all', t('remote.editors.closeAll'), () => {
		void commands.execute('workbench.closeAllEditors').then(() => setTimeout(render, 60));
	});
	openSheet({
		title: t('remote.editors.title'),
		subtitle: tf('remote.editors.count', editorTabs().length),
		actions: [closeAll],
		body,
		className: 'ggs-editors-sheet'
	});
	render();
}

/** The editor's actions — what the desktop's menus, tab strip and keyboard offer. */
export function editorActionEntries(): MenuEntry[] {
	const tab = activeTab();
	const isFile = tab?.dataset.kind === 'file';
	const markdown = isFile && /\.(md|markdown)$/i.test(tab?.title ?? '');
	const entries: MenuEntry[] = [
		commandEntry('workbench.save', t('remote.editor.save')),
		commandEntry('workbench.saveAll', t('remote.editor.saveAll')),
		'separator',
		commandEntry('editor.undo', t('remote.editorToolbar.undo')),
		commandEntry('editor.redo', t('remote.editorToolbar.redo')),
		commandEntry('editor.find', t('remote.editorToolbar.find')),
		commandEntry('editor.replace', t('remote.editor.replace')),
		commandEntry('workbench.gotoLine', t('remote.editor.gotoLine')),
		commandEntry('workbench.gotoSymbolInFile', t('remote.editor.gotoSymbol')),
		'separator',
		commandEntry('editor.toggleLineComment', t('remote.editorToolbar.comment')),
		commandEntry('editor.formatDocument', t('remote.editor.format')),
		commandEntry('editor.toggleWordWrap', t('remote.editor.wordWrap')),
		'separator'
	];
	if (markdown) entries.push(commandEntry('markdown.showPreview', t('remote.editor.preview')));
	if (isFile) {
		entries.push(commandEntry('git.openFileHistory', t('remote.editor.history')));
		entries.push(commandEntry('git.toggleBlame', t('remote.editor.blame')));
		entries.push(commandEntry('remote.download', t('remote.editor.download')));
	}
	entries.push(
		'separator',
		commandEntry('workbench.goBack', t('remote.editor.back')),
		commandEntry('workbench.goForward', t('remote.editor.forward')),
		commandEntry('workbench.action.reopenClosedEditor', t('remote.editor.reopen')),
		'separator'
	);
	// The tab's own context menu — Copy Path, Reveal, and every extension's editor/title
	// entries — is built by the editor at open time; the presenter shows it as its own sheet.
	if (tab) entries.push({ label: t('remote.editor.tabMenu'), run: () => openTabMenu(tab) });
	entries.push(commandEntry('workbench.closeEditor', t('remote.editors.close')), commandEntry('workbench.closeAllEditors', t('remote.editors.closeAll')));
	return entries;
}

/** The tab's own context menu, as the desktop's right-click opens it. */
function openTabMenu(tab: HTMLElement): void {
	const rect = tab.getBoundingClientRect();
	tab.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.left, clientY: rect.bottom, button: 2 }));
}

/** Open the editor's actions sheet. */
export function openEditorActions(): void {
	const heading = activeTab()?.querySelector('.label')?.textContent ?? t('remote.tabs.editor');
	showActionSheet(editorActionEntries(), heading);
}

/** The editor page's empty state: shown on the phone's Editor page when no regular editor
 *  is showing — the desktop's welcome page is a desktop layout. */
export function createEditorEmptyState(): HTMLElement {
	const pane = document.createElement('div');
	pane.className = 'ggs-editor-empty';
	pane.hidden = true;
	const glyph = document.createElement('span');
	glyph.className = 'codicon codicon-files hero';
	glyph.setAttribute('aria-hidden', 'true');
	const title = document.createElement('div');
	title.className = 'title';
	title.textContent = t('remote.editor.noneOpen');
	const text = document.createElement('div');
	text.className = 'text';
	text.textContent = t('remote.editor.emptyHint');
	const actions = document.createElement('div');
	actions.className = 'actions';
	const action = (iconName: string, label: string, run: () => void, primary = false) => {
		const button = document.createElement('button');
		button.className = primary ? 'primary' : '';
		const icon = document.createElement('span');
		icon.className = `codicon codicon-${iconName}`;
		icon.setAttribute('aria-hidden', 'true');
		const span = document.createElement('span');
		span.textContent = label;
		button.append(icon, span);
		button.addEventListener('click', run);
		return button;
	};
	actions.append(
		action('files', t('remote.editor.browse'), () => void goTo('explorer'), true),
		action('go-to-file', t('remote.appbar.quickOpen'), () => void commands.execute('workbench.quickOpen')),
		action('source-control', t('remote.editor.reviewChanges'), () => void goTo('scm'))
	);
	const open = document.createElement('div');
	open.className = 'open-list';
	pane.append(glyph, title, text, actions, open);
	const sync = () => {
		const tab = activeTab();
		const show = currentPage() === 'editor' && (editorPlaceholderShown() || !tab || Boolean(launcherForTab(tab)));
		pane.hidden = !show;
		if (!show) return;
		// Something is open, just not shown here (only extension pages, or a file in another
		// group): list it so the empty page is never a dead end.
		const tabs = editorTabs();
		open.replaceChildren();
		if (tabs.length > 0) {
			const label = document.createElement('div');
			label.className = 'section';
			label.textContent = t('remote.editors.title');
			open.appendChild(label);
			for (const other of tabs.slice(0, 6)) open.appendChild(editorRow(other, sync));
		}
	};
	sync();
	onWorkbenchChange(sync);
	return pane;
}
