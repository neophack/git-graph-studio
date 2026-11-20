// The hover card's rendering half: the quick-info tooltip's DOM — its head, the
// per-definition entries (kind tag, doc comment, declaration line or whole body, the
// type's members, clickable location), the definitions-overflow line and the
// reference-count footer — split from the data assembly in editorProviderViews, so the
// card and the data can move separately. The optional fields (members, totals, reference
// counts) are answered by the data half when it can and degrade to absent here.
import { t, tf } from '../../platform/i18n';
import { el, icon } from '../../platform/ui/index';
import { hoverRelationsOpener } from './hoverRelations';

/** One member row a type entry's card lists (the container-intern scan's answer). */
export interface HoverMember {
	kind: string;
	name: string;
	/** 0-based declaration line. */
	line: number;
}

/** One definition the hover card shows: its kind, its declaration line's text, the
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
	/** The members declared inside this entry (a type's fields and methods), when the
	 *  data half resolved them — absent on failure, on non-type kinds, and on the
	 *  scope-local answers. */
	members?: HoverMember[];
}

/** A hovered name's non-macro answer: the name and up to `QUICK_INFO_MAX_DEFS` entries.
 *  The optional totals ride along when the data half knows more than it shows: `total`
 *  counts the definitions past the rendered cap, `refFiles` the files whose text
 *  contains the name. */
export interface SymbolQuickInfo {
	name: string;
	entries: SymbolQuickInfoEntry[];
	/** The name's definition count past the rendered entries, when greater. */
	total?: number;
	/** How many files the index sees the name in. */
	refFiles?: number;
}

/** What the card can act on: a definition jump (the location rows) and, later, the
 *  relations window's opener (the card reads the module-level opener itself). */
export interface HoverCardActions {
	open?: (path: string, line: number) => void;
}

/** The codicon for a member row's kind — the same spellings the Context Window's symbol
 *  rows use; an unknown kind falls back to the variable glyph. */
const KIND_ICONS: Record<string, string> = {
	function: 'symbol-method',
	method: 'symbol-method',
	class: 'symbol-class',
	struct: 'symbol-struct',
	interface: 'symbol-interface',
	enum: 'symbol-enum',
	module: 'symbol-module',
	type: 'symbol-type-parameter'
};

/** The kind tag's text: the raw kind's word with its first letter capitalised, the
 *  category view's convention. An empty kind answers '' — no tag is drawn. */
function kindLabel(kind: string): string {
	return kind ? kind.charAt(0).toUpperCase() + kind.slice(1) : '';
}

/** A type entry's members block: the section header, then one row per member — its kind's
 *  icon, its name and its 1-based line at the row's far end. The rows jump to the member's
 *  declaration when `open` is wired (the same open the location rows ride); without it
 *  they render static. */
function membersDom(entry: SymbolQuickInfoEntry, open?: HoverCardActions['open']): HTMLElement {
	const block = el('div', 'ggs-symbol-hover-members');
	block.appendChild(el('div', 'ggs-symbol-hover-members-head', [t('symbols.hover.members')]));
	for (const member of entry.members ?? []) {
		const row = el(open ? 'button' : 'div', 'ggs-symbol-hover-member', [
			icon(KIND_ICONS[member.kind] ?? 'symbol-variable', 'ggs-symbol-hover-member-icon'),
			el('span', 'ggs-symbol-hover-member-name', [member.name]),
			el('span', 'ggs-symbol-hover-member-line', [String(member.line + 1)])
		]);
		if (open) {
			row.addEventListener('click', () => open(entry.path, member.line + 1));
		}
		block.appendChild(row);
	}
	return block;
}

/** The quick-info tooltip: kind, name, then one entry per definition — its kind tag, its
 *  doc comment (when there is one), its body whole (a block-shaped kind; the pane scrolls)
 *  or its declaration line, the type's members (when the data half resolved them), and its
 *  location, clickable when `open` is wired (the location rides the same open the
 *  workbench's jump uses). Past the rendered entries an overflow line names the rest, and
 *  a footer names the files that reference the name, with the relations window's opener
 *  (static when no opener is registered). */
export function quickInfoDom(info: SymbolQuickInfo, actions?: HoverCardActions): HTMLElement {
	const open = actions?.open;
	const dom = document.createElement('div');
	dom.className = 'ggs-symbol-hover ggs-quick-info';
	const head = document.createElement('div');
	head.className = 'ggs-symbol-hover-head';
	head.textContent = info.entries.length > 1 ? `${info.name} — ${info.entries.length} ${t('symbols.hover.definitions')}` : info.name;
	dom.appendChild(head);
	for (const entry of info.entries) {
		const entryDom = document.createElement('div');
		entryDom.className = 'ggs-symbol-hover-entry';
		const kind = kindLabel(entry.kind);
		if (kind) {
			entryDom.appendChild(el('span', 'ggs-symbol-hover-kind', [kind]));
		}
		if (entry.comment) {
			const comment = document.createElement('pre');
			comment.className = 'ggs-symbol-hover-comment';
			comment.textContent = entry.comment;
			entryDom.appendChild(comment);
		}
		if (entry.body || entry.text) {
			// A body carries its own signature line, so the declaration pre drops out —
			// the same text must not show twice.
			const code = document.createElement('pre');
			code.className = entry.body ? 'ggs-symbol-hover-code ggs-symbol-hover-body' : 'ggs-symbol-hover-code';
			code.textContent = entry.body || entry.text;
			entryDom.appendChild(code);
		}
		if (entry.members && entry.members.length > 0) {
			entryDom.appendChild(membersDom(entry, open));
		}
		const loc = open ? document.createElement('button') : document.createElement('div');
		loc.className = 'ggs-symbol-hover-loc';
		loc.textContent = `${entry.path}:${entry.line + 1}`;
		if (open) {
			loc.title = t('symbols.hover.openDefinition');
			loc.addEventListener('click', () => open(entry.path, entry.line));
		}
		entryDom.appendChild(loc);
		dom.appendChild(entryDom);
	}
	if (info.total !== undefined && info.total > info.entries.length) {
		dom.appendChild(el('div', 'ggs-symbol-hover-more', [tf('symbols.hover.moreDefinitions', info.total - info.entries.length)]));
	}
	if (info.refFiles !== undefined) {
		const footer = el('div', 'ggs-symbol-hover-footer', [el('span', 'ggs-symbol-hover-refs', [tf('symbols.hover.references', info.refFiles)])]);
		// The relations button speaks to the opener the workbench registered; a window
		// that never registered (a bare page) renders the row static instead.
		const first = info.entries[0];
		if (first) {
			const opener = hoverRelationsOpener();
			const relations = el(opener ? 'button' : 'div', 'ggs-symbol-hover-relations', [t('symbols.hover.openRelations')]);
			if (opener) {
				relations.addEventListener('click', () => opener({ kind: first.kind, name: info.name, path: first.path, line: first.line }));
			}
			footer.appendChild(relations);
		}
		dom.appendChild(footer);
	}
	return dom;
}
