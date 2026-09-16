// The Search view: workspace-wide search and replace, as VS Code's Search sidebar - the query
// box with its case / word / regex toggles, the include and exclude fields, and results grouped
// by file. Results stream in: the backend pushes batches (in path order) over a channel as it
// scans, the list grows as they land, and typing again cancels the search in flight. The result
// tree is a plain DOM tree, like VS Code's search tree: one group per file (its header row
// followed by its match rows) in normal document flow - every row in the DOM, no windowing.

import { Channel, invoke } from '@tauri-apps/api/core';

import * as state from './state';
import { queryHasUppercase } from './findOptions';
import { FindHistory, HistoryRecall, recallKey } from './findHistory';
import { settings } from './settings';
import { actionButton, basename, confirmDialog, dirname, el, icon, notify } from './ui';

export interface SearchMatch {
	line: number;
	column: number;
	length: number;
	text: string;
}

export interface FileMatches {
	path: string;
	matches: SearchMatch[];
	/** The root (workspace folder) the path is relative to - multi-root searches set it, so
	 *  the same relative path in two roots stays two results that open in their own root. */
	root?: string;
}

/** What the backend streams: result batches, then exactly one `done`. */
export type SearchEvent =
	| { kind: 'batch'; files: FileMatches[] }
	| { kind: 'done'; scanned: number; truncated: boolean; cancelled: boolean };

export interface SearchOptions {
	caseSensitive: boolean;
	wholeWord: boolean;
	useRegex: boolean;
	include: string;
	exclude: string;
}

export const DEFAULT_OPTIONS: SearchOptions = { caseSensitive: false, wholeWord: false, useRegex: false, include: '', exclude: '' };

/** How long after the last keystroke the as-you-type search fires, as in VS Code. */
const TYPE_DEBOUNCE_MS = 300;

/** One result row: the line's text with the match span highlighted. */
export function renderMatchLine(match: SearchMatch): HTMLElement {
	const row = el('div', 'search-match');
	const text = match.text;
	// Fast path: with no surrogate pairs (the common case), UTF-16 slicing is already
	// code-point slicing. Only lines with astral characters need the Array.from walk.
	let hasSurrogates = false;
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (code >= 0xd800 && code <= 0xdfff) { hasSurrogates = true; break; }
	}
	let start: number, end: number;
	if (hasSurrogates) {
		const chars = Array.from(text);
		start = Math.max(0, Math.min(match.column - 1, chars.length));
		end = Math.max(start, Math.min(start + match.length, chars.length));
		row.append(
			document.createTextNode(chars.slice(0, start).join('')),
			el('span', 'hit', [chars.slice(start, end).join('')]),
			document.createTextNode(chars.slice(end).join(''))
		);
		return row;
	}
	start = Math.max(0, Math.min(match.column - 1, text.length));
	end = Math.max(start, Math.min(start + match.length, text.length));
	row.append(
		document.createTextNode(text.substring(0, start)),
		el('span', 'hit', [text.substring(start, end)]),
		document.createTextNode(text.substring(end))
	);
	return row;
}

/** A regex query is only valid if the backend will accept it - checked here so the view can
 *  show the error before the search runs. */
export function validateQuery(query: string, options: SearchOptions): string | null {
	if (query === '') return null;
	if (options.useRegex) {
		try {
			new RegExp(query);
			return null;
		} catch (error) {
			return `Invalid regular expression: ${String(error)}`;
		}
	}
	return null;
}

