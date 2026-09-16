// The find/replace widget (M3 3.4): the match counter's semantics, the widget's behaviour
// once mounted (typing counts, toggles apply), and the option state shared with the Search
// view through the persisted `searchOptions` object.

import { beforeEach, describe, expect, it } from 'vitest';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { SearchQuery, openSearchPanel, setSearchQuery } from '@codemirror/search';

import { countMatches, createFindPanel } from '../src/findWidget';
import { findOptions } from '../src/findOptions';
import { FindHistory, HistoryRecall } from '../src/findHistory';
import { settings } from '../src/settings';
import { search } from '@codemirror/search';
import { click, key, texts, type } from './helpers';

const DOC = 'one two One twoo\nthree one\n';

function viewOf(doc: string, selection = doc.length): EditorView {
	const host = document.createElement('div');
	document.body.appendChild(host);
	const view = new EditorView({
		state: EditorState.create({
			doc,
			selection: { anchor: selection },
			extensions: [EditorState.allowMultipleSelections.of(true), search({ top: true, createPanel: createFindPanel })]
		}),
		parent: host
	});
	return view;
}

const queryOf = (options: Partial<ConstructorParameters<typeof SearchQuery>[0]> = {}) =>
	new SearchQuery({ search: 'one', ...options });

describe('the match counter', () => {
	it('counts case-insensitively by default, and by case / whole word / regex when asked', () => {
		const view = viewOf(DOC);
		expect(countMatches(view, queryOf(), false).count).toBe(3);
		expect(countMatches(view, queryOf({ caseSensitive: true }), false).count).toBe(2);
		expect(countMatches(view, queryOf({ wholeWord: true }), false).count).toBe(3); // "twoo" drops out
		expect(countMatches(view, queryOf({ search: 'o{2}', regexp: true }), false).count).toBe(1); // "twoo"
		expect(countMatches(view, queryOf({ search: 'o{', regexp: true }), false).invalid).toBe(true);
		expect(countMatches(view, queryOf({ search: '' }), false).count).toBe(0);
	});

	it('reports the index of the match at or after the cursor', () => {
		const view = viewOf(DOC, 0);
		const state = countMatches(view, queryOf(), false);
		expect(state).toMatchObject({ count: 3, index: 1 });
		// Past the last match, the counter shows just the total.
		expect(countMatches(viewOf(DOC, DOC.length), queryOf(), false).index).toBeNull();
	});

	it('treats the match under the cursor as current, including one selected by find-next', () => {
		// A cursor inside "one" (0-3) names that match, as VS Code does.
		expect(countMatches(viewOf(DOC, 1), queryOf(), false).index).toBe(1);
		// findNext selects the match with the head at its end; the landed-on match is current.
		expect(countMatches(viewOf(DOC, 3), queryOf(), false).index).toBe(1);
		// Between matches, the next one is current.
		expect(countMatches(viewOf(DOC, 4), queryOf(), false).index).toBe(2);
		// A selection covering the second match (the widget's seed case) names it.
		const view = viewOf(DOC, 11);
		view.dispatch({ selection: { anchor: 8, head: 11 } });
		expect(countMatches(view, queryOf(), false).index).toBe(2);
	});

	it('find-in-selection keeps only the matches inside the selection', () => {
		const view = viewOf('one one one\none', 0); // head at 0; selection covers line 1 below
		view.dispatch({ selection: { anchor: 0, head: 12 } });
		expect(countMatches(view, queryOf(), true).count).toBe(3);
		expect(countMatches(view, queryOf(), false).count).toBe(4);
	});

	it('find-in-selection with several ranges ignores the matches between them', () => {
		const view = viewOf('one x one x one', 15);
		view.dispatch({
			selection: EditorSelection.create([
				EditorSelection.range(0, 3),
				EditorSelection.range(12, 15)
			])
		});
		// The middle "one" is selected by no range, so it must not be counted.
		expect(countMatches(view, queryOf(), true).count).toBe(2);
		view.destroy();
	});
});

