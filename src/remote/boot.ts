// remote.html's entry. By default the page is a replica viewer (docs/ggs-remote-plan.md §22):
// connect, HELLO, ATTACH, then show the PC window's live DOM copy — the one real workbench
// runs on the PC, so a reload or a closed tab restarts nothing there. The page runs its own
// workbench instead (§9.2) when its UI cannot be the window's (§22.5, uiMode.ts): a phone
// watching a window the PC user has on screen gets the phone app while the PC keeps the
// desktop one, and `?frontend=1` asks for it outright. That mode boots exactly like the
// desktop workbench, after the Tauri seam has been pointed at the WebSocket — install the
// session and the internals stand-in, set the form factor, then load the very same
// `main.ts` the app runs.
import { Transport, basePathOf, instanceOf, type Notice } from './transport';
import { setRemoteEnv } from './session';
import { installInternals } from './tauriShim/internals';
import { initResponsive, formFactor } from './responsive';
import { installScopedStorage } from './storage';
import { dataSaverPreferred } from './dataSaver';
import { showBanner } from './banner';
import { installRemoteShell } from './shell';
import { isPhoneWidth, requestedMode, wantsOwnUi } from './mirror/uiMode';
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
	const request = requestedMode(location.search);
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
	// The window list arrives right behind HELLO_ACK, before ATTACHED: whether the PC user
	// has this window on screen is known by now (absent, the copy is the safe default).
	const pcVisible = transport.instances.find((info) => info.id === attached.instance)?.visible === true;
	if (!wantsOwnUi(request, isPhoneWidth(window.innerWidth), pcVisible)) {
		const { bootMirrorViewer } = await import('./mirror/viewerBoot');
		watchNotices(transport);
		bootMirrorViewer(transport, attached, basePath, request);
		return;
	}
	// The marker every shared module reads to take its remote-mode defaults (§10.3): the
	// open-size threshold below all, others as they grow one.
	document.documentElement.setAttribute('data-remote-shell', '');
	initResponsive();
	installInternals();
	watchNotices(transport);
	status('Loading Git Graph Studio…');
	await import('../main');
	installRemoteShell();
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
}

boot().catch((error) => {
	const splash = document.getElementById('boot-splash');
	splash?.replaceChildren(`The remote workbench failed to start: ${String(error)}`);
	throw error;
});
