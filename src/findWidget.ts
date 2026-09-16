// The editor's find/replace widget (M3 3.4), VS Code's find widget in shape and behaviour:
// a compact bar over the code with the search field, the "n of m" match count, previous /
// next, the four option toggles (match case, whole word, regex, find in selection), an
// expandable replace row with replace-next / replace-all, and Escape to close. It replaces
// CodeMirror's default panel through `search({ createPanel })`, so the search keymap
// (Ctrl+F, F3 / Shift+F3, Enter / Shift+Enter) and the match highlighting all keep working;
// the option toggles are the ones shared with the Search view (`findOptions.ts`).

import {
	SearchQuery,
	closeSearchPanel,
	findNext,
	findPrevious,
	getSearchQuery,
	openSearchPanel,
	replaceAll,
	replaceNext,
	setSearchQuery
} from '@codemirror/search';
import type { EditorView, Panel, ViewUpdate } from '@codemirror/view';

import { findOptions, queryHasUppercase, updateFindOption } from './findOptions';
import { FindHistory, HistoryRecall, recallKey } from './findHistory';
import { settings } from './settings';
import { t, tf } from './i18n';
import { el, icon } from './ui';

/** How many matches are counted before the counter gives up. One past the cap is still
 *  counted, so exactly COUNT_CAP matches show the real total instead of "10,000+". */
const COUNT_CAP = 10000;

interface FindState {
	/** The number of matches (capped), and the 1-based index of the current match: the first
	 *  one ending at or after the cursor, i.e. the one containing it or selected by find-next. */
	count: number;
	index: number | null;
	/** A regexp that failed to parse shows the count field's error style. */
	invalid: boolean;
}

/** Count the query's matches over the document (capped). Pure, so the tests can run it. */
export function countMatches(view: EditorView, query: SearchQuery, inSelection: boolean): FindState {
	if (!query.search) return { count: 0, index: null, invalid: false };
	if (!query.valid) return { count: 0, index: null, invalid: true };
	// "Find in selection" keeps the matches inside some selection range; a min/max span of the
	// ranges would wrongly keep the matches in the gaps of a multi-selection.
	const ranges = inSelection ? view.state.selection.ranges : null;
	// The query builds its own cursor: case, whole-word and regex semantics all come from it.
	// It gets the full state (not just the doc) so a `test` hook sees the real selection —
	// find-in-selection's test reads state.selection, and a doc-only cursor would run it
	// against a fresh state whose selection is a single empty range at 0.
	let cursor: Iterator<{ from: number; to: number }, unknown, undefined>;
	try {
		cursor = query.getCursor(view.state);
	} catch {
		return { count: 0, index: null, invalid: true };
	}
	const head = view.state.selection.main.head;
	let count = 0;
	let index: number | null = null;
	for (let next = cursor.next(); !next.done; next = cursor.next()) {
		if (ranges && !ranges.some((range) => range.from <= next.value.from && range.to >= next.value.to)) continue;
		count++;
		if (index === null && next.value.to >= head) index = count;
		if (count > COUNT_CAP) break;
	}
	return { count, index, invalid: false };
}

/** Set by `openReplacePanel` for the panel it is about to create: the replace row starts open. */
let openWithReplace = false;
/** The open panels' replace-row toggles, so Ctrl+H on an already-open widget expands it. */
const replaceToggles = new WeakMap<EditorView, (focus: boolean) => void>();

/** VS Code's Ctrl+H: the find widget with its replace row expanded and the replace field
 *  focused (the widget opens first when it is not showing). */
export function openReplacePanel(view: EditorView): boolean {
	if (view.state.readOnly) return false;
	const toggle = replaceToggles.get(view);
	if (toggle) {
		toggle(true);
		return true;
	}
	openWithReplace = true;
	try {
		const opened = openSearchPanel(view);
		// The panel focused its find field on open; VS Code lands in the replace field.
		replaceToggles.get(view)?.(true);
		return opened;
	} finally {
		openWithReplace = false;
	}
}