describe('the widget', () => {
	beforeEach(() => {
		localStorage.clear();
	});

	it('counts as you type and moves through matches with the buttons', async () => {
		const view = viewOf(DOC, 0);
		openSearchPanel(view);
		const widget = view.dom.querySelector('.cm-find-widget') as HTMLElement;
		expect(widget).not.toBeNull();
		const input = widget.querySelector('.cm-find-input') as HTMLInputElement;
		input.value = 'one';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		await Promise.resolve();
		expect(widget.querySelector('.cm-find-count')!.textContent).toBe('1 of 3');
	});

	it('names the match just jumped to, not the one after it', async () => {
		const view = viewOf(DOC, 0);
		openSearchPanel(view);
		const widget = view.dom.querySelector('.cm-find-widget') as HTMLElement;
		const input = widget.querySelector('.cm-find-input') as HTMLInputElement;
		input.value = 'one';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		await Promise.resolve();
		const next = Array.from(widget.querySelectorAll('.cm-find-btn')).find((b) => b.title.startsWith('Next Match'))!;
		click(next); // lands on "one" (0-3), the head ending up at 3
		expect(view.state.selection.main.to).toBe(3);
		expect(widget.querySelector('.cm-find-count')!.textContent).toBe('1 of 3');
		click(next); // lands on "One" (8-11)
		expect(widget.querySelector('.cm-find-count')!.textContent).toBe('2 of 3');
		view.destroy();
	});

	it('refreshes the count when the query changes externally', async () => {
		const view = viewOf(DOC, 0);
		openSearchPanel(view);
		const widget = view.dom.querySelector('.cm-find-widget') as HTMLElement;
		const input = widget.querySelector('.cm-find-input') as HTMLInputElement;
		input.value = 'one';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		await Promise.resolve();
		expect(widget.querySelector('.cm-find-count')!.textContent).toBe('1 of 3');
		// Ctrl+F on a selection with the widget already open changes the query without
		// touching the doc or the selection; the count must follow immediately.
		view.dispatch({ effects: setSearchQuery.of(queryOf({ search: 'three' })) });
		expect(input.value).toBe('three');
		expect(widget.querySelector('.cm-find-count')!.textContent).toBe('1 of 1');
		view.destroy();
	});

	it('only shows 10,000+ when there really are more than 10,000 matches', async () => {
		const view = viewOf('ab '.repeat(10000), 0); // exactly 10,000 "ab"s
		openSearchPanel(view);
		const widget = view.dom.querySelector('.cm-find-widget') as HTMLElement;
		const input = widget.querySelector('.cm-find-input') as HTMLInputElement;
		input.value = 'ab';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		await Promise.resolve();
		expect(widget.querySelector('.cm-find-count')!.textContent).toBe('1 of 10000');
		view.destroy();
	});

	it('find-in-selection counts the matches instead of always reporting "No results"', async () => {
		const view = viewOf('one one one\none', 0);
		view.dispatch({ selection: { anchor: 12, head: 0 } }); // the three "one"s of line 1
		openSearchPanel(view);
		const widget = view.dom.querySelector('.cm-find-widget') as HTMLElement;
		const input = widget.querySelector('.cm-find-input') as HTMLInputElement;
		const selectionButton = Array.from(widget.querySelectorAll('.cm-find-btn')).find((b) => b.title.startsWith('Find in Selection'))!;
		click(selectionButton);
		input.value = 'one';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		await Promise.resolve();
		expect(widget.querySelector('.cm-find-count')!.textContent).toBe('1 of 3');
		view.destroy();
	});

	it('shares the option toggles with the Search view through searchOptions', async () => {
		const view = viewOf(DOC, 0);
		openSearchPanel(view);
		const widget = view.dom.querySelector('.cm-find-widget') as HTMLElement;
		const buttons = Array.from(widget.querySelectorAll('.cm-find-btn.toggle')) as HTMLElement[];
		const input = widget.querySelector('.cm-find-input') as HTMLInputElement;
		input.value = 'one';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		const caseButton = buttons.find((b) => b.title.startsWith('Match Case'))!;
		click(caseButton);
		await Promise.resolve();
		expect(caseButton.classList.contains('active')).toBe(true);
		expect(findOptions().caseSensitive).toBe(true);
		expect(JSON.parse(localStorage.getItem('ggstudio.searchOptions')!)).toMatchObject({ caseSensitive: true });
		// The count followed the option: "One" stops matching.
		expect(widget.querySelector('.cm-find-count')!.textContent).toBe('1 of 2');
		// The replace row stays hidden until expanded.
		const replaceRow = widget.querySelector('.cm-replace-row') as HTMLElement;
		expect(replaceRow.classList.contains('open')).toBe(false);
		click(Array.from(widget.querySelectorAll('.cm-find-btn')).find((b) => b.title.startsWith('Toggle Replace'))!);
		expect(replaceRow.classList.contains('open')).toBe(true);
	});

	it('resyncs its field when the query changes externally', () => {
		const view = viewOf(DOC, 0);
		openSearchPanel(view);
		const input = view.dom.querySelector('.cm-find-input') as HTMLInputElement;
		expect(input.value).toBe('');
		view.dispatch({ effects: setSearchQuery.of(queryOf({ search: 'three' })) });
		// The panel's update hook resyncs fields not being typed in.
		view.dispatch({ selection: { anchor: 1 } });
		expect(input.value).toBe('three');
	});

	it('a single-line selection seeds the field, and the seed\'s case drives Match Case', async () => {
		const view = viewOf(DOC, 4); // inside "two One twoo" line; select "One"
		view.dispatch({ selection: { anchor: 8, head: 11 } });
		openSearchPanel(view);
		const input = view.dom.querySelector('.cm-find-input') as HTMLInputElement;
		expect(input.value).toBe('One');
		// The seeded occurrence is the second of the three and stays the current match.
		expect(texts('.cm-find-count', view.dom)).toEqual(['2 of 3']);
		// Smart case follows the seeded text once the panel's creating update is done (the
		// flip dispatches, so it waits a tick): "One" turns exact, leaving the one match.
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(findOptions().caseSensitive).toBe(true);
		expect(texts('.cm-find-count', view.dom)).toEqual(['1 of 1']);
		view.destroy();
	});

	it('recalls past queries with Up and Down at the field\'s edges', () => {
		const view = viewOf(DOC, 0);
		openSearchPanel(view);
		const input = view.dom.querySelector('.cm-find-input') as HTMLInputElement;
		// Two queries typed in this widget, each remembered as it is typed; the field is
		// then cleared — the empty query is not remembered, so the draft differs from the
		// newest entry and the walk's ends are both observable.
		type(input, 'alpha');
		type(input, 'beta');
		type(input, '');
		key(input, 'ArrowUp'); // the newest query, the draft ('') stashed
		expect(input.value).toBe('beta');
		key(input, 'ArrowUp'); // the walk continues
		expect(input.value).toBe('alpha');
		key(input, 'ArrowDown');
		expect(input.value).toBe('beta');
		key(input, 'ArrowDown'); // past the newest: the stashed draft returns
		expect(input.value).toBe('');
		// Down on the live field is not history's (the browser moves the caret to the end).
		const event = key(input, 'ArrowDown');
		expect(event.defaultPrevented).toBe(false);
		// The recalled query is selected, ready to be typed over.
		key(input, 'ArrowUp');
		expect(input.selectionStart).toBe(0);
		expect(input.selectionEnd).toBe('beta'.length);
		view.destroy();
	});

	it('recalls across widgets: the windowed editor\'s bar and this one share a history', () => {
		const history = new FindHistory('findHistory');
		history.add('from-the-other-widget');
		const view = viewOf(DOC, 0);
		openSearchPanel(view);
		const input = view.dom.querySelector('.cm-find-input') as HTMLInputElement;
		type(input, 'mine');
		key(input, 'ArrowUp');
		expect(input.value).toBe('from-the-other-widget');
		view.destroy();
	});

	it('smart case: an uppercase query turns Match Case on, an all-lowercase one turns it off', async () => {
		const view = viewOf(DOC, 0);
		openSearchPanel(view);
		const widget = view.dom.querySelector('.cm-find-widget') as HTMLElement;
		const input = widget.querySelector('.cm-find-input') as HTMLInputElement;
		const caseButton = Array.from(widget.querySelectorAll('.cm-find-btn.toggle')).find((b) => b.title.startsWith('Match Case'))! as HTMLElement;
		expect(caseButton.classList.contains('active')).toBe(false);
		type(input, 'One');
		await Promise.resolve();
		expect(caseButton.classList.contains('active')).toBe(true);
		expect(findOptions().caseSensitive).toBe(true);
		expect(widget.querySelector('.cm-find-count')!.textContent).toBe('1 of 1');
		type(input, 'one');
		await Promise.resolve();
		expect(caseButton.classList.contains('active')).toBe(false);
		expect(widget.querySelector('.cm-find-count')!.textContent).toBe('1 of 3');
		view.destroy();
	});

	it('smart case off: the toggle stays wherever the user left it', async () => {
		const held = settings.searchSmartCase;
		settings.searchSmartCase = false;
		try {
			const view = viewOf(DOC, 0);
			openSearchPanel(view);
			const widget = view.dom.querySelector('.cm-find-widget') as HTMLElement;
			const input = widget.querySelector('.cm-find-input') as HTMLInputElement;
			type(input, 'One');
			await Promise.resolve();
			const caseButton = Array.from(widget.querySelectorAll('.cm-find-btn.toggle')).find((b) => b.title.startsWith('Match Case'))! as HTMLElement;
			expect(caseButton.classList.contains('active')).toBe(false);
			expect(widget.querySelector('.cm-find-count')!.textContent).toBe('1 of 3');
			view.destroy();
		} finally {
			settings.searchSmartCase = held;
		}
	});
});

