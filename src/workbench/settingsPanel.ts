// The Settings dialog (M3 3.9): generated from the setting registry (`SETTING_DEFS` in
// settings.ts) - one row per setting, its control chosen by the schema, searchable, with a
// "modified" marker wherever the value differs from the default. Extensions'
// `contributes.configuration` declarations join as their own section, stored per extension.
// Changes apply immediately, persist to localStorage and write ~/.ggs/settings.json (which a
// hand edit of overrides on the next launch); the labels re-render on a language switch.
//
// The 2026-10-16 redesign: a near-fullscreen, flat, compact editor — every modified row
// carries its own reset-to-default button, and a "Modified" pseudo-category (badge-counted
// in the nav) collects them as one audit-and-restore list.

import { assocListDefaults } from '../platform/ipc/assoc';

import { LOCALES, t, tf } from '../platform/i18n';
import { DEFAULT_SETTINGS, SETTINGS_EVENT, SETTING_DEFS, THEMES, applyEnumSetting, isSettingModified, settings, updateSetting, type SettingDef } from '../platform/settings';
import { extensionSettingDefs, type ExtensionSettingDef } from '../features/extensions';
import { saveExtSetting, extSettings } from '../platform/state';
import { el, icon, notify } from '../platform/ui/index';
import { extLog } from '../features/extensions';

type CategoryId = 'general' | 'appearance' | 'editor' | 'search' | 'extensions' | 'modified';

/** The browseable categories, in nav order. `modified` rides last — an appended
 *  pseudo-category, not a SettingDef's home — so category indexes stay stable. */
const CATEGORIES: CategoryId[] = ['general', 'appearance', 'editor', 'search', 'extensions', 'modified'];

/** The same platform read `Uri`'s win32 default takes: the Terminal Shell row names
 *  shells that exist only on Windows, and hides elsewhere — off Windows the terminal
 *  opens the system's own shell whatever the setting says, so the row would be a
 *  dead control. */
const IS_WINDOWS = typeof navigator !== 'undefined' && /^win/i.test(navigator.platform ?? '');

/** The single open dialog, so a second invocation just re-focuses it. */
let openDialog: HTMLElement | null = null;

/** A labelled control row, laid out as VS Code's Settings editor: label + description left,
 *  the control right; `modified` marks a value that differs from its default, and a
 *  modified row carries a reset button restoring the default in one click. `wide` rows
 *  (the File Associations grid) let the control span the full row under the text. */
function settingRow(label: string, description: string, control: HTMLElement, modified: boolean, opts?: { wide?: boolean; onReset?: () => void }): HTMLElement {
	const row = el('div', 'settings-row' + (modified ? ' modified' : '') + (opts?.wide ? ' wide' : ''));
	if (modified) {
		const mark = el('span', 'settings-modified');
		mark.title = 'Modified - the default is shown in the description';
		row.appendChild(mark);
	}
	const text = el('div', 'settings-row-text', [el('div', 'settings-row-label', [label]), el('div', 'settings-row-description', [description])]);
	// The description clamps to two lines for compactness; the tooltip keeps the full text.
	text.title = description;
	row.appendChild(text);
	const controlCell = el('div', 'settings-row-control', [control]);
	if (modified && opts?.onReset) {
		const reset = el('button', 'settings-reset', [icon('discard')]);
		reset.title = t('settings.resetToDefault');
		reset.setAttribute('aria-label', t('settings.resetToDefault'));
		reset.addEventListener('click', opts.onReset);
		controlCell.appendChild(reset);
	}
	row.appendChild(controlCell);
	return row;
}

function select(value: string, options: { value: string; label: string }[], onChange: (value: string) => void): HTMLSelectElement {
	const select = el('select', 'settings-select') as HTMLSelectElement;
	for (const option of options) {
		// The enum schemas carry their labels as i18n keys (`settings.linuxDmabuf.auto`); the
		// literal labels (theme names, "12 px") pass through `t()` unchanged — an unknown
		// key returns itself — so one path serves both.
		const element = el('option', '', [t(option.label as 'settings.theme')]) as HTMLOptionElement;
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
		// Round to the setting's own step, not to an integer: a `step: 0.1` sensitivity
		// input took 1.5 and stored 2 — the model and the control desynced.
		const snapped = Math.round(parsed / step) * step;
		const digits = (String(step).split('.')[1] ?? '').length;
		onChange(Math.max(min, Math.min(max, Number(snapped.toFixed(digits)))));
	});
	return input;
}

/** The File Associations control: one checkbox per catalogued extension, its checked
 *  state the current selection. The catalogue comes from the backend (`assoc_list_defaults`)
 *  so the platform list and the Settings dialog can never drift apart. The grid lives in a
 *  wrapper so a failed or empty catalogue reads as a full-width message, not a word-broken
 *  strip inside one 64 px grid cell. */
