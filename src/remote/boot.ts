// remote.html's entry (docs/ggs-remote-plan.md §9.2): the remote workbench boots exactly
// like the desktop one, after the Tauri seam has been pointed at the WebSocket — connect,
// HELLO, ATTACH, install the session and the internals stand-in, set the form factor, then
// load the very same `main.ts` the app runs.
import { Transport, basePathOf, instanceOf, type Notice } from './transport';
import { setRemoteEnv } from './session';
import { installInternals } from './tauriShim/internals';
import { initResponsive, formFactor } from './responsive';
import { installScopedStorage } from './storage';
import { dataSaverPreferred } from './dataSaver';
import { showBanner } from './banner';
import { installRemoteShell } from './shell';
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
	// The marker every shared module reads to take its remote-mode defaults (§10.3): the
	// open-size threshold below all, others as they grow one.
	document.documentElement.setAttribute('data-remote-shell', '');
	initResponsive();
	const manifest = document.createElement('link');
	manifest.rel = 'manifest';
	manifest.href = new URL('manifest.webmanifest', new URL(basePath, location.href)).href;
	document.head.appendChild(manifest);
	status('Connecting…');
	const transport = new Transport({ basePath, instance, formFactor: formFactor(), dataSaver: dataSaverPreferred() });
	const attached = await transport.connect();
	setRemoteEnv({ transport, attached, basePath });
	installInternals();
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
	if ('serviceWorker' in navigator && window.isSecureContext) {
		void navigator.serviceWorker.register(new URL('sw.js', new URL(basePath, location.href)).href, { scope: basePath }).catch(() => undefined);
	}
	status('Loading Git Graph Studio…');
	await import('../main');
	installRemoteShell();
}

boot().catch((error) => {
	const splash = document.getElementById('boot-splash');
	splash?.replaceChildren(`The remote workbench failed to start: ${String(error)}`);
	throw error;
});
