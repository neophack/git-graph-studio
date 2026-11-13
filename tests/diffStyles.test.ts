// The diff colours in shell.css only apply if they outweigh @codemirror/merge's base theme,
// whose selectors (`.<theme>.cm-merge-b .cm-changedText`, `.<theme> .cm-deletedChunk
// .cm-deletedText`) carry three classes and paint a 2px gradient underline under changed
// words. A bare `.cm-changedText { background: ... }` loses that cascade silently and the
// underline reappears - the split view's right editor shipped that way once. This pins every
// shell.css rule that styles a diff decoration to at least four classes of specificity.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'workbench', 'shell.css'), 'utf8');

const DIFF_CLASSES = ['cm-changedText', 'cm-changedLine', 'cm-deletedText', 'cm-deletedChunk', 'cm-changedLineGutter', 'cm-deletedLineGutter', 'cm-inlineChangedLine', 'cm-collapsedLines'];

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

describe('diff decoration styles outweigh the merge view base theme', () => {
	it('every rule on a diff decoration carries at least four classes', () => {
		const weak = selectors()
			.filter((selector) => DIFF_CLASSES.some((cls) => selector.includes(`.${cls}`)))
			.filter((selector) => (selector.match(/\.[\w-]+/g) ?? []).length < 4);
		expect(weak).toEqual([]);
	});

	it('styles both split sides and the unified view, with no underline left over', () => {
		const rules = selectors();
		expect(rules).toContain('.editor-pane .cm-editor.cm-merge-a .cm-changedText');
		expect(rules).toContain('.editor-pane .cm-editor.cm-merge-b .cm-changedText');
		expect(rules).toContain('.editor-pane .cm-editor.cm-merge-b .cm-deletedChunk .cm-deletedText');
		expect(css).toMatch(/\.cm-changedText[^{]*\{\s*text-decoration:\s*none/);
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
