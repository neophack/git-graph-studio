// The files page (module 19, docs/remote-client-plan.md §6.1, P1): the MT-manager flat
// list — its rows (the two lines, the git letter, the folder chevron), entering and
// leaving directories with the scroll position remembered, the infinite scroll's sentinel,
// the long-press multi-select with its action bars (a multi-selection downloads as ONE
// zip), the sort rules (folders first, the hidden-files switch), and the path bar's chips.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installRemoteSessionHooks } from '../src/remote/desktopHooks';
installRemoteSessionHooks();
import { provideHook } from '../src/platform/hooks';
import { backend } from './tauriMock';
import { click, flush, workbenchShell, DefaultingHandlers } from './helpers';
import { createFileList, relativeTime, shortDateTime, defaultSort, type FileListHooks, type SortKey } from '../src/remote/app/files/fileList';
import { createPathBar } from '../src/remote/app/files/pathBar';
import { createMultiSelect } from '../src/remote/app/files/multiSelect';
import { installFilesPage } from '../src/remote/app/files/filesPage';
import { createEditorEmptyState } from '../src/remote/editorSwitcher';
import { bootWorkbench, currentWorkbench } from '../src/workbench';

interface Entry {
	name: string;
	isDir: boolean;
	size?: number;
	modified?: number;
	children?: number;
}

/** A scripted directory tree: path -> entries, served through `list_dir_page` windows in
 *  the backend's own order (folders first, then files, alphabetical; `.git` never). */
function serve(dirs: Record<string, Entry[]>): void {
	backend.on('list_dir_page', ({ path, offset, limit }: { path: string; offset: number; limit: number }) => {
		const entries = (dirs[path] ?? []).filter((entry) => entry.name !== '.git');
		const sorted = [
			...entries.filter((entry) => entry.isDir).sort((a, b) => a.name.localeCompare(b.name)),
			...entries.filter((entry) => !entry.isDir).sort((a, b) => a.name.localeCompare(b.name))
		];
		return {
			entries: sorted.slice(offset, offset + limit).map((entry) => ({
				name: entry.name,
				path: `${path}/${entry.name}`,
				isDir: entry.isDir,
				size: entry.size ?? 0,
				...(entry.modified !== undefined ? { modified: entry.modified } : {}),
				...(entry.children !== undefined ? { children: entry.children } : {})
			})),
			total: sorted.length,
			offset,
			limit
		};
	});
}

/** The multi-select under test, and the ONE hook object every list reads live. */
let select: ReturnType<typeof createMultiSelect> | null = null;
const selectionHook = {
	active: () => select?.active() ?? false,
	isSelected: (path: string) => select?.isSelected(path) ?? false,
	longPress: (path: string) => select?.longPress(path),
	toggle: (path: string) => select?.toggle(path)
};

function mountList(dirs: Record<string, Entry[]>, letters: Record<string, string> = {}) {
	serve(dirs);
	const entered: string[] = [];
	const opened: string[] = [];
	const menus: string[] = [];
	const scroll = document.createElement('div');
	scroll.className = 'ggs-files-scroll';
	const list = createFileList({
		enter: (dir) => entered.push(dir),
		open: (path) => opened.push(path),
		letter: (path) => letters[path] ?? null,
		selection: selectionHook,
		filter: () => '',
		// The page's row menu, shaped as filesPage builds it — the 多选 row is the one the
		// long-press tests tap to enter the selection mode.
		menu: (entry) => [
			{ label: `open:${entry.path}`, run: () => (entry.isDir ? entered.push(entry.path) : opened.push(entry.path)) },
			{ label: 'Select', run: () => select?.longPress(entry.path) },
			{ label: 'Copy Path', run: () => menus.push(entry.path) }
		]
	});
	scroll.appendChild(list.root);
	document.body.appendChild(scroll);
	return { list, root: list.root, scroll, entered, opened, menus };
}

const row = (root: HTMLElement, name: string) =>
	root.querySelector<HTMLElement>(`.ggs-file-row[data-path$="/${name}"]`)!;

const rows = (root: HTMLElement): string[] =>
	[...root.querySelectorAll('.ggs-file-row .l1')].map((line) => line.textContent);

