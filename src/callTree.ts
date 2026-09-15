// The Call Tree: Source Insight's caller / callee navigation over the workspace symbol index.
// There is no parser here - a function's body is the lines between its declaration and the
// next symbol's, and a call is a reference to a known function name inside another function's
// body. That heuristic covers the direct-call reading the tree is for; the definitions come
// from the same outline extraction the viewer uses.

import { invoke } from '@tauri-apps/api/core';

import { el, icon } from './ui';

export interface WsSymbol {
	kind: string;
	name: string;
	path: string;
	line: number;
}

export interface RefFile {
	path: string;
	matches: { line: number; column: number; length: number; text: string }[];
}

export interface CallNode {
	name: string;
	path: string;
	line: number;
	/** The lines of the caller/callee relationship, for the tree's title. */
	detail: string;
}

/** A function's extent: its declaration line (0-based, inclusive) to the next symbol's line in
 *  the same file (exclusive), or the end of the file. */
export function symbolRanges(symbols: WsSymbol[]): Map<string, { from: number; to: number }> {
	const ranges = new Map<string, { from: number; to: number }>();
	const byFile = new Map<string, WsSymbol[]>();
	for (const symbol of symbols) {
		if (!byFile.has(symbol.path)) byFile.set(symbol.path, []);
		byFile.get(symbol.path)!.push(symbol);
	}
	for (const [path, fileSymbols] of byFile) {
		const sorted = [...fileSymbols].sort((a, b) => a.line - b.line);
		sorted.forEach((symbol, index) => {
			const to = index + 1 < sorted.length ? sorted[index + 1]!.line : Number.MAX_SAFE_INTEGER;
			ranges.set(`${path}:${symbol.line}`, { from: symbol.line, to });
		});
		// File-level anchor so references outside any function still resolve to "the file".
		ranges.set(`file:${path}`, { from: 0, to: Number.MAX_SAFE_INTEGER });
	}
	return ranges;
}

/** Which function contains a (0-based) line of a file, or null for top-level code. */
export function enclosingSymbol(symbols: WsSymbol[], path: string, line: number): WsSymbol | null {
	const candidates = symbols
		.filter((s) => s.path === path && s.line <= line)
		.sort((a, b) => b.line - a.line);
	return candidates[0] ?? null;
}

/** The functions that call `symbol`: every reference to its name that sits inside another
 *  function's body. `references` come from the backend's find_references. */
