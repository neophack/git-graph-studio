// The setting registry (M3 3.9): the schema covers every setting, the generated dialog is
// searchable and marks modified values, extension `contributes.configuration` joins as its
// own section, and changes write ~/.ggs/settings.json (which the next launch reads back).

import { beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_SETTINGS, SETTING_DEFS, isSettingModified, loadSettingsFile, settings, updateSetting, type AppSettings } from '../src/settings';
import { applyContributions, extensionSettingDefs, removeContributions } from '../src/contributions';
import { openSettingsPanel } from '../src/settingsPanel';
import { backend } from './tauriMock';
import { click, texts, type } from './helpers';

describe('the setting registry', () => {
	it('covers every setting exactly once, with a category', () => {
		const keys = SETTING_DEFS.map((def) => def.key).sort();
		const expected = Object.keys(DEFAULT_SETTINGS).sort() as (keyof AppSettings)[];
		expect(keys).toEqual(expected);
		expect(new Set(keys).size).toBe(keys.length);
	});

	it('flags modified values against the defaults', () => {
		updateSetting('tabSize', 2);
		expect(isSettingModified('tabSize')).toBe(true);
		expect(isSettingModified('wordWrap')).toBe(false);
		updateSetting('tabSize', DEFAULT_SETTINGS.tabSize as number);
		expect(isSettingModified('tabSize')).toBe(false);
	});
});

describe('the generated dialog', () => {
	beforeEach(() => {
		document.getElementById('overlays')!.innerHTML = '';
		updateSetting('wordWrap', true);
	});

	it('searches across labels and descriptions', () => {
		openSettingsPanel();
		const search = document.querySelector('.settings-search') as HTMLInputElement;
		type(search, 'brackets');
		const labels = texts('.settings-row-label');
		expect(labels).toEqual(['Bracket Pair Colorization']);
		type(search, 'no such setting anywhere');
		expect(texts('.settings-row-label')).toEqual([]);
		expect(texts('.settings-content .empty')).toEqual(['No matching settings']);
	});

	it('marks the modified rows', () => {
		openSettingsPanel();
		click(Array.from(document.querySelectorAll('.settings-nav-item')).find((item) => item.textContent === 'Editor')!);
		const rows = Array.from(document.querySelectorAll('.settings-row'));
		const wrapRow = rows.find((row) => row.querySelector('.settings-row-label')?.textContent === 'Word Wrap');
		expect(wrapRow!.classList.contains('modified')).toBe(true);
		const minimapRow = rows.find((row) => row.querySelector('.settings-row-label')?.textContent === 'Minimap');
		expect(minimapRow!.classList.contains('modified')).toBe(false);
	});

	it('lists extension-declared settings under Extensions', () => {
		applyContributions('test.ext', {
			configuration: {
				properties: {
					'test.ext.enableCool': { type: 'boolean', default: false, description: 'Cool things on' },
					'test.ext.level': { type: 'number', default: 3 }
				}
			}
		}, {}, () => undefined, () => true);
		openSettingsPanel();
		click(Array.from(document.querySelectorAll('.settings-nav-item')).find((item) => item.textContent === 'Extensions')!);
		expect(texts('.settings-row-label')).toEqual(['test.ext.enableCool', 'test.ext.level']);
		// A boolean toggle writes the extension's own settings store.
		const box = document.querySelector('.settings-row .settings-checkbox') as HTMLInputElement;
		click(box);
		expect(JSON.parse(localStorage.getItem('ggstudio.extSettings.test.ext')!)['test.ext.enableCool']).toBe(true);
		removeContributions('test.ext');
		expect(extensionSettingDefs()).toHaveLength(0);
	});
});

describe('settings.json (both ways)', () => {
	beforeEach(() => {
		localStorage.clear();
	});

	it('a change writes the file, and the file wins on the next load', async () => {
		let written: string | null = null;
		backend.on('settings_write', ({ contents }) => {
			written = String(contents);
			return null;
		});
		updateSetting('fontSize', 18);
		expect(written).not.toBeNull();
		expect(JSON.parse(written!)).toMatchObject({ fontSize: 18 });

		// A hand edit of the file is read back over the stored settings.
		backend.on('settings_read', () => JSON.stringify({ fontSize: 20, wordWrap: true }));
		await loadSettingsFile();
		expect(settings.fontSize).toBe(20);
		expect(settings.wordWrap).toBe(true);
	});

	it('an unparsable or absent file leaves the stored settings alone', async () => {
		const before = settings.fontSize;
		backend.on('settings_read', () => 'not json {');
		await loadSettingsFile();
		expect(settings.fontSize).toBe(before);
		backend.on('settings_read', () => null);
		await loadSettingsFile();
		expect(settings.fontSize).toBe(before);
	});
});
