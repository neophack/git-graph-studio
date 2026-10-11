// The phone's back button for overlays (docs/ggs-remote-plan.md §11.2): Android's back gesture
// (and a browser's back) must close the sheet or drawer on screen, not leave the workbench —
// every phone app behaves that way, and leaving would drop the session. The first overlay
// pushes one history entry; a popstate closes the top overlay; when the last overlay closes
// from the UI, the entry is consumed again. The release is deferred a tick, so a sheet that
// replaces another (a submenu level) keeps the one entry instead of racing a back() against
// a fresh push.
const closers: (() => void)[] = [];
let pushed = false;
let ignorePop = 0;
let installed = false;

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
		closers.length = 0;
		close?.();
	});
}

/** Register an open overlay; the returned release runs when the overlay closes by itself. */
export function pushBack(close: () => void): () => void {
	install();
	closers.push(close);
	if (!pushed) {
		try {
			history.pushState({ ggsOverlay: true }, '');
			pushed = true;
		} catch {
			/* a sandboxed history: the back button simply leaves, as before */
		}
	}
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