export function computeCallers(symbol: WsSymbol, symbols: WsSymbol[], references: RefFile[]): CallNode[] {
	const callers = new Map<string, CallNode>();
	for (const file of references) {
		for (const match of file.matches) {
			if (file.path === symbol.path && match.line - 1 === symbol.line) continue; // the declaration itself
			const caller = enclosingSymbol(symbols, file.path, match.line - 1);
			if (!caller) continue;
			if (caller.path === symbol.path && caller.line === symbol.line) continue;
			const key = `${caller.path}:${caller.line}`;
			if (!callers.has(key)) {
				callers.set(key, { name: caller.name, path: caller.path, line: caller.line, detail: `${file.path}:${match.line}` });
			}
		}
	}
	return [...callers.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/** The functions `symbol` calls: the known function names that appear inside its body text. */
export function computeCallees(symbol: WsSymbol, symbols: WsSymbol[], body: string, bodyStartLine: number): CallNode[] {
	const functionNames = new Map<string, CallNode>();
	for (const candidate of symbols) {
		if ((candidate.kind === 'function' || candidate.kind === 'method') && !functionNames.has(candidate.name)) {
			functionNames.set(candidate.name, { name: candidate.name, path: candidate.path, line: candidate.line, detail: `${candidate.path}:${candidate.line + 1}` });
		}
	}
	const seen = new Map<string, CallNode>();
	// Every call-shaped word of the body (`name(`), looked up in the known names: one scan per
	// line, however many symbols the workspace has - a regex per name per line took seconds
	// on a large index. The declaration line itself is skipped (a recursive call still
	// counts, just not the header).
	const call = /[\p{L}\p{N}_$][\p{L}\p{N}_$]*(?=\s*\()/gu;
	for (const [index, line] of body.split('\n').entries()) {
		const isHeader = bodyStartLine + index === symbol.line;
		for (const match of line.matchAll(call)) {
			const name = match[0];
			const node = functionNames.get(name);
			if (!node || seen.has(name)) continue;
			if (isHeader && node.path === symbol.path) continue;
			seen.set(name, node);
		}
	}
	return [...seen.values()].filter((node) => !(node.path === symbol.path && node.line === symbol.line)).sort((a, b) => a.name.localeCompare(b.name));
}

export type CallDirection = 'callers' | 'callees';

/** The Call Tree editor pane: a root symbol with a direction toggle, its callers or callees as
 *  a lazily expanding tree (each level fetches the references or the body it needs). */
export class CallTreeView {
	private readonly list: HTMLElement;
	private readonly root: WsSymbol;
	private direction: CallDirection = 'callers';
	private loading = true;
	private levels = new Map<string, CallNode[]>(); // node key -> children
	private expanded = new Set<string>();
	/** depth cap so a click-through cannot walk the whole program. */
	private maxDepth = 3;
	/** The workspace index, fetched once per tree: a static cache outlived the folder it was
	 *  read from, so a tree opened after a folder switch resolved the old repository's
	 *  symbols (and never saw a function added since). */
	private symbolCache: Promise<WsSymbol[]> | null = null;

	onOpen: ((path: string, line: number) => void) | null = null;

	constructor(container: HTMLElement, root: WsSymbol) {
		this.root = root;
		container.classList.add('call-tree');
		const header = el('div', 'ct-header');
		const callers = el('button', 'button' + (this.direction === 'callers' ? ' primary' : ''), ['Callers']);
		const callees = el('button', 'button' + (this.direction === 'callees' ? ' primary' : ''), ['Callees']);
		callers.addEventListener('click', () => { this.direction = 'callers'; void this.reload().then(() => this.render()); });
		callees.addEventListener('click', () => { this.direction = 'callees'; void this.reload().then(() => this.render()); });
		header.append(icon('git-merge'), el('span', 'ct-root', [`${root.name} — ${root.path}:${root.line + 1}`]), callers, callees);
		container.appendChild(header);
		this.list = el('div', 'ct-list');
		container.appendChild(this.list);
		void this.reload().then(() => this.render());
	}

	private symbols(): Promise<WsSymbol[]> {
		// The promise is what is cached, so two levels loading at once share one request;
		// a failed request is not kept, and the next level asks again.
		this.symbolCache ??= invoke<WsSymbol[]>('workspace_symbols', { query: '', limit: 20000 }).catch((error: unknown) => {
			this.symbolCache = null;
			throw error;
		});
		return this.symbolCache;
	}

	private async reload(): Promise<void> {
		this.loading = true;
		this.levels.clear();
		this.expanded.clear();
		const symbols = await this.symbols().catch(() => [] as WsSymbol[]);
		await this.loadLevel(this.root, symbols);
		this.loading = false;
	}

	private async loadLevel(symbol: WsSymbol, symbols: WsSymbol[]): Promise<void> {
		if (this.direction === 'callers') {
			const references = await invoke<RefFile[]>('find_references', { name: symbol.name }).catch(() => [] as RefFile[]);
			this.levels.set(`${symbol.path}:${symbol.line}`, computeCallers(symbol, symbols, references));
			return;
		}
		// Callees need the body: read the file and take the lines to the next symbol.
		const file = await invoke<{ contents: string | null }>('read_file', { path: absolute(symbol.path) }).catch(() => null);
		if (!file || file.contents === null) {
			this.levels.set(`${symbol.path}:${symbol.line}`, []);
			return;
		}
		const lines = file.contents.split('\n');
		const next = symbols.filter((s) => s.path === symbol.path && s.line > symbol.line).map((s) => s.line)[0] ?? lines.length;
		this.levels.set(`${symbol.path}:${symbol.line}`, computeCallees(symbol, symbols, lines.slice(symbol.line, next).join('\n'), symbol.line));
	}

	/* The workspace symbols are repo-relative; opening needs the root, injected by the host. */
	static repoRoot: string | null = null;

	private render(): void {
		this.list.innerHTML = '';
		if (this.loading) {
			this.list.appendChild(el('div', 'ct-empty', ['Loading…']));
			return;
		}
		this.renderLevel(this.list, this.levels.get(`${this.root.path}:${this.root.line}`) ?? [], `root:${this.root.path}:${this.root.line}`, 0);
	}

	private renderLevel(container: HTMLElement, nodes: CallNode[], parentKey: string, depth: number): void {
		if (nodes.length === 0) {
			container.appendChild(el('div', 'ct-empty', [depth === 0 ? 'No calls found' : 'No further calls']));
			return;
		}
		for (const node of nodes) {
			const key = `${parentKey}>${node.path}:${node.line}`;
			const expanded = this.expanded.has(key);
			const row = el('div', 'row ct-row', [
				icon(depth >= this.maxDepth ? 'circle-filled' : expanded ? 'chevron-down' : 'chevron-right', 'twistie'),
				icon('symbol-method'),
				el('span', 'label', [node.name]),
				el('span', 'description', [`${node.path}:${node.line + 1}`])
			]);
			row.addEventListener('click', () => this.onOpen?.(absolute(node.path), node.line + 1));
			container.appendChild(row);
			if (expanded) {
				const children = el('div', 'ct-children');
				this.renderLevel(children, this.levels.get(`${node.path}:${node.line}`) ?? [], key, depth + 1);
				container.appendChild(children);
			} else if (depth < this.maxDepth) {
				// At the depth cap the circle-filled twistie is an end marker, not a button.
				row.querySelector('.twistie')?.addEventListener('click', (event) => {
					event.stopPropagation();
					void (async () => {
						this.expanded.add(key);
						if (!this.levels.has(`${node.path}:${node.line}`)) {
							const symbols = await this.symbols().catch(() => [] as WsSymbol[]);
							await this.loadLevel({ name: node.name, path: node.path, line: node.line, kind: 'function' }, symbols);
						}
						this.render();
					})();
				});
			}
		}
	}
}

/** repo-relative → absolute path (the tree opens files through the editor group). */
function absolute(relative: string): string {
	const root = CallTreeView.repoRoot;
	if (!root || /^[A-Za-z]:[\\/]/.test(relative) || relative.startsWith('\\\\')) return relative;
	const separator = root.includes('\\') ? '\\' : '/';
	return root.replace(/[\\/]+$/, '') + separator + relative.replaceAll('/', separator);
}

function basename(path: string): string {
	return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? path;
}
