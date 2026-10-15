// The phone's Settings page (docs/ggs-remote-plan.md §11.2): the desktop Settings dialog is a
// 720 px two-pane window — on a 390 px screen its 170 px category rail leaves the rows a
// 130 px strip, which is why Settings on a phone was unreadable. The page is phone-native
// instead: full-screen, one column, the categories as drill-in rows, each level sliding in
// from the right with a back step — and the phone's back button pops one level at a time
// before it closes the page. Every row drives the same registry the desktop dialog does
// (`SETTING_DEFS` + `updateSetting`, the extension declarations through `saveExtSetting`),
// so the two shapes of UI are one source of settings: a choice (a theme, an enum) picks
// from an action sheet, a boolean is the row's own switch, a number steps in a sheet
// (− value +, a typed value snapping to the setting's step), and the File Associations
// catalogue is a level of its own over the backend list. The root's search spans every
// category and the extension declarations, like the desktop's.
import { commands, type Command } from '../platform/commands';
import { extensionSettingDefs, type ExtensionSettingDef } from '../features/extensions';
import { LOCALES, t, tf, type LocaleKey } from '../platform/i18n';
import { SETTINGS_EVENT, SETTING_DEFS, THEMES, applyEnumSetting, isSettingModified, settings, updateSetting, type SettingDef } from '../platform/settings';
import { extSettings, saveExtSetting } from '../platform/state';
import { notify } from '../platform/ui';
import { extLog } from '../features/extensions';
import { assocListDefaults } from '../platform/ipc/assoc';
import { closeActionSheet, openSheet, showActionSheet, sheetOpen } from './actionSheet';
import { pushBack } from './backStack';
import { setDataSaver } from './dataSaver';
import { codicon, toggleSwitch } from './widgets';

/** The page's categories: the phone's own Remote section, the registry's four, extensions. */
type CategoryId = 'remote' | 'general' | 'appearance' | 'editor' | 'search' | 'extensions';

const CATEGORIES: { id: CategoryId; icon: string }[] = [
	{ id: 'remote', icon: 'globe' },
	{ id: 'general', icon: 'gear' },
	{ id: 'appearance', icon: 'symbol-color' },
	{ id: 'editor', icon: 'code' },
	{ id: 'search', icon: 'search' },
	{ id: 'extensions', icon: 'extensions' }
];

const BUILTIN_CATEGORIES = ['general', 'appearance', 'editor', 'search'] as const;

type Level = { kind: 'root' } | { kind: 'category'; id: CategoryId } | { kind: 'fileTypes' };

/** The one open page and its level stack (the root plus whatever was drilled into). */
let page: HTMLElement | null = null;
let stack: Level[] = [];
let releaseBack: (() => void) | null = null;
let query = '';

export function settingsPageOpen(): boolean {
	return page !== null;
}

/** Option labels that are i18n keys resolve; plain labels (theme names, "14 px") pass through. */
function optionLabel(label: string): string {
	return label.startsWith('settings.') ? t(label as LocaleKey) : label;
}

/* ---------- Rows ---------- */

/** The row every setting renders as: the label with its description under it, the control
 *  (a switch, the current value with a chevron) on the trailing edge, a dot when modified. */
function settingRow(options: { label: string; description?: string; modified?: boolean; control?: HTMLElement; run?: () => void }): HTMLButtonElement {
	const button = document.createElement('button');
	button.className = 'ggs-settings-row' + (options.modified ? ' modified' : '');
	button.disabled = !options.run;
	const text = document.createElement('span');
	text.className = 'text';
	const label = document.createElement('span');
	label.className = 'label';
	label.textContent = options.label;
	text.appendChild(label);
	if (options.description) {
		const description = document.createElement('span');
		description.className = 'desc';
		description.textContent = options.description;
		text.appendChild(description);
	}
	button.appendChild(text);
	if (options.control) button.appendChild(options.control);
	button.addEventListener('click', () => options.run?.());
	return button;
}

/** A category's drill-in row, with a leading icon. */
function iconRow(iconName: string, label: string, run: () => void): HTMLButtonElement {
	const button = settingRow({ label, control: codicon('chevron-right'), run });
	const icon = codicon(iconName);
	icon.classList.add('ggs-settings-icon');
	button.prepend(icon);
	return button;
}

function chevron(): HTMLElement {
	return codicon('chevron-right');
}

function valueLabel(text: string): HTMLElement {
	const value = document.createElement('span');
	value.className = 'value';
	value.textContent = text;
	return value;
}

