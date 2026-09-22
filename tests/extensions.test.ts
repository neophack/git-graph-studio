import { beforeEach, describe, expect, it } from 'vitest';

import { ensureBuiltinSettings, ExtensionHost, type ExtInfo } from '../src/extHost';
import { extensionSettingDefs, resolvedMenuEntries } from '../src/contributions';
import { ExtensionsPanel } from '../src/extensionsPanel';
import { commandForBinding, commands } from '../src/commands';
import { createVscodeApi } from '../src/vscodeApi';
// The frame half of the extension host, loaded for its window message listener: under jsdom the
// frame's `parent` is this same window, so tests drive it with MessageEvents and read its posts.
import '../src/extHostBoot';
import { backend } from './tauriMock';
import { click, flush, key, menuItem, menuLabels, notificationButton, notifications, rightClick, type } from './helpers';
import { Explorer } from '../src/explorer';

const BUILTIN: ExtInfo = { id: 'neophack.git-graph-rs', name: 'git-graph-rs', displayName: 'Git Graph', publisher: 'neophack', version: '1.0.23', description: 'Git Graph', builtin: true, icon: null, path: '', categories: ['SCM Providers'], keywords: ['git'], repository: 'https://github.com/neophack/git-graph-rs', license: 'MIT', enginesVscode: '^1.80.0', extensionDependencies: [], extensionPack: [], readme: 'README.md', changelog: null, format: 'builtin', ggx: null };
const USER: ExtInfo = { id: 'acme.demo', name: 'demo', displayName: null, publisher: 'acme', version: '2.0.0', description: 'A demo', builtin: false, icon: null, path: '/ext/acme.demo-2.0.0', categories: [], keywords: [], repository: null, license: null, enginesVscode: null, extensionDependencies: ['acme.base'], extensionPack: [], readme: null, changelog: null, format: 'vsix', ggx: null };

function withExtensions(...extensions: ExtInfo[]): void {
	backend.on('ext_list', () => extensions);
}

function mountedPanel(host = new ExtensionHost()): ExtensionsPanel {
	const container = document.body.appendChild(document.createElement('div'));
	return new ExtensionsPanel(container, host);
}

