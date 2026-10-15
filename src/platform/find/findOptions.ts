// The find/replace options shared between the editor's find widget (M3 3.4) and the Search
// view: the same persisted `searchOptions` object, so toggling "Match Case" in one place is
// what the other reads next. The Search view keeps writing the whole object as before; the
// helpers here merge, so neither side clobbers the other's keys.

import { load, save } from '../state';

export interface FindOptions {
	caseSensitive: boolean;
	wholeWord: boolean;
	useRegex: boolean;
}

/** Read the shared options (falling back to the defaults for missing keys). */
export function findOptions(): FindOptions {
	const stored = load<Partial<FindOptions>>('searchOptions', {});
	return {
		caseSensitive: stored.caseSensitive ?? false,
		wholeWord: stored.wholeWord ?? false,
		useRegex: stored.useRegex ?? false
	};
}

/** Change one option in the shared object. */
export function updateFindOption<K extends keyof FindOptions>(key: K, value: FindOptions[K]): void {
	save('searchOptions', { ...load<Record<string, unknown>>('searchOptions', {}), [key]: value });
}

/** Whether the query carries an uppercase letter (Zed's `contains_uppercase`): a case-mapped
 *  difference, so letters without case (CJK, digits, symbols) never trigger it. */
export function queryHasUppercase(query: string): boolean {
	return query !== query.toLowerCase();
}

/** One Alt+<letter> toggle chord a find bar serves: Alt+C the case toggle, Alt+W whole
 *  word, Alt+R regex (the editor's find widget, the windowed editor's find bar, and any
 *  bar-specific extra). Fires the toggle's button and consumes the event when it is one —
 *  exactly the `else if (… && event.altKey)` chains both bars spelled before. */
export function findToggleChord(event: KeyboardEvent, chords: { key: string; button: HTMLElement }[]): boolean {
	if (!event.altKey) return false;
	const letter = event.key.toLowerCase();
	for (const chord of chords) {
		if (chord.key === letter) {
			event.preventDefault();
			chord.button.click();
			return true;
		}
	}
	return false;
}
