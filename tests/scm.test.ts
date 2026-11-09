import { describe, expect, it } from 'vitest';

import { CommandRegistry } from '../src/platform/commands';
import { applyContributions, contextUri, removeContributions } from '../src/features/extensions';
import { isSafeRefName, registerGitCommands, validateTarget, type GitCommandHost } from '../src/features/scm';
import { buildChangeTree, SourceControlView, sortChanges } from '../src/features/scm';
import type { DiffRequest } from '../src/features/editor/types';
import { backend } from './tauriMock';
import { click, flush, hover, key, menuItem, menuLabels, notificationButton, notifications, rightClick, texts, type } from './helpers';

const REPO = 'C:\\repo';

function change(path: string, extra: Partial<{ staged: string | null; unstaged: string | null; untracked: boolean; oldPath: string | null; conflicted: boolean }> = {}) {
	return { path, oldPath: null, staged: null, unstaged: null, untracked: false, ...extra };
}

describe('change trees and sorting', () => {
	it('nests folders, compacts single-child chains and sorts folders first', () => {
		const tree = buildChangeTree([change('src/a/b/x.ts'), change('src/y.ts'), change('README.md')]);
		expect(tree.map((n) => n.name)).toEqual(['src', 'README.md']);
		const src = tree[0]!;
		expect(src.children.map((n) => n.name)).toEqual(['a/b', 'y.ts']);
		expect(src.children[0]!.children[0]!.file?.path).toBe('src/a/b/x.ts');
	});

	it('sorts by name, path and status', () => {
		const files = [change('b/z.ts', { unstaged: 'modified' }), change('a/y.ts', { untracked: true }), change('c/a.ts', { unstaged: 'deleted' })];
		expect(sortChanges(files, 'path', 'changes').map((f) => f.path)).toEqual(['a/y.ts', 'b/z.ts', 'c/a.ts']);
		expect(sortChanges(files, 'name', 'changes').map((f) => f.path)).toEqual(['c/a.ts', 'a/y.ts', 'b/z.ts']);
		expect(sortChanges(files, 'status', 'changes').map((f) => f.path)).toEqual(['c/a.ts', 'b/z.ts', 'a/y.ts']);
	});
});

