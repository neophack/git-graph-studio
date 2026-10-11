// Form factors (docs/ggs-remote-plan.md §11.1): phone below 600 px, tablet below 1024 px,
// desktop above — width breakpoints, with the pointer kind decided separately (a tablet with
// a mouse is not a touch device). Written onto <html> as `data-form-factor` and
// `data-pointer`, which remote.css keys every layout change on; the virtual keyboard's
// visible height rides in `--vvh` (and the visual viewport's offset in `--vv-top`, which iOS
// pans instead of resizing) for the views that must stay above it, and `data-keyboard="open"`
// marks a raised keyboard — the bottom navigation steps aside and the editing rows show.
export type FormFactor = 'phone' | 'tablet' | 'desktop';

const listeners = new Set<(factor: FormFactor) => void>();
let current: FormFactor | null = null;

export function formFactorFor(width: number): FormFactor {
	if (width < 600) return 'phone';
	if (width < 1024) return 'tablet';
	return 'desktop';
}

export function formFactor(): FormFactor {
	return current ?? formFactorFor(typeof window === 'undefined' ? 1280 : window.innerWidth);
}

export function coarsePointer(): boolean {
	return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
}

export function onFormFactorChange(listener: (factor: FormFactor) => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/** The tallest viewport seen per width (an orientation): the keyboard-down height. With
 *  `interactive-widget=resizes-content` the layout viewport itself shrinks under a keyboard,
 *  so the comparison has to be against a remembered height, not the current one. */
const fullHeight = new Map<number, number>();

/** Whether the focus sits in something that raises the on-screen keyboard. */
export function editableFocused(target: Element | null = document.activeElement): boolean {
	if (!target) return false;
	if (target instanceof HTMLTextAreaElement) return !target.readOnly;
	if (target instanceof HTMLInputElement) return !target.readOnly && !['button', 'checkbox', 'radio', 'range', 'file', 'submit', 'reset', 'color'].includes(target.type);
	return (target as HTMLElement).isContentEditable === true;
}

/** A keyboard is up: an editable has the focus and the visible height fell well below the
 *  keyboard-down height of this orientation (a 120 px margin rides out the browser's own
 *  toolbars collapsing). */
export function keyboardOpen(visible: number, full: number, editable: boolean): boolean {
	return editable && full - visible > 120;
}

function apply(): void {
	const root = document.documentElement;
	const next = formFactorFor(window.innerWidth);
	root.dataset.formFactor = next;
	root.dataset.pointer = coarsePointer() ? 'coarse' : 'fine';
	const viewport = window.visualViewport;
	const visible = Math.round(viewport?.height ?? window.innerHeight);
	root.style.setProperty('--vvh', `${visible}px`);
	root.style.setProperty('--vv-top', `${Math.round(viewport?.offsetTop ?? 0)}px`);
	const full = Math.max(fullHeight.get(window.innerWidth) ?? 0, window.innerHeight, visible);
	fullHeight.set(window.innerWidth, full);
	root.toggleAttribute('data-keyboard', keyboardOpen(visible, full, editableFocused()));
	if (next !== current) {
		current = next;
		for (const listener of listeners) listener(next);
	}
}

/** Start following the viewport (rotation, resize, the virtual keyboard, the focus). The
 *  returned stop drops every listener (the remote page never stops; tests do). */
export function initResponsive(): () => void {
	document.documentElement.classList.add('remote-shell');
	apply();
	const coarse = typeof matchMedia === 'function' ? matchMedia('(pointer: coarse)') : null;
	// Focus moves without a resize (one field to the next, a blur that drops the keyboard
	// before the viewport reports it): re-read on the next frame.
	const later = () => requestAnimationFrame(apply);
	window.addEventListener('resize', apply);
	window.visualViewport?.addEventListener('resize', apply);
	window.visualViewport?.addEventListener('scroll', apply);
	coarse?.addEventListener?.('change', apply);
	document.addEventListener('focusin', later);
	document.addEventListener('focusout', later);
	return () => {
		window.removeEventListener('resize', apply);
		window.visualViewport?.removeEventListener('resize', apply);
		window.visualViewport?.removeEventListener('scroll', apply);
		coarse?.removeEventListener?.('change', apply);
		document.removeEventListener('focusin', later);
		document.removeEventListener('focusout', later);
		document.documentElement.classList.remove('remote-shell');
		document.documentElement.removeAttribute('data-keyboard');
		current = null;
	};
}