describe('ExtensionsPanel', () => {
	beforeEach(() => withExtensions(BUILTIN, USER));

	it('lists installed extensions with versions and the built-in marker', async () => {
		const panel = mountedPanel();
		await panel.refresh();
		const names = [...document.querySelectorAll('.ext-name')].map((n) => n.textContent);
		expect(names.join('|')).toContain('Git Graph');
		expect(names.join('|')).toContain('demo');
		expect(document.querySelector('.ext-builtin')).not.toBeNull();
		// The integrated entry (no package installed) offers the one-click bundled install, not
		// an uninstall; user extensions get the uninstall.
		const builtinButton = document.querySelectorAll<HTMLElement>('.ext-row')[0]!.querySelector<HTMLElement>('.action-btn')!;
		expect(builtinButton.title).toContain('Install the bundled');
		const userButton = document.querySelectorAll<HTMLElement>('.ext-row')[1]!.querySelector<HTMLElement>('.action-btn')!;
		expect(userButton.title).toContain('Uninstall acme.demo');
	});

	it('installs the bundled git-graph-rs package from the integrated entry, as a standard package', async () => {
		let listed: ExtInfo[] = [BUILTIN, USER];
		backend.on('ext_list', () => listed);
		const installedGgx: ExtInfo = { ...BUILTIN, builtin: false, format: 'ggx', version: '1.0.25', path: '/ext/neophack.git-graph-rs-1.0.25' };
		backend.on('ext_install_bundled', () => installedGgx);
		const panel = mountedPanel();
		await panel.refresh();
		document.querySelectorAll<HTMLElement>('.ext-row')[0]!.querySelector<HTMLElement>('.action-btn')!.click();
		await flush();
		expect(backend.callsTo('ext_install_bundled')).toEqual([{ extId: 'neophack.git-graph-rs' }]);
		expect(notifications().join()).toContain('neophack.git-graph-rs v1.0.25');
		// Once installed it is a standard package: the button becomes the ordinary uninstall.
		listed = [installedGgx, USER];
		await panel.refresh();
		const integrated = document.querySelectorAll<HTMLElement>('.ext-row')[0]!.querySelector<HTMLElement>('.action-btn')!;
		expect(integrated.title).toContain('Uninstall neophack.git-graph-rs');
	});

	it('offers the bundled sample the same way: a not-yet-installed entry installs by its id', async () => {
		// What cmd_ext.rs's listing composes when no demo package is installed: the embedded
		// manifest stands in, `format: 'builtin'` (the install offer), `builtin: false` (it is
		// a sample, nothing of it is built into the app).
		const SAMPLE: ExtInfo = { id: 'ggs.ext-demo', name: 'ext-demo', displayName: 'GGX Demo', publisher: 'ggs', version: '0.2.0', description: 'The worked example', builtin: false, icon: null, path: '', categories: ['Examples'], keywords: [], repository: null, license: null, enginesVscode: null, extensionDependencies: [], extensionPack: [], readme: null, changelog: null, format: 'builtin', ggx: null };
		let listed: ExtInfo[] = [BUILTIN, SAMPLE, USER];
		backend.on('ext_list', () => listed);
		const installed: ExtInfo = { ...SAMPLE, format: 'ggx', path: '/ext/ggs.ext-demo-0.2.0', ggx: { format: 'ggx/2', id: 'ggs.ext-demo', version: '0.2.0', pages: { main: { page: 'web/view.html' } }, backend: { kind: 'process', command: 'bin/win32-x64/ggs-ext-demo.exe' }, permissions: ['clipboard'] } };
		backend.on('ext_install_bundled', ({ extId }) => (extId === 'ggs.ext-demo' ? installed : BUILTIN));
		const panel = mountedPanel();
		await panel.refresh();
		// The sample row: its badge and its one-click install button.
		expect([...document.querySelectorAll('.ext-builtin')].map((b) => b.textContent)).toEqual(['built-in', 'sample']);
		const sampleRow = document.querySelectorAll<HTMLElement>('.ext-row')[1]!;
		const button = sampleRow.querySelector<HTMLElement>('.action-btn')!;
		expect(button.title).toContain('Install the bundled sample');
		button.click();
		await flush();
		expect(backend.callsTo('ext_install_bundled')).toEqual([{ extId: 'ggs.ext-demo' }]);
		expect(notifications().join()).toContain('ggs.ext-demo v0.2.0');
		// Installed, it is an ordinary process package: uninstall and restart buttons, no offer.
		listed = [BUILTIN, installed, USER];
		await panel.refresh();
		const row = document.querySelectorAll<HTMLElement>('.ext-row')[1]!;
		expect([...row.querySelectorAll('.action-btn')].map((b) => b.title).join('|')).toContain('Uninstall ggs.ext-demo');
		expect([...row.querySelectorAll('.action-btn')].map((b) => b.title).join('|')).toContain('Restart');
	});

	it('shows a process package\'s backend state and restarts it', async () => {
		const PROC: ExtInfo = {
			...USER, id: 'acme.proc', displayName: 'Proc', format: 'ggx',
			ggx: { format: 'ggx/2', id: 'acme.proc', version: '2.0.0', pages: {}, backend: { kind: 'process', command: 'bin/main' }, permissions: [] }
		};
		backend.on('ext_list', () => [BUILTIN, PROC]);
		backend.on('ext_process_status', () => [
			{ extensionId: 'acme.proc', pid: 4321, commands: ['acme.proc.hello'], protocolVersion: 'ggs-ext/1', startCount: 2, lastError: null }
		]);
		const panel = mountedPanel();
		await panel.refresh();
		expect(document.querySelector('.ext-process.running')!.textContent).toContain('Running · pid 4321');
		expect(document.querySelector('.ext-process.running')!.textContent).toContain('start #2');

		// Restart: stop, then start; a backend that is down says so, with its last error.
		backend.on('ext_process_stop', () => null);
		backend.on('ext_process_start', () => null);
		backend.on('ext_process_status', () => [
			{ extensionId: 'acme.proc', pid: 0, commands: [], protocolVersion: 'ggs-ext/1', startCount: 2, lastError: 'the backend exited' }
		]);
		document.querySelector<HTMLElement>('.action-btn[title*="Restart"]')!.click();
		await flush();
		expect(backend.callsTo('ext_process_stop')).toEqual([{ extId: 'acme.proc' }]);
		expect(backend.callsTo('ext_process_start')).toEqual([{ extId: 'acme.proc' }]);
		expect(document.querySelector('.ext-process')!.textContent).toContain('Not running · the backend exited');
	});

	it('a row click asks the workbench to open the extension\'s detail page', async () => {
		const panel = mountedPanel();
		await panel.refresh();
		let opened: ExtInfo | null = null;
		panel.onOpenDetail = (ext) => { opened = ext; };
		document.querySelectorAll<HTMLElement>('.ext-row')[1]!.click();
		expect(opened).toBeTruthy();
		expect(opened!.id).toBe('acme.demo');
		// The inline chevron section is gone: the page carries the details now.
		expect(document.querySelector('.ext-detail')).toBeNull();
	});

	it('the detail page shows the facts and renders the package\'s README', async () => {
		const PROC: ExtInfo = {
			...USER, id: 'acme.proc', displayName: 'Proc', format: 'ggx', path: '/ext/acme.proc-2.0.0', readme: 'README.md',
			ggx: {
				format: 'ggx/2', id: 'acme.proc', version: '2.0.0', pages: {},
				backend: { kind: 'process', command: 'bin/main', protocol: 'ggx-rpc/1' },
				permissions: ['repo:read', 'network']
			}
		};
		backend.on('ext_list', () => [BUILTIN, PROC]);
		backend.on('ext_process_status', () => [
			{ extensionId: 'acme.proc', pid: 4321, commands: [], protocolVersion: 'ggx-rpc/1', startCount: 1, lastError: null }
		]);
		backend.on('ext_read_file', () => '# Proc\n\nThe readme.');
		// jsdom loads no vendor script: a tiny markdown-it stand-in renders the README.
		(window as unknown as { markdownit: unknown }).markdownit = {
			render: (text: string) => text.split('\n').map((line) => `<p>${line}</p>`).join(''),
			renderer: { rules: {} }
		};
		const panel = mountedPanel();
		await panel.refresh();
		const pane = document.body.appendChild(document.createElement('div'));
		panel.mountDetail(PROC, pane);
		const page = pane.querySelector<HTMLElement>('.ext-detail-page')!;
		expect(page).not.toBeNull();
		// The header: the resolved name and the description.
		expect(page.textContent).toContain('Proc');
		expect(page.textContent).toContain('A demo');
		// The facts: identifier, install location, declared backend and its live process,
		// permissions.
		expect(page.textContent).toContain('acme.proc');
		expect(page.textContent).toContain('/ext/acme.proc-2.0.0');
		expect(page.textContent).toContain('ggx-rpc/1');
		expect(page.textContent).toContain('bin/main');
		expect(page.textContent).toContain('repo:read, network');
		await flush(4);
		expect(pane.querySelector('.ext-detail-readme article')!.innerHTML).toContain('<p># Proc</p>');

		// The built-in entry (no ggx, no path) reports "embedded" and no backend, and points
		// at the install for the README it cannot read yet.
		const builtinPane = document.body.appendChild(document.createElement('div'));
		panel.mountDetail(BUILTIN, builtinPane);
		expect(builtinPane.textContent).toContain('Embedded (not installed as a package)');
		expect(builtinPane.textContent).toContain('None (frontend only)');
		expect(builtinPane.textContent).toContain('Install the package to read its README');
	});

	it('installs from a picked .ggx package and refreshes', async () => {
		backend.dialog.openResult = 'C:\\downloads\\acme.demo-2.1.0.ggx';
		const installed: ExtInfo = { ...USER, version: '2.1.0', format: 'ggx' };
		backend.on('ext_install_from_ggx', () => installed);
		let listed = [BUILTIN, USER];
		backend.on('ext_list', () => listed);
		const panel = mountedPanel();
		await panel.refresh();
		await panel.installFromGgxCommand();
		expect(backend.callsTo('ext_install_from_ggx')).toEqual([{ path: 'C:\\downloads\\acme.demo-2.1.0.ggx' }]);
		expect(notifications().join()).toContain('acme.demo v2.1.0');
		listed = [BUILTIN, installed];
		await panel.refresh();
		expect([...document.querySelectorAll('.ext-version')].map((v) => v.textContent)).toContain('v2.1.0');
	});

	it('installs from a picked .vsix — the VS Code compatibility path', async () => {
		backend.dialog.openResult = 'C:\\downloads\\acme.demo-2.1.0.vsix';
		const installed: ExtInfo = { ...USER, version: '2.1.0', format: 'vsix' };
		backend.on('ext_install_from_vsix', () => installed);
		let listed = [BUILTIN, USER];
		backend.on('ext_list', () => listed);
		const panel = mountedPanel();
		await panel.refresh();
		await panel.installFromVsixCommand();
		expect(backend.callsTo('ext_install_from_vsix')).toEqual([{ path: 'C:\\downloads\\acme.demo-2.1.0.vsix' }]);
		expect(notifications().join()).toContain('acme.demo v2.1.0');
		// The panel's header carries both install actions: the GGX one and the VSIX one.
		expect([...document.querySelectorAll('.pane-header .action-btn')].some((b) => b.title.includes('Install from VSIX'))).toBe(true);
	});

	it('surfaces the error when a same-version package is installed again', async () => {
		backend.dialog.openResult = 'C:\\downloads\\git-graph-rs-1.0.24.ggx';
		backend.on('ext_install_from_ggx', () => { throw 'neophack.git-graph-rs 1.0.24 is already installed'; });
		const panel = mountedPanel();
		await panel.refresh();
		await panel.installFromGgxCommand();
		expect(notifications().join()).toContain('already installed');
	});

	it('surfaces install errors (a downgrade, for instance)', async () => {
		backend.dialog.openResult = 'old.ggx';
		backend.on('ext_install_from_ggx', () => { throw 'acme.demo 2.0.0 is already installed; acme.demo 1.0.0 is older'; });
		const panel = mountedPanel();
		await panel.installFromGgxCommand();
		expect(notifications().join()).toContain('older');
	});

	it('uninstalls a user extension after confirmation', async () => {
		backend.on('ext_uninstall', () => null);
		let listed = [BUILTIN, USER];
		backend.on('ext_list', () => listed);
		const panel = mountedPanel();
		await panel.refresh();
		const uninstall = (async () => { await panel['uninstall'](USER); })();
		await Promise.resolve();
		click(notificationButton('Uninstall'));
		await uninstall;
		expect(backend.callsTo('ext_uninstall')).toEqual([{ extId: 'acme.demo' }]);
		listed = [BUILTIN];
		await panel.refresh();
		expect(document.querySelectorAll('.ext-row')).toHaveLength(1);
	});

	it('keeps a built-in when its uninstall is refused by the backend', async () => {
		backend.on('ext_uninstall', () => { throw 'neophack.git-graph-rs is built into Git Graph Studio and cannot be uninstalled'; });
		const panel = mountedPanel();
		await panel.refresh();
		const uninstall = (async () => { await panel['uninstall'](BUILTIN); })();
		await Promise.resolve();
		click(notificationButton('Uninstall'));
		await uninstall;
		expect(notifications().join()).toContain('cannot be uninstalled');
	});

	it('loads an icon from a subfolder of the extension root (the manifest-relative path)', async () => {
		// ExtInfo.icon is absolute (<ext dir>/resources/icon.png); the backend resolves the
		// path it is given against the extension root, so the subfolder must survive.
		backend.on('ext_list', () => [{ ...USER, icon: `${USER.path}/resources/icon.png` }]);
		backend.on('ext_read_file_base64', () => 'aGk=');
		const panel = mountedPanel();
		await panel.refresh();
		await flush();
		expect(backend.callsTo('ext_read_file_base64')).toEqual([{ extId: 'acme.demo', relPath: 'resources/icon.png' }]);
		expect(document.querySelector('.ext-icon-img')).not.toBeNull();
	});

	it('loads an icon from a subfolder spelled with Windows separators', async () => {
		backend.on('ext_list', () => [{ ...USER, path: 'C:\\ext\\acme.demo-2.0.0', icon: 'C:\\ext\\acme.demo-2.0.0\\resources\\icon.png' }]);
		backend.on('ext_read_file_base64', () => 'aGk=');
		const panel = mountedPanel();
		await panel.refresh();
		await flush();
		expect(backend.callsTo('ext_read_file_base64')).toEqual([{ extId: 'acme.demo', relPath: 'resources\\icon.png' }]);
		expect(document.querySelector('.ext-icon-img')).not.toBeNull();
	});

	it('still loads an icon at the extension root', async () => {
		backend.on('ext_list', () => [{ ...USER, icon: `${USER.path}/favicon.png` }]);
		backend.on('ext_read_file_base64', () => 'aGk=');
		const panel = mountedPanel();
		await panel.refresh();
		await flush();
		expect(backend.callsTo('ext_read_file_base64')).toEqual([{ extId: 'acme.demo', relPath: 'favicon.png' }]);
	});

});

