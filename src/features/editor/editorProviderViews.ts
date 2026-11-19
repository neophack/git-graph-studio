// The editor-side hover surfaces and Go-to-Definition: the extensions' hover and
// definition providers ride the frame half (editorHovers.ts's bridge) as a CodeMirror
// hover tooltip that asks the providers, and F12 / Ctrl+Click opens the first location.
// Beside them the workbench's own quick-info hover answers from the symbol index
// (CLion's quick documentation without a language server): a hovered `#define` shows
// every indexed definition's directive text, a hovered function / struct / enum / class
// shows its whole definition body (the scrollable pane carries it whatever its length),
// and any other symbol shows its declaration line with the comment block above it — a
// name defined in several places lists all of them, each location a click that opens the
// definition. The tooltip is sticky: the pointer may travel to it (the keep-alive guard
// below) and work it — scrolling the body, clicking a location — without it dismissing.
// Markdown from a provider renders as TEXT — an extension's hover must not be able to
// inject markup into the workbench's DOM.

import { hoverTooltip, ViewPlugin, EditorView, keymap, type TooltipView } from '@codemirror/view';
import { Facet, type Extension } from '@codemirror/state';
import { t } from '../../platform/i18n';
import { joinPath, relativeTo } from '../../platform/ui/index';
import type { WsSymbol } from '../../platform/ipc/search';
import type { ScopeDefinition } from '../../platform/ipc/symbols';
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
	// The word under the pointer spans the tooltip's keep range: a zero-width one would
	// dismiss on the first move off that exact spot, before the pointer ever reaches the
	// tooltip.
	const word = view.state.wordAt(pos);
	const from = word ? word.from : Math.max(0, Math.min(pos, view.state.doc.length));
	return {
		pos: from,
		end: word ? word.to : from,
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
	/** 0-based declaration line — the directive's own line, wherever the file keeps it now. */
	line: number;
	/** The `#define …` directive's text, or '' when the file could not be read. */
	text: string;
	/** The doc comment above the directive, or '' when there is none. */
	comment: string;
}

/** Where the hover's data comes from, injected so tests and the mount share one path:
 *  the group's root for path joins, the index's exact-name lookup, the group's cached
 *  file read (which a save invalidates, so a hovered macro never shows stale text), and
 *  the open that a clicked location rides — the repo-relative path and the 0-based
 *  declaration line; the group resolves them against its own root. */
export interface MacroHoverSource {
	root(): string | null;
	lookup(name: string): Promise<WsSymbol[]>;
	read(path: string): Promise<string | null>;
	open?(path: string, line: number): void;
	/** The scope-aware half (2026-11-18): the enclosing function's parameters and locals
	 *  for a name at a line of `text` — the group passes the live buffer, the backend
	 *  parses it per call. Optional: a source without it (a diff tab holds no file of
	 *  its own; the tests' fakes) answers only the global index. */
	scopeLookup?(name: string, line: number, text: string): Promise<ScopeDefinition[]>;
}

/** How many directive lines and characters one hover entry shows. */
const MACRO_VALUE_LINES = 8;
const MACRO_VALUE_CHARS = 400;
/** At most this many definitions render in one tooltip (a heavily guarded name). */
const MACRO_HOVER_MAX_DEFS = 8;
/** A lookup answer rides hovers of the same name for this long before it is re-asked. */
const MACRO_LOOKUP_TTL_MS = 15_000;
const MACRO_LOOKUP_CACHE_MAX = 64;
/** The quick-info body's own caps: at most this many definitions of one name, and the
 *  comment block above a declaration shows at most this many lines / characters. */
const QUICK_INFO_MAX_DEFS = 3;
const QUICK_INFO_COMMENT_LINES = 6;
const QUICK_INFO_COMMENT_CHARS = 300;
/** How much of one definition body the hover keeps — a real function or struct fits
 *  whole; the tooltip pane scrolls over the cap, not the body. */
