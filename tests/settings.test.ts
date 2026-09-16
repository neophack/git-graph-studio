// The settings layer: the persisted defaults (the code outline is off until the user turns it
// on), theme switching (the stylesheet link and the vscode-* classes), the display-language
// table, and the Settings dialog's categories and controls.

import { beforeEach, describe, expect, it } from 'vitest';

import { setLocale, t } from '../src/i18n';
import { DEFAULT_SETTINGS, THEMES, applyTheme, migrateStoredSettings, settings, updateSetting } from '../src/settings';
import { openSettingsPanel } from '../src/settingsPanel';
import { EditorGroup } from '../src/editor';
import { backend } from './tauriMock';
import { click, flush, texts } from './helpers';

function themeLink(): HTMLLinkElement {
	const link = document.createElement('link');
	link.id = 'theme-css';
	link.rel = 'stylesheet';
	link.href = '/theme/dark-modern.css';
	document.head.appendChild(link);
	return link;
}

beforeEach(() => {
	setLocale('en');
	settings.theme = 'dark-modern';
	settings.locale = 'en';
	settings.showOutline = false;
	localStorage.clear();
});

describe('settings store', () => {
	it('ships at least three switchable themes', () => {
		expect(THEMES.length).toBeGreaterThanOrEqual(3);
		expect(THEMES.map((theme) => theme.id)).toContain('light-modern');
	});

	it('defaults the code outline to off', () => {
		expect(settings.showOutline).toBe(false);
	});

	it('migrates a stored wheel sensitivity that was only ever a shipped default', () => {
		// The whole settings object persists on any change, so a store from an older release
		// pins the *default* of the day: 1 and 2 were shipped defaults (never user picks) and
		// follow the current default; any other value is the user's own and stands.
		expect(DEFAULT_SETTINGS.mouseWheelScrollSensitivity).toBe(3);
		expect(migrateStoredSettings({ mouseWheelScrollSensitivity: 1 }).mouseWheelScrollSensitivity).toBe(3);
		expect(migrateStoredSettings({ mouseWheelScrollSensitivity: 2 }).mouseWheelScrollSensitivity).toBe(3);
		expect(migrateStoredSettings({ mouseWheelScrollSensitivity: 0.5 }).mouseWheelScrollSensitivity).toBe(0.5);
		expect(migrateStoredSettings({ mouseWheelScrollSensitivity: 5 }).mouseWheelScrollSensitivity).toBe(5);
		expect(migrateStoredSettings({}).mouseWheelScrollSensitivity).toBeUndefined();
	});

	it('persists a change and notifies the workbench', () => {
		const heard: string[] = [];
		const listener = (event: Event) => heard.push((event as CustomEvent).detail);
		document.addEventListener('app:settings-changed', listener);
		updateSetting('showOutline', true);
		expect(settings.showOutline).toBe(true);
		expect(heard).toEqual(['showOutline']);
		expect(JSON.parse(localStorage.getItem('ggstudio.appSettings')!)).toMatchObject({ showOutline: true });
		// A no-op change does not fire again.
		updateSetting('showOutline', true);
		expect(heard).toEqual(['showOutline']);
		document.removeEventListener('app:settings-changed', listener);
	});

	it('switching the theme swaps the stylesheet and the vscode-* classes', () => {
		const link = themeLink();
		applyTheme('light-modern');
		expect(link.getAttribute('href')).toBe('/theme/light-modern.css');
		expect(document.body.classList.contains('vscode-light')).toBe(true);
		expect(document.body.dataset['vscodeThemeName']).toBe('Light Modern');
		applyTheme('monokai');
		expect(link.getAttribute('href')).toBe('/theme/monokai.css');
		expect(document.body.classList.contains('vscode-dark')).toBe(true);
		// An unknown theme id falls back to the first theme instead of a missing stylesheet.
		applyTheme('nope');
		expect(link.getAttribute('href')).toBe('/theme/dark-modern.css');
	});

	it('switching the locale through the settings switches the string table', () => {
		updateSetting('locale', 'zh-cn');
		expect(t('menu.file')).toBe('文件');
		updateSetting('locale', 'en');
		expect(t('menu.file')).toBe('File');
		// An unknown key falls back to itself rather than rendering blank.
		expect(t('not.a.key' as 'menu.file')).toBe('not.a.key');
	});
});

describe('settings dialog', () => {
	it('groups its controls into categories', () => {
		openSettingsPanel();
		expect(texts('.settings-nav-item')).toEqual(['General', 'Appearance', 'Editor', 'Search', 'Extensions']);
		// General holds the language picker, Appearance the theme picker.
		expect(document.querySelector('.settings-content .settings-select')).not.toBeNull();
		click(document.querySelectorAll('.settings-nav-item')[1]!);
		const themeSelect = document.querySelector('.settings-select') as HTMLSelectElement;
		expect(themeSelect).not.toBeNull();
		expect(themeSelect.querySelectorAll('option')).toHaveLength(THEMES.length);
		// Editor holds the outline toggle, off by default. Its checkbox is found by row
		// label - the editor category carries several toggles now.
		click(document.querySelectorAll('.settings-nav-item')[2]!);
		const box = Array.from(document.querySelectorAll('.settings-row'))
			.find((row) => row.querySelector('.settings-row-label')?.textContent === 'Show Code Outline')
			?.querySelector('.settings-checkbox') as HTMLInputElement;
		expect(box).not.toBeNull();
		expect(box.checked).toBe(false);
		click(box);
		expect(settings.showOutline).toBe(true);
		expect(JSON.parse(localStorage.getItem('ggstudio.appSettings')!)).toMatchObject({ showOutline: true });
	});

	it('relabels itself when the display language changes', () => {
		openSettingsPanel();
		const language = document.querySelector('.settings-select') as HTMLSelectElement;
		language.value = 'zh-cn';
		language.dispatchEvent(new Event('change', { bubbles: true }));
		expect(texts('.settings-nav-item')).toEqual(['常规', '外观', '编辑器', '搜索', '扩展']);
		expect(document.querySelector('.settings-title')!.textContent).toBe('设置');
		// Escape closes the dialog.
		document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		expect(document.querySelector('.settings-overlay')).toBeNull();
	});
});

describe('the editor outline setting', () => {
	function scriptBackend(): void {
		backend.on('read_file', ({ path }) => ({ contents: 'fn main() {}\n', binary: false, size: 14, path }));
		backend.on('viewer_open', ({ path }) => ({
			docId: 3,
			lineCount: 1,
			language: 'rs',
			syntaxName: 'Rust',
			symbols: [{ kind: 'function', name: 'main', line: 0 }],
			path
		}));
		backend.on('viewer_close', () => null);
	}

	it('keeps the outline hidden by default and shows it when enabled', async () => {
		scriptBackend();
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		group.setRoot('C:\\repo');
		await group.openFile('C:\\repo\\main.rs');
		await flush();
		expect(document.querySelector('.editor-outline')).toBeNull();

		updateSetting('showOutline', true);
		await flush();
		const items = texts('.editor-outline-item');
		expect(items).toEqual(['main']);
		// The outline document was released again after its symbols were read.
		expect(backend.callsTo('viewer_close')).toHaveLength(1);

		updateSetting('showOutline', false);
		await flush();
		expect(document.querySelector('.editor-outline')).toBeNull();
		await group.closeAll();
	});
});
