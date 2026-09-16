// The row scroll model the file viewers share (src/scroll/): Zed's scroll manager in
// TypeScript. The position is a row index the model owns; these tests pin the clamping,
// the wheel's arithmetic, the page distance, the autoscroll strategies, the trackpad axis
// lock and the drawn scrollbar's geometry — against the numbers Zed's own tests and
// defaults use.

import { describe, expect, it } from 'vitest';

import { scrollAmountLines } from '../src/scroll/amount';
import { attachPageKeys, attachWheel } from '../src/scroll/input';
import { ScrollModel } from '../src/scroll/model';
import { MIN_THUMB_PX, Scrollbar, scrollbarGeometry } from '../src/scroll/scrollbar';
import { coalesceDeltas, OngoingScroll, PX_PER_WHEEL_LINE, wheelToDelta } from '../src/scroll/wheel';
import { key } from './helpers';

/** A model of `rows` rows, 19px each, in a 380px viewport: 20 lines visible. */
function model(rows = 1000, viewport = 380): ScrollModel {
	const m = new ScrollModel(19, rows);
	m.setViewport(viewport);
	return m;
}

describe('the scroll amount', () => {
	it('a full page is the viewport less one anchor line, truncated to whole lines', () => {
		// Zed's ScrollAmount::lines: `visible_line_count - 1` for a full page, then trunc.
		expect(scrollAmountLines({ kind: 'page', count: 1 }, 20)).toBe(19);
		expect(scrollAmountLines({ kind: 'page', count: -1 }, 20)).toBe(-19);
		expect(scrollAmountLines({ kind: 'page', count: 1 }, 20.7)).toBe(19);
		// A half page keeps the whole viewport as its base.
		expect(scrollAmountLines({ kind: 'page', count: 0.5 }, 20)).toBe(10);
		expect(scrollAmountLines({ kind: 'line', count: 3 }, 20)).toBe(3);
	});
});

