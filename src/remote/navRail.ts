// The vertical navigation rail (docs/remote-client-plan.md §5.2, §5.3): the bottom
// navigation's destinations stood on their side — icon-only at 56 px on a landscape phone
// (no bottom bar: the height is 360–430 px and the content needs all of it), icon over
// label at 72 px on a portrait tablet. The same page model (pages.ts) drives it: a tap
// always shows its page, the active page is marked, and the badges (open editors, pending
// changes) carry what the hidden status and activity bars would.
import { t } from '../platform/i18n';
import { currentPage, extensionContainers, goTo, onWorkbenchChange, pageIcon, type PageId } from './pages';
import { bottomTabs, tabBadge } from './bottomTabs';

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
	// The label span exists in every form; the rail's width decides whether CSS shows it
	// (§5.2 hides, §5.3 shows) — one element, no rebuild between the two rails.
	const text = document.createElement('span');
	text.className = 'label';
	text.textContent = label;
	button.append(pill, text);
	button.addEventListener('click', onTap);
	return button;
}

/** Mark the page showing and refresh the badges (the bar's own syncActive answers for the
 *  buttons themselves — the rail's buttons carry the same classes and badge structure). */
function syncRail(bar: HTMLElement): void {
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

/** Rebuild the buttons when the destinations change, else only the active mark and badges
 *  (bottomTabs.syncTabs answers the same keying for the bar; the rail keeps its own key so
 *  the two never fight over one element). The key carries the containers' images too — a
 *  package image replacing a codicon stand-in is a rebuild, or the rail's button would
 *  wear the placeholder forever (the bar's key already says so). */
function syncButtons(bar: HTMLElement, onTap: (page: PageId) => void): void {
	const tabs = bottomTabs();
	const images = extensionContainers().map((container) => container.image ?? '').join(' ');
	const key = `${tabs.map((tab) => `${tab.id}|${tab.label}`).join(' ')}#${images}`;
	if (bar.dataset.tabsKey !== key) {
		bar.dataset.tabsKey = key;
		bar.replaceChildren(
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
 *  has no app bar, the rail's Editor item is its only switcher. */
export function createNavRail(onTap: (page: PageId) => void = () => undefined): HTMLElement {
	const bar = document.createElement('nav');
	bar.className = 'ggs-nav-rail';
	bar.setAttribute('role', 'tablist');
	bar.setAttribute('aria-label', t('remote.nav.label'));
	syncButtons(bar, onTap);
	onWorkbenchChange(() => syncButtons(bar, onTap));
	return bar;
}
