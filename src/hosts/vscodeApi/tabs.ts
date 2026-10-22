// The Tabs API (`window.tabGroups`, VS Code 1.67+): the editor area's groups and tabs as
// the host reports them — a snapshot at activation, a `tabsChanged` push after every
// change. Tab and group objects keep their identity across pushes (an extension compares
// a tab it remembered against the next push's `activeTab` with `===`, Git Graph's
// orphaned-tab watcher among them), and `close` reaches the host's real tab close.

import { EventEmitter } from './types/events';
import { Uri } from './types/uri';
import { TabInputText, TabInputTextDiff, TabInputWebview } from './types/values';
import type { HostBridge, TabGroupSnapshot, TabGroupsSnapshot, TabSnapshot } from './bridge';

type TabInput = TabInputText | TabInputTextDiff | TabInputWebview | undefined;

/** One tab: its fields read the latest snapshot, its identity stays the tab's. */
export class Tab {
	/** The input object, rebuilt only when the tab's input itself changes — VS Code hands
	 *  out the same input until then. */
	private inputValue: TabInput = undefined;
	private inputKey = '';

	constructor(private data: TabSnapshot, private owner: TabGroup) {
		this.update(data, owner);
	}

	update(data: TabSnapshot, owner: TabGroup): void {
		this.data = data;
		this.owner = owner;
		const key = JSON.stringify(data.input);
		if (key === this.inputKey) return;
		this.inputKey = key;
		const input = data.input;
		this.inputValue = input === null ? undefined
			: input.kind === 'text' ? new TabInputText(Uri.file(input.path))
				: input.kind === 'diff' ? new TabInputTextDiff(Uri.file(input.original), Uri.file(input.modified))
					: new TabInputWebview(input.viewType);
	}

	get id(): string {
		return this.data.id;
	}

	get label(): string {
		return this.data.label;
	}

	get group(): TabGroup {
		return this.owner;
	}

	get input(): TabInput {
		return this.inputValue;
	}

	get isActive(): boolean {
		return this.owner.activeTab === this;
	}

	get isDirty(): boolean {
		return this.data.dirty;
	}

	readonly isPinned = false;
	readonly isPreview = false;

	/** The panel behind a webview tab, when the tab is one of `extId`'s panels. */
	panelOf(extId: string): number | null {
		const input = this.data.input;
		return input?.kind === 'webview' && input.extId === extId ? input.panelId : null;
	}
}

/** One editor group (VS Code's `TabGroup`), keyed by its column. */
export class TabGroup {
	tabs: Tab[] = [];
	activeTab: Tab | undefined = undefined;
	isActive = false;

	constructor(readonly viewColumn: number) {}
}

export interface TabChangeEvent {
	readonly opened: readonly Tab[];
	readonly closed: readonly Tab[];
	readonly changed: readonly Tab[];
}

export interface TabGroupChangeEvent {
	readonly opened: readonly TabGroup[];
	readonly closed: readonly TabGroup[];
	readonly changed: readonly TabGroup[];
}

/** The model behind `window.tabGroups`: applies the host's snapshots, fires VS Code's two
 *  change events, and closes tabs through the `tabs.close` host request. */
export class TabGroupsModel {
	private groups: TabGroup[] = [];
	private readonly groupsByColumn = new Map<number, TabGroup>();
	private readonly tabsById = new Map<string, Tab>();
	private lastJson = '';
	readonly tabsChanged = new EventEmitter<TabChangeEvent>();
	readonly groupsChanged = new EventEmitter<TabGroupChangeEvent>();

	constructor(private readonly bridge: HostBridge, initial: TabGroupsSnapshot | undefined) {
		// An older bridge reports nothing: the one empty group a fresh window has.
		this.apply(initial ?? [{ viewColumn: 1, active: true, activeId: null, tabs: [] }], false);
	}

	/** Every tab currently open, across the groups. */
	allTabs(): Tab[] {
		return this.groups.flatMap((group) => group.tabs);
	}

