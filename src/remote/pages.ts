// The phone's page model (docs/ggs-remote-plan.md §11.2): on a phone the workbench is a set of
// full-screen pages — a side view (Files, Search, Changes, an extension's container such as
// Claude Code), the editor, the panel (Terminal) and an extension's own editor page (Git
// Graph, reached through its `scm/title` navigation launcher). This module answers "which
// page is showing" from the workbench's own DOM state and goes to a page through the command
// registry, so the bottom navigation, the app bar and the drawer all agree on one model and no
// view changes. Going to a page always shows it — never toggles it away: a tab bar that hides
// what it was tapped to show reads as broken.
//
// Nothing here names an extension: the containers are mirrored off the (hidden) activity bar
// and the launchers are whatever an installed manifest places in `scm/title`'s navigation
// group — the same entries Source Control renders as its header buttons.
import { commands } from '../commands';
import { codiconOf, resolvedMenuEntries, runMenuEntry, type ResolvedMenuEntry } from '../contributions';
import { extFileDataUrl } from '../extHost';
import { t } from '../i18n';
import { revealEditorPage, dismissFullScreenSideView } from './nav';

/** A page: a built-in side view, an extension container (`ext-container:…`), the editor,
 *  the panel, or an extension launcher (`launch:<command>`). */
export type PageId = string;

export const BUILTIN_VIEWS: Record<string, { icon: string; command: string; label: () => string }> = {
	explorer: { icon: 'files', command: 'workbench.showExplorer', label: () => t('remote.tabs.explorer') },
	search: { icon: 'search', command: 'workbench.showSearch', label: () => t('remote.tabs.search') },
	scm: { icon: 'source-control', command: 'workbench.showScm', label: () => t('remote.tabs.scm') },
	analysis: { icon: 'graph', command: 'workbench.showAnalysis', label: () => t('remote.page.analysis') },
	extensions: { icon: 'extensions', command: 'workbench.showExtensions', label: () => t('remote.page.extensions') }
};

export interface ExtensionContainer {
	id: PageId;
	title: string;
	/** The package image's URL once it loaded, else null (a codicon stands in). */
	image: string | null;
	item: HTMLElement;
}

export interface Launcher {
	id: PageId;
	label: string;
	extId: string | undefined;
	entry: ResolvedMenuEntry;
}

/** The extension containers, mirrored off the activity bar the workbench keeps (hidden on a
 *  phone): one per contributed views container, its title and icon. */
export function extensionContainers(): ExtensionContainer[] {
	return [...document.querySelectorAll<HTMLElement>('#activitybar .activity-item')]
		.filter((item) => item.dataset.view?.startsWith('ext-container:'))
		.map((item) => ({
			id: item.dataset.view!,
			// The workbench's delayed tooltip strips the native `title` off every activity
			// item (ui.ts keeps the name as `aria-label`), so the mirror reads whichever the
			// item carries — from a stripped item the tab would carry no label at all.
			title: item.title || item.getAttribute('aria-label') || '',
			image: item.querySelector('img')?.src || null,
			item
		}));
}

/** The extension launchers: `scm/title` navigation entries (the "View Git Graph" class of
 *  button) — each opens its extension's own page in the editor. */
export function launchers(): Launcher[] {
	const seen = new Set<string>();
	const out: Launcher[] = [];
	for (const entry of resolvedMenuEntries('scm/title')) {
		if (entry.group !== 'navigation' || seen.has(entry.command)) continue;
		seen.add(entry.command);
		out.push({ id: `launch:${entry.command}`, label: launcherLabel(entry.label), extId: entry.extId, entry });
	}
	return out;
}

/** A page's icon: a codicon, or an extension's package image (a launcher's manifest icon, a
 *  container's activity image) with a codicon standing in until — or instead of — the read. */
