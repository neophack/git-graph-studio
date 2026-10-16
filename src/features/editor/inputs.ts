// The editor input vocabulary: the input union, the Editor record every view of a
// document carries, the input ids/titles/icons and the encoding labels.

import type { Text } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import type { MergeView } from '@codemirror/merge';
import type { FastView, HexView, HexCompareView } from '../viewers/types';
import type { CanLogView, CanRawView } from '../can/types';
import type { EditableDocView } from './docEditView';
import type { FileHistoryView } from '../scm/types';
import type { CallTreeView, WsSymbol } from '../search/types';
import type { FolderCompareView, MergeToolbar } from '../compare/types';
import type { DiffSide } from './types';

/** The Code Analysis tabs' labels and icons (module 17): English, like every tab label —
 *  the pages' own text goes through `t()`. */
export const ANALYSIS_PAGE_LABELS: Record<import('../analysis').AnalysisToolId, string> = {
	modules: 'Module Analysis',
	metrics: 'Complexity & Hotspots',
	deadcode: 'Dead Code',
	security: 'Security Scan',
	imports: 'Import Graph',
	mcp: 'MCP Server'
};
export const ANALYSIS_PAGE_ICONS: Record<import('../analysis').AnalysisToolId, string> = {
	modules: 'symbol-module',
	metrics: 'pulse',
	deadcode: 'circle-slash',
	security: 'shield',
	imports: 'type-hierarchy-sub',
	mcp: 'plug'
};


/** The encodings the status bar offers (mirrors `encoding::ENCODINGS`; the backend's list wins). */
export const ENCODING_LABELS: Record<string, string> = {
	utf8: 'UTF-8', utf8bom: 'UTF-8 with BOM', 'utf-16le': 'UTF-16 LE', 'utf-16be': 'UTF-16 BE',
	gb18030: 'GB18030 (GBK)', big5: 'Big5', shift_jis: 'Shift JIS', 'euc-kr': 'EUC-KR',
	'windows-1252': 'Western (Windows 1252)', 'iso-8859-1': 'Western (ISO 8859-1)'
};


export type EditorInput =
	| { kind: 'file'; path: string }
	| { kind: 'diff'; id: string; title: string; repo?: string; binaryNotice?: boolean; left: DiffSide; right: DiffSide }
	| { kind: 'content'; id: string; title: string; path: string; text: string }
	| { kind: 'folders'; id: string; left: string; right: string }
	| { kind: 'calltree'; id: string; symbol: WsSymbol }
	| { kind: 'symboldb'; id: string }
	| { kind: 'analysis'; id: string; tool: import('../analysis').AnalysisToolId; folders?: string[] }
	| { kind: 'help'; help: 'welcome' | 'shortcuts' }
	| { kind: 'selftest'; id: string }
	| { kind: 'providers'; id: string }
	| { kind: 'markdown'; path: string }
	| { kind: 'history'; path: string }
	| { kind: 'hex'; path: string }
	| { kind: 'canlog'; path: string }
	| { kind: 'extpage'; id: string; title: string; extId: string; pageId: string; params?: unknown }
	| { kind: 'extdetail'; id: string; title: string; extId: string };


export interface Editor {
	input: EditorInput;
	id: string;
	label: string;
	description?: string;
	iconClass?: string;
	iconSrc?: string;
	pane: HTMLElement;
	/** The symbol outline beside the editor, shown while the "show code outline" setting is on. */
	outline?: HTMLElement;
	view?: EditorView;
	merge?: MergeView;
	diffObserver?: ResizeObserver;
	/** The extension's own Binary Compare page — a binary file between two revisions. */
	folderCompare?: FolderCompareView;
	/** An address-aligned hex comparison of two binary files on disk. */
	hexCompare?: HexCompareView;
	callTree?: CallTreeView;
	symbolDatabase?: import('../search').SymbolDatabaseView;
	/** A Code Analysis page (module 17) — the view the lazy analysisPages chunk mounts. */
	analysis?: import('../analysis/types').AnalysisPageView;
	mergeToolbar?: MergeToolbar;
	/** A preview's re-render (the Markdown preview follows its source). */
	render?: () => Promise<void>;
	/** Runs when the editor is closed, to release what it holds beyond its own DOM. */
	onClose?: () => void;
	/** The blame gutter is showing. */
	blame?: boolean;
	history?: FileHistoryView;
	/** A binary (or hex-opened) file's hex view, whose edits Ctrl+S writes back in place. */
	hex?: HexView;
	/** A CAN log (.blf / .asc) statistics view, filled when the backend's parse returns. */
	canlog?: CanLogView;
	/** A CAN log's raw frame view — the tab a .blf / .asc opens in, live while it parses. */
	canraw?: CanRawView;
	/** A large file's windowed editable editor — the document lives in the backend's rope
	 *  and only a window of lines is ever in the webview. */
	doc?: EditableDocView;
	/** An enormous file's read-only windowed viewer — past what an editable document can hold. */
	fast?: FastView;
	dirty: boolean;
	/** The buffer as it was last saved — or loaded, before any save: the doc's own `Text`
	 *  object, so the equality check shares unchanged nodes with the live document. An
	 *  undo (or a plain delete) that returns the buffer exactly here clears `dirty`,
	 *  as VS Code's does. */
	savedDoc?: Text;
	/** The line endings and encoding `savedDoc` was written with: a pure EOL or encoding
	 *  switch keeps the tab dirty even while the text itself matches. */
	savedEol?: 'lf' | 'crlf';
	savedEncoding?: string;
	/** A file's encoding id and line endings: what it was read with, what a save writes back. */
	encoding?: string;
	eol?: 'lf' | 'crlf';
	languageName?: string;
	/** The disk moved under a DIRTY buffer — another device saved this file while this
	 *  tab held unsaved changes (docs/remote-client-plan.md §7.3): the conflict bar
	 *  shows until the user compares, takes the disk version or keeps their own (the
	 *  next save overwrites). */
	conflict?: boolean;
}


/** The tab id an input's editor has while open (a navigation entry's, Remote Access's
 *  cross-frontend tab sync — module 19). */
export function inputId(input: EditorInput): string {
	switch (input.kind) {
		case 'file': return 'file:' + input.path;
		case 'diff': return 'diff:' + input.id;
		case 'content': return 'content:' + input.id;
		case 'folders': return 'folders:' + input.id;
		case 'symboldb': return input.id;
		case 'analysis': return 'analysis:' + input.tool + (input.folders?.length ? ':' + input.folders.join(',') : '');
		case 'extpage': return input.id;
		case 'extdetail': return input.id;
		case 'calltree': return 'calltree:' + input.id;
		case 'help': return 'help:' + input.help;
		case 'selftest': return input.id;
		case 'providers': return input.id;
		case 'markdown': return 'markdown:' + input.path;
		case 'history': return 'history:' + input.path;
		case 'hex': return 'hex:' + input.path;
		case 'canlog': return 'canlog:' + input.path;
	}
}


export interface NavEntry {
	input: EditorInput;
	line: number;
	column: number;
}
