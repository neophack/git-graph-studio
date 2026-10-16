// The phone's app bar (docs/ggs-remote-plan.md §11.2): the desktop title bar's menus and
// command center are hidden on a phone; in their place one 48 px bar says where you are and
// what you can do there. Leading: ☰, the drawer with every page and the full menus. Middle:
// the page's title and a subtitle — the open file and its folder on the Editor, the branch
// and the pending changes on Changes, the workspace elsewhere; on the Editor a tap opens the
// open editors list. Trailing: the page's own actions (Go to File everywhere; the editor's
// lock toggle and action sheet, the repository's or the terminal's), each a 44 px target.
import { commands } from '../platform/commands';
import { t, tf } from '../platform/i18n';
import type { MenuEntry } from '../platform/ui';
import { currentWorkbench } from '../workbench';
import { showActionSheet } from './actionSheet';
import { activeEditLock, isEditLocked, onEditLockChange, toggleEditLock } from './editLock';
import { pageBack, pageBackAvailable } from './pageBack';
import { activeTab, BUILTIN_VIEWS, currentPage, editorPlaceholderShown, extensionContainers, launchers, onWorkbenchChange, type PageId } from './pages';

export interface AppBarHooks {
	openDrawer(): void;
	openEditors(): void;
	editorActions(): void;
}

/** The files page's ＋ (the owner's 2026-10-16 direction, continued — the add icon rides the
 *  app bar, ahead of its other buttons): the page alone knows the directory its sheet acts
 *  on, so it registers the sheet here at install; until then the ＋ hides. */
let filesActions: (() => MenuEntry[]) | null = null;
let rerenderAppBar: (() => void) | null = null;

/** The files page hands its actions sheet (the current directory's uploads, new file and
 *  folder) to the bar at install; `null` withdraws it. */
export function registerFilesActions(provider: (() => MenuEntry[]) | null): void {
	filesActions = provider;
	rerenderAppBar?.();
}

/** The workspace's display name, off the title the workbench keeps ("repo - Git Graph Studio"). */
export function workspaceName(): string {
	const match = /^(.*) - Git Graph Studio$/.exec(document.title);
	return match?.[1] ?? '';
}

