// The setting registry (M3 3.9): the schema covers every setting, the generated dialog is
// searchable and marks modified values, extension `contributes.configuration` joins as its
// own section, and changes write ~/.ggs/settings.json (which the next launch reads back).

import { beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_SETTINGS, SETTING_DEFS, isSettingModified, loadSettingsFile, settings, updateSetting, type AppSettings } from '../src/platform/settings';
import { applyContributions, extensionSettingDefs, removeContributions } from '../src/features/extensions';
import { openSettingsPanel } from '../src/workbench/settingsPanel';
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

	it('an extension row follows its own save seam - a reset clears the marker and the badge live', () => {
		// Extension rows save through `saveExtSetting`, which dispatches
		// `EXT_SETTINGS_EVENT` — the dialog used to listen to the built-ins' event only,
		// so a toggle or a reset left the row, its modified marker and the badge stale
		// until the dialog was reopened.
		localStorage.removeItem('ggstudio.extSettings.test.ext');
		updateSetting('wordWrap', DEFAULT_SETTINGS.wordWrap); // the beforeEach modified it
		applyContributions('test.ext', {
			configuration: { properties: { 'test.ext.enableCool': { type: 'boolean', default: false, description: 'Cool things on' } } }
		}, {}, () => undefined, () => true);
		openSettingsPanel();
		click(Array.from(document.querySelectorAll('.settings-nav-item')).find((item) => item.textContent === 'Extensions')!);
		// The badge may already count built-ins left modified by an earlier test in this
		// worker's shared jsdom - the extension row contributes a delta over whatever was.
		const badge = () => document.querySelector('.settings-nav-badge')?.textContent;
		const before = badge();
		const box = document.querySelector('.settings-row .settings-checkbox') as HTMLInputElement;
		click(box);
		expect(document.querySelector('.settings-row')!.classList.contains('modified')).toBe(true);
		expect(badge()).toBe(before === undefined ? '1' : String(Number(before) + 1));
		// The reset button rides the same seam: row un-modified, badge back - no reopen.
		click(document.querySelector('.settings-row .settings-reset')!);
		expect(document.querySelector('.settings-row')!.classList.contains('modified')).toBe(false);
		expect(badge()).toBe(before);
		expect(JSON.parse(localStorage.getItem('ggstudio.extSettings.test.ext')!)['test.ext.enableCool']).toBe(false);
		document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		removeContributions('test.ext');
	});

	it('an extension number row keeps its old value on invalid input instead of storing NaN as null', () => {
		localStorage.removeItem('ggstudio.extSettings.test.ext');
		applyContributions('test.ext', {
			configuration: { properties: { 'test.ext.level': { type: 'number', default: 3 } } }
		}, {}, () => undefined, () => true);
		openSettingsPanel();
		click(Array.from(document.querySelectorAll('.settings-nav-item')).find((item) => item.textContent === 'Extensions')!);
		const input = document.querySelector('.settings-row .settings-input') as HTMLInputElement;
		expect(input.type).toBe('number');
		expect(input.value).toBe('3');
		// The DOM sanitizes a number input's bad text to '' (which `Number` reads as 0),
		// so the NaN the guard refuses is forced past the sanitization to pin it: garbage
		// must not reach the store, where JSON serializes NaN as null.
		Object.defineProperty(input, 'value', { value: 'abc', configurable: true });
		input.dispatchEvent(new Event('change', { bubbles: true }));
		expect(JSON.parse(localStorage.getItem('ggstudio.extSettings.test.ext') ?? '{}')['test.ext.level']).toBeUndefined();
		// A readable value still writes.
		Object.defineProperty(input, 'value', { value: '7', configurable: true });
		input.dispatchEvent(new Event('change', { bubbles: true }));
		expect(JSON.parse(localStorage.getItem('ggstudio.extSettings.test.ext')!)['test.ext.level']).toBe(7);
		document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		removeContributions('test.ext');
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
