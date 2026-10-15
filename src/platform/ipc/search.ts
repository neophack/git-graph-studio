// The typed IPC seam of the search domain (plan §5.6): the streaming workspace search and
// its cancellation, the batched replace, the folder comparison, and the workspace-wide
// symbol / reference scans — the ggs-index crate behind the app's commands/search adapters.
import { invoke, type Channel } from './core';

/** One match line of a search hit. */
export interface SearchMatch {
	line: number;
	column: number;
	length: number;
	text: string;
}

/** One file's worth of hits as the streaming search delivers them. */
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

/** The matcher options the search and the replace share (whole word included, so what was
 *  listed is exactly what gets replaced). */
export interface SearchMatcher {
	query: string;
	isRegex: boolean;
	caseSensitive: boolean;
	wordOnly: boolean;
	include: string;
	exclude: string;
}

/** One workspace symbol the index answers — the parser layer's additions optional. */
export interface WsSymbol {
	kind: string;
	name: string;
	path: string;
	line: number;
	/** The parser layer's additions (symbols/parse.rs); 0 / the start line when absent. */
	column?: number;
	endLine?: number;
	container?: string | null;
}

/** One file of `find_references`: the lines the name occurs on. */
export interface RefFile {
	path: string;
	matches: { line: number; column: number; length: number; text: string }[];
}

/** One row of the folder comparison. */
export interface DirDiffEntry {
	path: string;
	status: 'leftOnly' | 'rightOnly' | 'different' | 'same';
	leftSize: number;
	rightSize: number;
}

export const searchCancel = () => invoke<void>('search_cancel');
/** The streaming search: batches arrive over the channel, the promise settles when the
 *  scan is done (or cancelled — `searchCancel` makes the settle a no-error early return). */
export const searchWorkspace = (matcher: SearchMatcher, repo: string | undefined, onEvent: Channel<SearchEvent>) =>
	invoke<void>('search_workspace', { ...matcher, repo, onEvent });
export const replaceInFiles = (matcher: SearchMatcher, replacement: string, repo: string | undefined) =>
	invoke<{ files: number; replacements: number }>('replace_in_files', { ...matcher, replacement, repo });
export const compareDirs = (left: string, right: string, include: string | null, exclude: string | null) =>
	invoke<DirDiffEntry[] | null>('compare_dirs', { left, right, include, exclude });
export const findReferences = (name: string) => invoke<RefFile[]>('find_references', { name });
export const workspaceSymbols = (query: string, limit: number, repo?: string | null) =>
	invoke<WsSymbol[] | null>('workspace_symbols', { query, limit, ...(repo !== undefined && { repo }) });
