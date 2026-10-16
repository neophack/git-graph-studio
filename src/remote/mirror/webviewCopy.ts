// The remote half of a webview stream (docs/ggs-remote-plan.md §22.6): in a remote page that
// runs its own workbench, an extension webview's pane — Claude Code's chat in its sidebar
// view or its editor tab — shows the desktop window's live page of it instead of a second
// page of its own. Every webview lives in the desktop window (ext_routing.rs): the copy is
// the very conversation the PC shows, laid out at this pane's size (the viewer's fluid
// mode), scrolled here, and every tap and key typed into it is replayed into the PC's page
// (webviewShare.ts) — asked on either side, the answer streams on both. The page it shows is
// the extension's own, composer included (2026-10-16, the owner's direction): nothing here
// builds a second chat UI around the copy.

import { showBanner } from '../banner';
import { remoteEnv } from '../session';
import { t, tf } from '../../platform/i18n';
import { noteCopyInteraction } from './copyInteraction';
import { HELLO_EVERY_MS, MIRROR_DOWN, MIRROR_UP, type DownMessage, type UpPayload } from './protocol';
import { MirrorViewer } from './viewer';
import { ViewerInput } from './viewerInput';

/** §9.2's follow hint: the pill names the stream's scroll owner while this end is not
 *  it, and clears itself when the 3-second lease lapses or the ownership comes home. */
export function mountScrollHint(host: HTMLElement, me: string): { receive(message: DownMessage): void; dispose(): void } {
	let hint: HTMLElement | null = null;
	let timer: ReturnType<typeof setTimeout> | null = null;
	const hide = () => {
		if (timer !== null) clearTimeout(timer);
		timer = null;
		hint?.remove();
		hint = null;
	};
	const show = (label: string, ms: number) => {
		if (!hint) {
			hint = host.ownerDocument.createElement('div');
			hint.className = 'scroll-follow-hint';
			host.appendChild(hint);
		}
		hint.textContent = tf('remote.scrollFollows', label);
		if (timer !== null) clearTimeout(timer);
		timer = setTimeout(hide, Math.max(ms, 1000));
	};
	const label = (name: string): string =>
		name.startsWith('phone') ? t('remote.device.phone')
		: name.startsWith('tablet') ? t('remote.device.tablet')
		: name === 'desktop' ? t('remote.device.desktop')
		: name;
	return {
		receive(message) {
			if (message.k !== 'own') return;
			if (message.who === me) {
				hide();
				return;
			}
			show(message.who === 'main' ? t('remote.device.pc') : label(message.name), message.ms);
		},
		dispose: hide
	};
}

/** Mount the live copy of `stream` (`view:<id>` / `panel:<ext>#<id>`) into a pane; the
 *  answer unmounts it. `extId` names the stream's extension (a view's stream id carries
 *  none) — the copy's input trail is noted under it, so a mirrored create or reveal the
 *  input causes (a "new session" tap) is known for this frontend's own act. */
export function mountWebviewCopy(container: HTMLElement, stream: string, extId?: string): () => void {
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
		// Real input — everything but the hello/bye/resnap housekeeping and a bare hover,
		// the same rule the PC's scroll ownership reads (§9.2): it may be the tap whose
		// replayed click on the PC opens a panel, so the mirrored create it causes can be
		// told apart from another frontend's act (copyInteraction.ts).
		if (extId && message.k !== 'hello' && message.k !== 'bye' && message.k !== 'resnap' && !(message.k === 'ptr' && message.ev === 'hover')) noteCopyInteraction(extId);
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
		onCaret: (point) => input?.caretAt(point),
		onClipboard: (text) => {
			if (!text) return;
			void navigator.clipboard?.writeText(text).then(() => showBanner('remote.mirror.copied', 2000)).catch(() => undefined);
		}
	});
	input = new ViewerInput(viewer, send, container.ownerDocument, { embedded: true, parent: host });
	const hint = mountScrollHint(host, from);
	const listener = transport.listen(MIRROR_DOWN, (event) => {
		const message = event.payload as DownMessage;
		if (message.k === 'own') {
			if (message.w === stream && (message.to === '*' || message.to === from)) hint.receive(message);
			return;
		}
		viewer.receive(message);
	});
	const hello = () => send({ k: 'hello', vw: host.clientWidth, vh: host.clientHeight, touch, device: document.documentElement.dataset['device'] });
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
		hint.dispose();
		input?.dispose();
		viewer.dispose();
		host.remove();
	};
}
