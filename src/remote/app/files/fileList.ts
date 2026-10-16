// The files page's flat list (docs/remote-client-plan.md §6.1): ONE directory per screen,
// MT-manager style — folders first, big two-line rows (the name over the folder's item
// count and age, or the file's size and mtime), the git status letter at the right edge.
// The listing pages (`list_dir_page`, 200 a page) and a sentinel row loads the next page
// as it scrolls into view; `.git` never shows (the backend's listing excludes it), the
// hidden-files switch covers the other dotfiles; every directory's scroll position is
// remembered for the way back. Sorting (name / modified / size / type, folders always
// first) is applied over what is loaded — the backend's own order stays name-based.
import { el, icon, formatBytes } from '../../../platform/ui';
import { fileIcon, fileIconColor } from '../../../platform/fileIcons';
import { listDirPage, type DirEntryInfo } from '../../../platform/ipc/fs';
import { t, tf } from '../../../platform/i18n';

export const FILES_PAGE = 200;

export type SortKey = 'name' | 'modified' | 'size' | 'type';

export interface FilesSort {
	key: SortKey;
	asc: boolean;
	hidden: boolean;
}

export function defaultSort(): FilesSort {
	return { key: 'name', asc: true, hidden: false };
}

/** How the sort sheet labels each key (§6.1's four). */
export const SORT_KEYS: { key: SortKey; label: () => string }[] = [
	{ key: 'name', label: () => t('remote.files.sort.name') },
	{ key: 'modified', label: () => t('remote.files.sort.modified') },
	{ key: 'size', label: () => t('remote.files.sort.size') },
	{ key: 'type', label: () => t('remote.files.sort.type') }
];

export interface FileListHooks {
	/** A folder row was tapped: enter it. */
	enter(dir: string): void;
	/** A file row was tapped: open it in the editor page. */
	open(path: string): void;
	/** The git status letter of a path (M/U/A/D…), or null. */
	letter(path: string, isDir: boolean): string | null;
	/** The selection layer (multiSelect.ts): the long-press starts it, the checkboxes and
	 *  row marks read it. */
	selection: {
		active(): boolean;
		isSelected(path: string): boolean;
		/** A long-press landed on a row. */
		longPress(path: string): void;
		toggle(path: string): void;
	};
	/** The current filter text (the toolbar's search box), or ''. */
	filter(): string;
}

