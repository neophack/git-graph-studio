// The user's keybindings (M3 3.10): `~/.ggs/keybindings.json` (VS Code's shape - an array of
// `{ "key": "Ctrl+Shift+P", "command": "workbench.commandPalette" }`, `when` stored and
// shown but not yet evaluated) overrides the commands registry's defaults, conflicts are
// detected (the same chord bound to more than one command), and the editor in the Keyboard
// Shortcuts view (Ctrl+K Ctrl+S) records a new key straight from the keyboard.

import { invoke } from '@tauri-apps/api/core';

import { commands, UNSHIFTED_GLYPHS } from './commands';
import { el, icon } from './ui';

export interface UserKeybinding {
	key: string;
	command: string;
	when?: string;
}

/** The loaded user bindings (empty until `loadUserKeybindings` lands, and whenever the file
 *  does not exist). */
let userBindings: UserKeybinding[] = [];

export function userKeybindings(): UserKeybinding[] {
	return [...userBindings];
}

/** Read ~/.ggs/keybindings.json (a missing or unparsable file leaves the bindings empty). */
export async function loadUserKeybindings(): Promise<void> {
	try {
		const text = await invoke<string | null>('keybindings_read');
		if (!text) return;
		const parsed = JSON.parse(text) as unknown;
		if (!Array.isArray(parsed)) return;
		userBindings = parsed.filter(
			(entry): entry is UserKeybinding =>
				typeof entry === 'object' && entry !== null && typeof (entry as UserKeybinding).key === 'string' && typeof (entry as UserKeybinding).command === 'string'
		);
	} catch {
		// No file, or one that does not parse: the defaults stand.
	}
}

/** The key a command answers to: the user's binding wins over the registry's default
 *  (`null` when the user explicitly unbound it). */
export function effectiveKeybinding(commandId: string): string | undefined | null {
	const user = userBindings.find((binding) => binding.command === commandId);
	if (user) return user.key === '' ? null : user.key;
	return commands.get(commandId)?.keybinding;
}

/** Set (or, with an empty key, clear) a command's binding; `undefined` resets to default by
 *  dropping the user entry. Writes the file. */
export async function setUserKeybinding(commandId: string, key: string | undefined): Promise<void> {
	userBindings = userBindings.filter((binding) => binding.command !== commandId);
	if (key !== undefined) userBindings.push({ key, command: commandId });
	await invoke('keybindings_write', { contents: JSON.stringify(userBindings, null, '\t') }).catch(() => undefined);
}

/** Every command whose effective binding is `binding` - more than one entry is a conflict. */
export function commandsBoundTo(binding: string): string[] {
	const wanted = binding.toLowerCase();
	const ids: string[] = [];
	for (const command of commands.all()) {
		const effective = effectiveKeybinding(command.id);
		if (effective !== null && effective !== undefined && effective.toLowerCase() === wanted) ids.push(command.id);
	}
	// User bindings for unknown commands still count (they show as conflicts in the file).
	for (const user of userBindings) {
		if (user.key.toLowerCase() === wanted && !ids.includes(user.command) && !commands.get(user.command)) ids.push(user.command);
	}
	return ids;
}

/** Normalize a KeyboardEvent into a binding string ("Ctrl+Shift+P"), the shape the registry
 *  spells - the recording path of the editor. Returns undefined for bare modifiers. */
