// Extension manifest contributions: the `contributes` section of each installed extension's
// package.json - commands (with their localized titles from package.nls.json), menu placements
// and keybindings - parsed into the workbench. This is static contribution data: it registers
// commands in the palette and appends menu entries to Studio's context menus, evaluated against
// the extension's declared settings (a `when` clause reading `config.<id>`).
//
// `when` clauses get a minimal treatment: `evaluateWhen` below understands `&&`-joined clauses
// of the shapes VS Code's own manifests actually use for the locations this module models -
// `identifier`, `!identifier`, `identifier == 'literal'` / `!= 'literal'`, and the literal
// `true`/`false`. An identifier this cannot resolve (Studio has no general context-key engine)
// is treated as satisfied, so a clause this module does not model never hides an item - it just
// stops narrowing it. `config.<extension-setting-id>` reads the extension's own declared setting
// (its current value, or its declared default); anything else is looked up through
// `registerContextProvider`, for the handful of context keys a natively-hosted extension's own
// code would otherwise have set itself (any `extension:key` identifier registered here).

import { extSettings } from './state';
import { commands } from './commands';
import type { MenuEntry, MenuItem } from './ui';

/** The menu locations Studio surfaces. `git.pullpush` is VS Code's SCM sync menu — where
 * a Gerrit `refs/for/` push goes — rendered inside the Source Control "..."
 * menu's Pull, Push submenu. Others (commandPalette, …) only hide or relocate entries in
 * VS Code itself, so they are ignored. */
export const SUPPORTED_MENU_LOCATIONS = ['explorer/context', 'editor/context', 'editor/title/context', 'scm/title', 'scm/resourceState/context', 'git.pullpush'] as const;
export type MenuLocation = (typeof SUPPORTED_MENU_LOCATIONS)[number];

interface DeclaredCommand {
	id: string;
	title: string;
	category?: string;
	/** The manifest's own icon paths for this command (VS Code renders them in scm/title's
	 *  navigation group); resolved against the package by whoever renders. */
	icon?: { light?: string; dark?: string };
}

interface MenuPlacement {
	command: string;
	/** VS Code's `when` clause. A bare JSON `false` is the "never" spelling (VS Code's own
	 *  manifests use it to keep a command out of the palette); it normalizes through
	 *  `whenText` before evaluation. */
	when?: string | boolean;
	/** VS Code renders a `scm/title` item in the `navigation` group as a title-bar icon, and
	 *  everything else inside "..."; other locations declare a group only to order entries. */
	group?: string;
}

interface ExtensionContributions {
	commands: Map<string, DeclaredCommand>;
	menus: Partial<Record<MenuLocation, MenuPlacement[]>>;
	/** Runs one of this extension's commands with arguments — what a menu entry calls when
	 *  its location hands the command its context (the clicked file, the selection). */
	dispatch: (command: string, args?: unknown[]) => void;
}

const byExtension = new Map<string, ExtensionContributions>();

/** Resource/environment values `evaluateWhen` resolves without asking anything else - the ones
 *  Studio's own views actually match: a single Source Control provider (`git`), no multi-select
 *  in that view's resource list, and a context menu always opened on a real file. */
const staticContext: Record<string, unknown> = { scmProvider: 'git', listMultiSelection: false, resourceScheme: 'file' };

/** Context keys a natively-hosted extension's own code would otherwise set itself (VS Code's
 *  `setContext`), resolved lazily so they always reflect the current settings/locale - see
 *  `registerContextProvider`. */
const contextProviders = new Map<string, () => boolean>();

/** Supply a `when`-clause context key `evaluateWhen` cannot otherwise resolve, computed on
 *  demand (not cached: the caller reads whatever is current every time). Call for every context
 *  key a natively-hosted extension's own (non-running) code would have set via VS Code's
 *  `setContext` - e.g. `git-graph-rs:interfaceZhCn`, set by an extension's own code. */
