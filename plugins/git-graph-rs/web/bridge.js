// The Git Graph view's bridge: the extension-host role, in the page. The page (web/view.html,
// served over the package's own ggx:// assets) boots this before anything else; it waits for
// the host's context, applies the theme, generates the extension's own page (viewpage.js —
// its compiled getHtmlForWebview) and swaps the document to it, defining acquireVsCodeApi
// first so the generated bundle finds VS Code's webview API in place.
//
// From then on this script IS the extension host: the view's requests are classified here —
// the shell's own actions (opening files and diffs, the terminal, dialogs, view state, code
// reviews, settings) served through the host's page services, everything else forwarded to
// this package's backend process over `backend.message` (the same `ggx-rpc/1` request the app
// used to relay). Nothing of this lives in the app: the app only provides generic services.
(function () {
	'use strict';

	var UNCOMMITTED = '*';
	var ggs = acquireGgsApi();
	var context = null; // { settings, state, params, folders, language }
	var config = null; // the built GitGraphStudioConfig result
	var settings = null; // the flat git-graph-rs.* overrides (key -> value)
	var repoPath = null; // the open repository (the first workspace folder)
	var repos = []; // the dropdown's set: the repository plus its initialised submodules
	var currentRepo = null; // the repository the view is showing
	var viewState = null; // acquireVsCodeApi state (persisted through the workspace memento)
	var mementos = { global: {}, workspace: {} }; // the host-preloaded mementos
	var pending = Promise.resolve(); // write serialisation, exactly the extension host's
	var sessionLog = [];
	var firstPageSeen = false;
	var generation = 0;

	/* ---------- small helpers ---------- */

	function log(line) {
		var time = new Date().toISOString().replace('T', ' ').slice(0, 19);
		sessionLog.push('[' + time + '] ' + line);
		if (sessionLog.length > 2000) sessionLog.splice(0, sessionLog.length - 2000);
	}

	// A host service call. Not named `request`: the view's own messages travel as `request`
	// parameters through handle/handleLocally, and a parameter of that name shadowed this
	// function there — every host call from a handler threw "request is not a function".
	function hostRequest(method, args) { return ggs.request(method, args || []); }

	function backend(message) {
		return hostRequest('backend.message', [message, actionSettings()]).then(function (response) {
			return response === null || response === undefined ? null : response;
		}, function (error) {
			return { command: String(message.command || ''), error: String(error), errors: [String(error)] };
		});
	}

	/** The git-side settings the backend's write path consults. */
	function actionSettings() {
		return {
			signCommits: config && config.signCommits === true,
			signTags: config && config.signTags === true,
			squashMergeMessageFormat: Number(config && config.squashMergeMessageFormat) || 0,
			squashPullMessageFormat: Number(config && config.squashPullMessageFormat) || 0
		};
	}

	function post(message) {
		// The generated page listens on its own window's `message` events.
		window.postMessage(message, '*');
	}

	/* ---------- the persisted state (the host's memento service) ---------- */

	var MEMENTO_KEY = 'gitGraphViewState';
	var STATE_FLUSH_MS = 400;
	var stateFlushTimer = null;

	function memento(scope, key) { return mementos[scope][key]; }

	function saveMemento(scope, key, value) {
		mementos[scope][key] = value;
		if (stateFlushTimer !== null) return;
		stateFlushTimer = window.setTimeout(function () {
			stateFlushTimer = null;
			for (var scopeKey in mementos) hostRequest('state.update', [scopeKey, null, mementos[scopeKey]]);
		}, STATE_FLUSH_MS);
	}

	function defaultRepoState() {
		// The extension's DEFAULT_REPO_STATE (src/repoManager.ts), kept here now that the
		// extension host role belongs to this page.
		return {
			cdvDivider: 0.5, cdvHeight: 250, columnWidths: null, commitOrdering: 'default',
			fileViewType: 0, gerritFetchRefs: false, gerritFetchLimit: null,
			gerritStatusFilter: { new: true, merged: false, abandoned: false, wip: false },
			hideRemotes: [], includeCommitsMentionedByReflogs: 0, issueLinkingConfig: null,
			lastImportAt: 0, name: null, onlyFollowFirstParent: 0,
			onRepoLoadShowCheckedOutBranch: 0, onRepoLoadShowSpecificBranches: null,
			pinnedBranches: [], pinnedCommits: [], pullRequestConfig: null,
			showRemoteBranches: true, showRemoteBranchesV2: 0, showStashes: 0, showTags: 0,
			workspaceFolderIndex: null
		};
	}

	function repoStates() {
		var all = memento('workspace', 'repoStates') || {};
		var out = {};
		for (var i = 0; i < repos.length; i++) {
			out[repos[i]] = Object.assign(defaultRepoState(), all[repos[i]] || {});
		}
		return out;
	}

	function saveRepoState(repo, value) {
		var all = memento('workspace', 'repoStates') || {};
		all[repo] = value;
		saveMemento('workspace', 'repoStates', all);
	}

	function codeReview(repo, id) {
		var reviews = memento('workspace', 'codeReviews') || {};
		return reviews[repo + '|' + id] || null;
	}

	function saveCodeReview(repo, review, id) {
		var reviews = memento('workspace', 'codeReviews') || {};
		var key = repo + '|' + (id !== undefined ? id : (review && review.id) || '');
		if (review) reviews[key] = review;
		else delete reviews[key];
		saveMemento('workspace', 'codeReviews', reviews);
	}

	/* ---------- the theme ---------- */

	var themeStyle = null;

	function applyTheme(theme) {
		var doc = document;
		if (themeStyle === null) {
			themeStyle = doc.createElement('style');
			themeStyle.id = 'ggs-theme';
			(doc.head || doc.documentElement).insertBefore(themeStyle, (doc.head || doc.documentElement).firstChild);
		}
		themeStyle.textContent = 'html, body { height: 100%; margin: 0; background: var(--vscode-editor-background); }\n' + theme.css;
		for (var i = 0; i < [doc.documentElement, doc.body].length; i++) {
			var element = [doc.documentElement, doc.body][i];
			if (!element) continue;
			element.classList.remove('vscode-dark', 'vscode-light');
			element.classList.add(theme.kind);
			element.setAttribute('data-vscode-theme-kind', theme.kind);
			element.setAttribute('data-vscode-theme-name', theme.label);
		}
	}

	/** The tokens the view's synchronous boot read needs, mirrored to inline style on <html> —
	 *  VS Code's own delivery (web/utils.ts getVSCodeStyle reads them off the element). */
	function mirrorThemeVars() {
		var computed = getComputedStyle(document.documentElement);
		['--vscode-font-family', '--vscode-editor-font-family', '--vscode-editor-findMatchHighlightBackground', '--vscode-selection-background'].forEach(function (name) {
			var value = computed.getPropertyValue(name).trim();
			if (value) document.documentElement.style.setProperty(name, value);
		});
	}

	/* ---------- the settings the view's widget writes (WRITABLE_GLOBAL_SETTINGS) ---------- */

	function isBoolean(v) { return typeof v === 'boolean'; }
	function oneOf() {
		var allowed = Array.prototype.slice.call(arguments);
		return function (v) { return typeof v === 'string' && allowed.indexOf(v) !== -1; };
	}
	function integerInRange(min, max) {
		return function (v) { return typeof v === 'number' && isFinite(v) && Math.floor(v) === v && v >= min && v <= max; };
	}
	var WRITABLE_SETTINGS = {
		'commitAuthors': function (v) { return Array.isArray(v) && v.length <= 50 && v.every(function (a) { return typeof a === 'object' && a !== null && typeof a.name === 'string' && typeof a.email === 'string'; }); },
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

	function buildConfig() {
		var build = window.GitGraphStudioConfig;
		if (!build) throw new Error('The Git Graph config bundle (config.js) did not load');
		return build(settings || {});
	}

	/* ---------- boot ---------- */

	function boot() {
		ggs.ready.then(function (ctx) {
			context = ctx;
			settings = ctx.settings || {};
			mementos.global = (ctx.state && ctx.state.global) || {};
			mementos.workspace = (ctx.state && ctx.state.workspace) || {};
			viewState = memento('workspace', MEMENTO_KEY) || null;
			repoPath = (ctx.folders && ctx.folders[0]) || null;
			return hostRequest('theme.stylesheet').then(function (theme) {
				applyTheme(theme);
				return refreshRepos();
			});
		}).then(function () {
			config = buildConfig();
			return backend({ command: '__engineVersion' }).catch(function () { return null; });
		}).then(function (version) {
			var params = (context && context.params) || {};
			var filterPath = typeof params.filterPath === 'string' && params.filterPath !== '' ? params.filterPath : null;
			var named = typeof params.repo === 'string' ? matchRepo(params.repo) : null;
			if (named) currentRepo = named;
			currentRepo = currentRepo || repos[0] || null;
			var page = window.GitGraphViewPage.buildViewPage({
				settings: settings,
				repos: repoStates(),
				lastActiveRepo: currentRepo,
				loadViewTo: filterPath !== null && currentRepo ? { repo: currentRepo, filterPath: filterPath } : null,
				globalState: Object.assign({ alwaysAcceptCheckoutCommit: false, issueLinkingConfig: null, pushTagSkipRemoteCheck: false }, memento('workspace', 'globalViewState') || {}),
				workspaceState: Object.assign({ findIsCaseSensitive: false, findIsRegex: false, findOpenCommitDetailsView: false }, memento('workspace', 'workspaceViewState') || {}),
				engineVersion: typeof version === 'string' && version !== '' ? version : undefined
			});
			swapDocument(page);
			log('Session started');
		}).catch(function (error) {
			log('VIEW LOAD FAILED: ' + String(error));
			var div = document.createElement('div');
			div.style.cssText = 'padding:20px;color:var(--vscode-errorForeground,#f48771)';
			div.textContent = 'The Git Graph view failed to start: ' + String(error);
			document.body.innerHTML = '';
			document.body.appendChild(div);
		});
	}

	/** Swap this document for the extension's generated page. The window (and everything this
	 *  bridge defined on it, acquireVsCodeApi included) survives document.open/write, so the
	 *  generated bundle's scripts run against the shim already in place; the theme style is
	 *  re-attached ahead of them (a written document is parsed in order, stylesheets and
	 *  blocking scripts included, so the view's synchronous theme read and markdown-it
	 *  ordering both hold). The page's own nonces ride along untouched — its CSP admits them. */
	function swapDocument(html) {
		var theme = document.getElementById('ggs-theme');
		var themeText = theme ? theme.textContent : '';
		var scriptsSeen = 0;
		var lifted = html.replace(/<script nonce="([^"]+)" src="([^"]+)"><\/script>/g, function (_all, nonce, src) {
			scriptsSeen++;
			// Absolute asset URLs resolve against this package's own web/ directory instead.
			return '<script nonce="' + nonce + '" src="' + src.replace(/^.*\//, '') + '"></script>';
		});
		lifted = lifted.replace('<head>', '<head><style id="ggs-theme">' + themeText + '</style>');
		document.open();
		document.write(lifted);
		document.close();
		if (scriptsSeen === 0) {
			// The extension's own empty state (no repository): no bundle was ever going to run.
			window.__ggViewNoRepo = true;
			window.clearTimeout(bootGuard);
			return;
		}
		// The written scripts execute synchronously during the parse: the parse completing
		// means the bundle ran. (The page's own `load` event would fire later, for assets.)
		window.setTimeout(function () {
			window.__ggViewBooted = true;
			window.clearTimeout(bootGuard);
			mirrorThemeVars();
		}, 0);
	}

	/** The repository set: the open repository plus its initialised submodules, re-read from
	 *  this package's own backend. */
	function refreshRepos() {
		if (repoPath === null) {
			repos = [];
			return Promise.resolve();
		}
		return backend({ command: '__submoduleRoots', repo: repoPath }).then(function (response) {
			var roots = (response && response.roots) || [];
			repos = [repoPath].concat(roots.filter(function (root) { return root !== repoPath; }));
		});
	}

	/* ---------- the request pump (the extension host's own) ---------- */

	var WRITE_COMMANDS = {
		abortOperation: 1, addRemote: 1, addTag: 1, applyStash: 1, branchFromStash: 1, checkoutBranch: 1,
		checkoutCommit: 1, cherrypickCommit: 1, cleanUntrackedFiles: 1, commitFixup: 1, commitSquash: 1,
		continueOperation: 1, createBranch: 1, createPullRequest: 1, deleteBranch: 1, deleteRemote: 1,
		deleteRemoteBranch: 1, deleteTag: 1, deleteUserDetails: 1, dropCommit: 1, dropStash: 1,
		editCommitMessage: 1, editRemote: 1, editUserDetails: 1, fetch: 1, fetchIntoLocalBranch: 1,
		gerritSetFetchRefs: 1, merge: 1, popStash: 1, pruneRemote: 1, pullBranch: 1, pushBranch: 1,
		pushStash: 1, pushTag: 1, rebase: 1, renameBranch: 1, resetFileToRevision: 1, resetToCommit: 1,
		revertCommit: 1, undoLastCommit: 1, worktreeAdd: 1, worktreePrune: 1, worktreeRemove: 1
	};

	var api = {
		getState: function () { return viewState; },
		setState: function (value) { viewState = value; saveMemento('workspace', MEMENTO_KEY, value); return value; },
		postMessage: function (message) { onMessage(message); }
	};
	window.acquireVsCodeApi = function () { return api; };

	function onMessage(message) {
		if (!message || typeof message !== 'object') return;
		var command = String(message.command);
		if (typeof message.repo === 'string' && message.repo !== '') currentRepo = message.repo;
		var failed = function (error) {
			log('ERROR handling ' + command + ': ' + String(error));
			post({ command: command, error: String(error), errors: [String(error)] });
		};
		if (WRITE_COMMANDS[command]) {
			pending = pending.then(function () { return handle(message); }).catch(failed);
			return;
		}
		var read = handle(message).catch(failed);
		pending = Promise.all([pending, read]).then(function () { return undefined; });
	}

	function handle(request) {
		var command = String(request.command);
		return handleLocally(command, request).then(function (handled) {
			if (handled) return null;
			// The Gerrit remote and the resolved fetch limit ride along, as the extension host
			// added them from its own config state.
			if (command === 'loadCommits' && request.gerritFetchRefs === true) {
				request = Object.assign({}, request, { gerritRemote: gerritRemote(), gerritFetchLimit: gerritFetchLimitOf(request) });
			} else if (command === 'gerritSetFetchRefs') {
				request = Object.assign({}, request, { gerritRemote: gerritRemote() });
			}
			if (command === 'loadCommits') {
				request = Object.assign({}, request, { deferUncommittedChanges: true });
			}
			var started = performance.now();
			return backend(request).then(function (response) {
				log(command + ': ' + (performance.now() - started).toFixed(0) + ' ms');
				if (command === 'loadCommits' && !firstPageSeen) firstPageSeen = true;
				if (response === null) return null;
				if (response.error !== null && response.error !== undefined) log('ERROR ' + command + ': ' + String(response.error));
				else if (WRITE_COMMANDS[command]) log(command + ' completed');
				decorate(command, request, response);
				post(response);
				if (command === 'loadCommits' && response.error === null) {
					var stage = response.gerritPending === true ? gerritFollowUp(request).then(function (s) { return s || response; }) : Promise.resolve(response);
					return stage.then(function (page) { return uncommittedFollowUp(request, page); });
				}
				if (WRITE_COMMANDS[command] && response.command !== 'lossWarning') {
					hostRequest('workbench.repoChanged', []).catch(function () { return undefined; });
					if (command === 'cherrypickCommit' && request.noCommit === true && Array.isArray(response.errors) && response.errors[0] === null) {
						hostRequest('workbench.showView', ['scm']).catch(function () { return undefined; });
					}
					if (command === 'createPullRequest' && Array.isArray(response.errors) && response.errors[0] === null) {
						openPullRequestUrl(request);
					}
				}
				return null;
			});
		});
	}

	function decorate(command, request, response) {
		var repo = typeof request.repo === 'string' && request.repo !== '' ? request.repo : repoPath;
		if (!repo) return;
		if (command === 'commitDetails' && request.commitHash !== UNCOMMITTED) {
			response.codeReview = touchCodeReview(repo, String(request.commitHash));
		} else if (command === 'compareCommits' && request.toHash !== UNCOMMITTED) {
			response.codeReview = touchCodeReview(repo, String(request.fromHash) + '-' + String(request.toHash));
		}
	}

	function touchCodeReview(repo, id) {
		var review = codeReview(repo, id);
		if (review) {
			review.lastActive = Date.now();
			saveCodeReview(repo, review);
		}
		return review;
	}

	/* ---------- Gerrit follow-up + the deferred uncommitted row ---------- */

	var gerritFollowUps = {};

	function gerritFollowUp(request) {
		var repo = typeof request.repo === 'string' && request.repo !== '' ? request.repo : repoPath;
		if (!repo) return Promise.resolve(null);
		var chained = (gerritFollowUps[repo] || Promise.resolve(null)).then(function () {
			return runGerritFollowUp(request, repo);
		});
		gerritFollowUps[repo] = chained.then(function () { return null; }, function () { return null; });
		return chained;
	}

	function runGerritFollowUp(request, repo) {
		var started = performance.now();
		return backend({
			command: 'gerritRefresh', repo: repo,
			gerritRemote: gerritRemote(), gerritFetchLimit: gerritFetchLimitOf(request),
			gerritStatusFilter: request.gerritStatusFilter
		}).then(function () {
			return backend(Object.assign({}, request, { gerritRemote: gerritRemote(), gerritFetchLimit: gerritFetchLimitOf(request) }));
		}).then(function (stage) {
			log('gerritRefresh + stage: ' + (performance.now() - started).toFixed(0) + ' ms');
			if (stage === null || (stage.error !== null && stage.error !== undefined)) return null;
			delete stage.gerritPending;
			var states = stage.gerritStates;
			if (Array.isArray(states)) {
				post(Object.assign({}, stage, { gerritStates: states.map(function (state) { return Object.assign({}, state, { events: [], eventsPending: true }); }) }));
			}
			post(stage);
			return stage;
		});
	}

	var uncommittedFollowUps = {};

	function uncommittedFollowUp(request, page) {
		var repo = typeof request.repo === 'string' && request.repo !== '' ? request.repo : repoPath;
		if (!repo) return Promise.resolve();
		var run = function () { return runUncommittedFollowUp(request, page, repo); };
		var chained = (uncommittedFollowUps[repo] || Promise.resolve()).then(run, run);
		uncommittedFollowUps[repo] = chained.then(function () { return undefined; }, function () { return undefined; });
		return chained;
	}

	var renderedCount = null;
	var zeroSince = null;
	var ZERO_CONFIRM_MS = 5000;
	var RECHECK_MS = 1000;

	function runUncommittedFollowUp(request, page, repo) {
		if (config.showUncommittedChanges === false) return Promise.resolve();
		var head = page.head;
		var commits = page.commits;
		if (typeof head !== 'string' || head === '' || !Array.isArray(commits) || !commits.some(function (c) { return c.hash === head; })) {
			return Promise.resolve();
		}
		var read = function () {
			return backend({
				command: 'countUncommittedChanges', repo: repo,
				includeUntracked: config.showUntrackedFiles !== false
			}).then(function (counted) {
				if (counted === null || (counted.error !== null && counted.error !== undefined)) return null;
				return typeof counted.count === 'number' ? counted.count : null;
			});
		};
		var loop = function (count) {
			if (count === null) return Promise.resolve();
			if (request.hard === true) {
				deliver(page, count);
				return Promise.resolve();
			}
			var outcome = observe(count, Date.now());
			if (typeof outcome === 'number') {
				deliver(page, outcome);
				return Promise.resolve();
			}
			return new Promise(function (resolve) { return window.setTimeout(resolve, outcome); }).then(read).then(loop);
		};
		return read().then(loop);
	}

	function observe(count, now) {
		if (count > 0) { zeroSince = null; return count; }
		if (renderedCount === null || renderedCount === 0) return 0;
		if (zeroSince === null) zeroSince = now;
		if (now - zeroSince < ZERO_CONFIRM_MS) return RECHECK_MS;
		zeroSince = null;
		return 0;
	}

	function deliver(page, count) {
		var completion = Object.assign({}, page, { uncommittedCount: count });
		delete completion.gerritPending;
		renderedCount = count;
		if (count > 0) zeroSince = null;
		post(completion);
	}

	function gerritRemote() {
		var gerrit = config.gerrit;
		return gerrit && typeof gerrit.remote === 'string' && gerrit.remote !== '' ? gerrit.remote : 'origin';
	}

	function gerritFetchLimitOf(request) {
		var limit = request.gerritFetchLimit;
		if (typeof limit === 'number' && isFinite(limit) && Math.floor(limit) === limit && limit >= 1 && limit <= 10000) return limit;
		var gerrit = config.gerrit;
		return gerrit && typeof gerrit.fetchLimit === 'number' && gerrit.fetchLimit >= 1 ? gerrit.fetchLimit : 20;
	}

	/* ---------- the shell's own requests (the extension host's intercepts) ---------- */

	function handleLocally(command, request) {
		var repo = typeof request.repo === 'string' && request.repo !== '' ? request.repo : (repoPath || '');
		var ok = function (extra) { post(Object.assign({ command: command, error: null }, extra || {})); return Promise.resolve(true); };

		switch (command) {
			case 'loadRepos':
				return refreshRepos().then(function () {
					post({ command: command, repos: repoStates(), lastActiveRepo: currentRepo || repoPath, loadViewTo: null });
					return true;
				});
			case 'setRepoState':
				saveRepoState(String(request.repo), request.state);
				return Promise.resolve(true);
			case 'setGlobalViewState':
				saveMemento('workspace', 'globalViewState', request.state);
				return ok();
			case 'setWorkspaceViewState':
				saveMemento('workspace', 'workspaceViewState', request.state);
				return ok();
			case 'setGlobalSetting': {
				var key = String(request.setting);
				var validate = Object.prototype.hasOwnProperty.call(WRITABLE_SETTINGS, key) ? WRITABLE_SETTINGS[key] : null;
				if (validate === null) {
					post({ command: command, setting: key, authorConfigTouched: false, error: 'The setting "' + key + '" cannot be written from the Git Graph View.' });
				} else if (!validate(request.value)) {
					post({ command: command, setting: key, authorConfigTouched: false, error: 'The value provided for "' + key + '" is not valid.' });
				} else {
					settings[key] = request.value;
					// The host's shape: [extension id, full setting id, value] — the same call the
					// vscode shim makes, keyed so `when` clauses resolve the stored value.
					hostRequest('settings.update', [context.extensionId, 'git-graph-rs.' + key, request.value]).catch(function () { return undefined; });
					config = buildConfig();
					post({ command: command, setting: key, authorConfigTouched: key === 'commitAuthors', error: null });
					post({ command: 'configChanged', config: config });
				}
				return Promise.resolve(true);
			}
			case 'showErrorMessage':
				hostRequest('notify', ['error', String(request.message)]).catch(function () { return undefined; });
				return Promise.resolve(true);
			case 'openFile':
				hostRequest('workbench.openFile', [joinPath(repo, String(request.filePath))]).catch(function () { return undefined; });
				return ok();
			case 'viewFileAtRevision':
				hostRequest('workbench.openFileAtRevision', [String(request.hash), String(request.filePath), abbrev(String(request.hash)) + ': ' + basename(String(request.filePath)), repo]).catch(function () { return undefined; });
				return ok();
			case 'viewDiff':
				viewDiffRequest(repo, request);
				return ok();
			case 'viewDiffWithWorkingFile': {
				var hash = String(request.hash);
				var path = toPosix(String(request.filePath));
				hostRequest('workbench.openDiff', [{
					id: 'graph:' + hash + ':' + path + ':*:' + path,
					title: basename(path) + ' (' + abbrev(hash) + ' \u2194 Present)',
					repo: repo, binaryNotice: true,
					left: { revision: hash, path: path, label: abbrev(hash), exists: true },
					right: { revision: UNCOMMITTED, path: path, label: 'Working Tree', exists: true }
				}]).catch(function () { return undefined; });
				return ok();
			}
			case 'viewDiffBinary': {
				var binaryFrom = resolveDiffFromHash(String(request.fromHash), String(request.toHash));
				hostRequest('pages.open', ['binarycompare', {
					repo: repo,
					fromHash: binaryFrom,
					toHash: String(request.toHash),
					file: { oldFilePath: String(request.oldFilePath), newFilePath: String(request.newFilePath), type: String(request.type) }
				}, { title: panelTitle({ kind: 'binary', filePath: String(request.newFilePath) || String(request.oldFilePath), fromHash: binaryFrom, toHash: String(request.toHash) }) }]).catch(function () { return undefined; });
				return Promise.resolve(true);
			}
			case 'openCompareTab':
				hostRequest('pages.open', ['compare', {
					repo: repo, fromHash: String(request.fromHash), toHash: String(request.toHash),
					singleCommit: request.singleCommit === true
				}, { title: panelTitle({ kind: request.singleCommit === true ? 'commit' : 'compare', fromHash: String(request.fromHash), toHash: String(request.toHash) }) }]).catch(function () { return undefined; });
				return Promise.resolve(true);
			case 'viewScm':
				hostRequest('workbench.showView', ['scm']).catch(function () { return undefined; });
				return ok();
			case 'openTerminal':
				hostRequest('workbench.revealTerminal', []).catch(function () { return undefined; });
				return ok();
			case 'rebase':
				if (request.interactive === true) {
					var obj = String(request.obj);
					var parts = ['git', 'rebase', '--interactive'];
					if (request.autosquash === true) parts.push('--autosquash');
					if (config.signCommits === true) parts.push('-S');
					parts.push(request.actionOn === 'Branch' ? quoteShellArg(obj) : obj);
					hostRequest('workbench.runInTerminal', [parts.join(' ')]).catch(function () { return undefined; });
					post({ command: command, actionOn: request.actionOn, interactive: true, error: null });
					return Promise.resolve(true);
				}
				return Promise.resolve(false);
			case 'openExternalDirDiff':
				if (request.isGui !== true) {
					var from = String(request.fromHash), to = String(request.toHash);
					var range = from === to ? (to === UNCOMMITTED ? 'HEAD' : to + '^..' + to) : (to === UNCOMMITTED ? from : from + '..' + to);
					hostRequest('workbench.runInTerminal', ['git difftool --dir-diff ' + range]).catch(function () { return undefined; });
					return ok();
				}
				return Promise.resolve(false);
			case 'createArchive': {
				var ref = String(request.ref);
				var safeName = ref.replace(/[\\/:*?"<>|]/g, '-');
				return hostRequest('workbench.saveFile', [
					'Create Archive', joinPath(repo, safeName + '.zip'),
					[{ name: 'ZIP Archive', extensions: ['zip'] }, { name: 'TAR Archive', extensions: ['tar'] }]
				]).then(function (target) {
					if (!target) return ok();
					return backend(Object.assign({}, request, { outputFilePath: target })).then(function (response) {
						if (response === null) return true;
						post(response);
						if (response.error === null) hostRequest('notify', ['info', 'Archive created: ' + target]).catch(function () { return undefined; });
						return true;
					});
				}).catch(function (error) { post({ command: command, error: String(error) }); return true; });
			}
			case 'exportRepoConfig': {
				var file = exportableRepoConfig(memento('workspace', 'repoStates') ? (memento('workspace', 'repoStates')[repo] || defaultRepoState()) : defaultRepoState());
				var dir = joinPath(repo, '.vscode');
				var targetFile = joinPath(dir, 'git-graph-rs.json');
				return hostRequest('workbench.writeFile', [targetFile, JSON.stringify(file, null, 4)]).then(function () {
					var current = memento('workspace', 'repoStates') || {};
					var state = Object.assign(defaultRepoState(), current[repo] || {});
					state.lastImportAt = file.exportedAt;
					current[repo] = state;
					saveMemento('workspace', 'repoStates', current);
					hostRequest('notify', ['info', 'The repository configuration was exported to ' + targetFile]).catch(function () { return undefined; });
					return ok();
				}).catch(function (error) { post({ command: command, error: String(error) }); return true; });
			}
			case 'setInterfaceLanguage': {
				var language = request.language;
				if (language === 'auto' || language === 'en' || language === 'zh-cn') {
					settings.interfaceLanguage = language;
					hostRequest('settings.update', [context.extensionId, 'git-graph-rs.interfaceLanguage', language]).catch(function () { return undefined; });
					log('Interface language set to "' + language + '"');
					post({ command: command, error: null });
					window.setTimeout(function () { window.location.reload(); }, 0);
				} else {
					post({ command: command, error: 'The value provided for "interfaceLanguage" is not valid.' });
				}
				return Promise.resolve(true);
			}
			case 'openExtensionSettings':
				hostRequest('notify', ['info', 'The extension has no separate settings page: every setting it supports is in this Settings widget.']).catch(function () { return undefined; });
				return ok();
			case 'openLogFile':
				return hostRequest('workbench.saveFile', ['Session Log', 'git-graph-session.log', [{ name: 'Log', extensions: ['log'] }]]).then(function (target) {
					if (!target) return ok();
					return hostRequest('workbench.writeFile', [target, sessionLog.join('\n') + '\n']).then(function () {
						hostRequest('workbench.openFile', [target]).catch(function () { return undefined; });
						return ok();
					});
				}).catch(function (error) { post({ command: command, error: String(error) }); return true; });
			case 'startCodeReview': {
				var review = { id: String(request.id), lastActive: Date.now(), lastViewedFile: typeof request.lastViewedFile === 'string' ? request.lastViewedFile : null, remainingFiles: request.files || [] };
				saveCodeReview(repo, review);
				post({ command: command, commitHash: request.commitHash, compareWithHash: request.compareWithHash, codeReview: review, error: null });
				return Promise.resolve(true);
			}
			case 'updateCodeReview': {
				var id = String(request.id);
				var existing = codeReview(repo, id);
				if (!existing) {
					post({ command: command, error: 'The Code Review could not be found.' });
					return Promise.resolve(true);
				}
				var remaining = request.remainingFiles || [];
				if (remaining.length > 0) {
					existing.remainingFiles = remaining;
					existing.lastActive = Date.now();
					if (request.lastViewedFile !== null) existing.lastViewedFile = request.lastViewedFile;
					saveCodeReview(repo, existing);
				} else {
					saveCodeReview(repo, null, id);
				}
				return ok();
			}
			case 'endCodeReview':
				saveCodeReview(repo, null, String(request.id));
				return Promise.resolve(true);
			case 'fetchAvatar':
			case 'fetchPullRequest':
				return Promise.resolve(true);
			case 'rescanForRepos':
				refreshRepos().then(function () {
					if (window.__ggViewBooted) {
						post({ command: 'loadRepos', repos: repoStates(), lastActiveRepo: currentRepo || repoPath, loadViewTo: null });
					} else if (repoPath !== null && repos.length > 0) {
						window.location.reload();
					}
				});
				return Promise.resolve(true);
			default:
				return Promise.resolve(false);
		}
	}

	/* ---------- helpers the intercepts share ---------- */

	/** A comparison tab's title, exactly as the extension titles its panels (its own i18n, in
	 *  the view's interface language); undefined leaves the host's default. */
	function panelTitle(options) {
		var pages = window.GitGraphViewPage;
		if (!pages || typeof pages.panelTitle !== 'function') return undefined;
		try {
			return pages.panelTitle(Object.assign({ settings: settings || {} }, options));
		} catch (error) {
			log('panel title: ' + String(error));
			return undefined;
		}
	}

	function abbrev(hash) {
		if (hash === UNCOMMITTED) return 'Uncommitted';
		var suffix = hash.slice(-1) === '^' ? '^' : '';
		var bare = suffix ? hash.slice(0, -1) : hash;
		return (bare.length > 8 ? bare.slice(0, 8) : bare) + suffix;
	}

	function resolveDiffFromHash(fromHash, toHash) {
		var from = fromHash === UNCOMMITTED ? 'HEAD' : fromHash;
		return from === toHash ? from + '^' : from;
	}

	function quoteShellArg(value) {
		return /^[A-Za-z0-9_./-]+$/.test(value) ? value : '"' + value.replace(/["\\$`]/g, '\\$&') + '"';
	}

	function toPosix(path) { return String(path).replace(/\\/g, '/'); }

	/** The known repository a path names — as spelled in this view's repository set. The
	 *  Source Control view and the engine may spell one path differently (slashes, drive
	 *  letter case, a trailing separator), so the match ignores those. */
	function matchRepo(path) {
		var key = function (value) { return toPosix(value).replace(/\/+$/, '').toLowerCase(); };
		var wanted = key(path);
		for (var i = 0; i < repos.length; i++) if (key(repos[i]) === wanted) return repos[i];
		return null;
	}

	function basename(path) {
		var posix = toPosix(path);
		var at = posix.lastIndexOf('/');
		return at === -1 ? posix : posix.slice(at + 1);
	}

	function joinPath(base, relative) {
		var toPos = toPosix(relative);
		var joined = toPosix(base).replace(/\/+$/, '') + '/' + toPos.replace(/^\/+/, '');
		return base.indexOf('\\') !== -1 ? joined.replace(/\//g, '\\') : joined;
	}

	function viewDiffRequest(repo, request) {
		var from = String(request.fromHash), to = String(request.toHash);
		var type = String(request.type);
		var oldPath = toPosix(String(request.oldFilePath)), newPath = toPosix(String(request.newFilePath));
		if (type === 'U') {
			request_openFile(repo, newPath);
			return;
		}
		var leftRevision = resolveDiffFromHash(from, to);
		var toLabel = to === UNCOMMITTED ? 'Present' : abbrev(to);
		var description = from === to
			? (from === UNCOMMITTED ? 'Uncommitted Changes' : type === 'A' ? 'Added in ' + toLabel : type === 'D' ? 'Deleted in ' + toLabel : abbrev(leftRevision) + ' \u2194 ' + toLabel)
			: (type === 'A' ? 'Added between ' + abbrev(from) + ' & ' + toLabel : type === 'D' ? 'Deleted between ' + abbrev(from) + ' & ' + toLabel : abbrev(from) + ' \u2194 ' + toLabel);
		hostRequest('workbench.openDiff', [{
			id: 'graph:' + leftRevision + ':' + oldPath + ':' + to + ':' + newPath,
			title: basename(newPath) + ' (' + description + ')',
			repo: repo, binaryNotice: true,
			left: { revision: leftRevision, path: oldPath, label: abbrev(leftRevision), exists: type !== 'A' },
			right: { revision: to, path: newPath, label: to === UNCOMMITTED ? 'Working Tree' : abbrev(to), exists: type !== 'D' }
		}]).catch(function () { return undefined; });
	}

	function request_openFile(repo, relative) {
		hostRequest('workbench.openFile', [joinPath(repo, relative)]).catch(function () { return undefined; });
	}

	function openPullRequestUrl(request) {
		var configFields = request.config || {};
		var fields = [
			String(configFields.hostRootUrl || ''),
			String(request.sourceOwner || ''), String(request.sourceRepo || ''), String(request.sourceBranch || ''),
			String(configFields.destOwner || ''), String(configFields.destRepo || ''), String(configFields.destProjectId || ''), String(configFields.destBranch || '')
		];
		var template;
		switch (configFields.provider) {
			case 0: template = '$1/$2/$3/pull-requests/new?source=$2/$3::$4&dest=$5/$6::$8'; break; // Bitbucket
			case 1: template = String((configFields.custom || {}).templateUrl || ''); break;
			case 3: template = '$1/$2/$3/-/merge_requests/new?merge_request[source_branch]=$4&merge_request[target_branch]=$8' + (fields[6] !== '' ? '&merge_request[target_project_id]=$7' : ''); break; // GitLab
			default: template = '$1/$5/$6/compare/$8...$2:$4'; // GitHub
		}
		var url = template.replace(/\$([1-8])/g, function (_all, index) { return fields[parseInt(index, 10) - 1] || ''; });
		hostRequest('openExternal', [url]).catch(function () {
			return hostRequest('notify', ['error', 'Could not open ' + url]);
		});
	}

	function exportableRepoConfig(repo) {
		var file = {};
		if (repo.commitOrdering !== 'default') file.commitOrdering = repo.commitOrdering;
		if (repo.fileViewType === 1) file.fileViewType = 'tree';
		if (repo.fileViewType === 2) file.fileViewType = 'list';
		if (Array.isArray(repo.hideRemotes) && repo.hideRemotes.length > 0) file.hideRemotes = repo.hideRemotes;
		if (repo.includeCommitsMentionedByReflogs !== 0) file.includeCommitsMentionedByReflogs = repo.includeCommitsMentionedByReflogs === 1;
		if (repo.issueLinkingConfig !== null) file.issueLinkingConfig = repo.issueLinkingConfig;
		if (repo.name !== null) file.name = repo.name;
		if (repo.onlyFollowFirstParent !== 0) file.onlyFollowFirstParent = repo.onlyFollowFirstParent === 1;
		if (repo.onRepoLoadShowCheckedOutBranch !== 0) file.onRepoLoadShowCheckedOutBranch = repo.onRepoLoadShowCheckedOutBranch === 1;
		if (repo.onRepoLoadShowSpecificBranches !== null) file.onRepoLoadShowSpecificBranches = repo.onRepoLoadShowSpecificBranches;
		if (repo.pullRequestConfig !== null) file.pullRequestConfig = repo.pullRequestConfig;
		if (repo.showRemoteBranchesV2 !== 0) file.showRemoteBranches = repo.showRemoteBranchesV2 === 1;
		if (repo.showStashes !== 0) file.showStashes = repo.showStashes === 1;
		if (repo.showTags !== 0) file.showTags = repo.showTags === 1;
		file.exportedAt = Date.now();
		return file;
	}

	/* ---------- the host's pushes (theme switches, workspace changes, re-open params) ---------- */

	ggs.onMessage(function (event) {
		if (!event || typeof event !== 'object') return;
		if (event.kind === 'theme') {
			hostRequest('theme.stylesheet').then(function (theme) {
				applyTheme(theme);
				mirrorThemeVars();
			}).catch(function () { return undefined; });
		} else if (event.kind === 'workspace') {
			window.location.reload();
		} else if (event.kind === 'params' && event.params) {
			// A re-open of the (singleton) view: a repository it names — a submodule section's
			// own graph button — switches the view to it, a file history filter applies to it.
			var params = event.params;
			var filterPath = typeof params.filterPath === 'string' && params.filterPath !== '' ? params.filterPath : null;
			var wanted = typeof params.repo === 'string' && params.repo !== '' ? params.repo : null;
			if (wanted === null) {
				if (filterPath !== null && currentRepo) post({ command: 'loadRepos', repos: repoStates(), lastActiveRepo: currentRepo, loadViewTo: { repo: currentRepo, filterPath: filterPath } });
				return;
			}
			// The Source Control view may know a submodule initialised since this view read the
			// repository set: re-read it before switching (the old native host's switchRepo).
			refreshRepos().then(function () {
				var target = matchRepo(wanted);
				if (target === null) return;
				if (target === currentRepo && filterPath === null) return;
				currentRepo = target;
				post({ command: 'loadRepos', repos: repoStates(), lastActiveRepo: target, loadViewTo: filterPath !== null ? { repo: target, filterPath: filterPath } : { repo: target } });
			}).catch(function (error) { log('switch repository: ' + String(error)); });
		}
	});

	// The shell's keyboard shortcuts (Ctrl+B, Ctrl+`, …) must work while the view has focus.
	window.addEventListener('keydown', function (event) {
		if (!(event.ctrlKey || event.metaKey)) return;
		var key = event.key.toLowerCase();
		if (['`', 'j', 'b', 'o', 'w', 'tab', 'pageup', 'pagedown'].indexOf(key) !== -1 || (event.shiftKey && (key === 'e' || key === 'g'))) {
			event.preventDefault();
			hostRequest('workbench.forwardKey', [{ key: event.key, ctrlKey: event.ctrlKey, metaKey: event.metaKey, shiftKey: event.shiftKey, altKey: event.altKey }]).catch(function () { return undefined; });
		}
	});

	// Script errors must not leave a silent near-empty skeleton: they go to the session log.
	window.addEventListener('error', function (event) {
		log('VIEW ERROR: ' + (event.message || 'Script error') + (event.filename ? ' (' + String(event.filename).split('/').pop() + ':' + event.lineno + ')' : ''));
	});

	var bootGuard = window.setTimeout(function () {
		if (window.__ggViewBooted || window.__ggViewNoRepo) return;
		var div = document.createElement('div');
		div.style.cssText = 'padding:20px;color:var(--vscode-errorForeground,#f48771)';
		div.textContent = 'The Git Graph view failed to start. Open the session log or reinstall the git-graph-rs extension.';
		(document.getElementById('content') || document.body).appendChild(div);
	}, 4000);

	// The generated page's last script marks the boot (the watchdog above and the rescan
	// handling key off it); viewpage.js sets the flag itself at the end of its bundle.
	window.__ggViewBooted = false;
	window.__ggViewNoRepo = false;

	boot();
})();