/** The long-press (450 ms, §6.1): a pointer that stays put. */
async function longPress(node: HTMLElement): Promise<void> {
	node.dispatchEvent(new MouseEvent('pointerdown', { clientX: 10, clientY: 10 }));
	await new Promise((resolve) => setTimeout(resolve, 480));
	node.dispatchEvent(new MouseEvent('pointerup', { clientX: 10, clientY: 10 }));
}

/** The gesture path into the selection mode (§6.1 as of the owner's 2026-10-16 direction):
 * the long-press opens the row's menu, the menu's Select row starts the mode. */
async function longPressSelect(node: HTMLElement): Promise<void> {
	await longPress(node);
	const sheet = document.querySelector('.ggs-action-sheet');
	if (!sheet) throw new Error('the long-press opened no menu');
	click([...sheet.querySelectorAll('button')].find((button) => button.textContent === 'Select')!);
}

/** The multi-select over a mounted list, with its bars. */
function selectOver(mounted: ReturnType<typeof mountList>, isDir: (path: string) => boolean = () => false) {
	select = createMultiSelect({
		paths: () => [...mounted.root.querySelectorAll<HTMLElement>('.ggs-file-row')].map((node) => node.dataset.path!),
		rerender: () => mounted.list.render(),
		refresh: () => undefined,
		entryOf: (path) => ({ name: path.slice(path.lastIndexOf('/') + 1), isDir: isDir(path) })
	});
	return select;
}

beforeEach(() => {
	document.body.replaceChildren();
	// The notifications container confirmDialog's toasts land in.
	const notes = document.createElement('div');
	notes.id = 'notifications';
	document.body.appendChild(notes);
	select = null;
});

afterEach(() => {
	document.body.replaceChildren();
	select = null;
});

describe('the file list (§6.1)', () => {
	it('lays the rows out: two lines, the git letter, the folder chevron', async () => {
		const now = Math.floor(Date.now() / 1000);
		const mounted = mountList({
			'C:/repo': [
				{ name: 'src', isDir: true, children: 12, modified: now - 3 * 86400 },
				{ name: 'main.ts', isDir: false, size: 43008, modified: now - 3600 },
				{ name: '.hidden', isDir: false, size: 1 }
			]
		}, { 'C:/repo/main.ts': 'M' });
		await mounted.list.show('C:/repo');
		// Folders first; dotfiles hidden by default; .git never (the backend's walk).
		expect(rows(mounted.root)).toEqual(['src', 'main.ts']);
		const folder = row(mounted.root, 'src');
		expect(folder.querySelector('.chev')!.textContent).toBe('›');
		expect(folder.querySelector('.l2')!.textContent).toContain('12');
		expect(folder.querySelector('.l2')!.textContent).toContain(relativeTime(now - 3 * 86400));
		const file = row(mounted.root, 'main.ts');
		expect(file.querySelector('.status')!.textContent).toBe('M');
		expect(file.querySelector('.status')!.classList.contains('mod')).toBe(true);
		expect(file.querySelector('.l2')!.textContent).toContain('KB');
		expect(file.querySelector('.l2')!.textContent).toContain(shortDateTime(now - 3600));
		expect(file.querySelector('.chev')).toBeNull();
	});

	it('enters a folder on a tap, opens a file, and the way back restores the scroll', async () => {
		const mounted = mountList({
			'C:/repo': [{ name: 'src', isDir: true }, { name: 'a.txt', isDir: false }],
			'C:/repo/src': Array.from({ length: 5 }, (_, i) => ({ name: `f${i}.ts`, isDir: false }))
		});
		await mounted.list.show('C:/repo');
		click(row(mounted.root, 'src'));
		expect(mounted.entered).toEqual(['C:/repo/src']);
		await mounted.list.show('C:/repo/src');
		mounted.scroll.scrollTop = 240;
		await mounted.list.show('C:/repo');
		expect(rows(mounted.root)).toEqual(['src', 'a.txt']);
		await mounted.list.show('C:/repo/src');
		expect(mounted.scroll.scrollTop).toBe(240);
	});

	it('pages through the sentinel: 200 a page until the total is loaded', async () => {
		const many = Array.from({ length: 430 }, (_, i) => ({ name: `f${String(i).padStart(3, '0')}.ts`, isDir: false }));
		serve({ 'C:/repo': many });
		// jsdom has no IntersectionObserver: a stub that reports the sentinel intersecting
		// the moment it is observed — exactly what scrolling to the end does.
		vi.stubGlobal('IntersectionObserver', class {
			constructor(private readonly callback: (seen: { isIntersecting: boolean }[]) => void) {}
			observe(): void {
				queueMicrotask(() => this.callback([{ isIntersecting: true }]));
			}
			unobserve(): void { /* the sentinel swaps */ }
			disconnect(): void { /* the list lives once */ }
		});
		const scroll = document.createElement('div');
		scroll.className = 'ggs-files-scroll';
		const list = createFileList({ enter: () => undefined, open: () => undefined, letter: () => null, selection: selectionHook, filter: () => '' });
		scroll.appendChild(list.root);
		document.body.appendChild(scroll);
		await list.show('C:/repo');
		expect(list.root.querySelectorAll('.ggs-file-row')).toHaveLength(200);
		expect(list.root.querySelector('.ggs-file-sentinel')).not.toBeNull();
		for (let i = 0; i < 12 && list.root.querySelector('.ggs-file-sentinel'); i++) await flush();
		expect(list.root.querySelectorAll('.ggs-file-row')).toHaveLength(430);
		expect(list.root.querySelector('.ggs-file-sentinel')).toBeNull();
		vi.unstubAllGlobals();
	});

	it('sorts: folders always first, every key both ways, the hidden switch', async () => {
		const now = Math.floor(Date.now() / 1000);
		const mounted = mountList({
			'C:/repo': [
				{ name: 'zeta', isDir: true },
				{ name: 'beta.md', isDir: false, size: 10, modified: now - 100 },
				{ name: 'alpha.ts', isDir: false, size: 900, modified: now - 10 },
				{ name: '.env', isDir: false, size: 5 }
			]
		});
		await mounted.list.show('C:/repo');
		const sort = (key: SortKey, asc: boolean, hidden = false) => mounted.list.setSort({ key, asc, hidden });
		expect(rows(mounted.root)).toEqual(['zeta', 'alpha.ts', 'beta.md']);
		sort('size', true);
		expect(rows(mounted.root)).toEqual(['zeta', 'beta.md', 'alpha.ts']);
		sort('name', false);
		expect(rows(mounted.root)).toEqual(['zeta', 'beta.md', 'alpha.ts']);
		sort('name', true, true);
		expect(rows(mounted.root)).toEqual(['zeta', '.env', 'alpha.ts', 'beta.md']);
	});
});