function extensionListControl(): HTMLElement {
	const wrap = el('div', 'settings-extlist-wrap');
	const unavailable = () => wrap.appendChild(el('span', 'empty', [t('assoc.unavailable')]));
	void assocListDefaults()
		.then((catalog) => {
			if (catalog.length === 0) {
				unavailable();
				return;
			}
			const grid = el('div', 'settings-extlist');
			for (const entry of catalog) {
				const box = el('input', 'settings-checkbox') as HTMLInputElement;
				box.type = 'checkbox';
				box.checked = settings.fileAssociations.includes(entry.ext);
				box.addEventListener('change', () => {
					const next = new Set(settings.fileAssociations);
					if (box.checked) next.add(entry.ext);
					else next.delete(entry.ext);
					updateSetting('fileAssociations', [...next]);
				});
				const label = el('label', 'settings-extlist-item', [box, el('span', '', [`.${entry.ext}`])]);
				grid.appendChild(label);
			}
			wrap.appendChild(grid);
		})
		.catch(unavailable);
	return wrap;
}

/** The control one schema entry renders. */
function controlFor(def: SettingDef): HTMLElement {
	switch (def.kind) {
		case 'extensionList':
			return extensionListControl();
		case 'theme':
			return select(settings.theme, THEMES.map((theme) => ({ value: theme.id, label: theme.label })), (value) => updateSetting('theme', value));
		case 'locale':
			return select(settings.locale, LOCALES.map((l) => ({ value: l.id, label: l.label })), (value) => updateSetting('locale', value));
		case 'enum':
			return select(String(settings[def.key]), def.options ?? [], (value) => applyEnumSetting(def, value));
		case 'number':
			return numberInput(settings[def.key] as number, (value) => updateSetting(def.key, value as never), def.min ?? 0, def.max ?? 10000, def.step);
		default:
			return checkbox(settings[def.key] as boolean, (value) => updateSetting(def.key, value as never));
	}
}

/** One extension-declared setting as a row, its control chosen by the declared type. */
function extensionSettingRow(def: ExtensionSettingDef, query: string): HTMLElement | null {
	if (query !== '' && !`${def.extId} ${def.id} ${def.description}`.toLowerCase().includes(query)) return null;
	const stored = extSettings(def.extId);
	const value = def.id in stored ? stored[def.id] : def.default;
	const described = `${def.extId} — ${def.description || t('settings.noDescription')}`;
	const modified = JSON.stringify(value) !== JSON.stringify(def.default);
	const onReset = () => saveExtSetting(def.extId, def.id, def.default);
	if (def.type === 'boolean') {
		return settingRow(def.id, described, checkbox(value === true, (next) => saveExtSetting(def.extId, def.id, next)), modified, { onReset });
	}
	if (def.type === 'enum') {
		// The declared value list as a select; the stored value keeps its type
		// (an enum of numbers stays numbers).
		const values = def.enumValues ?? [];
		const control = select(String(value), values.map((entry) => ({ value: String(entry), label: String(entry) })), (next) => {
			saveExtSetting(def.extId, def.id, values.find((entry) => String(entry) === next) ?? next);
		});
		return settingRow(def.id, described, control, modified, { onReset });
	}
	if (def.type === 'json') {
		// Arrays, objects and multi-type values edit as JSON text; an invalid
		// value is refused (and logged) rather than stored as a string.
		const input = el('input', 'settings-input settings-input-wide') as HTMLInputElement;
		input.type = 'text';
		input.value = JSON.stringify(value ?? null);
		input.addEventListener('change', () => {
			try {
				saveExtSetting(def.extId, def.id, JSON.parse(input.value));
			} catch (error) {
				notify('warning', tf('extensions.invalidJsonSetting', def.id, String(error)));
				extLog('warn', def.extId, `setting ${def.id} rejected: not valid JSON`, String(error));
			}
		});
		return settingRow(def.id, described, input, modified, { onReset });
	}
	const input = el('input', 'settings-input settings-input-wide') as HTMLInputElement;
	input.type = def.type === 'number' ? 'number' : 'text';
	input.value = String(value);
	input.addEventListener('change', () => {
		const raw = def.type === 'number' ? Number(input.value) : input.value;
		saveExtSetting(def.extId, def.id, raw);
	});
	return settingRow(def.id, described, input, modified, { onReset });
}

/** How many settings differ from their default right now — built-ins plus the
 *  extensions' declarations; the nav badge and the Modified category both count it. */
