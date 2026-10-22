// A native window move — the title bar's drag region — holds the pointer inside the OS's
// own move loop: the page sees no events while it runs, and every git refresh the
// workbench would start mid-drag competes with that loop for CPU and stutters the drag.
// Two marks cover a drag whole, and neither needs an end event (the native loop never
// sends one):
//
// - a left mousedown on the title bar marks before the first move — the click that
//   focuses the window schedules its refresh right there, ahead of any `tauri://move`;
// - every `tauri://move` re-marks while the window actually moves, so a drag that
//   outlives the click's decay stays covered.
//
// The mark decays on a quiet timer: a plain click (never moved) and a drag's last pixel
// both settle back to "not dragging" a quarter second after their last signal, and the
// workbench's deferred refresh re-fires through its own schedule loop. A drag held still
// past the decay re-marks on its first moved pixel — a still window is exactly when a
// refresh costs nothing visible.

const QUIET_MS = 250;

let dragging = false;
let quiet: number | null = null;

export function isWindowDragging(): boolean {
	return dragging;
}

function mark(): void {
	dragging = true;
	if (quiet !== null) window.clearTimeout(quiet);
	quiet = window.setTimeout(() => {
		quiet = null;
		dragging = false;
	}, QUIET_MS);
}

/** A left mousedown reached the title bar: the drag may start here. */
export function noteTitleBarMouseDown(): void {
	mark();
}

/** The window moved (`tauri://move`, one per position change while the drag lasts). */
export function noteWindowMoved(): void {
	mark();
}