/** The trailing edge of a choice row: the current value, then the chevron. */
function valueControl(text: string): HTMLElement {
	const control = document.createElement('span');
	control.className = 'ggs-settings-value';
	control.append(valueLabel(text), chevron());
	return control;
}

/** A boolean: the whole row toggles, the switch follows. */
function boolRow(label: string, description: string, modified: boolean, read: () => boolean, write: (next: boolean) => void): HTMLButtonElement {
	return settingRow({ label, description, modified, control: toggleSwitch(read()), run: () => {
		write(!read());
		rerender();
	} });
}

interface ChoiceOptions {
	label: string;
	current: string;
	choices: { value: string; label: string }[];
	onPick: (value: string) => void;
}

/** A choice: the row names the setting and its current value; a tap picks from a sheet. */
function choiceRow(options: ChoiceOptions & { description: string; modified: boolean }): HTMLButtonElement {
	const current = options.choices.find((choice) => choice.value === options.current);
	return settingRow({
		label: options.label,
		description: options.description,
		modified: options.modified,
		control: valueControl(current ? optionLabel(current.label) : options.current),
		run: () => showChoiceSheet(options)
	});
}

function showChoiceSheet(options: ChoiceOptions): void {
	showActionSheet(
		options.choices.map((choice) => ({
			label: optionLabel(choice.label),
			checked: choice.value === options.current,
			run: () => {
				options.onPick(choice.value);
				rerender();
			}
		})),
		options.label
	);
}

/** A number: the row names the setting and its value; a tap opens the − value + stepper. */
function numberRow(def: SettingDef): HTMLButtonElement {
	return settingRow({
		label: t(`settings.${def.key}` as LocaleKey),
		description: t(`settings.${def.key}.description` as LocaleKey),
		modified: isSettingModified(def.key),
		control: valueControl(String(settings[def.key])),
		run: () => numberSheet(def)
	});
}

function numberSheet(def: SettingDef): void {
	const min = def.min ?? 0;
	const max = def.max ?? 10000;
	const step = def.step ?? 1;
	const digits = (String(step).split('.')[1] ?? '').length;
	const display = document.createElement('input');
	display.type = 'number';
	display.inputMode = 'decimal';
	display.value = String(settings[def.key]);
	display.min = String(min);
	display.max = String(max);
	display.step = String(step);
	const apply = (raw: number) => {
		if (Number.isNaN(raw)) return;
		// Snap to the setting's own step, as the desktop's number input does.
		const snapped = Math.round(raw / step) * step;
		updateSetting(def.key, Math.max(min, Math.min(max, Number(snapped.toFixed(digits)))) as never);
		display.value = String(settings[def.key]);
	};
	display.addEventListener('change', () => apply(Number(display.value)));
	const stepButton = (iconName: string, direction: 1 | -1) => {
		const button = document.createElement('button');
		button.appendChild(codicon(iconName));
		button.setAttribute('aria-label', direction > 0 ? '+' : '−');
		button.addEventListener('click', () => apply(Number(settings[def.key]) + direction * step));
		return button;
	};
	const body = document.createElement('div');
	body.className = 'ggs-number-picker';
	body.append(stepButton('remove', -1), display, stepButton('add', 1));
	openSheet({ title: t(`settings.${def.key}` as LocaleKey), subtitle: t(`settings.${def.key}.description` as LocaleKey), body });
}

/** The File Associations control's row: the selection joined, a tap opens its own level. */
function fileAssociationsRow(): HTMLButtonElement {
	return settingRow({
		label: t('settings.fileAssociations'),
		description: t('settings.fileAssociations.description'),
		modified: isSettingModified('fileAssociations'),
		control: valueControl(settings.fileAssociations.map((ext) => `.${ext}`).join(', ') || '—'),
		run: () => pushLevel({ kind: 'fileTypes' })
	});
}