describe('the scroll model', () => {
	it('clamps the top to the last row with onePage, and to the last screen with off', () => {
		const m = model(100);
		expect(m.visibleLines).toBe(20);
		expect(m.maxScrollTop()).toBe(99); // Zed: scroll_beyond_last_line = one_page → max_row
		expect(m.setTop(500)).toBe(true);
		expect(m.top).toBe(99);
		expect(m.setTop(-5)).toBe(true);
		expect(m.top).toBe(0);
		m.beyondLastLine = 'off';
		expect(m.maxScrollTop()).toBe(80); // max_row - height_in_lines + 1
		m.setTop(500);
		expect(m.top).toBe(80);
	});

	it('a row count change or a viewport change reclamps and reports a layout move', () => {
		const m = model(100);
		const heard: string[] = [];
		m.onChange((_top, reason) => heard.push(reason));
		m.setTop(90);
		m.setRowCount(50);
		expect(m.top).toBe(49);
		expect(heard).toEqual(['user', 'layout']);
		// Growing the document never moves the view.
		m.setRowCount(5_000_000);
		expect(m.top).toBe(49);
		expect(heard.length).toBe(2);
		expect(m.maxScrollTop()).toBe(4_999_999);
	});

	it('the wheel lands one system notch at once: lines × row height × sensitivity', () => {
		const m = model();
		// A mouse notch at the system's three lines per notch.
		expect(m.applyWheel({ kind: 'lines', x: 0, y: 3 })).toBe(true);
		expect(m.top).toBe(3);
		m.applyWheel({ kind: 'lines', x: 0, y: 3 }, 4); // Alt: fast_scroll_sensitivity 4
		expect(m.top).toBe(15);
		m.applyWheel({ kind: 'lines', x: 0, y: -3 });
		expect(m.top).toBe(12);
		// A trackpad's pixels divide by the row height, fractions kept.
		m.applyWheel({ kind: 'pixels', x: 0, y: 9.5 });
		expect(m.top).toBeCloseTo(12.5);
		// The edge swallows the notch and says so.
		m.setTop(0);
		expect(m.applyWheel({ kind: 'lines', x: 0, y: -3 })).toBe(false);
	});

	it('a page is visible − 1 rows; N pages are exactly N × that with no drift', () => {
		const m = model(10_000);
		for (let i = 0; i < 20; i++) m.scrollScreen({ kind: 'page', count: 1 });
		expect(m.top).toBe(20 * 19);
		for (let i = 0; i < 20; i++) m.scrollScreen({ kind: 'page', count: -1 });
		expect(m.top).toBe(0);
	});

	it('visibleRange covers the rows the viewport cuts through, plus the overscan', () => {
		const m = model(1000);
		m.setTop(10.5);
		expect(m.visibleRange()).toEqual({ first: 10, last: 31 }); // ceil(10.5 + 20) = 31
		expect(m.visibleRange(10)).toEqual({ first: 0, last: 41 });
		m.setTop(999);
		expect(m.visibleRange()).toEqual({ first: 999, last: 999 });
		expect(new ScrollModel(19, 0).visibleRange()).toEqual({ first: 0, last: -1 });
	});

	it('rowTop snaps the top to whole pixels so text never sits on a half pixel', () => {
		const m = model(1000);
		m.setTop(10.5);
		expect(m.rowTop(10)).toBe(10 * 19 - Math.round(10.5 * 19)); // -10
		expect(m.rowTop(11)).toBe(9);
		expect(m.rowAt(9)).toBe(10);
		expect(m.rowAt(30)).toBe(12);
	});

	describe('autoscroll', () => {
		it('fit moves nothing while the row sits inside the margin', () => {
			const m = model(1000);
			m.setTop(100);
			// Rows 103..116 are inside the 3-row margin of a 20-line viewport.
			expect(m.autoscroll(103)).toBe(false);
			expect(m.autoscroll(116)).toBe(false);
			expect(m.top).toBe(100);
		});

		it('fit scrolls the least that brings the row and its margin back', () => {
			const m = model(1000);
			m.setTop(100);
			// Row 118: bottom 119 + margin 3 = 122 ≥ end 120 → top = 122 − 20 = 102.
			expect(m.autoscroll(118)).toBe(true);
			expect(m.top).toBe(102);
			// Row 101 from top 102: 101 − 3 = 98 < 102 → top = 98.
			m.autoscroll(101);
			expect(m.top).toBe(98);
			// A row far below lands at the bottom margin, not centred.
			m.autoscroll(500);
			expect(m.top).toBe(501 + 3 - 20);
			// The margin never exceeds half the viewport (a 4-line viewport keeps 1).
			const small = new ScrollModel(19, 1000);
			small.setViewport(19 * 4);
			small.autoscroll(50);
			expect(small.top).toBe(51 + 1 - 4);
		});

		it('center, focused, top and bottom place the row where they say', () => {
			const m = model(1000);
			m.autoscroll(500, 'center');
			expect(m.top).toBe(500 - 9); // floor((20 − 1) / 2)
			m.autoscroll(500, 'focused');
			expect(m.top).toBe(497);
			m.autoscroll(500, 'top');
			expect(m.top).toBe(500);
			m.autoscroll(500, 'bottom');
			expect(m.top).toBe(481);
			// Never above the first row, never past the clamp.
			m.autoscroll(2, 'center');
			expect(m.top).toBe(0);
			m.autoscroll(5000, 'top');
			expect(m.top).toBe(999);
		});

		it('reports its move as an autoscroll, not a user scroll', () => {
			const m = model(1000);
			const heard: string[] = [];
			m.onChange((_top, reason) => heard.push(reason));
			m.autoscroll(500, 'center');
			expect(heard).toEqual(['autoscroll']);
		});
	});
});