/** The list. `show(dir)` loads and renders; a same-dir `show` is a refresh. */
export function createFileList(hooks: FileListHooks) {
	const root = el('div', 'ggs-file-list');
	root.setAttribute('role', 'list');
	const sentinel = el('div', 'ggs-file-sentinel');
	/** What is loaded of the current directory, and its unfiltered total. */
	let entries: DirEntryInfo[] = [];
	let total = 0;
	let dir = '';
	/** A listing that started before a directory switch is dropped. */
	let generation = 0;
	let sort = defaultSort();
	/** The scroll top each directory left (§6.1: the way back restores it). */
	const scrollMemory = new Map<string, number>();
	const scroller = () => root.closest('.ggs-files-scroll') ?? root;

	const observer = typeof IntersectionObserver !== 'undefined'
		? new IntersectionObserver((seen) => {
				if (seen.some((item) => item.isIntersecting)) void loadMore();
			}, { root: null, rootMargin: '160px' })
		: null;

	async function loadPage(path: string, offset: number, mine: number, limit = FILES_PAGE): Promise<void> {
		const page = await listDirPage(path, offset, limit);
		if (mine !== generation) return;
		total = page.total;
		if (offset === 0) entries = page.entries;
		else entries = entries.concat(page.entries);
		render();
		if (path === dir && offset > 0) {
			// A continuation keeps its place: the rows above must not jump.
			const before = scrollMemory.get(dir) ?? 0;
			if (before > 0) scroller().scrollTop = before;
		}
	}

	async function loadMore(): Promise<void> {
		if (!dir || entries.length >= total) return;
		const mine = generation;
		try {
			await loadPage(dir, entries.length, mine);
		} catch {
			/* the sentinel will fire again on the next scroll */
		}
	}

	/** The entries as the current sort and filter leave them. */
	function visible(): DirEntryInfo[] {
		const query = hooks.filter().toLowerCase();
		let list = entries.filter((entry) => (sort.hidden || !entry.name.startsWith('.')) && (!query || entry.name.toLowerCase().includes(query)));
		const direction = sort.asc ? 1 : -1;
		const keyOf = (entry: DirEntryInfo): string | number => {
			if (sort.key === 'modified') return entry.modified ?? 0;
			if (sort.key === 'size') return entry.size;
			if (sort.key === 'type') return extensionOf(entry.name);
			return entry.name.toLowerCase();
		};
		list = [...list].sort((a, b) => {
			if (a.isDir !== b.isDir) return a.isDir ? -1 : 1; // folders always first
			const left = keyOf(a);
			const right = keyOf(b);
			const compared = typeof left === 'number' && typeof right === 'number'
				? left - right
				: String(left).localeCompare(String(right));
			return compared * direction;
		});
		return list;
	}

	/** §6.1's middle ellipsis: a long name keeps its head and its tail, extension inside
	 *  (`very-long-na…me.ts`). */
	function displayName(name: string): string {
		if (name.length <= 28) return name;
		return `${name.slice(0, 19)}…${name.slice(-8)}`;
	}

	function secondLine(entry: DirEntryInfo): string {
		if (entry.isDir) {
			const count = entry.children === undefined ? '' : tf('remote.files.itemCount', entry.children);
			const when = entry.modified === undefined ? '' : relativeTime(entry.modified);
			return [count, when].filter(Boolean).join(' · ');
		}
		const when = entry.modified === undefined ? '' : shortDateTime(entry.modified);
		return [formatBytes(entry.size, { trim: true }), when].filter(Boolean).join(' · ');
	}

	function row(entry: DirEntryInfo): HTMLElement {
		const node = el('div', 'ggs-file-row');
		node.dataset.path = entry.path;
		node.dataset.dir = entry.isDir ? '1' : '';
		node.setAttribute('role', 'listitem');
		const check = el('span', 'check');
		const box = document.createElement('input');
		box.type = 'checkbox';
		box.tabIndex = -1;
		check.appendChild(box);
		const glyph = icon(entry.isDir ? 'folder' : fileIcon(entry.name));
		if (!entry.isDir) glyph.style.color = fileIconColor(entry.name) ?? '';
		const lines = el('div', 'lines', [
			el('div', 'l1', [displayName(entry.name)]),
			el('div', 'l2', [secondLine(entry)])
		]);
		node.title = `${entry.name}\n${entry.path}`;
		node.append(check, el('span', 'row-icon', [glyph]), lines);
		const letter = hooks.letter(entry.path, entry.isDir);
		if (letter) node.appendChild(el('span', `status ${letterClass(letter)}`, [letter]));
		if (entry.isDir) node.appendChild(el('span', 'chev', ['›']));
		if (hooks.selection.active()) {
			node.classList.add('selectable');
			box.checked = hooks.selection.isSelected(entry.path);
		}
		node.addEventListener('click', (event) => {
			if (hooks.selection.active()) {
				if (event.target !== box) hooks.selection.toggle(entry.path);
				return;
			}
			if (entry.isDir) hooks.enter(entry.path);
			else hooks.open(entry.path);
		});
		installRowLongPress(node, entry.path);
		return node;
	}

	/** §6.1's long-press (450 ms, 10 px tolerance — gestures.ts's own recipe, kept local so
	 *  the row's click never races the selection entry): the first long-press starts the
	 *  selection with this row; later ones toggle. */
	function installRowLongPress(node: HTMLElement, path: string): void {
		let timer: number | null = null;
		let start: { x: number; y: number } | null = null;
		const clear = () => {
			if (timer !== null) window.clearTimeout(timer);
			timer = null;
			start = null;
		};
		node.addEventListener('pointerdown', (event) => {
			if (event.pointerType === 'mouse') return; // a mouse right-clicks (the sheet)
			start = { x: event.clientX, y: event.clientY };
			timer = window.setTimeout(() => {
				timer = null;
				navigator.vibrate?.(10);
				hooks.selection.longPress(path);
			}, 450);
		});
		node.addEventListener('pointermove', (event) => {
			if (!start) return;
			if (Math.abs(event.clientX - start.x) > 10 || Math.abs(event.clientY - start.y) > 10) clear();
		});
		node.addEventListener('pointerup', clear);
		node.addEventListener('pointercancel', clear);
	}

	function render(): void {
		const list = visible();
		root.replaceChildren(...list.map(row));
		if (entries.length < total) {
			sentinel.replaceChildren(el('span', 'hint', [tf('remote.files.moreLoaded', entries.length, total)]));
			root.appendChild(sentinel);
			observer?.observe(sentinel);
		} else {
			observer?.unobserve(sentinel);
			if (list.length === 0) root.appendChild(el('div', 'ggs-file-empty', [t('remote.files.empty')]));
		}
	}

	return {
		root,
		get dir() {
			return dir;
		},
		get sort() {
			return sort;
		},
		setSort(next: FilesSort): void {
			sort = next;
			render();
		},
		get entries() {
			return entries;
		},
		visible,
		render,
		async show(path: string): Promise<void> {
			if (path === dir) {
				await this.refresh();
				return;
			}
			scrollMemory.set(dir, scroller().scrollTop);
			dir = path;
			entries = [];
			total = 0;
			generation++;
			render();
			const mine = generation;
			try {
				await loadPage(path, 0, mine);
			} catch (error) {
				if (mine === generation) root.replaceChildren(el('div', 'ggs-file-empty', [String(error)]));
				return;
			}
			if (mine !== generation) return;
			scroller().scrollTop = scrollMemory.get(path) ?? 0;
		},
		async refresh(): Promise<void> {
			const mine = ++generation;
			scrollMemory.set(dir, scroller().scrollTop);
			try {
				await loadPage(dir, 0, mine, Math.max(FILES_PAGE, entries.length));
			} catch {
				/* leave the rows as they are */
			}
			if (mine === generation) scroller().scrollTop = scrollMemory.get(dir) ?? 0;
		}
	};
}

