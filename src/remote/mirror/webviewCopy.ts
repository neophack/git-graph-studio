// The remote half of a webview stream (docs/ggs-remote-plan.md §22.6): in a remote page that
// runs its own workbench, an extension webview's pane — Claude Code's chat in its sidebar
// view or its editor tab — shows the desktop window's live page of it instead of a second
// page of its own. Every webview lives in the desktop window (ext_routing.rs): the copy is
// the very conversation the PC shows, laid out at this pane's size (the viewer's fluid
// mode), scrolled here, and every tap and key typed into it is replayed into the PC's page
// (webviewShare.ts) — asked on either side, the answer streams on both.

import { showBanner } from '../banner';
import { remoteEnv } from '../session';
import { HELLO_EVERY_MS, MIRROR_DOWN, MIRROR_UP, type DownMessage, type UpPayload } from './protocol';
import { MirrorViewer } from './viewer';
import { ViewerInput } from './viewerInput';

/** Mount the live copy of `stream` (`view:<id>` / `panel:<ext>#<id>`) into a pane; the
 *  answer unmounts it. */
export function mountWebviewCopy(container: HTMLElement, stream: string): () => void {
	const env = remoteEnv();
	if (!env) return () => undefined;
	const { transport, attached } = env;
	const from = attached.frontendId;
	const host = container.ownerDocument.createElement('div');
	host.className = 'webview-copy';
	container.appendChild(host);
	const touch = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
	const send = (message: UpPayload) => {
		transport.emit(MIRROR_UP, { ...message, from, w: stream }, { kind: 'AnyLabel', label: 'main' });
	};
	let input: ViewerInput | null = null;
	const viewer = new MirrorViewer(host, from, {
		appBase: new URL(`${attached.assetBase}main/`, location.href).href,
		ggsBase: new URL(attached.ggsBase, location.href).href,
		stream,
		fluid: true,
		resnap: () => send({ k: 'resnap' }),
		onScroll: (id, fraction, end) => send({ k: 'scroll', i: id, f: fraction, e: end ? 1 : undefined }),
		onDocument: (doc) => input?.attach(doc),
		onClipboard: (text) => {
			if (!text) return;
			void navigator.clipboard?.writeText(text).then(() => showBanner('remote.mirror.copied', 2000)).catch(() => undefined);
		}
	});
	input = new ViewerInput(viewer, send, container.ownerDocument, { embedded: true, parent: host });
	const listener = transport.listen(MIRROR_DOWN, (event) => viewer.receive(event.payload as DownMessage));
	const hello = () => send({ k: 'hello', vw: host.clientWidth, vh: host.clientHeight, touch });
	hello();
	const timer = setInterval(hello, HELLO_EVERY_MS);
	const onVisible = () => {
		if (document.visibilityState === 'visible') hello();
	};
	document.addEventListener('visibilitychange', onVisible);
	return () => {
		clearInterval(timer);
		document.removeEventListener('visibilitychange', onVisible);
		transport.unlisten(listener);
		send({ k: 'bye' });
		input?.dispose();
		viewer.dispose();
		host.remove();
	};
}