export class SearchView {
	private readonly container: HTMLElement;
	private readonly title: HTMLElement;
	private readonly content: HTMLElement;
	private readonly queryInput: HTMLInputElement;
	private readonly replaceInput: HTMLInputElement;
	private readonly replaceAllButton: HTMLButtonElement;
	private readonly includeInput: HTMLInputElement;
	private readonly excludeInput: HTMLInputElement;
	private readonly filterRows: HTMLElement;
	private readonly filterButton: HTMLElement;
	/** The fold-away replace row and the chevron that unfolds it. */
	private replaceRow: HTMLElement | null = null;
	private replaceToggleIcon: HTMLElement | null = null;
	/** VS Code's thin animated bar under the query box, shown while a search is running. */
	private readonly progress: HTMLElement;
	private readonly messageArea: HTMLElement;
	/** The scroll container of the result tree. */
	private readonly list: HTMLElement;
	/** The result tree itself: one `.search-file-group` per file, in path order. */
	private readonly listInner: HTMLElement;
	private readonly toggleButtons = new Map<keyof SearchOptions, HTMLButtonElement>();
	private query = '';
	private replacement = '';
	private options: SearchOptions = { ...DEFAULT_OPTIONS, ...state.load<Partial<SearchOptions>>('searchOptions', {}) };
	private showFilters = false;
	/** Whether the replace row is unfolded, as VS Code keeps it collapsed until asked for. */
	private showReplace = state.load<{ showReplace?: boolean }>('searchUi', {}).showReplace ?? false;
	private results: FileMatches[] = [];
	private truncated = false;
	private scanned = 0;
	private searching = false;
	private searchId = 0;
	private collapsed = new Set<string>();
	/** Each file's group element, so folding a file is a class flip on its group, not a rebuild. */
	private readonly groups = new Map<string, HTMLElement>();
	private debounceTimer: number | null = null;
	/** The fields' own query histories (findHistory.ts, Zed's `SearchHistory`): Up / Down at
	 *  a field's edges walk it, and as-you-type query refinements collapse into one entry. */
	private readonly queryHistory = new FindHistory('searchHistory.query');
	private readonly includeHistory = new FindHistory('searchHistory.include');
	private readonly excludeHistory = new FindHistory('searchHistory.exclude');
	private readonly queryRecall = new HistoryRecall(this.queryHistory);
	private readonly includeRecall = new HistoryRecall(this.includeHistory);
	private readonly excludeRecall = new HistoryRecall(this.excludeHistory);

	/** A click on a match: open the file at the position. */
	onOpenMatch: ((path: string, line: number, column: number, root?: string) => void) | null = null;

	constructor(container: HTMLElement) {
		this.container = container;
		this.title = el('div', 'sidebar-title', [el('span', 'label', ['Search'])]);
		this.content = el('div', 'view-pane');
		container.append(this.title, this.content);

		this.queryInput = el('input', 'input');
		this.replaceInput = el('input', 'input');
		this.includeInput = this.makeFilterInput('files to include (e.g. *.rs, *.ts)', 'include', this.includeRecall);
		this.excludeInput = this.makeFilterInput('files to exclude (e.g. node_modules, *.lock)', 'exclude', this.excludeRecall);
		this.filterRows = el('div', 'search-filter-rows', [
			el('div', 'search-widget', [this.includeInput]),
			el('div', 'search-widget', [this.excludeInput])
		]);
		this.replaceAllButton = actionButton('replace-all', 'Replace All', () => void this.replaceAll());
		this.filterButton = el('button', 'search-filters-toggle', [icon('ellipsis')]);
		this.progress = el('div', 'search-progress');
		this.messageArea = el('div', 'search-messages');
		this.list = el('div', 'pane-body search-results');
		this.listInner = el('div', 'search-rows');

		this.buildTitle();
		this.buildBox();
		this.list.append(this.listInner);
		this.content.append(this.progress, this.messageArea, this.list);
		this.render();
	}

	/** The roots a search runs over: one entry per open workspace folder; empty means the
	 *  single-open-folder case (the backend derives the root). The searches run one root at a
	 *  time - the backend's generation counter cancels the previous search when a new one
	 *  starts, so the roots are chained, each after the previous one's `done`. */
	private roots: string[] = [];

	setRoots(roots: string[]): void {
		this.roots = roots;
		// The old folder's results (and a search still streaming for it) must not survive the
		// switch; a Replace All after it would run the old query against the new roots.
		this.cancel();
		this.results = [];
		this.truncated = false;
		this.scanned = 0;
		this.renderResults();
		this.render();
	}

	setEnabled(hasFolder: boolean): void {
		this.container.classList.toggle('disabled', !hasFolder);
	}

