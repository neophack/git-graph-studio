// The editor-side hover surfaces and Go-to-Definition: the extensions' hover and
// definition providers ride the frame half (editorHovers.ts's bridge) as a CodeMirror
// hover tooltip that asks the providers, and F12 / Ctrl+Click opens the first location.
// Beside them the workbench's own macro hover answers from the symbol index: the word
// under the pointer's `#define` definitions, one entry each — a name defined in several
// places lists all of them. Markdown from a provider renders as TEXT — an extension's
// hover must not be able to inject markup into the workbench's DOM.

import { hoverTooltip, EditorView, keymap, type TooltipView } from '@codemirror/view';
import { Facet, type Extension } from '@codemirror/state';
import { t } from '../../platform/i18n';
import { joinPath } from '../../platform/ui/index';
import type { WsSymbol } from '../../platform/ipc/search';
import { extensionDefinitionFor, extensionDefinitionOpener, extensionHoverFor, hasExtensionDefinitions, hasExtensionHovers } from './editorHovers';

/** The open file's path, so the provider call names the right document. */
const pathSlot = Facet.define<string, string>({ combine: (values) => values[values.length - 1] ?? '' });

function docInfo(view: EditorView): { path: string; languageId: string; text: string; line: number; character: number } | null {
	const path = view.state.facet(pathSlot);
	if (!path) return null;
	const line = view.state.doc.lineAt(view.state.selection.main.head);
	return {
		path,
		languageId: (view.state as unknown as { language?: { name?: string } }).language?.name ?? '',
		text: view.state.doc.toString(),
		line: line.number - 1,
		character: view.state.selection.main.head - line.from
	};
}

/** The hover tooltip: the providers' first non-empty answer, its contents as text lines. */
const extensionHover = hoverTooltip(async (view, pos) => {
	if (!hasExtensionHovers()) return null;
	const info = docInfo(view);
	if (!info) return null;
	const hover = await extensionHoverFor(info.path, info.languageId, info.text, pos >= 0 ? view.state.doc.lineAt(pos).number - 1 : 0, pos - view.state.doc.lineAt(pos).from);
	if (!hover || hover.contents.length === 0) return null;
	return {
		pos: Math.max(0, Math.min(pos, view.state.doc.length)),
		create: (): TooltipView => {
			const dom = document.createElement('div');
			dom.className = 'ggs-ext-hover';
			for (const text of hover.contents) {
				const block = document.createElement('pre');
				block.className = 'ggs-ext-hover-content';
				block.textContent = text;
				dom.appendChild(block);
			}
			return { dom };
		}
	};
}, { hoverTime: 350 });

/** Go-to-Definition: the providers' first location opens in a tab (F12 or Ctrl/Cmd+Click). */
function goToDefinition(view: EditorView): boolean {
	const opener = extensionDefinitionOpener();
	if (!hasExtensionDefinitions() || !opener) return false;
	const info = docInfo(view);
	if (!info) return false;
	void extensionDefinitionFor(info.path, info.languageId, info.text, info.line, info.character).then((locations) => {
		const first = locations[0];
		if (first) opener.open(first.path, first.startLine, first.startCharacter);
	});
	return true;
}

/** The extension-provider extensions a file editor mounts (hover + definition). */
export function extensionProviderExtensions(path: string): Extension[] {
	return [
		pathSlot.of(path),
		extensionHover,
		keymap.of([{ key: 'F12', run: (view) => goToDefinition(view) }]),
		EditorView.domEventHandlers({
			mousedown: (event, view) => {
				if (!(event.ctrlKey || event.metaKey)) return false;
				if (!hasExtensionDefinitions()) return false;
				const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
				if (pos === null) return false;
				const info = docInfo(view);
				if (!info) return false;
				void extensionDefinitionFor(info.path, info.languageId, info.text, view.state.doc.lineAt(pos).number - 1, pos - view.state.doc.lineAt(pos).from).then((locations) => {
					const first = locations[0];
					if (first) extensionDefinitionOpener()?.open(first.path, first.startLine, first.startCharacter);
				});
				return true;
			}
		})
	];
}

/* ---------- The built-in macro hover ---------- */

/** One indexed macro definition, its directive text sliced off the definition file. */
export interface MacroHoverEntry {
	/** Repo-relative, forward slashes — the index's own spelling. */
	path: string;
	/** 0-based declaration line. */
	line: number;
	/** The `#define …` directive's text, or '' when the file could not be read. */
	text: string;
}

/** Where the hover's data comes from, injected so tests and the mount share one path:
 *  the group's root for path joins, the index's exact-name lookup, the group's cached
 *  file read (which a save invalidates, so a hovered macro never shows stale text). */
export interface MacroHoverSource {
	root(): string | null;
	lookup(name: string): Promise<WsSymbol[]>;
	read(path: string): Promise<string | null>;
}

