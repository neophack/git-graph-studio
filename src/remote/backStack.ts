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
//
// The STAY GUARD (2026-10-18, the owner's direction: 手机远程时浏览器手势会导致页面退出) sits
// at the BOTTOM of that stack on the page-stack shells: when a back reaches it — every
// overlay and page already closed — it shows the "press back again to leave" hint instead of
// leaving, and does NOT re-arm; a second back within the window leaves (the browser is at
// the base entry by then), silence re-arms. A browser's edge-swipe back therefore never
// exits the workbench by accident; it walks the in-app layers first (swipeNav.ts owns the
// content's own horizontal swipes).
const closers: (() => void)[] = [];
let pushed = false;
let ignorePop = 0;
let installed = false;

/** How long the guard's "press back again" window stays open before it re-arms. */
const STAY_REARM_MS = 2600;
let stayClose: (() => void) | null = null;
let stayHint: (() => void) | null = null;
let stayWindow = false;
let stayTimer: ReturnType<typeof setTimeout> | undefined;

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
 *  Drop the entry without traversing; the leave lands. The stay guard stands down with it. */
export function leavingPage(): void {
	closers.length = 0;
	pushed = false;
	if (stayTimer !== undefined) clearTimeout(stayTimer);
	stayTimer = undefined;
	stayWindow = false;
	stayHint = null;
}

/** Arm the stay guard on a page-stack shell: a back that peels every layer shows the hint
 *  and opens the leave window instead of exiting. Idempotent while armed — the shell
 *  re-syncs it on every device-class change, and a re-sync inside the open window must not
 *  re-arm early (the promised second back would then land on a fresh entry). */
export function installStayGuard(hint: () => void): void {
	install();
	stayHint = hint;
	if (stayClose && (closers.includes(stayClose) || stayWindow)) return;
	if (!stayClose) {
		stayClose = () => {
			stayHint?.();
			stayWindow = true;
			stayTimer = setTimeout(() => {
				stayTimer = undefined;
				stayWindow = false;
				// Still on a page-stack shell: the guard returns to the bottom of the stack.
				// An overlay that opened during the window holds its own closer above it.
				if (stayHint && stayClose) {
					closers.unshift(stayClose);
					if (!pushed) arm();
				}
			}, STAY_REARM_MS);
		};
	}
	closers.unshift(stayClose);
	if (!pushed) arm();
}

/** Stand the guard down (the viewport left the page-stack forms): its closer leaves the
 *  stack and the spare entry is consumed the release path's own deferred way when nothing
 *  else holds it. */
export function uninstallStayGuard(): void {
	if (stayTimer !== undefined) clearTimeout(stayTimer);
	stayTimer = undefined;
	stayWindow = false;
	stayHint = null;
	if (stayClose) {
		const index = closers.indexOf(stayClose);
		if (index !== -1) closers.splice(index, 1);
	}
	setTimeout(() => {
		if (closers.length === 0 && pushed) {
			pushed = false;
			ignorePop++;
			history.back();
		}
	}, 0);
}
