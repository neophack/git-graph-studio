// The phone's Source Control page (module 19, docs/remote-client-plan.md §6.4, the owner's
// 2026-10-16 direction: 手机端源代码管理界面不适合触控，要重新设计): the branch chip riding
// the commit card's action row (the owner's 2026-10-16 direction: ggs-scm-branch 要放到第一
// 行增加一个按钮就可以，不要单独一行) with the shared branch sheet (切换分支), the commit card whose primary action follows the
// repository's state, the change groups as touch sections — a tap opens the change, the ⋮
// opens the row's sheet, the group's own verbs stage / unstage / discard — and the page's
// seamlessness: it renders the ONE SourceControlView's state, so a device-class switch
// keeps the message typed here (the classic view's own box picks it up on its re-render).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installRemoteSessionHooks } from '../src/remote/desktopHooks';
installRemoteSessionHooks();
import { backend } from './tauriMock';
import { click, flush, notificationButton, type, until, workbenchShell, DefaultingHandlers } from './helpers';
import { bootWorkbench, currentWorkbench } from '../src/workbench';
import { installScmPage } from '../src/remote/app/scm/scmPage';
import { installFilesPage } from '../src/remote/app/files/filesPage';
import type { ScmChange } from '../src/platform/ipc/scm';
import type { DiffRequest } from '../src/features/editor/types';
import { t, tf } from '../src/platform/i18n';

vi.mock('mermaid', () => import('./mermaidStub'));
vi.mock('@mermaid-js/layout-elk', () => ({ default: {} }));

/** A change row of `scm_status`, in the backend's own shape. */
const change = (path: string, over: Partial<ScmChange> = {}): ScmChange => ({
	path,
	oldPath: null,
	staged: null,
	unstaged: 'modified',
	untracked: false,
	...over
});

let changes: ScmChange[] = [];
let head: { branch: string | null; shortHash: string; ahead: number; behind: number; upstream: string | null };
let branches: { name: string; remote: boolean; current: boolean; upstream: string | null }[];

/** Boot the workbench with the phone pages mounted (the shell's own order) and a scripted
 *  repository: the status, the head and the branches the sheets read. */
async function bootPhoneRepo(): Promise<void> {
	localStorage.clear();
	workbenchShell();
	document.documentElement.setAttribute('data-remote-shell', '');
	backend.reset();
	backend.handlers = new DefaultingHandlers([
		['boot_context', () => ({ file: null, actions: [], repo: 'C:/repo', roots: ['C:/repo'], workspaceFile: null })],
		['open_folder', () => ({ root: 'C:/repo', isRepo: true })],
		['scm_status', () => changes],
		['repo_head', () => head],
		['scm_branches', () => branches],
		['repo_submodules', () => []],
		['list_dir_page', () => ({ entries: [], total: 0, offset: 0, limit: 100 })],
		['read_file', ({ path }: { path: string }) => ({ contents: `${path}\n`, binary: false, size: 8, encoding: 'utf8', eol: 'lf' })],
		['ext_list', () => []],
		['backup_list', () => []],
		['pty_create', () => 1]
	] as [string, (args: Record<string, unknown>) => unknown][]);
	await import('../src/features/editor'); // pre-warm the editor chunk, as the boot suites do
	const booted = bootWorkbench();
	installFilesPage();
	installScmPage();
	await booted;
	await flush(8);
}

const sheetRows = (): string[] =>
	[...document.querySelectorAll('.ggs-action-sheet .row .label')].map((label) => label.textContent);

const groupSection = (label: string): HTMLElement | null =>
	[...document.querySelectorAll<HTMLElement>('.ggs-scm-grouphead')].find((head) => head.querySelector('.label')?.textContent === label)?.closest('.ggs-scm-group') ?? null;

const rowOf = (name: string): HTMLElement | null =>
	[...document.querySelectorAll<HTMLElement>('.ggs-scm-row')].find((row) => row.querySelector('.name')?.textContent === name) ?? null;

beforeEach(() => {
	changes = [change('src/a.ts'), change('src/b.md', { staged: 'modified', unstaged: null })];
	head = { branch: 'main', shortHash: 'abc1234', ahead: 2, behind: 1, upstream: 'origin/main' };
	branches = [
		{ name: 'main', remote: false, current: true, upstream: 'origin/main' },
		{ name: 'dev', remote: false, current: false, upstream: null },
		{ name: 'origin/feature', remote: true, current: false, upstream: null }
	];
});