describe('the vscode API shim', () => {
	it('registers commands through the bridge and keeps the handler callable', async () => {
		const registeredIds: string[] = [];
		let handler: ((...args: unknown[]) => unknown) | null = null;
		const api = createVscodeApi(
			{ extensionId: 'acme.demo', extensionPath: '/ext/acme.demo-2.0.0', workspaceFolders: [], settings: {}, language: 'en' },
			{
				request: async (method) => {
					if (method === 'commands.register') registeredIds.push('queued');
					return undefined;
				},
				registerCommandHandler: (id, fn) => { registeredIds.push(id); handler = fn; }
			}
		);
		api.commands.registerCommand('sayHi', (...args: unknown[]) => `hi ${args[0]}`);
		expect(registeredIds).toEqual(['acme.demo.sayHi', 'queued']);
		expect(handler!('world')).toBe('hi world');
	});

	it('reads and persists configuration through the settings bridge', async () => {
		const settings: Record<string, unknown> = { 'demo.greeting': 'hello' };
		const updates: unknown[][] = [];
		const api = createVscodeApi(
			{ extensionId: 'acme.demo', extensionPath: '/ext', workspaceFolders: [], settings, language: 'en' },
			{ request: async (method, args) => { if (method === 'settings.update') updates.push(args); return undefined; }, registerCommandHandler: () => undefined }
		);
		const config = api.workspace.getConfiguration('demo');
		expect(config.get('greeting')).toBe('hello');
		expect(config.get('missing', 'fallback')).toBe('fallback');
		await config.update('greeting', 'hey');
		expect(settings['demo.greeting']).toBe('hey');
		expect(updates).toEqual([['acme.demo', 'demo.greeting', 'hey']]);
	});

	it('throws a clear error for unsupported APIs', () => {
		const api = createVscodeApi(
			{ extensionId: 'x', extensionPath: '/x', workspaceFolders: [], settings: {}, language: 'en', webviewResourceBase: 'ggx://localhost/x-1.0.0/', state: { global: {}, workspace: {} } },
			{ request: async () => undefined, registerCommandHandler: () => undefined }
		);
		expect(() => api.window.createTreeView('files', { treeDataProvider: {} as never })).toThrow('not supported');
		expect(() => api.window.registerWebviewViewProvider('view', {} as never)).toThrow('not supported');
		// Webview panels ARE supported now (the round-one VS Code API surface).
		expect(typeof api.window.createWebviewPanel).toBe('function');
	});
});

