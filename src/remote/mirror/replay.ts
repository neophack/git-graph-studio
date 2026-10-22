// The PC half of the replica's input path: a viewer's pointer, wheel and keyboard messages
// become DOM events on the desktop window's real nodes, dispatched with each frame's own
// event constructors, so the page code that handles a real click handles this one the same
// way (React's root listeners, CodeMirror's keymaps and mouse selection, xterm's textarea).
// What the browser would do natively after an unhandled event — move the focus on a
// press, scroll on a wheel, edit on a key — is done here explicitly, since a synthetic
// event triggers no default action.

import { SYNTH_POINTER_ID, type Mods, type Spot, type UpMessage } from './protocol';
import type { DomRecorder } from './recorder';

const FOCUSABLE = 'input, textarea, select, button, a[href], [tabindex], [contenteditable]:not([contenteditable="false"])';

/** The elements Tauri's drag script treats as clickable — a mousedown on one without the
 *  drag-region attribute blocks the window drag (scripts/drag.js's isClickableElement). */
const DRAG_BLOCKING = 'a, button, input, select, textarea, label, summary, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="checkbox"], [role="radio"], [role="switch"], [role="option"], [contenteditable]:not([contenteditable="false"]), [tabindex]:not([tabindex="-1"])';

/** Tauri's own drag-region walk: would a mousedown on `el` start dragging the PC's window?
 *  A bare region answers a direct hit on itself alone, a `deep` region any non-interactive
 *  descendant, and an interactive element without the attribute blocks (the replayed events
 *  reach Tauri's document listener, so this walk must agree with its script exactly). */
function startsWindowDrag(el: Element): boolean {
	for (let up: Element | null = el; up; up = up.parentElement) {
		const attr = up.getAttribute('data-tauri-drag-region');
		if (up.matches(DRAG_BLOCKING) && attr === null) return false;
		if (attr === null) continue;
		if (attr === 'false') return false;
		if (attr === 'deep') return true;
		return up === el;
	}
	return false;
}

interface ViewerInput {
	down: Element | null;
	hover: Element | null;
}

type Win = Window & typeof globalThis;

/** The element a pointer capture claimed during replay (a sash drag, a scrollbar thumb):
 *  later moves and the release go there, as the browser would route them. */
let captured: Element | null = null;
const patchedWindows = new WeakSet<Window>();

/** A synthetic pointer is never an active pointer, so `setPointerCapture` would throw on
 *  it: the replay's own id is captured here instead, everything else passes through. */
function patchCapture(win: Win): void {
	if (patchedWindows.has(win)) return;
	patchedWindows.add(win);
	const proto = win.Element.prototype;
	const set = proto.setPointerCapture;
	const release = proto.releasePointerCapture;
	const has = proto.hasPointerCapture;
	proto.setPointerCapture = function (this: Element, id: number) {
		if (id === SYNTH_POINTER_ID) {
			captured = this;
			return;
		}
		return set.call(this, id);
	};
	proto.releasePointerCapture = function (this: Element, id: number) {
		if (id === SYNTH_POINTER_ID) {
			if (captured === this) captured = null;
			return;
		}
		return release.call(this, id);
	};
	proto.hasPointerCapture = function (this: Element, id: number) {
		return id === SYNTH_POINTER_ID ? captured === this : has.call(this, id);
	};
}

function winOf(node: Node): Win | null {
	return (node.ownerDocument?.defaultView as Win | null) ?? null;
}

function modInit(m: Mods): { ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean } {
	return { ctrlKey: (m & 1) !== 0, shiftKey: (m & 2) !== 0, altKey: (m & 4) !== 0, metaKey: (m & 8) !== 0 };
}

const BUTTONS = [1, 4, 2];

/** The focused element at the bottom of the frame chain. */
export function deepActive(doc: Document): Element {
	let el: Element | null = doc.activeElement;
	for (let depth = 0; depth < 8 && el && el.nodeName === 'IFRAME'; depth++) {
		let inner: Document | null = null;
		try {
			inner = (el as HTMLIFrameElement).contentDocument;
		} catch {
			inner = null;
		}
		if (!inner) break;
		el = inner.activeElement ?? inner.body;
	}
	return el ?? doc.body;
}

