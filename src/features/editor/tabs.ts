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
import { editorState } from './editorState';
import type { Editor, NavEntry } from './inputs';
import { inputId } from './inputs';
import type * as TextEditor from './textEditor';


/** One stop in the back/forward navigation history: an editor (by input, so a closed file can
 *  be reopened on the way back) at the position the cursor last had there. */


/** The tab being dragged between editor groups: filled on `dragstart`, consumed on drop. */
export const tabDrag: { editor: Editor | null; groupId: number | null } = { editor: null, groupId: null };


/** The tabs concern of EditorGroup — assigned onto the prototype by the module facade. */
export const tabsMethods: ThisType<EditorGroup> = {
	add(editor: Editor, activate = true, intent?: number): void {
		// A parallel open of the same target passed the "already open" check while this one
		// was still awaiting its reads: the tab that landed first wins, and the latecomer's
		// views are released unshown instead of duplicating the tab.
		const duplicate = this.open.find((e) => e.id === editor.id);
		if (duplicate) {
			editor.view?.destroy();
			editor.merge?.destroy();
			editor.diffObserver?.disconnect();
			editor.fast?.dispose();
			editor.onClose?.();
			if (activate && this.holdsIntent(intent)) this.activate(duplicate);
			return;
		}
		this.open.push(editor);
		this.editors.appendChild(editor.pane);
		if (activate && this.holdsIntent(intent)) {
			this.activate(editor);
		} else {
			// An inactive open keeps whatever is showing (the session restore opens in
			// parallel and activates its pick afterwards); the pane waits hidden. A stale
			// open behaves the same: the tab joins the bar, the user's last pick stays up.
			editor.pane.hidden = true;
			this.update();
		}
	},

	activate(editor: Editor): void {
		// A fresh activation revokes every in-flight open's right to activate (its ticket is
		// no longer the newest): the editor the user just chose keeps the view.
		this.openIntent++;
		if (!this.navigating) {
			// Leaving an editor updates its history stop with the position the cursor reached;
			// arriving at a different editor starts a new stop (dropping any forward stops).
			const leaving = this.active;
			if (leaving && leaving !== editor && this.navIndex >= 0 && this.navHistory[this.navIndex]!.input === leaving.input) {
				this.navHistory[this.navIndex] = this.navEntryOf(leaving);
			}
			if (!leaving || leaving.input !== editor.input) this.pushNav(editor);
		}
		this.active = editor;
		// The phone's page stack (src/remote/nav.ts): an editor shown beneath the full-screen
		// side view (or the full-screen terminal page) navigates to it — tapping a file in the
		// explorer is "open this file", and with one column the file only becomes visible once
		// the page above it closes.
		hook('navigation').revealEditorPage();
		const mruIndex = this.mru.indexOf(editor);
		if (mruIndex !== -1) this.mru.splice(mruIndex, 1);
		this.mru.unshift(editor);
		this.onFocus?.();
		for (const other of this.open) other.pane.hidden = other !== editor;
		this.update();
		editor.view?.focus();
		editor.view?.requestMeasure();
		this.tabs.querySelector<HTMLElement>('.tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
	},

	activateLast(): void {
		const last = this.open[this.open.length - 1];
		if (last) this.activate(last);
	},

	activateNext(direction: 1 | -1): void {
		if (!this.active || this.open.length < 2) return;
		const index = this.open.indexOf(this.active);
		this.activate(this.open[(index + direction + this.open.length) % this.open.length]!);
	},

	activateSuccessor(editor: Editor, index: number): void {
		if (this.active !== editor) {
			this.update();
			return;
		}
		const next = this.mru.find((candidate) => this.open.includes(candidate)) ?? this.open[Math.min(index, this.open.length - 1)];
		if (next) {
			this.activate(next);
		} else {
			this.active = null;
			this.update();
		}
	},

	activateById(id: string): void {
		const editor = this.open.find((e) => e.id === id);
		if (editor) this.activate(editor);
	},

	moveOut(editor: Editor): Editor | null {
		const index = this.open.indexOf(editor);
		if (index === -1) return null;
		this.open.splice(index, 1);
		this.forget(editor);
		this.activateSuccessor(editor, index);
		return editor;
	},

	moveIn(editor: Editor): void {
		if (this.open.includes(editor)) return;
		this.open.push(editor);
		this.editors.appendChild(editor.pane);
		editor.pane.hidden = false;
		this.activate(editor);
	},

	forget(editor: Editor): void {
		const mruIndex = this.mru.indexOf(editor);
		if (mruIndex !== -1) this.mru.splice(mruIndex, 1);
	},

	renameById(id: string, title: string): boolean {
		const editor = this.open.find((e) => e.id === id);
		if (!editor || editor.label === title) return false;
		editor.label = title;
		if (editor.input.kind === 'extpage') editor.input.title = title;
		this.update();
		return true;
	},

	setIconSrc(id: string, iconSrc: string): boolean {
		const editor = this.open.find((e) => e.id === id);
		if (!editor) return false;
		editor.iconSrc = iconSrc;
		this.update();
		return true;
	},

	findEditor(id: string): Editor | null {
		return this.open.find((e) => e.id === id) ?? null;
	},

	hasEditor(id: string): boolean {
		return this.open.some((e) => e.id === id);
	},

	editorForPath(path: string): Editor | null {
		return this.open.find((candidate) => (candidate.input.kind === 'file' || candidate.input.kind === 'canlog') && samePath(candidate.input.path, path)) ?? null;
	},

	fileViewFor(path: string): EditorView | null {
		return this.open.find((candidate) => candidate.input.kind === 'file' && samePath(candidate.input.path, path))?.view ?? null;
	},

	renderTabs(): void {
		this.tabs.innerHTML = '';
		// Two open files with the same name are told apart by their folder, as VS Code does.
		const names = new Map<string, number>();
		for (const editor of this.open) names.set(editor.label, (names.get(editor.label) ?? 0) + 1);
		for (const editor of this.open) {
			const tab = el('div', 'tab' + (editor === this.active ? ' active' : '') + (editor.dirty ? ' dirty' : ''));
			tab.setAttribute('role', 'tab');
			tab.setAttribute('aria-selected', editor === this.active ? 'true' : 'false');
			// What the tab holds, for shells that mirror the strip (the remote phone's page
			// model tells an extension's own page from a file by these).
			tab.dataset.kind = editor.input.kind;
			if (editor.input.kind === 'extpage' || editor.input.kind === 'extdetail') tab.dataset.ext = editor.input.extId;
			tab.title = editor.input.kind === 'file' ? editor.input.path : editor.label;
			const iconElement = el('span', 'icon');
			if (editor.iconSrc) {
				const image = el('img');
				image.src = editor.iconSrc;
				image.alt = '';
				iconElement.appendChild(image);
			} else {
				const glyph = icon(editor.iconClass ?? 'file');
				if (editor.input.kind === 'file') glyph.style.color = fileIconColor(editor.label) ?? '';
				iconElement.appendChild(glyph);
			}
			tab.appendChild(iconElement);
			tab.appendChild(el('span', 'label', [editor.label]));
			if (editor.input.kind === 'file' && (names.get(editor.label) ?? 0) > 1) {
				const folder = basename(editor.input.path.slice(0, editor.input.path.length - editor.label.length - 1));
				if (folder) tab.appendChild(el('span', 'description', [folder]));
			}
			const close = el('span', 'close', [icon('close'), icon('circle-filled')]);
			close.title = 'Close';
			close.addEventListener('click', (event) => {
				event.stopPropagation();
				void this.close(editor);
			});
			tab.appendChild(close);
			tab.addEventListener('click', () => this.activate(editor));
			// Tabs drag into other editor groups (M3 3.1): the payload travels in a module-level
			// slot, because DataTransfer's custom types are not readable during dragover.
			tab.draggable = true;
			tab.addEventListener('dragstart', (event) => {
				tabDrag.editor = editor;
				tabDrag.groupId = this.groupId;
				event.dataTransfer?.setData('text/plain', editor.id);
			});
			tab.addEventListener('dragend', () => { tabDrag.editor = null; tabDrag.groupId = null; });
			tab.addEventListener('auxclick', (event) => {
				if (event.button === 1) void this.close(editor);
			});
			tab.addEventListener('contextmenu', (event) => {
				event.preventDefault();
				showContextMenu(event.clientX, event.clientY, this.tabMenu(editor));
			});
			this.tabs.appendChild(tab);
		}
		// The tab strip's one action cluster at its right edge. A Markdown file's preview
		// button (VS Code shows it there) sits beside the extensions' `editor/title` actions
		// for the active file: the `navigation` group as buttons (the manifest's own icon —
		// codicon or package image — else the title), the rest behind "…", each run with the
		// file's Uri as VS Code passes it. One container, never one per source:
		// `tab-actions` centers itself with `margin-left: auto`, and two of them split the
		// strip's free space between themselves — the Markdown button marooned mid-strip,
		// apart from the title actions it belongs beside.
		const active = this.active;
		const actions: HTMLElement[] = [];
		if (active?.input.kind === 'file' && /\.(md|markdown)$/i.test(active.input.path)) {
			const button = el('button', 'markdown-preview-button', [icon('open-preview')]);
			button.title = 'Open Preview to the Side (Ctrl+K V)';
			button.addEventListener('click', (event) => {
				event.stopPropagation();
				this.onOpenPreviewToSide?.(active.input.kind === 'file' ? active.input.path : '');
			});
			actions.push(button);
		}
		// A Python file's run button, VS Code's Run Python File: the terminal opens with the
		// file's interpreter line ready to run.
		if (active?.input.kind === 'file' && /\.py$/i.test(active.input.path)) {
			const button = el('button', 'markdown-preview-button python-run-button', [icon('play')]);
			button.title = t('python.runFile');
			button.addEventListener('click', (event) => {
				event.stopPropagation();
				this.onRunInTerminal?.(active.input.kind === 'file' ? active.input.path : '');
			});
			actions.push(button);
		}
		if (active?.input.kind === 'file') {
			const path = active.input.path;
			const entries = resolvedMenuEntries('editor/title', resourceContext(path));
			if (entries.length > 0) {
				const args = [contextUri(path), [contextUri(path)]];
				for (const entry of entries.filter((candidate) => candidate.group === 'navigation')) {
					const button = el('button', 'markdown-preview-button ext-editor-action', commandIconContent(entry, entry.label, extFileDataUrl));
					button.title = entry.label;
					button.addEventListener('click', (event) => {
						event.stopPropagation();
						runMenuEntry(entry, args);
					});
					actions.push(button);
				}
				const rest = entries.filter((candidate) => candidate.group !== 'navigation');
				if (rest.length > 0) {
					const more = el('button', 'markdown-preview-button ext-editor-action', [icon('ellipsis')]);
					more.title = '…';
					more.addEventListener('click', (event) => {
						event.stopPropagation();
						showMenuBelow(more, rest.map((entry) => ({ label: entry.label, run: () => runMenuEntry(entry, args) })));
					});
					actions.push(more);
				}
			}
		}
		if (actions.length > 0) this.tabs.appendChild(el('div', 'tab-actions', actions));
		// The locked-group badge (VS Code's marker) as the tab strip's last item, in flow
		// after the title actions — a marker beside them, never an overlay covering them
		// (the Claude button a claude-code install contributes sits right there).
		if (this.locked) {
			const badge = el('div', 'group-lock', [icon('lock')]);
			badge.title = t('editor.groupLocked');
			// The badge is the exit too, as in VS Code: a click unlocks this group. The lock
			// claude-code leaves on its chat's group is the one users meet unasked — without
			// this, no surface in the group itself answered, and the lock read as permanent.
			badge.addEventListener('click', (event) => {
				event.stopPropagation();
				this.onToggleGroupLock?.();
			});
			this.tabs.appendChild(badge);
		}
	},

	tabMenu(editor: Editor): MenuEntry[] {
		const entries: MenuEntry[] = [
			{ label: 'Close', keybinding: 'Ctrl+W', run: () => void this.close(editor) },
			{ label: 'Close Others', run: () => void this.closeOthers(editor) },
			{ label: 'Close to the Right', disabled: this.open.indexOf(editor) === this.open.length - 1, run: () => void this.closeToTheRight(editor) },
			{ label: 'Close Saved', run: () => void this.closeSaved() },
			{ label: 'Close All', keybinding: 'Ctrl+K Ctrl+W', run: () => void this.closeAll() },
			// VS Code's tab-menu lock toggle, labelled by the state — the discoverable exit
			// beside the badge's click (the palette names the commands too). `trText` reuses
			// the palette labels' own translations, so every surface says the same thing.
			'separator',
			{ label: trText(this.locked ? 'Unlock Editor Group' : 'Lock Editor Group'), run: () => this.onToggleGroupLock?.() }
		];
		if (editor.input.kind === 'file') {
			const path = editor.input.path;
			entries.push('separator',
				{ label: 'Copy Path', keybinding: 'Shift+Alt+C', run: () => void writeText(path) },
				{ label: 'Copy Relative Path', keybinding: 'Ctrl+K Ctrl+Shift+C', run: () => void writeText(this.rootPath ? relativeTo(this.rootPath, path) : path) });
		}
		entries.push(...menuSection('editor/title/context', editor.input.kind === 'file' ? [contextUri(editor.input.path), [contextUri(editor.input.path)]] : undefined, editor.input.kind === 'file' ? resourceContext(editor.input.path) : undefined));
		return entries;
	},

	canGoBack(): boolean {
		return this.navIndex > 0;
	},

	canGoForward(): boolean {
		return this.navIndex < this.navHistory.length - 1;
	},

	goBack(): void {
		if (this.navIndex <= 0) return;
		this.navIndex--;
		this.onNavigationChange?.();
		void this.navigate(this.navHistory[this.navIndex]!);
	},

	goForward(): void {
		if (this.navIndex >= this.navHistory.length - 1) return;
		this.navIndex++;
		this.onNavigationChange?.();
		void this.navigate(this.navHistory[this.navIndex]!);
	},

	navEntryOf(editor: Editor): NavEntry {
		let line = 1, column = 1;
		if (editor.view) {
			const head = editor.view.state.selection.main.head;
			const lineInfo = editor.view.state.doc.lineAt(head);
			line = lineInfo.number;
			column = head - lineInfo.from + 1;
		}
		return { input: editor.input, line, column };
	},

	pushNav(editor: Editor): void {
		this.navHistory.length = this.navIndex + 1;
		this.navHistory.push(this.navEntryOf(editor));
		if (this.navHistory.length > 100) this.navHistory.splice(0, this.navHistory.length - 100);
		this.navIndex = this.navHistory.length - 1;
		this.onNavigationChange?.();
	},

	async navigate(entry: NavEntry): Promise<void> {
		const existing = this.open.find((e) => e.id === inputId(entry.input));
		this.navigating = true;
		try {
			if (existing) {
				this.activate(existing);
				this.revealIn(existing, entry.line, entry.column);
			} else if (entry.input.kind === 'file') {
				// A CAN tab's raw form has no cursor, so its entry carries no real position —
				// it reopens in the raw frame view, where a line option would force the text form.
				const line = isCanLog(entry.input.path) ? undefined : entry.line;
				await this.openFile(entry.input.path, { line, column: entry.column });
			}
			// A closed diff / comparison stop is gone with its data: the jump is a no-op.
		} finally {
			this.navigating = false;
		}
	},

	revealPosition(view: EditorView, line: number, column: number): void {
		editorState.cm?.revealPosition(view, line, column);
	},

	toggleBookmarkAt(editor: Editor, line: number): void {
		if (editor.input.kind !== 'file' || !editor.view) return;
		toggleBookmark(editor.input.path, line);
		editor.view.dispatch({ selection: { anchor: editor.view.state.selection.main.head } });
	},
};
