import { beforeEach, describe, expect, it } from 'vitest';

import { commands } from '../src/commands';
import { applyContributions, contextUri, evaluateWhen, extensionViewContributions, menuItems, menuSection, normalizeKeybinding, registerContextProvider, removeContributions, type ManifestContributes } from '../src/contributions';
import { saveExtSetting } from '../src/state';

const manifest: ManifestContributes = {
	commands: [
		{ command: 'git-graph-rs.view', title: '%command.view.title%', category: 'Git Graph RS' },
		{ command: 'git-graph-rs.filterByFile', title: '%command.filter.title%' }
	],
	menus: {
		'explorer/context': [{ command: 'git-graph-rs.filterByFile', when: 'resourceScheme == file' }],
		'editor/context': [{ command: 'git-graph-rs.filterByFile' }, { command: 'git-graph-rs.hidden', when: 'false' }],
		'git.pullpush': [
			{ command: 'git-graph-rs.view', when: 'scmProvider == git', group: '3_push@5' },
			{ command: 'git-graph-rs.filterByFile', when: 'scmProvider == svn' }
		],
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
		// git.pullpush (the sync menu) resolves like any location, `when` narrowing included:
		// the git provider's entry shows, the other provider's does not.
		expect(menuItems('git.pullpush').map((item) => item.label)).toEqual(['View Git Graph']);
	});

	it('hands a menu entry the location\'s context as the command\'s arguments', () => {
		// VS Code's (uri, uris) pair, as paths: the Explorer passes the clicked file and the
		// whole selection; a location that passes nothing runs the command bare.
		const run: { command: string; args?: unknown[] }[] = [];
		applyContributions('neophack.git-graph-rs', manifest, nls, (command, args) => run.push({ command, args }), () => true);
		menuItems('explorer/context', ['C:\\repo\\a.txt', ['C:\\repo\\a.txt', 'C:\\repo\\b.txt']])[0]!.run();
		expect(run).toEqual([{ command: 'git-graph-rs.filterByFile', args: ['C:\\repo\\a.txt', ['C:\\repo\\a.txt', 'C:\\repo\\b.txt']] }]);
		run.length = 0;
		menuItems('explorer/context')[0]!.run();
		expect(run).toEqual([{ command: 'git-graph-rs.filterByFile', args: undefined }]);
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

describe('contextUri: the resource argument a menu command receives', () => {
	it('is the data half of a Uri — the shape that crosses the wire into a frame', () => {
		const uri = contextUri('C:\\repo\\a.txt');
		expect(uri.scheme).toBe('file');
		expect(uri.fsPath).toBe('C:\\repo\\a.txt');
		expect(uri.path).toBe('C:\\repo\\a.txt');
		expect(uri.query).toBe('');
		expect(uri.fragment).toBe('');
		// No methods on the payload itself: they cannot cross a structured clone, and the
		// frame's shim (vscodeApi's rehydrateUris) rebuilds them on arrival.
		expect(Object.prototype.hasOwnProperty.call(uri, 'toString')).toBe(false);
	});
});

describe('a view\'s when clause', () => {
	beforeEach(() => {
		removeContributions('acme.views');
	});

	it('rides the view contribution for the workbench\'s visibility filter', () => {
		applyContributions('acme.views', {
			commands: [],
			viewsContainers: { activitybar: [{ id: 'acme.side', title: 'Acme' }] },
			views: {
				'acme.side': [
					{ id: 'acme.tree', name: 'Tree' },
					{ id: 'acme.gated', name: 'Gated', when: 'config.acme.showGated' }
				]
			},
			configuration: { properties: { 'acme.showGated': { type: 'boolean', default: false } } }
		}, {}, () => undefined, () => true);
		const contribution = extensionViewContributions().find((entry) => entry.extId === 'acme.views')!;
		expect(contribution.views.map((view) => view.viewId)).toEqual(['acme.tree', 'acme.gated']);
		// The clause the workbench evaluates: off by the declared default, on when the
		// stored setting turns it on — Code Spell Checker's experimental regexp view shape.
		expect(evaluateWhen('acme.views', contribution.views[1]!.when)).toBe(false);
		saveExtSetting('acme.views', 'acme.showGated', true);
		expect(evaluateWhen('acme.views', contribution.views[1]!.when)).toBe(true);
		saveExtSetting('acme.views', 'acme.showGated', false);
	});

	it('an unset key in the extension\'s own namespace reads false; a foreign unset key still never narrows', () => {
		// Claude Code's shape: the package is `claude-code`, its commands `claude-vscode.*`,
		// and it sets `claude-code:doesNotSupportSecondarySidebar` only on an old host.
		applyContributions('acme.views', {
			commands: [{ command: 'acme-vscode.open', title: 'Open' }],
			views: { side: [{ id: 'chat', name: 'Chat', when: 'views:oldHost' }, { id: 'list', name: 'List', when: 'acme-vscode.listEnabled' }] }
		}, {}, () => undefined, () => true);
		expect(evaluateWhen('acme.views', 'views:oldHost')).toBe(false);
		expect(evaluateWhen('acme.views', '!views:oldHost')).toBe(true);
		expect(evaluateWhen('acme.views', 'acme-vscode.listEnabled')).toBe(false);
		expect(evaluateWhen('acme.views', 'someOtherTool.flag')).toBe(true);
		registerContextProvider('acme-vscode.listEnabled', () => true);
		expect(evaluateWhen('acme.views', 'acme-vscode.listEnabled')).toBe(true);
	});
});
