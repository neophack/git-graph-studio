// The Definition panel page (module 5) — the bottom panel's answer to a click, the
// whole declaring file as the page (2026-11-23, the si4-rea reconstruction's
// SPEC-ui-references-definition §2): the file stands as a live read-only view — scrolled
// to the declaration, the symbol's own line span marked as the selection — not a slice.
// Files over the 1 MiB+1 ceiling refuse with the same "file too big" note. The body's
// one click relocates the page — chain browsing: the word under the caret resolves
// against the index and the view re-roots on its definition, until the next cursor feed
// replaces it. The workbench feeds it with the same gate and debounce discipline the
// relation page ran on (the panel up, this page active, the pin off); the pin freezes
// the content, and the location button jumps to the definition. The relation window's
// clicks land here too (2026-11-23, the owner's direction: a relation click shows the
// jump in the Definition page, the code page never jumps, and the Definition page's
// right-click syncs its position onto the code page) — and the page's own right-click carries
// the sync, pushing its current position into the code editor when asked.

import { readFile } from '../../platform/ipc/fs';
import { symbolLookup } from '../../platform/ipc/symbols';

import { t } from '../../platform/i18n';
import { highlightLine, extOf, wordAt } from '../../platform/highlight';
import { KIND_ICONS } from './contextView';
import { actionButton, el, icon, showContextMenu, type MenuEntry } from '../../platform/ui/index';

import './definition.css';

/** The definition the page shows: the resolved symbol with its body's reach. */
export interface DefinitionSubject {
	kind: string;
	name: string;
	/** Repo-relative path of the definition — the index's own vocabulary. */
	path: string;
	/** 0-based declaration line. */
	line: number;
	/** 0-based line the definition's body ends on (the index's end_line; absent falls
	 *  back to the declaration's line and the macro rule extends the span). */
	endLine?: number;
}

/** The file-level ceiling (SPEC §2.2: `FUN_004174d0(file) < 0x100001` — one byte over a
 *  mebibite refuses with "file too big"). */
const FILE_MAX = 1024 * 1024 + 1;

/** A path's basename over either separator. */
function baseName(path: string): string {
	const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
	return cut === -1 ? path : path.slice(cut + 1);
}

export class DefinitionView {
	readonly element: HTMLElement;
	readonly actions: HTMLElement;

	/** A location-button click — the line arrives 1-based. */
	onOpenDefinition?: (path: string, line: number) => void;

	/** The panel page's shown() asks the workbench to re-resolve the cursor symbol. */
	onNeedRoot?: () => void;

	/** The index's repo-relative paths against the workspace: the hook the host wires so
	 *  the body's read opens the absolute spelling the backend's read_file needs. Unwired,
	 *  the path passes through as-is. */
	resolvePath?: (path: string) => string;

	private readonly body: HTMLElement;
	private readonly pinButton: HTMLButtonElement;

	private pinned = false;
	private subject: DefinitionSubject | null = null;
	/** Why the subject is empty (the resolution's note), shown instead of the resting hint. */
	private note: string | undefined;
	private loading = false;
	private failed = false;
	/** The file was past the ceiling — the page's own refusal. */
	private tooBig = false;
	/** The whole file's text once read, and its lines — the view's live document. */
	private fileLines: string[] | null = null;
	/** The fetch's staleness counter: every setDefinition drops the answers before it. */
	private generation = 0;

	constructor() {
		this.body = el('div', 'def-body');
		this.body.addEventListener('click', this.onBodyClick);
		this.body.addEventListener('contextmenu', this.onBodyContextMenu);
		this.element = el('div', 'panel-body def-panel', [this.body]);
		this.element.hidden = true;
		this.pinButton = actionButton('pin', t('definition.pin'), () => this.togglePin());
		this.actions = el('div', 'actions', [this.pinButton]);
		this.render();
	}

	private togglePin(): void {
		this.setPinned(!this.pinned);
	}

