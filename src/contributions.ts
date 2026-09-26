// Extension manifest contributions: the `contributes` section of each installed extension's
// package.json - commands (with their localized titles from package.nls.json), menu placements
// and keybindings - parsed into the workbench. This is static contribution data: it registers
// commands in the palette and appends menu entries to Studio's context menus, evaluated against
// the extension's declared settings (a `when` clause reading `config.<id>`).
//
// `when` clauses are parsed with VS Code's grammar (`evaluateWhen`): `||`, `&&`, `!`,
// parentheses, `==` / `!=` / `===` / `!==`, the regex match `=~ /…/flags`, `in` / `not in`
// and the numeric comparisons `<` `<=` `>` `>=`, over quoted or bare literals. Identifiers
// resolve from: `config.<setting>` (the extension's declared setting — its value or default),
// the context keys `setContext` stored (any value — a string mode, an array for `in`), the
// location's own keys (`view`, `viewItem`, `resourceLangId`, … — passed by the caller), and a
// few platform facts. An identifier nothing defines is treated as satisfied when it stands
// alone (Studio sets far fewer context keys than VS Code, so an unmodelled key must not hide
// an item — it just stops narrowing it); compared against a literal it is `undefined`.

import { extSettings } from './state';
import { commands } from './commands';
import type { MenuEntry, MenuItem } from './ui';

/** The menu locations Studio surfaces. `git.pullpush` is VS Code's SCM sync menu — where
 * a Gerrit `refs/for/` push goes — rendered inside the Source Control "..."
 * menu's Pull, Push submenu. Others (commandPalette, …) only hide or relocate entries in
 * VS Code itself, so they are ignored. */
export const SUPPORTED_MENU_LOCATIONS = ['explorer/context', 'editor/context', 'editor/title', 'editor/title/context', 'scm/title', 'scm/resourceState/context', 'git.pullpush', 'view/title', 'view/item/context'] as const;
export type MenuLocation = (typeof SUPPORTED_MENU_LOCATIONS)[number];

interface DeclaredCommand {
	id: string;
	title: string;
	category?: string;
	/** The manifest's own icon for this command (VS Code renders it in title-bar navigation
	 *  groups): package-relative paths, or a `$(codicon)` reference. */
	icon?: { light?: string; dark?: string } | string;
	/** The `enablement` clause: the command runs (and its menu entries enable) only while
	 *  it holds. */
	enablement?: string;
}

