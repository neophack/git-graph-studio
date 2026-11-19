// The Relations panel (module 5) - an expandable reference tree over the bottom
// panel: the symbol under the cursor as the root of an expandable reference tree. The
// workbench feeds the root (debounced there); every `+` drills one ring deeper through
// `symbol_relation_children`, in either direction (refs to the root, refs the root
// makes). An expansion caches per node - a collapse keeps the fetched ring, re-expanding
// never re-asks - and a generation counter drops the answers a root or direction switch
// left behind. A ring the backend cut short (the node cap / time budget) says so in a
// faint closing line; an edge that aggregates several reference sites carries a `×N`
// badge; and resting on any symbol row floats the declaration card - the
// definition's first lines with its "kind in file at line N" caption.

import { readFile } from '../../platform/ipc/fs';
import { symbolLookup, symbolRelationChildren, type RelationDirection, type RelationNode } from '../../platform/ipc/symbols';
import type { WsSymbol } from '../../platform/ipc/search';

import { t, tf } from '../../platform/i18n';
import { KIND_ICONS } from './contextView';
import { actionButton, el, escapeHtml, icon } from '../../platform/ui/index';

import './relations.css';

/** What the workbench resolved the symbol under the cursor to (0-based line). */
export interface RelationRoot {
	kind: string;
	name: string;
	/** Repo-relative path of the definition - the index's own vocabulary, which the
	 *  relation backend and every node below the root speak too. */
	path: string;
	line: number;
}

/** How deep the tree may drill before the faint "maximum depth" line answers - the
 *  runaway guard for a hot name whose rings never end. */
const MAX_DEPTH = 8;

/** The pointer's rest before the declaration card floats in - long enough that a pass
 *  across the rows shows nothing, short enough to feel instant. */
const DECL_DELAY = 300;

/** The declaration fragment's caps: at most this many lines of the definition and this
 *  many characters, past either the text ends with an ellipsis. */
const DECL_MAX_LINES = 6;
const DECL_MAX_CHARS = 400;

/** One expandable row and its ring's bookkeeping. */
interface RelationRow {
	node: RelationNode;
	depth: number;
	row: HTMLElement;
	twistie: HTMLElement;
	childrenHost: HTMLElement;
	/** The rows built from this node's own expansion, in answer order. */
	children: RelationRow[];
	/** Whether the node's own ring came back cut short - its closing line keeps saying so. */
	truncated: boolean;
	expanded: boolean;
	/** An expansion settled - possibly with nothing (the optimistic `hasChildren`). */
	loaded: boolean;
	loading: boolean;
}

/** The declaration card's cargo: the definition's opening lines and where they sit. */
interface DeclFragment {
	kind: string;
	path: string;
	/** 0-based line the fragment starts on. */
	line: number;
	text: string;
}

/** A path's basename over either separator. */
function baseName(path: string): string {
	const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
	return cut === -1 ? path : path.slice(cut + 1);
}

export class RelationsView {
	readonly element: HTMLElement;
	readonly actions: HTMLElement;

	/** A definition click (the root chip, a row's name) or a reference-site click (a row's
	 *  edge, the row's double click) - the line arrives 1-based. */
	onOpen?: (path: string, line: number) => void;

	/** The panel page's shown() asks the workbench to re-resolve the cursor symbol. */
	onNeedRoot?: () => void;

	private readonly body: HTMLElement;
	private readonly header: HTMLElement;
	private readonly rootChip: HTMLButtonElement;
	private readonly dirTo: HTMLButtonElement;
	private readonly dirFrom: HTMLButtonElement;
	private readonly treeHost: HTMLElement;
	private readonly pinButton: HTMLButtonElement;

	private pinned = false;
	private root: RelationRoot | null = null;
	/** Why the root is empty (the resolution's note), shown instead of the resting hint. */
	private rootNote: string | undefined;
	private direction: RelationDirection = 'refsTo';
	private rootRows: RelationRow[] = [];
	/** Whether the root's own ring was cut short - its closing line keeps saying so. */
	private rootTruncated = false;
	private rootLoading = false;
	private rootFailed = false;
	/** The root fetch's staleness counter: a setRoot / direction switch invalidates every
	 *  answer before it, the in-flight expansions included. */
	private generation = 0;

