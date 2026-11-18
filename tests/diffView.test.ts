// The split diff's pane alignment: a hunk whose sides differ in line count pads the
// shorter pane with blank spacer rows, so the identical code after every hunk sits side
// by side and both panes scroll over the same range (the panes' scroll sync mirrors
// equal pixel offsets and presumes it). This pins the padding over every hunk shape the
// backend answers — resized modification, insertion, git's top-of-file `@@ -0,0`
// spelling, deletion — and that the unchanged-gap pill folds the same lines on both
// panes (an empty side's anchor must not steal a line into the wrong gap).
//
// The inline character marks: a paired line's spans (the backend's character-level
// diff of the line against its twin) paint over exactly the differing characters in
// both panes and the unified layout's deleted block — a one-character edit shows as
// that character, the way VS Code's word-diff reads.

import { afterEach, describe, expect, it } from 'vitest';
import { EditorView } from '@codemirror/view';

import { mountTextDiffView, type TextDiffView } from '../src/features/editor/diffView';
import type { DiffHunkData, DiffLineData } from '../src/platform/ipc/scm';

const hunk = (oldStart: number, oldLines: number, newStart: number, newLines: number, lines: DiffLineData[]): DiffHunkData => ({
	oldStart,
	oldLines,
	newStart,
	newLines,
	lines
});

/** Every row a pane renders: its own lines plus the spacer rows padding the hunks. */
function rows(view: EditorView): number {
	let n = 0;
	for (const child of Array.from(view.dom.querySelectorAll('.cm-content > *'))) {
		if (child.classList.contains('cm-line')) n++;
		else if (child.classList.contains('cm-diff-spacer')) n += child.children.length;
	}
	return n;
}

const spacers = (view: EditorView | null): number =>
	view === null ? 0 : view.dom.querySelectorAll('.cm-diff-spacer-row').length;

