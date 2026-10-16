// The remote shell (docs/ggs-remote-plan.md §11, docs/remote-client-plan.md §5): what the
// remote workbench adds around the unchanged workbench core once it has booted — the remote
// vocabulary of commands (the window switcher, the transfers, the traffic readout, Data
// Saver), long-press menus as an action sheet, and the LAYOUT HOST: the five form factors'
// arrangements (remote/app/layouts/) that adopt the workbench frame's own elements plus the
// phone chrome (the app bar, the bottom navigation, the rail) inside one persistent frame
// root. Layout itself is CSS (remote.css + layouts.css), keyed on the markers responsive.ts
// and the host keep on <html>. The PC's own window installs the same shell while a phone
// watches it: what only a browser session can do — the window switcher, transfers, the
// traffic readout, Data Saver — stays with the browser.
import { commands } from '../platform/commands';
import { formatBytes, notify, quickPick } from '../platform/ui';
import { t, tf } from '../platform/i18n';
import { installActionSheet } from './actionSheet';
import { installLongPress, swipeBack } from './gestures';
import { installHasFallbacks } from './hasFallbacks';
import { backToEditor, currentPage, onWorkbenchChange } from './pages';
import { deviceOverride, onDeviceClassChange, setDeviceOverride, type DeviceOverride } from './responsive';
import { downloadTo, uploadInto } from '../features/explorer';
import { goWindowsPicker, openWindowSwitcher, watchLifecycle } from './windowSwitcher';
import { connectionLooksSlow, dataSaverPreferred, setDataSaver } from './dataSaver';
import { remoteEnv } from './session';
import { installPhoneSettingsEntry } from './settingsPage';
import { remoteHostStatus } from '../platform/ipc/remote';
import { modeUrl } from './mirror/uiMode';
import { pageStackOfClass } from './app/deviceClass';
import { installLayoutHost } from './app/layouts/host';
import { installFilesPage } from './app/files/filesPage';
import { installScmPage } from './app/scm/scmPage';
import { installTerminalFollow } from './terminalFollow';

async function firstFolder(): Promise<string | null> {
	try {
		const status = await remoteHostStatus();
		return status.folders?.[0] ?? null;
	} catch {
		return null;
	}
}

