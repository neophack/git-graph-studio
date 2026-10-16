// The files page (docs/remote-client-plan.md §6.1, P1): the page-stack shells' Files
// destination — the MT-manager flat list, its path bar, its toolbar (the filter box and
// the sort sheet), the multi-select bars and the floating action button (upload, new
// file, new folder), mounted INTO the explorer's sidebar view: on a page-stack shell the
// tree hides and this page shows; on the wide forms (tablet landscape, desktop) the tree
// shows and this page hides — the classic explorer stays theirs (§6.1's own desktop
// paragraph). The current directory refreshes when the watcher reports a change under it.
//
// The git letters ride the same status feed the explorer rides (the SCM view's onStatus,
// chained here — one callback, wrapped) and the file opens go through the same
// workbench.openFile the explorer's rows reach.
import { el, icon, notify, relativeTo } from '../../../platform/ui';
import { t } from '../../../platform/i18n';
import { createFile, createFolder, type DirEntryInfo } from '../../../platform/ipc/fs';
import { currentWorkbench, type FsChange } from '../../../workbench';
import { uploadInto } from '../../../features/explorer';
import { withinRoots } from '../../pathGate';
import { openSheet, showActionSheet, closeActionSheet } from '../../actionSheet';
import type { MenuEntry } from '../../../platform/ui';
import { createFileList, SORT_KEYS, defaultSort, type FilesSort } from './fileList';
import { createPathBar } from './pathBar';
import { createMultiSelect } from './multiSelect';

const SORT_STORE = 'remote.files.sort';

function loadSort(): FilesSort {
	try {
		const raw = localStorage.getItem(SORT_STORE);
		if (!raw) return defaultSort();
		const parsed = JSON.parse(raw) as Partial<FilesSort>;
		const key = SORT_KEYS.find((entry) => entry.key === parsed.key)?.key;
		return { key: key ?? 'name', asc: parsed.asc !== false, hidden: parsed.hidden === true };
	} catch {
		return defaultSort();
	}
}

