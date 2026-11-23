// The Context Window (plan M4 4.7): the definition of the
// symbol under the cursor, pinned over the bottom panel. The workbench feeds it from the
// editor's cursor changes (debounced there); this view only renders what it is handed, keeps
// a pin that stops the auto-following, and opens the definition in the editor on click.
// The window is a live view too (2026-11-23, the si4-rea reconstruction's
// SPEC-ui-references-definition §2): the fed fragment paints first, then the whole
// declaring file replaces it — scrolled to the declaration, the symbol's own span marked
// as the selection, files past the 1 MiB+1 ceiling keeping the fragment — and the body's
// one click relocates the window onto the clicked word's own definition, chain browsing.

import { readFile } from '../../platform/ipc/fs';
import { symbolLookup } from '../../platform/ipc/symbols';

import { t } from '../../platform/i18n';
import { highlightLine, extOf, wordAt } from '../../platform/highlight';
import { actionButton, el, icon } from '../../platform/ui/index';

/** What the workbench resolved the symbol under the cursor to. */
export interface ContextDefinition {
	kind: string;
	name: string;
	/** Absolute path of the declaring file. */
	path: string;
	/** 0-based declaration line. */
	line: number;
	/** 0-based line the body ends on (the index's end_line; the whole-file view marks
	 *  the span, the fed fragment ignores it). */
	endLine?: number;
	/** The source fragment around the declaration, already sliced. */
	fragment: string;
}

/** The codicon for a symbol kind, spelled as the Outline's icons are. The Symbol
 *  Database page renders the same kinds. The table covers every kind the parser layer
 *  produces (store.rs's KINDS order) plus the scope parser's, so a kind never falls to
 *  the bare variable icon — every kind gets its own picture. */
export const KIND_ICONS: Record<string, string> = {
	function: 'symbol-method',
	method: 'symbol-method',
	class: 'symbol-class',
	struct: 'symbol-structure',
	union: 'symbol-structure',
	file: 'file-code',
	interface: 'symbol-interface',
	enum: 'symbol-enum',
	enumMember: 'symbol-enum-member',
	constant: 'symbol-constant',
	member: 'symbol-property',
	property: 'symbol-property',
	field: 'symbol-field',
	namespace: 'symbol-namespace',
	module: 'symbol-module',
	package: 'symbol-module',
	type: 'symbol-type-parameter',
	typedef: 'symbol-type-parameter',
	typeParameter: 'symbol-type-parameter',
	macro: 'symbol-snippet',
	label: 'symbol-keyword',
	variable: 'symbol-variable'
};

/** The file-level ceiling — past it the fed fragment stays instead of the whole file
 *  (SPEC-ui-references-definition §2.2). */
const FILE_MAX = 1024 * 1024 + 1;

export class ContextView {
	readonly element: HTMLElement;
	readonly actions: HTMLElement;
	private readonly body: HTMLElement;
	private readonly pinButton: HTMLButtonElement;
	private pinned = false;
	/** The subject the window shows — the identity the async whole-file read answers to. */
	private current: ContextDefinition | null = null;
	private currentToken: object | null = null;
	/** The whole file's lines once read for the current subject — null keeps the fragment. */
	private wholeLines: string[] | null = null;
	/** Invalidates an older whole-file read against a newer show(). */
	private generation = 0;

	onOpenDefinition: ((definition: ContextDefinition) => void) | null = null;

	/** The index's repo-relative paths against the workspace: the hook the host wires so
	 *  the whole-file read (and the chain browse's feed) opens the absolute spelling the
	 *  backend's read_file needs. Unwired, the path passes through as-is. */
	resolvePath?: (path: string) => string;

	constructor() {
		this.body = el('div', 'context-body');
		this.body.addEventListener('click', this.onBodyClick);
		this.element = el('div', 'panel-body context-panel', [this.body]);
		this.element.hidden = true;
		this.pinButton = actionButton('pin', t('symbols.context.pin'), () => this.togglePin());
		this.actions = el('div', 'actions', [this.pinButton]);
		this.renderEmpty();
	}

	private togglePin(): void {
		this.pinned = !this.pinned;
		this.pinButton.title = this.pinned ? t('symbols.context.unpin') : t('symbols.context.pin');
		this.pinButton.setAttribute('aria-label', this.pinButton.title);
		this.pinButton.innerHTML = '';
		this.pinButton.appendChild(icon(this.pinned ? 'pinned' : 'pin'));
		this.element.classList.toggle('pinned', this.pinned);
	}

	/** While pinned, the auto-following pauses: the cursor can roam without wiping the view. */
	isPinned(): boolean {
		return this.pinned;
	}

	definition(): ContextDefinition | null {
		return this.current;
	}

	private renderEmpty(message = t('symbols.context.empty')): void {
		this.current = null;
		this.currentToken = null;
		this.wholeLines = null;
		this.body.textContent = '';
		this.body.appendChild(el('div', 'context-empty', [message]));
	}