const HOVER_BODY_MAX_LINES = 600;
const HOVER_BODY_MAX_CHARS = 30_000;
/** The kinds whose declaration is a block the hover shows whole — everything else
 *  (a variable, a constant, a field) is its declaration line. */
const BODY_KINDS = new Set([
	'function', 'method', 'class', 'struct', 'enum', 'union', 'interface', 'module',
	'namespace', 'trait', 'impl', 'record', 'constructor', 'type'
]);

/** The definition body `contents` carries at `line` through `endLine` — whole, whatever
 *  its length: the hover pane scrolls (an `endLine` at or before the line, the outline
 *  fallback's shape, means the index names no body and the answer is ''). */
export function symbolBodyAt(contents: string, line: number, endLine: number | undefined): string {
	const end = endLine ?? line;
	if (end <= line) return '';
	const lines = contents.split('\n');
	const from = Math.min(Math.max(0, line), lines.length - 1);
	const to = Math.min(Math.max(end, from), from + HOVER_BODY_MAX_LINES - 1, lines.length - 1);
	const trimmed = lines.slice(from, to + 1).join('\n').replace(/\s+$/, '');
	return trimmed.slice(0, HOVER_BODY_MAX_CHARS);
}

/** A preprocessor directive line (`#define`, `#if`, … — the C family's `#`-keyword rows). */
const PREPROC_ROW = /^\s*#\s*\w/;

/** Whether `line` textually ends on a line continuation: an unescaped trailing backslash
 *  (`\`-newline), the preprocessor's own continuation rule — a doubled `\\\\` is an
 *  escaped backslash, not a continuation. */
function continues(line: string): boolean {
	const t = line.replace(/\s+$/, '');
	return t.endsWith('\\') && !t.endsWith('\\\\');
}

/** The last 0-based row a `#define` at `from` naturally reaches: itself, plus one row per
 *  `\`-continued line above the first line that ends clean. The index's own end line is
 *  trusted only this far — a stale entry (a file the index has not re-read yet) must never
 *  pull the declaration below the directive into a macro's hover. */
function directiveEnd(lines: string[], from: number): number {
	let end = from;
	while (end + 1 < lines.length && continues(lines[end]!)) end++;
	return end;
}

/** The directive a definition names: its lines from the declaration through the end line
 *  (a `\`-continued macro's continuations), trimmed of trailing blank lines and capped —
 *  and, for a preprocessor directive, cut at the directive's own last continuation line,
 *  whatever end line a stale index entry carries. */
export function macroValueAt(contents: string, line: number, endLine: number | undefined): string {
	const lines = contents.split('\n');
	const from = Math.min(Math.max(0, line), lines.length - 1);
	let to = Math.min(Math.max(endLine ?? line, from), from + MACRO_VALUE_LINES - 1, lines.length - 1);
	if (PREPROC_ROW.test(lines[from]!)) to = Math.min(to, directiveEnd(lines, from));
	const text = lines.slice(from, to + 1).join('\n');
	const trimmed = text.replace(/\s+$/, '');
	return trimmed.slice(0, MACRO_VALUE_CHARS);
}

/** Whether `row` is the directive that defines `name` — `#define NAME` / `#define NAME(`
 *  (the C family) or `macro_rules! NAME` (Rust). */
function namesDirective(row: string, name: string): boolean {
	return new RegExp(`^\\s*#\\s*define\\s+${name}(?![\\w])`).test(row)
		|| new RegExp(`^\\s*macro_rules!\\s*${name}(?![\\w])`).test(row);
}

/** The line `contents` actually defines `name`'s macro on: the index's line when it still
 *  names the directive, else the first line that does (the index's lines drift while a
 *  file's re-read lags — a watcher-missed save, a multi-root path mismatch), or -1 when
 *  the file no longer defines the name. */
