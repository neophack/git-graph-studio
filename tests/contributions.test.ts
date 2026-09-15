import { beforeEach, describe, expect, it } from 'vitest';

import { commands } from '../src/commands';
import { applyContributions, menuItems, menuSection, normalizeKeybinding, removeContributions, type ManifestContributes } from '../src/contributions';

const manifest: ManifestContributes = {
	commands: [
		{ command: 'git-graph-rs.view', title: '%command.view.title%', category: 'Git Graph RS' },
		{ command: 'git-graph-rs.filterByFile', title: '%command.filter.title%' }
	],
	menus: {
		'explorer/context': [{ command: 'git-graph-rs.filterByFile', when: 'resourceScheme == file' }],
		'editor/context': [{ command: 'git-graph-rs.filterByFile' }, { command: 'git-graph-rs.hidden', when: 'false' }],
		'commandPalette': [{ command: 'git-graph-rs.view', when: 'false' }]
	},
	keybindings: [{ command: 'git-graph-rs.view', key: 'ctrl+shift+g g', when: 'false' }, { command: 'git-graph-rs.filterByFile', key: 'ctrl+alt+f' }]
};

const nls = { 'command.view.title': 'View Git Graph', 'command.filter.title': 'Filter Commits by File' };

describe('keybinding normalization', () => {
	it('maps VS Code spellings onto Studio ones', () => {
		expect(normalizeKeybinding('ctrl+shift+t')).toBe('Ctrl+Shift+T');
		expect(normalizeKeybinding('ctrl+k ctrl+w')).toBe('Ctrl+K Ctrl+W');
		expect(normalizeKeybinding('alt+q')).toBe('Alt+Q');
		expect(normalizeKeybinding('cmd+down')).toBe('Ctrl+Down');
	});
});

describe('manifest contributions', () => {
	beforeEach(() => {
		removeContributions('neophack.git-graph-rs');
	});

	it('registers declared commands with localized titles and keybindings', () => {
		const run: string[] = [];
		applyContributions('neophack.git-graph-rs', manifest, nls, (command) => run.push(command), () => true);
		const view = commands.get('git-graph-rs.view')!;
		expect(view.title).toBe('View Git Graph');
		expect(view.category).toBe('Git Graph RS');
		// The keybinding with when: "false" is skipped; the plain one is normalized.
		expect(view.keybinding).toBeUndefined();
		expect(commands.get('git-graph-rs.filterByFile')!.keybinding).toBe('Ctrl+Alt+F');
		void commands.execute('git-graph-rs.view');
		expect(run).toEqual(['git-graph-rs.view']);
	});

	it('shows menu entries for supported locations, localized, unless when is "false"', () => {
		applyContributions('neophack.git-graph-rs', manifest, nls, () => undefined, () => true);
		const explorer = menuItems('explorer/context');
		expect(explorer.map((item) => item.label)).toEqual(['Filter Commits by File']);
		const editor = menuItems('editor/context');
		expect(editor.map((item) => item.label)).toEqual(['Filter Commits by File']); // when:"false" dropped
		expect(menuSection('explorer/context')).toHaveLength(2); // separator + entry
		expect(menuSection('editor/title/context')).toHaveLength(0);
	});

	it('disables menu entries whose command cannot run', () => {
		applyContributions('neophack.git-graph-rs', manifest, nls, () => undefined, () => false);
		expect(menuItems('explorer/context')[0]!.disabled).toBe(true);
	});

	it('removeContributions drops the menu entries', () => {
		applyContributions('neophack.git-graph-rs', manifest, nls, () => undefined, () => true);
		removeContributions('neophack.git-graph-rs');
		expect(menuItems('explorer/context')).toHaveLength(0);
	});
});
