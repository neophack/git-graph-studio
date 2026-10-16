// Swipe-to-reveal: a list row dragged sideways uncovers the actions pinned behind its
// trailing edge — the touch list's row gesture (MT-manager's, VS Code mobile's). Hand-written
// over Pointer Events (no framework): the strip of actions lives in the row's PARENT, laid
// exactly under the row's box, and the ROW itself translates with the finger — whatever
// background the row carries slides with it, uncovering the strip. A drag snaps open past
// half the strip's width (or a 48 px minimum), snaps shut otherwise, only one row of a list
// is ever open (opening one closes the previous), and the click that ends a drag is
// swallowed so a revealed row never also opens what a plain tap would.

export interface RevealAction {
	icon: string;
	label: string;
	/** The destructive tint (a discard, a delete) — the caller confirms on its own. */
	danger?: boolean;
	run(): void;
}

/** The one row currently revealed; opening another closes it first. */
let revealed: { close(): void } | null = null;

/** Close whatever row is revealed (a list re-render, a route change). */
export function closeRevealedRow(): void {
	revealed?.close();
	revealed = null;
}

/** How far the finger must drag before the row follows (a click is not a swipe). */
const DRAG_THRESHOLD = 12;
/** The least drag that holds a row open when the finger lifts. */
const OPEN_THRESHOLD = 48;

export function swipeReveal(row: HTMLElement, actions: RevealAction[]): () => void {
	if (actions.length === 0) return () => undefined;
	row.classList.add('ggs-swipe-row');
	// The host (the row's list container) resolves lazily: the caller may wire the gesture
	// while the row is still detached (the view appends it after building).
	let host: HTMLElement | null = null;
	let strip: HTMLElement | null = null;
	const hostOf = (): HTMLElement | null => row.parentElement;

	const build = (): HTMLElement | null => {
		const parent = hostOf();
		if (!parent) return null;
		host = parent;
		host.classList.add('ggs-swipe-host');
		const node = document.createElement('div');
		node.className = 'ggs-swipe-actions';
		node.setAttribute('role', 'toolbar');
		for (const action of actions) {
			const button = document.createElement('button');
			button.type = 'button';
			button.className = action.danger ? 'danger' : '';
			button.title = action.label;
			button.setAttribute('aria-label', action.label);
			const glyph = document.createElement('span');
			glyph.className = `codicon codicon-${action.icon}`;
			glyph.setAttribute('aria-hidden', 'true');
			button.appendChild(glyph);
			button.addEventListener('click', (event) => {
				event.stopPropagation();
				close();
				action.run();
			});
			node.appendChild(button);
		}
		host.appendChild(node);
		strip = node;
		return node;
	};
	const stripOf = (): HTMLElement | null => strip ?? build();

	// Eager build once the row lands in its list (the caller may wire while detached): the
	// strip is in place before the first touch, and the lazy path covers a row never laid
	// out by a frame.
	if (row.isConnected) build();
	else requestAnimationFrame(() => { if (!strip) build(); });

	let open = false;
	const setOffset = (px: number): void => {
		row.style.transform = px === 0 ? '' : `translateX(${-px}px)`;
	};
	const snap = (px: number): void => {
		row.style.transition = 'transform 160ms cubic-bezier(.2,.8,.2,1)';
		setOffset(px);
	};
	let away: ((event: PointerEvent) => void) | null = null;
	const attachAway = (): void => {
		if (away) return;
		away = (event: PointerEvent) => {
			if (!(event.target as HTMLElement).closest?.('.ggs-swipe-actions')) close();
		};
		document.addEventListener('pointerdown', away, true);
	};
	const detachAway = (): void => {
		if (!away) return;
		document.removeEventListener('pointerdown', away, true);
		away = null;
	};
	const close = (): void => {
		open = false;
		if (revealed && revealed.close === close) revealed = null;
		row.classList.remove('revealed');
		detachAway();
		snap(0);
	};
	const width = (): number => stripOf()?.offsetWidth || actions.length * 56;
	const openRow = (): void => {
		const node = stripOf();
		if (node) {
			node.style.top = `${row.offsetTop}px`;
			node.style.height = `${row.offsetHeight}px`;
		}
		open = true;
		row.classList.add('revealed');
		attachAway();
		snap(width());
	};

	let startX = 0;
	let startY = 0;
	let dragging = false;
	let moved = false;
	let axis: 'x' | 'y' | null = null;
	let base = 0;
	let current = 0;

	row.addEventListener('pointerdown', (event) => {
		if (event.pointerType === 'mouse') return; // a mouse right-clicks (the menu)
		startX = event.clientX;
		startY = event.clientY;
		base = open ? width() : 0;
		dragging = true;
		moved = false;
		axis = null;
	});
	row.addEventListener('pointermove', (event) => {
		if (!dragging) return;
		const dx = event.clientX - startX;
		const dy = event.clientY - startY;
		// The first decisive move picks the axis: a vertical drag scrolls (the browser's
		// own pan), a horizontal one reveals. Once picked, the other is ignored.
		if (axis === null) {
			if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
			axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
			if (axis === 'x') row.style.transition = 'none';
		}
		if (axis !== 'x') return;
		moved = true;
		event.preventDefault();
		current = Math.max(0, Math.min(width(), base - dx));
		setOffset(current);
	});
	const lift = (): void => {
		if (!dragging) return;
		dragging = false;
		if (axis !== 'x') return;
		const held = current >= Math.min(width() / 2, OPEN_THRESHOLD) || (open && current > 0);
		if (held) {
			closeRevealedRow();
			revealed = { close };
			openRow();
		} else {
			close();
		}
	};
	row.addEventListener('pointerup', lift);
	row.addEventListener('pointercancel', lift);
	// The click that ends a drag is not the row's own tap-to-open.
	row.addEventListener('click', (event) => {
		if (moved) {
			event.stopPropagation();
			event.preventDefault();
			moved = false;
		}
	}, true);

	return () => {
		detachAway();
		if (open) close();
		strip?.remove();
		row.classList.remove('ggs-swipe-row', 'revealed');
		row.style.transform = '';
		if (host && !host.querySelector('.ggs-swipe-actions')) host.classList.remove('ggs-swipe-host');
	};
}
