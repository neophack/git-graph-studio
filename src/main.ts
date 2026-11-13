// The boot entry. It stays tiny on purpose: the workbench pulls in CodeMirror, xterm and the
// graph host, and that module graph is a large chunk to download and parse - so it is loaded
// asynchronously after the styles and the boot splash have painted, and the splash is dropped
// once the workbench's first frame is up. The window is never a blank dark rectangle.

import '@vscode/codicons/dist/codicon.css';
import './workbench/shell.css';
import { bootStage, webviewBeat } from './platform/ipc/app';
import { installGlobalContextMenu } from './platform/ui/globalContextMenu';
import { initSettings, loadSettingsFile } from './platform/settings';
import { installDesktopRemoteHooks } from './remote/desktopHooks';
import { installDeviceShell, primeDeviceShell } from './remote/deviceShell';
import { tauriBridgePresent } from './remote/assetUrl';

// The webview's own right-click menu is the host browser's chrome (back/refresh/save
// as/print/inspect) - never something this desktop app wants surfaced. Views that offer
// their own context menu already call preventDefault() on their own 'contextmenu' handler
// and keep it; everywhere else the fallback menu answers — Copy over whatever is selected
// (notifications, dialogs, tooltips, the Output view, previews), Paste into a focused
// field, Select All — so selectable text is copyable on every page, popups included.
// Devtools stay reachable from the Help menu.
installGlobalContextMenu(document);

// The backend's liveness probe hook (window.rs's sweep): the Rust side evals a probe here
// every ~20 s and the page answers through `webview_beat` — two consecutive silent probes
// mean the renderer died or the JS thread is hung, and the backend reloads the window (a
// crashed WebView2 renderer is a gray rectangle forever; wry does not watch for it). Named
// on `window` because the probe script reaches for it by name, and installed before the
// workbench loads so the earliest probes already land. The probe script itself falls back
// to Tauri's injected IPC bridge, so pages without this hook answer too.
declare global {
	interface Window {
		__ggsAliveProbe?: () => void;
	}
}
window.__ggsAliveProbe = () => { void webviewBeat().catch(() => undefined); };

// Tauri injects the IPC bridge before any page script runs; its absence means a plain
// browser opened the dev server's root - the workbench is the desktop window's content
// and has no backend to boot against there. The splash states the two doors that do work
// (the real backend under `tauri dev`, the harness's scripted one) instead of the boot
// dying mid-flight on the first invoke with an uncaught error. (The bridge check rides
// the one helper the seam allows to read Tauri's internals.)
if (!tauriBridgePresent()) {
	const status = document.querySelector('#boot-splash .boot-status');
	if (status) status.textContent = 'The workbench needs the desktop backend - run "npx tauri dev", or open /dev/dev-harness.html for the scripted harness.';
} else {
	// The persisted theme (and display language) take effect before the shell loads, so the
	// window never flashes the default theme at the user. A hand-edited ~/.ggs/settings.json
	// wins over the stored settings (M3 3.9) - one read before the theme applies. The
	// workbench loads AFTER the settings apply: its menus and views build their labels at
	// construction, and a shell that won the race against this read would carry the
	// boot-default English until the next settings change.
	loadSettingsFile()
		.then(() => initSettings())
		// The device mode's markers and shell CSS land before the workbench chunk, so a
		// forced form's first paint is already that form (a no-op while the mode is Auto).
		.then(() => primeDeviceShell())
		.then(() => import('./workbench'))
		.then(({ bootWorkbench }) => bootWorkbench())
		// The phone/tablet layouts adopt the workbench's own elements — installed once the
		// shell's first frame is up (a no-op while the mode is Auto).
		.then(() => installDeviceShell())
		.catch((error) => {
			const splash = document.getElementById('boot-splash');
			// Even on failure the user should see more than a black window.
			splash?.replaceChildren(`The workbench failed to start: ${String(error)}`);
			throw error;
		});

	// The desktop's own remote-shaped halves (the mirror host, the asset protocol, the
	// workbench sync) install before the workbench loads — the composition root's wiring.
	installDesktopRemoteHooks();

	// Boot timing: report when the splash first paints, so the log shows how long the window
	// spent dark between process start and the first frame (the Rust side prints both stamps).
	void bootStage('splash module ran', performance.now()).catch((e) => console.error('boot_stage failed:', e));
	requestAnimationFrame(() => {
		void bootStage('splash painted', performance.now()).catch(() => undefined);
	});
}
