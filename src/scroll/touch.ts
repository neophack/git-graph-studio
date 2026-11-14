// The touch half of the row-scroll vocabulary (scroll/input.ts serves the wheel and the
// page keys; this serves the finger): a pointer drag over a row surface feeds the model
// pixel-for-pixel — the wheel's trackpad path — and the lift's velocity coasts out in a
// decay loop, the momentum a natively scrolling list has and a model-positioned one must
// supply itself. Horizontal is the browser's (`touch-action: pan-x`, the payload column's
// own overflow); mouse and wheel are untouched. Lives in scroll/ because every model-
// scrolled surface browses with it — the CAN trace and the data table alike — and the
// scroll layer is the one both modules already share.
//
// Beside it, the pointer form factor the surfaces' touch row heights key on: whether the
// pointer driving this page is a finger. A coarse-pointer override (the replica-viewer
// hook responsive.ts carries for the PC window a phone drives; tests use it too) wins
// over the media query.

import type { ScrollModel } from './model';
import type { Disposable } from './input';

let pointerOverride: 'coarse' | 'fine' | null = null;

export function setCanPointerOverride(kind: 'coarse' | 'fine' | null): void {
	pointerOverride = kind;
}

export function canCoarsePointer(): boolean {
	if (pointerOverride !== null) return pointerOverride === 'coarse';
	return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
}

/** A finger over a row surface scrolls it: one pointer's vertical drag feeds the row
 *  model pixel-for-pixel, and the lift's velocity coasts out in a decay loop. */
export function attachTouchScroll(element: HTMLElement, model: ScrollModel): Disposable {
	let dragging = false;
	/** The finger that owns the drag: a second finger's moves must not re-anchor it (one
	 *  large dy from the new finger's position is a visible jump) nor end it early. */
	let pointerId: number | null = null;
	let lastY = 0;
	let lastT = 0;
	let velocity = 0; // px/ms, finger-positive down
	let coasting = 0;
	const stopCoast = (): void => {
		if (coasting) cancelAnimationFrame(coasting);
		coasting = 0;
	};
	const coast = (): void => {
		coasting = requestAnimationFrame(() => {
			coasting = 0;
			if (Math.abs(velocity) < 0.02) return;
			model.applyWheel({ kind: 'pixels', x: 0, y: -velocity * 16 }, 1);
			velocity *= 0.95;
			coast();
		});
	};
	const down = (event: PointerEvent): void => {
		if (event.pointerType === 'mouse') return;
		// The FIRST finger owns the drag: a second one landing neither takes it over (its
		// position would re-anchor the scroll) nor ends it early at its own lift.
		if (dragging) return;
		stopCoast();
		pointerId = event.pointerId;
		dragging = true;
		lastY = event.clientY;
		lastT = event.timeStamp;
		velocity = 0;
	};
	const move = (event: PointerEvent): void => {
		if (!dragging || event.pointerId !== pointerId) return;
		const dt = event.timeStamp - lastT;
		const dy = event.clientY - lastY;
		model.applyWheel({ kind: 'pixels', x: 0, y: -dy }, 1);
		// The trailing speed, smoothed — one noisy sample must not fling the list. A
		// zero-delta sample (same stamp) still scrolls; it just carries no velocity.
		if (dt > 0) velocity = velocity * 0.7 + (dy / dt) * 0.3;
		lastY = event.clientY;
		lastT = event.timeStamp;
	};
	const up = (event: PointerEvent): void => {
		if (!dragging || event.pointerId !== pointerId) return;
		dragging = false;
		pointerId = null;
		// A finger that rested before lifting (the velocity window went stale) does not coast.
		if (event.timeStamp - lastT > 90) velocity = 0;
		if (Math.abs(velocity) > 0.05) coast();
	};
	element.addEventListener('pointerdown', down);
	element.addEventListener('pointermove', move);
	element.addEventListener('pointerup', up);
	element.addEventListener('pointercancel', up);
	return {
		dispose(): void {
			stopCoast();
			element.removeEventListener('pointerdown', down);
			element.removeEventListener('pointermove', move);
			element.removeEventListener('pointerup', up);
			element.removeEventListener('pointercancel', up);
		}
	};
}
