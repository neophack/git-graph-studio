import type { Extension, Text } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import type { MergeView } from '@codemirror/merge';
import { invoke } from '../../platform/ipc/core';
import { backupClear, backupWrite, type FileContents, type FileProbe, fileProbe, listFiles, readFileBase64, readFileRaw as fetchFileRaw, writeFile } from '../../platform/ipc/fs';
import { materializeRevisionFile, readFileAt } from '../../platform/ipc/revision';
import { viewerClose, viewerOpen, type ViewerOutlineSymbol } from '../../platform/ipc/viewer';
import { findReferences, workspaceSymbols } from '../../platform/ipc/search';
import { symbolLookup, symbolReferences } from '../../platform/ipc/symbols';
import { scmBlame } from '../../platform/ipc/scm';
import { hasBookmark, toggleBookmark } from './bookmarks';
import { samePath, commandIconContent, contextUri, declaredLanguageName, menuSection, resolvedMenuEntries, resourceContext, runMenuEntry } from '../extensions';
import { loadAnalysisPages, loadCanViews, loadCallTree, loadEditorExtensions, loadFastView, loadFileHistory, loadFolderCompare, loadHexCompare, loadHexView, loadMerge, loadMergeEditor, loadSnippetRegistry, loadSymbolDbView, loadTextEditor } from '../../platform/lazy';
import type { FastView, HexView, HexCompareView } from '../viewers/types';
import type { CanLogView, CanRawView } from '../can/types';
import type { EditableDocView } from './docEditView';
import { imageMime, renderMarkdown } from '../../platform/markdown';
import type { FileHistoryView, BlameLine } from '../scm/types';
import type { CallTreeView, WsSymbol } from '../search/types';
import { commands } from '../../platform/commands';
import { extFileDataUrl } from '../../platform/extAssets';
import type { FolderCompareView, MergeToolbar } from '../compare/types';
import { t, trText } from '../../platform/i18n';
import { SETTINGS_EVENT, settings } from '../../platform/settings';
import { basename, dirname, el, icon, joinPath, notify, quickPick, relativeTo, showContextMenu, showMenuBelow, toPosix, type MenuEntry } from '../../platform/ui/index';
import { fileIcon, fileIconColor, isCanLog, isCodeExtension } from '../../platform/fileIcons';
import { hook } from '../../platform/hooks';
import type { DiffSide, EditorPlacement } from './types';
import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager';
import type { EditorGroup } from './group';
import { SYMBOL_ICONS } from './breadcrumbs';
import type { Editor } from './inputs';
import { readFileRaw } from './shared';
import type * as TextEditor from './textEditor';


/** How many workspace files "Go to Definition" reads through before giving up. */
const MAX_DEFINITION_FILES = 3000;

export const workspaceFileCache = new Map<string, string | null>();
/** How many workspace files the definition search keeps cached (whole file strings). */
const WORKSPACE_CACHE_MAX = 64;

