// The phone's editor page chrome (docs/ggs-remote-plan.md §11.2, "标签页变下拉列表"): a
// 390 px screen has no room for a tab strip, so the strip is hidden and its jobs move here —
// the open editors as a sheet (tap to switch, ✕ to close, Close All in the header; every
// group's tabs, so an editor an extension opened "beside" is one tap away too), the editor's
// actions as a sheet (save, undo, find, go to line, history, the tab's own menu with its
// extension entries), and — when nothing is open — the page itself as a small dashboard of
// the workspace (the owner's 2026-10-16 direction: 远程这个页面要重新设计,要更好用,更专业):
// the workspace's name, the repository's own state as a card one tap from the Source Control
// page, the three ways to something open as tiles, this device's recently opened files, and
// what is already open elsewhere. Every action goes through the tab's own DOM, the command
// registry or the workbench's own methods; nothing here reaches into the editor's state.
import { commands } from '../platform/commands';
import { t, tf } from '../platform/i18n';
import type { MenuEntry } from '../platform/ui';
import { fileIcon, fileIconColor } from '../platform/fileIcons';
import { currentWorkbench } from '../workbench';
import { closeActionSheet, openSheet, sheetButton, showActionSheet } from './actionSheet';
import { commandEntry, relativeFolder, workspaceName } from './appBar';
import { activeTab, clearEditorPlaceholder, currentPage, editorPlaceholderShown, editorTabs, goTo, launcherForTab, onWorkbenchChange } from './pages';
import { withinRoots } from './pathGate';
import { revealEditorPageNow as revealEditorPage } from './nav';

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
		// The chooser answers from wherever it was opened: bring the editor page forward
		// (a full-screen side view or the panel page may still cover it) before the tab's
		// own click activates it.
		revealEditorPage();
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

/* ---------- The empty page's own recents (this device, this PC) ---------- */

/** Where the device's recently opened files live. Plain localStorage, like the Files page's
 *  sort: under a Hub the scoped storage has already prefixed it with this PC's base path. */
const RECENT_KEY = 'remote.editor.recent';
const RECENT_STORED = 15;
const RECENT_SHOWN = 5;

/** The parsed recents, memoized against the store's raw bytes: the empty state's `sync`
 *  runs on every chrome wave and JSON-parsed the store twice per wave before this (the
 *  list plus `rememberRecent`'s read). The raw-string key keeps an external change (a
 *  cleared store included) honest — `getItem` is the cheap half, the parse was the cost. */
let recentsRaw: string | null = null;
let recentsCache: string[] = [];

function loadRecents(): string[] {
	const raw: string = localStorage.getItem(RECENT_KEY) ?? '[]';
	if (raw === recentsRaw) return recentsCache;
	try {
		const parsed: unknown = JSON.parse(raw);
		recentsCache = Array.isArray(parsed) ? parsed.filter((path): path is string => typeof path === 'string') : [];
	} catch {
		recentsCache = [];
	}
	recentsRaw = raw;
	return recentsCache;
}

function rememberRecent(path: string): void {
	const previous = loadRecents();
	if (previous[0] === path) return;
	const next = [path, ...previous.filter((other) => other !== path)].slice(0, RECENT_STORED);
	const raw = JSON.stringify(next);
	recentsCache = next;
	recentsRaw = raw;
	try {
		localStorage.setItem(RECENT_KEY, raw);
	} catch {
		// Storage unavailable (private mode / quota): this session simply keeps no recents.
	}
}

/** The editor page's empty state (the owner's 2026-10-16 direction: 更好用,更专业): the
 *  desktop's welcome page is a desktop layout, so the phone's Editor page answers with its
 *  own — a small dashboard of the workspace instead of three lone buttons. */
