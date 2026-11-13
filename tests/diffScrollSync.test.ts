// The diff sides' scroll coupling (attachScrollSync, module 6/8): the merge view's spacers
// put corresponding content at equal pixel offsets on both panes, so the mirror is the raw
// offset — equal offsets keep the panes aligned and the two scrollbars level. The fraction
// form this replaced desynced the sides whenever their scrollable ranges momentarily
// differed, and its time lock swallowed every drag's tail (the gesture's last events always
// fell inside the window, freezing the mirror pane one gesture behind the thumb). These
// tests pin the offset form, the echo suppression that replaced the lock, and the clamps.

import { describe, expect, it } from 'vitest';
import { attachScrollSync } from '../src/features/editor/shared';

/** A pane stand-in: only the scrollDOM matters. Dimensions are stubbed because jsdom
 *  lays nothing out; scrollTop is plain state the tests read back. */
function pane(scrollHeight: number, clientHeight: number): { view: never; el: HTMLElement; fired: () => number } {
	const el = document.createElement('div');
	let top = 0;
	Object.defineProperty(el, 'scrollHeight', { get: () => scrollHeight });
	Object.defineProperty(el, 'clientHeight', { get: () => clientHeight });
	Object.defineProperty(el, 'scrollTop', { get: () => top, set: (v: number) => { top = v; } });
	let count = 0;
	const view = { scrollDOM: el } as never;
	return { view, el, fired: () => ++count };
}

function scroll(el: HTMLElement): void {
	el.dispatchEvent(new Event('scroll'));
}

describe('the diff sides\u2019 scroll sync', () => {
	it('mirrors the same viewport offset, not a fraction of the far side\u2019s own range', () => {
		const a = pane(5000, 400);
		const b = pane(5000, 400);
		const detach = attachScrollSync(a.view, b.view);
		a.el.scrollTop = 1000;
		scroll(a.el);
		expect(b.el.scrollTop).toBe(1000);
		// The far pane's own scrollable range differs (a transient spacer rebuild): the
		// offset still crosses verbatim — the fraction form landed it at 1000/4600*8600.
		const taller = pane(9000, 400);
		detach();
		const detach2 = attachScrollSync(a.view, taller.view);
		a.el.scrollTop = 2000;
		scroll(a.el);
		expect(taller.el.scrollTop).toBe(2000);
		detach2();
	});

	it('a written pane\u2019s own scroll event is an echo and does not bounce back', () => {
		const a = pane(5000, 400);
		const b = pane(5000, 400);
		const detach = attachScrollSync(a.view, b.view);
		a.el.scrollTop = 1000;
		scroll(a.el);
		expect(b.el.scrollTop).toBe(1000);
		// The write's echo fires on b: without suppression it would rewrite a (whose
		// scroll would rewrite b — the old lock existed for this).
		scroll(b.el);
		expect(a.el.scrollTop).toBe(1000);
		// The expectation is spent: a user scrolling b to the very same value mirrors.
		b.el.scrollTop = 1500;
		scroll(b.el);
		expect(a.el.scrollTop).toBe(1500);
		detach();
	});

	it('a drag\u2019s every event mirrors — the tail is never dropped', () => {
		const a = pane(5000, 400);
		const b = pane(5000, 400);
		const detach = attachScrollSync(a.view, b.view);
		// The old 50 ms lock dropped every event inside the window; a drag's final event
		// always fell there, leaving b one gesture behind a.
		for (const top of [200, 400, 600, 800, 1000, 1200]) {
			a.el.scrollTop = top;
			scroll(a.el);
		}
		expect(b.el.scrollTop).toBe(1200);
		detach();
	});

	it('the far pane clamps to its own range without yanking the pane being driven', () => {
		const a = pane(5000, 400);
		const b = pane(500, 400);
		const detach = attachScrollSync(a.view, b.view);
		a.el.scrollTop = 1000;
		scroll(a.el);
		expect(b.el.scrollTop).toBe(100);
		// The clamped write's echo stops there: a is not dragged to b's clamp.
		scroll(b.el);
		expect(a.el.scrollTop).toBe(1000);
		detach();
	});

	it('mirrors both ways and the detach removes the listeners', () => {
		const a = pane(5000, 400);
		const b = pane(5000, 400);
		const detach = attachScrollSync(a.view, b.view);
		b.el.scrollTop = 700;
		scroll(b.el);
		expect(a.el.scrollTop).toBe(700);
		detach();
		a.el.scrollTop = 900;
		scroll(a.el);
		expect(b.el.scrollTop).toBe(700);
	});
});