	/** The pin's state, from the host's side too: a relation click's feed pins the page
	 *  ahead of its own activation, so the cursor-follow's gate refuses and the symbol
	 *  the click named stays standing. */
	setPinned(pinned: boolean): void {
		this.pinned = pinned;
		this.pinButton.title = this.pinned ? t('definition.unpin') : t('definition.pin');
		this.pinButton.setAttribute('aria-label', this.pinButton.title);
		this.pinButton.innerHTML = '';
		this.pinButton.appendChild(icon(this.pinned ? 'pinned' : 'pin'));
	}

	/** While pinned, the auto-following pauses: the cursor can roam without changing the content. */
	isPinned(): boolean {
		return this.pinned;
	}

	/** Swap the subject (or clear it, `note` explaining why) and refetch its content. */
	setDefinition(subject: DefinitionSubject | null, note?: string): void {
		const same =
			this.subject !== null &&
			subject !== null &&
			this.subject.name === subject.name &&
			this.subject.path === subject.path &&
			this.subject.line === subject.line;
		if (same) return;
		this.subject = subject ? { ...subject } : null;
		this.note = note;
		void this.load();
	}

	private async load(): Promise<void> {
		const generation = ++this.generation;
		const subject = this.subject;
		this.loading = subject !== null;
		this.failed = false;
		this.tooBig = false;
		this.fileLines = null;
		this.render();
		if (!subject) return;
		try {
			const file = await readFile(this.resolvePath?.(subject.path) ?? subject.path);
			// A newer setDefinition owns the page now; this answer paints nothing.
			if (generation !== this.generation) return;
			const contents = file?.contents;
			if (contents == null) {
				this.failed = true;
			} else if (contents.length > FILE_MAX) {
				this.tooBig = true;
			} else {
				this.fileLines = contents.split('\n');
			}
		} catch {
			if (generation !== this.generation) return;
			this.failed = true;
		}
		this.loading = false;
		this.render();
	}

	/** The selection's last line: the index's end span, a macro whose end never reached
	 *  the index extending over its `\` continuations. */
	private selectionEnd(subject: DefinitionSubject, lines: string[]): number {
		let end = Math.max(subject.endLine ?? subject.line, subject.line);
		if (subject.kind === 'macro' && (subject.endLine ?? 0) <= subject.line) {
			end = subject.line;
			for (let at = subject.line; at < Math.min(lines.length, subject.line + 40); at++) {
				end = at;
				if (!lines[at]!.trimEnd().endsWith('\\')) break;
			}
		}
		return Math.min(end, lines.length - 1);
	}

	/** The header row: the kind's icon and caption, the name, and the file:line button. */
	private buildHeader(subject: DefinitionSubject): HTMLElement {
		const location = el('button', 'def-location');
		location.textContent = `${baseName(subject.path)}:${subject.line + 1}`;
		location.title = t('symbols.context.open');
		location.addEventListener('click', () => this.onOpenDefinition?.(subject.path, subject.line + 1));
		return el('div', 'def-title', [
			icon(KIND_ICONS[subject.kind] ?? 'symbol-variable'),
			el('span', 'def-name', [subject.name]),
			el('span', 'def-kind', [subject.kind]),
			location
		]);
	}

	/** The panel page's activation: the workbench's hook re-resolves the cursor symbol. */
	shown(): void {
		this.onNeedRoot?.();
	}

