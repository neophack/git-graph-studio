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

const DIFF_CLASSES = ['cm-diff-ins', 'cm-diff-del', 'cm-diff-del-block', 'cm-diff-del-row', 'cm-diff-unchanged', 'cm-merge-revert'];

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

	it('no diff line carries an underline or strikethrough', () => {
		for (const cls of ['cm-diff-ins', 'cm-diff-del', 'cm-diff-del-row']) {
			const selector = selectors().find((s) => s.includes(`.${cls}`))!;
			expect(ruleBody(selector)).not.toMatch(/text-decoration:\s*(?!none)/);
		}
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
});