describe('the VS Code API surface, round one (messages, picks, progress, status bar, webviews)', () => {
	/** The shim under test plus every bridge request it made. */
	function shim() {
		const requests: { method: string; args: unknown[] }[] = [];
		const answers = new Map<string, unknown>([['notify', 'Retry'], ['showQuickPick', 'second']]);
		let nextId = 0;
		const api = createVscodeApi(
			{ extensionId: 'acme.demo', extensionPath: '/ext/acme.demo-2.0.0', workspaceFolders: [], settings: {}, language: 'en', webviewResourceBase: 'ggx://localhost/acme.demo-2.0.0/', state: { global: {}, workspace: {} } },
			{ request: async (method, args) => { requests.push({ method, args }); if (method === 'progress.begin') return ++nextId; return answers.get(method); }, registerCommandHandler: () => undefined }
		);
		return { api, requests };
	}

	it('showInformationMessage returns the MessageItem object the user picked', async () => {
		const { api, requests } = shim();
		const retry = { title: 'Retry', isCloseAffordance: false };
		const picked = await api.window.showInformationMessage('It broke', retry, 'Ignore');
		// The wire carries titles; the original object comes back.
		expect(picked).toBe(retry);
		expect(requests[0]).toMatchObject({ method: 'notify', args: ['info', 'It broke', ['Retry', 'Ignore']] });
	});

	it('showQuickPick accepts object items and returns the picked item', async () => {
		const { api, requests } = shim();
		const first = { label: 'first', description: 'the one' };
		const second = { label: 'second', detail: 'the other' };
		const picked = await api.window.showQuickPick([first, second], { placeHolder: 'pick' });
		expect(picked).toBe(second);
		// The wire carries {label, description, detail} entries (the host renders those), and
		// answers with the label.
		expect(requests[0]).toMatchObject({ method: 'showQuickPick', args: [[{ label: 'first', description: 'the one', detail: undefined }, { label: 'second', description: undefined, detail: 'the other' }], 'pick'] });
	});

	it('withProgress drives the progress bridge begin -> report -> end', async () => {
		const { api, requests } = shim();
		const result = await api.window.withProgress({ title: 'Working' }, async (progress) => {
			progress.report({ increment: 25, message: 'quarter' });
			progress.report({ increment: 75 });
			return 'done';
		});
		expect(result).toBe('done');
		const methods = requests.map((r) => r.method);
		expect(methods.slice(0, 4)).toEqual(['progress.begin', 'progress.report', 'progress.report', 'progress.end']);
		// Increments accumulate into a percentage: 25, then 100.
		expect(requests[1]!.args).toEqual([1, 25, 'quarter']);
		expect(requests[2]!.args).toEqual([1, 100, '']);
	});

	it('a status bar item posts create, every field write, and dispose', async () => {
		const { api, requests } = shim();
		const item = api.window.createStatusBarItem(2 /* Right */);
		item.text = '$(sync) syncing';
		item.tooltip = 'Syncing changes';
		item.command = 'acme.demo.sync';
		item.show();
		item.dispose();
		await flush();
		expect(requests[0]).toMatchObject({ method: 'statusbar.create', args: ['acme.demo:1', 2] });
		// Every field write posts the full current state; show() is the last of them, so the
		// final set carries everything, visible.
		const sets = requests.filter((r) => r.method === 'statusbar.set');
		expect(sets).toHaveLength(4);
		expect(sets.at(-1)).toMatchObject({ args: ['acme.demo:1', { alignment: 2, text: '$(sync) syncing', tooltip: 'Syncing changes', command: 'acme.demo.sync', visible: true }] });
		expect(requests.at(-1)).toMatchObject({ method: 'statusbar.dispose', args: ['acme.demo:1'] });
	});

	it('a webview panel proxies html, messages and disposal; events route back in', async () => {
		const { api, requests } = shim();
		const panel = api.window.createWebviewPanel('demo.view', 'Demo', undefined, { enableScripts: true });
		panel.webview.html = '<html><body>hi</body></html>';
		await expect(panel.webview.postMessage({ hello: 1 })).resolves.toBe(true);
		// asWebviewUri composes the preloaded base with the extension-relative path, both for
		// an absolute path inside the install and a ./-relative one.
		expect(panel.webview.asWebviewUri('/ext/acme.demo-2.0.0/media/logo.png').toString()).toBe('ggx://localhost/acme.demo-2.0.0/media/logo.png');
		expect(panel.webview.asWebviewUri('./media/logo.png').toString()).toBe('ggx://localhost/acme.demo-2.0.0/media/logo.png');
		expect(panel.visible).toBe(true);

		// The panel's messages arrive as host events and reach onDidReceiveMessage.
		const received: unknown[] = [];
		panel.webview.onDidReceiveMessage((message) => received.push(message));
		api.handleHostEvent({ event: 'webviewMessage', panelId: 1, message: { from: 'webview' } });
		expect(received).toEqual([{ from: 'webview' }]);

		// Disposal fires onDidDispose exactly once, whichever side went first.
		let disposals = 0;
		panel.onDidDispose(() => disposals++);
		panel.dispose();
		expect(disposals).toBe(1);
		api.handleHostEvent({ event: 'webviewDisposed', panelId: 1 }); // the tab's disposer, late
		expect(disposals).toBe(1);
		expect(requests.map((r) => r.method)).toEqual(['webview.create', 'webview.setHtml', 'webview.postMessage', 'webview.dispose']);
		expect(panel.visible).toBe(false);
	});

	it('a configChanged host event refreshes the settings and fires onDidChangeConfiguration', async () => {
		const { api } = shim();
		const fired: unknown[] = [];
		api.workspace.onDidChangeConfiguration(() => fired.push('changed'));
		api.handleHostEvent({ event: 'configChanged', settings: { 'demo.level': 3 } });
		expect(fired).toEqual(['changed']);
		expect(api.workspace.getConfiguration('demo').get('level')).toBe(3);
	});
});

