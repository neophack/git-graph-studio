// The text diff view: the backend's git-computed hunks (`scm_diff`, the gix engine)
// painted as line decorations over CodeMirror views — a split of two panes, or the
// unified single editor whose deleted lines ride a block widget above their new
// position. Paired lines carry the backend's character-level spans as inline marks
// (VS Code's word-diff), so a one-character edit highlights that character. The
// frontend never diffs: this module only draws what the backend answered
// and maps it through the user's edits until the next answer lands. A hunk whose sides
// differ in line count pads the shorter pane with blank spacer rows, so the identical
// code after every hunk stays side by side. Unchanged gaps collapse into an "unchanged
// lines" widget the way VS Code's diff does; a click, an edit or the cursor entering
// one expands it again; and an editable modified pane gains VS Code's per-change
// revert arrows.

import { ChangeSet, EditorState, Range, RangeSet, StateEffect, StateField, type Extension, type Text } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, WidgetType } from '@codemirror/view';

import type { DiffHunkData, DiffSpanData } from '../../platform/ipc/scm';
import { el, icon } from '../../platform/ui/index';
import type { TextDiffView } from './types';

/** Unchanged gaps longer than this many lines collapse (VS Code's own threshold band). */
const COLLAPSE_ABOVE = 10;
/** The lines kept visible at each edge of a collapsed gap. */
const COLLAPSE_MARGIN = 3;

const setDiffBase = StateEffect.define<{ marks: DecorationSet; gaps: GapSpan[]; resetExpanded: boolean }>();
const expandGap = StateEffect.define<number>();

/** One unchanged region between two hunks, in this document's positions. `id` is the
 *  gap's ordinal — stable while the hunks stand, so an expansion survives edits. */
interface GapSpan {
	id: number;
	from: number;
	to: number;
	lines: number;
}

interface DiffState {
	/** The hunk marks (and the unified layout's deleted-line blocks), mapped current. */
	marks: DecorationSet;
	gaps: GapSpan[];
	expanded: Set<number>;
	decos: DecorationSet;
}

/** The line's start position, clamped into the document. */
const lineStart = (doc: Text, line: number): number => doc.line(Math.min(Math.max(line, 1), doc.lines)).from;

/** Where an empty side of a hunk sits: git's `@@ -5,0` spells an insertion after line
 *  5, whose position is line 6's start — the document's end when 5 is the last line. */
const anchorAt = (doc: Text, start: number): number => (start + 1 > doc.lines ? doc.length : lineStart(doc, start + 1));

/** The side's span in the document: occupied sides run from their first line's start to
 *  one past the last line's end (the line break included, the copy paths' own shape);
 *  empty sides collapse onto their anchor. The hunk's numbers are clamped into the
 *  document — they answer the pair the backend diffed, and until the next answer lands
 *  an edited or re-read document may have moved out from under them. */
function hunkSpan(doc: Text, hunk: DiffHunkData, side: 'old' | 'new'): { from: number; to: number } {
	const raw = side === 'old' ? hunk.oldStart : hunk.newStart;
	const start = Math.min(Math.max(raw, 1), doc.lines);
	const lines = Math.max(Math.min(side === 'old' ? hunk.oldLines : hunk.newLines, doc.lines - start + 1), 0);
	if (lines === 0) {
		// Git spells a top-of-file change `@@ -0,0` — the anchor is the document's very
		// top, and the clamp to 1 would move it after line 1 (stealing that line into the
		// wrong gap, which would fold the panes' margins onto different rows).
		const at = raw === 0 ? 0 : anchorAt(doc, start);
		return { from: at, to: at };
	}
	const first = doc.line(start);
	const last = doc.line(start + lines - 1);
	return { from: first.from, to: Math.min(last.to + 1, doc.length) };
}

/** One side's hunk marks: every occupied line of every hunk, `cm-diff-del` on the base
 *  pane and `cm-diff-ins` on the modified one — plus, where the backend paired a line
 *  with its twin across the hunk, the inline `cm-diff-char-*` marks over exactly the
 *  characters that differ (VS Code's word-diff: a one-character edit highlights that
 *  character, not a whole-line wash). The span offsets are UTF-16 into the line's own
 *  text — CodeMirror's own coordinate — clamped into the line the pane holds so an
 *  edited document never paints outside it. */