export function macroDirectiveLine(contents: string, name: string, line: number): number {
	const lines = contents.split('\n');
	const at = Math.min(Math.max(0, line), lines.length - 1);
	if (!/^[\w]+$/.test(name)) return at;
	if (namesDirective(lines[at] ?? '', name)) return at;
	for (let i = 0; i < lines.length; i++) {
		if (namesDirective(lines[i] ?? '', name)) return i;
	}
	return -1;
}

/** The comment block that ends on the line above `line`: consecutive `//`, `///`, `/*`
 *  or `*` rows walked upward, stopped by any other text or a blank line, reading
 *  downward and capped — a declaration's doc comment, as CLion's hover shows it. */
export function precedingComment(contents: string, line: number): string {
	const lines = contents.split('\n');
	const picked: string[] = [];
	for (let i = line - 1; i >= 0 && picked.length < QUICK_INFO_COMMENT_LINES; i--) {
		const text = lines[i]?.trim() ?? '';
		if (!text || !/^(\/\/|\/\*|\*)/.test(text)) break;
		picked.push(lines[i]!);
	}
	if (picked.length === 0) return '';
	picked.reverse();
	return picked.join('\n').slice(0, QUICK_INFO_COMMENT_CHARS).trim();
}

const macroLookupCache = new Map<string, { at: number; defs: WsSymbol[] }>();

/** Drop every cached lookup answer: the tests reset it between cases. */
export function resetMacroHoverCache(): void {
	macroLookupCache.clear();
}

function cacheMacroDefs(key: string, defs: WsSymbol[]): WsSymbol[] {
	// Refresh the insertion order, then drop the oldest entry past the cap.
	macroLookupCache.delete(key);
	macroLookupCache.set(key, { at: Date.now(), defs });
	if (macroLookupCache.size > MACRO_LOOKUP_CACHE_MAX) {
		macroLookupCache.delete(macroLookupCache.keys().next().value!);
	}
	return defs;
}

/** The macro definitions of `name`, each with its directive text — empty when the name
 *  declares no macro (the hover answers nothing) or the index has none. The index's
 *  lookup is cached for the TTL, but the text is sliced fresh from the file on every
 *  hover and validated against it: the entry's line is re-aligned onto the directive
 *  the file has now, the slice is cut at the directive's own last continuation line,
 *  and the comment above rides along — so a stale index entry shows the macro and its
 *  comment, never the declaration that happens to sit on the drifted lines. */
