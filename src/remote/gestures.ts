// Touch gestures for the remote workbench (docs/ggs-remote-plan.md §11.4), hand-written over
// Pointer Events: long-press (500 ms, 10 px tolerance) becomes the `contextmenu` event every
// view already handles — iOS Safari never fires one by itself; pinch reports a scale ratio;
// an edge swipe from the left goes back.
export const LONG_PRESS_MS = 500;
export const MOVE_TOLERANCE = 10;

/** Long-press anywhere under `root` dispatches a synthetic `contextmenu` at the finger. */
export function installLongPress(root: HTMLElement | Document = document): () => void {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let start: { x: number; y: number; target: EventTarget | null } | null = null;
	let fired = false;
	const cancel = () => {
		clearTimeout(timer);
		start = null;
	};
	const down = (event: Event) => {
		const e = event as PointerEvent;
		if (e.pointerType !== 'touch' && e.pointerType !== 'pen') return;
		fired = false;
		start = { x: e.clientX, y: e.clientY, target: e.target };
		timer = setTimeout(() => {
			if (!start) return;
			fired = true;
			// The tick that says "menu" before it appears (Android; iOS has no vibrate).
			navigator.vibrate?.(10);
			const menu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: start.x, clientY: start.y, button: 2 });
			start.target?.dispatchEvent(menu);
			start = null;
		}, LONG_PRESS_MS);
	};
	const move = (event: Event) => {
		const e = event as PointerEvent;
		if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > MOVE_TOLERANCE) cancel();
	};
	// The click that ends a long-press must not also activate the row under the finger.
	const click = (event: Event) => {
		if (fired) {
			event.preventDefault();
			event.stopPropagation();
			fired = false;
		}
	};
	root.addEventListener('pointerdown', down, true);
	root.addEventListener('pointermove', move, true);
	root.addEventListener('pointerup', cancel, true);
	root.addEventListener('pointercancel', cancel, true);
	root.addEventListener('click', click, true);
	return () => {
		root.removeEventListener('pointerdown', down, true);
		root.removeEventListener('pointermove', move, true);
		root.removeEventListener('pointerup', cancel, true);
		root.removeEventListener('pointercancel', cancel, true);
		root.removeEventListener('click', click, true);
	};
}

/** Two-finger pinch on `el`: `onScale` gets the distance ratio against the gesture's start. */
export function pinch(el: HTMLElement, onScale: (ratio: number) => void, onEnd?: (ratio: number) => void): () => void {
	const pointers = new Map<number, { x: number; y: number }>();
	let startDistance = 0;
	let ratio = 1;
	const distance = () => {
		const [a, b] = [...pointers.values()];
		return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
	};
	const down = (e: PointerEvent) => {
		pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
		if (pointers.size === 2) {
			startDistance = distance();
			ratio = 1;
		}
	};
	const move = (e: PointerEvent) => {
		if (!pointers.has(e.pointerId)) return;
		pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
		if (pointers.size === 2 && startDistance > 0) {
			ratio = distance() / startDistance;
			onScale(ratio);
		}
	};
	const up = (e: PointerEvent) => {
		if (pointers.size === 2) onEnd?.(ratio);
		pointers.delete(e.pointerId);
	};
	el.addEventListener('pointerdown', down);
	el.addEventListener('pointermove', move);
	el.addEventListener('pointerup', up);
	el.addEventListener('pointercancel', up);
	return () => {
		el.removeEventListener('pointerdown', down);
		el.removeEventListener('pointermove', move);
		el.removeEventListener('pointerup', up);
		el.removeEventListener('pointercancel', up);
	};
}

/** A right swipe starting within 24 px of the left edge and travelling 80 px goes back. */
export function swipeBack(el: HTMLElement, onBack: () => void): () => void {
	let start: { x: number; y: number } | null = null;
	const down = (e: PointerEvent) => {
		start = e.clientX <= 24 ? { x: e.clientX, y: e.clientY } : null;
	};
	const up = (e: PointerEvent) => {
		if (start && e.clientX - start.x > 80 && Math.abs(e.clientY - start.y) < 60) onBack();
		start = null;
	};
	el.addEventListener('pointerdown', down);
	el.addEventListener('pointerup', up);
	return () => {
		el.removeEventListener('pointerdown', down);
		el.removeEventListener('pointerup', up);
	};
}
