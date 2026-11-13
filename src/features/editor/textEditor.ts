// The text editor widget: everything of CodeMirror the editor group needs, in one module that
// is loaded on the first file (or diff) open rather than with the workbench - so the 400 KB of
// CodeMirror core sits in an async chunk (vite.config.ts) and never delays the first frame.
// `editor.ts` reaches it through `lazy.ts`'s `loadTextEditor()` and keeps the loaded module
// around; `folderCompare.ts` does the same for its read-only panes.

import { Compartment, EditorSelection, EditorState, Transaction, type Extension, type StateCommand } from '@codemirror/state';
import { EditorView, gutter, GutterMarker, keymap, type Command, type KeyBinding, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, highlightSpecialChars, rectangularSelection, crosshairCursor, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import { addCursorAbove, addCursorBelow, copyLineDown, copyLineUp, cursorMatchingBracket, defaultKeymap, deleteLine, deleteTrailingWhitespace, history, historyKeymap, indentWithTab, moveLineDown, moveLineUp, redo, selectAll, selectLine, undo } from '@codemirror/commands';
import { closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
import { searchKeymap, highlightSelectionMatches, search, openSearchPanel, selectSelectionMatches } from '@codemirror/search';
import { bracketMatching, foldGutter, foldKeymap, indentOnInput, indentUnit } from '@codemirror/language';
import { languages } from '@codemirror/language-data';

import { completionExtension } from './autocomplete';
import { commentKeymapFor } from './comments';
import { hasBookmark } from './bookmarks';
import { expandSelection, shrinkSelection } from './expandSelection';
import { bracketColorsExtension, minimapExtension, stickyScrollExtension, wheelExtension } from './editorExtras';
import { createFindPanel, openReplacePanel } from './findWidget';
import { vscodeHighlighting } from './cmTheme';
import { settings } from '../../platform/settings';
import { icon } from '../../platform/ui/index';

export { EditorState, EditorView, keymap, openSearchPanel, openReplacePanel, redo, selectAll, undo, completionExtension, expandSelection, shrinkSelection };
export { addCursorAbove, addCursorBelow, copyLineDown, copyLineUp, cursorMatchingBracket, deleteLine, moveLineDown, moveLineUp };
// The diff overview ruler rides the text-editor chunk: compare modules (merge toolbar,
// folder compare) reach it through this module (lazy.ts), never across module files (R2).
export { attachOverviewRuler, chunkOverviewMarks, type OverviewMark } from './editorExtras';

/** The phone's read-only open's reconfigure point (src/remote/editLock.ts): the locked
 *  configuration is editor state, lifted and restored in place by the app bar's lock toggle. */
export const editLockSlot = new Compartment();

/** The locked configuration: user input, the touch keyboard and paste are all refused
 *  while selection and copy keep working (`state.readOnly` also gates the commands that
 *  check it; `editable: false` takes the content out of contenteditable). */
export function editLockedExtensions(): Extension[] {
	return [EditorState.readOnly.of(true), EditorView.editable.of(false)];
}
export type { Extension };

/** The extensions every text surface shares: VS Code-like gutters, selection, search,
 *  folding, bracket matching, the keymaps, and the highlighting theme. The indent unit and
 *  word wrap ride in compartments so the settings can reconfigure open editors in place. */
export const indentSlot = new Compartment();
export const wrapSlot = new Compartment();

/** VS Code's Ctrl+Shift+Enter: a blank line above the cursor's line, indented like it. */
const insertBlankLineAbove: StateCommand = ({ state, dispatch }) => {
	if (state.readOnly) return false;
	const changes = state.changeByRange((range) => {
		const line = state.doc.lineAt(range.from);
		const indent = /^\s*/.exec(line.text)?.[0] ?? '';
		return {
			changes: { from: line.from, insert: indent + state.lineBreak },
			range: EditorSelection.cursor(line.from + indent.length)
		};
	});
	dispatch(state.update(changes, { scrollIntoView: true, userEvent: 'input' }));
	return true;
};

/** VS Code's Change All Occurrences (Ctrl+F2): a cursor on every occurrence of the selected
 *  text - or, with nothing selected, of the word under the cursor. */
export const changeAllOccurrences: Command = (view) => {
	if (view.state.selection.main.empty) {
		const word = view.state.wordAt(view.state.selection.main.head);
		if (!word) return false;
		view.dispatch({ selection: { anchor: word.from, head: word.to } });
	}
	return selectSelectionMatches(view);
};

/** CodeMirror's default editing keys, minus the ones VS Code spells differently: Alt+Left /
 *  Alt+Right are the workbench's Go Back / Go Forward (CodeMirror moves by syntax there, and
 *  both would run on one keystroke), and Alt+L is not VS Code's line selection (Ctrl+L is). */
const editingKeymap = defaultKeymap.filter((binding) => !['Alt-ArrowLeft', 'Alt-ArrowRight', 'Alt-l'].includes(binding.key ?? ''));

/** The merged line span of every selection that spans more than one line, plus the cursor's
 *  own line paired with its successor — the spans Join Lines collapses, merged where the
 *  selections' line ranges overlap (CodeMirror's changes must not). */
function joinSpans(state: EditorState): { first: number; last: number }[] {
	const spans: { first: number; last: number }[] = [];
	for (const range of state.selection.ranges) {
		const first = state.doc.lineAt(range.from).number;
		const lastTouched = state.doc.lineAt(range.to).number;
		// A bare cursor joins its line with the next; a spanning selection joins all its lines.
		const last = !range.empty && lastTouched > first ? lastTouched : first + 1;
		if (last > state.doc.lines) continue; // the document's last line joins nothing
		// The phantom line a trailing newline creates (empty, at the very end) joins
		// nothing either — the join would only eat the document's final newline.
		if (last === state.doc.lines && state.doc.line(last).length === 0) continue;
		const previous = spans[spans.length - 1];
		if (previous && first <= previous.last) {
			previous.last = Math.max(previous.last, last);
			continue;
		}
		spans.push({ first, last });
	}
	return spans;
}

/** The text lines `first..last` join into: VS Code's semantics — one space at each seam,
 *  each joined line's trailing whitespace and leading indentation gone. Empty lines
 *  contribute no seam ("a" joined with "" and "b" reads "a b"), and a join whose every
 *  follower is empty just eats their newlines. Returns the insert and the cursor's offset
 *  from the span start (the first seam, clamped to the text). */
function joinedSpan(state: EditorState, first: number, last: number): { insert: string; seam: number } {
	const lines: string[] = [];
	for (let n = first; n <= last; n++) lines.push(state.doc.line(n).text);
	const head = lines[0]!.replace(/\s+$/, '');
	const insert = [head, ...lines.slice(1).map((line) => line.trim()).filter((text) => text !== '')].join(' ');
	return { insert, seam: Math.min(head.length + 1, insert.length) };
}

/** VS Code's Join Lines: the cursor's line joins the next one (every line of a multi-line
 *  selection joins together), correct under multiple selections, one undo step (a single
 *  transaction). Ctrl+J toggles the panel here, so the command is palette-only. */
export const joinLines: Command = (view) => {
	if (view.state.readOnly) return false;
	const spans = joinSpans(view.state);
	if (spans.length === 0) return false;
	const changes: { from: number; to: number; insert: string }[] = [];
	const cursors: number[] = [];
	let shift = 0;
	for (const span of spans) {
		const first = view.state.doc.line(span.first);
		const last = view.state.doc.line(span.last);
		const { insert, seam } = joinedSpan(view.state, span.first, span.last);
		changes.push({ from: first.from, to: last.to, insert });
		// Every change sits before the next cursor, so the shift it causes accumulates.
		cursors.push(first.from + seam + shift);
		shift += insert.length - (last.to - first.from);
	}
	if (changes.length === 0) return false;
	view.dispatch({
		changes,
		selection: EditorSelection.create(cursors.map((anchor) => EditorSelection.cursor(anchor))),
		scrollIntoView: true,
		userEvent: 'input.join'
	});
	return true;
};

/** VS Code's Sort Lines: every selection spanning more than one line sorts its lines
 *  (stable, so equal lines keep their order); a lone cursor or a single-line selection
 *  sorts nothing, which is the command's disabled state. One transaction for everything. */
export const sortLines = (direction: 1 | -1): Command => (view) => {
	if (view.state.readOnly) return false;
	const state = view.state;
	const spans: { first: number; last: number }[] = [];
	for (const range of state.selection.ranges) {
		if (range.empty) continue;
		const first = state.doc.lineAt(range.from).number;
		const last = state.doc.lineAt(range.to).number;
		if (last === first) continue;
		const previous = spans[spans.length - 1];
		if (previous && first <= previous.last) {
			previous.last = Math.max(previous.last, last);
			continue;
		}
		spans.push({ first, last });
	}
	if (spans.length === 0) return false;
	const changes = spans.map((span) => {
		const lines = [];
		for (let n = span.first; n <= span.last; n++) lines.push({ text: state.doc.line(n).text, at: n });
		// `at` keeps the sort stable — a reversed comparator alone would reverse equal lines.
		lines.sort((a, b) => (direction * (a.text < b.text ? -1 : a.text > b.text ? 1 : 0)) || a.at - b.at);
		const from = state.doc.line(span.first).from;
		const to = state.doc.line(span.last).to;
		return { from, to, insert: lines.map((line) => line.text).join(state.lineBreak) };
	});
	// The selection rides along: CodeMirror maps it through the permutation itself.
	view.dispatch({ changes, scrollIntoView: true, userEvent: 'input.sort' });
	return true;
};

/** VS Code's Title Case: the first letter of every whitespace-delimited word capitalized,
 *  the rest lowered — "hello WORLD" becomes "Hello World". */
function toTitleCase(text: string): string {
	return text.replace(/[^\s]+/g, (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());
}

/** VS Code's case transforms: every non-empty selection is rewritten in place (empty
 *  cursors are left alone, and with none selected the command refuses, like VS Code's
 *  disabled palette rows). One transaction, so one undo step undoes all selections. */
export const transformSelection = (mode: 'upper' | 'lower' | 'title'): Command => (view) => {
	if (view.state.readOnly) return false;
	const transform = mode === 'upper' ? (text: string) => text.toUpperCase() : mode === 'lower' ? (text: string) => text.toLowerCase() : toTitleCase;
	const changes: { from: number; to: number; insert: string }[] = [];
	for (const range of view.state.selection.ranges) {
		if (range.empty) continue;
		const text = view.state.sliceDoc(range.from, range.to);
		const insert = transform(text);
		if (insert !== text) changes.push({ from: range.from, to: range.to, insert });
	}
	if (changes.length === 0) return false;
	// Same-length (upper/lower) or mapped automatically — the selections keep covering
	// their rewritten text either way.
	view.dispatch({ changes, scrollIntoView: true, userEvent: 'input.transform' });
	return true;
};

/** VS Code's Trim Trailing Whitespace: CodeMirror's own whole-document pass (every line's
 *  trailing spaces and tabs gone, one undo step, whitespace-only lines emptied entirely). */
export const trimTrailingWhitespace: Command = (view) => deleteTrailingWhitespace(view);

/** VS Code's Duplicate Selection: every selection's text copies in place right after itself,
 *  the duplicate selected (a bare cursor duplicates its whole line below and lands on the
 *  same column of the copy, VS Code's editor.action.duplicateSelection). A last line without
 *  a trailing newline gains one, so the copy is a line of its own there too. Multiple
 *  selections ride one transaction, so one undo step takes them all back. */
export const duplicateSelection: Command = (view) => {
	if (view.state.readOnly) return false;
	const state = view.state;
	const result = state.changeByRange((range) => {
		if (range.empty) {
			const line = state.doc.lineAt(range.head);
			// The copy goes below the line: past its newline where one follows; the last line
			// without a trailing break inserts its own, or the copy would share its line.
			const trailing = line.to < state.doc.length;
			const insert = trailing ? line.text + state.lineBreak : state.lineBreak + line.text;
			return {
				changes: { from: trailing ? line.to + 1 : line.to, insert },
				range: EditorSelection.cursor(range.head + insert.length)
			};
		}
		const text = state.sliceDoc(range.from, range.to);
		return {
			changes: { from: range.to, insert: text },
			range: EditorSelection.range(range.from + text.length, range.to + text.length)
		};
	});
	view.dispatch(state.update(result, { scrollIntoView: true, userEvent: 'input.duplicate' }));
	return true;
};

/** The search keys, minus Ctrl+G: VS Code's Ctrl+G is Go to Line (the workbench's command,
 *  which only runs when the editor leaves the key alone); F3 / Shift+F3 stay find next/previous. */
const findKeymap = searchKeymap.filter((binding) => binding.key !== 'Mod-g');

/** The VS Code editing keys CodeMirror does not ship. The expand/shrink entries stop
 *  propagation: their keys are ALSO registry keybindings (the palette rows), and a handled
 *  key that bubbles to the workbench's keydown runs the command a second time — a comment
 *  toggle survives its double run (toggle + untoggle), a selection ladder would climb two
 *  tiers per press. The line-motion family (move / copy / delete line, go to bracket, the
 *  add-cursor pair) stops propagation for the same reason — a moved line moved twice is a
 *  different document. */
const vscodeKeymap: KeyBinding[] = [
	{ key: 'Mod-h', run: openReplacePanel },
	{ key: 'Shift-Mod-Enter', run: insertBlankLineAbove },
	{ key: 'Mod-l', run: selectLine, preventDefault: true },
	{ key: 'Mod-F2', run: changeAllOccurrences, preventDefault: true },
	{ key: 'Shift-Alt-ArrowRight', run: expandSelection, preventDefault: true, stopPropagation: true },
	{ key: 'Shift-Alt-ArrowLeft', run: shrinkSelection, preventDefault: true, stopPropagation: true },
	{ key: 'Alt-ArrowUp', run: moveLineUp, preventDefault: true, stopPropagation: true },
	{ key: 'Alt-ArrowDown', run: moveLineDown, preventDefault: true, stopPropagation: true },
	{ key: 'Shift-Alt-ArrowUp', run: copyLineUp, preventDefault: true, stopPropagation: true },
	{ key: 'Shift-Alt-ArrowDown', run: copyLineDown, preventDefault: true, stopPropagation: true },
	{ key: 'Shift-Mod-k', run: deleteLine, preventDefault: true, stopPropagation: true },
	{ key: 'Shift-Mod-\\', run: cursorMatchingBracket, preventDefault: true, stopPropagation: true },
	{ key: 'Mod-Alt-ArrowUp', run: addCursorAbove, preventDefault: true, stopPropagation: true },
	{ key: 'Mod-Alt-ArrowDown', run: addCursorBelow, preventDefault: true, stopPropagation: true }
];

/** The tab-size setting is both the indent unit Tab inserts and the width a tab character
 *  renders at: a file indented with real tabs must line up with the setting too. */
function indentSettings(): Extension {
	return [indentUnit.of(' '.repeat(settings.tabSize)), EditorState.tabSize.of(settings.tabSize)];
}

/** VS Code's comment keys (Ctrl+/, Shift+Alt+A) against a file's comment tokens. */
function commentBindings(path: string): KeyBinding[] {
	const comment = commentKeymapFor(() => path);
	return [
		{ key: 'Mod-/', run: comment.line, preventDefault: true },
		{ key: 'Shift-Alt-a', run: comment.block, preventDefault: true }
	];
}

/** Sets the content's underhang for the editors' scroll-past-the-end: a page (minus a
 *  line) of padding under the last line, so the scrollbar's bottom puts the file's final
 *  line at the top of the view and the page below it stays blank. Re-applied on every
 *  geometry change, so it follows the window size.
 */
export function pastEndPadding(view: EditorView): void {
	const pad = Math.max(0, view.scrollDOM.clientHeight - view.defaultLineHeight);
	const current = parseFloat(view.contentDOM.style.paddingBottom || '0');
	if (Math.abs(current - pad) > 0.5) view.contentDOM.style.paddingBottom = `${pad}px`;
}

function pastEndExtension(): Extension {
	return ViewPlugin.fromClass(class {
		constructor(view: EditorView) { pastEndPadding(view); }
		update(update: ViewUpdate) { pastEndPadding(update.view); }
	});
}

export function baseExtensions(readOnly: boolean, path = ''): Extension[] {
	return [
		lineNumbers(),
		highlightActiveLineGutter(),
		highlightSpecialChars(),
		history(),
		foldGutter({ markerDOM: (open) => icon(open ? 'chevron-down' : 'chevron-right') }),
		drawSelection(),
		EditorState.allowMultipleSelections.of(true),
		indentOnInput(),
		indentSlot.of(indentSettings()),
		wrapSlot.of(settings.wordWrap ? EditorView.lineWrapping : []),
		bracketMatching(),
		rectangularSelection(),
		crosshairCursor(),
		highlightActiveLine(),
		highlightSelectionMatches(),
		// The M3 3.4 find/replace widget replaces CodeMirror's default panel; the search
		// keymap (Ctrl+F, Enter/F3) keeps driving it.
		search({ top: true, createPanel: createFindPanel }),
		// Every text surface scrolls past its end: the last line parks at the viewport's top.
		pastEndExtension(),
		keymap.of([...commentBindings(path), ...vscodeKeymap, ...editingKeymap, ...closeBracketsKeymap, ...completionKeymap, ...findKeymap, ...historyKeymap, ...foldKeymap, indentWithTab]),
		// The M3 3.2 decorations belong to the editable editor: diff and revision panes stay
		// lean. The wheel is not a decoration — every surface that scrolls file content gets
		// Zed's, read-only panes included.
		wheelExtension(),
		...(readOnly ? [] : [bracketColorsExtension(), stickyScrollExtension(), minimapExtension()]),
		vscodeHighlighting,
		// Read-only stays VS Code's read-only editor: the content DOM keeps its focusability
		// (`editable: false` would drop it, and no key — Ctrl+C, Ctrl+F — would ever reach
		// the pane again); `readOnly` alone refuses every input, paste, drop and edit command.
		EditorState.readOnly.of(readOnly)
	];
}

/** Re-apply the tab-size and word-wrap settings to an open editor (the settings panel calls
 *  this for every view on a change). Merge views pass their two sides separately. */
export function reconfigureEditorSettings(view: EditorView): void {
	view.dispatch({
		effects: [
			indentSlot.reconfigure(indentSettings()),
			wrapSlot.reconfigure(settings.wordWrap ? EditorView.lineWrapping : [])
		]
	});
}

/** Read-only extensions for a comparison pane that is browsed and copied but never edited.
 *  The pane keeps VS Code's read-only-editor behaviour (focusable, navigable, the keys
 *  work; `readOnly` refuses the input itself), and the wheel glide rides along: a
 *  comparison is browsed exactly like the file it came from. */
export function readOnlyExtensions(): Extension[] {
	return [EditorState.readOnly.of(true), pastEndExtension(), wheelExtension()];
}

/* ---------- The bookmark gutter ---------- */

const bookmarkMarker = new (class extends GutterMarker {
	element(): HTMLElement {
		return icon('bookmark');
	}
})();

/** A gutter of bookmark marks for one file: lines whose number is bookmarked show a mark. The
 *  click-to-toggle lives in the editor group (a mousedown on the gutter resolves the line
 *  from the click position). */
export function bookmarkGutter(path: string): Extension {
	return gutter({
		class: 'cm-bookmark-gutter',
		lineMarker(view, line) {
			return path !== '' && hasBookmark(path, view.state.doc.lineAt(line.from).number) ? bookmarkMarker : null;
		},
		initialSpacer: () => bookmarkMarker
	});
}

/* ---------- Blame ---------- */

/** The blame gutter rides in a compartment so it can be switched on and off per editor. */
export const blameSlot = new Compartment();

/** A gutter showing who last changed each line ("Ada, 3 days ago"), the commit's subject as
 *  the tooltip; `labels` is indexed by 0-based line. */
export function blameGutter(labels: { label: string; title: string }[]): Extension {
	class BlameMarker extends GutterMarker {
		constructor(private readonly text: string, private readonly tip: string) { super(); }
		override eq(other: BlameMarker): boolean { return other.text === this.text; }
		override toDOM(): HTMLElement {
			const span = document.createElement('span');
			span.className = 'cm-blame-line';
			span.textContent = this.text;
			span.title = this.tip;
			return span;
		}
	}
	const markers = labels.map((l) => new BlameMarker(l.label, l.title));
	return gutter({
		class: 'cm-blame-gutter',
		lineMarker(view, line) {
			return markers[view.state.doc.lineAt(line.from).number - 1] ?? null;
		}
	});
}

/* ---------- Languages ---------- */

const languageCache = new Map<string, Promise<{ name: string; support: Extension } | null>>();

/** The language support rides in a compartment so an editor paints immediately and its syntax
 *  highlighting (a dynamic import that can take longer than the read itself) arrives in place. */
export const languageSlot = new Compartment();

/** The CodeMirror language for a file name (loaded on first use, cached by extension). */
export async function loadLanguage(name: string): Promise<{ name: string; support: Extension } | null> {
	const description = languages.find((l) => l.filename?.test(name)) ?? matchByExtension(name);
	if (!description) return null;
	let pending = languageCache.get(description.name);
	if (!pending) {
		pending = description.load().then((support) => ({ name: description.name, support }), () => null);
		languageCache.set(description.name, pending);
	}
	return pending;
}

function matchByExtension(name: string) {
	const dot = name.lastIndexOf('.');
	if (dot === -1) return null;
	const ext = name.slice(dot + 1).toLowerCase();
	return languages.find((l) => l.extensions.includes(ext)) ?? null;
}

/** Move the cursor to a 1-based line / column, scroll it to the centre and focus the view. */
export function revealPosition(view: EditorView, line: number, column: number): void {
	const target = view.state.doc.line(Math.max(1, Math.min(line, view.state.doc.lines)));
	const pos = Math.min(target.from + Math.max(0, column - 1), target.to);
	view.dispatch({
		selection: { anchor: pos },
		effects: EditorView.scrollIntoView(pos, { y: 'center' })
	});
	view.focus();
}

/** The position of a 1-based line / 0-based column in `text`, clamped to the line and to the
 *  text's end: a selection set in the same transaction as a whole-document replace is spelled
 *  in the new text's coordinates, not mapped. */
function posAtLineColumn(text: string, line: number, column: number): number {
	let at = 0;
	for (let n = 1; n < line; n++) {
		const next = text.indexOf('\n', at);
		if (next === -1) return text.length;
		at = next + 1;
	}
	const end = text.indexOf('\n', at);
	return Math.min(at + column, end === -1 ? text.length : end);
}

/** The 1-based line at the viewport's top edge, probed against the scroller's own bounds (the
 *  sticky scroll's measurement); without a layout (jsdom, a hidden pane) the viewport's first
 *  line stands in. */
function topVisibleLine(view: EditorView): number {
	try {
		const rect = view.scrollDOM.getBoundingClientRect();
		const at = view.posAtCoords({ x: rect.left + rect.width / 2, y: rect.top + 2 });
		if (at !== null) return view.state.doc.lineAt(at).number;
	} catch {
		// No layout to probe: the viewport's head is the best anchor available.
	}
	return view.state.doc.lineAt(view.viewport.from).number;
}

/** Swap the whole document - an external change, a redecode in another encoding - without
 * losing the reader's place. CodeMirror maps a viewport inside a replaced range to the
 * range's edge, so a bare whole-document replace parks both the scroll and the cursor at
 * the file head on every reload (a watcher burst, a refocus). The cursor's line/column and
 * the top visible line carry over instead, clamped to the new text. */
export function replaceDocument(view: EditorView, contents: string): void {
	const state = view.state;
	const head = state.selection.main.head;
	const cursorLine = state.doc.lineAt(head);
	const column = head - cursorLine.from;
	const topLine = topVisibleLine(view);
	// The document's own line ending is LF - CodeMirror normalises CRLF and CR on insert -
	// so every position below is computed against the same normalised text, or each CRLF
	// line start would land one character late (a drift that grows with the line number).
	const text = contents.replace(/\r\n?/g, '\n');
	// The replace is not the reader's edit: a silent reload (the watcher's), a redecode in
	// another encoding and the conflict bar's "use the disk version" must not enter the
	// undo stack — Ctrl+Z over one would resurrect the stale text as dirty and Ctrl+S
	// write it back. `addToHistory: false` still maps the history's positions through the
	// replace (the history field keeps the change descriptor), so every earlier undo step
	// keeps pointing where its text now sits.
	view.dispatch({
		changes: { from: 0, to: state.doc.length, insert: text },
		annotations: Transaction.addToHistory.of(false)
	});
	// The restore runs as its own follow-up transaction: a `scrollIntoView` effect rides
	// through its transaction's changes, and a whole-document replace maps any interior
	// position onto the replaced range's edge - these coordinates must not be mapped.
	view.dispatch({
		selection: { anchor: posAtLineColumn(text, cursorLine.number, column) },
		effects: EditorView.scrollIntoView(posAtLineColumn(text, topLine, 0), { y: 'start', yMargin: 0 })
	});
}