export async function macroHoverEntries(source: MacroHoverSource, name: string): Promise<MacroHoverEntry[]> {
	const root = source.root();
	if (!root) return [];
	const key = `${root}\u0000${name}`;
	const cached = macroLookupCache.get(key);
	let defs: WsSymbol[];
	if (cached && Date.now() - cached.at < MACRO_LOOKUP_TTL_MS) {
		defs = cached.defs;
	} else {
		try {
			defs = await source.lookup(name);
		} catch {
			return [];
		}
		defs = cacheMacroDefs(key, defs.filter((def) => def.kind === 'macro').slice(0, MACRO_HOVER_MAX_DEFS));
	}
	const entries: MacroHoverEntry[] = [];
	for (const def of defs) {
		let text = '';
		let comment = '';
		let line = def.line;
		try {
			const contents = await source.read(joinPath(root, def.path));
			if (contents !== null) {
				const at = macroDirectiveLine(contents, def.name, def.line);
				if (at >= 0) {
					// The end line rides the same drift the start realigned by; the
					// directive's own continuation end caps whatever is left of it.
					const drift = at - def.line;
					text = macroValueAt(contents, at, Math.max(at, (def.endLine ?? def.line) + drift));
					comment = precedingComment(contents, at);
					line = at;
				}
			}
		} catch {
			text = '';
		}
		entries.push({ path: def.path, line, text, comment });
	}
	return entries;
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

export function macroHoverDom(name: string, entries: MacroHoverEntry[], open?: (path: string, line: number) => void): HTMLElement {
	const dom = document.createElement('div');
	dom.className = 'ggs-symbol-hover';
	const head = document.createElement('div');
	head.className = 'ggs-symbol-hover-head';
	head.textContent = entries.length > 1 ? `${name} — ${entries.length} ${t('symbols.hover.definitions')}` : name;
	dom.appendChild(head);
	for (const entry of entries) {
		if (entry.comment) {
			const comment = document.createElement('pre');
			comment.className = 'ggs-symbol-hover-comment';
			comment.textContent = entry.comment;
			dom.appendChild(comment);
		}
		if (entry.text) {
			const code = document.createElement('pre');
			code.className = 'ggs-symbol-hover-code';
			code.textContent = entry.text;
			dom.appendChild(code);
		}
		const loc = open
			? document.createElement('button')
			: document.createElement('div');
		loc.className = 'ggs-symbol-hover-loc';
		loc.textContent = `${entry.path}:${entry.line + 1}`;
		if (open) {
			loc.title = t('symbols.hover.openDefinition');
			loc.addEventListener('click', () => open(entry.path, entry.line));
		}
		dom.appendChild(loc);
	}
	return dom;
}

/* ---------- The quick-info hover: every other indexed symbol ---------- */

/** One non-macro definition the quick-info hover lists: its declaration line, the
 *  comment block above it and — for a block-shaped kind — the definition's whole body,
 *  all sliced off the declaring file. */
export interface SymbolQuickInfoEntry {
	kind: string;
	/** Repo-relative, forward slashes — the index's own spelling. */
	path: string;
	/** 0-based declaration line. */
	line: number;
	/** The declaration line's text, or '' when the file could not be read. */
	text: string;
	/** The doc comment above the declaration, or '' when there is none. */
	comment: string;
	/** The definition's whole body through its end line, or '' — a variable, a scalar
	 *  kind, or an index that names no body shows the declaration line only. */
	body: string;
}

/** A hovered name's non-macro answer: the name and up to `QUICK_INFO_MAX_DEFS` entries. */
export interface SymbolQuickInfo {
	name: string;
	entries: SymbolQuickInfoEntry[];
}

const quickInfoCache = new Map<string, { at: number; info: SymbolQuickInfo | null }>();

/** Drop every cached quick-info answer: the tests reset it between cases. */
export function resetQuickInfoCache(): void {
	quickInfoCache.clear();
}

function cacheQuickInfo(key: string, info: SymbolQuickInfo | null): SymbolQuickInfo | null {
	quickInfoCache.delete(key);
	quickInfoCache.set(key, { at: Date.now(), info });
	if (quickInfoCache.size > MACRO_LOOKUP_CACHE_MAX) {
		quickInfoCache.delete(quickInfoCache.keys().next().value!);
	}
	return info;
}

/** Paths compare POSIX-side, case-insensitively — the two spellings of one Windows path. */
function sameFile(a: string, b: string): boolean {
	return a.split('\\').join('/').toLowerCase() === b.split('\\').join('/').toLowerCase();
}

/** What the text around the hovered word says it is. The index lists every same-name
 *  declaration — a local variable and a file-scope function can share one name — so the
 *  hover ranks the kind the site asks for first: `total(` is the function, `struct Point`
 *  names that struct, and everything else at a value position (an assignment, a statement
 *  end, an argument, a comparison) is the variable. Null when the site is undecided — a
 *  bare type name in a declaration, say. */
export function hoverKindHint(line: string, from: number, to: number): string | null {
	const before = line.slice(0, from);
	const after = line.slice(to);
	if (/^\s*\(/.test(after)) return 'function';
	const leading = before.match(/(?:^|[^\w])(struct|enum|class)\s+(?:\w+\s+)?$/);
	if (leading) return leading[1];
	if (/^\s*([+\-*/%&|^=<>!?:;,)\].])/.test(after)) return 'variable';
	return null;
}

/** Whether a definition of `kind` answers a hover site asking for `hint` — a method is
 *  the function of an `obj.m(` site, a class the struct of a `class C` site. */