export function registerContextProvider(key: string, provider: () => boolean): void {
	contextProviders.set(key, provider);
}

/** One declared setting's current value: the stored override, or the manifest's default. */
function configValue(extId: string, key: string): unknown {
	const stored = extSettings(extId);
	if (key in stored) return stored[key];
	return extensionSettings.get(extId)?.find((def) => def.id === key)?.default;
}

function resolveIdentifier(extId: string, name: string): unknown {
	if (name === 'true') return true;
	if (name === 'false') return false;
	if (name in staticContext) return staticContext[name];
	if (name.startsWith('config.')) return configValue(extId, name.slice('config.'.length));
	if (contextProviders.has(name)) return contextProviders.get(name)!();
	return undefined; // not modelled: never narrows the item away (see module doc)
}

/** A manifest `when` in the string form `evaluateWhen` parses: the bare JSON `false` (and any
 *  boolean spelling) becomes its text, so "never" and the clause forms share one path. */
function whenText(when: string | boolean | undefined): string | undefined {
	return when === undefined ? undefined : String(when);
}

/** Evaluate a `when` clause - see the module doc for exactly which shapes this understands. */
function evaluateWhen(extId: string, when: string | undefined): boolean {
	if (when === undefined) return true;
	return when.split('&&').every((raw) => {
		const clause = raw.trim();
		// VS Code's when clauses allow the right-hand side quoted ('Inline') or bare (git) -
		// `scmProvider == git` and `config.x == 'Inline'` both appear in this manifest.
		const comparison = /^([\w.:-]+)\s*(==|!=)\s*(?:'([^']*)'|([\w.-]+))$/.exec(clause);
		if (comparison) {
			const name = comparison[1]!, op = comparison[2]!, literal = comparison[3] ?? comparison[4];
			const equal = String(resolveIdentifier(extId, name)) === literal;
			return op === '==' ? equal : !equal;
		}
		const negated = clause.startsWith('!');
		const value = resolveIdentifier(extId, negated ? clause.slice(1).trim() : clause);
		if (value === undefined) return true;
		return negated ? !value : Boolean(value);
	});
}

/** `ctrl+shift+t` / `ctrl+k ctrl+w` -> `Ctrl+Shift+T` / `Ctrl+K Ctrl+W` (Studio's spelling). */
export function normalizeKeybinding(binding: string): string | undefined {
	const KEY_NAMES: Record<string, string> = { esc: 'Escape', del: 'Delete', ins: 'Insert', enter: 'Enter', up: 'Up', down: 'Down', left: 'Left', right: 'Right', space: 'Space' };
	const normalizeChord = (chord: string) =>
		chord
			.split('+')
			.filter((part) => part !== '')
			.map((part) => {
				const lower = part.toLowerCase();
				if (KEY_NAMES[lower]) return KEY_NAMES[lower];
				if (lower === 'ctrl' || lower === 'cmd' || lower === 'mod') return 'Ctrl';
				if (lower === 'shift') return 'Shift';
				if (lower === 'alt' || lower === 'option') return 'Alt';
				return part.length === 1 ? part.toUpperCase() : part[0]!.toUpperCase() + part.slice(1);
			})
			.join('+');
	const normalized = binding.trim().split(/\s+/).map(normalizeChord).join(' ');
	return normalized === '' ? undefined : normalized;
}

/** Resolve `%key%` placeholders against an extension's package.nls.json (exported for the
 *  extension host, which pairs the default table with a translation to register labels). */
export function localize(text: string | undefined, nls: Record<string, string>): string {
	if (!text) return '';
	const match = /^%([\w.:-]+)%$/.exec(text.trim());
	return (match && nls[match[1]]) || text;
}

