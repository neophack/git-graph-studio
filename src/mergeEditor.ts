// Merge conflict resolution: a file with git's conflict markers gets a toolbar that walks the
// conflicts and resolves each one in place (keep ours, keep theirs, keep both), then "Mark
// Resolved" saves the file and stages it - the workflow of a three-way merge view without a
// language server or a separate merge tool.

import { invoke } from '@tauri-apps/api/core';
import type { EditorView } from '@codemirror/view';

import { el, icon, notify } from './ui';

/** One conflict in the document, by line numbers: 1-based, inclusive, including the markers. */
export interface Conflict {
	/** The `<<<<<<<` line. */
	start: number;
	/** The `=======` separator line. */
	separator: number;
	/** The `>>>>>>>` line. */
	end: number;
	/** The `|||||||` line of a diff3-style conflict, when present. */
	baseSeparator: number | null;
}

/** Parse the conflict blocks of a text. The markers are git's (`.mt` markers of style=merge are
 *  not handled; the default conflict style is what a merge produces).
 *  Malformed leftovers (a `<<<<<<<` without its partners) are ignored. */
export function parseConflicts(text: string): Conflict[] {
	const conflicts: Conflict[] = [];
	let start: number | null = null;
	let base: number | null = null;
	let separator: number | null = null;
	const lines = text.split('\n');
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!.trimEnd();
		if (line.startsWith('<<<<<<<')) {
			if (start !== null) {
				// Nested / stray marker: restart from here.
				start = null;
				base = null;
				separator = null;
			}
			start = i + 1;
		} else if (line.startsWith('|||||||') && start !== null && separator === null) {
			base = i + 1;
		} else if (line.startsWith('=======') && start !== null && separator === null) {
			separator = i + 1;
		} else if (line.startsWith('>>>>>>>') && start !== null && separator !== null) {
			conflicts.push({ start, separator, end: i + 1, baseSeparator: base });
			start = null;
			base = null;
			separator = null;
		}
	}
	return conflicts;
}

export type ConflictChoice = 'ours' | 'theirs' | 'both';

/** The line range that remains of a conflict for a choice, as 1-based inclusive bounds. In a
 *  diff3 conflict ours sits between `<<<<<<<` and `|||||||` (not between the base section and
 *  the separator); without a base section it is everything above `=======`. */
export function resolutionRange(conflict: Conflict, choice: ConflictChoice): { start: number; end: number } | null {
	// Ours: between the start marker and the base separator (or the "=======").
	const oursFrom = conflict.start + 1;
	const oursTo = (conflict.baseSeparator ?? conflict.separator) - 1;
	// Theirs: between "=======" and the end marker.
	const theirsFrom = conflict.separator + 1;
	const theirsTo = conflict.end - 1;
	if (choice === 'ours') return { start: oursFrom, end: oursTo };
	if (choice === 'theirs') return { start: theirsFrom, end: theirsTo };
	return { start: oursFrom, end: theirsTo };
}

/** The line the CodeMirror document range of a conflict maps to. */
function lineRange(view: EditorView, conflict: Conflict): { from: number; to: number } {
	const doc = view.state.doc;
	const from = doc.line(Math.min(conflict.start, doc.lines)).from;
	const to = doc.line(Math.min(conflict.end, doc.lines)).to;
	return { from, to };
}

/** Apply a choice to a conflict in the editor: replace the whole block (markers included) with
 *  the chosen lines. Returns false when the block no longer matches (the file changed). */
export function applyChoice(view: EditorView, conflict: Conflict, choice: ConflictChoice): boolean {
	const doc = view.state.doc;
	if (conflict.end > doc.lines) return false;
	const block = (from: number, to: number) => view.state.sliceDoc(doc.line(from).from, doc.line(to).to);
	const ours = block(conflict.start + 1, (conflict.baseSeparator ?? conflict.separator) - 1);
	const theirs = block(conflict.separator + 1, conflict.end - 1);
	const replacement = choice === 'ours' ? ours : choice === 'theirs' ? theirs : [ours, theirs].filter((part) => part !== '').join('\n');
	const { from, to } = lineRange(view, conflict);
	view.dispatch({ changes: { from, to, insert: replacement } });
	return true;
}

/** The conflict at (or around) a 1-based line, or null. */
export function conflictAt(conflicts: Conflict[], line: number): Conflict | null {
	return conflicts.find((c) => line >= c.start && line <= c.end) ?? null;
}

/** The toolbar of a conflicted editor: the remaining count, prev / next, the three choices for
 *  the conflict at the cursor, and Mark Resolved (save + stage). */
export class MergeToolbar {
	private readonly bar: HTMLElement;
	private readonly count: HTMLElement;
	private view: EditorView | null = null;
	private path: string | null = null;
	private conflicts: Conflict[] = [];
	private activeIndex = 0;
	/** The file once had markers: a conflict-free document then means "resolved", and the bar
	 *  offers Mark Resolved (a file that never had conflicts keeps the bar hidden). */
	private hadConflicts = false;
	/** Set by a successful Mark Resolved; the bar steps aside until markers reappear. */
	private staged = false;
	/** Fired after "Mark Resolved" so the workbench refreshes SCM and the graph. */
	onResolved: (() => void) | null = null;

