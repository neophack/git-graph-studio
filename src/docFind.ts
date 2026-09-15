// The whole-file find/replace widget for the backend-rope surfaces — the windowed large-file
// editor (docEditView.ts) and the fast viewer (fastView.ts). Both hold only a slice of the
// document, so CodeMirror's in-buffer search cannot serve them: the query runs against the
// backend's rope (`viewer_find`) and the matches come back as whole-document line/column
// positions the host reveals, decorates and replaces (`viewer_replace`). Shape and keys
// match the CodeMirror widget (findWidget.ts) — the same top-right bar, the same option
// toggles shared with the Search view — minus find-in-selection, which has no meaning on a
// surface whose selection only exists inside the loaded window.

import { invoke } from '@tauri-apps/api/core';

import { findOptions, updateFindOption, type FindOptions } from './findOptions';
import { t, tf } from './i18n';
import { el, icon } from './ui';

/** One single-line match: 0-based line and code-point `[start, end)` columns — the units
 *  `viewer_find` reports and `viewer_replace` addresses. */
export interface DocFindMatch {
	line: number;
	startCol: number;
	endCol: number;
}

/** What a host surface provides; the controller stays CodeMirror-free so the fast viewer's
 *  chunk never pulls the editor bundle in. */
export interface DocFindHost {
	/** The document to search — read live, so a reopened file addresses the right rope. */
	docId(): number | null;
	/** The absolute position a fresh find anchors on: the first match at or after it is the
	 *  current one (an editor's cursor; a viewer's top line, column 0). */
	position(): { line: number; col: number };
	/** The text a single-line selection would seed the field with, or null to keep the
	 *  previous query (VS Code's behaviour). */
	seedText?(): string | null;
	/** Show a match as the current one: scroll it into view, select it (an editor) or mark
	 *  it (a viewer). Must not steal focus from the widget. */
	revealMatch(match: DocFindMatch): void;
	/** Repaint the host's match decorations from the current list. */
	paintMatches(matches: DocFindMatch[], current: DocFindMatch | null): void;
	/** Apply a replacement through the backend; absent on read-only surfaces. `from` is the
	 *  anchor — the current match for Replace, null for Replace All (the whole document). */
	replace?(spec: DocFindSpec, from: DocFindMatch | null, replacement: string, all: boolean): Promise<void>;
	/** Where Escape returns focus. */
	focusEditor(): void;
}

/** One query in flight, exactly as the backend commands spell it. */
export interface DocFindSpec {
	query: string;
	caseSensitive: boolean;
	wholeWord: boolean;
	useRegex: boolean;
}

/** Typing in the field re-runs the backend scan this late: a 200 MB rope takes a moment,
 *  and every keystroke re-scanning it would starve the window reads. */
const DEBOUNCE_MS = 250;

interface FindResult {
	matches: DocFindMatch[];
	capped: boolean;
}

/** The find/replace bar one windowed surface mounts at its top right. */
export class DocFindController {
	readonly root: HTMLElement;
	private readonly host: DocFindHost;
	private readonly editable: boolean;
	private readonly input: HTMLInputElement;
	private readonly replaceInput: HTMLInputElement;
	private readonly count: HTMLElement;
	private readonly replaceRow: HTMLElement;
	private readonly expand: HTMLElement;
	private matches: DocFindMatch[] = [];
	private capped = false;
	private current = -1;
	/** Every search bumps this; a result whose generation is stale is dropped. */
	private generation = 0;
	private timer: number | undefined;
	private showReplace = false;

