// The phone's read-only open (docs/ggs-remote-plan.md §11.3, the editor row): on a touch
// phone every file opens locked — browsing with a finger must not drop a caret into the
// text — and the app bar's lock button (appBar.ts) toggles the active editor between
// locked and editable. Tablet, desktop-web and the desktop app stay directly editable; the
// lock exists only where it was born.
//
// Deliberately dependency-light (no imports, hand-built state): editor.ts and
// docEditView.ts import this at their top level, and a heavier import here would both pull
// CodeMirror into the first-paint chunk (the editor suite keeps it lazy) and thread a cycle
// through the ui kit. The locked configuration itself (a Compartment with `readOnly` +
// `editable: false`) is defined beside each surface's CodeMirror module; a surface hands
// its reconfigure over as a callback and this module reconfigures nothing itself.

/** Whether a freshly opened file starts locked: the remote shell on its phone form factor
 *  (the markers responsive.ts keeps on <html>; a desktop build carries neither). */
export function editLockDefault(): boolean {
	return typeof document !== 'undefined'
		&& document.documentElement.hasAttribute('data-remote-shell')
		&& document.documentElement.dataset['formFactor'] === 'phone';
}

interface EditLockHandle {
	setLocked(locked: boolean): void;
	focus(): void;
}

const handles = new WeakMap<HTMLElement, EditLockHandle>();
const listeners = new Set<() => void>();

function changed(): void {
	for (const listener of listeners) listener();
}

/** Register a locked editor: `host` is the element the editor lives in (its pane, or the
 *  windowed editor's root), marked `data-edit-lock="locked"` until a toggle flips it. */
export function registerEditLock(host: HTMLElement, setLocked: (locked: boolean) => void, focus: () => void): void {
	handles.set(host, { setLocked, focus });
	host.dataset['editLock'] = 'locked';
	changed();
}

/** The lock of the editor on screen — the visible pane of the focused group — or null when
 *  the active editor carries none (a preview, an extension page, no editor at all). */
export function activeEditLock(): HTMLElement | null {
	const group = document.querySelector('.editor-group-box.focused') ?? document.getElementById('editorGroup') ?? document;
	for (const host of group.querySelectorAll<HTMLElement>('[data-edit-lock]')) {
		if (!handles.has(host)) continue;
		const pane = host.closest<HTMLElement>('.editor-pane');
		if (pane?.hidden) continue;
		return host;
	}
	return null;
}

export function isEditLocked(host: HTMLElement): boolean {
	return host.dataset['editLock'] === 'locked';
}

/** Flip an editor between locked and editable; an unlock focuses it, raising the keyboard. */
export function toggleEditLock(host: HTMLElement): void {
	const handle = handles.get(host);
	if (!handle) return;
	const locked = !isEditLocked(host);
	handle.setLocked(locked);
	host.dataset['editLock'] = locked ? 'locked' : 'unlocked';
	if (!locked) handle.focus();
	changed();
}

/** Called after every registration and toggle (the app bar re-renders its lock button). */
export function onEditLockChange(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}
