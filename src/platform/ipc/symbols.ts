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

/** `symbol_references`: the occurrence list the index keeps, narrowed to per-file lines.
 *  `line` is 1-based (the scan counts source lines from one); `column` is the 1-based
 *  character column of the hit. */
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

/** Every scope-local definition covering `line` of `text` — all parameters and locals of
 *  the enclosing function, declaration order first. The parse runs over the passed text
 *  (the editor's live buffer) with the passed extension: no folder, no index, no disk read. */
export const symbolLocals = (text: string, ext: string, line: number) =>
	invoke<ScopeDefinition[]>('symbol_locals', { text, ext, line });

export const symbolTree = () => invoke<TreeFile[] | null>('symbol_tree');
export const symbolReferences = (name: string) => invoke<SymbolRefFile[]>('symbol_references', { name });

/** What `symbol_ref_stats` answers: how many files contain `name` at all — the index's
 *  occurrence list length, the declaration's own file included (the same number the
 *  Symbol Database tree's refs badges show). */
export interface RefStats {
	files: number;
}

/** The hover card's reference-files count over the persistent index. */
export const symbolRefStats = (name: string) => invoke<RefStats>('symbol_ref_stats', { name });
export const symbolsRebuild = (onEvent: Channel<SymbolIndexEvent>) => invoke<SymbolIndexStatus | null>('symbols_rebuild', { onEvent });

/** One definition `symbol_file_outline` answers: the file's own symbol from the index. */
export interface FileOutlineSymbol {
	kind: string;
	name: string;
	/** The enclosing type for a method, null otherwise. */
	container: string | null;
	/** 0-based declaration line. */
	line: number;
	/** 0-based last line of the definition body; equals `line` when the end is unknown. */
	endLine: number;
}

/** One import of the outline's file: the imported name and its 0-based line. */
export interface FileOutlineImport {
	name: string;
	line: number;
}

/** What `symbol_file_outline` answers for one file: the index's per-file outline and
 *  the file's imports (include/module names with their lines) in source order. */
export interface FileOutline {
	symbols: FileOutlineSymbol[];
	imports: FileOutlineImport[];
}

/** The open file's outline over the persistent index — null when no folder is open. */
export const symbolFileOutline = (path: string) => invoke<FileOutline | null>('symbol_file_outline', { path });

/** One node of a relation tree (`symbol_relation_children`): a symbol that references
 *  the subject (`refsTo`) or that the subject's body references (`refsFrom`), carried
 *  with the reference site that produced the edge. */
export interface RelationNode {
	kind: string;
	name: string;
	/** The enclosing type for a method, null otherwise. */
	container: string | null;
	/** Repo-relative path and 0-based line of the node's own definition. */
	path: string;
	line: number;
	/** The earliest reference site this edge came from (repo-relative, 0-based). */
	edgePath: string;
	edgeLine: number;
	/** `call` when the site is a call site, `use` for any other reference. */
	edgeKind: string;
	/** How many reference sites this edge aggregates — 1 for a single site. */
	edgeCount: number;
	/** Whether expanding this node again yields children (best effort). */
	hasChildren: boolean;
}

/** What `symbol_relation_children` answers: the children of one relation node and
 *  whether the ring was cut short (the time budget or the node cap ran out). */
export interface RelationAnswer {
	nodes: RelationNode[];
	truncated: boolean;
}

/** The relation kinds the window drills — Source Insight's own relation-type set
 *  (2026-11-20): the three original directions plus Calls/Callers (the call edges only),
 *  their combined view, the referenced-by files/modules keys, the upward Container walk,
 *  the member rings by kind, the body's type references, and the inheritance chains the
 *  parser captures. `refsTo` doubles as `Referenced by Functions` — every edge's site is
 *  attributed to the enclosing definition already. */
export type RelationKind =
	| 'refsTo'
	| 'refsFrom'
	| 'contains'
	| 'calls'
	| 'callers'
	| 'callsAndCallers'
	| 'referencedByFunctions'
	| 'referencedByFiles'
	| 'referencedByModules'
	| 'container'
	| 'memberTypes'
	| 'memberClasses'
	| 'typesUsed'
	| 'baseClasses'
	| 'derivedClasses';

/** The original direction spellings, kept for the callers that speak them. */
export type RelationDirection = 'refsTo' | 'refsFrom' | 'contains';

/** The children of one relation node — the next ring of the box-and-arrow relation
 *  graph, computed over the persistent index. The subject is a definition: the symbol under
 *  the cursor with the location the context-symbol resolution reported for it. The kind
 *  accepts Source Insight's own view-name spellings too (`calls`, `callers`,
 *  `callsandcallers`, `referencedbyfiles`, … — the backend lower-cases and de-spaces
 *  before it matches). */
export const symbolRelationChildren = (name: string, path: string, line: number, kind: RelationKind) =>
	invoke<RelationAnswer>('symbol_relation_children', { name, path, line, direction: kind });

/** One site a rename plans to rewrite: the identifier occurrence at a 0-based line and
 *  character column, rewritten word-boundary exact. */
export interface RenameSite {
	/** Repo-relative path. */
	path: string;
	line: number;
	column: number;
}

/** What `symbol_rename_preview` answers: every site the rename would rewrite and the
 *  reasons it must not run — an empty `conflicts` means the apply is safe. */
export interface RenamePlan {
	name: string;
	sites: RenameSite[];
	files: number;
	conflicts: string[];
}

export const symbolRenamePreview = (oldName: string, newName: string) =>
	invoke<RenamePlan>('symbol_rename_preview', { oldName, newName });

/** What `symbol_rename_apply` answers: the applied totals and the per-file failures —
 *  a file that failed its post-write verification is left byte-identical. */
export interface RenameOutcome {
	applied: number;
	files: string[];
	errors: { path: string; message: string }[];
}

export const symbolRenameApply = (oldName: string, newName: string) =>
	invoke<RenameOutcome>('symbol_rename_apply', { oldName, newName });
