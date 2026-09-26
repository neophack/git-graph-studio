// The status bar, VS Code's layout (M3 3.11 / 3.12): on the left the repository's name, the
// checked-out branch and the "Synchronize Changes" item - three buttons of its own, not one
// block - then the "Git Graph" item, the conflict count, the symbol index state and the save
// progress, then the extension-owned items (`window.createStatusBarItem`); on the right the
// extension items come first, then the cursor position, the indent, the encoding, the line
// endings, the language, and the notification bell (which opens the notification centre -
// every toast ever shown stays listed there until cleared).

import { invoke } from '@tauri-apps/api/core';

import { ENCODING_LABELS } from './editor';
import { t, tf } from './i18n';
import { SETTINGS_EVENT, settings } from './settings';
import { clearAllNotifications, clearNotification, el, icon, labelWithIcons, notificationEntries, onNotificationsChange, tooltip, type CentreEntry } from './ui';

/** How long ago an entry landed, in VS Code's wording ("just now", "5m ago"). */
function ago(at: number): string {
	const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
	if (seconds < 50) return 'just now';
	if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
	if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
	return `${Math.round(seconds / 86400)}d ago`;
}

export interface HeadInfo {
	repo: string;
	branch: string | null;
	shortHash: string;
	ahead: number;
	behind: number;
	upstream: string | null;
}

/** One extension status bar item as the extension host pushes it. */
export interface ExtensionStatusItem {
	id: string;
	alignment: number;
	priority?: number;
	text: string;
	tooltip: string;
	command?: string;
	commandArgs?: unknown[];
	color?: string;
	backgroundColor?: string;
	visible: boolean;
}

export class StatusBar {
	private readonly left: HTMLElement;
	private readonly right: HTMLElement;
	/** The repository's folder name; a click opens Source Control. */
	private readonly repoItem: HTMLElement;
	private readonly branchItem: HTMLElement;
	/** VS Code's "Synchronize Changes": sync icon with the ahead/behind counts; a click
	 *  pulls then pushes. Only a branch with an upstream has anything to synchronize. */
	private readonly syncItem: HTMLElement;
	/** VS Code's "N conflicts" item, shown while a merge / rebase has unmerged paths. */
	private readonly conflictsItem: HTMLElement;
	/** The symbol index state (M4 4.11): "Indexing symbols 12/300" while a build runs, the
	 *  symbol count when it is ready; a click rebuilds. */
	private readonly symbolsItem: HTMLElement;
	/** The save progress: "Saving… 42%" over a thin bar that fills as the backend streams
	 *  the rope out. The whole point is the multi-hundred-megabyte Ctrl+S that takes
	 *  seconds; `total` 0 (the save has not reported yet) shows the indeterminate pulse. */
	private readonly saveItem: HTMLElement;
	private readonly saveFill: HTMLElement;
	private readonly saveLabel: HTMLElement;
	private readonly positionItem: HTMLElement;
	private readonly indentItem: HTMLElement;
	private readonly encodingItem: HTMLElement;
	private readonly eolItem: HTMLElement;
	private readonly languageItem: HTMLElement;
	/** The notification bell (rightmost) and the centre panel it opens (M3 3.12). */
	private readonly bellItem: HTMLElement;
	private readonly bellBadge: HTMLElement;
	private readonly centrePanel: HTMLElement;
	private centreOpen = false;
	private hasRepo = false;
	/** Extension-owned items (`window.createStatusBarItem`): left items join after the app's
	 *  own left cluster, right items before its right one, as VS Code places them. */
	private readonly extLeft: HTMLElement;
	private readonly extRight: HTMLElement;
	private extItems: ExtensionStatusItem[] = [];
	/** An extension item was clicked - the workbench routes the command (through the
	 *  extension host, which knows whether its handler lives in a frame) with the
	 *  arguments of a `Command`-object item. */
	onExtensionCommand: ((command: string, args?: unknown[]) => void) | null = null;

	onRepoClick: (() => void) | null = null;
	onBranchClick: (() => void) | null = null;
	onSyncClick: (() => void) | null = null;
	onConflictsClick: (() => void) | null = null;
	/** The symbols item was clicked - the workbench offers the rebuild. */
	onSymbolsClick: (() => void) | null = null;
	/** The encoding / line-ending / indent items were clicked (the workbench offers pickers). */
	onEncodingClick: (() => void) | null = null;
	onEolClick: (() => void) | null = null;
	onIndentClick: (() => void) | null = null;

