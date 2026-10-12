// The remote shell (docs/ggs-remote-plan.md §11): what the remote workbench adds around the
// unchanged desktop workbench once it has booted — the window switcher in the title bar and
// the command palette, long-press menus as an action sheet, upload / download commands, the
// Data Saver hint and the traffic readout; and on a phone the whole app chrome: the app bar,
// the bottom navigation, the drawer, the editor page's empty state and editing row, and the
// terminal's key row, all driven by one page model (pages.ts). Layout itself is CSS
// (remote.css), keyed on the form factor responsive.ts writes. The PC's own window installs
// the same shell while a phone watches it (the replica's phone mode, mirror/phoneShell.ts):
// what only a browser session can do — the window switcher, transfers, the traffic readout,
// Data Saver — stays with the browser.
import { commands } from '../commands';
import { notify } from '../ui';
import { t, tf } from '../i18n';
import { currentWorkbench } from '../workbench';
import { installActionSheet } from './actionSheet';
import { createAppBar } from './appBar';
import { createBottomTabs } from './bottomTabs';
import { createEditorAccessory } from './editorAccessory';
import { createEditorEmptyState, openEditorActions, openEditorsSheet } from './editorSwitcher';
import { installLongPress, swipeBack } from './gestures';
import { closeDrawer, openDrawer } from './navDrawer';
import { backToEditor, currentPage, onWorkbenchChange } from './pages';
import { formFactor, onFormFactorChange } from './responsive';
import { createTerminalKeys } from './terminalKeys';
import { download, uploadFiles } from './transfer';
import { openWindowSwitcher, watchLifecycle } from './windowSwitcher';
import { connectionLooksSlow, dataSaverPreferred, setDataSaver } from './dataSaver';
import { remoteEnv } from './session';
import { installPhoneSettingsEntry } from './settingsPage';
import { invoke } from '@tauri-apps/api/core';
import { modeUrl } from './mirror/uiMode';

function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

async function firstFolder(): Promise<string | null> {
	try {
		const status = await invoke<{ folders?: string[] }>('remote_host_status');
		return status.folders?.[0] ?? null;
	} catch {
		return null;
	}
}

function registerCommands(): void {
	if (!remoteEnv()) return;
	commands.register({ id: 'remote.switchWindow', title: t('remote.windows'), category: 'Remote', run: () => openWindowSwitcher() });
	// Back from this page's own workbench to the PC window's live copy (§22.5), pinned so the
	// auto rule does not hand a phone straight back here while the PC shows the window.
	commands.register({ id: 'remote.liveView', title: t('remote.liveView'), category: 'Remote', run: () => location.replace(modeUrl(location.href, 'mirror')) });
	commands.register({
		id: 'remote.uploadFiles',
		title: t('remote.transfer.upload'),
		category: 'Remote',
		run: async () => {
			const dir = await firstFolder();
			if (!dir) return;
			const done = await uploadFiles(dir, false);
			if (done.length) notify('info', tf('remote.transfer.uploaded', done.length));
		}
	});
	commands.register({
		id: 'remote.uploadFolder',
		title: t('remote.transfer.uploadFolder'),
		category: 'Remote',
		run: async () => {
			const dir = await firstFolder();
			if (!dir) return;
			const done = await uploadFiles(dir, true);
			if (done.length) notify('info', tf('remote.transfer.uploaded', done.length));
		}
	});
	commands.register({
		id: 'remote.download',
		title: t('remote.transfer.download'),
		category: 'Remote',
		run: async () => {
			const active = document.querySelector('.tab.active')?.getAttribute('title') ?? (await firstFolder());
			if (!active) return;
			try {
				await download(active);
			} catch (error) {
				notify('error', tf('remote.transfer.failed', String(error)));
			}
		}
	});
	commands.register({
		id: 'remote.toggleDataSaver',
		title: t('setting.remote.dataSaver'),
		category: 'Remote',
		run: () => setDataSaver(!document.documentElement.hasAttribute('data-data-saver'))
	});
	commands.register({
		id: 'remote.traffic',
		title: tf('remote.traffic', '…', '…'),
		category: 'Remote',
		run: () => {
			const stats = remoteEnv()?.transport.stats;
			if (stats) notify('info', tf('remote.traffic', formatBytes(stats.up), formatBytes(stats.down)));
		}
	});
}

