// VS Code's comment commands: Ctrl+/ toggles the line comment of every selected line,
// Shift+Alt+A wraps the selection in the language's block comment. The tokens come from a
// table keyed by file extension (the editors highlight through syntect decorations, not
// CodeMirror languages, so CM's own comment-token facet has nothing to consult). Both
// commands work on any CodeMirror view — the full editor and the windowed large-file
// editor alike (the windowed one syncs its edits through the backend rope as always).

import type { Command } from '@codemirror/view';
import { EditorSelection } from '@codemirror/state';

/** The comment syntax a language carries: a line token (`//`, `#`, `--`) and/or a block
 *  pair (`/* … *\/`), exactly the pair VS Code's languages contribute. */
export interface CommentTokens {
	line?: string;
	block?: [string, string];
}

/** The comment tokens for a file name, by extension — the syntax families the workbench
 *  opens in practice. Unknown extensions get nothing (the commands no-op, like VS Code on
 *  plain text without a comment token). */
export function commentTokensFor(path: string): CommentTokens | null {
	const dot = path.lastIndexOf('.');
	const ext = dot === -1 ? '' : path.slice(dot + 1).toLowerCase();
	const table: Record<string, CommentTokens> = {
		rs: { line: '//', block: ['/*', '*/'] },
		js: { line: '//', block: ['/*', '*/'] },
		mjs: { line: '//', block: ['/*', '*/'] },
		cjs: { line: '//', block: ['/*', '*/'] },
		ts: { line: '//', block: ['/*', '*/'] },
		tsx: { line: '//', block: ['/*', '*/'] },
		jsx: { line: '//', block: ['/*', '*/'] },
		java: { line: '//', block: ['/*', '*/'] },
		c: { line: '//', block: ['/*', '*/'] },
		h: { line: '//', block: ['/*', '*/'] },
		cpp: { line: '//', block: ['/*', '*/'] },
		hpp: { line: '//', block: ['/*', '*/'] },
		cc: { line: '//', block: ['/*', '*/'] },
		cs: { line: '//', block: ['/*', '*/'] },
		go: { line: '//', block: ['/*', '*/'] },
		swift: { line: '//', block: ['/*', '*/'] },
		kt: { line: '//', block: ['/*', '*/'] },
		scala: { line: '//', block: ['/*', '*/'] },
		php: { line: '//', block: ['/*', '*/'] },
		dart: { line: '//', block: ['/*', '*/'] },
		py: { line: '#' },
		pyw: { line: '#' },
		rb: { line: '#' },
		sh: { line: '#' },
		bash: { line: '#' },
		zsh: { line: '#' },
		yml: { line: '#' },
		yaml: { line: '#' },
		toml: { line: '#' },
		r: { line: '#' },
		perl: { line: '#' },
		conf: { line: '#' },
		sql: { line: '--', block: ['/*', '*/'] },
		lua: { line: '--', block: ['--[[', ']]'] },
		hs: { line: '--' },
		vim: { line: '"' },
		ini: { line: ';' },
		css: { block: ['/*', '*/'] },
		scss: { line: '//', block: ['/*', '*/'] },
		less: { line: '//', block: ['/*', '*/'] },
		html: { block: ['<!--', '-->'] },
		htm: { block: ['<!--', '-->'] },
		xml: { block: ['<!--', '-->'] },
		md: { block: ['<!--', '-->'] },
		jsonc: { line: '//' }
	};
	return table[ext] ?? null;
}

/** Ctrl+/: comment every selected line when any is bare, uncomment them all when every
 *  non-empty one carries the token — VS Code's all-or-nothing toggle per press. */
export function toggleLineComment(view: import('@codemirror/view').EditorView, path: string): boolean {
	const tokens = commentTokensFor(path);
	const token = tokens?.line;
	if (!token || view.state.readOnly) return false;
	const { state } = view;
	const changes = state.changeByRange((range) => {
		const first = state.doc.lineAt(range.from).number;
		const last = state.doc.lineAt(range.to).number;
		const lines = [];
		for (let number = first; number <= last; number++) lines.push(state.doc.line(number));
		const commenting = lines.some((line) => line.text.trim() !== '' && !line.text.trimStart().startsWith(token));
		// The comment goes after the common leading whitespace, one space after the token;
		// uncommenting takes the token and that one space back.
		const changes: { from: number; to?: number; insert: string }[] = [];
		for (const line of lines) {
			if (commenting) {
				if (line.text.trim() === '') continue;
				const at = line.text.length - line.text.trimStart().length;
				changes.push({ from: line.from + at, insert: `${token} ` });
			} else {
				const at = line.text.indexOf(token);
				if (at === -1) continue;
				const after = at + token.length;
				const space = line.text.slice(after, after + 1) === ' ' ? 1 : 0;
				changes.push({ from: line.from + at, to: line.from + after + space, insert: '' });
			}
		}
		return {
			changes,
			range: commenting ? range : EditorSelection.range(
				Math.max(range.from - token.length - 1, state.doc.lineAt(range.from).from),
				Math.max(range.to - token.length - 1, state.doc.lineAt(range.to).from)
			)
		};
	});
	view.dispatch(state.update(changes, { userEvent: 'input.comment' }));
	return true;
}

/** Shift+Alt+A: wrap the selection in the language's block-comment pair, or insert an
 *  empty pair at the cursor; a selection that is exactly a comment unwraps. */
export function toggleBlockComment(view: import('@codemirror/view').EditorView, path: string): boolean {
	const tokens = commentTokensFor(path);
	const [open, close] = tokens?.block ?? [];
	if (!open || !close || view.state.readOnly) return false;
	const { state } = view;
	const range = state.selection.main;
	const text = state.sliceDoc(range.from, range.to);
	if (text.startsWith(open) && text.endsWith(close) && text.length >= open.length + close.length) {
		// Unwrap: the inner text with the one space each side the wrap added, if present.
		let inner = text.slice(open.length, text.length - close.length);
		if (inner.startsWith(' ')) inner = inner.slice(1);
		if (inner.endsWith(' ')) inner = inner.slice(0, -1);
		view.dispatch({
			changes: { from: range.from, to: range.to, insert: inner },
			selection: EditorSelection.range(range.from, range.from + inner.length),
			userEvent: 'input.comment'
		});
		return true;
	}
	// Wrap, with VS Code's one space inside each delimiter; an empty selection leaves the
	// cursor between them, ready to type.
	const inner = text === '' ? '' : ` ${text} `;
	view.dispatch({
		changes: { from: range.from, to: range.to, insert: open + inner + close },
		// The selection covers the whole comment, delimiters included — exactly VS Code's,
		// so the next press unwraps it.
		selection: text === ''
			? { anchor: range.from + open.length }
			: EditorSelection.range(range.from, range.from + open.length + inner.length + close.length),
		userEvent: 'input.comment'
	});
	return true;
}

/** The two as CodeMirror keymap commands, bound with the file's path read live (an editor
 *  keeps one path for its lifetime; a caller with a different shape can call the functions
 *  above directly). */
export function commentKeymapFor(path: () => string): { line: Command; block: Command } {
	return {
		line: (view) => toggleLineComment(view, path()),
		block: (view) => toggleBlockComment(view, path())
	};
}
