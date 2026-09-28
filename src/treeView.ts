// The generic tree view host (module 12): the sidebar surface `contributes.views` declares
// and `window.createTreeView` feeds. The workbench owns the section (its header, this tree);
// the content comes from the extension's frame over the extension host — `fetchChildren`
// resolves one node's serialized children, `onCommand` runs the item's declared command.
//
// Rows are VS Code's shapes: a twistie for expandable items (children fetched lazily, the
// expansion state kept per item handle), an icon (a codicon for a ThemeIcon, an image for
// a path), the label with a dimmed description, an optional checkbox, the `inline` item
// actions on hover, a click that selects the row and runs its command, and a right-click
// with the `view/item/context` menu (matched on the item's `contextValue` as `viewItem`).
// The header carries the view's `view/title` actions, its description and badge; the
// view's `message` shows above the rows.

import { commandIconContent, menuSection, resolvedMenuEntries, runMenuEntry, type ResolvedMenuEntry } from './contributions';
import { extFileDataUrl } from './extHost';
import { el, icon, labelWithIcons, showContextMenu, showMenuBelow } from './ui';

/** One node as the extension's frame serialized it (`getTreeItem` already applied). The
 *  handle is the frame's opaque id — `fetchChildren(handle)` walks the next level. */
export interface SerializedTreeItem {
	handle: string;
	label: string;
	description?: string;
	tooltip?: string;
	/** A data: URL (the host resolves `iconPath` through the extension's files). */
	iconUrl?: string;
	/** A ThemeIcon's codicon name (`new ThemeIcon('refresh')`). */
	codicon?: string;
	/** The `contextValue` the `view/item/context` menus match as `viewItem`. */
	contextValue?: string;
	/** The item's resource path (a `resourceUri` item), for the resource `when` keys. */
	resourcePath?: string;
	/** `TreeItemCheckboxState` when the item carries a checkbox (0 unchecked, 1 checked). */
	checkbox?: number;
	/** `TreeItemCollapsibleState`: 0 none, 1 collapsed, 2 expanded. */
	collapsibleState?: number;
	command?: { command: string; title?: string; arguments?: unknown[] };
}

/** The view's header facts an extension sets (`TreeView.title` / `.description` / …). */
export interface TreeViewMeta {
	title?: string;
	description?: string;
	message?: string;
	badge?: { value: number; tooltip?: string };
}

export interface TreeViewHost {
	/** The contributed view id (`view == <id>` in `when` clauses). */
	viewId?: string;
	/** The children of `handle` (null = the root level), straight from the provider. */
	fetchChildren: (handle: string | null) => Promise<SerializedTreeItem[]>;
	/** A row's declared command was clicked. */
	onCommand: (command: string, args: unknown[]) => void;
	/** A row was selected (`onDidChangeSelection`). */
	onSelect?: (handles: string[]) => void;
	/** A row was expanded or collapsed (`onDidExpandElement` / `onDidCollapseElement`). */
	onExpand?: (handle: string, expanded: boolean) => void;
	/** A row's checkbox was toggled (`onDidChangeCheckboxState`). */
	onCheckbox?: (handle: string, state: number) => void;
}

interface Row {
	handle: string;
	item: SerializedTreeItem;
	depth: number;
}

export class ExtensionTreeView {
	private readonly tree: HTMLElement;
	private readonly titleLabel: HTMLElement;
	private readonly titleDescription: HTMLElement;
	private readonly titleBadge: HTMLElement;
	private readonly titleActions: HTMLElement;
	private readonly messageEl: HTMLElement;
	/** Node handles whose children are on screen (fetched and rendered). */
	private readonly expanded = new Set<string>();
	/** Handles the extension declared Expanded that already opened once (the user may
	 *  collapse them afterwards; a refresh must not re-open them). */
	private readonly autoExpanded = new Set<string>();
	private selected: string | null = null;
	private rows: Row[] = [];
	private refreshing = false;
	private refreshQueued = false;

	constructor(container: HTMLElement, private readonly title: string, private readonly host: TreeViewHost) {
		this.titleLabel = el('span', 'label', [title]);
		this.titleDescription = el('span', 'ext-tree-title-description');
		this.titleBadge = el('span', 'ext-tree-badge');
		this.titleBadge.hidden = true;
		this.titleActions = el('span', 'ext-tree-title-actions');
		container.appendChild(el('div', 'sidebar-title', [this.titleLabel, this.titleDescription, this.titleBadge, this.titleActions]));
		this.messageEl = el('p', 'ext-tree-message');
		this.messageEl.hidden = true;
		this.tree = el('div', 'pane-body list ext-tree');
		this.tree.tabIndex = 0;
		container.appendChild(el('div', 'view-pane', [this.messageEl, this.tree]));
		this.renderTitleActions();
		this.refresh();
	}

	/** The `when` keys every menu of this view evaluates against. */
	private viewContext(item?: SerializedTreeItem): Record<string, unknown> {
		return { view: this.host.viewId, viewItem: item?.contextValue, ...(item?.resourcePath ? { resourcePath: item.resourcePath, resource: item.resourcePath } : {}) };
	}

	/** The menu argument for a row: a marker the extension's shim turns back into the
	 *  element its provider returned (the element itself never leaves the frame). */
	private itemArgument(row: Row): unknown {
		return { $treeViewId: this.host.viewId, $treeItemHandle: row.handle };
	}

