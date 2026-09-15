import { describe, expect, it } from 'vitest';

import { CommandRegistry } from '../src/commands';
import { applyContributions, removeContributions } from '../src/contributions';
import { registerGitCommands, type GitCommandHost } from '../src/gitCommands';
import { buildChangeTree, DiffRequest, SourceControlView, sortChanges } from '../src/scm';
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
			commit: (options) => view.commit(options)
		};
		registerGitCommands(registry, host);
		// The "..." menu's Amend/Gerrit entries (and the Git Graph title button's Inline/More
		// Actions placement) come from the extension's own manifest (contributions.ts), the
		// same way the real Workbench wires the built-in git-graph-rs: the manifest ids
		// dispatch to gitCommands.ts's working `gitGraph.*` implementations.
		removeContributions('git-graph-rs');
		const scmCommands: Record<string, { impl: string; title: string }> = {
			'git-graph-rs.amendLastCommit': { impl: 'gitGraph.amendLastCommit', title: 'Amend Last Commit' },
			'git-graph-rs.gerritFetchCommitMsgHook': { impl: 'gitGraph.gerritFetchCommitMsgHook', title: 'Fetch commit-msg Hook (Gerrit)' },
			'git-graph-rs.resetCurrentBranchToRemote': { impl: 'gitGraph.resetCurrentBranchToRemote', title: 'Reset Current Branch to Remote (Soft)' },
			'git-graph-rs.gerritPushRef': { impl: 'gitGraph.gerritPushRef', title: 'Push to Gerrit Ref for Current Branch (refs/for/...)' }
		};
		applyContributions(
			'git-graph-rs',
			{
				commands: Object.entries(scmCommands).map(([command, { title }]) => ({ command, title })),
				menus: { 'scm/title': Object.keys(scmCommands).map((command, index) => ({ command, group: `git-graph-rs@${index}` })) }
			},
			{},
			(command) => void registry.execute(scmCommands[command]!.impl),
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
		expect(menuLabels()).toEqual(['Open in Merge Editor', 'Stage Changes (Mark Resolved)']);
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

	it('commits with Ctrl+Enter, smart-stages when nothing is staged, and amends', async () => {
		const { view, setChanges } = setup([change('a.txt', { unstaged: 'modified' })]);
		view.setRepo(REPO);
		await view.refresh();
		const textarea = document.querySelector<HTMLTextAreaElement>('textarea')!;
		expect(document.querySelector<HTMLButtonElement>('.commit-row .button')!.disabled).toBe(true);
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

	it('offers the "..." menu VS Code offers, with submenus, tree view and sorting', async () => {
		const { view } = setup();
		view.setRepo(REPO);
		await view.refresh();
		click(document.querySelector('.sidebar-title .codicon-ellipsis')!.parentElement);
		expect(menuLabels()).toEqual([
			'View as Tree', 'View & Sort', 'Pull', 'Push', 'Clone', 'Checkout to...', 'Fetch',
			'Commit', 'Changes', 'Pull, Push', 'Branch', 'Remote', 'Stash', 'Tags', 'Show Git Output',
			'Amend Last Commit', 'Fetch commit-msg Hook (Gerrit)', 'Reset Current Branch to Remote (Soft)', 'Push to Gerrit Ref for Current Branch (refs/for/...)'
		]);
		hover(menuItem('Branch'));
		expect(menuLabels()).toEqual(['Merge Branch...', 'Rebase Branch...', 'Create Branch...', 'Create Branch From...', 'Rename Branch...', 'Delete Branch...']);
		hover(menuItem('Stash'));
		expect(menuLabels()).toEqual(['Stash', 'Stash (Include Untracked)', 'Apply Stash...', 'Apply Latest Stash', 'Pop Stash...', 'Pop Latest Stash', 'Drop Stash...']);
		hover(menuItem('View & Sort'));
		expect(menuLabels()).toEqual(['View as Tree', 'Sort by Name', 'Sort by Path', 'Sort by Status']);
		expect(menuItem('Sort by Path')!.querySelector('.codicon-check')).not.toBeNull();
		click(menuItem('Sort by Name'));
		expect(view.sort).toBe('name');
		expect(texts('.scm-group .row .label')).toEqual(['main.ts', 'gone.txt', 'new.txt', 'README.md']);

		click(document.querySelector('.sidebar-title .codicon-ellipsis')!.parentElement);
		click(menuItem('View as Tree'));
		expect(view.viewMode).toBe('tree');
		expect(texts('.scm-group .row .label')).toEqual(['src', 'main.ts', 'gone.txt', 'new.txt', 'README.md']);
		click(document.querySelector('.scm-folder'));
		expect(texts('.scm-group .row .label')).toEqual(['src', 'gone.txt', 'new.txt', 'README.md']);
		expect(localStorage.getItem('ggstudio.scmViewMode')).toBe('"tree"');
		click(document.querySelector('.sidebar-title .codicon-list-flat')!.parentElement);
		expect(view.viewMode).toBe('list');

		rightClick(document.querySelector('.scm-group .row'));
		expect(menuLabels()).toEqual(['Open File', 'Open Changes', 'Unstage Changes']);
	});

	it('places the Git Graph title button following the manifest\'s scm/title placement, not hardcoded', async () => {
		const { view } = setup();
		view.setRepo(REPO);
		await view.refresh();
		// No contribution registered for git-graph-rs.view at all: the icon shows by default
		// (git-graph-rs.sourceCodeProviderIntegrationLocation's own default is "Inline").
		expect(document.querySelector('.sidebar-title .actions img[alt=""]')).not.toBeNull();

		applyContributions('test-view-ext', {
			commands: [{ command: 'git-graph-rs.view', title: 'View Git Graph' }],
			menus: { 'scm/title': [{ command: 'git-graph-rs.view', group: 'inline' }] } // "More Actions"
		}, {}, () => undefined, () => true);
		view.setRepo(REPO); // re-render
		await view.refresh();
		expect(document.querySelector('.sidebar-title .actions img[alt=""]')).toBeNull();
		click(document.querySelector('.sidebar-title .codicon-ellipsis')!.parentElement);
		expect(menuLabels()).toContain('View Git Graph');
		removeContributions('test-view-ext');
	});

	it('shows "Show File History in Git Graph" on a change\'s context menu when the manifest declares it', async () => {
		const { view } = setup();
		applyContributions('test-history-ext', {
			commands: [{ command: 'git-graph-rs.filterByFile', title: 'Show File History in Git Graph' }],
			menus: { 'scm/resourceState/context': [{ command: 'git-graph-rs.filterByFile', when: '!listMultiSelection' }] }
		}, {}, () => undefined, () => true);
		const shown: string[] = [];
		view.onShowFileHistory = (path) => shown.push(path);
		view.setRepo(REPO);
		await view.refresh();
		rightClick(document.querySelector('.scm-group .row'));
		expect(menuLabels()).toEqual(['Open File', 'Open Changes', 'Unstage Changes', 'Show File History in Git Graph']);
		click(menuItem('Show File History in Git Graph'));
		expect(shown).toEqual([`${REPO}\\src\\main.ts`]);
		removeContributions('test-history-ext');
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
		expect(menuLabels()).toEqual(['Commit', 'Commit & Push', 'Commit & Sync', 'Commit Staged', 'Commit All', 'Commit (Amend)', 'Commit Staged (Amend)']);
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

});

describe('git commands', () => {
	function setup() {
		const registry = new CommandRegistry();
		const host: GitCommandHost = {
			repoPath: () => REPO,
			repoChanged: () => undefined,
			openFolder: async () => undefined,
			showOutput: () => undefined,
			graphSettings: () => ({}),
			commit: async () => undefined
		};
		registerGitCommands(registry, host);
		return { registry };
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
		expect(rows.map((r) => r.querySelector('.label')!.textContent)).toEqual(['feature', 'origin/main', 'v1.0.0']);
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
});