function addSwitcherButton(): void {
	if (!remoteEnv()) return;
	const titlebar = document.getElementById('titlebar');
	if (!titlebar || titlebar.querySelector('.ggs-window-switcher')) return;
	const button = document.createElement('div');
	button.className = 'ggs-window-switcher titlebar-nav';
	button.setAttribute('role', 'button');
	button.title = t('remote.windows');
	const icon = document.createElement('span');
	icon.className = 'codicon codicon-multiple-windows';
	button.appendChild(icon);
	button.addEventListener('click', () => void openWindowSwitcher());
	const center = titlebar.querySelector('.titlebar-center');
	(center ?? titlebar).appendChild(button);
}

/** Create a piece of phone chrome once, then show it only on the phone. */
function phonePart(selector: string, create: () => HTMLElement, place: (element: HTMLElement) => void, phone: boolean): void {
	let element = document.querySelector(selector) as HTMLElement | null;
	if (phone && !element) {
		element = create();
		place(element);
	}
	if (element) element.hidden = !phone;
}

function placePhoneChrome(): void {
	const phone = formFactor() === 'phone';
	const menus = () => currentWorkbench?.titleBar.menuDefinitions() ?? [];
	// The app bar takes the title bar's row (the title bar stays in the DOM, CSS-hidden: the
	// workbench keeps filling it, and the tablet and desktop forms show it).
	phonePart('.ggs-appbar', () => createAppBar({ openDrawer: () => openDrawer(menus), openEditors: openEditorsSheet, editorActions: openEditorActions }), (bar) => document.getElementById('titlebar')?.before(bar), phone);
	// In the body's own column under the workbench: the editing row, then the navigation —
	// in flow rather than fixed, so a raised keyboard (the body follows the visual viewport)
	// lifts both with the content instead of covering them.
	phonePart('.ggs-bottom-tabs', () => createBottomTabs((page) => {
		if (page === 'editor') openEditorsSheet();
	}), (bar) => document.getElementById('statusbar')?.after(bar), phone);
	phonePart('.ggs-editor-accessory', createEditorAccessory, (row) => document.querySelector('.ggs-bottom-tabs')?.before(row), phone);
	phonePart('.ggs-editor-empty', createEditorEmptyState, (pane) => document.getElementById('editorPart')?.appendChild(pane), phone);
	const panel = document.getElementById('panel');
	if (panel) phonePart('.ggs-terminal-keys', createTerminalKeys, (keys) => panel.appendChild(keys), phone);
	if (!phone) closeDrawer();
	// Settings on a phone is the phone's own page (settingsPage.ts), whichever entry asked —
	// the drawer's row, the palette, an extension's `workbench.action.openSettings`.
	installPhoneSettingsEntry(phone);
	// The full-screen side view's back gesture (§11.2): a swipe from the left edge returns
	// to the editor, the way every phone app's back navigation works. One binding for the
	// workbench's lifetime — the sidebar element itself persists across view switches.
	if (!swipeBackInstalled) {
		const sidebar = document.getElementById('sidebar');
		if (sidebar) {
			swipeBackInstalled = true;
			swipeBack(sidebar, () => {
				if (formFactor() === 'phone' && !sidebar.hidden) backToEditor();
			});
		}
	}
	// The page on <html>, for the few rules that differ per page (the terminal's key row
	// shows on the Terminal view only).
	if (!pageMarked) {
		pageMarked = true;
		const mark = () => {
			document.documentElement.dataset['phonePage'] = currentPage();
			const panelView = document.querySelector('#panel .panel-title.active') as HTMLElement | null;
			document.documentElement.dataset['panelView'] = panelView?.dataset['view'] ?? '';
		};
		mark();
		onWorkbenchChange(mark);
	}
}

let swipeBackInstalled = false;
let pageMarked = false;

/** Re-place the phone chrome for the current form factor (the replica's phone mode turning
 *  off — no form-factor change fires once the responsive watch has stopped). */
export function refreshPhoneChrome(): void {
	placePhoneChrome();
}

/** Wait for the workbench's first frame (the title bar is filled), then install. */
export function installRemoteShell(): void {
	registerCommands();
	installActionSheet();
	installLongPress(document);
	watchLifecycle();
	if (remoteEnv()) setDataSaver(dataSaverPreferred());
	const ready = () => {
		addSwitcherButton();
		placePhoneChrome();
	};
	const observer = new MutationObserver(() => {
		if (document.querySelector('#titlebar .titlebar-center')) {
			observer.disconnect();
			ready();
		}
	});
	if (document.querySelector('#titlebar .titlebar-center')) ready();
	else observer.observe(document.body, { childList: true, subtree: true });
	onFormFactorChange(() => placePhoneChrome());
	if (connectionLooksSlow() && !document.documentElement.hasAttribute('data-data-saver')) {
		notify('info', t('remote.dataSaver.suggest'), [{ label: t('remote.dataSaver.enable'), run: () => setDataSaver(true) }]);
	}
}