/** How many directive lines and characters one hover entry shows. */
const MACRO_VALUE_LINES = 8;
const MACRO_VALUE_CHARS = 400;
/** At most this many definitions render in one tooltip (a heavily guarded name). */
const MACRO_HOVER_MAX_DEFS = 8;
/** A lookup answer rides hovers of the same name for this long before it is re-asked. */
const MACRO_LOOKUP_TTL_MS = 15_000;
const MACRO_LOOKUP_CACHE_MAX = 64;

/** The directive a definition names: its lines from the declaration through the end line
 *  (a `\`-continued macro's continuations), trimmed of trailing blank lines and capped. */
export function macroValueAt(contents: string, line: number, endLine: number | undefined): string {
	const lines = contents.split('\n');
	const from = Math.min(Math.max(0, line), lines.length - 1);
	const to = Math.min(Math.max(endLine ?? line, from), from + MACRO_VALUE_LINES - 1, lines.length - 1);
	const text = lines.slice(from, to + 1).join('\n');
	const trimmed = text.replace(/\s+$/, '');
	return trimmed.slice(0, MACRO_VALUE_CHARS);
}

const macroLookupCache = new Map<string, { at: number; entries: MacroHoverEntry[] }>();

/** Drop every cached lookup answer: the tests reset it between cases. */
export function resetMacroHoverCache(): void {
	macroLookupCache.clear();
}

function cacheMacroEntries(key: string, entries: MacroHoverEntry[]): MacroHoverEntry[] {
	// Refresh the insertion order, then drop the oldest entry past the cap.
	macroLookupCache.delete(key);
	macroLookupCache.set(key, { at: Date.now(), entries });
	if (macroLookupCache.size > MACRO_LOOKUP_CACHE_MAX) {
		macroLookupCache.delete(macroLookupCache.keys().next().value!);
	}
	return entries;
}

/** The macro definitions of `name`, each with its directive text — empty when the name
 *  declares no macro (the hover answers nothing) or the index has none. */
export async function macroHoverEntries(source: MacroHoverSource, name: string): Promise<MacroHoverEntry[]> {
	const root = source.root();
	if (!root) return [];
	const key = `${root}\u0000${name}`;
	const cached = macroLookupCache.get(key);
	if (cached && Date.now() - cached.at < MACRO_LOOKUP_TTL_MS) return cached.entries;
	let defs: WsSymbol[];
	try {
		defs = await source.lookup(name);
	} catch {
		return [];
	}
	const macros = defs.filter((def) => def.kind === 'macro').slice(0, MACRO_HOVER_MAX_DEFS);
	if (macros.length === 0) return cacheMacroEntries(key, []);
	const entries: MacroHoverEntry[] = [];
	for (const def of macros) {
		let text = '';
		try {
			const contents = await source.read(joinPath(root, def.path));
			if (contents !== null) text = macroValueAt(contents, def.line, def.endLine);
		} catch {
			text = '';
		}
		entries.push({ path: def.path, line: def.line, text });
	}
	return cacheMacroEntries(key, entries);
}

/** The word under `pos` resolves to its indexed macros: the hover entries, or null when
 *  the pointer is not on an identifier or the name declares no macro. */
export async function macroHoverFor(source: MacroHoverSource, view: EditorView, pos: number): Promise<MacroHoverEntry[] | null> {
	const word = view.state.wordAt(pos);
	if (!word) return null;
	const name = view.state.sliceDoc(word.from, word.to);
	const entries = await macroHoverEntries(source, name);
	return entries.length > 0 ? entries : null;
}

export function macroHoverDom(name: string, entries: MacroHoverEntry[]): HTMLElement {
	const dom = document.createElement('div');
	dom.className = 'ggs-symbol-hover';
	const head = document.createElement('div');
	head.className = 'ggs-symbol-hover-head';
	head.textContent = entries.length > 1 ? `${name} — ${entries.length} ${t('symbols.hover.definitions')}` : name;
	dom.appendChild(head);
	for (const entry of entries) {
		const loc = document.createElement('div');
		loc.className = 'ggs-symbol-hover-loc';
		loc.textContent = `${entry.path}:${entry.line + 1}`;
		dom.appendChild(loc);
		if (entry.text) {
			const code = document.createElement('pre');
			code.className = 'ggs-symbol-hover-code';
			code.textContent = entry.text;
			dom.appendChild(code);
		}
	}
	return dom;
}

/** The workbench's own hover: every definition of the hovered macro, listed. A second
 *  tooltip source beside the extension providers' — both may answer, CodeMirror stacks
 *  them. Definitions of other kinds stay off it: Go-to-Definition and the Context
 *  Window already speak for them. */
export function symbolHoverExtension(source: MacroHoverSource): Extension {
	return hoverTooltip(async (view, pos) => {
		const word = view.state.wordAt(pos);
		if (!word) return null;
		const name = view.state.sliceDoc(word.from, word.to);
		const entries = await macroHoverEntries(source, name);
		if (entries.length === 0) return null;
		return {
			pos: word.from,
			create: (): TooltipView => ({ dom: macroHoverDom(name, entries) })
		};
	}, { hoverTime: 350 });
}