function isTextControl(el: Element): el is HTMLInputElement | HTMLTextAreaElement {
	if (el.nodeName === 'TEXTAREA') return true;
	if (el.nodeName !== 'INPUT') return false;
	return !['button', 'checkbox', 'radio', 'range', 'file', 'submit', 'reset', 'color', 'image', 'hidden'].includes((el as HTMLInputElement).type);
}

function isEditable(el: Element): boolean {
	return isTextControl(el) || (el as HTMLElement).isContentEditable === true;
}

/** The key code legacy handlers still read (`keyCode` / `which`), for the keys that have one. */
export function keyCodeFor(key: string): number {
	const named: Record<string, number> = {
		Backspace: 8, Tab: 9, Enter: 13, Shift: 16, Control: 17, Alt: 18, Escape: 27, ' ': 32,
		PageUp: 33, PageDown: 34, End: 35, Home: 36, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
		Insert: 45, Delete: 46, Meta: 91
	};
	if (key in named) return named[key];
	const fn = /^F(\d{1,2})$/.exec(key);
	if (fn) return 111 + Number(fn[1]);
	if (key.length === 1) {
		const upper = key.toUpperCase();
		if (upper >= 'A' && upper <= 'Z') return upper.charCodeAt(0);
		if (key >= '0' && key <= '9') return key.charCodeAt(0);
	}
	return 0;
}

export class InputReplayer {
	private viewers = new Map<string, ViewerInput>();

	constructor(
		private readonly recorder: DomRecorder,
		private readonly root: Document
	) {}

	forget(viewer: string): void {
		this.viewers.delete(viewer);
	}

	/** Replay one input message. Answers the clipboard text for a `copy`. */
	handle(message: UpMessage): string | undefined {
		const state = this.viewers.get(message.from) ?? { down: null, hover: null };
		this.viewers.set(message.from, state);
		switch (message.k) {
			case 'ptr':
				this.pointer(state, message, message.ev, message.b, message.m, message.d);
				return undefined;
			case 'wheel':
				this.wheel(message, message.dx, message.dy, message.m);
				return undefined;
			case 'key':
				this.key(message.key, message.code, message.m);
				return undefined;
			case 'text':
				this.text(message.v);
				return undefined;
			case 'sel':
				this.select(message.i, message.v);
				return undefined;
			case 'scroll':
				this.syncScroll(message.i, message.f, message.e === 1);
				return undefined;
			case 'copy':
				return this.selectionText();
			default:
				return undefined;
		}
	}

	/** The element and the client point a spot names, read off the PC's own layout. */
	private locate(spot: Spot): { el: Element; win: Win; x: number; y: number } | null {
		let node = this.recorder.nodeOf(spot.i);
		if (node && node.nodeType !== 1) node = node.parentElement ?? undefined;
		if (!node || !node.isConnected) return null;
		const el = node as Element;
		const win = winOf(el);
		if (!win) return null;
		patchCapture(win);
		if (spot.ci !== undefined) {
			const text = this.recorder.nodeOf(spot.ci);
			if (text && text.nodeType === 3 && text.isConnected) {
				const range = el.ownerDocument.createRange();
				const offset = Math.min(spot.co ?? 0, (text.nodeValue ?? '').length);
				range.setStart(text, offset);
				range.setEnd(text, offset);
				const rect = range.getClientRects()[0] ?? range.getBoundingClientRect();
				if (rect && (rect.height > 0 || rect.left > 0)) return { el, win, x: rect.left, y: rect.top + rect.height / 2 };
			}
		}
		const rect = el.getBoundingClientRect();
		const fx = Number.isFinite(spot.fx) ? Math.min(1, Math.max(0, spot.fx)) : 0.5;
		const fy = Number.isFinite(spot.fy) ? Math.min(1, Math.max(0, spot.fy)) : 0.5;
		return { el, win, x: rect.left + fx * rect.width, y: rect.top + fy * rect.height };
	}

	private fire(win: Win, target: Element, type: string, x: number, y: number, button: number, buttons: number, m: Mods, detail = 0, related: Element | null = null): boolean {
		const bubbles = type !== 'mouseenter' && type !== 'mouseleave' && type !== 'pointerenter' && type !== 'pointerleave';
		const init: MouseEventInit = {
			bubbles,
			cancelable: bubbles,
			composed: true,
			view: win,
			clientX: x,
			clientY: y,
			screenX: x,
			screenY: y,
			button,
			buttons,
			detail,
			relatedTarget: related,
			...modInit(m)
		};
		let event: Event;
		if (type.startsWith('pointer') && typeof win.PointerEvent === 'function') {
			event = new win.PointerEvent(type, { ...init, pointerId: SYNTH_POINTER_ID, pointerType: 'mouse', isPrimary: true, width: 1, height: 1, pressure: buttons ? 0.5 : 0 });
		} else if (type.startsWith('pointer')) {
			return true;
		} else {
			event = new win.MouseEvent(type, init);
		}
		return target.dispatchEvent(event);
	}

