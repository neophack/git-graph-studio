// The phone's back button for overlays (docs/ggs-remote-plan.md §11.2): Android's back gesture
// (and a browser's back) must close the sheet or drawer on screen, not leave the workbench —
// every phone app behaves that way, and leaving would drop the session. The first overlay
// pushes one history entry; a popstate closes the top overlay; when the last overlay closes
// from the UI, the entry is consumed again. The release is deferred a tick, so a sheet that
// replaces another (a submenu level) keeps the one entry instead of racing a back() against
// a fresh push.
//
// The closers STACK (a sheet over a full-screen page over the editor): one back peels the
// top one, and while any closer remains the entry is pushed again — the next back peels the
// next layer, and only an empty stack lets the back leave the workbench.
const closers: (() => void)[] = [];
let pushed = false;
let ignorePop = 0;
let installed = false;

function arm(): void {
	try {
		history.pushState({ ggsOverlay: true }, '');
		pushed = true;
	} catch {
		/* a sandboxed history: the back button simply leaves, as before */
	}
}

function install(): void {
	if (installed || typeof window === 'undefined') return;
	installed = true;
	window.addEventListener('popstate', () => {
		if (ignorePop > 0) {
			ignorePop--;
			return;
		}
		if (!pushed) return;
		pushed = false;
		const close = closers.pop();
		close?.();
		// Layers remain beneath the one this back closed: keep one entry armed for them.
		if (closers.length > 0) arm();
	});
}

/** Register an open overlay; the returned release runs when the overlay closes by itself. */
export function pushBack(close: () => void): () => void {
	install();
	closers.push(close);
	if (!pushed) arm();
	let released = false;
	return () => {
		if (released) return;
		released = true;
		const index = closers.indexOf(close);
		if (index !== -1) closers.splice(index, 1);
		setTimeout(() => {
			if (closers.length > 0 || !pushed) return;
			pushed = false;
			ignorePop++;
			history.back();
		}, 0);
	};
}

/** The page is leaving for good (a full-page navigation — the picker, another window's
 *  workbench): the overlay entry a release would consume is moot, and consuming it would
 *  kill the leave itself — the release's history.back() fires one tick after the closing
 *  click, and that traversal cancels the navigation the same click started (the drawer's
 *  picker-page row: closeDrawer's queued back() aborted the location.assign behind it).
 *  Drop the entry without traversing; the leave lands. */
export function leavingPage(): void {
	closers.length = 0;
	pushed = false;
}
