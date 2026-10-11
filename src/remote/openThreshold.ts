// The remote workbench's open-size defaults (docs/ggs-remote-plan.md §10.3): the shared
// editor suite asks this whether a file should open windowed — over the WebSocket every
// byte is metered, so the remote threshold sits a sixteenth of the desktop one. The
// `data-remote-shell` marker (boot.ts) is what makes a build remote; a `ggsr.windowedOpenBytes`
// value in the browser's storage overrides the number (the same knob shape Data Saver uses).
export function windowedEditThreshold(desktopBytes: number, remoteBytes = 512 * 1024): number {
	if (typeof document === 'undefined'
		|| !document.documentElement.hasAttribute('data-remote-shell')) {
		return desktopBytes;
	}
	try {
		const stored = Number(localStorage.getItem('ggsr.windowedOpenBytes'));
		if (Number.isFinite(stored) && stored >= 64 * 1024) return stored;
	} catch {
		/* storage unavailable */
	}
	return remoteBytes;
}
