// Hosts the Git Graph webview (static/gitgraph/view.html) in an iframe and plays the extension
// host's part for it: composes `initialState` from the extension's own config code plus the
// stored view/repo state, forwards read and write requests to the Rust backend, and serves
// the requests that belong to the shell itself - opening files and diffs in the editor, the
// terminal, dialogs, view state, code reviews, settings - so the unmodified webview has every
// action it has inside VS Code.
//
// This is deliberately the app's ONLY module that consumes the extension's TypeScript
// artifacts at runtime: the webview bundle (loaded by the view page), the config bundle
// (gitgraph/config.js = the extension's compiled src/config.ts, exposed as
// window.GitGraphStudioConfig by scripts/prepare.mjs) and the comparison page generator
// (gitgraph/compare.js, built from the extension's own compiled src/comparisonView.ts - see
// CompareHost below). The Rust counterpart of this seam is src-tauri/src/cmd_graph.rs, the one
// module that talks to git-graph-core.

import { invoke } from '@tauri-apps/api/core';
import { save as saveDialog } from '@tauri-apps/plugin-dialog';
import { openUrl } from '@tauri-apps/plugin-opener';

import type { DiffRequest } from './scm';
import { THEME_EVENT, themeById } from './settings';
import * as state from './state';
import { basename, el, joinPath, notify, toPosix } from './ui';

declare global {
	interface Window {
		GitGraphStudioConfig?: (settings: Record<string, unknown>) => Record<string, unknown>;
	}
}

/* ---------- The Commit Comparison page (the extension's own view, hosted) ---------- */

/** One file entry of the comparison the page renders. */
interface CompareFileChange {
	oldFilePath: string;
	newFilePath: string;
	type: string;
	additions: number | null;
	deletions: number | null;
}

/** The extension's compiled page generator (scripts/compare-bundle.mjs, driven by
 *  scripts/prepare.mjs, builds it from out/comparisonView.js — its `getHtml` template over a
 *  stubbed panel). */
declare global {
	interface Window {
		GitGraphCompare?: { buildComparePage(options: Record<string, unknown>): string };
	}
}

/* ---------- Where the graph's assets come from ---------- */

/** The id of the theme-token stylesheet the host injects into the view page. */
const HOST_THEME_LINK_ID = 'ggs-host-theme';

function hostThemeLink(css: string): string {
	return `<link id="${HOST_THEME_LINK_ID}" rel="stylesheet" href="${css}" />`;
}

let compareGenerator: Promise<void> | null = null;

/** Load the extension's comparison page generator once per document. A generator that is
 *  already present (tests pre-set it) resolves at once. */
function loadCompareGenerator(): Promise<void> {
	if (window.GitGraphCompare) return Promise.resolve();
	compareGenerator ??= loadGitGraphScript('compare.js', 'The Git Graph comparison page generator (gitgraph/compare.js) did not load');
	return compareGenerator;
}

/** Run one of the app's /gitgraph/ script assets (config.js is on the page already via
 *  index.html; compare.js loads here) in the document. */
function loadGitGraphScript(name: string, failure: string): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const script = document.createElement('script');
		script.src = '/gitgraph/' + name;
		script.onload = () => resolve();
		script.onerror = () => reject(new Error(failure));
		document.head.appendChild(script);
	});
}

/** The comparison view is not part of the webview bundle: the extension generates its whole
 *  page (styles and script inline) from extension-host code. This host does what the extension
 *  host does with it - the loading page first, the page with the fetched data once it lands,
 *  and the page's requests answered over the same graph_request channel - so Studio shows the
 *  extension's real comparison UI. */
export class CompareHost {
	readonly frame: HTMLIFrameElement;
	private changes: CompareFileChange[] = [];
	private disposed = false;
	private binaryNotified = false;
	private countsSettled = false;
	private readonly onMessage = (event: MessageEvent): void => this.handlePageMessage(event);

	constructor(
		private readonly container: HTMLElement,
		private readonly input: { fromHash: string; toHash: string; singleCommit: boolean; repo?: string },
		private readonly delegate: { openDiff(diff: DiffRequest): void }
	) {
		this.frame = document.createElement('iframe');
		this.frame.title = 'Commit Comparison';
		this.container.appendChild(this.frame);
		window.addEventListener('message', this.onMessage);
		void this.load();
	}

	dispose(): void {
		this.disposed = true;
		window.removeEventListener('message', this.onMessage);
	}

	/** The extension host's own load: the comparison, the header's summary cards and the
	 *  commits-between count, fetched in parallel, the page swapped in when they land. */
	private async load(): Promise<void> {
		await this.setPage({ loading: true });
		const repo = this.input.repo;
		const [comparison, summaries, commitsBetween] = await Promise.all([
			graphRequest({ command: 'getCommitComparison', repo, fromHash: this.input.fromHash, toHash: this.input.toHash }),
			graphRequest({ command: 'getCommitSummaries', repo, commitHashes: (this.input.singleCommit ? [this.input.toHash] : [this.input.fromHash, this.input.toHash]).filter((hash) => hash !== '' && hash !== UNCOMMITTED) }),
			this.countBetween()
		]);
		if (this.disposed) return;
		const error = comparison && comparison['error'] === null
			? null
			: String(comparison?.['error'] ?? 'The changes could not be loaded.');
		this.changes = error === null ? ((comparison?.['fileChanges'] as CompareFileChange[] | undefined) ?? []) : [];
		await this.setPage({
			error,
			fileChanges: this.changes,
			summaries: (summaries?.['summaries'] as Record<string, unknown> | undefined) ?? {},
			commitsBetween
		});
	}

	private async countBetween(): Promise<number | null> {
		const { fromHash, toHash, singleCommit } = this.input;
		if (singleCommit || fromHash === '' || fromHash === UNCOMMITTED) return null;
		const tip = toHash === '' || toHash === UNCOMMITTED ? 'HEAD' : toHash;
		const response = await graphRequest({ command: 'countCommitsBefore', repo: this.input.repo, hash: fromHash, branches: [tip], showRemoteBranches: false, includeCommitsMentionedByReflogs: false });
		const count = response?.['count'];
		return typeof count === 'number' ? count : null;
	}

