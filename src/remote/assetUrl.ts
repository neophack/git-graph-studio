// A package file's URL — the one helper the workbench uses instead of reading Tauri's
// internals itself (docs/ggs-remote-plan.md §15.4 rule 1; src/extHost.ts). Desktop: the real
// `convertFileSrc`; remote: the shim installed by boot.ts, which maps the `ggs` protocol onto
// the daemon's token-guarded path; neither (jsdom, probes): the bare scheme. No imports, so
// the desktop build pays nothing for it.
export function assetUrl(path: string, protocol = 'ggs'): string {
	const internals = (window as { __TAURI_INTERNALS__?: { convertFileSrc?: (path: string, protocol: string) => string } }).__TAURI_INTERNALS__;
	return internals?.convertFileSrc ? internals.convertFileSrc(path, protocol) : `${protocol}://localhost/${path}`;
}
