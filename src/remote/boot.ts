// remote.html's entry (docs/remote-client-plan.md §3.1). The page ALWAYS runs the remote
// app — its own composition root (src/remote/app/main.ts) over the WebSocket-pointed
// Tauri seam — with the device-class layouts of §5 to come; the PC window's live DOM copy
// (the replica, ggs-remote-plan.md §22) is no longer the default anyone lands in, but an
// explicit one: `?mirror=1` (the remote.liveView command) still boots it, and a reload or
// a closed tab restarts nothing on the PC either way.
import { Transport, basePathOf, instanceOf, type Notice } from './transport';
import { setRemoteEnv } from './session';
import { installInternals } from './tauriShim/internals';
import { initResponsive, formFactor } from './responsive';
import { installScopedStorage } from './storage';
import { dataSaverPreferred } from './dataSaver';
import { showBanner } from './banner';
import { installRemoteShell } from './shell';
import { installRemoteSessionHooks } from './desktopHooks';
import { currentPresence } from './presence';
import { requestedMode } from './mirror/uiMode';
import './remote.css';

function status(text: string): void {
	const line = document.querySelector('#boot-splash .boot-status');
	if (line) line.textContent = text;
}

async function boot(): Promise<void> {
	const basePath = basePathOf(location.pathname);
	const instance = instanceOf(location.pathname);
	if (!instance) {
		location.replace(new URL('windows', new URL(basePath, location.href)).href);
		return;
	}
	// Through a Hub every PC shares one origin: this PC's storage keys get its own prefix
	// before any module reads them (§20.6.1).
	installScopedStorage(basePath);
	const manifest = document.createElement('link');
	manifest.rel = 'manifest';
	manifest.href = new URL('manifest.webmanifest', new URL(basePath, location.href)).href;
	document.head.appendChild(manifest);
	status('Connecting…');
	const transport = new Transport({
		basePath,
		instance,
		formFactor: formFactor(),
		dataSaver: dataSaverPreferred(),
		// A dropped link must not look like a frozen workbench: say so while the retry loop
		// runs, greet the return, and let the notices (relay restarted, PC reconnecting)
		// refine the story when they know more.
		onOffline: () => showBanner('remote.banner.offline', 0),
		onOnline: () => showBanner('remote.banner.reconnected', 4000)
	});
	const attached = await transport.connect();
	setRemoteEnv({ transport, attached, basePath });
	if ('serviceWorker' in navigator && window.isSecureContext) {
		void navigator.serviceWorker.register(new URL('sw.js', new URL(basePath, location.href)).href, { scope: basePath }).catch(() => undefined);
	}
	// The replica is the explicit mode now (`?mirror=1`, the remote.liveView command): the
	// PC window's live DOM copy, booted for whoever asked for it by name.
	if (requestedMode(location.search) === 'mirror') {
		const { bootMirrorViewer } = await import('./mirror/viewerBoot');
		watchNotices(transport);
		bootMirrorViewer(transport, attached, basePath);
		return;
	}
	// The marker every shared module reads to take its remote-mode defaults (§10.3): the
	// open-size threshold below all, others as they grow one.
	document.documentElement.setAttribute('data-remote-shell', '');
	initResponsive();
	installInternals();
	watchNotices(transport);
	// The shared modules' remote hooks install before the workbench loads (the session
	// first of all — everything else may read it).
	installRemoteSessionHooks();
	// The daemon's `visible` word is the authoritative source for whether the PC window
	// is active (§7.0.1): every WINDOWS frame feeds it into the sync's presence table,
	// overriding whatever stale announcement it holds.
	transport.onWindows((list) => {
		const info = list.find((entry) => entry.id === instance);
		if (info) currentPresence()?.noteExternal('main', info.visible && !info.minimized);
	});
	status('Loading Git Graph Studio…');
	await import('./app/main');
	installRemoteShell();
	// The table exists now (the workbench's sync created it): the WINDOWS frame that
	// arrived before it lands too — the first word about the PC window is not missed.
	const first = transport.instances.find((entry) => entry.id === instance);
	if (first) currentPresence()?.noteExternal('main', first.visible && !first.minimized);
}

function watchNotices(transport: Transport): void {
	transport.onNotice((notice: Notice) => {
		switch (notice.kind) {
			case 'relay-restarted':
				showBanner('remote.banner.relayRestarted', 4000);
				break;
			case 'version-changed':
				showBanner('remote.banner.versionChanged', 0, () => location.reload());
				break;
			case 'pc-reconnecting':
				showBanner('remote.banner.pcReconnecting', 0);
				break;
			case 'overflow':
				showBanner('remote.banner.overflow', 4000);
				break;
		}
	});
	document.addEventListener('visibilitychange', () => transport.onVisibility(document.visibilityState === 'visible'));
	window.addEventListener('online', () => transport.onVisibility(true));
	// A return from the back/forward cache restores the page without a visibility flip
	// (§10.2 item 13): the socket the cache froze is long dead — greet it like a comeback.
	window.addEventListener('pageshow', (event) => {
		if ((event as PageTransitionEvent).persisted) transport.onVisibility(true);
	});
}

boot().catch((error) => {
	const splash = document.getElementById('boot-splash');
	splash?.replaceChildren(`The remote workbench failed to start: ${String(error)}`);
	throw error;
});
