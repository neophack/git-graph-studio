// The boot entry. It stays tiny on purpose: the workbench pulls in CodeMirror, xterm and the
// graph host, and that module graph is a large chunk to download and parse - so it is loaded
// asynchronously after the styles and the boot splash have painted, and the splash is dropped
// once the workbench's first frame is up. The window is never a blank dark rectangle.

import '@vscode/codicons/dist/codicon.css';
import './workbench/shell.css';
import { bootStage } from './platform/ipc/app';
import { initSettings, loadSettingsFile } from './platform/settings';
import { installDesktopRemoteHooks } from './remote/desktopHooks';

// The webview's own right-click menu is the host browser's chrome (back/refresh/save
// as/print/inspect) - never something this desktop app wants surfaced. Views that offer
// their own context menu already call preventDefault() on their own 'contextmenu' handler;
// this is the catch-all for everywhere else. Devtools stay reachable from the Help menu.
document.addEventListener('contextmenu', (event) => event.preventDefault());

// The persisted theme (and display language) take effect before the shell loads, so the
// window never flashes the default theme at the user. A hand-edited ~/.ggs/settings.json
// wins over the stored settings (M3 3.9) - one read before the theme applies.
void loadSettingsFile().then(() => initSettings());

// The desktop's own remote-shaped halves (the mirror host, the asset protocol, the
// workbench sync) install before the workbench loads — the composition root's wiring.
installDesktopRemoteHooks();

// Boot timing: report when the splash first paints, so the log shows how long the window
// spent dark between process start and the first frame (the Rust side prints both stamps).
void bootStage('splash module ran', performance.now()).catch((e) => console.error('boot_stage failed:', e));
requestAnimationFrame(() => {
	void bootStage('splash painted', performance.now()).catch(() => undefined);
});


void import('./workbench/workbench')
	.then(({ bootWorkbench }) => bootWorkbench())
	.catch((error) => {
		const splash = document.getElementById('boot-splash');
		// Even on failure the user should see more than a black window.
		splash?.replaceChildren(`The workbench failed to start: ${String(error)}`);
		throw error;
	});
