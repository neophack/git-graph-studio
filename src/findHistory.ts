// The query history of the find and search fields, Zed's `SearchHistory`
// (crates/project/src/search_history.rs): the Up and Down arrows walk past queries with the
// half-typed draft kept so Down returns to it, and a new query either replaces the previous
// entry when it extends it (as-you-type refinements collapse into one entry) or moves its
// equal to the end. One history per field kind — the file-level find widgets share one, the
// workspace search keeps its own query, include and exclude histories — each persisted
// through the state store.

import { load, save } from './state';

/** How many queries one history keeps. */
const CAP = 50;

/** How `add` treats the query against the last entry. */
export type HistoryAddMode =
	| 'append'
	/** A query that starts with the last entry replaces it — the refinements of one search
	 *  (as-you-type runs) become one entry, Zed's `ReplacePreviousIfContains`. */
	| 'replaceIfPrefix';

export class FindHistory {
	private entries: string[];

	constructor(private readonly key: string) {
		this.entries = load<string[]>(key, []);
	}

	size(): number {
		return this.entries.length;
	}

	/** The entry at `index` (0 the oldest), or null past either end. */
	at(index: number): string | null {
		return index >= 0 && index < this.entries.length ? this.entries[index]! : null;
	}

	/** Remember `query`. The empty string never lands; an exact repeat moves to the end;
	 *  with `replaceIfPrefix` a query extending the last entry replaces it. */
	add(query: string, mode: HistoryAddMode = 'append'): void {
		if (query === '') return;
		const last = this.entries.length - 1;
		if (mode === 'replaceIfPrefix' && last >= 0 && query.startsWith(this.entries[last]!)) {
			this.entries[last] = query;
		} else {
			const at = this.entries.lastIndexOf(query);
			if (at >= 0) this.entries.splice(at, 1);
			this.entries.push(query);
		}
		while (this.entries.length > CAP) this.entries.shift();
		save(this.key, this.entries);
	}
}

/** The Up/Down recall state of one input (Zed's `SearchHistoryCursor`): index `-1` is the
 *  live field; the first Up stashes the typed text as the draft, and walking Down past the
 *  newest entry returns to it. */
export class HistoryRecall {
	private index = -1;
	private draft = '';

	constructor(private readonly history: FindHistory) {}

	/** The user typed (or cleared) the field: the cursor returns to the live end. */
	edited(): void {
		this.index = -1;
	}

	/** The previous entry, or null when the history is empty (the key keeps its default). */
	up(current: string): string | null {
		if (this.history.size() === 0) return null;
		if (this.index < 0) {
			this.draft = current;
			this.index = this.history.size() - 1;
			// The live text is usually the just-recorded newest entry (the find widgets
			// remember as they type): the first Up goes to the previous distinct query, not
			// to a repeat of what the field already shows.
			if (this.history.at(this.index) === current && this.index > 0) this.index--;
		} else if (this.index > 0) {
			this.index--;
		}
		return this.history.at(this.index);
	}

	/** The next entry, or the stashed draft past the newest one; null while the field is
	 *  live (the key keeps its default). */
	down(): string | null {
		if (this.index < 0) return null;
		this.index++;
		if (this.history.at(this.index) === null) {
			this.index = -1;
			return this.draft;
		}
		return this.history.at(this.index);
	}
}

/** The recall's keydown half: a plain Up or Down in a single-line search field walks the
 *  history instead of moving the caret (VS Code's find widgets do exactly that; Zed gates
 *  on the caret sitting at the field's edge, a protection for its multi-line query editors
 *  that a one-line `<input>` has nothing to protect). Returns the recalled text when the
 *  key was consumed; the recalled value is put in the field selected, so typing replaces
 *  it while the arrows keep walking. */
export function recallKey(recall: HistoryRecall, input: HTMLInputElement, event: KeyboardEvent): string | null {
	if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return null;
	if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return null;
	const text = event.key === 'ArrowUp' ? recall.up(input.value) : recall.down();
	if (text === null) return null;
	event.preventDefault();
	input.value = text;
	input.setSelectionRange(0, text.length);
	return text;
}
