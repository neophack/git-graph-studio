// The vertical navigation rail (docs/remote-client-plan.md §5.2, §5.3): the bottom
// navigation's destinations stood on their side — icon-only at 56 px on every form that
// shows it (a landscape phone has no bottom bar: the height is 360–430 px and the content
// needs all of it; the portrait tablet's icon-over-label form went with the owner's
// 2026-10-16 direction, 左轨图标不配文字 — VS Code's activity bar shape). The same page
// model (pages.ts) drives it: a tap always shows its page, the active page is marked, and
// the badges (open editors, pending changes) carry what the hidden status and activity
// bars would. The destination SET is the form's (the owner's 2026-10-16 direction, 平板
// 左轨要有搜索、插件、终端): the portrait tablet's rail carries the drawer's full page
// list uncapped (railTabs), the landscape phone's keeps the bottom bar's five-cap economy.
import { onLocaleChange, t } from '../platform/i18n';
import { currentPage, extensionContainers, goTo, onWorkbenchChange, pageIcon, type PageId } from './pages';
import { pageBack, pageBackAvailable } from './pageBack';
import { bottomTabs, tabBadge } from './bottomTabs';
import { drawerPages } from './navDrawer';
import { currentDeviceClass, onDeviceClassChange } from './responsive';
import { codicon } from './widgets';

function railButton(id: PageId, label: string, onTap: () => void): HTMLButtonElement {
	const button = document.createElement('button');
	button.dataset.tab = id;
	if (id.startsWith('ext-container:') || id.startsWith('launch:')) button.dataset.ext = '';
	button.setAttribute('role', 'tab');
	button.setAttribute('aria-label', label);
	const pill = document.createElement('span');
	pill.className = 'pill';
	pill.appendChild(pageIcon(id));
	const badge = document.createElement('span');
	badge.className = 'badge';
	badge.hidden = true;
	pill.appendChild(badge);
	button.appendChild(pill);
	button.addEventListener('click', onTap);
	return button;
}

/** Mark the page showing and refresh the badges (the bar's own syncActive answers for the
 *  buttons themselves — the rail's buttons carry the same classes and badge structure). */
function syncRail(bar: HTMLElement): void {
	const page = currentPage();
	const back = bar.querySelector<HTMLButtonElement>('.ggs-rail-back');
	if (back) back.hidden = !pageBackAvailable();
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

/** The rail's ☰ (the portrait tablet's menu entry — it has no app bar): the drawer the
 *  phone's app bar opens, reached from the rail's head. The landscape phone's rail hides
 *  it (layouts.css — its app bar carries its own ☰). */
function railMenuButton(open: () => void): HTMLButtonElement {
	const button = document.createElement('button');
	button.className = 'ggs-rail-menu';
	button.setAttribute('aria-label', t('remote.menu'));
	const pill = document.createElement('span');
	pill.className = 'pill';
	pill.appendChild(codicon('menu'));
	button.appendChild(pill);
	button.addEventListener('click', open);
	return button;
}

/** The rail's ‹ (the portrait tablet's back entry — the form draws no app bar, so the ‹ the
 *  phone's app bar carries rides the rail's head instead, above ☰, while a page covers the
 *  editor). The landscape phone hides it (layouts.css): its app bar carries its own ‹. */
function railBackButton(): HTMLButtonElement {
	const button = document.createElement('button');
	button.className = 'ggs-rail-back';
	button.setAttribute('aria-label', t('remote.page.back'));
	const pill = document.createElement('span');
	pill.className = 'pill';
	pill.appendChild(codicon('chevron-left'));
	button.appendChild(pill);
	button.addEventListener('click', () => void pageBack());
	return button;
}

/** The rail's destinations by form: the portrait tablet's rail carries every page the drawer
 *  lists — search, extensions and terminal with them (the owner's 2026-10-16 direction, 平板
 *  左轨要有搜索、插件、终端; the five-cap is the bottom bar's economy, and a tablet's rail has
 *  an activity bar's height to spend); every other form that shows the rail (the landscape
 *  phone, height 360–430 px) keeps the capped set. */
function railTabs(): { id: PageId; label: string }[] {
	return currentDeviceClass() === 'tablet-portrait' ? drawerPages() : bottomTabs();
}

/** Rebuild the buttons when the destinations change, else only the active mark and badges
 * (bottomTabs.syncTabs answers the same keying for the bar; the rail keeps its own key so
 * the two never fight over one element). The key carries the device class (the form picks
 * the destination set) and the containers' images too — a package image replacing a
 * codicon stand-in is a rebuild, or the rail's button would wear the placeholder forever
 * (the bar's key already says so). */
function syncButtons(bar: HTMLElement, onTap: (page: PageId) => void, menu: HTMLButtonElement | null, back: HTMLButtonElement | null): void {
	const tabs = railTabs();
	const images = extensionContainers().map((container) => container.image ?? '').join(' ');
	const key = `${currentDeviceClass() ?? ''}#${tabs.map((tab) => `${tab.id}|${tab.label}`).join(' ')}#${images}`;
	if (bar.dataset.tabsKey !== key) {
		bar.dataset.tabsKey = key;
		bar.replaceChildren(
			...(back ? [back] : []),
			...(menu ? [menu] : []),
			...tabs.map((tab) =>
				railButton(tab.id, tab.label, () => {
					if (currentPage() !== tab.id) void goTo(tab.id).then(() => syncRail(bar));
					onTap(tab.id);
				})
			)
		);
	}
	syncRail(bar);
}

/** The rail itself. Every tap reports through `onTap` (a reselect on the rail was a plain
 *  re-mark before): the Editor's opens the open editors list (§6.2) — the portrait tablet
 *  has no app bar, the rail's Editor item is its only switcher. `openMenu`, when given,
 *  rides the ☰ at the rail's head. */
export function createNavRail(onTap: (page: PageId) => void = () => undefined, openMenu: (() => void) | null = null): HTMLElement {
	const bar = document.createElement('nav');
	bar.className = 'ggs-nav-rail';
	bar.setAttribute('role', 'tablist');
	bar.setAttribute('aria-label', t('remote.nav.label'));
	const back = railBackButton();
	const menu = openMenu ? railMenuButton(openMenu) : null;
	syncButtons(bar, onTap, menu, back);
	onWorkbenchChange(() => syncButtons(bar, onTap, menu, back));
	// A device-class flip (into or out of the portrait tablet) changes which destination set
	// the rail carries: re-read it as the layout host rearranges the same element.
	onDeviceClassChange(() => syncButtons(bar, onTap, menu, back));
	// A language switch relabels the rail's own chrome (its aria name, the ☰ and the ‹)
	// and rebuilds the destinations — syncButtons keys on the labels, so the re-read under
	// the new locale replaces the buttons.
	onLocaleChange(() => {
		bar.setAttribute('aria-label', t('remote.nav.label'));
		back.setAttribute('aria-label', t('remote.page.back'));
		menu?.setAttribute('aria-label', t('remote.menu'));
		syncButtons(bar, onTap, menu, back);
	});
	return bar;
}
