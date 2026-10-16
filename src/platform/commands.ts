// The command registry: every action of the workbench is a command with an id, a title (the
// Command Palette shows "Category: Title"), an optional keybinding and an optional enablement.
// The title bar menus, the "..." menus, the palette and the keyboard shortcuts all resolve to
// these, so one definition drives every entry point - and every entry point is testable.

import { trText } from './i18n';
import type { MenuItem } from './ui';

/** The shells a command belongs to (docs/remote-client-plan.md §3.2, K1–K4): the desktop
 *  app and the remote app are two entries with two command configs over one core. */
export type CommandProfile = 'desktop' | 'remote';

export interface Command {
	id: string;
	title: string;
	category?: string;
	keybinding?: string;
	/** False hides the command from the palette and disables its menu items. */
	enabled?: () => boolean;
	/** False hides the command from the palette only (its menu entries keep their own
	 *  enablement) — the manifest `commandPalette` placements' `when` clauses. */
	paletteHidden?: () => boolean;
	/** Which shells list the command — menus, palette, keybindings, the action panels all
	 *  filter on the ACTIVE profile; absent means both. Visibility only: a programmatic
	 *  `execute` keeps working (an extension's openSettings is not the user's menu row). */
	profiles?: readonly CommandProfile[];
	run: () => void | Promise<void>;
}

/** Key names as they are spelled in keybindings ("Left") vs. KeyboardEvent ("ArrowLeft"). */
function normalizeKey(key: string): string {
	return key.toLowerCase().replace(/^arrow/, '');
}

/** Normalise a keybinding label ("Ctrl+Shift+E", "Ctrl+`") into the parts a KeyboardEvent has. */
function parseKeybinding(keybinding: string): { ctrl: boolean; shift: boolean; alt: boolean; key: string } {
	const parts = keybinding.split('+').map((p) => p.trim());
	const key = normalizeKey(parts[parts.length - 1]!);
	return {
		ctrl: parts.some((p) => /^(ctrl|cmd|mod)$/i.test(p)),
		shift: parts.some((p) => /^shift$/i.test(p)),
		alt: parts.some((p) => /^alt$/i.test(p)),
		key: key === 'space' ? ' ' : key
	};
}

/** The US-layout key behind a shifted glyph ("~" is Shift+"`"): bindings are spelled with the
 *  unshifted key ("Ctrl+Shift+`"), but a KeyboardEvent reports the shifted glyph - matching
 *  (commands.ts) and recording (keybindings.ts) both normalize through this table. */
export const UNSHIFTED_GLYPHS: Record<string, string> = {
	'~': '`', '!': '1', '@': '2', '#': '3', '$': '4', '%': '5', '^': '6', '&': '7', '*': '8', '(': '9', ')': '0',
	'_': '-', '+': '=', '{': '[', '}': ']', '|': '\\', ':': ';', '"': "'", '<': ',', '>': '.', '?': '/'
};

/** The user-keybinding override (keybindings.ts installs it; circular import otherwise):
 *  returns the effective binding for a command id - undefined "the registry default", null
 *  "explicitly unbound", a string "the user's key". */
export type KeybindingResolver = (commandId: string) => string | null | undefined;
let keybindingResolver: KeybindingResolver | null = null;

export function setKeybindingResolver(resolver: KeybindingResolver | null): void {
	keybindingResolver = resolver;
}

/** The key a command answers to: the user's binding, or the registry's default. */
export function effectiveBinding(commandId: string, fallback?: string): string | null | undefined {
	if (keybindingResolver) return keybindingResolver(commandId);
	return fallback ?? undefined;
}

/** The command a binding string ("Ctrl+Shift+P", or a chord "Ctrl+K Ctrl+S") runs. */
export function commandForBinding(binding: string): Command | undefined {
	const wanted = binding.toLowerCase();
	return commands.all().find((command) => {
		const effective = keybindingResolver ? keybindingResolver(command.id) : undefined;
		const key = (effective === undefined ? command.keybinding : effective) ?? null;
		return key !== null && key.toLowerCase() === wanted;
	});
}

