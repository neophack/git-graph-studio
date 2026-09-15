// The File Associations setting (cmd_assoc / settings): the backend catalogue drives
// the Settings dialog's checkbox grid, the defaults are the formats GGS is built
// around, and a change re-registers at the OS level through `assoc_apply`.

import { beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_SETTINGS, SETTING_DEFS, isSettingModified, settings, updateSetting } from '../src/settings';
import { openSettingsPanel } from '../src/settingsPanel';
import { backend } from './tauriMock';
import { click, flush, texts } from './helpers';

const CATALOG = [
	{ ext: 'blf', mime: 'application/x-vector-blf', recommended: true },
	{ ext: 'asc', mime: 'application/x-vector-asc', recommended: true },
	{ ext: 'ggx', mime: 'application/x-ggs-extension', recommended: true },
	{ ext: 'bin', mime: 'application/octet-stream', recommended: true },
	{ ext: 'hex', mime: 'application/x-hex', recommended: true },
	{ ext: 'json', mime: 'application/json', recommended: false },
	{ ext: 'md', mime: 'text/markdown', recommended: false }
];

beforeEach(() => {
	document.getElementById('overlays')!.innerHTML = '';
	settings.fileAssociations = [...DEFAULT_SETTINGS.fileAssociations];
	backend.on('assoc_list_defaults', () => CATALOG);
	backend.on('settings_write', () => null);
	backend.on('assoc_apply', ({ extensions }) => ({ messageKey: 'assoc.applied.linux', detail: `${(extensions as string[]).length} extension(s)` }));
});

describe('the file associations setting', () => {
	it('defaults to the recommended formats', () => {
		expect(DEFAULT_SETTINGS.fileAssociations).toEqual(['blf', 'asc', 'ggx', 'bin', 'hex']);
		expect(isSettingModified('fileAssociations')).toBe(false);
	});

	it('is registered as the general category extensionList setting', () => {
		const def = SETTING_DEFS.find((d) => d.key === 'fileAssociations')!;
		expect(def.kind).toBe('extensionList');
		expect(def.category).toBe('general');
	});

	it('a change re-registers through assoc_apply', async () => {
		updateSetting('fileAssociations', ['blf', 'ggx']);
		await flush();
		expect(settings.fileAssociations).toEqual(['blf', 'ggx']);
		expect(isSettingModified('fileAssociations')).toBe(true);
		const calls = backend.callsTo('assoc_apply');
		expect(calls).toHaveLength(1);
		expect((calls[0] as { extensions: string[] }).extensions).toEqual(['blf', 'ggx']);
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
		expect(texts('.settings-extlist-item')).toEqual(['.blf', '.asc', '.ggx', '.bin', '.hex', '.json', '.md']);
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