describe('the wheel delta', () => {
	it('a Chromium mouse notch is the system lines per notch, a trackpad is pixels', () => {
		// 100px of deltaY at three lines per notch (Windows default) is three lines.
		expect(wheelToDelta(new WheelEvent('wheel', { deltaY: 100, deltaMode: 0 }))).toEqual({ kind: 'lines', x: 0, y: 3 });
		expect(wheelToDelta(new WheelEvent('wheel', { deltaY: -200, deltaMode: 0 })).y).toBe(-6);
		// A system set to one line per notch.
		expect(wheelToDelta(new WheelEvent('wheel', { deltaY: PX_PER_WHEEL_LINE, deltaMode: 0 })).y).toBeCloseTo(1);
		// A trackpad's odd pixel count.
		expect(wheelToDelta(new WheelEvent('wheel', { deltaY: 7.25, deltaMode: 0 }))).toEqual({ kind: 'pixels', x: 0, y: 7.25 });
		// Firefox's line mode is lines already.
		expect(wheelToDelta(new WheelEvent('wheel', { deltaY: 3, deltaMode: 1 }))).toEqual({ kind: 'lines', x: 0, y: 3 });
	});

	it('the legacy wheelDeltaY tags a notch whatever the pixel count', () => {
		const notch = new WheelEvent('wheel', { deltaY: 87, deltaMode: 0 });
		Object.defineProperty(notch, 'wheelDeltaY', { value: -120 });
		expect(wheelToDelta(notch).kind).toBe('lines');
		const pad = new WheelEvent('wheel', { deltaY: 100, deltaMode: 0 });
		Object.defineProperty(pad, 'wheelDeltaY', { value: -90 });
		expect(wheelToDelta(pad).kind).toBe('pixels');
	});

	it('coalesces a continuing direction and restarts on a reversal', () => {
		expect(coalesceDeltas({ kind: 'lines', x: 0, y: 3 }, { kind: 'lines', x: 0, y: 3 })).toEqual({ kind: 'lines', x: 0, y: 6 });
		expect(coalesceDeltas({ kind: 'lines', x: 0, y: 3 }, { kind: 'lines', x: 0, y: -3 })).toEqual({ kind: 'lines', x: 0, y: -3 });
		expect(coalesceDeltas({ kind: 'lines', x: 0, y: 3 }, { kind: 'pixels', x: 0, y: 5 })).toEqual({ kind: 'pixels', x: 0, y: 5 });
		expect(coalesceDeltas(null, { kind: 'pixels', x: 1, y: 5 })).toEqual({ kind: 'pixels', x: 1, y: 5 });
	});

	it('a trackpad gesture locks to its dominant axis and unlocks on a clear turn', () => {
		// gpui gestures.rs's own cases: a vertical start zeroes x, a strong horizontal
		// movement (≥ 1.9× and ≥ 6px) unlocks, a pause starts a new gesture.
		const gesture = new OngoingScroll();
		expect(gesture.filter({ x: 2, y: 10 }, 0)).toEqual({ x: 0, y: 10 });
		expect(gesture.filter({ x: 4, y: 3 }, 10)).toEqual({ x: 0, y: 3 }); // under the unlock bound
		expect(gesture.filter({ x: 20, y: 4 }, 20)).toEqual({ x: 20, y: 4 }); // unlocked
		expect(gesture.filter({ x: 20, y: 1 }, 100)).toEqual({ x: 20, y: 0 }); // a new gesture, horizontal
	});
});