describe('source control view', () => {
	function setup(changes = [
		change('src/main.ts', { staged: 'modified' }),
		change('README.md', { unstaged: 'modified' }),
		change('new.txt', { untracked: true }),
		change('gone.txt', { unstaged: 'deleted' })
	]) {
		let current = changes;
		backend.on('scm_status', () => current);
		// The in-sync tracked branch: a clean tree keeps the plain gray Commit button.
		backend.on('repo_head', () => ({ branch: 'main', shortHash: 'abc1234', ahead: 0, behind: 0, upstream: 'origin/main' }));
		for (const command of ['git_stage', 'git_unstage', 'git_stage_all', 'git_unstage_all', 'git_discard', 'git_discard_all', 'git_commit']) {
			backend.on(command, () => null);
		}
		const registry = new CommandRegistry();
		const view = new SourceControlView(document.getElementById('sidebar')!, registry);
		const host: GitCommandHost = {
			repoPath: () => REPO,
			repoChanged: () => undefined,
			openFolder: async () => undefined,
			showOutput: () => undefined,
			graphSettings: () => ({}),
			commit: (options) => view.commit(options),
			undoCommit: () => view.undoCommit()
		};
		registerGitCommands(registry, host);
		// The "..." menu's Amend/Gerrit entries come from the extension's own manifest
		// (contributions.ts), dispatched to the plugin's backend — the app registers no copy of
		// its own. The placements mirror the shipped manifest: three commands in scm/title, the
		// Gerrit refs/for push in git.pullpush — the sync menu's push group, rendered in the
		// Pull, Push submenu.
		removeContributions('git-graph-rs');
		const scmCommands: Record<string, { title: string; location: 'scm/title' | 'git.pullpush' }> = {
			'git-graph-rs.amendLastCommit': { title: 'Amend Last Commit', location: 'scm/title' },
			'git-graph-rs.gerritFetchCommitMsgHook': { title: 'Fetch commit-msg Hook (Gerrit)', location: 'scm/title' },
			'git-graph-rs.resetCurrentBranchToRemote': { title: 'Reset Current Branch to Remote (Soft)', location: 'scm/title' },
			'git-graph-rs.gerritPushRef': { title: 'Push to Gerrit Ref for Current Branch (refs/for/...)', location: 'git.pullpush' }
		};
		applyContributions(
			'git-graph-rs',
			{
				commands: Object.entries(scmCommands).map(([command, { title }]) => ({ command, title })),
				menus: {
					'scm/title': Object.keys(scmCommands)
						.filter((command) => scmCommands[command]!.location === 'scm/title')
						.map((command, index) => ({ command, group: `git-graph-rs@${index}` })),
					'git.pullpush': [{ command: 'git-graph-rs.gerritPushRef', group: '3_push@5' }]
				}
			},
			{},
			() => undefined,
			() => true
		);
		return { view, registry, setChanges: (c: typeof changes) => { current = c; } };
	}

	it('lists unmerged paths under Merge Changes, opens them in the editor and stages them as resolved', async () => {
		const { view } = setup([
			change('src/clash.ts', { staged: 'modified', unstaged: 'modified', conflicted: true }),
			change('README.md', { unstaged: 'modified' })
		]);
		const opened: string[] = [];
		const diffs: string[] = [];
		let conflicts = -1;
		let statusMap = new Map<string, string>();
		view.onOpenFile = (p) => opened.push(p);
		view.onOpenDiff = (d) => diffs.push(d.id);
		view.onConflicts = (n) => { conflicts = n; };
		view.onStatus = (s) => { statusMap = s; };
		view.setRepo(REPO);
		await view.refresh();

		expect(texts('.pane-header .label')).toEqual(['repo', 'Merge Changes', 'Changes']);
		expect(texts('.pane-header .badge')).toEqual(['2', '1', '1']);
		expect(texts('.scm-group .row .decoration')).toEqual(['!', 'M']);
		expect(document.querySelector('.scm-group .row.git-conflict .label')!.textContent).toBe('clash.ts');
		expect(conflicts).toBe(1);
		expect(statusMap.get('src/clash.ts')).toBe('!');
		expect(view.conflictedPaths()).toEqual(['src/clash.ts']);

		// A click opens the file itself (the editor's conflict toolbar), never a diff.
		click(document.querySelector('.scm-group .row.git-conflict'));
		expect(opened).toEqual([`${REPO}\\src\\clash.ts`]);
		expect(diffs).toEqual([]);

		// The row's stage action marks it resolved.
		click(document.querySelector('.scm-group .row.git-conflict [title="Stage Changes (Mark Resolved)"]'));
		await flush();
		expect(backend.callsTo('git_stage')).toEqual([{ paths: ['src/clash.ts'] }]);

		rightClick(document.querySelector('.scm-group .row.git-conflict'));
		expect(menuLabels()).toEqual([
			'Open in Merge Editor',
			'Open Timeline', 'Reveal in Explorer', 'Copy Path', 'Copy Relative Path',
			'Stage Changes (Mark Resolved)'
		]);
	});

	it('renders the groups, badges and decorations, and opens diffs / files on click', async () => {
		const { view } = setup();
		const diffs: string[] = [];
		const opened: string[] = [];
		let statusMap = new Map<string, string>();
		view.onOpenDiff = (d) => diffs.push(`${d.title}|${d.left.revision}>${d.right.revision}`);
		view.onOpenFile = (p) => opened.push(p);
		view.onStatus = (s) => { statusMap = s; };
		view.setRepo(REPO);
		view.setBranch('main');
		await view.refresh();

		expect(texts('.pane-header .label')).toEqual(['repo', 'Staged Changes', 'Changes']);
		expect(texts('.pane-header .badge')).toEqual(['4', '1', '3']);
		expect(texts('.scm-group .row .label')).toEqual(['main.ts', 'gone.txt', 'new.txt', 'README.md']);
		expect(texts('.scm-group .row .decoration')).toEqual(['M', 'D', 'U', 'M']);
		expect(document.querySelector('textarea')!.placeholder).toContain('on "main"');
		expect(statusMap.get('new.txt')).toBe('U');
		expect(statusMap.get('gone.txt')).toBe('D');

		const rows = Array.from(document.querySelectorAll<HTMLElement>('.scm-group .row'));
		click(rows[0]);
		click(rows[1]);
		click(rows[2]);
		click(rows[3]);
		expect(diffs).toEqual(['main.ts (Index)|HEAD>:index', 'gone.txt (Working Tree)|HEAD>*', 'README.md (Working Tree)|HEAD>*']);
		expect(opened).toEqual([`${REPO}\\new.txt`]);
	});

	it('multi-selects rows with Ctrl and Shift, and the row actions act on the whole selection', async () => {
		const { view } = setup();
		const diffs: string[] = [];
		view.onOpenDiff = (d) => diffs.push(d.id);
		view.setRepo(REPO);
		await view.refresh();
		const row = (label: string) => Array.from(document.querySelectorAll<HTMLElement>('.scm-group .row'))
			.find((r) => r.querySelector('.label')!.textContent === label)!;
		const selected = () => Array.from(document.querySelectorAll<HTMLElement>('.scm-group .row.selected'))
			.map((r) => r.querySelector('.label')!.textContent);

		// Ctrl toggles rows into the selection; picking files opens nothing.
		click(row('main.ts'), { ctrlKey: true });
		click(row('README.md'), { ctrlKey: true });
		expect(selected()).toEqual(['main.ts', 'README.md']);
		expect(diffs).toEqual([]);

		// Ctrl again takes a row back out.
		click(row('main.ts'), { ctrlKey: true });
		expect(selected()).toEqual(['README.md']);

		// Shift spans the flattened rows from the anchor (main.ts, just re-added) to the
		// click, across the group boundary.
		click(row('main.ts'), { ctrlKey: true });
		click(row('README.md'), { shiftKey: true });
		expect(selected()).toEqual(['main.ts', 'gone.txt', 'new.txt', 'README.md']);
		expect(diffs).toEqual([]);

		// The inline Stage of a selected row carries every picked unstaged path (the staged
		// pick keeps its own Unstage action).
		click(row('new.txt').querySelector('[title="Stage Changes"]')!);
		await flush();
		expect(backend.callsTo('git_stage')).toEqual([{ paths: ['gone.txt', 'new.txt', 'README.md'] }]);

		// The context menu of a selected row speaks for the selection too: one confirmation
		// naming the count, one backend write with the paths split tracked / untracked.
		rightClick(row('gone.txt'));
		click(menuItem('Discard Changes'));
		await flush();
		expect(notifications().at(-1)).toContain('discard changes in 3 files');
		click(notificationButton('Discard Changes'));
		await flush();
		expect(backend.callsTo('git_discard_all')).toEqual([{ restore: ['gone.txt', 'README.md'], clean: ['new.txt'] }]);

		// A plain click collapses the selection back to one row and opens it.
		click(row('main.ts'));
		expect(selected()).toEqual(['main.ts']);
		expect(diffs).toHaveLength(1);
	});

	it('refuses to write a path git cannot decode, and stages the rest of the list', async () => {
		const { view } = setup([
			// A name git reported with its decode-replacement character in it: no pathspec
			// matches the real file, so every write naming it is refused up front — in the
			// UI's language, before any backend command — while the representable rows
			// stage as usual.
			change('\u{FFFD}bad.txt', { untracked: true }),
			change('good.txt', { untracked: true })
		]);
		view.setRepo(REPO);
		await view.refresh();
		const row = (label: string) => Array.from(document.querySelectorAll<HTMLElement>('.scm-group .row'))
			.find((r) => r.querySelector('.label')!.textContent === label)!;

		click(row('\u{FFFD}bad.txt').querySelector('[title="Stage Changes"]')!);
		await flush();
		expect(backend.callsTo('git_stage')).toHaveLength(0);
		expect(notifications().at(-1)).toContain('U+FFFD');
		expect(notifications().at(-1)).toContain('\u{FFFD}bad.txt');

		// The single-path discard shape carries the same refusal (its own confirm first,
		// the write's guard behind it — nothing ever reaches the backend).
		rightClick(row('\u{FFFD}bad.txt'));
		click(menuItem('Discard Changes'));
		await flush();
		click(notificationButton('Delete file'));
		await flush();
		expect(backend.callsTo('git_discard')).toHaveLength(0);
		expect(notifications().at(-1)).toContain('U+FFFD');

		// A representable row stages as usual.
		click(row('good.txt').querySelector('[title="Stage Changes"]')!);
		await flush();
		expect(backend.callsTo('git_stage')).toEqual([{ paths: ['good.txt'] }]);
	});

	it('keeps the selection across a refresh that moves a file between groups', async () => {
		const { view, setChanges } = setup();
		view.setRepo(REPO);
		await view.refresh();
		const row = (label: string) => Array.from(document.querySelectorAll<HTMLElement>('.scm-group .row'))
			.find((r) => r.querySelector('.label')!.textContent === label)!;
		const selected = () => Array.from(document.querySelectorAll<HTMLElement>('.scm-group .row.selected'))
			.map((r) => r.querySelector('.label')!.textContent);

		// Two picks: one per group.
		click(row('main.ts'), { ctrlKey: true });
		click(row('README.md'), { ctrlKey: true });

		// The stage lands: README moves from Changes to Staged Changes, the other two
		// changes are gone.
		setChanges([
			change('src/main.ts', { staged: 'modified' }),
			change('README.md', { staged: 'modified' })
		]);
		await view.refresh();

		// README followed its group move; both staged rows stay picked — so the Unstage of
		// either carries both paths.
		expect(selected()).toEqual(['README.md', 'main.ts']);
		click(row('main.ts').querySelector('[title="Unstage Changes"]')!);
		await flush();
		expect(backend.callsTo('git_unstage')).toEqual([{ paths: ['README.md', 'src/main.ts'] }]);
	});

	it('stages, unstages and discards through the inline actions and asks before discarding', async () => {
		const { view } = setup();
		let changed = 0;
		view.onChanged = () => changed++;
		view.setRepo(REPO);
		await view.refresh();
		const readme = Array.from(document.querySelectorAll<HTMLElement>('.scm-group .row')).find((r) => r.textContent!.includes('README'))!;
		click(readme.querySelector('.codicon-add')!.parentElement);
		await flush();
		expect(backend.callsTo('git_stage')).toEqual([{ paths: ['README.md'] }]);
		const staged = document.querySelector<HTMLElement>('.scm-group .row')!;
		click(staged.querySelector('.codicon-remove')!.parentElement);
		await flush();
		expect(backend.callsTo('git_unstage')).toEqual([{ paths: ['src/main.ts'] }]);

		const untracked = Array.from(document.querySelectorAll<HTMLElement>('.scm-group .row')).find((r) => r.textContent!.includes('new.txt'))!;
		click(untracked.querySelector('.codicon-discard')!.parentElement);
		await flush();
		expect(notifications().at(-1)).toContain('DELETE new.txt');
		click(notificationButton('Delete file'));
		await flush();
		expect(backend.callsTo('git_discard')).toEqual([{ path: 'new.txt', untracked: true }]);

		click(document.querySelectorAll('.scm-group .pane-header .codicon-add')[0]!.parentElement);
		await flush();
		expect(backend.callsTo('git_stage_all')).toHaveLength(1);
		click(document.querySelector('.scm-group .pane-header .codicon-discard')!.parentElement);
		await flush();
		click(notificationButton('Discard All Changes'));
		await flush();
		expect(backend.callsTo('git_discard_all')).toHaveLength(1);
		expect(changed).toBeGreaterThanOrEqual(4);
	});

	it("an untracked discard's confirmation stays honest: the file goes to the trash, it is not lost forever", async () => {
		const { view } = setup([change('new.txt', { untracked: true })]);
		view.setRepo(REPO);
		await view.refresh();
		const row = Array.from(document.querySelectorAll<HTMLElement>('.scm-group .row'))
			.find((r) => r.textContent!.includes('new.txt'))!;
		click(row.querySelector('.codicon-discard')!.parentElement);
		await flush();
		expect(notifications().at(-1)).toContain('DELETE new.txt');
		expect(notifications().at(-1)).toContain('system trash');
		expect(notifications().at(-1)).not.toContain('IRREVERSIBLE');
		click(notificationButton('Delete file'));
		await flush();
		expect(backend.callsTo('git_discard')).toEqual([{ path: 'new.txt', untracked: true }]);
	});

	it('commits with Ctrl+Enter, smart-stages when nothing is staged, and amends', async () => {
		const { view, setChanges } = setup([change('a.txt', { unstaged: 'modified' })]);
		view.setRepo(REPO);
		await view.refresh();
		const textarea = document.querySelector<HTMLTextAreaElement>('textarea')!;
		// Live with changes to commit whatever the message says - the commit itself demands
		// one; gray is reserved for "nothing to commit".
		expect(document.querySelector<HTMLButtonElement>('.commit-row .button')!.disabled).toBe(false);
		key(textarea, 'Enter', { ctrlKey: true });
		await flush();
		expect(notifications().at(-1)).toContain('Please provide a commit message');

		type(textarea, 'Fix it');
		expect(document.querySelector<HTMLButtonElement>('.commit-row .button')!.disabled).toBe(false);
		key(textarea, 'Enter', { ctrlKey: true });
		await flush();
		expect(notifications().at(-1)).toContain('no staged changes');
		click(notificationButton('Yes'));
		await flush();
		expect(backend.callsTo('git_stage_all')).toHaveLength(1);
		expect(backend.callsTo('git_commit')).toEqual([{ message: 'Fix it', amend: false }]);
		expect(document.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('');

		setChanges([change('a.txt', { staged: 'modified' })]);
		await view.refresh();
		await view.commit({ amend: true });
		expect(backend.callsTo('git_commit').at(-1)).toEqual({ message: '', amend: true });
		await view.commit({ all: true });
		expect(notifications().at(-1)).toContain('Please provide a commit message');
		type(document.querySelector<HTMLTextAreaElement>('textarea')!, 'All');
		await view.commit({ all: true });
		expect(backend.callsTo('git_stage_all')).toHaveLength(2);
		expect(backend.callsTo('git_commit').at(-1)).toEqual({ message: 'All', amend: false });
	});

	it('refills the commit box with the undone commit\'s message after Undo Last Commit', async () => {
		const { view } = setup([change('a.txt', { staged: 'modified' })]);
		view.setRepo(REPO);
		await view.refresh();
		// The backend's answer is the undone commit's message; the box renders it (the
		// refresh re-renders the input), ready to re-word and re-commit.
		backend.on('scm_undo_last_commit', () => 'Fix the leak');
		await view.undoCommit();
		expect(backend.callsTo('scm_undo_last_commit')).toEqual([{}]);
		expect(view.message).toBe('Fix the leak');
		expect(document.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('Fix the leak');
	});

	it('routes the palette\'s Undo Last Commit through the view that owns the commit box', async () => {
		const { view, registry } = setup([change('a.txt', { staged: 'modified' })]);
		view.setRepo(REPO);
		await view.refresh();
		backend.on('scm_undo_last_commit', () => 'Redo me');
		await registry.execute('git.undoCommit');
		expect(backend.callsTo('scm_undo_last_commit')).toEqual([{}]);
		expect(document.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('Redo me');
	});

	it('offers the "..." menu VS Code offers, with submenus, tree view and sorting', async () => {
		const { view } = setup();
		view.setRepo(REPO);
		await view.refresh();
		click(document.querySelector('.scm-main-header .codicon-ellipsis')!.parentElement);
		expect(menuLabels()).toEqual([
			'View as Tree', 'View & Sort', 'Pull', 'Push', 'Clone', 'Checkout to...', 'Fetch',
			'Commit', 'Changes', 'Pull, Push', 'Branch', 'Remote', 'Stash', 'Tags', 'Show Git Output',
			'Amend Last Commit', 'Fetch commit-msg Hook (Gerrit)', 'Reset Current Branch to Remote (Soft)'
		]);
		hover(menuItem('Pull, Push'));
		expect(menuLabels()).toEqual([
			'Sync', 'Sync (Rebase)', 'Pull', 'Pull (Rebase)', 'Pull from...',
			'Push', 'Push to...', 'Push (Force With Lease)', 'Fetch', 'Fetch (Prune)', 'Fetch From...',
			'Push to Gerrit Ref for Current Branch (refs/for/...)'
		]);
		hover(menuItem('Branch'));
		expect(menuLabels()).toEqual(['Merge Branch...', 'Rebase Branch...', 'Abort Merge', 'Abort Rebase', 'Cherry-Pick...', 'Revert Commit...', 'Reset Current Branch to Commit...', 'Create Branch...', 'Create Branch From...', 'Rename Branch...', 'Delete Branch...', 'Delete Remote Branch...']);
		hover(menuItem('Stash'));
		expect(menuLabels()).toEqual(['Stash', 'Stash (Include Untracked)', 'Stash Staged', 'Apply Stash...', 'Apply Latest Stash', 'Pop Stash...', 'Pop Latest Stash', 'Drop Stash...']);
		hover(menuItem('View & Sort'));
		expect(menuLabels()).toEqual(['View as Tree', 'Sort by Name', 'Sort by Path', 'Sort by Status']);
		expect(menuItem('Sort by Path')!.querySelector('.codicon-check')).not.toBeNull();
		click(menuItem('Sort by Name'));
		expect(view.sort).toBe('name');
		expect(texts('.scm-group .row .label')).toEqual(['main.ts', 'gone.txt', 'new.txt', 'README.md']);

		click(document.querySelector('.scm-main-header .codicon-ellipsis')!.parentElement);
		click(menuItem('View as Tree'));
		expect(view.viewMode).toBe('tree');
		expect(texts('.scm-group .row .label')).toEqual(['src', 'main.ts', 'gone.txt', 'new.txt', 'README.md']);
		click(document.querySelector('.scm-folder'));
		expect(texts('.scm-group .row .label')).toEqual(['src', 'gone.txt', 'new.txt', 'README.md']);
		expect(localStorage.getItem('ggstudio.scmViewMode')).toBe('"tree"');
		click(document.querySelector('.scm-main-header .codicon-list-flat')!.parentElement);
		expect(view.viewMode).toBe('list');

		rightClick(document.querySelector('.scm-group .row'));
		expect(menuLabels()).toEqual([
			'Open File', 'Open Changes',
			'Open Timeline', 'Reveal in Explorer', 'Copy Path', 'Copy Relative Path',
			'Unstage Changes'
		]);
	});

	it('offers the row menu VS Code offers: the HEAD revision diff, the timeline, reveal, copy and the untracked extras', async () => {
		const { view } = setup();
		const history: string[] = [];
		const revealed: string[] = [];
		const diffs: string[] = [];
		view.onOpenHistory = (p) => history.push(p);
		view.onReveal = (p) => revealed.push(p);
		view.onOpenDiff = (d) => diffs.push(`${d.title}|${d.left.revision}>${d.right.revision}`);
		view.setRepo(REPO);
		await view.refresh();
		const row = (label: string) => Array.from(document.querySelectorAll<HTMLElement>('.scm-group .row'))
			.find((r) => r.querySelector('.label')!.textContent === label)!;

		// "Open Changes with Revision": the worktree file against HEAD, the staged and
		// unstaged halves of the change in one diff. Untracked rows have no HEAD side —
		// the entry is theirs to miss.
		rightClick(row('README.md'));
		expect(menuLabels()).toContain('Open Changes with Revision');
		click(menuItem('Open Changes with Revision'));
		expect(diffs).toEqual(['README.md (Working Tree)|HEAD>*']);
		rightClick(row('new.txt'));
		expect(menuLabels()).not.toContain('Open Changes with Revision');

		// The timeline opens the file's history tab; a deleted file reveals nothing.
		rightClick(row('README.md'));
		click(menuItem('Open Timeline'));
		expect(history).toEqual([`${REPO}\\README.md`]);
		rightClick(row('gone.txt'));
		expect(menuLabels()).not.toContain('Reveal in Explorer');
		rightClick(row('README.md'));
		click(menuItem('Reveal in Explorer'));
		expect(revealed).toEqual([`${REPO}\\README.md`]);

		// Both path spellings land on the clipboard — one file, or the whole selection.
		backend.clipboard.length = 0;
		rightClick(row('README.md'));
		click(menuItem('Copy Path'));
		expect(backend.clipboard).toEqual([`${REPO}\\README.md`]);
		backend.clipboard.length = 0;
		click(row('gone.txt'), { ctrlKey: true });
		rightClick(row('README.md'));
		click(menuItem('Copy Relative Path'));
		expect(backend.clipboard).toEqual(['gone.txt\nREADME.md']);

		// The untracked extras — ignore, rename, delete — belong to the untracked row
		// alone, and the tracked ones never see them.
		backend.on('read_file', () => { throw new Error('no ignore file yet'); });
		rightClick(row('new.txt'));
		expect(menuLabels()).toEqual([
			'Open File', 'Open Changes',
			'Open Timeline', 'Reveal in Explorer', 'Copy Path', 'Copy Relative Path',
			'Stage Changes', 'Discard Changes',
			'Add to .gitignore', 'Rename...', 'Delete File'
		]);
		rightClick(row('README.md'));
		expect(menuLabels()).not.toContain('Add to .gitignore');

		// A missing .gitignore is created; an existing one is appended to, its own
		// lines and line endings kept, duplicates never repeated.
		rightClick(row('new.txt'));
		click(menuItem('Add to .gitignore'));
		await flush();
		expect(backend.callsTo('write_file')).toEqual([{ path: `${REPO}\\.gitignore`, contents: 'new.txt\n', encoding: undefined, eol: 'lf' }]);
		backend.on('read_file', () => ({ contents: 'node_modules\r\n', binary: false, size: 13, eol: 'crlf' }));
		rightClick(row('new.txt'));
		click(menuItem('Add to .gitignore'));
		await flush();
		expect(backend.callsTo('write_file').at(-1)).toEqual({ path: `${REPO}\\.gitignore`, contents: 'node_modules\r\nnew.txt\r\n', encoding: undefined, eol: 'crlf' });

		// The rename keeps the folder and asks nothing twice; the delete answers the
		// DELETE confirm and sends the path to the trash.
		rightClick(row('new.txt'));
		click(menuItem('Rename...'));
		const quick = document.querySelector<HTMLInputElement>('.quick-input input')!;
		type(quick, 'renamed.txt');
		key(quick, 'Enter');
		await flush();
		expect(backend.callsTo('rename_path')).toEqual([{ from: `${REPO}\\new.txt`, to: `${REPO}\\renamed.txt` }]);
		rightClick(row('new.txt'));
		click(menuItem('Delete File'));
		expect(notifications().at(-1)).toContain('DELETE new.txt');
		click(notificationButton('Delete File'));
		await flush();
		expect(backend.callsTo('delete_path')).toEqual([{ path: `${REPO}\\new.txt`, permanent: false }]);
	});

	it('appends every selected untracked path in one write and refreshes the view out of the list', async () => {
		const { view } = setup([
			change('gone.txt', { unstaged: 'deleted' }),
			change('logs/trace.log', { untracked: true }),
			change('new.txt', { untracked: true }),
			change('README.md', { unstaged: 'modified' })
		]);
		view.setRepo(REPO);
		await view.refresh();
		let refreshed = 0;
		view.refresh = () => { refreshed++; return Promise.resolve(); };
		const row = (label: string) => Array.from(document.querySelectorAll<HTMLElement>('.scm-group .row'))
			.find((r) => r.querySelector('.label')!.textContent === label)!;
		// Both untracked rows picked: the batch menu carries the ignore entry alone —
		// rename and delete stay a single file's verbs.
		click(row('trace.log'), { ctrlKey: true });
		click(row('new.txt'), { ctrlKey: true });
		backend.on('read_file', () => { throw new Error('no ignore file yet'); });
		backend.on('write_file', () => null);
		rightClick(row('trace.log'));
		expect(menuLabels()).toEqual([
			'Open File', 'Open Changes',
			'Open Timeline', 'Reveal in Explorer', 'Copy Path', 'Copy Relative Path',
			'Stage Changes', 'Discard Changes',
			'Add to .gitignore'
		]);
		click(menuItem('Add to .gitignore'));
		await flush();
		// One append carries both paths in row order; the write is followed by the
		// view's own refresh (the ignored rows leave the list at once).
		expect(backend.callsTo('write_file')).toEqual([{ path: `${REPO}\\.gitignore`, contents: 'logs/trace.log\nnew.txt\n', encoding: undefined, eol: 'lf' }]);
		expect(refreshed).toBe(1);
	});

	it('notifies when the .gitignore write fails instead of failing silently', async () => {
		const { view } = setup();
		view.setRepo(REPO);
		await view.refresh();
		const row = (label: string) => Array.from(document.querySelectorAll<HTMLElement>('.scm-group .row'))
			.find((r) => r.querySelector('.label')!.textContent === label)!;
		// A missing .gitignore reads as empty (the create path); the write itself failing
		// — permissions, a read-only checkout — surfaces as an error notification.
		backend.on('write_file', () => { throw new Error('access denied'); });
		rightClick(row('new.txt'));
		click(menuItem('Add to .gitignore'));
		await flush();
		expect(notifications().at(-1)).toContain('access denied');
	});

	it('renders scm/title navigation entries as header buttons, and nothing else inline', async () => {
		const { view } = setup();
		view.setRepo(REPO);
		await view.refresh();
		// No installed extension contributes scm/title: the header carries only the view's own
		// actions — nothing of any extension is hardcoded into the app.
		expect(document.querySelector('.scm-main-header .actions img[alt=""]')).toBeNull();

		// An icon-less navigation command renders its title text — the button VS Code draws
		// when the manifest declares no icon; no empty image placeholder.
		applyContributions('test-view-ext', {
			commands: [{ command: 'test.view', title: 'View Test' }],
			menus: { 'scm/title': [{ command: 'test.view', group: 'navigation' }] }
		}, {}, () => undefined, () => true);
		view.setRepo(REPO); // re-render
		await view.refresh();
		expect([...document.querySelectorAll('.scm-main-header .actions .action-btn')].some((button) => button.textContent === 'View Test')).toBe(true);
		expect(document.querySelector('.scm-main-header .actions img[alt=""]')).toBeNull();

		// A manifest path-pair icon loads out of the package into the same button.
		removeContributions('test-view-ext');
		backend.on('ext_read_file_base64', () => 'aGk=');
		applyContributions('test-view-ext', {
			commands: [{ command: 'test.view', title: 'View Test', icon: { light: 'resources/light.svg', dark: 'resources/dark.svg' } }],
			menus: { 'scm/title': [{ command: 'test.view', group: 'navigation' }] }
		}, {}, () => undefined, () => true);
		view.setRepo(REPO);
		await view.refresh();
		await flush();
		expect(document.querySelector('.scm-main-header .actions img[alt=""]')).not.toBeNull();

		// A non-navigation group ("inline", "More Actions") tucks the entry into "..." instead.
		removeContributions('test-view-ext');
		applyContributions('test-view-ext', {
			commands: [{ command: 'test.view', title: 'View Test' }],
			menus: { 'scm/title': [{ command: 'test.view', group: 'inline' }] }
		}, {}, () => undefined, () => true);
		view.setRepo(REPO);
		await view.refresh();
		expect(document.querySelector('.scm-main-header .actions img[alt=""]')).toBeNull();
		click(document.querySelector('.scm-main-header .codicon-ellipsis')!.parentElement);
		expect(menuLabels()).toContain('View Test');
		removeContributions('test-view-ext');
	});
	it('runs a scm/resourceState/context entry with the resource state VS Code hands the command', async () => {
		const { view } = setup();
		applyContributions('test-history-ext', {
			commands: [{ command: 'test.filterByFile', title: 'Show File History in Test' }],
			menus: { 'scm/resourceState/context': [{ command: 'test.filterByFile', when: '!listMultiSelection' }] }
		}, {}, () => undefined, () => true);
		const dispatched: [string, unknown[] | undefined][] = [];
		view.onExtensionCommand = (command, args) => dispatched.push([command, args]);
		view.setRepo(REPO);
		await view.refresh();
		rightClick(document.querySelector('.scm-group .row'));
		expect(menuLabels()).toEqual([
			'Open File', 'Open Changes',
			'Open Timeline', 'Reveal in Explorer', 'Copy Path', 'Copy Relative Path',
			'Unstage Changes',
			'Show File History in Test'
		]);
		click(menuItem('Show File History in Test'));
		// VS Code's menu argument: a SourceControlResourceState whose `resourceUri` is a Uri.
		expect(dispatched).toEqual([['test.filterByFile', [{ resourceUri: contextUri(REPO + '\\src\\main.ts') }]]]);
		removeContributions('test-history-ext');
	});
	it('keeps the button gray with a clean, synced tree, and turns it into Push with unpushed commits', async () => {
		const { view, setChanges } = setup([]);
		view.setRepo(REPO);
		await view.refresh();
		let button = document.querySelector<HTMLButtonElement>('.commit-row.single .button')!;
		expect(button.textContent).toContain('Commit');
		expect(button.disabled).toBe(true);
		backend.on('scm_push', () => null);
		backend.on('repo_head', () => ({ branch: 'main', shortHash: 'abc1234', ahead: 3, behind: 0, upstream: 'origin/main' }));
		await view.refresh();
		button = document.querySelector<HTMLButtonElement>('.commit-row.single .button')!;
		expect(button.textContent).toContain('Push');
		expect(button.textContent).toContain('3');
		expect(button.disabled).toBe(false);
		setChanges([]);
		click(button);
		await flush();
		expect(backend.callsTo('scm_push')).toEqual([{ remote: null, setUpstream: false, force: false }]);
	});

	it('offers Commit & Push, and keeps the commit box focused with its caret across refreshes', async () => {
		backend.on('scm_push', () => null);
		backend.on('scm_sync', () => null);
		const { view } = setup([change('a.txt', { staged: 'modified' })]);
		let changed = 0;
		view.onChanged = () => changed++;
		view.setRepo(REPO);
		await view.refresh();

		const textarea = document.querySelector<HTMLTextAreaElement>('textarea')!;
		type(textarea, 'Ship it');
		textarea.focus();
		textarea.setSelectionRange(0, 0);
		await view.refresh();
		const rerendered = document.querySelector<HTMLTextAreaElement>('textarea')!;
		expect(document.activeElement).toBe(rerendered);
		expect(rerendered.selectionStart).toBe(0);
		expect(rerendered.selectionEnd).toBe(0);
		expect(rerendered.value).toBe('Ship it');

		click(document.querySelector('.commit-row .more')!);
		expect(menuLabels()).toEqual(['Commit', 'Commit & Push', 'Commit & Sync', 'Commit Staged', 'Commit All', 'Commit (Amend)', 'Commit Staged (Amend)', 'Commit (Signed Off)', 'Commit Staged (Signed Off)']);
		click(menuItem('Commit & Push'));
		await flush();
		expect(backend.callsTo('git_commit')).toEqual([{ message: 'Ship it', amend: false }]);
		expect(backend.callsTo('scm_push')).toEqual([{ remote: null, setUpstream: false, force: false }]);
		expect(changed).toBeGreaterThanOrEqual(2);

		type(document.querySelector<HTMLTextAreaElement>('textarea')!, 'Again');
		click(document.querySelector('.commit-row .more')!);
		click(menuItem('Commit & Sync'));
		await flush();
		expect(backend.callsTo('scm_sync')).toEqual([{ rebase: false }]);
	});
	it('commits with the Signed-off-by trailer through the more-commit menu', async () => {
		const { view } = setup([change('a.txt', { staged: 'modified' })]);
		view.setRepo(REPO);
		await view.refresh();
		type(document.querySelector<HTMLTextAreaElement>('textarea')!, 'Ship it');
		click(document.querySelector('.commit-row .more')!);
		click(menuItem('Commit (Signed Off)'));
		await flush();
		expect(backend.callsTo('git_commit').at(-1)).toEqual({ message: 'Ship it', amend: false, signoff: true });

		// The plain commit keeps the two-flag shape (no signoff key on the wire).
		type(document.querySelector<HTMLTextAreaElement>('textarea')!, 'Plain');
		click(document.querySelector('.commit-row .more')!);
		click(menuItem('Commit'));
		await flush();
		expect(backend.callsTo('git_commit').at(-1)).toEqual({ message: 'Plain', amend: false });
	});
	it('keeps the change list scrolled where the user left it across a refresh', async () => {
		const many = Array.from({ length: 60 }, (_, i) => change(`dir/file${i}.ts`, { unstaged: 'modified' }));
		const { view } = setup(many);
		view.setRepo(REPO);
		await view.refresh();

		// The user drags the list down. jsdom stores scrollTop with no layout, so model the
		// platform's real rule explicitly: a detached element has no scrolling box and reads
		// 0 (Chromium/WebKit) — a render that reads the old list's offset only after wiping
		// the pane captures 0 and the list jumps to the top.
		const list = document.querySelector<HTMLElement>('.scm-list')!;
		let offset = 440;
		Object.defineProperty(list, 'scrollTop', {
			configurable: true,
			get: () => (list.isConnected ? offset : 0),
			set: (value: number) => { offset = value; }
		});

		await view.refresh();

		const rebuilt = document.querySelector<HTMLElement>('.scm-list')!;
		expect(rebuilt).not.toBe(list);
		expect(rebuilt.scrollTop).toBe(440);
	});
	it('discards only the non-conflicted paths during a merge (git restore aborts on unmerged ones)', async () => {
		const { view } = setup([
			change('src/clash.ts', { staged: 'modified', unstaged: 'modified', conflicted: true }),
			change('README.md', { unstaged: 'modified' }),
			change('new.txt', { untracked: true })
		]);
		view.setRepo(REPO);
		await view.refresh();
		click(document.querySelector('.scm-group .pane-header .codicon-discard')!.parentElement);
		await flush();
		click(notificationButton('Discard All Changes'));
		await flush();
		// Explicit path lists: the conflicted file is neither restored nor cleaned.
		expect(backend.callsTo('git_discard_all')).toEqual([{ restore: ['README.md'], clean: ['new.txt'] }]);
	});

	it('counts only the non-conflicted changes in the discard-all confirmation', async () => {
		const { view } = setup([
			change('src/clash.ts', { staged: 'modified', unstaged: 'modified', conflicted: true }),
			change('README.md', { unstaged: 'modified' })
		]);
		view.setRepo(REPO);
		await view.refresh();
		click(document.querySelector('.scm-group .pane-header .codicon-discard')!.parentElement);
		await flush();
		expect(notifications().at(-1)).toContain('ALL 1 changes');
		click(notificationButton('Cancel'));
	});

	it('diffs a partially staged rename against the index at its new path', async () => {
		const { view } = setup([change('renamed.ts', { staged: 'modified', unstaged: 'modified', oldPath: 'old.ts' })]);
		const diffs: DiffRequest[] = [];
		view.onOpenDiff = (d) => diffs.push(d);
		view.setRepo(REPO);
		await view.refresh();
		const rows = Array.from(document.querySelectorAll<HTMLElement>('.scm-group .row'));
		click(rows[1]); // the working-tree side of the same file
		expect(diffs[0]!.left).toMatchObject({ revision: ':index', path: 'renamed.ts' });
		expect(diffs[0]!.right).toMatchObject({ revision: '*', path: 'renamed.ts' });
	});
	it('offers to initialize a repository when the open folder is not one', async () => {
		const { view, registry } = setup();
		let initialised = 0;
		registry.register({ id: 'git.initRepository', title: 'Initialize Repository', run: () => { initialised++; } });
		view.setRepo('C:\plain', false);
		const empty = document.querySelector('.welcome-view')!;
		expect(empty.textContent).toContain('plain is not a Git repository');
		const button = empty.querySelector('button') as HTMLButtonElement;
		expect(button.textContent).toContain('Initialize Repository');
		button.click();
		expect(initialised).toBe(1);

		// A repository folder renders the usual view instead.
		view.setRepo('C:\repo');
		expect(document.querySelector('.welcome-view button')).toBeNull();
	});

	it('a failing status read stops demanding refreshes once a refresh has failed too', async () => {
		const { view } = setup([]);
		view.setRepo(REPO);
		await view.refresh();
		// The backend's status read starts failing (a wedged index, a corrupted repo).
		backend.on('scm_status', () => { throw new Error('fatal: bad index'); });
		// After a healthy refresh, one failed read still errs toward "differs" - the
		// refresh is the recovery for a transient failure.
		await expect(view.statusDiffers()).resolves.toBe(true);
		// The recovery refresh itself fails and lands in the error state; a further
		// failing read must NOT demand another one: that cycle (refresh -> its own .git
		// echo batch -> re-check -> refresh) spins forever while git keeps failing.
		await view.refresh();
		await expect(view.statusDiffers()).resolves.toBe(false);
		// And git coming back is still picked up: a healthy read against the failed
		// refresh's empty snapshot differs, so the view recovers on the next batch.
		backend.on('scm_status', () => [change('src/main.ts', { unstaged: 'modified' })]);
		await expect(view.statusDiffers()).resolves.toBe(true);
	});

	it('a failed status refresh keeps the last known change list and shows the error', async () => {
		const { view, setChanges } = setup([
			change('src/main.ts', { staged: 'modified' }),
			change('README.md', { unstaged: 'modified' })
		]);
		view.setRepo(REPO);
		await view.refresh();
		// One transient failure (another git process holds the index) must not wipe the
		// last known list: the view keeps it, shows the error, and the next healthy
		// refresh clears the error and updates the rows.
		backend.on('scm_status', () => { throw new Error('fatal: index.lock: File exists'); });
		await view.refresh();
		expect(texts('.scm-rows .row .label')).toEqual(['main.ts', 'README.md']);
		expect(document.querySelector('.view-pane .error')!.textContent).toContain('index.lock');
		const healthy = [change('README.md', { unstaged: 'modified' })];
		backend.on('scm_status', () => healthy);
		await view.refresh();
		expect(texts('.scm-rows .row .label')).toEqual(['README.md']);
		expect(document.querySelector('.view-pane .error')).toBeNull();
	});

	it('serializes mutating runs: an overlapping second stage waits for the first', async () => {
		const { view } = setup();
		view.setRepo(REPO);
		await view.refresh();
		let inFlight = 0;
		let maxConcurrent = 0;
		backend.on('git_stage', async () => {
			inFlight++;
			maxConcurrent = Math.max(maxConcurrent, inFlight);
			await flush(3); // the spawn takes a few ticks
			inFlight--;
			return null;
		});
		// A double-click: two stage calls overlap, and the second must queue behind the
		// first instead of racing it into `index.lock: File exists`.
		const first = view.run('git_stage', { paths: ['a.txt'] });
		const second = view.run('git_stage', { paths: ['b.txt'] });
		await Promise.all([first, second]);
		await flush();
		expect(maxConcurrent).toBe(1);
		expect(backend.callsTo('git_stage')).toEqual([{ paths: ['a.txt'] }, { paths: ['b.txt'] }]);
	});

	it('the publish button asks which remote to publish to when the repository has several', async () => {
		const { view } = setup([]);
		backend.on('repo_head', () => ({ branch: 'main', shortHash: 'abc1234', ahead: 0, behind: 0, upstream: null }));
		backend.on('scm_remotes', () => [
			{ name: 'origin', url: 'https://example.com/r.git' },
			{ name: 'mirror', url: 'https://example.com/m.git' }
		]);
		backend.on('scm_push', () => null);
		view.setRepo(REPO);
		await view.refresh();
		const button = document.querySelector<HTMLButtonElement>('.commit-row.single .button')!;
		expect(button.textContent).toContain('Publish Branch');
		click(button);
		await flush();
		// Two remotes: the pick names the server the branch belongs on.
		const rows = Array.from(document.querySelectorAll<HTMLElement>('.quick-input .list .row'));
		expect(rows.map((r) => r.querySelector('.label')!.textContent)).toEqual(['origin', 'mirror']);
		click(rows.find((r) => r.textContent!.includes('mirror'))!);
		await flush();
		expect(backend.callsTo('scm_push')).toEqual([{ remote: 'mirror', setUpstream: true, force: false }]);

		// One remote keeps today's path: no pick, the backend's own choice rides the null.
		backend.calls.length = 0;
		backend.on('scm_remotes', () => [{ name: 'origin', url: 'https://example.com/r.git' }]);
		await view.refresh();
		click(document.querySelector<HTMLButtonElement>('.commit-row.single .button')!);
		await flush();
		expect(backend.callsTo('scm_push')).toEqual([{ remote: null, setUpstream: true, force: false }]);
	});

});

describe('submodule sections', () => {
	const SUB = 'C:\\repo\\vendor\\dep';

	function setup(options: { subUpstream?: string | null; subAhead?: number; subBehind?: number } = {}) {
		const mainChanges = [change('README.md', { unstaged: 'modified' })];
		let subChanges = [change('lib.rs', { staged: 'modified' })];
		const upstream = 'subUpstream' in options ? options.subUpstream : 'origin/main';
		backend.on('repo_submodules', () => [SUB]);
		backend.on('scm_status', (args) => (args['repo'] === SUB ? subChanges : mainChanges));
		backend.on('repo_head', (args) => (args['repo'] === SUB
			? { branch: 'main', shortHash: 'dead123', ahead: options.subAhead ?? 0, behind: options.subBehind ?? 0, upstream }
			: { branch: 'main', shortHash: 'abc1234', ahead: 0, behind: 0, upstream: 'origin/main' }));
		for (const command of ['git_stage', 'git_unstage', 'git_stage_all', 'git_unstage_all', 'git_discard', 'git_discard_all', 'git_commit', 'scm_push', 'scm_sync']) {
			backend.on(command, () => null);
		}
		const view = new SourceControlView(document.getElementById('sidebar')!, new CommandRegistry());
		return { view, setSubChanges: (c: typeof subChanges) => { subChanges = c; } };
	}

	it('renders every initialised submodule as its own repository section, scoped to its own changes', async () => {
		const { view } = setup();
		view.setRepo(REPO);
		await view.refresh();

		const repoHeaders = Array.from(document.querySelectorAll<HTMLElement>('.scm-repo-header .label'));
		expect(repoHeaders.map((h) => h.textContent)).toEqual(['dep']);
		const subSection = document.querySelector('.scm-repo')!;
		expect(subSection.querySelector('.scm-repo-branch')!.textContent).toContain('main');
		expect(texts('.scm-repo .pane-header .label')).toEqual(['dep', 'Staged Changes', 'Changes']);
		expect(subSection.querySelector('.row .label')!.textContent).toBe('lib.rs');
		// The main repository's own list is untouched: only the submodule's change shows there.
		expect(texts('.scm-rows .row .label')).toEqual(['README.md']);
	});

	it('stacks the submodule sections inside the change list, compactly below the main repository\'s rows', async () => {
		const { view } = setup();
		view.setRepo(REPO);
		await view.refresh();

		// VS Code's multi-repo Source Control view: the sections follow the content above them
		// in the one scrolling list (never pinned to the bottom of the view by a stretched
		// main section), and the virtualised main list keeps its own spacer.
		const list = document.querySelector('.scm-list')!;
		expect(list.querySelector('.scm-repo')).not.toBeNull();
		expect(document.querySelector('.view-pane > .scm-repo')).toBeNull();
		expect(document.querySelector('.scm-rows')!.nextElementSibling).toBe(document.querySelector('.scm-repo'));
	});

	it('dispatches the scm/title button with the section\'s repository as VS Code\'s SourceControl argument', async () => {
		const { view } = setup();
		const dispatched: [string, unknown[] | undefined][] = [];
		view.onExtensionCommand = (command, args) => dispatched.push([command, args]);
		view.setRepo(REPO);
		await view.refresh();

		applyContributions('test-view-ext', {
			commands: [{ command: 'test.view', title: 'View Test' }],
			menus: { 'scm/title': [{ command: 'test.view', group: 'navigation' }] }
		}, {}, () => undefined, () => true);
		view.render();
		const subIcon = document.querySelector<HTMLButtonElement>('.scm-repo-header .action-btn')!;
		click(subIcon);
		// VS Code's scm/title argument: the SourceControl object, whose `rootUri` is what a
		// "view this repository" command reads to switch the repository it shows.
		expect(dispatched).toEqual([['test.view', [{ rootUri: contextUri(SUB) }]]]);
		const mainIcon = document.querySelector<HTMLButtonElement>('.scm-main-header .action-btn')!;
		click(mainIcon);
		expect(dispatched).toEqual([['test.view', [{ rootUri: contextUri(SUB) }]], ['test.view', [{ rootUri: contextUri(REPO) }]]]);
		removeContributions('test-view-ext');
	});
	it('stages a change within a submodule, passing its own repo path', async () => {
		const { view, setSubChanges } = setup();
		setSubChanges([change('lib.rs', { unstaged: 'modified' })]);
		view.setRepo(REPO);
		await view.refresh();

		const subSection = document.querySelector('.scm-repo')!;
		click(subSection.querySelector('.row .codicon-add')!.parentElement);
		await flush();
		expect(backend.callsTo('git_stage')).toEqual([{ paths: ['lib.rs'], repo: SUB }]);
	});

	it('right-clicks a submodule\'s uncommitted file to the same context menu as the main repository\'s row', async () => {
		const { view, setSubChanges } = setup();
		setSubChanges([change('lib.rs', { unstaged: 'modified' })]);
		view.setRepo(REPO);
		await view.refresh();

		const subSection = document.querySelector('.scm-repo')!;
		rightClick(subSection.querySelector('.row'));
		// The sub-repo row carries the same additions the main repository's row does,
		// minus what cannot follow it: no timeline (the editor's history page rides the
		// workspace root), the paths and the reveal absolute to the submodule.
		expect(menuLabels()).toEqual([
			'Open File', 'Open Changes', 'Open Changes with Revision',
			'Reveal in Explorer', 'Copy Path', 'Copy Relative Path',
			'Stage Changes', 'Discard Changes'
		]);
		click(menuItem('Stage Changes'));
		await flush();
		expect(backend.callsTo('git_stage')).toEqual([{ paths: ['lib.rs'], repo: SUB }]);
	});

	it('offers a submodule\'s untracked file the ignore extras, writing the sub-repo\'s own .gitignore', async () => {
		const { view, setSubChanges } = setup();
		setSubChanges([change('gen.rs', { untracked: true })]);
		view.setRepo(REPO);
		await view.refresh();
		const subSection = document.querySelector('.scm-repo')!;
		rightClick(subSection.querySelector('.row'));
		expect(menuLabels()).toEqual([
			'Open File', 'Open Changes',
			'Reveal in Explorer', 'Copy Path', 'Copy Relative Path',
			'Stage Changes', 'Discard Changes',
			'Add to .gitignore', 'Rename...', 'Delete File'
		]);
		click(menuItem('Add to .gitignore'));
		await flush();
		// The write lands in the submodule's root, not the workspace's.
		expect(backend.callsTo('write_file')).toEqual([{ path: `${SUB}\\.gitignore`, contents: 'gen.rs\n', encoding: undefined, eol: 'lf' }]);
	});

	it('keeps the main repository\'s selection out of a submodule row\'s ignore targets', async () => {
		const { view } = setup();
		// The main repository holds a same-path file: its selection id collides with the
		// sub-repo row's, and the sub row's extras must not inherit the main picks — they
		// would append the main repository's paths to the submodule's .gitignore.
		backend.on('scm_status', (args) => (args['repo'] === SUB
			? [change('lib.rs', { untracked: true })]
			: [change('README.md', { unstaged: 'modified' }), change('lib.rs', { untracked: true }), change('scratch.txt', { untracked: true })]));
		view.setRepo(REPO);
		await view.refresh();
		const mainRow = (label: string) => Array.from(document.querySelectorAll<HTMLElement>('.scm-rows .row'))
			.find((r) => r.querySelector('.label')!.textContent === label)!;
		click(mainRow('lib.rs'), { ctrlKey: true });
		click(mainRow('scratch.txt'), { ctrlKey: true });
		backend.on('read_file', () => { throw new Error('no ignore file yet'); });
		backend.on('write_file', () => null);
		rightClick(document.querySelector('.scm-repo .row'));
		click(menuItem('Add to .gitignore'));
		await flush();
		// Only the sub-repo's own path lands in its ignore file — never the main picks.
		expect(backend.callsTo('write_file')).toEqual([{ path: `${SUB}\\.gitignore`, contents: 'lib.rs\n', encoding: undefined, eol: 'lf' }]);
	});

	it('keeps the main repository\'s selection out of a submodule row\'s copied paths', async () => {
		const { view } = setup();
		// Same collision as the ignore targets above, on the nav cluster: the sub-repo
		// row's Copy Path must speak for itself, never for the main repository's picks.
		backend.on('scm_status', (args) => (args['repo'] === SUB
			? [change('lib.rs', { unstaged: 'modified' })]
			: [change('README.md', { unstaged: 'modified' }), change('lib.rs', { untracked: true }), change('scratch.txt', { untracked: true })]));
		view.setRepo(REPO);
		await view.refresh();
		const mainRow = (label: string) => Array.from(document.querySelectorAll<HTMLElement>('.scm-rows .row'))
			.find((r) => r.querySelector('.label')!.textContent === label)!;
		click(mainRow('lib.rs'), { ctrlKey: true });
		click(mainRow('scratch.txt'), { ctrlKey: true });
		rightClick(document.querySelector('.scm-repo .row'));
		click(menuItem('Copy Path'));
		await flush();
		expect(backend.clipboard).toEqual([`${SUB}\\lib.rs`]);
	});

	it('commits within a submodule, passing its own repo path', async () => {
		const { view } = setup(); // the default fixture's lib.rs is already staged
		view.setRepo(REPO);
		await view.refresh();

		const subSection = document.querySelector('.scm-repo')!;
		const textarea = subSection.querySelector<HTMLTextAreaElement>('textarea')!;
		type(textarea, 'Update dep');
		click(subSection.querySelector('.commit-row .button')!);
		await flush();
		expect(backend.callsTo('git_commit')).toEqual([{ message: 'Update dep', amend: false, repo: SUB }]);
	});

	it('refills the submodule\'s commit box with the undone commit\'s message', async () => {
		const { view } = setup();
		view.setRepo(REPO);
		await view.refresh();

		backend.on('scm_undo_last_commit', (args) => (args['repo'] === SUB ? 'Bump dep' : 'Main'));
		const sub = view.subRepos[0]!;
		await view.subUndoCommit(sub);
		expect(backend.callsTo('scm_undo_last_commit')).toEqual([{ repo: SUB }]);
		expect(sub.message).toBe('Bump dep');
		expect(document.querySelector('.scm-repo')!.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('Bump dep');
	});

	it('turns the submodule\'s button into Publish Branch once its tree is clean and the branch is unpublished', async () => {
		const { view, setSubChanges } = setup({ subUpstream: null });
		setSubChanges([]);
		view.setRepo(REPO);
		await view.refresh();
		const button = document.querySelector<HTMLButtonElement>('.scm-repo .commit-row.single .button')!;
		expect(button.textContent).toContain('Publish Branch');
		expect(button.disabled).toBe(false);
		click(button);
		await flush();
		expect(backend.callsTo('scm_push')).toEqual([{ remote: null, setUpstream: true, force: false, repo: SUB }]);
	});

	it('pushes from the same button once the submodule has nothing to commit but unpushed commits', async () => {
		const { view, setSubChanges } = setup({ subUpstream: 'origin/main', subAhead: 2 });
		setSubChanges([]);
		view.setRepo(REPO);
		await view.refresh();
		const button = document.querySelector<HTMLButtonElement>('.scm-repo .commit-row.single .button')!;
		expect(button.textContent).toContain('Push');
		expect(button.textContent).toContain('2');
		click(button);
		await flush();
		expect(backend.callsTo('scm_push')).toEqual([{ remote: null, setUpstream: false, force: false, repo: SUB }]);
	});

	it('syncs from the same button once the submodule diverged from its upstream', async () => {
		const { view, setSubChanges } = setup({ subUpstream: 'origin/main', subAhead: 2, subBehind: 1 });
		setSubChanges([]);
		view.setRepo(REPO);
		await view.refresh();
		const button = document.querySelector<HTMLButtonElement>('.scm-repo .commit-row.single .button')!;
		expect(button.textContent).toContain('Sync Changes');
		click(button);
		await flush();
		expect(backend.callsTo('scm_sync')).toEqual([{ rebase: false, repo: SUB }]);
	});

	it('grays the submodule\'s commit button once a clean tree has nothing to commit, push or pull', async () => {
		const { view, setSubChanges } = setup({ subUpstream: 'origin/main', subAhead: 0, subBehind: 0 });
		setSubChanges([]);
		view.setRepo(REPO);
		await view.refresh();
		const button = document.querySelector<HTMLButtonElement>('.scm-repo .commit-row.single .button')!;
		expect(button.textContent).toContain('Commit');
		expect(button.disabled).toBe(true);
	});

	it('rests a detached, clean submodule at the gray Commit - its recorded commit has no branch to publish', async () => {
		const { view, setSubChanges } = setup({ subUpstream: null });
		setSubChanges([]);
		backend.on('repo_head', (args) => (args['repo'] === SUB
			? { branch: null, shortHash: 'f43634a', ahead: 0, behind: 0, upstream: null }
			: { branch: 'main', shortHash: 'abc1234', ahead: 0, behind: 0, upstream: 'origin/main' }));
		view.setRepo(REPO);
		await view.refresh();
		const button = document.querySelector<HTMLButtonElement>('.scm-repo .commit-row.single .button')!;
		expect(button.textContent).toContain('Commit');
		expect(button.textContent).not.toContain('Publish');
		expect(button.disabled).toBe(true);
	});

	it('collapses a submodule section by clicking its header, keeping the others open', async () => {
		const { view } = setup();
		view.setRepo(REPO);
		await view.refresh();
		expect(document.querySelector('.scm-repo-body')).not.toBeNull();
		click(document.querySelector('.scm-repo-header')!);
		expect(document.querySelector('.scm-repo-body')).toBeNull();
	});

	it('aggregates the badge count and conflict count across the main repository and its submodules', async () => {
		const { view } = setup();
		let count = -1;
		let conflicts = -1;
		view.onCount = (n) => { count = n; };
		view.onConflicts = (n) => { conflicts = n; };
		view.setRepo(REPO);
		await view.refresh();
		expect(count).toBe(2); // one main change, one submodule change
		expect(conflicts).toBe(0);
	});
});

describe('git ref-name and target validation', () => {
	// The battery mirrors the Rust side's (ggs-git's is_safe_ref_name), and both were
	// pinned against the real `git check-ref-format` (git 2.50.1.windows.1, one call per
	// line) — the validator must agree with git in both directions.
	it('isSafeRefName matches git check-ref-format', () => {
		const accepted = [
			'main', 'v1.0.0', 'feature.x', 'feature/foo', 'a/b/c', 'refs',
			'refs/heads/@',       // an @ component is legal
			'foo./bar',           // a component ending in '.' mid-name is legal
			'a/foo.lock./b',      // …and so is one ending in '.lock.'
			'a/@b/c', 'a/b@/c', 'a/@@/b', 'f@oo', 'a@b', '@oo', 'fo@', 'a@@b',
			'a]b/c', 'foo-', 'trail'
		];
		const rejected = [
			'',                 // empty
			'@',                // the revision-syntax token alone
			'-dash',            // git refuses a leading dash; our spawn would too
			'.hidden', 'refs/.hidden', 'a/.hidden', 'a/./b',   // a component may not start with '.'
			'foo.lock', 'foo.lock/bar', 'a/@.lock/b',          // …nor end with '.lock'
			'refs//heads',      // no empty component
			'a..b', 'a../b', 'b/..a', 'x/a..b/z',              // no consecutive dots anywhere
			'a@{b', 'refs/heads/a@{b',                          // no reflog sequence anywhere
			'a b', 'a b/c',                                     // no space
			'a~b', 'a^b', 'a:b', 'a?b', 'a*b', 'a[b', 'a\\b',   // no ~ ^ : ? * [ \ anywhere
			'/lead', '/lead/x', 'trail/', 'trail/x/',           // no leading or trailing slash
			'trail.', 'trail/x.'                                // the name may not end with '.'
		];
		for (const name of accepted) expect(isSafeRefName(name)).toBe(true);
		for (const name of rejected) expect(isSafeRefName(name)).toBe(false);
	});

	it('validateTarget takes revision expressions and refuses only the impossible shapes', () => {
		expect(validateTarget('HEAD~1')).toBeNull();
		expect(validateTarget('HEAD^')).toBeNull();
		expect(validateTarget('main@{yesterday}')).toBeNull();
		expect(validateTarget('abc1234def')).toBeNull();
		expect(validateTarget('')).not.toBeNull();
		expect(validateTarget('   ')).not.toBeNull();
		expect(validateTarget('-force')).not.toBeNull();
		expect(validateTarget('HEAD~1 extra')).not.toBeNull();
	});
});

describe('git commands', () => {
	function setup() {
		const registry = new CommandRegistry();
		const commits: Record<string, unknown>[] = [];
		const undos: number[] = [];
		const host: GitCommandHost = {
			repoPath: () => REPO,
			repoChanged: () => undefined,
			openFolder: async () => undefined,
			showOutput: () => undefined,
			graphSettings: () => ({}),
			commit: async (options) => { commits.push(options ?? {}); },
			undoCommit: async () => { undos.push(undos.length); }
		};
		registerGitCommands(registry, host);
		return { registry, commits, undos };
	}

	it('checkouts branches and tags picked from one list, excluding the current branch', async () => {
		backend.on('scm_branches', () => [
			{ name: 'main', remote: false, current: true, upstream: 'origin/main' },
			{ name: 'feature', remote: false, current: false, upstream: null },
			{ name: 'origin/main', remote: true, current: false, upstream: null }
		]);
		backend.on('scm_tags', () => ['v1.0.0']);
		backend.on('scm_checkout', () => null);
		const { registry } = setup();

		const executing = registry.execute('git.checkout');
		await flush();
		const rows = Array.from(document.querySelectorAll<HTMLElement>('.quick-input .list .row'));
		expect(rows.map((r) => r.querySelector('.label')!.textContent)).toEqual(['feature', 'origin/main', 'v1.0.0', 'Checkout a commit (detached)...']);
		expect(rows[0]!.querySelector('.codicon-git-branch')).not.toBeNull();
		expect(rows[1]!.querySelector('.codicon-cloud')).not.toBeNull();
		expect(rows[2]!.querySelector('.codicon-tag')).not.toBeNull();

		click(rows.find((r) => r.textContent!.includes('v1.0.0'))!);
		await executing;
		await flush();
		expect(backend.callsTo('scm_checkout')).toEqual([{ name: 'v1.0.0' }]);
	});

	it('reports when there is nothing to checkout', async () => {
		backend.on('scm_branches', () => [{ name: 'main', remote: false, current: true, upstream: null }]);
		backend.on('scm_tags', () => []);
		const { registry } = setup();
		await registry.execute('git.checkout');
		await flush();
		expect(notifications().at(-1)).toContain('no branches or tags');
		expect(backend.callsTo('scm_checkout')).toHaveLength(0);
	});

	it('the picker\'s trailing affordance confirms the detached HEAD and takes a commit hash', async () => {
		backend.on('scm_branches', () => [
			{ name: 'main', remote: false, current: true, upstream: null },
			{ name: 'dev', remote: false, current: false, upstream: null }
		]);
		backend.on('scm_tags', () => []);
		backend.on('scm_checkout', () => null);
		const { registry } = setup();

		const executing = registry.execute('git.checkout');
		await flush();
		const rows = Array.from(document.querySelectorAll<HTMLElement>('.quick-input .list .row'));
		expect(rows.map((r) => r.querySelector('.label')!.textContent)).toEqual(['dev', 'Checkout a commit (detached)...']);
		click(rows.find((r) => r.textContent!.includes('detached'))!);
		await flush();
		// The detached-HEAD explanation stands between the pick and the hash.
		expect(notifications().at(-1)).toContain('detaches HEAD');
		// A garbage input is refused before anything is invoked.
		click(notificationButton('Checkout (Detached)'));
		await flush();
		const quick = document.querySelector<HTMLInputElement>('.quick-input input')!;
		type(quick, 'not-a-hash!');
		key(quick, 'Enter');
		await flush();
		expect(backend.callsTo('scm_checkout')).toHaveLength(0);
		// A hash passes and checks out (the backend resolves it detached).
		type(quick, 'abc1234def');
		key(quick, 'Enter');
		await executing;
		await flush();
		expect(backend.callsTo('scm_checkout')).toEqual([{ name: 'abc1234def' }]);
	});

	it('cherry-pick takes a commit-ish, refusing only the shapes that could never be one', async () => {
		backend.on('scm_cherry_pick', () => 'The picked change');
		const { registry } = setup();

		const executing = registry.execute('git.cherryPick');
		await flush();
		const quick = document.querySelector<HTMLInputElement>('.quick-input input')!;
		// A leading dash is refused before anything is invoked: it would ride the spawn as
		// an option. Revision expressions pass now — the backend resolves the expression
		// against git and reports git's own complaint when it names nothing.
		type(quick, '-force');
		key(quick, 'Enter');
		await flush();
		expect(backend.callsTo('scm_cherry_pick')).toHaveLength(0);
		expect(document.querySelector('.quick-input .hint')!.textContent).toContain('commit hash');
		type(quick, 'HEAD~1');
		key(quick, 'Enter');
		await executing;
		await flush();
		expect(backend.callsTo('scm_cherry_pick')).toEqual([{ target: 'HEAD~1' }]);
		expect(notifications().at(-1)).toContain('Cherry-picked: The picked change');
	});

	it('revert commit asks the same way and reports the inverse commit', async () => {
		backend.on('scm_revert_commit', () => 'Revert "base"');
		const { registry } = setup();

		const executing = registry.execute('git.revertCommit');
		await flush();
		const quick = document.querySelector<HTMLInputElement>('.quick-input input')!;
		type(quick, 'HEAD');
		key(quick, 'Enter');
		await executing;
		await flush();
		expect(backend.callsTo('scm_revert_commit')).toEqual([{ target: 'HEAD' }]);
		expect(notifications().at(-1)).toContain('Reverted: Revert "base"');
	});

	it('reset to commit picks the mode, and hard demands the second irreversible confirm', async () => {
		backend.on('scm_reset_ref', () => null);
		const { registry } = setup();

		const executing = registry.execute('git.resetToCommit');
		await flush();
		let quick = document.querySelector<HTMLInputElement>('.quick-input input')!;
		type(quick, 'abc1234');
		key(quick, 'Enter');
		await flush();
		const rows = Array.from(document.querySelectorAll<HTMLElement>('.quick-input .list .row'));
		expect(rows.map((r) => r.querySelector('.label')!.textContent)).toEqual(['Soft', 'Mixed', 'Hard']);
		click(rows[2]!);
		await flush();
		// Hard carries the same irreversible wording the discard-all confirm carries.
		expect(notifications().at(-1)).toContain('IRREVERSIBLE');
		click(notificationButton('Reset (Hard)'));
		await executing;
		await flush();
		expect(backend.callsTo('scm_reset_ref')).toEqual([{ target: 'abc1234', mode: 'hard' }]);

		// Soft runs straight from the pick, no second confirm.
		const soft = registry.execute('git.resetToCommit');
		await flush();
		quick = document.querySelector<HTMLInputElement>('.quick-input input')!;
		type(quick, 'abc1234');
		key(quick, 'Enter');
		await flush();
		const modeRows = Array.from(document.querySelectorAll<HTMLElement>('.quick-input .list .row'));
		click(modeRows[0]!);
		await soft;
		await flush();
		expect(backend.callsTo('scm_reset_ref')).toEqual([
			{ target: 'abc1234', mode: 'hard' },
			{ target: 'abc1234', mode: 'soft' }
		]);
	});

	it('delete branch deletes a merged branch through the safe -d after the plain confirm', async () => {
		backend.on('scm_branches', () => [
			{ name: 'main', remote: false, current: true, upstream: null },
			{ name: 'topic', remote: false, current: false, upstream: null }
		]);
		backend.on('scm_branch_merged', () => true);
		backend.on('scm_delete_branch', () => null);
		const { registry } = setup();

		const executing = registry.execute('git.deleteBranch');
		await flush();
		const rows = Array.from(document.querySelectorAll<HTMLElement>('.quick-input .list .row'));
		click(rows.find((r) => r.textContent!.includes('topic'))!);
		await flush();
		expect(notifications().at(-1)).toContain("Delete the branch 'topic'");
		click(notificationButton('Delete Branch'));
		await executing;
		await flush();
		expect(backend.callsTo('scm_branch_merged')).toEqual([{ branchName: 'topic' }]);
		expect(backend.callsTo('scm_delete_branch')).toEqual([{ branchName: 'topic', force: false }]);
	});

	it('delete branch offers the force delete with the irreversible wording for an unmerged branch', async () => {
		backend.on('scm_branches', () => [
			{ name: 'main', remote: false, current: true, upstream: null },
			{ name: 'topic', remote: false, current: false, upstream: null }
		]);
		backend.on('scm_branch_merged', () => false);
		backend.on('scm_delete_branch', () => null);
		const { registry } = setup();

		const executing = registry.execute('git.deleteBranch');
		await flush();
		const rows = Array.from(document.querySelectorAll<HTMLElement>('.quick-input .list .row'));
		click(rows.find((r) => r.textContent!.includes('topic'))!);
		await flush();
		expect(notifications().at(-1)).toContain('not fully merged');
		expect(notifications().at(-1)).toContain('IRREVERSIBLE');
		// Cancelling keeps the branch.
		click(notificationButton('Cancel'));
		await executing;
		await flush();
		expect(backend.callsTo('scm_delete_branch')).toHaveLength(0);

		const again = registry.execute('git.deleteBranch');
		await flush();
		const rows2 = Array.from(document.querySelectorAll<HTMLElement>('.quick-input .list .row'));
		click(rows2.find((r) => r.textContent!.includes('topic'))!);
		await flush();
		click(notificationButton('Delete Anyway'));
		await again;
		await flush();
		expect(backend.callsTo('scm_delete_branch')).toEqual([{ branchName: 'topic', force: true }]);
	});

	it('push to offers the remote\'s own branches and pushes the chosen one', async () => {
		backend.on('scm_remotes', () => [{ name: 'origin', url: 'https://example.com/r.git' }]);
		backend.on('scm_branches', () => [
			{ name: 'main', remote: false, current: true, upstream: 'origin/main' },
			{ name: 'origin/main', remote: true, current: false, upstream: null },
			{ name: 'origin/feature', remote: true, current: false, upstream: null }
		]);
		backend.on('scm_push_branch', () => null);
		const { registry } = setup();

		const executing = registry.execute('git.pushTo');
		await flush();
		// One remote answers without its own pick; the second step lists the remote's
		// branches under the names the remote spells them.
		const rows = Array.from(document.querySelectorAll<HTMLElement>('.quick-input .list .row'));
		expect(rows.map((r) => r.querySelector('.label')!.textContent)).toEqual(['main', 'feature']);
		click(rows[0]!);
		await executing;
		await flush();
		expect(backend.callsTo('scm_push_branch')).toEqual([{ remote: 'origin', branch: 'main', force: false }]);
	});

	it('delete remote branch picks the remote and its branch, confirming the irreversible deletion', async () => {
		backend.on('scm_remotes', () => [{ name: 'origin', url: 'https://example.com/r.git' }]);
		backend.on('scm_branches', () => [
			{ name: 'main', remote: false, current: true, upstream: 'origin/main' },
			{ name: 'origin/main', remote: true, current: false, upstream: null },
			{ name: 'origin/feature', remote: true, current: false, upstream: null }
		]);
		backend.on('scm_delete_remote_branch', () => null);
		const { registry } = setup();

		const executing = registry.execute('git.deleteRemoteBranch');
		await flush();
		// One remote answers without its own pick; the second step lists the remote's own
		// branches (the remote-tracking names as the view lists them).
		const rows = Array.from(document.querySelectorAll<HTMLElement>('.quick-input .list .row'));
		expect(rows.map((r) => r.querySelector('.label')!.textContent)).toEqual(['origin/main', 'origin/feature']);
		click(rows.find((r) => r.textContent!.includes('origin/feature'))!);
		await flush();
		expect(notifications().at(-1)).toContain('IRREVERSIBLE');
		// Cancelling keeps the remote branch.
		click(notificationButton('Cancel'));
		await executing;
		await flush();
		expect(backend.callsTo('scm_delete_remote_branch')).toHaveLength(0);

		const again = registry.execute('git.deleteRemoteBranch');
		await flush();
		const rows2 = Array.from(document.querySelectorAll<HTMLElement>('.quick-input .list .row'));
		click(rows2.find((r) => r.textContent!.includes('origin/feature'))!);
		await flush();
		click(notificationButton('Delete Remote Branch'));
		await again;
		await flush();
		expect(backend.callsTo('scm_delete_remote_branch')).toEqual([{ remote: 'origin', branch: 'feature' }]);
		expect(notifications().at(-1)).toContain("Deleted the remote branch 'feature'");
	});

	it('delete remote tag picks the tag and the remote, confirming the deletion', async () => {
		backend.on('scm_tags', () => ['v1', 'v2']);
		backend.on('scm_remotes', () => [
			{ name: 'origin', url: 'https://example.com/r.git' },
			{ name: 'mirror', url: 'https://example.com/m.git' }
		]);
		backend.on('scm_delete_remote_tag', () => null);
		const { registry } = setup();

		const executing = registry.execute('git.deleteRemoteTag');
		await flush();
		const rows = Array.from(document.querySelectorAll<HTMLElement>('.quick-input .list .row'));
		expect(rows.map((r) => r.querySelector('.label')!.textContent)).toEqual(['v1', 'v2']);
		click(rows.find((r) => r.textContent!.includes('v2'))!);
		await flush();
		// Two remotes: the second pick chooses the one the tag is deleted from.
		const remotes = Array.from(document.querySelectorAll<HTMLElement>('.quick-input .list .row'));
		expect(remotes.map((r) => r.querySelector('.label')!.textContent)).toEqual(['origin', 'mirror']);
		click(remotes.find((r) => r.textContent!.includes('mirror'))!);
		await flush();
		expect(notifications().at(-1)).toContain('IRREVERSIBLE');
		click(notificationButton('Delete Remote Tag'));
		await executing;
		await flush();
		expect(backend.callsTo('scm_delete_remote_tag')).toEqual([{ remote: 'mirror', tagName: 'v2' }]);
	});

	it('All Remotes lists every remote and copies a URL or deletes the picked one', async () => {
		backend.on('scm_remotes', () => [
			{ name: 'origin', url: 'https://example.com/r.git' },
			{ name: 'mirror', url: 'https://example.com/m.git' }
		]);
		backend.on('scm_delete_remote', () => null);
		const { registry } = setup();

		const executing = registry.execute('git.listRemotes');
		await flush();
		// The pick lists every remote, its URL beside the name.
		const rows = Array.from(document.querySelectorAll<HTMLElement>('.quick-input .list .row'));
		expect(rows.map((r) => r.querySelector('.label')!.textContent)).toEqual(['origin', 'mirror']);
		click(rows.find((r) => r.textContent!.includes('mirror'))!);
		await flush();
		// The chosen remote's own actions: copy its URL first.
		const actions = Array.from(document.querySelectorAll<HTMLElement>('.quick-input .list .row'));
		expect(actions.map((r) => r.querySelector('.label')!.textContent)).toEqual(['Copy URL', 'Delete']);
		click(actions.find((r) => r.textContent!.includes('Copy URL'))!);
		await executing;
		await flush();
		expect(backend.clipboard.at(-1)).toBe('https://example.com/m.git');

		const again = registry.execute('git.listRemotes');
		await flush();
		const rows2 = Array.from(document.querySelectorAll<HTMLElement>('.quick-input .list .row'));
		click(rows2.find((r) => r.textContent!.includes('origin'))!);
		await flush();
		const actions2 = Array.from(document.querySelectorAll<HTMLElement>('.quick-input .list .row'));
		click(actions2.find((r) => r.textContent!.includes('Delete'))!);
		await again;
		await flush();
		expect(backend.callsTo('scm_delete_remote')).toEqual([{ name: 'origin' }]);
	});

	it('push with no upstream and several remotes asks which one to publish to', async () => {
		backend.on('repo_head', () => ({ branch: 'main', shortHash: 'abc1234', hash: 'd'.repeat(40), ahead: 0, behind: 0, upstream: null }));
		backend.on('scm_remotes', () => [
			{ name: 'origin', url: 'https://example.com/r.git' },
			{ name: 'mirror', url: 'https://example.com/m.git' }
		]);
		backend.on('scm_push', () => null);
		const { registry } = setup();

		const executing = registry.execute('git.push');
		await flush();
		const rows = Array.from(document.querySelectorAll<HTMLElement>('.quick-input .list .row'));
		expect(rows.map((r) => r.querySelector('.label')!.textContent)).toEqual(['origin', 'mirror']);
		click(rows.find((r) => r.textContent!.includes('mirror'))!);
		await executing;
		await flush();
		expect(backend.callsTo('scm_push')).toEqual([{ remote: 'mirror', setUpstream: false, force: false }]);

		// An upstream already set (or a single remote) keeps the plain push: no pick.
		backend.calls.length = 0;
		backend.on('repo_head', () => ({ branch: 'main', shortHash: 'abc1234', hash: 'd'.repeat(40), ahead: 0, behind: 0, upstream: 'origin/main' }));
		await registry.execute('git.push');
		await flush();
		expect(backend.callsTo('scm_push')).toEqual([{ remote: null, setUpstream: false, force: false }]);
	});

	it('create tag names the full head hash, never the short display prefix', async () => {
		const full = 'c'.repeat(40);
		backend.on('repo_head', () => ({ branch: 'main', shortHash: full.slice(0, 7), hash: full, ahead: 0, behind: 0, upstream: 'origin/main' }));
		const { registry } = setup();

		const executing = registry.execute('git.createTag');
		await flush();
		const name = document.querySelector<HTMLInputElement>('.quick-input input')!;
		type(name, 'v9');
		key(name, 'Enter');
		await flush();
		const message = document.querySelector<HTMLInputElement>('.quick-input input')!;
		type(message, 'release nine');
		key(message, 'Enter');
		await executing;
		await flush();
		expect(backend.callsTo('scm_add_tag')).toEqual([{ tagName: 'v9', commitHash: full, message: 'release nine', force: false }]);
	});

	it('abort merge guards on the in-progress state and confirms before aborting', async () => {
		backend.on('scm_operation_state', () => ({ merge: false, rebase: false }));
		const { registry } = setup();
		await registry.execute('git.mergeAbort');
		await flush();
		expect(notifications().at(-1)).toContain('no merge in progress');
		expect(backend.callsTo('scm_abort_merge')).toHaveLength(0);

		backend.on('scm_operation_state', () => ({ merge: true, rebase: false }));
		backend.on('scm_abort_merge', () => null);
		const executing = registry.execute('git.mergeAbort');
		await flush();
		expect(notifications().at(-1)).toContain('pre-merge state');
		click(notificationButton('Abort Merge'));
		await executing;
		await flush();
		expect(backend.callsTo('scm_abort_merge')).toEqual([{}]);
	});

	it('abort rebase runs the same guard for a pending rebase', async () => {
		backend.on('scm_operation_state', () => ({ merge: false, rebase: true }));
		backend.on('scm_abort_rebase', () => null);
		const { registry } = setup();
		const executing = registry.execute('git.rebaseAbort');
		await flush();
		expect(notifications().at(-1)).toContain('pre-rebase state');
		click(notificationButton('Abort Rebase'));
		await executing;
		await flush();
		expect(backend.callsTo('scm_abort_rebase')).toEqual([{}]);

		// An idle repository answers a plain info instead of aborting anything.
		backend.on('scm_operation_state', () => ({ merge: false, rebase: false }));
		await registry.execute('git.rebaseAbort');
		await flush();
		expect(notifications().at(-1)).toContain('no rebase in progress');
		expect(backend.callsTo('scm_abort_rebase')).toHaveLength(1);
	});

	it('push tags picks the remote and pushes the local tags to it', async () => {
		backend.on('scm_remotes', () => [
			{ name: 'origin', url: 'https://example.com/r.git' },
			{ name: 'mirror', url: 'https://example.com/m.git' }
		]);
		backend.on('scm_push_tags', () => null);
		const { registry } = setup();

		const executing = registry.execute('git.pushTags');
		await flush();
		const rows = Array.from(document.querySelectorAll<HTMLElement>('.quick-input .list .row'));
		expect(rows.map((r) => r.querySelector('.label')!.textContent)).toEqual(['origin', 'mirror']);
		click(rows.find((r) => r.textContent!.includes('mirror'))!);
		await executing;
		await flush();
		expect(backend.callsTo('scm_push_tags')).toEqual([{ remote: 'mirror' }]);
		expect(notifications().at(-1)).toContain('Tags pushed to mirror');
	});

	it('the signed-off commit commands hand the option through to the view commit', async () => {
		const { registry, commits } = setup();
		await registry.execute('git.commitSignedOff');
		await registry.execute('git.commitStagedSignedOff');
		await registry.execute('git.commitAllSignedOff');
		await registry.execute('git.commitAmendSignedOff');
		await registry.execute('git.commitStagedAmendSignedOff');
		expect(commits).toEqual([
			{ signoff: true },
			{ signoff: true, stagedOnly: true },
			{ signoff: true, all: true },
			{ signoff: true, amend: true },
			{ signoff: true, amend: true, stagedOnly: true }
		]);
	});

	it('stage all tracked / untracked changes reach their backend halves', async () => {
		backend.on('git_stage_all_tracked', () => null);
		backend.on('git_stage_all_untracked', () => null);
		const { registry } = setup();
		await registry.execute('git.stageAllTracked');
		await registry.execute('git.stageAllUntracked');
		expect(backend.callsTo('git_stage_all_tracked')).toEqual([{}]);
		expect(backend.callsTo('git_stage_all_untracked')).toEqual([{}]);
	});

	it('undo last commit routes through the view that owns the commit box', async () => {
		const { registry, undos } = setup();
		await registry.execute('git.undoCommit');
		expect(undos).toHaveLength(1);
	});
});