function hintMatchesKind(kind: string, hint: string): boolean {
	switch (hint) {
		case 'function':
			return kind === 'function' || kind === 'method' || kind === 'constructor';
		case 'struct':
			return kind === 'struct' || kind === 'class' || kind === 'interface';
		case 'enum':
			return kind === 'enum';
		case 'variable':
			// A parameter never reaches the index (it resolves through the scope half or
			// not at all), so it must not rank as a value site's answer here either.
			return kind === 'variable' || kind === 'constant' || kind === 'field' || kind === 'property';
		default:
			return kind === hint;
	}
}

/** The hovered name's non-macro definitions, one entry each — null when the index holds
 *  none (macros answer first, so this is the hover's fallback). The entries rank by what
 *  the hover site is: a definition whose own lines cover the hovered line (hovering the
 *  definition itself), the hovered file's own definitions, and the kind the site's text
 *  asks for (`hoverKindHint`) — so a hovered variable leads over a same-named function.
 *  The rest follow in index order. */
export async function quickInfoFor(source: MacroHoverSource, name: string, currentPath?: string, currentLine?: number, hint?: string | null): Promise<SymbolQuickInfo | null> {
	const root = source.root();
	if (!root) return null;
	const key = `${root}\u0000${name}\u0000${currentPath ?? ''}\u0000${currentLine ?? -1}\u0000${hint ?? ''}`;
	const cached = quickInfoCache.get(key);
	if (cached && Date.now() - cached.at < MACRO_LOOKUP_TTL_MS) return cached.info;
	let defs: WsSymbol[];
	try {
		defs = (await source.lookup(name)).filter((def) => def.kind !== 'macro');
	} catch {
		return null;
	}
	if (currentPath || currentLine !== undefined || hint) {
		const rank = (def: WsSymbol): number => {
			let score = 0;
			const inFile = Boolean(currentPath) && sameFile(joinPath(root, def.path), currentPath!);
			if (inFile) score += 2;
			if (hint && hintMatchesKind(def.kind, hint)) score += 3;
			if (currentLine !== undefined && inFile && def.line <= currentLine && currentLine <= (def.endLine ?? def.line)) score += 4;
			return score;
		};
		defs.sort((a, b) => rank(b) - rank(a));
	}
	defs = defs.slice(0, QUICK_INFO_MAX_DEFS);
	const entries: SymbolQuickInfoEntry[] = [];
	for (const def of defs) {
		let text = '';
		let comment = '';
		let body = '';
		try {
			const contents = await source.read(joinPath(root, def.path));
			if (contents !== null) {
				text = macroValueAt(contents, def.line, def.line);
				comment = precedingComment(contents, def.line);
				if (BODY_KINDS.has(def.kind)) body = symbolBodyAt(contents, def.line, def.endLine);
			}
		} catch {
			text = '';
		}
		entries.push({ kind: def.kind, path: def.path, line: def.line, text, comment, body });
	}
	if (entries.length === 0) return cacheQuickInfo(key, null);
	return cacheQuickInfo(key, { name, entries });
}

/** The scope-local quick info: when the hovered site sits inside a function that
 *  declares the name — one of its parameters or locals — that definition IS the answer,
 *  and a same-named global never appears (2026-11-18, the owner's direction: 局部变量
 *  只显示局部范围的定义). The declaration line is sliced from the passed buffer text —
 *  the editor's own document, so an unsaved edit shows as written and no disk read
 *  happens at all. Null when the site is outside every local's scope, or the source
 *  carries no scope lookup: the caller falls back to the global index answer. */