	/** Generate the page with the extension's own template and hand it to the frame, with the
	 *  acquireVsCodeApi shim (state in sessionStorage, requests posted to this host) injected
	 *  under the page's own nonce so its CSP lets it run. */
	private async setPage(page: Record<string, unknown>): Promise<void> {
		await loadCompareGenerator();
		const build = window.GitGraphCompare;
		if (!build) throw new Error('The Git Graph comparison page generator did not load');
		const html = build.buildComparePage({ ...this.input, ...page });
		const nonce = /nonce="([^"]+)"/.exec(html)?.[1] ?? '';
		const shim = '<script nonce="' + nonce + '">(function(){' +
			'window.acquireVsCodeApi=function(){return{' +
			"postMessage:function(m){window.parent.postMessage({__ggComparePage:m},'*');}," +
			"getState:function(){try{return JSON.parse(sessionStorage.getItem('ggstudio.compareState')||'null');}catch(e){return null;}}," +
			"setState:function(s){sessionStorage.setItem('ggstudio.compareState',JSON.stringify(s));}" +
			'}};' +
			'})();</script>';
		this.frame.srcdoc = html.replace('<head>', '<head>' + shim);
	}

	private handlePageMessage(event: MessageEvent): void {
		if (this.disposed || event.source !== this.frame.contentWindow) return;
		const message = (event.data as { __ggComparePage?: Record<string, unknown> } | null)?.__ggComparePage;
		if (message === undefined) return;
		const command = String(message['command']);
		if (command === 'getFileDiff') {
			void this.answerFileDiff(Number(message['index']));
		} else if (command === 'requestCounts') {
			void this.answerCounts((message['paths'] as string[]) ?? []);
		} else if (command === 'viewDiff') {
			const file = this.changes[Number(message['index'])];
			if (file) this.delegate.openDiff(this.diffRequest(file));
		} else if (command === 'viewDiffBinary' || command === 'getHexInfo' || command === 'getHexRows' || command === 'getImageData') {
			// The binary/hex area needs the extension's hex-session machinery, which reads blobs
			// through Node streams; hosting it is future work (see the development plan).
			if (!this.binaryNotified) {
				this.binaryNotified = true;
				notify('info', 'Binary files have no textual comparison. The hex/image comparison page is not wired into Studio yet.');
			}
		}
		this.settlePendingCounts();
	}

	/** The page requests the deferred "+/-" counts only when the right side is a commit
	 *  (`countsPossible` in the generated page); against the working tree its pending
	 *  placeholders would never settle. The engine reports no line counts for a working-tree
	 *  comparison (its counts come from tree diffs), so the rows settle as uncounted - posted
	 *  on the page's first message, when its listener is certainly up. */
	private settlePendingCounts(): void {
		if (this.countsSettled || (this.input.toHash !== UNCOMMITTED && this.input.toHash !== '')) return;
		this.countsSettled = true;
		const counts: Record<string, { additions: null; deletions: null }> = {};
		for (const file of this.changes) {
			if (file.additions === null && file.type !== 'U') {
				counts[file.newFilePath !== '' ? file.newFilePath : file.oldFilePath] = { additions: null, deletions: null };
			}
		}
		if (Object.keys(counts).length > 0) this.post({ command: 'lineCounts', counts });
	}

	private async answerFileDiff(index: number): Promise<void> {
		const file = this.changes[index];
		if (file === undefined) return;
		const response = await graphRequest({ command: 'getCommitFileDiff', repo: this.input.repo, fromHash: this.input.fromHash, toHash: this.input.toHash, oldFilePath: file.oldFilePath, newFilePath: file.newFilePath });
		this.post({ command: 'fileDiff', index, diff: (response?.['diff'] as string | null) ?? null, error: response && response['error'] === null ? null : String(response?.['error'] ?? 'The diff could not be loaded.') });
	}

	private async answerCounts(paths: string[]): Promise<void> {
		if (paths.length === 0) return;
		// Never leave the page's request unanswered: an uncommitted right side has no
		// engine-computable counts, so the asked paths settle as uncounted.
		if (this.input.toHash === UNCOMMITTED || this.input.toHash === '') {
			this.post({ command: 'lineCounts', counts: Object.fromEntries(paths.map((path) => [path, { additions: null, deletions: null }])) });
			return;
		}
		const response = await graphRequest({ command: 'commitFileCounts', repo: this.input.repo, from: this.input.fromHash, to: this.input.toHash, paths });
		this.post({ command: 'lineCounts', counts: (response?.['counts'] as Record<string, unknown>) ?? {} });
	}

	private post(message: Record<string, unknown>): void {
		this.frame.contentWindow?.postMessage(message, '*');
	}

	/** "Open Diff in Editor": the shell's own diff editor, titled as the extension's viewDiff
	 *  titles it. */
	private diffRequest(file: CompareFileChange): DiffRequest {
		const from = this.input.fromHash === '' || this.input.fromHash === UNCOMMITTED ? 'HEAD' : this.input.fromHash;
		const to = this.input.toHash;
		const oldPath = toPosix(file.oldFilePath), newPath = toPosix(file.newFilePath || file.oldFilePath);
		return {
			id: `compare:${from}:${oldPath}:${to}:${newPath}`,
			title: `${basename(newPath)} (${from === to ? `${abbrev(from)}^ ↔ ${abbrev(to)}` : `${abbrev(from)} ↔ ${abbrev(to)}`})`,
			repo: this.input.repo,
			left: { revision: from, path: oldPath, label: abbrev(from), exists: file.type !== 'A' },
			right: { revision: to, path: newPath, label: to === UNCOMMITTED ? 'Working Tree' : abbrev(to), exists: file.type !== 'D' }
		};
	}
}

/** The write-path settings the backend consults (cmd_graph.rs's `ActionSettings`): the view's
 *  Settings Widget can change them, so they ride along with every request. */
export interface GraphActionSettings {
	signCommits: boolean;
	signTags: boolean;
	squashMergeMessageFormat: number;
	squashPullMessageFormat: number;
}

/** One Git Graph view request over the app's single backend channel (`graph_request`). This is
 *  the only `invoke` of the protocol in the app — every module that talks to the view's
 *  backend goes through it (scripts/check-seams.mjs enforces that at build time). A transport
 *  failure normalises into the protocol's own `{ command, error, errors }` error response. */