	constructor(container: HTMLElement) {
		this.left = el('div', 'status-left');
		this.right = el('div', 'status-right');
		container.append(this.left, this.right);

		this.repoItem = el('div', 'status-item');
		this.repoItem.hidden = true;
		this.repoItem.addEventListener('click', () => this.onRepoClick?.());
		this.branchItem = el('div', 'status-item');
		this.branchItem.addEventListener('click', () => this.onBranchClick?.());
		this.syncItem = el('div', 'status-item');
		this.syncItem.hidden = true;
		this.syncItem.addEventListener('click', () => this.onSyncClick?.());
		this.conflictsItem = el('div', 'status-item warning');
		this.conflictsItem.hidden = true;
		this.conflictsItem.addEventListener('click', () => this.onConflictsClick?.());
		this.symbolsItem = el('div', 'status-item');
		this.symbolsItem.hidden = true;
		this.symbolsItem.addEventListener('click', () => this.onSymbolsClick?.());
		this.saveItem = el('div', 'status-item status-save');
		this.saveItem.hidden = true;
		this.saveFill = el('i');
		this.saveLabel = el('span');
		this.saveItem.append(el('div', 'status-save-track', [this.saveFill]), this.saveLabel);
		this.extLeft = el('div', 'status-ext');
		this.extRight = el('div', 'status-ext');
		this.left.append(this.repoItem, this.branchItem, this.syncItem, this.conflictsItem, this.symbolsItem, this.saveItem, this.extLeft);

		this.positionItem = el('div', 'status-item static');
		this.indentItem = el('div', 'status-item', ['Spaces: 4']);
		this.indentItem.title = 'Select Indentation';
		this.indentItem.addEventListener('click', () => this.onIndentClick?.());
		this.encodingItem = el('div', 'status-item', ['UTF-8']);
		this.encodingItem.title = 'Select Encoding';
		this.encodingItem.addEventListener('click', () => this.onEncodingClick?.());
		this.eolItem = el('div', 'status-item', ['LF']);
		this.eolItem.title = 'Select End of Line Sequence';
		this.eolItem.addEventListener('click', () => this.onEolClick?.());
		this.languageItem = el('div', 'status-item static');
		this.bellBadge = el('span', 'bell-badge');
		this.bellItem = el('div', 'status-item', [icon('bell'), this.bellBadge]);
		this.bellItem.title = 'Notifications';
		this.bellItem.hidden = true;
		this.bellItem.addEventListener('click', () => this.toggleCentre());
		// Extension items sit before the app's own right cluster (VS Code's placement).
		this.right.prepend(this.extRight);
		this.right.append(this.positionItem, this.indentItem, this.eolItem, this.encodingItem, this.languageItem, this.bellItem);
		this.centrePanel = el('div', 'notification-centre');
		this.centrePanel.hidden = true;
		document.body.appendChild(this.centrePanel);
		// The bell follows the centre in real time, and refreshes an open panel.
		onNotificationsChange((count) => {
			this.bellItem.hidden = count === 0 && !this.centreOpen;
			this.bellBadge.textContent = count > 0 ? String(count) : '';
			if (this.centreOpen) this.renderCentre();
		});
		document.addEventListener('click', (event) => {
			if (this.centreOpen && !this.centrePanel.contains(event.target as Node) && !this.bellItem.contains(event.target as Node)) {
				this.toggleCentre();
			}
		}, true);
		document.addEventListener(SETTINGS_EVENT, () => this.renderIndent(null));
		this.setEditor(null);
		this.setRepo(false);
	}

	/** The indent item: the tab-size setting when no editor overrides it. */
	private renderIndent(editorIndent: number | null): void {
		const size = editorIndent ?? settings.tabSize;
		this.indentItem.textContent = `Spaces: ${size}`;
		this.indentItem.title = `Select Indentation (tab size ${size})`;
	}

	private toggleCentre(): void {
		this.centreOpen = !this.centreOpen;
		this.centrePanel.hidden = !this.centreOpen;
		this.bellItem.hidden = !this.centreOpen && notificationEntries().length === 0;
		if (this.centreOpen) this.renderCentre();
	}

	/** The centre's list: every notification still recorded, newest first, each clearable. */
	private renderCentre(): void {
		const entries = notificationEntries();
		this.centrePanel.textContent = '';
		const header = el('div', 'notification-centre-header', [el('span', '', ['Notifications'])]);
		if (entries.length > 0) {
			const clear = el('button', 'button secondary', ['Clear All']);
			clear.addEventListener('click', () => clearAllNotifications());
			header.appendChild(clear);
		}
		this.centrePanel.appendChild(header);
		if (entries.length === 0) {
			this.centrePanel.appendChild(el('div', 'notification-centre-empty', ['No notifications']));
			return;
		}
		for (const entry of entries) this.centrePanel.appendChild(this.renderCentreRow(entry));
	}

