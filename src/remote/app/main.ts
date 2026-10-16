// The remote app's composition root (docs/remote-client-plan.md §3.1, K1): remote.html
// boots HERE, never through the desktop's src/main.ts. The two roots share the workbench
// core (the Workbench class and every view) but install different surroundings: this one
// points the Tauri seam at the WebSocket (boot.ts did that before loading us), installs
// the SESSION's hooks — not the desktop's mirror-host halves, whose folderOpen override
// used to land here through main.ts and bury the session's own — switches the command
// registry to the remote profile, and boots the same workbench main.ts boots.
//
// The mounts are remote.html's skeleton for now; A2's layouts pass their own containers
// (WorkbenchMounts) as the five form factors arrive.
import '@vscode/codicons/dist/codicon.css';
import '../../workbench/shell.css';

import { bootStage } from '../../platform/ipc/app';
import { commands } from '../../platform/commands';
import { initSettings, loadSettingsFile } from '../../platform/settings';
import { installCapabilities } from './capabilities';
import '../remote.css';
import './layouts/layouts.css';

// The webview's own right-click menu is the host browser's chrome — the remote page is a
// webview too, and its views serve their own menus.
document.addEventListener('contextmenu', (event) => event.preventDefault());

// The remote's theme and language ride the same settings seam, read over the wire (a
// read-only invoke; the session's own settings never write back, R0).
void loadSettingsFile().then(() => initSettings());

// This shell's command config and its capability stamp (§10.3).
commands.setActiveProfile('remote');
installCapabilities();

void bootStage('splash module ran', performance.now()).catch(() => undefined);
requestAnimationFrame(() => {
	void bootStage('splash painted', performance.now()).catch(() => undefined);
});

void import('../../workbench')
	.then(({ bootWorkbench }) => bootWorkbench())
	.catch((error) => {
		const splash = document.getElementById('boot-splash');
		splash?.replaceChildren(`The remote workbench failed to start: ${String(error)}`);
		throw error;
	});
