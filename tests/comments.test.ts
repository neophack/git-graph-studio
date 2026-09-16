// VS Code's comment toggles: Ctrl+/ comments or uncomments every selected line (the
// all-or-nothing per press), Shift+Alt+A wraps or unwraps the selection in the block pair.
// The tokens come from the extension table, unknown languages no-op.

import { describe, expect, it } from 'vitest';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

import { commentTokensFor, toggleBlockComment, toggleLineComment } from '../src/comments';

function viewOf(text: string, selection?: { anchor: number; head?: number }): EditorView {
	const parent = document.createElement('div');
	document.body.appendChild(parent);
	return new EditorView({
		state: EditorState.create({
			doc: text,
			selection: selection ? EditorSelection.range(selection.anchor, selection.head ?? selection.anchor) : undefined
		}),
		parent
	});
}

describe('comment toggles', () => {
	it('maps extensions to their comment tokens', () => {
		expect(commentTokensFor('main.rs')).toEqual({ line: '//', block: ['/*', '*/'] });
		expect(commentTokensFor('script.PY')).toEqual({ line: '#' });
		expect(commentTokensFor('query.SQL')).toEqual({ line: '--', block: ['/*', '*/'] });
		expect(commentTokensFor('readme.xyz')).toBeNull();
	});

	it('comments the selected lines after their indentation and uncomments on the second press', () => {
		const view = viewOf('let a = 1;\n    let b = 2;\nlet c = 3;\n', { anchor: 0, head: 22 });
		toggleLineComment(view, 'code.rs');
		expect(view.state.sliceDoc()).toBe('// let a = 1;\n    // let b = 2;\nlet c = 3;\n');
		// The selection survived as a range; the second press takes every token back out.
		toggleLineComment(view, 'code.rs');
		expect(view.state.sliceDoc()).toBe('let a = 1;\n    let b = 2;\nlet c = 3;\n');
		view.destroy();
	});

	it('comments after the shared indentation, not at column 0', () => {
		const view = viewOf('fn main() {\n    inner();\n}\n', { anchor: 12, head: 24 });
		toggleLineComment(view, 'code.rs');
		expect(view.state.sliceDoc()).toBe('fn main() {\n    // inner();\n}\n');
		view.destroy();
	});

	it('no-ops on a language without tokens', () => {
		const view = viewOf('plain text\n', { anchor: 0, head: 11 });
		expect(toggleLineComment(view, 'file.xyz')).toBe(false);
		expect(view.state.sliceDoc()).toBe('plain text\n');
		view.destroy();
	});

	it('wraps the selection in the block pair and unwraps it back', () => {
		const view = viewOf('let a = 1;', { anchor: 4, head: 9 });
		toggleBlockComment(view, 'code.rs');
		expect(view.state.sliceDoc()).toBe('let /* a = 1 */;');
		toggleBlockComment(view, 'code.rs');
		expect(view.state.sliceDoc()).toBe('let a = 1;');
		view.destroy();
	});

	it('inserts an empty pair at the cursor when nothing is selected', () => {
		const view = viewOf('let a;', { anchor: 6 });
		toggleBlockComment(view, 'code.rs');
		expect(view.state.sliceDoc()).toBe('let a;/**/');
		view.destroy();
	});
});
