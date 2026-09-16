// Small DOM building blocks shared by every part of the workbench: element construction,
// codicons, notifications (VS Code's toasts), context menus, and the quick-input prompt.

import { trText } from './i18n';

export function el<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	className?: string,
	children: (Node | string | null | undefined)[] = []
): HTMLElementTagNameMap[K] {
	const element = document.createElement(tag);
	if (className) element.className = className;
	for (const child of children) {
		if (child === null || child === undefined) continue;
		element.append(child);
	}
	return element;
}

/** A codicon glyph (`@vscode/codicons`), the icon font VS Code itself draws with. */
export function icon(name: string, className = ''): HTMLElement {
	return el('span', `codicon codicon-${name}${className ? ' ' + className : ''}`);
}

/** A 22px toolbar button: a codicon with a title, as VS Code's view title actions. */
export function actionButton(iconName: string, title: string, onClick: (event: MouseEvent) => void): HTMLButtonElement {
	const button = el('button', 'action-btn', [icon(iconName)]);
	button.title = title;
	button.setAttribute('aria-label', title);
	button.addEventListener('click', (event) => {
		event.stopPropagation();
		onClick(event);
	});
	return button;
}

export function escapeHtml(text: string): string {
	return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

/* ---------- Virtual scrolling past the engines' height ceiling ---------- */

/** The document height to assume the engines can lay out when nothing can be measured (a
 *  headless test DOM): under Chromium's and WebKit's ~33.5M px clamp with a margin. */
export const MAX_SCROLL_PX = 32_000_000;

/** The probe height for measuring the real clamp: the engines cut every element near
 *  33,554,432 layout px (their 2^25-ish LayoutUnit). */
const CEILING_PROBE_PX = 33_554_432;

let measuredCeiling: number | null = null;

/** The tallest document this engine will actually lay out, in CSS pixels. The ~33.5M layout
 *  clamp divides by the webview's zoom: on a Windows display scaled to 150%, say, an
 *  element is cut near 22.4M CSS px — so the ceiling is probed once (an element is laid
 *  out and measured back) rather than assumed, and everything taller stays a guard band
 *  under it so the rows and windows placed at its edge fit inside the clamp too. */
function scrollHeightCeiling(): number {
	if (measuredCeiling === null) {
		measuredCeiling = MAX_SCROLL_PX;
		if (typeof document !== 'undefined' && document.body) {
			const probe = document.createElement('div');
			probe.style.cssText = `position:absolute;top:0;left:0;width:1px;height:${CEILING_PROBE_PX}px;visibility:hidden;pointer-events:none;`;
			document.body.appendChild(probe);
			const laid = probe.getBoundingClientRect().height;
			probe.remove();
			if (laid > 0 && laid < CEILING_PROBE_PX) measuredCeiling = Math.max(1_000_000, Math.floor(laid) - 65_536);
		}
	}
	return measuredCeiling;
}

/** The scrollbar mapping for a virtual document of `count` rows × `rowHeight`: the spacer
 *  height to ask the engine for, the document offset a scroll position stands for, and the
 *  scroll position that lands a given document offset. While the document fits the ceiling
 *  (the common case) everything is the identity; past it the scroll range is scaled — a
 *  four-million-row trace stays browsable to its last row instead of ending at the clamp. */
export class VirtualScroll {
	private readonly documentHeight: number;
	private spacer: number;

	/** `padBottom` extends the scrollable document past its last row (a page minus a row,
	 *  the editors' scroll-past-the-end): at the scrollbar's bottom the last row sits at
	 *  the viewport's top and the page below it stays blank. */
	constructor(count: number, rowHeight: number, padBottom = 0) {
		this.documentHeight = Math.max(1, count) * rowHeight + Math.max(0, padBottom);
		this.spacer = Math.min(scrollHeightCeiling(), this.documentHeight);
	}

	/** Sets the spacer's height and adopts the height the engine actually laid out. The
	 *  engine rounds the laid box a step shorter than asked (a spacer of 22,304,100 lays
	 *  out as 22,304,084); the mapping must divide by the real scrollable extent, or that
	 *  shortfall — multiplied by the scale, a hundred-fold on a multi-gigabyte document —
	 *  parks the document's last rows below the viewport where scrolling can never reach
	 *  them. A zero rect (a hidden pane, a test DOM) keeps the asked-for height. */
	lay(spacer: HTMLElement): void {
		spacer.style.height = `${this.spacer}px`;
		const laid = spacer.getBoundingClientRect().height;
		if (laid > 0 && laid < this.spacer) this.spacer = Math.floor(laid);
	}

	/** True past the ceiling: rows must then be placed viewport-relative (their document-space
	 *  offsets would themselves be clamped away) and repositioned as the scroller moves. */
	get scaled(): boolean {
		return this.documentHeight > scrollHeightCeiling();
	}

	/** The document-space offset (px from the document's top) the scroller's current position
	 *  stands for. `scrollHeight` (the scroller's own, when the caller has it) pins the
	 *  mapping at the bottom: the engine snaps scroll positions to device pixels, so a
	 *  position a fraction of a pixel short of the bottom times the scale (135 rows' worth
	 *  on a 3 GB file) would otherwise park the document's last rows below the viewport. */
	documentTop(scrollTop: number, clientHeight: number, scrollHeight = 0): number {
		if (!this.scaled) return scrollTop;
		const maxTop = this.documentHeight - clientHeight;
		if (scrollHeight > 0 && scrollTop >= scrollHeight - clientHeight - 1) return Math.max(0, maxTop);
		const scale = this.scale(clientHeight);
		return Math.max(0, Math.min(maxTop, scrollTop * scale));
	}

	/** The scroll position that puts `documentOffset` at the viewport's top. */
	scrollTopFor(documentOffset: number, clientHeight: number): number {
		if (!this.scaled) return documentOffset;
		return Math.max(0, Math.min(this.spacer - clientHeight, documentOffset / this.scale(clientHeight)));
	}

	/** Document pixels per scrollbar pixel — 1 while the document fits the ceiling, the
	 *  scale past it. Deltas that mean document distance (a wheel notch) divide by this
	 *  before they move the thumb, or the scaled range multiplies them into whole
	 *  screens per notch. */
	documentPxPerScrollPx(clientHeight: number): number {
		return this.scaled ? this.scale(clientHeight) : 1;
	}

	private scale(clientHeight: number): number {
		const scrollable = this.spacer - clientHeight;
		if (scrollable <= 0) return 1;
		const document = this.documentHeight - clientHeight;
		return document > scrollable ? document / scrollable : 1;
	}
}

/* ---------- Smooth wheel scrolling (VS Code's scrollable model) ---------- */

/** VS Code's smooth-scroll duration (`SMOOTH_SCROLL_DURATION` in its `scrollable.ts`): a
 *  wheel notch glides over 125 ms instead of jumping its pixels in a single frame. */
const SMOOTH_WHEEL_MS = 125;

/** VS Code's `SCROLL_WHEEL_SENSITIVITY` (`scrollableElement.ts`): the content pixels one
 *  normalised wheel notch moves. With `StandardWheelEvent`'s normalisation — 40 px of
 *  browser delta, or 3 lines, is one notch — the default Windows notch (100 px of browser
 *  delta) walks 50 × 100/40 = 125 px at sensitivity 1, on every surface, exactly VS Code's
 *  model. The shipped default sensitivity is 3 (settings.ts): VS Code's own pace — even
 *  doubled — read code too slowly. */
const WHEEL_NOTCH_PX = 50;

export interface SmoothWheelOptions {
	/** Whether the glide is on, read live at wheel time so the setting flips without a
	 *  remount. Absent means always on; false lands the same distance at once — the
	 *  sensitivity sets the scroll distance with or without the glide. */
	enabled?: () => boolean;
	/** VS Code's `editor.mouseWheelScrollSensitivity`: a multiplier on the wheel's
	 *  distance, read live at wheel time. Absent means 1. */
	sensitivity?: () => number;
	/** VS Code's `editor.fastScrollSensitivity`: the extra multiplier Alt holds while
	 *  scrolling. Absent means 1. */
	fastSensitivity?: () => number;
	/** How many document pixels one scrollbar pixel stands for — a VirtualScroll range
	 *  past the engines' height ceiling. Wheel deltas are document-space: they divide by
	 *  this, so a notch moves the same rows whatever the file's size. Absent means 1. */
	zoom?: () => number;
}

/** Detach the handler and stop any glide in flight. */
export interface SmoothWheelHandle {
	dispose(): void;
}

/** The glide in flight: a cubic hermite spline per axis — position and velocity captured at
 *  its start, rest at its target — so a notch that lands mid-glide re-splines from where the
 *  motion stands and never jerks it. The clock is the rAF timestamps alone: `start` is
 *  anchored by the first frame, and a retarget reads the velocity at `s`, the parameter the
 *  last frame reached — never a second clock (under jsdom, `performance.now()` and the frame
 *  timestamps are different timelines, and mixing them sent the spline negative). */
interface SmoothWheelGlide {
	start: number | null;
	s: number;
	fromTop: number;
	fromLeft: number;
	velocityTop: number;
	velocityLeft: number;
	targetTop: number;
	targetLeft: number;
	frame: number;
}

/** One hermite step (end velocity zero): the position and velocity `s` of the way through. */
function hermite(from: number, velocity: number, target: number, s: number, duration: number): [number, number] {
	const s2 = s * s;
	const s3 = s2 * s;
	const position = (2 * s3 - 3 * s2 + 1) * from + (s3 - 2 * s2 + s) * duration * velocity + (-2 * s3 + 3 * s2) * target;
	const d = (6 * s2 - 6 * s) / duration * from + (3 * s2 - 4 * s + 1) * velocity + (-6 * s2 + 6 * s) / duration * target;
	return [position, d];
}

/** Smooth mouse-wheel scrolling over any scrollable element, VS Code's model: each wheel
 *  notch is prevented and re-delivered as a 125 ms ease from the current position (carrying
 *  its velocity, so streaming notches compound smoothly — but every notch restarts the
 *  125 ms clock, or later notches would be squeezed into the first notch's window and the
 *  same cadence would alternate between glides and snaps), and any scroll the glide did not
 *  write — a thumb drag, a reveal, a window slide — cancels it on the spot.
 *  The notch's distance is VS Code's model too — 50 px per normalised notch through the
 *  sensitivity options below; the shipped default sensitivity (settings.ts) triples it.
 *  With the glide off the same distance lands at once: the wheel never falls back to the
 *  platform's own step, which would ignore the sensitivity. */
export function attachSmoothWheel(element: HTMLElement, options: SmoothWheelOptions = {}): SmoothWheelHandle {
	const isEnabled = options.enabled ?? (() => true);
	const sensitivity = options.sensitivity ?? (() => 1);
	const fastSensitivity = options.fastSensitivity ?? (() => 1);
	const zoom = options.zoom;
	let glide: SmoothWheelGlide | null = null;
	/** The scroll positions the glide itself last wrote; anything else arriving through a
	 *  scroll event is an external move and owns the element. */
	let writtenTop = 0;
	let writtenLeft = 0;

	function onWheel(event: WheelEvent): void {
		if (event.defaultPrevented || event.ctrlKey || event.metaKey) return;
		// The wheel is always taken over, glide or not: the sensitivity multipliers are the
		// scroll distance's only source (VS Code's mouseWheelScrollSensitivity is not tied to
		// smoothScrolling either — leaving the native scroll in place when the glide is off
		// would silently drop the setting). A scaled virtual range (VirtualScroll above)
		// makes one scrollbar pixel stand for many document pixels, so the notch is computed
		// in document space and divided back to scrollbar pixels, or the native scroll would
		// race the document by the same factor.
		const factor = Math.max(1, zoom?.() ?? 1);
		const smooth = isEnabled();
		// VS Code's wheel model (`StandardWheelEvent` over `SCROLL_WHEEL_SENSITIVITY`): the
		// delta is normalised to notches — 40 px of browser delta, or 3 lines in Firefox's
		// line mode, is one notch — the sensitivity multipliers scale it (Alt holds the
		// fast-scroll factor), and one notch is 50 px of content.
		const notchUnit = event.deltaMode === 1 ? 3 : 40;
		const speed = sensitivity() * (event.altKey ? fastSensitivity() : 1);
		let dx = ((event.deltaX / notchUnit) * WHEEL_NOTCH_PX * speed) / factor;
		let dy = ((event.deltaY / notchUnit) * WHEEL_NOTCH_PX * speed) / factor;
		// Shift+wheel scrolls horizontally — Chromium swaps the axes itself, Firefox does not.
		if (event.shiftKey && dx === 0 && dy !== 0) {
			dx = dy;
			dy = 0;
		}
		// VS Code rounds the delta away from zero ("otherwise low speed scrolling will
		// never scroll"): a scaled range can leave a notch under half a scrollbar pixel,
		// and the engine's whole-pixel snapping would swallow it whole.
		dx = dx < 0 ? Math.floor(dx) : Math.ceil(dx);
		dy = dy < 0 ? Math.floor(dy) : Math.ceil(dy);
		const baseTop = glide ? glide.targetTop : element.scrollTop;
		const baseLeft = glide ? glide.targetLeft : element.scrollLeft;
		// The engine clamps writes anyway, but clamping the target too keeps a notch that
		// lands past an edge from banking there: the first notch the other way must answer.
		const maxTop = element.scrollHeight - element.clientHeight;
		const maxLeft = element.scrollWidth - element.clientWidth;
		const targetTop = Math.max(0, maxTop > 0 ? Math.min(baseTop + dy, maxTop) : baseTop + dy);
		const targetLeft = Math.max(0, maxLeft > 0 ? Math.min(baseLeft + dx, maxLeft) : baseLeft + dx);
		event.preventDefault();
		// The glide off, the same distance lands at once, the way the native wheel would
		// have moved — but at the sensitivity-set distance, not the platform's.
		if (!smooth) {
			cancelGlide();
			element.scrollTop = targetTop;
			element.scrollLeft = targetLeft;
			return;
		}
		// A glide already running hands its live position and velocity to the new spline, but
		// the clock restarts: every notch eases for the full 125 ms from wherever the motion
		// stands. Keeping the old clock squeezed each later notch into the glide's shrinking
		// remainder, so one cadence alternated between full eases and near-instant snaps —
		// the wheel felt faster and slower from notch to notch. A notch against the glide's
		// direction starts from rest: carrying the velocity would lurch the view the wrong
		// way first.
		const pending = glide;
		let velocityTop = 0;
		let velocityLeft = 0;
		if (pending) {
			velocityTop = hermite(pending.fromTop, pending.velocityTop, pending.targetTop, pending.s, SMOOTH_WHEEL_MS)[1];
			velocityLeft = hermite(pending.fromLeft, pending.velocityLeft, pending.targetLeft, pending.s, SMOOTH_WHEEL_MS)[1];
			if (dy !== 0 && Math.sign(dy) !== Math.sign(pending.targetTop - pending.fromTop)) velocityTop = 0;
			if (dx !== 0 && Math.sign(dx) !== Math.sign(pending.targetLeft - pending.fromLeft)) velocityLeft = 0;
		}
		glide = {
			start: null,
			s: 0,
			fromTop: element.scrollTop,
			fromLeft: element.scrollLeft,
			velocityTop,
			velocityLeft,
			targetTop,
			targetLeft,
			frame: pending ? pending.frame : 0
		};
		// Adopt the current positions as ours, so a scroll event still pending from before
		// this notch does not read as an external move and kill the glide it belongs to.
		writtenTop = element.scrollTop;
		writtenLeft = element.scrollLeft;
		if (!pending) glide.frame = requestAnimationFrame(tick);
	}

	function tick(now: number): void {
		if (!glide) return;
		if (!element.isConnected) {
			cancelGlide();
			return;
		}
		glide.start ??= now;
		glide.s = Math.min(1, Math.max(0, (now - glide.start) / SMOOTH_WHEEL_MS));
		const s = glide.s;
		// The spline is defined by its start position and velocity — the velocity out is only
		// read at a retarget, never stored back or the curve would bend mid-flight.
		writtenTop = Math.round(hermite(glide.fromTop, glide.velocityTop, glide.targetTop, s, SMOOTH_WHEEL_MS)[0]);
		writtenLeft = Math.round(hermite(glide.fromLeft, glide.velocityLeft, glide.targetLeft, s, SMOOTH_WHEEL_MS)[0]);
		element.scrollTop = writtenTop;
		element.scrollLeft = writtenLeft;
		if (s >= 1) {
			glide = null;
			return;
		}
		glide.frame = requestAnimationFrame(tick);
	}

	function cancelGlide(): void {
		if (!glide) return;
		cancelAnimationFrame(glide.frame);
		glide = null;
	}

	function onScroll(): void {
		// A position the glide did not write: an external scroll owns the element now.
		if (glide && (element.scrollTop !== writtenTop || element.scrollLeft !== writtenLeft)) cancelGlide();
	}

	element.addEventListener('wheel', onWheel, { passive: false });
	element.addEventListener('scroll', onScroll, { passive: true });
	return {
		dispose(): void {
			cancelGlide();
			element.removeEventListener('wheel', onWheel);
			element.removeEventListener('scroll', onScroll);
		}
	};
}

/* ---------- PageUp / PageDown over a VirtualScroll ---------- */

/** The scroll position one PageUp/PageDown lands on: exactly one viewport of *document*
 *  distance from where the viewport stands, row-quantised so repeated pages never drift a
 *  line. Under a scaled range the native page key moves one viewport of *scrollbar* pixels,
 *  which the scale multiplies into whole screens skipped at once — this never skips. */
export function pageScrollTop(range: VirtualScroll, scroller: HTMLElement, direction: 1 | -1, rowHeight: number): number {
	const clientHeight = scroller.clientHeight;
	const docTop = range.documentTop(scroller.scrollTop, clientHeight, scroller.scrollHeight);
	const target = Math.round((docTop + direction * clientHeight) / rowHeight) * rowHeight;
	return range.scrollTopFor(Math.max(0, target), clientHeight);
}

export interface PageKeysOptions {
	/** The live scroll range — it is rebuilt as documents load and resync, hence a getter. */
	range: () => VirtualScroll;
	/** The live row height, for the drift-free quantisation. */
	rowHeight: () => number;
	/** Runs right after the jump (a view's own scroll listener does not fire under every
	 *  test DOM, and a repaint due this frame need not wait for it anyway). */
	paged?: () => void;
}

/** PageUp / PageDown on a VirtualScroll scroller, one viewport of document rows per press.
 *  Ctrl/Meta/Alt chords pass through — Ctrl+PageUp/Down are the workbench's editor-tab keys;
 *  Shift pages too, these caret-less surfaces having no selection to extend. The element is
 *  made focusable if it is not already, or the keys would never reach it. */
export function attachPageKeys(element: HTMLElement, options: PageKeysOptions): SmoothWheelHandle {
	if (!element.hasAttribute('tabindex')) element.tabIndex = 0;
	function onKeydown(event: KeyboardEvent): void {
		if (event.key !== 'PageUp' && event.key !== 'PageDown') return;
		if (event.ctrlKey || event.metaKey || event.altKey) return;
		if (element.clientHeight <= 0) return;
		event.preventDefault();
		element.scrollTop = pageScrollTop(options.range(), element, event.key === 'PageDown' ? 1 : -1, options.rowHeight());
		options.paged?.();
	}
	element.addEventListener('keydown', onKeydown);
	return {
		dispose(): void {
			element.removeEventListener('keydown', onKeydown);
		}
	};
}

/* ---------- Delayed tooltips and the busy cursor (M7 7.8) ---------- */

/** How long the pointer must rest on an element before its tooltip appears - long enough
 *  that a pass across the bar shows nothing (VS Code's own delay). */
const TOOLTIP_DELAY = 500;
let tooltipTimer: number | null = null;
let tooltipElement: HTMLElement | null = null;

function hideTooltip(): void {
	if (tooltipTimer !== null) {
		clearTimeout(tooltipTimer);
		tooltipTimer = null;
	}
	tooltipElement?.remove();
	tooltipElement = null;
}

/** A delayed custom tooltip in place of the native `title` popup (M7 7.8): VS Code-style
 *  hover-after-a-rest, keyboard-reachable, and gone on any pointer or focus move. The text
 *  is a callback so a label that changes (a status item's counts) stays fresh. */
export function tooltip(element: HTMLElement, text: () => string): void {
	// The native title would race this tooltip with its own popup; the accessible name stays
	// for screen readers either way.
	element.removeAttribute('title');
	element.setAttribute('aria-label', text());
	const show = () => {
		hideTooltip();
		tooltipTimer = window.setTimeout(() => {
			tooltipTimer = null;
			const tip = el('div', 'tooltip', [text()]);
			tooltipElement = tip;
			(document.getElementById('overlays') ?? document.body).appendChild(tip);
			const bounds = element.getBoundingClientRect();
			tip.style.left = `${Math.max(4, Math.min(bounds.left, window.innerWidth - 260))}px`;
			tip.style.top = `${bounds.bottom + 4}px`;
		}, TOOLTIP_DELAY);
	};
	element.addEventListener('mouseenter', show);
	element.addEventListener('focusin', show);
	element.addEventListener('mouseleave', hideTooltip);
	element.addEventListener('blur', hideTooltip);
	element.addEventListener('mousedown', hideTooltip);
}

/** The workbench's busy state (M7 7.8): a progress cursor over everything while a long,
 *  user-initiated task runs, without blocking a single interaction. */
export function busy(on: boolean): void {
	document.body.classList.toggle('busy', on);
}

export function basename(path: string): string {
	const normalised = path.replace(/[\\/]+$/, '');
	const index = Math.max(normalised.lastIndexOf('/'), normalised.lastIndexOf('\\'));
	return index === -1 ? normalised : normalised.slice(index + 1);
}

export function dirname(path: string): string {
	const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
	return index === -1 ? '' : path.slice(0, index);
}

export function joinPath(base: string, name: string): string {
	const separator = base.includes('\\') && !base.includes('/') ? '\\' : '/';
	return base.replace(/[\\/]+$/, '') + separator + name;
}

/** Forward slashes, as git and the graph view spell paths. */
export function toPosix(path: string): string {
	return path.replaceAll('\\', '/');
}

/** `path` relative to `root` (both spelled either way), or `path` itself when outside. */
export function relativeTo(root: string, path: string): string {
	const normalisedRoot = toPosix(root).replace(/\/$/, '');
	const normalisedPath = toPosix(path);
	if (normalisedPath === normalisedRoot) return '';
	return normalisedPath.startsWith(normalisedRoot + '/') ? normalisedPath.slice(normalisedRoot.length + 1) : normalisedPath;
}

/* ---------- Notifications ---------- */

export type NotificationKind = 'info' | 'warning' | 'error';

export interface NotificationAction {
	label: string;
	run: () => void;
}

/** One entry of the notification centre: what was shown, when, and whether it still has its
 *  toast on screen (an auto-dismissed info toast lives on in the centre). */
export interface CentreEntry {
	id: number;
	kind: NotificationKind;
	message: string;
	at: number;
}

const centre: CentreEntry[] = [];
let centreSeq = 1;
const centreListeners = new Set<(count: number) => void>();

/** React to the centre's size changing (the status bar's bell badge). */
export function onNotificationsChange(listener: (count: number) => void): () => void {
	centreListeners.add(listener);
	return () => centreListeners.delete(listener);
}

export function notificationEntries(): CentreEntry[] {
	return [...centre].reverse(); // newest first
}

export function clearNotification(id: number): void {
	const at = centre.findIndex((entry) => entry.id === id);
	if (at !== -1) centre.splice(at, 1);
	for (const listener of centreListeners) listener(centre.length);
}

export function clearAllNotifications(): void {
	centre.length = 0;
	for (const listener of centreListeners) listener(centre.length);
}

/** Post a toast. `onDismiss` runs whenever the toast goes away - the close button, an action
 *  button, or the auto-timeout - so callers can treat "dismissed without choosing" as cancel.
 *  The notification also joins the centre, where it stays until cleared. */
export function notify(kind: NotificationKind, message: string, actions: NotificationAction[] = [], onDismiss?: () => void): void {
	centre.push({ id: centreSeq++, kind, message, at: Date.now() });
	if (centre.length > 100) centre.shift(); // bounded, like the session log
	for (const listener of centreListeners) listener(centre.length);
	const container = document.getElementById('notifications')!;
	const body = el('div', 'message', [message]);
	const toast = el('div', 'notification', [icon(kind), el('div', 'body', [body])]);
	const close = actionButton('close', 'Clear Notification', () => dismiss());
	toast.appendChild(close);
	if (actions.length > 0) {
		const buttons = el('div', 'buttons');
		for (const action of actions) {
			const button = el('button', 'button', [action.label]);
			button.addEventListener('click', () => {
				action.run();
				dismiss();
			});
			buttons.appendChild(button);
		}
		toast.querySelector('.body')!.appendChild(buttons);
	}
	toast.querySelector<HTMLElement>('.body')!.style.flex = '1';
	toast.querySelector<HTMLElement>('.body')!.style.minWidth = '0';
	container.appendChild(toast);
	let timer: number | null = kind === 'info' && actions.length === 0 ? window.setTimeout(() => dismiss(), 8000) : null;
	function dismiss(): void {
		if (timer !== null) window.clearTimeout(timer);
		timer = null;
		toast.remove();
		onDismiss?.();
	}
	// Keep an info toast while the pointer is over it, then resume the auto-dismiss countdown.
	toast.addEventListener('mouseenter', () => {
		if (timer !== null) window.clearTimeout(timer);
		timer = null;
	});
	toast.addEventListener('mouseleave', () => {
		if (timer === null && kind === 'info' && actions.length === 0) {
			timer = window.setTimeout(() => dismiss(), 8000);
		}
	});
}

/* ---------- Menus (context menus, the title bar's menus, the "..." menus) ---------- */

export interface MenuItem {
	label: string;
	keybinding?: string;
	disabled?: boolean;
	checked?: boolean;
	submenu?: MenuEntry[];
	run?: () => void;
}
export type MenuEntry = MenuItem | 'separator';

const openMenus: HTMLElement[] = [];

export function closeContextMenu(): void {
	for (const menu of openMenus.splice(0)) menu.remove();
	document.querySelector('.menubar-item.open')?.classList.remove('open');
}

export function isMenuOpen(): boolean {
	return openMenus.length > 0;
}

/** Render one menu level at a position; submenus open to the right of their item on hover. */
function renderMenu(x: number, y: number, entries: MenuEntry[], level: number, minWidth: number): HTMLElement {
	const menu = el('div', 'context-menu');
	menu.setAttribute('role', 'menu');
	menu.style.minWidth = `${minWidth}px`;
	let openSubmenu: HTMLElement | null = null;
	const closeSubmenu = () => {
		if (openSubmenu) {
			const index = openMenus.indexOf(openSubmenu);
			if (index !== -1) openMenus.splice(index).forEach((m) => m.remove());
			openSubmenu = null;
		}
	};
	for (const entry of entries) {
		if (entry === 'separator') {
			menu.appendChild(el('div', 'separator'));
			continue;
		}
		const item = el('div', 'item' + (entry.disabled ? ' disabled' : ''), [
			el('span', 'check', [entry.checked ? icon('check') : null]),
			// Labels arrive as the registry's English text whatever built them - the title bar's
			// commands, a view's "..." entries, an extension's contribution - and localize here,
			// the one place every menu (and submenu) level renders through.
			el('span', 'label', [trText(entry.label)])
		]);
		item.setAttribute('role', 'menuitem');
		// The pointer and the arrow keys share one focus ring per menu level.
		item.addEventListener('mouseenter', () => {
			for (const other of menu.querySelectorAll('.item.focused')) other.classList.remove('focused');
			if (!entry.disabled) item.classList.add('focused');
		});
		if (entry.submenu) {
			item.appendChild(icon('chevron-right', 'submenu-indicator'));
			item.addEventListener('mouseenter', () => {
				closeSubmenu();
				const rect = item.getBoundingClientRect();
				openSubmenu = renderMenu(rect.right - 4, rect.top - 5, entry.submenu!, level + 1, 180);
			});
			item.addEventListener('click', (event) => event.stopPropagation());
		} else {
			if (entry.keybinding) item.appendChild(el('span', 'keybinding', [entry.keybinding]));
			item.addEventListener('mouseenter', closeSubmenu);
			item.addEventListener('click', (event) => {
				event.stopPropagation();
				closeContextMenu();
				entry.run?.();
			});
		}
		menu.appendChild(item);
	}
	document.getElementById('overlays')!.appendChild(menu);
	openMenus.push(menu);
	// Keep the menu on screen; a submenu that does not fit to the right opens to the left.
	const rect = menu.getBoundingClientRect();
	let left = x;
	if (left + rect.width > window.innerWidth - 4) left = level > 0 ? Math.max(4, x - rect.width - 180 + 8) : Math.max(4, window.innerWidth - rect.width - 4);
	menu.style.left = `${left}px`;
	menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - rect.height - 4))}px`;
	return menu;
}

export function showContextMenu(x: number, y: number, entries: MenuEntry[]): void {
	closeContextMenu();
	renderMenu(x, y, entries, 0, 180);
}

/** A menu dropped below an element (a title-bar menu, a "..." button). */
export function showMenuBelow(anchor: HTMLElement, entries: MenuEntry[], minWidth = 200): void {
	closeContextMenu();
	const rect = anchor.getBoundingClientRect();
	renderMenu(rect.left, rect.bottom, entries, 0, minWidth);
}

document.addEventListener('mousedown', (event) => {
	if (openMenus.length > 0 && !openMenus.some((menu) => menu.contains(event.target as Node)) && !(event.target as HTMLElement).closest('.menubar-item')) closeContextMenu();
});
/** VS Code's menu keyboard: Up/Down walk the enabled items of the innermost open menu (with
 *  wrap-around), Enter runs the focused one (or opens its submenu), Right opens a submenu,
 *  Left closes it, Escape closes everything. */
document.addEventListener('keydown', (event) => {
	if (openMenus.length === 0) return;
	if (event.key === 'Escape') {
		closeContextMenu();
		return;
	}
	const menu = openMenus[openMenus.length - 1]!;
	const items = Array.from(menu.querySelectorAll<HTMLElement>('.item:not(.disabled)'));
	if (items.length === 0) return;
	const current = items.findIndex((item) => item.classList.contains('focused'));
	const focus = (index: number) => {
		items.forEach((item, i) => item.classList.toggle('focused', i === index));
		items[index]?.scrollIntoView({ block: 'nearest' });
	};
	switch (event.key) {
		case 'ArrowDown':
			event.preventDefault();
			focus((current + 1) % items.length);
			break;
		case 'ArrowUp':
			event.preventDefault();
			focus((current - 1 + items.length) % items.length);
			break;
		case 'ArrowRight':
			if (current !== -1 && items[current]!.querySelector('.submenu-indicator')) {
				event.preventDefault();
				items[current]!.dispatchEvent(new MouseEvent('mouseenter'));
				const opened = openMenus[openMenus.length - 1];
				if (opened && opened !== menu) opened.querySelector<HTMLElement>('.item:not(.disabled)')?.classList.add('focused');
			}
			break;
		case 'ArrowLeft':
			if (openMenus.length > 1) {
				event.preventDefault();
				openMenus.pop()!.remove();
			}
			break;
		case 'Enter':
		case ' ':
			if (current !== -1) {
				event.preventDefault();
				const item = items[current]!;
				if (item.querySelector('.submenu-indicator')) item.dispatchEvent(new MouseEvent('mouseenter'));
				else item.click();
			}
			break;
	}
}, true);
window.addEventListener('blur', closeContextMenu);

/* ---------- Quick input ---------- */

export interface QuickPickItem {
	label: string;
	description?: string;
	detail?: string;
	icon?: string;
	value: string;
	/** Matched-character ranges in the label (rendered bold), as the fuzzy scorer reports them. */
	highlights?: [number, number][];
}

/** A large-list item source that filters off the keystroke path, as VS Code's quick access
 *  does: the scan runs in chunks, between which the input stays responsive; intermediate top
 *  rows arrive through `onPartial`; `isCancelled` aborts a scan a newer keystroke superseded. */
export interface QuickPickSource {
	query(query: string, onPartial: (items: QuickPickItem[]) => void, isCancelled: () => boolean): Promise<QuickPickItem[]>;
	/** Shown instead of the empty state while the source has nothing to show yet. */
	status?(): string | null;
}

export interface QuickInputOptions {
	title?: string;
	placeholder?: string;
	value?: string;
	/** The characters of `value` initially selected (a file name without its extension). */
	selection?: [number, number];
	validate?: (value: string) => string | null;
	/** A pick list: static, computed from what is typed, or a chunked QuickPickSource (Quick
	 *  Open's file list) whose results fill in progressively while the scan runs. */
	items?: QuickPickItem[] | ((query: string) => QuickPickItem[]) | QuickPickSource;
	/** With a pick list: Enter on free text (no match) resolves with the text itself. */
	allowFreeText?: boolean;
}

const MAX_PICK_ROWS = 60;

function isQuickPickSource(items: QuickPickItem[] | ((query: string) => QuickPickItem[]) | QuickPickSource): items is QuickPickSource {
	return typeof items === 'object' && items !== null && 'query' in items;
}

/** The label with its matched ranges bolded, as VS Code highlights picker matches. */
function applyLabelHighlights(parent: HTMLElement, label: string, ranges?: [number, number][]): void {
	parent.textContent = '';
	if (!ranges || ranges.length === 0) {
		parent.textContent = label;
		return;
	}
	let at = 0;
	for (const [start, end] of ranges) {
		if (start > at) parent.appendChild(document.createTextNode(label.slice(at, start)));
		parent.appendChild(el('b', '', [label.slice(start, end)]));
		at = end;
	}
	if (at < label.length) parent.appendChild(document.createTextNode(label.slice(at)));
}

/** Case-insensitive "every query word appears" match, as VS Code's quick pick filters. */
export function matchesQuery(text: string, query: string): boolean {
	const haystack = text.toLowerCase();
	return query.toLowerCase().split(/\s+/).filter((w) => w !== '').every((word) => haystack.includes(word));
}

/** VS Code's quick input at the top of the window: an input box, or a filterable pick list.
 *  Resolves with the value (a pick's `value`, or the typed text), or null on Escape. */
export function quickInput(options: QuickInputOptions): Promise<string | null> {
	return new Promise((resolve) => {
		const box = el('div', 'quick-input');
		const input = el('input', 'input');
		input.type = 'text';
		input.placeholder = options.placeholder ?? '';
		input.value = options.value ?? '';
		input.spellcheck = false;
		input.setAttribute('aria-label', options.title ?? options.placeholder ?? 'Input');
		const hint = el('div', 'hint');
		if (options.title) box.appendChild(el('div', 'title', [options.title]));
		box.appendChild(input);
		box.appendChild(hint);
		const list = options.items ? el('div', 'list') : null;
		if (list) box.appendChild(list);
		document.getElementById('overlays')!.appendChild(box);
		let focused = 0;
		let rows: { element: HTMLElement; item: QuickPickItem }[] = [];

		const finish = (value: string | null) => {
			generation += 1; // cancels any source scan still streaming into the list
			box.remove();
			document.removeEventListener('mousedown', onOutside, true);
			resolve(value);
		};
		const onOutside = (event: MouseEvent) => {
			if (!box.contains(event.target as Node)) finish(null);
		};
		document.addEventListener('mousedown', onOutside, true);

		// Row application is incremental: a row whose pick kept its value keeps its element and
		// only has its highlights refreshed, so progressive scans do not rebuild the list. The
		// generation counter cancels source scans a newer keystroke superseded.
		let generation = 0;
		let searching = false;
		let emptyState: HTMLElement | null = null;

		const emptyText = () => {
			if (searching) {
				const items = options.items;
				const status = items && isQuickPickSource(items) ? items.status?.() : null;
				return status ?? 'Searching…';
			}
			return input.value.trim() === '' ? 'No results' : 'No matching results';
		};

		const applyRows = (items: QuickPickItem[]) => {
			if (!list) return;
			emptyState?.remove();
			emptyState = null;
			for (let i = 0; i < items.length; i++) {
				const item = items[i]!;
				const existing = rows[i];
				if (existing && existing.item.value === item.value) {
					existing.item = item;
					applyLabelHighlights(existing.element.querySelector<HTMLElement>('.label')!, item.label, item.highlights);
				} else {
					const row = el('div', 'row', [
						item.icon ? icon(item.icon) : null,
						el('span', 'label'),
						item.description ? el('span', 'description', [item.description]) : null,
						item.detail ? el('span', 'decoration', [item.detail]) : null
					]);
					applyLabelHighlights(row.querySelector<HTMLElement>('.label')!, item.label, item.highlights);
					row.addEventListener('click', () => finish(item.value));
					if (existing) existing.element.replaceWith(row);
					else list.appendChild(row);
					rows[i] = { element: row, item };
				}
			}
			for (let i = rows.length - 1; i >= items.length; i--) rows[i]!.element.remove();
			rows.length = items.length;
			if (rows.length === 0) {
				emptyState = el('div', 'scm-empty', [emptyText()]);
				list.appendChild(emptyState);
			}
			focused = Math.min(focused, Math.max(0, rows.length - 1));
			highlight();
		};

		const runSource = async (source: QuickPickSource, query: string): Promise<void> => {
			const id = generation;
			try {
				const items = await source.query(
					query,
					(partial) => {
						if (id === generation) applyRows(partial);
					},
					() => id !== generation
				);
				if (id !== generation) return; // a newer keystroke superseded this scan
				searching = false;
				applyRows(items);
			} catch (error) {
				if (id !== generation) return;
				// A failed scan still settles the "Searching…" state; its rows are simply empty.
				searching = false;
				console.warn('quick input source failed', error);
				applyRows([]);
			}
		};

		const renderList = () => {
			if (!list || !options.items) return;
			generation += 1;
			focused = 0;
			if (isQuickPickSource(options.items)) {
				searching = true;
				if (rows.length === 0) {
					emptyState?.remove();
					emptyState = el('div', 'scm-empty', [emptyText()]);
					list.appendChild(emptyState);
				}
				void runSource(options.items, input.value.trim());
				return;
			}
			searching = false;
			const query = input.value.trim();
			const source = typeof options.items === 'function' ? options.items(query) : options.items.filter((item) => matchesQuery(item.label + ' ' + (item.description ?? ''), query));
			applyRows(source.slice(0, MAX_PICK_ROWS));
		};
		const highlight = () => {
			rows.forEach((row, index) => row.element.classList.toggle('focused', index === focused));
			rows[focused]?.element.scrollIntoView({ block: 'nearest' });
		};
		const validate = () => {
			const error = options.validate ? options.validate(input.value) : null;
			hint.textContent = error ?? '';
			hint.classList.toggle('error', error !== null);
			return error === null;
		};
		input.addEventListener('input', () => {
			validate();
			renderList();
		});
		input.addEventListener('keydown', (event) => {
			event.stopPropagation();
			if (event.key === 'Enter') {
				event.preventDefault();
				if (list) {
					const pick = rows[focused];
					if (pick) finish(pick.item.value);
					else if (options.allowFreeText && input.value.trim() !== '' && validate()) finish(input.value.trim());
					return;
				}
				if (validate()) finish(input.value);
			} else if (event.key === 'Escape') {
				event.preventDefault();
				finish(null);
			} else if (list && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
				event.preventDefault();
				if (rows.length === 0) return;
				focused = (focused + (event.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length;
				highlight();
			}
		});
		renderList();
		input.focus();
		if (options.selection) {
			input.setSelectionRange(options.selection[0], options.selection[1]);
		} else {
			input.select();
		}
	});
}

/** A pick list (branches, remotes, stashes, …); resolves with the chosen value or null. */
export function quickPick(items: QuickPickItem[], placeholder: string, title?: string): Promise<string | null> {
	return quickInput({ items, placeholder, title });
}

/** A modal confirmation, drawn as a notification with buttons; resolves with the chosen label. */
export function confirmDialog(message: string, primary: string, kind: NotificationKind = 'warning'): Promise<boolean> {
	return new Promise((resolve) => {
		let settled = false;
		const settle = (value: boolean) => {
			if (!settled) {
				settled = true;
				resolve(value);
			}
		};
		// The toast's own close button (or any other dismissal) also cancels.
		notify(kind, message, [
			{ label: primary, run: () => settle(true) },
			{ label: 'Cancel', run: () => settle(false) }
		], () => settle(false));
	});
}
