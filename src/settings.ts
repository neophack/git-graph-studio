// The application settings (theme, display language, viewer outline), persisted through the
// same localStorage store as the rest of the state. Theme changes swap the workbench's theme
// stylesheet and re-apply the vscode-* body classes; every change dispatches an event so the
// parts that cache derived values (menus, terminals, the viewer's colors) can refresh.

import { invoke } from '@tauri-apps/api/core';

import { load, save } from './state';
import { setLocale, t } from './i18n';
import { notify } from './ui';

export type AutoSave = 'off' | 'afterDelay' | 'onFocusChange' | 'onWindowChange';
export type LinuxDmabuf = 'auto' | 'disable' | 'keep';
export type WorkbenchDensity = 'comfortable' | 'compact';

export interface AppSettings {
	theme: string;
	locale: string;
	showOutline: boolean;
	/** VS Code's `files.autoSave`: never, a delay after the last edit, when the editor loses
	 *  focus (another tab, the sidebar, the terminal), or when the window does. */
	autoSave: AutoSave;
	/** `files.autoSaveDelay`, in milliseconds. */
	autoSaveDelay: number;
	/** `editor.minimap.enabled`: the scaled code overview beside the scroller. */
	minimap: boolean;
	/** `editor.stickyScroll.enabled`: the enclosing blocks pinned over the code. */
	stickyScroll: boolean;
	/** Zed's `scroll_sensitivity`: a multiplier on the wheel's distance. At 1 a mouse notch
	 *  is the system's lines per notch (three on Windows) — the wheel model is Zed's
	 *  (scroll/wheel.ts), on every viewer and editor, and nothing eases. */
	mouseWheelScrollSensitivity: number;
	/** Zed's `fast_scroll_sensitivity`: the multiplier Alt holds over the wheel's distance. */
	fastScrollSensitivity: number;
	/** `editor.bracketPairColorization.enabled`: brackets coloured by nesting depth. */
	bracketColors: boolean;
	/** `editor.fontSize`, in pixels - the code editors follow a CSS variable. */
	fontSize: number;
	/** `editor.tabSize`: how many spaces a level of indentation is (and Tab inserts). */
	tabSize: number;
	/** `editor.wordWrap`: break long lines at the viewport edge. */
	wordWrap: boolean;
	/** `editor.snippetSuggestions`: offer snippets in the completion list. */
	snippetSuggestions: boolean;
	/** Offer workspace paths in the completion list when a fragment looks like one. */
	pathCompletion: boolean;
	/** The file extensions (no dot) GGS registers itself to open at the OS level - the
	 *  File Associations row in Settings; changing it re-registers via `assoc_apply`. */
	fileAssociations: string[];
	/** How the webview renders on Linux (`auto` disables the DMABUF renderer only when the
	 *  NVIDIA proprietary driver is detected). Read by the backend before the webview
	 *  starts, so a change takes effect on the next launch. */
	linuxDmabuf: LinuxDmabuf;
	/** `workbench.density`: how tightly rows, tabs and bars are packed (M7 7.3). */
	density: WorkbenchDensity;
	/** Zed's `use_smartcase_search`: a query containing an uppercase letter matches case
	 *  exactly, an all-lowercase query ignores case. The Match Case toggle shows the state
	 *  the query's case picked — and can still override it — in every search field. */
	searchSmartCase: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
	theme: 'dark-modern', locale: 'en', showOutline: false, autoSave: 'off', autoSaveDelay: 1000,
	minimap: true, stickyScroll: true, bracketColors: true,
	mouseWheelScrollSensitivity: 1, fastScrollSensitivity: 4,
	fontSize: 14, tabSize: 4, wordWrap: false, snippetSuggestions: true, pathCompletion: true,
	fileAssociations: ['blf', 'asc', 'ggx', 'bin', 'hex'],
	linuxDmabuf: 'auto',
	density: 'comfortable',
	searchSmartCase: true
};

