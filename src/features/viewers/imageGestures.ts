// The image viewer's pointer gesture recognizer: one Pointer Events state machine for the
// mouse, the pen and every finger — a drag pans, two fingers pinch (scale about their
// centroid while the centroid itself pans), a tap, a double tap and a long press are told
// apart by time and travel, and a released drag reports its fling velocity for the
// view's inertia. Coordinates are relative to the bound element's top-left corner.
//
// The recognizer owns no transform: it reports gestures, the view decides what they
// mean (a pan at fit scale is the gallery swipe, a pan when zoomed moves the image).

export type PointerKind = 'mouse' | 'pen' | 'touch';

export interface GestureHandlers {
	/** A confirmed single tap (touch: after the double-tap window lapsed; mouse: at once). */
	tap?(x: number, y: number, kind: PointerKind): void;
	doubleTap?(x: number, y: number, kind: PointerKind): void;
	longPress?(x: number, y: number, kind: PointerKind): void;
	/** A drag begins (one pointer, past the slop). */
	panStart?(x: number, y: number, kind: PointerKind): void;
	/** A drag moves: the step since the last report. */
	pan?(dx: number, dy: number, x: number, y: number): void;
	/** Two pointers: the scale step since the last report, about the centroid, and the
	 *  centroid's own move. */
	pinch?(factor: number, cx: number, cy: number, dx: number, dy: number): void;
	pinchStart?(cx: number, cy: number): void;
	/** The last pointer lifted after a drag or a pinch; the velocity is px/ms (zero after
	 *  a pinch, a cancel, or a finger that stopped before lifting). */
	end?(vx: number, vy: number, kind: PointerKind, cancelled: boolean): void;
}

const TOUCH_SLOP = 8;
const MOUSE_SLOP = 3;
const DOUBLE_TAP_MS = 280;
const DOUBLE_TAP_PX = 32;
const LONG_PRESS_MS = 520;
/** The velocity is read over this trailing window; an older sample means the finger rested. */
const VELOCITY_WINDOW_MS = 90;

interface Point { x: number; y: number }

export class GestureRecognizer {
	private readonly pointers = new Map<number, Point>();
	private mode: 'idle' | 'press' | 'pan' | 'pinch' = 'idle';
	private kind: PointerKind = 'mouse';
	private start: Point = { x: 0, y: 0 };
	private last: Point = { x: 0, y: 0 };
	private pinchDistance = 0;
	private pinchCentre: Point = { x: 0, y: 0 };
	private samples: { x: number; y: number; t: number }[] = [];
	private longTimer: number | undefined;
	private tapTimer: number | undefined;
	private lastTap: { x: number; y: number; t: number } | null = null;
	private longFired = false;
	private dragged = false;
	private readonly disposers: (() => void)[] = [];

