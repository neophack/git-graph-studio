// The phone's bottom navigation (docs/ggs-remote-plan.md §11.2): the activity bar's job on a
// screen too narrow for it — at most five destinations, each a page of pages.ts: Files, the
// Editor, Changes, then the installed extensions' pages (a `scm/title` launcher such as Git
// Graph, a views container such as Claude Code), with Terminal and Search filling any slot
// left. A tap always shows its page; tapping the page already showing is a reselect — the
// Editor's opens the open editors list, a list page scrolls back to its top. Badges carry
// what the hidden status and activity bars would: the open editors (a dot while one is
// unsaved) and the pending changes. Everything else lives in the drawer (navDrawer.ts).
import { t } from '../platform/i18n';
import {
	BUILTIN_VIEWS,
	currentPage,
	editorTabs,
	extensionContainers,
	goTo,
	launcherForTab,
	launchers,
	onWorkbenchChange,
	pageIcon,
	type PageId
} from './pages';

export const MAX_TABS = 5;

export interface BottomTab {
	id: PageId;
	label: string;
}

/** The destinations, in bar order, capped at five. */
export function bottomTabs(): BottomTab[] {
	const tabs: BottomTab[] = [
		{ id: 'explorer', label: t('remote.tabs.explorer') },
		{ id: 'editor', label: t('remote.tabs.editor') },
		{ id: 'scm', label: t('remote.tabs.scm') }
	];
	for (const launcher of launchers()) tabs.push({ id: launcher.id, label: launcher.label });
	const titles = new Set<string>();
	for (const container of extensionContainers()) {
		// One package can declare look-alike containers (two "Claude Code"s, one per mode);
		// the bar shows the first.
		if (titles.has(container.title)) continue;
		titles.add(container.title);
		tabs.push({ id: container.id, label: container.title });
	}
	tabs.push({ id: 'panel', label: t('remote.tabs.panel') });
	tabs.push({ id: 'search', label: t('remote.tabs.search') });
	return tabs.slice(0, MAX_TABS);
}

/** The badge of one destination: a count, a dot, or nothing. */
export function tabBadge(id: PageId): { text: string; dot: boolean } | null {
	if (id === 'editor') {
		const tabs = editorTabs().filter((tab) => !launcherForTab(tab));
		if (tabs.length === 0) return null;
		return { text: tabs.length > 99 ? '99+' : String(tabs.length), dot: tabs.some((tab) => tab.classList.contains('dirty')) };
	}
	if (id === 'scm') {
		const count = document.querySelector('#activitybar .activity-item[data-view="scm"] .badge')?.textContent?.trim();
		return count ? { text: count, dot: false } : null;
	}
	return null;
}

function tabButton(tab: BottomTab, onTap: () => void): HTMLButtonElement {
	const button = document.createElement('button');
	button.dataset.tab = tab.id;
	if (tab.id.startsWith('ext-container:') || tab.id.startsWith('launch:')) button.dataset.ext = '';
	button.setAttribute('role', 'tab');
	button.setAttribute('aria-label', tab.label);
	const pill = document.createElement('span');
	pill.className = 'pill';
	pill.appendChild(pageIcon(tab.id));
	const badge = document.createElement('span');
	badge.className = 'badge';
	badge.hidden = true;
	pill.appendChild(badge);
	const label = document.createElement('span');
	label.className = 'label';
	label.textContent = tab.label;
	button.append(pill, label);
	button.addEventListener('click', onTap);
	return button;
}

/** Mark the page showing and refresh the badges. */
export function syncActive(bar: HTMLElement): void {
	const page = currentPage();
	for (const button of bar.querySelectorAll<HTMLButtonElement>('button[data-tab]')) {
		const id = button.dataset.tab ?? '';
		const active = id === page;
		button.classList.toggle('active', active);
		button.setAttribute('aria-selected', active ? 'true' : 'false');
		const badge = button.querySelector<HTMLElement>('.badge')!;
		const value = tabBadge(id);
		badge.hidden = value === null;
		badge.textContent = value?.text ?? '';
		badge.classList.toggle('dirty', value?.dot ?? false);
	}
}

/** Scroll a list page back to its top — the reselect gesture every phone tab bar has. */
function scrollPageToTop(): void {
	const sidebar = document.getElementById('sidebar');
	if (!sidebar) return;
	for (const scroller of sidebar.querySelectorAll<HTMLElement>('.pane-body, .tree, .list, [class*="scroll"]')) {
		if (scroller.scrollTop > 0 && scroller.offsetParent !== null) scroller.scrollTo({ top: 0, behavior: 'smooth' });
	}
}

/** Rebuild the buttons when the destinations change (an extension installs, its icon
 *  loads); otherwise only the active mark and badges move. */
export function syncTabs(bar: HTMLElement, onReselect: (page: PageId) => void): void {
	const tabs = bottomTabs();
	// Keyed on the containers' images too: a package image replaces the codicon once it loads.
	const images = extensionContainers().map((container) => container.image ?? '').join(' ');
	const key = `${tabs.map((tab) => `${tab.id}|${tab.label}`).join(' ')}#${images}`;
	if (bar.dataset.tabsKey !== key) {
		bar.dataset.tabsKey = key;
		bar.replaceChildren(
			...tabs.map((tab) =>
				tabButton(tab, () => {
					if (currentPage() === tab.id) onReselect(tab.id);
					else void goTo(tab.id).then(() => syncActive(bar));
				})
			)
		);
	}
	syncActive(bar);
}

/** The bar itself. `onReselect` handles a tap on the page already showing (the shell opens
 *  the open editors list for the Editor); list pages scroll to the top by default. */
export function createBottomTabs(onReselect: (page: PageId) => void = () => undefined): HTMLElement {
	const bar = document.createElement('nav');
	bar.className = 'ggs-bottom-tabs';
	bar.setAttribute('role', 'tablist');
	bar.setAttribute('aria-label', t('remote.nav.label'));
	const reselect = (page: PageId) => {
		if (BUILTIN_VIEWS[page] || page.startsWith('ext-container:')) scrollPageToTop();
		onReselect(page);
	};
	syncTabs(bar, reselect);
	onWorkbenchChange(() => syncTabs(bar, reselect));
	return bar;
}