	/** Focus the query box (the Search command / Ctrl+Shift+F), its text selected so typing
	 *  replaces it — a seeded query is one keystroke away from a fresh one. */
	focus(): void {
		this.queryInput.focus();
		this.queryInput.select();
	}

	/** Put `text` into the query box as the ready-made query — the workbench's Search command
	 *  seeding it from the active editor's selection (Zed's `query_suggestion`). A regex
	 *  search escapes the seed, smart case follows the seeded text, and the search runs after
	 *  the typing pause, as if it had been typed. */
	seedQuery(text: string): void {
		const value = this.options.useRegex ? text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : text;
		this.queryInput.value = value;
		this.query = value;
		this.syncSmartCase();
		this.scheduleTypedSearch();
	}

	/** VS Code's Replace in Files (Ctrl+Shift+H): the replace row unfolded and focused. */
	focusReplace(): void {
		if (!this.showReplace) this.toggleReplace();
		this.replaceInput.focus();
	}

	/* ---------- Static chrome, built once ---------- */

	private buildTitle(): void {
		this.title.appendChild(el('div', 'actions', [
			actionButton('refresh', 'Refresh Search', () => void this.runSearch()),
			actionButton('clear-all', 'Clear Search Results', () => this.clear()),
			actionButton('collapse-all', 'Collapse All', () => this.setAllCollapsed(true)),
			actionButton('expand-all', 'Expand All', () => this.setAllCollapsed(false))
		]));
		this.title.querySelector<HTMLElement>('.actions')!.style.visibility = 'visible';
	}

	/** The query area, as VS Code's search widget: one bordered composite per row, with the
	 *  option toggles living inside the query box, the replace row folded away behind a
	 *  chevron, and the include / exclude fields behind the "…" button. */
	private buildBox(): void {
		const box = el('div', 'search-box');

		const replaceToggle = el('button', 'action-btn search-replace-toggle', [icon('chevron-right', 'twistie')]);
		replaceToggle.title = 'Toggle Replace';
		replaceToggle.setAttribute('aria-label', 'Toggle Replace');
		replaceToggle.addEventListener('click', (event) => {
			event.stopPropagation();
			this.toggleReplace();
		});
		this.replaceToggleIcon = replaceToggle.querySelector('.twistie')!;

		this.queryInput.type = 'text';
		this.queryInput.placeholder = 'Search';
		this.queryInput.spellcheck = false;
		this.queryInput.value = this.query;
		this.queryInput.addEventListener('input', () => {
			this.query = this.queryInput.value;
			this.queryRecall.edited();
			this.syncSmartCase();
			this.scheduleTypedSearch();
		});
		this.queryInput.addEventListener('keydown', (event) => this.onInputKey(event, () => this.runSearchNow()));
		this.attachRecall(this.queryInput, this.queryRecall, (text) => {
			this.query = text;
			this.syncSmartCase();
			this.scheduleTypedSearch();
		});
		const queryWidget = el('div', 'search-widget', [
			this.queryInput,
			el('div', 'search-toggles', [
				this.toggle('case-sensitive', 'Match Case (Alt+C)', 'caseSensitive'),
				this.toggle('whole-word', 'Match Whole Word (Alt+W)', 'wholeWord'),
				this.toggle('regex', 'Use Regular Expression (Alt+R)', 'useRegex')
			])
		]);
		const queryRow = el('div', 'search-row query-row', [replaceToggle, queryWidget]);

		this.replaceInput.type = 'text';
		this.replaceInput.placeholder = 'Replace';
		this.replaceInput.spellcheck = false;
		this.replaceInput.value = this.replacement;
		this.replaceInput.addEventListener('input', () => {
			this.replacement = this.replaceInput.value;
		});
		this.replaceInput.addEventListener('keydown', (event) => this.onInputKey(event, null));
		const replaceRow = el('div', 'search-row replace-row', [
			el('div', 'search-widget', [this.replaceInput, this.replaceAllButton])
		]);
		this.replaceRow = replaceRow;

		this.filterButton.title = 'Toggle Include / Exclude Filters';
		this.filterButton.setAttribute('aria-label', 'Toggle Include / Exclude Filters');
		this.filterButton.addEventListener('click', () => {
			this.showFilters = !this.showFilters;
			this.filterRows.style.display = this.showFilters ? '' : 'none';
		});

		box.append(queryRow, replaceRow, this.filterButton, this.filterRows);
		this.filterRows.style.display = this.showFilters ? '' : 'none';
		this.applyReplaceVisibility();
		this.content.appendChild(box);
	}

