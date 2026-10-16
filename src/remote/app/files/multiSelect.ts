// The files page's multi-select (docs/remote-client-plan.md §6.1): a long-press starts it
// with the pressed row; every row then carries a checkbox, the count bar replaces the
// toolbar (已选 N 项 + 全选 + 取消), and the bottom action bar offers the selection's
// verbs — download (a multi-selection packs ONE zip, §6.7), delete (a confirm, then the
// paths go), rename (single selection only, an inline edit in the row) and copy path.
// The list renders the marks: this module owns the STATE and the bars.
import { el, notify, confirmDialog } from '../../../platform/ui';
import { deletePath, renamePath } from '../../../platform/ipc/fs';
import { t, tf } from '../../../platform/i18n';
import { downloadManyTo, downloadTo } from '../../../features/explorer';

export interface MultiSelectHooks {
	/** Every visible row's path, in order — the select-all's set. */
	paths(): string[];
	/** The rows changed (selection marks): re-render them. */
	rerender(): void;
	/** The selection left (delete/rename changed the directory): the list reloads. */
	refresh(): void;
	/** A single selection's entry, for rename. */
	entryOf(path: string): { name: string; isDir: boolean } | null;
}

export function createMultiSelect(hooks: MultiSelectHooks) {
	const selected = new Set<string>();
	let active = false;
	/** The two bars; built once, shown while the selection is on. */
	const countBar = el('div', 'ggs-select-bar');
	const actionBar = el('div', 'ggs-select-actions');
	let countText = el('span', 'count');
	let renamed = false;

	function syncBars(): void {
		if (!active) {
			countBar.remove();
			actionBar.remove();
			return;
		}
		countText.textContent = tf('remote.files.selected', selected.size);
		countBar.replaceChildren(
			countText,
			barButton(t('remote.files.selectAll'), () => {
				for (const path of hooks.paths()) selected.add(path);
				hooks.rerender();
				syncBars();
			}),
			barButton(t('transfer.cancel'), () => clear())
		);
		const single = selected.size === 1 ? [...selected][0] : null;
		actionBar.replaceChildren(
			barButton(t('remote.files.download'), () => void download()),
			barButton(t('remote.files.delete'), () => void remove()),
			barButton(t('remote.files.rename'), () => single && void rename(single)),
			barButton(t('remote.files.copyPath'), () => void copyAll())
		);
		// Rename reads one selection only (§6.1): the button stays disabled otherwise.
		(actionBar.children[2] as HTMLButtonElement).disabled = single === null;
	}

	function barButton(label: string, onTap: () => void, extraClass = ''): HTMLButtonElement {
		const button = el('button', `ggs-select-btn ${extraClass}`, [label]);
		button.type = 'button';
		button.addEventListener('click', onTap);
		return button;
	}

	async function download(): Promise<void> {
		const paths = [...selected];
		if (paths.length === 0) return;
		if (paths.length === 1) await downloadTo(paths[0], hooks.entryOf(paths[0])?.isDir ?? false);
		else await downloadManyTo(paths);
	}

	async function remove(): Promise<void> {
		const paths = [...selected];
		if (paths.length === 0) return;
		// §12.3: a destructive act confirms once for the whole selection.
		const ok = await confirmDialog(tf('remote.files.deleteConfirm', paths.length), t('remote.files.delete'));
		if (!ok) return;
		const failed: string[] = [];
		for (const path of paths) {
			try {
				await deletePath(path, true);
			} catch {
				failed.push(path);
			}
		}
		if (failed.length > 0) notify('error', tf('remote.files.deleteFailed', failed.length));
		// Whatever the outcome, the directory changed when anything succeeded: reload so
		// the deleted rows leave the screen (the watcher's own refresh is suppressed while
		// a selection is on). The selection ends either way — a failed path simply reappears
		// in the reloaded list, unmarked, and the error toast named the count.
		clear();
		void hooks.refresh();
	}

	async function rename(path: string): Promise<void> {
		const entry = hooks.entryOf(path);
		if (!entry) return;
		const row = document.querySelector<HTMLElement>(`.ggs-file-row[data-path="${cssEscape(path)}"] .l1`);
		if (!row) return;
		const input = document.createElement('input');
		input.type = 'text';
		input.value = entry.name;
		input.className = 'ggs-rename-input';
		row.replaceChildren(input);
		input.focus();
		input.select();
		renamed = false;
		const commit = async () => {
			if (renamed) return;
			renamed = true;
			const next = input.value.trim();
			if (next && next !== entry.name) {
				const parent = path.slice(0, Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')));
				try {
					await renamePath(path, `${parent}/${next}`);
				} catch (error) {
					notify('error', String(error));
				}
			}
			clear();
			void hooks.refresh();
		};
		input.addEventListener('blur', () => void commit());
		input.addEventListener('keydown', (event) => {
			if (event.key === 'Enter') input.blur();
			if (event.key === 'Escape') {
				renamed = true;
				clear();
				void hooks.refresh();
			}
		});
	}

	async function copyAll(): Promise<void> {
		const text = [...selected].join('\n');
		try {
			await navigator.clipboard.writeText(text);
			notify('info', t('remote.files.pathCopied'));
		} catch {
			notify('error', t('remote.files.copyFailed'));
		}
	}

	function cssEscape(value: string): string {
		return (window.CSS && CSS.escape) ? CSS.escape(value) : value.replace(/"/g, '\\"');
	}

	function clear(): void {
		active = false;
		selected.clear();
		syncBars();
		hooks.rerender();
	}

	return {
		countBar,
		actionBar,
		active: () => active,
		isSelected: (path: string) => selected.has(path),
		/** The row menu's rename (§6.1): the same inline edit the action bar's button opens —
		 *  from the menu it runs with no selection active, and the commit's `clear()` is a
		 *  no-op there. */
		rename: (path: string) => void rename(path),
		toggle(path: string): void {
			if (selected.has(path)) selected.delete(path);
			else selected.add(path);
			syncBars();
			hooks.rerender();
		},
		/** The long-press entry (§6.1): the first starts the mode with this row selected;
		 *  later ones toggle their row. */
		longPress(path: string): void {
			if (!active) {
				active = true;
				selected.clear();
				selected.add(path);
				syncBars();
				hooks.rerender();
			} else this.toggle(path);
		}
	};
}
