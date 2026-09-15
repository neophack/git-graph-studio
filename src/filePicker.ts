// The Quick Open file source, modelled on VS Code's anythingQuickAccess: the walked file list
// is turned into pre-lowered entries once and kept across picker opens, and every query scans
// it in chunks that yield to the event loop between slices — keystrokes are handled while the
// scan runs, and a newer keystroke aborts the superseded scan at the next chunk boundary. The
// top rows fill in progressively, ranked by the fuzzy scorer.

import { invoke } from '@tauri-apps/api/core';

import { compareFileMatches, makeQuery, scoreFile, type FileEntry, type FileMatch } from './fuzzy';
import type { QuickPickItem, QuickPickSource } from './ui';

/** Rows the picker shows at once, the budget ui.ts's quick input renders. */
const PICK_LIMIT = 60;
/** Entries scored per slice before the scan yields to the browser — big enough to finish a
 *  20,000-file tree in a handful of slices, small enough that each slice stays well under a
 *  frame, so typing never waits on the scan. */
const CHUNK = 4000;

function toEntry(path: string): FileEntry {
	// A multi-root workspace lists absolute paths, spelled with backslashes on Windows.
	const label = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);
	return { path, label, labelLower: label.toLowerCase(), pathLower: path.toLowerCase() };
}

function toItem(match: FileMatch): QuickPickItem {
	return {
		label: match.entry.label,
		description: match.entry.path,
		icon: 'file',
		value: 'file:' + match.entry.path,
		highlights: match.labelRanges
	};
}

/** The un-ranked empty-query rows: the first files as walked, nothing highlighted. */
function entryToItem(entry: FileEntry): QuickPickItem {
	return { label: entry.label, description: entry.path, icon: 'file', value: 'file:' + entry.path };
}

/** Keep `list` the best `limit` matches, sorted best-first, without re-sorting per chunk. */
function insertBounded(list: FileMatch[], match: FileMatch, limit: number): void {
	let lo = 0;
	let hi = list.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (compareFileMatches(list[mid]!, match) < 0) lo = mid + 1;
		else hi = mid;
	}
	if (lo === limit) return; // ranks below everything kept so far
	list.splice(lo, 0, match);
	if (list.length > limit) list.pop();
}

/** Hand the thread back so queued keystrokes and painting run before the next chunk. */
function yieldToUi(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

export class FilePickSource implements QuickPickSource {
	private entries: FileEntry[] = [];
	private loaded = false;
	private loading: Promise<void> | null = null;

	/** `options.backend` (the default) lets the Rust scorer answer from the open folder's
	 *  cached list; a multi-root workspace turns it off - the backend scores the first root
	 *  alone, and its rows are relative to it, so the other roots' files would never appear. */
	constructor(private readonly loadFiles: () => Promise<string[]>, private readonly options: { backend?: boolean } = {}) {}

	/** True until the first file list has landed (the picker says it is still reading files). */
	get pending(): boolean {
		return !this.loaded;
	}

	/** Adopt a freshly walked file list; the pre-lowered entries are rebuilt only when the list
	 *  actually changed, so a warm open costs one array comparison, not 20,000 allocations. */
	setFiles(files: string[]): void {
		if (this.entries.length === files.length && this.entries.every((entry, i) => entry.path === files[i])) return;
		this.entries = files.map(toEntry);
		this.loaded = true;
	}

	/** Read the file list in the background; concurrent callers share the in-flight load. */
	refresh(): Promise<void> {
		if (this.loading) return this.loading;
		this.loading = this.loadFiles()
			.then((files) => this.setFiles(files))
			.catch(() => undefined)
			.finally(() => {
				this.loading = null;
			});
		return this.loading;
	}

	/** The chunked scan. The backend scores its cached file list in Rust first (`fuzzy_files`,
	 *  `cmd_fuzzy.rs`) and ships only the top rows - a keystroke stops costing an event-loop
	 *  scan. The TS scan below is the fallback: no folder open, or a stubbed backend. */
	async query(query: string, onPartial: (items: QuickPickItem[]) => void, isCancelled: () => boolean): Promise<QuickPickItem[]> {
		const trimmed = query.trim();
		// The first query starts the list load at once (the picker's "Reading…" status follows
		// it) whether the backend or the TS scan ends up answering; later queries reuse it.
		if (!this.loaded && !this.loading) void this.refresh();
		try {
			const hits = this.options.backend === false ? null : await invoke<{ path: string; label: string; ranges: [number, number][] }[]>('fuzzy_files', { query: trimmed, limit: PICK_LIMIT });
			if (Array.isArray(hits)) {
				if (isCancelled()) return [];
				return hits.map((hit) => ({
					label: hit.label,
					description: hit.path,
					icon: 'file',
					value: 'file:' + hit.path,
					highlights: hit.ranges
				}));
			}
		} catch {
			// No backend answer (no folder open, tests): the TS scan takes over.
		}
		if (!this.loaded || this.loading) await this.refresh();
		if (trimmed === '') return this.entries.slice(0, PICK_LIMIT).map(entryToItem);
		const fuzzyQuery = makeQuery(trimmed);
		const top: FileMatch[] = [];
		for (let start = 0; start < this.entries.length; start += CHUNK) {
			const end = Math.min(this.entries.length, start + CHUNK);
			for (let i = start; i < end; i++) {
				const match = scoreFile(this.entries[i]!, fuzzyQuery);
				if (match) insertBounded(top, match, PICK_LIMIT);
			}
			if (isCancelled()) return top.map(toItem);
			onPartial(top.map(toItem));
			await yieldToUi();
		}
		return top.map(toItem);
	}

	status(): string | null {
		return this.pending ? 'Reading the file list…' : null;
	}
}
