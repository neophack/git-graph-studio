// Scenario fixtures for the harness: scripted backend data modelling the git states (and the
// non-git folders) the app must handle - each one is "a repository in a situation", answered
// the way the real backend would answer it. The scenario harness boots the real workbench
// against each and asserts what the user would see; the run writes a markdown report.

export type Handler = (args: Record<string, unknown>) => unknown;

import { encodeRawFile } from './tauriMock';

export interface Scenario {
	/** The report's row id. */
	name: string;
	/** Repository or plain folder. */
	kind: 'git' | 'plain';
	/** One line describing the modelled situation (the report's "what it covers"). */
	situation: string;
	/** The scripted backend; layered over the common base. */
	handlers: [string, Handler][];
}

interface Change {
	path: string;
	oldPath: string | null;
	staged: string | null;
	unstaged: string | null;
	untracked: boolean;
	conflicted?: boolean;
}

interface Head {
	repo: string;
	branch: string | null;
	shortHash: string;
	ahead: number;
	behind: number;
	upstream: string | null;
}

const COMMIT = {
	hash: '0123456789abcdef0123456789abcdef01234567', parents: [],
	author: 'Fixture', email: 'fix@example.org', date: 1700000000000,
	message: 'initial commit', heads: ['main'], tags: [], remotes: [], stash: null
};

/** The handlers every scenario shares (a folder with two files and the graph's frame data). */
/** The folder every scenario opens (the workbench's boot re-opens it through open_folder). */
export const SCENARIO_ROOT = 'C:\\repo';

export function commonHandlers(): [string, Handler][] {
	return [
		['boot_stage', () => null],
		['analysis_status', () => ({ state: 'ready', done: 3, total: 3, files: 3, symbols: 8, calls: 5 })],
		['analysis_module_graph', () => ({ modules: [], edges: [], fileEdges: [], totalCalls: 0, totalFileEdges: 0 })],
		['analysis_metrics', ({ onEvent }) => { (onEvent as { onmessage: (e: unknown) => void }).onmessage({ kind: 'done', files: 3, functions: 8, cancelled: false }); return null; }],
		['analysis_dead_code', ({ onEvent }) => { (onEvent as { onmessage: (e: unknown) => void }).onmessage({ kind: 'done', found: 0, cancelled: false }); return null; }],
		['analysis_security', ({ onEvent }) => { (onEvent as { onmessage: (e: unknown) => void }).onmessage({ kind: 'done', files: 3, findings: 0, cancelled: false }); return null; }],
		['analysis_import_graph', () => ({ edges: [], cycles: [] })],
		['analysis_rebuild', () => ({ state: 'ready', done: 3, total: 3, files: 3, symbols: 8, calls: 5 })],
		['initial_file', () => null],
		['initial_repo', () => SCENARIO_ROOT],
		['open_folder', ({ path }) => ({ root: path, isRepo: true })],
		['read_file', ({ path }) => ({
			contents: String(path).endsWith('conflicted.txt')
				? 'ours\n<<<<<<< HEAD\nours line\n=======\ntheirs line\n>>>>>>> feature\ncommon\n'
				: 'one two one\n',
			binary: false, size: 12
		})],
		['read_file_at', () => ({ contents: 'one\n', binary: false, size: 3 })],
		['write_file', () => null],
		['list_dir', ({ path }) => {
			if (String(path).endsWith('src')) return [{ name: 'main.rs', path: `${path}\\main.rs`, isDir: false, size: 10 }];
			return [
				{ name: 'src', path: `${path}\\src`, isDir: true, size: 0 },
				{ name: 'notes.txt', path: `${path}\\notes.txt`, isDir: false, size: 12 },
				{ name: 'conflicted.txt', path: `${path}\\conflicted.txt`, isDir: false, size: 40 }
			];
		}],
		['list_files', () => ['notes.txt', 'src/main.rs']],
		['repo_head', () => ({ repo: 'repo', branch: 'main', shortHash: '0123456', ahead: 0, behind: 0, upstream: null })],
		['scm_status', () => []],
		['scm_branches', () => [{ name: 'main', current: true, remote: false, upstream: null }]],
		['scm_remotes', () => []],
		['scm_tags', () => []],
		['scm_stashes', () => []],
		['git_output_log', () => []],
		['ext_list', () => []],
		['settings_read', () => null],
		['keybindings_read', () => null],
		['keybindings_write', () => null],
		['backup_list', () => []],
		['search_workspace', ({ onEvent }) => {
			(onEvent as { onmessage: (e: unknown) => void }).onmessage({ kind: 'done', scanned: 0, truncated: false, cancelled: false });
			return null;
		}],
		['search_cancel', () => null],
		['viewer_open', () => ({ docId: 1, lineCount: 1, language: 'plaintext', syntaxName: 'Plain Text', symbols: [] })],
		['viewer_close', () => null],
		['workspace_symbols', () => []],
		['find_references', () => []],
		['pty_create', () => 1], ['pty_write', () => null], ['pty_kill', () => null],
		['graph_request', ({ message }) => {
			const command = (message as { command: string }).command;
			if (command === 'loadRepoInfo') {
				return { command, branches: ['main'], head: COMMIT.hash, remotes: [], stashes: [], isRepo: true, operationState: { type: null, conflictedFiles: [], progress: null }, error: null };
			}
			if (command === 'loadCommits') {
				return { command, commits: [COMMIT], head: COMMIT.hash, tags: [], moreCommitsAvailable: false, onlyFollowFirstParent: false, gerritStates: null, error: null };
			}
			if (command === 'loadConfig') {
				return { command, config: { branches: {}, authors: [], diffTool: null, guiDiffTool: null, pushDefault: null, remotes: [], user: { name: { local: null, global: null }, email: { local: null, global: null } } }, error: null };
			}
			return { command, error: null };
		}]
	];
}