export function pageIcon(page: PageId, fallback = 'circle-large-outline'): HTMLElement {
	const glyph = (name: string) => {
		const span = document.createElement('span');
		span.className = `codicon codicon-${name}`;
		span.setAttribute('aria-hidden', 'true');
		return span;
	};
	const builtin = BUILTIN_VIEWS[page];
	if (builtin) return glyph(builtin.icon);
	if (page === 'editor') return glyph('code');
	if (page === 'panel') return glyph('terminal');
	const image = (src: string | null, stand: string, load?: Promise<string | null>) => {
		if (!src && !load) return glyph(stand);
		const img = document.createElement('img');
		img.className = 'ext-icon';
		img.alt = '';
		if (src) img.src = src;
		void load?.then((url) => {
			if (url) img.src = url;
			else img.replaceWith(glyph(stand));
		});
		return img;
	};
	if (page.startsWith('ext-container:')) {
		const container = extensionContainers().find((candidate) => candidate.id === page);
		return image(container?.image ?? null, 'list-tree');
	}
	if (page.startsWith('launch:')) {
		const launcher = launchers().find((candidate) => candidate.id === page);
		const icon = launcher?.entry.icon;
		const codicon = codiconOf(icon);
		if (codicon || !launcher?.extId || !icon) return glyph(codicon ?? 'git-merge');
		const path = typeof icon === 'string' ? icon : icon.dark ?? icon.light;
		return path ? image(null, 'git-merge', cachedIcon(launcher.extId, path)) : glyph('git-merge');
	}
	return glyph(fallback);
}

const iconCache = new Map<string, Promise<string | null>>();

function cachedIcon(extId: string, path: string): Promise<string | null> {
	const key = `${extId}/${path}`;
	let pending = iconCache.get(key);
	if (!pending) {
		pending = extFileDataUrl(extId, path).catch(() => null);
		iconCache.set(key, pending);
	}
	return pending;
}