export function matchesKeybinding(event: KeyboardEvent, keybinding: string): boolean {
	// A chord ("Ctrl+K Ctrl+B") is two keystrokes; the workbench resolves it from its pending
	// prefix. Matching its last key here would let "Ctrl+K Ctrl+B" swallow a plain Ctrl+B.
	if (keybinding.includes(' ')) return false;
	const wanted = parseKeybinding(keybinding);
	const ctrl = event.ctrlKey || event.metaKey;
	if (wanted.ctrl !== ctrl || wanted.shift !== event.shiftKey || wanted.alt !== event.altKey) return false;
	const key = normalizeKey(event.key);
	if (key === wanted.key) return true;
	// Shift changes the reported glyph for punctuation (Ctrl+Shift+` arrives as "~"): match the
	// unshifted key the binding is spelled with.
	return event.shiftKey && UNSHIFTED_GLYPHS[key] === wanted.key;
}

export class CommandRegistry {
	private readonly commands = new Map<string, Command>();
	private profile: CommandProfile = 'desktop';

	/** The shell this frontend runs as (the desktop app's default stays 'desktop'; the
	 *  remote composition root switches before the workbench registers anything). */
	setActiveProfile(profile: CommandProfile): void {
		this.profile = profile;
	}

	activeProfile(): CommandProfile {
		return this.profile;
	}

	/** Whether the command shows in the active shell — menus, palette, keybindings and the
	 *  action panels all resolve through this one answer. */
	visible(id: string): boolean {
		const command = this.commands.get(id);
		return command === undefined || command.profiles === undefined || command.profiles.includes(this.profile);
	}

	register(command: Command): Command {
		this.commands.set(command.id, command);
		return command;
	}

	get(id: string): Command | undefined {
		return this.commands.get(id);
	}

	all(): Command[] {
		return Array.from(this.commands.values());
	}

	isEnabled(id: string): boolean {
		const command = this.commands.get(id);
		return command !== undefined && (command.enabled === undefined || command.enabled());
	}

	async execute(id: string): Promise<boolean> {
		const command = this.commands.get(id);
		if (!command || !this.isEnabled(id)) return false;
		await command.run();
		return true;
	}

	/** A menu item for a command: its title, keybinding and enablement, unless overridden. */
	menuItem(id: string, overrides: Partial<MenuItem> = {}): MenuItem {
		const command = this.commands.get(id);
		if (!command) return { label: overrides.label ?? id, disabled: true, ...overrides };
		return {
			label: trText(command.title),
			// The user's binding (or "unbound") wins over the registry's default, like the palette.
			keybinding: effectiveBinding(command.id, command.keybinding) ?? undefined,
			disabled: !this.isEnabled(command.id),
			run: () => void this.execute(id),
			...overrides
		};
	}

	/** The command a key event triggers, if any (the first registered wins — and only one
	 *  visible in the active shell: a remote page never keys the desktop-only opens). */
	forKeyEvent(event: KeyboardEvent): Command | undefined {
		for (const command of this.commands.values()) {
			if (!this.visible(command.id)) continue;
			const effective = keybindingResolver ? keybindingResolver(command.id) : undefined;
			const key = (effective === undefined ? command.keybinding : effective) ?? null;
			if (key !== null && matchesKeybinding(event, key)) return command;
		}
		return undefined;
	}

	/** Palette entries: "Category: Title", enabled, not palette-hidden and visible in the
	 *  active shell, sorted. */
	paletteItems(): { label: string; description?: string; value: string }[] {
		return this.all()
			.filter((command) => this.visible(command.id) && this.isEnabled(command.id) && command.paletteHidden?.() !== true)
			.map((command) => ({
				label: command.category ? `${trText(command.category)}: ${trText(command.title)}` : trText(command.title),
				description: effectiveBinding(command.id, command.keybinding) ?? undefined,
				value: command.id
			}))
			.sort((a, b) => a.label.localeCompare(b.label));
	}
}

export const commands = new CommandRegistry();