function countModified(): number {
	const builtins = SETTING_DEFS.filter((def) => (!def.windowsOnly || IS_WINDOWS) && isSettingModified(def.key)).length;
	const extensions = extensionSettingDefs().filter((def) => {
		const stored = extSettings(def.extId);
		return JSON.stringify(def.id in stored ? stored[def.id] : def.default) !== JSON.stringify(def.default);
	}).length;
	return builtins + extensions;
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
	// The live result count beside the search box: what a query narrowed the list to.
	const searchCount = el('span', 'settings-search-count');
	const close = el('button', 'settings-close', [icon('chrome-close')]);
	close.title = t('menu.openSettings');
	const dialog = el('div', 'settings-dialog', [
		el('div', 'settings-header', [title, search, searchCount, close]),
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
		const modifiedCount = countModified();
		for (const id of CATEGORIES) {
			// The label wraps in its own span so the Modified badge's count never joins the
			// item's text (tests and a11y read the label alone).
			const item = el('div', 'settings-nav-item' + (id === category ? ' active' : ''), [el('span', 'settings-nav-label', [t(`settings.category.${id}` as 'settings.category.general')])]);
			if (id === 'modified') {
				item.title = t('settings.category.modified');
				if (modifiedCount > 0) {
					const badge = el('span', 'settings-nav-badge', [String(modifiedCount)]);
					item.appendChild(badge);
				}
			}
			item.addEventListener('click', () => {
				category = id;
				render();
			});
			nav.appendChild(item);
		}

		content.textContent = '';
		const categoryTitle = (text: string) => content.appendChild(el('div', 'settings-category-title', [text]));

		if (query !== '') {
			// A search spans every category (VS Code's Settings search does too), whatever
			// the selected category — the extension declarations included.
			const defs = extensionSettingDefs();
			if (defs.length > 0) {
				categoryTitle(t('settings.category.extensions'));
				for (const def of defs) {
					const row = extensionSettingRow(def, query);
					if (row) content.appendChild(row);
				}
			}
			categoryTitle(t('settings.allSettings'));
			for (const def of SETTING_DEFS) {
				if (def.windowsOnly && !IS_WINDOWS) continue;
				const label = t(`settings.${def.key}` as 'settings.theme');
				const description = t(`settings.${def.key}.description` as 'settings.theme.description');
				if (!`${label} ${description} ${def.key}`.toLowerCase().includes(query)) continue;
				content.appendChild(settingRow(label, description, controlFor(def), isSettingModified(def.key), {
					wide: def.kind === 'extensionList',
					onReset: () => updateSetting(def.key, DEFAULT_SETTINGS[def.key])
				}));
			}
		} else if (category === 'modified') {
			// The audit list: every row that differs from its default, ready to reset.
			categoryTitle(t('settings.category.modified'));
			for (const def of SETTING_DEFS) {
				if (def.windowsOnly && !IS_WINDOWS) continue;
				if (!isSettingModified(def.key)) continue;
				content.appendChild(settingRow(t(`settings.${def.key}` as 'settings.theme'), t(`settings.${def.key}.description` as 'settings.theme.description'), controlFor(def), true, {
					wide: def.kind === 'extensionList',
					onReset: () => updateSetting(def.key, DEFAULT_SETTINGS[def.key])
				}));
			}
			for (const def of extensionSettingDefs()) {
				const row = extensionSettingRow(def, '');
				if (row && row.classList.contains('modified')) content.appendChild(row);
			}
		} else {
			if (category === 'extensions') {
				// Browsing the Extensions category shows only those.
				const defs = extensionSettingDefs();
				if (defs.length > 0) {
					for (const def of defs) {
						const row = extensionSettingRow(def, '');
						if (row) content.appendChild(row);
					}
				} else {
					content.appendChild(el('p', 'empty', [t('settings.noExtensionSettings')]));
				}
				searchCount.textContent = '';
				return;
			}
			categoryTitle(t(`settings.category.${category}` as 'settings.category.general'));
			for (const def of SETTING_DEFS) {
				if (def.windowsOnly && !IS_WINDOWS) continue;
				if (def.category !== category) continue;
				content.appendChild(settingRow(t(`settings.${def.key}` as 'settings.theme'), t(`settings.${def.key}.description` as 'settings.theme.description'), controlFor(def), isSettingModified(def.key), {
					wide: def.kind === 'extensionList',
					onReset: () => updateSetting(def.key, DEFAULT_SETTINGS[def.key])
				}));
			}
		}
		if (category === 'modified' && query === '' && !content.querySelector('.settings-row')) {
			content.appendChild(el('p', 'empty', [t('settings.noModified')]));
		}
		if (query !== '' && !content.querySelector('.settings-row')) {
			content.appendChild(el('p', 'empty', [t('settings.noMatching')]));
		}
		searchCount.textContent = query !== '' ? tf('settings.resultCount', content.querySelectorAll('.settings-row').length) : '';
	};
	search.addEventListener('input', render);
	render();
	// The extensions' settings schemas arrive on the async builtin-settings chunk: if it had
	// not landed by the time the dialog opened, its rows appear with this re-render.

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