export async function scopeQuickInfoFor(source: MacroHoverSource, name: string, line: number, text: string, currentPath: string): Promise<SymbolQuickInfo | null> {
	const root = source.root();
	if (!root || !source.scopeLookup) return null;
	const key = `scope\u0000${currentPath}\u0000${text.length}\u0000${line}\u0000${name}`;
	const cached = quickInfoCache.get(key);
	if (cached && Date.now() - cached.at < MACRO_LOOKUP_TTL_MS) return cached.info;
	let defs: ScopeDefinition[];
	try {
		defs = await source.scopeLookup(name, line, text);
	} catch {
		return null;
	}
	if (!defs || defs.length === 0) return cacheQuickInfo(key, null);
	const lines = text.split('\n');
	const entries: SymbolQuickInfoEntry[] = defs.slice(0, QUICK_INFO_MAX_DEFS).map((def) => {
		const at = Math.min(Math.max(0, def.line), lines.length - 1);
		return {
			kind: def.kind,
			// The definitions are this file's own; the location click rides the same
			// open the index entries use — a same-file reveal at the declaration.
			path: relativeTo(root, currentPath),
			line: def.line,
			text: (lines[at] ?? '').trim(),
			comment: precedingComment(text, def.line),
			body: '',
		};
	});
	return cacheQuickInfo(key, { name, entries });
}

/** The quick-info tooltip: kind, name, then one entry per definition — its doc comment
 *  (when there is one), its body whole (a block-shaped kind; the pane scrolls) or its
 *  declaration line, and its location, clickable when `open` is wired (the location
 *  rides the same open the workbench's jump uses). */
export function quickInfoDom(info: SymbolQuickInfo, open?: (path: string, line: number) => void): HTMLElement {
	const dom = document.createElement('div');
	dom.className = 'ggs-symbol-hover ggs-quick-info';
	const head = document.createElement('div');
	head.className = 'ggs-symbol-hover-head';
	head.textContent = info.entries.length > 1 ? `${info.name} — ${info.entries.length} ${t('symbols.hover.definitions')}` : info.name;
	dom.appendChild(head);
	for (const entry of info.entries) {
		if (entry.comment) {
			const comment = document.createElement('pre');
			comment.className = 'ggs-symbol-hover-comment';
			comment.textContent = entry.comment;
			dom.appendChild(comment);
		}
		if (entry.body || entry.text) {
			// A body carries its own signature line, so the declaration pre drops out —
			// the same text must not show twice.
			const code = document.createElement('pre');
			code.className = entry.body ? 'ggs-symbol-hover-code ggs-symbol-hover-body' : 'ggs-symbol-hover-code';
			code.textContent = entry.body || entry.text;
			dom.appendChild(code);
		}
		const loc = open ? document.createElement('button') : document.createElement('div');
		loc.className = 'ggs-symbol-hover-loc';
		loc.textContent = `${entry.path}:${entry.line + 1}`;
		if (open) {
			loc.title = t('symbols.hover.openDefinition');
			loc.addEventListener('click', () => open(entry.path, entry.line));
		}
		dom.appendChild(loc);
	}
	return dom;
}

/* ---------- The sticky hover: reaching the tooltip must not dismiss it ---------- */

/** How far the tooltip's keep-alive zone reaches: down/up covers CodeMirror's own
 *  tooltip margin (4px) plus the adjacent line the pointer crosses on its way, the
 *  sideways reach stays narrow so a move to a neighbouring word escapes it and re-hovers
 *  instead of pinning a stale tooltip. */
const HOVER_REACH_Y = 26;
const HOVER_REACH_X = 14;

/** The tooltip's own DOM must be reachable. CodeMirror's hover plugin hides its tooltip
 *  the moment a mousemove lands off the hovered range — which every pointer travel to
 *  the tooltip is, the 4px gap between the hovered line and the tooltip alone maps off
 *  the range. The guard runs on view.dom's CAPTURE phase, ahead of the plugin's bubble
 *  listener: while one of this workbench's hover tooltips stands, a no-button mousemove
 *  inside its keep-alive zone never reaches the plugin, so the pointer can travel onto
 *  the tooltip and work it (scroll the body, click a location) without it dismissing.
 *  A drag (buttons ≠ 0) passes through — selection must keep working — and a move out
 *  of the zone flows again, dismissing as before. */