	constructor(private readonly element: HTMLElement, private readonly handlers: GestureHandlers) {
		const on = <K extends keyof HTMLElementEventMap>(type: K, listener: (event: HTMLElementEventMap[K]) => void, options?: AddEventListenerOptions) => {
			element.addEventListener(type, listener as EventListener, options);
			this.disposers.push(() => element.removeEventListener(type, listener as EventListener, options));
		};
		on('pointerdown', (e) => this.down(e));
		on('pointermove', (e) => this.move(e));
		on('pointerup', (e) => this.up(e, false));
		on('pointercancel', (e) => this.up(e, true));
		on('lostpointercapture', (e) => { if (this.pointers.has(e.pointerId)) this.up(e, true); });
		// iOS Safari's own pinch (gesture events) would zoom the page under the image.
		const block = (e: Event) => e.preventDefault();
		for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
			element.addEventListener(type, block);
			this.disposers.push(() => element.removeEventListener(type, block));
		}
	}

	/** True while a drag or pinch is in flight — the click that ends one is not a click. */
	get active(): boolean {
		return this.mode === 'pan' || this.mode === 'pinch';
	}

	/** The last gesture moved: a click arriving now is the drag's own. */
	get wasDrag(): boolean {
		return this.dragged;
	}

	dispose(): void {
		window.clearTimeout(this.longTimer);
		window.clearTimeout(this.tapTimer);
		for (const dispose of this.disposers.splice(0)) dispose();
	}

	private local(e: PointerEvent): Point {
		const rect = this.element.getBoundingClientRect();
		return { x: e.clientX - rect.left, y: e.clientY - rect.top };
	}

	private down(e: PointerEvent): void {
		// Only the primary button drags with a mouse (the middle button pans too); the right
		// button belongs to the context menu.
		if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 1) return;
		const point = this.local(e);
		try {
			this.element.setPointerCapture(e.pointerId);
		} catch {
			// A synthetic event (tests) has no active pointer to capture.
		}
		this.pointers.set(e.pointerId, point);
		if (e.pointerType === 'mouse' && e.button === 1) e.preventDefault(); // no autoscroll
		if (this.pointers.size === 1) {
			this.kind = (e.pointerType || 'mouse') as PointerKind;
			this.mode = 'press';
			this.start = point;
			this.last = point;
			this.longFired = false;
			this.dragged = false;
			this.samples = [{ ...point, t: e.timeStamp }];
			window.clearTimeout(this.longTimer);
			// A tap still waiting out its double-tap window dies here: a new gesture (a
			// drag, a long press) must not fire it mid-way. `lastTap` stays — the lift's
			// double-tap check reads it.
			window.clearTimeout(this.tapTimer);
			if (this.kind !== 'mouse') {
				this.longTimer = window.setTimeout(() => {
					if (this.mode !== 'press' || this.pointers.size !== 1) return;
					this.longFired = true;
					this.mode = 'idle';
					this.handlers.longPress?.(this.start.x, this.start.y, this.kind);
				}, LONG_PRESS_MS);
			}
			return;
		}
		if (this.pointers.size === 2) {
			window.clearTimeout(this.longTimer);
			window.clearTimeout(this.tapTimer);
			this.lastTap = null;
			this.dragged = true;
			const [a, b] = [...this.pointers.values()] as [Point, Point];
			this.pinchDistance = Math.max(1, Math.hypot(b.x - a.x, b.y - a.y));
			this.pinchCentre = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
			this.mode = 'pinch';
			this.handlers.pinchStart?.(this.pinchCentre.x, this.pinchCentre.y);
		}
	}

	private move(e: PointerEvent): void {
		if (!this.pointers.has(e.pointerId)) return;
		const point = this.local(e);
		this.pointers.set(e.pointerId, point);
		if (this.mode === 'pinch' && this.pointers.size >= 2) {
			const [a, b] = [...this.pointers.values()] as [Point, Point];
			const distance = Math.max(1, Math.hypot(b.x - a.x, b.y - a.y));
			const centre = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
			const factor = distance / this.pinchDistance;
			this.handlers.pinch?.(factor, centre.x, centre.y, centre.x - this.pinchCentre.x, centre.y - this.pinchCentre.y);
			this.pinchDistance = distance;
			this.pinchCentre = centre;
			return;
		}
		if (this.pointers.size !== 1) return;
		if (this.mode === 'press') {
			const slop = this.kind === 'mouse' ? MOUSE_SLOP : TOUCH_SLOP;
			if (Math.hypot(point.x - this.start.x, point.y - this.start.y) < slop) return;
			window.clearTimeout(this.longTimer);
			this.mode = 'pan';
			this.dragged = true;
			this.lastTap = null;
			this.handlers.panStart?.(this.start.x, this.start.y, this.kind);
		}
		if (this.mode !== 'pan') return;
		this.handlers.pan?.(point.x - this.last.x, point.y - this.last.y, point.x, point.y);
		this.last = point;
		this.samples.push({ ...point, t: e.timeStamp });
		while (this.samples.length > 2 && e.timeStamp - this.samples[0]!.t > VELOCITY_WINDOW_MS) this.samples.shift();
	}

	private up(e: PointerEvent, cancelled: boolean): void {
		if (!this.pointers.has(e.pointerId)) return;
		this.pointers.delete(e.pointerId);
		try {
			this.element.releasePointerCapture(e.pointerId);
		} catch {
			// Never captured (a synthetic event).
		}
		if (this.mode === 'pinch') {
			if (this.pointers.size === 1) {
				// One finger stays: the gesture carries on as a pan from where it rests, never
				// jumping by the lifted finger's offset.
				const rest = [...this.pointers.values()][0]!;
				this.last = rest;
				this.samples = [{ ...rest, t: e.timeStamp }];
				this.mode = 'pan';
				this.handlers.panStart?.(rest.x, rest.y, this.kind);
				return;
			}
			if (this.pointers.size === 0) {
				this.mode = 'idle';
				this.handlers.end?.(0, 0, this.kind, cancelled);
				return;
			}
			// A finger of three (or more) lifted: the remaining pair is a fresh baseline, or
			// the next move would report the old pair's geometry as a one-shot jump.
			const [a, b] = [...this.pointers.values()] as [Point, Point];
			this.pinchDistance = Math.max(1, Math.hypot(b.x - a.x, b.y - a.y));
			this.pinchCentre = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
			return;
		}
		if (this.pointers.size > 0) return;
		window.clearTimeout(this.longTimer);
		const mode = this.mode;
		this.mode = 'idle';
		if (mode === 'pan') {
			let vx = 0;
			let vy = 0;
			const first = this.samples[0];
			const last = this.samples[this.samples.length - 1];
			if (!cancelled && first && last && last.t > first.t && e.timeStamp - last.t < VELOCITY_WINDOW_MS) {
				vx = (last.x - first.x) / (last.t - first.t);
				vy = (last.y - first.y) / (last.t - first.t);
			}
			this.handlers.end?.(vx, vy, this.kind, cancelled);
			return;
		}
		if (mode !== 'press' || cancelled || this.longFired) return;
		const point = this.start;
		const now = e.timeStamp;
		const previous = this.lastTap;
		if (previous && now - previous.t < DOUBLE_TAP_MS && Math.hypot(point.x - previous.x, point.y - previous.y) < DOUBLE_TAP_PX) {
			window.clearTimeout(this.tapTimer);
			this.lastTap = null;
			this.handlers.doubleTap?.(point.x, point.y, this.kind);
			return;
		}
		this.lastTap = { ...point, t: now };
		const kind = this.kind;
		if (kind === 'mouse') {
			this.handlers.tap?.(point.x, point.y, kind);
			return;
		}
		// A finger's single tap waits out the double-tap window: the tap toggles the chrome,
		// and a double tap must not flash it on and off first.
		window.clearTimeout(this.tapTimer);
		this.tapTimer = window.setTimeout(() => {
			this.lastTap = null;
			this.handlers.tap?.(point.x, point.y, kind);
		}, DOUBLE_TAP_MS);
	}
}
