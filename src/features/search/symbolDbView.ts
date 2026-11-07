// The Symbol Database page (plan M4): the whole index as one collapsible tree — folders,
// files, declarations — with per-symbol reference counts, a name filter, and a rebuild
// action. The same backend shape (`symbol_tree`) serves the MCP server's `symbol_tree`
// tool, so what the page shows is exactly what an AI assistant is told.

import { Channel } from '../../platform/ipc/core';
import { symbolTree, symbolsRebuild } from '../../platform/ipc/symbols';

import { t } from '../../platform/i18n';
import { KIND_ICONS } from './contextView';
import { actionButton, el, icon } from '../../platform/ui/index';


import type { TreeFile, TreeSymbol } from '../../platform/ipc/symbols';
export type { TreeFile, TreeSymbol };

/** A folder of the tree: nested folders and the files directly in it. */
export interface FolderNode {
	name: string;
	/** The folder's repo-relative path ('' for the root). */
	path: string;
	folders: FolderNode[];
	files: TreeFile[];
}

/** Group the path-sorted file list into the nested folder tree the page renders — the
 *  returned node is the root (its  are the top-level ones). Pure, so the tests
 *  shape it without a backend. */
export function buildTree(files: TreeFile[]): FolderNode {
	const root: FolderNode = { name: '', path: '', folders: [], files: [] };
	const folderAt = (segments: string[], create: boolean): FolderNode | null => {
		let node = root;
		let path = '';
		for (const segment of segments) {
			path = path ? `${path}/${segment}` : segment;
			let next = node.folders.find((folder) => folder.name === segment);
			if (!next) {
				if (!create) return null;
				next = { name: segment, path, folders: [], files: [] };
				node.folders.push(next);
			}
			node = next;
		}
		return node;
	};
	for (const file of files) {
		const segments = file.path.split('/');
		segments.pop();
		const folder = folderAt(segments, true)!;
		folder.files.push({ ...file, path: file.path });
		folder.files.sort((a, b) => a.path.localeCompare(b.path));
	}
	const sortFolders = (node: FolderNode): void => {
		node.folders.sort((a, b) => a.name.localeCompare(b.name));
		for (const folder of node.folders) sortFolders(folder);
	};
	sortFolders(root);
	return root;
}

/** How many files and symbols a subtree holds, for the folder rows' counters. */
export function subtreeCounts(folders: FolderNode[], files: TreeFile[]): { files: number; symbols: number } {
	let fileCount = files.length;
	let symbols = files.reduce((sum, file) => sum + file.symbols.length, 0);
	for (const folder of folders) {
		const nested = subtreeCounts(folder.folders, folder.files);
		fileCount += nested.files;
		symbols += nested.symbols;
	}
	return { files: fileCount, symbols };
}

/** One visible row's identity and content — what the render's reconciliation compares
 *  before keeping an existing row's DOM (element, listeners included) instead of rebuilding. */
interface RowSpec {
	/** The folder path, file path, or `file:line` of a symbol — unique per visible row. */
	key: string;
	container: boolean;
	glyph: string;
	label: string;
	description: string;
	tail: string | null;
	/** A symbol row's click handler (the open target folded in); a container row toggles
	 *  its own key instead. */
	onOpen: (() => void) | null;
}

export class SymbolDatabaseView {
	private readonly list: HTMLElement;
	private files: TreeFile[] = [];
	private loading = true;
	/** Collapsed node keys (the folder or file path); a filter overrides the collapsing. */
	private collapsed = new Set<string>();
	private filter = '';

	onOpen: ((path: string, line: number) => void) | null = null;

