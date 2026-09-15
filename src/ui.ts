// Small DOM building blocks shared by every part of the workbench: element construction,
// codicons, notifications (VS Code's toasts), context menus, and the quick-input prompt.

import { trText } from './i18n';

export function el<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	className?: string,
	children: (Node | string | null | undefined)[] = []
): HTMLElementTagNameMap[K] {
	const element = document.createElement(tag);
	if (className) element.className = className;
	for (const child of children) {
		if (child === null || child === undefined) continue;
		element.append(child);
	}
	return element;
}

/** A codicon glyph (`@vscode/codicons`), the icon font VS Code itself draws with. */
export function icon(name: string, className = ''): HTMLElement {
	return el('span', `codicon codicon-${name}${className ? ' ' + className : ''}`);
}

/** A 22px toolbar button: a codicon with a title, as VS Code's view title actions. */
export function actionButton(iconName: string, title: string, onClick: (event: MouseEvent) => void): HTMLButtonElement {
	const button = el('button', 'action-btn', [icon(iconName)]);
	button.title = title;
	button.setAttribute('aria-label', title);
	button.addEventListener('click', (event) => {
		event.stopPropagation();
		onClick(event);
	});
	return button;
}

export function escapeHtml(text: string): string {
	return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

export function basename(path: string): string {
	const normalised = path.replace(/[\\/]+$/, '');
	const index = Math.max(normalised.lastIndexOf('/'), normalised.lastIndexOf('\\'));
	return index === -1 ? normalised : normalised.slice(index + 1);
}

export function dirname(path: string): string {
	const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
	return index === -1 ? '' : path.slice(0, index);
}

export function joinPath(base: string, name: string): string {
	const separator = base.includes('\\') && !base.includes('/') ? '\\' : '/';
	return base.replace(/[\\/]+$/, '') + separator + name;
}

/** Forward slashes, as git and the graph view spell paths. */
export function toPosix(path: string): string {
	return path.replaceAll('\\', '/');
}

/** `path` relative to `root` (both spelled either way), or `path` itself when outside. */
export function relativeTo(root: string, path: string): string {
	const normalisedRoot = toPosix(root).replace(/\/$/, '');
	const normalisedPath = toPosix(path);
	if (normalisedPath === normalisedRoot) return '';
	return normalisedPath.startsWith(normalisedRoot + '/') ? normalisedPath.slice(normalisedRoot.length + 1) : normalisedPath;
}

/* ---------- Notifications ---------- */

export type NotificationKind = 'info' | 'warning' | 'error';

export interface NotificationAction {
	label: string;
	run: () => void;
}

/** One entry of the notification centre: what was shown, when, and whether it still has its
 *  toast on screen (an auto-dismissed info toast lives on in the centre). */
export interface CentreEntry {
	id: number;
	kind: NotificationKind;
	message: string;
	at: number;
}

const centre: CentreEntry[] = [];
let centreSeq = 1;
const centreListeners = new Set<(count: number) => void>();

/** React to the centre's size changing (the status bar's bell badge). */
export function onNotificationsChange(listener: (count: number) => void): () => void {
	centreListeners.add(listener);
	return () => centreListeners.delete(listener);
}

export function notificationEntries(): CentreEntry[] {
	return [...centre].reverse(); // newest first
}

export function clearNotification(id: number): void {
	const at = centre.findIndex((entry) => entry.id === id);
	if (at !== -1) centre.splice(at, 1);
	for (const listener of centreListeners) listener(centre.length);
}

export function clearAllNotifications(): void {
	centre.length = 0;
	for (const listener of centreListeners) listener(centre.length);
}

/** Post a toast. `onDismiss` runs whenever the toast goes away - the close button, an action
 *  button, or the auto-timeout - so callers can treat "dismissed without choosing" as cancel.
 *  The notification also joins the centre, where it stays until cleared. */
export function notify(kind: NotificationKind, message: string, actions: NotificationAction[] = [], onDismiss?: () => void): void {
	centre.push({ id: centreSeq++, kind, message, at: Date.now() });
	if (centre.length > 100) centre.shift(); // bounded, like the session log
	for (const listener of centreListeners) listener(centre.length);
	const container = document.getElementById('notifications')!;
	const body = el('div', 'message', [message]);
	const toast = el('div', 'notification', [icon(kind), el('div', 'body', [body])]);
	const close = actionButton('close', 'Clear Notification', () => dismiss());
	toast.appendChild(close);
	if (actions.length > 0) {
		const buttons = el('div', 'buttons');
		for (const action of actions) {
			const button = el('button', 'button', [action.label]);
			button.addEventListener('click', () => {
				action.run();
				dismiss();
			});
			buttons.appendChild(button);
		}
		toast.querySelector('.body')!.appendChild(buttons);
	}
	toast.querySelector<HTMLElement>('.body')!.style.flex = '1';
	toast.querySelector<HTMLElement>('.body')!.style.minWidth = '0';
	container.appendChild(toast);
	let timer: number | null = kind === 'info' && actions.length === 0 ? window.setTimeout(() => dismiss(), 8000) : null;
	function dismiss(): void {
		if (timer !== null) window.clearTimeout(timer);
		timer = null;
		toast.remove();
		onDismiss?.();
	}
	// Keep an info toast while the pointer is over it, then resume the auto-dismiss countdown.
	toast.addEventListener('mouseenter', () => {
		if (timer !== null) window.clearTimeout(timer);
		timer = null;
	});
	toast.addEventListener('mouseleave', () => {
		if (timer === null && kind === 'info' && actions.length === 0) {
			timer = window.setTimeout(() => dismiss(), 8000);
		}
	});
}

/* ---------- Menus (context menus, the title bar's menus, the "..." menus) ---------- */

export interface MenuItem {
	label: string;
	keybinding?: string;
	disabled?: boolean;
	checked?: boolean;
	submenu?: MenuEntry[];
	run?: () => void;
}
export type MenuEntry = MenuItem | 'separator';

const openMenus: HTMLElement[] = [];

export function closeContextMenu(): void {
	for (const menu of openMenus.splice(0)) menu.remove();
	document.querySelector('.menubar-item.open')?.classList.remove('open');
}

export function isMenuOpen(): boolean {
	return openMenus.length > 0;
}

/** Render one menu level at a position; submenus open to the right of their item on hover. */
function renderMenu(x: number, y: number, entries: MenuEntry[], level: number, minWidth: number): HTMLElement {
	const menu = el('div', 'context-menu');
	menu.setAttribute('role', 'menu');
	menu.style.minWidth = `${minWidth}px`;
	let openSubmenu: HTMLElement | null = null;
	const closeSubmenu = () => {
		if (openSubmenu) {
			const index = openMenus.indexOf(openSubmenu);
			if (index !== -1) openMenus.splice(index).forEach((m) => m.remove());
			openSubmenu = null;
		}
	};
	for (const entry of entries) {
		if (entry === 'separator') {
			menu.appendChild(el('div', 'separator'));
			continue;
		}
		const item = el('div', 'item' + (entry.disabled ? ' disabled' : ''), [
			el('span', 'check', [entry.checked ? icon('check') : null]),
			// Labels arrive as the registry's English text whatever built them - the title bar's
			// commands, a view's "..." entries, an extension's contribution - and localize here,
			// the one place every menu (and submenu) level renders through.
			el('span', 'label', [trText(entry.label)])
		]);
		item.setAttribute('role', 'menuitem');
		// The pointer and the arrow keys share one focus ring per menu level.
		item.addEventListener('mouseenter', () => {
			for (const other of menu.querySelectorAll('.item.focused')) other.classList.remove('focused');
			if (!entry.disabled) item.classList.add('focused');
		});
		if (entry.submenu) {
			item.appendChild(icon('chevron-right', 'submenu-indicator'));
			item.addEventListener('mouseenter', () => {
				closeSubmenu();
				const rect = item.getBoundingClientRect();
				openSubmenu = renderMenu(rect.right - 4, rect.top - 5, entry.submenu!, level + 1, 180);
			});
			item.addEventListener('click', (event) => event.stopPropagation());
		} else {
			if (entry.keybinding) item.appendChild(el('span', 'keybinding', [entry.keybinding]));
			item.addEventListener('mouseenter', closeSubmenu);
			item.addEventListener('click', (event) => {
				event.stopPropagation();
				closeContextMenu();
				entry.run?.();
			});
		}
		menu.appendChild(item);
	}
	document.getElementById('overlays')!.appendChild(menu);
	openMenus.push(menu);
	// Keep the menu on screen; a submenu that does not fit to the right opens to the left.
	const rect = menu.getBoundingClientRect();
	let left = x;
	if (left + rect.width > window.innerWidth - 4) left = level > 0 ? Math.max(4, x - rect.width - 180 + 8) : Math.max(4, window.innerWidth - rect.width - 4);
	menu.style.left = `${left}px`;
	menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - rect.height - 4))}px`;
	return menu;
}

export function showContextMenu(x: number, y: number, entries: MenuEntry[]): void {
	closeContextMenu();
	renderMenu(x, y, entries, 0, 180);
}

/** A menu dropped below an element (a title-bar menu, a "..." button). */
export function showMenuBelow(anchor: HTMLElement, entries: MenuEntry[], minWidth = 200): void {
	closeContextMenu();
	const rect = anchor.getBoundingClientRect();
	renderMenu(rect.left, rect.bottom, entries, 0, minWidth);
}

document.addEventListener('mousedown', (event) => {
	if (openMenus.length > 0 && !openMenus.some((menu) => menu.contains(event.target as Node)) && !(event.target as HTMLElement).closest('.menubar-item')) closeContextMenu();
});
/** VS Code's menu keyboard: Up/Down walk the enabled items of the innermost open menu (with
 *  wrap-around), Enter runs the focused one (or opens its submenu), Right opens a submenu,
 *  Left closes it, Escape closes everything. */
document.addEventListener('keydown', (event) => {
	if (openMenus.length === 0) return;
	if (event.key === 'Escape') {
		closeContextMenu();
		return;
	}
	const menu = openMenus[openMenus.length - 1]!;
	const items = Array.from(menu.querySelectorAll<HTMLElement>('.item:not(.disabled)'));
	if (items.length === 0) return;
	const current = items.findIndex((item) => item.classList.contains('focused'));
	const focus = (index: number) => {
		items.forEach((item, i) => item.classList.toggle('focused', i === index));
		items[index]?.scrollIntoView({ block: 'nearest' });
	};
	switch (event.key) {
		case 'ArrowDown':
			event.preventDefault();
			focus((current + 1) % items.length);
			break;
		case 'ArrowUp':
			event.preventDefault();
			focus((current - 1 + items.length) % items.length);
			break;
		case 'ArrowRight':
			if (current !== -1 && items[current]!.querySelector('.submenu-indicator')) {
				event.preventDefault();
				items[current]!.dispatchEvent(new MouseEvent('mouseenter'));
				const opened = openMenus[openMenus.length - 1];
				if (opened && opened !== menu) opened.querySelector<HTMLElement>('.item:not(.disabled)')?.classList.add('focused');
			}
			break;
		case 'ArrowLeft':
			if (openMenus.length > 1) {
				event.preventDefault();
				openMenus.pop()!.remove();
			}
			break;
		case 'Enter':
		case ' ':
			if (current !== -1) {
				event.preventDefault();
				const item = items[current]!;
				if (item.querySelector('.submenu-indicator')) item.dispatchEvent(new MouseEvent('mouseenter'));
				else item.click();
			}
			break;
	}
}, true);
window.addEventListener('blur', closeContextMenu);

/* ---------- Quick input ---------- */

export interface QuickPickItem {
	label: string;
	description?: string;
	detail?: string;
	icon?: string;
	value: string;
	/** Matched-character ranges in the label (rendered bold), as the fuzzy scorer reports them. */
	highlights?: [number, number][];
}

/** A large-list item source that filters off the keystroke path, as VS Code's quick access
 *  does: the scan runs in chunks, between which the input stays responsive; intermediate top
 *  rows arrive through `onPartial`; `isCancelled` aborts a scan a newer keystroke superseded. */
export interface QuickPickSource {
	query(query: string, onPartial: (items: QuickPickItem[]) => void, isCancelled: () => boolean): Promise<QuickPickItem[]>;
	/** Shown instead of the empty state while the source has nothing to show yet. */
	status?(): string | null;
}

export interface QuickInputOptions {
	title?: string;
	placeholder?: string;
	value?: string;
	/** The characters of `value` initially selected (a file name without its extension). */
	selection?: [number, number];
	validate?: (value: string) => string | null;
	/** A pick list: static, computed from what is typed, or a chunked QuickPickSource (Quick
	 *  Open's file list) whose results fill in progressively while the scan runs. */
	items?: QuickPickItem[] | ((query: string) => QuickPickItem[]) | QuickPickSource;
	/** With a pick list: Enter on free text (no match) resolves with the text itself. */
	allowFreeText?: boolean;
}

const MAX_PICK_ROWS = 60;

function isQuickPickSource(items: QuickPickItem[] | ((query: string) => QuickPickItem[]) | QuickPickSource): items is QuickPickSource {
	return typeof items === 'object' && items !== null && 'query' in items;
}

/** The label with its matched ranges bolded, as VS Code highlights picker matches. */
function applyLabelHighlights(parent: HTMLElement, label: string, ranges?: [number, number][]): void {
	parent.textContent = '';
	if (!ranges || ranges.length === 0) {
		parent.textContent = label;
		return;
	}
	let at = 0;
	for (const [start, end] of ranges) {
		if (start > at) parent.appendChild(document.createTextNode(label.slice(at, start)));
		parent.appendChild(el('b', '', [label.slice(start, end)]));
		at = end;
	}
	if (at < label.length) parent.appendChild(document.createTextNode(label.slice(at)));
}

/** Case-insensitive "every query word appears" match, as VS Code's quick pick filters. */
export function matchesQuery(text: string, query: string): boolean {
	const haystack = text.toLowerCase();
	return query.toLowerCase().split(/\s+/).filter((w) => w !== '').every((word) => haystack.includes(word));
}

/** VS Code's quick input at the top of the window: an input box, or a filterable pick list.
 *  Resolves with the value (a pick's `value`, or the typed text), or null on Escape. */
export function quickInput(options: QuickInputOptions): Promise<string | null> {
	return new Promise((resolve) => {
		const box = el('div', 'quick-input');
		const input = el('input', 'input');
		input.type = 'text';
		input.placeholder = options.placeholder ?? '';
		input.value = options.value ?? '';
		input.spellcheck = false;
		input.setAttribute('aria-label', options.title ?? options.placeholder ?? 'Input');
		const hint = el('div', 'hint');
		if (options.title) box.appendChild(el('div', 'title', [options.title]));
		box.appendChild(input);
		box.appendChild(hint);
		const list = options.items ? el('div', 'list') : null;
		if (list) box.appendChild(list);
		document.getElementById('overlays')!.appendChild(box);
		let focused = 0;
		let rows: { element: HTMLElement; item: QuickPickItem }[] = [];

		const finish = (value: string | null) => {
			generation += 1; // cancels any source scan still streaming into the list
			box.remove();
			document.removeEventListener('mousedown', onOutside, true);
			resolve(value);
		};
		const onOutside = (event: MouseEvent) => {
			if (!box.contains(event.target as Node)) finish(null);
		};
		document.addEventListener('mousedown', onOutside, true);

		// Row application is incremental: a row whose pick kept its value keeps its element and
		// only has its highlights refreshed, so progressive scans do not rebuild the list. The
		// generation counter cancels source scans a newer keystroke superseded.
		let generation = 0;
		let searching = false;
		let emptyState: HTMLElement | null = null;

		const emptyText = () => {
			if (searching) {
				const items = options.items;
				const status = items && isQuickPickSource(items) ? items.status?.() : null;
				return status ?? 'Searching…';
			}
			return input.value.trim() === '' ? 'No results' : 'No matching results';
		};

		const applyRows = (items: QuickPickItem[]) => {
			if (!list) return;
			emptyState?.remove();
			emptyState = null;
			for (let i = 0; i < items.length; i++) {
				const item = items[i]!;
				const existing = rows[i];
				if (existing && existing.item.value === item.value) {
					existing.item = item;
					applyLabelHighlights(existing.element.querySelector<HTMLElement>('.label')!, item.label, item.highlights);
				} else {
					const row = el('div', 'row', [
						item.icon ? icon(item.icon) : null,
						el('span', 'label'),
						item.description ? el('span', 'description', [item.description]) : null,
						item.detail ? el('span', 'decoration', [item.detail]) : null
					]);
					applyLabelHighlights(row.querySelector<HTMLElement>('.label')!, item.label, item.highlights);
					row.addEventListener('click', () => finish(item.value));
					if (existing) existing.element.replaceWith(row);
					else list.appendChild(row);
					rows[i] = { element: row, item };
				}
			}
			for (let i = rows.length - 1; i >= items.length; i--) rows[i]!.element.remove();
			rows.length = items.length;
			if (rows.length === 0) {
				emptyState = el('div', 'scm-empty', [emptyText()]);
				list.appendChild(emptyState);
			}
			focused = Math.min(focused, Math.max(0, rows.length - 1));
			highlight();
		};

		const runSource = async (source: QuickPickSource, query: string): Promise<void> => {
			const id = generation;
			try {
				const items = await source.query(
					query,
					(partial) => {
						if (id === generation) applyRows(partial);
					},
					() => id !== generation
				);
				if (id !== generation) return; // a newer keystroke superseded this scan
				searching = false;
				applyRows(items);
			} catch (error) {
				if (id !== generation) return;
				// A failed scan still settles the "Searching…" state; its rows are simply empty.
				searching = false;
				console.warn('quick input source failed', error);
				applyRows([]);
			}
		};

		const renderList = () => {
			if (!list || !options.items) return;
			generation += 1;
			focused = 0;
			if (isQuickPickSource(options.items)) {
				searching = true;
				if (rows.length === 0) {
					emptyState?.remove();
					emptyState = el('div', 'scm-empty', [emptyText()]);
					list.appendChild(emptyState);
				}
				void runSource(options.items, input.value.trim());
				return;
			}
			searching = false;
			const query = input.value.trim();
			const source = typeof options.items === 'function' ? options.items(query) : options.items.filter((item) => matchesQuery(item.label + ' ' + (item.description ?? ''), query));
			applyRows(source.slice(0, MAX_PICK_ROWS));
		};
		const highlight = () => {
			rows.forEach((row, index) => row.element.classList.toggle('focused', index === focused));
			rows[focused]?.element.scrollIntoView({ block: 'nearest' });
		};
		const validate = () => {
			const error = options.validate ? options.validate(input.value) : null;
			hint.textContent = error ?? '';
			hint.classList.toggle('error', error !== null);
			return error === null;
		};
		input.addEventListener('input', () => {
			validate();
			renderList();
		});
		input.addEventListener('keydown', (event) => {
			event.stopPropagation();
			if (event.key === 'Enter') {
				event.preventDefault();
				if (list) {
					const pick = rows[focused];
					if (pick) finish(pick.item.value);
					else if (options.allowFreeText && input.value.trim() !== '' && validate()) finish(input.value.trim());
					return;
				}
				if (validate()) finish(input.value);
			} else if (event.key === 'Escape') {
				event.preventDefault();
				finish(null);
			} else if (list && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
				event.preventDefault();
				if (rows.length === 0) return;
				focused = (focused + (event.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length;
				highlight();
			}
		});
		renderList();
		input.focus();
		if (options.selection) {
			input.setSelectionRange(options.selection[0], options.selection[1]);
		} else {
			input.select();
		}
	});
}

/** A pick list (branches, remotes, stashes, …); resolves with the chosen value or null. */
export function quickPick(items: QuickPickItem[], placeholder: string, title?: string): Promise<string | null> {
	return quickInput({ items, placeholder, title });
}

/** A modal confirmation, drawn as a notification with buttons; resolves with the chosen label. */
export function confirmDialog(message: string, primary: string, kind: NotificationKind = 'warning'): Promise<boolean> {
	return new Promise((resolve) => {
		let settled = false;
		const settle = (value: boolean) => {
			if (!settled) {
				settled = true;
				resolve(value);
			}
		};
		// The toast's own close button (or any other dismissal) also cancels.
		notify(kind, message, [
			{ label: primary, run: () => settle(true) },
			{ label: 'Cancel', run: () => settle(false) }
		], () => settle(false));
	});
}
