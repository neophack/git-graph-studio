// The Context Window (plan M4 4.7): the definition of the
// symbol under the cursor, pinned over the bottom panel. The workbench feeds it from the
// editor's cursor changes (debounced there); this view only renders what it is handed, keeps
// a pin that stops the auto-following, and opens the definition in the editor on click.
// The window is a live view too (2026-11-23, the owner's direction: the windows read
// as one coherent set): the fed fragment paints first, then the whole
// declaring file replaces it — scrolled to the declaration, the symbol's own span marked
// as the selection, files past the 1 MiB+1 ceiling keeping the fragment — and the body's
// one click relocates the window onto the clicked word's own definition, chain browsing.

import { readFile } from '../../platform/ipc/fs';
import { symbolLookup, symbolScopeLookup } from '../../platform/ipc/symbols';

import { t } from '../../platform/i18n';
import { highlightLine, extOf, wordAt } from '../../platform/highlight';
import { actionButton, el, icon, showContextMenu, type MenuEntry } from '../../platform/ui/index';

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
	parameter: 'symbol-parameter',
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

	/** The panel page's shown() asks the workbench to re-resolve the cursor symbol. */
	onNeedRoot?: () => void;

	/** Notifies the host when the user toggles the pin button. */
	onPinChange?: (pinned: boolean) => void;

	/** The index's repo-relative paths against the workspace: the hook the host wires so
	 *  the whole-file read (and the chain browse's feed) opens the absolute spelling the
	 *  backend's read_file needs. Unwired, the path passes through as-is. */
	resolvePath?: (path: string) => string;

	constructor() {
		this.body = el('div', 'context-body');
		this.body.addEventListener('click', this.onBodyClick);
		this.body.addEventListener('contextmenu', this.onBodyContextMenu);
		this.element = el('div', 'panel-body context-panel', [this.body]);
		this.element.hidden = true;
		this.pinButton = actionButton('pin', t('symbols.context.pin'), () => this.togglePin());
		this.actions = el('div', 'actions', [this.pinButton]);
		this.renderEmpty();
	}

	private togglePin(): void {
		this.setPinned(!this.pinned);
		this.onPinChange?.(this.pinned);
	}

	setPinned(pinned: boolean): void {
		this.pinned = pinned;
		this.pinButton.title = this.pinned ? t('symbols.context.unpin') : t('symbols.context.pin');
		this.pinButton.setAttribute('aria-label', this.pinButton.title);
		this.pinButton.innerHTML = '';
		this.pinButton.appendChild(icon(this.pinned ? 'pinned' : 'pin'));
		this.pinButton.classList.toggle('active', this.pinned);
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
	 *  read, or one past the ceiling keeps the fragment (or shows the refusal when
	 *  chain-browsing without a fed fragment); a newer show() drops this one. */
	private async loadWhole(definition: ContextDefinition, token: object): Promise<void> {
		const generation = ++this.generation;
		const resolved = this.resolvePath?.(definition.path) ?? definition.path;
		try {
			const file = await readFile(resolved);
			if (token !== this.currentToken || generation !== this.generation) return;
			const contents = file?.contents;
			if (contents == null) return;
			if (contents.length > FILE_MAX) {
				if (!definition.fragment) {
					this.body.textContent = '';
					this.body.appendChild(this.buildHeader(definition));
					this.body.appendChild(el('div', 'context-empty', [t('definition.tooBig')]));
				}
				return;
			}
			this.wholeLines = contents.split('\n');
		} catch {
			return; // the fragment stands
		}
		if (token !== this.currentToken) return;
		this.paint(definition, this.wholeLines!, true);
	}

	private buildHeader(definition: ContextDefinition): HTMLElement {
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
		return header;
	}

	/** The selection's last line: the index's end span, a macro whose end never reached
	 *  the index extending over its `\` continuations. */
	private selectionEnd(definition: ContextDefinition, lines: string[]): number {
		let end = Math.max(definition.endLine ?? definition.line, definition.line);
		if (definition.kind === 'macro' && (definition.endLine ?? 0) <= definition.line) {
			end = definition.line;
			for (let at = definition.line; at < Math.min(lines.length, definition.line + 40); at++) {
				end = at;
				if (!lines[at]!.trimEnd().endsWith('\\')) break;
			}
		}
		return Math.min(end, Math.max(0, lines.length - 1));
	}

	/** The window's paint: the header, then the lines — the fed fragment's slice, or the
	 *  whole file with the symbol's span marked and the declaration scrolled to. */
	private paint(definition: ContextDefinition, lines: string[], whole: boolean): void {
		this.body.textContent = '';
		const header = this.buildHeader(definition);
		// The definition's own colors: the shared tokenizer's runs, one colored span per
		// line with the newline as text — the context reads like the editor's code, and
		// the pane's text content stays the code verbatim.
		const code = el('pre', 'context-code');
		const ext = extOf(definition.path);
		const selEnd = whole ? this.selectionEnd(definition, lines) : Math.max(definition.endLine ?? definition.line, definition.line);
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
		if ((window.getSelection?.()?.toString().length ?? 0) > 0) return;
		const target = event.target as HTMLElement;
		if (target.closest('.hl-comment, .hl-string, .hl-keyword, .hl-number')) return;
		const row = target.closest<HTMLElement>('.context-line');
		if (!row?.dataset['line'] || row.dataset['line'] === '-1') return;
		const at = this.caretOffsetIn(row, event);
		if (at < 0) return;
		const line0 = Number(row.dataset['line']);
		const word = wordAt(this.wholeLines[line0] ?? '', at);
		if (word === null) return;
		void this.revealWord(word, line0);
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
	private async revealWord(word: string, line0: number): Promise<void> {
		try {
			if (this.current && this.wholeLines) {
				const ext = extOf(this.current.path);
				if (ext) {
					try {
						const locals = (await symbolScopeLookup(word, line0, this.wholeLines.join('\n'), ext)) ?? [];
						const local = locals[0];
						if (local) {
							this.show({
								kind: local.kind,
								name: local.name,
								path: this.current.path,
								line: local.line,
								endLine: local.line,
								fragment: ''
							});
							return;
						}
					} catch {
						// Scope lookup is opportunistic; fall back to the workspace index.
					}
				}
			}
			const defs = (await symbolLookup(word)) ?? [];
			if (defs.length === 0) return;
			const norm = (p: string): string => (this.resolvePath?.(p) ?? p).replaceAll('\\', '/').toLowerCase();
			const currentNorm = this.current ? norm(this.current.path) : '';
			const sameFile = this.current ? defs.filter((entry) => norm(entry.path) === currentNorm) : [];
			const def = (sameFile.length > 0
				? (sameFile.find((entry) => entry.line <= line0 && line0 <= (entry.endLine ?? entry.line))
					?? sameFile.find((entry) => (entry.endLine ?? entry.line) > entry.line)
					?? sameFile.reduce((best, entry) => Math.abs(entry.line - line0) < Math.abs(best.line - line0) ? entry : best, sameFile[0]!))
				: undefined)
				?? defs.find((entry) => (entry.endLine ?? entry.line) > entry.line)
				?? defs[0];
			if (!def) return;
			this.show({
				kind: def.kind,
				name: def.name,
				// The lookup's own spelling — the host's resolvePath resolves it against
				// the workspace for the whole-file read, the same hook the Definition
				// page's chain browse rides.
				path: def.path,
				line: def.line,
				endLine: def.endLine,
				fragment: ''
			});
		} catch {
			// The click is an affordance, never an error surface.
		}
	}

	private readonly onBodyContextMenu = (event: MouseEvent): void => {
		if (!this.current) return;
		event.preventDefault();
		const current = this.current;
		const entries: MenuEntry[] = [
			{
				label: t('definition.syncToEditor'),
				run: () => this.onOpenDefinition?.(current)
			}
		];
		showContextMenu(event.clientX, event.clientY, entries);
	};

	shown(): void {
		this.onNeedRoot?.();
	}
}
