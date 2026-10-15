// The typed IPC seam of the rope viewer domain (plan §5.6): the document sessions behind
// the windowed large-file editor and the Fast Viewer — open/close, line windows, edits,
// find/replace, undo/redo, saves with streamed progress — the ggs-text crate's viewer
// engine behind the app's viewer_commands adapters. The indexed command family
// (`indexed_*`) serves the memory-bounded viewer of enormous files; its callers dispatch
// by variable and keep the raw invoke.
import { invoke, type Channel } from './core';

/** One outline symbol the viewer's symbol pass reports. */
export interface ViewerOutlineSymbol {
	kind: string;
	name: string;
	line: number;
}

/** `viewer_open`: the session handle, the document's facts and (when asked up front) the
 *  outline — consumers read the subset they opened for. */
export interface ViewerOpenInfo {
	docId: number;
	lineCount: number;
	syntaxName: string;
	/** The language id the indexed tier reports; the rope tier spells `syntaxName`. */
	language?: string;
	encoding: string;
	eol: 'lf' | 'crlf';
	symbols?: ViewerOutlineSymbol[] | null;
}

/** One window of `viewer_lines` / `indexed_lines`: rendered rows with their tokens, or
 *  plain rows the highlight pass still owes. */
export interface ViewerLinesResult {
	startLine: number;
	lineCount: number;
	lines: [string, [number, number, string][]][];
	/** True when the lines above are plain text — the tokens are owed by `viewer_highlight`. */
	tokensPending: boolean;
}

/** One window of `viewer_text`. */
export interface ViewerTextWindow {
	startLine: number;
	lineCount: number;
	lines: string[];
}

/** What `viewer_edit` answers: the document's new length, and whether the rope is back at
 *  the saved text (the dirty mark's truth). */
export interface ViewerEditResult {
	lineCount: number;
	clean?: boolean;
}

/** `viewer_undo` / `viewer_redo`: where the restored region starts, for the window swap. */
export interface ViewerHistoryResult {
	firstLine: number;
	lineCount: number;
	clean?: boolean;
}

/** `viewer_reload`: whether the file changed under the session. */
export interface ViewerReloadResult {
	changed: boolean;
	lineCount: number;
}

/** `viewer_replace`: how many replacements landed and where the first one sits. */
export interface ViewerReplaceResult {
	replacements: number;
	firstLine: number;
	lineCount: number;
	clean?: boolean;
}

/** One save-progress report: bytes of the document streamed out so far. */
export interface ViewerSaveProgress {
	written: number;
	total: number;
}

export const viewerOpen = (path: string) => invoke<ViewerOpenInfo>('viewer_open', { path });
export const viewerClose = (docId: number) => invoke<void>('viewer_close', { docId });
export const viewerLines = (docId: number, start: number, end: number) => invoke<ViewerLinesResult>('viewer_lines', { docId, start, end });
export const viewerHighlight = (docId: number, start: number, end: number) => invoke<ViewerLinesResult>('viewer_highlight', { docId, start, end });
/** The indexed tier's family — the memory-bounded viewer of enormous files. */
export const indexedOpen = (path: string) => invoke<ViewerOpenInfo>('indexed_open', { path });
export const indexedClose = (docId: number) => invoke<void>('indexed_close', { docId });
export const indexedLines = (docId: number, start: number, end: number) => invoke<ViewerLinesResult>('indexed_lines', { docId, start, end });
export const viewerText = (docId: number, start: number, end: number) => invoke<ViewerTextWindow>('viewer_text', { docId, start, end });
export const viewerEdit = (docId: number, startLine: number, endLine: number, text: string) =>
	invoke<ViewerEditResult>('viewer_edit', { docId, startLine, startCol: 0, endLine, endCol: 0, text });
export const viewerUndo = (docId: number) => invoke<ViewerHistoryResult>('viewer_undo', { docId });
export const viewerRedo = (docId: number) => invoke<ViewerHistoryResult>('viewer_redo', { docId });
export const viewerReload = (docId: number) => invoke<ViewerReloadResult>('viewer_reload', { docId });
export const viewerReplace = (docId: number, spec: { query: string; caseSensitive: boolean; wholeWord: boolean; regexp: boolean }, replacement: string, from: { line: number; startCol: number } | null, all: boolean) =>
	invoke<ViewerReplaceResult>('viewer_replace', {
		docId,
		query: spec.query,
		replacement,
		caseSensitive: spec.caseSensitive,
		wholeWord: spec.wholeWord,
		regexp: spec.regexp,
		// Replace All covers the whole document from the top; Replace covers the current
		// match, addressed by its whole-document position.
		fromLine: from ? from.line : 0,
		fromCol: from ? from.startCol : 0,
		max: all ? Number.MAX_SAFE_INTEGER : 1
	});
export const viewerSave = (docId: number, onProgress: Channel<ViewerSaveProgress>) => invoke<void>('viewer_save', { docId, onProgress });
export const viewerBackup = (docId: number) => invoke<void>('viewer_backup', { docId });
export const viewerSymbols = (docId: number) => invoke<ViewerOutlineSymbol[]>('viewer_symbols', { docId });