function settingRowFor(def: SettingDef): HTMLButtonElement {
	const label = t(`settings.${def.key}` as LocaleKey);
	const description = t(`settings.${def.key}.description` as LocaleKey);
	switch (def.kind) {
		case 'boolean':
			return boolRow(label, description, isSettingModified(def.key), () => settings[def.key] === true, (next) => updateSetting(def.key, next as never));
		case 'theme':
			return choiceRow({ label, description, modified: isSettingModified('theme'), current: settings.theme,
				choices: THEMES.map((theme) => ({ value: theme.id, label: theme.label })), onPick: (value) => updateSetting('theme', value) });
		case 'locale':
			return choiceRow({ label, description, modified: isSettingModified('locale'), current: settings.locale,
				choices: LOCALES.map((l) => ({ value: l.id, label: l.label })), onPick: (value) => updateSetting('locale', value) });
		case 'enum':
			return choiceRow({ label, description, modified: isSettingModified(def.key), current: String(settings[def.key]),
				choices: def.options ?? [], onPick: (value) => applyEnumSetting(def, value) });
		case 'number':
			return numberRow(def);
		default:
			return fileAssociationsRow();
	}
}

/** An extension-declared setting: booleans toggle, enums pick, the rest edit as text/JSON. */
function extensionSettingRow(def: ExtensionSettingDef): HTMLButtonElement {
	const description = `${def.extId} — ${def.description || t('settings.noDescription')}`;
	const stored = extSettings(def.extId);
	const value = def.id in stored ? stored[def.id] : def.default;
	const modified = JSON.stringify(value) !== JSON.stringify(def.default);
	if (def.type === 'boolean') {
		return boolRow(def.id, description, modified, () => value === true, (next) => saveExtSetting(def.extId, def.id, next));
	}
	if (def.type === 'enum') {
		return settingRow({ label: def.id, description, modified, control: valueControl(String(value)), run: () => {
			const values = def.enumValues ?? [];
			showChoiceSheet({ label: def.id, current: String(value), choices: values.map((entry) => ({ value: String(entry), label: String(entry) })),
				onPick: (pick) => saveExtSetting(def.extId, def.id, values.find((entry) => String(entry) === pick) ?? pick) });
		} });
	}
	return settingRow({ label: def.id, description, modified,
		control: valueControl(def.type === 'json' ? JSON.stringify(value ?? null) : String(value ?? '')),
		run: () => textSheet(def) });
}

/** A text / JSON value edits in a sheet: an input and a Save row, an invalid JSON refused. */
function textSheet(def: ExtensionSettingDef): void {
	const stored = extSettings(def.extId);
	const current = def.id in stored ? stored[def.id] : def.default;
	const input = document.createElement('input');
	input.type = 'text';
	input.value = def.type === 'json' ? JSON.stringify(current ?? null) : String(current ?? '');
	const body = document.createElement('div');
	body.className = 'ggs-text-sheet';
	body.appendChild(input);
	const save = document.createElement('button');
	save.className = 'row save';
	save.textContent = t('remote.editorToolbar.save');
	save.addEventListener('click', () => {
		if (def.type === 'json') {
			try {
				saveExtSetting(def.extId, def.id, JSON.parse(input.value));
			} catch (error) {
				notify('warning', tf('extensions.invalidJsonSetting', def.id, String(error)));
				extLog('warn', def.extId, `setting ${def.id} rejected: not valid JSON`, String(error));
				return;
			}
		} else {
			saveExtSetting(def.extId, def.id, def.type === 'number' ? Number(input.value) : input.value);
		}
		closeActionSheet();
		rerender();
	});
	body.appendChild(save);
	openSheet({ title: def.id, subtitle: def.extId, body });
	input.focus();
}

/** Data Saver is this browser's own (a localStorage flag, not a registry setting). */
function dataSaverRow(): HTMLButtonElement {
	return boolRow(t('remote.drawer.dataSaver'), t('setting.remote.dataSaver'), false,
		() => document.documentElement.hasAttribute('data-data-saver'), (next) => setDataSaver(next));
}

/* ---------- Levels ---------- */

function categoryLabel(id: CategoryId): string {
	return t(`settings.category.${id}` as 'settings.category.general');
}

function sectionHeading(text: string): HTMLElement {
	const heading = document.createElement('div');
	heading.className = 'ggs-settings-heading';
	heading.textContent = text;
	return heading;
}

function emptyNote(text: string): HTMLElement {
	const note = document.createElement('p');
	note.className = 'empty';
	note.textContent = text;
	return note;
}

function defMatches(def: SettingDef, q: string): boolean {
	const label = t(`settings.${def.key}` as LocaleKey);
	const description = t(`settings.${def.key}.description` as LocaleKey);
	return `${label} ${description} ${def.key}`.toLowerCase().includes(q);
}