function buildMarks(doc: Text, hunks: readonly DiffHunkData[], side: 'old' | 'new'): DecorationSet {
	const marks: Range<Decoration>[] = [];
	const lineDeco = Decoration.line({ class: side === 'old' ? 'cm-diff-del' : 'cm-diff-ins' });
	const charDeco = Decoration.mark({ class: side === 'old' ? 'cm-diff-char-del' : 'cm-diff-char-ins' });
	for (const hunk of hunks) {
		const start = Math.min(Math.max(side === 'old' ? hunk.oldStart : hunk.newStart, 1), doc.lines);
		const lines = Math.max(Math.min(side === 'old' ? hunk.oldLines : hunk.newLines, doc.lines - start + 1), 0);
		for (let line = start; line < start + lines; line++) {
			marks.push(lineDeco.range(lineStart(doc, line)));
		}
		// The hunk's lines walk the deleted block then the added one; each entry of this
		// pane's side claims the next line number the block spans.
		let index = 0;
		for (const entry of hunk.lines) {
			if ((entry.kind === 'deleted') !== (side === 'old')) continue;
			if (index >= lines) break;
			const line = doc.line(start + index);
			for (const span of entry.spans ?? []) {
				const from = Math.min(Math.max(line.from + span.start, line.from), line.to);
				const to = Math.min(line.from + span.end, line.to);
				if (to > from) marks.push(charDeco.range(from, to));
			}
			index++;
		}
	}
	return RangeSet.of(marks, true);
}

/** The unified layout's deleted-line blocks: one widget per hunk above its new position,
 *  riding inside the marks set so the mapping carries it like any mark. */
function buildDeletedBlocks(doc: Text, hunks: readonly DiffHunkData[]): Range<Decoration>[] {
	const blocks: Range<Decoration>[] = [];
	for (const hunk of hunks) {
		const deleted = hunk.lines.filter((line) => line.kind === 'deleted').map((line) => ({ text: line.text, spans: line.spans }));
		if (deleted.length === 0) continue;
		const at = hunk.newLines > 0 ? lineStart(doc, hunk.newStart) : anchorAt(doc, hunk.newStart);
		blocks.push(Decoration.widget({ widget: new DeletedLinesWidget(deleted), block: true }).range(at));
	}
	return blocks;
}

/** The blank rows a pane pads where its twin's side of a hunk is longer: the shorter
 *  side fills the difference so both panes carry the same row count through the hunk
 *  region and the unchanged lines after it sit side by side again — what
 *  @codemirror/merge's spacers did, and what the panes' scroll sync presumes (equal
 *  pixel offsets). Without them every insertion, deletion or resized hunk left all the
 *  identical code below drifting out of alignment. */
class SpacerWidget extends WidgetType {
	constructor(readonly lines: number) {
		super();
	}

	eq(other: SpacerWidget): boolean {
		return other.lines === this.lines;
	}

	toDOM(): HTMLElement {
		const div = el('div', 'cm-diff-spacer');
		for (let i = 0; i < this.lines; i++) div.appendChild(el('div', 'cm-diff-spacer-row'));
		return div;
	}
}

/** The split layout's alignment fillers: one spacer per hunk whose sides differ in line
 *  count, riding after the shorter side's span — an occupied side's rows sit opposite
 *  its twin's, and an empty side (a pure insertion or deletion) pads at the anchor the
 *  hunk spans. */
function buildSpacers(doc: Text, hunks: readonly DiffHunkData[], side: 'old' | 'new'): Range<Decoration>[] {
	const out: Range<Decoration>[] = [];
	for (const hunk of hunks) {
		const mine = side === 'old' ? hunk.oldLines : hunk.newLines;
		const want = (side === 'old' ? hunk.newLines : hunk.oldLines) - mine;
		if (want <= 0) continue;
		const at = hunkSpan(doc, hunk, side).to;
		out.push(Decoration.widget({ widget: new SpacerWidget(want), block: true }).range(at));
	}
	return out;
}

/** The unchanged gaps between consecutive hunks, each side carrying its own span of the
 *  same logical region. `collapse` counts on the modified side; the base side keeps a
 *  gap only when its twin is collapsing, so both panes fold together. */
