// Merge conflict resolution: a file with git's conflict markers gets VS Code's two surfaces —
// the editor decorates every conflict block (ours teal, theirs blue) and rides an inline
// actions widget above each one (Accept Current / Incoming / Both), and a toolbar walks the
// conflicts and resolves each one in place, then "Mark Resolved" saves the file and stages it
// - the workflow of a three-way merge view without a language server or a separate merge tool.

import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';
import { StateField, type Extension, type Text } from '@codemirror/state';
import { gitStage } from '../../platform/ipc/scm';
import { type FileContents, readFile, writeFile } from '../../platform/ipc/fs';
import { t } from '../../platform/i18n';

import { el, icon, notify } from '../../platform/ui/index';

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
	// A side the merge already resolved away has no lines — an empty replacement, never an
	// inverted range (sliceDoc would throw on start > end).
	const block = (from: number, to: number) => (from > to ? '' : view.state.sliceDoc(doc.line(from).from, doc.line(to).to));
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

/** VS Code's inline conflict actions: one widget above each conflict's first marker line with
 *  the three accept buttons. A click resolves against the conflict at the widget's own start
 *  line as the document stands in that moment, so a widget whose conflict was resolved by a
 *  neighbouring action simply answers nothing. */
class ConflictActionsWidget extends WidgetType {
	constructor(readonly startLine: number) {
		super();
	}

	eq(other: ConflictActionsWidget): boolean {
		return other.startLine === this.startLine;
	}

	toDOM(view: EditorView): HTMLElement {
		const box = el('div', 'cm-conflict-actions');
		const actions: [ConflictChoice, string][] = [
			['ours', t('merge.acceptCurrent')],
			['theirs', t('merge.acceptIncoming')],
			['both', t('merge.acceptBoth')]
		];
		for (const [choice, label] of actions) {
			const button = el('button', 'cm-conflict-action', [label]);
			// A press must not move the editor's own focus into the widget.
			button.addEventListener('mousedown', (event) => event.preventDefault());
			button.addEventListener('click', (event) => {
				event.stopPropagation();
				const conflict = parseConflicts(view.state.doc.toString()).find((c) => c.start === this.startLine);
				if (conflict) applyChoice(view, conflict, choice);
			});
			box.appendChild(button);
		}
		return box;
	}
}

/** The conflict blocks' line decorations, with one actions widget above each conflict's
 *  first marker: the marker lines carry the stronger header tints (ours teal, theirs blue,
 *  the diff3 base grey), the bodies their content tints — VS Code's `merge.*` colours, which
 *  the theme files define as `--vscode-merge-*`. */
/** The marker lines that can complete (or carry) a conflict: a changed region touching any
 *  of them could have brought a parseable block into the document, so the decorations
 *  re-parse. Typing the last `=` of a separator or the `>>>>>>>` line completes a conflict
 *  whose opening `<<<<<<<` sits far outside the changed range — checking only the opening
 *  marker let the toolbar count a conflict the decorations never drew. */
const CONFLICT_MARKERS = ['<<<<<<<', '=======', '>>>>>>>', '|||||||'];

export function conflictDecorations(): Extension {
	return StateField.define<DecorationSet>({
		create: (state) => conflictDecorationsOf(state.doc),
		update: (value, update) => {
			if (!update.docChanged) return value;
			// An editor without decorations stays cheap: only a change that could have brought
			// a marker into the document pays the reparse, and a decorated document reparses
			// on every edit (a resolution's edit must clear its decorations).
			let dirty = value.size > 0;
			if (!dirty) {
				const doc = update.state.doc;
				update.changes.iterChangedRanges((_fromA, _toA, from, to) => {
					const window = doc.sliceString(Math.max(0, from - 8), Math.min(doc.length, to + 8));
					if (CONFLICT_MARKERS.some((marker) => window.includes(marker))) dirty = true;
				});
			}
			return dirty ? conflictDecorationsOf(update.state.doc) : value;
		},
		provide: (field) => EditorView.decorations.from(field)
	});
}

