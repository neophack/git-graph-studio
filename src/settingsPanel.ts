// The Settings dialog (M3 3.9): generated from the setting registry (`SETTING_DEFS` in
// settings.ts) - one row per setting, its control chosen by the schema, searchable, with a
// "modified" marker wherever the value differs from the default. Extensions'
// `contributes.configuration` declarations join as their own section, stored per extension.
// Changes apply immediately, persist to localStorage and write ~/.ggs/settings.json (which a
// hand edit of overrides on the next launch); the labels re-render on a language switch.

import { LOCALES, t } from './i18n';
import { SETTINGS_EVENT, SETTING_DEFS, THEMES, isSettingModified, settings, updateSetting, type SettingDef } from './settings';
import { extensionSettingDefs } from './contributions';
import { ensureBuiltinSettings } from './extHost';
import { saveExtSetting, extSettings } from './state';
import { el, icon } from './ui';

type CategoryId = 'general' | 'appearance' | 'editor' | 'extensions';

/** The single open dialog, so a second invocation just re-focuses it. */
let openDialog: HTMLElement | null = null;

/** A labelled control row, laid out as VS Code's Settings editor: label + description left,
 *  the control right; `modified` marks a value that differs from its default. */
function settingRow(label: string, description: string, control: HTMLElement, modified: boolean): HTMLElement {
	const row = el('div', 'settings-row' + (modified ? ' modified' : ''));
	if (modified) {
		const mark = el('span', 'settings-modified');
		mark.title = 'Modified - the default is shown in the description';
		row.appendChild(mark);
	}
	row.appendChild(el('div', 'settings-row-text', [el('div', 'settings-row-label', [label]), el('div', 'settings-row-description', [description])]));
	row.appendChild(el('div', 'settings-row-control', [control]));
	return row;
}

function select(value: string, options: { value: string; label: string }[], onChange: (value: string) => void): HTMLSelectElement {
	const select = el('select', 'settings-select') as HTMLSelectElement;
	for (const option of options) {
		const element = el('option', '', [option.label]) as HTMLOptionElement;
		element.value = option.value;
		select.appendChild(element);
	}
	select.value = value;
	select.addEventListener('change', () => onChange(select.value));
	return select;
}

function checkbox(value: boolean, onChange: (value: boolean) => void): HTMLInputElement {
	const box = el('input', 'settings-checkbox') as HTMLInputElement;
	box.type = 'checkbox';
	box.checked = value;
	box.addEventListener('change', () => onChange(box.checked));
	return box;
}

/** A numeric control (the auto-save delay), with its bounds enforced on change. */
function numberInput(value: number, onChange: (value: number) => void, min: number, max: number, step = 100): HTMLInputElement {
	const input = el('input', 'settings-input') as HTMLInputElement;
	input.type = 'number';
	input.value = String(value);
	input.min = String(min);
	input.max = String(max);
	input.step = String(step);
	input.addEventListener('change', () => {
		const parsed = Number(input.value);
		if (Number.isNaN(parsed)) return;
		onChange(Math.max(min, Math.min(max, Math.round(parsed))));
	});
	return input;
}

/** The control one schema entry renders. */
function controlFor(def: SettingDef): HTMLElement {
	switch (def.kind) {
		case 'theme':
			return select(settings.theme, THEMES.map((theme) => ({ value: theme.id, label: theme.label })), (value) => updateSetting('theme', value));
		case 'locale':
			return select(settings.locale, LOCALES.map((l) => ({ value: l.id, label: l.label })), (value) => updateSetting('locale', value));
		case 'enum':
			return select(String(settings[def.key]), def.options ?? [], (value) => {
				if (def.key === 'autoSave') updateSetting('autoSave', value as typeof settings.autoSave);
				else updateSetting(def.key, Number(value) as never);
			});
		case 'number':
			return numberInput(settings[def.key] as number, (value) => updateSetting(def.key, value as never), def.min ?? 0, def.max ?? 10000, def.step);
		default:
			return checkbox(settings[def.key] as boolean, (value) => updateSetting(def.key, value as never));
	}
}