	/** The header's `view/title` actions: the `navigation` group as icon buttons, the rest
	 *  behind "…" (VS Code's layout). */
	private renderTitleActions(): void {
		this.titleActions.replaceChildren();
		if (!this.host.viewId) return;
		const entries = resolvedMenuEntries('view/title', this.viewContext());
		for (const entry of entries.filter((candidate) => candidate.group === 'navigation')) this.titleActions.appendChild(this.actionButton(entry, []));
		const rest = entries.filter((candidate) => candidate.group !== 'navigation');
		if (rest.length > 0) {
			const more = el('button', 'action-btn', [icon('ellipsis')]);
			more.title = '…';
			more.addEventListener('click', (event) => {
				event.stopPropagation();
				showMenuBelow(more, rest.map((entry) => ({ label: entry.label, run: () => runMenuEntry(entry, []) })));
			});
			this.titleActions.appendChild(more);
		}
	}

	/** One action as a button: its manifest icon (a codicon, or the package image), else
	 *  its label. */
	private actionButton(entry: ResolvedMenuEntry, args: unknown[]): HTMLElement {
		const button = el('button', 'action-btn', commandIconContent(entry, entry.label, extFileDataUrl));
		button.title = entry.label;
		button.setAttribute('aria-label', entry.label);
		button.addEventListener('click', (event) => {
			event.stopPropagation();
			runMenuEntry(entry, args);
		});
		return button;
	}

	/** The extension set the view's title, description, message or badge. */
	setMeta(meta: TreeViewMeta): void {
		this.titleLabel.textContent = meta.title ?? this.title;
		this.titleDescription.textContent = meta.description ?? '';
		this.titleBadge.hidden = !meta.badge || !meta.badge.value;
		this.titleBadge.textContent = meta.badge ? String(meta.badge.value) : '';
		this.titleBadge.title = meta.badge?.tooltip ?? '';
		this.messageEl.hidden = !meta.message;
		this.messageEl.textContent = meta.message ?? '';
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
			this.renderTitleActions();
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
			if ((item.collapsibleState ?? 0) === 2 && !this.autoExpanded.has(item.handle)) {
				this.autoExpanded.add(item.handle);
				this.expanded.add(item.handle);
			}
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
		const rowEl = el('div', `row ext-tree-row${expandable ? ' expandable' : ''}${this.selected === row.handle ? ' selected' : ''}`, [twistie]);
		rowEl.style.paddingLeft = `${8 + row.depth * 12}px`;
		if (item.checkbox !== undefined) {
			const box = el('input', 'ext-tree-checkbox') as HTMLInputElement;
			box.type = 'checkbox';
			box.checked = item.checkbox === 1;
			box.addEventListener('click', (event) => {
				event.stopPropagation();
				item.checkbox = box.checked ? 1 : 0;
				this.host.onCheckbox?.(row.handle, item.checkbox);
			});
			rowEl.appendChild(box);
		}
		if (item.codicon) {
			rowEl.appendChild(icon(item.codicon, 'ext-tree-codicon'));
		} else if (item.iconUrl) {
			const image = el('img', 'ext-tree-icon');
			image.src = item.iconUrl;
			image.alt = '';
			rowEl.appendChild(image);
		}
		rowEl.appendChild(el('span', 'label', labelWithIcons(item.label)));
		if (item.description) rowEl.appendChild(el('span', 'description', [item.description]));
		if (item.tooltip) rowEl.title = item.tooltip;
		// The `inline` group of the item menu: icon buttons at the row's end.
		if (this.host.viewId) {
			const inline = resolvedMenuEntries('view/item/context', this.viewContext(item)).filter((entry) => entry.group === 'inline');
			if (inline.length > 0) rowEl.appendChild(el('span', 'ext-tree-inline-actions', inline.map((entry) => this.actionButton(entry, [this.itemArgument(row)]))));
		}
		rowEl.addEventListener('click', () => {
			this.select(row);
			if (expandable) this.toggle(row);
			if (item.command) this.host.onCommand(item.command.command, item.command.arguments ?? []);
		});
		rowEl.addEventListener('contextmenu', (event) => {
			if (!this.host.viewId) return;
			const entries = menuSection('view/item/context', [this.itemArgument(row)], this.viewContext(item)).filter((entry) => entry !== 'separator');
			if (entries.length === 0) return;
			event.preventDefault();
			this.select(row);
			showContextMenu(event.clientX, event.clientY, entries);
		});
		return rowEl;
	}

	private select(row: Row): void {
		if (this.selected === row.handle) return;
		this.selected = row.handle;
		for (const element of this.tree.querySelectorAll('.ext-tree-row.selected')) element.classList.remove('selected');
		const index = this.rows.indexOf(row);
		this.tree.children[index]?.classList.add('selected');
		this.host.onSelect?.([row.handle]);
	}

	private toggle(row: Row): void {
		if (this.expanded.has(row.handle)) {
			this.expanded.delete(row.handle);
			this.host.onExpand?.(row.handle, false);
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
		this.host.onExpand?.(row.handle, true);
		void this.host.fetchChildren(row.handle)
			.then((children) => {
				const at = this.rows.findIndex((candidate) => candidate.handle === row.handle);
				if (at === -1) return;
				this.rows.splice(at + 1, 0, ...children.map((child) => ({ handle: child.handle, item: child, depth: row.depth + 1 })));
				this.render();
			})
			.catch(() => undefined);
	}
}