function buildGaps(aDoc: Text, bDoc: Text, hunks: readonly DiffHunkData[], collapse: boolean): { a: GapSpan[]; b: GapSpan[] } {
	const spans = (doc: Text, side: 'old' | 'new'): GapSpan[] => {
		const gaps: GapSpan[] = [];
		// k runs over the unchanged regions: before the first hunk, between each pair,
		// and after the last one (VS Code's collapse covers the file's head and tail too).
		for (let k = 0; k <= hunks.length; k++) {
			const from = k === 0 ? 0 : hunkSpan(doc, hunks[k - 1]!, side).to;
			const to = k === hunks.length ? doc.length : hunkSpan(doc, hunks[k]!, side).from;
			if (to <= from) continue;
			const lines = doc.lineAt(Math.max(to - 1, from)).number - doc.lineAt(from).number + 1;
			gaps.push({ id: k - 1, from, to, lines });
		}
		return gaps;
	};
	if (!collapse) return { a: [], b: [] };
	const bGaps = spans(bDoc, 'new').filter((gap) => gap.lines > COLLAPSE_ABOVE);
	const aGaps = spans(aDoc, 'old').filter((gap) => bGaps.some((twin) => twin.id === gap.id));
	return { a: aGaps, b: bGaps };
}

/** The widget an unchanged gap collapses into; a click hands the gap back. */
class UnchangedWidget extends WidgetType {
	constructor(
		readonly count: number,
		readonly id: number,
	) {
		super();
	}

	eq(other: UnchangedWidget): boolean {
		return other.count === this.count && other.id === this.id;
	}

	toDOM(): HTMLElement {
		const button = el('button', 'cm-diff-unchanged', [`\u22EF ${this.count} unchanged lines \u22EF`]);
		button.addEventListener('click', () => {
			const pane = button.closest('.cm-editor');
			const view = pane instanceof HTMLElement ? EditorView.findFromDOM(pane) : null;
			if (view) view.dispatch({ effects: expandGap.of(this.id) });
		});
		return button;
	}
}

/** One deleted row of the unified layout's block: its unchanged runs as plain text and
 *  the differing characters wrapped in the same `cm-diff-char-del` mark the panes
 *  paint — the inline highlight survives the unified layout too. */
function deletedRow(text: string, spans?: readonly DiffSpanData[]): HTMLElement {
	const parts: (string | HTMLElement)[] = [];
	let at = 0;
	for (const span of spans ?? []) {
		// The spans answer the backend's own line text; anything past what this row
		// holds (never expected) is skipped rather than spilling outside the line.
		if (span.start < at || span.end > text.length || span.end <= span.start) continue;
		if (span.start > at) parts.push(text.slice(at, span.start));
		parts.push(el('span', 'cm-diff-char-del', [text.slice(span.start, span.end)]));
		at = span.end;
	}
	parts.push(text.slice(at) || (parts.length === 0 ? '\u200b' : ''));
	return el('div', 'cm-diff-del-row', parts);
}

/** The deleted lines of one hunk, shown above their new position in the unified
 *  layout — the rows themselves styled like deleted lines. */
class DeletedLinesWidget extends WidgetType {
	constructor(
		readonly rows: readonly { text: string; spans?: readonly DiffSpanData[] }[],
	) {
		super();
	}

	get lineBreaks(): number {
		return Math.max(this.rows.length - 1, 0);
	}

	eq(other: DeletedLinesWidget): boolean {
		return (
			this.rows.length === other.rows.length &&
			this.rows.every(
				(row, i) =>
					row.text === other.rows[i]!.text &&
					(row.spans ?? []).length === (other.rows[i]!.spans ?? []).length &&
					(row.spans ?? []).every(
						(span, j) => span.start === other.rows[i]!.spans![j]!.start && span.end === other.rows[i]!.spans![j]!.end,
					),
			)
		);
	}

	toDOM(): HTMLElement {
		return el(
			'div',
			'cm-diff-del-block',
			this.rows.map((row) => deletedRow(row.text, row.spans)),
		);
	}
}

/** The side's full decoration set: the mapped marks, every unexpanded gap long enough
 *  collapsed into its widget. */
