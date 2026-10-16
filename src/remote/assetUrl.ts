// A package file's URL — the one helper the workbench uses instead of reading Tauri's
// internals itself (docs/ggs-remote-plan.md §15.4 rule 1; src/extHost.ts). Desktop: the real
// `convertFileSrc`; remote: the shim installed by boot.ts, which maps the `ggs` protocol onto
// the daemon's token-guarded path; neither (jsdom, probes): the bare scheme. No imports, so
// the desktop build pays nothing for it.
export function assetUrl(path: string, protocol = 'ggs'): string {
	const internals = (window as { __TAURI_INTERNALS__?: { convertFileSrc?: (path: string, protocol: string) => string } }).__TAURI_INTERNALS__;
	return internals?.convertFileSrc ? internals.convertFileSrc(path, protocol) : `${protocol}://localhost/${path}`;
}

/** Whether Tauri's IPC bridge is present — true only in the desktop window. The boot entry's
 *  plain-browser guard asks this (main.ts) rather than reading the internals itself: the
 *  internals object is touched only through this file (and the remote shims). */
export function tauriBridgePresent(): boolean {
	return Boolean((window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
}