	/** Move the hover from wherever it was to `el`: out / leave on the old chain, over /
	 *  enter on the new one — React's onMouseEnter and every `mouseenter` submenu rely on it. */
	private hoverTo(state: ViewerInput, el: Element, win: Win, x: number, y: number, m: Mods): void {
		const old = state.hover;
		if (old === el) return;
		state.hover = el;
		const oldWin = old ? winOf(old) : null;
		if (old && old.isConnected && oldWin) {
			this.fire(oldWin, old, 'pointerout', x, y, 0, 0, m, 0, el);
			this.fire(oldWin, old, 'mouseout', x, y, 0, 0, m, 0, el);
			for (let up: Element | null = old; up && !up.contains(el); up = up.parentElement) {
				this.fire(oldWin, up, 'pointerleave', x, y, 0, 0, m, 0, el);
				this.fire(oldWin, up, 'mouseleave', x, y, 0, 0, m, 0, el);
			}
		}
		this.fire(win, el, 'pointerover', x, y, 0, 0, m, 0, old);
		this.fire(win, el, 'mouseover', x, y, 0, 0, m, 0, old);
		const entered: Element[] = [];
		for (let up: Element | null = el; up && !(old && up.contains(old)); up = up.parentElement) entered.push(up);
		for (const up of entered.reverse()) {
			this.fire(win, up, 'pointerenter', x, y, 0, 0, m, 0, old);
			this.fire(win, up, 'mouseenter', x, y, 0, 0, m, 0, old);
		}
	}

	private pointer(state: ViewerInput, spot: Spot, ev: 'down' | 'move' | 'up' | 'hover' | 'ctx', b: number, m: Mods, detail: number): void {
		const at = this.locate(spot);
		if (!at) return;
		const { el, win, x, y } = at;
		// The title bar's drag region moves the PC's window — nothing a viewer may do.
		if (ev !== 'hover' && startsWindowDrag(el)) return;
		const button = Math.max(0, Math.min(2, b));
		const pressed = BUTTONS[button] ?? 1;
		switch (ev) {
			case 'hover':
				this.hoverTo(state, el, win, x, y, m);
				this.fire(win, el, 'pointermove', x, y, 0, 0, m);
				this.fire(win, el, 'mousemove', x, y, 0, 0, m);
				return;
			case 'down': {
				this.hoverTo(state, el, win, x, y, m);
				captured = null;
				const pointer = this.fire(win, el, 'pointerdown', x, y, button, pressed, m, detail);
				const mouse = pointer ? this.fire(win, el, 'mousedown', x, y, button, pressed, m, detail) : false;
				if (mouse && button === 0) this.focusAt(el, x, y);
				state.down = el;
				return;
			}
			case 'move': {
				const target = captured && captured.isConnected ? captured : el;
				const targetWin = winOf(target) ?? win;
				if (!captured) this.hoverTo(state, el, win, x, y, m);
				this.fire(targetWin, target, 'pointermove', x, y, 0, pressed, m);
				this.fire(targetWin, target, 'mousemove', x, y, 0, pressed, m);
				return;
			}
			case 'up': {
				const target = captured && captured.isConnected ? captured : el;
				const targetWin = winOf(target) ?? win;
				this.fire(targetWin, target, 'pointerup', x, y, button, 0, m, detail);
				this.fire(targetWin, target, 'mouseup', x, y, button, 0, m, detail);
				captured = null;
				const down = state.down;
				state.down = null;
				if (!down || !down.isConnected) return;
				let common: Element | null = el;
				while (common && !common.contains(down)) common = common.parentElement;
				if (!common) return;
				const commonWin = winOf(common) ?? win;
				if (button === 0) {
					this.fire(commonWin, common, 'click', x, y, 0, 0, m, Math.max(1, detail));
					if (detail === 2) this.fire(commonWin, common, 'dblclick', x, y, 0, 0, m, 2);
				} else if (button === 1) {
					this.fire(commonWin, common, 'auxclick', x, y, 1, 0, m, 1);
				}
				return;
			}
			case 'ctx': {
				this.hoverTo(state, el, win, x, y, m);
				this.fire(win, el, 'pointerdown', x, y, 2, 2, m, 1);
				this.fire(win, el, 'mousedown', x, y, 2, 2, m, 1);
				this.fire(win, el, 'pointerup', x, y, 2, 0, m, 1);
				this.fire(win, el, 'mouseup', x, y, 2, 0, m, 1);
				this.fire(win, el, 'contextmenu', x, y, 2, 0, m, 1);
				return;
			}
		}
	}