/** Mount the files page into the explorer's sidebar view (idempotent). */
export function installFilesPage(): void {
	const workbench = currentWorkbench;
	const view = workbench?.views.explorer;
	if (!workbench || !view || view.querySelector('.ggs-files-page')) return;
	view.classList.add('ggs-files-host');
	const workspaceRoot = () => workbench.openFolders()[0] ?? '';

	/** The git status feed (the SCM view's own keying, repo-relative), chained onto the
	 *  explorer's — the letters stay honest in both surfaces. */
	let status = new Map<string, string>();
	const previous = workbench.scm.onStatus;
	workbench.scm.onStatus = (next) => {
		previous?.(next);
		status = next;
		list.render();
	};

	const page = el('div', 'ggs-files-page');
	const scroll = el('div', 'ggs-files-scroll');
	let dir = workspaceRoot();
	let filterText = '';

	const list = createFileList({
		enter: (next) => void show(next),
		open: (path) => void workbench.editors.openFile(path),
		letter: (path) => {
			const root = workbench.repoPath ?? workspaceRoot();
			if (!root) return null;
			return status.get(relativeTo(root, path)) ?? null;
		},
		selection: {
			active: () => select.active(),
			isSelected: (path) => select.isSelected(path),
			longPress: (path) => select.longPress(path),
			toggle: (path) => select.toggle(path)
		},
		filter: () => filterText
	});

	const select = createMultiSelect({
		paths: () => list.visible().map((entry) => entry.path),
		rerender: () => list.render(),
		refresh: () => void list.refresh(),
		entryOf: (path): DirEntryInfo | null => list.entries.find((entry) => entry.path === path) ?? null
	});

	const pathBar = createPathBar((next) => void show(next));

	// The toolbar (§6.1): the filter box (300 ms debounce) and the sort button.
	const filter = document.createElement('input');
	filter.type = 'search';
	filter.className = 'ggs-files-filter';
	filter.placeholder = t('remote.files.filter');
	let filterTimer: number | null = null;
	filter.addEventListener('input', () => {
		if (filterTimer !== null) window.clearTimeout(filterTimer);
		filterTimer = window.setTimeout(() => {
			filterText = filter.value.trim();
			list.render();
		}, 300);
	});
	const sortButton = el('button', 'ggs-files-toolbtn', [icon('list-ordered')]);
	sortButton.type = 'button';
	sortButton.title = t('remote.files.sort.title');
	sortButton.addEventListener('click', () => sortSheet());
	const toolbar = el('div', 'ggs-files-toolbar', [filter, sortButton]);

	// The floating action button (§6.1): upload files, upload folder (by capability,
	// §10.2 item 11 — iOS hides the row), new file, new folder.
	const fab = el('button', 'ggs-files-fab', [icon('add')]);
	fab.type = 'button';
	fab.setAttribute('aria-label', t('remote.files.actions'));
	fab.addEventListener('click', () => {
		const entries: MenuEntry[] = [
			{ label: t('transfer.uploadHere'), run: () => void uploadInto(dir, false).then(() => list.refresh()) },
			...(document.documentElement.hasAttribute('data-cap-ios')
				? []
				: [{ label: t('transfer.uploadFolderHere'), run: () => void uploadInto(dir, true).then(() => list.refresh()) }]),
			{ label: t('remote.files.newFile'), run: () => void createNew(false) },
			{ label: t('remote.files.newFolder'), run: () => void createNew(true) }
		];
		showActionSheet(entries, t('remote.files.actions'));
	});

	/** The one-field sheet a new file or folder takes its name from. */
	function askName(title: string): Promise<string | null> {
		return new Promise((resolve) => {
			const input = document.createElement('input');
			input.type = 'text';
			input.className = 'ggs-name-input';
			input.placeholder = t('remote.files.namePlaceholder');
			const settle = (value: string | null) => {
				resolve(value);
				closeSheet();
			};
			const create = el('button', 'ggs-select-btn primary', [t('remote.files.create')]);
			create.type = 'button';
			create.addEventListener('click', () => settle(input.value.trim() || null));
			const cancel = el('button', 'ggs-select-btn', [t('transfer.cancel')]);
			cancel.type = 'button';
			cancel.addEventListener('click', () => settle(null));
			const body = el('div', 'ggs-name-body', [input, el('div', 'ggs-name-buttons', [cancel, create])]);
			const sheet = openSheet({ title, body, onClose: () => resolve(null) });
			input.addEventListener('keydown', (event) => {
				if (event.key === 'Enter') settle(input.value.trim() || null);
				if (event.key === 'Escape') settle(null);
			});
			void sheet;
			setTimeout(() => input.focus(), 80);
			function closeSheet(): void {
				// The sheet's own dismissal already ran onClose; closing here is idempotent.
				if (sheet.isConnected) closeActionSheet();
			}
		});
	}

	async function createNew(folder: boolean): Promise<void> {
		const name = await askName(folder ? t('remote.files.newFolder') : t('remote.files.newFile'));
		if (!name) return;
		try {
			if (folder) await createFolder(`${dir}/${name}`);
			else await createFile(`${dir}/${name}`);
		} catch (error) {
			notify('error', String(error));
		}
		await list.refresh();
	}

	function sortSheet(): void {
		const current = list.sort;
		const entries: MenuEntry[] = SORT_KEYS.map((key) => ({
			label: key.label(),
			checked: current.key === key.key,
			run: () => applySort({ ...current, key: key.key })
		}));
		entries.push('separator');
		entries.push({
			label: t(current.asc ? 'remote.files.sort.asc' : 'remote.files.sort.desc'),
			run: () => applySort({ ...current, asc: !current.asc })
		});
		entries.push({
			label: t('remote.files.sort.hidden'),
			checked: current.hidden,
			run: () => applySort({ ...current, hidden: !current.hidden })
		});
		showActionSheet(entries, t('remote.files.sort.title'));
	}

	function applySort(next: FilesSort): void {
		localStorage.setItem(SORT_STORE, JSON.stringify(next));
		list.setSort(next);
	}

	async function show(next: string): Promise<void> {
		dir = next;
		pathBar.set(dir, workspaceRoot() || dir);
		await list.show(next);
	}

	// The watcher's batches (§6.1: only the shown directory refetches — a change under it
	// or at it; anything deeper in the tree is another directory's business).
	const previousFs = workbench.onFsChanged.bind(workbench);
	workbench.onFsChanged = (change: FsChange) => {
		previousFs(change);
		if (select.active()) return; // a selection in flight is not interrupted
		const root = workbench.repoPath ?? workspaceRoot();
		if (!root) return;
		const here = relativeTo(root, dir).replace(/\\/g, '/');
		const touches = here === ''
			|| change.paths.some((path) => path === here || path.startsWith(`${here}/`));
		if (touches) void list.refresh();
	};

	page.append(pathBar.root, toolbar, select.countBar, scroll);
	scroll.appendChild(list.root);
	view.append(page, select.actionBar, fab);
	list.setSort(loadSort());
	if (dir) void show(dir);

	// The page mounts at the shell's install moment — the title bar's first frame, which
	// the workbench builds synchronously while the boot context's roots are still one wire
	// round trip away (2026-10-16: the page booted with `dir === ''` and showed the
	// "空目录" placeholder forever — nothing retried once the workspace landed). The
	// explorer renders into this same view, and its header/rows appear exactly when
	// setRoots applies, so that render is the signal; the check itself no-ops unless the
	// first open folder actually moved (a directory still inside it keeps its place).
	let followedRoot = workspaceRoot();
	const followRoot = (): void => {
		const root = workspaceRoot();
		if (!root || root === followedRoot) return; // none yet, or the one already followed
		const previous = followedRoot;
		followedRoot = root;
		if (!previous || !withinRoots(previous, [root])) void show(root);
	};
	if (typeof MutationObserver !== 'undefined') {
		new MutationObserver(() => followRoot()).observe(view, { childList: true, subtree: true });
	}
	followRoot();
}
