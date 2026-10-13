// The replica's input layer in the browser: what the viewer does on the copy becomes
// messages the PC replays (replay.ts). The copy itself never takes focus or edits —
// presses are swallowed, keys and text are read off one hidden text field (the "proxy"),
// which is also what a phone's soft keyboard types into: a tap on something editable
// focuses it inside the tap's own gesture, the only moment a mobile browser raises the
// keyboard. Touch has its own grammar: a tap is a click, a one-finger drag scrolls the
// PC (replayed as wheel deltas), a long press opens the context menu, two fingers are the
// browser's own pinch-zoom.
//
// Embedded in a remote workbench (a webview stream's fluid copy, webviewCopy.ts) the layer
// is a guest: it takes no focus until the copy is touched, scrolling stays the copy's own
// (wheel and drag scroll it natively), and the keys typed for the PC do not also reach the
// workbench's keybindings.

import { modsOf, type Spot, type UpPayload } from './protocol';
import type { MirrorViewer } from './viewer';

const TAP_SLOP = 8;
const LONG_PRESS_MS = 550;
const DOUBLE_TAP_MS = 320;
/** Mouse events this soon after a touch are the browser's compatibility copies. */
const TOUCH_ECHO_MS = 800;
const MOVE_EVERY_MS = 33;

type Send = (message: UpPayload) => void;

export interface ViewerInputOptions {
	/** A guest inside a remote workbench (see the file comment). */
	embedded?: boolean;
	/** Where the keyboard proxy lives (default: the page's body). */
	parent?: HTMLElement;
}

const EDITABLE = 'input, textarea, [contenteditable]:not([contenteditable="false"]), .cm-content, .xterm';

function editableAt(el: Element | null): boolean {
	if (!el) return false;
	const hit = el.closest(EDITABLE);
	if (!hit) return false;
	if (hit.nodeName === 'INPUT') return !['button', 'checkbox', 'radio', 'range', 'file', 'submit', 'reset', 'color', 'image'].includes((hit as HTMLInputElement).type);
	return true;
}

/** A special key travels as a key; plain characters travel as text (so keyboard layouts
 *  and IMEs compose them here, not on the PC). */