export function hoverKeepAliveExtension(): Extension {
	return ViewPlugin.fromClass(
		class {
			readonly #view: EditorView;
			#onMove = (event: MouseEvent): void => {
				if (event.buttons !== 0) return;
				const tip = this.#view.dom.querySelector<HTMLElement>('.cm-tooltip .ggs-symbol-hover, .cm-tooltip .ggs-ext-hover');
				if (!tip) return;
				// The keep-alive zone reads the tooltip HOST's geometry — the wrapper CodeMirror
				// positions (arrow, padding and all), the same element its own in-tooltip check
				// measures, not the content pane inside it.
				const host = tip.closest<HTMLElement>('.cm-tooltip') ?? tip;
				const r = host.getBoundingClientRect();
				if (event.clientX < r.left - HOVER_REACH_X || event.clientX > r.right + HOVER_REACH_X) return;
				if (event.clientY < r.top - HOVER_REACH_Y || event.clientY > r.bottom + HOVER_REACH_Y) return;
				event.stopPropagation();
			};
			constructor(view: EditorView) {
				this.#view = view;
				view.dom.addEventListener('mousemove', this.#onMove, true);
			}
			destroy(): void {
				this.#view.dom.removeEventListener('mousemove', this.#onMove, true);
			}
		}
	);
}

/** The word under `pos` — the range a hover of that word keeps: a zero-width one
 *  dismisses on the first move off the exact spot. Null when the pointer is not on an
 *  identifier. */
export function wordRangeAt(view: EditorView, pos: number): { from: number; to: number } | null {
	return view.state.wordAt(pos);
}

/** The workbench's own hover (CLion's quick info, over the symbol index): a hovered
 *  `#define` lists every indexed definition's directive text, a hovered function /
 *  struct / enum / class shows its whole definition body, and any other indexed symbol
 *  shows its declaration line with the comment above it. A second tooltip source beside
 *  the extension providers' — both may answer, CodeMirror stacks them. Definitions of
 *  the hovered file's own symbol lead the list; each location opens the definition on
 *  click when `open` is wired. The keep-alive guard rides along, so the tooltip is
 *  reachable and stays while it is worked. */
export function symbolHoverExtension(source: MacroHoverSource): Extension[] {
	const open = source.open
		? (path: string, line: number): void => {
				const root = source.root();
				if (root) source.open!(joinPath(root, path), line);
			}
		: undefined;
	return [
		hoverTooltip(async (view, pos) => {
			const range = wordRangeAt(view, pos);
			if (!range) return null;
			const name = view.state.sliceDoc(range.from, range.to);
			const macroEntries = await macroHoverEntries(source, name);
			if (macroEntries.length > 0) {
				return {
					pos: range.from,
					end: range.to,
					create: (): TooltipView => ({ dom: macroHoverDom(name, macroEntries, open) })
				};
			}
			const hoverLine = view.state.doc.lineAt(range.from);
			const currentPath = view.state.facet(pathSlot);
			// The scope answer first: a name declared inside the hovered function is that
			// local or parameter — the global index never gets asked, so a same-named
			// function in another scope cannot outrank it.
			const scopeInfo = await scopeQuickInfoFor(source, name, hoverLine.number - 1, view.state.doc.toString(), currentPath);
			if (scopeInfo) {
				return {
					pos: range.from,
					end: range.to,
					create: (): TooltipView => ({ dom: quickInfoDom(scopeInfo, open) })
				};
			}
			const hint = hoverKindHint(hoverLine.text, range.from - hoverLine.from, range.to - hoverLine.from);
			const info = await quickInfoFor(source, name, currentPath, hoverLine.number - 1, hint);
			if (!info) return null;
			return {
				pos: range.from,
				end: range.to,
				create: (): TooltipView => ({ dom: quickInfoDom(info, open) })
			};
		}, { hoverTime: 350 }),
		hoverKeepAliveExtension()
	];
}
