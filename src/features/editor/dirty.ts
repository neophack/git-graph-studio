import { backupClear, backupWrite, type FileContents, writeFile } from '../../platform/ipc/fs';
import { samePath } from '../extensions';
import { settings } from '../../platform/settings';
import { t } from '../../platform/i18n';
import { basename, el, notify, toPosix } from '../../platform/ui/index';
import { fileIcon } from '../../platform/fileIcons';
import type { EditorGroup } from './group';
import { editorState } from './editorState';
import type { Editor } from './inputs';
import { inputId } from './inputs';
import { readFileRaw } from './shared';


/** How long after the last keystroke an unsaved buffer is backed up for hot exit. */
const BACKUP_DELAY_MS = 500;
/** Backing a large document up means one whole-document `toString()` plus one whole-file
 *  IPC transfer; at typing cadence that is visible jank, so large documents back up on a
 *  slower clock (and still on save and close). */
const LARGE_BACKUP_DELAY_MS = 3000;
const LARGE_DOC_CHARS = 1024 * 1024;



/** VS Code's prompt before closing several dirty files at once: one question listing them,
 *  with Save All / Don't Save / Cancel. */
export function askToSaveMany(labels: string[]): Promise<'save' | 'discard' | 'cancel'> {
	return new Promise((resolve) => {
		let settled = false;
		const settle = (value: 'save' | 'discard' | 'cancel') => {
			if (!settled) {
				settled = true;
				resolve(value);
			}
		};
		const list = labels.length > 6 ? `${labels.slice(0, 6).join(', ')} and ${labels.length - 6} more` : labels.join(', ');
		notify('warning', `Do you want to save the changes to the following ${labels.length} files? ${list}. Your changes will be lost if you don't save them.`, [
			{ label: 'Save All', run: () => settle('save') },
			{ label: "Don't Save", run: () => settle('discard') },
			{ label: 'Cancel', run: () => settle('cancel') }
		], () => settle('cancel'));
	});
}

/** VS Code's "Do you want to save the changes?" prompt, rendered as a notification. */
function askToSave(label: string): Promise<'save' | 'discard' | 'cancel'> {
	return new Promise((resolve) => {
		let settled = false;
		const settle = (value: 'save' | 'discard' | 'cancel') => {
			if (!settled) {
				settled = true;
				resolve(value);
			}
		};
		// The toast's own close button (or any other dismissal) also cancels.
		notify('warning', `Do you want to save the changes you made to ${label}? Your changes will be lost if you don't save them.`, [
			{ label: 'Save', run: () => settle('save') },
			{ label: "Don't Save", run: () => settle('discard') },
			{ label: 'Cancel', run: () => settle('cancel') }
		], () => settle('cancel'));
	});
}

