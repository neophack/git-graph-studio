// The phone's read-only open (docs/ggs-remote-plan.md §11.3, the editor row): on a touch
// phone every file opens locked — browsing with a finger must not drop a caret into the
// text — and one explicit unlock turns that editor editable for the rest of its tab's
// life. Tablet, desktop-web and the desktop app stay directly editable; the unlock bar
// exists only where the lock did.
//
// Deliberately dependency-light (i18n only, hand-built DOM): editor.ts and docEditView.ts
// import this at their top level, and a heavier import here would both pull CodeMirror
// into the first-paint chunk (the editor suite keeps it lazy) and thread a cycle through
// the ui kit. The locked configuration itself (a Compartment with `readOnly` +
// `editable: false`) is defined beside each surface's CodeMirror module; the bar takes
// the unlock as a callback and reconfigures nothing itself.
import { t } from '../i18n';

/** Whether a freshly opened file starts locked: the remote shell on its phone form factor
 *  (the markers responsive.ts keeps on <html>; a desktop build carries neither). */
export function editLockDefault(): boolean {
	return typeof document !== 'undefined'
		&& document.documentElement.hasAttribute('data-remote-shell')
		&& document.documentElement.dataset['formFactor'] === 'phone';
}

/** The bar a locked editor carries: what state it is in, and the one tap that lifts it.
 *  Mounted above the editor's own DOM, removed by the unlock itself. */
export function mountEditUnlockBar(parent: HTMLElement, unlock: () => void, focus: () => void): void {
	const bar = document.createElement('div');
	bar.className = 'edit-lock-bar';
	const glyph = document.createElement('span');
	glyph.className = 'codicon codicon-lock';
	const label = document.createElement('span');
	label.className = 'label';
	label.textContent = t('remote.editLock.locked');
	const button = document.createElement('button');
	button.textContent = t('remote.editLock.unlock');
	button.addEventListener('click', () => {
		unlock();
		bar.remove();
		focus();
	});
	bar.append(glyph, label, button);
	parent.insertBefore(bar, parent.firstChild);
}