describe('the row menu (§6.1, the owner\'s 2026-10-16 direction: 长按要弹出菜单)', () => {
	it('a long-press opens the row\'s menu, titled by the entry, and swallows the release\'s click', async () => {
		const mounted = mountList({ 'C:/repo': [{ name: 'a.ts', isDir: false }, { name: 'b', isDir: true }] });
		await mounted.list.show('C:/repo');
		await longPress(row(mounted.root, 'a.ts'));
		const sheet = document.querySelector('.ggs-action-sheet');
		expect(sheet).not.toBeNull();
		expect(sheet!.textContent).toContain('a.ts');
		// The sheet's rows are the menu's actions, the 多选 entry among them.
		expect([...sheet!.querySelectorAll('button')].map((button) => button.textContent)).toContain('Select');
		// The touch release's trailing click lands on the row under the sheet — swallowed,
		// the file does not open (the symptom the owner reported read as a dead long-press).
		click(row(mounted.root, 'a.ts'));
		expect(mounted.opened).toEqual([]);
		expect(mounted.entered).toEqual([]);
	});

	it('the ⋮ button opens the same menu, and its rows run', async () => {
		const mounted = mountList({ 'C:/repo': [{ name: 'a.ts', isDir: false }] });
		await mounted.list.show('C:/repo');
		click(row(mounted.root, 'a.ts').querySelector('.ggs-file-more')!);
		const sheet = document.querySelector('.ggs-action-sheet');
		expect(sheet).not.toBeNull();
		// The tap on ⋮ is not the row's own tap: nothing opened beside the sheet.
		expect(mounted.opened).toEqual([]);
		click([...sheet!.querySelectorAll('button')].find((button) => button.textContent === 'Copy Path')!);
		expect(mounted.menus).toEqual(['C:/repo/a.ts']);
		expect(document.querySelector('.ggs-action-sheet')).toBeNull();
	});

	it('a contextmenu opens the menu; one already open is not re-opened', async () => {
		const mounted = mountList({ 'C:/repo': [{ name: 'a.ts', isDir: false }] });
		await mounted.list.show('C:/repo');
		const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
		row(mounted.root, 'a.ts').dispatchEvent(event);
		expect(event.defaultPrevented).toBe(true);
		expect(document.querySelector('.ggs-action-sheet')).not.toBeNull();
		// Android fires contextmenu ~500 ms into a long-press: the sheet the timer opened
		// stays as it is (no restart of its slide-in).
		const first = document.querySelector('.ggs-action-sheet');
		row(mounted.root, 'a.ts').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
		expect(document.querySelector('.ggs-action-sheet')).toBe(first);
	});

	it('while a selection is on, a long-press toggles the row — no menu over the checkboxes', async () => {
		const mounted = mountList({ 'C:/repo': [{ name: 'a.ts', isDir: false }, { name: 'b.ts', isDir: false }] });
		await mounted.list.show('C:/repo');
		const select = selectOver(mounted);
		await longPressSelect(row(mounted.root, 'a.ts'));
		await longPress(row(mounted.root, 'b.ts'));
		expect(select.countBar.textContent).toContain('2');
		expect(document.querySelector('.ggs-action-sheet')).toBeNull();
	});
});