	private toggleReplace(): void {
		this.showReplace = !this.showReplace;
		state.save('searchUi', { showReplace: this.showReplace });
		this.applyReplaceVisibility();
		if (this.showReplace) this.replaceInput.focus();
	}

	private applyReplaceVisibility(): void {
		if (!this.replaceRow) return;
		this.replaceRow.style.display = this.showReplace ? '' : 'none';
		this.replaceToggleIcon?.classList.toggle('codicon-chevron-right', !this.showReplace);
		this.replaceToggleIcon?.classList.toggle('codicon-chevron-down', this.showReplace);
	}

	private makeFilterInput(placeholder: string, key: 'include' | 'exclude', recall: HistoryRecall): HTMLInputElement {
		const input = el('input', 'input');
		input.type = 'text';
		input.placeholder = placeholder;
		input.spellcheck = false;
		input.value = this.options[key];
		input.addEventListener('input', () => {
			recall.edited();
			this.options[key] = input.value;
			state.save('searchOptions', this.options);
			this.scheduleTypedSearch();
		});
		input.addEventListener('keydown', (event) => this.onInputKey(event, () => this.runSearchNow()));
		this.attachRecall(input, recall, (text) => {
			this.options[key] = text;
			state.save('searchOptions', this.options);
			this.scheduleTypedSearch();
		});
		return input;
	}

	/** Up / Down at a field's edges walk its history (findHistory.ts, Zed's
	 *  `should_navigate_history`); a recalled value is applied exactly as typing it. */
	private attachRecall(input: HTMLInputElement, recall: HistoryRecall, apply: (text: string) => void): void {
		input.addEventListener('keydown', (event) => {
			const text = recallKey(recall, input, event);
			if (text !== null) apply(text);
		});
	}

	/** Enter searches at once; Alt+C / Alt+W / Alt+R flip the toggles, as in VS Code. */
	private onInputKey(event: KeyboardEvent, onEnter: (() => void) | null): void {
		event.stopPropagation();
		if (event.key === 'Enter' && onEnter) {
			event.preventDefault();
			onEnter();
			return;
		}
		if (event.altKey) {
			const key: keyof SearchOptions | null =
				event.key === 'c' || event.key === 'C' ? 'caseSensitive'
					: event.key === 'w' || event.key === 'W' ? 'wholeWord'
						: event.key === 'r' || event.key === 'R' ? 'useRegex'
							: null;
			if (key) {
				event.preventDefault();
				this.setOption(key, !this.options[key] as never);
			}
		}
	}

	private toggle(iconName: string, title: string, key: keyof SearchOptions): HTMLButtonElement {
		const button = el('button', 'action-btn toggle' + (this.options[key] ? ' active' : ''), [icon(iconName)]);
		button.title = title;
		button.addEventListener('click', () => this.setOption(key, !this.options[key] as never));
		this.toggleButtons.set(key, button);
		return button;
	}

	/* ---------- Search ---------- */

	private setOption<K extends keyof SearchOptions>(key: K, value: SearchOptions[K], rerun = true): void {
		this.options[key] = value;
		state.save('searchOptions', this.options);
		const button = this.toggleButtons.get(key);
		if (button) button.classList.toggle('active', Boolean(value));
		if (rerun && this.query !== '') this.runSearchNow();
	}

