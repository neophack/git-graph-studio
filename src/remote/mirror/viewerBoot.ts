// The remote page in replica mode (docs/ggs-remote-plan.md §22): connected and attached by
// boot.ts, it shows the PC window's live copy — nothing of the workbench runs in the
// browser. Hello on arrival and every few seconds (the PC forgets a silent viewer), bye on
// leaving; a reload is a new hello and a new snapshot, and the PC never restarts anything.
// The copy is the desktop window at its own desktop shell (docs/remote-client-plan.md §11:
// the phone-shell path is gone — a phone runs its own workbench); this mode is the explicit
// `?mirror=1`, and the bar's button leaves it for the own workbench on request.

import { showBanner } from '../banner';
import { setLocale, t } from '../../platform/i18n';
import type { Attached, Transport } from '../transport';
import { HELLO_EVERY_MS, MIRROR_DOWN, MIRROR_UP, type DownMessage, type UpPayload } from './protocol';
import { MirrorViewer } from './viewer';
import { ViewerInput } from './viewerInput';
import { modeUrl } from './uiMode';

// Deliberately not platform/ui/dom's `el`: this page runs no workbench (the comment
// above), and its call shape is the page's own — a text third argument, not a children
// array. One 6-line helper, kept local on purpose.
function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

/** The page's own viewport, zoomable: a phone pinches into the copy. */
function allowZoom(): void {
	const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
	meta?.setAttribute('content', 'width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content');
}

export function bootMirrorViewer(transport: Transport, attached: Attached, basePath: string): void {
	if (/zh/i.test(navigator.language)) setLocale('zh-cn');
	// The replica's own transfer surface (upload progress, outcome notices): the workbench's
	// toasts belong to a workbench this page never runs. Lazy — it drags transfer.ts.
	void import('./transferSink').then((sink) => sink.installMirrorTransferSink());
	allowZoom();
	document.documentElement.classList.add('mirror-mode');
	const stage = el('div', 'mirror-stage');
	stage.setAttribute('aria-label', t('remote.mirror.live'));
	document.body.appendChild(stage);
	const from = attached.frontendId;
	const touch = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
	const send = (message: UpPayload) => {
		transport.emit(MIRROR_UP, { ...message, from }, { kind: 'AnyLabel', label: 'main' });
	};
	// The page's real size, a raised soft keyboard included: the PC window follows it the way
	// a phone app's own viewport would (the phone shell lifts its editing row above the
	// keyboard), instead of the copy shrinking to fit.
	const hello = () => send({ k: 'hello', vw: stage.clientWidth || window.innerWidth, vh: stage.clientHeight || window.innerHeight, touch });
	const appBase = new URL(`${attached.assetBase}main/`, location.href).href;
	const ggsBase = new URL(attached.ggsBase, location.href).href;
	let input: ViewerInput | null = null;
	const viewer = new MirrorViewer(stage, from, {
		appBase,
		ggsBase,
		resnap: () => send({ k: 'resnap' }),
		onDocument: (doc) => input?.attach(doc),
		onCaret: (point) => input?.caretAt(point),
		onReady: () => document.getElementById('boot-splash')?.remove(),
		onClipboard: (text) => {
			if (!text) return;
			void navigator.clipboard?.writeText(text).then(() => showBanner('remote.mirror.copied', 2000)).catch(() => undefined);
		}
	});
	input = new ViewerInput(viewer, send, document);
	let leaving = false;
	const ownUi = () => {
		if (leaving) return;
		leaving = true;
		send({ k: 'bye' });
		location.replace(modeUrl(location.href, 'frontend'));
	};

	const bar = el('div', 'mirror-bar');
	const keyboard = el('button', 'mirror-bar-button', t('remote.mirror.keyboard'));
	keyboard.type = 'button';
	keyboard.addEventListener('click', () => input?.focusKeyboard());
	const own = el('button', 'mirror-bar-button', t('remote.mirror.ownUi'));
	own.type = 'button';
	own.title = t('remote.mirror.ownUiHint');
	own.addEventListener('click', ownUi);
	const windows = el('a', 'mirror-bar-button', t('remote.mirror.windows'));
	windows.href = new URL('windows', new URL(basePath, location.href)).href;
	bar.append(keyboard, own, windows);
	document.body.appendChild(bar);
	const status = document.querySelector('#boot-splash .boot-status');
	if (status) status.textContent = t('remote.mirror.waiting');

	transport.listen(MIRROR_DOWN, (event) => {
		const message = event.payload as DownMessage;
		viewer.receive(message);
	});
	hello();
	setInterval(hello, HELLO_EVERY_MS);
	let resizeTimer: ReturnType<typeof setTimeout> | null = null;
	window.addEventListener('resize', () => {
		if (resizeTimer !== null) clearTimeout(resizeTimer);
		resizeTimer = setTimeout(hello, 300);
	});
	window.addEventListener('online', hello);
	document.addEventListener('visibilitychange', () => {
		if (document.visibilityState === 'visible') hello();
	});
	window.addEventListener('pagehide', () => {
		if (!leaving) send({ k: 'bye' });
	});
}
