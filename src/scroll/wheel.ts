// The wheel event as Zed reads it: a delta in lines (a mouse wheel's notches) or in pixels
// (a trackpad's fingers), and the trackpad gesture's axis lock. Pure functions over the
// event's numbers — the DOM listener that applies them to a model is input.ts.
//
// Zed: `ScrollDelta` (gpui interactive.rs), `OngoingScroll` (gpui gestures.rs), and the
// Windows platform's `handle_mouse_wheel_msg` (gpui_windows events.rs), where one notch of
// WHEEL_DELTA becomes `ScrollDelta::Lines(SPI_GETWHEELSCROLLLINES)` — the system's own
// "lines per notch" setting, 3 by default.

export interface ScrollDelta {
	/** `lines` is a mouse wheel: whole notches × the system's lines per notch. `pixels` is a
	 *  trackpad: the fingers' distance, to be divided by the row height. */
	kind: 'lines' | 'pixels';
	x: number;
	y: number;
}

/** Chromium's pixel unit for one system wheel line on Windows: a WHEEL_DELTA notch at the
 *  default three lines per notch is 100 px of `deltaY`, so dividing by 100/3 recovers the
 *  system setting exactly — the same number Zed's Windows platform reads through
 *  `SPI_GETWHEELSCROLLLINES`. */
export const PX_PER_WHEEL_LINE = 100 / 3;

/** A Firefox `DOM_DELTA_PAGE` delta, in lines: rare (Firefox with the system's "one screen
 *  at a time" wheel setting), taken as a generous screen. */
const LINES_PER_WHEEL_PAGE = 20;

/** Chromium's legacy `wheelDeltaY`: a mouse notch is ±120, a trackpad any value. */
interface LegacyWheelEvent {
	wheelDeltaY?: number;
	wheelDeltaX?: number;
}

/** Whether the event came from a mouse wheel — its notches speak system lines — or from a
 *  trackpad, whose deltas are the fingers' pixels. Chromium tags a wheel notch with a
 *  `wheelDeltaY` that is a multiple of 120; where that legacy field is missing, a `deltaY`
 *  that is a whole multiple of the platform line unit is a notch too. */
function isWheelNotch(event: WheelEvent): boolean {
	const legacy = event as WheelEvent & LegacyWheelEvent;
	const wheelDelta = legacy.wheelDeltaY ?? legacy.wheelDeltaX;
	if (typeof wheelDelta === 'number' && wheelDelta !== 0) return wheelDelta % 120 === 0;
	const delta = event.deltaY !== 0 ? event.deltaY : event.deltaX;
	if (delta === 0) return false;
	const lines = delta / PX_PER_WHEEL_LINE;
	return Math.abs(lines - Math.round(lines)) < 1e-6;
}

/** The event's delta in Zed's terms. Line mode (`deltaMode === 1`, Firefox) is lines already;
 *  a Chromium mouse notch is converted back to the system's lines per notch; anything else
 *  (a trackpad, a high-resolution wheel) is pixels. */
export function wheelToDelta(event: WheelEvent): ScrollDelta {
	if (event.deltaMode === 1) return { kind: 'lines', x: event.deltaX, y: event.deltaY };
	if (event.deltaMode === 2) return { kind: 'lines', x: event.deltaX * LINES_PER_WHEEL_PAGE, y: event.deltaY * LINES_PER_WHEEL_PAGE };
	if (isWheelNotch(event)) return { kind: 'lines', x: event.deltaX / PX_PER_WHEEL_LINE, y: event.deltaY / PX_PER_WHEEL_LINE };
	return { kind: 'pixels', x: event.deltaX, y: event.deltaY };
}

/** The delta in pixels at a given row height and column width (Zed's `mouse.rs`: lines
 *  multiply by the line height and the glyph width, pixels pass through). */
export function deltaToPixels(delta: ScrollDelta, rowHeight: number, columnWidth = rowHeight / 2): { x: number; y: number } {
	if (delta.kind === 'pixels') return { x: delta.x, y: delta.y };
	return { x: delta.x * columnWidth, y: delta.y * rowHeight };
}

/** Two deltas of one frame folded into one (`ScrollDelta::coalesce`): a continuing direction
 *  adds up, a reversal starts over from the new delta. Deltas of different kinds do not
 *  mix; the later one wins. */
export function coalesceDeltas(first: ScrollDelta | null, second: ScrollDelta): ScrollDelta {
	if (!first || first.kind !== second.kind) return second;
	const fold = (a: number, b: number): number => (Math.sign(a) === Math.sign(b) ? a + b : b);
	return { kind: second.kind, x: fold(first.x, second.x), y: fold(first.y, second.y) };
}

/** Events closer together than this belong to one trackpad gesture (`SCROLL_EVENT_SEPARATION`). */
const SCROLL_EVENT_SEPARATION_MS = 28;
/** The cross-axis movement must exceed the locked axis' by this factor to unlock it. */
const UNLOCK_PERCENT = 1.9;
/** ...and be at least this many pixels, so a tremor never unlocks. */
const UNLOCK_LOWER_BOUND = 6;

export type ScrollAxis = 'x' | 'y';

/** The dominant axis across the events of one trackpad gesture (gpui's `OngoingScroll`): a
 *  diagonal swipe that starts mostly vertical stays vertical, so text does not creep
 *  sideways while the finger scrolls down. The DOM has no touch phases, so gestures are
 *  delimited by the timeout alone. Applies to pixel deltas only; a mouse notch is one axis. */
export class OngoingScroll {
	private lastEvent: number | null = null;
	private axis: ScrollAxis | null = null;

	/** Zero the delta's minor axis while the gesture is locked. `now` is injectable for tests. */
	filter(delta: { x: number; y: number }, now: number = performance.now()): { x: number; y: number } {
		const x = Math.abs(delta.x);
		const y = Math.abs(delta.y);
		if (x === 0 && y === 0) return delta;
		const startsNewGesture = this.lastEvent === null || now - this.lastEvent >= SCROLL_EVENT_SEPARATION_MS;
		let axis = this.axis;
		if (startsNewGesture) {
			axis = x <= y ? 'y' : 'x';
		} else if (Math.max(x, y) >= UNLOCK_LOWER_BOUND) {
			if (axis === 'y' && x > y && x >= y * UNLOCK_PERCENT) axis = null;
			else if (axis === 'x' && y > x && y >= x * UNLOCK_PERCENT) axis = null;
		}
		this.lastEvent = now;
		this.axis = axis;
		if (axis === 'y') return { x: 0, y: delta.y };
		if (axis === 'x') return { x: delta.x, y: 0 };
		return delta;
	}
}
