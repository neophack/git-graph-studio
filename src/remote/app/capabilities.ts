// The remote app's capability probe (docs/remote-client-plan.md §10.3): one place that
// answers "what can this browser do", consulted before a feature renders its entry —
// never a UA sniff (the one sanctioned exception, iOS's undetectable missing folder
// upload, lives in `uploadFolderSupported` and keys on the platform tell-tales).
// The answers are written to <html> as `data-cap-*` attributes at startup (CSS and the
// devtools can read them) and exported for JS.

export interface RemoteCapabilities {
	/** `CompressionStream('deflate-raw')` is native (the frame codec falls back to fflate
	 *  otherwise — §10.2 item 1). */
	nativeDeflate: boolean;
	/** CSS `height: 100dvh` (§10.2 item 4); the JS-maintained `--vvh` covers the rest. */
	dvh: boolean;
	/** `navigator.vibrate` — the long-press haptic, Android browsers only (§12.3). */
	vibrate: boolean;
	/** `document.startViewTransition` — the form-switch cross-fade, progressive (item 3). */
	viewTransitions: boolean;
	/** `navigator.clipboard.writeText` in a secure context (item 9); the fallback is
	 *  `execCommand('copy')`. */
	clipboardWrite: boolean;
	/** Notifications permission exists at all (item 10 — iOS serves only installed PWAs). */
	notifications: boolean;
	/** `matchMedia('(hover: hover)')` — hover-only affordances hide on touch (item 15). */
	hover: boolean;
	/** iOS / iPadOS Safari: the platform whose browser engines cannot upload folders
	 *  (`webkitdirectory` is unsupported and undetectable — the sanctioned platform
	 *  exception, §10.2 item 11). */
	ios: boolean;
}

/** iPadOS Safari masquerades as macOS; `maxTouchPoints` is the tell (§4.1). */
export function isIosPlatform(): boolean {
	const nav = navigator;
	const macTouch = nav.maxTouchPoints > 1 && /Mac/.test(nav.platform);
	return macTouch || /iPhone|iPad|iPod/.test(nav.platform) || (nav.userAgent.includes('Macintosh') && nav.maxTouchPoints > 1);
}

export function detectCapabilities(): RemoteCapabilities {
	const dvh = typeof CSS !== 'undefined' && CSS.supports !== undefined ? CSS.supports('height', '100dvh') : false;
	return {
		nativeDeflate: typeof CompressionStream === 'function' && typeof DecompressionStream === 'function',
		dvh,
		vibrate: typeof navigator.vibrate === 'function',
		viewTransitions: typeof document.startViewTransition === 'function',
		clipboardWrite: typeof navigator !== 'undefined' && navigator.clipboard !== undefined && window.isSecureContext,
		notifications: typeof Notification !== 'undefined',
		hover: typeof matchMedia === 'function' ? matchMedia('(hover: hover)').matches : false,
		ios: isIosPlatform()
	};
}

/** Probe once and stamp `<html data-cap-*>` (idempotent — the attributes answer for CSS
 *  and the returned object for JS). */
export function installCapabilities(): RemoteCapabilities {
	const caps = detectCapabilities();
	const root = document.documentElement;
	for (const [key, value] of Object.entries(caps)) {
		if (value) root.setAttribute(`data-cap-${key}`, '');
		else root.removeAttribute(`data-cap-${key}`);
	}
	return caps;
}

/** "Upload folder" renders only where the picker can honour `webkitdirectory` (iOS /
 *  iPadOS browsers cannot, and no feature probe exists — §10.2 item 11). */
export function uploadFolderSupported(caps: RemoteCapabilities): boolean {
	return !caps.ios;
}