	/** The declaration fragments, keyed `name|path`: a settled one is reused across every
	 *  node that carries the symbol, an in-flight one dedupes concurrent hovers. */
	private readonly declCache = new Map<string, Promise<DeclFragment | null>>();
	/** The armed hover's rest timer; null when nothing rests under the pointer. */
	private declTimer: number | null = null;
	/** The one floating card, when a hover earned it. */
	private declCard: HTMLElement | null = null;
	/** The card's document-level dismissers, kept by name so dispose can drop them — a
	 *  disposed panel must leave no listeners on the document (workbenchParts pins it). */
	private readonly onDocMouseDown = (event: MouseEvent): void => {
		if (this.declCard && !this.declCard.contains(event.target as Node)) this.hideDecl();
	};
	private readonly onDocKeyDown = (event: KeyboardEvent): void => {
		if (event.key === 'Escape' && this.declCard) this.hideDecl();
	};

	constructor() {
		this.rootChip = el('button', 'rel-root');
		this.rootChip.addEventListener('click', () => {
			if (this.root) this.onOpen?.(this.root.path, this.root.line + 1);
		});
		this.dirTo = el('button', 'rel-dir');
		this.dirTo.addEventListener('click', () => this.setDirection('refsTo'));
		this.dirFrom = el('button', 'rel-dir');
		this.dirFrom.addEventListener('click', () => this.setDirection('refsFrom'));
		this.header = el('div', 'rel-header');
		this.treeHost = el('div', 'rel-tree');
		this.body = el('div', 'rel-body');
		this.body.addEventListener('scroll', () => this.hideDecl(), { passive: true });
		this.element = el('div', 'panel-body rel-panel', [this.body]);
		this.element.hidden = true;
		this.pinButton = actionButton('pin', t('relations.pin'), () => this.togglePin());
		this.actions = el('div', 'actions', [this.pinButton]);
		// The card survives over everything (it lives in the overlays host), so any press
		// outside it - a page tab, the editor, the palette - dismisses it, and Escape does
		// too.
		document.addEventListener('mousedown', this.onDocMouseDown);
		document.addEventListener('keydown', this.onDocKeyDown);
		this.wireDeclHover(this.rootChip);
		this.render();
	}

	private togglePin(): void {
		this.pinned = !this.pinned;
		this.pinButton.title = this.pinned ? t('relations.unpin') : t('relations.pin');
		this.pinButton.setAttribute('aria-label', this.pinButton.title);
		this.pinButton.innerHTML = '';
		this.pinButton.appendChild(icon(this.pinned ? 'pinned' : 'pin'));
		this.element.classList.toggle('pinned', this.pinned);
	}

	/** While pinned, the auto-following pauses: the cursor can roam without changing the root. */
	isPinned(): boolean {
		return this.pinned;
	}

	/** The workbench's dispose: the document-level dismissers the constructor registered
	 *  must not outlive the view (a disposed panel would keep answering every click). */
	dispose(): void {
		this.hideDecl();
		document.removeEventListener('mousedown', this.onDocMouseDown);
		document.removeEventListener('keydown', this.onDocKeyDown);
	}

	/** Swap the root (or clear it, `note` explaining why) and refetch its children; the
	 *  direction survives, every expansion below the root does not. */
	setRoot(sym: RelationRoot | null, note?: string): void {
		this.root = sym ? { kind: sym.kind, name: sym.name, path: sym.path, line: sym.line } : null;
		this.rootNote = note;
		void this.loadRoot();
	}

	private async loadRoot(): Promise<void> {
		const generation = ++this.generation;
		const root = this.root;
		// A root or direction switch retires whatever a previous hover floated.
		this.hideDecl();
		this.rootRows = [];
		this.rootFailed = false;
		this.rootLoading = root !== null;
		this.render();
		if (!root) return;
		try {
			const answer = await symbolRelationChildren(root.name, root.path, root.line, this.direction);
			// A newer root or direction owns the view now; this answer paints nothing.
			if (generation !== this.generation) return;
			this.rootTruncated = answer?.truncated === true;
			this.rootRows = (answer?.nodes ?? []).map((node) => this.buildRow(node, 1));
		} catch {
			if (generation !== this.generation) return;
			this.rootFailed = true;
		}
		this.rootLoading = false;
		this.render();
	}

