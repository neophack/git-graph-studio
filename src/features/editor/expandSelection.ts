// VS Code's Expand / Shrink Selection (Shift+Alt+Right / Shift+Alt+Left): every selection
// grows up a fallback ladder of scopes — the word under it, the inside of the enclosing
// bracket pair, the pair including its brackets, the surrounding indentation block — and
// Shrink walks back down the exact path Expand came, remembered per view. Both commands
// take every selection at once in a single transaction, like the rest of the editor's
// selection vocabulary. Self-contained on purpose: no parser, no new dependency — the
// ladder is character-level, which is what the fallback tiers promise.

import { EditorSelection, type EditorState } from '@codemirror/state';
import { type Command, type EditorView } from '@codemirror/view';

interface Span {
	from: number;
	to: number;
}

/** The remembered expansion paths: one selection snapshot per Expand press, popped by
 *  Shrink. A document edit invalidates a stack (the stored positions would land elsewhere),
 *  spotted cheaply through the document length the snapshots were taken at. */
const stacks = new WeakMap<EditorView, { length: number; selections: EditorSelection }[]>();

const PAIRS: Record<string, string> = { '(': ')', '[': ']', '{': '}' };

/** The nearest bracket pair whose opener sits before `from` and whose closer sits at or
 *  after `to`, scanning outward with depth counts so nested pairs are skipped. Brackets
 *  inside strings and comments count too — the ladder is a fallback, not a parse. */
function enclosingPair(state: EditorState, from: number, to: number): Span | null {
	const doc = state.doc;
	let depth = 0;
	let open = -1;
	for (let pos = from - 1; pos >= 0; pos--) {
		const ch = state.sliceDoc(pos, pos + 1);
		if (ch === ')' || ch === ']' || ch === '}') depth++;
		else if (PAIRS[ch] !== undefined) {
			if (depth === 0) {
				open = pos;
				break;
			}
			depth--;
		}
	}
	if (open < 0) return null;
	const closer = PAIRS[state.sliceDoc(open, open + 1)]!;
	const opener = state.sliceDoc(open, open + 1);
	depth = 0;
	for (let pos = Math.max(to, open + 1); pos < doc.length; pos++) {
		const ch = state.sliceDoc(pos, pos + 1);
		if (ch === opener) depth++;
		else if (ch === closer) {
			if (depth === 0) return { from: open, to: pos + 1 };
			depth--;
		}
	}
	return null;
}

/** The block of lines the anchor's indentation belongs to: up and down from the anchor
 *  across every non-blank line at least as indented (the blank lines between them belong
 *  to the block), stopping at the first less-indented non-blank line. Blanks past the
 *  block's edge — the trailing phantom line a final newline gives CodeMirror included —
 *  are never taken. Whole lines, the ladder's widest tier. A blank anchor borrows the
 *  nearest non-blank line's indentation. */
function indentBlock(state: EditorState, from: number, to: number): Span | null {
	const doc = state.doc;
	const anchor = doc.lineAt(from);
	const indentOf = (text: string): number => {
		const match = /^[ \t]*/.exec(text);
		return text.trim() === '' ? -1 : (match?.[0].length ?? 0);
	};
	const nextNonBlank = (from: number, step: 1 | -1): { number: number; indent: number } | null => {
		for (let n = from; n >= 1 && n <= doc.lines; n += step) {
			const found = indentOf(doc.line(n).text);
			if (found !== -1) return { number: n, indent: found };
		}
		return null;
	};
	let indent = indentOf(anchor.text);
	if (indent === -1) indent = nextNonBlank(anchor.number - 1, -1)?.indent ?? nextNonBlank(anchor.number + 1, 1)?.indent ?? 0;
	let first = anchor.number;
	for (;;) {
		const above = nextNonBlank(first - 1, -1);
		if (!above || above.indent < indent) break;
		first = above.number;
	}
	let last = anchor.number;
	for (;;) {
		const below = nextNonBlank(last + 1, 1);
		if (!below || below.indent < indent) break;
		last = below.number;
	}
	return { from: doc.line(first).from, to: doc.line(last).to };
}

/** The smallest span of the ladder that strictly contains `range`: the word at it (while
 *  the range is not already that word), the inside of the enclosing bracket pair, the pair
 *  with its brackets, then the indentation block. `null` when the range already covers the
 *  widest tier — the key does nothing, as VS Code's does at the top. */
function nextSpan(state: EditorState, range: Span): Span | null {
	const word = state.wordAt(range.from);
	const candidates: (Span | null)[] = [];
	if (word && (range.to - range.from === 0 || word.from !== range.from || word.to !== range.to)) candidates.push(word);
	const pair = enclosingPair(state, range.from, range.to);
	if (pair) {
		// Only pairs that actually enclose the range count: the scan can return a pair whose
		// opener is inside the range (a selection ending between a pair's brackets).
		if (pair.from <= range.from && pair.to >= range.to) {
			const content = { from: pair.from + 1, to: pair.to - 1 };
			candidates.push(content);
			candidates.push(pair);
		}
	}
	candidates.push(indentBlock(state, range.from, range.to));
	for (const candidate of candidates) {
		if (!candidate) continue;
		const encloses = candidate.from <= range.from && candidate.to >= range.to;
		const bigger = candidate.from < range.from || candidate.to > range.to;
		if (encloses && bigger) return candidate;
	}
	return null;
}

/** VS Code's Expand Selection: every selection climbs one tier per press, and the whole
 *  selection as it was is remembered for Shrink. Overlapping results (two cursors growing
 *  into the same word) merge into their union, as a selection cannot overlap itself. */
export const expandSelection: Command = (view) => {
	const state = view.state;
	const grown: Span[] = [];
	let changed = false;
	for (const range of state.selection.ranges) {
		const span = nextSpan(state, range) ?? range;
		if (span !== range) changed = true;
		const previous = grown[grown.length - 1];
		if (previous && span.from <= previous.to) previous.to = Math.max(previous.to, span.to);
		else grown.push({ ...span });
	}
	if (!changed) return false;
	const stack = stacks.get(view) ?? [];
	stack.push({ length: state.doc.length, selections: state.selection });
	stacks.set(view, stack);
	view.dispatch({
		selection: EditorSelection.create(grown.map((span) => EditorSelection.range(span.from, span.to))),
		scrollIntoView: true
	});
	return true;
};

/** VS Code's Shrink Selection: pops the last Expand's snapshot and restores it. Without a
 *  remembered path (the view just opened, or edits moved under the stack) a word selection
 *  still collapses to its cursor — the ladder's floor — and anything wider refuses. */
export const shrinkSelection: Command = (view) => {
	const state = view.state;
	const stack = stacks.get(view);
	while (stack && stack.length > 0) {
		const top = stack[stack.length - 1]!;
		stack.pop();
		// A snapshot taken at a different document length is stale (positions moved); walk
		// past it to whatever was remembered before.
		if (top.length !== state.doc.length) continue;
		view.dispatch({ selection: top.selections, scrollIntoView: true });
		return true;
	}
	const collapsed = state.selection.ranges.map((range) => {
		const word = state.wordAt(range.from);
		return word && word.from === range.from && word.to === range.to ? EditorSelection.cursor(range.head) : range;
	});
	if (collapsed.every((range, index) => range === state.selection.ranges[index])) return false;
	view.dispatch({ selection: EditorSelection.create(collapsed), scrollIntoView: true });
	return true;
};
