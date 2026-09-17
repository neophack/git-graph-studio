// The status bar, VS Code's layout (M3 3.11 / 3.12): on the left the repository's name, the
// checked-out branch and the "Synchronize Changes" item - three buttons of its own, not one
// block - then the "Git Graph" item, the conflict count, the symbol index state and the save
// progress; on the right the cursor position, the indent, the encoding, the line endings,
// the language, and the notification bell (which opens the notification centre - every toast
// ever shown stays listed there until cleared).

import { invoke } from '@tauri-apps/api/core';

import { ENCODING_LABELS } from './editor';
import { t, tf } from './i18n';
import { SETTINGS_EVENT, settings } from './settings';
import { clearAllNotifications, clearNotification, el, icon, notificationEntries, onNotificationsChange, tooltip, type CentreEntry } from './ui';

/** How long ago an entry landed, in VS Code's wording ("just now", "5m ago"). */
function ago(at: number): string {
	const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
	if (seconds < 50) return 'just now';
	if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
	if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
	return `${Math.round(seconds / 86400)}d ago`;
}

interface HeadInfo {
	repo: string;
	branch: string | null;
	shortHash: string;
	ahead: number;
	behind: number;
	upstream: string | null;
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
	private readonly graphItem: HTMLElement;
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

	onRepoClick: (() => void) | null = null;
	onBranchClick: (() => void) | null = null;
	onSyncClick: (() => void) | null = null;
	onGraphClick: (() => void) | null = null;
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
		this.graphItem = el('div', 'status-item', [(() => { const image = el('img'); image.src = '/icons/git-graph-16.svg'; image.alt = ''; return image; })(), 'Git Graph']);
		this.graphItem.title = 'View Git Graph';
		this.graphItem.addEventListener('click', () => this.onGraphClick?.());
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
		this.left.append(this.repoItem, this.branchItem, this.syncItem, this.graphItem, this.conflictsItem, this.symbolsItem, this.saveItem);

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
		this.graphItem.hidden = !hasRepo;
		this.symbolsItem.hidden = !hasRepo;
		document.body.classList.toggle('no-folder', !hasRepo);
		this.setConflicts(0);
		if (hasRepo) void this.refreshHead();
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