	/** Flip the tree's direction and refetch: the other direction is a different graph, so
	 *  every expansion collapses (the rebuilt root rows drop them) rather than surviving. */
	private setDirection(direction: RelationDirection): void {
		if (this.direction === direction) return;
		this.direction = direction;
		void this.loadRoot();
	}

	/** The panel page's activation: the workbench's hook re-resolves the cursor symbol so
	 *  the view shows the ring of whatever the editor holds right now. */
	shown(): void {
		this.onNeedRoot?.();
	}

	private render(): void {
		this.body.textContent = '';
		if (!this.root) {
			this.body.appendChild(el('div', 'rel-empty', [this.rootNote ?? t('relations.hint')]));
			return;
		}
		this.rootChip.textContent = '';
		this.rootChip.append(
			icon(KIND_ICONS[this.root.kind] ?? 'symbol-variable'),
			el('span', 'rel-root-name', [this.root.name]),
			el('span', 'rel-root-loc', [`${this.root.path}:${this.root.line + 1}`])
		);
		this.rootChip.title = t('relations.openDef');
		this.dirTo.textContent = t('relations.refsTo');
		this.dirTo.classList.toggle('active', this.direction === 'refsTo');
		this.dirTo.setAttribute('aria-pressed', this.direction === 'refsTo' ? 'true' : 'false');
		this.dirFrom.textContent = t('relations.refsFrom');
		this.dirFrom.classList.toggle('active', this.direction === 'refsFrom');
		this.dirFrom.setAttribute('aria-pressed', this.direction === 'refsFrom' ? 'true' : 'false');
		this.header.textContent = '';
		this.header.append(this.rootChip, el('div', 'rel-directions', [this.dirTo, this.dirFrom]));
		this.treeHost.textContent = '';
		this.body.append(this.header, this.treeHost);
		if (this.rootLoading) {
			this.treeHost.appendChild(el('div', 'rel-empty', [icon('sync', 'codicon-modifier-spin'), t('relations.loading')]));
			return;
		}
		if (this.rootFailed) {
			this.treeHost.appendChild(el('div', 'rel-empty', [t('relations.failed')]));
			return;
		}
		if (this.rootRows.length === 0) {
			this.treeHost.appendChild(el('div', 'rel-empty', [this.direction === 'refsTo' ? t('relations.emptyTo') : t('relations.emptyFrom')]));
			return;
		}
		for (const entry of this.rootRows) this.treeHost.append(entry.row, entry.childrenHost);
		if (this.rootTruncated) this.treeHost.appendChild(this.truncatedLine());
	}

	/** The faint closing line a cut-short ring ends with. */
	private truncatedLine(): HTMLElement {
		return el('div', 'rel-row rel-note rel-truncated', [t('relations.truncated')]);
	}

	private buildRow(node: RelationNode, depth: number): RelationRow {
		const twistie = node.hasChildren ? el('button', 'rel-twistie') : el('span', 'rel-twistie leaf');
		const name = el('button', 'rel-name', [node.name]);
		name.title = t('relations.openDef');
		const edge = el('button', 'rel-edge', [`${baseName(node.edgePath)}:${node.edgeLine + 1}`]);
		edge.title = `${node.edgePath}:${node.edgeLine + 1}`;
		// Several reference sites behind one edge: the faint count says how many, its title
		// spelling it out. A single site earns no badge.
		const count = node.edgeCount > 1 ? el('span', 'rel-edge-count', [`×${node.edgeCount}`]) : null;
		if (count) count.title = tf('relations.edgeCount', node.edgeCount);
		const row = el('div', 'rel-row', [
			twistie,
			icon(KIND_ICONS[node.kind] ?? 'symbol-variable'),
			node.container ? el('span', 'rel-container', [`${node.container}·`]) : null,
			name,
			edge,
			count
		]);
		row.title = `${node.path}:${node.line + 1}`;
		const childrenHost = el('div', 'rel-children');
		childrenHost.hidden = true;
		const entry: RelationRow = { node, depth, row, twistie, childrenHost, children: [], truncated: false, expanded: false, loaded: false, loading: false };
		if (node.hasChildren) {
			this.paintTwistie(entry);
			twistie.addEventListener('click', () => void this.toggleExpand(entry));
		}
		name.addEventListener('click', () => this.onOpen?.(node.path, node.line + 1));
		edge.addEventListener('click', () => this.onOpen?.(node.edgePath, node.edgeLine + 1));
		// The row's double click is the reference-site jump - unless it landed on the name
		// (its own click already opened the definition; a fast double click must not also
		// drag the editor to the reference site).
		row.addEventListener('dblclick', (event) => {
			const target = event.target as HTMLElement | null;
			if (target?.closest('.rel-name') || target?.closest('.rel-twistie')) return;
			this.onOpen?.(node.edgePath, node.edgeLine + 1);
		});
		this.wireDeclHover(row, node.name, node.path, node.line);
		return entry;
	}

