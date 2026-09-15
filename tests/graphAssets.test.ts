// The Git Graph view's mount: the integrated extension's page is the app's own
// /gitgraph/view.html, loaded by URL into the frame (no package probe, no blob URLs). The
// repository set the view's dropdown offers is the open repository plus its initialised
// submodules; a folder that is not a repository gets the Initialize placeholder instead.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GraphHost, type GraphHostDelegate } from '../src/graphHost';
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
});
