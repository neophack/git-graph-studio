// Open Folder in a browser session (docs/remote-ui-redesign-plan.md §P0): the folder is
// chosen on the PC (folderBrowser.ts over the daemon's `api/browse`) and opened in a PC
// window — the one already showing it is entered, otherwise the daemon SPAWNs one, which
// the window switcher's lifecycle watch enters the moment it registers. A session's own
// `open_folder` stays refused (pathGate.ts): this window's roots are the session's file
// boundary, and widening it is the SPAWN's business, sandbox rules included.
import { notify } from '../platform/ui';
import { t } from '../platform/i18n';
import { remoteEnv } from './session';
import { browseFolders, daemonFolderSource } from './folderBrowser';
import { enterInstance } from './windowSwitcher';

function pathKey(path: string): string {
	const slashed = path.replace(/\\/g, '/').replace(/\/+$/, '');
	return /^[a-zA-Z]:/.test(slashed) ? slashed.toLowerCase() : slashed;
}

/** Browse the PC and open the chosen folder in a PC window. */
export async function openFolderOnPc(): Promise<void> {
	const env = remoteEnv();
	if (!env) return;
	const transport = env.transport;
	const folder = await browseFolders(daemonFolderSource(env.basePath), { recent: transport.recentFolders });
	if (!folder) return;
	await openFolderPathOnPc(folder);
}

/** Open a known PC folder: enter the window showing it, or spawn one. */
export async function openFolderPathOnPc(folder: string): Promise<void> {
	const env = remoteEnv();
	if (!env) return;
	const transport = env.transport;
	const key = pathKey(folder);
	const showing = transport.instances.find((info) => info.folders.some((f) => pathKey(f) === key));
	if (showing?.id === env.attached.instance) {
		notify('info', t('remote.folders.alreadyHere'));
		return;
	}
	if (showing) {
		enterInstance(showing);
		return;
	}
	transport.spawn(folder, false);
}
