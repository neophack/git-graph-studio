// Bookmarks: per-file line markers persisted in localStorage, toggled from the editor's
// context menu, listed (and jumped to) from the command palette - with gutter marks in every
// open editor.

import * as state from './state';

/** All bookmarks: file path -> 1-based lines. */
export type BookmarkMap = Record<string, number[]>;

export function loadBookmarks(): BookmarkMap {
	return state.load<BookmarkMap>('bookmarks', {});
}

function saveBookmarks(map: BookmarkMap): void {
	state.save('bookmarks', map);
}

export function toggleBookmark(path: string, line: number): void {
	const map = loadBookmarks();
	const lines = map[path] ?? [];
	const at = lines.indexOf(line);
	if (at === -1) lines.push(line);
	else lines.splice(at, 1);
	lines.sort((a, b) => a - b);
	if (lines.length === 0) delete map[path];
	else map[path] = lines;
	saveBookmarks(map);
}

export function hasBookmark(path: string, line: number): boolean {
	return (loadBookmarks()[path] ?? []).includes(line);
}

/** Every bookmark as a flat, sorted list. */
export function listBookmarks(): { path: string; line: number }[] {
	const out: { path: string; line: number }[] = [];
	for (const [path, lines] of Object.entries(loadBookmarks())) {
		for (const line of lines) out.push({ path, line });
	}
	return out.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
}

export function clearBookmarks(path?: string): void {
	if (path === undefined) saveBookmarks({});
	else {
		const map = loadBookmarks();
		delete map[path];
		saveBookmarks(map);
	}
}

export function bookmarksFor(path: string): number[] {
	return loadBookmarks()[path] ?? [];
}