	/** Show a resolved definition (or, with null, the resting text; `note` explains why).
	 *  The fed fragment paints at once; the whole file's read replaces it when it lands. */
	show(definition: ContextDefinition | null, note?: string): void {
		if (!definition) {
			this.renderEmpty(note);
			return;
		}
		const token = {};
		this.current = definition;
		this.currentToken = token;
		this.wholeLines = null;
		this.paint(definition, definition.fragment.split('\n'), false);
		void this.loadWhole(definition, token);
	}

	/** The whole declaring file: the live view's document. A vanished file, a failed
	 *  read, or one past the ceiling keeps the fragment; a newer show() drops this one. */
	private async loadWhole(definition: ContextDefinition, token: object): Promise<void> {
		const generation = ++this.generation;
		try {
			const file = await readFile(this.resolvePath?.(definition.path) ?? definition.path);
			if (token !== this.currentToken || generation !== this.generation) return;
			const contents = file?.contents;
			if (contents == null || contents.length > FILE_MAX) return;
			this.wholeLines = contents.split('\n');
		} catch {
			return; // the fragment stands
		}
		if (token !== this.currentToken) return;
		this.paint(definition, this.wholeLines!, true);
	}

	/** The window's paint: the header, then the lines — the fed fragment's slice, or the
	 *  whole file with the symbol's span marked and the declaration scrolled to. */
	private paint(definition: ContextDefinition, lines: string[], whole: boolean): void {
		this.body.textContent = '';
		const header = el('div', 'context-header', [
			icon(KIND_ICONS[definition.kind] ?? 'symbol-variable'),
			el('span', 'context-name', [definition.name]),
			el('span', 'context-kind', [definition.kind])
		]);
		const location = el('button', 'context-location');
		location.textContent = `${definition.path.split(/[\\/]/).pop()}:${definition.line + 1}`;
		location.title = t('symbols.context.open');
		location.addEventListener('click', () => this.onOpenDefinition?.(definition));
		header.appendChild(location);
		// The definition's own colors: the shared tokenizer's runs, one colored span per
		// line with the newline as text — the context reads like the editor's code, and
		// the pane's text content stays the code verbatim.
		const code = el('pre', 'context-code');
		const ext = extOf(definition.path);
		const selEnd = Math.max(definition.endLine ?? definition.line, definition.line);
		lines.forEach((line, index) => {
			const row = el('span', 'context-line');
			if (whole && index >= definition.line && index <= selEnd) row.classList.add('context-sel');
			row.dataset['line'] = whole ? String(index) : '-1';
			for (const segment of highlightLine(line, ext)) {
				row.appendChild(segment.cls ? el('span', segment.cls, [segment.text]) : document.createTextNode(segment.text));
			}
			code.appendChild(row);
			if (index < lines.length - 1) code.appendChild(document.createTextNode('\n'));
		});
		this.body.append(header, code);
		if (whole) {
			const declaration = this.body.querySelector<HTMLElement>(`.context-line[data-line="${definition.line}"]`);
			if (declaration && typeof declaration.scrollIntoView === 'function') declaration.scrollIntoView({ block: 'center' });
		}
	}

	/* ---------- The click-to-relocate (chain browsing) ---------- */

	private readonly onBodyClick = (event: MouseEvent): void => {
		if (this.wholeLines === null) return; // the fragment's rows carry no line coordinates
		const target = event.target as HTMLElement;
		const row = target.closest<HTMLElement>('.context-line');
		if (!row?.dataset['line'] || row.dataset['line'] === '-1') return;
		const at = this.caretOffsetIn(row, event);
		if (at < 0) return;
		const word = wordAt(this.wholeLines[Number(row.dataset['line'])] ?? '', at);
		if (word === null) return;
		void this.revealWord(word);
	};

	/** The caret's character offset across the row's text — the browser's own hit test,
	 *  read back through the row's text nodes. No layout (a harness), no offset. */
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

	/** The clicked word's definition re-roots the window — the same resolution the
	 *  workbench feeds by, resolved here for the chain browsing. */
	private async revealWord(word: string): Promise<void> {
		try {
			const defs = (await symbolLookup(word)) ?? [];
			if (defs.length === 0) return;
			const def = (this.current && defs.find((entry) => entry.path === this.current!.path)) ?? defs.find((entry) => (entry.endLine ?? entry.line) > entry.line) ?? defs[0];
			if (!def) return;
			this.show({
				kind: def.kind,
				name: def.name,
				// The lookup's own spelling — the host's resolvePath resolves it against
				// the workspace for the whole-file read, the same hook the Definition
				// page's chain browse rides.
				path: def.path,
				line: def.line,
				fragment: ''
			});
		} catch {
			// The click is an affordance, never an error surface.
		}
	}

	shown(): void {
		// Nothing to load lazily - the workbench pushes into this view.
	}
}
