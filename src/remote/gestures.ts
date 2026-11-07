// Touch gestures for the remote workbench (docs/ggs-remote-plan.md §11.4), hand-written over
// Pointer Events: long-press (500 ms, 10 px tolerance) becomes the `contextmenu` event every
// view already handles — iOS Safari never fires one by itself; pinch reports a scale ratio.
// The horizontal swipes that page the bottom navigation's destinations are swipeNav.ts (the
// shell's own layer over the page column, with its follow-finger animation); the browser's
// edge-swipe back stays the system's, turned in-app by backStack's stay guard.
export const LONG_PRESS_MS = 500;
export const MOVE_TOLERANCE = 10;

/** Long-press anywhere under `root` dispatches a synthetic `contextmenu` at the finger. */
export function installLongPress(root: HTMLElement | Document = document): () => void {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let start: { x: number; y: number; target: EventTarget | null } | null = null;
	let fired = false;
	/** The pointers currently on the glass: a second finger is the pinch forming, never a
	 *  longer press — the first finger's timer dies the moment it lands (left alone it
	 *  would fire the context menu mid-pinch, at the first finger's stale coordinates). */
	const pointers = new Set<number>();
	const down = (event: Event) => {
		const e = event as PointerEvent;
		if (e.pointerType !== 'touch' && e.pointerType !== 'pen') return;
		clearTimeout(timer);
		pointers.add(e.pointerId);
		fired = false;
		if (pointers.size !== 1) {
			// A pinch in the making: no finger of it arms a long-press, and none does
			// until a fresh sole finger lands.
			start = null;
			return;
		}
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
	const disarm = (): void => {
		clearTimeout(timer);
		start = null;
	};
	const move = (event: Event) => {
		const e = event as PointerEvent;
		if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > MOVE_TOLERANCE) disarm();
	};
	// The click that ends a long-press must not also activate the row under the finger.
	const click = (event: Event) => {
		if (fired) {
			event.preventDefault();
			event.stopPropagation();
			fired = false;
		}
	};
	const lift = (event: Event) => {
		pointers.delete((event as PointerEvent).pointerId);
		disarm();
	};
	root.addEventListener('pointerdown', down, true);
	root.addEventListener('pointermove', move, true);
	root.addEventListener('pointerup', lift, true);
	root.addEventListener('pointercancel', lift, true);
	root.addEventListener('click', click, true);
	return () => {
		root.removeEventListener('pointerdown', down, true);
		root.removeEventListener('pointermove', move, true);
		root.removeEventListener('pointerup', lift, true);
		root.removeEventListener('pointercancel', lift, true);
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
