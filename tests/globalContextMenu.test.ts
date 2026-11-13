// The app-wide fallback context menu (globalContextMenu.ts): the Copy/Paste/Select All
// rows over every surface that shows no menu of its own, the renderer-kept selection
// sources (the terminal's), and the install that respects a view's own menu.

import { beforeEach, describe, expect, it } from 'vitest';

import { backend } from './tauriMock';
import { fallbackContextMenuItems, installGlobalContextMenu, registerSelectionSource, selectedText } from '../src/platform/ui/globalContextMenu';
import { closeContextMenu } from '../src/platform/ui';
import { menuLabels, menuItem, rightClick } from './helpers';

/** Select a node's text the way a user drag does (a real DOM selection). */
function selectNode(node: Node): void {
	const range = document.createRange();
	range.selectNodeContents(node);
	document.getSelection()?.removeAllRanges();
	document.getSelection()?.addRange(range);
}

describe('selectedText', () => {
	it('answers the DOM selection, falling back to the newest registered source, and unregisters cleanly', () => {
		const body = document.createElement('div');
		body.textContent = 'picked text';
		document.body.appendChild(body);
		expect(selectedText()).toBe('');
		selectNode(body);
		expect(selectedText()).toBe('picked text');
		document.getSelection()?.removeAllRanges();

		const unregister = registerSelectionSource(() => 'term selection');
		const newer = registerSelectionSource(() => null);
		expect(selectedText()).toBe('term selection');
		newer();
		expect(selectedText()).toBe('term selection');
		unregister();
		expect(selectedText()).toBe('');
		body.remove();
	});
});

describe('fallbackContextMenuItems', () => {
	beforeEach(() => {
		backend.clipboard.length = 0;
		closeContextMenu();
	});

	it('Copy rides the live selection and writes the clipboard; with none it is disabled', async () => {
		// Nothing selected yet: the Copy row disables.
		const without = fallbackContextMenuItems();
		const disabled = without.find((entry) => entry !== 'separator' && entry.label === 'Copy');
		expect(disabled && 'disabled' in disabled && disabled.disabled).toBe(true);
		// A DOM selection enables it, and running it writes the clipboard.
		const body = document.createElement('div');
		body.textContent = 'copy me';
		document.body.appendChild(body);
		selectNode(body);
		const rows = fallbackContextMenuItems();
		const copy = rows.find((entry) => entry !== 'separator' && entry.label === 'Copy');
		expect(copy && !('disabled' in copy && copy.disabled)).toBe(true);
		(copy as { run?: () => void }).run?.();
		await Promise.resolve();
		expect(backend.clipboard).toEqual(['copy me']);
		body.remove();
		document.getSelection()?.removeAllRanges();
	});

	it('Paste lands in the focused input as typing would (an input event the field hears)', async () => {
		const input = document.createElement('input');
		input.value = 'hello world';
		input.setSelectionRange(6, 11);
		document.body.appendChild(input);
		input.focus();
		input.addEventListener('input', (event) => {
			(event.target as HTMLInputElement).dataset.heard = (event as InputEvent).data ?? '';
		});
		(backend as unknown as { clipboardText: string }).clipboardText = 'there';
		const rows = fallbackContextMenuItems();
		const paste = rows.find((entry) => entry !== 'separator' && entry.label === 'Paste');
		expect(paste && !('disabled' in paste && paste.disabled)).toBe(true);
		(paste as { run?: () => void }).run?.();
		await Promise.resolve();
		await Promise.resolve();
		expect(input.value).toBe('hello there');
		expect(input.dataset.heard).toBe('there');
		expect(input.selectionStart).toBe(11);
		input.remove();
		// Without a focused editable the row disables.
		(document.activeElement as HTMLElement)?.blur();
		const without = fallbackContextMenuItems();
		const disabled = without.find((entry) => entry !== 'separator' && entry.label === 'Paste');
		expect(disabled && 'disabled' in disabled && disabled.disabled).toBe(true);
	});

	it('Select All selects the focused field, else the surface that was right-clicked', () => {
		const input = document.createElement('input');
		input.value = 'all of this';
		document.body.appendChild(input);
		input.focus();
		(fallbackContextMenuItems().find((entry) => entry !== 'separator' && entry.label === 'Select All') as { run?: () => void }).run?.();
		expect(input.selectionStart).toBe(0);
		expect(input.selectionEnd).toBe(input.value.length);
		input.remove();
		// With no field focused, the selectable surface the pointer named is the scope (the
		// chrome's user-select:none would swallow a whole-body select).
		const toast = document.createElement('div');
		toast.className = 'notification';
		toast.textContent = 'toast words to select';
		document.body.appendChild(toast);
		const selection = document.getSelection()!;
		selection.removeAllRanges();
		const scoped = fallbackContextMenuItems(toast.querySelector('.body') ?? toast);
		(scoped.find((entry) => entry !== 'separator' && entry.label === 'Select All') as { run?: () => void }).run?.();
		expect(selection.toString()).toBe('toast words to select');
		toast.remove();
		selection.removeAllRanges();
	});
});

describe('installGlobalContextMenu', () => {
	beforeEach(() => {
		closeContextMenu();
	});

	it('an unclaimed contextmenu opens the fallback menu; a view\'s own preventDefault keeps its menu', () => {
		installGlobalContextMenu(document);
		const surface = document.createElement('div');
		document.body.appendChild(surface);
		// Unclaimed: the menu renders with Copy / Paste / Select All.
		rightClick(surface);
		expect(menuLabels()).toEqual(expect.arrayContaining(['Copy', 'Paste', 'Select All']));
		const copyRow = menuItem('Copy');
		expect(copyRow).not.toBeNull();
		closeContextMenu();
		// A view's own handler prevents default: the fallback stays out.
		surface.addEventListener('contextmenu', (event) => event.preventDefault());
		rightClick(surface);
		expect(menuLabels()).toEqual([]);
		surface.remove();
	});
});