export interface ManifestContributes {
	commands?: { command: string; title?: string; category?: string; icon?: { light?: string; dark?: string } }[];
	menus?: Record<string, MenuPlacement[] | undefined>;
	keybindings?: { command: string; key: string; when?: string }[];
	/** VS Code's `contributes.configuration`: the settings an extension declares (M3 3.9). */
	configuration?: {
		title?: string;
		properties?: Record<string, { type?: string; default?: unknown; description?: string }>;
	};
	/** VS Code's `contributes.viewsContainers`: activity-bar containers an extension adds —
	 *  each becomes its own sidebar view holding the views that name it in `views`. */
	viewsContainers?: { activitybar?: { id: string; title: string; icon?: string }[] };
	/** VS Code's `contributes.views`, by container id: the tree views the extension shows
	 *  (`window.createTreeView` of the same id feeds them their content). */
	views?: Record<string, { id: string; name: string; when?: string }[] | undefined>;
	/** VS Code's `contributes.languages`: a language id with the file extensions and aliases
	 *  that identify it (feeds the editor's language naming and snippets scoping). */
	languages?: { id: string; aliases?: string[]; extensions?: string[] }[];
	/** VS Code's `contributes.grammars`: TextMate grammars, loaded into the backend's syntect
	 *  set so the Fast Viewer highlights files of their languages. */
	grammars?: { language?: string; scopeName: string; path: string }[];
	/** VS Code's `contributes.snippets`: `*.code-snippets` files joined into the registry. */
	snippets?: { language: string; path: string }[];
	/** VS Code's `contributes.themes`: color themes added to the theme picker. */
	themes?: { label: string; uiTheme?: string; path: string }[];
}

/** One extension-declared setting, normalised for the Settings dialog's generated rows. */
export interface ExtensionSettingDef {
	extId: string;
	id: string;
	type: 'boolean' | 'string' | 'number';
	default: unknown;
	description: string;
}

/** One extension's declared sidebar surface: its activity-bar containers and the tree views
 *  placed in them (or in a built-in container — `explorer` and `scm` are accepted ids, the
 *  view then rides that container's sidebar view as a stacked section). */
export interface ExtensionViewContribution {
	extId: string;
	containers: { id: string; title: string; icon?: string }[];
	/** `container` is the manifest's container id; `viewId` is the view's own id (the
	 *  `createTreeView` id). */
	views: { viewId: string; name: string; container: string }[];
}

const viewContributions = new Map<string, ExtensionViewContribution>();

/** Register one extension's view containers and views (called by `applyContributions`). */
function applyExtensionViews(extId: string, contributes: ManifestContributes | undefined, nls: Record<string, string>): void {
	const containers = (contributes?.viewsContainers?.activitybar ?? []).map((container) => ({
		id: container.id,
		title: localize(container.title, nls) || container.id,
		icon: container.icon
	}));
	const views: ExtensionViewContribution['views'] = [];
	for (const [container, entries] of Object.entries(contributes?.views ?? {})) {
		for (const view of entries ?? []) views.push({ viewId: view.id, name: localize(view.name, nls) || view.id, container });
	}
	if (containers.length > 0 || views.length > 0) viewContributions.set(extId, { extId, containers, views });
	else viewContributions.delete(extId);
}

/** Every active extension's declared containers and views (the workbench builds the activity
 *  bar entries and sidebar sections from this list). */
export function extensionViewContributions(): ExtensionViewContribution[] {
	return [...viewContributions.values()];
}

/* ---------- Extension languages, snippets and themes (module 12's registries) ---------- */

/** File extensions mapped to VS Code's language ids — the base of every resolution; the
 *  snippet registry keeps its own copy of the map for its lazy chunk, this one serves the
 *  always-loaded half (onLanguage activations, the editor's language labelling). */