afterEach(() => {
	currentWorkbench?.dispose();
	document.documentElement.removeAttribute('data-remote-shell');
});

describe('the phone Source Control page (§6.4)', () => {
	it('renders the branch chip in the commit row, the groups, and the letters', { timeout: 30_000 }, async () => {
		await bootPhoneRepo();
		const branch = document.querySelector<HTMLElement>('.ggs-scm-branch')!;
		expect(branch.querySelector('.name')!.textContent).toBe('main');
		expect(branch.querySelector('.meta')!.textContent).toContain('1');
		expect(branch.querySelector('.meta')!.textContent).toContain('2');
		// The chip is a button in the commit card's action row — never a row of its own
		// (the owner's 2026-10-16 direction: ggs-scm-branch 要放到第一行增加一个按钮就可以，
		// 不要单独一行): the page's own children are the commit card and the scroll.
		expect(branch.closest('.ggs-scm-commitrow')).not.toBeNull();
		const pageChildren = [...document.querySelector('.ggs-scm-page')!.children];
		expect(pageChildren.map((child) => child.className)).toEqual(['ggs-scm-commit', 'ggs-scm-scroll']);
		// The groups: the staged change under 已暂存的更改, the unstaged under 更改.
		expect(groupSection(t('remote.scm.group.staged'))).not.toBeNull();
		expect(groupSection(t('remote.scm.group.changes'))).not.toBeNull();
		expect(rowOf('b.md')).not.toBeNull();
		const a = rowOf('a.ts')!;
		expect(a.querySelector('.letter')!.textContent).toBe('M');
		expect(a.querySelector('.dir')!.textContent).toBe('src');
		// The classic view stays mounted beside the page (CSS hides it on the page-stack
		// shells): the host class is what the stylesheet keys on.
		expect(currentWorkbench!.views.scm.classList.contains('ggs-scm-host')).toBe(true);
		expect(currentWorkbench!.views.scm.querySelector('.view-pane')).not.toBeNull();
	});

	it('the swipe strip never doubles the group head\'s own verbs — it paints only under a dragged row', { timeout: 30_000 }, async () => {
		// The page-stack marker is what the row gesture keys on (a desktop build wires none).
		document.documentElement.setAttribute('data-page-stack', '');
		try {
			await bootPhoneRepo();
			// The change rows carry their strips inside the group sections, whose first child
			// is the group head — the head already shows the group's own discard-all /
			// stage-all pair, and a resting strip once painted over it (2026-10-16: the two
			// icons showed twice).
			const strips = [...document.querySelectorAll<HTMLElement>('.ggs-scm-page .ggs-swipe-actions')];
			expect(strips.length).toBeGreaterThan(0);
			for (const strip of strips) expect(strip.style.visibility).toBe('hidden');
			// A left drag on an unstaged row uncovers exactly that row's pair — discard and
			// stage, the same verbs the row's ⋮ sheet runs.
			Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 112 });
			try {
				const row = rowOf('a.ts')!;
				const drag = (type: string, x: number): void =>
					row.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: 10, bubbles: true, cancelable: true }));
				drag('pointerdown', 200);
				drag('pointermove', 180);
				const visible = strips.filter((strip) => strip.style.visibility === 'visible');
				expect(visible).toHaveLength(1);
				const labels = [...visible[0]!.querySelectorAll('button')].map((button) => button.getAttribute('aria-label'));
				expect(labels).toEqual([t('remote.scm.discard'), t('remote.scm.stage')]);
			} finally {
				delete (HTMLElement.prototype as { offsetWidth?: number }).offsetWidth;
			}
		} finally {
			document.documentElement.removeAttribute('data-page-stack');
		}
	});

	it('a tap opens the change, and the row sheet stages through the backend', { timeout: 30_000 }, async () => {
		await bootPhoneRepo();
		const diffs: DiffRequest[] = [];
		currentWorkbench!.scm.onOpenDiff = (diff) => diffs.push(diff);
		currentWorkbench!.scm.onOpenFile = () => undefined;
		click(rowOf('a.ts'));
		await flush(2);
		expect(diffs).toHaveLength(1);
		expect(diffs[0]!.right.path).toBe('src/a.ts');
		// The ⋮ sheet: stage runs git_stage with the row's path.
		click(rowOf('a.ts')!.querySelector<HTMLButtonElement>('.ggs-scm-rowmore'));
		await flush(2);
		const rows = [...document.querySelectorAll<HTMLElement>('.ggs-action-sheet .row')];
		click(rows.find((row) => row.textContent === t('remote.scm.stage'))!);
		await flush(4);
		expect(backend.callsTo('git_stage')).toContainEqual({ paths: ['src/a.ts'] });
	});

	it('the staged group unstage-all and the changes group stage-all run their commands', { timeout: 30_000 }, async () => {
		await bootPhoneRepo();
		backend.calls.length = 0;
		const staged = groupSection(t('remote.scm.group.staged'))!;
		click(staged.querySelector<HTMLButtonElement>('.ggs-scm-groupbtn[aria-label="' + t('remote.scm.unstageAll') + '"]'));
		await flush(4);
		expect(backend.callsTo('git_unstage_all')).toHaveLength(1);
		const unstaged = groupSection(t('remote.scm.group.changes'))!;
		click(unstaged.querySelector<HTMLButtonElement>('.ggs-scm-groupbtn[aria-label="' + t('remote.scm.stageAll') + '"]'));
		await flush(4);
		expect(backend.callsTo('git_stage_all')).toHaveLength(1);
	});

	it('the commit card follows the repository state, and a commit stages all and commits the message', { timeout: 30_000 }, async () => {
		changes = [change('src/a.ts'), change('src/b.md')]; // nothing staged: the commit stages all
		await bootPhoneRepo();
		const commitButton = document.querySelector<HTMLButtonElement>('.ggs-scm-commitbtn')!;
		expect(commitButton.textContent).toContain(t('remote.scm.commit'));
		type(document.querySelector<HTMLTextAreaElement>('.ggs-scm-message')!, 'fix: the phone page');
		click(commitButton);
		// Nothing staged: the commit asks (the classic view's own confirm) before staging all.
		await until(() => notificationButton('Yes') !== null);
		click(notificationButton('Yes'));
		await flush(8);
		expect(backend.callsTo('git_stage_all')).toHaveLength(1);
		expect(backend.callsTo('git_commit')).toContainEqual({ message: 'fix: the phone page', amend: false });
		// The message box cleared with the view's own state.
		await until(() => document.querySelector<HTMLTextAreaElement>('.ggs-scm-message')!.value === '');
	});

	it('a clean tree turns the button into the repository\'s server action', { timeout: 30_000 }, async () => {
		changes = [];
		head = { branch: 'main', shortHash: 'abc', ahead: 2, behind: 0, upstream: 'origin/main' };
		await bootPhoneRepo();
		const button = document.querySelector<HTMLButtonElement>('.ggs-scm-commitbtn')!;
		expect(button.textContent).toContain(tf('remote.scm.pushN', '2'));
		click(button);
		await flush(4);
		expect(backend.callsTo('scm_push')).toContainEqual({ remote: null, setUpstream: false, force: false });
		// Behind only: the sync action.
		head = { branch: 'main', shortHash: 'abc', ahead: 0, behind: 3, upstream: 'origin/main' };
		await currentWorkbench!.scm.refresh();
		await flush(4);
		expect(document.querySelector('.ggs-scm-commitbtn')!.textContent).toContain(t('remote.scm.sync'));
		// No upstream at all: publish.
		head = { branch: 'main', shortHash: 'abc', ahead: 0, behind: 0, upstream: null };
		await currentWorkbench!.scm.refresh();
		await flush(4);
		expect(document.querySelector('.ggs-scm-commitbtn')!.textContent).toContain(t('remote.scm.publish'));
	});

	it('keeps the message across a device-class switch — the classic view re-renders from the same state', { timeout: 30_000 }, async () => {
		await bootPhoneRepo();
		type(document.querySelector<HTMLTextAreaElement>('.ggs-scm-page .ggs-scm-message')!, 'kept across the switch');
		// The device-change handler's own act: both renderings refresh from the one state.
		currentWorkbench!.scm.render();
		const classic = currentWorkbench!.views.scm.querySelector<HTMLTextAreaElement>('.view-pane textarea');
		expect(classic!.value).toBe('kept across the switch');
	});

	it('a sub-repo\'s show-more grows only its own group — the paging budget keys per repository', { timeout: 30_000 }, async () => {
		changes = Array.from({ length: 120 }, (_, i) => change(`src/m${i}.ts`));
		const subChanges = Array.from({ length: 120 }, (_, i) => change(`lib/s${i}.ts`));
		await bootPhoneRepo();
		const mainHead = head;
		backend.handlers.set('repo_submodules', () => ['C:/repo/sub']);
		backend.handlers.set('scm_status', (args) => (args.repo === 'C:/repo/sub' ? subChanges : changes));
		backend.handlers.set('repo_head', (args) =>
			args.repo === 'C:/repo/sub' ? { branch: 'main', shortHash: 'sub1234', ahead: 0, behind: 0, upstream: null } : mainHead);
		await currentWorkbench!.scm.refresh();
		await flush(4);
		// Both repositories' Changes groups page at 100 rows with a show-more row.
		const mainGroup = groupSection(t('remote.scm.group.changes'))!;
		const subSectionEl = document.querySelector<HTMLElement>('.ggs-scm-grouphead.sub')!.closest('.ggs-scm-group')!;
		expect(mainGroup.querySelectorAll('.ggs-scm-row')).toHaveLength(100);
		expect(subSectionEl.querySelectorAll('.ggs-scm-row')).toHaveLength(100);
		click(subSectionEl.querySelector<HTMLButtonElement>('.ggs-scm-showmore'));
		await flush(2);
		// The click re-renders the page (replaceChildren): re-query, the old nodes are dead.
		const subAfter = document.querySelector<HTMLElement>('.ggs-scm-grouphead.sub')!.closest('.ggs-scm-group')!;
		expect(subAfter.querySelectorAll('.ggs-scm-row')).toHaveLength(120);
		// The main repository's group is untouched: still paged, its show-more still offered.
		const mainAfter = groupSection(t('remote.scm.group.changes'))!;
		expect(mainAfter.querySelectorAll('.ggs-scm-row')).toHaveLength(100);
		expect(mainAfter.querySelector('.ggs-scm-showmore')).not.toBeNull();
	});
});