	private async toggleExpand(entry: RelationRow): Promise<void> {
		if (entry.loading) return;
		if (entry.expanded) {
			entry.expanded = false;
			entry.childrenHost.hidden = true;
			this.paintTwistie(entry);
			return;
		}
		entry.expanded = true;
		if (entry.loaded) {
			entry.childrenHost.hidden = false;
			this.paintTwistie(entry);
			return;
		}
		// The runaway guard: at the depth cap the faint line answers instead of a request.
		if (entry.depth >= MAX_DEPTH) {
			entry.childrenHost.textContent = '';
			entry.childrenHost.appendChild(el('div', 'rel-row rel-note', [t('relations.maxDepth')]));
			entry.childrenHost.hidden = false;
			this.paintTwistie(entry);
			return;
		}
		entry.loading = true;
		this.paintTwistie(entry);
		const generation = this.generation;
		try {
			const answer = await symbolRelationChildren(entry.node.name, entry.node.path, entry.node.line, this.direction);
			entry.loading = false;
			// A root or direction switch rebuilt the tree while this rang out; the answer
			// would paint into a detached host.
			if (generation !== this.generation) return;
			entry.loaded = true;
			entry.truncated = answer?.truncated === true;
			entry.children = (answer?.nodes ?? []).map((child) => this.buildRow(child, entry.depth + 1));
			entry.childrenHost.textContent = '';
			if (entry.children.length === 0) {
				// The optimistic hasChildren misfired; `loaded` keeps the next expansion from
				// asking the same empty ring again.
				entry.childrenHost.appendChild(el('div', 'rel-row rel-note', [t('relations.noChildren')]));
			} else {
				for (const child of entry.children) entry.childrenHost.append(child.row, child.childrenHost);
			}
			if (entry.truncated) entry.childrenHost.appendChild(this.truncatedLine());
			entry.childrenHost.hidden = !entry.expanded;
		} catch {
			entry.loading = false;
			if (generation !== this.generation) return;
			entry.loaded = true;
			entry.children = [];
			entry.childrenHost.textContent = '';
			entry.childrenHost.appendChild(el('div', 'rel-row rel-note', [t('relations.failed')]));
			entry.childrenHost.hidden = false;
		}
		this.paintTwistie(entry);
	}

	private paintTwistie(entry: RelationRow): void {
		if (!(entry.twistie instanceof HTMLButtonElement)) return; // a leaf row carries no twistie
		entry.twistie.textContent = '';
		if (entry.loading) {
			entry.twistie.classList.add('loading');
			entry.twistie.appendChild(icon('sync', 'codicon-modifier-spin'));
		} else {
			entry.twistie.classList.remove('loading');
			entry.twistie.appendChild(document.createTextNode(entry.expanded ? '−' : '+'));
		}
	}

	/* ---------- The declaration card ---------- */