describe('the multi-select (§6.1)', () => {
	it('starts from the menu\'s Select row, counts, and cancels', async () => {
		const mounted = mountList({ 'C:/repo': [{ name: 'a.ts', isDir: false }, { name: 'b.ts', isDir: false }] });
		await mounted.list.show('C:/repo');
		const select = selectOver(mounted);
		await longPressSelect(row(mounted.root, 'a.ts'));
		expect(select.active()).toBe(true);
		const first = row(mounted.root, 'a.ts');
		expect(first.classList.contains('selectable')).toBe(true);
		expect((first.querySelector('input') as HTMLInputElement).checked).toBe(true);
		expect(select.countBar.textContent).toContain('1');
		// A plain tap toggles in select mode — no open, no enter.
		click(row(mounted.root, 'b.ts'));
		expect(select.countBar.textContent).toContain('2');
		expect(mounted.opened).toEqual([]);
		expect(mounted.entered).toEqual([]);
		// Cancel clears the mode and the marks.
		click([...select.countBar.querySelectorAll('button')].at(-1)!);
		expect(select.active()).toBe(false);
		expect(row(mounted.root, 'a.ts').classList.contains('selectable')).toBe(false);
	});

	it('a multi-selection downloads as ONE zip; a single file downloads itself', async () => {
		const packed: string[][] = [];
		const single: string[] = [];
		provideHook('transferWire', () => Promise.resolve({
			uploadFiles: () => Promise.resolve({ uploaded: [], failed: [] }),
			download: (path: string) => {
				single.push(path);
				return Promise.resolve();
			},
			downloadMany: (paths: string[]) => {
				packed.push(paths);
				return Promise.resolve();
			}
		}));
		const mounted = mountList({
			'C:/repo': [
				{ name: 'a.ts', isDir: false },
				{ name: 'b', isDir: true },
				{ name: 'c.md', isDir: false }
			]
		});
		await mounted.list.show('C:/repo');
		const select = selectOver(mounted, (path) => path.endsWith('/b'));
		const download = () => [...select.actionBar.querySelectorAll('button')].find((button) => button.textContent === 'Download')!;
		await longPressSelect(row(mounted.root, 'a.ts'));
		click(row(mounted.root, 'b'));
		click(row(mounted.root, 'c.md'));
		await click(download());
		await flush();
		expect(packed).toEqual([['C:/repo/a.ts', 'C:/repo/b', 'C:/repo/c.md']]);
		expect(single).toEqual([]);
		// One selection alone: the plain download of that file.
		click([...select.countBar.querySelectorAll('button')].at(-1)!);
		await longPressSelect(row(mounted.root, 'a.ts'));
		await click(download());
		await flush();
		expect(single).toEqual(['C:/repo/a.ts']);
		provideHook('transferWire', null);
	});

	it('deletes after one confirm for the whole selection', async () => {
		const deleted: { path: string; permanent: boolean }[] = [];
		backend.on('delete_path', ({ path, permanent }: { path: string; permanent: boolean }) => {
			deleted.push({ path, permanent });
			return null;
		});
		const mounted = mountList({ 'C:/repo': [{ name: 'a.ts', isDir: false }, { name: 'b.ts', isDir: false }] });
		await mounted.list.show('C:/repo');
		const select = selectOver(mounted);
		await longPressSelect(row(mounted.root, 'a.ts'));
		click(row(mounted.root, 'b.ts'));
		await click([...select.actionBar.querySelectorAll('button')].find((button) => button.textContent === 'Delete')!);
		// §12.3's confirm: the dialog's own primary button agrees.
		const confirm = [...document.querySelectorAll('#notifications button')].find((button) => button.textContent === 'Delete');
		expect(confirm).toBeDefined();
		await click(confirm!);
		await flush();
		expect(deleted).toEqual([
			{ path: 'C:/repo/a.ts', permanent: true },
			{ path: 'C:/repo/b.ts', permanent: true }
		]);
	});
});

