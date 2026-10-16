// Where the replica host finds an extension webview's live frame (docs/ggs-remote-plan.md
// §22.6). The desktop window's extension host registers the lookup at boot; the host
// (webviewShare.ts) loads only when a remote page asks for a stream. Kept apart so the
// desktop's first paint carries none of the replica code.

export interface WebviewFrameSource {
	/** The frame showing a stream (`view:<viewId>` / `panel:<extId>#<panelId>`), if mounted. */
	frameFor(stream: string): HTMLIFrameElement | null;
	/** Make the stream's page exist: a webview view nobody has shown yet resolves now. */
	ensure(stream: string): void;
	/** The extension that owns a stream's page (a view's owner; a panel carries it in its
	 *  key) — what decides whether a stream is a bridged extension's chat (chatBridge.ts). */
	extOf?(stream: string): string | null;
}

let source: WebviewFrameSource | null = null;

export function setWebviewFrameSource(next: WebviewFrameSource | null): void {
	source = next;
}

export function webviewFrameSource(): WebviewFrameSource | null {
	return source;
}

/** A stream key's parts: a view's id, or a panel's extension and id. */
export function parseStream(stream: string): { view: string } | { extId: string; panelId: number } | null {
	if (stream.startsWith('view:')) return { view: stream.slice(5) };
	if (!stream.startsWith('panel:')) return null;
	const rest = stream.slice(6);
	const hash = rest.lastIndexOf('#');
	const panelId = Number(rest.slice(hash + 1));
	if (hash <= 0 || !Number.isInteger(panelId)) return null;
	return { extId: rest.slice(0, hash), panelId };
}