describe('the extension host UI surfaces (status bar, output, webview tabs)', () => {
	/** A host with one live frame for acme.demo, recording everything pushed into it. */
	function hostWithFrame() {
		const host = new ExtensionHost();
		const sent: unknown[] = [];
		const handle = { frame: document.body.appendChild(document.createElement('iframe')), commandIds: new Set<string>(), pendingCalls: new Set<(error: Error) => void>(), send: (message: unknown) => sent.push(message) };
		host['frames'].set('acme.demo', handle);
		return { host, sent };
	}

	it('status bar items flow to the workbench callback and back on dispose', async () => {
		const { host } = hostWithFrame();
		const pushed: { id: string; alignment: number; text: string; tooltip: string; command?: string; visible: boolean }[][] = [];
		host.onStatusBarItems = (items) => pushed.push(items);
		await host['serve']('statusbar.create', ['acme.demo:1', 1], 'acme.demo', {} as never);
		await host['serve']('statusbar.set', ['acme.demo:1', { alignment: 1, text: 'OK', tooltip: '', command: undefined, visible: true }], 'acme.demo', {} as never);
		expect(pushed.at(-1)).toEqual([{ id: 'acme.demo:1', alignment: 1, text: 'OK', tooltip: '', command: undefined, visible: true }]);
		await host['serve']('statusbar.dispose', ['acme.demo:1'], 'acme.demo', {} as never);
		expect(pushed.at(-1)).toEqual([]);
	});

	it('output channels register on first line and forward every append', async () => {
		const { host } = hostWithFrame();
		const channels: { extId: string; name: string }[][] = [];
		const lines: [string, string][] = [];
		host.onOutputChannels = (list) => channels.push(list);
		host.onOutputAppend = (_extId, name, line) => lines.push([name, line]);
		await host['serve']('output.append', ['Build', 'compiling...'], 'acme.demo', {} as never);
		await host['serve']('output.append', ['Build', 'done'], 'acme.demo', {} as never);
		await host['serve']('output.append', ['Tests', 'ran'], 'acme.demo', {} as never);
		expect(channels.at(-1)).toEqual([{ extId: 'acme.demo', name: 'Build' }, { extId: 'acme.demo', name: 'Tests' }]);
		expect(lines).toEqual([['Build', 'compiling...'], ['Build', 'done'], ['Tests', 'ran']]);
		await host['serve']('output.dispose', ['Build'], 'acme.demo', {} as never);
		expect(channels.at(-1)).toEqual([{ extId: 'acme.demo', name: 'Tests' }]);
	});

	it('webview panels open a tab, mount a sandboxed srcdoc frame, and notify the extension on close', async () => {
		const { host, sent } = hostWithFrame();
		const opened: [number, string, string][] = [];
		let closedTab = '';
		host.onOpenWebview = (panelId, title, extId) => opened.push([panelId, title, extId]);
		host.onCloseWebviewTab = (tabId) => { closedTab = tabId; host['webviewClosed'](1); };

		await host['serve']('webview.create', [1, 'demo.view', 'Demo Panel'], 'acme.demo', {} as never);
		expect(opened).toEqual([[1, 'Demo Panel', 'acme.demo']]);
		await host['serve']('webview.setHtml', [1, '<html><body>hi</body></html>'], 'acme.demo', {} as never);

		// The workbench's mount: the tab pane gets a sandboxed iframe whose srcdoc carries the
		// composed acquireVsCodeApi bootstrap and the extension's document.
		const pane = document.body.appendChild(document.createElement('div'));
		const dispose = host.mountWebview(1, pane);
		const frame = pane.querySelector('iframe')!;
		expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
		expect(frame.getAttribute('srcdoc')).toContain('acquireVsCodeApi');
		expect(frame.getAttribute('srcdoc')).toContain('<body>hi</body>');
		// A later setHtml reloads the document, as VS Code's webviews do.
		await host['serve']('webview.setHtml', [1, '<html><body>again</body></html>'], 'acme.demo', {} as never);
		expect(frame.getAttribute('srcdoc')).toContain('<body>again</body>');

		// The extension's dispose closes the tab; the frame is told the panel is gone.
		await host['serve']('webview.dispose', [1], 'acme.demo', {} as never);
		expect(closedTab).toBe('webview:1');
		expect(sent.filter((m) => (m as { type?: string }).type === '__studioExtEvent' && (m as { event?: string }).event === 'webviewDisposed')).toHaveLength(1);

		// The tab closing on its own (user close) runs the disposer: same notification, once.
		dispose();
		expect(sent.filter((m) => (m as { type?: string }).type === '__studioExtEvent' && (m as { event?: string }).event === 'webviewDisposed')).toHaveLength(1);
	});

	it('a settings change reaches the frame as a configChanged event', async () => {
		const { host, sent } = hostWithFrame();
		document.dispatchEvent(new CustomEvent('ggs-ext-settings', { detail: 'acme.demo' }));
		const events = sent.filter((m) => (m as { type?: string }).type === '__studioExtEvent') as { event: string; settings: unknown }[];
		expect(events).toHaveLength(1);
		expect(events[0]!.event).toBe('configChanged');
		expect(events[0]!.settings).toEqual({});
	});

	it('state.update persists the memento under the extension id', async () => {
		const { host } = hostWithFrame();
		await host['serve']('state.update', ['global', 'lastOpen', 'file-a'], 'acme.demo', {} as never);
		expect(JSON.parse(localStorage.getItem('ggstudio.extMemento.global.acme.demo')!)).toEqual({ lastOpen: 'file-a' });
	});
});

describe('the extension host command wiring', () => {
	it('registers the baked-in contributions synchronously, and the activation pass skips them', async () => {
		// The build-time virtual module carries the shipped manifest: its menus must join the
		// registry without a single backend round-trip, before any view has rendered.
		backend.on('ext_read_file', () => { throw new Error('no such file'); });
		const host = new ExtensionHost();
		host.applyBuiltinContributions();
		expect(resolvedMenuEntries('scm/title').some((entry) => entry.command === 'git-graph-rs.view')).toBe(true);
		// The settings schemas ride the async builtin-settings chunk - build-time data too, so
		// still no backend round-trip, one microtask behind the menus.
		await ensureBuiltinSettings();
		expect(extensionSettingDefs().some((def) => def.extId === 'neophack.git-graph-rs')).toBe(true);
		// The activation pass lists the built-in but must not re-read its manifest: the baked
		// data already registered it, and the on-disk copy could even lag mid-upgrade.
		const applied: string[] = [];
		host.onContributionsApplied = () => applied.push('applied');
		withExtensions(BUILTIN);
		await host.activateInstalled();
		expect(backend.callsTo('ext_read_file').some((call) => call.extId === 'neophack.git-graph-rs')).toBe(false);
		expect(applied).toEqual(['applied']);
	});

	it('serves commands.register by adding to the workbench registry', async () => {
		withExtensions();
		const host = new ExtensionHost();
		const handle = { frame: document.createElement('iframe'), commandIds: new Set<string>(), pendingCalls: new Set<(error: Error) => void>() };
		document.body.appendChild(handle.frame);
		host['frames'].set('acme.demo', handle);
		await host['serve']('commands.register', ['acme.demo.sayHi'], 'acme.demo', handle);
		expect(commands.get('acme.demo.sayHi')).toBeDefined();
		// Unregistering removes it from the palette.
		await host['serve']('commands.unregister', ['acme.demo.sayHi'], 'acme.demo', handle);
		expect(commands.paletteItems().some((item) => item.value === 'acme.demo.sayHi')).toBe(false);
	});

	it('uninstalling disables the extension commands and releases their keybindings', async () => {
		backend.on('ext_uninstall', () => null);
		backend.on('ext_read_file', ({ relPath }) => {
			if (relPath === 'package.json') return JSON.stringify({
				main: './extension.js',
				contributes: {
					commands: [{ command: 'acme.demo.declared', title: 'Declared Command' }],
					keybindings: [{ command: 'acme.demo.declared', key: 'ctrl+alt+d' }]
				}
			});
			throw new Error('no such file');
		});
		const host = new ExtensionHost();
		const handle = { frame: document.createElement('iframe'), commandIds: new Set<string>(), pendingCalls: new Set<(error: Error) => void>() };
		document.body.appendChild(handle.frame);
		host['frames'].set('acme.demo', handle);
		await host['applyContributions'](USER);
		// The manifest-declared command answers its keybinding even before the frame is up.
		expect(commandForBinding('Ctrl+Alt+D')?.id).toBe('acme.demo.declared');
		await host['serve']('commands.register', ['acme.demo.live'], 'acme.demo', handle);
		expect(commands.paletteItems().some((item) => item.value === 'acme.demo.live')).toBe(true);

		await host.uninstall('acme.demo');

		// The frame-registered command leaves the palette (it was registered with enabled: true).
		expect(commands.paletteItems().some((item) => item.value === 'acme.demo.live')).toBe(false);
		// The declared command's keybinding no longer swallows the keystroke.
		expect(commandForBinding('Ctrl+Alt+D')).toBeUndefined();
	});

	it('showInputBox and showQuickPick resolve undefined (not null) when cancelled', async () => {
		// VS Code's contract for a dismissed quick input is undefined; extensions test for it
		// with `value === undefined`, so a null must never cross the bridge.
		const host = new ExtensionHost();
		const handle = { frame: document.createElement('iframe'), commandIds: new Set<string>(), pendingCalls: new Set<(error: Error) => void>() };
		const inputBox = host['serve']('showInputBox', ['Name?', ''], 'acme.demo', handle);
		key(document.querySelector<HTMLInputElement>('.quick-input .input')!, 'Escape');
		expect(await inputBox).toBeUndefined();

		const pick = host['serve']('showQuickPick', [['One', 'Two'], 'pick one'], 'acme.demo', handle);
		key(document.querySelector<HTMLInputElement>('.quick-input .input')!, 'Escape');
		expect(await pick).toBeUndefined();

		// An accepted input still resolves with its value.
		const accepted = host['serve']('showInputBox', ['Name?', ''], 'acme.demo', handle);
		const input = document.querySelector<HTMLInputElement>('.quick-input .input')!;
		type(input, 'demo');
		key(input, 'Enter');
		expect(await accepted).toBe('demo');
	});
});