describe('the path bar (§6.1)', () => {
	it('shows one chip per level, jumps on a tap, and lists the siblings', async () => {
		serve({
			'C:/repo': [{ name: 'src', isDir: true }, { name: 'docs', isDir: true }, { name: 'a.txt', isDir: false }],
			'C:/repo/src': []
		});
		const gone: string[] = [];
		const bar = createPathBar((dir) => gone.push(dir));
		document.body.appendChild(bar.root);
		bar.set('C:/repo/src', 'C:/repo');
		const chips = [...bar.root.querySelectorAll('.ggs-path-chip:not(.home)')];
		expect(chips.map((chip) => chip.textContent)).toEqual(['src']);
		click(chips[0]);
		expect(gone).toEqual(['C:/repo/src']);
		// The trailing ▸ lists the sibling folders (docs beside src).
		click(bar.root.querySelector('.ggs-path-siblings')!);
		await flush();
		const sheet = document.querySelector('.ggs-action-sheet');
		expect(sheet).not.toBeNull();
		expect(sheet!.textContent).toContain('docs');
	});
});

describe('the second line formats', () => {
	it("reads the plan's own examples", () => {
		const now = Math.floor(Date.now() / 1000);
		expect(relativeTime(now - 30)).toContain('just');
		expect(relativeTime(now - 5 * 60)).toContain('5');
		expect(relativeTime(now - 3 * 86400)).toContain('3');
		expect(shortDateTime(new Date('2026-10-14T18:20:00').getTime() / 1000)).toBe('10-14 18:20');
	});
});

describe('the installed page follows the workspace root', () => {
	/** The booted workbench with the files page mounted the way the shell mounts it — before
	 *  the roots land. The shell installs at the title bar's first frame, which the workbench
	 *  builds synchronously while `boot_context` (a wire round trip on the remote) is still in
	 *  flight: the page must not stay on its "空目录" placeholder once the workspace applies. */
	async function bootWithoutRoots(): Promise<void> {
		localStorage.clear();
		workbenchShell();
		// The remote marker: the tree pages through `list_dir_page` like the files page does.
		document.documentElement.setAttribute('data-remote-shell', '');
		backend.reset();
		backend.handlers = new DefaultingHandlers([
			['boot_context', () => ({ file: null, actions: [], repo: null, roots: [], workspaceFile: null })],
			['repo_head', () => ({ branch: 'main', shortHash: 'abc', ahead: 0, behind: 0, upstream: null })],
			['scm_status', () => []],
			['ext_list', () => []],
			['backup_list', () => []],
			['pty_create', () => 1]
		] as [string, (args: Record<string, unknown>) => unknown][]);
		serve({
			'C:/repo': [{ name: 'src', isDir: true }, { name: 'a.txt', isDir: false }],
			'C:/other': [{ name: 'b.md', isDir: false }]
		});
		await import('../src/features/editor'); // pre-warm the editor chunk, as the boot suites do
		const booted = bootWorkbench();
		installFilesPage(); // the shell's moment: the constructor is done, the roots are not
		await booted;
		await flush(4);
	}

	const pageRows = (): string[] =>
		[...document.querySelectorAll('.ggs-files-page .ggs-file-row .l1')].map((line) => line.textContent);

	afterEach(() => {
		currentWorkbench?.dispose();
		document.documentElement.removeAttribute('data-remote-shell');
	});

	it('loads the root once it arrives, and follows a switch to another folder', { timeout: 30_000 }, async () => {
		await bootWithoutRoots();
		// The symptom as reported (2026-10-16: 远程文件也显示空目录): the placeholder, no rows.
		expect(pageRows()).toEqual([]);
		expect(document.querySelector('.ggs-files-page .ggs-file-empty')).not.toBeNull();
		await currentWorkbench!.applyRoots(['C:/repo'], true, null);
		await flush(8);
		expect(pageRows()).toEqual(['src', 'a.txt']);
		expect(document.querySelector('.ggs-files-page .ggs-file-empty')).toBeNull();
		// A directory the window no longer holds is not listable — the page moves to the new root.
		await currentWorkbench!.applyRoots(['C:/other'], false, null);
		await flush(8);
		expect(pageRows()).toEqual(['b.md']);
	});
});