	apply(snapshot: TabGroupsSnapshot, fire = true): void {
		const json = JSON.stringify(snapshot);
		if (json === this.lastJson) return;
		this.lastJson = json;
		const groupsBefore = new Set(this.groups);
		const tabsBefore = new Map(this.tabsById);
		const describe = (group: TabGroup) => `${group.isActive}|${group.activeTab?.id ?? ''}|${group.tabs.map((tab) => tab.id).join(',')}`;
		const groupStateBefore = new Map(this.groups.map((group) => [group, describe(group)]));
		const tabStateBefore = new Map([...this.tabsById].map(([id, tab]) => [id, JSON.stringify([tab.label, tab.isDirty, tab.isActive, tab.group.viewColumn, tab.input === undefined ? null : JSON.stringify(tab.input)])]));
		const opened: Tab[] = [];
		const nextGroups: TabGroup[] = [];
		this.tabsById.clear();
		for (const groupData of snapshot) {
			const group = this.groupFor(groupData);
			group.isActive = groupData.active;
			group.tabs = groupData.tabs.map((tabData) => {
				let tab = tabsBefore.get(tabData.id);
				if (tab) tab.update(tabData, group);
				else {
					tab = new Tab(tabData, group);
					opened.push(tab);
				}
				this.tabsById.set(tabData.id, tab);
				return tab;
			});
			group.activeTab = group.tabs.find((tab) => tab.id === groupData.activeId);
			nextGroups.push(group);
		}
		for (const column of [...this.groupsByColumn.keys()]) {
			if (!snapshot.some((group) => group.viewColumn === column)) this.groupsByColumn.delete(column);
		}
		this.groups = nextGroups;
		if (!fire) return;
		const closed = [...tabsBefore.values()].filter((tab) => !this.tabsById.has(tab.id));
		const changed = [...this.tabsById.values()].filter((tab) => {
			const before = tabStateBefore.get(tab.id);
			return before !== undefined && before !== JSON.stringify([tab.label, tab.isDirty, tab.isActive, tab.group.viewColumn, tab.input === undefined ? null : JSON.stringify(tab.input)]);
		});
		const groupsOpened = nextGroups.filter((group) => !groupsBefore.has(group));
		const groupsClosed = [...groupsBefore].filter((group) => !nextGroups.includes(group));
		const groupsChanged = nextGroups.filter((group) => groupsBefore.has(group) && groupStateBefore.get(group) !== describe(group));
		if (groupsOpened.length > 0 || groupsClosed.length > 0 || groupsChanged.length > 0) {
			this.groupsChanged.fire({ opened: groupsOpened, closed: groupsClosed, changed: groupsChanged });
		}
		if (opened.length > 0 || closed.length > 0 || changed.length > 0) this.tabsChanged.fire({ opened, closed, changed });
	}

	private groupFor(data: TabGroupSnapshot): TabGroup {
		let group = this.groupsByColumn.get(data.viewColumn);
		if (!group) {
			group = new TabGroup(data.viewColumn);
			this.groupsByColumn.set(data.viewColumn, group);
		}
		return group;
	}

	/** `window.tabGroups` itself. */
	api() {
		const model = this;
		return {
			get all(): readonly TabGroup[] {
				return model.groups;
			},
			get activeTabGroup(): TabGroup {
				return model.groups.find((group) => group.isActive) ?? model.groups[0]!;
			},
			onDidChangeTabs: this.tabsChanged.event,
			onDidChangeTabGroups: this.groupsChanged.event,
			/** `close(tab | tab[] | group | group[], preserveFocus?)`: answers whether anything
			 *  closed — a tab already gone (another close, the host's own cleanup) is no error. */
			close: async (target: Tab | TabGroup | readonly (Tab | TabGroup)[], preserveFocus?: boolean): Promise<boolean> => {
				const items = Array.isArray(target) ? target : [target];
				const ids = items.flatMap((item) => (item instanceof TabGroup ? item.tabs.map((tab) => tab.id) : item instanceof Tab ? [item.id] : []));
				if (ids.length === 0) return false;
				return (await model.bridge.request('tabs.close', [ids, preserveFocus === true])) === true;
			}
		};
	}
}