function fillRoot(level: HTMLElement): void {
	const q = query.trim().toLowerCase();
	if (q === '') {
		for (const category of CATEGORIES) {
			level.appendChild(iconRow(category.icon, categoryLabel(category.id), () => pushLevel({ kind: 'category', id: category.id })));
		}
		return;
	}
	let any = false;
	for (const id of BUILTIN_CATEGORIES) {
		const defs = SETTING_DEFS.filter((def) => def.category === id && defMatches(def, q));
		if (defs.length === 0) continue;
		any = true;
		level.appendChild(sectionHeading(categoryLabel(id)));
		for (const def of defs) level.appendChild(settingRowFor(def));
	}
	if (`${t('remote.drawer.dataSaver')} ${t('setting.remote.dataSaver')}`.toLowerCase().includes(q)) {
		any = true;
		level.append(sectionHeading(categoryLabel('remote')), dataSaverRow());
	}
	const extensions = extensionSettingDefs().filter((def) => `${def.extId} ${def.id} ${def.description}`.toLowerCase().includes(q));
	if (extensions.length > 0) {
		any = true;
		level.append(sectionHeading(categoryLabel('extensions')));
		for (const def of extensions) level.appendChild(extensionSettingRow(def));
	}
	if (!any) level.appendChild(emptyNote(t('settings.noMatching')));
}

function fillCategory(level: HTMLElement, id: CategoryId): void {
	if (id === 'remote') {
		level.appendChild(dataSaverRow());
		return;
	}
	if (id === 'extensions') {
		const defs = extensionSettingDefs();
		if (defs.length === 0) {
			level.appendChild(emptyNote(t('settings.noExtensionSettings')));
			return;
		}
		for (const def of defs) level.appendChild(extensionSettingRow(def));
		return;
	}
	for (const def of SETTING_DEFS) {
		if (def.category === id) level.appendChild(settingRowFor(def));
	}
}

function fillFileTypes(level: HTMLElement): void {
	const mount = document.createElement('div');
	level.appendChild(mount);
	void assocListDefaults()
		.then((catalog) => {
			for (const entry of catalog) {
				mount.appendChild(boolRow(`.${entry.ext}`, '', false,
					() => settings.fileAssociations.includes(entry.ext),
					() => {
						const next = new Set(settings.fileAssociations);
						if (settings.fileAssociations.includes(entry.ext)) next.delete(entry.ext);
						else next.add(entry.ext);
						updateSetting('fileAssociations', [...next]);
					}));
			}
			if (catalog.length === 0) mount.appendChild(emptyNote(t('assoc.unavailable')));
		})
		.catch(() => mount.appendChild(emptyNote(t('assoc.unavailable'))));
}

function fillLevel(level: HTMLElement): void {
	const top = stack[stack.length - 1]!;
	if (top.kind === 'root') fillRoot(level);
	else if (top.kind === 'category') fillCategory(level, top.id);
	else fillFileTypes(level);
}

/** Re-render the showing level in place, keeping its scroll (a change just landed). */
function rerender(): void {
	if (!page) return;
	const showing = page.querySelector<HTMLElement>('.ggs-settings-level:last-child');
	if (!showing) return;
	const scroll = showing.scrollTop;
	const next = document.createElement('div');
	next.className = 'ggs-settings-level';
	fillLevel(next);
	showing.replaceWith(next);
	next.scrollTop = scroll;
}

function levelTitle(): string {
	const top = stack[stack.length - 1]!;
	if (top.kind === 'category') return categoryLabel(top.id);
	if (top.kind === 'fileTypes') return t('settings.fileAssociations');
	return t('settings.title');
}

function syncChrome(): void {
	const searchbar = page!.querySelector<HTMLElement>('.ggs-settings-searchbar')!;
	const search = searchbar.querySelector('input')!;
	searchbar.hidden = stack[stack.length - 1]!.kind !== 'root';
	search.placeholder = t('settings.searchPlaceholder');
	page!.querySelector<HTMLElement>('.ggs-settings-title')!.textContent = levelTitle();
}

/** Slide a fresh level in (a drill-in from the right, a back step from the left). */
function showLevel(direction: 'forward' | 'back' | 'none'): void {
	const container = page!.querySelector<HTMLElement>('.ggs-settings-levels')!;
	const old = container.querySelector<HTMLElement>('.ggs-settings-level');
	const next = document.createElement('div');
	next.className = 'ggs-settings-level';
	fillLevel(next);
	syncChrome();
	if (!old || direction === 'none') {
		old?.remove();
		container.appendChild(next);
		return;
	}
	const enterFrom = direction === 'forward' ? 'from-right' : 'from-left';
	const exitTo = direction === 'forward' ? 'to-left' : 'to-right';
	next.classList.add(enterFrom, 'slide');
	old.classList.add('slide', exitTo);
	container.appendChild(next);
	requestAnimationFrame(() => next.classList.remove(enterFrom));
	setTimeout(() => old.remove(), 300);
}

