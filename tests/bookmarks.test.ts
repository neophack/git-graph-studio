// Bookmarks: toggling per file and line, listing sorted, and clearing (one file or all).

import { beforeEach, describe, expect, it } from 'vitest';

import { bookmarksFor, clearBookmarks, hasBookmark, listBookmarks, loadBookmarks, toggleBookmark } from '../src/bookmarks';

describe('bookmarks', () => {
	beforeEach(() => {
		localStorage.clear();
	});

	it('toggles a bookmark on and off', () => {
		toggleBookmark('a.rs', 3);
		expect(hasBookmark('a.rs', 3)).toBe(true);
		expect(bookmarksFor('a.rs')).toEqual([3]);
		toggleBookmark('a.rs', 3);
		expect(hasBookmark('a.rs', 3)).toBe(false);
		expect(loadBookmarks()).toEqual({});
	});

	it('lists every bookmark sorted by path and line', () => {
		toggleBookmark('b.rs', 9);
		toggleBookmark('a.rs', 2);
		toggleBookmark('a.rs', 1);
		expect(listBookmarks()).toEqual([
			{ path: 'a.rs', line: 1 },
			{ path: 'a.rs', line: 2 },
			{ path: 'b.rs', line: 9 }
		]);
	});

	it('clears one file or everything', () => {
		toggleBookmark('a.rs', 1);
		toggleBookmark('b.rs', 1);
		clearBookmarks('a.rs');
		expect(listBookmarks()).toEqual([{ path: 'b.rs', line: 1 }]);
		clearBookmarks();
		expect(listBookmarks()).toEqual([]);
	});
});