function extensionOf(name: string): string {
	const dot = name.lastIndexOf('.');
	return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
}

/** The status letter's theme colour class (M/U/A/D map onto gitDecoration.*). */
function letterClass(letter: string): string {
	if (letter.startsWith('M') || letter.startsWith('m')) return 'mod';
	if (letter.startsWith('A') || letter.startsWith('+')) return 'add';
	if (letter.startsWith('D')) return 'del';
	if (letter.startsWith('U') || letter.startsWith('?')) return 'untracked';
	return 'mod';
}

/** "刚刚 · 5 分钟前 · 3 天前", the date itself past a week (§6.1's second line). */
export function relativeTime(seconds: number): string {
	const delta = Math.max(0, Date.now() / 1000 - seconds);
	if (delta < 60) return t('remote.files.time.now');
	if (delta < 3600) return tf('remote.files.time.min', Math.floor(delta / 60));
	if (delta < 86400) return tf('remote.files.time.hour', Math.floor(delta / 3600));
	if (delta < 7 * 86400) return tf('remote.files.time.day', Math.floor(delta / 86400));
	return shortDateTime(seconds);
}

/** `10-14 18:20` — the plan's own row example. */
export function shortDateTime(seconds: number): string {
	const date = new Date(seconds * 1000);
	const two = (n: number) => String(n).padStart(2, '0');
	return `${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
}
