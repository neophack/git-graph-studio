// VS Code's quick input at the top of the window: an input box, or a filterable pick list.

import { el } from './dom';
import { icon } from './codicon';

export interface QuickPickItem {
	label: string;
	description?: string;
	detail?: string;
	icon?: string;
	value: string;
	/** Matched-character ranges in the label (rendered bold), as the fuzzy scorer reports them. */
	highlights?: [number, number][];
}

/** A large-list item source that filters off the keystroke path, as VS Code's quick access
 *  does: the scan runs in chunks, between which the input stays responsive; intermediate top
 *  rows arrive through `onPartial`; `isCancelled` aborts a scan a newer keystroke superseded. */
export interface QuickPickSource {
	query(query: string, onPartial: (items: QuickPickItem[]) => void, isCancelled: () => boolean): Promise<QuickPickItem[]>;
	/** Shown instead of the empty state while the source has nothing to show yet. */
	status?(): string | null;
}

export interface QuickInputOptions {
	title?: string;
	placeholder?: string;
	value?: string;
	/** The characters of `value` initially selected (a file name without its extension). */
	selection?: [number, number];
	validate?: (value: string) => string | null;
	/** A pick list: static, computed from what is typed, or a chunked QuickPickSource (Quick
	 *  Open's file list) whose results fill in progressively while the scan runs. */
	items?: QuickPickItem[] | ((query: string) => QuickPickItem[]) | QuickPickSource;
	/** With a pick list: Enter on free text (no match) resolves with the text itself. */
	allowFreeText?: boolean;
	/** Mask the typed text (`showInputBox({ password: true })`). */
	password?: boolean;
}

const MAX_PICK_ROWS = 60;

function isQuickPickSource(items: QuickPickItem[] | ((query: string) => QuickPickItem[]) | QuickPickSource): items is QuickPickSource {
	return typeof items === 'object' && items !== null && 'query' in items;
}

/** The label with its matched ranges bolded, as VS Code highlights picker matches. */
function applyLabelHighlights(parent: HTMLElement, label: string, ranges?: [number, number][]): void {
	parent.textContent = '';
	if (!ranges || ranges.length === 0) {
		parent.textContent = label;
		return;
	}
	let at = 0;
	for (const [start, end] of ranges) {
		if (start > at) parent.appendChild(document.createTextNode(label.slice(at, start)));
		parent.appendChild(el('b', '', [label.slice(start, end)]));
		at = end;
	}
	if (at < label.length) parent.appendChild(document.createTextNode(label.slice(at)));
}

/** Case-insensitive "every query word appears" match, as VS Code's quick pick filters. */
export function matchesQuery(text: string, query: string): boolean {
	const haystack = text.toLowerCase();
	return query.toLowerCase().split(/\s+/).filter((w) => w !== '').every((word) => haystack.includes(word));
}

/** VS Code's quick input at the top of the window: an input box, or a filterable pick list.
 *  Resolves with the value (a pick's `value`, or the typed text), or null on Escape. */