	constructor(bar: HTMLElement) {
		this.bar = bar;
		this.bar.classList.add('merge-bar');
		this.count = el('span', 'merge-count');
		this.render();
	}

	/** Attach to (or detach from) an editor; the toolbar hides itself when the file is clean. */
	attach(view: EditorView | null, path: string | null): void {
		this.view = view;
		this.path = path;
		this.hadConflicts = false;
		this.staged = false;
		this.update();
	}

	/** Re-read the conflicts from the document (after every edit). */
	update(): void {
		this.conflicts = this.view ? parseConflicts(this.view.state.doc.toString()) : [];
		if (this.conflicts.length > 0) {
			this.hadConflicts = true;
			this.staged = false;
		}
		if (this.activeIndex >= this.conflicts.length) this.activeIndex = 0;
		this.render();
	}

	get conflictCount(): number {
		return this.conflicts.length;
	}

	private button(label: string, title: string, onClick: () => void): HTMLButtonElement {
		const button = el('button', 'button', [label]);
		button.title = title;
		button.addEventListener('click', (event) => {
			event.stopPropagation();
			onClick();
		});
		return button;
	}

	private render(): void {
		this.bar.innerHTML = '';
		if (!this.view || (this.conflicts.length === 0 && (!this.hadConflicts || this.staged))) {
			this.bar.hidden = true;
			return;
		}
		this.bar.hidden = false;
		if (this.conflicts.length === 0) {
			// The last conflict is resolved: finishing (save + stage) is the bar's one offer now.
			this.count.textContent = 'No conflicts remaining';
			this.bar.append(
				icon('git-merge'),
				this.count,
				this.button('Mark Resolved', 'Save the file and stage it', () => void this.markResolved())
			);
			return;
		}
		const active = this.conflicts[this.activeIndex] ?? null;
		this.count.textContent = `${this.activeIndex + 1} / ${this.conflicts.length} conflicts`;
		// Select the active conflict's start line so the user sees which one the buttons target.
		const reveal = () => {
			if (!this.view || !active) return;
			const doc = this.view.state.doc;
			const line = doc.line(Math.min(active.start, doc.lines));
			this.view.dispatch({ selection: { anchor: line.from } });
			this.view.focus();
		};
		const choose = (choice: ConflictChoice) => {
			if (!this.view || !active) return;
			if (applyChoice(this.view, active, choice)) this.update();
		};
		this.bar.append(
			icon('git-merge'),
			this.count,
			this.button('‹', 'Previous conflict', () => { this.activeIndex = (this.activeIndex - 1 + this.conflicts.length) % this.conflicts.length; this.render(); }),
			this.button('›', 'Next conflict', () => { this.activeIndex = (this.activeIndex + 1) % this.conflicts.length; this.render(); }),
			this.button('Go To', 'Reveal this conflict', reveal),
			this.button('Keep Ours', 'Resolve with the current branch\'s lines', () => choose('ours')),
			this.button('Keep Theirs', 'Resolve with the incoming branch\'s lines', () => choose('theirs')),
			this.button('Keep Both', 'Keep both sides', () => choose('both')),
			this.button('Mark Resolved', 'Save the file and stage it', () => void this.markResolved())
		);
	}

	private async markResolved(): Promise<void> {
		if (!this.view || !this.path) return;
		if (this.conflicts.length > 0) {
			notify('warning', 'Resolve all conflicts first (or edit them away) before marking the file resolved.');
			return;
		}
		const view = this.view;
		try {
			// CodeMirror holds the document normalized to \n; the file's own encoding and line
			// endings come from a fresh read, or the write would re-encode it as UTF-8/LF
			// (flipping every line ending of a CRLF file, corrupting a GB18030/UTF-16 one).
			const format = await invoke<{ encoding?: string; eol?: 'lf' | 'crlf' }>('read_file', { path: this.path }).catch(() => null);
			await invoke('write_file', {
				path: this.path,
				contents: view.state.doc.toString(),
				encoding: format?.encoding ?? 'utf8',
				eol: format?.eol ?? 'lf'
			});
			await invoke('git_stage', { paths: [this.path] });
		} catch (error) {
			notify('error', String(error));
			return;
		}
		// The resolution edits were never the editor's own save: its buffer still reads dirty.
		// Running its save binding settles the dirty flag, the tab dot and the hot-exit backup
		// (the write it makes is the one just staged - byte-identical).
		const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? { metaKey: true } : { ctrlKey: true };
		view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 's', bubbles: true, cancelable: true, ...mod }));
		notify('info', 'The merge conflict was resolved and staged.');
		this.staged = true;
		this.render();
		this.onResolved?.();
	}
}