const BASE_LANGUAGE_BY_EXTENSION: Record<string, string> = {
	rs: 'rust', ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
	mjs: 'javascript', cjs: 'javascript', py: 'python', go: 'go', java: 'java', c: 'c',
	h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', cs: 'csharp', rb: 'ruby',
	php: 'php', sh: 'shellscript', bash: 'shellscript', zsh: 'shellscript', ps1: 'powershell',
	html: 'html', htm: 'html', css: 'css', scss: 'css', less: 'css', md: 'markdown',
	markdown: 'markdown', sql: 'sql', kt: 'kotlin', swift: 'swift', lua: 'lua', dart: 'dart'
};

/** The language id a file name resolves to ('' when unknown): the base map, then the
 *  extension-declared languages. Always loaded, so onLanguage activations resolve without
 *  waking the snippet registry's chunk. */
export function languageIdFor(fileName: string): string {
	const ext = fileName.includes('.') ? fileName.split('.').pop()!.toLowerCase() : fileName.toLowerCase();
	if (BASE_LANGUAGE_BY_EXTENSION[ext]) return BASE_LANGUAGE_BY_EXTENSION[ext];
	return declaredLanguageId(fileName);
}

/** The languages installed extensions declared (`contributes.languages`), by extension id. */
const declaredLanguages = new Map<string, { id: string; aliases: string[]; extensions: string[] }[]>();

/** Register one extension's declared languages (whole-set replacement, like every registry
 *  here — install and uninstall both re-emit). */
export function registerDeclaredLanguages(extId: string, languages: { id: string; aliases?: string[]; extensions?: string[] }[]): void {
	if (languages.length > 0) declaredLanguages.set(extId, languages.map((language) => ({ id: language.id, aliases: language.aliases ?? [], extensions: language.extensions ?? [] })));
	else declaredLanguages.delete(extId);
	bumpVersion();
}

/** The declared-language id a file's extension resolves to ('' when none matches) — the
 *  half `languageIdFor` and the snippet registry both defer to. */
export function declaredLanguageId(fileName: string): string {
	const ext = fileName.includes('.') ? fileName.split('.').pop()!.toLowerCase() : fileName.toLowerCase();
	for (const declared of declaredLanguages.values()) {
		for (const entry of declared) {
			if (entry.extensions.some((candidate) => candidate.toLowerCase().replace(/^\./, '') === ext)) return entry.id;
		}
	}
	return '';
}

/** The display name for a file whose language only an extension declares — the first alias
 *  (VS Code's `aliases[0]`), else null: no declared language matches. */
export function declaredLanguageName(fileName: string): string | null {
	const ext = fileName.includes('.') ? fileName.split('.').pop()!.toLowerCase() : fileName.toLowerCase();
	for (const declared of declaredLanguages.values()) {
		for (const entry of declared) {
			if (entry.extensions.some((candidate) => candidate.toLowerCase().replace(/^\./, '') === ext)) return entry.aliases[0] ?? entry.id;
		}
	}
	return null;
}

/** The extension-contributed snippet files, raw (`contributes.snippets` — `{language, path}`
 *  with the file already read): the snippet registry's lazy chunk parses them on demand. */
const extensionSnippetFilesByExt = new Map<string, { language: string; text: string }[]>();

/** Register one extension's snippet files (whole-set replacement). */
export function registerExtensionSnippets(extId: string, files: { language: string; text: string }[]): void {
	if (files.length > 0) extensionSnippetFilesByExt.set(extId, files);
	else extensionSnippetFilesByExt.delete(extId);
	bumpVersion();
}

/** Every extension's snippet files, flattened (the lazy parser's input). */
export function extensionSnippetFiles(): { language: string; text: string }[] {
	return [...extensionSnippetFilesByExt.values()].flat();
}

/** One extension's declared themes (`contributes.themes`, the JSON already read): the
 *  settings module turns each into a theme-picker entry with a generated overlay. */
export interface ExtensionThemeDef {
	extId: string;
	label: string;
	kind: 'vscode-dark' | 'vscode-light';
	colors: Record<string, string>;
	tokenColors: { scope: string | string[]; settings: { foreground?: string } }[];
}

