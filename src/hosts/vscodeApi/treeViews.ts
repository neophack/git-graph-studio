// The frame-side half of tree views: the provider contract, the TreeItem
// serializer and one registration (provider + element handles + push events).

import type { HostBridge } from './bridge';
import { Disposable, EventEmitter } from './types/events';
import { ThemeIcon } from './types/values';
import { Uri } from './types/uri';
import { shimLog } from './shimLog';

/** A tree data provider as VS Code spells it: children on demand, an item per element, a
 *  change event that re-reads whatever is on screen. */
export interface TreeDataProvider<T> {
	getChildren(element?: T): T[] | PromiseLike<T[]>;
	getTreeItem(element: T): { label: string | { label: string; highlights?: [number, number][] }; description?: string; tooltip?: string | undefined; iconPath?: string | { light?: string; dark?: string }; collapsibleState?: number; command?: { command: string; title?: string; arguments?: unknown[] } } | PromiseLike<Record<string, unknown>>;
	onDidChangeTreeData?: (listener: (element: T | undefined | null) => void) => Disposable;
	getParent?(element: T): T | undefined;
}

/** An icon path (string, Uri, light/dark pair) as the path the host resolves: an
 *  extension-relative or absolute file path. */
function iconPathText(value: unknown): string | undefined {
	if (typeof value === 'string') return value;
	if (value instanceof Uri) return value.fsPath;
	if (value !== null && typeof value === 'object') {
		const pair = value as { light?: unknown; dark?: unknown; fsPath?: unknown };
		if (typeof pair.fsPath === 'string') return pair.fsPath;
		return iconPathText(pair.dark) ?? iconPathText(pair.light);
	}
	return undefined;
}

/** One `TreeItem` as plain data for the sidebar: the label (or the resource's file name),
 *  a codicon for a ThemeIcon or a file path for an image, the contextValue the
 *  `view/item/context` menus match on, the checkbox and the command with its arguments. */
function serializeTreeItem(handle: string, raw: Record<string, unknown>): Record<string, unknown> {
	const resourceUri = raw.resourceUri as Uri | undefined;
	const rawLabel = raw.label as string | { label?: string } | undefined;
	const label = typeof rawLabel === 'string' ? rawLabel : rawLabel?.label ?? (resourceUri ? resourceUri.path.split('/').pop() ?? '' : '');
	const icon = raw.iconPath;
	const themeIcon = icon instanceof ThemeIcon || (icon !== null && typeof icon === 'object' && typeof (icon as { id?: unknown }).id === 'string' && !('light' in (icon as object))) ? (icon as ThemeIcon).id : undefined;
	const tooltip = raw.tooltip as string | { value?: string } | undefined;
	const checkbox = raw.checkboxState as number | { state?: number } | undefined;
	const description = raw.description === true && resourceUri ? resourceUri.fsPath : typeof raw.description === 'string' ? raw.description : undefined;
	return {
		handle,
		id: typeof raw.id === 'string' ? raw.id : undefined,
		label,
		description,
		tooltip: typeof tooltip === 'string' ? tooltip : tooltip?.value,
		// The extension-relative path crosses the wire; the host resolves it into a data
		// URL before the sidebar renders (the field stays `iconUrl` end to end).
		iconUrl: themeIcon === undefined ? iconPathText(icon) : undefined,
		codicon: themeIcon,
		contextValue: typeof raw.contextValue === 'string' ? raw.contextValue : undefined,
		resourcePath: resourceUri?.fsPath,
		checkbox: checkbox === undefined ? undefined : typeof checkbox === 'number' ? checkbox : checkbox.state,
		collapsibleState: typeof raw.collapsibleState === 'number' ? raw.collapsibleState : 0,
		command: raw.command as { command: string; title?: string; arguments?: unknown[] } | undefined
	};
}

/** One registered tree view: the provider, its element handles (host calls walk by handle),
 *  and the visibility events the host pushes. */
export class TreeViewRegistration {
	visible = false;
	/** Handle -> element, and back: an element keeps its handle across refreshes (keyed by
	 *  its TreeItem id when it has one), so the host's expansion state survives a refresh
	 *  and the maps do not grow with every re-fetch. */
	readonly handles = new Map<string, unknown>();
	private readonly handleOf = new Map<unknown, string>();
	private nextHandle = 1;
	selection: unknown[] = [];
	readonly visibilityChanged = new EventEmitter<{ visible: boolean }>();
	readonly selectionChanged = new EventEmitter<{ selection: unknown[] }>();
	readonly expanded = new EventEmitter<{ element: unknown }>();
	readonly collapsed = new EventEmitter<{ element: unknown }>();
	readonly checkboxChanged = new EventEmitter<{ items: [unknown, number][] }>();

	constructor(readonly viewId: string, private readonly provider: TreeDataProvider<unknown>, private readonly bridge: HostBridge) {
		void Promise.resolve(bridge.request('treeView.register', [viewId])).catch((error) => shimLog('warn', `tree view ${viewId}: register failed: ${String(error)}`));
		provider.onDidChangeTreeData?.(() => void Promise.resolve(bridge.request('treeView.changed', [viewId])).catch(() => undefined));
	}

	/** The host asks for one level's children: elements become handles, `getTreeItem`
	 *  serializes each, and the list crosses as plain JSON. */
	async children(parent: string | null): Promise<unknown[]> {
		const element = parent === null ? undefined : this.handles.get(parent);
		const children = await Promise.resolve(this.provider.getChildren(element));
		const items: unknown[] = [];
		for (const child of children ?? []) {
			const raw = await Promise.resolve(this.provider.getTreeItem(child) as Promise<Record<string, unknown>>);
			const key = typeof raw?.id === 'string' ? `id:${raw.id}` : child;
			let handle = this.handleOf.get(key);
			if (handle === undefined) {
				handle = String(this.nextHandle++);
				this.handleOf.set(key, handle);
			}
			this.handles.set(handle, child);
			items.push(serializeTreeItem(handle, raw ?? {}));
		}
		return items;
	}

	setVisible(visible: boolean): void {
		if (this.visible === visible) return;
		this.visible = visible;
		this.visibilityChanged.fire({ visible });
	}

	/** The user selected rows (the host pushes their handles). */
	select(handles: string[]): void {
		this.selection = handles.map((handle) => this.handles.get(handle)).filter((element) => element !== undefined);
		this.selectionChanged.fire({ selection: this.selection });
	}

	/** A row was expanded or collapsed in the sidebar. */
	expand(handle: string, expanded: boolean): void {
		const element = this.handles.get(handle);
		if (element === undefined) return;
		(expanded ? this.expanded : this.collapsed).fire({ element });
	}

	/** A row's checkbox was toggled. */
	check(handle: string, state: number): void {
		const element = this.handles.get(handle);
		if (element !== undefined) this.checkboxChanged.fire({ items: [[element, state]] });
	}
}
