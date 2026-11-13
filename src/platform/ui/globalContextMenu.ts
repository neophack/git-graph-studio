// The app-wide fallback context menu. The browser's own menu is suppressed everywhere
// (the webview's right-click chrome is never wanted), and most informative surfaces —
// notifications, dialogs, tooltips, the Output view, the settings rows, previews — show no
// menu of their own, so right-clicking them offered nothing to copy with. This menu rides
// wherever no view claimed the event: Copy takes whatever is selected (the DOM's, or a
// renderer-kept selection such as the terminal's), Paste lands in the focused field, and
// Select All selects the surface under the pointer. A view that preventDefaults its own
// contextmenu keeps its menu untouched.

import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager';

import { showContextMenu, type MenuEntry } from './contextMenu';

/** Selections a renderer keeps in its own model rather than the DOM's — the terminal's
 *  xterm selection above all. Copy consults them, last registered first, when the document
 *  selection is empty. */
const selectionSources: (() => string | null)[] = [];

/** Register a renderer-kept selection; answers the selection's text or null for none.
 *  Returns the unregister. */
export function registerSelectionSource(source: () => string | null): () => void {
	selectionSources.push(source);
	return () => {
		const at = selectionSources.indexOf(source);
		if (at !== -1) selectionSources.splice(at, 1);
	};
}

/** The text a Copy would take right now: the DOM selection's, else the newest registered
 *  source's non-empty one, else nothing. */
export function selectedText(): string {
	const dom = document.getSelection();
	const text = dom && !dom.isCollapsed ? dom.toString() : '';
	if (text) return text;
	for (let i = selectionSources.length - 1; i >= 0; i--) {
		const own = selectionSources[i]();
		if (own) return own;
	}
	return '';
}

/** The focused field a Paste would land in, when there is one. */
function focusedEditable(): HTMLInputElement | HTMLTextAreaElement | HTMLElement | null {
	const el = document.activeElement as HTMLElement | null;
	if (!el) return null;
	if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el;
	return el.isContentEditable ? el : null;
}

/** Insert into an input/textarea by splicing the value (the field's own listeners hear the
 *  input event, exactly as typing would), or into a contentEditable through the editor
 *  command, which keeps its undo stack. */
function insertIntoEditable(el: HTMLElement, text: string): void {
	if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
		const start = el.selectionStart ?? el.value.length;
		const end = el.selectionEnd ?? el.value.length;
		el.value = el.value.slice(0, start) + text + el.value.slice(end);
		const at = start + text.length;
		el.setSelectionRange(at, at);
		el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
		return;
	}
	document.execCommand('insertText', false, text);
}

/** The nearest ancestor (or self) that opts into text selection — the surface Select All
 *  should cover. The chrome is `user-select: none`, where a whole-body select would land
 *  on nothing at all. */
function selectableSurface(from: Element | null): Element {
	let at = from;
	while (at) {
		if (getComputedStyle(at).userSelect === 'text') return at;
		at = at.parentElement;
	}
	return from ?? document.body;
}

/** The fallback menu's rows: Copy over the live selection, Paste into a focused field,
 *  Select All over the focused field or the surface that was right-clicked. `target` is
 *  the contextmenu event's target — the surface Select All covers when no field holds
 *  focus. */
export function fallbackContextMenuItems(target: Element | null = null): MenuEntry[] {
	const selection = selectedText();
	const editable = focusedEditable();
	const copy = (): void => {
		void writeText(selection).catch(() => {
			// The webview's own clipboard (no Tauri runtime — a plain browser page).
			void navigator.clipboard?.writeText(selection).catch(() => undefined);
		});
	};
	const selectAll = (): void => {
		// The focused field only claims Select All when the pointer named it (or no surface
		// did): a hidden-but-focused field — the terminal's textarea — must not swallow the
		// toast's Select All the user asked for.
		const insideFocused = !!editable && !!target && (target === editable || editable.contains(target));
		if (editable && insideFocused) {
			if (editable instanceof HTMLInputElement || editable instanceof HTMLTextAreaElement) editable.select();
			else document.getSelection()?.selectAllChildren(editable);
			return;
		}
		if (target) {
			document.getSelection()?.selectAllChildren(selectableSurface(target));
			return;
		}
		if (editable) {
			if (editable instanceof HTMLInputElement || editable instanceof HTMLTextAreaElement) editable.select();
			else document.getSelection()?.selectAllChildren(editable);
			return;
		}
		document.getSelection()?.selectAllChildren(document.body);
	};
	const entries: MenuEntry[] = [
		{ label: 'Copy', keybinding: 'Ctrl+C', disabled: selection === '', run: copy },
		{ label: 'Paste', keybinding: 'Ctrl+V', disabled: !editable, run: () => {
			void readText().then((text) => {
				const el = focusedEditable();
				if (el && text) insertIntoEditable(el, text);
			}).catch(() => undefined);
		} },
		'separator',
		{ label: 'Select All', keybinding: 'Ctrl+A', run: selectAll }
	];
	return entries;
}

/** Install the document-level fallback: a contextmenu nobody preventDefaulted opens this
 *  menu instead of the browser's. Installed once from the composition root. */
export function installGlobalContextMenu(doc: Document): void {
	doc.addEventListener('contextmenu', (event) => {
		if (event.defaultPrevented) return;
		event.preventDefault();
		const target = event.target instanceof Element ? event.target : null;
		showContextMenu(event.clientX, event.clientY, fallbackContextMenuItems(target));
	});
}