describe('the query history (findHistory.ts)', () => {
	beforeEach(() => {
		localStorage.clear();
	});

	it('collapses prefix refinements and moves repeats to the end', () => {
		const history = new FindHistory('findHistory');
		history.add('foo', 'replaceIfPrefix');
		history.add('foobar', 'replaceIfPrefix'); // extends the last entry: replaces it
		history.add('foobar', 'replaceIfPrefix'); // an exact repeat grows nothing
		history.add('other');
		history.add('foo'); // re-searched: lands at the end
		expect(history.size()).toBe(3);
		expect(history.at(0)).toBe('foobar');
		expect(history.at(1)).toBe('other');
		expect(history.at(2)).toBe('foo');
	});

	it('recalls Up through the entries and Down back to the stashed draft', () => {
		const history = new FindHistory('findHistory');
		history.add('alpha');
		history.add('beta');
		const recall = new HistoryRecall(history);
		expect(recall.up('half')).toBe('beta'); // the draft is stashed, the newest shows
		expect(recall.up('half')).toBe('alpha');
		expect(recall.up('half')).toBe('alpha'); // the oldest holds
		expect(recall.down()).toBe('beta');
		expect(recall.down()).toBe('half'); // the draft returns
		expect(recall.down()).toBeNull(); // live again: the key keeps its default
	});

	it('an edit returns the cursor to the live field', () => {
		const history = new FindHistory('findHistory');
		history.add('alpha');
		history.add('beta');
		const recall = new HistoryRecall(history);
		expect(recall.up('typed')).toBe('beta');
		recall.edited();
		expect(recall.up('new draft')).toBe('beta'); // a fresh walk from the newest
		expect(recall.down()).toBe('new draft');
	});

	it('Up from the just-recorded live text skips to the previous distinct query', () => {
		const history = new FindHistory('findHistory');
		history.add('old');
		history.add('current'); // what the field shows right now
		const recall = new HistoryRecall(history);
		expect(recall.up('current')).toBe('old');
		expect(recall.down()).toBe('current');
	});
});