function pushLevel(level: Level): void {
	stack.push(level);
	showLevel('forward');
	armBack();
}

function popLevel(): void {
	if (stack.length <= 1) return;
	stack.pop();
	showLevel('back');
	armBack();
}

/** The phone's back: one level at a time, the page itself last. Re-armed per level, so the
 *  single history entry backStack keeps is enough for any depth. */
function armBack(): void {
	releaseBack?.();
	releaseBack = pushBack(() => {
		if (stack.length > 1) popLevel();
		else closeSettingsPage();
	});
}

/* ---------- The page ---------- */

export function openSettingsPage(): void {
	// A page left over from a torn-down DOM (a test, a reload) must not block a fresh one.
	if (page && !page.isConnected) {
		page = null;
		stack = [];
		releaseBack = null;
	}
	if (page) return;
	closeActionSheet();
	stack = [{ kind: 'root' }];
	query = '';

	const root = document.createElement('div');
	root.className = 'ggs-settings-page';
	root.setAttribute('role', 'dialog');
	root.setAttribute('aria-modal', 'true');
	root.setAttribute('aria-label', t('settings.title'));

	const header = document.createElement('div');
	header.className = 'ggs-settings-header';
	const back = document.createElement('button');
	back.className = 'ggs-settings-back';
	back.title = t('remote.sheet.back');
	back.setAttribute('aria-label', t('remote.sheet.back'));
	back.appendChild(codicon('chevron-left'));
	back.addEventListener('click', () => {
		if (stack.length > 1) popLevel();
		else closeSettingsPage();
	});
	const title = document.createElement('div');
	title.className = 'ggs-settings-title';
	header.append(back, title);

	const searchbar = document.createElement('div');
	searchbar.className = 'ggs-settings-searchbar';
	const search = document.createElement('input');
	search.type = 'search';
	search.spellcheck = false;
	search.addEventListener('input', () => {
		query = search.value;
		rerender();
	});
	searchbar.appendChild(search);

	const levels = document.createElement('div');
	levels.className = 'ggs-settings-levels';
	root.append(header, searchbar, levels);
	document.body.appendChild(root);
	page = root;
	syncChrome();
	showLevel('none');
	armBack();
	// A setting changed (this page's own row, the desktop dialog elsewhere): the showing
	// level re-renders — labels included, so a language switch relabels the page in place.
	document.addEventListener(SETTINGS_EVENT, onSettingsChanged);
	document.addEventListener('keydown', onKeyDown);
	requestAnimationFrame(() => root.classList.add('open'));
}

export function closeSettingsPage(): void {
	if (!page) return;
	const root = page;
	page = null;
	stack = [];
	releaseBack?.();
	releaseBack = null;
	document.removeEventListener('keydown', onKeyDown);
	document.removeEventListener(SETTINGS_EVENT, onSettingsChanged);
	root.classList.remove('open');
	setTimeout(() => root.remove(), 260);
}

function onKeyDown(event: KeyboardEvent): void {
	if (event.key !== 'Escape' || sheetOpen()) return;
	if (stack.length > 1) popLevel();
	else closeSettingsPage();
}

function onSettingsChanged(): void {
	if (!page) return;
	rerender();
	syncChrome();
}

/* ---------- The command entry: the phone's Settings opens this page ---------- */

let desktopSettingsCommand: Command | null = null;

/** Route `workbench.openSettings` to the phone page while the phone form factor is showing;
 *  leaving it (a tablet, a desktop browser) restores the desktop dialog verbatim. */
export function installPhoneSettingsEntry(phone: boolean): void {
	const current = commands.get('workbench.openSettings');
	if (!desktopSettingsCommand && current) desktopSettingsCommand = current;
	if (phone) {
		commands.register({
			id: 'workbench.openSettings',
			title: desktopSettingsCommand?.title ?? 'Settings',
			category: 'Preferences',
			keybinding: desktopSettingsCommand?.keybinding,
			run: () => openSettingsPage()
		});
	} else if (desktopSettingsCommand && current !== desktopSettingsCommand) {
		commands.register(desktopSettingsCommand);
		desktopSettingsCommand = null;
	}
}