	constructor(container: HTMLElement) {
		container.classList.add('symbol-db');
		const header = el('div', 'sd-header');
		this.title = el('span', 'sd-title', [t('symbols.page.title')]);
		this.filterInput = el('input', 'sd-filter') as HTMLInputElement;
		this.filterInput.type = 'search';
		this.filterInput.placeholder = t('symbols.page.filter');
		this.filterInput.setAttribute('aria-label', t('symbols.page.filter'));
		this.filterInput.addEventListener('input', () => {
			this.filter = this.filterInput.value.trim().toLowerCase();
			this.render();
		});
		header.append(
			icon('symbol-structure'),
			this.title,
			this.filterInput,
			el('div', 'actions', [
				actionButton('collapse-all', t('symbols.page.collapseAll'), () => this.setCollapsed(true)),
				actionButton('expand-all', t('symbols.page.expandAll'), () => this.setCollapsed(false)),
				actionButton('refresh', t('symbols.rebuild'), () => void this.rebuild())
			])
		);
		this.list = el('div', 'sd-list');
		this.list.setAttribute('role', 'tree');
		this.list.setAttribute('aria-label', t('symbols.page.title'));
		container.append(header, this.list);
		this.render();
	}

	private readonly title: HTMLElement;
	private readonly filterInput: HTMLInputElement;

	/** Fetch the index outline and render it (the tab's open, or a rebuild's refresh). */
	async load(): Promise<void> {
		this.loading = true;
		this.render();
		try {
			this.files = (await symbolTree()) ?? [];
		} catch {
			this.files = [];
		}
		this.loading = false;
		this.render();
	}

	private async rebuild(): Promise<void> {
		const onEvent = new Channel<{ kind: string }>();
		onEvent.onmessage = () => undefined; // the status bar follows the progress; the page reloads at the end
		try {
			await symbolsRebuild(onEvent);
		} catch {
			// An old backend or a cancelled build: the outline stands as it is.
		}
		await this.load();
	}

	private setCollapsed(collapsed: boolean): void {
		this.collapsed.clear();
		if (!collapsed) return;
		const walk = (folders: FolderNode[]): void => {
			for (const folder of folders) {
				this.collapsed.add(folder.path);
				walk(folder.folders);
			}
		};
		walk(buildTree(this.files).folders);
		for (const file of this.files) this.collapsed.add(file.path);
		this.render();
	}

	/** One node's children are visible when it is not collapsed — or when the filter needs
	 *  them open to show a match. */
	private isOpen(key: string): boolean {
		return this.filter !== '' || !this.collapsed.has(key);
	}

	private matches(symbol: TreeSymbol): boolean {
		return this.filter === '' || symbol.name.toLowerCase().includes(this.filter);
	}

	render(): void {
		const total = subtreeCounts([], this.files);
		this.title.textContent = this.loading
			? `${t('symbols.indexing')}…`
			: `${total.files} ${t('symbols.page.files')} · ${total.symbols} ${t('symbols.page.symbols')}`;
		if (!this.loading && this.files.length === 0) {
			this.list.textContent = '';
			this.list.appendChild(el('div', 'sd-empty', [t('symbols.page.empty')]));
			return;
		}
		const rows: { spec: RowSpec; depth: number }[] = [];
		const root = buildTree(this.files);
		this.collectRows(root.folders, root.files, 0, rows);
		this.reconcile(rows);
	}

	/** The visible rows in tree order: folders first (each followed by its subtree), then
	 *  the files, each open file followed by its declarations. Pure assembly — the DOM
	 *  changes only in `reconcile`. */
	private collectRows(folders: FolderNode[], files: TreeFile[], depth: number, out: { spec: RowSpec; depth: number }[]): void {
		// With a filter, a folder stays on screen only while something under it matches.
		const countMatches = (folders: FolderNode[]): number => {
			let count = 0;
			for (const folder of folders) {
				count += countMatches(folder.folders);
				for (const file of folder.files) count += file.symbols.filter((symbol) => this.matches(symbol)).length;
			}
			return count;
		};
		const folderVisible = (folder: FolderNode): boolean => this.filter === '' || countMatches([folder]) > 0;
		for (const folder of folders) {
			if (!folderVisible(folder)) continue;
			const counts = subtreeCounts(folder.folders, folder.files);
			out.push({
				depth,
				spec: { key: folder.path, container: true, glyph: 'folder', label: folder.name, description: `${counts.files} ${t('symbols.page.files')}`, tail: null, onOpen: null }
			});
			if (this.isOpen(folder.path)) this.collectRows(folder.folders, folder.files, depth + 1, out);
		}
		for (const file of files) {
			// With a filter, a file stays on screen only while one of its symbols matches.
			if (this.filter !== '' && !file.symbols.some((symbol) => this.matches(symbol))) continue;
			const name = file.path.slice(file.path.lastIndexOf('/') + 1);
			const directory = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '';
			out.push({
				depth,
				spec: { key: file.path, container: true, glyph: 'file', label: name, description: `${file.symbols.length} ${t('symbols.page.symbols')}`, tail: directory, onOpen: null }
			});
			if (!this.isOpen(file.path)) continue;
			for (const symbol of file.symbols) {
				if (!this.matches(symbol)) continue;
				out.push({
					depth: depth + 1,
					spec: {
						key: `${file.path}:${symbol.line}`,
						container: false,
						glyph: KIND_ICONS[symbol.kind] ?? 'symbol-variable',
						label: symbol.name,
						description: symbol.kind,
						tail: `${symbol.line + 1} · ${symbol.refs} ${t('symbols.page.refs')}`,
						onOpen: () => this.onOpen?.(file.path, symbol.line + 1)
					}
				});
			}
		}
	}

