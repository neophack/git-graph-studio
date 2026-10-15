import type { Extension } from '@codemirror/state';
import { type FileContents, type FileProbe, fileProbe, readFileBase64 } from '../../platform/ipc/fs';
import { materializeRevisionFile, readFileAt } from '../../platform/ipc/revision';
import { scmBlame } from '../../platform/ipc/scm';
import { hasBookmark } from './bookmarks';
import { samePath, contextUri, menuSection, resourceContext } from '../extensions';
import { loadAnalysisPages, loadCanViews, loadCallTree, loadFileHistory, loadFolderCompare, loadHexCompare, loadMerge, loadSymbolDbView, loadTextEditor } from '../../platform/lazy';
import { imageMime, renderMarkdown } from '../../platform/markdown';
import type { BlameLine } from '../scm/types';
import type { WsSymbol } from '../search/types';
import { commands } from '../../platform/commands';
import { t } from '../../platform/i18n';
import { basename, el, icon, joinPath, notify, relativeTo, type MenuEntry } from '../../platform/ui/index';
import { fileIcon, isCanLog } from '../../platform/fileIcons';
import { hook } from '../../platform/hooks';
import type { DiffSide } from './types';
import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager';
import type { EditorGroup } from './group';
import { editorState } from './editorState';
import { notice, readFileRaw } from './shared';
import type { Editor, EditorInput } from './inputs';
import { ANALYSIS_PAGE_ICONS, ANALYSIS_PAGE_LABELS } from './inputs';
import type * as TextEditor from './textEditor';



export async function textEditor(): Promise<typeof TextEditor> {
	return (editorState.cm ??= await loadTextEditor());
}


export async function loadDocEdit(): Promise<typeof import('./docEditView')> {
	return (editorState.docEditModule ??= await import('./docEditView'));
}


/** Files past this size open in the windowed editable editor (`docEditView.ts`): the
 *  document lives in the backend's rope and the webview holds a window of lines, so editing
 *  a 100 MB log costs the same as editing a 10 KB one — with no upper size wall. Below it
 *  the full editor is snappier (its extras — minimap, folding, completion — all work).
 *  Minified files (few enormous lines) defeat the line window: a small one takes the full
 *  editor, a large one the read-only indexed view with its Edit button into the full
 *  editor. */
export const WINDOWED_EDIT_BYTES = 8 * 1024 * 1024;


/** Past this the fast viewer's Edit button refuses the swap to the whole-file editor: that
 *  editor holds the file as one JavaScript string, and V8 strings cap at 2²⁹ − 24
 *  characters — a byte past this margin would make the decode throw instead of edit. */
export const WHOLE_FILE_EDITOR_BYTES = 480 * 1024 * 1024;

/** How long after the last keystroke a Markdown preview follows its source. */
const PREVIEW_DELAY_MS = 300;




/** Below this width (px) a diff drops the side-by-side layout for a single-column inline view. */
const DIFF_SPLIT_MIN_WIDTH = 720;


/** Every open Markdown preview, across groups: a source's edits refresh its preview wherever
 *  the preview tab lives, and the scroll sync finds its pair without caring which group
 *  holds either side. */
const markdownPreviews = new Set<Editor>();

/** Resolves a file's open editor across every group; the editor area, which owns them, sets
 *  itself as the resolver - a preview split to its own group still follows edits to the
 *  source that stayed behind in the original one. */
export const fileEditorResolver: { find: ((path: string) => Editor | null) | null } = { find: null };

/** While one side of a preview pair is scrolled programmatically (until this timestamp), the
 *  other side ignores the scroll events that causes - without the lock, the two scroll
 *  listeners would bounce each other forever. */
const syncLocks = new Map<string, number>();


/** The px offset from a scroller's top a synced scroll lands its target line at. */
const SYNC_TOP_OFFSET = 4;