	/** A press's default: focus what it landed on (the caret where it landed, in an
	 *  editable), or drop the focus when it landed on nothing focusable. */
	private focusAt(el: Element, x: number, y: number): void {
		const doc = el.ownerDocument;
		const focusable = el.closest(FOCUSABLE) as HTMLElement | null;
		if (!focusable) {
			const active = doc.activeElement as HTMLElement | null;
			if (active && active !== doc.body) active.blur?.();
			return;
		}
		if (doc.activeElement !== focusable) focusable.focus({ preventScroll: true });
		if (focusable.isContentEditable) {
			const range = (doc as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null }).caretRangeFromPoint?.(x, y);
			if (range && focusable.contains(range.startContainer)) {
				const selection = doc.getSelection();
				selection?.removeAllRanges();
				selection?.addRange(range);
			}
		}
	}

	private wheel(spot: Spot, dx: number, dy: number, m: Mods): void {
		const at = this.locate(spot);
		if (!at) return;
		const { el, win, x, y } = at;
		const event = typeof win.WheelEvent === 'function'
			? new win.WheelEvent('wheel', { bubbles: true, cancelable: true, composed: true, view: win, clientX: x, clientY: y, deltaX: dx, deltaY: dy, deltaMode: 0, ...modInit(m) })
			: new win.Event('wheel', { bubbles: true, cancelable: true });
		if (!el.dispatchEvent(event)) return;
		// Nobody handled it: scroll the nearest scroller, as the browser would.
		for (let up: Element | null = el; up; up = up.parentElement) {
			const style = win.getComputedStyle(up);
			const canY = dy !== 0 && /auto|scroll|overlay/.test(style.overflowY) && up.scrollHeight > up.clientHeight;
			const canX = dx !== 0 && /auto|scroll|overlay/.test(style.overflowX) && up.scrollWidth > up.clientWidth;
			if (canY || canX) {
				up.scrollBy({ left: canX ? dx : 0, top: canY ? dy : 0 });
				return;
			}
		}
		el.ownerDocument.scrollingElement?.scrollBy({ left: dx, top: dy });
	}

	private keyEvent(win: Win, target: Element, type: string, key: string, code: string, m: Mods): boolean {
		const event = new win.KeyboardEvent(type, { key, code, bubbles: true, cancelable: true, composed: true, view: win, ...modInit(m) });
		const keyCode = keyCodeFor(key);
		Object.defineProperty(event, 'keyCode', { get: () => keyCode });
		Object.defineProperty(event, 'which', { get: () => keyCode });
		return target.dispatchEvent(event);
	}

	private key(key: string, code: string, m: Mods): void {
		const target = deepActive(this.root);
		const win = winOf(target);
		if (!win) return;
		if (this.keyEvent(win, target, 'keydown', key, code, m)) this.defaultKey(target, key, m);
		this.keyEvent(win, target, 'keyup', key, code, m);
	}

	/** What an unhandled key does in an editable (the native default a synthetic key lacks). */
	private defaultKey(target: Element, key: string, m: Mods): void {
		if (!isEditable(target)) return;
		const doc = target.ownerDocument;
		const shift = (m & 2) !== 0;
		const command = (m & 9) !== 0;
		const exec = (name: string, value?: string) => {
			try {
				return doc.execCommand(name, false, value);
			} catch {
				return false;
			}
		};
		if (command) {
			const lower = key.toLowerCase();
			if (lower === 'a') exec('selectAll');
			else if (lower === 'z') exec(shift ? 'redo' : 'undo');
			else if (lower === 'y') exec('redo');
			return;
		}
		switch (key) {
			case 'Backspace':
				exec('delete');
				return;
			case 'Delete':
				exec('forwardDelete');
				return;
			case 'Enter':
				if (target.nodeName === 'TEXTAREA') exec('insertText', '\n');
				else if (target.nodeName === 'INPUT') (target as HTMLInputElement).form?.requestSubmit?.();
				else exec(shift ? 'insertLineBreak' : 'insertParagraph');
				return;
			case 'ArrowLeft':
			case 'ArrowRight':
			case 'ArrowUp':
			case 'ArrowDown':
			case 'Home':
			case 'End':
				this.moveCaret(target, key, shift);
				return;
		}
	}

	private moveCaret(target: Element, key: string, extend: boolean): void {
		if (isTextControl(target)) {
			const control = target;
			const length = control.value.length;
			const start = control.selectionStart ?? length;
			const end = control.selectionEnd ?? length;
			let caret = end;
			if (key === 'ArrowLeft') caret = Math.max(0, (start === end || extend ? end : start) - (start === end || extend ? 1 : 0));
			else if (key === 'ArrowRight') caret = Math.min(length, end + (start === end || extend ? 1 : 0));
			else if (key === 'Home' || key === 'ArrowUp') caret = 0;
			else caret = length;
			if (extend) control.setSelectionRange(Math.min(start, caret), Math.max(start, caret));
			else control.setSelectionRange(caret, caret);
			return;
		}
		const selection = target.ownerDocument.getSelection() as (Selection & { modify?: (alter: string, direction: string, granularity: string) => void }) | null;
		if (!selection?.modify) return;
		const direction = key === 'ArrowLeft' || key === 'ArrowUp' || key === 'Home' ? 'backward' : 'forward';
		const granularity = key === 'ArrowUp' || key === 'ArrowDown' ? 'line' : key === 'Home' || key === 'End' ? 'lineboundary' : 'character';
		selection.modify(extend ? 'extend' : 'move', direction, granularity);
	}

	private text(value: string): void {
		if (!value) return;
		const target = deepActive(this.root);
		const win = winOf(target);
		if (!win) return;
		if (isEditable(target)) {
			const before = isTextControl(target) ? target.value : null;
			let inserted = false;
			try {
				inserted = target.ownerDocument.execCommand('insertText', false, value);
			} catch {
				inserted = false;
			}
			// An engine may answer true and change nothing: the field's value is the proof.
			if (isTextControl(target) && (!inserted || target.value === before)) {
				const start = target.selectionStart ?? target.value.length;
				const end = target.selectionEnd ?? target.value.length;
				target.setRangeText(value, start, end, 'end');
				target.dispatchEvent(new win.InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
			}
			return;
		}
		// No editable focused: type-to-filter lists and single-key bindings hear the keys.
		for (const ch of value) {
			this.keyEvent(win, target, 'keydown', ch, '', 0);
			this.keyEvent(win, target, 'keyup', ch, '', 0);
		}
	}

	private select(id: number, value: string): void {
		const node = this.recorder.nodeOf(id);
		if (!node || node.nodeName !== 'SELECT') return;
		const select = node as HTMLSelectElement;
		const win = winOf(select);
		if (!win) return;
		select.value = value;
		select.dispatchEvent(new win.Event('input', { bubbles: true }));
		select.dispatchEvent(new win.Event('change', { bubbles: true }));
	}

	/** A fluid copy scrolled its own layout of the page (§22.6): put this page's scroller at
	 *  the same place — the fraction of the range, since the copy's pixels belong to another
	 *  layout — so a page that renders its content around the scroll position (a virtualized
	 *  list: git-graph-rs) renders the window the viewer is looking at. The page's own scroll
	 *  handlers run as they would for a real scroll, and the recorder shows the move to every
	 *  other viewer. */
	private syncScroll(id: number, fraction: number, end: boolean): void {
		const node = this.recorder.nodeOf(id);
		if (!node || node.nodeType !== 1 || !node.isConnected) return;
		const el = node as Element;
		const range = el.scrollHeight - el.clientHeight;
		if (range <= 0) return;
		const top = end ? range : Math.round(Math.min(1, Math.max(0, fraction)) * range);
		if (Math.abs(el.scrollTop - top) >= 1) el.scrollTop = top;
	}

	private selectionText(): string {
		const target = deepActive(this.root);
		if (isTextControl(target)) {
			const start = target.selectionStart ?? 0;
			const end = target.selectionEnd ?? 0;
			return target.value.slice(start, end);
		}
		return target.ownerDocument.getSelection()?.toString() ?? '';
	}
}