describe('the extension host frame (src/extHostBoot.ts)', () => {
	// The frame's replies to host calls, collected off the message loop (the frame posts them
	// to its parent, which under jsdom is this same window).
	const callResults = new Map<number, { ok: boolean; result: unknown }>();
	window.addEventListener('message', (event) => {
		const data = event.data as { type?: string; id?: number; ok?: boolean; result?: unknown };
		if (data?.type === '__studioExtCallResult') callResults.set(data.id!, { ok: data.ok!, result: data.result });
	});

	/** Hand the frame an extension bundle, as the host's __studioExtInit would. */
	const bootExtension = (code: string): void => {
		window.dispatchEvent(new MessageEvent('message', {
			data: {
				type: '__studioExtInit',
				context: { extensionId: 'acme.demo', extensionPath: '/ext/acme.demo-2.0.0', workspaceFolders: [], settings: {}, language: 'en', webviewResourceBase: 'ggx://localhost/acme.demo-2.0.0/', state: { global: {}, workspace: {} } },
				code
			}
		}));
	};

	it('runs a command handler invoked with no arguments (the palette invocation shape)', async () => {
		bootExtension("const vscode = require('vscode'); exports.activate = () => { vscode.commands.registerCommand('demo.echo', (...args) => args.length); };");
		await flush();
		// What the host's runRegistered sends for a palette click: the id, and nothing else.
		window.dispatchEvent(new MessageEvent('message', { data: { type: '__studioExtCall', id: 41, method: 'runCommand', args: ['demo.echo'] } }));
		await flush();
		const call = callResults.get(41);
		expect(call).toBeDefined();
		expect(call!.ok).toBe(true);
		expect(call!.result).toBe(0); // the handler ran, with zero arguments
	});

	it('executeCommand forwards its arguments to the handler living in the frame', async () => {
		bootExtension("const vscode = require('vscode'); exports.activate = () => { vscode.commands.registerCommand('demo.inc', (x) => (x ?? 0) + 1); };");
		await flush();
		const host = new ExtensionHost();
		const sent: { method: string; args: unknown[] }[] = [];
		// The host's handle for the frame: its calls are delivered to the real frame code above
		// over the message loop. contentWindow matches nothing on purpose - the frame's own RPCs
		// (e.g. its commands.register) need no host answer here.
		const handle = {
			frame: { contentWindow: {} } as unknown as HTMLIFrameElement,
			commandIds: new Set<string>(),
			pendingCalls: new Set<(error: Error) => void>(),
			send: (message: unknown) => {
				const data = message as { type?: string; method?: string; args?: unknown[] };
				if (data.type === '__studioExtCall') sent.push({ method: data.method!, args: data.args! });
				window.dispatchEvent(new MessageEvent('message', { data: message }));
			}
		};
		host['frames'].set('acme.demo', handle);
		await host['serve']('commands.register', ['demo.inc'], 'acme.demo', handle);
		const result = await host['serve']('commands.execute', ['demo.inc', [41]], 'acme.demo', handle);
		expect(sent).toEqual([{ method: 'runCommand', args: ['demo.inc', [41]] }]);
		expect(result).toBe(42);
	});
});

describe('calls into an extension frame that goes away', () => {
	it('settle when the extension is deactivated instead of waiting forever', async () => {
		backend.on('ext_uninstall', () => null);
		backend.on('ext_read_file', () => { throw new Error('no such file'); });
		const host = new ExtensionHost();
		const handle = { frame: document.createElement('iframe'), commandIds: new Set<string>(), pendingCalls: new Set<(error: Error) => void>(), send: () => undefined };
		document.body.appendChild(handle.frame);
		host['frames'].set('acme.demo', handle);
		await host['serve']('commands.register', ['acme.demo.slow'], 'acme.demo', handle);
		const listenersBefore = host['frames'].size;

		// The command runs in the frame and never answers (the frame is stuck, or dies).
		const running = commands.execute('acme.demo.slow');
		let settled: string | null = null;
		running.then(() => { settled = 'resolved'; }, (error: Error) => { settled = error.message; });
		await flush();
		expect(settled).toBeNull();
		expect(handle.pendingCalls.size).toBe(1);

		// Uninstalling the extension rejects what was still running in its frame.
		await host.uninstall('acme.demo');
		await flush();
		expect(settled).toContain('acme.demo was deactivated');
		expect(handle.pendingCalls.size).toBe(0);
		expect(host['frames'].size).toBe(listenersBefore - 1);
	});
});