export function isSpecialKey(event: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }): boolean {
	if (event.key === 'Process' || event.key === 'Unidentified' || event.key === 'Dead') return false;
	if (event.key.length > 1) return !['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(event.key);
	// Alt with a character is how some layouts type it — AltGr arrives as Ctrl+Alt on
	// Windows: that stays text.
	if (event.ctrlKey && event.altKey) return false;
	return event.ctrlKey || event.metaKey;
}

export class ViewerInput {
	private readonly proxy: HTMLTextAreaElement;
	private lastTouch = 0;
	private touch: { x: number; y: number; lastX: number; lastY: number; spot: Spot; target: Element; moved: boolean; long: boolean; timer: ReturnType<typeof setTimeout> | null } | null = null;
	private lastTap: { at: number; x: number; y: number } | null = null;
	private lastMove = 0;
	private pendingMove: (() => void) | null = null;
	private moveTimer: ReturnType<typeof setTimeout> | null = null;
	private wheelAcc: { spot: Spot; dx: number; dy: number; m: number } | null = null;
	private wheelTimer: ReturnType<typeof setTimeout> | null = null;
	private hoverId: number | undefined;
	private composing = false;
	private readonly coarse: boolean;
	private readonly embedded: boolean;

	constructor(
		private readonly viewer: MirrorViewer,
		private readonly send: Send,
		page: Document,
		options: ViewerInputOptions = {}
	) {
		this.embedded = options.embedded === true;
		this.coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
		const proxy = page.createElement('textarea');
		proxy.className = 'mirror-proxy';
		proxy.setAttribute('autocapitalize', 'off');
		proxy.setAttribute('autocomplete', 'off');
		proxy.setAttribute('autocorrect', 'off');
		proxy.setAttribute('spellcheck', 'false');
		proxy.setAttribute('aria-hidden', 'true');
		(options.parent ?? page.body).appendChild(proxy);
		this.proxy = proxy;
		this.wireProxy();
		if (!this.coarse && !this.embedded) proxy.focus({ preventScroll: true });
	}

	dispose(): void {
		this.cancelTouch();
		this.proxy.remove();
	}

	/** Raise the keyboard (the toolbar's keyboard button; a tap on an editable). */
	focusKeyboard(): void {
		this.proxy.focus({ preventScroll: true });
	}

	/** The mirrored caret moved (the viewer's `onCaret`): the proxy rides its position, so
	 *  an IME's candidate window anchors where the typing is — the hidden corner the proxy
	 *  otherwise sits in would decide it, and the candidates would never follow the input
	 *  (2026-10-13). `null` sends it back to its corner. */
	caretAt(point: { x: number; y: number; h: number } | null): void {
		const style = this.proxy.style;
		if (!point) {
			style.left = '';
			style.top = '';
			style.bottom = '';
			style.height = '';
			return;
		}
		style.left = `${Math.round(point.x)}px`;
		style.top = `${Math.round(point.y)}px`;
		style.bottom = 'auto';
		style.height = `${Math.max(18, Math.round(point.h))}px`;
	}

	private spot(event: { clientX: number; clientY: number; target: EventTarget | null }, doc: Document): Spot | null {
		let el: Node | null = event.target as Node | null;
		while (el && (el.nodeType !== 1 || this.viewer.idOf(el) === undefined)) el = el.parentNode;
		if (!el) return null;
		const target = el as Element;
		const id = this.viewer.idOf(target)!;
		const rect = target.getBoundingClientRect();
		const spot: Spot = {
			i: id,
			fx: rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0.5,
			fy: rect.height > 0 ? (event.clientY - rect.top) / rect.height : 0.5
		};
		const caret = (doc as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null }).caretRangeFromPoint?.(event.clientX, event.clientY);
		const container = caret?.startContainer;
		if (container && container.nodeType === 3) {
			const ci = this.viewer.idOf(container);
			if (ci !== undefined) {
				spot.ci = ci;
				spot.co = caret!.startOffset;
			}
		}
		return spot;
	}

	/** Hook a document of the copy (the root, and every frame's document). */
	attach(doc: Document): void {
		const opts = { capture: true, passive: false } as const;
		const echo = () => Date.now() - this.lastTouch < TOUCH_ECHO_MS;
		doc.addEventListener('mousedown', (event) => {
			const target = event.target as Element | null;
			if (target?.closest?.('select')) return;
			event.preventDefault();
			if (echo()) return;
			const spot = this.spot(event, doc);
			if (spot) this.send({ k: 'ptr', ev: 'down', b: event.button, m: modsOf(event), d: event.detail, ...spot });
			if (!this.coarse) this.proxy.focus({ preventScroll: true });
		}, opts);
		doc.addEventListener('mousemove', (event) => {
			if (echo()) return;
			if (event.buttons === 0) return;
			this.throttleMove(() => {
				const spot = this.spot(event, doc);
				if (spot) this.send({ k: 'ptr', ev: 'move', b: 0, m: modsOf(event), d: 0, ...spot });
			});
		}, opts);
		doc.addEventListener('mouseover', (event) => {
			if (echo() || event.buttons !== 0) return;
			const spot = this.spot(event, doc);
			if (!spot || spot.i === this.hoverId) return;
			this.hoverId = spot.i;
			this.send({ k: 'ptr', ev: 'hover', b: 0, m: modsOf(event), d: 0, ...spot });
		}, opts);
		doc.addEventListener('mouseup', (event) => {
			const target = event.target as Element | null;
			if (target?.closest?.('select')) return;
			event.preventDefault();
			if (echo()) return;
			this.flushMove();
			const spot = this.spot(event, doc);
			if (spot) this.send({ k: 'ptr', ev: 'up', b: event.button, m: modsOf(event), d: event.detail, ...spot });
		}, opts);
		doc.addEventListener('contextmenu', (event) => {
			event.preventDefault();
			if (echo() || this.touch) return;
			const spot = this.spot(event, doc);
			if (spot) this.send({ k: 'ptr', ev: 'ctx', b: 2, m: modsOf(event), d: 1, ...spot });
		}, opts);
		doc.addEventListener('click', (event) => {
			const target = event.target as Element | null;
			if (!target?.closest?.('select')) event.preventDefault();
		}, opts);
		doc.addEventListener('dblclick', (event) => event.preventDefault(), opts);
		doc.addEventListener('submit', (event) => event.preventDefault(), opts);
		doc.addEventListener('dragstart', (event) => event.preventDefault(), opts);
		doc.addEventListener('change', (event) => {
			const target = event.target as Element | null;
			if (target?.nodeName !== 'SELECT') return;
			const id = this.viewer.idOf(target);
			if (id !== undefined) this.send({ k: 'sel', i: id, v: (target as HTMLSelectElement).value });
		}, opts);
		doc.addEventListener('wheel', (event) => {
			// Embedded: the copy scrolls itself.
			if (this.embedded) return;
			event.preventDefault();
			const spot = this.spot(event, doc);
			if (!spot) return;
			const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? this.viewer.root?.defaultView?.innerHeight ?? 600 : 1;
			this.queueWheel(spot, event.deltaX * unit, event.deltaY * unit, modsOf(event));
		}, opts);
		doc.addEventListener('touchstart', (event) => this.touchStart(event, doc), opts);
		doc.addEventListener('touchmove', (event) => this.touchMove(event), opts);
		doc.addEventListener('touchend', (event) => this.touchEnd(event), opts);
		doc.addEventListener('touchcancel', () => this.cancelTouch(), opts);
	}

	private throttleMove(run: () => void): void {
		this.pendingMove = run;
		const wait = MOVE_EVERY_MS - (Date.now() - this.lastMove);
		if (wait <= 0) {
			this.flushMove();
			return;
		}
		if (this.moveTimer === null) this.moveTimer = setTimeout(() => this.flushMove(), wait);
	}

	private flushMove(): void {
		if (this.moveTimer !== null) clearTimeout(this.moveTimer);
		this.moveTimer = null;
		const run = this.pendingMove;
		this.pendingMove = null;
		if (!run) return;
		this.lastMove = Date.now();
		run();
	}

	private queueWheel(spot: Spot, dx: number, dy: number, m: number): void {
		if (this.wheelAcc && this.wheelAcc.spot.i === spot.i) {
			this.wheelAcc.dx += dx;
			this.wheelAcc.dy += dy;
		} else {
			this.flushWheel();
			this.wheelAcc = { spot, dx, dy, m };
		}
		if (this.wheelTimer === null) this.wheelTimer = setTimeout(() => this.flushWheel(), MOVE_EVERY_MS);
	}

	private flushWheel(): void {
		if (this.wheelTimer !== null) clearTimeout(this.wheelTimer);
		this.wheelTimer = null;
		const acc = this.wheelAcc;
		this.wheelAcc = null;
		if (acc && (acc.dx || acc.dy)) this.send({ k: 'wheel', dx: Math.round(acc.dx), dy: Math.round(acc.dy), m: acc.m, ...acc.spot });
	}

	private touchStart(event: TouchEvent, doc: Document): void {
		this.lastTouch = Date.now();
		if (event.touches.length !== 1) {
			// Two fingers: the browser's pinch-zoom; whatever one finger began is off.
			this.cancelTouch();
			return;
		}
		const point = event.touches[0];
		const spot = this.spot({ clientX: point.clientX, clientY: point.clientY, target: event.target }, doc);
		if (!spot) return;
		const touch = { x: point.clientX, y: point.clientY, lastX: point.clientX, lastY: point.clientY, spot, target: event.target as Element, moved: false, long: false, timer: null as ReturnType<typeof setTimeout> | null };
		touch.timer = setTimeout(() => {
			if (this.touch !== touch || touch.moved) return;
			touch.long = true;
			this.send({ k: 'ptr', ev: 'ctx', b: 2, m: 0, d: 1, ...spot });
		}, LONG_PRESS_MS);
		this.touch = touch;
	}

	private touchMove(event: TouchEvent): void {
		this.lastTouch = Date.now();
		const touch = this.touch;
		if (!touch || event.touches.length !== 1) return;
		const point = event.touches[0];
		if (!touch.moved && Math.hypot(point.clientX - touch.x, point.clientY - touch.y) < TAP_SLOP) return;
		touch.moved = true;
		if (touch.timer !== null) clearTimeout(touch.timer);
		// Embedded: the drag is the copy's own native scroll.
		if (this.embedded) return;
		event.preventDefault();
		const dx = touch.lastX - point.clientX;
		const dy = touch.lastY - point.clientY;
		touch.lastX = point.clientX;
		touch.lastY = point.clientY;
		this.queueWheel(touch.spot, dx, dy, 0);
	}

	private touchEnd(event: TouchEvent): void {
		this.lastTouch = Date.now();
		const touch = this.touch;
		this.touch = null;
		if (!touch) return;
		if (touch.timer !== null) clearTimeout(touch.timer);
		this.flushWheel();
		if (touch.moved || touch.long) {
			if (!this.embedded || touch.long) event.preventDefault();
			return;
		}
		if (touch.target?.closest?.('select')) return;
		event.preventDefault();
		const now = Date.now();
		const double = this.lastTap !== null && now - this.lastTap.at < DOUBLE_TAP_MS && Math.hypot(touch.x - this.lastTap.x, touch.y - this.lastTap.y) < 24;
		this.lastTap = double ? null : { at: now, x: touch.x, y: touch.y };
		const d = double ? 2 : 1;
		this.send({ k: 'ptr', ev: 'down', b: 0, m: 0, d, ...touch.spot });
		this.send({ k: 'ptr', ev: 'up', b: 0, m: 0, d, ...touch.spot });
		// Inside the tap's own gesture: the one moment a phone agrees to raise the keyboard.
		if (editableAt(touch.target)) this.proxy.focus({ preventScroll: true });
		else if (this.coarse) this.proxy.blur();
	}

	private cancelTouch(): void {
		if (this.touch?.timer) clearTimeout(this.touch.timer);
		this.touch = null;
	}

	// ---- the keyboard ----

	private sendKey(key: string, code: string, m: number): void {
		this.send({ k: 'key', key, code, m });
	}

	private wireProxy(): void {
		const proxy = this.proxy;
		proxy.addEventListener('keydown', (event) => {
			// Keys typed into the copy are the PC page's, never the workbench's shortcuts.
			if (this.embedded) event.stopPropagation();
			if (event.isComposing || this.composing || event.keyCode === 229) return;
			const lower = event.key.toLowerCase();
			const command = event.ctrlKey || event.metaKey;
			// Paste reads THIS device's clipboard: the browser's paste event carries it.
			if (command && lower === 'v') return;
			if (!isSpecialKey(event)) return;
			event.preventDefault();
			if (command && (lower === 'c' || lower === 'x')) {
				this.send({ k: 'copy' });
				if (lower === 'x') this.sendKey('Backspace', 'Backspace', 0);
				return;
			}
			this.sendKey(event.key, event.code, modsOf(event));
		});
		proxy.addEventListener('beforeinput', (event) => {
			if (event.isComposing || this.composing) return;
			switch (event.inputType) {
				case 'insertText':
					event.preventDefault();
					if (event.data) this.send({ k: 'text', v: event.data });
					return;
				case 'insertLineBreak':
				case 'insertParagraph':
					event.preventDefault();
					this.sendKey('Enter', 'Enter', 0);
					return;
				case 'deleteContentBackward':
					event.preventDefault();
					this.sendKey('Backspace', 'Backspace', 0);
					return;
				case 'deleteContentForward':
					event.preventDefault();
					this.sendKey('Delete', 'Delete', 0);
					return;
			}
		});
		proxy.addEventListener('compositionstart', () => {
			this.composing = true;
		});
		proxy.addEventListener('compositionend', (event) => {
			this.composing = false;
			if (event.data) this.send({ k: 'text', v: event.data });
			setTimeout(() => {
				proxy.value = '';
			}, 0);
		});
		proxy.addEventListener('input', () => {
			// What slipped past beforeinput (an engine that cannot cancel it) still travels.
			if (this.composing) return;
			const text = proxy.value;
			proxy.value = '';
			if (text) this.send({ k: 'text', v: text });
		});
		proxy.addEventListener('paste', (event) => {
			event.preventDefault();
			const text = event.clipboardData?.getData('text/plain') ?? '';
			if (text) this.send({ k: 'text', v: text });
		});
	}
}