function compose(doc: Text, state: { marks: DecorationSet; gaps: GapSpan[]; expanded: Set<number> }): DecorationSet {
	const ranges: Range<Decoration>[] = [];
	state.marks.between(0, doc.length, (from, to, value) => {
		ranges.push(value.range(from, to));
	});
	for (const gap of state.gaps) {
		if (state.expanded.has(gap.id)) continue;
		const firstLine = doc.lineAt(gap.from).number;
		const lastLine = doc.lineAt(Math.max(gap.to - 1, gap.from)).number;
		const hiddenFrom = firstLine + COLLAPSE_MARGIN;
		const hiddenTo = lastLine - COLLAPSE_MARGIN;
		if (hiddenTo < hiddenFrom) continue;
		ranges.push(
			Decoration.replace({ widget: new UnchangedWidget(hiddenTo - hiddenFrom + 1, gap.id), block: true }).range(
				lineStart(doc, hiddenFrom),
				lineStart(doc, hiddenTo + 1),
			),
		);
	}
	return RangeSet.of(ranges, true);
}

const diffField = StateField.define<DiffState>({
	create: () => ({ marks: Decoration.none, gaps: [], expanded: new Set<number>(), decos: Decoration.none }),
	update(value, tr) {
		let marks = value.marks.map(tr.changes);
		let gaps = value.gaps.map((gap) => ({ ...gap, from: tr.changes.mapPos(gap.from), to: tr.changes.mapPos(gap.to) }));
		let expanded = value.expanded;
		for (const effect of tr.effects) {
			if (effect.is(setDiffBase)) {
				marks = effect.value.marks;
				gaps = effect.value.gaps;
				if (effect.value.resetExpanded) expanded = new Set<number>();
			} else if (effect.is(expandGap)) {
				expanded = new Set(expanded);
				expanded.add(effect.value);
			}
		}
		// An edit inside or beside a collapsed gap, or the cursor entering one, hands it
		// back — the lines the user reached must be visible again.
		const reach = tr.docChanged ? touchedRanges(tr.changes) : tr.selection ? [tr.state.selection.main] : [];
		for (const range of reach) {
			for (const gap of gaps) {
				if (!expanded.has(gap.id) && range.from <= gap.to && range.to >= gap.from) {
					expanded = new Set(expanded);
					expanded.add(gap.id);
				}
			}
		}
		return { marks, gaps, expanded, decos: compose(tr.state.doc, { marks, gaps, expanded }) };
	},
});

/** Every post-change position a transaction's edits touched. */
function touchedRanges(changes: ChangeSet): { from: number; to: number }[] {
	const out: { from: number; to: number }[] = [];
	changes.iterChanges((_fromA, _toA, fromB, toB) => out.push({ from: fromB, to: toB }));
	return out;
}

export type { TextDiffView };

export interface TextDiffViewConfig {
	split: boolean;
	leftDoc: string;
	rightDoc: string;
	hunks: readonly DiffHunkData[];
	collapse: boolean;
	/** The base pane's extensions (read-only, language, hover, the diff keys). */
	aExtensions: Extension[];
	/** The modified pane's extensions (its own editability and listeners included). */
	bExtensions: Extension[];
	/** VS Code's per-change revert arrows: their presence builds the arrow overlay on the
	 *  modified pane's left edge (split layout only), one arrow per hunk, each handing its
	 *  index back. */
	revert?: { onRevert: (index: number) => void };
}