describe('ggx/2 packages: the page registry and the process backend', () => {
	const GGX2: ExtInfo = {
		id: 'acme.proc', name: 'proc', displayName: 'Proc Demo', publisher: 'acme', version: '1.0.0', description: 'A ggx/2 package',
		builtin: false, icon: null, path: '/ext/acme.proc-1.0.0', categories: [], keywords: [], repository: null, license: null,
		enginesVscode: null, extensionDependencies: [], extensionPack: [], readme: null, changelog: null, format: 'ggx',
		ggx: {
			format: 'ggx/2', id: 'acme.proc', version: '1.0.0',
			pages: { main: { page: 'web/view.html', title: 'Demo Page' } },
			backend: { kind: 'process', command: 'bin/main' },
			permissions: []
		}
	};

	it('dispatches a process-backed declared command to its backend and opens the page its result names', async () => {
		withExtensions(GGX2);
		backend.on('ext_read_file', ({ relPath }) => {
			if (relPath === 'package.json') return JSON.stringify({
				main: './main.js',
				contributes: { commands: [
					{ command: 'acme.proc.hello', title: 'Hello' },
					{ command: 'acme.proc.open', title: 'Open' }
				] }
			});
			if (relPath === 'main.js') return 'exports.activate = function () {};';
			throw new Error('no such file');
		});
		backend.on('ext_process_run', ({ command }) => (command === 'acme.proc.open' ? { openPage: 'main', params: { by: 'command' } } : { greeting: 'hi' }));
		const host = new ExtensionHost();
		const opened: Array<[string, string, unknown]> = [];
		host.onOpenPage = (extId, pageId, params) => opened.push([extId, pageId, params]);
		await host.activateInstalled();

		// The declared command is runnable from the manifest alone — no frame, no spawn yet.
		expect(commands.get('acme.proc.hello')).toBeDefined();
		expect(commands.paletteItems().some((item) => item.value === 'acme.proc.hello')).toBe(true);
		await commands.execute('acme.proc.open');
		await flush();
		// The palette invocation reached the backend process command, and its page-open
		// convention surfaced the package's page.
		expect(backend.callsTo('ext_process_run')).toEqual([{ extId: 'acme.proc', command: 'acme.proc.open', args: [] }]);
		expect(opened).toEqual([['acme.proc', 'main', { by: 'command' }]]);

		// A failing backend command surfaces as an error notification, not a throw.
		backend.on('ext_process_run', () => { throw 'spawn failed'; });
		await commands.execute('acme.proc.hello');
		await flush();
		expect(notifications().join()).toContain('Extension backend command failed');
	});

	it('resolves pages through the registry (ggx/1 frontend pages included) and mounts them sandboxed', async () => {
		const FRONTEND_ONLY: ExtInfo = { ...GGX2, id: 'acme.front', ggx: { format: 'ggx/1', id: 'acme.front', version: '1.0.0', frontend: { page: 'web/view.html' } } };
		withExtensions(GGX2, FRONTEND_ONLY);
		const host = new ExtensionHost();
		await host.list();
		// The ggx/2 registry names its page; a ggx/1 package's single frontend page is the
		// page named "view".
		expect(host.pageEntry('acme.proc', 'main')!.page).toBe('web/view.html');
		expect(host.pageEntry('acme.front', 'view')!.page).toBe('web/view.html');
		expect(host.pageEntry('acme.proc', 'missing')).toBeNull();

		const opened: Array<[string, string, unknown]> = [];
		host.onOpenPage = (extId, pageId, params) => opened.push([extId, pageId, params]);
		host.openPage('acme.proc', 'main', { x: 1 });
		host.openPage('acme.proc', 'missing');
		expect(opened).toEqual([['acme.proc', 'main', { x: 1 }]]);
		expect(notifications().join()).toContain('Extension page not found');

		const container = document.body.appendChild(document.createElement('div'));
		const dispose = host.mountPage('acme.proc', 'main', { x: 1 }, container);
		const frame = container.querySelector<HTMLIFrameElement>('iframe.ext-page-frame')!;
		expect(frame).not.toBeNull();
		expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
		expect(frame.src).toContain('acme.proc-1.0.0/web/view.html');
		expect(frame.src.startsWith('ggx://localhost/') || frame.src.startsWith('http://ggx.localhost/')).toBe(true);

		// A page's backend.run routes to the process command with the page's extension.
		backend.on('ext_process_run', () => ({ greeting: 'from the page' }));
		const replies: unknown[] = [];
		frame.contentWindow!.addEventListener('message', (event: MessageEvent) => {
			const data = event.data as { __ggxHost?: boolean; type?: string; result?: unknown };
			if (data?.__ggxHost && data.type === 'rpcResult') replies.push(data.result);
		});
		window.dispatchEvent(new MessageEvent('message', {
			source: frame.contentWindow,
			data: { __ggxPage: true, kind: 'rpc', id: 9, method: 'backend.run', args: ['acme.proc.hello', ['page']] }
		}));
		await flush();
		expect(backend.callsTo('ext_process_run')).toContainEqual({ extId: 'acme.proc', command: 'acme.proc.hello', args: ['page'] });
		expect(replies).toEqual([{ greeting: 'from the page' }]);

		// Pages may not register commands — that is a package.json (or backend) concern.
		const errors: unknown[] = [];
		frame.contentWindow!.addEventListener('message', (event: MessageEvent) => {
			const data = event.data as { __ggxHost?: boolean; type?: string; ok?: boolean; result?: unknown };
			if (data?.__ggxHost && data.type === 'rpcResult' && data.ok === false) errors.push(data.result);
		});
		window.dispatchEvent(new MessageEvent('message', {
			source: frame.contentWindow,
			data: { __ggxPage: true, kind: 'rpc', id: 10, method: 'commands.register', args: ['nope'] }
		}));
		await flush();
		expect(errors.join()).toContain('cannot register commands');

		dispose();
		expect(container.querySelector('iframe')).toBeNull();
	});

	it('uninstalling a process package stops its backend', async () => {
		withExtensions(GGX2);
		backend.on('ext_uninstall', () => null);
		backend.on('ext_process_stop', () => null);
		const host = new ExtensionHost();
		await host.list();
		await host.uninstall('acme.proc');
		expect(backend.callsTo('ext_process_stop')).toEqual([{ extId: 'acme.proc' }]);
	});

	it('starts a process package\'s backend as soon as it is installed', async () => {
		// Install means run: the reload that follows an install brings the declared backend up,
		// without waiting for a first command — the same detect-and-run the boot pass does.
		backend.on('ext_install_from_ggx', () => GGX2);
		backend.on('ext_list', () => [GGX2]);
		backend.on('ext_read_file', ({ relPath }) => {
			if (relPath === 'package.json') return JSON.stringify({
				main: './main.js',
				contributes: { commands: [{ command: 'acme.proc.hello', title: 'Hello' }] }
			});
			if (relPath === 'main.js') return 'exports.activate = function () {};';
			throw new Error('no such file');
		});
		backend.on('ext_process_stop', () => null);
		backend.on('ext_process_start', () => null);
		const host = new ExtensionHost();
		await host.installFromGgx('C:\\pkgs\\acme.proc-1.0.0.ggx');
		expect(backend.callsTo('ext_process_start')).toEqual([{ extId: 'acme.proc' }]);
	});

	it('never frame-activates embedded offers or process packages — no entry needs a frame it has', async () => {
		// The builtin-format entries (git-graph-rs without its package, the bundled sample)
		// have no files on disk, and a ggx/2 process package's manifest is its whole program:
		// a frame boot for either would only read a missing extension.js and warn.
		const SAMPLE: ExtInfo = { id: 'ggs.ext-demo', name: 'ext-demo', displayName: 'GGX Demo', publisher: 'ggs', version: '0.2.0', description: 'sample', builtin: false, icon: null, path: '', categories: [], keywords: [], repository: null, license: null, enginesVscode: null, extensionDependencies: [], extensionPack: [], readme: null, changelog: null, format: 'builtin', ggx: null };
		const PROC: ExtInfo = { ...GGX2, path: '/ext/acme.proc-1.0.0' };
		withExtensions(SAMPLE, PROC);
		backend.on('ext_read_file', ({ relPath }) => {
			if (relPath === 'package.json') return JSON.stringify({
				contributes: { commands: [{ command: 'acme.proc.hello', title: 'Hello' }] }
			});
			throw new Error('no such file'); // extension.js: must never be asked for
		});
		const host = new ExtensionHost();
		await host.activateInstalled();
		expect(notifications().join()).not.toContain('Could not load');
		// No frame entry point was ever asked for (the nls probes are allowed and miss).
		expect(backend.callsTo('ext_read_file').some((call) => call.relPath === 'extension.js')).toBe(false);
		expect(host['frames'].size).toBe(0);
		// The process package's declared command is still runnable, straight from the manifest.
		expect(commands.get('acme.proc.hello')).toBeDefined();
	});
});