describe('the wheel and page keys over a surface', () => {
	it('a wheel event lands as a model move, Alt fast, Ctrl passed through', () => {
		const m = model(1000);
		const surface = document.createElement('div');
		document.body.appendChild(surface);
		attachWheel(surface, m, { sensitivity: () => 1, fastSensitivity: () => 4 });
		const notch = (init: WheelEventInit) => {
			const event = new WheelEvent('wheel', { deltaMode: 0, bubbles: true, cancelable: true, ...init });
			surface.dispatchEvent(event);
			return event;
		};
		expect(notch({ deltaY: 100 }).defaultPrevented).toBe(true);
		expect(m.top).toBe(3);
		notch({ deltaY: 100, altKey: true });
		expect(m.top).toBe(15);
		expect(notch({ deltaY: 100, ctrlKey: true }).defaultPrevented).toBe(false);
		expect(m.top).toBe(15);
		// Shift turns a notch horizontal: the vertical position stands.
		notch({ deltaY: 100, shiftKey: true });
		expect(m.top).toBe(15);
	});

	it('PageDown / PageUp move a page each, chords pass through', () => {
		const m = model(1000);
		const surface = document.createElement('div');
		document.body.appendChild(surface);
		attachPageKeys(surface, m);
		expect(surface.tabIndex).toBe(0);
		expect(key(surface, 'PageDown').defaultPrevented).toBe(true);
		expect(m.top).toBe(19);
		key(surface, 'PageDown', { shiftKey: true });
		expect(m.top).toBe(38);
		expect(key(surface, 'PageDown', { ctrlKey: true }).defaultPrevented).toBe(false);
		expect(m.top).toBe(38);
		key(surface, 'PageUp');
		key(surface, 'PageUp');
		key(surface, 'PageUp');
		expect(m.top).toBe(0);
	});
});

describe('the drawn scrollbar', () => {
	it('sizes the thumb to the viewport share, never under the grab, and maps rows to track pixels', () => {
		const m = model(100);
		// 20 of 119 (99 scrollable + 20 visible) on a 380px track → 63.9px thumb.
		const g = scrollbarGeometry(m, 380)!;
		expect(g.thumb).toBeCloseTo(380 * 20 / 119);
		expect(g.pxPerRow).toBeCloseTo((380 - g.thumb) / 99);
		expect(g.offset).toBe(0);
		m.setTop(99);
		expect(scrollbarGeometry(m, 380)!.offset).toBeCloseTo(380 - g.thumb);
		// A five-million-row document keeps a 25px grab.
		const huge = model(5_000_000);
		expect(scrollbarGeometry(huge, 380)!.thumb).toBe(MIN_THUMB_PX);
		// Even a short document scrolls its last row to the top (onePage); only one with
		// nothing below its first row draws no thumb.
		expect(scrollbarGeometry(model(10), 380)).not.toBeNull();
		expect(scrollbarGeometry(model(1), 380)).toBeNull();
		const flush = model(10);
		flush.beyondLastLine = 'off';
		expect(scrollbarGeometry(flush, 380)).toBeNull();
	});

	it('a drag maps the pointer back to rows; a track press pages', () => {
		const m = model(1000);
		const host = document.createElement('div');
		document.body.appendChild(host);
		const bar = new Scrollbar(host, m);
		bar.setTrackLength(380);
		const g = bar.geometry()!;
		const thumb = bar.root.querySelector<HTMLElement>('.scrollbar-thumb')!;
		expect(thumb.style.height).toBe(`${g.thumb}px`);
		const pointer = (target: Element, type: string, clientY: number) =>
			target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientY, button: 0 }));
		// Grab the thumb 5px in and drag it 100 track pixels down.
		pointer(thumb, 'pointerdown', 5);
		pointer(bar.root, 'pointermove', 105);
		expect(m.top).toBeCloseTo(100 / g.pxPerRow);
		expect(bar.root.classList.contains('dragging')).toBe(true);
		pointer(bar.root, 'pointerup', 105);
		expect(bar.root.classList.contains('dragging')).toBe(false);
		// The thumb followed.
		expect(thumb.style.transform).toBe(`translateY(${Math.round(m.top * g.pxPerRow)}px)`);
		// A press on the track below the thumb pages down; above it pages up.
		const before = m.top;
		pointer(bar.root, 'pointerdown', 379);
		expect(m.top).toBe(before + 19);
		pointer(bar.root, 'pointerdown', 0);
		expect(m.top).toBe(before);
		bar.dispose();
		expect(host.querySelector('.scrollbar')).toBeNull();
	});
});