	/** Rebuild only the rows whose content changed: a keystroke in the filter, a folder
	 *  toggle or a reload keeps every unchanged visible row's element (its listeners ride
	 *  along), so a 20k-symbol index never re-creates thousands of rows per keystroke. */
	private reconcile(rows: { spec: RowSpec; depth: number }[]): void {
		const existing = new Map<string, HTMLElement>();
		for (const child of Array.from(this.list.children) as HTMLElement[]) {
			if (child.dataset['key'] !== undefined) existing.set(child.dataset['key']!, child);
		}
		const next: HTMLElement[] = [];
		const keep = new Set<HTMLElement>();
		for (const { spec, depth } of rows) {
			// The signature is every input the row's DOM derives from; an unchanged one
			// keeps its element.
			const signature = [depth, spec.container ? 'c' : 'f', this.isOpen(spec.key) ? 'open' : 'closed', spec.glyph, spec.label, spec.description, spec.tail ?? ''].join('\u0000');
			const current = existing.get(spec.key);
			if (current && current.dataset['sig'] === signature) {
				keep.add(current);
				next.push(current);
				continue;
			}
			const row = this.row(spec, depth, signature);
			keep.add(row);
			next.push(row);
		}
		for (const child of Array.from(this.list.children) as HTMLElement[]) {
			if (!keep.has(child)) child.remove();
		}
		// Restore the tree order — skipped entirely when it already holds (the common
		// keystroke): every append of a kept row is a move, and a no-op order moves nothing.
		const unchanged = next.length === this.list.children.length && next.every((node, index) => this.list.children[index] === node);
		if (!unchanged) for (const node of next) this.list.appendChild(node);
	}

	private toggle(key: string): void {
		if (this.collapsed.has(key)) this.collapsed.delete(key);
		else this.collapsed.add(key);
		this.render();
	}

	/** One tree row: twistie + icon + label + description + tail, at an indentation depth.
	 *  `signature` is what reconciliation compared; a row carries it forward in its dataset. */
	private row(spec: RowSpec, depth: number, signature: string): HTMLElement {
		const row = el('div', 'sd-row' + (spec.container ? ' container' : ''));
		row.dataset['key'] = spec.key;
		row.dataset['sig'] = signature;
		row.style.setProperty('--depth', String(depth));
		row.setAttribute('role', 'treeitem');
		if (spec.container) row.setAttribute('aria-expanded', this.isOpen(spec.key) ? 'true' : 'false');
		const twistie = el('span', 'twistie', [icon(spec.container ? (this.isOpen(spec.key) ? 'chevron-down' : 'chevron-right') : 'none')]);
		twistie.tabIndex = -1;
		row.append(twistie, icon(spec.glyph), el('span', 'label', [spec.label]));
		if (spec.description) row.appendChild(el('span', 'description', [spec.description]));
		if (spec.tail !== null) row.appendChild(el('span', 'tail', [spec.tail]));
		if (spec.container) row.addEventListener('click', () => this.toggle(spec.key));
		else row.addEventListener('click', () => spec.onOpen?.());
		return row;
	}
}