describe('the branch sheet (the Files page chip and the SCM branch row)', () => {
	it('lists the branches — current checked, locals, remotes — and switches through scm_checkout', { timeout: 30_000 }, async () => {
		await bootPhoneRepo();
		// The Files page's chip carries the branch and opens the same sheet.
		const chip = document.querySelector<HTMLButtonElement>('.ggs-files-branch')!;
		expect(chip.textContent).toContain('main');
		click(chip);
		await until(() => document.querySelector('.ggs-action-sheet') !== null);
		const rows = [...document.querySelectorAll<HTMLElement>('.ggs-action-sheet .row')];
		expect(rows.find((row) => row.textContent === 'main')!.classList.contains('checked')).toBe(true);
		expect(sheetRows()).toContain('dev');
		expect(sheetRows()).toContain('origin/feature');
		expect(sheetRows()).toContain(t('remote.branch.new'));
		backend.calls.length = 0;
		click(rows.find((row) => row.textContent === 'dev')!);
		await flush(6);
		expect(backend.callsTo('scm_checkout')).toContainEqual({ name: 'dev' });
		// The switch ends in the SCM view's own refresh.
		expect(backend.callsTo('scm_status').length).toBeGreaterThan(0);
	});

	it('the SCM page\'s branch chip opens the same sheet', { timeout: 30_000 }, async () => {
		await bootPhoneRepo();
		click(document.querySelector<HTMLElement>('.ggs-scm-branch'));
		await until(() => document.querySelector('.ggs-action-sheet') !== null);
		expect(sheetRows()).toContain('dev');
	});

	it('a new branch asks for one name and checks it out', { timeout: 30_000 }, async () => {
		await bootPhoneRepo();
		click(document.querySelector<HTMLElement>('.ggs-scm-branch'));
		await until(() => document.querySelector('.ggs-action-sheet') !== null);
		const rows = [...document.querySelectorAll<HTMLElement>('.ggs-action-sheet .row')];
		click(rows.find((row) => row.textContent === t('remote.branch.new'))!);
		await until(() => document.querySelector('.ggs-name-input') !== null);
		const input = document.querySelector<HTMLInputElement>('.ggs-name-input')!;
		input.value = 'feature-x';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		click([...document.querySelectorAll<HTMLElement>('.ggs-name-buttons button')].find((button) => button.textContent === t('remote.branch.create'))!);
		await flush(6);
		expect(backend.callsTo('scm_create_branch')).toContainEqual({ name: 'feature-x', from: null });
	});
});