/** A command icon's codicon name when the manifest spells it `$(name)`, else undefined. */
export function codiconOf(icon: DeclaredCommand['icon']): string | undefined {
	if (typeof icon !== 'string') return undefined;
	return /^\$\(([\w-]+)(?:~[\w-]+)?\)$/.exec(icon.trim())?.[1];
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
 *  `registerContextProvider`. Any value: a boolean, a mode string, an array for `in`. */
const contextProviders = new Map<string, () => unknown>();

/** Supply a `when`-clause context key `evaluateWhen` cannot otherwise resolve, computed on
 *  demand (not cached: the caller reads whatever is current every time). Call for every context
 *  key a natively-hosted extension's own (non-running) code would have set via VS Code's
 *  `setContext` - e.g. `git-graph-rs:interfaceZhCn`, set by an extension's own code. */
export function registerContextProvider(key: string, provider: () => unknown): void {
	contextProviders.set(key, provider);
}

/** The platform facts every `when` can read. */
function platformContext(): Record<string, unknown> {
	const platform = typeof navigator !== 'undefined' ? navigator.platform ?? '' : '';
	return { isWindows: /^win/i.test(platform), isMac: /^mac/i.test(platform), isLinux: /linux/i.test(platform), isWeb: false, remoteName: '' };
}

/** One declared setting's current value: the stored override, or the manifest's default. */
function configValue(extId: string, key: string): unknown {
	const stored = extSettings(extId);
	if (key in stored) return stored[key];
	return extensionSettings.get(extId)?.find((def) => def.id === key)?.default;
}

function resolveIdentifier(extId: string, name: string, extra?: Record<string, unknown>): unknown {
	if (name === 'true') return true;
	if (name === 'false') return false;
	if (extra && name in extra) return extra[name];
	if (name in staticContext) return staticContext[name];
	if (name.startsWith('config.')) return configValue(extId, name.slice('config.'.length));
	if (contextProviders.has(name)) return contextProviders.get(name)!();
	const platform = platformContext();
	if (name in platform) return platform[name];
	return undefined; // not modelled: never narrows the item away (see module doc)
}

/* ---------- The `when` clause grammar ---------- */

type WhenToken = { kind: 'op'; value: string } | { kind: 'word'; value: string } | { kind: 'string'; value: string } | { kind: 'regex'; value: RegExp };

/** Split a clause into operators, words, quoted strings and `/regex/flags` literals. */
function tokenizeWhen(text: string): WhenToken[] {
	const tokens: WhenToken[] = [];
	let at = 0;
	while (at < text.length) {
		const char = text[at]!;
		if (/\s/.test(char)) {
			at++;
			continue;
		}
		const two = text.slice(at, at + 3);
		const op = ['===', '!=='].includes(two) ? two : ['==', '!=', '&&', '||', '<=', '>=', '=~'].includes(text.slice(at, at + 2)) ? text.slice(at, at + 2) : ['!', '(', ')', '<', '>'].includes(char) ? char : null;
		if (op !== null) {
			tokens.push({ kind: 'op', value: op });
			at += op.length;
			// A regex literal follows `=~`.
			if (op === '=~') {
				while (at < text.length && /\s/.test(text[at]!)) at++;
				if (text[at] === '/') {
					let end = at + 1;
					while (end < text.length && text[end] !== '/') end += text[end] === '\\' ? 2 : 1;
					const body = text.slice(at + 1, end);
					let flagsEnd = end + 1;
					while (flagsEnd < text.length && /[a-z]/i.test(text[flagsEnd]!)) flagsEnd++;
					try {
						tokens.push({ kind: 'regex', value: new RegExp(body, text.slice(end + 1, flagsEnd)) });
					} catch {
						tokens.push({ kind: 'regex', value: /(?!)/ });
					}
					at = flagsEnd;
				}
			}
			continue;
		}
		if (char === "'" || char === '"') {
			const end = text.indexOf(char, at + 1);
			const stop = end === -1 ? text.length : end;
			tokens.push({ kind: 'string', value: text.slice(at + 1, stop) });
			at = stop + 1;
			continue;
		}
		let end = at;
		while (end < text.length && !/[\s!=<>()&|'"]/.test(text[end]!)) end++;
		if (end === at) end++; // a stray character: consume it as a word
		tokens.push({ kind: 'word', value: text.slice(at, end) });
		at = end;
	}
	return tokens;
}

/** A literal's value: quoted text as-is, numbers and booleans typed, bare words as text. */
function literalValue(token: WhenToken | undefined): unknown {
	if (token === undefined) return undefined;
	if (token.kind === 'regex') return token.value;
	if (token.kind === 'string') return token.value;
	if (token.value === 'true') return true;
	if (token.value === 'false') return false;
	if (/^-?\d+(\.\d+)?$/.test(token.value)) return Number(token.value);
	return token.value;
}

/** Evaluate a `when` clause with VS Code's precedence (`!` > comparisons > `&&` > `||`).
 *  Exported for the workbench's view visibility (a `contributes.views` entry's `when`
 *  hides the view exactly as a menu entry's hides the item). `extra` carries the
 *  location's own context keys (`view`, `viewItem`, `resourceLangId`, …). */
export function evaluateWhen(extId: string, when: string | undefined, extra?: Record<string, unknown>): boolean {
	if (when === undefined) return true;
	const tokens = tokenizeWhen(when);
	let at = 0;
	const peek = () => tokens[at];
	const isOp = (value: string) => peek()?.kind === 'op' && peek()!.value === value;
	const resolve = (name: string) => resolveIdentifier(extId, name, extra);

	const parseOr = (): boolean => {
		let value = parseAnd();
		while (isOp('||')) {
			at++;
			const right = parseAnd();
			value = value || right;
		}
		return value;
	};
	const parseAnd = (): boolean => {
		let value = parseUnary();
		while (isOp('&&')) {
			at++;
			const right = parseUnary();
			value = value && right;
		}
		return value;
	};
	const parseUnary = (): boolean => {
		if (isOp('!')) {
			at++;
			// `!unknownKey` keeps the "never narrows away" posture: an unmodelled key negated
			// is still satisfied.
			const next = peek();
			if (next?.kind === 'word' && !isComparisonAt(at + 1) && resolve(next.value) === undefined && next.value !== 'true' && next.value !== 'false') {
				at++;
				return true;
			}
			return !parseUnary();
		}
		return parsePrimary();
	};
	const isComparisonAt = (index: number): boolean => {
		const token = tokens[index];
		if (token === undefined) return false;
		if (token.kind === 'op') return ['==', '!=', '===', '!==', '=~', '<', '<=', '>', '>='].includes(token.value);
		if (token.kind === 'word') return token.value === 'in' || (token.value === 'not' && tokens[index + 1]?.kind === 'word' && tokens[index + 1]!.value === 'in');
		return false;
	};
	const parsePrimary = (): boolean => {
		const token = peek();
		if (token === undefined) return true;
		if (token.kind === 'op' && token.value === '(') {
			at++;
			const value = parseOr();
			if (isOp(')')) at++;
			return value;
		}
		at++;
		if (token.kind !== 'word') return Boolean(literalValue(token));
		const name = token.value;
		const next = peek();
		if (next?.kind === 'word' && (next.value === 'in' || next.value === 'not')) {
			const negate = next.value === 'not';
			at += negate ? 2 : 1;
			const container = resolve(String(literalValue(peek())));
			at++;
			const needle = resolve(name);
			const contained = Array.isArray(container) ? container.includes(needle) : container !== null && typeof container === 'object' ? Object.prototype.hasOwnProperty.call(container, String(needle)) : false;
			return negate ? !contained : contained;
		}
		if (next?.kind === 'op' && ['==', '!=', '===', '!==', '=~', '<', '<=', '>', '>='].includes(next.value)) {
			at++;
			const literal = literalValue(peek());
			at++;
			const value = resolve(name);
			switch (next.value) {
				case '==':
				case '===':
					return String(value) === String(literal);
				case '!=':
				case '!==':
					return String(value) !== String(literal);
				case '=~':
					return literal instanceof RegExp && typeof value === 'string' ? literal.test(value) : false;
				case '<':
					return Number(value) < Number(literal);
				case '<=':
					return Number(value) <= Number(literal);
				case '>':
					return Number(value) > Number(literal);
				case '>=':
					return Number(value) >= Number(literal);
			}
		}
		const value = resolve(name);
		if (value === undefined) return true; // not modelled: never narrows the item away
		return Boolean(value);
	};
	try {
		return parseOr();
	} catch {
		return true;
	}
}

/** A manifest `when` in the string form `evaluateWhen` parses: the bare JSON `false` (and any
 *  boolean spelling) becomes its text, so "never" and the clause forms share one path. */
function whenText(when: string | boolean | undefined): string | undefined {
	return when === undefined ? undefined : String(when);
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
	commands?: { command: string; title?: string | { value?: string; original?: string }; category?: string | { value?: string; original?: string }; icon?: { light?: string; dark?: string } | string; enablement?: string }[];
	menus?: Record<string, MenuPlacement[] | undefined>;
	/** VS Code's own shape allows a single binding object as well as the array; the single
	 *  form is normalized to the array on read. */
	keybindings?: ManifestKeybinding | ManifestKeybinding[];
	/** VS Code's `contributes.configuration`: the settings an extension declares (M3 3.9).
	 *  VS Code accepts one object OR an array of them — the array form is normalized on
	 *  read (a package with several configuration blocks keeps every property). */
	configuration?: {
		title?: string;
		properties?: Record<string, ManifestSettingProperty>;
	} | { title?: string; properties?: Record<string, ManifestSettingProperty> }[];
	/** VS Code's `contributes.viewsContainers`: activity-bar containers an extension adds —
	 *  each becomes its own sidebar view holding the views that name it in `views`. */
	viewsContainers?: { activitybar?: { id: string; title: string; icon?: string }[] };
	/** VS Code's `contributes.views`, by container id: the tree views the extension shows
	 *  (`window.createTreeView` of the same id feeds them their content); a view with
	 *  `type: "webview"` is a webview view (`registerWebviewViewProvider` serves it). */
	views?: Record<string, { id: string; name: string; when?: string; type?: string }[] | undefined>;
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

/** One `contributes.keybindings` entry: `key` plus the per-platform overrides, and the
 *  arguments the bound command receives. */
export interface ManifestKeybinding {
	command: string;
	key?: string;
	win?: string;
	linux?: string;
	mac?: string;
	when?: string;
	args?: unknown;
}

/** One `contributes.configuration` property, as much of JSON schema as the dialog uses. */
export interface ManifestSettingProperty {
	type?: string | string[];
	default?: unknown;
	description?: string;
	markdownDescription?: string;
	enum?: unknown[];
	deprecationMessage?: string;
}

/** One extension-declared setting, normalised for the Settings dialog's generated rows:
 *  `json` covers arrays, objects and multi-type schemas (edited as JSON text), `enum`
 *  a closed value list (a select). */
export interface ExtensionSettingDef {
	extId: string;
	id: string;
	type: 'boolean' | 'string' | 'number' | 'enum' | 'json';
	default: unknown;
	description: string;
	enumValues?: unknown[];
}

/** The Uri-shaped argument VS Code hands a menu's command for a clicked resource: the
 *  Explorer's context locations, the editor's resource, a resource state's `resourceUri`,
 *  a repository's `rootUri`. A plain `{ scheme, path, fsPath }` object — the frame-side
 *  shim (`vscodeApi`'s `rehydrateUris`) rebuilds the Uri methods on arrival, so an
 *  extension's `uri.fsPath`, `uri.toString()` and `uri.with()` all work. */
export function contextUri(path: string): { scheme: string; path: string; fsPath: string; query: string; fragment: string } {
	return { scheme: 'file', path, fsPath: path, query: '', fragment: '' };
}

/** One extension's declared sidebar surface: its activity-bar containers and the tree
 *  views placed in them (or in a built-in container — `explorer` and `scm` are accepted
 *  ids, the view then rides that container's sidebar view as a stacked section). */
export interface ExtensionViewContribution {
	extId: string;
	containers: { id: string; title: string; icon?: string }[];
	/** `container` is the manifest's container id; `viewId` is the view's own id (the
	 *  `createTreeView` id); `type: "webview"` marks a webview view
	 *  (`registerWebviewViewProvider`), which the workbench hosts as an iframe section;
	 *  `when` is the manifest's visibility clause, evaluated like a menu's. */
	views: { viewId: string; name: string; container: string; type?: 'tree' | 'webview'; when?: string }[];
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
		for (const view of entries ?? []) views.push({ viewId: view.id, name: localize(view.name, nls) || view.id, container, type: view.type === 'webview' ? 'webview' : 'tree', when: view.when });
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
 *  schema and its localised descriptions arrive with the Settings dialog's chunk. The
 *  configuration contribution accepts VS Code's two spellings — one object or an array of
 *  them — and every block's properties join one settings list. */
export function applyExtensionSettings(extId: string, configuration: ManifestContributes['configuration'], nls: Record<string, string>): void {
	const blocks = Array.isArray(configuration) ? configuration : [configuration];
	const defs: ExtensionSettingDef[] = [];
	for (const block of blocks) {
		for (const [id, property] of Object.entries(block?.properties ?? {})) {
			const declared = Array.isArray(property.type) ? property.type.filter((entry) => entry !== 'null') : [property.type];
			const single = declared.length === 1 ? declared[0] : undefined;
			const type: ExtensionSettingDef['type'] = Array.isArray(property.enum) && property.enum.length > 0 ? 'enum'
				: single === 'boolean' ? 'boolean'
				: single === 'number' || single === 'integer' ? 'number'
				: single === 'string' || single === undefined && property.default === undefined ? 'string'
				: single === undefined && typeof property.default === 'string' ? 'string'
				: single === undefined && typeof property.default === 'boolean' ? 'boolean'
				: single === undefined && typeof property.default === 'number' ? 'number'
				: 'json';
			// The declared default is kept whatever its shape (an array, an object, null) —
			// only an absent one falls back to the type's empty value.
			const fallback = type === 'boolean' ? false : type === 'number' ? 0 : type === 'json' ? (single === 'array' ? [] : single === 'object' ? {} : null) : type === 'enum' ? property.enum![0] : '';
			const description = localize(property.description ?? property.markdownDescription, nls);
			defs.push({ extId, id, type, default: 'default' in property ? property.default : fallback, description, enumValues: type === 'enum' ? property.enum : undefined });
		}
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

	// One registry keybinding per command: the first declared binding whose platform key
	// exists and whose `when` is not the literal false wins (VS Code's first match), and
	// its `args` travel with the run. The later alternatives are noted, not bound.
	const platform = typeof navigator !== 'undefined' ? navigator.platform ?? '' : '';
	const platformKey = (binding: ManifestKeybinding): string | undefined =>
		(/^win/i.test(platform) ? binding.win : /^mac/i.test(platform) ? binding.mac : /linux/i.test(platform) ? binding.linux : undefined) ?? binding.key;
	const keybindings = new Map<string, { key: string; when?: string; args?: unknown }>();
	for (const binding of (Array.isArray(contributes.keybindings) ? contributes.keybindings : [contributes.keybindings])) {
		if (binding === undefined || typeof binding.command !== 'string') continue;
		const key = platformKey(binding);
		if (!key || binding.when === 'false' || keybindings.has(binding.command)) continue;
		keybindings.set(binding.command, { key, when: binding.when, args: binding.args });
	}
	// VS Code's `commandPalette` placements: an entry whose `when` currently fails hides the
	// command from the palette only — its menu entries keep their own clauses. This is how a
	// locale-twin pair (`x` / `x.zhCn`, each palette-excluded abroad) shows exactly one
	// palette entry, and `when: false` marks an internal command.
	const paletteWhens = new Map<string, string | boolean>(
		(contributes?.menus?.commandPalette ?? []).map((entry) => [entry.command, entry.when ?? true] as [string, string | boolean])
	);
	// A localized title may be `{ value, original }` (VS Code's ILocalizedString form).
	const textOf = (value: string | { value?: string; original?: string } | undefined): string | undefined =>
		typeof value === 'string' ? value : value?.value ?? value?.original;
	for (const declared of contributes.commands ?? []) {
		const entry: DeclaredCommand = { id: declared.command, title: localize(textOf(declared.title), nls) || declared.command, category: declared.category ? localize(textOf(declared.category), nls) : undefined, icon: declared.icon, enablement: declared.enablement };
		registered.commands.set(entry.id, entry);
		const key = keybindings.get(entry.id);
		const keybinding = key ? normalizeKeybinding(key.key) : undefined;
		const paletteWhen = whenText(paletteWhens.get(entry.id));
		commands.register({
			id: entry.id,
			title: entry.title,
			category: entry.category,
			keybinding,
			enabled: () => canRun(entry.id) && evaluateWhen(extId, entry.enablement),
			paletteHidden: paletteWhen === undefined ? undefined : () => !evaluateWhen(extId, paletteWhen),
			run: () => dispatch(entry.id, key?.args === undefined ? undefined : [key.args])
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
	/** The declared command's icon (paths or a `$(codicon)`), when the manifest has one. */
	icon?: { light?: string; dark?: string } | string;
}

/** Every location's declared entries that currently apply, in declaration order — sorted
 *  by group, then by the `@order` suffix, as VS Code lays menus out. `context` carries the
 *  location's own `when` keys (`view`, `viewItem`, `resourceLangId`, …). */
export function resolvedMenuEntries(location: MenuLocation, context?: Record<string, unknown>): ResolvedMenuEntry[] {
	const out: (ResolvedMenuEntry & { order: number; index: number })[] = [];
	for (const [extId, contribution] of byExtension) {
		for (const entry of contribution.menus[location] ?? []) {
			if (!evaluateWhen(extId, whenText(entry.when), context)) continue;
			const declared = contribution.commands.get(entry.command) ?? declaredCommand(entry.command);
			if (!declared) continue; // a menu entry whose command is not declared: nothing to show
			const [group, order] = (entry.group ?? '').split('@');
			out.push({ command: entry.command, label: declared.title, group: group ?? '', extId, icon: declared.icon, order: Number(order) || 0, index: out.length });
		}
	}
	// Grouped entries keep declaration order within equal (group, order) — a stable sort.
	return out
		.sort((a, b) => (a.group === b.group ? a.order - b.order || a.index - b.index : a.group === 'navigation' ? -1 : b.group === 'navigation' ? 1 : a.group.localeCompare(b.group)))
		.map(({ order: _order, index: _index, ...entry }) => entry);
}

/** Contributed entries for one of Studio's context menus; empty when nothing applies. */
export function menuItems(location: MenuLocation, args?: unknown[], context?: Record<string, unknown>): MenuItem[] {
	return resolvedMenuEntries(location, context).map((entry) => {
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

/** Run one contributed menu entry with its location's arguments (a title-bar button). */
export function runMenuEntry(entry: ResolvedMenuEntry, args?: unknown[]): void {
	const dispatch = entry.extId !== undefined && args !== undefined ? byExtension.get(entry.extId)?.dispatch : undefined;
	if (dispatch) dispatch(entry.command, args);
	else void commands.execute(entry.command);
}

/** Menu entries for a location, prefixed with a separator when non-empty. `args` is the
 *  location's context for the commands (see `menuItems`). */
export function menuSection(location: MenuLocation, args?: unknown[], context?: Record<string, unknown>): MenuEntry[] {
	const items = menuItems(location, args, context);
	return items.length > 0 ? ['separator', ...items] : [];
}

/** The `when` keys VS Code sets for a resource menu (explorer, editor title, …). */
export function resourceContext(path: string): Record<string, unknown> {
	const name = path.split(/[\\/]/).pop() ?? path;
	const dot = name.lastIndexOf('.');
	return {
		resource: path,
		resourcePath: path,
		resourceFilename: name,
		resourceExtname: dot > 0 ? name.slice(dot) : '',
		resourceDirname: path.slice(0, Math.max(0, path.length - name.length - 1)),
		resourceLangId: languageIdFor(name),
		resourceScheme: 'file',
		editorLangId: languageIdFor(name)
	};
}

export function hasMenuItems(location: MenuLocation): boolean {
	for (const [extId, contribution] of byExtension) {
		if ((contribution.menus[location] ?? []).some((item) => evaluateWhen(extId, whenText(item.when)))) return true;
	}
	return false;
}
