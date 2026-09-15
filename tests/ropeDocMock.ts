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

/** A replace-all's undo step: the whole text before and after, one Ctrl+Z either way. */
interface MultiStep {
	before: string;
	after: string;
}

/** The query options both find commands take, as the IPC carries them. */
export interface MockFindOptions {
	caseSensitive: boolean;
	wholeWord: boolean;
	regexp: boolean;
}

/** The match shape `viewer_find` reports: 0-based line, code-point columns. */
export interface MockMatch {
	line: number;
	startCol: number;
	endCol: number;
}

/** Mirrors the backend's MAX_FIND_MATCHES (src-tauri/src/viewer/find.rs). */
const MAX_FIND_MATCHES = 50_000;

/** The 0-based line two texts first differ on (a replace-all's undo report). */
function firstDiffLine(a: string, b: string): number {
	let line = 0;
	let at = 0;
	while (at < a.length && at < b.length && a[at] === b[at]) {
		if (a[at] === '\n') line++;
		at++;
	}
	return line;
}

export class RopeDocMock {
	text: string;
	/** What `viewer_save` last wrote, null until the first save. */
	saved: string | null = null;
	/** Set by a test to stand in for the file changing on disk under the editor. */
	diskChanged = false;
	/** When set, the next `viewer_edit` throws once (a failed send). */
	failNextEdit = false;
	private undoStack: (Step | MultiStep)[] = [];
	private redoStack: (Step | MultiStep)[] = [];

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
		if ('before' in step) {
			this.text = step.before;
			this.redoStack.push(step);
			return { firstLine: firstDiffLine(step.after, step.before), lineCount: this.lineCount() };
		}
		this.apply(step.start, step.start + step.inserted.length, step.removed);
		this.redoStack.push(step);
		return { firstLine: this.lineAt(step.start), lineCount: this.lineCount() };
	}

	redo(): { firstLine: number; lineCount: number } | null {
		const step = this.redoStack.pop();
		if (!step) return null;
		if ('before' in step) {
			this.text = step.after;
			this.undoStack.push(step);
			return { firstLine: firstDiffLine(step.before, step.after), lineCount: this.lineCount() };
		}
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

	/* ---------- viewer_find / viewer_replace (mirrors src-tauri/src/viewer/find.rs) ---------- */

	/** The single-line matches of a query over the whole document: 0-based lines,
	 *  code-point `[start, end)` columns, case / whole-word / regex options, the cap. */
	find(query: string, options: MockFindOptions): { matches: MockMatch[]; capped: boolean } {
		const matches: MockMatch[] = [];
		if (query === '') return { matches, capped: false };
		const isWord = (c: string) => /[\w]/.test(c) && c !== undefined;
		const hits = (line: string): [number, number][] => {
			const chars = Array.from(line);
			const out: [number, number][] = [];
			if (options.regexp) {
				const regex = new RegExp(query, options.caseSensitive ? '' : 'i');
				for (let at = 0; at < chars.length;) {
					regex.lastIndex = 0;
					const rest = chars.slice(at).join('');
					const hit = regex.exec(rest);
					if (!hit) break;
					if (hit[0] === '') { at++; continue; }
					out.push([at + hit.index, at + hit.index + Array.from(hit[0]).length]);
					at += hit.index + Array.from(hit[0]).length;
				}
			} else {
				const needle = Array.from(options.caseSensitive ? query : query.toLowerCase());
				const lower = (c: string) => (options.caseSensitive ? c : c.toLowerCase());
				let at = 0;
				while (at + needle.length <= chars.length) {
					let hit = true;
					for (let i = 0; i < needle.length; i++) {
						if (lower(chars[at + i]!) !== needle[i]!) { hit = false; break; }
					}
					if (hit) { out.push([at, at + needle.length]); at += needle.length; }
					else at++;
				}
			}
			if (!options.wholeWord) return out;
			return out.filter(([start, end]) => {
				const before = start > 0 ? chars[start - 1]! : null;
				const after = end < chars.length ? chars[end]! : null;
				return (before === null || !isWord(before)) && (after === null || !isWord(after));
			});
		};
		const lines = this.lines();
		for (let line = 0; line < lines.length; line++) {
			for (const [startCol, endCol] of hits(lines[line]!)) {
				matches.push({ line, startCol, endCol });
				if (matches.length === MAX_FIND_MATCHES) return { matches, capped: true };
			}
		}
		return { matches, capped: false };
	}

	/** Replace the next `max` matches from a 0-based line/col position (`max = 1` is the
	 *  widget's Replace, `Infinity` its Replace All), as one undo step. */
	replace(query: string, replacement: string, options: MockFindOptions, fromLine: number, fromCol: number, max: number): { replacements: number; firstLine: number; lineCount: number } {
		if (max === 0 || query === '') return { replacements: 0, firstLine: 0, lineCount: this.lineCount() };
		const all = this.find(query, options).matches.filter(
			(match) => match.line > fromLine || (match.line === fromLine && match.startCol >= fromCol)
		);
		const lines = this.lines();
		const before = this.text;
		const expand = (matchText: string): string => {
			if (!options.regexp) return replacement;
			const regex = new RegExp(query, options.caseSensitive ? '' : 'i');
			const groups = regex.exec(matchText);
			return replacement.replace(/\$(\d+)/g, (_all, group: string) => groups?.[Number(group)] ?? '');
		};
		// The replacements of one line apply against its own matches, left to right.
		const perLine = new Map<number, [number, number][]>();
		let replacements = 0;
		let firstLine = Number.MAX_SAFE_INTEGER;
		for (const match of all) {
			if (replacements >= max) break;
			const list = perLine.get(match.line) ?? [];
			list.push([match.startCol, match.endCol]);
			perLine.set(match.line, list);
			replacements++;
			firstLine = Math.min(firstLine, match.line);
		}
		for (const [line, ranges] of perLine) {
			const chars = Array.from(lines[line]!);
			const out: string[] = [];
			let at = 0;
			for (const [start, end] of ranges) {
				out.push(...chars.slice(at, start), expand(chars.slice(start, end).join('')));
				at = end;
			}
			out.push(...chars.slice(at));
			lines[line] = out.join('');
		}
		if (replacements === 0) return { replacements: 0, firstLine: 0, lineCount: this.lineCount() };
		this.text = lines.join('\n');
		this.undoStack.push({ before, after: this.text });
		this.redoStack = [];
		return { replacements, firstLine: firstLine === Number.MAX_SAFE_INTEGER ? 0 : firstLine, lineCount: this.lineCount() };
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
		backend.on('viewer_find', ({ query, caseSensitive, wholeWord, regexp }) =>
			this.find(String(query), { caseSensitive: Boolean(caseSensitive), wholeWord: Boolean(wholeWord), regexp: Boolean(regexp) })
		);
		backend.on('viewer_replace', ({ query, replacement, caseSensitive, wholeWord, regexp, fromLine, fromCol, max }) =>
			this.replace(
				String(query),
				String(replacement ?? ''),
				{ caseSensitive: Boolean(caseSensitive), wholeWord: Boolean(wholeWord), regexp: Boolean(regexp) },
				Number(fromLine ?? 0),
				Number(fromCol ?? 0),
				Number(max ?? Number.MAX_SAFE_INTEGER)
			)
		);
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
