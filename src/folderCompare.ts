// The Folder Compare editor: a Beyond Compare-style view of two folders - every file with its
// status (left only / right only / different / same), a text diff of a chosen file's two
// versions, and the sync actions (copy to the other side, delete) that flow through the same
// filesystem commands the Explorer uses.

import { invoke } from '@tauri-apps/api/core';
import type { EditorView } from '@codemirror/view';
import type { MergeView } from '@codemirror/merge';

import { loadHexCompare, loadMerge, loadTextEditor } from './lazy';
import type { HexCompareView } from './hexCompare';

import { basename, confirmDialog, dirname, el, icon, joinPath, notify, showContextMenu, type MenuEntry } from './ui';

export interface DirDiffEntry {
	path: string;
	status: 'leftOnly' | 'rightOnly' | 'different' | 'same';
	leftSize: number;
	rightSize: number;
}

interface FileContents {
	contents: string | null;
	binary: boolean;
	size: number;
	/** The encoding id the text was decoded with (`encodings` lists them); a copy must be
	 *  written back in it, or the copy transcodes. */
	encoding: string;
	/** `lf` or `crlf`. */
	eol: string;
}

const STATUS_META: Record<DirDiffEntry['status'], { icon: string; title: string; cls: string }> = {
	leftOnly: { icon: 'arrow-left', title: 'Only in the left folder', cls: 'fc-left-only' },
	rightOnly: { icon: 'arrow-right', title: 'Only in the right folder', cls: 'fc-right-only' },
	different: { icon: 'diff', title: 'The files differ', cls: 'fc-different' },
	same: { icon: 'check', title: 'Identical', cls: 'fc-same' }
};

export class FolderCompareView {
	private readonly pane: HTMLElement;
	private readonly left: string;
	private readonly right: string;
	private entries: DirDiffEntry[] = [];
	private filter = '';
	private hideSame = true;
	private selected: string | null = null;
	private loading = false;
	/** The currently shown file's diff: both texts (a text file), or the hex comparison of
	 *  two binaries - whichever the chosen file asked for. */
	private fileDiff: { path: string; left: string; right: string; merge?: MergeView; view?: EditorView; hexCompare?: HexCompareView; host: HTMLElement } | null = null;
	/** Incremented on every render: a detail load started before the latest render is stale -
	 *  its DOM was wiped and its `fileDiff` slot reassigned, so its continuation must not
	 *  attach to the detached element nor claim the slot (the stale check in `detail`). */
	private detailLoad = 0;

	onDispose: (() => void) | null = null;
	/** A file changed on disk through a sync action; the host refreshes editors and SCM. */
	onFilesChanged: (() => void) | null = null;

	constructor(pane: HTMLElement, options: { left: string; right: string }) {
		this.pane = pane;
		this.left = options.left;
		this.right = options.right;
		this.pane.classList.add('folder-compare');
		this.render();
		void this.refresh();
	}

	dispose(): void {
		this.fileDiff?.merge?.destroy();
		this.fileDiff?.view?.destroy();
		this.fileDiff?.hexCompare?.destroy();
		this.onDispose?.();
	}

	async refresh(): Promise<void> {
		this.loading = true;
		this.render();
		try {
			const entries = await invoke<DirDiffEntry[] | null>('compare_dirs', { left: this.left, right: this.right, include: null, exclude: null });
			// A backend that answers nothing (a stub, a refused call) is an empty comparison,
			// not a crash in the render that follows.
			this.entries = Array.isArray(entries) ? entries : [];
		} catch (error) {
			this.entries = [];
			notify('error', String(error));
		}
		this.loading = false;
		if (this.selected && !this.entries.some((e) => e.path === this.selected)) this.selected = null;
		this.render();
	}

	private visibleEntries(): DirDiffEntry[] {
		const query = this.filter.toLowerCase();
		return this.entries.filter((entry) => {
			if (this.hideSame && entry.status === 'same') return false;
			return query === '' || entry.path.toLowerCase().includes(query);
		});
	}

	/* ---------- Rendering ---------- */

	/** The header (the two folders, the filter box, the toggles) is built once and stays: a
	 *  render replaces only the body beneath it, so a filter keystroke never rebuilds the very
	 *  input being typed into (which lost its focus after every character). */
	private headerElement: HTMLElement | null = null;

