// The phone's navigation drawer (docs/ggs-remote-plan.md §11.2): the ☰ in the app bar opens a
// panel from the left edge with everything the five bottom destinations cannot hold — every
// page (Search, Terminal, Extensions, Code Analysis and each extension's page beside the
// bar's own), the workspace actions (Go to File, the Command Palette, this PC's windows and
// the picker page at /windows), the
// transfers, the full application menus (File, Edit, View, … as sheets), Settings and the
// Data Saver switch, and the session's traffic. A tap on the backdrop, a swipe to the left,
// Escape or the phone's back closes it.
import { commands } from '../platform/commands';
import { formatBytes } from '../platform/ui';
import { t, tf } from '../platform/i18n';
import type { MenuDefinition } from '../workbench/titlebar';
import { showActionSheet } from './actionSheet';
import { branchName, workspaceName } from './appBar';
import { pushBack } from './backStack';
import { tabBadge } from './bottomTabs';
import { setDataSaver } from './dataSaver';
import { BUILTIN_VIEWS, currentPage, extensionContainers, goTo, launchers, pageIcon, type PageId } from './pages';
import { remoteEnv } from './session';
import { openSettingsPage } from './settingsPage';
import { codicon, toggleSwitch } from './widgets';

let open: { root: HTMLElement; release: () => void } | null = null;

export function closeDrawer(): void {
	if (!open) return;
	const { root, release } = open;
	open = null;
	root.classList.remove('open');
	release();
	// Let the slide-out play; a reopen before it ends replaces the element anyway.
	setTimeout(() => root.remove(), 200);
}

export function drawerOpen(): boolean {
	return open !== null;
}

/** Every page the drawer lists, in order: the bar's own, then the rest. */
export function drawerPages(): { id: PageId; label: string }[] {
	const pages: { id: PageId; label: string }[] = [
		{ id: 'explorer', label: t('remote.tabs.explorer') },
		{ id: 'editor', label: t('remote.tabs.editor') },
		{ id: 'search', label: t('remote.tabs.search') },
		{ id: 'scm', label: t('remote.page.scm') }
	];
	for (const launcher of launchers()) pages.push({ id: launcher.id, label: launcher.label });
	const titles = new Set<string>();
	for (const container of extensionContainers()) {
		if (titles.has(container.title)) continue;
		titles.add(container.title);
		pages.push({ id: container.id, label: container.title });
	}
	pages.push({ id: 'panel', label: t('remote.tabs.panel') });
	pages.push({ id: 'extensions', label: BUILTIN_VIEWS['extensions']!.label() });
	pages.push({ id: 'analysis', label: BUILTIN_VIEWS['analysis']!.label() });
	return pages;
}

function row(iconNode: HTMLElement, label: string, run: () => void, options: { active?: boolean; badge?: string; trailing?: HTMLElement; disabled?: boolean } = {}): HTMLButtonElement {
	const button = document.createElement('button');
	button.className = 'ggs-drawer-row' + (options.active ? ' active' : '');
	button.disabled = Boolean(options.disabled);
	const iconBox = document.createElement('span');
	iconBox.className = 'icon';
	iconBox.appendChild(iconNode);
	const text = document.createElement('span');
	text.className = 'label';
	text.textContent = label;
	button.append(iconBox, text);
	if (options.badge) {
		const badge = document.createElement('span');
		badge.className = 'count';
		badge.textContent = options.badge;
		button.appendChild(badge);
	}
	if (options.trailing) button.appendChild(options.trailing);
	button.addEventListener('click', run);
	return button;
}

function section(label: string, rows: HTMLElement[]): HTMLElement {
	const group = document.createElement('div');
	group.className = 'ggs-drawer-section';
	const heading = document.createElement('div');
	heading.className = 'heading';
	heading.textContent = label;
	group.append(heading, ...rows);
	return group;
}

/** A command row that closes the drawer first (the command may open a sheet or a page). */
function commandRow(iconName: string, label: string, id: string, extra: { badge?: string } = {}): HTMLButtonElement {
	return row(codicon(iconName), label, () => {
		closeDrawer();
		void commands.execute(id);
	}, { ...extra, disabled: !commands.isEnabled(id) });
}

/** Open the drawer. `menus` reads the workbench's menus at open time, so every entry's
 *  enablement is the state of this moment. */