	/** Zed's `use_smartcase_search` (settings.searchSmartCase): the query's own case drives
	 *  the Match Case toggle — the toggle lights up, so the state stays visible and a manual
	 *  flip holds until the query's case changes again. The flip rides the search the caller
	 *  already scheduled, not one of its own. */
	private syncSmartCase(): void {
		if (!settings.searchSmartCase) return;
		const wants = queryHasUppercase(this.query);
		if (wants !== this.options.caseSensitive) this.setOption('caseSensitive', wants, false);
	}

	/** The as-you-type search: fires once typing pauses, cancelled by an explicit run. */
	private scheduleTypedSearch(): void {
		if (this.debounceTimer !== null) window.clearTimeout(this.debounceTimer);
		this.debounceTimer = window.setTimeout(() => {
			this.debounceTimer = null;
			void this.runSearch();
		}, TYPE_DEBOUNCE_MS);
	}

	private runSearchNow(): void {
		void this.runSearch();
	}

	private clear(): void {
		if (this.debounceTimer !== null) {
			window.clearTimeout(this.debounceTimer);
			this.debounceTimer = null;
		}
		this.cancel();
		this.query = '';
		this.queryInput.value = '';
		this.results = [];
		this.truncated = false;
		this.scanned = 0;
		this.renderResults();
		this.render();
	}

	/** Stop the search in flight (its remaining batches are ignored, its `done` settles it). */
	cancel(): void {
		if (!this.searching) return;
		this.searchId++;
		this.searching = false;
		void invoke('search_cancel').catch(() => undefined);
	}

	async runSearch(): Promise<void> {
		// Any explicit search supersedes the as-you-type one still on the timer.
		if (this.debounceTimer !== null) {
			window.clearTimeout(this.debounceTimer);
			this.debounceTimer = null;
		}
		const query = this.query;
		const error = validateQuery(query, this.options);
		if (error) {
			// No new search runs, so the one in flight must be cancelled here - otherwise
			// its batches still match `searchId` and repopulate the just-cleared list.
			this.cancel();
			this.results = [];
			this.truncated = false;
			this.renderResults();
			this.render(error);
			return;
		}
		if (query === '') {
			this.cancel();
			this.results = [];
			this.truncated = false;
			this.scanned = 0;
			this.renderResults();
			this.render();
			return;
		}
		// The search runs: its query and filters are what history should recall (Zed records
		// on confirmed searches; as-you-type query refinements collapse into one entry).
		this.queryHistory.add(query, 'replaceIfPrefix');
		if (this.options.include !== '') this.includeHistory.add(this.options.include);
		if (this.options.exclude !== '') this.excludeHistory.add(this.options.exclude);
		// A newer search supersedes the running one: its id moves on, so the old channel's
		// batches are dropped on arrival, and the backend stops it (the generation counter
		// behind `search_workspace` treats a new search as a cancel).
		const id = ++this.searchId;
		this.searching = true;
		this.results = [];
		this.truncated = false;
		this.scanned = 0;
		this.renderResults();
		this.render();
		const onEvent = new Channel<SearchEvent>();
		let pendingRender: number | null = null;
		// The roots of this search, in order: a single-folder workspace is one implicit root
		// (the backend derives it), a multi-root workspace one entry per open folder.
		const roots = this.roots.length > 1 ? this.roots : [undefined];
		let rootIndex = 0;
		const searchRoot = async (): Promise<void> => {
			if (id !== this.searchId) return;
			try {
				await invoke('search_workspace', {
					query,
					isRegex: this.options.useRegex,
					caseSensitive: this.options.caseSensitive,
					include: this.options.include,
					exclude: this.options.exclude,
					wordOnly: this.options.wholeWord,
					repo: roots[rootIndex],
					onEvent
				});
			} catch (err) {
				if (id !== this.searchId) return;
				this.searching = false;
				this.renderResults();
				this.render(String(err));
			}
		};
		onEvent.onmessage = (event) => {
			if (id !== this.searchId) return;
			if (event.kind === 'batch') {
				this.appendBatch(event.files, roots[rootIndex]);
				// Batches can land faster than frames; one render per frame is plenty.
				if (pendingRender === null) {
					pendingRender = requestAnimationFrame(() => {
						pendingRender = null;
						if (id === this.searchId) this.render();
					});
				}
				return;
			}
			if (pendingRender !== null) {
				cancelAnimationFrame(pendingRender);
				pendingRender = null;
			}
			if (event.cancelled) return;
			this.truncated = this.truncated || event.truncated;
			this.scanned += event.scanned;
			// The next root's search starts when this root's finished; the last one ends it.
			rootIndex++;
			if (rootIndex < roots.length) {
				void searchRoot();
				return;
			}
			this.searching = false;
			this.render();
		};
		await searchRoot();
	}