function cacheWorkspaceFile(path: string, contents: string | null): void {
	// Refresh the insertion order, then drop the oldest entry past the cap.
	workspaceFileCache.delete(path);
	workspaceFileCache.set(path, contents);
	if (workspaceFileCache.size > WORKSPACE_CACHE_MAX) {
		workspaceFileCache.delete(workspaceFileCache.keys().next().value!);
	}
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The line and column a declaration of the pattern starts at, or null if the text has none. */
function findDefinition(text: string, pattern: RegExp): { line: number; column: number } | null {
	const lines = text.split('\n');
	for (let i = 0; i < lines.length; i++) {
		const match = lines[i]!.match(pattern);
		if (match) return { line: i + 1, column: match[0].length - match[0].trimStart().length + 1 };
	}
	return null;
}

function looksLikeCode(path: string): boolean {
	return isCodeExtension(path);
}


/** The navigate concern of EditorGroup — assigned onto the prototype by the module facade. */
export const navigateMethods: ThisType<EditorGroup> = {
	async goToDefinition(editor?: Editor | null, pos?: number | null): Promise<void> {
		if (editor === undefined) editor = this.active;
		if (!editor?.view) return;
		const view = editor.view;
		const at = pos ?? view.state.selection.main.head;
		const word = view.state.wordAt(at) ?? view.state.wordAt(view.state.selection.main.head);
		if (!word) return;
		const name = view.state.sliceDoc(word.from, word.to);
		const currentPath = editor.input.kind === 'file' ? editor.input.path : null;
		if (this.rootPath && await this.goToIndexedDefinition(name, currentPath, view)) return;
		const pattern = new RegExp(
			'^(?:\\s*(?:export|declare|default|pub|public|private|protected|internal|static|async|abstract|unsafe|extern|virtual|override|final)\\s+)*'
			+ `(?:function|fn|def|class|struct|enum|interface|trait|type|module|impl|const|let|var)\\s+${escapeRegExp(name)}\\b`
		);
		const inThisFile = findDefinition(view.state.doc.toString(), pattern);
		if (inThisFile !== null && (currentPath === null || inThisFile.line !== view.state.doc.lineAt(at).number)) {
			this.revealPosition(view, inThisFile.line, inThisFile.column);
			return;
		}
		if (!this.rootPath) {
			notify('info', inThisFile ? `The definition of '${name}' is in this file.` : `No definition found for '${name}'.`);
			return;
		}
		let files: string[];
		try {
			files = await listFiles();
		} catch {
			files = [];
		}
		const candidates = files.filter((f) => looksLikeCode(f) && (currentPath === null || joinPath(this.rootPath!, f) !== currentPath));
		// Same-language files are likelier to hold the definition; the current file's folder
		// first (candidates are workspace-relative, so the folder is compared relatively too).
		const wanted = currentPath ? currentPath.split('.').pop()! : '';
		const folder = currentPath ? dirname(relativeTo(this.rootPath!, currentPath)) : '';
		candidates.sort((a, b) => Number(b.endsWith('.' + wanted)) - Number(a.endsWith('.' + wanted)) || Number(dirname(b) === folder) - Number(dirname(a) === folder));
		for (const relative of candidates.slice(0, MAX_DEFINITION_FILES)) {
			const path = joinPath(this.rootPath, relative);
			const contents = await this.cachedRead(path);
			if (contents === null) continue;
			const hit = findDefinition(contents, pattern);
			if (hit !== null) {
				await this.openFile(path, { line: hit.line, column: hit.column });
				return;
			}
		}
		if (inThisFile !== null) this.revealPosition(view, inThisFile.line, inThisFile.column);
		else notify('info', `No definition found for '${name}'.`);
	},

	async goToIndexedDefinition(name: string, currentPath: string | null, view: EditorView): Promise<boolean> {
		try {
			const exact = await symbolLookup(name);
			if (exact.length === 1) return this.jumpToDefinition(exact[0]!, currentPath, view);
			if (exact.length > 1) return this.pickDefinition(exact, currentPath, view);
		} catch {
			// No persistent index yet (or an old backend): the substring query takes over.
		}
		let symbols: WsSymbol[];
		try {
			symbols = (await workspaceSymbols(name, 200)) ?? [];
		} catch {
			return false;
		}
		const hits = symbols.filter((s) => s.name === name && (s.kind === 'function' || s.kind === 'method' || s.kind === 'class' || s.kind === 'struct' || s.kind === 'interface'));
		const currentRelative = currentPath ? toPosix(relativeTo(this.rootPath!, currentPath)) : null;
		// The current file's own hit is the fallback, not the pick: another file's definition
		// is the useful jump.
		const other = hits.find((s) => s.path !== currentRelative);
		const target = other ?? hits[0];
		if (!target) return false;
		return this.jumpToDefinition(target, currentPath, view);
	},

	async pickDefinition(defs: WsSymbol[], currentPath: string | null, view: EditorView): Promise<boolean> {
		const chosen = await quickPick(
			defs.map((def) => ({ label: def.name, description: `${def.path}:${def.line + 1}`, icon: 'symbol-method', value: `${def.path}\u0000${def.line}` })),
			`${defs.length} definitions`,
			'Definitions'
		);
		if (chosen === null) return true; // dismissed - the gesture is consumed either way
		const [path, line] = chosen.split('\u0000');
		const absolute = joinPath(this.rootPath!, path!);
		if (currentPath && absolute === currentPath) {
			this.revealPosition(view, Number(line) + 1, 1);
			return true;
		}
		await this.openFile(absolute, { line: Number(line) + 1, column: 1 });
		return true;
	},

	async jumpToDefinition(target: WsSymbol, currentPath: string | null, view: EditorView): Promise<boolean> {
		const path = joinPath(this.rootPath!, target.path);
		if (currentPath && path === currentPath) {
			// Jump within this file only when it is a different line than the cursor's word.
			this.revealPosition(view, target.line + 1, 1);
			return true;
		}
		await this.openFile(path, { line: target.line + 1, column: 1 });
		return true;
	},

	async findReferences(editor?: Editor | null, pos?: number | null): Promise<void> {
		if (editor === undefined) editor = this.active;
		if (!editor?.view) return;
		const view = editor.view;
		const at = pos ?? view.state.selection.main.head;
		const word = view.state.wordAt(at) ?? view.state.wordAt(view.state.selection.main.head);
		if (!word) return;
		const name = view.state.sliceDoc(word.from, word.to);
		let files: { path: string; matches: { line: number; column: number }[] }[];
		try {
			// The index's occurrence list narrows this scan to the files that contain the
			// word (M4); the older full-scan command stays as the fallback.
			files = (await symbolReferences(name)) ?? [];
		} catch {
			try {
				files = (await findReferences(name)) ?? [];
			} catch (error) {
				notify('error', String(error));
				return;
			}
		}
		const total = files.reduce((sum, f) => sum + f.matches.length, 0);
		if (total === 0) {
			notify('info', `No references found for '${name}'.`);
			return;
		}
		const items = files.flatMap((file) => file.matches.map((match) => ({
			label: `${file.path}:${match.line}`,
			description: name,
			icon: 'go-to-file',
			value: `${file.path}\u0000${match.line}\u0000${match.column}`
		})));
		const chosen = await quickPick(items.slice(0, 60), `${total} reference(s) to '${name}'`, 'References');
		if (!chosen || !this.rootPath) return;
		const [path, line, column] = chosen.split('\u0000');
		await this.openFile(joinPath(this.rootPath, path!), { line: Number(line), column: Number(column) });
	},

	async openCallTreeAtCursor(editor?: Editor | null, pos?: number | null): Promise<void> {
		if (editor === undefined) editor = this.active;
		if (!editor?.view || !this.rootPath) return;
		const view = editor.view;
		const at = pos ?? view.state.selection.main.head;
		const word = view.state.wordAt(at) ?? view.state.wordAt(view.state.selection.main.head);
		if (!word) {
			notify('info', 'Place the cursor on a function name to see its call tree.');
			return;
		}
		const name = view.state.sliceDoc(word.from, word.to);
		let symbols: WsSymbol[];
		try {
			symbols = (await workspaceSymbols(name, 200)) ?? [];
		} catch (error) {
			notify('error', String(error));
			return;
		}
		const currentPath = editor.input.kind === 'file' ? toPosix(relativeTo(this.rootPath, editor.input.path)) : null;
		const symbol = symbols.find((s) => s.name === name && s.path === currentPath) ?? symbols.find((s) => s.name === name);
		if (!symbol) {
			notify('info', `No function named '${name}' was found in the workspace index.`);
			return;
		}
		await this.openCallTree(symbol);
	},

	async gotoSymbolInFile(): Promise<void> {
		const editor = this.active;
		if (!editor || editor.input.kind !== 'file') return;
		let symbols: ViewerOutlineSymbol[];
		try {
			const info = await viewerOpen(editor.input.path);
			symbols = info.symbols ?? [];
			await viewerClose(info.docId).catch(() => undefined);
		} catch {
			symbols = [];
		}
		if (symbols.length === 0) {
			notify('info', 'No symbols were found in this file.');
			return;
		}
		const chosen = await quickPick(
			symbols.map((symbol) => ({ label: symbol.name, description: symbol.kind, icon: SYMBOL_ICONS[symbol.kind] ?? 'symbol-method', value: String(symbol.line) })),
			'Go to symbol in this file',
			'Go to Symbol'
		);
		if (chosen !== null) this.revealIn(editor, Number(chosen) + 1, 1);
	},

	lineInfo(): { line: number; column: number; lines: number } | null {
		const view = this.active?.view;
		if (!view) return null;
		const head = view.state.selection.main.head;
		const line = view.state.doc.lineAt(head);
		return { line: line.number, column: head - line.from + 1, lines: view.state.doc.lines };
	},

	gotoLine(line: number, column = 1): void {
		const editor = this.active;
		if (editor && (editor.view || editor.doc || editor.fast)) this.revealIn(editor, line, column);
	},

	async cachedRead(path: string): Promise<string | null> {
		if (workspaceFileCache.has(path)) return workspaceFileCache.get(path)!;
		try {
			const file = await readFileRaw(path);
			const contents = file.contents !== null && !file.binary && file.contents.length <= 1_000_000 ? file.contents : null;
			cacheWorkspaceFile(path, contents);
			return contents;
		} catch {
			cacheWorkspaceFile(path, null);
			return null;
		}
	},
};