	private render(): void {
		this.body.textContent = '';
		if (!this.subject) {
			this.body.appendChild(el('div', 'def-hint', [this.note ?? t('definition.hint')]));
			return;
		}
		this.body.appendChild(this.buildHeader(this.subject));
		if (this.loading) {
			this.body.appendChild(el('div', 'def-hint', [icon('sync', 'codicon-modifier-spin'), t('relations.loading')]));
			return;
		}
		if (this.failed || this.fileLines === null) {
			this.body.appendChild(el('div', 'def-hint', [this.tooBig ? t('definition.tooBig') : t('relations.failed')]));
			return;
		}
		// The whole file as the live view: every line one colored span with the newline
		// as text — the pane's text content stays the code verbatim — the symbol's own
		// span marked as the selection, and the declaration scrolled into view: the
		// page's opening frame.
		const subject = this.subject;
		const selEnd = this.selectionEnd(subject, this.fileLines);
		const code = el('pre', 'def-code');
		const ext = extOf(subject.path);
		const lines = this.fileLines;
		lines.forEach((line, index) => {
			const row = el('span', 'def-line');
			row.dataset['line'] = String(index);
			if (index >= subject.line && index <= selEnd) row.classList.add('def-sel');
			for (const segment of highlightLine(line, ext)) {
				row.appendChild(segment.cls ? el('span', segment.cls, [segment.text]) : document.createTextNode(segment.text));
			}
			code.appendChild(row);
			if (index < lines.length - 1) code.appendChild(document.createTextNode('\n'));
		});
		this.body.appendChild(code);
		const declaration = this.body.querySelector<HTMLElement>(`.def-line[data-line="${subject.line}"]`);
		if (declaration && typeof declaration.scrollIntoView === 'function') declaration.scrollIntoView({ block: 'center' });
	}

	/* ---------- The click-to-relocate (chain browsing) ---------- */

	private readonly onBodyClick = (event: MouseEvent): void => {
		if (!this.fileLines) return;
		const target = event.target as HTMLElement;
		const row = target.closest<HTMLElement>('.def-line');
		if (!row?.dataset['line']) return;
		const at = this.caretOffsetIn(row, event);
		if (at < 0) return;
		const word = wordAt(this.fileLines[Number(row.dataset['line'])] ?? '', at);
		if (word === null) return;
		void this.revealWord(word);
	};

	/** The caret's character offset across the row's text — the browser's own hit test
	 *  (`caretRangeFromPoint` / `caretPositionFromPoint`), read back through the row's
	 *  text nodes. No layout (a harness), no offset. */
	private caretOffsetIn(row: HTMLElement, event: MouseEvent): number {
		const doc = document as Document & {
			caretRangeFromPoint?: (x: number, y: number) => Range | null;
			caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
		};
		let node: Node | null = null;
		let offset = 0;
		if (typeof doc.caretRangeFromPoint === 'function') {
			const range = doc.caretRangeFromPoint(event.clientX, event.clientY);
			node = range?.startContainer ?? null;
			offset = range?.startOffset ?? 0;
		} else if (typeof doc.caretPositionFromPoint === 'function') {
			const position = doc.caretPositionFromPoint(event.clientX, event.clientY);
			node = position?.offsetNode ?? null;
			offset = position?.offset ?? 0;
		}
		if (!node || !row.contains(node)) return -1;
		const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
		let at = 0;
		let current = walker.nextNode();
		while (current) {
			if (current === node) return at + offset;
			at += current.textContent?.length ?? 0;
			current = walker.nextNode();
		}
		return -1;
	}

	/** The clicked word's definition re-roots the page: the shown file's own definition
	 *  wins, then one with a body, then the first — the same preference the declaration
	 *  card reads by. A failed lookup leaves the page standing. */
	private async revealWord(word: string): Promise<void> {
		try {
			const defs = (await symbolLookup(word)) ?? [];
			if (defs.length === 0) return;
			const def = (this.subject && defs.find((entry) => entry.path === this.subject!.path)) ?? defs.find((entry) => (entry.endLine ?? entry.line) > entry.line) ?? defs[0];
			if (!def) return;
			this.setDefinition({ kind: def.kind, name: def.name, path: def.path, line: def.line, endLine: def.endLine });
		} catch {
			// The click is an affordance, never an error surface.
		}
	}

	/* ---------- The right-click sync (the page's own push into the code page) ---------- */

	/** The page's right-click: "sync the current position to the code page" — the jump
	 *  the location button makes, offered in place. Nothing stands without a subject. */
	private readonly onBodyContextMenu = (event: MouseEvent): void => {
		if (!this.subject) return;
		event.preventDefault();
		const subject = this.subject;
		const entries: MenuEntry[] = [
			{
				label: t('definition.syncToEditor'),
				run: () => this.onOpenDefinition?.(subject.path, subject.line + 1)
			}
		];
		showContextMenu(event.clientX, event.clientY, entries);
	};
}