export function mountTextDiffView(host: HTMLElement, config: TextDiffViewConfig): TextDiffView {
	const state = (doc: string, extensions: Extension[], cls: string): EditorState =>
		EditorState.create({
			doc,
			extensions: [...extensions, diffField, EditorView.decorations.from(diffField, (value) => value.decos), EditorView.editorAttributes.of({ class: cls })],
		});
	const views: { a: EditorView | null; b: EditorView | null } = { a: null, b: null };
	let hunks = config.hunks;
	let collapse = config.collapse;
	/** The per-change revert column (built only where the config asks and the layout is
	 *  split): one arrow per hunk, rebuilt whenever the hunks change. */
	let revertColumn: HTMLElement | null = null;

	if (config.split) {
		// The wrappers carry the package's own class names, so shell.css's sizing and
		// sash rules keep holding without a fork of the styles.
		const root = el('div', 'cm-mergeView');
		const row = el('div', 'cm-mergeViewEditors');
		const paneA = el('div', 'cm-mergeViewEditor');
		views.a = new EditorView({ state: state(config.leftDoc, config.aExtensions, 'cm-merge-a'), parent: paneA });
		paneA.appendChild(views.a.dom);
		row.appendChild(paneA);
		const paneB = el('div', 'cm-mergeViewEditor');
		views.b = new EditorView({ state: state(config.rightDoc, config.bExtensions, 'cm-merge-b'), parent: paneB });
		paneB.appendChild(views.b.dom);
		row.appendChild(paneB);
		if (config.revert) {
			// The arrows overlay the modified pane's left edge (VS Code's placement) — a
			// dedicated column between the panes spent its width as an empty strip; here the
			// buttons ride over the fold-gutter zone, each with its own background so the
			// chevron beneath never shows through (shell.css positions the wrapper).
			revertColumn = el('div', 'cm-merge-revert');
			paneB.appendChild(revertColumn);
		}
		root.appendChild(row);
		host.appendChild(root);
	} else {
		// The unified editor sits directly in the host (the inline layout's flex rule
		// targets `.cm-merge-view > .cm-editor`).
		views.b = new EditorView({ state: state(config.rightDoc, config.bExtensions, 'cm-merge-b cm-diff-unified'), parent: host });
	}

	/** Repaints one pane: marks (with the unified layout's deleted-line blocks on the
	 *  modified pane), the split layout's alignment spacers and gaps, computed against
	 *  the panes' CURRENT documents so an edit's pending backend answer never re-draws
	 *  from stale geometry. */
	const repaint = (view: EditorView, side: 'old' | 'new', resetExpanded: boolean): void => {
		const mine = view.state.doc;
		const twin = (side === 'old' ? views.b : views.a)?.state.doc ?? mine;
		const marks = RangeSet.of(
			[
				...collectRanges(mine, buildMarks(mine, hunks, side)),
				...(side === 'new' && views.a === null ? buildDeletedBlocks(mine, hunks) : []),
				// The split's two panes pad their shorter sides; the unified editor is alone
				// and needs no alignment.
				...(config.split ? buildSpacers(mine, hunks, side) : []),
			],
			true,
		);
		const gaps = buildGaps(side === 'old' ? mine : twin, side === 'new' ? mine : twin, hunks, collapse);
		view.dispatch({ effects: setDiffBase.of({ marks, gaps: side === 'old' ? gaps.a : gaps.b, resetExpanded }) });
	};
	const refresh = (resetExpanded: boolean): void => {
		if (views.a) repaint(views.a, 'old', resetExpanded);
		if (views.b) repaint(views.b, 'new', resetExpanded);
		if (revertColumn) {
			revertColumn.textContent = '';
			hunks.forEach((_hunk, index) => {
				const button = el('button', '', [icon('arrow-left')]);
				button.title = 'Revert this change';
				button.dataset.chunk = String(index);
				button.addEventListener('click', () => config.revert?.onRevert(index));
				revertColumn!.appendChild(button);
			});
		}
	};
	refresh(true);

	return {
		a: views.a,
		b: views.b,
		get hunks() {
			return hunks;
		},
		setDiff(next) {
			hunks = next;
			refresh(true);
		},
		setCollapse(on) {
			collapse = on;
			refresh(false);
		},
		ranges() {
			const a = views.a?.state.doc;
			const b = views.b?.state.doc;
			return hunks.map((hunk) => {
				const spanA = a ? hunkSpan(a, hunk, 'old') : { from: 0, to: 0 };
				const spanB = b ? hunkSpan(b, hunk, 'new') : { from: 0, to: 0 };
				return { fromA: spanA.from, toA: spanA.to, fromB: spanB.from, toB: spanB.to };
			});
		},
		destroy() {
			views.a?.destroy();
			views.b?.destroy();
			views.a = null;
			views.b = null;
			// The frame the view built leaves with it (a host that outlives the diff —
			// the folder compare's detail slot — keeps no empty shell behind). children is
			// a LIVE collection: removing inside a for..of over it skips every other
			// child, so the loop reads firstChild instead.
			while (host.firstChild) host.firstChild.remove();
		},
	};
}

/** Flatten a decoration set into ranges (compose feeds RangeSet.of with everything). */
function collectRanges(doc: Text, set: DecorationSet): Range<Decoration>[] {
	const out: Range<Decoration>[] = [];
	set.between(0, doc.length, (from, to, value) => {
		out.push(value.range(from, to));
	});
	return out;
}