/** The open concern of EditorGroup — assigned onto the prototype by the module facade. */
export const openMethods: ThisType<EditorGroup> = {
	async openContent(input: Extract<EditorInput, { kind: 'content' }>): Promise<void> {
		const intent = this.beginOpen();
		const existing = this.open.find((e) => e.input.kind === 'content' && e.input.id === input.id);
		if (existing) {
			this.activate(existing);
			return;
		}
		const editor: Editor = {
			input,
			id: 'content:' + input.id,
			label: input.title,
			iconClass: fileIcon(input.path || input.title),
			pane: el('div', 'editor-pane'),
			dirty: false
		};
		const { EditorView, EditorState, baseExtensions, languageSlot, loadLanguage } = await textEditor();
		editor.languageName = 'Plain Text';
		editor.view = new EditorView({
			state: EditorState.create({
				doc: input.text,
				extensions: [baseExtensions(true, input.path || input.title), languageSlot.of([])]
			}),
			parent: editor.pane
		});
		const view = editor.view;
		void loadLanguage(input.path || input.title).then((language) => {
			if (editor.view !== view || !language) return;
			editor.languageName = language.name;
			view.dispatch({ effects: languageSlot.reconfigure(language.support) });
		});
		this.add(editor, true, intent);
	},

	async openFile(path: string, options: { line?: number; column?: number; inactive?: boolean } = {}): Promise<void> {
		const intent = this.beginOpen();
		// Any spelling of an open file reveals its tab (an extension's backslashed path is
		// the Explorer's forward-slashed one).
		const existing = this.open.find((e) => e.input.kind === 'file' && samePath(e.input.path, path));
		if (existing) {
			this.activate(existing);
			if (options.line !== undefined) {
				// A jump into a line of a CAN log (a search hit) lands in the text form — the
				// raw frame view has no text lines to reveal.
				if (existing.canraw) void this.swapCanRawToText(existing).then(() => this.revealIn(existing, options.line!, options.column ?? 1));
				else this.revealIn(existing, options.line, options.column ?? 1);
			}
			return;
		}
		const name = basename(path);
		const editor: Editor = {
			input: { kind: 'file', path },
			id: 'file:' + path,
			label: name,
			iconClass: fileIcon(name),
			pane: el('div', 'editor-pane'),
			dirty: false
		};
		// `show` folds the ticket in: a stale open still adds its tab, but neither shows nor
		// reveals it — the user's last pick keeps the view.
		const show = () => !options.inactive && this.holdsIntent(intent);
		// An image opens in the image preview rather than as bytes in a text editor.
		if (imageMime(name)) {
			await this.mountImagePreview(editor);
			this.add(editor, show(), intent);
			return;
		}
		// A CAN trace (.blf / .asc) opens in the raw frame view: the backend parses in the
		// background while the viewport browses frames as they arrive. The statistics
		// analysis is a separate tab, opened from that view's Statistics button. A jump to a
		// text position (a search hit) opens the log's text form instead — that is where the
		// line exists.
		if (isCanLog(name)) {
			if (options.line !== undefined) {
				editor.languageName = 'Plain Text';
				editor.pane.classList.add('can-log');
				await this.mountCanTextForm(editor);
				const showNow = show();
				this.add(editor, showNow, intent);
				if (!showNow) return;
				this.revealIn(editor, options.line, options.column ?? 1);
				// The activation recorded the new editor at 1:1; note where it actually landed.
				if (this.navIndex >= 0 && this.navHistory[this.navIndex]!.input === editor.input) {
					this.navHistory[this.navIndex] = { input: editor.input, line: options.line, column: options.column ?? 1 };
				}
				return;
			}
			editor.languageName = 'CAN Log';
			editor.iconClass = 'pulse';
			const { CanRawView } = await loadCanViews();
			editor.canraw = new CanRawView(path, {
				onAnalyze: () => this.openCanStats(path),
				onEditText: () => void this.swapCanRawToText(editor)
			});
			editor.pane.classList.add('can-log');
			editor.pane.appendChild(editor.canraw.root);
			editor.onClose = () => editor.canraw?.dispose();
			this.add(editor, show(), intent);
			return;
		}
		// One small probe (the size and a binary sniff of the first bytes) routes the open
		// before any byte of the body is read: a binary file goes straight to the hex viewer,
		// and only an enormous text file (past what an editable document can hold) to the
		// fast viewer - neither is ever read whole here.
		let probe: FileProbe | null = null;
		try {
			probe = await fileProbe(path);
		} catch {
			probe = null; // `read_file` below reports the real error
		}
		if (probe?.binary) {
			await this.mountHexView(editor);
			this.add(editor, show(), intent);
			return;
		}
		// A large text file edits in the windowed editor — no size wall: the document lives
		// in the backend's rope (built in parallel chunks however big the file is) and the
		// webview holds one window of lines. A minified file (few enormous lines that defeat
		// line windows) opens in the read-only fast viewer instead, as does any document the
		// rope backend refuses — both still offer the whole-file editor through the view's
		// Edit button, and only when every editable surface refuses does the plain
		// read-and-mount path below take over.
		if (probe !== null && probe.size > hook('openThreshold')(WINDOWED_EDIT_BYTES)) {
			const offerWholeEditor = () => void this.swapFastToWholeEditor(editor);
			if (!probe.longLines && (await this.tryMountDocEdit(editor))) {
				const showNow = show();
				this.add(editor, showNow, intent);
				if (!showNow) return;
				if (options.line !== undefined) {
					this.revealIn(editor, options.line, options.column ?? 1);
					// The activation recorded the new editor at 1:1; note where it actually landed.
					if (this.navIndex >= 0 && this.navHistory[this.navIndex]!.input === editor.input) {
						this.navHistory[this.navIndex] = { input: editor.input, line: options.line, column: options.column ?? 1 };
					}
				}
				return;
			}
			if (await this.tryMountFastView(editor, editor.pane, true, offerWholeEditor)) {
				if (!probe.longLines) notify('info', t('viewer.readOnlyFallback') + basename(path));
				const showNow = show();
				this.add(editor, showNow, intent);
				if (!showNow) return;
				if (options.line !== undefined) this.revealIn(editor, options.line, options.column ?? 1);
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
			// A binary file opens in the hex viewer (M3 3.7) rather than only a notice.
			await this.mountHexView(editor);
		} else {
			editor.encoding = file.encoding ?? 'utf8';
			editor.eol = file.eol ?? 'lf';
			await this.mountTextEditor(editor, file.contents);
			this.attachMergeSupport(editor);
			this.updateOutline(editor);
		}
		const showNow = show();
		this.add(editor, showNow, intent);
		if (!showNow) return;
		if (options.line !== undefined) {
			this.revealIn(editor, options.line, options.column ?? 1);
			// The activation recorded the new editor at 1:1; note where it actually landed.
			if (this.navIndex >= 0 && this.navHistory[this.navIndex]!.input === editor.input) {
				this.navHistory[this.navIndex] = { input: editor.input, line: options.line, column: options.column ?? 1 };
			}
		}
	},







	async openHex(path?: string): Promise<void> {
		if (path === undefined) path = this.activeInput?.kind === 'file' ? this.activeInput.path : '';
		if (!path) return;
		const id = 'hex:' + path;
		const existing = this.open.find((e) => e.id === id);
		if (existing) {
			this.activate(existing);
			return;
		}
		const intent = this.beginOpen();
		const editor: Editor = {
			input: { kind: 'hex', path },
			id,
			label: `Hex ${basename(path)}`,
			iconClass: 'file-binary',
			pane: el('div', 'editor-pane'),
			dirty: false
		};
		await this.mountHexView(editor);
		this.add(editor, true, intent);
	},

	openCanStats(path: string): void {
		const id = 'canlog:' + path;
		const existing = this.open.find((e) => e.id === id);
		if (existing) {
			this.activate(existing);
			return;
		}
		const editor: Editor = {
			input: { kind: 'canlog', path },
			id,
			label: `Stats ${basename(path)}`,
			iconClass: 'pulse',
			pane: el('div', 'editor-pane can-log'),
			dirty: false
		};
		editor.pane.appendChild(el('div', 'can-loading', ['Loading…']));
		this.add(editor);
		// The view's chunk lands after the tab is up; a tab closed meanwhile gets no view.
		void loadCanViews().then(({ CanLogView }) => {
			if (!this.open.includes(editor)) return;
			editor.canlog = new CanLogView(path);
			editor.pane.replaceChildren(editor.canlog.root);
		});
	},



	async openMarkdownPreview(path?: string): Promise<void> {
		if (path === undefined) path = this.activeInput?.kind === 'file' ? this.activeInput.path : '';
		if (!path) return;
		const id = 'markdown:' + path;
		const existing = this.open.find((e) => e.id === id);
		if (existing) {
			this.activate(existing);
			return;
		}
		const intent = this.beginOpen();
		const editor: Editor = {
			input: { kind: 'markdown', path },
			id,
			label: `Preview ${basename(path)}`,
			iconClass: 'open-preview',
			pane: el('div', 'editor-pane markdown-preview'),
			dirty: false
		};
		editor.languageName = 'Markdown';
		const pane = editor.pane;
		const article = el('article', 'extension-doc markdown-preview-body');
		pane.appendChild(article);
		const lock = () => syncLocks.set(path, Date.now() + 120);
		const locked = () => (syncLocks.get(path) ?? 0) > Date.now();
		// The preview's own path, read live: a rename of the file retargets this tab.
		const currentPath = () => (editor.input.kind === 'markdown' ? editor.input.path : path);
		const findSource = () => fileEditorResolver.find?.(currentPath())
			?? this.open.find((e) => e.input.kind === 'file' && e.input.path === currentPath())
			?? null;
		const blocks = () => Array.from(article.querySelectorAll<HTMLElement>('[data-line]'));
		// Preview → source: the last rendered block at (or above) the pane's top edge names
		// the source line to bring up.
		pane.addEventListener('scroll', () => {
			if (locked()) return;
			const view = findSource()?.view;
			if (!view) return;
			const paneTop = pane.getBoundingClientRect().top;
			let line: number | null = null;
			for (const block of blocks()) {
				if (block.getBoundingClientRect().top - paneTop > SYNC_TOP_OFFSET) break;
				line = Number(block.dataset.line);
			}
			if (line === null || Number.isNaN(line)) return;
			// The rendered lines are the doc at the last render: edits since then (the
			// re-render is debounced) may have shortened it - clamp to what exists.
			const coords = view.coordsAtPos(view.state.doc.line(Math.min(line + 1, view.state.doc.lines)).from);
			if (!coords) return;
			lock();
			view.scrollDOM.scrollTop += coords.top - view.scrollDOM.getBoundingClientRect().top - SYNC_TOP_OFFSET;
		});
		// Source → preview: attached to whichever editor currently holds the file, so a source
		// opened after the preview (or re-opened after a close) is picked up on the next render.
		let detachSourceScroll: (() => void) | null = null;
		let attachedScroller: HTMLElement | null = null;
		const attachSource = (source: Editor) => {
			const view = source.view;
			if (!view || view.scrollDOM === attachedScroller) return;
			detachSourceScroll?.();
			const handler = () => {
				if (locked() || !article.isConnected) return;
				const block = view.lineBlockAtHeight(view.scrollDOM.scrollTop + SYNC_TOP_OFFSET);
				const line = view.state.doc.lineAt(block.from).number - 1;
				let target: HTMLElement | null = null;
				for (const candidate of blocks()) {
					if (Number(candidate.dataset.line) > line) break;
					target = candidate;
				}
				if (!target) return;
				lock();
				pane.scrollTop += target.getBoundingClientRect().top - pane.getBoundingClientRect().top - SYNC_TOP_OFFSET;
			};
			view.scrollDOM.addEventListener('scroll', handler);
			attachedScroller = view.scrollDOM;
			detachSourceScroll = () => {
				view.scrollDOM.removeEventListener('scroll', handler);
				attachedScroller = null;
				detachSourceScroll = null;
			};
		};
		editor.onClose = () => {
			detachSourceScroll?.();
			markdownPreviews.delete(editor);
			syncLocks.delete(path);
		};
		editor.render = async () => {
			const source = findSource();
			if (source) attachSource(source);
			let text: string;
			if (source?.view) {
				text = source.view.state.doc.toString();
			} else {
				try {
					const file = await readFileRaw(currentPath());
					text = file.contents ?? '';
				} catch (error) {
					article.textContent = String(error);
					return;
				}
			}
			const folder = currentPath().slice(0, Math.max(0, currentPath().length - basename(currentPath()).length - 1));
			const rendered = await renderMarkdown(text, article, async (relative) => {
				const mime = imageMime(relative);
				if (!mime) return null;
				// A markdown link is spelled with forward slashes; the file system path is the folder's.
				const full = joinPath(folder, folder.includes('\\') ? relative.replaceAll('/', '\\') : relative);
				return readFileBase64(full).then((data) => `data:${mime};base64,${data}`, () => null);
			});
			if (!rendered) article.textContent = text;
		};
		await editor.render();
		markdownPreviews.add(editor);
		this.add(editor, true, intent);
	},

	async openFileHistory(path?: string): Promise<void> {
		if (path === undefined) path = this.activeInput?.kind === 'file' ? this.activeInput.path : '';
		if (!path || !this.rootPath) return;
		const id = 'history:' + path;
		const existing = this.open.find((e) => e.id === id);
		if (existing) {
			this.activate(existing);
			return;
		}
		const intent = this.beginOpen();
		const { FileHistoryView } = await loadFileHistory();
		const editor: Editor = {
			input: { kind: 'history', path },
			id,
			label: `History ${basename(path)}`,
			iconClass: 'history',
			pane: el('div', 'editor-pane'),
			dirty: false
		};
		editor.history = new FileHistoryView(editor.pane, this.rootPath, relativeTo(this.rootPath, path));
		editor.history.onOpenDiff = (diff) => void this.openDiff({ kind: 'diff', ...diff });
		editor.history.onOpenRevision = (revision, relative, title) => void this.openRevision(revision, relative, title);
		this.add(editor, true, intent);
	},

	async toggleBlame(): Promise<void> {
		const editor = this.active;
		if (!editor || editor.input.kind !== 'file' || !editor.view || !this.rootPath || !editorState.cm) return;
		if (editor.blame) {
			editor.view.dispatch({ effects: editorState.cm.blameSlot.reconfigure([]) });
			editor.blame = false;
			return;
		}
		let lines: BlameLine[];
		try {
			lines = await scmBlame(relativeTo(this.rootPath, editor.input.path));
		} catch (error) {
			notify('error', `Blame failed: ${String(error)}`);
			return;
		}
		if (!editor.view || !Array.isArray(lines)) return;
		const { blameLabel } = await loadFileHistory();
		const now = Date.now();
		editor.view.dispatch({ effects: editorState.cm.blameSlot.reconfigure(editorState.cm.blameGutter(lines.map((line) => ({ label: blameLabel(line, now), title: `${line.hash.slice(0, 8)} ${line.summary}` })))) });
		editor.blame = true;
	},

	refreshPreviews(path: string): void {
		for (const editor of markdownPreviews) {
			if (editor.input.kind !== 'markdown' || editor.input.path !== path) continue;
			const timer = this.previewTimers.get(editor.id);
			if (timer !== undefined) window.clearTimeout(timer);
			this.previewTimers.set(editor.id, window.setTimeout(() => {
				this.previewTimers.delete(editor.id);
				void editor.render?.();
			}, PREVIEW_DELAY_MS));
		}
	},


	openBinaryNoticeDiff(input: Extract<EditorInput, { kind: 'diff' }>, intent?: number): void {
		const existing = this.open.find((e) => e.input.kind === 'diff' && e.input.id === input.id);
		if (existing) {
			this.activate(existing);
			return;
		}
		const editor: Editor = {
			input,
			id: 'diff:' + input.id,
			label: input.title,
			iconClass: 'diff',
			pane: el('div', 'editor-pane'),
			dirty: false
		};
		editor.pane.appendChild(el('div', 'diff-binary-notice', [t('diff.binaryNotice')]));
		this.add(editor, true, intent);
	},

	async openDiff(input: Extract<EditorInput, { kind: 'diff' }>): Promise<void> {
		const intent = this.beginOpen();
		const existing = this.open.find((e) => e.input.kind === 'diff' && e.input.id === input.id);
		if (existing) {
			this.activate(existing);
			return;
		}
		// Two files on disk route through a cheap probe first: a binary on either side opens
		// the hex comparison, so a multi-gigabyte pair is never read whole only to be
		// refused as text.
		if (input.left.local && input.right.local) {
			const binary = (path: string) => fileProbe(path).then((probe) => probe.binary).catch(() => false);
			const [leftBinary, rightBinary] = await Promise.all([binary(input.left.path), binary(input.right.path)]);
			if (leftBinary || rightBinary) {
				await this.openHexCompare(input, undefined, intent);
				return;
			}
		}
	const read = async (side: DiffSide): Promise<FileContents> => {
		if (!side.exists) return { contents: '', binary: false, size: 0 };
		if (side.content !== undefined) return { contents: side.content, binary: false, size: side.content.length };
		if (side.local) return readFileRaw(side.path);
			try {
				return await readFileAt(side.revision, side.path, input.repo);
			} catch (error) {
				// A file missing on one side (deleted / added between the revisions) shows empty.
				if (/not in|not found|no such|does not exist|cannot find/i.test(String(error))) return { contents: '', binary: false, size: 0 };
				throw error;
			}
		};
		let left: FileContents, right: FileContents;
		try {
			[left, right] = await Promise.all([read(input.left), read(input.right)]);
		} catch (error) {
			notify('error', String(error));
			return;
		}
		// A binary side that reached here was not a local-local pair (the probe above would
		// have routed it to the hex comparison already), so at least one side is a revision.
		// A Git Graph request opens the diff editor with the binary placeholder notice - the
		// extension opens the native diff editor, and that is what VS Code shows for binary
		// sides; the shell's own surfaces (Source Control, file history) open the hex
		// comparison, the bytes materialized to temp files it can stream.
		if (left.binary || right.binary) {
			if (input.binaryNotice === true) {
				this.openBinaryNoticeDiff(input, intent);
				return;
			}
			const resolve = (side: DiffSide): Promise<string> =>
				side.local ? Promise.resolve(side.path) : materializeRevisionFile(input.repo ?? '', side.revision, side.path);
			try {
				const [leftPath, rightPath] = await Promise.all([resolve(input.left), resolve(input.right)]);
				await this.openHexCompare(input, { left: leftPath, right: rightPath }, intent);
			} catch (error) {
				notify('error', String(error));
			}
			return;
		}
		const name = basename(input.right.path || input.left.path);
		const editor: Editor = {
			input,
			id: 'diff:' + input.id,
			label: input.title,
			iconClass: 'diff',
			pane: el('div', 'editor-pane'),
			dirty: false
		};
		// The diff's ignore options: both texts are normalised before they reach the merge
		// view, and a toggle rebuilds it (the views are cheap to rebuild).
		const ignore = { whitespace: false, case: false };
		const normalize = (text: string): string => {
			let out = text.replace(/\r\n?/g, '\n');
			if (ignore.whitespace) out = out.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).join('\n');
			if (ignore.case) out = out.toLowerCase();
			return out;
		};
		const toolbar = el('div', 'diff-toolbar');
		let lastSplit = true;
		let rebuild: ((split: boolean) => void) | null = null;
		/** Xcode's version editor keeps its change navigation beside the ignore options: the
		 *  prev/next arrows, the "n of m changes" counter, the +A/−D statistics, and a manual
		 *  layout switch. `manualSplit` (undefined = follow the pane width) persists per tab
		 *  for the diff's lifetime. */
		let manualSplit: boolean | undefined;
		const counter = el('span', 'diff-count');
		/** Set once the diff's views exist (the text-diff branch below). */
		let stepChange: (direction: 1 | -1) => void = () => undefined;
		const stats = el('span', 'diff-stats');
		const navButton = (iconName: string, title: string, direction: 1 | -1) => {
			const button = el('button', 'action-btn', [icon(iconName)]);
			button.title = title;
			button.addEventListener('click', () => stepChange(direction));
			toolbar.appendChild(button);
			return button;
		};
		navButton('arrow-up', 'Previous Change', -1);
		navButton('arrow-down', 'Next Change', 1);
		toolbar.appendChild(counter);
		const layoutButton = el('button', 'action-btn toggle', [icon('split-horizontal')]);
		layoutButton.title = 'Switch between side-by-side and inline (follows the pane width until set)';
		layoutButton.addEventListener('click', () => {
			manualSplit = !lastSplit;
			rebuild?.(manualSplit);
		});
		toolbar.appendChild(layoutButton);
		const toggle = (label: string, key: 'whitespace' | 'case') => {
			const button = el('button', 'action-btn toggle' + (ignore[key] ? ' active' : ''), [label]);
			button.title = label === 'Aa' ? 'Ignore case' : 'Ignore whitespace';
			button.addEventListener('click', () => {
				ignore[key] = !ignore[key];
				button.classList.toggle('active', ignore[key]);
				rebuild?.(lastSplit);
			});
			toolbar.appendChild(button);
		};
		toggle('Wh', 'whitespace');
		toggle('Aa', 'case');
		// A local-file compare labels its sides with the full paths; "C:\a.txt (C:\a.txt)" would
		// just repeat itself, so a label that equals the path shows the path alone.
		const sideText = (side: DiffSide): string => side.label === side.path ? side.path : `${side.path} (${side.label})`;
		editor.pane.appendChild(el('div', 'diff-header', [
			el('span', '', [sideText(input.left)]),
			el('span', '', [sideText(input.right)]),
			toolbar,
			stats
		]));
		editor.languageName = 'Plain Text';
		const host = el('div', 'editorState.cm-merge-view');
		editor.pane.appendChild(host);
		// The text editor and the merge views are async chunks, loaded with the first diff.
		const [{ EditorView, EditorState, baseExtensions, keymap, languageSlot, loadLanguage }, { Chunk, MergeView, goToNextChunk, goToPreviousChunk, unifiedMergeView }] = await Promise.all([textEditor(), loadMerge()]);
		// The language support, once loaded, so that a layout switch rebuilds an already
		// highlighted view instead of dropping back to Plain Text until the next open.
		let languageSupport: Extension | null = null;
		/** The change navigation's state: the hunks, which one the cursor is in, and the
		 *  +added/−deleted line statistics the header badge shows. Recomputed per render -
		 *  both layouts expose their chunks (the merge view directly, the unified view via
		 *  a build over its two texts). */
		let chunks: readonly InstanceType<typeof Chunk>[] = [];
		const at = (): number => {
			const view = editor.view ?? editor.merge?.b ?? null;
			if (!view) return 0;
			const head = view.state.selection.main.head;
			let index = 0;
			for (const chunk of chunks) {
				if (chunk.fromB > head) break;
				index++;
			}
			return Math.min(index, chunks.length);
		};
		const refreshChangeInfo = (): void => {
			const aDoc = EditorState.create({ doc: normalize(left.contents ?? '') }).doc;
			const bDoc = editor.view?.state.doc ?? editor.merge?.b.state.doc ?? EditorState.create({ doc: normalize(right.contents ?? '') }).doc;
			chunks = editor.merge?.chunks ?? Chunk.build(aDoc, bDoc);
			let additions = 0;
			let deletions = 0;
			for (const chunk of chunks) {
				for (const change of chunk.changes) {
					if (change.toA > change.fromA) deletions += aDoc.lineAt(chunk.fromA + change.toA - 1).number - aDoc.lineAt(chunk.fromA + change.fromA).number + 1;
					if (change.toB > change.fromB) additions += bDoc.lineAt(chunk.fromB + change.toB - 1).number - bDoc.lineAt(chunk.fromB + change.fromB).number + 1;
				}
			}
			stats.innerHTML = '';
			if (chunks.length > 0) {
				const added = el('span', 'added', [`+${additions}`]);
				const removed = el('span', 'deleted', [`\u2212${deletions}`]);
				stats.append(added, removed, `${chunks.length} change${chunks.length === 1 ? '' : 's'}`);
				stats.title = `${additions} added, ${deletions} deleted lines across ${chunks.length} changes`;
			} else {
				stats.textContent = 'No changes';
				stats.title = 'The two sides are identical';
			}
			updateCounter();
		};
		const updateCounter = (): void => {
			if (chunks.length === 0) {
				counter.textContent = '';
				return;
			}
			counter.textContent = `${Math.min(at() + 1, chunks.length)} / ${chunks.length}`;
		};
		/** Jump to the previous/next change (Xcode's version editor arrows). */
		stepChange = (direction: 1 | -1): void => {
			const view = editor.view ?? editor.merge?.b ?? null;
			if (!view || chunks.length === 0) return;
			const command = direction === 1 ? goToNextChunk : goToPreviousChunk;
			command(view);
			// The command moves the selection; scroll it in and refresh the counter.
			view.dispatch({ effects: EditorView.scrollIntoView(view.state.selection.main.head, { y: 'center' }) });
			updateCounter();
		};
		// VS Code's diff-editor keys: F7 / Shift+F7 step through the changes.
		const diffKeys = keymap.of([{ key: 'F7', run: () => (stepChange(1), true), shift: () => (stepChange(-1), true) }]);
		// Wide panes get the classic side-by-side view; narrow ones a single-column inline
		// view - unless the layout button pinned one. A ResizeObserver rebuilds the editors
		// whenever the pane crosses the threshold.
		const render = (split: boolean) => {
			lastSplit = split;
			editor.merge?.destroy();
			editor.merge = undefined;
			editor.view?.destroy();
			editor.view = undefined;
			host.textContent = '';
			editor.pane.classList.toggle('diff-inline', !split);
			if (split) {
				editor.merge = new MergeView({
					a: { doc: normalize(left.contents ?? ''), extensions: [...baseExtensions(true), languageSlot.of(languageSupport ?? []), diffKeys, EditorView.updateListener.of(() => updateCounter())] },
					b: { doc: normalize(right.contents ?? ''), extensions: [...baseExtensions(true), languageSlot.of(languageSupport ?? []), diffKeys, EditorView.updateListener.of(() => updateCounter())] },
					parent: host,
					collapseUnchanged: { margin: 3, minSize: 4 },
					highlightChanges: true,
					gutter: true
				});
			} else {
				editor.view = new EditorView({
					state: EditorState.create({
						doc: normalize(right.contents ?? ''),
						extensions: [
							...baseExtensions(true),
							languageSlot.of(languageSupport ?? []),
							diffKeys,
							EditorView.updateListener.of(() => updateCounter()),
							unifiedMergeView({
								original: normalize(left.contents ?? ''),
								collapseUnchanged: { margin: 3, minSize: 4 },
								highlightChanges: true,
								gutter: true,
								mergeControls: false
							})
						]
					}),
					parent: host
				});
			}
			refreshChangeInfo();
		};
		rebuild = render;
		let split: boolean | undefined;
		// The first render waits one frame for the pane to be mounted and measurable: the
		// naive build-then-flip cost a full editor construction twice on narrow panes.
		requestAnimationFrame(() => {
			// Dropped as a parallel-open duplicate (or already rendered): nothing to build.
			if (!this.open.includes(editor) || editor.view !== undefined || editor.merge !== undefined) return;
			split = manualSplit ?? (host.clientWidth >= DIFF_SPLIT_MIN_WIDTH || host.clientWidth === 0);
			lastSplit = split;
			render(split);
		});
		editor.diffObserver = new ResizeObserver(() => {
			// A pinned layout stays; the pane width only rules until the user chooses.
			if (manualSplit !== undefined) return;
			const want = host.clientWidth >= DIFF_SPLIT_MIN_WIDTH;
			if (want !== split) {
				split = want;
				lastSplit = want;
				render(want);
			}
		});
		editor.diffObserver.observe(host);
		void loadLanguage(name).then((language) => {
			if (!language) return;
			languageSupport = language.support;
			editor.languageName = language.name;
			const effect = languageSlot.reconfigure(language.support);
			if (editor.merge) {
				editor.merge.a.dispatch({ effects: effect });
				editor.merge.b.dispatch({ effects: effect });
			}
			if (editor.view) editor.view.dispatch({ effects: effect });
			this.emitActive();
		});
		this.add(editor, true, intent);
	},

	async openLocalHexCompare(left: string, right: string): Promise<void> {
		const input: Extract<EditorInput, { kind: 'diff' }> = {
			kind: 'diff',
			id: `paths:${left}::${right}`,
			title: `${basename(left)} ↔ ${basename(right)}`,
			left: { revision: '*', path: left, label: left, exists: true, local: true },
			right: { revision: '*', path: right, label: right, exists: true, local: true }
		};
		const existing = this.open.find((e) => e.input.kind === 'diff' && e.input.id === input.id);
		if (existing) {
			this.activate(existing);
			return;
		}
		const intent = this.beginOpen();
		await this.openHexCompare(input, undefined, intent);
	},

	async openHexCompare(input: Extract<EditorInput, { kind: 'diff' }>, paths?: { left: string; right: string }, intent?: number): Promise<void> {
		const editor: Editor = {
			input,
			id: 'diff:' + input.id,
			label: input.title,
			iconClass: 'file-binary',
			pane: el('div', 'editor-pane binary-hex'),
			dirty: false
		};
		const sideLabel = (side: DiffSide): string => side.local || side.label === side.path ? side.path : `${side.path} (${side.label})`;
		const { HexCompareView } = await loadHexCompare();
		const view = new HexCompareView(paths?.left ?? input.left.path, paths?.right ?? input.right.path, { left: sideLabel(input.left), right: sideLabel(input.right) });
		editor.hexCompare = view;
		editor.pane.appendChild(view.root);
		editor.onClose = () => view.destroy();
		this.add(editor, true, intent);
		void view.load().then(() => view.scan());
	},

	async openRevision(revision: string, path: string, title: string, repo?: string): Promise<void> {
		const id = `rev:${revision}:${path}`;
		// The tab id matches what `inputId` computes for the input (a revision shows as a
		// read-only diff-kind editor), or back/forward could never find the open tab.
		const existing = this.open.find((e) => e.id === 'diff:' + id);
		if (existing) {
			this.activate(existing);
			return;
		}
		const intent = this.beginOpen();
		let file: FileContents;
		try {
			file = await readFileAt(revision, path, repo);
		} catch (error) {
			notify('error', String(error));
			return;
		}
		const name = basename(path);
		const editor: Editor = {
			input: { kind: 'diff', id, title, left: { revision, path, label: revision, exists: true }, right: { revision, path, label: revision, exists: true } },
			id: 'diff:' + id,
			label: title,
			iconClass: fileIcon(name),
			pane: el('div', 'editor-pane'),
			dirty: false
		};
		if (file.binary || file.contents === null) {
			editor.pane.appendChild(notice('file-binary', 'The file is binary and cannot be shown in the text editor.'));
		} else {
			const { EditorView, EditorState, baseExtensions, languageSlot, loadLanguage } = await textEditor();
			editor.languageName = 'Plain Text';
			editor.view = new EditorView({
				state: EditorState.create({
					doc: file.contents,
					extensions: [
						...baseExtensions(true),
						languageSlot.of([]),
						EditorView.updateListener.of((update) => {
							if (update.selectionSet) this.emitActive();
						})
					]
				}),
				parent: editor.pane
			});
			void loadLanguage(name).then((language) => {
				if (!language || editor.view === undefined) return;
				editor.languageName = language.name;
				editor.view.dispatch({ effects: languageSlot.reconfigure(language.support) });
				this.emitActive();
			});
			this.attachTextServices(editor);
		}
		this.add(editor, true, intent);
	},

	openHelp(help: 'welcome' | 'shortcuts'): void {
		const id = 'help:' + help;
		const existing = this.open.find((e) => e.id === id);
		if (existing) {
			this.activate(existing);
			return;
		}
		const editor: Editor = {
			input: { kind: 'help', help },
			id,
			label: help === 'welcome' ? 'Welcome' : 'Keyboard Shortcuts',
			iconClass: help === 'welcome' ? 'book' : 'keyboard',
			pane: el('div', 'editor-pane'),
			dirty: false
		};
		const page = el('div', 'welcome');
		editor.pane.appendChild(page);
		this.renderHelp?.(help, page);
		this.add(editor);
	},

	openSelfTest(): void {
		const id = 'selftest';
		const existing = this.open.find((e) => e.id === id);
		if (existing) {
			this.activate(existing);
			return;
		}
		const editor: Editor = {
			input: { kind: 'selftest', id },
			id,
			label: 'Module Self-Tests',
			iconClass: 'checklist',
			pane: el('div', 'editor-pane'),
			dirty: false
		};
		const page = el('div', 'selftest-page');
		editor.pane.appendChild(page);
		this.renderSelfTest?.(page);
		this.add(editor);
	},

	openProviders(): void {
		const id = 'providers';
		const existing = this.open.find((e) => e.id === id);
		if (existing) {
			this.activate(existing);
			return;
		}
		const editor: Editor = {
			input: { kind: 'providers', id },
			id,
			label: t('providers.title'),
			iconClass: 'cloud',
			pane: el('div', 'editor-pane'),
			dirty: false
		};
		const page = el('div', 'providers-page');
		editor.pane.appendChild(page);
		const dispose = this.renderProviders?.(page);
		if (typeof dispose === 'function') editor.onClose = dispose;
		this.add(editor);
	},

	async openFolderCompare(input: Extract<EditorInput, { kind: 'folders' }>): Promise<void> {
		const existing = this.open.find((e) => e.input.kind === 'folders' && e.input.id === input.id);
		if (existing) {
			this.activate(existing);
			return;
		}
		const intent = this.beginOpen();
		const { FolderCompareView } = await loadFolderCompare();
		const editor: Editor = {
			input,
			id: 'folders:' + input.id,
			label: 'Folder Compare',
			iconClass: 'diff',
			pane: el('div', 'editor-pane'),
			dirty: false
		};
		editor.folderCompare = new FolderCompareView(editor.pane, { left: input.left, right: input.right });
		editor.folderCompare.onFilesChanged = () => this.onExternalFileChange?.();
		this.add(editor, true, intent);
	},

	async openSymbolDatabase(): Promise<void> {
		const id = `symboldb:${this.rootPath ?? ''}`;
		const existing = this.open.find((e) => e.input.kind === 'symboldb' && e.input.id === id);
		if (existing) {
			this.activate(existing);
			return;
		}
		const intent = this.beginOpen();
		const { SymbolDatabaseView } = await loadSymbolDbView();
		const editor: Editor = {
			input: { kind: 'symboldb', id },
			id,
			label: 'Symbol Database',
			iconClass: 'symbol-structure',
			pane: el('div', 'editor-pane'),
			dirty: false
		};
		editor.symbolDatabase = new SymbolDatabaseView(editor.pane);
		editor.symbolDatabase.onOpen = (path, line) => void this.openFile(joinPath(this.rootPath ?? '', path), { line });
		this.add(editor, true, intent);
	},

	async openAnalysisPage(
		tool: import('../analysis').AnalysisToolId,
		folders?: string[]
	): Promise<void> {
		const scope = folders?.filter((folder) => folder !== '') ?? [];
		const id = `analysis:${tool}${scope.length > 0 ? `:${scope.join(',')}` : ''}`;
		const existing = this.open.find((e) => e.input.kind === 'analysis' && e.input.id === id);
		if (existing) {
			this.activate(existing);
			return;
		}
		// The tab's label names the scope the way the compare tabs name their
		// sides — English, like every tab label; the pages' own text goes
		// through `t()`.
		const scopeSuffix = scope.length === 0
			? ''
			: ` (${scope.slice(0, 3).map((folder) => basename(folder) || folder).join(', ')}${scope.length > 3 ? ` +${scope.length - 3}` : ''})`;
		const editor: Editor = {
			input: { kind: 'analysis', id, tool, folders: scope },
			id,
			label: ANALYSIS_PAGE_LABELS[tool] + scopeSuffix,
			iconClass: ANALYSIS_PAGE_ICONS[tool],
			pane: el('div', 'editor-pane'),
			dirty: false
		};
		editor.pane.appendChild(el('div', 'an-loading', ['Loading…']));
		this.add(editor);
		const { createAnalysisPage } = await loadAnalysisPages();
		if (!this.open.includes(editor)) return; // the tab closed while the chunk loaded
		editor.pane.textContent = '';
		editor.analysis = createAnalysisPage(tool, editor.pane, scope);
		editor.analysis.onOpen = (path, line) => void this.openFile(joinPath(this.rootPath ?? '', path), { line });
	},

	async openCallTree(symbol: WsSymbol): Promise<void> {
		const id = `calltree:${symbol.path}:${symbol.line}`;
		const existing = this.open.find((e) => e.input.kind === 'calltree' && e.input.id === id);
		if (existing) {
			this.activate(existing);
			return;
		}
		const intent = this.beginOpen();
		const { CallTreeView } = await loadCallTree();
		const editor: Editor = {
			input: { kind: 'calltree', id, symbol },
			id,
			label: `Calls — ${symbol.name}`,
			iconClass: 'symbol-method',
			pane: el('div', 'editor-pane'),
			dirty: false
		};
		CallTreeView.repoRoot = this.rootPath;
		editor.callTree = new CallTreeView(editor.pane, symbol);
		editor.callTree.onOpen = (path, line) => void this.openFile(path, { line });
		this.add(editor, true, intent);
	},

	async openExtPage(
		input: Extract<EditorInput, { kind: 'extpage' }>,
		mount: (pane: HTMLElement) => (() => void) | void,
		iconSrc?: string | null
	): Promise<void> {
		const editor: Editor = {
			input,
			id: input.id,
			label: input.title,
			// The package's own icon when it declares one (a data URL), the generic globe else.
			...(iconSrc ? { iconSrc } : { iconClass: 'globe' }),
			pane: el('div', 'editor-pane ext-page'),
			dirty: false
		};
		// The frame's DOM home: the overlay host when the area provides one (the pane stays in
		// the rebuilt tree as the placeholder the host is positioned over), the pane itself
		// otherwise — the standalone-group shape the tests use.
		const overlay = this.extOverlayHost?.(editor.pane);
		const dispose = mount(overlay?.host ?? editor.pane);
		if (dispose || overlay) {
			const teardownOverlay = overlay?.dispose;
			editor.onClose = () => {
				dispose?.();
				teardownOverlay?.();
			};
		}
		this.add(editor);
	},

	openExtDetail(
		input: Extract<EditorInput, { kind: 'extdetail' }>,
		mount: (pane: HTMLElement) => (() => void) | void
	): void {
		const existing = this.open.find((editor) => editor.id === input.id);
		if (existing) {
			this.activate(existing);
			return;
		}
		const editor: Editor = {
			input,
			id: input.id,
			label: input.title,
			iconClass: 'extensions',
			pane: el('div', 'editor-pane ext-detail-pane'),
			dirty: false
		};
		const dispose = mount(editor.pane);
		if (dispose) editor.onClose = dispose;
		this.add(editor);
	},

	revealIn(editor: Editor, line: number, column: number): void {
		if (editor.fast) editor.fast.revealLine(line - 1);
		if (editor.doc) void editor.doc.revealLine(line - 1, column - 1);
		if (editor.view) this.revealPosition(editor.view, line, column);
	},


	textMenu(editor: Editor, pos: number | null): MenuEntry[] {
		const view = editor.view;
		const hasSelection = !!view && !view.state.selection.main.empty;
		const readOnly = !!view && view.state.readOnly;
		const copy = () => {
			if (!view) return;
			const selection = view.state.selection.main;
			if (selection.empty) return;
			void writeText(view.state.sliceDoc(selection.from, selection.to));
		};
		const cut = () => {
			if (!view || readOnly) return;
			const selection = view.state.selection.main;
			if (selection.empty) return;
			void writeText(view.state.sliceDoc(selection.from, selection.to));
			view.dispatch({ changes: { from: selection.from, to: selection.to } });
		};
		const paste = async () => {
			if (!view || readOnly) return;
			try {
				const text = await readText();
				const selection = view.state.selection.main;
				view.dispatch({ changes: { from: selection.from, to: selection.to, insert: text }, selection: { anchor: selection.from + text.length } });
			} catch {
				notify('warning', 'The clipboard could not be read.');
			}
		};
		const currentLine = view ? view.state.doc.lineAt(view.state.selection.main.head).number : null;
		return [
			{ label: 'Go to Definition', keybinding: 'F12', run: () => void this.goToDefinition(editor, pos) },
			{ label: 'Find References', keybinding: 'Shift+F12', run: () => void this.findReferences(editor, pos) },
			{ label: 'Show Call Tree', run: () => void this.openCallTreeAtCursor(editor, pos) },
			'separator',
			{ label: 'Go Back', keybinding: 'Alt+Left', disabled: !this.canGoBack(), run: () => this.goBack() },
			{ label: 'Go Forward', keybinding: 'Alt+Right', disabled: !this.canGoForward(), run: () => this.goForward() },
			'separator',
			{ label: currentLine !== null && hasBookmark(editor.input.kind === 'file' ? editor.input.path : '', currentLine) ? 'Remove Bookmark' : 'Toggle Bookmark', keybinding: 'Ctrl+Alt+B', disabled: currentLine === null, run: () => this.toggleBookmarkAt(editor, currentLine!) },
			'separator',
			{ label: 'Change All Occurrences', keybinding: 'Ctrl+F2', disabled: !view || readOnly, run: () => { if (view) editorState.cm?.changeAllOccurrences(view); } },
			'separator',
			{ label: 'Cut', keybinding: 'Ctrl+X', disabled: !hasSelection || readOnly, run: () => cut() },
			{ label: 'Copy', keybinding: 'Ctrl+C', disabled: !hasSelection, run: () => copy() },
			{ label: 'Paste', keybinding: 'Ctrl+V', disabled: readOnly, run: () => void paste() },
			'separator',
			{ label: 'Find', keybinding: 'Ctrl+F', run: () => this.runEditorCommand('find') },
			{ label: 'Command Palette...', keybinding: 'Ctrl+Shift+P', run: () => void commands.execute('workbench.commandPalette') },
			// Extensions' `contributes.menus["editor/context"]` entries, handed the file the
			// editor shows (VS Code's resource argument) when it shows one.
			...menuSection('editor/context', editor.input.kind === 'file' ? [contextUri(editor.input.path), [contextUri(editor.input.path)]] : undefined, editor.input.kind === 'file' ? { ...resourceContext(editor.input.path), editorTextFocus: true, editorHasSelection: !editor.view?.state.selection.main.empty } : undefined)
		];
	},

	runEditorCommand(command: 'undo' | 'redo' | 'selectAll' | 'find' | 'replace' | 'toggleLineComment' | 'toggleBlockComment'): void {
		// A windowed editor keeps its undo stack in the backend's document; the rest run on
		// its small window view.
		if (this.active?.doc) {
			if (command === 'undo') void this.active.doc.undo();
			else if (command === 'redo') void this.active.doc.redo();
			else if (command === 'find') this.active.doc.openFind();
			else if (command === 'replace') this.active.doc.openReplace();
			else if (command === 'toggleLineComment') this.active.doc.toggleComment('line');
			else if (command === 'toggleBlockComment') this.active.doc.toggleComment('block');
			else this.active.doc.selectAll();
			return;
		}
		// A fast-view tab has no editor at all — find still serves its read-only rope.
		if (this.active?.fast) {
			if (command === 'find') this.active.fast.openFind();
			return;
		}
		const view = this.activeView;
		if (!view || !editorState.cm) return;
		const path = this.active?.input.kind === 'file' ? this.active.input.path : this.active?.label ?? '';
		if (command === 'find') editorState.cm.openSearchPanel(view);
		else if (command === 'replace') editorState.cm.openReplacePanel(view);
		else if (command === 'toggleLineComment') void import('./comments').then(({ toggleLineComment }) => toggleLineComment(view, path));
		else if (command === 'toggleBlockComment') void import('./comments').then(({ toggleBlockComment }) => toggleBlockComment(view, path));
		else editorState.cm[command](view);
	},
};
