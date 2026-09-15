// A faithful stand-in for the backend's viewer document (src-tauri/src/viewer): the text is
// kept whole, edits arrive as the same (line, col) ranges the frontend sends, and they apply
// with ropey's line model — a trailing newline yields a final empty line, a past-the-end
// line is the document's end — so a test can assert that what the windowed editor shows is
// byte-for-byte what the backend holds. The line-array mocks elsewhere are too forgiving for
// that: they cannot tell a lost newline from a kept one.

import { backend } from './tauriMock';

interface Step {
	start: number;
	removed: string;
	inserted: string;
}

export class RopeDocMock {
	text: string;
	/** What `viewer_save` last wrote, null until the first save. */
	saved: string | null = null;
	/** Set by a test to stand in for the file changing on disk under the editor. */
	diskChanged = false;
	/** When set, the next `viewer_edit` throws once (a failed send). */
	failNextEdit = false;
	private undoStack: Step[] = [];
	private redoStack: Step[] = [];

	constructor(text: string) {
		this.text = text;
	}

	/** ropey's lines: "a\nb\n" is three lines, the last one empty. */
	lines(): string[] {
		return this.text.split('\n');
	}

	lineCount(): number {
		return this.lines().length;
	}

	/** Mirrors `ViewerDoc::offset_of`: a column past the line's end stops before its newline;
	 *  a line past the end is the document's end. */
	offsetOf(line: number, col: number): number {
		const lines = this.lines();
		if (line >= lines.length) return this.text.length;
		let base = 0;
		for (let i = 0; i < line; i++) base += lines[i]!.length + 1;
		return Math.min(base + Math.min(col, lines[line]!.length), this.text.length);
	}

	edit(startLine: number, startCol: number, endLine: number, endCol: number, inserted: string): number {
		const a = this.offsetOf(startLine, startCol);
		const b = this.offsetOf(endLine, endCol);
		const [lo, hi] = a <= b ? [a, b] : [b, a];
		const removed = this.text.slice(lo, hi);
		this.apply(lo, hi, inserted);
		this.undoStack.push({ start: lo, removed, inserted });
		this.redoStack = [];
		return this.lineAt(lo);
	}

	undo(): { firstLine: number; lineCount: number } | null {
		const step = this.undoStack.pop();
		if (!step) return null;
		this.apply(step.start, step.start + step.inserted.length, step.removed);
		this.redoStack.push(step);
		return { firstLine: this.lineAt(step.start), lineCount: this.lineCount() };
	}

	redo(): { firstLine: number; lineCount: number } | null {
		const step = this.redoStack.pop();
		if (!step) return null;
		this.apply(step.start, step.start + step.removed.length, step.inserted);
		this.undoStack.push(step);
		return { firstLine: this.lineAt(step.start), lineCount: this.lineCount() };
	}

	private apply(lo: number, hi: number, inserted: string): void {
		this.text = this.text.slice(0, lo) + inserted + this.text.slice(hi);
	}

	private lineAt(offset: number): number {
		return this.text.slice(0, offset).split('\n').length - 1;
	}

	/** Script every viewer command the windowed editor uses against this document. The probe
	 *  reports a size past the windowed threshold so the open path takes the windowed editor
	 *  whatever the text's real length. */
	install(docId = 1): void {
		backend.on('file_probe', () => ({ size: 100 * 1024 * 1024, binary: false, longLines: false }));
		backend.on('viewer_open', () => ({ docId, lineCount: this.lineCount(), language: 'log', syntaxName: 'Plain Text', symbols: [], encoding: 'utf8', eol: 'lf' }));
		backend.on('viewer_text', ({ start, end }: { start: number; end: number }) => {
			if (end - start + 1 > 500) throw new Error(`window too large: ${start}..${end}`);
			const lines = this.lines();
			const last = lines.length - 1;
			const from = Math.min(start, last);
			const to = Math.min(end, last);
			return { startLine: from, lineCount: lines.length, lines: lines.slice(from, to + 1) };
		});
		backend.on('viewer_edit', ({ startLine, startCol, endLine, endCol, text }: { startLine: number; startCol: number; endLine: number; endCol: number; text: string }) => {
			if (this.failNextEdit) {
				this.failNextEdit = false;
				throw new Error('edit failed');
			}
			const rehighlightFrom = this.edit(startLine, startCol, endLine, endCol, text);
			return { lineCount: this.lineCount(), rehighlightFrom };
		});
		backend.on('viewer_undo', () => this.undo());
		backend.on('viewer_redo', () => this.redo());
		backend.on('viewer_save', () => {
			this.saved = this.text;
			return null;
		});
		backend.on('viewer_reload', () => {
			if (!this.diskChanged) return { changed: false, lineCount: 0 };
			this.diskChanged = false;
			return { changed: true, lineCount: this.lineCount() };
		});
		backend.on('viewer_backup', () => null);
		backend.on('backup_clear', () => null);
		backend.on('viewer_close', () => null);
	}
}
