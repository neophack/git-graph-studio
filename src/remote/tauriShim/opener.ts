// `@tauri-apps/plugin-opener` for the remote workbench (§9.3): URLs open in a new tab, a PC
// path downloads to this device, "reveal" opens the remote file picker at the item.
import { download } from '../transfer';
import { pickRemotePath } from '../remoteFilePicker';

export async function openUrl(url: string | URL): Promise<void> {
	window.open(String(url), '_blank', 'noopener');
}

export async function openPath(path: string): Promise<void> {
	await download(path);
}

export async function revealItemInDir(path: string | string[]): Promise<void> {
	const first = Array.isArray(path) ? path[0] : path;
	if (first) await pickRemotePath({ defaultPath: first });
}