export async function graphRequest(message: Record<string, unknown>, settings: GraphActionSettings | null = null): Promise<Record<string, unknown> | null> {
	const command = String(message['command']);
	try {
		return await invoke<Record<string, unknown> | null>('graph_request', { message, settings });
	} catch (error) {
		return { command, error: String(error), errors: [String(error)] };
	}
}

/** Run one of the view's write requests and settle its confirmation protocol: a data-loss
 *  warning asks `confirm` and retries with `confirmed: true`; any error the protocol reports
 *  (the single `error`, or the first non-null of `errors`) rejects. The workbench's git
 *  commands use this for the operations they share with the view. */
export async function runGraphAction(message: Record<string, unknown>, options: { settings: GraphActionSettings | null; confirm: (text: string) => Promise<boolean> }): Promise<void> {
	let request = message;
	for (;;) {
		const response = await graphRequest(request, options.settings);
		if (response !== null && response['command'] === 'lossWarning') {
			if (!(await options.confirm(String(response['message'])))) return;
			request = { ...request, confirmed: true };
			continue;
		}
		const error = response?.['error'] ?? (Array.isArray(response?.['errors']) ? (response['errors'] as unknown[]).find((e) => e !== null) ?? null : null);
		if (error !== null && error !== undefined) throw new Error(String(error));
		return;
	}
}

type Message = Record<string, unknown>;

/** The requests after which the repository (refs, HEAD, index or working tree) may have changed. */
const WRITE_COMMANDS = new Set([
	'abortOperation', 'addRemote', 'addTag', 'applyStash', 'branchFromStash', 'checkoutBranch', 'checkoutCommit',
	'cherrypickCommit', 'cleanUntrackedFiles', 'commitFixup', 'commitSquash', 'continueOperation', 'createBranch',
	'createPullRequest', 'deleteBranch', 'deleteRemote', 'deleteRemoteBranch', 'deleteTag', 'deleteUserDetails',
	'dropCommit', 'dropStash', 'editCommitMessage', 'editRemote', 'editUserDetails', 'fetch', 'fetchIntoLocalBranch',
	'gerritSetFetchRefs', 'merge', 'popStash', 'pruneRemote', 'pullBranch', 'pushBranch', 'pushStash', 'pushTag',
	'rebase', 'renameBranch', 'resetFileToRevision', 'resetToCommit', 'revertCommit', 'undoLastCommit',
	'worktreeAdd', 'worktreePrune', 'worktreeRemove'
]);