	/** Merge a streamed batch into the results and grow the tree. Batches arrive in path
	 *  order, so the common case appends: new groups go on the end, existing rows are never
	 *  touched. A batch that lands out of order (a re-search over a changed file list) falls
	 *  back to one full redraw, which puts every file in sorted position. */
	private appendBatch(files: FileMatches[], root?: string): void {
		const keyOf = (path: string, at: string | undefined): string => `${at ?? ''}/${path}`;
		let inOrder = true;
		for (const file of files) {
			const tagged = { ...file, root };
			const key = keyOf(file.path, root);
			const last = this.results[this.results.length - 1];
			const lastKey = last ? keyOf(last.path, last.root) : '';
			if (!last || lastKey < key) {
				this.results.push(tagged);
				continue;
			}
			inOrder = false;
			let low = 0;
			let high = this.results.length;
			while (low < high) {
				const mid = (low + high) >> 1;
				if (keyOf(this.results[mid]!.path, this.results[mid]!.root) < key) low = mid + 1;
				else high = mid;
			}
			if (this.results[low] && keyOf(this.results[low]!.path, this.results[low]!.root) === key) this.results[low] = tagged;
			else this.results.splice(low, 0, tagged);
		}
		if (inOrder) {
			for (const file of files) this.listInner.appendChild(this.renderFileGroup({ ...file, root }));
		} else {
			this.renderResults();
		}
	}

	async replaceAll(): Promise<void> {
		if (this.query === '' || this.results.length === 0) return;
		const count = this.results.reduce((sum, f) => sum + f.matches.length, 0);
		// VS Code's confirmation and report, word for word.
		const occurrences = (n: number) => `${n} occurrence${n === 1 ? '' : 's'}`;
		const acrossFiles = (n: number) => `${n === 1 ? '1 file' : `${n} files`}`;
		const confirmed = await confirmDialog(
			this.replacement === ''
				? `Replace ${occurrences(count)} across ${acrossFiles(this.results.length)}?`
				: `Replace ${occurrences(count)} across ${acrossFiles(this.results.length)} with '${this.replacement}'?`,
			'Replace'
		);
		if (!confirmed) return;
		try {
			let files = 0;
			let replacements = 0;
			for (const root of this.roots.length > 1 ? this.roots : [undefined]) {
				// The same matcher as the search (whole word included), so what was listed is
				// exactly what gets replaced.
				const outcome = await invoke<{ files: number; replacements: number }>('replace_in_files', {
					query: this.query,
					replacement: this.replacement,
					isRegex: this.options.useRegex,
					caseSensitive: this.options.caseSensitive,
					wordOnly: this.options.wholeWord,
					include: this.options.include,
					exclude: this.options.exclude,
					repo: root
				});
				files += outcome.files;
				replacements += outcome.replacements;
			}
			notify('info', this.replacement === ''
				? `Replaced ${occurrences(replacements)} across ${acrossFiles(files)}.`
				: `Replaced ${occurrences(replacements)} across ${acrossFiles(files)} with '${this.replacement}'.`);
		} catch (error) {
			notify('error', String(error));
			return;
		}
		await this.runSearch();
	}

	/* ---------- Rendering ---------- */