/** The branch the status bar shows (its item is hidden on the phone), or ''. */
export function branchName(): string {
	const item = document.querySelector<HTMLElement>('#statusbar [data-item="branch"]');
	if (!item || item.hidden) return '';
	return (item.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/** The pending changes Source Control counts (its activity badge), or ''. */
export function changeCount(): string {
	return document.querySelector('#activitybar .activity-item[data-view="scm"] .badge')?.textContent?.trim() ?? '';
}

/** A command as a sheet row, carrying its live enablement; `label` overrides the title. */
export function commandEntry(id: string, label?: string): MenuEntry {
	const command = commands.get(id);
	return {
		label: label ?? (command ? command.title.replace(/\.\.\.$/, '…') : id),
		disabled: !commands.isEnabled(id),
		run: () => void commands.execute(id)
	};
}

/** The open file's folder, relative to the workspace when it sits inside it. */
export function relativeFolder(path: string, workspace = workspaceName()): string {
	const separator = path.includes('\\') ? '\\' : '/';
	const folder = path.slice(0, Math.max(0, path.lastIndexOf(separator)));
	if (workspace) {
		const marker = `${separator}${workspace}${separator}`;
		const padded = folder + separator;
		const at = padded.lastIndexOf(marker);
		// Inside the workspace: the path below it ('' at its root — the caller names the
		// workspace instead).
		if (at !== -1) return padded.slice(at + marker.length, -1).split(separator).join('/');
	}
	return folder.split(separator).pop() ?? folder;
}

export interface PageHeading {
	title: string;
	subtitle: string;
	dirty?: boolean;
	/** The heading opens the open editors list (the Editor page). */
	switcher?: boolean;
}

/** The page's title and subtitle. */
export function pageHeading(page: PageId): PageHeading {
	const workspace = workspaceName();
	if (page === 'editor') {
		const tab = editorPlaceholderShown() ? null : activeTab();
		if (!tab) return { title: t('remote.tabs.editor'), subtitle: t('remote.editor.noneOpen'), switcher: true };
		const label = tab.querySelector('.label')?.textContent ?? '';
		const path = tab.dataset.kind === 'file' ? tab.title : '';
		const folder = path ? relativeFolder(path, workspace) : tab.querySelector('.description')?.textContent ?? '';
		return { title: label, subtitle: folder || workspace, dirty: tab.classList.contains('dirty'), switcher: true };
	}
	if (page === 'panel') {
		const active = document.querySelector('#panel .panel-title.active')?.textContent;
		return { title: active || t('remote.tabs.panel'), subtitle: workspace };
	}
	if (page === 'scm') {
		const count = changeCount();
		const changes = count ? tf('remote.appbar.changes', count) : t('remote.appbar.noChanges');
		return { title: t('remote.page.scm'), subtitle: [branchName(), changes].filter(Boolean).join(' · ') };
	}
	if (page.startsWith('launch:')) {
		const tab = activeTab();
		const launcher = launchers().find((candidate) => candidate.id === page);
		return { title: tab?.querySelector('.label')?.textContent || launcher?.label || '', subtitle: [workspace, branchName()].filter(Boolean).join(' · ') };
	}
	if (page.startsWith('ext-container:')) {
		const container = extensionContainers().find((candidate) => candidate.id === page);
		return { title: container?.title ?? '', subtitle: workspace };
	}
	const builtin = BUILTIN_VIEWS[page];
	return { title: builtin ? builtin.label() : page, subtitle: workspace };
}

function barButton(iconName: string, label: string, run: () => void, className = ''): HTMLButtonElement {
	const button = document.createElement('button');
	button.className = `ggs-appbar-btn${className ? ' ' + className : ''}`;
	button.title = label;
	button.setAttribute('aria-label', label);
	const glyph = document.createElement('span');
	glyph.className = `codicon codicon-${iconName}`;
	glyph.setAttribute('aria-hidden', 'true');
	button.appendChild(glyph);
	button.addEventListener('click', run);
	return button;
}

/** The repository's actions — the git commands a phone reaches for. */
export function gitSheet(): MenuEntry[] {
	return [
		commandEntry('git.sync', t('remote.git.sync')),
		commandEntry('git.pull', t('remote.git.pull')),
		commandEntry('git.push', t('remote.git.push')),
		commandEntry('git.fetch', t('remote.git.fetch')),
		'separator',
		commandEntry('git.commitAll', t('remote.git.commitAll')),
		commandEntry('git.undoCommit', t('remote.git.undoCommit')),
		'separator',
		commandEntry('git.checkout', t('remote.git.checkout')),
		commandEntry('git.branch', t('remote.git.branch')),
		commandEntry('git.merge', t('remote.git.merge')),
		'separator',
		commandEntry('git.stash', t('remote.git.stash')),
		commandEntry('git.stashPopLatest', t('remote.git.stashPop')),
		'separator',
		commandEntry('git.showOutput', t('remote.git.output'))
	];
}

/** The Files page's actions. No Open Folder — a remote page opens files, not folders (K4). */
export function filesSheet(): MenuEntry[] {
	return [
		commandEntry('workbench.newFile', t('remote.files.newFile')),
		commandEntry('remote.uploadFiles', t('transfer.upload')),
		commandEntry('remote.uploadFolder', t('transfer.uploadFolder')),
		'separator',
		commandEntry('workbench.quickOpen', t('remote.appbar.quickOpen'))
	];
}

/** The Terminal page's actions. */
export function panelSheet(): MenuEntry[] {
	return [
		commandEntry('terminal.new', t('remote.terminal.new')),
		commandEntry('terminal.kill', t('remote.terminal.kill')),
		'separator',
		commandEntry('workbench.showOutput', t('remote.terminal.output')),
		commandEntry('git.showOutput', t('remote.git.output'))
	];
}

/** The editor's lock toggle (editLock.ts): a phone opens every file locked, and this one
 *  button flips the active editor between locked and editable. Hidden while the active
 *  editor carries no lock; `syncEditLockButton` keeps its glyph and label current. */
function editLockButton(): HTMLButtonElement {
	const button = barButton('lock', t('remote.editLock.unlock'), () => {
		const host = activeEditLock();
		if (host) toggleEditLock(host);
	}, 'edit-lock');
	syncEditLockButton(button);
	return button;
}

function syncEditLockButton(button: HTMLButtonElement): void {
	const host = activeEditLock();
	button.hidden = !host;
	if (!host) return;
	const locked = isEditLocked(host);
	const label = t(locked ? 'remote.editLock.unlock' : 'remote.editLock.lock');
	button.dataset.state = locked ? 'locked' : 'unlocked';
	button.title = label;
	button.setAttribute('aria-label', label);
	button.firstElementChild!.className = `codicon codicon-${locked ? 'lock' : 'unlock'}`;
}

/** The ＋ leads the Files page's trailing buttons (the owner's 2026-10-16 direction:
 *  codicon-add 放在 ggs-appbar-btn 前面) — its sheet is the files page's own, the current
 *  directory's uploads and the new file/folder rows. Hidden until the page registered its
 *  sheet; the forms without an app bar (the tablet portrait) keep the toolbar's own ＋. */
function filesAddButton(): HTMLButtonElement {
	const button = barButton('add', t('remote.files.actions'), () => {
		const entries = filesActions?.();
		if (entries?.length) showActionSheet(entries, t('remote.files.actions'));
	}, 'files-add');
	button.hidden = !filesActions;
	return button;
}

/** The Markdown source⇄preview toggle (the owner's 2026-10-16 direction: 顶栏加按钮，
 *  切换源码还是预览查看): on a Markdown file's tab it opens the rendered preview, on the
 *  preview it returns to the source. Hidden for every other editor — the active input says
 *  which side is up (`file` + .md is the source, `markdown` the preview). */
function markdownToggle(): HTMLButtonElement {
	const button = barButton('open-preview', t('remote.editor.preview'), () => {
		const input = currentWorkbench?.editors.activeInput;
		if (input?.kind === 'markdown') void currentWorkbench!.editors.openFile(input.path);
		else if (input?.kind === 'file' && /\.(md|markdown)$/i.test(input.path)) void currentWorkbench!.editors.openMarkdownPreview(input.path);
	}, 'markdown-toggle');
	syncMarkdownToggle(button);
	return button;
}

function syncMarkdownToggle(button: HTMLButtonElement): void {
	const input = currentWorkbench?.editors.activeInput;
	const source = input?.kind === 'file' && /\.(md|markdown)$/i.test(input.path);
	const preview = input?.kind === 'markdown';
	button.hidden = !(source || preview);
	if (button.hidden) return;
	const label = t(preview ? 'remote.editor.source' : 'remote.editor.preview');
	button.dataset.state = preview ? 'preview' : 'source';
	button.title = label;
	button.setAttribute('aria-label', label);
	button.firstElementChild!.className = `codicon codicon-${preview ? 'code' : 'open-preview'}`;
}

/** The trailing actions of a page. */
function trailingActions(page: PageId, hooks: AppBarHooks): HTMLElement[] {
	const quickOpen = () => barButton('go-to-file', t('remote.appbar.quickOpen'), () => void commands.execute('workbench.quickOpen'));
	const more = (entries: () => MenuEntry[], title: string) => barButton('kebab-vertical', t('remote.appbar.more'), () => showActionSheet(entries(), title));
	if (page === 'editor') return [markdownToggle(), editLockButton(), quickOpen(), barButton('kebab-vertical', t('remote.appbar.more'), () => hooks.editorActions())];
	if (page === 'explorer') return [filesAddButton(), quickOpen(), more(filesSheet, t('remote.tabs.explorer'))];
	if (page === 'scm') return [barButton('sync', t('remote.git.sync'), () => void commands.execute('git.sync')), more(gitSheet, t('remote.page.scm'))];
	// The panel's own header already carries New and Kill beside its view tabs.
	if (page === 'panel') return [more(panelSheet, t('remote.tabs.panel'))];
	if (page === 'search') return [];
	return [quickOpen()];
}

/** Build the bar; it re-renders itself as the page, the tabs and the branch change. */
export function createAppBar(hooks: AppBarHooks): HTMLElement {
	const bar = document.createElement('header');
	bar.className = 'ggs-appbar';
	// The ‹ ahead of ☰ while a page covers the editor (§5.1's 层级 rule: the app bar's back
	// button pops the page stack) — the drawer stays beside it, one tap from every page.
	const back = barButton('chevron-left', t('remote.page.back'), () => void pageBack(), 'back');
	back.hidden = true;
	const menu = barButton('menu', t('remote.menu'), () => hooks.openDrawer(), 'leading');
	const heading = document.createElement('button');
	heading.className = 'ggs-appbar-heading';
	const title = document.createElement('span');
	title.className = 'title';
	const titleText = document.createElement('span');
	titleText.className = 'text';
	const dirty = document.createElement('span');
	dirty.className = 'dirty-dot';
	dirty.title = t('remote.editor.unsaved');
	const chevron = document.createElement('span');
	chevron.className = 'codicon codicon-chevron-down chevron';
	chevron.setAttribute('aria-hidden', 'true');
	title.append(titleText, dirty, chevron);
	const subtitle = document.createElement('span');
	subtitle.className = 'subtitle';
	heading.append(title, subtitle);
	heading.addEventListener('click', () => {
		if (heading.classList.contains('switcher')) hooks.openEditors();
	});
	const actions = document.createElement('div');
	actions.className = 'ggs-appbar-actions';
	bar.append(back, menu, heading, actions);
	let actionsFor = '';
	const render = () => {
		const page = currentPage();
		const info = pageHeading(page);
		back.hidden = !pageBackAvailable();
		titleText.textContent = info.title;
		subtitle.textContent = info.subtitle;
		subtitle.hidden = !info.subtitle;
		dirty.hidden = !info.dirty;
		heading.classList.toggle('switcher', Boolean(info.switcher));
		chevron.hidden = !info.switcher;
		heading.setAttribute('aria-label', info.switcher ? tf('remote.appbar.openEditorsOf', info.title) : info.title);
		bar.dataset.page = page;
		if (actionsFor !== page) {
			actionsFor = page;
			actions.replaceChildren(...trailingActions(page, hooks));
		}
		const lock = actions.querySelector<HTMLButtonElement>('.edit-lock');
		if (lock) syncEditLockButton(lock);
		const markdown = actions.querySelector<HTMLButtonElement>('.markdown-toggle');
		if (markdown) syncMarkdownToggle(markdown);
		// A late registration (the page installing after the bar built) unhides in place —
		// the actions themselves rebuild only on a page change.
		const add = actions.querySelector<HTMLButtonElement>('.files-add');
		if (add) add.hidden = !filesActions;
	};
	render();
	rerenderAppBar = render;
	onWorkbenchChange(render);
	onEditLockChange(render);
	return bar;
}