function registerCommands(): void {
	if (!remoteEnv()) return;
	// The remote shell's own vocabulary (§3.2): visible only in the remote profile — the
	// desktop app's palette and menus never list the browser's commands.
	const remoteOnly = { profiles: ['remote'] as const };
	commands.register({ ...remoteOnly, id: 'remote.switchWindow', title: t('remote.windows'), category: 'Remote', run: () => openWindowSwitcher() });
	// The picker page (the daemon's `/windows`): the button entry every form factor reaches —
	// the drawer's row and the switcher's last item ride it. Navigation only; the workbench
	// itself still never spawns (K4 — the picker page is the one spawn surface).
	commands.register({ ...remoteOnly, id: 'remote.windowsPage', title: t('remote.windowsPage'), category: 'Remote', run: () => goWindowsPicker() });
	// The PC window's own lifecycle, from the remote (§17): hide or show THIS window's
	// desktop half — the session stays attached either way (K12), and "close on the PC"
	// is exactly that, never the instance's exit.
	commands.register({
		...remoteOnly,
		id: 'remote.pcWindow.hide',
		title: t('remote.pcWindow.hide'),
		category: 'Remote',
		run: () => {
			const env = remoteEnv();
			env?.transport.displayInstance(env.attached.instance, false);
		}
	});
	commands.register({
		...remoteOnly,
		id: 'remote.pcWindow.show',
		title: t('remote.pcWindow.show'),
		category: 'Remote',
		run: () => {
			const env = remoteEnv();
			env?.transport.displayInstance(env.attached.instance, true);
		}
	});
	// Back from this page's own workbench to the PC window's live copy (§22.5), pinned so the
	// auto rule does not hand a phone straight back here while the PC shows the window.
	commands.register({ ...remoteOnly, id: 'remote.liveView', title: t('remote.liveView'), category: 'Remote', run: () => location.replace(modeUrl(location.href, 'mirror')) });
	commands.register({
		...remoteOnly,
		id: 'remote.uploadFiles',
		title: t('transfer.upload'),
		category: 'Remote',
		run: async () => {
			const dir = await firstFolder();
			if (!dir) return;
			await uploadInto(dir, false);
		}
	});
	commands.register({
		...remoteOnly,
		id: 'remote.uploadFolder',
		title: t('transfer.uploadFolder'),
		category: 'Remote',
		run: async () => {
			const dir = await firstFolder();
			if (!dir) return;
			await uploadInto(dir, true);
		}
	});
	commands.register({
		...remoteOnly,
		id: 'remote.download',
		title: t('transfer.download'),
		category: 'Remote',
		run: async () => {
			const active = document.querySelector('.tab.active')?.getAttribute('title') ?? (await firstFolder());
			if (!active) return;
			await downloadTo(active);
		}
	});
	commands.register({ ...remoteOnly, id: 'remote.toggleDataSaver', title: t('setting.remote.dataSaver'), category: 'Remote', run: () => setDataSaver(!document.documentElement.hasAttribute('data-data-saver')) });
	// The layout override (§4.2's 设备级设置 "布局"): the entry every form factor reaches —
	// the phone Settings page serves the page-stack shells, the palette serves them all
	// (a desktop-form browser cannot open the phone page, and tablet mode is its offer).
	commands.register({
		...remoteOnly,
		id: 'remote.layoutMode',
		title: t('remote.layout.pick'),
		category: 'Remote',
		run: async () => {
			const current: DeviceOverride | 'auto' = deviceOverride() ?? 'auto';
			const entries: { value: string; label: string }[] = [
				{ value: 'auto', label: t('remote.layout.auto') },
				{ value: 'phone', label: t('remote.layout.phone') },
				{ value: 'tablet', label: t('remote.layout.tablet') },
				{ value: 'desktop', label: t('remote.layout.desktop') }
			];
			const pick = await quickPick(
				entries.map((entry) => ({ label: entry.label, description: entry.value === current ? t('remote.layout.current') : undefined, value: entry.value })),
				t('remote.layout')
			);
			if (pick === null) return;
			setDeviceOverride(pick === 'phone' || pick === 'tablet' || pick === 'desktop' ? pick : null);
		}
	});
	commands.register({
		...remoteOnly,
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

/** The one-time installs that outlive every layout: the files page and the phone Source
 *  Control page (the page-stack shells' Files and Changes destinations), the page-stack
 *  back gesture (the side bar element persists across arrangements), the settings entry's
 *  routing, and the page marks the CSS reads. */
function installOnce(): void {
	installFilesPage();
	installScmPage();
	installTerminalFollow();
	if (!swipeBackInstalled) {
		const sidebar = document.getElementById('sidebar');
		if (sidebar) {
			swipeBackInstalled = true;
			swipeBack(sidebar, () => {
				if (document.documentElement.hasAttribute('data-page-stack') && !sidebar.hidden) backToEditor();
			});
		}
	}
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
	// Settings on a page-stack shell is the phone's own page (settingsPage.ts), whichever
	// entry asked — the drawer's row, the palette, an extension's openSettings. The routing
	// follows the form: every device-class change re-points it.
	installPhoneSettingsEntry(document.documentElement.hasAttribute('data-page-stack'));
	onDeviceClassChange((device) => installPhoneSettingsEntry(pageStackOfClass(device)));
}

let swipeBackInstalled = false;
let pageMarked = false;

/** Wait for the workbench's first frame (the title bar is filled), then install: the layout
 *  host adopts the frame from wherever the settled device class says this viewport is. */
export function installRemoteShell(): void {
	registerCommands();
	installActionSheet();
	installLongPress(document);
	installHasFallbacks();
	watchLifecycle();
	if (remoteEnv()) setDataSaver(dataSaverPreferred());
	const ready = () => {
		addSwitcherButton();
		installOnce();
		installLayoutHost();
	};
	const observer = new MutationObserver(() => {
		if (document.querySelector('#titlebar .titlebar-center')) {
			observer.disconnect();
			ready();
		}
	});
	if (document.querySelector('#titlebar .titlebar-center')) ready();
	else observer.observe(document.body, { childList: true, subtree: true });
	if (connectionLooksSlow() && !document.documentElement.hasAttribute('data-data-saver')) {
		notify('info', t('remote.dataSaver.suggest'), [{ label: t('remote.dataSaver.enable'), run: () => setDataSaver(true) }]);
	}
}
