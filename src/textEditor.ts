// The text editor widget: everything of CodeMirror the editor group needs, in one module that
// is loaded on the first file (or diff) open rather than with the workbench - so the 400 KB of
// CodeMirror core sits in an async chunk (vite.config.ts) and never delays the first frame.
// `editor.ts` reaches it through `lazy.ts`'s `loadTextEditor()` and keeps the loaded module
// around; `folderCompare.ts` does the same for its read-only panes.

import { Compartment, EditorSelection, EditorState, type Extension, type StateCommand } from '@codemirror/state';
import { EditorView, gutter, GutterMarker, keymap, type Command, type KeyBinding, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, highlightSpecialChars, rectangularSelection, crosshairCursor, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab, redo, selectAll, selectLine, undo } from '@codemirror/commands';
import { closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
import { searchKeymap, highlightSelectionMatches, search, openSearchPanel, selectSelectionMatches } from '@codemirror/search';
import { bracketMatching, foldGutter, foldKeymap, indentOnInput, indentUnit } from '@codemirror/language';
import { languages } from '@codemirror/language-data';

import { completionExtension } from './autocomplete';
import { hasBookmark } from './bookmarks';
import { bracketColorsExtension, minimapExtension, stickyScrollExtension } from './editorExtras';
import { createFindPanel, openReplacePanel } from './findWidget';
import { vscodeHighlighting } from './cmTheme';
import { settings } from './settings';
import { icon } from './ui';

export { EditorState, EditorView, keymap, openSearchPanel, openReplacePanel, redo, selectAll, undo, completionExtension };
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

/** The search keys, minus Ctrl+G: VS Code's Ctrl+G is Go to Line (the workbench's command,
 *  which only runs when the editor leaves the key alone); F3 / Shift+F3 stay find next/previous. */
const findKeymap = searchKeymap.filter((binding) => binding.key !== 'Mod-g');

/** The VS Code editing keys CodeMirror does not ship. */
const vscodeKeymap: KeyBinding[] = [
	{ key: 'Mod-h', run: openReplacePanel },
	{ key: 'Shift-Mod-Enter', run: insertBlankLineAbove },
	{ key: 'Mod-l', run: selectLine, preventDefault: true },
	{ key: 'Mod-F2', run: changeAllOccurrences, preventDefault: true }
];

/** The tab-size setting is both the indent unit Tab inserts and the width a tab character
 *  renders at: a file indented with real tabs must line up with the setting too. */
function indentSettings(): Extension {
	return [indentUnit.of(' '.repeat(settings.tabSize)), EditorState.tabSize.of(settings.tabSize)];
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

export function baseExtensions(readOnly: boolean): Extension[] {
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
		keymap.of([...vscodeKeymap, ...editingKeymap, ...closeBracketsKeymap, ...completionKeymap, ...findKeymap, ...historyKeymap, ...foldKeymap, indentWithTab]),
		// The M3 3.2 decorations belong to the editable editor: diff and revision panes stay lean.
		// Every text surface scrolls past its end: the last line parks at the viewport's top.
		pastEndExtension(),
		...(readOnly ? [] : [bracketColorsExtension(), stickyScrollExtension(), minimapExtension()]),
		vscodeHighlighting,
		EditorState.readOnly.of(readOnly),
		EditorView.editable.of(!readOnly)
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

/** Read-only extensions for a comparison pane that is never edited or navigated. */
export function readOnlyExtensions(): Extension[] {
	return [EditorState.readOnly.of(true), EditorView.editable.of(false), pastEndExtension()];
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