/** Build the panel `search({ createPanel })` mounts in place of CodeMirror's default. */
export function createFindPanel(view: EditorView): Panel {
	const options = findOptions();
	let inSelection = false;
	let showReplace = openWithReplace && !view.state.readOnly;
	// The query history shared with the windowed editor's bar (findHistory.ts): typed
	// refinements collapse into one entry, Up / Down at the field's edges walk it.
	const history = new FindHistory('findHistory');
	const recall = new HistoryRecall(history);

	const dom = el('div', 'cm-find-widget');
	const input = el('input', 'cm-find-input') as HTMLInputElement;
	input.placeholder = t('find.placeholder');
	input.setAttribute('main-field', 'true');
	input.spellcheck = false;
	const count = el('span', 'cm-find-count');
	const replaceInput = el('input', 'cm-find-input') as HTMLInputElement;
	replaceInput.placeholder = t('find.replacePlaceholder');
	replaceInput.spellcheck = false;

	const iconButton = (name: string, title: string, run: () => void, toggle = false) => {
		const button = el('button', 'cm-find-btn' + (toggle ? ' toggle' : ''), [icon(name)]);
		button.title = title;
		button.addEventListener('click', run);
		return button;
	};

	const query = (): SearchQuery => new SearchQuery({
		search: input.value,
		replace: replaceInput.value,
		caseSensitive: options.caseSensitive,
		wholeWord: options.wholeWord,
		regexp: options.useRegex,
		// "Find in selection" keeps only the matches inside the (multi-)selection.
		test: inSelection
			? (_match, state, from, to) => state.selection.ranges.some((range) => range.from <= from && range.to >= to)
			: undefined
	});

	const refreshCount = (): void => {
		const state = countMatches(view, query(), inSelection);
		count.classList.toggle('invalid', state.invalid);
		if (state.invalid) {
			count.textContent = '';
			input.classList.add('invalid');
			input.title = t('find.invalidRegex');
			return;
		}
		input.classList.remove('invalid');
		input.title = '';
		if (input.value === '') {
			count.textContent = '';
			return;
		}
		count.textContent = state.count === 0
			? t('find.noResults')
			: state.count > COUNT_CAP
				? '10,000+'
				: state.index !== null ? tf('find.resultCount', state.index, state.count) : `${state.count}`;
	};

	const apply = (): void => {
		// The panel's update hook sees the setSearchQuery effect and refreshes the count.
		view.dispatch({ effects: setSearchQuery.of(query()) });
	};

	// The toggles share their state with the Search view (findOptions.ts).
	const optionButton = (iconName: string, title: string, key: 'caseSensitive' | 'wholeWord' | 'useRegex') => {
		const button = iconButton(iconName, title, () => {
			options[key] = !options[key];
			updateFindOption(key, options[key]);
			button.classList.toggle('active', options[key]);
			apply();
		}, true);
		button.classList.toggle('active', options[key]);
		return button;
	};
	const caseButton = optionButton('case-sensitive', t('find.matchCase'), 'caseSensitive');
	const wordButton = optionButton('whole-word', t('find.wholeWord'), 'wholeWord');
	const regexButton = optionButton('regex', t('find.useRegex'), 'useRegex');
	const selectionButton = iconButton('selection', t('find.inSelection'), () => {
		inSelection = !inSelection;
		selectionButton.classList.toggle('active', inSelection);
		apply();
	}, true);

	const findRow = el('div', 'cm-find-row');
	const replaceRow = el('div', 'cm-find-row cm-replace-row');
	const setReplace = (open: boolean, focus = false): void => {
		showReplace = open;
		expand.firstElementChild?.replaceWith(icon(showReplace ? 'chevron-down' : 'chevron-right'));
		replaceRow.classList.toggle('open', showReplace);
		if (focus && showReplace) replaceInput.focus();
	};
	const expand = iconButton(showReplace ? 'chevron-down' : 'chevron-right', t('find.toggleReplace'), () => setReplace(!showReplace));
	if (showReplace) replaceRow.classList.add('open');
	replaceToggles.set(view, (focus) => setReplace(true, focus));
	const prev = iconButton('arrow-up', t('find.previous'), () => void findPrevious(view));
	const next = iconButton('arrow-down', t('find.next'), () => void findNext(view));
	const close = iconButton('close', t('find.close'), () => closeSearchPanel(view));

	findRow.append(expand, input, count, prev, next, caseButton, wordButton, regexButton, selectionButton, close);
	replaceRow.append(el('span', 'cm-find-spacer'), replaceInput,
		iconButton('replace', t('find.replace'), () => void replaceNext(view)),
		iconButton('replace-all', t('find.replaceAll'), () => void replaceAll(view)));
	dom.append(findRow, replaceRow);

	// A single-line selection seeds the field, as VS Code's widget does.
	const seed = view.state.selection.main;
	if (!seed.empty && view.state.doc.lineAt(seed.from).number === view.state.doc.lineAt(seed.to).number) {
		input.value = view.state.sliceDoc(seed.from, seed.to);
	} else {
		const current = getSearchQuery(view.state);
		input.value = current.search;
		replaceInput.value = current.replace;
	}

	const keydown = (event: KeyboardEvent): void => {
		if (event.key === 'Escape') {
			event.preventDefault();
			closeSearchPanel(view);
			view.focus();
		} else if (event.key === 'Enter' && event.altKey && (event.ctrlKey || event.metaKey)) {
			// Ctrl+Alt+Enter replaces every match, from either field (VS Code's binding).
			event.preventDefault();
			history.add(input.value);
			void replaceAll(view);
		} else if (event.key === 'Enter' && event.target === replaceInput) {
			// Enter in the replace field replaces the current match and moves to the next.
			event.preventDefault();
			history.add(input.value);
			void replaceNext(view);
		} else if (event.key === 'Enter') {
			event.preventDefault();
			history.add(input.value);
			void (event.shiftKey ? findPrevious(view) : findNext(view));
		} else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
			// The query field's Up / Down at its edges walk the history (findHistory.ts).
			if (event.target === input && recallKey(recall, input, event) !== null) apply();
		} else if ((event.code === 'Digit1' || event.key === '1') && event.shiftKey && (event.ctrlKey || event.metaKey)) {
			event.preventDefault();
			void replaceNext(view);
		} else if (event.key.toLowerCase() === 'c' && event.altKey) {
			event.preventDefault();
			caseButton.click();
		} else if (event.key.toLowerCase() === 'w' && event.altKey) {
			event.preventDefault();
			wordButton.click();
		} else if (event.key.toLowerCase() === 'r' && event.altKey) {
			event.preventDefault();
			regexButton.click();
		} else if (event.key.toLowerCase() === 'l' && event.altKey) {
			event.preventDefault();
			selectionButton.click();
		}
	};
	for (const field of [input, replaceInput]) {
		field.addEventListener('input', apply);
		field.addEventListener('keydown', keydown);
	}
	// The query field's own behaviours: typing is remembered and drives the smart-case
	// toggle (Zed's use_smartcase_search — the toggle lights up, so the state stays visible).
	input.addEventListener('input', () => {
		recall.edited();
		history.add(input.value, 'replaceIfPrefix');
		if (settings.searchSmartCase && queryHasUppercase(input.value) !== options.caseSensitive) caseButton.click();
	});
	// A seeded field (a single-line selection, or a prior query) follows the seed's case too.
	// The panel is created inside a view update, where dispatching is not allowed - the
	// click (whose apply dispatches) waits until the update has finished, and only runs
	// while the panel still lives.
	if (settings.searchSmartCase && queryHasUppercase(input.value) !== options.caseSensitive) {
		window.setTimeout(() => {
			if (dom.isConnected) caseButton.click();
		}, 0);
	}

	// No dispatch here: the panel is created inside a view update, where dispatching is not
	// allowed - the opener has already seeded the query, so only the count needs computing.
	refreshCount();
	return {
		dom,
		top: true,
		update(update: ViewUpdate): void {
			// An external setSearchQuery (the keymap's Ctrl+F on a selection) resyncs the fields.
			// Such a transaction touches neither the doc nor the selection, so it must refresh
			// the count itself - otherwise it keeps describing the previous query.
			const requery = update.transactions.some((tr) => tr.effects.some((effect) => effect.is(setSearchQuery)));
			if (requery) {
				const current = getSearchQuery(update.state);
				if (current.search !== input.value && document.activeElement !== input) input.value = current.search;
			}
			if (requery || update.docChanged || update.selectionSet) refreshCount();
		},
		destroy(): void {
			replaceToggles.delete(view);
			dom.remove();
		}
	};
}
