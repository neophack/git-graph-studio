// The generic tree view host (module 12): the sidebar surface `contributes.views` declares
// and `window.createTreeView` feeds. The workbench owns the section (its header, this tree);
// the content comes from the extension's frame over the extension host — `fetchChildren`
// resolves one node's serialized children, `onCommand` runs the item's declared command.
//
// Rows are VS Code's shapes: a twistie for expandable items (children fetched lazily, the
// expansion state kept per item handle), the label with a dimmed description, an optional
// icon image, and a click that runs the item's command when it declares one.

import { el, icon } from './ui';

/** One node as the extension's frame serialized it (`getTreeItem` already applied). The
 *  handle is the frame's opaque id — `fetchChildren(handle)` walks the next level. */
export interface SerializedTreeItem {
	handle: string;
	label: string;
	description?: string;
	tooltip?: string;
	/** A data: URL (the host resolves `iconPath` through the extension's files). */
	iconUrl?: string;
	/** `TreeItemCollapsibleState`: 0 none, 1 collapsed, 2 expanded. */
	collapsibleState?: number;
	command?: { command: string; title?: string; arguments?: unknown[] };
}

export interface TreeViewHost {
	/** The children of `handle` (null = the root level), straight from the provider. */
	fetchChildren: (handle: string | null) => Promise<SerializedTreeItem[]>;
	/** A row's declared command was clicked. */
	onCommand: (command: string, args: unknown[]) => void;
}

interface Row {
	handle: string;
	item: SerializedTreeItem;
	depth: number;
}

export class ExtensionTreeView {
	private readonly tree: HTMLElement;
	/** Node handles whose children are on screen (fetched and rendered). */
	private readonly expanded = new Set<string>();
	private rows: Row[] = [];
	private refreshing = false;
	private refreshQueued = false;

	constructor(container: HTMLElement, title: string, private readonly host: TreeViewHost) {
		container.appendChild(el('div', 'sidebar-title', [el('span', 'label', [title])]));
		this.tree = el('div', 'pane-body list ext-tree');
		this.tree.tabIndex = 0;
		container.appendChild(el('div', 'view-pane', [this.tree]));
		this.refresh();
	}

	/** Re-fetch every visible level — the extension's data changed. A refresh already running
	 *  queues one more pass, so a burst of `onDidChangeTreeData` events collapses. */
	refresh(): void {
		if (this.refreshing) {
			this.refreshQueued = true;
			return;
		}
		this.refreshing = true;
		void this.buildVisible(null, 0, []).then((rows) => {
			this.rows = rows;
			this.render();
			this.refreshing = false;
			if (this.refreshQueued) {
				this.refreshQueued = false;
				this.refresh();
			}
		});
	}

	/** The visible rows in order: each level's children fetched, then descended into for
	 *  nodes still expanded. Sequential per level — a tree view's nodes are cheap. */
	private async buildVisible(parent: string | null, depth: number, out: Row[]): Promise<Row[]> {
		const items = await this.host.fetchChildren(parent).catch(() => [] as SerializedTreeItem[]);
		for (const item of items) {
			// A node declared Expanded opens itself the first time it appears.
			if ((item.collapsibleState ?? 0) === 2) this.expanded.add(item.handle);
			out.push({ handle: item.handle, item, depth });
			if (this.expanded.has(item.handle) && (item.collapsibleState ?? 0) !== 0) await this.buildVisible(item.handle, depth + 1, out);
		}
		return out;
	}

	private render(): void {
		this.tree.replaceChildren();
		if (this.rows.length === 0) {
			this.tree.appendChild(el('p', 'empty', ['—']));
			return;
		}
		for (const row of this.rows) this.tree.appendChild(this.renderRow(row));
	}

	private renderRow(row: Row): HTMLElement {
		const item = row.item;
		const expandable = (item.collapsibleState ?? 0) !== 0;
		const expanded = this.expanded.has(row.handle);
		const twistie = expandable ? icon(expanded ? 'chevron-down' : 'chevron-right') : el('span', 'twistie-placeholder');
		const rowEl = el('div', `row ext-tree-row${expandable ? ' expandable' : ''}`, [twistie]);
		rowEl.style.paddingLeft = `${8 + row.depth * 12}px`;
		if (item.iconUrl) {
			const image = el('img', 'ext-tree-icon');
			image.src = item.iconUrl;
			image.alt = '';
			rowEl.appendChild(image);
		}
		rowEl.appendChild(el('span', 'label', [item.label]));
		if (item.description) rowEl.appendChild(el('span', 'description', [item.description]));
		if (item.tooltip) rowEl.title = item.tooltip;
		rowEl.addEventListener('click', () => {
			if (expandable) this.toggle(row);
			if (item.command) this.host.onCommand(item.command.command, item.command.arguments ?? []);
		});
		return rowEl;
	}

	private toggle(row: Row): void {
		if (this.expanded.has(row.handle)) {
			this.expanded.delete(row.handle);
			// Drop this row's subtree, then re-render.
			const at = this.rows.findIndex((candidate) => candidate.handle === row.handle);
			if (at !== -1) {
				let end = at + 1;
				while (end < this.rows.length && this.rows[end]!.depth > row.depth) end++;
				this.rows.splice(at + 1, end - at - 1);
			}
			this.render();
			return;
		}
		this.expanded.add(row.handle);
		void this.host.fetchChildren(row.handle)
			.then((children) => {
				const at = this.rows.findIndex((candidate) => candidate.handle === row.handle);
				if (at === -1) return;
				// A node declared Expanded opens itself as part of the toggle.
				this.rows.splice(at + 1, 0, ...children.map((child) => ({ handle: child.handle, item: child, depth: row.depth + 1 })));
				this.render();
			})
			.catch(() => undefined);
	}
}