	private renderCentreRow(entry: CentreEntry): HTMLElement {
		const row = el('div', 'notification-centre-row');
		row.appendChild(icon(entry.kind));
		row.appendChild(el('div', 'body', [
			el('div', 'message', [entry.message]),
			el('div', 'time', [ago(entry.at)])
		]));
		const clear = el('button', 'icon-button', [icon('close')]);
		clear.title = 'Clear Notification';
		clear.addEventListener('click', () => clearNotification(entry.id));
		row.appendChild(clear);
		return row;
	}

	/** Replace the extension-owned items (the extension host pushes the current set on every
	 *  change — create, field write, dispose). A click runs the item's declared command. */
	setExtensionItems(items: ExtensionStatusItem[]): void {
		this.extItems = items;
		this.renderExtensionItems();
	}

	private renderExtensionItems(): void {
		this.extLeft.replaceChildren();
		this.extRight.replaceChildren();
		// VS Code's order: a higher priority sits further left within its side; equal
		// priorities keep creation order (a stable sort).
		const ordered = this.extItems.map((item, index) => ({ item, index })).sort((a, b) => (b.item.priority ?? 0) - (a.item.priority ?? 0) || a.index - b.index);
		for (const { item } of ordered) {
			if (!item.visible || item.text === '') continue;
			// `$(icon)` references render as codicons, as VS Code's status bar does.
			const entry = el('div', 'status-item', labelWithIcons(item.text));
			if (item.tooltip) entry.title = item.tooltip;
			// The two background colours VS Code allows map onto theme classes; a foreground
			// is the extension's own colour (a literal, or a theme colour's variable).
			if (item.backgroundColor === 'statusBarItem.errorBackground') entry.classList.add('ext-status-error');
			else if (item.backgroundColor === 'statusBarItem.warningBackground') entry.classList.add('ext-status-warning');
			if (item.color) entry.style.color = /^[a-z]+(\.[A-Za-z]+)+$/.test(item.color) ? `var(--vscode-${item.color.replace(/\./g, '-')})` : item.color;
			if (item.command) {
				entry.classList.add('clickable');
				entry.addEventListener('click', () => this.onExtensionCommand?.(item.command!, item.commandArgs));
			}
			(item.alignment === 2 ? this.extRight : this.extLeft).appendChild(entry);
		}
	}

	/** Show (or, with null, hide) the symbol index state. */
	setSymbols(status: { state: string; done: number; total: number; files: number; symbols: number } | null): void {
		this.symbolsItem.hidden = status === null;
		if (status === null) return;
		this.symbolsItem.innerHTML = '';
		if (status.state === 'building') {
			this.symbolsItem.append(icon('sync', 'codicon-modifier-spin'), ` ${t('symbols.indexing')} ${status.done}/${status.total}`);
			tooltip(this.symbolsItem, () => `${t('symbols.indexing')} ${status.done}/${status.total}`);
		} else if (status.state === 'ready') {
			this.symbolsItem.append(icon('symbol-method'), ` ${status.symbols} ${t('symbols.ready')}`);
			tooltip(this.symbolsItem, () => `${status.symbols} ${t('symbols.ready')} - ${status.files}`);
		} else {
			this.symbolsItem.append(icon('symbol-method'), ` ${t('symbols.ready')}`);
			tooltip(this.symbolsItem, () => t('symbols.rebuild'));
		}
	}

	/** Show (or, with null, hide) the save progress. `total` 0 is the indeterminate pulse —
	 *  the save is running but the backend has not streamed a report yet (its tail is still
	 *  landing, or the document is a whole-file save the backend reports nothing about). */
	setSaveProgress(progress: { written: number; total: number } | null): void {
		this.saveItem.hidden = progress === null;
		if (progress === null) return;
		if (progress.total > 0) {
			const percent = Math.min(100, Math.floor((progress.written / progress.total) * 100));
			this.saveLabel.textContent = `${t('status.saving')} ${percent}%`;
			this.saveFill.style.width = `${percent}%`;
			this.saveFill.classList.remove('indeterminate');
		} else {
			this.saveLabel.textContent = t('status.saving');
			this.saveFill.classList.add('indeterminate');
			this.saveFill.style.width = '';
		}
		this.saveItem.title = t('status.saving');
	}