	constructor(host: DocFindHost, parent: HTMLElement, editable: boolean) {
		this.host = host;
		this.editable = editable;

		this.root = el('div', 'cm-find-widget');
		this.root.hidden = true;
		const input = el('input', 'cm-find-input') as HTMLInputElement;
		input.placeholder = t('find.placeholder');
		input.setAttribute('main-field', 'true');
		input.spellcheck = false;
		this.input = input;
		this.count = el('span', 'cm-find-count');
		const replaceInput = el('input', 'cm-find-input') as HTMLInputElement;
		replaceInput.placeholder = t('find.replacePlaceholder');
		replaceInput.spellcheck = false;
		this.replaceInput = replaceInput;

		const button = (name: string, title: string, run: () => void, toggle = false) => {
			const node = el('button', 'cm-find-btn' + (toggle ? ' toggle' : ''), [icon(name)]);
			node.title = title;
			node.addEventListener('click', run);
			return node;
		};

		const findRow = el('div', 'cm-find-row');
		this.replaceRow = el('div', 'cm-find-row cm-replace-row');
		// A read-only surface has no replace row to expand; the chevron would be a dead control.
		this.expand = editable
			? button('chevron-right', t('find.toggleReplace'), () => this.setReplaceRow(!this.showReplace))
			: el('span', 'cm-find-spacer');
		const expand = this.expand;
		const prev = button('arrow-up', t('find.previous'), () => this.step(-1));
		const next = button('arrow-down', t('find.next'), () => this.step(1));
		const optionButton = (iconName: string, title: string, key: keyof FindOptions) => {
			const options = findOptions();
			const node = button(iconName, title, () => {
				const current = findOptions();
				current[key] = !current[key];
				// The toggles are shared with the Search view and the CodeMirror widget
				// (findOptions.ts persists the whole object).
				updateFindOption(key, current[key]);
				node.classList.toggle('active', current[key]);
				this.scheduleFind();
			}, true);
			node.classList.toggle('active', options[key]);
			return node;
		};
		const caseButton = optionButton('case-sensitive', t('find.matchCase'), 'caseSensitive');
		const wordButton = optionButton('whole-word', t('find.wholeWord'), 'wholeWord');
		const regexButton = optionButton('regex', t('find.useRegex'), 'useRegex');
		const close = button('close', t('find.close'), () => this.close());

		findRow.append(expand, input, this.count, prev, next, caseButton, wordButton, regexButton, close);
		if (editable) {
			this.replaceRow.append(
				el('span', 'cm-find-spacer'),
				replaceInput,
				button('replace', t('find.replace'), () => void this.replace(false)),
				button('replace-all', t('find.replaceAll'), () => void this.replace(true))
			);
		}
		this.root.append(findRow, this.replaceRow);
		parent.appendChild(this.root);

		for (const field of [this.input, replaceInput]) {
			field.addEventListener('input', () => this.scheduleFind());
			field.addEventListener('keydown', (event) => this.keydown(event, caseButton, wordButton, regexButton));
		}
	}

	get isOpen(): boolean {
		return !this.root.hidden;
	}

	/** Open the bar (with its replace row when asked and the surface is editable). */
	open(withReplace = false): void {
		this.root.hidden = false;
		if (withReplace && this.editable) this.setReplaceRow(true, true);
		const seed = this.host.seedText?.();
		if (seed !== null && seed !== undefined) this.input.value = seed;
		this.input.focus();
		this.input.select();
		this.scheduleFind(0);
	}

	close(): void {
		this.root.hidden = true;
		this.generation++;
		if (this.timer !== undefined) window.clearTimeout(this.timer);
		this.timer = undefined;
		this.host.focusEditor();
	}

	/** A host edit landed (or its window moved): re-run the debounced search so counts and
	 *  decorations follow the document. */
	refresh(): void {
		if (this.isOpen) this.scheduleFind();
	}

	/** Repaint the host from the cached match list — the host's window slid under matches
	 *  that did not change. */
	repaint(): void {
		if (this.isOpen) this.host.paintMatches(this.matches, this.matchAt(this.current));
	}

	/** Destroy the bar along with its surface. */
	destroy(): void {
		this.generation++;
		if (this.timer !== undefined) window.clearTimeout(this.timer);
		this.root.remove();
	}

	private setReplaceRow(open: boolean, focus = false): void {
		this.showReplace = open;
		this.expand.firstElementChild?.replaceWith(icon(open ? 'chevron-down' : 'chevron-right'));
		this.replaceRow.classList.toggle('open', open);
		if (focus && open) this.replaceInput.focus();
	}

	private scheduleFind(delay = DEBOUNCE_MS): void {
		if (this.timer !== undefined) window.clearTimeout(this.timer);
		this.timer = window.setTimeout(() => {
			this.timer = undefined;
			void this.runFind();
		}, delay);
	}