describe('an installed ggx/2 package in the workbench surfaces (the full feature matrix)', () => {
	/** The package.json the acme.proc fixture reads back: two commands, a keybinding and an
	 *  explorer/context menu entry — everything a plugin can contribute to the workbench. */
	const PROC_MANIFEST = {
		main: './main.js',
		contributes: {
			commands: [
				{ command: 'acme.proc.hello', title: 'Hello' },
				{ command: 'acme.proc.open', title: 'Open' }
			],
			keybindings: [{ command: 'acme.proc.hello', key: 'ctrl+alt+g' }],
			menus: { 'explorer/context': [{ command: 'acme.proc.hello' }] }
		}
	};
	const PROC: ExtInfo = {
		id: 'acme.proc', name: 'proc', displayName: 'Proc Demo', publisher: 'acme', version: '1.0.0', description: 'A ggx/2 package',
		builtin: false, icon: null, path: '/ext/acme.proc-1.0.0', categories: [], keywords: [], repository: null, license: null,
		enginesVscode: null, extensionDependencies: [], extensionPack: [], readme: null, changelog: null, format: 'ggx',
		ggx: {
			format: 'ggx/2', id: 'acme.proc', version: '1.0.0',
			pages: { main: { page: 'web/view.html', title: 'Demo Page' } },
			backend: { kind: 'process', command: 'bin/main' },
			permissions: []
		}
	};

	function scriptProc(listed: ExtInfo[] = [PROC]): void {
		withExtensions(...listed);
		backend.on('ext_read_file', ({ relPath }) => {
			if (relPath === 'package.json') return JSON.stringify(PROC_MANIFEST);
			if (relPath === 'main.js') return 'exports.activate = function () {};';
			throw new Error('no such file');
		});
		backend.on('ext_process_run', () => ({ openPage: 'main', params: { by: 'menu' } }));
	}

	/** A one-file workspace the Explorer renders, like explorer.test.ts's fileSystem. */
	function fileSystem(tree: Record<string, string[]>): void {
		backend.on('list_dir', ({ path }) => {
			const entries = tree[String(path)];
			if (!entries) throw new Error(`${path}: no such directory`);
			return entries.map((name) => {
				const isDir = name.endsWith('/');
				const clean = isDir ? name.slice(0, -1) : name;
				return { name: clean, path: `${path}\${clean}`, isDir, size: 0 };
			});
		});
	}

	it('merges the plugin\'s and the built-in\'s entries into the file context menu, and each dispatches its own way', async () => {
		scriptProc();
		fileSystem({ 'C:\repo': ['README.md'] });
		const host = new ExtensionHost();
		// The built-in git-graph-rs contributes explorer/context (filterByFile, the file
		// history entry); its baked contributions join first, as at boot.
		host.applyBuiltinContributions();
		const native: string[] = [];
		// The workbench declares the built-in's commands native (workbench.ts wires the same
		// set); without it the entry renders disabled, as a real host would show.
		host.nativeCommands = new Set(['git-graph-rs.filterByFile']);
		host.onNativeCommand = (command) => {
			if (command === 'git-graph-rs.filterByFile') {
				native.push(command);
				return true;
			}
			return false;
		};
		const opened: Array<[string, string, unknown]> = [];
		host.onOpenPage = (extId, pageId, params) => opened.push([extId, pageId, params]);
		await host.activateInstalled();

		const explorer = new Explorer(document.getElementById('sidebar')!);
		explorer.setRoot('C:\repo');
		await flush();
		rightClick(document.querySelector('.tree .row'));
		const labels = menuLabels();
		// The built-in's file-history entry and the plugin's entry sit in the same menu.
		expect(labels).toContain('Show File History in Git Graph RS');
		expect(labels).toContain('Hello');

		// Clicking the plugin entry runs its backend command and opens the page it names.
		click(menuItem('Hello'));
		await flush();
		expect(backend.callsTo('ext_process_run')).toEqual([{ extId: 'acme.proc', command: 'acme.proc.hello', args: [] }]);
		expect(opened).toEqual([['acme.proc', 'main', { by: 'menu' }]]);

		// Clicking the built-in's entry reaches the native command hook (GraphHost's path).
		rightClick(document.querySelector('.tree .row'));
		click(menuItem('Show File History in Git Graph RS'));
		await flush();
		expect(native).toEqual(['git-graph-rs.filterByFile']);
	});

	it('binds the plugin\'s keybinding, and uninstalling releases it, drops the menu entry and stops the backend', async () => {
		scriptProc();
		fileSystem({ 'C:\repo': ['README.md'] });
		backend.on('ext_uninstall', () => null);
		backend.on('ext_process_stop', () => null);
		const host = new ExtensionHost();
		host.applyBuiltinContributions(); // the built-in's entries stay after the plugin goes
		await host.activateInstalled();
		expect(commandForBinding('Ctrl+Alt+G')?.id).toBe('acme.proc.hello');

		const explorer = new Explorer(document.getElementById('sidebar')!);
		explorer.setRoot('C:\repo');
		await flush();

		await host.uninstall('acme.proc');
		// The keybinding no longer swallows the keystroke.
		expect(commandForBinding('Ctrl+Alt+G')).toBeUndefined();
		// The context menu entry is gone with the extension; the built-in's survives.
		rightClick(document.querySelector('.tree .row'));
		expect(menuLabels()).not.toContain('Hello');
		expect(menuLabels()).toContain('Show File History in Git Graph RS');
		// The backend process died with its extension.
		expect(backend.callsTo('ext_process_stop')).toEqual([{ extId: 'acme.proc' }]);
	});
});
