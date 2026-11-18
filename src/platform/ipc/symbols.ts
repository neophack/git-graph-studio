// The typed IPC seam of the persistent symbol index (plan §5.6): the workspace store's
// lookup / tree / occurrence-narrowed references and the rebuild with its streaming
// progress — the ggs-index crate's symbols half behind the app's commands/symbols adapters.
import { invoke, type Channel } from './core';
import type { WsSymbol } from './search';

/** One symbol of the index's file tree, with the name's reference count. */
export interface TreeSymbol {
	kind: string;
	name: string;
	/** 0-based declaration line. */
	line: number;
	/** How many files the name occurs in (the index's occurrence list length). */
	refs: number;
}

export interface TreeFile {
	/** Repo-relative, forward slashes. */
	path: string;
	symbols: TreeSymbol[];
}

/** `symbol_references`: the occurrence list the index keeps, narrowed to per-file lines. */
export interface SymbolRefFile {
	path: string;
	matches: { line: number; column: number }[];
}

/** The index's status as `symbols_status` reports and `symbols_rebuild` answers with. */
export interface SymbolIndexStatus {
	state: 'empty' | 'building' | 'ready';
	done: number;
	total: number;
	files: number;
	symbols: number;
}

/** What `symbols_rebuild` pushes over its channel before the final answer. */
export type SymbolIndexEvent = { kind: 'progress'; done: number; total: number } | { kind: 'done'; files: number; symbols: number; cancelled: boolean };

export const symbolLookup = (name: string) => invoke<WsSymbol[]>('symbol_lookup', { name });

/** One scope-local definition `symbol_scope_lookup` answers: a parameter or local
 *  variable of the enclosing function, parsed out of the caller's live buffer. */
export interface ScopeDefinition {
	/** `variable` for a local, `parameter` for a function parameter. */
	kind: string;
	name: string;
	/** 0-based line and character column of the declaration's name. */
	line: number;
	column: number;
	/** 0-based line the local's reach ends on (the enclosing function's end). */
	scopeEnd: number;
}

/** The scope-local definitions of `name` covering `line` of `text`, innermost scope
 *  first — a name declared inside the enclosing function is that local or parameter,
 *  never a same-named global. Empty means the site is outside every local's scope and
 *  the caller falls back to `symbolLookup`'s global answer. */
export const symbolScopeLookup = (name: string, line: number, text: string, ext: string) =>
	invoke<ScopeDefinition[]>('symbol_scope_lookup', { name, line, text, ext });

export const symbolTree = () => invoke<TreeFile[] | null>('symbol_tree');
export const symbolReferences = (name: string) => invoke<SymbolRefFile[]>('symbol_references', { name });
export const symbolsRebuild = (onEvent: Channel<SymbolIndexEvent>) => invoke<SymbolIndexStatus | null>('symbols_rebuild', { onEvent });