describe('the split diff pane alignment (SpacerWidget)', () => {
	const mounted: TextDiffView[] = [];
	const mount = (leftDoc: string, rightDoc: string, hunks: DiffHunkData[], collapse = false): TextDiffView => {
		const host = document.createElement('div');
		document.body.appendChild(host);
		const handle = mountTextDiffView(host, { split: true, leftDoc, rightDoc, hunks, collapse, aExtensions: [], bExtensions: [] });
		mounted.push(handle);
		return handle;
	};

	afterEach(() => {
		for (const handle of mounted.splice(0)) handle.destroy();
	});

	it('a resized hunk (3 old lines → 1 new) pads the modified pane so the rows below realign', () => {
		const diff = mount('a\nx1\nx2\nx3\nb\nc', 'a\ny\nb\nc', [
			hunk(2, 3, 2, 1, [
				{ kind: 'deleted', text: 'x1' },
				{ kind: 'deleted', text: 'x2' },
				{ kind: 'deleted', text: 'x3' },
				{ kind: 'added', text: 'y' }
			])
		]);
		expect(diff.a).not.toBeNull();
		expect(diff.b).not.toBeNull();
		// The base side is the longer one and pads nothing; the modified pane carries two
		// blank rows right after its own last changed line, between `y` and the unchanged
		// `b`, so the unchanged lines sit side by side again.
		expect(spacers(diff.a)).toBe(0);
		expect(rows(diff.a!)).toBe(rows(diff.b!));
		const content = diff.b!.dom.querySelector('.cm-content')!;
		const children = Array.from(content.children);
		const spacer = children.find((child) => child.classList.contains('cm-diff-spacer'));
		expect(spacer).not.toBeUndefined();
		expect(children.indexOf(spacer!)).toBe(2); // after `a` and `y`, before `b`
		expect(spacer!.children.length).toBe(2);
	});

	it('a pure insertion pads the base pane at the line the change sits after', () => {
		const diff = mount('a\nb', 'a\nB1\nB2\nB3\nb', [hunk(1, 0, 2, 3, [{ kind: 'added', text: 'B1' }, { kind: 'added', text: 'B2' }, { kind: 'added', text: 'B3' }])]);
		expect(spacers(diff.b)).toBe(0);
		expect(rows(diff.a!)).toBe(rows(diff.b!));
		const children = Array.from(diff.a!.dom.querySelector('.cm-content')!.children);
		const spacer = children.find((child) => child.classList.contains('cm-diff-spacer'))!;
		// Between `a` and `b` — the insertion's place — three blank rows.
		expect(children.indexOf(spacer)).toBe(1);
		expect(spacer.children.length).toBe(3);
	});

	it('git\u2019s top-of-file spelling (`@@ -0,0`) pads above the first line, not after it', () => {
		// The backend answers oldStart 0 for an insertion before line 1; an anchor clamped
		// to line 1's own start would pad one row late and steal the first line into the
		// wrong gap.
		const diff = mount('top\nbottom', 'N1\nN2\nN3\ntop\nbottom', [hunk(0, 0, 1, 3, [{ kind: 'added', text: 'N1' }, { kind: 'added', text: 'N2' }, { kind: 'added', text: 'N3' }])]);
		expect(rows(diff.a!)).toBe(rows(diff.b!));
		const children = Array.from(diff.a!.dom.querySelector('.cm-content')!.children);
		expect(children[0]!.classList.contains('cm-diff-spacer')).toBe(true);
		expect(children[0]!.children.length).toBe(3);
	});

	it('a pure deletion pads the modified pane', () => {
		const diff = mount('a\nD1\nD2\nb', 'a\nb', [hunk(2, 2, 1, 0, [{ kind: 'deleted', text: 'D1' }, { kind: 'deleted', text: 'D2' }])]);
		expect(spacers(diff.a)).toBe(0);
		expect(rows(diff.a!)).toBe(rows(diff.b!));
		const children = Array.from(diff.b!.dom.querySelector('.cm-content')!.children);
		const spacer = children.find((child) => child.classList.contains('cm-diff-spacer'))!;
		expect(children.indexOf(spacer)).toBe(1);
		expect(spacer.children.length).toBe(2);
	});

	it('the unchanged pill folds the same lines on both panes beside a top insertion', () => {
		// The head line `top` belongs to no hunk on either side; the base side's anchor (the
		// raw 0) must keep it in the same gap partition as the modified side's, or the two
		// pills would hide different lines and the panes would end one row apart.
		const unchanged = Array.from({ length: 12 }, (_v, i) => `u${i + 1}`);
		const left = ['top', ...unchanged].join('\n');
		const right = ['N1', 'N2', 'top', ...unchanged].join('\n');
		const diff = mount(left, right, [hunk(0, 0, 1, 2, [{ kind: 'added', text: 'N1' }, { kind: 'added', text: 'N2' }])], true);
		const pillA = diff.a!.dom.querySelector('.cm-diff-unchanged');
		const pillB = diff.b!.dom.querySelector('.cm-diff-unchanged');
		expect(pillA).not.toBeNull();
		expect(pillB).not.toBeNull();
		expect(pillA!.textContent).toBe(pillB!.textContent);
		expect(rows(diff.a!)).toBe(rows(diff.b!));
	});

	it('identical documents pad nothing', () => {
		const same = 'one\ntwo\nthree\n';
		const diff = mount(same, same, []);
		expect(spacers(diff.a)).toBe(0);
		expect(spacers(diff.b)).toBe(0);
		expect(rows(diff.a!)).toBe(rows(diff.b!));
	});

	it('destroy leaves the host empty even with several children (the host children are a live collection)', () => {
		// A host that outlives the diff (the folder compare's detail slot) keeps no shell
		// behind — and removing inside a `for..of` over the live `host.children` skips
		// every other child, so the loop must read firstChild instead.
		const diff = mount('a\nb', 'a\nc', [hunk(2, 1, 2, 1, [{ kind: 'deleted', text: 'b' }, { kind: 'added', text: 'c' }])]);
		const host = diff.a!.dom.closest('.cm-mergeView')!.parentElement!;
		host.appendChild(document.createElement('div')); // a stray sibling of the view's root
		mounted.splice(mounted.indexOf(diff), 1); // this test destroys it itself
		diff.destroy();
		expect(host.children.length).toBe(0);
		host.remove();
	});
});

