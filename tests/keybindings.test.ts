// The user keybindings (M3 3.10): the file overrides the registry's defaults everywhere a
// binding is matched or shown, chords resolve through the override too, conflicts are
// detected, and the editor records a new binding straight from a keystroke.

import { beforeEach, describe, expect, it } from 'vitest';

import { commandForBinding, commands, setKeybindingResolver } from '../src/commands';
import { bindingFromEvent, commandsBoundTo, effectiveKeybinding, loadUserKeybindings, renderKeybindingsEditor, setUserKeybinding, userKeybindings } from '../src/keybindings';
import { backend } from './tauriMock';
import { click, texts, type } from './helpers';

// A sliver of the workbench's registry (the ids and default bindings the tests exercise).
function registerTestCommands(): void {
	for (const [id, keybinding] of [
		['workbench.commandPalette', 'Ctrl+Shift+P'],
		['workbench.quickOpen', 'Ctrl+P'],
		['workbench.save', 'Ctrl+S'],
		['workbench.showScm', 'Ctrl+Shift+G'],
		['workbench.showSearch', 'Ctrl+Shift+F']
	] as const) {
		if (!commands.get(id)) commands.register({ id, title: id, keybinding, run: () => undefined });
	}
	setKeybindingResolver((id) => effectiveKeybinding(id));
}

describe('the keybinding store', () => {
	beforeEach(() => {
		registerTestCommands();
		backend.on('keybindings_read', () => null);
		backend.on('keybindings_write', () => null);
		return () => void setUserKeybindingsCleanup();
	});

	async function setUserKeybindingsCleanup(): Promise<void> {
		// Reset every user binding between tests.
		for (const binding of userKeybindings()) await setUserKeybinding(binding.command, undefined);
	}

	it('loads the file and answers with the user binding over the default', async () => {
		backend.on('keybindings_read', () => JSON.stringify([
			{ key: 'Ctrl+Alt+P', command: 'workbench.commandPalette' },
			{ key: '', command: 'workbench.quickOpen' }, // explicitly unbound
			{ key: 'Ctrl+X', command: 'not.a.command' }, // kept, shown as a conflict source
			'garbage entry'
		]));
		await loadUserKeybindings();
		expect(effectiveKeybinding('workbench.commandPalette')).toBe('Ctrl+Alt+P');
		expect(effectiveKeybinding('workbench.quickOpen')).toBeNull();
		expect(effectiveKeybinding('workbench.save')).toBe(commands.get('workbench.save')!.keybinding);
		// The lookup path the workbench's key handler uses.
		expect(commandForBinding('Ctrl+Alt+P')?.id).toBe('workbench.commandPalette');
		expect(commandForBinding('Ctrl+P')).toBeUndefined(); // unbound
	});

	it('a change writes the file and conflicts are flagged', async () => {
		await loadUserKeybindings();
		await setUserKeybinding('workbench.showScm', 'Ctrl+Shift+F'); // also the Search view's
		expect(commandsBoundTo('Ctrl+Shift+F').sort()).toEqual(['workbench.showScm', 'workbench.showSearch']);
		// Resetting removes the user entry and the conflict.
		await setUserKeybinding('workbench.showScm', undefined);
		expect(commandsBoundTo('Ctrl+Shift+F')).toEqual(['workbench.showSearch']);
	});

	it('the menus advertise the effective binding, and nothing when unbound', async () => {
		backend.on('keybindings_read', () => JSON.stringify([
			{ key: 'Ctrl+Alt+S', command: 'workbench.save' },
			{ key: '', command: 'workbench.quickOpen' } // explicitly unbound
		]));
		await loadUserKeybindings();
		expect(commands.menuItem('workbench.save').keybinding).toBe('Ctrl+Alt+S');
		// An unbound command shows no shortcut rather than advertising a dead one.
		expect(commands.menuItem('workbench.quickOpen').keybinding).toBeUndefined();
		// An untouched command keeps its registry default.
		expect(commands.menuItem('workbench.showSearch').keybinding).toBe('Ctrl+Shift+F');
	});
});

describe('bindingFromEvent', () => {
	// (pure: no registry needed)
	const event = (key: string, init: KeyboardEventInit = {}): KeyboardEvent =>
		new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });

	it('normalizes a keystroke into the registry spelling', () => {
		expect(bindingFromEvent(event('p', { ctrlKey: true }))).toBe('Ctrl+P');
		expect(bindingFromEvent(event('P', { ctrlKey: true, shiftKey: true }))).toBe('Ctrl+Shift+P');
		expect(bindingFromEvent(event('ArrowUp', { altKey: true }))).toBe('Alt+Up');
		expect(bindingFromEvent(event('Escape'))).toBe('Escape');
		expect(bindingFromEvent(event('Control', { ctrlKey: true }))).toBeUndefined(); // still choosing modifiers
	});

	it('records shifted punctuation with the unshifted spelling the defaults use', () => {
		// Shift+` reports "~": the binding is recorded like the built-in "Ctrl+Shift+`", so it
		// matches (and conflicts with) the same spelling everywhere.
		expect(bindingFromEvent(event('~', { ctrlKey: true, shiftKey: true }))).toBe('Ctrl+Shift+`');
		expect(bindingFromEvent(event('!', { ctrlKey: true, shiftKey: true }))).toBe('Ctrl+Shift+1');
		expect(bindingFromEvent(event('`', { ctrlKey: true }))).toBe('Ctrl+`');
	});
});

describe('the keybindings editor', () => {
	beforeEach(async () => {
		registerTestCommands();
		backend.on('keybindings_read', () => null);
		backend.on('keybindings_write', () => null);
		await loadUserKeybindings();
	});

	it('lists, searches and records a new binding', async () => {
		const container = document.createElement('div');
		document.body.appendChild(container);
		renderKeybindingsEditor(container);
		expect(texts('.kb-row kbd', container).length).toBeGreaterThanOrEqual(5); // the sliver registered above

		const search = container.querySelector('.shortcuts-filter') as HTMLInputElement;
		type(search, 'save');
		expect(texts('.kb-row .description', container).join(' ')).toContain('workbench.save');

		// Click the key cell to start recording; the next keystroke becomes the binding.
		const row = container.querySelector('.kb-row') as HTMLElement;
		const cell = row.querySelector('kbd') as HTMLElement;
		click(cell);
		expect(cell.classList.contains('recording')).toBe(true);
		container.dispatchEvent(new KeyboardEvent('keydown', { key: 'F9', bubbles: true, cancelable: true }));
		await Promise.resolve();
		expect(effectiveKeybinding('workbench.save')).toBe('F9');
		// The row re-rendered with the user binding marked and a reset action offered.
		const saved = userKeybindings();
		expect(saved.some((binding) => binding.command === 'workbench.save' && binding.key === 'F9')).toBe(true);
		await setUserKeybinding('workbench.save', undefined);
	});
});
