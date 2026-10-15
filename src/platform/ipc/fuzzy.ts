// The typed IPC seam of the Quick Open domain (plan §5.6): the server-side fuzzy file
// scoring and the editor's path completions — the ggs-index crate's fuzzy module behind
// the app's commands/fuzzy adapters (a keystroke ships rows, not the tree).
import { invoke } from './core';

/** One scored file hit: the path, a display label, and the matched ranges. */
export interface FuzzyFileHit {
	path: string;
	label: string;
	ranges: [number, number][];
}

export const fuzzyFiles = (query: string, limit: number) => invoke<FuzzyFileHit[]>('fuzzy_files', { query, limit });
export const pathCompletions = (prefix: string) => invoke<{ label: string; isDir: boolean }[]>('path_completions', { prefix });