	private render(): void {
		this.fileDiff?.merge?.destroy();
		this.fileDiff?.view?.destroy();
		this.fileDiff?.hexCompare?.destroy();
		this.fileDiff = null;
		this.detailLoad++;
		if (!this.headerElement) {
			this.headerElement = this.header();
			this.pane.appendChild(this.headerElement);
		}
		this.pane.querySelector(':scope > .fc-body')?.remove();
		const body = el('div', 'fc-body');
		body.appendChild(this.list());
		if (this.selected) body.appendChild(this.detail());
		this.pane.appendChild(body);
	}

	private header(): HTMLElement {
		const side = (label: 'left' | 'right', path: string) => {
			const button = el('button', 'fc-side', [icon(label === 'left' ? 'arrow-left' : 'arrow-right'), el('span', '', [path])]);
			button.title = path;
			return button;
		};
		const filter = el('input', 'input');
		filter.type = 'text';
		filter.placeholder = 'Filter by name';
		filter.spellcheck = false;
		filter.value = this.filter;
		filter.addEventListener('input', () => { this.filter = filter.value; this.render(); });
		filter.addEventListener('keydown', (event) => event.stopPropagation());
		const hideSame = el('button', 'action-btn toggle' + (this.hideSame ? ' active' : ''), [icon('filter')]);
		hideSame.title = 'Hide identical files';
		hideSame.addEventListener('click', () => {
			this.hideSame = !this.hideSame;
			hideSame.classList.toggle('active', this.hideSame);
			this.render();
		});
		const refresh = el('button', 'action-btn', [icon('refresh')]);
		refresh.title = 'Refresh comparison';
		refresh.addEventListener('click', () => void this.refresh());
		return el('div', 'fc-header', [
			el('div', 'fc-sides', [side('left', this.left), el('span', 'fc-vs', ['↔']), side('right', this.right)]),
			el('div', 'fc-controls', [filter, hideSame, refresh])
		]);
	}

	private list(): HTMLElement {
		const list = el('div', 'fc-list');
		list.tabIndex = 0;
		if (this.loading) {
			list.appendChild(el('div', 'fc-empty', ['Comparing folders…']));
			return list;
		}
		const visible = this.visibleEntries();
		if (visible.length === 0) {
			list.appendChild(el('div', 'fc-empty', [this.filter === '' && this.hideSame && this.entries.length > 0 ? 'All files are identical' : 'No files']));
			return list;
		}
		for (const entry of visible) {
			const meta = STATUS_META[entry.status];
			const row = el('div', `row fc-row ${meta.cls}` + (entry.path === this.selected ? ' selected' : ''), [
				icon(meta.icon, 'fc-status'),
				el('span', 'label', [entry.path]),
				el('span', 'description', [sizes(entry)])
			]);
			row.title = `${entry.path} — ${meta.title}`;
			row.addEventListener('click', () => { this.selected = entry.path; this.render(); });
			row.addEventListener('contextmenu', (event) => {
				event.preventDefault();
				showContextMenu(event.clientX, event.clientY, this.entryMenu(entry));
			});
			list.appendChild(row);
		}
		return list;
	}

	private entryMenu(entry: DirDiffEntry): MenuEntry[] {
		const leftPath = joinPath(this.left, entry.path);
		const rightPath = joinPath(this.right, entry.path);
		const copy = async (from: string, to: string) => {
			try {
				const file = await invoke<FileContents>('read_file', { path: from });
				if (file.contents === null || file.binary) {
					notify('warning', `${basename(from)} is binary; only text files can be copied.`);
					return;
				}
				// A file in a folder the other side lacks (`src/new/x.txt` left-only) needs
				// that folder first: `write_file` refuses to write into a missing parent.
				const parent = dirname(to);
				if (parent !== '') await invoke('create_folder', { path: parent }).catch(() => undefined);
				// Written back in the file's own encoding and line endings, as the editor
				// saves: without them `write_file` defaults to UTF-8/LF and the "copy"
				// transcodes - the pair still differs on the next refresh.
				await invoke('write_file', { path: to, contents: file.contents, encoding: file.encoding, eol: file.eol });
				this.onFilesChanged?.();
				await this.refresh();
			} catch (error) {
				notify('error', String(error));
			}
		};
		const remove = async (path: string) => {
			const confirmed = await confirmDialog(`Delete ${path}?`, 'Delete');
			if (!confirmed) return;
			try {
				await invoke('delete_path', { path });
				this.onFilesChanged?.();
				await this.refresh();
			} catch (error) {
				notify('error', String(error));
			}
		};
		const entries: MenuEntry[] = [];
		if (entry.status !== 'rightOnly') entries.push({ label: 'Copy Left → Right', disabled: entry.status === 'same', run: () => void copy(leftPath, rightPath) });
		if (entry.status !== 'leftOnly') entries.push({ label: 'Copy Right → Left', disabled: entry.status === 'same', run: () => void copy(rightPath, leftPath) });
		entries.push('separator');
		if (entry.status !== 'rightOnly') entries.push({ label: 'Delete Left File', run: () => void remove(leftPath) });
		if (entry.status !== 'leftOnly') entries.push({ label: 'Delete Right File', run: () => void remove(rightPath) });
		return entries;
	}