const extensionThemes = new Map<string, ExtensionThemeDef[]>();

/** Register one extension's themes (whole-set replacement). */
export function registerExtensionThemes(extId: string, themes: ExtensionThemeDef[]): void {
	if (themes.length > 0) extensionThemes.set(extId, themes);
	else extensionThemes.delete(extId);
	bumpVersion();
}

/** Every extension's declared themes, flattened. */
export function extensionThemeList(): ExtensionThemeDef[] {
	return [...extensionThemes.values()].flat();
}

/** Bumped by every whole-set registry write above, so lazy consumers (the snippet parser's
 *  cache) and the settings module know the world changed. */
let registryVersion = 0;

export function contributionRegistryVersion(): number {
	return registryVersion;
}

function bumpVersion(): void {
	registryVersion++;
}

const extensionSettings = new Map<string, ExtensionSettingDef[]>();

/** The extension-declared settings of every active extension (the dialog's Extensions rows). */
export function extensionSettingDefs(): ExtensionSettingDef[] {
	return [...extensionSettings.values()].flat();
}

/** Register one extension's declared settings only - the slice the async builtin-settings
 *  pass (extHost.ts) applies: the first-paint baked data carries commands and menus, the
 *  schema and its localised descriptions arrive with the Settings dialog's chunk. */
export function applyExtensionSettings(extId: string, configuration: ManifestContributes['configuration'], nls: Record<string, string>): void {
	const defs: ExtensionSettingDef[] = [];
	for (const [id, property] of Object.entries(configuration?.properties ?? {})) {
		const type = property.type === 'boolean' || property.type === 'number' ? property.type : 'string';
		defs.push({ extId, id, type, default: property.default ?? (type === 'boolean' ? false : type === 'number' ? 0 : ''), description: localize(property.description, nls) });
	}
	if (defs.length > 0) extensionSettings.set(extId, defs);
	else extensionSettings.delete(extId);
}

/**
 * Register one extension's contributions. `dispatch` runs a contributed command (into the
 * extension's frame, or the workbench's native handling for the built-in); `canRun` gates
 * palette enablement the same way.
 */
export function applyContributions(extId: string, contributes: ManifestContributes | undefined, nls: Record<string, string>, dispatch: (command: string, args?: unknown[]) => void, canRun: (command: string) => boolean): void {
	// The declared settings join the registry the Settings dialog generates its rows from.
	applyExtensionSettings(extId, contributes?.configuration, nls);
	// The declared sidebar surface (containers + tree views) joins the same registry the
	// workbench builds its activity bar sections from; the declared languages join the
	// language resolution (the snippet files and themes are read by the host, which
	// registers them whole once their contents land).
	applyExtensionViews(extId, contributes, nls);
	registerDeclaredLanguages(extId, contributes?.languages ?? []);
	if (!contributes) return;
	const registered: ExtensionContributions = { commands: new Map(), menus: {}, dispatch };
	byExtension.set(extId, registered);

	const keybindings = new Map((contributes.keybindings ?? []).map((binding) => [binding.command, binding]));
	// VS Code's `commandPalette` placements: an entry whose `when` currently fails hides the
	// command from the palette only — its menu entries keep their own clauses. This is how a
	// locale-twin pair (`x` / `x.zhCn`, each palette-excluded abroad) shows exactly one
	// palette entry, and `when: false` marks an internal command.
	const paletteWhens = new Map<string, string | boolean>(
		(contributes?.menus?.commandPalette ?? []).map((entry) => [entry.command, entry.when ?? true] as [string, string | boolean])
	);
	for (const declared of contributes.commands ?? []) {
		const entry: DeclaredCommand = { id: declared.command, title: localize(declared.title, nls) || declared.command, category: declared.category ? localize(declared.category, nls) : undefined, icon: declared.icon };
		registered.commands.set(entry.id, entry);
		const key = keybindings.get(entry.id);
		const keybinding = key && key.when !== 'false' ? normalizeKeybinding(key.key) : undefined;
		const paletteWhen = whenText(paletteWhens.get(entry.id));
		commands.register({
			id: entry.id,
			title: entry.title,
			category: entry.category,
			keybinding,
			enabled: () => canRun(entry.id),
			paletteHidden: paletteWhen === undefined ? undefined : () => !evaluateWhen(extId, paletteWhen),
			run: () => dispatch(entry.id)
		});
	}

	for (const location of SUPPORTED_MENU_LOCATIONS) {
		const items = contributes.menus?.[location] ?? [];
		if (items.length > 0) registered.menus[location] = items;
	}
}