export function createEditorEmptyState(): HTMLElement {
	const pane = document.createElement('div');
	pane.className = 'ggs-editor-empty';
	pane.hidden = true;
	const inner = document.createElement('div');
	inner.className = 'inner';

	/* The mark and the page's own line. */
	const mark = document.createElement('span');
	mark.className = 'mark';
	const glyph = document.createElement('span');
	glyph.className = 'codicon codicon-files';
	glyph.setAttribute('aria-hidden', 'true');
	mark.appendChild(glyph);
	const title = document.createElement('div');
	title.className = 'title';
	title.textContent = t('remote.editor.noneOpen');
	const subtitle = document.createElement('div');
	subtitle.className = 'subtitle';

	/* The repository's own state as one card: the branch, ahead/behind and the pending
	 * changes, one tap from the Source Control page. */
	const branchIcon = document.createElement('span');
	branchIcon.className = 'codicon codicon-git-branch';
	branchIcon.setAttribute('aria-hidden', 'true');
	const branchName = document.createElement('span');
	branchName.className = 'name';
	const branchMeta = document.createElement('span');
	branchMeta.className = 'meta';
	const changeChip = document.createElement('span');
	changeChip.className = 'chip';
	const chev = document.createElement('span');
	chev.className = 'codicon codicon-chevron-right chev';
	chev.setAttribute('aria-hidden', 'true');
	const repoCard = document.createElement('button');
	repoCard.type = 'button';
	repoCard.className = 'ggs-empty-repo';
	repoCard.title = t('remote.page.scm');
	repoCard.setAttribute('aria-label', t('remote.page.scm'));
	repoCard.append(branchIcon, branchName, branchMeta, changeChip, chev);
	repoCard.addEventListener('click', () => void goTo('scm'));

	/* The three ways to something open, as tiles. */
	const tiles = document.createElement('div');
	tiles.className = 'tiles';
	const tile = (iconName: string, label: string, run: () => void, primary = false) => {
		const button = document.createElement('button');
		button.type = 'button';
		if (primary) button.className = 'primary';
		const glyphBox = document.createElement('span');
		glyphBox.className = 'glyph';
		const icon = document.createElement('span');
		icon.className = `codicon codicon-${iconName}`;
		icon.setAttribute('aria-hidden', 'true');
		glyphBox.appendChild(icon);
		const text = document.createElement('span');
		text.className = 'label';
		text.textContent = label;
		button.append(glyphBox, text);
		button.addEventListener('click', run);
		return button;
	};
	tiles.append(
		tile('files', t('remote.editor.browse'), () => void goTo('explorer'), true),
		tile('go-to-file', t('remote.appbar.quickOpen'), () => void commands.execute('workbench.quickOpen')),
		tile('source-control', t('remote.editor.reviewChanges'), () => void goTo('scm'))
	);

	/* The two lists: what is already open (elsewhere — another group, behind an extension
	 * page), and this device's recently opened files. */
	const open = document.createElement('div');
	open.className = 'open-list';
	const recent = document.createElement('div');
	recent.className = 'recent-list';

	inner.append(mark, title, subtitle, repoCard, tiles, open, recent);
	pane.appendChild(inner);

	const recentRow = (path: string): HTMLElement => {
		const name = path.replace(/\\/g, '/').split('/').pop() ?? path;
		const row = document.createElement('div');
		row.className = 'ggs-editor-row recent';
		row.setAttribute('role', 'button');
		row.tabIndex = 0;
		row.title = path;
		const glyph = document.createElement('span');
		glyph.className = 'icon';
		const fileGlyph = document.createElement('span');
		fileGlyph.className = `codicon codicon-${fileIcon(name)}`;
		fileGlyph.style.color = fileIconColor(name) ?? '';
		glyph.appendChild(fileGlyph);
		const text = document.createElement('span');
		text.className = 'text';
		const nameLabel = document.createElement('span');
		nameLabel.className = 'name';
		nameLabel.textContent = name;
		const folder = document.createElement('span');
		folder.className = 'folder';
		folder.textContent = relativeFolder(path);
		text.append(nameLabel, folder);
		row.append(glyph, text);
		const openRecent = () => void currentWorkbench?.editors.openFile(path);
		row.addEventListener('click', openRecent);
		row.addEventListener('keydown', (event) => {
			if (event.key === 'Enter' || event.key === ' ') openRecent();
		});
		return row;
	};

	const sync = () => {
		const tab = activeTab();
		// The device's recents follow the tab that is being looked at, wherever the page is.
		if (tab?.dataset.kind === 'file' && tab.title) rememberRecent(tab.title);
		const show = currentPage() === 'editor' && (editorPlaceholderShown() || !tab || Boolean(launcherForTab(tab)));
		pane.hidden = !show;
		if (!show) return;
		subtitle.textContent = workspaceName();
		subtitle.hidden = !subtitle.textContent;

		// The repository card: hidden off a repository, live off the SCM view's own state.
		const scm = currentWorkbench?.scm;
		const isRepo = scm?.isRepo === true;
		repoCard.hidden = !isRepo;
		if (isRepo && scm) {
			branchName.textContent = scm.branch ?? '';
			branchMeta.replaceChildren();
			const pair = (iconName: string, count: number) => {
				const box = document.createElement('span');
				box.className = 'pair';
				const arrow = document.createElement('span');
				arrow.className = `codicon codicon-${iconName}`;
				arrow.setAttribute('aria-hidden', 'true');
				box.append(arrow, `${count}`);
				return box;
			};
			if (scm.behind > 0) branchMeta.appendChild(pair('arrow-down', scm.behind));
			if (scm.ahead > 0) branchMeta.appendChild(pair('arrow-up', scm.ahead));
			changeChip.textContent = scm.changes.length > 0 ? tf('remote.appbar.changes', scm.changes.length) : t('remote.appbar.noChanges');
			changeChip.classList.toggle('clean', scm.changes.length === 0);
		}

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

		// The device's own recents — only the files that still sit in an open folder.
		recent.replaceChildren();
		const roots = currentWorkbench?.openFolders() ?? [];
		const shown = roots.length > 0 ? loadRecents().filter((path) => withinRoots(path, roots)).slice(0, RECENT_SHOWN) : [];
		if (shown.length > 0) {
			const label = document.createElement('div');
			label.className = 'section';
			label.textContent = t('remote.editor.recent');
			recent.append(label, ...shown.map(recentRow));
		}
	};
	sync();
	onWorkbenchChange(sync);
	return pane;
}
