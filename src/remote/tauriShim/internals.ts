// The `window.__TAURI_INTERNALS__` stand-in (§9.3, §15.4 rule 1): the few internals a
// module reaches without the API package — `convertFileSrc`, `invoke`, `transformCallback`
// and `metadata` — answered by the remote transport. Installed by boot.ts before the
// workbench loads; outside src/remote/ nothing names the internals object.
import { convertFileSrc, invoke, transformCallback } from './core';

export function installInternals(): void {
	(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
		convertFileSrc,
		invoke,
		transformCallback,
		metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } }
	};
}

export { assetUrl } from '../assetUrl';