export function bindingFromEvent(event: KeyboardEvent): string | undefined {
	const key = event.key;
	if (key === 'Control' || key === 'Shift' || key === 'Alt' || key === 'Meta') return undefined;
	const named: Record<string, string> = { Escape: 'Escape', Enter: 'Enter', Backspace: 'Backspace', Delete: 'Delete', Insert: 'Insert', Tab: 'Tab', Space: 'Space', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right' };
	// Shift reports punctuation as the shifted glyph ("~"): record the unshifted key, the
	// spelling the defaults (and matchesKeybinding) use - "Ctrl+Shift+`".
	const glyph = event.shiftKey ? (UNSHIFTED_GLYPHS[key] ?? key) : key;
	let part = named[glyph] ?? (glyph.length === 1 ? glyph.toUpperCase() : glyph[0]!.toUpperCase() + glyph.slice(1));
	if (part === ' ') part = 'Space';
	const parts: string[] = [];
	if (event.ctrlKey || event.metaKey) parts.push('Ctrl');
	if (event.shiftKey && key.length === 1) parts.push('Shift');
	else if (event.shiftKey) parts.push('Shift');
	if (event.altKey) parts.push('Alt');
	parts.push(part);
	return parts.join('+');
}

/** The Keyboard Shortcuts editor (the Ctrl+K Ctrl+S view): searchable rows of every command
 *  with its effective binding, its source (default / user), a recorder, and conflict badges. */
export function renderKeybindingsEditor(container: HTMLElement): void {
	const inner = el('div', 'welcome-inner');
	const search = el('input', 'input shortcuts-filter') as HTMLInputElement;
	search.type = 'text';
	search.placeholder = 'Search keybindings (type to filter, click a row\u2019s pencil to record)';
	search.spellcheck = false;
	inner.append(el('div', '', [el('h1', '', ['Keyboard Shortcuts'])]), search);
	const list = el('div', 'shortcuts-list');
	inner.appendChild(list);
	container.appendChild(inner);

	/** The row currently recording (a strike-through key cell captures the next keystroke). */
	let recording: { commandId: string; cell: HTMLElement } | null = null;

	const stopRecording = (): void => {
		if (!recording) return;
		recording.cell.classList.remove('recording');
		recording.cell.textContent = effectiveKeybinding(recording.commandId) ?? '';
		recording = null;
	};

	const render = (): void => {
		list.textContent = '';
		const query = search.value.trim().toLowerCase();
		for (const command of commands.all()) {
			const label = `${command.category ? command.category + ': ' : ''}${command.title}`;
			if (query !== '' && !`${label} ${command.id}`.toLowerCase().includes(query)) continue;
			const user = userBindings.find((binding) => binding.command === command.id);
			const effective = effectiveKeybinding(command.id);
			const row = el('div', 'shortcut kb-row');
			const keyCell = el('kbd', '', [effective ?? (user ? '(unbound)' : '\u2014')]);
			keyCell.title = user !== undefined ? 'User keybinding' : 'Default keybinding';
			if (user !== undefined) keyCell.classList.add('user');
			// A conflict: this chord also starts another command.
			if (effective && commandsBoundTo(effective).length > 1) {
				keyCell.classList.add('conflict');
				keyCell.title = `Conflicts with ${commandsBoundTo(effective).filter((id) => id !== command.id).join(', ')}`;
			}
			keyCell.addEventListener('click', () => {
				stopRecording();
				recording = { commandId: command.id, cell: keyCell };
				keyCell.classList.add('recording');
				keyCell.textContent = 'Press a key\u2026';
				keyCell.title = 'Recording - press the new key, Escape cancels';
			});
			const text = el('span', '', [label, el('span', 'description', [' ' + command.id])]);
			const actions = el('div', 'kb-actions');
			if (user !== undefined) {
				const reset = icon('discard');
				reset.title = 'Reset to the default keybinding';
				reset.classList.add('action-btn');
				reset.addEventListener('click', () => void setUserKeybinding(command.id, undefined).then(render));
				actions.appendChild(reset);
			}
			row.append(keyCell, text, actions);
			list.appendChild(row);
		}
		if (list.children.length === 0) list.appendChild(el('p', 'empty', ['No matching commands']));
	};

	search.addEventListener('input', render);
	search.addEventListener('keydown', (event) => {
		if (event.key === 'Escape') stopRecording();
		event.stopPropagation();
	});
	container.addEventListener('keydown', (event) => {
		if (!recording) return;
		event.preventDefault();
		event.stopPropagation();
		const binding = bindingFromEvent(event);
		if (binding === undefined) return; // still choosing modifiers
		if (binding === 'Escape') {
			stopRecording();
			return;
		}
		const commandId = recording.commandId;
		stopRecording();
		void setUserKeybinding(commandId, binding).then(render);
	});
	render();
}