const status = (changes: Change[]): [string, Handler] => ['scm_status', () => changes];
const head = (info: Partial<Head>): [string, Handler] => ['repo_head', () => ({ repo: 'repo', branch: 'main', shortHash: '0123456', ahead: 0, behind: 0, upstream: null, ...info })];

/** The situations the harness covers. */
export const SCENARIOS: Scenario[] = [
	{
		name: 'empty-repository', kind: 'git',
		situation: 'git init, no commits yet: no branch name, an empty graph, nothing to commit',
		handlers: [
			head({ branch: null, shortHash: '' }),
			['graph_request', () => ({ command: 'loadRepoInfo', branches: [], head: null, remotes: [], stashes: [], isRepo: true, operationState: { type: null, conflictedFiles: [], progress: null }, error: null })]
		]
	},
	{
		name: 'clean-repository', kind: 'git',
		situation: 'one commit on main, a clean working tree: a branch, a graph, an empty Changes group',
		handlers: []
	},
	{
		name: 'mixed-changes', kind: 'git',
		situation: 'a staged edit, an unstaged edit, an untracked file and a deletion at once',
		handlers: [
			status([
				{ path: 'src/main.rs', oldPath: null, staged: 'M', unstaged: null, untracked: false },
				{ path: 'notes.txt', oldPath: null, staged: null, unstaged: 'M', untracked: false },
				{ path: 'new.txt', oldPath: null, staged: null, unstaged: null, untracked: true },
				{ path: 'gone.txt', oldPath: null, staged: null, unstaged: 'D', untracked: false }
			])
		]
	},
	{
		name: 'merge-conflict', kind: 'git',
		situation: 'a merge stopped on conflicts: the Merge Changes group, the status bar count, the conflict toolbar in the file',
		handlers: [
			status([
				{ path: 'conflicted.txt', oldPath: null, staged: null, unstaged: 'U', untracked: false, conflicted: true },
				{ path: 'notes.txt', oldPath: null, staged: null, unstaged: 'M', untracked: false }
			]),
			['graph_request', ({ message }) => {
				const command = (message as { command: string }).command;
				if (command === 'loadRepoInfo') {
					return { command, branches: ['main'], head: COMMIT.hash, remotes: [], stashes: [], isRepo: true, operationState: { type: 'merge', conflictedFiles: ['conflicted.txt'], progress: null }, error: null };
				}
				return { command, error: null, commits: [COMMIT] };
			}]
		]
	},
	{
		name: 'detached-head', kind: 'git',
		situation: 'a checkout of a raw commit: no branch, the short hash in the status bar',
		handlers: [head({ branch: null, shortHash: '0123456', upstream: null })]
	},
	{
		name: 'ahead-and-behind', kind: 'git',
		situation: 'two local commits pushed nowhere, three fetched: the sync counts in the status bar',
		handlers: [head({ ahead: 2, behind: 3, upstream: 'origin/main' })]
	},
	{
		name: 'branches-and-tags', kind: 'git',
		situation: 'several local and remote branches plus annotated tags around one commit',
		handlers: [
			['scm_branches', () => [
				{ name: 'main', current: true, remote: false, upstream: 'origin/main' },
				{ name: 'feature/x', current: false, remote: false, upstream: null },
				{ name: 'origin/main', current: false, remote: true, upstream: null }
			]],
			['scm_tags', () => ['v1.0.0', 'v1.1.0-rc1']]
		]
	},
	{
		name: 'stash-present', kind: 'git',
		situation: 'a stashed change waiting in the stash list',
		handlers: [['scm_stashes', () => [{ index: 0, selector: 'stash@{0}', message: 'wip: experiments' }]]]
	},
	{
		name: 'plain-folder', kind: 'plain',
		situation: 'a folder with files and no .git anywhere: explorer and editor work, the git views stand down',
		handlers: [['open_folder', ({ path }) => ({ root: path, isRepo: false })]]
	},
	{
		name: 'empty-folder', kind: 'plain',
		situation: 'a freshly created, completely empty folder',
		handlers: [
			['open_folder', ({ path }) => ({ root: path, isRepo: false })],
			['list_dir', () => []],
			['list_files', () => []]
		]
	}
];

/** Every open_folder is a repository except the plain scenarios say otherwise. */
export function handlersFor(scenario: Scenario): Map<string, Handler> {
	const map = new Map<string, Handler>(commonHandlers());
	if (!map.has('open_folder')) map.set('open_folder', ({ path }) => ({ root: path, isRepo: scenario.kind === 'git' }));
	for (const [command, handler] of scenario.handlers) map.set(command, handler);
	// The defaulting layer: an unscripted command answers null (a write that succeeded),
	// except `read_file_raw`, which the scripted `read_file` answers over the raw channel.
	const read = map.get('read_file');
	return new (class extends Map<string, Handler> {
		override get(command: string) {
			if (command === 'read_file_raw' && !super.has(command) && read) {
				return (args) => encodeRawFile(read(args) as Parameters<typeof encodeRawFile>[0]);
			}
			return super.get(command) ?? (() => null);
		}
	})(map);
}
