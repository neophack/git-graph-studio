// The find/replace widget (M3 3.4): the match counter's semantics, the widget's behaviour
// once mounted (typing counts, toggles apply), and the option state shared with the Search
// view through the persisted `searchOptions` object.

import { beforeEach, describe, expect, it } from 'vitest';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { SearchQuery, openSearchPanel, setSearchQuery } from '@codemirror/search';

import { countMatches, createFindPanel } from '../src/findWidget';
import { findOptions } from '../src/findOptions';
import { search } from '@codemirror/search';
import { click, texts } from './helpers';

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

	it('a single-line selection seeds the field', () => {
		const view = viewOf(DOC, 4); // inside "two One twoo" line; select "One"
		view.dispatch({ selection: { anchor: 8, head: 11 } });
		openSearchPanel(view);
		const input = view.dom.querySelector('.cm-find-input') as HTMLInputElement;
		expect(input.value).toBe('One');
		// The seeded occurrence is the second of the three and stays the current match.
		expect(texts('.cm-find-count', view.dom)).toEqual(['2 of 3']);
		view.destroy();
	});
});