/** The settings the view's Settings Widget may write (src/gitGraphView.ts WRITABLE_GLOBAL_SETTINGS). */
const WRITABLE_SETTINGS: Record<string, (value: unknown) => boolean> = {
	'commitAuthors': (v) => Array.isArray(v) && v.length <= 50 && v.every((a) => typeof a === 'object' && a !== null && typeof a.name === 'string' && typeof a.email === 'string'),
	'graph.style': oneOf('rounded', 'angular'),
	'graph.rowHeight': integerInRange(16, 48),
	'graph.fontSize': integerInRange(8, 24),
	'date.type': oneOf('Author Date', 'Commit Date'),
	'date.format': oneOf('Date & Time', 'Date Only', 'ISO Date & Time', 'ISO Date Only', 'Relative'),
	'referenceLabels.combineLocalAndRemoteBranchLabels': isBoolean,
	'stickyHeader': isBoolean,
	'markdown': isBoolean,
	'repository.commits.initialLoad': integerInRange(1, 100000),
	'repository.commits.loadMore': integerInRange(1, 100000),
	'repository.commits.loadMoreAutomatically': isBoolean,
	'repository.commits.order': oneOf('date', 'author-date', 'topo'),
	'repository.commits.fetchAvatars': isBoolean,
	'repository.showUncommittedChanges': isBoolean,
	'repository.showUntrackedFiles': isBoolean,
	'repository.fetchAndPrune': isBoolean,
	'repository.fetchAndPruneTags': isBoolean,
	'repository.trackRemoteTags': isBoolean,
	'repository.showRemoteBranches': isBoolean,
	'repository.showRemoteHeads': isBoolean,
	'pullRequests.enabled': isBoolean,
	'enableLog': isBoolean
};
function isBoolean(value: unknown): boolean { return typeof value === 'boolean'; }
function oneOf(...allowed: string[]) { return (value: unknown) => typeof value === 'string' && allowed.includes(value); }
function integerInRange(min: number, max: number) { return (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max; }

const UNCOMMITTED = '*';

export interface GraphHostDelegate {
	openFile(path: string): void;
	openDiff(diff: DiffRequest): void;
	openFileAtRevision(revision: string, path: string, title: string, repo?: string): void;
	/** The graph asked for a Commit Comparison tab ("Open Changes", "Compare with..."). */
	openCompareTab(fromHash: string, toHash: string, singleCommit: boolean, repo?: string): void;
	showSourceControl(): void;
	revealTerminal(): void;
	runInTerminal(command: string): void;
	/** The repository changed through the view: the SCM view, the explorer, the status bar catch up. */
	repoChanged(): void;
	/** The "Initialize Repository" button of the not-a-repository placeholder was clicked. */
	initRepository(): void;
}

export class GraphHost {
	/** The element the editor group hosts: the view frame, with the not-a-repository
	 *  placeholder layered over it when the open folder is not a Git repository. */
	readonly element: HTMLDivElement;
	readonly frame: HTMLIFrameElement;
	private repoPath: string | null = null;
	/** Whether the open folder is a Git repository (the placeholder shows when it is not). */
	private isRepo = true;
	/** The repositories the view's dropdown offers: the open repository plus its initialised
	 *  submodules, refreshed from the backend on every load and loadRepos request. */
	private repos: string[] = [];
	/** The repository the view is currently showing (it switches locally in the dropdown);
	 *  `null` while none is loaded. */
	private currentRepo: string | null = null;
	private config: Record<string, unknown> = {};
	/** Serialises requests so responses can never overtake each other on a refresh. */
	private pending: Promise<unknown> = Promise.resolve();
	/** Whether the view frame has been loaded at least once (a locale switch only reloads it then). */
	loaded = false;

	/** The session log the view's "Open Session Log" action writes out (see `openLogFile`). */
	private sessionLog: string[] = [];
	private firstPageSeen = false;

	constructor(private readonly delegate: GraphHostDelegate) {
		this.element = el('div', 'graph-host');
		this.frame = document.createElement('iframe');
		this.frame.title = 'Git Graph';
		this.frame.setAttribute('aria-label', 'Git Graph');
		this.element.appendChild(this.frame);
		this.logLine('Session started');
		window.addEventListener('message', (event) => this.onMessage(event));
		// Script errors inside the view page (view.html forwards them) belong in the session log.
		window.addEventListener('message', (event) => {
			const data = event.data as { __studioGraphError?: string } | null;
			if (data && typeof data.__studioGraphError === 'string' && event.source === this.frame.contentWindow) {
				this.logLine(`VIEW ERROR: ${data.__studioGraphError}`);
			}
		});
		// The view is same-origin: after it (re)loads - and after a theme switch - its theme
		// stylesheet and vscode-* classes follow the shell's. The boot stage is reported for
		// the view page itself only: an iframe also fires `load` for its initial empty document,
		// which is not a page the user ever sees.
		this.frame.addEventListener('load', () => {
			this.applyFrameTheme();
			const src = this.frame.getAttribute('src') ?? '';
			const isViewPage = this.frame.getAttribute('srcdoc') !== null || (src !== '' && src !== 'about:blank');
			if (isViewPage) void invoke('boot_stage', { stage: 'graph view page loaded', pageMs: performance.now() }).catch(() => undefined);
		});
		window.addEventListener(THEME_EVENT, () => this.applyFrameTheme());
		// The editor group dispatches this on the shared element when the Git Graph tab becomes
		// the visible one (see EditorGroup.activate): the pane may have been `hidden` (zero-size)
		// while the view loaded or last rendered, so its column widths and virtual window are
		// stale. The view (web/observers.ts) already recomputes both, but only in response to a
		// 'resize' event on its own window - raise one now that the frame has its real size back.
		this.element.addEventListener('ggs-graph-shown', () => {
			requestAnimationFrame(() => this.frame.contentWindow?.dispatchEvent(new Event('resize')));
		});
	}

	/** The host's contract with the view, as VS Code's with a webview: the `--vscode-*` token
	 *  sheet of the current theme and the `vscode-dark` / `vscode-light` classes, injected into
	 *  the page - never a stylesheet of the plugin's own. */
	private applyFrameTheme(): void {
		try {
			const doc = this.frame.contentDocument;
			if (!doc) return;
			const theme = themeById();
			let link = doc.getElementById(HOST_THEME_LINK_ID) as HTMLLinkElement | null;
			if (!link && doc.head) {
				doc.head.insertAdjacentHTML('afterbegin', hostThemeLink(theme.css));
				link = doc.getElementById(HOST_THEME_LINK_ID) as HTMLLinkElement | null;
			}
			for (const element of [doc.documentElement, doc.body]) {
				if (!element) continue;
				element.classList.remove('vscode-dark', 'vscode-light');
				element.classList.add(theme.kind);
				element.dataset['vscodeThemeKind'] = theme.kind;
				element.dataset['vscodeThemeName'] = theme.label;
			}
			if (link && link.getAttribute('href') !== theme.css) {
				// A live switch while the view is already running (no reload): once the new
				// stylesheet has loaded, tell the view to re-mirror the --vscode-* colour tokens
				// it copied into inline style at boot (see static/gitgraph/view.html), so the
				// scroll-to-commit flash and Find highlight follow the new theme too.
				const frameWindow = this.frame.contentWindow;
				link.addEventListener('load', () => frameWindow?.postMessage({ __studioThemeReady: true }, '*'), { once: true });
				link.href = theme.css;
			}
		} catch {
			// A cross-origin or not-yet-created document: the view keeps its loaded theme.
		}
	}

	private logLine(line: string): void {
		const time = new Date().toISOString().replace('T', ' ').slice(0, 19);
		this.sessionLog.push(`[${time}] ${line}`);
		// One session's log stays bounded even in a long-running window.
		if (this.sessionLog.length > 2000) this.sessionLog.splice(0, this.sessionLog.length - 2000);
	}

	/** Build the view config from the extension's own config code plus the stored overrides. */
	private buildConfig(): Record<string, unknown> {
		const build = window.GitGraphStudioConfig;
		if (!build) throw new Error('The Git Graph config bundle (gitgraph/config.js) did not load');
		return build(state.graphSettings());
	}

	/** The git-side settings the backend's write path consults. */
	actionSettings(): GraphActionSettings {
		return {
			signCommits: this.config['signCommits'] === true,
			signTags: this.config['signTags'] === true,
			squashMergeMessageFormat: Number(this.config['squashMergeMessageFormat'] ?? 0),
			squashPullMessageFormat: Number(this.config['squashPullMessageFormat'] ?? 0)
		};
	}

	/** Load (or reload) the view for a repository. The page is the app's own
	 *  /gitgraph/view.html (the extension is integrated: its assets ship with the app), and the
	 *  mount runs asynchronously so the frame shows the page as soon as it is ready. A folder
	 *  that is not a Git repository gets the placeholder with the Initialize button instead. */
	load(repoPath: string | null, isRepo = true): void {
		const switched = this.repoPath !== repoPath;
		this.repoPath = repoPath;
		this.isRepo = isRepo;
		if (!isRepo || repoPath === null) {
			this.currentRepo = null;
			this.loadGeneration++;
			this.showPlaceholder(repoPath !== null);
			this.loaded = false;
			return;
		}
		// A reload of the same folder keeps the repository the view had selected (a submodule,
		// perhaps); switching folders starts from the newly opened one.
		if (switched) this.currentRepo = null;
		this.hidePlaceholder();
		this.loaded = true;
		const generation = ++this.loadGeneration;
		void this.mount(repoPath, generation).catch((error) => this.logLine(`VIEW LOAD FAILED: ${String(error)}`));
	}

	private loadGeneration = 0;

	/** The repository set for the view: the open repository plus its initialised submodules,
	 *  each with its saved view state. */
	private repoStates(): Record<string, unknown> {
		const repos: Record<string, unknown> = {};
		for (const repo of this.repos) repos[repo] = state.repoState(repo);
		return repos;
	}

	/** Re-read the submodule roots from the backend (a `git submodule update` may have
	 *  initialised some since the last look). */
	private async refreshRepos(): Promise<void> {
		const repoPath = this.repoPath;
		if (repoPath === null) {
			this.repos = [];
			return;
		}
		const submodules = await invoke<string[]>('repo_submodules', { repo: repoPath }).catch(() => []);
		// The folder may have switched while the submodules were being read: the old repo's
		// list must not end up in the new view's repository picker.
		if (repoPath !== this.repoPath) return;
		this.repos = [repoPath, ...submodules];
	}

	private async mount(repoPath: string, generation: number): Promise<void> {
		await this.refreshRepos();
		if (generation !== this.loadGeneration) return; // superseded by a newer load / unload
		// A repository switch asked for while the load was still running (a submodule's graph
		// icon in the Source Control view clicked right after the folder opened) lands directly
		// on the freshly loaded view.
		const pendingRepo = this.pendingRepo;
		this.pendingRepo = null;
		if (pendingRepo !== null && this.repos.includes(pendingRepo)) this.currentRepo = pendingRepo;
		this.currentRepo ??= repoPath;
		this.config = this.buildConfig();
		const initialState = {
			config: this.config,
			lastActiveRepo: this.currentRepo,
			loadViewTo: this.pendingFilterPath !== null ? { repo: repoPath, filterPath: this.pendingFilterPath } : null,
			loadRepoInfoRefreshId: 0,
			loadCommitsRefreshId: 0,
			backend: { platform: 'studio', engineAvailable: true, engineVersion: 'embedded', gitCliAvailable: true, capabilities: [] }
		};
		// sessionStorage: per-window, so a second instance of the app (another window,
		// another repository) cannot have its own mount overwrite this one's initial state.
		// The view page reads it back on boot (static/gitgraph/view.html) - `theme` included so
		// the page can link its own theme stylesheet up front and wait for it, instead of relying
		// on this host inserting one later once the frame's `load` fires (too late for the
		// view's first, synchronous read of the --vscode-* colour tokens: see applyFrameTheme).
		const theme = themeById();
		sessionStorage.setItem('ggstudio.initial', JSON.stringify({
			initialState: { ...initialState, repos: this.repoStates() },
			globalState: state.globalViewState(),
			workspaceState: state.workspaceViewState(),
			theme: { css: theme.css, kind: theme.kind, label: theme.label }
		}));
		// A (re)load re-reads the init state; the fresh page drops every cache. No
		// cache-busting query: the page's freshness comes from the init state it reads on boot,
		// and letting the webview cache the (multi-hundred-kilobyte) bundle makes every reload
		// after the first one cheaper.
		this.frame.removeAttribute('srcdoc');
		if (!this.firstPageSeen) void invoke('boot_stage', { stage: 'graph view load started', pageMs: performance.now() }).catch(() => undefined);
		this.frame.src = '/gitgraph/view.html';
		this.pendingFilterPath = null;
	}

	unload(): void {
		this.repoPath = null;
		this.currentRepo = null;
		this.loadGeneration++;
		this.showPlaceholder(false);
		this.frame.removeAttribute('srcdoc');
		this.frame.src = 'about:blank';
		this.loaded = false;
	}

	/* ---------- The not-a-repository placeholder ---------- */

	private placeholder: HTMLElement | null = null;

	/** Cover the (blank) frame with the placeholder. `overFolder` says whether a folder is
	 *  open (the Initialize button only makes sense then). */
	private showPlaceholder(overFolder: boolean): void {
		this.hidePlaceholder();
		this.frame.removeAttribute('src');
		this.frame.removeAttribute('srcdoc');
		this.frame.src = 'about:blank';
		if (!overFolder) return;
		const button = el('button', 'button', ['Initialize Repository']);
		button.addEventListener('click', () => this.delegate.initRepository());
		this.placeholder = el('div', 'graph-placeholder', [
			el('div', '', [
				el('h2', '', ['Not a Git repository']),
				el('p', '', ['The folder that is open does not contain a Git repository. Initialize one to see its graph, changes and branches here.']),
				button
			])
		]);
		this.element.appendChild(this.placeholder);
	}

	private hidePlaceholder(): void {
		this.placeholder?.remove();
		this.placeholder = null;
	}

	/** Ask the view to refresh (what the extension's file watcher triggers). */
	refresh(): void {
		if (this.loaded) this.post({ command: 'refresh' });
	}

	/** A path filter asked for before the view finished a load; applied by `mount`. */
	private pendingFilterPath: string | null = null;
	/** A repository switch asked for before the view finished a load; applied by `mount`. */
	private pendingRepo: string | null = null;

	/** Switch the view to another repository of its dropdown's set (the open repository or one
	 *  of its submodules) - the Source Control view's per-repository graph icon. The view
	 *  re-renders its repository dropdown and loads that repository, exactly what its own
	 *  dropdown switch produces; a switch asked for before the load settles is applied by
	 *  `mount` instead. */
	switchRepo(repo: string): void {
		if (!this.loaded || !this.currentRepo) {
			this.pendingRepo = repo;
			return;
		}
		if (this.currentRepo === repo) return;
		const postSwitch = () => {
			if (this.currentRepo === repo || !this.repos.includes(repo)) return;
			this.currentRepo = repo;
			this.post({ command: 'loadRepos', repos: this.repoStates(), lastActiveRepo: repo, loadViewTo: { repo } });
		};
		// The Source Control view may know a submodule this host has not re-read since its load
		// (it was initialised in between): refresh the repository set before switching.
		if (this.repos.includes(repo)) postSwitch();
		else void this.refreshRepos().then(postSwitch);
	}

	/** Filter the view's commits to one or more files (Git Graph RS: Show File History in Git
	 *  Graph, `git-graph-rs.filterByFile`). `relativePath` is repo-relative, posix; multiple
	 *  paths join with commas - the filter syntax the view's own dataSource splits on. */
	filterByFile(relativePath: string): void {
		if (!this.repoPath) return;
		if (!this.loaded || !this.currentRepo) {
			this.pendingFilterPath = relativePath;
			return;
		}
		this.post({ command: 'loadRepos', repos: this.repoStates(), lastActiveRepo: this.currentRepo, loadViewTo: { repo: this.currentRepo, filterPath: relativePath } });
	}

	private post(message: Message): void {
		this.frame.contentWindow?.postMessage({ __studioGraphResponse: message }, '*');
	}

	/* ---------- Requests ---------- */

	private onMessage(event: MessageEvent): void {
		const data = event.data as { __studioGraphRequest?: Message } | null;
		if (!data || data.__studioGraphRequest === undefined) return;
		if (event.source !== this.frame.contentWindow) return;
		const request = data.__studioGraphRequest;
		const command = String(request['command']);
		if (typeof request['repo'] === 'string' && request['repo'] !== '') this.currentRepo = request['repo'];
		const failed = (error: unknown) => {
			this.logLine(`ERROR handling ${command}: ${String(error)}`);
			this.post({ command, error: String(error), errors: [String(error)] });
		};
		// Reads run concurrently - the view's opening burst (repo info, config, the first page)
		// then costs one backend round trip, not their sum; writes chain behind everything
		// before them, as they did in the extension host, so a refresh never overtakes the
		// operation it reports on.
		if (WRITE_COMMANDS.has(command)) {
			this.pending = this.pending.then(() => this.handle(request)).catch(failed);
			return;
		}
		const read = this.handle(request).catch(failed);
		this.pending = Promise.all([this.pending, read]).then(() => undefined);
	}

	private async handle(request: Message): Promise<void> {
		const command = String(request['command']);
		const handled = await this.handleLocally(command, request);
		if (handled) return;

		const started = performance.now();
		// Until the first page is up, every request is a boot stage too (sent and answered),
		// so the boot log shows what the graph waited on before it became visible.
		const booting = !this.firstPageSeen;
		if (booting) void invoke('boot_stage', { stage: `graph ${command} sent`, pageMs: started }).catch(() => undefined);
		const response = await graphRequest(request, this.actionSettings());
		// Every backend round trip is timed into the session log; the first page of commits is
		// also a boot stage, so the boot log shows when the graph became visible.
		this.logLine(`${command}: ${(performance.now() - started).toFixed(0)} ms`);
		if (booting) void invoke('boot_stage', { stage: `graph ${command} answered`, pageMs: performance.now() }).catch(() => undefined);
		if (command === 'loadCommits' && !this.firstPageSeen) {
			this.firstPageSeen = true;
			void invoke('boot_stage', { stage: 'graph first page', pageMs: performance.now() }).catch(() => undefined);
		}
		if (response === null) return;
		if (response['error'] !== null && response['error'] !== undefined) {
			this.logLine(`ERROR ${command}: ${String(response['error'])}`);
		} else if (WRITE_COMMANDS.has(command)) {
			this.logLine(`${command} completed`);
		}
		this.decorate(command, request, response);
		this.post(response);
		if (WRITE_COMMANDS.has(command) && response['command'] !== 'lossWarning') {
			this.delegate.repoChanged();
			if (command === 'cherrypickCommit' && request['noCommit'] === true && (response['errors'] as unknown[])?.[0] === null) {
				this.delegate.showSourceControl();
			}
			if (command === 'createPullRequest' && (response['errors'] as unknown[])?.[0] === null) {
				await this.openPullRequestUrl(request);
			}
		}
	}

	/** Fields the extension host adds from its own state: code reviews. */
	private decorate(command: string, request: Message, response: Message): void {
		// Reviews are keyed by the repository the request names (a submodule's review lives
		// under the submodule), exactly as handleLocally's start/update/end store them.
		const repo = typeof request['repo'] === 'string' && request['repo'] !== '' ? request['repo'] : this.repoPath;
		if (!repo) return;
		if (command === 'commitDetails' && request['commitHash'] !== UNCOMMITTED) {
			response['codeReview'] = touchCodeReview(repo, String(request['commitHash']));
		} else if (command === 'compareCommits' && request['toHash'] !== UNCOMMITTED) {
			response['codeReview'] = touchCodeReview(repo, `${request['fromHash']}-${request['toHash']}`);
		}
	}

	/** The requests the shell serves itself. Returns true when handled. */
	private async handleLocally(command: string, request: Message): Promise<boolean> {
		// The repository the request names - a submodule's graph sends its own path, and every
		// file/diff/revision it opens must read that submodule, not the open repository.
		const repo = typeof request['repo'] === 'string' && request['repo'] !== '' ? request['repo'] : (this.repoPath ?? '');
		const ok = (extra: Message = {}) => this.post({ command, error: null, ...extra });
		switch (command) {
			case 'loadRepos': {
				// The view re-checks on focus and after a rescan: submodules may have been
				// initialised since the load, so the set is re-read before answering.
				void this.refreshRepos().then(() => {
					this.post({ command, repos: this.repoStates(), lastActiveRepo: this.currentRepo ?? this.repoPath, loadViewTo: null });
				});
				return true;
			}
			case 'setRepoState':
				state.saveRepoState(String(request['repo']), request['state'] as Record<string, unknown>);
				return true;
			case 'setGlobalViewState':
				state.save('globalViewState', request['state']);
				ok();
				return true;
			case 'setWorkspaceViewState':
				state.save('workspaceViewState', request['state']);
				ok();
				return true;
			case 'setGlobalSetting': {
				const key = String(request['setting']);
				const validate = Object.prototype.hasOwnProperty.call(WRITABLE_SETTINGS, key) ? WRITABLE_SETTINGS[key]! : null;
				if (validate === null) {
					this.post({ command, setting: key, authorConfigTouched: false, error: `The setting "${key}" cannot be written from the Git Graph View.` });
				} else if (!validate(request['value'])) {
					this.post({ command, setting: key, authorConfigTouched: false, error: `The value provided for "${key}" is not valid.` });
				} else {
					state.saveGraphSetting(key, request['value']);
					this.post({ command, setting: key, authorConfigTouched: key === 'commitAuthors', error: null });
					// Apply live, as the extension does on a configuration change.
					this.config = this.buildConfig();
					this.post({ command: 'configChanged', config: this.config });
				}
				return true;
			}
			case 'showErrorMessage':
				notify('error', String(request['message']));
				return true;
			case 'openFile':
				this.delegate.openFile(joinPath(repo, String(request['filePath'])));
				ok();
				return true;
			case 'viewFileAtRevision': {
				const hash = String(request['hash']);
				const path = String(request['filePath']);
				this.delegate.openFileAtRevision(hash, path, `${abbrev(hash)}: ${basename(path)}`, repo);
				ok();
				return true;
			}
			case 'viewDiff': {
				const from = String(request['fromHash']), to = String(request['toHash']);
				const type = String(request['type']);
				const oldPath = toPosix(String(request['oldFilePath'])), newPath = toPosix(String(request['newFilePath']));
				if (type === 'U') {
					this.delegate.openFile(joinPath(repo, newPath));
					ok();
					return true;
				}
				const leftRevision = resolveDiffFromHash(from, to);
				const toLabel = to === UNCOMMITTED ? 'Present' : abbrev(to);
				const description = from === to
					? (from === UNCOMMITTED ? 'Uncommitted Changes' : type === 'A' ? `Added in ${toLabel}` : type === 'D' ? `Deleted in ${toLabel}` : `${abbrev(leftRevision)} ↔ ${toLabel}`)
					: (type === 'A' ? `Added between ${abbrev(from)} & ${toLabel}` : type === 'D' ? `Deleted between ${abbrev(from)} & ${toLabel}` : `${abbrev(from)} ↔ ${toLabel}`);
				this.delegate.openDiff({
					id: `graph:${leftRevision}:${oldPath}:${to}:${newPath}`,
					title: `${basename(newPath)} (${description})`,
					repo,
					left: { revision: leftRevision, path: oldPath, label: abbrev(leftRevision), exists: type !== 'A' },
					right: { revision: to, path: newPath, label: to === UNCOMMITTED ? 'Working Tree' : abbrev(to), exists: type !== 'D' }
				});
				ok();
				return true;
			}
			case 'viewDiffWithWorkingFile': {
				const hash = String(request['hash']);
				const path = toPosix(String(request['filePath']));
				this.delegate.openDiff({
					id: `graph:${hash}:${path}:*:${path}`,
					title: `${basename(path)} (${abbrev(hash)} ↔ Present)`,
					repo,
					left: { revision: hash, path, label: abbrev(hash), exists: true },
					right: { revision: UNCOMMITTED, path, label: 'Working Tree', exists: true }
				});
				ok();
				return true;
			}
			case 'viewDiffBinary':
				notify('info', `${basename(String(request['newFilePath']))} is a binary file; Git Graph Studio has no binary comparison view. Use "View File at this Revision" or an external diff tool.`);
				return true;
			case 'openCompareTab':
				this.delegate.openCompareTab(String(request['fromHash']), String(request['toHash']), request['singleCommit'] === true, repo);
				return true;
			case 'viewScm':
				this.delegate.showSourceControl();
				ok();
				return true;
			case 'openTerminal':
				this.delegate.revealTerminal();
				ok();
				return true;
			case 'rebase':
				if (request['interactive'] === true) {
					// The extension types an interactive rebase into the integrated terminal.
					const obj = String(request['obj']);
					const onBranch = request['actionOn'] === 'Branch';
					const parts = ['git', 'rebase', '--interactive'];
					if (request['autosquash'] === true) parts.push('--autosquash');
					if (this.config['signCommits'] === true) parts.push('-S');
					parts.push(onBranch ? quoteShellArg(obj) : obj);
					this.delegate.runInTerminal(parts.join(' '));
					this.post({ command, actionOn: request['actionOn'], interactive: true, error: null });
					return true;
				}
				return false;
			case 'openExternalDirDiff':
				if (request['isGui'] !== true) {
					const from = String(request['fromHash']), to = String(request['toHash']);
					const range = from === to ? (to === UNCOMMITTED ? 'HEAD' : `${to}^..${to}`) : to === UNCOMMITTED ? from : `${from}..${to}`;
					this.delegate.runInTerminal(`git difftool --dir-diff ${range}`);
					ok();
					return true;
				}
				return false;
			case 'createArchive': {
				const ref = String(request['ref']);
				const safeName = ref.replace(/[\\/:*?"<>|]/g, '-');
				let target: string | null = null;
				try {
					target = await saveDialog({
						title: 'Create Archive',
						defaultPath: joinPath(repo, `${safeName}.zip`),
						filters: [{ name: 'ZIP Archive', extensions: ['zip'] }, { name: 'TAR Archive', extensions: ['tar'] }]
					});
				} catch (error) {
					this.post({ command, error: String(error) });
					return true;
				}
				if (!target) {
					ok();
					return true;
				}
				const response = await graphRequest({ ...request, outputFilePath: target }, this.actionSettings());
				if (response === null) return true;
				this.post(response);
				if (response['error'] === null) notify('info', `Archive created: ${target}`);
				return true;
			}
			case 'exportRepoConfig': {
				try {
					const file = exportableRepoConfig(state.repoState(repo));
					const dir = joinPath(repo, '.vscode');
					await invoke('create_folder', { path: dir }).catch(() => undefined);
					const target = joinPath(dir, 'git-graph-rs.json');
					await invoke('write_file', { path: target, contents: JSON.stringify(file, null, 4) });
					const current = state.repoState(repo);
					current['lastImportAt'] = file.exportedAt;
					state.saveRepoState(repo, current);
					notify('info', `The repository configuration was exported to ${target}`);
					ok();
				} catch (error) {
					this.post({ command, error: String(error) });
				}
				return true;
			}
			case 'setInterfaceLanguage': {
				const language = request['language'];
				if (language === 'auto' || language === 'en' || language === 'zh-cn') {
					state.saveGraphSetting('interfaceLanguage', language);
					this.logLine(`Interface language set to "${language}"`);
					this.post({ command, error: null });
					// The extension's configuration listener reloads the view to re-render it in
					// the new language (the Settings Widget is restored from the view state).
					this.load(this.repoPath);
				} else {
					this.post({ command, error: 'The value provided for "interfaceLanguage" is not valid.' });
				}
				return true;
			}
			case 'openExtensionSettings':
				notify('info', 'Git Graph Studio has no separate settings page: every setting the app supports is in this Settings widget.');
				ok();
				return true;
			case 'openLogFile': {
				try {
					const path = await invoke<string>('session_log_file');
					await invoke('write_file', { path, contents: this.sessionLog.join('\n') + '\n' });
					this.delegate.openFile(path);
					ok();
				} catch (error) {
					this.post({ command, error: String(error) });
				}
				return true;
			}
			case 'startCodeReview': {
				const review: state.CodeReview = { id: String(request['id']), lastActive: Date.now(), lastViewedFile: (request['lastViewedFile'] as string | null) ?? null, remainingFiles: request['files'] as string[] };
				state.saveCodeReview(repo, review);
				this.post({ command, commitHash: request['commitHash'], compareWithHash: request['compareWithHash'], codeReview: review, error: null });
				return true;
			}
			case 'updateCodeReview': {
				const id = String(request['id']);
				const review = state.codeReview(repo, id);
				if (!review) {
					this.post({ command, error: 'The Code Review could not be found.' });
					return true;
				}
				const remaining = request['remainingFiles'] as string[];
				if (remaining.length > 0) {
					review.remainingFiles = remaining;
					review.lastActive = Date.now();
					if (request['lastViewedFile'] !== null) review.lastViewedFile = request['lastViewedFile'] as string;
					state.saveCodeReview(repo, review);
				} else {
					state.saveCodeReview(repo, null, id);
				}
				ok();
				return true;
			}
			case 'endCodeReview':
				state.saveCodeReview(repo, null, String(request['id']));
				return true;
			case 'fetchAvatar':
			case 'fetchPullRequest':
				return true;
			case 'rescanForRepos': {
				// The settings action: re-read the repository set (the open repository plus its
				// submodules) and push it, exactly as the extension host did after a scan.
				void this.refreshRepos().then(() => {
					this.post({ command: 'loadRepos', repos: this.repoStates(), lastActiveRepo: this.currentRepo ?? this.repoPath, loadViewTo: null });
				});
				return true;
			}
			default:
				return false;
		}
	}

	private async openPullRequestUrl(request: Message): Promise<void> {
		const config = request['config'] as Record<string, unknown>;
		const fields = [
			String(config['hostRootUrl'] ?? ''),
			String(request['sourceOwner'] ?? ''), String(request['sourceRepo'] ?? ''), String(request['sourceBranch'] ?? ''),
			String(config['destOwner'] ?? ''), String(config['destRepo'] ?? ''), String(config['destProjectId'] ?? ''), String(config['destBranch'] ?? '')
		];
		let template: string;
		switch (config['provider']) {
			case 0: template = '$1/$2/$3/pull-requests/new?source=$2/$3::$4&dest=$5/$6::$8'; break; // Bitbucket
			case 1: template = String((config['custom'] as Record<string, unknown> | undefined)?.['templateUrl'] ?? ''); break;
			case 3: template = '$1/$2/$3/-/merge_requests/new?merge_request[source_branch]=$4&merge_request[target_branch]=$8' + (fields[6] !== '' ? '&merge_request[target_project_id]=$7' : ''); break; // GitLab
			default: template = '$1/$5/$6/compare/$8...$2:$4'; // GitHub
		}
		const url = template.replace(/\$([1-8])/g, (_, index: string) => fields[parseInt(index, 10) - 1] ?? '');
		try {
			await openUrl(url);
		} catch (error) {
			notify('error', `Could not open ${url}: ${String(error)}`);
		}
	}
}

/* ---------- Helpers ---------- */

/** The 8-character form the extension titles diffs with; a parent suffix (`^`) is kept. */
function abbrev(hash: string): string {
	if (hash === UNCOMMITTED) return 'Uncommitted';
	const suffix = hash.endsWith('^') ? '^' : '';
	const bare = suffix ? hash.slice(0, -1) : hash;
	return (bare.length > 8 ? bare.slice(0, 8) : bare) + suffix;
}

/** The left side of a diff, as the extension resolves it (src/utils.ts resolveDiffFromHash). */
function resolveDiffFromHash(fromHash: string, toHash: string): string {
	const from = fromHash === UNCOMMITTED ? 'HEAD' : fromHash;
	return from === toHash ? `${from}^` : from;
}

function quoteShellArg(value: string): string {
	return /^[A-Za-z0-9_./-]+$/.test(value) ? value : `"${value.replace(/["\\$`]/g, '\\$&')}"`;
}

