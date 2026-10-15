// The viewer mounting paths: the CodeMirror/text, windowed, hex, image and CAN-text
// mounts, the fast-view swaps and the text services attach — called from the open
// orchestration (open.ts), split out so neither file outgrows the other.

import { type FileContents, type FileProbe, fileProbe, readFileBase64 } from '../../platform/ipc/fs';
import { declaredLanguageName } from '../extensions';
import { loadCanViews, loadEditorExtensions, loadFastView, loadHexView } from '../../platform/lazy';
import { imageMime } from '../../platform/markdown';
import { t } from '../../platform/i18n';
import { settings } from '../../platform/settings';
import { basename, el, icon, notify, showContextMenu } from '../../platform/ui/index';
import { hook } from '../../platform/hooks';
import { readFileRaw } from './shared';
import { WHOLE_FILE_EDITOR_BYTES, WINDOWED_EDIT_BYTES, loadDocEdit, textEditor } from './open';
import type { Editor } from './inputs';

/** The mounting concern of EditorGroup — assigned onto the prototype by the module facade. */
export const mountMethods: ThisType<import('./group').EditorGroup> = {
	async tryMountFastView(editor: Editor, parent: HTMLElement = editor.pane, indexed = false, onEdit?: () => void): Promise<boolean> {
		if (editor.input.kind !== 'file') return false;
		const { FastView } = await loadFastView();
		const view = new FastView(parent, onEdit ? { onEdit } : {});
		if (!(await view.openFile(editor.input.path, { indexed }))) {
			view.dispose();
			return false;
		}
		editor.fast = view;
		editor.languageName = view.languageName ?? undefined;
		return true;
	},

	async tryMountDocEdit(editor: Editor, parent: HTMLElement = editor.pane): Promise<boolean> {
		if (editor.input.kind !== 'file') return false;
		const { EditableDocView } = await loadDocEdit();
		const view = new EditableDocView(parent);
		if (!(await view.openFile(editor.input.path))) {
			view.dispose();
			return false;
		}
		view.onChanged = (clean) => {
			// The backend's verdict — the rope is back at what the file holds on disk — is
			// the tab's dirty mark: an undo (or a delete) that returns the buffer to the
			// saved text clears it, exactly as the full editor's own comparison does.
			if (clean) {
				if (editor.dirty) {
					editor.dirty = false;
					this.forgetBackup(editor);
					this.renderTabs();
				}
				return;
			}
			if (!editor.dirty) {
				editor.dirty = true;
				this.renderTabs();
			}
			// Hot-exit backups are written backend-side by the view itself; only the
			// delayed auto-save rides through the group like any editor's.
			if (settings.autoSave === 'afterDelay') {
				const pending = this.autoSaveTimers.get(editor.id);
				if (pending !== undefined) window.clearTimeout(pending);
				this.autoSaveTimers.set(editor.id, window.setTimeout(() => {
					this.autoSaveTimers.delete(editor.id);
					void this.save(editor);
				}, Math.max(100, settings.autoSaveDelay)));
			}
		};
		view.onSaveRequest = () => void this.save(editor);
		view.onStatusChange = () => this.emitActive();
		view.onSaveProgress = (progress) => this.onSaveProgress?.(progress);
		editor.doc = view;
		editor.languageName = view.languageName ?? undefined;
		editor.onClose = () => editor.doc?.dispose();
		return true;
	},

	async swapFastToWholeEditor(editor: Editor): Promise<void> {
		if (editor.input.kind !== 'file' || !editor.fast) return;
		const path = editor.input.path;
		try {
			const probe = await fileProbe(path);
			if (probe.size > WHOLE_FILE_EDITOR_BYTES) {
				notify('info', t('viewer.tooLargeWholeFile') + basename(path));
				return;
			}
		} catch {
			// No verdict on the size: the read below answers with the real error.
		}
		let file: FileContents;
		try {
			file = await readFileRaw(path);
		} catch (error) {
			notify('error', String(error));
			return;
		}
		if (file.binary || file.contents === null) {
			// The file changed under the view (the probe saw text, this read does not).
			notify('info', t('viewer.readOnlyFallback') + basename(path));
			return;
		}
		const parent = editor.fast.root.parentElement ?? editor.pane;
		editor.fast.dispose();
		editor.fast = undefined;
		editor.encoding = file.encoding ?? 'utf8';
		editor.eol = file.eol ?? 'lf';
		await this.mountTextEditor(editor, file.contents, parent);
		this.attachMergeSupport(editor);
		this.updateOutline(editor);
		this.emitActive();
	},

	async swapCanRawToText(editor: Editor): Promise<void> {
		if (editor.input.kind !== 'file' || !editor.canraw) return;
		editor.canraw.dispose();
		editor.canraw = undefined;
		editor.onClose = undefined;
		editor.pane.replaceChildren();
		await this.mountCanTextForm(editor);
		this.emitActive();
	},

	async mountCanTextForm(editor: Editor): Promise<void> {
		if (editor.input.kind !== 'file') return;
		const path = editor.input.path;
		const frames = el('button', 'button secondary can-frames', [icon('pulse'), ' Frames']);
		frames.title = 'Switch back to the CAN frame view';
		frames.addEventListener('click', () => void this.swapTextToCanRaw(editor));
		const pathChip = el('span', 'can-path', [path]);
		pathChip.title = path;
		const bar = el('div', 'hex-toolbar can-text-bar', [pathChip, el('span', 'hex-toolbar-sep'), frames]);
		// The bar and the editor share a wrapper: the fast viewer styles itself
		// `position: absolute; inset: 0`, which would otherwise cover the bar outright.
		const wrap = el('div', 'can-text-wrap', [bar]);
		editor.pane.append(wrap);
		let probe: FileProbe | null = null;
		try {
			probe = await fileProbe(path);
		} catch {
			probe = null; // `read_file` below reports the real error
		}
		// A large log edits in the windowed editor whatever its size — no read-only wall.
		// A minified one (few enormous lines) or a document the rope backend refuses opens
		// in the indexed fast viewer instead, still offering the whole-file editor through
		// its Edit button.
		if (probe !== null && probe.size > hook('openThreshold')(WINDOWED_EDIT_BYTES)) {
			if (!probe.longLines && (await this.tryMountDocEdit(editor, wrap))) return;
			if (await this.tryMountFastView(editor, wrap, true, () => void this.swapFastToWholeEditor(editor))) {
				if (!probe.longLines) notify('info', t('viewer.readOnlyFallback') + basename(path));
				return;
			}
		}
		let file: FileContents;
		try {
			file = await readFileRaw(path);
		} catch (error) {
			notify('error', String(error));
			return;
		}
		if (file.binary || file.contents === null) {
			// A binary "text form" (a .blf whose Raw button was pressed) is the hex viewer,
			// inside the wrapper so the path bar with the Frames button stays above it.
			await this.mountHexView(editor, wrap);
		} else {
			editor.encoding = file.encoding ?? 'utf8';
			editor.eol = file.eol ?? 'lf';
			await this.mountTextEditor(editor, file.contents, wrap);
			this.attachMergeSupport(editor);
			this.updateOutline(editor);
		}
	},

	async swapTextToCanRaw(editor: Editor): Promise<void> {
		if (editor.input.kind !== 'file') return;
		if (editor.dirty) {
			await this.save(editor);
			if (!editor.dirty) await this.swapTextToCanRaw(editor);
			return;
		}
		const { CanRawView } = await loadCanViews();
		if (!this.open.includes(editor) || editor.canraw) return; // closed, or swapped meanwhile
		editor.view?.destroy();
		editor.view = undefined;
		editor.fast?.dispose();
		editor.fast = undefined;
		editor.doc?.dispose();
		editor.doc = undefined;
		// The text form of a binary log is the hex viewer (the Raw button's landing); its
		// observer and slab caches must go with the swap back.
		editor.hex?.destroy();
		editor.hex = undefined;
		editor.mergeToolbar = undefined;
		editor.outline?.remove();
		editor.outline = undefined;
		editor.pane.classList.remove('has-outline');
		editor.pane.replaceChildren();
		const path = editor.input.path;
		editor.languageName = 'CAN Log';
		editor.canraw = new CanRawView(path, {
			onAnalyze: () => this.openCanStats(path),
			onEditText: () => void this.swapCanRawToText(editor)
		});
		editor.pane.appendChild(editor.canraw.root);
		editor.onClose = () => editor.canraw?.dispose();
		this.emitActive();
	},

	async mountHexView(editor: Editor, parent: HTMLElement = editor.pane): Promise<void> {
		if (editor.input.kind !== 'file' && editor.input.kind !== 'hex') return;
		editor.languageName = 'Hex';
		const { HexView } = await loadHexView();
		const view = new HexView(editor.input.path, {
			onDirtyChange: (dirty) => {
				editor.dirty = dirty;
				this.renderTabs();
			}
		});
		editor.hex = view;
		// The view's observer and slab caches outlive the tab unless they're released.
		editor.onClose = () => view.destroy();
		editor.pane.classList.add('binary-hex');
		parent.appendChild(view.root);
		await view.load();
	},

	async mountImagePreview(editor: Editor): Promise<void> {
		if (editor.input.kind !== 'file') return;
		const path = editor.input.path;
		editor.languageName = 'Image';
		const image = el('img', 'image-preview-img');
		image.alt = editor.label;
		const status = el('div', 'image-preview-status', ['Loading…']);
		const stage = el('div', 'image-preview-stage', [image]);
		let zoom = 1;
		let fit = true;
		const apply = () => {
			image.style.width = fit ? '' : `${image.naturalWidth * zoom}px`;
			image.classList.toggle('fit', fit);
			zoomLabel.textContent = fit ? 'Fit' : `${Math.round(zoom * 100)}%`;
		};
		const zoomLabel = el('span', 'image-preview-zoom', ['Fit']);
		const button = (label: string, title: string, run: () => void) => {
			const b = el('button', 'button secondary', [label]);
			b.title = title;
			b.addEventListener('click', run);
			return b;
		};
		const toolbar = el('div', 'image-preview-toolbar', [
			button('−', 'Zoom Out', () => { fit = false; zoom = Math.max(0.1, zoom / 1.25); apply(); }),
			zoomLabel,
			button('+', 'Zoom In', () => { fit = false; zoom = Math.min(16, zoom * 1.25); apply(); }),
			button('1:1', 'Actual Size', () => { fit = false; zoom = 1; apply(); }),
			button('Fit', 'Fit to Window', () => { fit = true; apply(); })
		]);
		// The wheel zooms like a desktop image viewer: a notch up zooms in, down zooms out,
		// anchored on the pointer — the image fraction under the cursor stays under it. The
		// Ctrl wheel that would otherwise zoom the whole window is swallowed here too.
		stage.addEventListener('wheel', (e) => {
			if (!e.deltaY) return; // a purely horizontal wheel pans
			e.preventDefault();
			if (!image.naturalWidth) return; // not loaded yet — nothing to scale
			const before = image.getBoundingClientRect();
			const fx = before.width > 0 ? (e.clientX - before.left) / before.width : 0.5;
			const fy = before.height > 0 ? (e.clientY - before.top) / before.height : 0.5;
			// Leaving Fit starts from the fitted scale, so the first notch grows the image
			// as it is on screen rather than jumping to its natural size's zoom.
			if (fit && before.width > 0) zoom = before.width / image.naturalWidth;
			fit = false;
			zoom = e.deltaY < 0 ? Math.min(16, zoom * 1.25) : Math.max(0.1, zoom / 1.25);
			apply();
			const after = image.getBoundingClientRect();
			stage.scrollLeft += after.left + fx * after.width - e.clientX;
			stage.scrollTop += after.top + fy * after.height - e.clientY;
		}, { passive: false });
		editor.pane.classList.add('image-preview');
		editor.pane.append(toolbar, stage, status);
		try {
			const data = await readFileBase64(path);
			image.src = `data:${imageMime(editor.label)};base64,${data}`;
			const size = Math.round((data.length * 3) / 4);
			image.addEventListener('load', () => {
				status.textContent = `${image.naturalWidth}×${image.naturalHeight}  ${size < 1024 ? `${size} B` : size < 1024 * 1024 ? `${(size / 1024).toFixed(1)} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`}`;
				apply();
			});
			status.textContent = `${size < 1024 ? `${size} B` : `${(size / 1024).toFixed(1)} KB`}`;
		} catch (error) {
			status.textContent = String(error);
		}
	},

	async mountTextEditor(editor: Editor, contents: string, parent: HTMLElement = editor.pane): Promise<void> {
		const { EditorView, EditorState, baseExtensions, completionExtension, bookmarkGutter, languageSlot, blameSlot, keymap, loadLanguage, editLockSlot, editLockedExtensions } = await textEditor();
		const [{ diagnosticsExtension }, { extensionDecorationsExtension }, { extensionProviderExtensions }] = await loadEditorExtensions();
		// A phone's remote workbench opens files locked: the app bar's lock button toggles
		// the edit grant (src/remote/editLock.ts). Everywhere else this is false and
		// the editor is born editable as always.
		const editLocked = hook('editLock').defaultLocked();
		editor.languageName = 'Plain Text';
		editor.view = new EditorView({
			state: EditorState.create({
				doc: contents,
				extensions: [
					// The lock must lead: `EditorState.readOnly`'s facet combine honours the
					// first value, so baseExtensions' own `readOnly.of(false)` would otherwise
					// swallow the locked `true` that follows it.
					...(editLocked ? [editLockSlot.of(editLockedExtensions())] : []),
					...baseExtensions(false, editor.input.kind === 'file' ? editor.input.path : editor.label),
					...completionExtension(editor.input.kind === 'file' ? editor.input.path : editor.label),
					...(editor.input.kind === 'file' ? [diagnosticsExtension(editor.input.path), extensionDecorationsExtension(editor.input.path), extensionProviderExtensions(editor.input.path)] : []),
					bookmarkGutter(editor.input.kind === 'file' ? editor.input.path : ''),
					languageSlot.of([]),
					blameSlot.of([]),
					keymap.of([
					{ key: 'Mod-s', preventDefault: true, run: () => (void this.save(editor), true) }
				]),
					EditorView.domEventHandlers({ blur: () => this.onEditorBlur(editor) }),
					EditorView.updateListener.of((update) => {
						if (update.docChanged) {
							// Dirty means "differs from the last saved state", recomputed on every
							// change: the undo — or the plain delete — that returns the text exactly
							// to the saved content clears the mark again.
							const dirty = !this.bufferAtSavedState(editor);
							if (dirty !== editor.dirty) {
								editor.dirty = dirty;
								if (!dirty) this.forgetBackup(editor);
								this.renderTabs();
							}
							editor.mergeToolbar?.update();
							this.onEdited(editor);
						}
						if (update.selectionSet || update.docChanged) this.emitActive();
					})
				]
			}),
			parent
		});
		// The baseline the dirty mark compares against: this content, these line endings,
		// this encoding — exactly what a save would write right now.
		editor.savedDoc = editor.view.state.doc;
		editor.savedEol = editor.eol;
		editor.savedEncoding = editor.encoding;
		if (editLocked) hook('editLock').register(parent, (locked) => editor.view?.dispatch({ effects: editLockSlot.reconfigure(locked ? editLockedExtensions() : []) }), () => editor.view?.focus());
		// The language loads asynchronously: by the time it arrives the editor may have been
		// remounted (a reopen with encoding rebuilds the view), so reconfigure the view that
		// was built here, and only while it is still the editor's current one.
		const view = editor.view;
		void loadLanguage(editor.label).then((language) => {
			if (editor.view !== view) return;
			if (language) {
				editor.languageName = language.name;
				view.dispatch({ effects: languageSlot.reconfigure(language.support) });
			} else {
				// No CodeMirror language — but an installed extension may still declare one
				// (`contributes.languages`): its name labels the editor (and scopes snippets).
				editor.languageName = declaredLanguageName(editor.label) ?? 'Plain Text';
			}
			this.emitActive();
		});
		this.attachTextServices(editor);
	},

	attachTextServices(editor: Editor): void {
		const posAt = (event: MouseEvent): number | null => {
			if (!editor.view) return null;
			try {
				return editor.view.posAtCoords({ x: event.clientX, y: event.clientY });
			} catch {
				return null; // no layout yet (the tests' jsdom): fall back to the selection
			}
		};
		editor.pane.addEventListener('contextmenu', (event) => {
			event.preventDefault();
			showContextMenu(event.clientX, event.clientY, this.textMenu(editor, posAt(event)));
		});
		editor.pane.addEventListener('mousedown', (event) => {
			if ((event.ctrlKey || event.metaKey) && event.button === 0 && editor.view) {
				event.preventDefault();
				void this.goToDefinition(editor, posAt(event));
			}
		});
	},
};
