// The Git Graph view's mount: the integrated extension's page is the app's own
// /gitgraph/view.html, loaded by URL into the frame (no package probe, no blob URLs). The
// repository set the view's dropdown offers is the open repository plus its initialised
// submodules; a folder that is not a repository gets the Initialize placeholder instead.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GraphHost, type GraphHostDelegate } from '../src/graphHost';
import { THEME_EVENT, updateSetting } from '../src/settings';
import { backend } from './tauriMock';
import { flush } from './helpers';

const delegate: GraphHostDelegate = {
	openFile: () => undefined,
	openDiff: () => undefined,
	openFileAtRevision: () => undefined,
	openCompareTab: () => undefined,
	showSourceControl: () => undefined,
	revealTerminal: () => undefined,
	runInTerminal: () => undefined,
	repoChanged: () => undefined,
	initRepository: () => undefined
};

describe('graph assets', () => {
	beforeEach(() => {
		localStorage.clear();
		sessionStorage.clear();
		backend.on('repo_submodules', () => []);
	});

	it('mounts the view frame on the app\'s own static page', async () => {
		const host = new GraphHost(delegate);
		document.body.appendChild(host.element);
		host.load('C:\\repo');
		expect(host.loaded).toBe(true);
		await flush(10);
		expect(host.frame.srcdoc).toBe('');
		expect(host.frame.getAttribute('src')).toBe('/gitgraph/view.html');
		// No cache-busting query: the webview may cache the bundle between loads.
		expect(host.frame.src).not.toContain('?');
		expect(sessionStorage.getItem('ggstudio.initial')).toContain('C:\\\\repo');
	});

	it('offers the open repository and its initialised submodules to the view', async () => {
		backend.on('repo_submodules', () => ['C:\\repo\\sub\\dep', 'C:\\repo\\vendor\\lib']);
		const host = new GraphHost(delegate);
		document.body.appendChild(host.element);
		host.load('C:\\repo');
		await flush(10);
		const initial = JSON.parse(sessionStorage.getItem('ggstudio.initial')!) as { initialState: { repos: Record<string, unknown> } };
		expect(Object.keys(initial.initialState.repos).sort()).toEqual(['C:\\repo', 'C:\\repo\\sub\\dep', 'C:\\repo\\vendor\\lib']);

		// A loadRepos request from the view re-reads the set (a submodule may have been
		// initialised since) and answers with it.
		const frameWindow = host.frame.contentWindow!;
		const postSpy = vi.spyOn(frameWindow, 'postMessage').mockImplementation(() => undefined);
		window.dispatchEvent(new MessageEvent('message', { source: frameWindow, data: { __studioGraphRequest: { command: 'loadRepos' } } }));
		await flush(10);
		const sent = postSpy.mock.calls.map((call) => call[0] as { __studioGraphResponse: Record<string, unknown> })
			.filter((message) => message.__studioGraphResponse['command'] === 'loadRepos')
			.map((message) => message.__studioGraphResponse)[0];
		expect(Object.keys(sent['repos'] as Record<string, unknown>).sort()).toEqual(['C:\\repo', 'C:\\repo\\sub\\dep', 'C:\\repo\\vendor\\lib']);
		expect(sent['lastActiveRepo']).toBe('C:\\repo');
	});

	it('switches the view to a submodule - the Source Control view\'s per-repository graph icon', async () => {
		backend.on('repo_submodules', () => ['C:\\repo\\sub\\dep']);
		const host = new GraphHost(delegate);
		document.body.appendChild(host.element);
		host.load('C:\\repo');
		await flush(10);
		const frameWindow = host.frame.contentWindow!;
		const postSpy = vi.spyOn(frameWindow, 'postMessage').mockImplementation(() => undefined);
		host.switchRepo('C:\\repo\\sub\\dep');
		await flush(10);
		const sent = postSpy.mock.calls
			.map((call) => (call[0] as { __studioGraphResponse: Record<string, unknown> }).__studioGraphResponse)
			.filter((message) => message['command'] === 'loadRepos')[0];
		// The loadRepos response the view's own dropdown switch produces: the repository set,
		// the new repository as the active one, and a loadViewTo that names it.
		expect(Object.keys(sent['repos'] as Record<string, unknown>)).toContain('C:\\repo\\sub\\dep');
		expect(sent['lastActiveRepo']).toBe('C:\\repo\\sub\\dep');
		expect(sent['loadViewTo']).toEqual({ repo: 'C:\\repo\\sub\\dep' });
		// The host stays in step: a later loadRepos request from the view is answered with the
		// switched repository as the active one.
		window.dispatchEvent(new MessageEvent('message', { source: frameWindow, data: { __studioGraphRequest: { command: 'loadRepos' } } }));
		await flush(10);
		const followUp = postSpy.mock.calls
			.map((call) => (call[0] as { __studioGraphResponse: Record<string, unknown> }).__studioGraphResponse)
			.filter((message) => message['command'] === 'loadRepos')
			.at(-1)!;
		expect(followUp['lastActiveRepo']).toBe('C:\\repo\\sub\\dep');

		// A repository outside the set is not switched to, and a repeat switch posts nothing.
		host.switchRepo('C:\\elsewhere');
		await flush(10);
		expect(postSpy.mock.calls.filter((call) => (call[0] as { __studioGraphResponse: Record<string, unknown> }).__studioGraphResponse['command'] === 'loadRepos').length).toBe(2);
	});

	it('lands a repository switch that raced the load on the freshly mounted view', async () => {
		backend.on('repo_submodules', () => ['C:\\repo\\sub\\dep']);
		const host = new GraphHost(delegate);
		document.body.appendChild(host.element);
		host.load('C:\\repo');
		host.switchRepo('C:\\repo\\sub\\dep'); // before the mount's repository read settles
		await flush(10);
		const initial = JSON.parse(sessionStorage.getItem('ggstudio.initial')!) as { initialState: { lastActiveRepo: string } };
		expect(initial.initialState.lastActiveRepo).toBe('C:\\repo\\sub\\dep');
	});

	it('opens a diff from a submodule against that submodule, not the open repository', async () => {
		const openDiff = vi.fn();
		const host = new GraphHost({ ...delegate, openDiff });
		document.body.appendChild(host.element);
		host.load('C:\repo');
		await flush(10);
		const frameWindow = host.frame.contentWindow!;
		vi.spyOn(frameWindow, 'postMessage').mockImplementation(() => undefined);
		window.dispatchEvent(new MessageEvent('message', { source: frameWindow, data: { __studioGraphRequest: {
			command: 'viewDiff', repo: 'C:\repo\dep', fromHash: 'abc123def', toHash: 'abc123def',
			type: 'M', oldFilePath: 'lib.js', newFilePath: 'lib.js'
		} } }));
		await flush(10);
		expect(openDiff).toHaveBeenCalledTimes(1);
		const diff = openDiff.mock.calls[0][0] as { repo?: string; left: { revision: string } };
		expect(diff.repo).toBe('C:\repo\dep');
		expect(diff.left.revision).toBe('abc123def^');
	});

	it('keys a code review to the repository the request names, so a submodule review is found', async () => {
		backend.on('graph_request', (args) => {
			const message = args['message'] as Record<string, unknown>;
			return { command: message['command'], commitDetails: {}, codeReview: null, error: null };
		});
		const host = new GraphHost(delegate);
		document.body.appendChild(host.element);
		host.load('C:\\repo');
		await flush(10);
		const frameWindow = host.frame.contentWindow!;
		const postSpy = vi.spyOn(frameWindow, 'postMessage').mockImplementation(() => undefined);
		// The view is switched to the submodule: the review starts and is looked up there.
		window.dispatchEvent(new MessageEvent('message', { source: frameWindow, data: { __studioGraphRequest: {
			command: 'startCodeReview', repo: 'C:\\repo\\sub', id: 'abc123', commitHash: 'abc123', compareWithHash: null, files: ['f.txt']
		} } }));
		await flush(10);
		window.dispatchEvent(new MessageEvent('message', { source: frameWindow, data: { __studioGraphRequest: {
			command: 'commitDetails', repo: 'C:\\repo\\sub', commitHash: 'abc123'
		} } }));
		await flush(10);
		const posted = postSpy.mock.calls
			.map((call) => (call[0] as { __studioGraphResponse: Record<string, unknown> }).__studioGraphResponse)
			.filter((message) => message['command'] === 'commitDetails')
			.at(-1)!;
		expect(posted['codeReview']).toMatchObject({ id: 'abc123' });
	});

	it('shows the Initialize placeholder over a blank frame for a folder without a repository', async () => {
		const init = vi.fn();
		const host = new GraphHost({ ...delegate, initRepository: init });
		document.body.appendChild(host.element);
		host.load('C:\\plain', false);
		expect(host.loaded).toBe(false);
		expect(host.frame.getAttribute('src')).toBe('about:blank');
		const placeholder = host.element.querySelector('.graph-placeholder');
		expect(placeholder).not.toBeNull();
		expect(placeholder!.textContent).toContain('Not a Git repository');
		(host.element.querySelector('.graph-placeholder button') as HTMLButtonElement).click();
		expect(init).toHaveBeenCalledTimes(1);

		// Loading a repository afterwards drops the placeholder and mounts the page.
		host.load('C:\repo');
		await flush(10);
		expect(host.element.querySelector('.graph-placeholder')).toBeNull();
		expect(host.frame.getAttribute('src')).toBe('/gitgraph/view.html');
	});

	it('replaces the page on a reload and blanks the frame on unload', async () => {
		const host = new GraphHost(delegate);
		document.body.appendChild(host.element);
		host.load('C:\\repo');
		await flush(10);
		host.load('C:\\other');
		await flush(10);
		expect(host.frame.getAttribute('src')).toBe('/gitgraph/view.html');
		host.unload();
		expect(host.frame.srcdoc).toBe('');
		expect(host.frame.src).toContain('about:blank');
		expect(host.loaded).toBe(false);
	});

	it('drops the view\'s persisted state on a repository switch, and keeps it on a reload', async () => {
		const host = new GraphHost(delegate);
		document.body.appendChild(host.element);
		host.load('C:\\repo');
		await flush(10);
		// What the view persists through its own shim (view.html): the repository it last
		// showed, and where it was scrolled to.
		sessionStorage.setItem('ggstudio.viewState', JSON.stringify({ currentRepo: 'C:\\repo', scrollTop: 120 }));
		// A reload of the same folder keeps it - the reader's place survives an external reload.
		host.load('C:\\repo');
		await flush(10);
		expect(JSON.parse(sessionStorage.getItem('ggstudio.viewState')!)).toMatchObject({ currentRepo: 'C:\\repo' });
		// A switch must not: on boot the page offers the persisted repository back as a
		// loadViewTo, and a repository the new set does not contain makes the view show its
		// "not currently included in Git Graph" error naming the previous repository.
		host.load('D:\\other');
		await flush(10);
		expect(sessionStorage.getItem('ggstudio.viewState')).toBeNull();
	});

	it('follows a theme switch into the view frame without a reload', async () => {
		const host = new GraphHost(delegate);
		document.body.appendChild(host.element);
		host.load('C:\\repo');
		await flush(10);
		// jsdom's never-navigated iframe document has no html/head/body; a real browser always
		// provides them (view.html carries all three), so the skeleton exists before the theme
		// switch the way the real page's does.
		const doc = host.frame.contentDocument!;
		if (!doc.documentElement) doc.appendChild(doc.createElement('html'));
		if (!doc.head) doc.documentElement.appendChild(doc.createElement('head'));
		if (!doc.body) doc.documentElement.appendChild(doc.createElement('body'));
		// The theme event bubbles (the host listens on window); jsdom never fires a stylesheet
		// link's load, so the event the real applyTheme waits for is dispatched as the
		// convention of tests/settings.test.ts.
		const themed = (): Record<string, unknown> => {
			const link = doc.getElementById('ggs-host-theme') as HTMLLinkElement | null;
			return { href: link?.getAttribute('href') ?? null, html: doc.documentElement.className, body: doc.body.className };
		};
		updateSetting('theme', 'light-modern');
		document.dispatchEvent(new CustomEvent(THEME_EVENT, { bubbles: true }));
		expect(themed()).toMatchObject({ href: '/theme/light-modern.css', html: expect.stringContaining('vscode-light'), body: expect.stringContaining('vscode-light') });
		// The sheet swap announces itself so the view re-mirrors its colour tokens; jsdom
		// cannot fire the link load, so only the swap itself is asserted here.
		updateSetting('theme', 'dark-modern');
		document.dispatchEvent(new CustomEvent(THEME_EVENT, { bubbles: true }));
		expect(themed()).toMatchObject({ href: '/theme/dark-modern.css', html: expect.stringContaining('vscode-dark'), body: expect.stringContaining('vscode-dark') });
	});

	it('delivers the Gerrit states in stages after a pending load', async () => {
		// The backend's first answer pends (the refresh pipeline has not run); the host then
		// refreshes and delivers the fresh states as the extension's staged follow-up responses
		// under the same refresh id: the light part the badges render, then the full states.
		let loads = 0;
		const state = { change: 41466, patchset: 2, codeReview: 2, verified: 0, status: 'new', wip: false, headHash: 'deadbeef', url: null,
			events: [{ type: 'vote', patchset: 2, reviewer: 'R', labels: [{ name: 'Code-Review', value: 2 }], timestamp: 1, raw: 'Patch Set 2', rawFull: 'Patch Set 2' }] };
		backend.on('graph_request', (args) => {
			const message = args['message'] as Record<string, unknown>;
			if (message['command'] === 'gerritRefresh') {
				return { command: 'gerritRefresh', error: null, changes: 1, refreshed: true };
			}
			if (message['command'] === 'loadCommits') {
				loads += 1;
				return loads === 1
					? { command: 'loadCommits', refreshId: 7, commits: [], head: 'abc', tags: [], moreCommitsAvailable: false, gerritStates: null, gerritPending: true, error: null }
					: { command: 'loadCommits', refreshId: 7, commits: [], head: 'abc', tags: [], moreCommitsAvailable: false, gerritStates: [state], error: null };
			}
			return { command: message['command'], error: null };
		});
		const host = new GraphHost(delegate);
		document.body.appendChild(host.element);
		host.load('C:\\repo');
		await flush(10);
		const frameWindow = host.frame.contentWindow!;
		const postSpy = vi.spyOn(frameWindow, 'postMessage').mockImplementation(() => undefined);
		window.dispatchEvent(new MessageEvent('message', { source: frameWindow, data: { __studioGraphRequest: {
			command: 'loadCommits', repo: 'C:\\repo', refreshId: 7, gerritFetchRefs: true, gerritFetchLimit: null,
			gerritStatusFilter: { new: true, merged: true, abandoned: true, wip: true }
		} } }));
		await vi.waitFor(() => expect(postSpy.mock.calls
			.filter((call) => (call[0] as { __studioGraphResponse: Record<string, unknown> }).__studioGraphResponse['command'] === 'loadCommits')
			.length).toBe(3));

		// The Gerrit remote and the resolved fetch limit ride along with the requests (the
		// view's own message names neither).
		const calls = backend.callsTo('graph_request').map((call) => call['message'] as Record<string, unknown>);
		expect(calls.find((message) => message['command'] === 'gerritRefresh')).toMatchObject({ repo: 'C:\\repo', gerritRemote: 'origin', gerritFetchLimit: 20 });
		expect(calls.find((message) => message['command'] === 'loadCommits')).toMatchObject({ gerritRemote: 'origin', gerritFetchLimit: 20 });

		const posted = postSpy.mock.calls
			.map((call) => (call[0] as { __studioGraphResponse: Record<string, unknown> }).__studioGraphResponse)
			.filter((message) => message['command'] === 'loadCommits');
		expect(posted[0]!['gerritPending']).toBe(true);
		// Stage 1 - the badges: the states without their event timelines; stage 2 - the full
		// states, which only the review dialog reads. Neither says pending again.
		const light = posted[1]!['gerritStates'] as Record<string, unknown>[];
		expect(light[0]!['events']).toEqual([]);
		expect(light[0]!['eventsPending']).toBe(true);
		expect('gerritPending' in posted[1]!).toBe(false);
		const full = posted[2]!['gerritStates'] as Record<string, unknown>[];
		expect((full[0]!['events'] as unknown[]).length).toBe(1);
		expect('gerritPending' in posted[2]!).toBe(false);
	});

	it('does not run the Gerrit follow-up when the backend\'s answer is not pending', async () => {
		backend.on('graph_request', (args) => {
			const message = args['message'] as Record<string, unknown>;
			return { command: message['command'], error: null };
		});
		const host = new GraphHost(delegate);
		document.body.appendChild(host.element);
		host.load('C:\\repo');
		await flush(10);
		const frameWindow = host.frame.contentWindow!;
		const postSpy = vi.spyOn(frameWindow, 'postMessage').mockImplementation(() => undefined);
		window.dispatchEvent(new MessageEvent('message', { source: frameWindow, data: { __studioGraphRequest: {
			command: 'loadCommits', repo: 'C:\\repo', refreshId: 1, gerritFetchRefs: false
		} } }));
		await flush(20);
		expect(backend.callsTo('graph_request').some((call) => (call['message'] as Record<string, unknown>)['command'] === 'gerritRefresh')).toBe(false);
	});
});
