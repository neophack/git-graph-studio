// Shared helpers of the editor suite's split files: the raw-IPC file read and the
// saved-tab notice chip. A leaf, so open/dirty/navigate can share them without
// importing each other (R5).

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
import { samePath } from '../extensions';
import { loadAnalysisPages, loadCanViews, loadCallTree, loadEditorExtensions, loadFastView, loadFileHistory, loadFolderCompare, loadHexCompare, loadHexView, loadMerge, loadMergeEditor, loadSnippetRegistry, loadSymbolDbView, loadTextEditor } from '../../platform/lazy';
import type { FastView } from '../viewers/types';
import type { HexView } from '../viewers/types';
import type { HexCompareView } from '../viewers/types';
import type { CanLogView } from '../can/types';
import type { CanRawView } from '../can/types';
import type { EditableDocView } from './docEditView';
import { imageMime, renderMarkdown } from '../../platform/markdown';
import type { FileHistoryView } from '../scm/types';
import type { BlameLine } from '../scm/types';
import type * as TextEditor from './textEditor';
import type { CallTreeView, WsSymbol } from '../search/types';
import { commands } from '../../platform/commands';
import { commandIconContent, contextUri, declaredLanguageName, menuSection, resolvedMenuEntries, resourceContext, runMenuEntry } from '../extensions';
import { extFileDataUrl } from '../../platform/extAssets';
import type { FolderCompareView } from '../compare/types';
import type { MergeToolbar } from '../compare/types';
import { t, trText } from '../../platform/i18n';
import { SETTINGS_EVENT, settings } from '../../platform/settings';
import { basename, dirname, el, icon, joinPath, notify, quickPick, relativeTo, showContextMenu, showMenuBelow, toPosix, type MenuEntry } from '../../platform/ui/index';
import { fileIcon, fileIconColor, isCanLog, isCodeExtension } from '../../platform/fileIcons';
import { hook } from '../../platform/hooks';
import type { DiffSide, EditorPlacement } from './types';
import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager';

/** Read a file's text over the raw IPC channel (`read_file_raw`). The JSON path re-escapes
 *  and re-copies the whole document on both sides of the bridge, which stalled the webview
 *  for seconds on large files; the raw payload is an 8-byte little-endian header length,
 *  the JSON metadata, then the UTF-8 text itself. */
export async function readFileRaw(path: string, encoding?: string): Promise<FileContents> {
	const raw = await fetchFileRaw(path, encoding);
	const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
	const headerLen = Number(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(0, true));
	const meta = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + headerLen))) as Omit<FileContents, 'contents'>;
	const contents = meta.binary ? null : new TextDecoder().decode(bytes.subarray(8 + headerLen));
	return { ...meta, contents };
}

export function notice(iconName: string, text: string): HTMLElement {
	return el('div', 'editor-notice', [icon(iconName), el('span', '', [text])]);
}