export function openSettingsPanel(): void {
	// A dialog left over from a torn-down DOM (a test, a reload) must not block a fresh one.
	if (openDialog && !openDialog.isConnected) openDialog = null;
	if (openDialog) {
		openDialog.querySelector<HTMLElement>('.settings-search, select, input')?.focus();
		return;
	}

	const overlay = el('div', 'settings-overlay');
	const content = el('div', 'settings-content');
	const nav = el('div', 'settings-nav');
	const title = el('span', 'settings-title', [t('settings.title')]);
	const search = el('input', 'input settings-search') as HTMLInputElement;
	search.type = 'text';
	search.placeholder = t('settings.searchPlaceholder');
	search.spellcheck = false;
	const close = el('button', 'settings-close', [icon('chrome-close')]);
	close.title = t('menu.openSettings');
	const dialog = el('div', 'settings-dialog', [
		el('div', 'settings-header', [title, search, close]),
		el('div', 'settings-body', [nav, content])
	]);
	overlay.appendChild(dialog);
	document.getElementById('overlays')!.appendChild(overlay);
	openDialog = overlay;

	let category: CategoryId = 'general';

	const render = () => {
		title.textContent = t('settings.title');
		close.title = t('menu.openSettings');
		search.placeholder = t('settings.searchPlaceholder');
		nav.textContent = '';
		const query = search.value.trim().toLowerCase();
		const categories: CategoryId[] = ['general', 'appearance', 'editor', 'extensions'];
		for (const id of categories) {
			const item = el('div', 'settings-nav-item' + (id === category ? ' active' : ''), [t(`settings.category.${id}` as 'settings.category.general')]);
			item.addEventListener('click', () => {
				category = id;
				render();
			});
			nav.appendChild(item);
		}

		content.textContent = '';
		// A search reaches the extension declarations too, whatever the category.
		if (category === 'extensions' || query !== '') {
			const defs = extensionSettingDefs();
			if (defs.length > 0) {
				content.appendChild(el('div', 'settings-category-title', [t('settings.category.extensions')]));
				for (const def of defs) {
					if (query !== '' && !`${def.extId} ${def.id} ${def.description}`.toLowerCase().includes(query)) continue;
					const stored = extSettings(def.extId);
					const value = def.id in stored ? stored[def.id] : def.default;
					if (def.type === 'boolean') {
						const box = checkbox(value === true, (next) => saveExtSetting(def.extId, def.id, next));
						content.appendChild(settingRow(def.id, `${def.extId} — ${def.description || t('settings.noDescription')}`, box, value !== def.default));
					} else {
						const input = el('input', 'settings-input') as HTMLInputElement;
						input.type = def.type === 'number' ? 'number' : 'text';
						input.value = String(value);
						input.addEventListener('change', () => {
							const raw = def.type === 'number' ? Number(input.value) : input.value;
							saveExtSetting(def.extId, def.id, raw);
						});
						content.appendChild(settingRow(def.id, `${def.extId} — ${def.description || t('settings.noDescription')}`, input, String(value) !== String(def.default)));
					}
				}
			} else if (category === 'extensions' && query === '') {
				content.appendChild(el('p', 'empty', [t('settings.noExtensionSettings')]));
			}
			// Browsing the Extensions category shows only those; a search goes on to the
			// built-in settings whichever category is selected.
			if (category === 'extensions' && query === '') return;
		}

		// A search spans every category (VS Code's Settings search does too); browsing keeps
		// the category's rows.
		content.appendChild(el('div', 'settings-category-title', [query === '' ? t(`settings.category.${category}` as 'settings.category.general') : t('settings.allSettings')]));
		for (const def of SETTING_DEFS) {
			if (query === '' && def.category !== category) continue;
			const label = t(`settings.${def.key}` as 'settings.theme');
			const description = t(`settings.${def.key}.description` as 'settings.theme.description');
			if (query !== '' && !`${label} ${description} ${def.key}`.toLowerCase().includes(query)) continue;
			content.appendChild(settingRow(label, description, controlFor(def), isSettingModified(def.key)));
		}
		if (!content.querySelector('.settings-row')) content.appendChild(el('p', 'empty', [t('settings.noMatching')]));
	};
	search.addEventListener('input', render);
	render();
	// The extensions' settings schemas arrive on the async builtin-settings chunk: if it had
	// not landed by the time the dialog opened, its rows appear with this re-render.
	void ensureBuiltinSettings().then(() => render());

	const closeDialog = () => {
		document.removeEventListener('keydown', onKeyDown);
		document.removeEventListener(SETTINGS_EVENT, render);
		overlay.remove();
		openDialog = null;
	};
	const onKeyDown = (event: KeyboardEvent) => {
		if (event.key === 'Escape') closeDialog();
	};
	// A language switch re-renders the labels in place; control state comes from `settings`.
	document.addEventListener(SETTINGS_EVENT, render);
	document.addEventListener('keydown', onKeyDown);
	overlay.addEventListener('mousedown', (event) => {
		if (event.target === overlay) closeDialog();
	});
	close.addEventListener('click', closeDialog);
	search.focus();
}
