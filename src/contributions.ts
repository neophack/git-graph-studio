// Extension manifest contributions: the `contributes` section of each installed extension's
// package.json - commands (with their localized titles from package.nls.json), menu placements
// and keybindings - parsed into the workbench. This is static contribution data: it registers
// commands in the palette and appends menu entries to Studio's context menus even when the
// extension's code is not running in the frame host (the built-in git-graph-rs, whose view the
// workbench hosts natively).
//
// `when` clauses get a minimal treatment: `evaluateWhen` below understands `&&`-joined clauses
// of the shapes VS Code's own manifests actually use for the locations this module models -
// `identifier`, `!identifier`, `identifier == 'literal'` / `!= 'literal'`, and the literal
// `true`/`false`. An identifier this cannot resolve (Studio has no general context-key engine)
// is treated as satisfied, so a clause this module does not model never hides an item - it just
// stops narrowing it. `config.<extension-setting-id>` reads the extension's own declared setting
// (its current value, or its declared default); anything else is looked up through
// `registerContextProvider`, for the handful of context keys a natively-hosted extension's own
// code would otherwise have set itself (see workbench.ts's `git-graph-rs:interfaceZhCn`).

import { extSettings } from './state';
import { commands } from './commands';
import type { MenuEntry, MenuItem } from './ui';

/** The menu locations Studio surfaces. Others (commandPalette, git.pullpush, …) only hide or
 *  relocate entries in VS Code itself, so they are ignored. */
export const SUPPORTED_MENU_LOCATIONS = ['explorer/context', 'editor/context', 'editor/title/context', 'scm/title', 'scm/resourceState/context'] as const;
export type MenuLocation = (typeof SUPPORTED_MENU_LOCATIONS)[number];

interface DeclaredCommand {
	id: string;
	title: string;
	category?: string;
}

interface MenuPlacement {
	command: string;
	when?: string;
	/** VS Code renders a `scm/title` item in the `navigation` group as a title-bar icon, and
	 *  everything else inside "..."; other locations declare a group only to order entries. */
	group?: string;
}

interface ExtensionContributions {
	commands: Map<string, DeclaredCommand>;
	menus: Partial<Record<MenuLocation, MenuPlacement[]>>;
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
 *  `setContext` - e.g. `git-graph-rs:interfaceZhCn`. */
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
	commands?: { command: string; title?: string; category?: string }[];
	menus?: Record<string, MenuPlacement[] | undefined>;
	keybindings?: { command: string; key: string; when?: string }[];
	/** VS Code's `contributes.configuration`: the settings an extension declares (M3 3.9). */
	configuration?: {
		title?: string;
		properties?: Record<string, { type?: string; default?: unknown; description?: string }>;
	};
}

/** One extension-declared setting, normalised for the Settings dialog's generated rows. */
export interface ExtensionSettingDef {
	extId: string;
	id: string;
	type: 'boolean' | 'string' | 'number';
	default: unknown;
	description: string;
}

const extensionSettings = new Map<string, ExtensionSettingDef[]>();

/** The extension-declared settings of every active extension (the dialog's Extensions rows). */
export function extensionSettingDefs(): ExtensionSettingDef[] {
	return [...extensionSettings.values()].flat();
}

/**
 * Register one extension's contributions. `dispatch` runs a contributed command (into the
 * extension's frame, or the workbench's native handling for the built-in); `canRun` gates
 * palette enablement the same way.
 */
export function applyContributions(extId: string, contributes: ManifestContributes | undefined, nls: Record<string, string>, dispatch: (command: string) => void, canRun: (command: string) => boolean): void {
	// The declared settings join the registry the Settings dialog generates its rows from.
	const properties = contributes?.configuration?.properties ?? {};
	const defs: ExtensionSettingDef[] = [];
	for (const [id, property] of Object.entries(properties)) {
		const type = property.type === 'boolean' || property.type === 'number' ? property.type : 'string';
		defs.push({ extId, id, type, default: property.default ?? (type === 'boolean' ? false : type === 'number' ? 0 : ''), description: localize(property.description, nls) });
	}
	if (defs.length > 0) extensionSettings.set(extId, defs);
	else extensionSettings.delete(extId);
	if (!contributes) return;
	const registered: ExtensionContributions = { commands: new Map(), menus: {} };
	byExtension.set(extId, registered);

	const keybindings = new Map((contributes.keybindings ?? []).map((binding) => [binding.command, binding]));
	for (const declared of contributes.commands ?? []) {
		const entry: DeclaredCommand = { id: declared.command, title: localize(declared.title, nls) || declared.command, category: declared.category ? localize(declared.category, nls) : undefined };
		registered.commands.set(entry.id, entry);
		const key = keybindings.get(entry.id);
		const keybinding = key && key.when !== 'false' ? normalizeKeybinding(key.key) : undefined;
		commands.register({
			id: entry.id,
			title: entry.title,
			category: entry.category,
			keybinding,
			enabled: () => canRun(entry.id),
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
}

/** Every location's declared entries that currently apply, in declaration order. */
export function resolvedMenuEntries(location: MenuLocation): ResolvedMenuEntry[] {
	const out: ResolvedMenuEntry[] = [];
	for (const [extId, contribution] of byExtension) {
		for (const entry of contribution.menus[location] ?? []) {
			if (!evaluateWhen(extId, entry.when)) continue;
			const declared = contribution.commands.get(entry.command) ?? declaredCommand(entry.command);
			if (!declared) continue; // a menu entry whose command is not declared: nothing to show
			out.push({ command: entry.command, label: declared.title, group: entry.group ?? '' });
		}
	}
	return out;
}

/** Contributed entries for one of Studio's context menus; empty when nothing applies. */
export function menuItems(location: MenuLocation): MenuItem[] {
	return resolvedMenuEntries(location).map((entry) => ({
		label: entry.label,
		disabled: !commands.isEnabled(entry.command),
		run: () => void commands.execute(entry.command)
	}));
}

/** Menu entries for a location, prefixed with a separator when non-empty. */
export function menuSection(location: MenuLocation): MenuEntry[] {
	const items = menuItems(location);
	return items.length > 0 ? ['separator', ...items] : [];
}

export function hasMenuItems(location: MenuLocation): boolean {
	for (const [extId, contribution] of byExtension) {
		if ((contribution.menus[location] ?? []).some((item) => evaluateWhen(extId, item.when))) return true;
	}
	return false;
}