/** Drop an extension's contributions (uninstall). */
export function removeContributions(extId: string): void {
	extensionSettings.delete(extId);
	viewContributions.delete(extId);
	registerDeclaredLanguages(extId, []);
	registerExtensionSnippets(extId, []);
	registerExtensionThemes(extId, []);
	byExtension.delete(extId);
}

/** The declared (localized) title of a command, for menus and palette-less registrations. */
export function declaredCommand(id: string): DeclaredCommand | undefined {
	for (const contribution of byExtension.values()) {
		const declared = contribution.commands.get(id);
		if (declared) return declared;
	}
	return undefined;
}

/** One manifest-declared menu entry, resolved against the current settings/context: its
 *  (localized) label and the group VS Code would place it in - `navigation` renders as a
 *  title-bar icon for `scm/title`; everything else goes inside "...". `when`-excluded entries
 *  are simply absent. */
export interface ResolvedMenuEntry {
	command: string;
	label: string;
	group: string;
	/** The contributing extension, for resolving its package-relative icon. */
	extId?: string;
	/** The declared command's icon paths, when the manifest carries them. */
	icon?: { light?: string; dark?: string };
}

/** Every location's declared entries that currently apply, in declaration order. */
export function resolvedMenuEntries(location: MenuLocation): ResolvedMenuEntry[] {
	const out: ResolvedMenuEntry[] = [];
	for (const [extId, contribution] of byExtension) {
		for (const entry of contribution.menus[location] ?? []) {
			if (!evaluateWhen(extId, whenText(entry.when))) continue;
			const declared = contribution.commands.get(entry.command) ?? declaredCommand(entry.command);
			if (!declared) continue; // a menu entry whose command is not declared: nothing to show
			out.push({ command: entry.command, label: declared.title, group: entry.group ?? '', extId, icon: declared.icon });
		}
	}
	return out;
}

/** Contributed entries for one of Studio's context menus; empty when nothing applies. */
export function menuItems(location: MenuLocation, args?: unknown[]): MenuItem[] {
	return resolvedMenuEntries(location).map((entry) => {
		// VS Code hands a menu's command the context it was opened on (the Explorer: the
		// clicked resource and the whole selection); a location that passes `args` does the
		// same through the contributing extension's own dispatch.
		const dispatch = entry.extId !== undefined && args !== undefined ? byExtension.get(entry.extId)?.dispatch : undefined;
		return {
			label: entry.label,
			disabled: !commands.isEnabled(entry.command),
			run: dispatch ? () => dispatch(entry.command, args) : () => void commands.execute(entry.command)
		};
	});
}

/** Menu entries for a location, prefixed with a separator when non-empty. `args` is the
 *  location's context for the commands (see `menuItems`). */
export function menuSection(location: MenuLocation, args?: unknown[]): MenuEntry[] {
	const items = menuItems(location, args);
	return items.length > 0 ? ['separator', ...items] : [];
}

export function hasMenuItems(location: MenuLocation): boolean {
	for (const [extId, contribution] of byExtension) {
		if ((contribution.menus[location] ?? []).some((item) => evaluateWhen(extId, whenText(item.when)))) return true;
	}
	return false;
}
