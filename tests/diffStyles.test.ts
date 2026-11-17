// The diff view's decoration classes (`diffView.ts` paints the backend hunks with them)
// are styled by shell.css in the VS Code diff palette — inserted/removed line backgrounds,
// the unified layout's deleted-line block rows, the unchanged-gap pill and the revert
// arrows' column. This pins the styling exists for both layouts and that no rule paints an
// underline over a diff line (VS Code's diff never underlines; an early merge-view theme
// did, and a leftover would come back silently).

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'workbench', 'shell.css'), 'utf8');

const DIFF_CLASSES = ['cm-diff-ins', 'cm-diff-del', 'cm-diff-del-block', 'cm-diff-del-row', 'cm-diff-unchanged', 'cm-diff-spacer-row', 'cm-merge-revert'];

/** Every comma-separated selector of every rule in the stylesheet (comments stripped). */
function selectors(): string[] {
	const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
	const out: string[] = [];
	for (const match of stripped.matchAll(/([^{}]+)\{[^{}]*\}/g)) {
		for (const selector of match[1]!.split(',')) {
			const trimmed = selector.trim();
			if (trimmed && !trimmed.startsWith('@')) out.push(trimmed);
		}
	}
	return out;
}

/** The rule body a selector opens (from its `{` to the next `}` — the diff rules are all
 *  single-declaration-block rules, which is all this test reads). */
function ruleBody(selector: string): string {
	const at = css.indexOf(selector);
	const open = css.indexOf('{', at);
	return css.slice(open + 1, css.indexOf('}', open));
}

