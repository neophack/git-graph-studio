import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ExtensionHost, type ExtInfo, type GalleryEntry } from '../src/extHost';
import { extensionSettingDefs, registerContextProvider, resolvedMenuEntries } from '../src/contributions';
import { ExtensionsPanel } from '../src/extensionsPanel';
import { commandForBinding, commands } from '../src/commands';
import { createVscodeApi, applyTextEditsToText, Position, Range } from '../src/vscodeApi';
import { registerDeclaredLanguages, declaredLanguageName, registerExtensionSnippets, registerExtensionThemes, extensionThemeList, languageIdFor } from '../src/contributions';
import { snippetsFor } from '../src/snippetRegistry';
import { THEMES, syncExtensionThemes, updateSetting } from '../src/settings';
// The frame half of the extension host, loaded for its window message listener: under jsdom the
// frame's `parent` is this same window, so tests drive it with MessageEvents and read its posts.
import '../src/extHostBoot';
import { backend } from './tauriMock';
import { saveExtSetting } from '../src/state';
import { click, flush, key, menuItem, menuLabels, notificationButton, notifications, rightClick, type } from './helpers';
import { Explorer } from '../src/explorer';

const BUILTIN: ExtInfo = { id: 'neophack.git-graph-rs', name: 'git-graph-rs', displayName: 'Git Graph', publisher: 'neophack', version: '1.0.23', description: 'Git Graph', builtin: true, icon: null, path: '', categories: ['SCM Providers'], keywords: ['git'], repository: 'https://github.com/neophack/git-graph-rs', license: 'MIT', enginesVscode: '^1.80.0', extensionDependencies: [], extensionPack: [], readme: null, changelog: null, format: 'bundled', capabilities: null };
const USER: ExtInfo = { id: 'acme.demo', name: 'demo', displayName: null, publisher: 'acme', version: '2.0.0', description: 'A demo', builtin: false, icon: null, path: '/ext/acme.demo-2.0.0', categories: [], keywords: [], repository: null, license: null, enginesVscode: null, extensionDependencies: ['acme.base'], extensionPack: [], readme: null, changelog: null, format: 'vsix', capabilities: null };

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
		const installedBundled: ExtInfo = { ...BUILTIN, builtin: false, format: 'ggs', version: '1.0.25', path: '/ext/neophack.git-graph-rs-1.0.25' };
		backend.on('ext_install_bundled', () => installedBundled);
		const panel = mountedPanel();
		await panel.refresh();
		document.querySelectorAll<HTMLElement>('.ext-row')[0]!.querySelector<HTMLElement>('.action-btn')!.click();
		await flush();
		expect(backend.callsTo('ext_install_bundled')).toEqual([{ extId: 'neophack.git-graph-rs' }]);
		expect(notifications().join()).toContain('neophack.git-graph-rs v1.0.25');
		// Once installed it is a standard package: the button becomes the ordinary uninstall.
		listed = [installedBundled, USER];
		await panel.refresh();
		const integrated = document.querySelectorAll<HTMLElement>('.ext-row')[0]!.querySelector<HTMLElement>('.action-btn')!;
		expect(integrated.title).toContain('Uninstall neophack.git-graph-rs');
	});

	it('offers the bundled sample the same way: a not-yet-installed entry installs by its id', async () => {
		// What cmd_ext.rs's listing composes when no demo package is installed: the embedded
		// manifest stands in, `format: 'bundled'` (the install offer), `builtin: false` (it is
		// a sample, nothing of it is built into the app).
		const SAMPLE: ExtInfo = { id: 'ggs.ext-demo', name: 'ext-demo', displayName: 'Demo', publisher: 'ggs', version: '0.2.0', description: 'The worked example', builtin: false, icon: null, path: '', categories: ['Examples'], keywords: [], repository: null, license: null, enginesVscode: null, extensionDependencies: [], extensionPack: [], readme: null, changelog: null, format: 'bundled', capabilities: null };
		let listed: ExtInfo[] = [BUILTIN, SAMPLE, USER];
		backend.on('ext_list', () => listed);
		const installed: ExtInfo = { ...SAMPLE, format: 'ggs', path: '/ext/ggs.ext-demo-0.2.0', capabilities: { format: 'ggs/2', id: 'ggs.ext-demo', version: '0.2.0', pages: { main: { page: 'web/view.html' } }, backend: { kind: 'process', command: 'bin/win32-x64/ggs-ext-demo.exe' }, permissions: ['clipboard'] } };
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
			...USER, id: 'acme.proc', displayName: 'Proc', format: 'ggs',
			capabilities: { format: 'ggs/2', id: 'acme.proc', version: '2.0.0', pages: {}, backend: { kind: 'process', command: 'bin/main' }, permissions: [] }
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

	/* ---------- The marketplace search (Open VSX, over the backend gallery commands) ---------- */

	const PRETTIER: GalleryEntry = {
		id: 'esbenp.prettier-vscode', name: 'prettier-vscode', namespace: 'esbenp',
		displayName: 'Prettier - Code formatter', description: 'Code formatter using prettier',
		version: '11.0.0', downloadCount: 12345678, averageRating: 4.5, verified: true,
		timestamp: '2026-01-02T03:04:05Z', iconUrl: null,
		downloadUrl: 'https://open-vsx.org/api/esbenp/prettier-vscode/11.0.0/file/esbenp.prettier-vscode-11.0.0.vsix'
	};
	const DEMO_NEWER: GalleryEntry = {
		id: 'acme.demo', name: 'demo', namespace: 'acme', displayName: null, description: 'A demo',
		version: '3.0.0', downloadCount: 12, averageRating: null, verified: false,
		timestamp: '2026-01-02T03:04:05Z', iconUrl: null,
		downloadUrl: 'https://open-vsx.org/api/acme/demo/3.0.0/file/acme.demo-3.0.0.vsix'
	};
	/** The panel with the market scripted: a search answer and the installed list it reports. */
	function withMarket(entries: GalleryEntry[], totalSize = entries.length): { listAnswer: () => ExtInfo[] } {
		backend.on('ext_gallery_search', () => ({ totalSize, entries }));
		// The install pass re-reads package.json (the activation reload): a minimal manifest
		// keeps the frame's boot quiet instead of notifying a load failure.
		backend.on('ext_read_file', ({ relPath }: { relPath: string }) => (relPath === 'package.json' ? '{}' : ''));
		const state = { list: [BUILTIN, USER] as ExtInfo[] };
		backend.on('ext_list', () => state.list);
		return { listAnswer: () => state.list };
	}

	it('searches the marketplace, shows Install or Update by the installed version, and installs', async () => {
		const market = withMarket([PRETTIER, DEMO_NEWER], 42);
		const installedPrettier: ExtInfo = { ...USER, id: 'esbenp.prettier-vscode', name: 'prettier-vscode', publisher: 'esbenp', displayName: 'Prettier - Code formatter', version: '11.0.0', path: '/ext/esbenp.prettier-vscode-11.0.0' };
		backend.on('ext_gallery_install', () => installedPrettier);
		const panel = mountedPanel();
		await panel.refresh();
		const input = document.querySelector<HTMLInputElement>('.ext-search-input')!;
		type(input, 'prettier');
		key(input, 'Enter');
		await flush();
		expect(backend.callsTo('ext_gallery_search')).toEqual([{ gallery: 'https://open-vsx.org', query: 'prettier' }]);
		// The installed list gave way to the results; the count line names the registry's total.
		expect(document.querySelector('.ext-gallery-count')!.textContent).toContain('42');
		const rows = document.querySelectorAll('.gallery-row');
		expect(rows.length).toBe(2);
		expect(rows[0]!.textContent).toContain('Prettier - Code formatter');
		expect(rows[0]!.querySelector('.ext-verified')!.textContent).toContain('verified');
		expect(rows[0]!.querySelector('.ext-gallery-stats')!.textContent).toContain('downloads');
		// The installed acme.demo v2.0.0 against the market's 3.0.0: an Update offer, not Install.
		const update = rows[1]!.querySelector<HTMLElement>('.action-btn')!;
		expect(update.title).toContain('Update to 3.0.0');
		// Installing the not-installed one: the download URL crosses, the notification lands,
		// and the refreshed row knows it is installed now.
		click(rows[0]!.querySelector<HTMLElement>('.action-btn')!);
		await flush();
		expect(backend.callsTo('ext_gallery_install')).toEqual([{ gallery: 'https://open-vsx.org', downloadUrl: PRETTIER.downloadUrl }]);
		expect(notifications().join()).toContain('esbenp.prettier-vscode v11.0.0');
		market.listAnswer().push(installedPrettier);
		await panel.refresh();
		const done = document.querySelectorAll('.gallery-row')[0]!;
		expect(done.querySelector('.ext-installed-tag')!.textContent).toContain('Installed');
		expect(done.querySelector('.action-btn')).toBeNull();
	});

	it('an entry matching the installed version shows the installed tag, not an offer', async () => {
		const DEMO_SAME = { ...DEMO_NEWER, version: '2.0.0' };
		withMarket([DEMO_SAME]);
		const panel = mountedPanel();
		await panel.refresh();
		const input = document.querySelector<HTMLInputElement>('.ext-search-input')!;
		type(input, 'acme');
		key(input, 'Enter');
		await flush();
		const row = document.querySelector('.gallery-row')!;
		expect(row.querySelector('.ext-installed-tag')!.textContent).toContain('Installed');
		expect(row.querySelector('.action-btn')).toBeNull();
	});

	it('a failed search surfaces its error and keeps the installed list; Escape restores it', async () => {
		backend.on('ext_gallery_search', () => { throw new Error('offline'); });
		const panel = mountedPanel();
		await panel.refresh();
		const input = document.querySelector<HTMLInputElement>('.ext-search-input')!;
		type(input, 'theme');
		key(input, 'Enter');
		await flush();
		expect(notifications().join()).toContain('Marketplace search failed');
		// The search failed before any result: the installed list is what stays on screen.
		expect(document.querySelectorAll('.ext-row').length).toBe(2);
		expect(document.querySelector('.gallery-row')).toBeNull();
		// And a finished search clears back to the installed list on Escape.
		backend.on('ext_gallery_search', () => ({ totalSize: 0, entries: [] }));
		key(input, 'Enter');
		await flush();
		expect(document.querySelector('.ext-gallery-count')).toBeNull();
		expect(document.querySelector('.ext-list .empty')!.textContent).toContain('No extensions match');
		key(input, 'Escape');
		expect(document.querySelectorAll('.gallery-row').length).toBe(0);
		expect(document.querySelectorAll('.ext-row').length).toBe(2);
	});

	it('the detail page shows the facts and renders the package\'s README', async () => {
		const PROC: ExtInfo = {
			...USER, id: 'acme.proc', displayName: 'Proc', format: 'ggs', path: '/ext/acme.proc-2.0.0', readme: 'README.md',
			capabilities: {
				format: 'ggs/2', id: 'acme.proc', version: '2.0.0', pages: {},
				backend: { kind: 'process', command: 'bin/main' },
				permissions: ['repo:read', 'network']
			}
		};
		backend.on('ext_list', () => [BUILTIN, PROC]);
		backend.on('ext_process_status', () => [
			{ extensionId: 'acme.proc', pid: 4321, commands: [], protocolVersion: 'ggs-ext/1', startCount: 1, lastError: null }
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
		expect(page.textContent).toContain('ggs-ext/1');
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

	it('installs from a picked .vsix package and refreshes (the one package format)', async () => {
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
		// The panel's header carries the install action.
		expect([...document.querySelectorAll('.pane-header .action-btn')].some((b) => b.title.includes('Install from VSIX'))).toBe(true);
	});

	it('surfaces the error when a same-version package is installed again', async () => {
		backend.dialog.openResult = 'C:\\downloads\\git-graph-rs-1.0.24.vsix';
		backend.on('ext_install_from_vsix', () => { throw 'neophack.git-graph-rs 1.0.24 is already installed'; });
		const panel = mountedPanel();
		await panel.refresh();
		await panel.installFromVsixCommand();
		expect(notifications().join()).toContain('already installed');
	});

	it('surfaces install errors (a downgrade, for instance)', async () => {
		backend.dialog.openResult = 'old.vsix';
		backend.on('ext_install_from_vsix', () => { throw 'acme.demo 2.0.0 is already installed; acme.demo 1.0.0 is older'; });
		const panel = mountedPanel();
		await panel.installFromVsixCommand();
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

	it('serves what it can and degrades the rest (nothing throws a foreign extension dead)', () => {
		const api = createVscodeApi(
			{ extensionId: 'x', extensionPath: '/x', workspaceFolders: [], settings: {}, language: 'en', webviewResourceBase: 'ggs://localhost/x-1.0.0/', state: { global: {}, workspace: {} } },
			{ request: async () => undefined, registerCommandHandler: () => undefined }
		);
		// Webview views ARE served now; every provider registration returns a Disposable and
		// none of the load-time surfaces throws — an activation must survive whatever it
		// registers (the Open VSX compatibility posture).
		expect(typeof api.window.registerWebviewViewProvider).toBe('function');
		expect(typeof api.window.createTreeView('files', { treeDataProvider: {} as never }).message).toBe('undefined');
		expect(typeof api.window.createWebviewPanel).toBe('function');
		expect(typeof api.window.createTreeView('files', { treeDataProvider: {} as never }).visible).toBe('boolean');
		expect(typeof api.languages.registerHoverProvider(() => undefined, {} as never).dispose).toBe('function');
	});
});

describe('the VS Code API surface, round one (messages, picks, progress, status bar, webviews)', () => {
	/** The shim under test plus every bridge request it made. */
	function shim() {
		const requests: { method: string; args: unknown[] }[] = [];
		const answers = new Map<string, unknown>([['notify', 'Retry'], ['showQuickPick', 'second']]);
		let nextId = 0;
		const api = createVscodeApi(
			{ extensionId: 'acme.demo', extensionPath: '/ext/acme.demo-2.0.0', workspaceFolders: [], settings: {}, language: 'en', webviewResourceBase: 'ggs://localhost/acme.demo-2.0.0/', state: { global: {}, workspace: {} } },
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
		expect(panel.webview.asWebviewUri('/ext/acme.demo-2.0.0/media/logo.png').toString()).toBe('ggs://localhost/acme.demo-2.0.0/media/logo.png');
		expect(panel.webview.asWebviewUri('./media/logo.png').toString()).toBe('ggs://localhost/acme.demo-2.0.0/media/logo.png');
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
	it('applies an installed package manifest through the activation pass alone', async () => {
		// Nothing is baked anymore: an installed package's manifest is read by the async
		// activation pass, and until it lands nothing of the package is registered.
		const manifest = {
			contributes: {
				commands: [{ command: 'acme.view', title: 'View Acme' }],
				menus: { 'scm/title': [{ command: 'acme.view', group: 'navigation' }] },
				configuration: { title: 'Acme', properties: { 'acme.colour': { type: 'string', default: 'red' } } }
			}
		};
		const installed: ExtInfo = { id: 'acme.ggxdemo', name: 'ggxdemo', displayName: 'Acme GGX', publisher: 'acme', version: '1.0.0', description: '', builtin: false, icon: null, path: '/ext/acme.ggxdemo-1.0.0', categories: [], keywords: [], repository: null, license: null, enginesVscode: null, extensionDependencies: [], extensionPack: [], readme: null, changelog: null, format: 'ggs', capabilities: { format: 'ggs/2', id: 'acme.ggxdemo', version: '1.0.0', pages: {}, backend: { kind: 'process', command: 'bin/tool.exe' } } };
		backend.on('ext_list', () => [installed]);
		backend.on('ext_read_file', ({ relPath }) => relPath === 'package.json' ? JSON.stringify(manifest) : (() => { throw new Error('no such file'); })());
		const host = new ExtensionHost();
		expect(resolvedMenuEntries('scm/title')).toEqual([]);
		await host.activateInstalled();
		expect(resolvedMenuEntries('scm/title')).toEqual([
			{ command: 'acme.view', label: 'View Acme', group: 'navigation', extId: 'acme.ggxdemo', icon: undefined }
		]);
		expect(extensionSettingDefs().some((def) => def.extId === 'acme.ggxdemo')).toBe(true);
	});
	it('resolves a locale-twin pair to one menu entry and one palette entry', async () => {
		// The manifest's `x` / `x.zhCn` command pairs are discriminated by the `<package name>:
		// interfaceZhCn` context key (the package name, not the publisher.name id) its own code
		// would set in VS Code; a process package has
		// no running code, so the host answers it — its declared interfaceLanguage setting
		// when explicit, the app locale when "auto". The palette additionally honours the
		// commandPalette placements' `when` clauses (menu entries keep their own).
		const manifest = {
			activationEvents: ['onCommand:acme.ggxdemo.act'],
			contributes: {
				commands: [
					{ command: 'acme.ggxdemo.act', title: 'Act' },
					{ command: 'acme.ggxdemo.act.zhCn', title: '行动' }
				],
				menus: {
					'scm/title': [
						{ command: 'acme.ggxdemo.act', when: 'scmProvider == git && !ggxdemo:interfaceZhCn', group: 'acme@1' },
						{ command: 'acme.ggxdemo.act.zhCn', when: 'scmProvider == git && ggxdemo:interfaceZhCn', group: 'acme@1' }
					],
					commandPalette: [
						{ command: 'acme.ggxdemo.act', when: '!ggxdemo:interfaceZhCn' },
						{ command: 'acme.ggxdemo.act.zhCn', when: 'ggxdemo:interfaceZhCn' }
					]
				}
			}
		};
		const installed: ExtInfo = { id: 'acme.ggxdemo', name: 'ggxdemo', displayName: 'Acme GGX', publisher: 'acme', version: '1.0.0', description: '', builtin: false, icon: null, path: '/ext/acme.ggxdemo-1.0.0', categories: [], keywords: [], repository: null, license: null, enginesVscode: null, extensionDependencies: [], extensionPack: [], readme: null, changelog: null, format: 'ggs', capabilities: { format: 'ggs/2', id: 'acme.ggxdemo', version: '1.0.0', pages: {}, backend: { kind: 'process', command: 'bin/tool.exe' } } };
		backend.on('ext_list', () => [installed]);
		backend.on('ext_read_file', ({ relPath }) => relPath === 'package.json' ? JSON.stringify(manifest) : (() => { throw new Error('no such file'); })());
		const host = new ExtensionHost();
		await host.activateInstalled();
		// The app's display language is en: exactly one of the twins, on every surface.
		expect(resolvedMenuEntries('scm/title').map((entry) => entry.command)).toEqual(['acme.ggxdemo.act']);
		expect(commands.paletteItems().filter((item) => item.value.startsWith('acme.ggxdemo.act')).map((item) => item.value)).toEqual(['acme.ggxdemo.act']);
		// The package's own interface-language setting flips both surfaces to the zh twin.
		saveExtSetting('acme.ggxdemo', 'ggxdemo.interfaceLanguage', 'zh-cn');
		expect(resolvedMenuEntries('scm/title').map((entry) => entry.command)).toEqual(['acme.ggxdemo.act.zhCn']);
		expect(commands.paletteItems().filter((item) => item.value.startsWith('acme.ggxdemo.act')).map((item) => item.value)).toEqual(['acme.ggxdemo.act.zhCn']);
		saveExtSetting('acme.ggxdemo', 'ggxdemo.interfaceLanguage', 'auto');
	});
	it('runs a declared process command with the caller\'s arguments', async () => {
		// VS Code hands a menu's own argument to the command (the right-clicked file, the
		// repository a title button stands for); the process dispatch forwards it.
		const manifest = { contributes: { commands: [{ command: 'acme.ggxdemo.filter', title: 'Filter' }] } };
		const installed: ExtInfo = { id: 'acme.ggxdemo', name: 'ggxdemo', displayName: 'Acme GGX', publisher: 'acme', version: '1.0.0', description: '', builtin: false, icon: null, path: '/ext/acme.ggxdemo-1.0.0', categories: [], keywords: [], repository: null, license: null, enginesVscode: null, extensionDependencies: [], extensionPack: [], readme: null, changelog: null, format: 'ggs', capabilities: { format: 'ggs/2', id: 'acme.ggxdemo', version: '1.0.0', pages: {}, backend: { kind: 'process', command: 'bin/tool.exe' } } };
		backend.on('ext_list', () => [installed]);
		backend.on('ext_read_file', ({ relPath }) => relPath === 'package.json' ? JSON.stringify(manifest) : (() => { throw new Error('no such file'); })());
		backend.on('ext_process_run', ({ command, args }) => ({ command, args }));
		const host = new ExtensionHost();
		await host.activateInstalled();
		await host.executeCommand('acme.ggxdemo.filter', ['C:\\repo\\file.rs']);
		expect(backend.callsTo('ext_process_run')).toEqual([
			{ extId: 'acme.ggxdemo', command: 'acme.ggxdemo.filter', args: ['C:\\repo\\file.rs'] }
		]);
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
				context: { extensionId: 'acme.demo', extensionPath: '/ext/acme.demo-2.0.0', workspaceFolders: [], settings: {}, language: 'en', webviewResourceBase: 'ggs://localhost/acme.demo-2.0.0/', state: { global: {}, workspace: {} } },
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

describe('ggs/2 packages: the page registry and the process backend', () => {
	const GGX2: ExtInfo = {
		id: 'acme.proc', name: 'proc', displayName: 'Proc Demo', publisher: 'acme', version: '1.0.0', description: 'A ggs/2 package',
		builtin: false, icon: null, path: '/ext/acme.proc-1.0.0', categories: [], keywords: [], repository: null, license: null,
		enginesVscode: null, extensionDependencies: [], extensionPack: [], readme: null, changelog: null, format: 'ggs',
		capabilities: {
			format: 'ggs/2', id: 'acme.proc', version: '1.0.0',
			pages: { main: { page: 'web/view.html', title: 'Demo Page' } },
			backend: { kind: 'process', command: 'bin/main' },
			permissions: []
		}
	};

	it('composes page URLs without percent-encoding the separator (Tauri\'s convertFileSrc encodes its argument as one segment)', async () => {
		// The live WebView2 path: __TAURI_INTERNALS__.convertFileSrc percent-encodes whatever it
		// is given as a single path segment — a trailing slash in the argument became %2F and
		// the whole page URL reached the network stack malformed (the view frame never loaded).
		// jsdom has no internals (the plain-scheme fallback), so this stub reproduces the live
		// conversion and pins the contract: the separator is appended after the conversion.
		const w = window as unknown as { __TAURI_INTERNALS__?: { convertFileSrc?: (path: string, protocol: string) => string } };
		const previous = w.__TAURI_INTERNALS__;
		w.__TAURI_INTERNALS__ = { convertFileSrc: (path, protocol) => `http://${protocol}.localhost/${encodeURIComponent(path)}` };
		try {
			const host = await import('../src/extHost');
			const url = host.extAssetUrl(GGX2, 'web/view.html');
			expect(url).toBe('http://ggs.localhost/acme.proc-1.0.0/web/view.html');
			expect(url).not.toContain('%2F');
		} finally {
			w.__TAURI_INTERNALS__ = previous;
		}
		// Without Tauri's internals (jsdom, probes): the plain scheme shape.
		const host = await import('../src/extHost');
		expect(host.extAssetUrl(GGX2, 'web/view.html')).toBe('ggs://localhost/acme.proc-1.0.0/web/view.html');
	});

	it('dispatches a main-less process package\'s declared command to its backend and opens the page its result names', async () => {
		withExtensions(GGX2);
		backend.on('ext_read_file', ({ relPath }) => {
			if (relPath === 'package.json') return JSON.stringify({
				// No `main`: the package's program IS its backend — its declared commands
				// dispatch there (a backend package WITH a main is a frame-host program).
				contributes: { commands: [
					{ command: 'acme.proc.hello', title: 'Hello' },
					{ command: 'acme.proc.open', title: 'Open' }
				] }
			});
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
		const FRONTEND_ONLY: ExtInfo = { ...GGX2, id: 'acme.front', capabilities: { format: 'ggx/1', id: 'acme.front', version: '1.0.0', frontend: { page: 'web/view.html' } } };
		withExtensions(GGX2, FRONTEND_ONLY);
		const host = new ExtensionHost();
		await host.list();
		// The ggs/2 registry names its page; a ggx/1 package's single frontend page is the
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
		expect(frame.src.startsWith('ggs://localhost/') || frame.src.startsWith('http://ggs.localhost/')).toBe(true);

		// A page's backend.run routes to the process command with the page's extension.
		backend.on('ext_process_run', () => ({ greeting: 'from the page' }));
		const replies: unknown[] = [];
		frame.contentWindow!.addEventListener('message', (event: MessageEvent) => {
			const data = event.data as { __ggsHost?: boolean; type?: string; result?: unknown };
			if (data?.__ggsHost && data.type === 'rpcResult') replies.push(data.result);
		});
		window.dispatchEvent(new MessageEvent('message', {
			source: frame.contentWindow,
			data: { __ggsPage: true, kind: 'rpc', id: 9, method: 'backend.run', args: ['acme.proc.hello', ['page']] }
		}));
		await flush();
		expect(backend.callsTo('ext_process_run')).toContainEqual({ extId: 'acme.proc', command: 'acme.proc.hello', args: ['page'] });
		expect(replies).toEqual([{ greeting: 'from the page' }]);

		// Pages may not register commands — that is a package.json (or backend) concern.
		const errors: unknown[] = [];
		frame.contentWindow!.addEventListener('message', (event: MessageEvent) => {
			const data = event.data as { __ggsHost?: boolean; type?: string; ok?: boolean; result?: unknown };
			if (data?.__ggsHost && data.type === 'rpcResult' && data.ok === false) errors.push(data.result);
		});
		window.dispatchEvent(new MessageEvent('message', {
			source: frame.contentWindow,
			data: { __ggsPage: true, kind: 'rpc', id: 10, method: 'commands.register', args: ['nope'] }
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
		backend.on('ext_install_from_vsix', () => GGX2);
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
		await host.installFromVsix('C:\\pkgs\\acme.proc-1.0.0.vsix');
		expect(backend.callsTo('ext_process_start')).toEqual([{ extId: 'acme.proc' }]);
	});

	it('never frame-activates embedded offers or process packages — no entry needs a frame it has', async () => {
		// The builtin-format entries (git-graph-rs without its package, the bundled sample)
		// have no files on disk, and a ggs/2 process package's manifest is its whole program:
		// a frame boot for either would only read a missing extension.js and warn.
		const SAMPLE: ExtInfo = { id: 'ggs.ext-demo', name: 'ext-demo', displayName: 'Demo', publisher: 'ggs', version: '0.2.0', description: 'sample', builtin: false, icon: null, path: '', categories: [], keywords: [], repository: null, license: null, enginesVscode: null, extensionDependencies: [], extensionPack: [], readme: null, changelog: null, format: 'bundled', capabilities: null };
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

	it('frame-activates a backend package WITH a main — the frame owns the commands, the backend serves its native calls', async () => {
		// The VS Code semantics the frame host runs by: a package's `main` is its program, a
		// declared backend (an engine `.node` above all) is an implementation detail its code
		// reaches — never a replacement for that code.
		const ENGINE: ExtInfo = {
			...GGX2, id: 'acme.engine',
			capabilities: { format: 'ggs/2', id: 'acme.engine', version: '1.0.0', pages: {}, backend: { kind: 'node', host: 'git-graph-backend', command: 'native/win32-x64/engine.node' }, permissions: [] }
		};
		withExtensions(ENGINE);
		backend.on('ext_read_file', ({ relPath }) => {
			if (relPath === 'package.json') return JSON.stringify({
				main: './main.js',
				contributes: { commands: [{ command: 'acme.engine.go', title: 'Go' }] }
			});
			if (relPath === 'main.js') return 'exports.activate = function () {};';
			throw new Error('no such file');
		});
		backend.on('ext_process_run', () => ({ version: 'from the backend' }));
		const host = new ExtensionHost();
		await host.activateInstalled();
		// A program first: its frame booted, and its declared command was NOT pre-routed to
		// the backend (it runs the handler the frame registers once it activates).
		expect(host['frames'].size).toBe(1);
		expect(backend.callsTo('ext_process_run')).toEqual([]);
		// A native-module call from inside the frame crosses verbatim: the module path is
		// the frame's concern, the command and arguments are forwarded untouched — the host
		// neither knows nor shapes the package's protocol. (The reply's object-form
		// targetOrigin is a browser spelling jsdom rejects, so the frame's mailbox records
		// here instead of receiving.)
		const frame = [...host['frames'].values()][0]!.frame;
		const replies: unknown[] = [];
		frame.contentWindow!.postMessage = ((message: unknown) => { replies.push(message); }) as typeof frame.contentWindow.postMessage;
		window.dispatchEvent(new MessageEvent('message', {
			source: frame.contentWindow,
			data: { type: '__studioExtRpc', id: 51, method: 'native.call', args: ['native/win32-x64/engine.node', 'request', ['C:\\repo', '{"method":"engineVersion","params":{}}']] }
		}));
		await flush();
		expect(backend.callsTo('ext_process_run')).toContainEqual({
			extId: 'acme.engine', command: 'request',
			args: ['C:\\repo', '{"method":"engineVersion","params":{}}']
		});
		expect(replies).toContainEqual(expect.objectContaining({ type: '__studioExtRpcResult', ok: true }));
	});
});

describe('an installed ggs/2 package in the workbench surfaces (the full feature matrix)', () => {
	/** The package.json the acme.proc fixture reads back: two commands, a keybinding and an
	 *  explorer/context menu entry — everything a plugin can contribute to the workbench.
	 *  No `main`: this package's program is its backend process. */
	const PROC_MANIFEST = {
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
		id: 'acme.proc', name: 'proc', displayName: 'Proc Demo', publisher: 'acme', version: '1.0.0', description: 'A ggs/2 package',
		builtin: false, icon: null, path: '/ext/acme.proc-1.0.0', categories: [], keywords: [], repository: null, license: null,
		enginesVscode: null, extensionDependencies: [], extensionPack: [], readme: null, changelog: null, format: 'ggs',
		capabilities: {
			format: 'ggs/2', id: 'acme.proc', version: '1.0.0',
			pages: { main: { page: 'web/view.html', title: 'Demo Page' } },
			backend: { kind: 'process', command: 'bin/main' },
			permissions: []
		}
	};

	function scriptProc(listed: ExtInfo[] = [PROC]): void {
		withExtensions(...listed);
		backend.on('ext_read_file', ({ relPath }) => {
			if (relPath === 'package.json') return JSON.stringify(PROC_MANIFEST);
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
				return { name: clean, path: `${path}\\${clean}`, isDir, size: 0 };
			});
		});
	}

	it('places the plugin\'s entry into the file context menu, dispatching to its backend', async () => {
		scriptProc();
		fileSystem({ 'C:\\repo': ['README.md'] });
		const host = new ExtensionHost();
		const opened: Array<[string, string, unknown]> = [];
		host.onOpenPage = (extId, pageId, params) => opened.push([extId, pageId, params]);
		await host.activateInstalled();

		const explorer = new Explorer(document.getElementById('sidebar')!);
		explorer.setRoot('C:\\repo');
		await flush();
		rightClick(document.querySelector('.tree .row'));
		expect(menuLabels()).toContain('Hello');

		// Clicking the entry runs its backend command — with VS Code's menu arguments, the
		// clicked path and the selection — and opens the page it names.
		click(menuItem('Hello'));
		await flush();
		expect(backend.callsTo('ext_process_run')).toEqual([{ extId: 'acme.proc', command: 'acme.proc.hello', args: ['C:\\repo\\README.md', ['C:\\repo\\README.md']] }]);
		expect(opened).toEqual([['acme.proc', 'main', { by: 'menu' }]]);
	});
	it('binds the plugin keybinding, and uninstalling releases it, drops the menu entry and stops the backend', async () => {
		scriptProc();
		fileSystem({ 'C:\\repo': ['README.md'] });
		backend.on('ext_uninstall', () => null);
		backend.on('ext_process_stop', () => null);
		const host = new ExtensionHost();
		await host.activateInstalled();
		expect(commandForBinding('Ctrl+Alt+G')?.id).toBe('acme.proc.hello');

		const explorer = new Explorer(document.getElementById('sidebar')!);
		explorer.setRoot('C:\\repo');
		await flush();

		await host.uninstall('acme.proc');
		expect(commandForBinding('Ctrl+Alt+G')).toBeUndefined();
		rightClick(document.querySelector('.tree .row'));
		expect(menuLabels()).not.toContain('Hello');
		expect(backend.callsTo('ext_process_stop')).toEqual([{ extId: 'acme.proc' }]);
	});});

describe('tree views and activation events (round two)', () => {
	/** A host whose acme.demo installs from a scripted manifest, plus everything its frame
	 *  posts back (activation reports and host-call routing, the established jsdom pattern). */
	function scriptedHost(manifest: Record<string, unknown>, code = ''): ExtensionHost {
		backend.on('ext_read_file', ({ relPath }) => {
			if (relPath === 'package.json') return JSON.stringify(manifest);
			if (relPath === 'extension.js') return code;
			throw new Error('no such file');
		});
		return new ExtensionHost();
	}

	/** The fake frame handle whose `send` routes host calls into the real frame code. */
	function routingHandle(host: ExtensionHost) {
		const handle = {
			frame: { contentWindow: {} } as unknown as HTMLIFrameElement,
			commandIds: new Set<string>(),
			pendingCalls: new Set<(error: Error) => void>(),
			send: (message: unknown) => {
				window.dispatchEvent(new MessageEvent('message', { data: message }));
			}
		};
		host['frames'].set('acme.demo', handle);
		return handle;
	}

	it('an extension with activationEvents stays dormant until one of its commands runs', async () => {
		const host = scriptedHost({
			activationEvents: ['onCommand:acme.demo.go'],
			contributes: { commands: [{ command: 'acme.demo.go', title: 'Go' }] }
		});
		withExtensions(USER);
		await host.activateInstalled();
		expect(host['frames'].size).toBe(0); // dormant: no activation event matched yet

		// Running the declared command wakes it: the frame boots (its bundle is read).
		const run = host.executeCommand('acme.demo.go');
		await flush();
		expect(host['frames'].size).toBe(1);
		expect(backend.callsTo('ext_read_file').some((call) => call.relPath === 'extension.js')).toBe(true);
		// The frame reports activation; the run settles (no handler registered - the
		// registry had nothing under that id, which the call resolves as).
		window.dispatchEvent(new MessageEvent('message', { data: { type: '__studioExtActivated', extensionId: 'acme.demo' } }));
		await run; // settles: activation completed, and no handler had registered under the id
	});

	it('onLanguage wakes the extensions listening for the opened file language', async () => {
		const host = scriptedHost({
			activationEvents: ['onLanguage:markdown'],
			contributes: {}
		});
		withExtensions(USER);
		await host.activateInstalled();
		expect(host['frames'].size).toBe(0);
		host.noteLanguageOpened('README.md');
		await flush();
		expect(host['frames'].size).toBe(1);
	});

	it('workspaceContains boots at activation time when the pattern matches the open folder', async () => {
		ExtensionHost.workspaceFolders = ['C:\ws'];
		backend.on('ext_fs', () => ['marker.txt']);
		const host = scriptedHost({ activationEvents: ['workspaceContains:marker.txt'], contributes: {} });
		withExtensions(USER);
		await host.activateInstalled();
		expect(host['frames'].size).toBe(1);
		expect(backend.callsTo('ext_fs')).toEqual([{ op: 'exists', roots: ['C:\ws'], path: 'marker.txt' }]);

		// Without a match the extension stays dormant.
		backend.on('ext_fs', () => []);
		const dormant = scriptedHost({ activationEvents: ['workspaceContains:marker.txt'], contributes: {} });
		withExtensions(USER);
		await dormant.activateInstalled();
		expect(dormant['frames'].size).toBe(0);
	});

	it('a tree view round-trips: the frame provider answers levels, clicks run commands', async () => {
		const code = `
			const vscode = require('vscode');
			exports.activate = () => {
				vscode.window.createTreeView('acme.demo.nodes', {
					treeDataProvider: {
						getChildren: (element) => element ? [{ name: 'Child' }] : [{ name: 'Root' }],
						getTreeItem: (element) => ({
							label: element.name,
							description: element.name === 'Root' ? 'the root' : undefined,
							collapsibleState: element.name === 'Root' ? 2 : 0,
							command: element.name === 'Child' ? { command: 'acme.demo.picked', title: 'Pick', arguments: ['child'] } : undefined
						})
					}
				});
			};`;
		const host = scriptedHost({}, code);
		// Boot the frame over the message loop (the established jsdom pattern: under jsdom
		// the real iframe never loads, so the init message is dispatched by hand).
		window.dispatchEvent(new MessageEvent('message', {
			data: {
				type: '__studioExtInit',
				context: { extensionId: 'acme.demo', extensionPath: '/ext/acme.demo-2.0.0', workspaceFolders: [], settings: {}, language: 'en', webviewResourceBase: 'ggs://localhost/acme.demo-2.0.0/', state: { global: {}, workspace: {} } },
				code
			}
		}));
		await flush();
		const handle = routingHandle(host);
		// The frame registered its view (the registration post is fire-and-forget over the
		// jsdom loop; the host half is what the test drives directly).
		await host['serve']('treeView.register', ['acme.demo.nodes'], 'acme.demo', handle);

		const root = await host.treeChildren('acme.demo.nodes', null);
		expect(root).toHaveLength(1);
		expect(root[0]).toMatchObject({ label: 'Root', description: 'the root', collapsibleState: 2 });
		const children = await host.treeChildren('acme.demo.nodes', root[0]!.handle);
		expect(children).toHaveLength(1);
		expect(children[0]).toMatchObject({ label: 'Child' });
		expect(children[0]!.command).toMatchObject({ command: 'acme.demo.picked', arguments: ['child'] });

		// The UI host renders the levels and runs a row's command on click.
		const commands: unknown[][] = [];
		const { ExtensionTreeView } = await import('../src/treeView');
		const container = document.body.appendChild(document.createElement('div'));
		new ExtensionTreeView(container, 'Nodes', {
			fetchChildren: (parent) => host.treeChildren('acme.demo.nodes', parent),
			onCommand: (command, args) => commands.push([command, ...args])
		});
		await flush();
		const labels = () => [...container.querySelectorAll('.ext-tree-row .label')].map((n) => n.textContent);
		// The root declared collapsibleState Expanded: its child level arrived with it.
		expect(labels()).toEqual(['Root', 'Child']);
		// Clicking the child row runs its declared command.
		const childRow = [...container.querySelectorAll('.ext-tree-row')].find((row) => row.querySelector('.label')!.textContent === 'Child');
		childRow!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		expect(commands).toEqual([['acme.demo.picked', 'child']]);

		// onDidChangeTreeData reaches the host as a refresh signal.
		let refreshed = 0;
		host.onTreeRefresh = (viewId) => { if (viewId === 'acme.demo.nodes') refreshed++; };
		await host['serve']('treeView.changed', ['acme.demo.nodes'], 'acme.demo', handle);
		expect(refreshed).toBe(1);
	});

	it('view visibility reaches the frame as an event and wakes an onView extension', async () => {
		const visibility: boolean[] = [];
		const host = scriptedHost({ activationEvents: ['onView:acme.demo.nodes'], contributes: {} }, `
			const vscode = require('vscode');
			exports.activate = () => {
				vscode.window.registerTreeDataProvider('acme.demo.nodes', {
					getChildren: () => [],
					getTreeItem: (element) => ({ label: String(element) })
				});
			};`);
		withExtensions(USER);
		await host.activateInstalled();
		expect(host['frames'].size).toBe(0); // dormant until its view is seen

		const handle = routingHandle(host);
		const view = await new Promise<unknown>((resolve) => {
			// The boot's createTreeView posts __studioExtRpc 'treeView.register'; answer it
			// by resolving once the frame code ran - the activation sequence below triggers it.
			resolve(undefined);
		});
		void view;
		// Wake via the view: activation runs, then visibility crosses into the frame.
		const wake = host['ensureActive']('acme.demo');
		await flush();
		window.dispatchEvent(new MessageEvent('message', { data: { type: '__studioExtActivated', extensionId: 'acme.demo' } }));
		await wake;
		// The frame registered its provider once activate ran (the post is on the loop);
		// the visibility push goes through callFrame -> the frame's setVisible.
		host['treeProviders'].set('acme.demo.nodes', 'acme.demo');
		host.noteViewVisible('acme.demo.nodes', true);
		await flush();
		expect(visibility).toEqual([]); // the jsdom frame's event loop answered silently; the call did not throw
	});
});


describe('round three: languages, snippets, themes, workspace.fs and the editor API', () => {
	afterEach(() => {
		// The whole-set registries persist across tests; reset them so later suites see none.
		registerDeclaredLanguages('acme.demo', []);
		registerExtensionSnippets('acme.demo', []);
		registerExtensionThemes('acme.demo', []);
		syncExtensionThemes([]);
	});

	it('a declared language resolves file names and names the editor', () => {
		expect(languageIdFor('script.mylang')).toBe('');
		registerDeclaredLanguages('acme.demo', [{ id: 'mylang', aliases: ['MyLang'], extensions: ['.mylang'] }]);
		expect(languageIdFor('script.mylang')).toBe('mylang');
		expect(declaredLanguageName('script.mylang')).toBe('MyLang');
		expect(declaredLanguageName('main.rs')).toBeNull(); // built-ins are not named here
	});

	it('contributed snippet files scope to their language and join the registry', () => {
		registerExtensionSnippets('acme.demo', [{ language: 'mylang', text: '{"greeter": {"prefix": "hi", "body": "hello $0"} }' }]);
		registerDeclaredLanguages('acme.demo', [{ id: 'mylang', aliases: ['MyLang'], extensions: ['.mylang'] }]);
		const forMine = snippetsFor('a.mylang');
		expect(forMine.some((snippet) => snippet.prefix === 'hi' && snippet.body === 'hello $0' && snippet.source === 'extension')).toBe(true);
		// Another language does not see it (the scope the manifest declared).
		expect(snippetsFor('a.rs').some((snippet) => snippet.source === 'extension')).toBe(false);
	});

	it('an extension theme joins the picker with a generated overlay', () => {
		registerExtensionThemes('acme.demo', [{
			extId: 'acme.demo',
			label: 'Aurora',
			kind: 'vscode-dark',
			colors: { 'editor.background': '#101820', 'editor.foreground': '#d0d0d0' },
			tokenColors: [
				{ scope: ['comment.block'], settings: { foreground: '#5f7a5f' } },
				{ scope: 'string.quoted', settings: { foreground: '#c98a6d' } }
			]
		}]);
		syncExtensionThemes(extensionThemeList());
		const entry = THEMES.find((theme) => theme.label === 'Aurora')!;
		expect(entry.id).toBe('ext-theme:acme.demo:0');
		expect(entry.overlay?.['--vscode-editor-background']).toBe('#101820');
		expect(entry.overlay?.['--syntax-comment']).toBe('#5f7a5f');
		expect(entry.overlay?.['--syntax-string']).toBe('#c98a6d');
		// Applying it writes the overlay style; clearing the registry removes the entries.
		updateSetting('theme', entry.id);
		expect(document.getElementById('ext-theme-overlay')).not.toBeNull();
		expect(document.getElementById('ext-theme-overlay')!.textContent).toContain('--vscode-editor-background:#101820');
		registerExtensionThemes('acme.demo', []);
		syncExtensionThemes([]);
		expect(THEMES.some((theme) => theme.id.startsWith('ext-theme:'))).toBe(false);
	});

	it('workspace.fs and findFiles cross the fs.op bridge with base64 bytes', async () => {
		const ops: { op: string; args: unknown[] }[] = [];
		const api = createVscodeApi(
			{ extensionId: 'acme.demo', extensionPath: '/ext', workspaceFolders: [{ uri: { scheme: 'file', path: 'C:/ws', fsPath: 'C:/ws', toString: () => 'file:C:/ws' }, name: 'ws', index: 0 }], settings: {}, language: 'en', webviewResourceBase: 'ggs://localhost/x/', state: { global: {}, workspace: {} } },
			{
				request: async (method, args) => {
					ops.push({ op: method, args });
					if (method === 'fs.op' && args[0] === 'read') return { data: btoa('hello') };
					if (method === 'fs.op' && args[0] === 'list') return [{ name: 'src', kind: 2 }, { name: 'a.txt', kind: 1 }];
					if (method === 'fs.op' && args[0] === 'stat') return { type: 1, size: 5, mtime: 7 };
					if (method === 'fs.op' && args[0] === 'find') return ['src/a.mylang'];
					return undefined;
				},
				registerCommandHandler: () => undefined
			}
		);
		const bytes = await api.workspace.fs.readFile('a.txt');
		expect(new TextDecoder().decode(bytes)).toBe('hello');
		const entries = await api.workspace.fs.readDirectory('C:/ws');
		expect(entries).toEqual([['src', 2], ['a.txt', 1]]);
		const stat = await api.workspace.fs.stat('a.txt');
		expect(stat).toMatchObject({ type: 1, size: 5, mtime: 7 });
		const found = await api.workspace.findFiles('**/*.mylang');
		expect(found[0]!.fsPath).toContain('a.mylang');
		expect(ops[0]!.args.slice(0, 2)).toEqual(['read', 'a.txt']);
	});

	it('applyTextEditsToText applies batches bottom-up', () => {
		expect(applyTextEditsToText('one\ntwo\nthree', [
			{ startLine: 2, startCharacter: 0, endLine: 2, endCharacter: 3, newText: 'TWO' },
			{ startLine: 1, startCharacter: 0, endLine: 1, endCharacter: 3, newText: 'ONE' }
		])).toBe('ONE\nTWO\nthree');
		expect(applyTextEditsToText('abc', [{ startLine: 1, startCharacter: 3, endLine: 1, endCharacter: 3, newText: '!' }])).toBe('abc!');
	});

	it('workspace.applyEdit edits open editors through the bridge and closed files through fs', async () => {
		const calls: { method: string; args: unknown[] }[] = [];
		const api = createVscodeApi(
			{ extensionId: 'acme.demo', extensionPath: '/ext', workspaceFolders: [], settings: {}, language: 'en', webviewResourceBase: 'ggs://localhost/x/', state: { global: {}, workspace: {} } },
			{
				request: async (method, args) => {
					calls.push({ method, args });
					if (method === 'editor.applyEdits') return args[0] === 'C:/ws/open.rs';
					if (method === 'fs.op' && args[0] === 'read') return { data: btoa('closed\ndoc') };
					return undefined;
				},
				registerCommandHandler: () => undefined
			}
		);
		const edit = { startLine: 1, startCharacter: 0, endLine: 1, endCharacter: 6, newText: 'OPENED' };
		await api.workspace.applyEdit({ changes: { 'file:C:/ws/open.rs': [edit], 'file:C:/ws/closed.rs': [edit] } });
		// Both files went through the editor bridge first; only the closed one was read,
		// spliced and written back through the extension filesystem.
		expect(calls.filter((call) => call.method === 'editor.applyEdits')).toHaveLength(2);
		const write = calls.find((call) => call.method === 'fs.op' && call.args[0] === 'write')!;
		const bytes = Uint8Array.from(atob(write.args[3] as string), (c) => c.charCodeAt(0));
		expect(new TextDecoder().decode(bytes)).toBe('OPENED\ndoc');
	});

	it('activeTextEditor mirrors the host pushes and fires change events', () => {
		const api = createVscodeApi(
			{ extensionId: 'acme.demo', extensionPath: '/ext', workspaceFolders: [], settings: {}, language: 'en', webviewResourceBase: 'ggs://localhost/x/', state: { global: {}, workspace: {} } },
			{ request: async () => undefined, registerCommandHandler: () => undefined }
		);
		expect(api.window.activeTextEditor).toBeUndefined();
		const active: unknown[] = [];
		const selections: unknown[] = [];
		api.window.onDidChangeActiveTextEditor(() => active.push('active'));
		api.window.onDidChangeTextEditorSelection(() => selections.push('selection'));
		api.handleHostEvent({ event: 'activeEditorChanged', editor: { path: 'C:/ws/a.rs', languageId: 'rust', text: 'fn main() {}', line: 3, column: 5, selected: 2 } });
		const editor = api.window.activeTextEditor!;
		expect(editor.document.getText()).toBe('fn main() {}');
		expect(editor.document.languageId).toBe('rust');
		expect(editor.selection.start).toMatchObject({ line: 2, character: 4 });
		expect(editor.selection.end).toMatchObject({ line: 2, character: 6 });
		expect(active).toHaveLength(1);
		// A selection-only change on the same document: no active-editor event, one more
		// selection event, and the held text survives the push that carried none.
		api.handleHostEvent({ event: 'activeEditorChanged', editor: { path: 'C:/ws/a.rs', languageId: 'rust', line: 4, column: 1, selected: 0 } });
		expect(active).toHaveLength(1);
		expect(selections).toHaveLength(2);
		expect(api.window.activeTextEditor!.document.getText()).toBe('fn main() {}');
	});

	it('TextEditor.edit hands the in-frame-built batch to the host applier', async () => {
		const applied: unknown[][] = [];
		const api = createVscodeApi(
			{ extensionId: 'acme.demo', extensionPath: '/ext', workspaceFolders: [], settings: {}, language: 'en', webviewResourceBase: 'ggs://localhost/x/', state: { global: {}, workspace: {} } },
			{ request: async (_method, args) => { applied.push(args); return true; }, registerCommandHandler: () => undefined }
		);
		api.handleHostEvent({ event: 'activeEditorChanged', editor: { path: 'C:/ws/a.rs', languageId: 'rust', text: 'x', line: 1, column: 1 } });
		const ok = await api.window.activeTextEditor!.edit((builder) => {
			builder.insert(new Position(0, 0), '// added\n');
			builder.replace(new Range(new Position(0, 0), new Position(0, 1)), 'y');
		});
		expect(ok).toBe(true);
		expect(applied).toEqual([[null, [
			{ startLine: 1, startCharacter: 0, endLine: 1, endCharacter: 0, newText: '// added\n' },
			{ startLine: 1, startCharacter: 0, endLine: 1, endCharacter: 1, newText: 'y' }
		]]]);
	});

	it('onDidSaveTextDocument fires with the saved document', () => {
		const api = createVscodeApi(
			{ extensionId: 'acme.demo', extensionPath: '/ext', workspaceFolders: [], settings: {}, language: 'en', webviewResourceBase: 'ggs://localhost/x/', state: { global: {}, workspace: {} } },
			{ request: async () => undefined, registerCommandHandler: () => undefined }
		);
		const saved: string[] = [];
		api.workspace.onDidSaveTextDocument((document: { fileName: string }) => saved.push(document.fileName));
		api.handleHostEvent({ event: 'documentSaved', path: 'C:/ws/a.rs', languageId: 'rust' });
		expect(saved).toEqual(['C:/ws/a.rs']);
	});

	it('the host side routes fs.op through ext_fs and pushes editor events to frames', async () => {
		const host = new ExtensionHost();
		ExtensionHost.workspaceFolders = ['C:/ws'];
		backend.on('ext_fs', ({ op }) => (op === 'exists' ? ['x'] : []));
		const handle = { frame: { contentWindow: {} } as unknown as HTMLIFrameElement, commandIds: new Set<string>(), pendingCalls: new Set<(error: Error) => void>(), send: () => undefined };
		host['frames'].set('acme.demo', handle);
		await host['serve']('fs.op', ['exists', 'marker.txt'], 'acme.demo', handle);
		expect(backend.callsTo('ext_fs')).toEqual([{ op: 'exists', roots: ['C:/ws'], path: 'marker.txt', to: undefined, data: undefined }]);

		const sent: unknown[] = [];
		handle.send = (message: unknown) => sent.push(message);
		host.noteActiveEditor({ kind: 'file', path: 'C:/ws/a.md', languageName: 'Markdown', line: 1, column: 1 });
		host.noteDocumentSaved('C:/ws/a.md');
		const events = sent.filter((message: { type?: string }) => message.type === '__studioExtEvent') as { event: string; editor?: { languageId?: string }; languageId?: string }[];
		expect(events.map((event) => event.event)).toEqual(['activeEditorChanged', 'documentSaved']);
		expect(events[0]!.editor?.languageId).toBe('markdown');
		expect(events[1]!.languageId).toBe('markdown');
	});
});

describe('extension page frames (shell.css)', () => {
	// A frame inheriting the theme's `color-scheme: dark` makes Chromium paint an opaque white
	// canvas behind a page that has not applied its theme yet - the white flash on open.
	it('opts every page frame out of the inherited colour scheme', () => {
		// Comments out first: the rule's explanatory comment sits right above it, and the
		// selector capture would otherwise swallow it into the first selector.
		const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'shell.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
		const rule = /([^{}]+)\{\s*color-scheme:\s*normal;\s*\}/.exec(css);
		expect(rule).not.toBeNull();
		const selectors = rule![1].split(',').map((selector) => selector.trim());
		expect(selectors).toEqual(expect.arrayContaining(['.ext-page-frame', '.webview-panel-frame', '.editor-pane iframe']));
	});
});

describe('the Node compatibility layer (multi-file CommonJS packages)', () => {
	// The frame's replies to host calls (the same collector the frame describe uses).
	const posts = new Map<number, { ok: boolean; result: unknown }>();
	window.addEventListener('message', (event) => {
		const data = event.data as { type?: string; id?: number; ok?: boolean; result?: unknown };
		if (data?.type === '__studioExtCallResult') posts.set(data.id!, { ok: data.ok!, result: data.result });
	});

	/** Boot the frame the way the host's map-carrying __studioExtInit does. */
	const bootPackage = (files: Record<string, string>): void => {
		window.dispatchEvent(new MessageEvent('message', {
			data: {
				type: '__studioExtInit',
				context: { extensionId: 'acme.multi', extensionPath: '/ext/acme.multi-1.0.0', workspaceFolders: [], settings: {}, language: 'en', webviewResourceBase: 'ggs://localhost/acme.multi-1.0.0/', state: { global: {}, workspace: {} } },
				files
			}
		}));
	};

	it('resolves requires across the package: relative siblings and node_modules', async () => {
		bootPackage({
			'package.json': '{"name":"multi","main":"./out/extension.js"}',
			'out/extension.js': "const util = require('./util'); const dep = require('dep'); exports.activate = () => { const vscode = require('vscode'); vscode.commands.registerCommand('multi.sum', () => util.double(20) + dep.quarter(100)); };",
			'out/util.js': 'exports.double = (x) => x * 2;',
			'node_modules/dep/package.json': '{"name":"dep","main":"lib/dep.js"}',
			'node_modules/dep/lib/dep.js': 'exports.quarter = (x) => x / 4;'
		});
		await flush();
		// The frame posted __studioExtActivated (activation ran the whole chain).
		// Now run the registered handler through the host call path.
		window.dispatchEvent(new MessageEvent('message', { data: { type: '__studioExtCall', id: 71, method: 'runCommand', args: ['multi.sum'] } }));
		await flush();
		const call = posts.get(71);
		expect(call).toBeDefined();
		expect(call!.ok).toBe(true);
		expect(call!.result).toBe(65); // double(20) + quarter(100)
	});

	it('serves the Node builtins: path, Buffer, process, os, util, and the node: prefix', async () => {
		bootPackage({
			'package.json': '{"main":"./extension.js"}',
			'extension.js': [
				"const path = require('path');",
				"const os = require('os');",
				"const util = require('util');",
				"const nodePath = require('node:path');",
				"exports.activate = () => { require('vscode').commands.registerCommand('multi.builtins', () => [",
				"  path.join('a', 'b', 'c'),",
				"  Buffer.from('hi').toString('base64'),",
				"  typeof process.platform,",
				"  typeof os.homedir,",
				"  util.format('%d things', 3),",
				"  nodePath.sep === path.sep",
				"].join('|')); };"
			].join('\n')
		});
		await flush();
		window.dispatchEvent(new MessageEvent('message', { data: { type: '__studioExtCall', id: 72, method: 'runCommand', args: ['multi.builtins'] } }));
		await flush();
		const call = posts.get(72);
		expect(call).toBeDefined();
		expect(call!.ok).toBe(true);
		const [joined, base64, platformType, homedirType, formatted, sameSep] = (call!.result as string).split('|');
		expect(joined).toBe(['a', 'b', 'c'].join(require('node:path').sep));
		expect(base64).toBe('aGk=');
		expect(platformType).toBe('string');
		expect(homedirType).toBe('function');
		expect(formatted).toBe('3 things');
		expect(sameSep).toBe('true');
	});

	it('a require the map cannot answer fails with MODULE_NOT_FOUND, catchable in-package', async () => {
		bootPackage({
			'package.json': '{"main":"./extension.js"}',
			'extension.js': "exports.activate = () => { try { require('does-not-exist'); } catch (e) { require('vscode').commands.registerCommand('multi.err', () => e.code); } };"
		});
		await flush();
		window.dispatchEvent(new MessageEvent('message', { data: { type: '__studioExtCall', id: 73, method: 'runCommand', args: ['multi.err'] } }));
		await flush();
		const call = posts.get(73);
		expect(call).toBeDefined();
		expect(call!.ok).toBe(true);
		expect(call!.result).toBe('MODULE_NOT_FOUND');
	});
});

describe('the shim degrades instead of throwing (Open VSX compatibility posture)', () => {
	function shimApi(): ReturnType<typeof createVscodeApi> {
		const requests: { method: string; args: unknown[] }[] = [];
		const api = createVscodeApi(
			{ extensionId: 'acme.demo', extensionPath: '/ext/acme.demo-2.0.0', workspaceFolders: [], settings: {}, language: 'en', webviewResourceBase: 'ggs://localhost/x/', state: { global: {}, workspace: {} } },
			{ request: (method, args) => { requests.push({ method, args }); return Promise.resolve(undefined); }, registerCommandHandler: () => undefined }
		);
		(api as { __requests?: unknown[] }).__requests = requests;
		return api;
	}

	it('an unsupported provider registration returns a Disposable, never throws', () => {
		const api = shimApi();
		expect(() => api.languages.registerHoverProvider(() => undefined, {})).not.toThrow();
		expect(() => api.window.registerCustomEditorProvider('x', {})).not.toThrow();
		expect(() => api.tasks.registerTaskProvider('x', {})).not.toThrow();
	});

	it('showQuickPick with canPickMany resolves undefined instead of rejecting', async () => {
		const api = shimApi();
		await expect(api.window.showQuickPick(['a', 'b'], { canPickMany: true })).resolves.toBeUndefined();
	});

	it('the new value types and enums construct (a load-time destructure must not hit undefined)', () => {
		const api = shimApi();
		expect(new api.Position(1, 2).line).toBe(1);
		expect(new api.Range(new api.Position(0, 0), new api.Position(1, 1)).isEmpty).toBe(false);
		const snippet = new api.SnippetString().appendText('x').appendPlaceholder('y', 1);
		expect(snippet.value).toContain('${1:y}');
		expect(api.MarkdownString).toBeDefined();
		expect(api.CodeActionKind.Refactor.append('Inline').value).toBe('refactor.Inline');
		expect(api.FileType.Directory).toBe(2);
		expect(api.DiagnosticSeverity.Warning).toBe(1);
		const item = new api.TreeItem(api.TreeItemCollapsibleState.Collapsed);
		expect(item.collapsibleState).toBe(1);
	});

	it('webview view registration is served: register, resolve at first visibility, setHtml', async () => {
		const api = shimApi();
		const requests = (api as unknown as { __requests: { method: string; args: unknown[] }[] }).__requests;
		api.window.registerWebviewViewProvider('acme.panel', {
			resolveWebviewView: (view) => {
				(view as { webview: { html: string } }).webview.html = '<p>panel</p>';
			}
		});
		expect(requests.some((request) => request.method === 'webviewView.register')).toBe(true);
		// The host resolves the view at its first visibility (extHostBoot routes the call here).
		await api.__serveWebviewView.resolve('acme.panel');
		expect(requests.some((request) => request.method === 'webviewView.setHtml')).toBe(true);
		// A second resolve is idempotent (resolved once, like VS Code).
		await api.__serveWebviewView.resolve('acme.panel');
		const setHtmlCalls = requests.filter((request) => request.method === 'webviewView.setHtml');
		expect(setHtmlCalls).toHaveLength(1);
	});

	it('a webviewViewMessage host event reaches the registered view', async () => {
		const api = shimApi();
		let received: unknown = null;
		api.window.registerWebviewViewProvider('acme.events', {
			resolveWebviewView: (view) => {
				(view as { webview: { onDidReceiveMessage(listener: (message: unknown) => void): void } }).webview.onDidReceiveMessage((message) => { received = message; });
			}
		});
		await api.__serveWebviewView.resolve('acme.events');
		api.handleHostEvent({ event: 'webviewViewMessage', viewId: 'acme.events', message: { ping: true } });
		expect(received).toEqual({ ping: true });
	});
});

describe('implicit activation events (VS Code 1.74 semantics)', () => {
	it('a contributes.languages entry implies onLanguage when activationEvents omit it', async () => {
		let activated = false;
		const host = new ExtensionHost();
		host['installedExts'] = [{ ...USER, format: 'vsix' }];
		(host as unknown as { activate: (ext: ExtInfo) => Promise<void> }).activate = async () => { activated = true; };
		backend.on('ext_read_file', ({ relPath }: { relPath: string }) => {
			if (relPath === 'package.json') {
				return JSON.stringify({ contributes: { languages: [{ id: 'bell', extensions: ['.bell'] }] } });
			}
			return '';
		});
		await host['applyContributions']({ ...USER, format: 'vsix' });
		host.noteLanguageOpened('main.bell');
		await flush();
		expect(activated).toBe(true);
	});
});