	/** The selected file's two versions, side by side (or inline when narrow). */
	private detail(): HTMLElement {
		const entry = this.entries.find((e) => e.path === this.selected)!;
		const meta = STATUS_META[entry.status];
		const detail = el('div', 'fc-detail');
		detail.appendChild(el('div', 'fc-detail-header', [
			icon(meta.icon),
			el('span', '', [entry.path]),
			el('span', 'description', [meta.title])
		]));
		if (entry.status === 'same') {
			detail.appendChild(el('div', 'fc-empty', ['The files are identical.']));
			return detail;
		}
		if (entry.status === 'leftOnly' || entry.status === 'rightOnly') {
			detail.appendChild(el('div', 'fc-empty', [`The file exists only in the ${entry.status === 'leftOnly' ? 'left' : 'right'} folder.`]));
			return detail;
		}
		// Both exist and differ: binaries open the hex comparison, text files the merge
		// view. A probe decides which before anything is read whole; the read races a
		// vanished file, which simply shows as empty.
		const probe = (path: string) => invoke<FileContents>('file_probe', { path }).catch(() => null);
		const read = (path: string) => invoke<FileContents>('read_file', { path }).catch(() => ({ contents: '', binary: false, size: 0, encoding: 'utf8', eol: 'lf' }) as FileContents);
		// The load's token: any re-render (a filter keystroke, the hide-same toggle, a
		// refresh) wipes this detail element and bumps `detailLoad`, so a continuation that
		// finds itself stale stops before attaching to the detached element or claiming
		// `fileDiff` - the merge/hex view it would have built is never created, never leaked.
		const load = this.detailLoad;
		const stale = () => load !== this.detailLoad || this.selected !== entry.path;
		void (async () => {
			const [leftProbe, rightProbe] = await Promise.all([
				probe(joinPath(this.left, entry.path)),
				probe(joinPath(this.right, entry.path))
			]);
			if (stale()) return;
			if (leftProbe?.binary || rightProbe?.binary) {
				const { HexCompareView } = await loadHexCompare();
				if (stale()) return;
				const host = el('div', 'fc-file-diff');
				detail.appendChild(host);
				const view = new HexCompareView(joinPath(this.left, entry.path), joinPath(this.right, entry.path));
				this.fileDiff = { path: entry.path, left: '', right: '', hexCompare: view, host };
				host.appendChild(view.root);
				await view.load();
				if (stale()) return;
				view.scan();
				return;
			}
			const [left, right] = await Promise.all([
				read(joinPath(this.left, entry.path)),
				read(joinPath(this.right, entry.path))
			]);
			const [{ MergeView }, { readOnlyExtensions }] = await Promise.all([loadMerge(), loadTextEditor()]);
			if (stale()) return;
			const host = el('div', 'cm-merge-view fc-file-diff');
			detail.appendChild(host);
			const merge = new MergeView({
				a: { doc: left.contents ?? '', extensions: readOnlyExtensions() },
				b: { doc: right.contents ?? '', extensions: readOnlyExtensions() },
				parent: host,
				collapseUnchanged: { margin: 3, minSize: 4 },
				highlightChanges: true,
				gutter: true
			});
			this.fileDiff = { path: entry.path, left: left.contents ?? '', right: right.contents ?? '', merge, host };
		})();
		return detail;
	}
}

function sizes(entry: DirDiffEntry): string {
	const human = (size: number) => (size < 1024 ? `${size} B` : size < 1024 * 1024 ? `${(size / 1024).toFixed(1)} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`);
	if (entry.status === 'leftOnly') return human(entry.leftSize);
	if (entry.status === 'rightOnly') return human(entry.rightSize);
	return entry.leftSize === entry.rightSize ? human(entry.leftSize) : `${human(entry.leftSize)} / ${human(entry.rightSize)}`;
}