/** A launcher's short label for a tab: "View Git Graph (git log)" → "Git Graph". */
export function launcherLabel(title: string): string {
	const bare = title.replace(/\s*[(（].*$/, '').trim();
	return bare.replace(/^(View|Show|Open)\s+/i, '').replace(/^(查看|显示|打开)\s*/, '') || title;
}

/** The tab elements of every editor group, the focused group's first. */
export function editorTabs(): HTMLElement[] {
	const focused = document.querySelector('.editor-group-box.focused');
	const all = [...document.querySelectorAll<HTMLElement>('#editorGroup .tab')];
	if (!focused) return all;
	return [...all.filter((tab) => focused.contains(tab)), ...all.filter((tab) => !focused.contains(tab))];
}

/** The active tab of the group the phone shows (the focused one). */
export function activeTab(): HTMLElement | null {
	return document.querySelector<HTMLElement>('.editor-group-box.focused .tab.active') ?? document.querySelector<HTMLElement>('#editorGroup .tab.active');
}

/** The launcher whose extension owns this tab's page, if any. */
export function launcherForTab(tab: HTMLElement | null, list = launchers()): Launcher | undefined {
	if (!tab || tab.dataset.kind !== 'extpage' || !tab.dataset.ext) return undefined;
	return list.find((launcher) => launcher.extId === tab.dataset.ext);
}

/** Whether the "editor" page should show its empty state over an extension's page: set when
 *  the Editor tab is chosen while only launcher pages are open, cleared by any page move. */
let editorPlaceholder = false;

export function editorPlaceholderShown(): boolean {
	return editorPlaceholder && currentPage() === 'editor';
}

/** The page the phone is showing right now, read off the workbench's DOM. */
export function currentPage(): PageId {
	const sidebar = document.getElementById('sidebar');
	if (sidebar && !sidebar.hidden) {
		// Another page came up over the empty state (a command, the palette): the flag
		// belonged to that one visit of the editor page.
		editorPlaceholder = false;
		return (document.querySelector('#activitybar .activity-item.active') as HTMLElement | null)?.dataset.view ?? 'explorer';
	}
	const panel = document.getElementById('panel');
	if (panel && !panel.hidden) {
		editorPlaceholder = false;
		return 'panel';
	}
	if (editorPlaceholder) return 'editor';
	const launcher = launcherForTab(activeTab());
	return launcher ? launcher.id : 'editor';
}

/** Show a page. Every path ends with that page on screen, whatever was showing before. */
export async function goTo(page: PageId): Promise<void> {
	editorPlaceholder = false;
	if (page === 'editor') {
		revealEditorPage();
		// The active tab is an extension's own page (the graph): the Editor tab means the
		// files — the most recently shown regular tab, else the empty state.
		if (launcherForTab(activeTab())) {
			const regular = editorTabs().find((tab) => !launcherForTab(tab));
			if (regular) regular.click();
			else editorPlaceholder = true;
		}
		notifyPageChange();
		return;
	}
	if (page === 'panel') {
		// `terminal.toggle` reveals a panel the side view covers and shows a hidden one; only
		// an already-visible, uncovered panel would toggle away — that page is showing.
		if (currentPage() !== 'panel') await commands.execute('terminal.toggle');
		notifyPageChange();
		return;
	}
	if (page.startsWith('launch:')) {
		const launcher = launchers().find((candidate) => candidate.id === page);
		revealEditorPage();
		// Already open: reveal its tab (no second run — a launcher may re-query its data).
		const open = launcher ? editorTabs().find((tab) => launcherForTab(tab, [launcher])) : undefined;
		if (open) open.click();
		else if (launcher) runMenuEntry(launcher.entry);
		notifyPageChange();
		return;
	}
	const builtin = BUILTIN_VIEWS[page];
	if (builtin) {
		await commands.execute(builtin.command);
	} else {
		// An extension container: its activity item's click toggles, so click only when it is
		// not the page already showing.
		const container = extensionContainers().find((candidate) => candidate.id === page);
		if (container && currentPage() !== page) container.item.click();
	}
	notifyPageChange();
}

/** Close whatever full-screen page sits over the editor (the back gesture's target). */
export function backToEditor(): void {
	dismissFullScreenSideView();
}

const pageListeners = new Set<() => void>();

/** Run `listener` after a page move this module made (DOM observers catch the rest). */
export function onPageChange(listener: () => void): () => void {
	pageListeners.add(listener);
	return () => pageListeners.delete(listener);
}

function notifyPageChange(): void {
	for (const listener of pageListeners) listener();
}

/** Clear the empty-state flag: a tab was chosen elsewhere (the open editors sheet). */
export function clearEditorPlaceholder(): void {
	if (!editorPlaceholder) return;
	editorPlaceholder = false;
	notifyPageChange();
}

/* ---------- One watcher for every piece of phone chrome ---------- */

const watchers = new Set<() => void>();
let observer: MutationObserver | null = null;

/** Mutation targets inside the editor area that change what the chrome shows: the tab strips
 *  and the group boxes. Everything else in there (CodeMirror's own DOM, a terminal's rows)
 *  is skipped at the first class check, so typing costs the chrome nothing. */
function chromeRelevant(record: MutationRecord): boolean {
	// A text edit (the branch name) reports the text node; its element decides.
	const target = record.target instanceof Element ? record.target : record.target.parentElement;
	if (!target) return false;
	if (target.id === 'sidebar' || target.id === 'panel' || target.id === 'activitybar') return true;
	const list = target.classList;
	return list.contains('tabs-container') || list.contains('tab') || list.contains('editor-group-box') || list.contains('editor-groups-root')
		|| list.contains('editor-split-child') || list.contains('activity-item') || list.contains('panel-title') || list.contains('badge')
		|| (target as HTMLElement).dataset?.item === 'branch' || target.closest('[data-item="branch"], #activitybar') !== null;
}

function installObserver(): void {
	if (observer || typeof MutationObserver === 'undefined') return;
	observer = new MutationObserver((records) => {
		if (!records.some(chromeRelevant)) return;
		for (const watcher of watchers) watcher();
	});
	const watch = (id: string, options: MutationObserverInit) => {
		const target = document.getElementById(id);
		if (target) observer!.observe(target, options);
	};
	watch('sidebar', { attributes: true, attributeFilter: ['hidden'] });
	watch('panel', { attributes: true, attributeFilter: ['hidden', 'class'], subtree: true, childList: false });
	watch('activitybar', { attributes: true, attributeFilter: ['class', 'title', 'src'], subtree: true, childList: true });
	watch('editorGroup', { attributes: true, attributeFilter: ['class'], subtree: true, childList: true });
	watch('statusbar', { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['hidden'] });
}

/** Run `listener` whenever the page, the tabs, the badges or the branch may have changed. */
export function onWorkbenchChange(listener: () => void): () => void {
	installObserver();
	watchers.add(listener);
	const offPage = onPageChange(listener);
	return () => {
		watchers.delete(listener);
		offPage();
	};
}

/** Drop the observer (tests rebuild the DOM between cases). */
export function resetWorkbenchWatch(): void {
	observer?.disconnect();
	observer = null;
	watchers.clear();
}