function conflictDecorationsOf(doc: Text): DecorationSet {
	const conflicts = parseConflicts(doc.toString());
	if (conflicts.length === 0) return Decoration.none;
	const ranges: { from: number; to: number; value: Decoration }[] = [];
	const line = (n: number) => doc.line(Math.min(Math.max(n, 1), doc.lines));
	const lineDeco = (n: number, cls: string) => {
		const at = line(n);
		ranges.push({ from: at.from, to: at.from, value: Decoration.line({ class: cls }) });
	};
	for (const conflict of conflicts) {
		const anchor = line(conflict.start).from;
		ranges.push({ from: anchor, to: anchor, value: Decoration.widget({ widget: new ConflictActionsWidget(conflict.start), side: -1, block: true }) });
		lineDeco(conflict.start, 'cm-conflict-head cm-conflict-ours-head');
		const oursEnd = (conflict.baseSeparator ?? conflict.separator) - 1;
		for (let n = conflict.start + 1; n <= oursEnd; n++) lineDeco(n, 'cm-conflict-ours');
		if (conflict.baseSeparator !== null) {
			for (let n = conflict.baseSeparator + 1; n <= conflict.separator - 1; n++) lineDeco(n, 'cm-conflict-base');
		}
		lineDeco(conflict.separator, 'cm-conflict-mid');
		for (let n = conflict.separator + 1; n <= conflict.end - 1; n++) lineDeco(n, 'cm-conflict-theirs');
		lineDeco(conflict.end, 'cm-conflict-head cm-conflict-theirs-head');
	}
	return Decoration.set(ranges.map((r) => r.value.range(r.from, r.to)), true);
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
	/** The editor group's own save path (dirty.ts's `save`), wired by whoever mounted the
	 *  toolbar: it settles the dirty flag, the tab dot and the hot-exit backup. A
	 *  synthesized Mod-S keystroke depended on the save binding living in the keymap. */
	onSave: (() => void) | null = null;

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
			this.count.textContent = t('merge.noConflicts');
			this.bar.append(
				icon('git-merge'),
				this.count,
				this.button(t('merge.markResolved'), t('merge.markResolvedHint'), () => void this.markResolved())
			);
			return;
		}
		const active = this.conflicts[this.activeIndex] ?? null;
		this.count.textContent = `${this.activeIndex + 1} / ${this.conflicts.length} ${t('merge.conflicts')}`;
		const choose = (choice: ConflictChoice) => {
			if (!this.view || !active) return;
			if (applyChoice(this.view, active, choice)) this.update();
		};
		// Prev / next land on the conflict: the selection moves to its first marker and the
		// view scrolls it into sight — VS Code's conflict navigation walks you there, it
		// never just renumbers.
		const step = (delta: number) => {
			this.activeIndex = (this.activeIndex + delta + this.conflicts.length) % this.conflicts.length;
			this.render();
			this.revealActive();
		};
		this.bar.append(
			icon('git-merge'),
			this.count,
			this.button('‹', t('merge.prev'), () => step(-1)),
			this.button('›', t('merge.next'), () => step(1)),
			this.button(t('merge.keepOurs'), t('merge.keepOursHint'), () => choose('ours')),
			this.button(t('merge.keepTheirs'), t('merge.keepTheirsHint'), () => choose('theirs')),
			this.button(t('merge.keepBoth'), t('merge.keepBothHint'), () => choose('both')),
			this.button(t('merge.markResolved'), t('merge.markResolvedHint'), () => void this.markResolved())
		);
	}

	/** Bring the active conflict's first marker line into the view: the selection lands on
	 *  it and the transaction scrolls it into sight. */
	private revealActive(): void {
		const active = this.conflicts[this.activeIndex];
		if (!this.view || !active) return;
		const doc = this.view.state.doc;
		const line = doc.line(Math.min(active.start, doc.lines));
		this.view.dispatch({ selection: { anchor: line.from }, scrollIntoView: true });
		this.view.focus();
	}

	private async markResolved(): Promise<void> {
		if (!this.view || !this.path) return;
		if (this.conflicts.length > 0) {
			notify('warning', t('merge.resolveFirst'));
			return;
		}
		const view = this.view;
		try {
			// CodeMirror holds the document normalized to \n; the file's own encoding and line
			// endings come from a fresh read, or the write would re-encode it as UTF-8/LF
			// (flipping every line ending of a CRLF file, corrupting a GB18030/UTF-16 one).
			// A failed read aborts the resolve — guessing utf8/lf would transcode a file the
			// read could not even answer (locked, deleted, unreadable).
			const format: FileContents = await readFile(this.path);
			await writeFile(this.path, view.state.doc.toString(), format.encoding, format.eol);
			await gitStage([this.path]);
		} catch (error) {
			notify('error', String(error));
			return;
		}
		// The resolution edits were never the editor's own save: its buffer still reads dirty.
		// Saving through the editor group's own save path settles the dirty flag, the tab dot
		// and the hot-exit backup (the write it makes is the one just staged - byte-identical).
		this.onSave?.();
		notify('info', t('merge.resolved'));
		this.staged = true;
		this.render();
		this.onResolved?.();
	}
}
