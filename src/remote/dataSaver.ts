// Data Saver (docs/ggs-remote-plan.md §10.4): on a slow or metered connection the remote
// workbench trades refresh rate and decoration for bytes — the minimap, sticky scroll and
// remote images off, the watcher and terminal batched coarser (the Relay's side). The
// browser's own hint (`saveData`, a 2g/3g effective type) suggests turning it on.
interface NetworkInformationLike {
	saveData?: boolean;
	effectiveType?: string;
}

export function connectionLooksSlow(connection: NetworkInformationLike | undefined = (navigator as { connection?: NetworkInformationLike }).connection): boolean {
	if (!connection) return false;
	return connection.saveData === true || ['slow-2g', '2g', '3g'].includes(connection.effectiveType ?? '');
}

const KEY = 'ggsr.dataSaver';

export function dataSaverPreferred(): boolean {
	try {
		const stored = localStorage.getItem(KEY);
		if (stored !== null) return stored === '1';
	} catch {
		/* storage unavailable */
	}
	return connectionLooksSlow();
}

export function setDataSaver(on: boolean): void {
	try {
		localStorage.setItem(KEY, on ? '1' : '0');
	} catch {
		/* storage unavailable */
	}
	document.documentElement.toggleAttribute('data-data-saver', on);
}
