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

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'shell.css'), 'utf8');

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
});