function touchCodeReview(repo: string, id: string): state.CodeReview | null {
	const review = state.codeReview(repo, id);
	if (review) {
		review.lastActive = Date.now();
		state.saveCodeReview(repo, review);
	}
	return review;
}

/** The exportable half of a repository's state (src/repoManager.ts generateExternalConfigFile). */
function exportableRepoConfig(repo: Record<string, unknown>): Record<string, unknown> & { exportedAt: number } {
	const file: Record<string, unknown> = {};
	if (repo['commitOrdering'] !== 'default') file['commitOrdering'] = repo['commitOrdering'];
	if (repo['fileViewType'] === 1) file['fileViewType'] = 'tree';
	if (repo['fileViewType'] === 2) file['fileViewType'] = 'list';
	if (Array.isArray(repo['hideRemotes']) && repo['hideRemotes'].length > 0) file['hideRemotes'] = repo['hideRemotes'];
	if (repo['includeCommitsMentionedByReflogs'] !== 0) file['includeCommitsMentionedByReflogs'] = repo['includeCommitsMentionedByReflogs'] === 1;
	if (repo['issueLinkingConfig'] !== null) file['issueLinkingConfig'] = repo['issueLinkingConfig'];
	if (repo['name'] !== null) file['name'] = repo['name'];
	if (repo['onlyFollowFirstParent'] !== 0) file['onlyFollowFirstParent'] = repo['onlyFollowFirstParent'] === 1;
	if (repo['onRepoLoadShowCheckedOutBranch'] !== 0) file['onRepoLoadShowCheckedOutBranch'] = repo['onRepoLoadShowCheckedOutBranch'] === 1;
	if (repo['onRepoLoadShowSpecificBranches'] !== null) file['onRepoLoadShowSpecificBranches'] = repo['onRepoLoadShowSpecificBranches'];
	if (repo['pullRequestConfig'] !== null) file['pullRequestConfig'] = repo['pullRequestConfig'];
	if (repo['showRemoteBranchesV2'] !== 0) file['showRemoteBranches'] = repo['showRemoteBranchesV2'] === 1;
	if (repo['showStashes'] !== 0) file['showStashes'] = repo['showStashes'] === 1;
	if (repo['showTags'] !== 0) file['showTags'] = repo['showTags'] === 1;
	return { ...file, exportedAt: Date.now() };
}