	/** Redraw the messages (summary, errors, the truncation warning) and the widget chrome.
	 *  The result tree is owned by `renderResults` / `appendBatch` and is never touched here,
	 *  so the per-frame summary refresh during a streamed search can't rebuild rows mid-list.
	 *  The query box is static DOM too and is never rebuilt, so typing never loses focus. */
	private render(error: string | null = null): void {
		this.messageArea.innerHTML = '';
		this.progress.classList.toggle('running', this.searching);
		this.replaceAllButton.disabled = this.results.length === 0;

		if (error) {
			this.messageArea.appendChild(el('div', 'search-error', [error]));
			return;
		}
		if (this.query === '') {
			this.messageArea.appendChild(el('div', 'welcome-view', [el('p', '', ['Type to search across all files in the open folder.'])]));
			return;
		}
		const total = this.results.reduce((sum, f) => sum + f.matches.length, 0);
		const header = this.searching
			? total === 0 ? 'Searching…' : `Searching… ${total} result${total === 1 ? '' : 's'} so far`
			: total === 0
				? 'No results found'
				: `${total} result${total === 1 ? '' : 's'} in ${this.results.length} file${this.results.length === 1 ? '' : 's'}`;
		this.messageArea.appendChild(el('div', 'search-summary', [header]));
		if (this.truncated) {
			this.messageArea.appendChild(el('div', 'search-warning', [
				'The result set only contains a subset of all matches. Use a more specific search term to narrow down the results.'
			]));
		}
	}

	/** Redraw the whole result tree: a new search, a clear, or the rare batch that lands out
	 *  of order. Streamed batches append through `appendBatch` instead, group by group. */
	private renderResults(): void {
		this.groups.clear();
		this.listInner.innerHTML = '';
		for (const file of this.results) this.listInner.appendChild(this.renderFileGroup(file));
	}

	/** One file's subtree, as VS Code's search tree: the header row (twistie, file icon, name,
	 *  dimmed folder, match-count badge), then its match rows - present but hidden when the
	 *  group is collapsed, so folding is a class flip with no rebuild. */
	private renderFileGroup(file: FileMatches): HTMLElement {
		const collapsed = this.collapsed.has(this.fileKey(file));
		const group = el('div', 'search-file-group' + (collapsed ? ' collapsed' : ''));
		const folder = dirname(file.path);
		const head = el('div', 'row search-file-head', [
			icon(collapsed ? 'chevron-right' : 'chevron-down', 'twistie'),
			icon('file-code'),
			el('span', 'label', [basename(file.path)]),
			folder ? el('span', 'description', [folder]) : null,
			el('span', 'badge', [String(file.matches.length)])
		]);
		head.title = file.path;
		head.addEventListener('click', () => this.setCollapsed(file, !this.collapsed.has(this.fileKey(file))));
		group.append(head);
		for (const match of file.matches) group.appendChild(this.renderMatchRow(file, match));
		this.groups.set(this.fileKey(file), group);
		return group;
	}

	private renderMatchRow(file: FileMatches, match: SearchMatch): HTMLElement {
		const line = renderMatchLine(match);
		line.classList.add('row', 'search-match');
		line.prepend(el('span', 'line-no', [String(match.line)]));
		line.title = `${file.path}:${match.line}`;
		line.addEventListener('click', () => this.onOpenMatch?.(file.path, match.line, match.column, file.root));
		return line;
	}

	/** Fold or unfold one file: the group's `collapsed` class hides its match rows, and the
	 *  twistie flips - two class toggles, however many rows the file holds. */
	/** A file's collapse/dedup key: its root and its path together, so the same relative
	 *  path under two roots stays two results. */
	private fileKey(file: FileMatches): string {
		return `${file.root ?? ''}/${file.path}`;
	}

	private setCollapsed(file: FileMatches, collapsed: boolean): void {
		if (collapsed) this.collapsed.add(this.fileKey(file));
		else this.collapsed.delete(this.fileKey(file));
		const group = this.groups.get(this.fileKey(file));
		if (!group) return;
		group.classList.toggle('collapsed', collapsed);
		const twistie = group.querySelector('.twistie');
		twistie?.classList.toggle('codicon-chevron-right', collapsed);
		twistie?.classList.toggle('codicon-chevron-down', !collapsed);
	}

	private setAllCollapsed(collapsed: boolean): void {
		for (const file of this.results) this.setCollapsed(file, collapsed);
	}
}