/** Any settings write persists the whole object, so a store from an older release pins the
 *  *default* of the day rather than a choice. The wheel sensitivities changed meaning with
 *  the Zed scroll model (a notch is the system's lines, not VS Code's 50 px): a value equal
 *  to any previously shipped default (1, 2 and 3 for the wheel, 5 for the fast one) is
 *  treated as "never picked" and follows the current default; any other value is the
 *  user's own and stands. The glide setting is gone — nothing eases any more — and a
 *  stored one is dropped. */
export function migrateStoredSettings(stored: Partial<AppSettings>): Partial<AppSettings> {
	const { smoothScrolling: _glide, ...rest } = stored as Partial<AppSettings> & { smoothScrolling?: boolean };
	const next: Partial<AppSettings> = { ...rest };
	if ([1, 2, 3].includes(next.mouseWheelScrollSensitivity as number)) next.mouseWheelScrollSensitivity = DEFAULT_SETTINGS.mouseWheelScrollSensitivity;
	if (next.fastScrollSensitivity === 5) next.fastScrollSensitivity = DEFAULT_SETTINGS.fastScrollSensitivity;
	return next;
}

export const settings: AppSettings = { ...DEFAULT_SETTINGS, ...migrateStoredSettings(load<Partial<AppSettings>>('appSettings', {})) };

/* ---------- The setting registry (M3 3.9): one row per setting, schema-driven ---------- */

export type SettingCategory = 'general' | 'appearance' | 'editor' | 'search';

/** How the generated Settings dialog renders one setting. `theme` and `locale` pick from
 *  THEMES / LOCALES; `enum` from its own options; a number gets bounds; a boolean a checkbox;
 *  `extensionList` renders the File Associations checkbox grid over the backend catalogue. */
export interface SettingDef {
	key: keyof AppSettings;
	category: SettingCategory;
	kind: 'boolean' | 'number' | 'enum' | 'theme' | 'locale' | 'extensionList';
	options?: { value: string; label: string }[];
	min?: number;
	max?: number;
	step?: number;
}

/** Every setting the workbench owns, in the order the Settings dialog lists them. The label
 *  and description come from the i18n tables (`settings.<key>` / `settings.<key>.description`).
 */
export const SETTING_DEFS: SettingDef[] = [
	{ key: 'locale', category: 'general', kind: 'locale' },
	{ key: 'fileAssociations', category: 'general', kind: 'extensionList' },
	{ key: 'linuxDmabuf', category: 'general', kind: 'enum', options: [
		{ value: 'auto', label: 'settings.linuxDmabuf.auto' },
		{ value: 'disable', label: 'settings.linuxDmabuf.disable' },
		{ value: 'keep', label: 'settings.linuxDmabuf.keep' }
	] },
	{ key: 'theme', category: 'appearance', kind: 'theme' },
	{ key: 'density', category: 'appearance', kind: 'enum', options: [
		{ value: 'comfortable', label: 'settings.density.comfortable' },
		{ value: 'compact', label: 'settings.density.compact' }
	] },
	{ key: 'autoSave', category: 'editor', kind: 'enum', options: [
		{ value: 'off', label: 'settings.autoSave.off' },
		{ value: 'afterDelay', label: 'settings.autoSave.afterDelay' },
		{ value: 'onFocusChange', label: 'settings.autoSave.onFocusChange' },
		{ value: 'onWindowChange', label: 'settings.autoSave.onWindowChange' }
	] },
	{ key: 'autoSaveDelay', category: 'editor', kind: 'number', min: 100, max: 10000, step: 100 },
	{ key: 'fontSize', category: 'editor', kind: 'enum', options: [12, 13, 14, 16, 18, 20, 24].map((size) => ({ value: String(size), label: `${size} px` })) },
	{ key: 'tabSize', category: 'editor', kind: 'enum', options: [2, 4, 8].map((size) => ({ value: String(size), label: String(size) })) },
	{ key: 'wordWrap', category: 'editor', kind: 'boolean' },
	{ key: 'showOutline', category: 'editor', kind: 'boolean' },
	{ key: 'minimap', category: 'editor', kind: 'boolean' },
	{ key: 'stickyScroll', category: 'editor', kind: 'boolean' },
	{ key: 'mouseWheelScrollSensitivity', category: 'editor', kind: 'number', min: 0.1, max: 10, step: 0.1 },
	{ key: 'fastScrollSensitivity', category: 'editor', kind: 'number', min: 1, max: 20, step: 1 },
	{ key: 'bracketColors', category: 'editor', kind: 'boolean' },
	{ key: 'snippetSuggestions', category: 'editor', kind: 'boolean' },
	{ key: 'pathCompletion', category: 'editor', kind: 'boolean' },
	{ key: 'searchSmartCase', category: 'search', kind: 'boolean' }
];