	private async runFind(): Promise<void> {
		const generation = ++this.generation;
		const query = this.input.value;
		const docId = this.host.docId();
		if (query === '' || docId === null) {
			this.matches = [];
			this.capped = false;
			this.current = -1;
			this.input.classList.remove('invalid');
			this.count.textContent = '';
			this.count.classList.remove('invalid');
			this.host.paintMatches([], null);
			return;
		}
		const options = findOptions();
		let result: FindResult;
		try {
			result = await invoke<FindResult>('viewer_find', {
				docId,
				query,
				caseSensitive: options.caseSensitive,
				wholeWord: options.wholeWord,
				regexp: options.useRegex
			});
		} catch (error) {
			// A newer find superseded this scan mid-rope: its result is already obsolete.
			const message = String(error);
			if (generation !== this.generation || message.includes('superseded')) return;
			if (message.includes('Invalid regular expression')) {
				this.matches = [];
				this.current = -1;
				this.input.classList.add('invalid');
				this.input.title = t('find.invalidRegex');
				this.count.textContent = '';
				this.count.classList.add('invalid');
				this.count.title = t('find.invalidRegex');
				this.host.paintMatches([], null);
				return;
			}
			this.count.textContent = '';
			this.count.title = message;
			return;
		}
		if (generation !== this.generation) return;
		this.input.classList.remove('invalid');
		this.input.title = '';
		this.count.classList.remove('invalid');
		this.count.title = '';
		this.matches = result.matches;
		this.capped = result.capped;
		this.current = this.nearest();
		this.refreshCount();
		this.host.paintMatches(this.matches, this.matchAt(this.current));
		// Typing lands on the nearest match, as VS Code's find does: revealed, not focused.
		if (this.current >= 0) this.host.revealMatch(this.matches[this.current]!);
	}

	/** The first match at or after the host's position, wrapping — the one "current" means. */
	private nearest(): number {
		if (this.matches.length === 0) return -1;
		const at = this.host.position();
		for (let index = 0; index < this.matches.length; index++) {
			const match = this.matches[index]!;
			if (match.line > at.line || (match.line === at.line && match.endCol >= at.col)) return index;
		}
		return 0;
	}

	private matchAt(index: number): DocFindMatch | null {
		return index >= 0 && index < this.matches.length ? this.matches[index]! : null;
	}

	/** Jump to the next (`1`) or previous (`-1`) match — F3's job when the bar is open. */
	step(delta: number): void {
		if (this.matches.length === 0) return;
		this.current = (this.current + delta + this.matches.length) % this.matches.length;
		const match = this.matches[this.current]!;
		this.host.revealMatch(match);
		this.host.paintMatches(this.matches, match);
		this.refreshCount();
	}

	private async replace(all: boolean): Promise<void> {
		if (!this.host.replace) return;
		if (this.matches.length === 0 || this.current < 0) return;
		if (this.input.value === '') return;
		const options = findOptions();
		const spec: DocFindSpec = {
			query: this.input.value,
			caseSensitive: options.caseSensitive,
			wholeWord: options.wholeWord,
			useRegex: options.useRegex
		};
		// Replace All works everywhere; Replace works on the current match.
		const from = all ? null : this.matches[this.current]!;
		await this.host.replace(spec, from, this.replaceInput.value, all);
		// The host re-windowed on the change; the cursor it left behind anchors the new
		// current match (the one after a just-replaced one, as VS Code steps).
		await this.runFind();
	}

	private refreshCount(): void {
		if (this.input.value === '' || this.matches.length === 0) {
			this.count.textContent = this.input.value === '' ? '' : t('find.noResults');
			return;
		}
		const index = this.current >= 0 ? this.current + 1 : 1;
		this.count.textContent = this.capped
			? tf('find.cappedResultCount', index)
			: tf('find.resultCount', index, this.matches.length);
	}

	private keydown(event: KeyboardEvent, caseButton: HTMLElement, wordButton: HTMLElement, regexButton: HTMLElement): void {
		if (event.key === 'Escape') {
			event.preventDefault();
			this.close();
		} else if (event.key === 'Enter' && event.altKey && (event.ctrlKey || event.metaKey)) {
			event.preventDefault();
			void this.replace(true);
		} else if ((event.code === 'Digit1' || event.key === '1') && event.shiftKey && (event.ctrlKey || event.metaKey)) {
			event.preventDefault();
			void this.replace(false);
		} else if (event.key === 'F3' || event.key === 'Enter') {
			event.preventDefault();
			this.step(event.shiftKey ? -1 : 1);
		} else if (event.key.toLowerCase() === 'h' && (event.ctrlKey || event.metaKey) && !event.shiftKey) {
			if (this.editable) {
				event.preventDefault();
				this.setReplaceRow(true, true);
			}
		} else if (event.key.toLowerCase() === 'c' && event.altKey) {
			event.preventDefault();
			caseButton.click();
		} else if (event.key.toLowerCase() === 'w' && event.altKey) {
			event.preventDefault();
			wordButton.click();
		} else if (event.key.toLowerCase() === 'r' && event.altKey) {
			event.preventDefault();
			regexButton.click();
		}
	}
}