describe('diff decoration styles', () => {
	it('every decoration class the view paints is styled', () => {
		const styled = selectors();
		const missing = DIFF_CLASSES.filter((cls) => !styled.some((selector) => selector.includes(`.${cls}`)));
		expect(missing).toEqual([]);
	});

	it('changed lines wear the VS Code diff palette in both layouts', () => {
		expect(css).toMatch(/\.cm-diff-ins\s*\{[^}]*--vscode-diffEditor-insertedLineBackground/);
		expect(css).toMatch(/\.cm-diff-del\s*\{[^}]*--vscode-diffEditor-removedLineBackground/);
		expect(css).toMatch(/\.cm-diff-del-row\s*\{[^}]*--vscode-diffEditor-removedTextBackground/);
	});

	it('removed lines dim their text to the theme\u2019s diff foreground', () => {
		// The owner's direction: the bright red and its bright text pulled the eye to the old
		// code — the removed side's text dims to --vscode-diffEditor-removedTextForeground,
		// forced past the syntax spans so a removed line greys out whole and recedes.
		const del = ruleBody('.editor-pane .cm-diff-del');
		expect(del).toMatch(/--vscode-diffEditor-removedTextForeground/);
		expect(del).toMatch(/!\s*important/);
		expect(ruleBody('.editor-pane .cm-diff-del-row')).toMatch(/--vscode-diffEditor-removedTextForeground/);
		// Every shipped theme defines the token — an undefined one would leave the removed
		// side at full brightness on that theme.
		const themes = ['dark-plus', 'dark-modern', 'hc-black', 'light-modern', 'nord', 'monokai'];
		for (const theme of themes) {
			const themeCss = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'static', 'theme', `${theme}.css`), 'utf8');
			expect(themeCss, theme).toMatch(/--vscode-diffEditor-removedTextForeground:\s*#/);
		}
	});

	it('no diff line carries an underline or strikethrough', () => {
		for (const cls of ['cm-diff-ins', 'cm-diff-del', 'cm-diff-del-row']) {
			const selector = selectors().find((s) => s.includes(`.${cls}`))!;
			expect(ruleBody(selector)).not.toMatch(/text-decoration:\s*(?!none)/);
		}
	});

	it('the alignment filler row is one scroller line tall, hatched as not-content', () => {
		// The split layout pads the shorter pane with these rows so the identical code
		// after a hunk stays side by side; a row any taller or shorter than a .cm-line
		// (the scroller pins line-height: 19px) would drift the panes apart by the
		// difference per padded row.
		const rule = /(?:^|[,{}])\s*\.cm-merge-view \.cm-diff-spacer-row\s*\{([^}]*)\}/m.exec(css.replace(/\/\*[\s\S]*?\*\//g, ''))?.[1] ?? '';
		expect(rule).toMatch(/height:\s*19px/);
		expect(rule).toMatch(/--vscode-diffEditor-diagonalFill/);
	});

	it('the inline diff editor keeps its pane width — the find widget never lands outside the window', () => {
		// Single-column diff: the lone .cm-editor sits directly in .cm-merge-view's row flex,
		// and without min-width: 0 CodeMirror's content minimum (a `pre` line, no shrink)
		// widens it past the pane — the find widget anchored to its right edge is then
		// clipped by the window. Split mode needs nothing: each pane's wrapper hides overflow.
		expect(selectors()).toContain('.editor-pane .cm-merge-view > .cm-editor');
		expect(css).toMatch(/\.editor-pane \.cm-merge-view > \.cm-editor\s*\{[^}]*min-width:\s*0/);
	});

	it('the merge container never scrolls — no ghost scrollbar at the diff\u2019s far right', () => {
		// The panes scroll themselves; the container's overflow-y: auto once let the revert
		// arrows' document-offset tops (thousands of px in a tall file) stretch its
		// scrollable range into a third scrollbar at the diff's right edge.
		expect(css).toMatch(/\.cm-merge-view \.cm-mergeView\s*\{[^}]*overflow:\s*hidden/);
		expect(css).toMatch(/\.cm-merge-view \.cm-merge-revert\s*\{[^}]*overflow:\s*hidden/);
	});

	it('the revert-arrow strip starts below the pane\u2019s side header', () => {
		// The strip overlays the modified pane's wrapper (its containing block), whose first
		// child is the side header; the buttons' tops are document coordinates measured from
		// the EDITOR's top edge. A strip starting at the wrapper's own top renders every
		// arrow the header's height above its hunk — the first hunk's arrow painting over
		// the header itself — so the strip's `top` must equal the header's `height`.
		const stripTop = /top:\s*(\d+)px/.exec(ruleBody('.cm-merge-view .cm-merge-revert'))?.[1];
		const headerHeight = /height:\s*(\d+)px/.exec(ruleBody('.diff-side-header'))?.[1];
		expect(stripTop).toBeDefined();
		expect(stripTop).toBe(headerHeight);
	});

	it('the split layout\u2019s pane row is a flex row of 50/50 columns', () => {
		// @codemirror/merge's style module owned these structural rules and left the tree
		// with it; without them the wrappers stack as blocks and their editors (flex-basis
		// 0, min-height 0) collapse to zero height — headers over a blank diff.
		const plain = css.replace(/\/\*[\s\S]*?\*\//g, '');
		expect(plain).toMatch(/\.cm-merge-view > \.cm-mergeView > \.cm-mergeViewEditors\s*\{[^}]*display:\s*flex/);
		const wrapper = /(?:^|[,{}])\s*\.cm-merge-view > \.cm-mergeView > \.cm-mergeViewEditors > \.cm-mergeViewEditor\s*\{([^}]*)\}/m.exec(plain)?.[1] ?? '';
		expect(wrapper).toMatch(/flex:\s*1 1 0/);
		expect(wrapper).toMatch(/min-width:\s*0/);
		expect(wrapper).toMatch(/overflow:\s*hidden/);
		expect(wrapper).toMatch(/flex-direction:\s*column/);
	});

	it('the sash owns the pane junction — above its pointer-cursor neighbours, with a wider grab strip', () => {
		// The base pane's overview ruler and the revert arrows' column sit flush against the
		// sash (both z-index 6, the wrappers are no stacking contexts) with pointer cursors:
		// a mouse aimed at the bar landed on them — hand cursor, and the drag never started.
		// The sash must sit above both, and its own 4px is too narrow a target: an ::after
		// extends its hit area 6px into each pane so everything near the line drags.
		const sash = ruleBody('.cm-merge-view .cm-mergeViewEditors .cm-diff-sash');
		expect(sash).toMatch(/z-index:\s*7/);
		const grab = ruleBody('.cm-merge-view .cm-mergeViewEditors .cm-diff-sash::after');
		expect(grab).toMatch(/left:\s*-6px/);
		expect(grab).toMatch(/right:\s*-6px/);
		// The neighbours the strip must outrank, at their z-index 6.
		expect(ruleBody('.cm-overview-ruler')).toMatch(/z-index:\s*6/);
		expect(ruleBody('.cm-merge-view .cm-merge-revert')).toMatch(/z-index:\s*6/);
		// The revert column starts beside the strip (left: 6px), and its empty stretches
		// pass the mouse through — only the arrows themselves take a press.
		expect(ruleBody('.cm-merge-view .cm-merge-revert')).toMatch(/left:\s*6px/);
		expect(ruleBody('.cm-merge-view .cm-merge-revert')).toMatch(/pointer-events:\s*none/);
		// The button rule read here is the positioned one (a shorter .cm-merge-revert
		// button rule earlier in the sheet styles colours only).
		const buttonRule = css.match(/\.cm-merge-revert button \{([^}]*position:\s*absolute[^}]*)\}/)?.[1] ?? '';
		expect(buttonRule).toMatch(/pointer-events:\s*auto/);
	});
});