/** A setting's value differs from its default (the dialog's "modified" marker). The JSON
 *  comparison is for `fileAssociations` - array identity never matches a default literal. */
export function isSettingModified(key: keyof AppSettings): boolean {
	return JSON.stringify(settings[key]) !== JSON.stringify(DEFAULT_SETTINGS[key]);
}

/** Dispatched on document whenever a setting changes (`detail.key` is the one that changed). */
export const SETTINGS_EVENT = 'app:settings-changed';
/** Dispatched after the theme stylesheet finished loading - derived colors can be re-read. */
export const THEME_EVENT = 'app:theme-applied';

export interface ThemeDef {
	id: string;
	label: string;
	kind: 'vscode-dark' | 'vscode-light';
	/** The vscode-* class pair the theme's surfaces expect on html/body. */
	css: string;
}

/** The theme the system's colour scheme picks for `auto` (dark first, VS Code's tie-break). */
function systemTheme(): ThemeDef {
	const dark = typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
	return themeById(dark ? 'dark-modern' : 'light-modern');
}

export const THEMES: ThemeDef[] = [
	{ id: 'auto', label: 'Auto (System)', kind: 'vscode-dark', css: '/theme/dark-modern.css' },
	{ id: 'dark-modern', label: 'Dark Modern', kind: 'vscode-dark', css: '/theme/dark-modern.css' },
	{ id: 'light-modern', label: 'Light Modern', kind: 'vscode-light', css: '/theme/light-modern.css' },
	{ id: 'dark-plus', label: 'Default Dark+', kind: 'vscode-dark', css: '/theme/dark-plus.css' },
	{ id: 'light-plus', label: 'Default Light+', kind: 'vscode-light', css: '/theme/light-plus.css' },
	{ id: 'hc-black', label: 'Dark High Contrast', kind: 'vscode-dark', css: '/theme/hc-black.css' },
	{ id: 'monokai', label: 'Monokai', kind: 'vscode-dark', css: '/theme/monokai.css' },
	{ id: 'nord', label: 'Nord', kind: 'vscode-dark', css: '/theme/nord.css' }
];

export function themeById(id: string = settings.theme): ThemeDef {
	if (id === 'auto') return systemTheme();
	// The fallback is the shipped default, not THEMES[0] - that is the `auto` placeholder.
	return THEMES.find((theme) => theme.id === id) ?? THEMES.find((theme) => theme.id === 'dark-modern')!;
}

function dispatch(name: string, detail?: unknown): void {
	document.dispatchEvent(new CustomEvent(name, { detail }));
}

/** Swap the theme stylesheet and the vscode-* classes on html/body. Fires THEME_EVENT once the
 *  new stylesheet has loaded, so anything that read computed colors can re-read them. */
export function applyTheme(id: string = settings.theme): void {
	const theme = themeById(id);
	if (id === 'auto') {
		// The pick is re-evaluated on every system switch (the listener below), so the
		// placeholder entry in the select never names a stylesheet itself.
		installSystemThemeListener();
	}
	const link = document.querySelector<HTMLLinkElement>('link#theme-css');
	for (const element of [document.documentElement, document.body]) {
		if (!element) continue;
		element.classList.remove('vscode-dark', 'vscode-light');
		element.classList.add(theme.kind);
		element.dataset['vscodeThemeKind'] = theme.kind;
		element.dataset['vscodeThemeName'] = theme.label;
	}
	if (!link || link.getAttribute('href') === theme.css) return;
	link.addEventListener('load', () => dispatch(THEME_EVENT, theme.id), { once: true });
	link.href = theme.css;
}

