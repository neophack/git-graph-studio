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
import type { Editor } from './inputs';
import type * as TextEditor from './textEditor';


/** A symbol the backend's outline extraction found in a document. */
/** The codicon VS Code's outline uses per symbol kind. */
export const SYMBOL_ICONS: Record<string, string> = {
	function: 'symbol-method',
	method: 'symbol-method',
	class: 'symbol-class',
	struct: 'symbol-structure',
	interface: 'symbol-interface',
	enum: 'symbol-enum',
	module: 'symbol-module',
	type: 'symbol-parameter'
};


/** The breadcrumbs concern of EditorGroup — assigned onto the prototype by the module facade. */
export const breadcrumbsMethods: ThisType<EditorGroup> = {
	refreshOutlines(): void {
		for (const editor of this.open) {
			if (editor.input.kind === 'file') this.updateOutline(editor);
		}
	},

	updateOutline(editor: Editor): void {
		editor.outline?.remove();
		editor.outline = undefined;
		editor.pane.classList.remove('has-outline');
		if (!settings.showOutline || editor.input.kind !== 'file') return;
		const path = editor.input.path;
		const pane = el('aside', 'editor-outline');
		pane.appendChild(el('div', 'editor-outline-title', [t('outline.title')]));
		pane.appendChild(el('div', 'editor-outline-empty'));
		editor.outline = pane;
		editor.pane.classList.add('has-outline');
		editor.pane.prepend(pane);
		void (async () => {
			let symbols: ViewerOutlineSymbol[];
			try {
				const info = await viewerOpen(path);
				symbols = info.symbols ?? [];
				await viewerClose(info.docId).catch(() => undefined);
			} catch {
				symbols = [];
			}
			// The editor may have closed, or the setting been toggled again, meanwhile.
			if (editor.outline !== pane) return;
			if (symbols.length === 0) {
				pane.remove();
				editor.outline = undefined;
				editor.pane.classList.remove('has-outline');
				return;
			}
			pane.textContent = '';
			pane.appendChild(el('div', 'editor-outline-title', [t('outline.title')]));
			for (const symbol of symbols) {
				const item = el('div', 'editor-outline-item', [icon(SYMBOL_ICONS[symbol.kind] ?? 'symbol-method'), el('span', '', [symbol.name])]);
				item.title = `${symbol.name} — line ${symbol.line + 1}`;
				item.addEventListener('click', () => this.revealIn(editor, symbol.line + 1, 1));
				pane.appendChild(item);
			}
		})();
	},

	renderBreadcrumbs(): void {
		this.breadcrumbs.innerHTML = '';
		const input = this.active?.input;
		// Only a file-backed tab has a path worth walking — a preview, history or hex tab
		// walks the file's own path, as VS Code's breadcrumbs do for a custom editor over
		// that file. Every other page has no path, and its single crumb would only repeat
		// the tab's own title, so the bar stays hidden.
		const path = input && (input.kind === 'file' || input.kind === 'markdown' || input.kind === 'history' || input.kind === 'hex' || input.kind === 'canlog') ? input.path : null;
		this.breadcrumbs.hidden = path === null;
		if (path === null) return;
		const relative = this.rootPath ? relativeTo(this.rootPath, path) : toPosix(path);
		const parts = relative.split('/').filter((p) => p !== '');
		parts.forEach((part, index) => {
			if (index > 0) this.breadcrumbs.appendChild(icon('chevron-right'));
			const last = index === parts.length - 1;
			const glyph = icon(last ? this.active!.iconClass ?? fileIcon(part) : 'folder');
			const color = last ? fileIconColor(part) : undefined;
			if (color) glyph.style.color = color;
			this.breadcrumbs.appendChild(el('span', 'crumb', [glyph, part]));
		});
	},
};