export function quickInput(options: QuickInputOptions): Promise<string | null> {
	return new Promise((resolve) => {
		const box = el('div', 'quick-input');
		const input = el('input', 'input');
		input.type = options.password === true ? 'password' : 'text';
		input.placeholder = options.placeholder ?? '';
		input.value = options.value ?? '';
		input.spellcheck = false;
		input.setAttribute('aria-label', options.title ?? options.placeholder ?? 'Input');
		const hint = el('div', 'hint');
		if (options.title) box.appendChild(el('div', 'title', [options.title]));
		box.appendChild(input);
		box.appendChild(hint);
		const list = options.items ? el('div', 'list') : null;
		if (list) box.appendChild(list);
		document.getElementById('overlays')!.appendChild(box);
		let focused = 0;
		let rows: { element: HTMLElement; item: QuickPickItem }[] = [];

		const finish = (value: string | null) => {
			generation += 1; // cancels any source scan still streaming into the list
			box.remove();
			document.removeEventListener('mousedown', onOutside, true);
			resolve(value);
		};
		const onOutside = (event: MouseEvent) => {
			if (!box.contains(event.target as Node)) finish(null);
		};
		document.addEventListener('mousedown', onOutside, true);

		// Row application is incremental: a row whose pick kept its value keeps its element and
		// only has its highlights refreshed, so progressive scans do not rebuild the list. The
		// generation counter cancels source scans a newer keystroke superseded.
		let generation = 0;
		let searching = false;
		let emptyState: HTMLElement | null = null;

		const emptyText = () => {
			if (searching) {
				const items = options.items;
				const status = items && isQuickPickSource(items) ? items.status?.() : null;
				return status ?? 'Searching…';
			}
			return input.value.trim() === '' ? 'No results' : 'No matching results';
		};

		const applyRows = (items: QuickPickItem[]) => {
			if (!list) return;
			emptyState?.remove();
			emptyState = null;
			for (let i = 0; i < items.length; i++) {
				const item = items[i]!;
				const existing = rows[i];
				if (existing && existing.item.value === item.value) {
					existing.item = item;
					applyLabelHighlights(existing.element.querySelector<HTMLElement>('.label')!, item.label, item.highlights);
				} else {
					const row = el('div', 'row', [
						item.icon ? icon(item.icon) : null,
						el('span', 'label'),
						item.description ? el('span', 'description', [item.description]) : null,
						item.detail ? el('span', 'decoration', [item.detail]) : null
					]);
					applyLabelHighlights(row.querySelector<HTMLElement>('.label')!, item.label, item.highlights);
					row.addEventListener('click', () => finish(item.value));
					if (existing) existing.element.replaceWith(row);
					else list.appendChild(row);
					rows[i] = { element: row, item };
				}
			}
			for (let i = rows.length - 1; i >= items.length; i--) rows[i]!.element.remove();
			rows.length = items.length;
			if (rows.length === 0) {
				emptyState = el('div', 'scm-empty', [emptyText()]);
				list.appendChild(emptyState);
			}
			focused = Math.min(focused, Math.max(0, rows.length - 1));
			highlight();
		};

		const runSource = async (source: QuickPickSource, query: string): Promise<void> => {
			const id = generation;
			try {
				const items = await source.query(
					query,
					(partial) => {
						if (id === generation) applyRows(partial);
					},
					() => id !== generation
				);
				if (id !== generation) return; // a newer keystroke superseded this scan
				searching = false;
				applyRows(items);
			} catch (error) {
				if (id !== generation) return;
				// A failed scan still settles the "Searching…" state; its rows are simply empty.
				searching = false;
				console.warn('quick input source failed', error);
				applyRows([]);
			}
		};

		const renderList = () => {
			if (!list || !options.items) return;
			generation += 1;
			focused = 0;
			if (isQuickPickSource(options.items)) {
				searching = true;
				if (rows.length === 0) {
					emptyState?.remove();
					emptyState = el('div', 'scm-empty', [emptyText()]);
					list.appendChild(emptyState);
				}
				void runSource(options.items, input.value.trim());
				return;
			}
			searching = false;
			const query = input.value.trim();
			const source = typeof options.items === 'function' ? options.items(query) : options.items.filter((item) => matchesQuery(item.label + ' ' + (item.description ?? ''), query));
			applyRows(source.slice(0, MAX_PICK_ROWS));
		};
		const highlight = () => {
			rows.forEach((row, index) => row.element.classList.toggle('focused', index === focused));
			rows[focused]?.element.scrollIntoView({ block: 'nearest' });
		};
		const validate = () => {
			const error = options.validate ? options.validate(input.value) : null;
			hint.textContent = error ?? '';
			hint.classList.toggle('error', error !== null);
			return error === null;
		};
		input.addEventListener('input', () => {
			validate();
			renderList();
		});
		input.addEventListener('keydown', (event) => {
			event.stopPropagation();
			if (event.key === 'Enter') {
				event.preventDefault();
				if (list) {
					const pick = rows[focused];
					if (pick) finish(pick.item.value);
					else if (options.allowFreeText && input.value.trim() !== '' && validate()) finish(input.value.trim());
					return;
				}
				if (validate()) finish(input.value);
			} else if (event.key === 'Escape') {
				event.preventDefault();
				finish(null);
			} else if (list && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
				event.preventDefault();
				if (rows.length === 0) return;
				focused = (focused + (event.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length;
				highlight();
			}
		});
		renderList();
		input.focus();
		if (options.selection) {
			input.setSelectionRange(options.selection[0], options.selection[1]);
		} else {
			input.select();
		}
	});
}

/** A pick list (branches, remotes, stashes, …); resolves with the chosen value or null. */
export function quickPick(items: QuickPickItem[], placeholder: string, title?: string): Promise<string | null> {
	return quickInput({ items, placeholder, title });
}