describe('the editor empty page over a live workbench', () => {
	/** The booted workbench with a repository behind it, the way a remote session lands on
	 *  one: the branch and one pending change answered by the scripted backend, the device's
	 *  recents seeded before the page mounts, and the page mounted into #editorPart exactly
	 *  as parts.ts mounts it. */
	async function bootWithRepo(): Promise<void> {
		localStorage.clear();
		workbenchShell();
		document.documentElement.setAttribute('data-remote-shell', '');
		document.documentElement.setAttribute('data-page-stack', '');
		backend.reset();
		backend.handlers = new DefaultingHandlers([
			['boot_context', () => ({ file: null, actions: [], repo: 'C:/repo', roots: ['C:/repo'], workspaceFile: null })],
			['open_folder', () => ({ root: 'C:/repo', isRepo: true })],
			['repo_head', () => ({ branch: 'main', shortHash: 'abc', ahead: 0, behind: 0, upstream: null })],
			['scm_status', () => [{ path: 'notes.txt', oldPath: null, staged: null, unstaged: 'modified', untracked: false, conflicted: false }]],
			['repo_submodules', () => []],
			['list_dir_page', () => ({ entries: [], total: 0, offset: 0, limit: 100 })],
			['ext_list', () => []],
			['backup_list', () => []],
			['pty_create', () => 1]
		] as [string, (args: Record<string, unknown>) => unknown][]);
		localStorage.setItem('remote.editor.recent', JSON.stringify(['C:/repo/src/a.ts', 'C:/elsewhere/x.ts']));
		await import('../src/features/editor'); // pre-warm the editor chunk, as the boot suites do
		await bootWorkbench();
		await flush(8);
		document.getElementById('sidebar')!.hidden = true; // the Editor page
		document.getElementById('editorPart')!.appendChild(createEditorEmptyState());
		await flush(4);
	}

	afterEach(() => {
		currentWorkbench?.dispose();
		document.documentElement.removeAttribute('data-remote-shell');
		document.documentElement.removeAttribute('data-page-stack');
	});

	it('carries the repository: the branch and the pending changes one tap from the Source Control page', { timeout: 30_000 }, async () => {
		await bootWithRepo();
		const empty = document.querySelector<HTMLElement>('.ggs-editor-empty')!;
		expect(empty.hidden).toBe(false);
		expect(empty.querySelector('.subtitle')!.textContent).toBe('repo');
		const card = empty.querySelector<HTMLElement>('.ggs-empty-repo')!;
		expect(card.hidden).toBe(false);
		expect(card.querySelector('.name')!.textContent).toBe('main');
		expect(card.querySelector('.chip')!.textContent).toBe('1 changes');
		// One tap: the card opens the Source Control page.
		card.click();
		await flush(4);
		expect(document.getElementById('sidebar')!.hidden).toBe(false);
		expect(document.querySelector('#activitybar .activity-item.active')!.getAttribute('data-view')).toBe('scm');
	});

	it('offers this device\'s recents — only the files still inside an open folder', { timeout: 30_000 }, async () => {
		await bootWithRepo();
		const empty = document.querySelector<HTMLElement>('.ggs-editor-empty')!;
		const recents = [...empty.querySelectorAll('.recent-list .ggs-editor-row')];
		// The file inside the open folder is offered with its folder; the one from a folder
		// that has since been closed is not.
		expect(recents.map((row) => row.title)).toEqual(['C:/repo/src/a.ts']);
		expect(recents[0]!.querySelector('.name')!.textContent).toBe('a.ts');
		expect(recents[0]!.querySelector('.folder')!.textContent).toBe('src');
	});
});
