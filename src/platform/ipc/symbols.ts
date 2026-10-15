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
export const symbolTree = () => invoke<TreeFile[] | null>('symbol_tree');
export const symbolReferences = (name: string) => invoke<SymbolRefFile[]>('symbol_references', { name });
export const symbolsRebuild = (onEvent: Channel<SymbolIndexEvent>) => invoke<SymbolIndexStatus | null>('symbols_rebuild', { onEvent });