/** The dirty concern of EditorGroup — assigned onto the prototype by the module facade. */
export const dirtyMethods: ThisType<EditorGroup> = {
	async save(editor?: Editor | null): Promise<void> {
		if (editor === undefined) editor = this.active;
		if (!editor || !editor.dirty) return;
		// A hex view's edits are patched byte-by-byte in place, not written as text.
		if (editor.hex) {
			if (!(await editor.hex.save())) notify('error', `Failed to save '${editor.label}'`);
			editor.dirty = editor.hex.isDirty;
			this.renderTabs();
			return;
		}
		// A windowed editor's document lives in the backend: the save writes it from there,
		// so nothing the size of the file ever crosses the IPC.
		if (editor.doc && editor.input.kind === 'file') {
			// A failed save (the view reports the error) leaves the tab dirty and its
			// backup in place, exactly like a failed write_file below.
			if (!(await editor.doc.save())) return;
			editor.dirty = false;
			this.renderTabs();
			this.clearSaveConflict(editor);
			this.flashSavedTab(editor);
			this.forgetBackup(editor);
			this.onFileSaved?.(editor.input.path);
			return;
		}
		if (editor.input.kind !== 'file' || !editor.view) return;
		// The saved baseline is the buffer as it crosses this line: an edit landing while
		// the write runs leaves the buffer past what disk now holds, and the tab must stay
		// dirty for it.
		const savedDoc = editor.view.state.doc;
		const contents = savedDoc.toString();
		try {
			await writeFile(editor.input.path, contents, editor.encoding ?? 'utf8', editor.eol ?? 'lf');
		} catch (error) {
			notify('error', `Failed to save '${editor.label}': ${String(error)}`);
			return;
		}
		editor.savedDoc = savedDoc;
		editor.savedEol = editor.eol;
		editor.savedEncoding = editor.encoding;
		const dirty = !this.bufferAtSavedState(editor);
		if (dirty !== editor.dirty) {
			editor.dirty = dirty;
			this.renderTabs();
		}
		// A saved baseline is the disk again: whatever conflict the tab carried is settled
		// the strong way — this side's text won (§7.3's "keep my version" is implicit in
		// every save).
		this.clearSaveConflict(editor);
		this.flashSavedTab(editor);
		if (!editor.dirty) this.forgetBackup(editor);
		this.onFileSaved?.(editor.input.path);
	},

	async saveAll(): Promise<void> {
		for (const editor of this.open) if (editor.dirty) await this.save(editor);
	},

	async saveByPath(path: string): Promise<boolean> {
		const editor = this.open.find((candidate) => candidate.input.kind === 'file' && samePath(candidate.input.path, path));
		if (!editor) return false;
		await this.save(editor);
		return !editor.dirty;
	},

	async saveWithEncoding(encoding: string): Promise<void> {
		const editor = this.active;
		if (!editor || editor.input.kind !== 'file' || !editor.view) return;
		editor.encoding = encoding;
		editor.dirty = true;
		await this.save(editor);
		this.emitActive();
	},

	async reopenWithEncoding(encoding: string): Promise<void> {
		const editor = this.active;
		if (!editor || editor.input.kind !== 'file' || !editor.view) return;
		if (editor.dirty) {
			const choice = await askToSave(editor.label);
			if (choice === 'cancel') return;
			if (choice === 'save') {
				await this.save(editor);
				if (editor.dirty) return; // the save failed and was reported
			}
		}
		let file: FileContents;
		try {
			file = await readFileRaw(editor.input.path, encoding);
		} catch (error) {
			notify('error', String(error));
			return;
		}
		if (file.contents === null) return;
		// The read was async: bail when the tab closed or its view was rebuilt meanwhile,
		// so the redecode cannot wipe what is on screen now.
		const view = editor.view;
		if (!view || editor.view !== view || !this.open.includes(editor)) return;
		editorState.cm?.replaceDocument(view, file.contents);
		editor.dirty = false;
		editor.encoding = file.encoding ?? encoding;
		editor.eol = file.eol ?? editor.eol;
		// The reopened text is the new saved baseline, read with these line endings and
		// this encoding.
		editor.savedDoc = view.state.doc;
		editor.savedEol = editor.eol;
		editor.savedEncoding = editor.encoding;
		this.forgetBackup(editor);
		this.renderTabs();
		this.emitActive();
	},

	setEol(eol: 'lf' | 'crlf'): void {
		const editor = this.active;
		if (!editor || editor.input.kind !== 'file' || !editor.view || editor.eol === eol) return;
		editor.eol = eol;
		editor.dirty = true;
		this.renderTabs();
		this.onEdited(editor);
		this.emitActive();
	},

	hasDirtyEditors(): boolean {
		return this.open.some((e) => e.dirty);
	},

	dirtyLabels(): string[] {
		return this.open.filter((e) => e.dirty).map((e) => e.label);
	},

	async settleDirty(choice: 'save' | 'discard'): Promise<boolean> {
		for (const editor of [...this.open]) {
			if (!editor.dirty) continue;
			if (choice === 'save') {
				await this.save(editor);
				if (editor.dirty) return false; // the save failed and was reported
			} else {
				editor.dirty = false;
				this.forgetBackup(editor);
			}
		}
		return true;
	},

	async close(editor?: Editor): Promise<void> {
		if (editor === undefined) editor = this.active!;
		if (!editor) return;
		if (editor.dirty) {
			const choice = await askToSave(editor.label);
			if (choice === 'cancel') return;
			if (choice === 'save') {
				await this.save(editor);
				if (editor.dirty) return; // the save failed and was reported
			}
		}
		const index = this.open.indexOf(editor);
		if (index === -1) return;
		this.open.splice(index, 1);
		if (editor.dirty) this.forgetBackup(editor); // discarded on purpose: nothing to recover
		editor.view?.destroy();
		editor.merge?.destroy();
		editor.diffObserver?.disconnect();
		editor.folderCompare?.dispose();
		editor.fast?.dispose();
		editor.onClose?.();
		editor.pane.remove();
		this.forget(editor);
		this.onEditorClosed?.(editor);
		this.activateSuccessor(editor, index);
		if (editor.input.kind === 'file') this.onDocumentClosed?.(editor.input.path);
	},

	closeById(id: string): boolean {
		const editor = this.open.find((e) => e.id === id);
		if (!editor) return false;
		void this.close(editor);
		return true;
	},

	async closeAll(): Promise<boolean> {
		// Several dirty files get one prompt (VS Code's), not one per file.
		const dirty = this.dirtyLabels();
		if (dirty.length > 1) {
			const choice = await askToSaveMany(dirty);
			if (choice === 'cancel' || !(await this.settleDirty(choice))) return false;
		}
		for (const editor of [...this.open]) {
			await this.close(editor);
			if (this.open.includes(editor)) return false; // cancelled
		}
		return true;
	},

	async closeOthers(keep: Editor): Promise<void> {
		for (const editor of [...this.open]) {
			if (editor !== keep) await this.close(editor);
		}
	},

	async closeToTheRight(from: Editor): Promise<void> {
		for (const editor of this.open.slice(this.open.indexOf(from) + 1)) await this.close(editor);
	},

	async closeSaved(): Promise<void> {
		for (const editor of [...this.open]) {
			if (!editor.dirty) await this.close(editor);
		}
	},

	onEdited(editor: Editor): void {
		if (editor.input.kind !== 'file') return;
		const path = editor.input.path;
		this.refreshPreviews(path);
		if (editor.view) {
			const view = editor.view;
			this.onDocumentEdited?.(path, () => view.state.doc.toString());
		}
		const backup = this.backupTimers.get(editor.id);
		if (backup !== undefined) window.clearTimeout(backup);
		// Backing a large document up is one whole-document `toString()` plus one whole-file
		// transfer: at keystroke cadence that is visible jank, so large documents back up on
		// a slower clock (and still on save and on close).
		const large = (editor.view?.state.doc.length ?? 0) > LARGE_DOC_CHARS;
		this.backupTimers.set(editor.id, window.setTimeout(() => {
			this.backupTimers.delete(editor.id);
			if (!editor.dirty || !editor.view || editor.input.kind !== 'file') return;
			// The path is read when the timer fires, not when the edit was made: a rename
			// in between retargets the backup with the editor.
			void backupWrite(editor.input.path, editor.view.state.doc.toString()).catch(() => undefined);
		}, large ? LARGE_BACKUP_DELAY_MS : BACKUP_DELAY_MS));
		if (settings.autoSave === 'afterDelay') {
			const pending = this.autoSaveTimers.get(editor.id);
			if (pending !== undefined) window.clearTimeout(pending);
			this.autoSaveTimers.set(editor.id, window.setTimeout(() => {
				this.autoSaveTimers.delete(editor.id);
				void this.save(editor);
			}, Math.max(100, settings.autoSaveDelay)));
		}
	},

	onWindowBlur(): void {
		if (settings.autoSave === 'onFocusChange' || settings.autoSave === 'onWindowChange') void this.saveAll();
	},

	onEditorBlur(editor: Editor): void {
		if (settings.autoSave === 'onFocusChange' && editor.dirty) void this.save(editor);
	},

	async restoreBackup(path: string, contents: string): Promise<boolean> {
		await this.openFile(path);
		const editor = this.open.find((e) => e.input.kind === 'file' && e.input.path === path);
		if (editor?.doc) {
			await editor.doc.replaceText(contents);
			editor.dirty = true;
			this.renderTabs();
			return true;
		}
		if (!editor?.view) return false;
		const current = editor.view.state.doc.toString();
		if (current !== contents) editor.view.dispatch({ changes: { from: 0, to: current.length, insert: contents } });
		editor.dirty = true;
		this.renderTabs();
		return true;
	},

	forgetBackup(editor: Editor): void {
		if (editor.input.kind !== 'file') return;
		const timer = this.backupTimers.get(editor.id);
		if (timer !== undefined) window.clearTimeout(timer);
		this.backupTimers.delete(editor.id);
		const autoSave = this.autoSaveTimers.get(editor.id);
		if (autoSave !== undefined) window.clearTimeout(autoSave);
		this.autoSaveTimers.delete(editor.id);
		void backupClear(editor.input.path).catch(() => undefined);
	},

	bufferAtSavedState(editor: Editor): boolean {
		if (!editor.view || editor.savedDoc === undefined) return false;
		return editor.view.state.doc.eq(editor.savedDoc)
			&& (editor.eol ?? 'lf') === (editor.savedEol ?? 'lf')
			&& (editor.encoding ?? 'utf8') === (editor.savedEncoding ?? 'utf8');
	},

	async reloadIfClean(path: string): Promise<void> {
		const editor = this.open.find((e) => e.input.kind === 'file' && e.input.path === path);
		if (!editor || editor.dirty) return;
		// A windowed editor's document lives in the backend: it compares the file's stamp
		// there and reloads only when the disk really changed (a save's own watcher echo
		// reads as unchanged, so the cursor never jumps after a save).
		if (editor.doc) {
			await editor.doc.reload();
			return;
		}
		if (editor.image) {
			await editor.image.reload();
			return;
		}
		const view = editor.view;
		if (!view) return;
		try {
			const file = await readFileRaw(path);
			if (file.contents === null) return;
			// The read was async: the editor may have been closed, dirtied, or swapped to
			// another surface (hex, fast view) while it was in flight, and a stale
			// whole-document replace would then wipe what is on screen now.
			if (editor.dirty || !this.open.includes(editor) || editor.view !== view) return;
			const current = view.state.doc.toString();
			editor.encoding = file.encoding ?? editor.encoding;
			editor.eol = file.eol ?? editor.eol;
			// The document holds LF (CodeMirror normalises CRLF on insert) while the read
			// carries the file's decoded bytes verbatim: an unchanged CRLF file never compares
			// equal as-is, and every refresh - a window refocus among them - would rebuild the
			// whole document (a full re-highlight) and nudge the view for nothing.
			if (current === file.contents || current === file.contents.replace(/\r\n?/g, '\n')) return;
			editorState.cm?.replaceDocument(view, file.contents);
			editor.dirty = false;
			// The reloaded disk text is the saved baseline the dirty mark compares against.
			editor.savedDoc = view.state.doc;
			editor.savedEol = editor.eol;
			editor.savedEncoding = editor.encoding;
			this.renderTabs();
			this.refreshPreviews(path);
			// The silent reload's one sign (§7.3): the tab flashes that another device
			// wrote this file, and the hint goes again on its own.
			this.flashReloadedTab(editor);
		} catch {
			// Deleted meanwhile: the tab keeps its last contents, as VS Code does.
		}
	},

	/** The §7.3 conflict check: the watcher named a file this tab holds DIRTY — a clean
	 *  tab would have taken `reloadIfClean`'s silent reload, so the only remaining case
	 *  is the disk moving under unsaved changes. The watcher's echo of OUR OWN save reads
	 *  back the baseline this tab knows and is not a conflict; a disk that still equals
	 *  the buffer never was one. A windowed editor's document lives in the backend and
	 *  owns its own merge — not this bar's fight. */
	async markSaveConflict(path: string): Promise<void> {
		const editor = this.open.find((e) => e.input.kind === 'file' && e.input.path === path);
		if (!editor || !editor.dirty || !editor.view || editor.doc) return;
		if (editor.conflict) return; // the bar is already up; a newer write keeps it
		let file: FileContents;
		try {
			file = await readFileRaw(path);
		} catch {
			return;
		}
		if (file.contents === null) return;
		// The read was async: the tab may have closed, cleaned or settled meanwhile.
		if (!editor.dirty || editor.conflict || !this.open.includes(editor) || !editor.view) return;
		const mine = editor.view.state.doc.toString();
		const base = editor.savedDoc?.toString();
		const disk = file.contents;
		if (disk === mine || disk === base || disk === base?.replace(/\r\n?/g, '\n')) return;
		editor.conflict = true;
		this.renderSaveConflictBar(editor, file);
	},

	/** The three-way bar over a conflicted editor (§7.3): compare, take the disk version,
	 *  or keep mine (the next save overwrites). One bar per editor, replaced not stacked. */
	renderSaveConflictBar(editor: Editor, file: FileContents): void {
		if (editor.input.kind !== 'file') return;
		const disk = file.contents ?? '';
		const path = editor.input.path;
		editor.pane.querySelector('.conflict-bar')?.remove();
		const take = (): void => {
			const view = editor.view;
			if (view) {
				editorState.cm?.replaceDocument(view, disk);
				editor.dirty = false;
				editor.savedDoc = view.state.doc;
				editor.encoding = file.encoding ?? editor.encoding;
				editor.eol = file.eol ?? editor.eol;
				editor.savedEol = editor.eol;
				editor.savedEncoding = editor.encoding;
				this.forgetBackup(editor);
				this.renderTabs();
				this.refreshPreviews(path);
			}
			this.clearSaveConflict(editor);
		};
		const bar = el('div', 'conflict-bar', [
			el('span', 'conflict-bar-text', [t('editor.conflict.savedElsewhere')]),
			el('span', 'conflict-bar-actions', [
				el('button', '', [t('editor.conflict.compare')]),
				el('button', '', [t('editor.conflict.useDisk')]),
				el('button', '', [t('editor.conflict.keepMine')])
			])
		]);
		const [compare, useDisk, keepMine] = [...bar.querySelectorAll('button')];
		compare?.addEventListener('click', () => {
			void this.openDiff({
				kind: 'diff',
				id: `conflict:${path}`,
				title: editor.label,
				left: { revision: '*', path, label: t('editor.conflict.diskSide'), content: disk, exists: true, local: true },
				right: { revision: '*', path, label: t('editor.conflict.mineSide'), content: editor.view?.state.doc.toString() ?? '', exists: true, local: true }
			});
		});
		useDisk?.addEventListener('click', take);
		keepMine?.addEventListener('click', () => this.clearSaveConflict(editor));
		editor.pane.prepend(bar);
	},

	/** The conflict is settled (saved, the disk version taken, or "keep mine" chosen): the
	 *  bar goes, the mark with it. */
	clearSaveConflict(editor: Editor): void {
		if (!editor.conflict && !editor.pane.querySelector('.conflict-bar')) return;
		editor.conflict = false;
		editor.pane.querySelector('.conflict-bar')?.remove();
	},

	/** The clean reload's own hint (§7.3): a distinct flash, 1.5 s, with the tab's title
	 *  telling what happened while the pointer rests on it. */
	flashReloadedTab(editor: Editor): void {
		const at = this.open.indexOf(editor);
		if (at < 0) return;
		const tab = this.tabs.children[at] as HTMLElement | undefined;
		if (!tab) return;
		const previous = tab.title;
		tab.classList.add('external-reload');
		tab.title = t('editor.conflict.reloaded');
		window.setTimeout(() => {
			tab.classList.remove('external-reload');
			tab.title = previous;
		}, 1500);
	},

	pathRenamed(from: string, to: string): void {
		for (const editor of this.open) {
			const kind = editor.input.kind;
			// Hex and markdown-preview tabs are views over a file too: they follow the rename.
			if (kind !== 'file' && kind !== 'hex' && kind !== 'markdown') continue;
			const path = editor.input.path;
			if (path !== from && !toPosix(path).startsWith(toPosix(from) + '/')) continue;
			const updated = to + path.slice(from.length);
			const previousId = editor.id;
			const previousInput = editor.input;
			if (kind === 'file') {
				editor.input = { kind: 'file', path: updated };
				editor.label = basename(updated);
				editor.iconClass = fileIcon(editor.label);
			} else if (kind === 'hex') {
				editor.input = { kind: 'hex', path: updated };
				editor.label = `Hex ${basename(updated)}`;
			} else {
				editor.input = { kind: 'markdown', path: updated };
				editor.label = `Preview ${basename(updated)}`;
			}
			editor.id = inputId(editor.input);
			// The history's stops hold the editor's input by identity: Back to a renamed file
			// must land on the new path (a closed tab would otherwise reopen the old one),
			// and the cursor bookkeeping in `activate` matches stops by that identity too.
			for (const entry of this.navHistory) {
				if (entry.input === previousInput) entry.input = editor.input;
			}
			// The hex view caches its own path copy for the byte-patch save.
			editor.hex?.setPath(updated);
			// Timers are keyed by the editor id: pending backup / auto-save / preview
			// refreshes move to the new id so they can still be found and cleared.
			for (const timers of [this.backupTimers, this.autoSaveTimers, this.previewTimers]) {
				const timer = timers.get(previousId);
				if (timer !== undefined) {
					timers.delete(previousId);
					timers.set(editor.id, timer);
				}
			}
		}
		// Stops of tabs closed before the rename hold their own input objects: respelled by
		// path, so Back reopens the file under its new name rather than failing on the old.
		for (const entry of this.navHistory) {
			const kind = entry.input.kind;
			if (kind !== 'file' && kind !== 'hex' && kind !== 'markdown') continue;
			const path = entry.input.path;
			if (path !== from && !toPosix(path).startsWith(toPosix(from) + '/')) continue;
			entry.input = { ...entry.input, path: to + path.slice(from.length) };
		}
		this.update();
	},

	async pathDeleted(path: string): Promise<void> {
		for (const editor of [...this.open]) {
			if (editor.input.kind !== 'file') continue;
			const target = editor.input.path;
			if (target === path || toPosix(target).startsWith(toPosix(path) + '/')) {
				editor.dirty = false;
				await this.close(editor);
			}
		}
	},

	flashSavedTab(editor: Editor): void {
		const at = this.open.indexOf(editor);
		if (at < 0) return;
		const tab = this.tabs.children[at] as HTMLElement | undefined;
		if (!tab) return;
		tab.classList.add('just-saved');
		window.setTimeout(() => tab.classList.remove('just-saved'), 200);
	},
};