	setRepo(hasRepo: boolean): void {
		this.hasRepo = hasRepo;
		this.generation++; // a repo_head still in flight for the old folder is dropped
		this.repoItem.hidden = true;
		this.branchItem.hidden = !hasRepo;
		this.syncItem.hidden = true;
		this.symbolsItem.hidden = !hasRepo;
		document.body.classList.toggle('no-folder', !hasRepo);
		this.setConflicts(0);
		// No repo_head here: the Source Control view's refresh fetches it and feeds this bar
		// through applyHead, so a refresh cycle costs one subprocess instead of two. The bar
		// keeps its own refreshHead for cycles the SCM view is not part of.
	}

	/** Bumped by setRepo: a head request that started before a folder switch is dropped. */
	private generation = 0;

	/** Show (or hide, at zero) the unmerged-path count; a click opens Source Control. */
	setConflicts(count: number): void {
		this.conflictsItem.hidden = count === 0;
		if (count === 0) return;
		this.conflictsItem.innerHTML = '';
		this.conflictsItem.append(icon('warning'), ` ${count} conflict${count === 1 ? '' : 's'}`);
		this.conflictsItem.title = `${count} unmerged path${count === 1 ? '' : 's'} - open Source Control to resolve`;
	}

	async refreshHead(): Promise<void> {
		if (!this.hasRepo) return;
		const generation = this.generation;
		let head: HeadInfo;
		try {
			head = await invoke<HeadInfo>('repo_head');
		} catch {
			if (generation !== this.generation) return;
			this.repoItem.hidden = true;
			this.branchItem.hidden = true;
			this.syncItem.hidden = true;
			return;
		}
		if (generation !== this.generation) return; // the folder switched mid-flight
		this.applyHead(head);
	}

	/** Render a head the Source Control view already fetched - one `repo_head` per refresh
	 *  serves both views, where each used to run its own. The caller guards the folder
	 *  generation; only a closed repository is dropped here. */
	applyHead(head: HeadInfo): void {
		if (!this.hasRepo) return;
		// The repo item: the repository's folder name, its own button like the branch is.
		this.repoItem.hidden = !head.repo;
		this.repoItem.innerHTML = '';
		this.repoItem.append(icon('repo'), head.repo);
		this.repoItem.title = head.repo ? tf('status.repoTitle', head.repo) : '';
		this.branchItem.hidden = false;
		this.branchItem.innerHTML = '';
		this.branchItem.append(icon('source-control'), head.branch ?? head.shortHash);
		// The sync item carries both counts (VS Code puts them on the branch; one button per
		// action reads better), and appears only for a branch that tracks an upstream.
		if (head.upstream) {
			this.syncItem.hidden = false;
			this.syncItem.innerHTML = '';
			this.syncItem.append(icon('sync'), ` ${head.ahead}`, icon('arrow-up'), ` ${head.behind}`, icon('arrow-down'));
			this.syncItem.title = tf('status.syncTitle', head.behind, head.ahead, head.upstream);
		} else {
			this.syncItem.hidden = true;
		}
		this.branchItem.title = head.branch
			? `${head.branch}${head.upstream ? ` (tracking ${head.upstream})` : ''} - Checkout Branch/Tag...`
			: `Detached at ${head.shortHash} - Checkout Branch/Tag...`;
	}

	setEditor(editor: { kind: string; languageName?: string; encoding?: string; eol?: string; line: number; column: number; selected?: number; selections?: number } | null): void {
		const isText = editor !== null && (editor.kind === 'file' || editor.kind === 'diff');
		const isFile = editor !== null && editor.kind === 'file';
		this.positionItem.hidden = !isText;
		this.indentItem.hidden = !isText;
		this.encodingItem.hidden = !isFile;
		this.eolItem.hidden = !isFile;
		this.languageItem.hidden = !isText || !editor?.languageName;
		if (!editor || !isText) return;
		// VS Code's wording: "Ln 3, Col 5", "(12 selected)" with a selection, and the cursor
		// count in front once there is more than one.
		const selected = editor.selected ?? 0;
		const selections = editor.selections ?? 1;
		this.positionItem.textContent = selections > 1
			? `${selections} selections${selected > 0 ? ` (${selected} characters selected)` : ''}`
			: `Ln ${editor.line}, Col ${editor.column}${selected > 0 ? ` (${selected} selected)` : ''}`;
		this.renderIndent(null);
		this.languageItem.textContent = editor.languageName ?? '';
		this.encodingItem.textContent = ENCODING_LABELS[editor.encoding ?? 'utf8'] ?? editor.encoding ?? 'UTF-8';
		this.eolItem.textContent = editor.eol === 'crlf' ? 'CRLF' : 'LF';
	}
}