	/** Arm the card for a surface: the pointer's 300 ms rest there floats the symbol's
	 *  declaration; leaving early (or re-entering another row) cancels it. The root chip
	 *  carries no fixed symbol - whatever `this.root` holds at the hover is the one. */
	private wireDeclHover(surface: HTMLElement, name?: string, path?: string, line?: number): void {
		const fixed = name !== undefined && path !== undefined && line !== undefined;
		surface.addEventListener('mouseenter', (event) => {
			const target = fixed ? { name: name!, path: path!, line: line! } : this.root;
			if (!target) return;
			const generation = this.generation;
			if (this.declTimer !== null) clearTimeout(this.declTimer);
			this.declTimer = window.setTimeout(() => {
				this.declTimer = null;
				void this.showDecl(target.name, target.path, target.line, generation, event.clientX, event.clientY);
			}, DECL_DELAY);
		});
		surface.addEventListener('mouseleave', (event) => {
			if (this.declTimer !== null) {
				clearTimeout(this.declTimer);
				this.declTimer = null;
			}
			// Sliding from the row into the card keeps it up (the card sits beside the
			// pointer and can be entered); leaving everything dismisses it.
			if (this.declCard && event.relatedTarget instanceof Node && this.declCard.contains(event.relatedTarget)) return;
			this.hideDecl();
		});
	}

	/** Fetch (or reuse) the declaration fragment of one symbol: the index's definitions
	 *  for the name pick the row's own file first, then one with a body, then the first;
	 *  the file's lines from the declaration on fill the fragment, capped. A fetch that
	 *  finds nothing (no index entry, unreadable file) answers null and is not kept. */
	private declFragment(name: string, path: string): Promise<DeclFragment | null> {
		const key = `${name}|${path}`;
		const cached = this.declCache.get(key);
		if (cached) return cached;
		const fetch = (async (): Promise<DeclFragment | null> => {
			try {
				const defs: WsSymbol[] = (await symbolLookup(name)) ?? [];
				const def =
					defs.find((d) => d.path === path) ?? defs.find((d) => (d.endLine ?? d.line) > d.line) ?? defs[0];
				if (!def) return null;
				const file = await readFile(def.path);
				const contents = file?.contents;
				if (contents == null) return null;
				const lines = contents.split('\n');
				const last = Math.min(def.line + DECL_MAX_LINES, Math.max(def.endLine ?? def.line, def.line) + 1);
				let text = lines.slice(def.line, last).join('\n').slice(0, DECL_MAX_CHARS);
				// A declaration past the file's end is a stale index entry, not a fragment.
				if (text.length === 0) return null;
				if (text.length === DECL_MAX_CHARS) text += '…';
				return { kind: def.kind, path: def.path, line: def.line, text };
			} catch {
				return null;
			}
		})();
		this.declCache.set(key, fetch);
		void fetch.then((fragment) => {
			if (fragment === null) this.declCache.delete(key);
		});
		return fetch;
	}

	/** Float the card beside the pointer: the declaration's first lines over the
	 *  "kind in file at line N" caption, clamped inside the viewport. Only one card
	 *  lives at a time, and a root switch or a rebuilt row leaves it unshown. */
	private async showDecl(name: string, path: string, line: number, generation: number, x: number, y: number): Promise<void> {
		const fragment = await this.declFragment(name, path);
		// A quick pass, a root switch or a re-render while the fetch ran asks for nothing.
		if (!fragment || generation !== this.generation) return;
		this.hideDecl();
		const card = el('div', 'rel-decl');
		const code = el('pre', 'rel-decl-code');
		code.innerHTML = escapeHtml(fragment.text);
		card.append(code, el('div', 'rel-decl-meta', [tf('relations.declAt', fragment.kind, baseName(fragment.path), fragment.line + 1)]));
		card.addEventListener('mouseleave', () => this.hideDecl());
		this.declCard = card;
		(document.getElementById('overlays') ?? document.body).appendChild(card);
		// Beside the cursor (the card overlaps the row's tail, so the pointer slides into
		// it without ever leaving the row), folded back inside the viewport.
		const rect = card.getBoundingClientRect();
		let left = x + 12;
		if (left + rect.width > window.innerWidth - 4) left = Math.max(4, window.innerWidth - rect.width - 4);
		let top = y + 14;
		if (top + rect.height > window.innerHeight - 4) top = Math.max(4, y - rect.height - 8);
		card.style.left = `${left}px`;
		card.style.top = `${top}px`;
	}

	/** Retire the card and any rest still pending. */
	private hideDecl(): void {
		if (this.declTimer !== null) {
			clearTimeout(this.declTimer);
			this.declTimer = null;
		}
		this.declCard?.remove();
		this.declCard = null;
	}
}
