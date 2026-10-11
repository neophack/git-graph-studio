// The phone's editing row (docs/ggs-remote-plan.md §11.3, the editor's toolbar): a phone
// keyboard has no Tab, no arrows and no Ctrl, so while an unlocked editor holds the focus and
// the keyboard is up, one scrolling row of keys rides directly above it — Tab, the four
// arrows, Undo, Redo, Toggle Comment, Find, Save, and the key that puts the keyboard away.
// The arrows and Tab are the editor's own key events (CodeMirror's keymap runs them, so a
// selection, a fold or a completion list reacts exactly as to a hardware key); the rest are
// registry commands. The row never takes the focus: a tap must not drop the keyboard.
import { commands } from '../commands';
import { t } from '../i18n';

export interface AccessoryKey {
	id: string;
	icon: string;
	label: () => string;
	/** A key event dispatched into the focused editor… */
	key?: { key: string; code: string; keyCode: number };
	/** …or a registry command. */
	command?: string;
	/** Blur the editor: the keyboard goes away. */
	dismiss?: true;
}

export const ACCESSORY_KEYS: AccessoryKey[] = [
	{ id: 'tab', icon: 'arrow-right', label: () => 'Tab', key: { key: 'Tab', code: 'Tab', keyCode: 9 } },
	{ id: 'left', icon: 'chevron-left', label: () => '←', key: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 } },
	{ id: 'up', icon: 'chevron-up', label: () => '↑', key: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 } },
	{ id: 'down', icon: 'chevron-down', label: () => '↓', key: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 } },
	{ id: 'right', icon: 'chevron-right', label: () => '→', key: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 } },
	{ id: 'undo', icon: 'discard', label: () => t('remote.editorToolbar.undo'), command: 'editor.undo' },
	{ id: 'redo', icon: 'redo', label: () => t('remote.editorToolbar.redo'), command: 'editor.redo' },
	{ id: 'comment', icon: 'comment', label: () => t('remote.editorToolbar.comment'), command: 'editor.toggleLineComment' },
	{ id: 'find', icon: 'search', label: () => t('remote.editorToolbar.find'), command: 'editor.find' },
	{ id: 'save', icon: 'save', label: () => t('remote.editorToolbar.save'), command: 'workbench.save' },
	{ id: 'done', icon: 'chevron-down', label: () => t('remote.editorToolbar.done'), dismiss: true }
];

/** The editable element the keys act on: the focused CodeMirror content, if any. */
export function focusedEditor(): HTMLElement | null {
	const active = document.activeElement as HTMLElement | null;
	if (!active?.isContentEditable) return null;
	return active.closest('.cm-editor') ? active : null;
}

/** Press one accessory key. */
export function pressAccessoryKey(key: AccessoryKey): void {
	const target = focusedEditor();
	if (key.dismiss) {
		target?.blur();
		return;
	}
	if (key.key) {
		if (!target) return;
		const init = { key: key.key.key, code: key.key.code, keyCode: key.key.keyCode, bubbles: true, cancelable: true };
		const down = new KeyboardEvent('keydown', init);
		// CodeMirror leaves Tab to the browser unless a keymap claims it (focus would leave the
		// editor): a Tab nobody handled inserts the indentation character itself.
		if (target.dispatchEvent(down) && key.id === 'tab') document.execCommand('insertText', false, '\t');
		target.dispatchEvent(new KeyboardEvent('keyup', init));
		return;
	}
	if (key.command) void commands.execute(key.command);
}

/** Build the row; the stylesheet shows it only while `data-keyboard` is set and the focus
 *  is inside an editor (`data-editor-focus`, kept here). */
export function createEditorAccessory(): HTMLElement {
	const row = document.createElement('div');
	row.className = 'ggs-editor-accessory';
	row.setAttribute('role', 'toolbar');
	row.setAttribute('aria-label', t('remote.editorToolbar.label'));
	for (const key of ACCESSORY_KEYS) {
		const button = document.createElement('button');
		button.dataset.key = key.id;
		button.title = key.label();
		button.setAttribute('aria-label', key.label());
		button.tabIndex = -1;
		const glyph = document.createElement('span');
		glyph.className = `codicon codicon-${key.icon}`;
		glyph.setAttribute('aria-hidden', 'true');
		button.appendChild(glyph);
		if (key.id === 'tab') {
			const text = document.createElement('span');
			text.className = 'text';
			text.textContent = 'Tab';
			button.appendChild(text);
		}
		// Keep the editor focused (and the keyboard up) while tapping the row.
		button.addEventListener('pointerdown', (event) => event.preventDefault());
		button.addEventListener('mousedown', (event) => event.preventDefault());
		button.addEventListener('click', () => pressAccessoryKey(key));
		row.appendChild(button);
	}
	const sync = () => document.documentElement.toggleAttribute('data-editor-focus', focusedEditor() !== null);
	document.addEventListener('focusin', sync);
	document.addEventListener('focusout', () => requestAnimationFrame(sync));
	sync();
	return row;
}
