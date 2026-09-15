// The Symbol Database page (plan M4): the whole index as one collapsible tree — folders,
// files, declarations — with per-symbol reference counts, a name filter, and a rebuild
// action. The same backend shape (`symbol_tree`) serves the MCP server's `symbol_tree`
// tool, so what the page shows is exactly what an AI assistant is told.

import { invoke, Channel } from '@tauri-apps/api/core';

import { t } from './i18n';
import { KIND_ICONS } from './contextView';
import { actionButton, el, icon } from './ui';

export interface TreeSymbol {
	kind: string;
	name: string;
	/** 0-based declaration line. */
	line: number;
	/** How many files the name occurs in (the index's occurrence list length). */
	refs: number;
}

export interface TreeFile {
	/** Repo-relative, forward slashes. */
	path: string;
	symbols: TreeSymbol[];
}

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
		const name = segments.pop()!;
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
			this.files = (await invoke<TreeFile[] | null>('symbol_tree')) ?? [];
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
			await invoke('symbols_rebuild', { onEvent });
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
		this.list.textContent = '';
		const total = subtreeCounts([], this.files);
		this.title.textContent = this.loading
			? `${t('symbols.indexing')}…`
			: `${total.files} ${t('symbols.page.files')} · ${total.symbols} ${t('symbols.page.symbols')}`;
		if (!this.loading && this.files.length === 0) {
			this.list.appendChild(el('div', 'sd-empty', [t('symbols.page.empty')]));
			return;
		}
		const root = buildTree(this.files);
		this.renderFolders(root.folders, root.files, 0);
	}

	private renderFolders(folders: FolderNode[], files: TreeFile[], depth: number): void {
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
			this.list.appendChild(this.row(depth, true, folder.path, icon('folder'), folder.name, `${counts.files} ${t('symbols.page.files')}`, null, () => {
				this.toggle(folder.path);
			}));
			if (this.isOpen(folder.path)) this.renderFolders(folder.folders, folder.files, depth + 1);
		}
		for (const file of files) {
			// With a filter, a file stays on screen only while one of its symbols matches.
			if (this.filter !== '' && !file.symbols.some((symbol) => this.matches(symbol))) continue;
			const name = file.path.slice(file.path.lastIndexOf('/') + 1);
			const directory = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '';
			this.list.appendChild(this.row(depth, true, file.path, icon('file'), name, `${file.symbols.length} ${t('symbols.page.symbols')}`, directory, () => {
				this.toggle(file.path);
			}));
			if (this.isOpen(file.path)) this.renderSymbols(file, depth + 1);
		}
	}

	private renderSymbols(file: TreeFile, depth: number): void {
		for (const symbol of file.symbols) {
			if (!this.matches(symbol)) continue;
			const row = this.row(depth, false, `${file.path}:${symbol.line}`, icon(KIND_ICONS[symbol.kind] ?? 'symbol-variable'), symbol.name, symbol.kind, `${symbol.line + 1} · ${symbol.refs} ${t('symbols.page.refs')}`, null);
			row.addEventListener('click', () => this.onOpen?.(file.path, symbol.line + 1));
			this.list.appendChild(row);
		}
	}

	private toggle(key: string): void {
		if (this.collapsed.has(key)) this.collapsed.delete(key);
		else this.collapsed.add(key);
		this.render();
	}

	/** One tree row: twistie + icon + label + description + tail, at an indentation depth. */
	private row(depth: number, container: boolean, key: string, glyph: HTMLElement, label: string, description: string, tail: string | null, onToggle: (() => void) | null): HTMLElement {
		const row = el('div', 'sd-row' + (container ? ' container' : ''));
		row.dataset['key'] = key;
		row.style.setProperty('--depth', String(depth));
		row.setAttribute('role', 'treeitem');
		if (container) row.setAttribute('aria-expanded', this.isOpen(key) ? 'true' : 'false');
		const twistie = el('span', 'twistie', [icon(container ? (this.isOpen(key) ? 'chevron-down' : 'chevron-right') : 'none')]);
		twistie.tabIndex = -1;
		row.append(twistie, glyph, el('span', 'label', [label]));
		if (description) row.appendChild(el('span', 'description', [description]));
		if (tail !== null) row.appendChild(el('span', 'tail', [tail]));
		if (onToggle) row.addEventListener('click', () => onToggle());
		return row;
	}
}
