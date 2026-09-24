// The File Associations setting (cmd_assoc / settings): the backend catalogue drives
// the Settings dialog's checkbox grid, the defaults are the formats GGS is built
// around, and a change re-registers at the OS level through `assoc_apply`.
// The Explorer context-menu setting rides the same module: a boot-time re-apply keeps
// the verb pointing at the executable's current path, and a change registers or
// removes it through `context_menu_apply`.

import { beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_SETTINGS, SETTING_DEFS, initSettings, isSettingModified, settings, updateSetting } from '../src/settings';
import { openSettingsPanel } from '../src/settingsPanel';
import { backend } from './tauriMock';
import { click, flush, notifications, texts } from './helpers';

const CATALOG = [
	{ ext: 'blf', mime: 'application/x-vector-blf', recommended: true },
	{ ext: 'asc', mime: 'application/x-vector-asc', recommended: true },
	{ ext: 'bin', mime: 'application/octet-stream', recommended: true },
	{ ext: 'hex', mime: 'application/x-hex', recommended: true },
	{ ext: 'json', mime: 'application/json', recommended: false },
	{ ext: 'md', mime: 'text/markdown', recommended: false }
];

beforeEach(() => {
	document.getElementById('overlays')!.innerHTML = '';
	settings.fileAssociations = [...DEFAULT_SETTINGS.fileAssociations];
	settings.explorerContextMenu = DEFAULT_SETTINGS.explorerContextMenu;
	backend.on('assoc_list_defaults', () => CATALOG);
	backend.on('settings_write', () => null);
	backend.on('assoc_apply', ({ extensions }) => ({ messageKey: 'assoc.applied.linux', detail: `${(extensions as string[]).length} extension(s)` }));
	backend.on('context_menu_apply', ({ on }) => ({ messageKey: on ? 'contextmenu.applied.on' : 'contextmenu.applied.off', detail: '' }));
});

describe('the file associations setting', () => {
	it('defaults to the recommended formats', () => {
		expect(DEFAULT_SETTINGS.fileAssociations).toEqual(['blf', 'asc', 'bin', 'hex']);
		expect(isSettingModified('fileAssociations')).toBe(false);
	});

	it('is registered as the general category extensionList setting', () => {
		const def = SETTING_DEFS.find((d) => d.key === 'fileAssociations')!;
		expect(def.kind).toBe('extensionList');
		expect(def.category).toBe('general');
	});

	it('a change re-registers through assoc_apply', async () => {
		updateSetting('fileAssociations', ['blf', 'asc']);
		await flush();
		expect(settings.fileAssociations).toEqual(['blf', 'asc']);
		expect(isSettingModified('fileAssociations')).toBe(true);
		const calls = backend.callsTo('assoc_apply');
		expect(calls).toHaveLength(1);
		expect((calls[0] as { extensions: string[] }).extensions).toEqual(['blf', 'asc']);
	});

	it('an unchanged selection does not re-register', async () => {
		updateSetting('fileAssociations', [...DEFAULT_SETTINGS.fileAssociations]);
		await flush();
		expect(backend.callsTo('assoc_apply')).toHaveLength(0);
	});
});

describe('the settings dialog row', () => {
	it('renders one checkbox per catalogued extension with the defaults checked', async () => {
		openSettingsPanel();
		await flush();
		expect(texts('.settings-extlist-item')).toEqual(['.blf', '.asc', '.bin', '.hex', '.json', '.md']);
		const jsonBox = () => Array.from(document.querySelectorAll('.settings-extlist-item')).find((item) => item.textContent === '.json')!.querySelector('input') as HTMLInputElement;
		expect(jsonBox().checked).toBe(false);

		// The row re-renders on every change, so each click re-queries the fresh checkbox.
		click(jsonBox());
		await flush();
		expect(settings.fileAssociations).toContain('json');
		expect((backend.callsTo('assoc_apply').at(-1) as { extensions: string[] }).extensions).toContain('json');

		// Unchecking withdraws the registration again.
		click(jsonBox());
		await flush();
		expect(settings.fileAssociations).not.toContain('json');
	});
});

describe('the Explorer context menu setting', () => {
	it('defaults to on and is the general category boolean setting', () => {
		expect(DEFAULT_SETTINGS.explorerContextMenu).toBe(true);
		expect(isSettingModified('explorerContextMenu')).toBe(false);
		const def = SETTING_DEFS.find((d) => d.key === 'explorerContextMenu')!;
		expect(def.kind).toBe('boolean');
		expect(def.category).toBe('general');
	});

	it('a change registers or removes through context_menu_apply, with the localized title', async () => {
		updateSetting('explorerContextMenu', false);
		await flush();
		expect(settings.explorerContextMenu).toBe(false);
		let calls = backend.callsTo('context_menu_apply');
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({ on: false, label: 'Open with Git Graph Studio' });
		// A visible change notifies; turning it back on goes through the same command.
		updateSetting('explorerContextMenu', true);
		await flush();
		calls = backend.callsTo('context_menu_apply');
		expect(calls).toHaveLength(2);
		expect(calls[1]).toMatchObject({ on: true, label: 'Open with Git Graph Studio' });
	});

	it('boot re-applies the verb quietly (no notification)', async () => {
		const before = notifications().length;
		initSettings();
		await flush();
		const calls = backend.callsTo('context_menu_apply');
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({ on: true, label: 'Open with Git Graph Studio' });
		expect(notifications().length).toBe(before);
	});

	it('renders as a General checkbox that applies on click', async () => {
		openSettingsPanel();
		await flush();
		const row = Array.from(document.querySelectorAll('.settings-row')).find((r) => r.querySelector('.settings-row-label')?.textContent === 'Explorer Context Menu');
		expect(row).toBeTruthy();
		const box = row!.querySelector('.settings-checkbox') as HTMLInputElement;
		expect(box.checked).toBe(true);
		click(box);
		await flush();
		expect(settings.explorerContextMenu).toBe(false);
		expect((backend.callsTo('context_menu_apply').at(-1) as { on: boolean }).on).toBe(false);
	});
});