/** Change one setting: store it, apply its side effects, and notify the workbench. */
export function updateSetting<K extends keyof AppSettings>(key: K, value: AppSettings[K]): void {
	// Deep compare: the File Associations row rebuilds its array on every toggle, and a
	// no-op re-registration at the OS level (a click that lands on a re-rendered row)
	// must not fire the backend command.
	if (JSON.stringify(settings[key]) === JSON.stringify(value)) return;
	settings[key] = value;
	save('appSettings', settings);
	if (key === 'theme') applyTheme();
	if (key === 'locale') setLocale(String(value));
	if (key === 'fontSize') applyFontSize();
	if (key === 'density') applyDensity();
	if (key === 'fileAssociations') applyFileAssociations();
	persistSettingsFile();
	dispatch(SETTINGS_EVENT, key);
}

/** Re-register the OS-level "open with" associations for the current selection. The
 *  backend reports per-platform; on Windows the result explains that Default Apps
 *  needs one confirmation (Win10/11 will not let an app set the default silently). */
function applyFileAssociations(): void {
	void invoke<{ messageKey: string; detail: string }>('assoc_apply', { extensions: settings.fileAssociations })
		.then((result) => notify('info', t(result.messageKey as 'assoc.applied.windows') + (result.detail ? ` (${result.detail})` : '')))
		.catch((error: unknown) => notify('error', t('assoc.failed') + String(error)));
}

/* ---------- The user-level settings.json (M3 3.9): the file wins on the next launch ---------- */

/** Apply `~/.ggs/settings.json` over the stored settings, if the file exists: a hand edit is
 *  the other direction of the "edited both ways" contract (picked up on the next launch,
 *  like VS Code's own reload semantics). */
export async function loadSettingsFile(): Promise<void> {
	try {
		const text = await invoke<string | null>('settings_read');
		if (!text) return;
		const parsed = JSON.parse(text) as Partial<AppSettings>;
		for (const def of SETTING_DEFS) {
			if (parsed[def.key] !== undefined) (settings as unknown as Record<string, unknown>)[def.key] = parsed[def.key];
		}
		save('appSettings', settings);
	} catch {
		// No file, or one that does not parse: the stored settings stand.
	}
}

/** Write the current settings to the file (fire and forget - the form's direction). */
export function persistSettingsFile(): void {
	void invoke('settings_write', { contents: JSON.stringify(settings, null, '\t') }).catch(() => undefined);
}

/** The code editors' font size travels on a CSS variable, so a change is live everywhere. */
export function applyFontSize(size: number = settings.fontSize): void {
	document.documentElement.style.setProperty('--editor-font-size', `${size}px`);
}

/** The workbench density travels as the row/tab/bar height variables (M7 7.3): every strip
 *  that hardcoded its height reads one of these, so one setting re-packs the whole shell. */
export function applyDensity(density: WorkbenchDensity = settings.density): void {
	const values = density === 'compact'
		? { row: '20px', tab: '30px', status: '20px', activity: '44px', panelTab: '26px' }
		: { row: '22px', tab: '35px', status: '22px', activity: '48px', panelTab: '30px' };
	const root = document.documentElement.style;
	root.setProperty('--row-height', values.row);
	root.setProperty('--tab-height', values.tab);
	root.setProperty('--status-height', values.status);
	root.setProperty('--activity-size', values.activity);
	root.setProperty('--panel-tab-height', values.panelTab);
}

/** `prefers-color-scheme` listener for the `auto` theme: a system switch re-applies while the
 *  setting says auto. Installed at most once, and only when auto is in play at all. */
let systemThemeListenerInstalled = false;
function installSystemThemeListener(): void {
	if (systemThemeListenerInstalled || typeof matchMedia !== 'function') return;
	systemThemeListenerInstalled = true;
	matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
		if (settings.theme === 'auto') applyTheme('auto');
	});
}

/** Boot-time initialisation: the persisted theme and locale take effect before the shell. */
export function initSettings(): void {
	setLocale(settings.locale);
	applyTheme();
	applyFontSize();
	applyDensity();
}