describe('the inline character marks (the backend\u2019s per-line spans)', () => {
	const mounted: TextDiffView[] = [];
	const mount = (split: boolean, leftDoc: string, rightDoc: string, hunks: DiffHunkData[]): TextDiffView => {
		const host = document.createElement('div');
		document.body.appendChild(host);
		const handle = mountTextDiffView(host, { split, leftDoc, rightDoc, hunks, collapse: false, aExtensions: [], bExtensions: [] });
		mounted.push(handle);
		return handle;
	};

	afterEach(() => {
		for (const handle of mounted.splice(0)) handle.destroy();
	});

	it('a paired one-character edit marks exactly that character on both panes', () => {
		const diff = mount(true, 'let value = 1;\n', 'let value = 2;\n', [
			hunk(1, 1, 1, 1, [
				{ kind: 'deleted', text: 'let value = 1;', spans: [{ start: 12, end: 13 }] },
				{ kind: 'added', text: 'let value = 2;', spans: [{ start: 12, end: 13 }] }
			])
		]);
		expect(diff.a!.dom.querySelector('.cm-diff-char-del')!.textContent).toBe('1');
		expect(diff.b!.dom.querySelector('.cm-diff-char-ins')!.textContent).toBe('2');
		// One mark per pane — the rest of the line carries no inline wash.
		expect(diff.a!.dom.querySelectorAll('.cm-diff-char-del')).toHaveLength(1);
		expect(diff.b!.dom.querySelectorAll('.cm-diff-char-ins')).toHaveLength(1);
	});

	it('a line without spans paints no inline marks', () => {
		const diff = mount(true, 'a\nb', 'a\nc', [hunk(2, 1, 2, 1, [{ kind: 'deleted', text: 'b' }, { kind: 'added', text: 'c' }])]);
		expect(diff.a!.dom.querySelector('.cm-diff-char-del')).toBeNull();
		expect(diff.b!.dom.querySelector('.cm-diff-char-ins')).toBeNull();
	});

	it('a span past what the pane\u2019s line holds clamps into the line, never outside it', () => {
		// The spans answer the backend's pair; until the next answer lands an edit may
		// have shortened the line under them. The mark may shrink but never cross the
		// line's end (a mark crossing a line break would break CodeMirror's drawing).
		const diff = mount(true, 'ab\n', 'axb\n', [
			hunk(1, 1, 1, 1, [
				{ kind: 'deleted', text: 'ab', spans: [{ start: 1, end: 99 }] },
				{ kind: 'added', text: 'axb', spans: [{ start: 1, end: 2 }] }
			])
		]);
		expect(diff.a!.dom.querySelector('.cm-diff-char-del')!.textContent).toBe('b');
	});

	it('the unified layout segments the deleted block\u2019s rows by the same spans', () => {
		const diff = mount(false, 'x = 1;\nb', 'x = 2;\nb', [
			hunk(1, 1, 1, 1, [
				{ kind: 'deleted', text: 'x = 1;', spans: [{ start: 4, end: 5 }] },
				{ kind: 'added', text: 'x = 2;', spans: [{ start: 4, end: 5 }] }
			])
		]);
		const row = diff.b!.dom.querySelector('.cm-diff-del-row')!;
		expect(row).not.toBeNull();
		// The row reads whole as `x = 1;` with only the `1` wrapped in the char mark.
		expect(row.textContent).toBe('x = 1;');
		expect(row.querySelector('.cm-diff-char-del')!.textContent).toBe('1');
		// And the editor side marks its own twin the same way.
		expect(diff.b!.dom.querySelector('.cm-content .cm-diff-char-ins')!.textContent).toBe('2');
	});

	it('setDiff repaints the widget when only the spans changed', () => {
		// The widget's eq compares the spans too — same texts with different highlights
		// must re-render, or a fresh backend answer would keep the old segmentation.
		const diff = mount(false, 'x = 1;\nb', 'x = 2;\nb', [
			hunk(1, 1, 1, 1, [
				{ kind: 'deleted', text: 'x = 1;', spans: [{ start: 0, end: 1 }] },
				{ kind: 'added', text: 'x = 2;', spans: [{ start: 0, end: 1 }] }
			])
		]);
		expect(diff.b!.dom.querySelector('.cm-diff-del-row .cm-diff-char-del')!.textContent).toBe('x');
		diff.setDiff([
			hunk(1, 1, 1, 1, [
				{ kind: 'deleted', text: 'x = 1;', spans: [{ start: 4, end: 6 }] },
				{ kind: 'added', text: 'x = 2;', spans: [{ start: 5, end: 6 }] }
			])
		]);
		expect(diff.b!.dom.querySelector('.cm-diff-del-row .cm-diff-char-del')!.textContent).toBe('1;');
	});
});