export function openDrawer(menus: () => MenuDefinition[]): void {
	if (open) return;
	const root = document.createElement('div');
	root.className = 'ggs-drawer-backdrop';
	const panel = document.createElement('aside');
	panel.className = 'ggs-drawer';
	panel.setAttribute('role', 'dialog');
	panel.setAttribute('aria-modal', 'true');
	panel.setAttribute('aria-label', t('remote.menu'));

	// Header: the product, the workspace and its branch, this window among the PC's windows.
	const header = document.createElement('div');
	header.className = 'ggs-drawer-header';
	const product = document.createElement('div');
	product.className = 'product';
	product.textContent = 'Git Graph Studio';
	const workspace = document.createElement('div');
	workspace.className = 'workspace';
	workspace.textContent = workspaceName() || t('remote.drawer.noFolder');
	const branch = branchName();
	const meta = document.createElement('div');
	meta.className = 'meta';
	if (branch) meta.append(codicon('git-branch'), document.createTextNode(` ${branch}`));
	header.append(product, workspace, meta);
	const env = remoteEnv();
	const windows = env?.transport.instances.length ?? 0;

	const page = currentPage();
	const pages = drawerPages().map((entry) =>
		row(pageIcon(entry.id), entry.label, () => {
			closeDrawer();
			void goTo(entry.id);
		}, { active: entry.id === page, badge: tabBadge(entry.id)?.text })
	);

	// The rows only a browser session can serve (this PC's windows, the picker page,
	// transfers, Data Saver) are left out where the drawer runs in the PC's own window —
	// the replica's phone mode, whose viewer carries its own Windows button.
	const workspaceRows = [
		commandRow('go-to-file', t('remote.appbar.quickOpen'), 'workbench.quickOpen'),
		commandRow('terminal-cmd', t('remote.drawer.palette'), 'workbench.commandPalette'),
		...(env
			? [
					commandRow('multiple-windows', t('remote.drawer.windows'), 'remote.switchWindow', { badge: windows > 1 ? String(windows) : undefined }),
					// The picker page (`/windows`): the daemon's own landing page — the window
					// list, the typed folder path and the remote's one spawn surface (K4).
					commandRow('browser', t('remote.windowsPage'), 'remote.windowsPage'),
					commandRow('device-desktop', t('remote.liveView'), 'remote.liveView')
				]
			: [])
	];
	const transferRows = [
		commandRow('cloud-upload', t('transfer.upload'), 'remote.uploadFiles'),
		commandRow('file-directory-create', t('transfer.uploadFolder'), 'remote.uploadFolder'),
		commandRow('cloud-download', t('remote.editor.download'), 'remote.download')
	];
	const menuRows = menus().map((menu) =>
		row(codicon('menu'), menu.label, () => {
			closeDrawer();
			showActionSheet(menu.entries(), menu.label);
		}, { trailing: codicon('chevron-right') })
	);
	const saver = document.documentElement.hasAttribute('data-data-saver');
	const saverRow = row(codicon('dashboard'), t('remote.drawer.dataSaver'), () => {
		const next = !document.documentElement.hasAttribute('data-data-saver');
		setDataSaver(next);
		saverRow.querySelector('.switch')?.replaceWith(toggleSwitch(next));
	}, { trailing: toggleSwitch(saver) });
	// Settings opens the phone's own page (settingsPage.ts), never the desktop dialog the
	// command would show: the 720 px two-pane window is unreadable at this width.
	const settingsRows = [...(env ? [saverRow] : []), row(codicon('settings-gear'), t('remote.drawer.settings'), () => {
		closeDrawer();
		openSettingsPage();
	})];

	const body = document.createElement('div');
	body.className = 'ggs-drawer-body';
	body.append(
		section(t('remote.drawer.pages'), pages),
		section(t('remote.drawer.workspace'), workspaceRows),
		...(env ? [section(t('remote.drawer.transfer'), transferRows)] : []),
		section(t('remote.drawer.menus'), menuRows),
		section(t('remote.drawer.preferences'), settingsRows)
	);

	const footer = document.createElement('div');
	footer.className = 'ggs-drawer-footer';
	const stats = env?.transport.stats;
	footer.textContent = stats ? tf('remote.traffic', formatBytes(stats.up), formatBytes(stats.down)) : t('remote.drawer.local');

	panel.append(header, body, footer);
	root.appendChild(panel);
	root.addEventListener('click', (event) => {
		if (event.target === root) closeDrawer();
	});
	root.addEventListener('keydown', (event) => {
		if (event.key === 'Escape') closeDrawer();
	});
	installSwipeClose(panel);
	document.body.appendChild(root);
	open = { root, release: pushBack(closeDrawer) };
	requestAnimationFrame(() => root.classList.add('open'));
	(panel.querySelector('.ggs-drawer-row.active') as HTMLElement | null)?.focus({ preventScroll: true });
}

/** A leftward swipe on the drawer follows the finger and closes it past a third. */
function installSwipeClose(panel: HTMLElement): void {
	let start: { x: number; y: number } | null = null;
	let dx = 0;
	let horizontal: boolean | null = null;
	panel.addEventListener('pointerdown', (event) => {
		start = { x: event.clientX, y: event.clientY };
		dx = 0;
		horizontal = null;
	});
	panel.addEventListener('pointermove', (event) => {
		if (!start) return;
		const mx = event.clientX - start.x;
		const my = event.clientY - start.y;
		if (horizontal === null && Math.hypot(mx, my) > 8) horizontal = Math.abs(mx) > Math.abs(my);
		if (!horizontal) return;
		dx = Math.min(0, mx);
		panel.classList.add('dragging');
		panel.style.transform = `translateX(${dx}px)`;
	});
	const end = () => {
		if (!start) return;
		start = null;
		panel.classList.remove('dragging');
		panel.style.transform = '';
		if (horizontal && dx < -panel.offsetWidth / 3) closeDrawer();
	};
	panel.addEventListener('pointerup', end);
	panel.addEventListener('pointercancel', end);
}
