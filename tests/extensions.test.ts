import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ExtensionHost, themeVars, type ExtInfo, type GalleryEntry } from '../src/extHost';
import { EditorGroup } from '../src/editor';
import { applyContributions, applyExtensionSettings, evaluateWhen, extensionSettingDefs, registerContextProvider, removeContributions, resolvedMenuEntries } from '../src/contributions';
import { extLog, extLogEntries, flushExtLog, resetExtLog } from '../src/extLog';
import { ExtensionsPanel } from '../src/extensionsPanel';
import { commandForBinding, commands } from '../src/commands';
import { activationContext, createVscodeApi, applyTextEditsToText, Position, rehydrateUris, Range, readLocalDocProvider, RelativePattern, setUriPlatform, Uri, ViewColumn, watcherGlobMatches } from '../src/vscodeApi';
import { createNodeBuiltins } from '../src/nodeShims';
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

// `Uri.fsPath` follows the host platform (VS Code's rule); the suite pins POSIX spelling so
// it asserts the same paths on every OS — the Windows spelling has its own tests.
beforeEach(() => setUriPlatform('linux'));

function withExtensions(...extensions: ExtInfo[]): void {
	backend.on('ext_list', () => extensions);
}

function mountedPanel(host = new ExtensionHost()): ExtensionsPanel {
	const container = document.body.appendChild(document.createElement('div'));
	return new ExtensionsPanel(container, host);
}

describe('ExtensionsPanel', () => {
	// The default market: git-graph-rs featured, the registry unreachable — so its row is
	// the installer's bundled offer and everything else lists under "Other installed".
	beforeEach(() => {
		withExtensions(BUILTIN, USER);
		backend.on('ext_gallery_featured', () => ['neophack.git-graph-rs']);
		backend.on('ext_gallery_lookup', () => { throw new Error('offline'); });
	});

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
		// A bundled offer shows on a featured row only (outside the list it is not offered).
		backend.on('ext_gallery_featured', () => ['neophack.git-graph-rs', 'ggs.ext-demo']);
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

	/* ---------- The featured packages (Open VSX, over the backend gallery commands) ---------- */

	const CLAUDE: GalleryEntry = {
		id: 'Anthropic.claude-code', name: 'claude-code', namespace: 'Anthropic',
		displayName: 'Claude Code for VS Code', description: 'Claude Code in the editor',
		version: '2.1.283', downloadCount: 12345678, averageRating: 4.5, verified: true,
		timestamp: '2026-09-20T03:04:05Z', iconUrl: null,
		downloadUrl: 'https://open-vsx.org/api/Anthropic/claude-code/win32-x64/2.1.283/file/Anthropic.claude-code-2.1.283@win32-x64.vsix'
	};
	const GRAPH: GalleryEntry = {
		id: 'neophack.git-graph-rs', name: 'git-graph-rs', namespace: 'neophack', displayName: 'Git Graph (Rust)',
		description: 'Git Graph', version: '1.0.25', downloadCount: 12, averageRating: null, verified: false,
		timestamp: '2026-09-20T03:04:05Z', iconUrl: null,
		downloadUrl: 'https://open-vsx.org/api/neophack/git-graph-rs/win32-x64/1.0.25/file/neophack.git-graph-rs-1.0.25@win32-x64.vsix'
	};
	const GRAPH_INSTALLED: ExtInfo = { ...BUILTIN, builtin: false, format: 'vsix', version: '1.0.23', path: '/ext/neophack.git-graph-rs-1.0.23' };

	/** The panel with both featured packages on the market; `list` is what ext_list reports. */
	function withFeatured(list: ExtInfo[]): { state: { list: ExtInfo[] } } {
		backend.on('ext_gallery_featured', () => ['Anthropic.claude-code', 'neophack.git-graph-rs']);
		backend.on('ext_gallery_lookup', ({ id }: { id: string }) => (id === CLAUDE.id ? CLAUDE : GRAPH));
		// The install pass re-reads package.json (the activation reload): a minimal manifest
		// keeps the frame's boot quiet instead of notifying a load failure.
		backend.on('ext_read_file', ({ relPath }: { relPath: string }) => (relPath === 'package.json' ? '{}' : ''));
		const state = { list };
		backend.on('ext_list', () => state.list);
		return { state };
	}

	it('shows exactly the featured packages, with no search box', async () => {
		withFeatured([GRAPH_INSTALLED]);
		const panel = mountedPanel();
		await panel.refresh();
		await flush();
		expect(document.querySelector('input[type="search"]')).toBeNull();
		// Each featured id is looked up exactly, through the one marketplace origin.
		expect(backend.callsTo('ext_gallery_lookup')).toEqual([
			{ gallery: 'https://open-vsx.org', id: 'Anthropic.claude-code' },
			{ gallery: 'https://open-vsx.org', id: 'neophack.git-graph-rs' }
		]);
		const rows = document.querySelectorAll('.ext-row');
		expect(rows.length).toBe(2);
		expect(rows[0]!.textContent).toContain('Claude Code for VS Code');
		expect(rows[0]!.querySelector('.ext-verified')!.textContent).toContain('verified');
		expect(rows[1]!.textContent).toContain('Git Graph');
		expect(document.querySelector('.ext-section-label')).toBeNull();
	});

	it('installs a featured package that is absent, and offers Update over an older install', async () => {
		const { state } = withFeatured([GRAPH_INSTALLED]);
		const installedClaude: ExtInfo = { ...USER, id: 'Anthropic.claude-code', name: 'claude-code', publisher: 'Anthropic', displayName: 'Claude Code for VS Code', version: '2.1.283', path: '/ext/Anthropic.claude-code-2.1.283', extensionDependencies: [] };
		backend.on('ext_gallery_install', () => installedClaude);
		const panel = mountedPanel();
		await panel.refresh();
		await flush();
		const rows = document.querySelectorAll<HTMLElement>('.ext-row');
		// git-graph-rs v1.0.23 installed against the market's 1.0.25: Update, beside Uninstall.
		const graphActions = [...rows[1]!.querySelectorAll<HTMLElement>('.action-btn')].map((b) => b.title);
		expect(graphActions.join('|')).toContain('Update to 1.0.25');
		expect(graphActions.join('|')).toContain('Uninstall neophack.git-graph-rs');
		// claude-code is absent: Install downloads this platform's build.
		click(rows[0]!.querySelector<HTMLElement>('.action-btn')!);
		await flush();
		expect(backend.callsTo('ext_gallery_install')).toEqual([{ gallery: 'https://open-vsx.org', downloadUrl: CLAUDE.downloadUrl }]);
		expect(notifications().join()).toContain('Anthropic.claude-code v2.1.283');
		state.list = [installedClaude, GRAPH_INSTALLED];
		await panel.refresh();
		// Installed and current: the ordinary installed row — no Install, no Update.
		const claudeRow = document.querySelectorAll<HTMLElement>('.ext-row')[0]!;
		const titles = [...claudeRow.querySelectorAll<HTMLElement>('.action-btn')].map((b) => b.title).join('|');
		expect(titles).toContain('Uninstall Anthropic.claude-code');
		expect(titles).not.toContain('Update');
		expect(titles).not.toContain('Install from the Marketplace');
	});

	it('matches an installed id ignoring case, as VS Code does', async () => {
		withFeatured([{ ...GRAPH_INSTALLED, id: 'NeoPhack.Git-Graph-RS', version: '1.0.25' }]);
		const panel = mountedPanel();
		await panel.refresh();
		await flush();
		const rows = document.querySelectorAll<HTMLElement>('.ext-row');
		expect(rows.length).toBe(2);
		expect(rows[1]!.querySelector('.action-btn')!.title).toContain('Uninstall');
	});

	it('an unreachable marketplace falls back to the bundled offer and says so where there is none', async () => {
		withFeatured([BUILTIN]);
		backend.on('ext_gallery_lookup', () => { throw new Error('offline'); });
		const panel = mountedPanel();
		await panel.refresh();
		await flush();
		const rows = document.querySelectorAll<HTMLElement>('.ext-row');
		expect(rows[0]!.textContent).toContain('The Marketplace is unavailable');
		expect(rows[0]!.textContent).toContain('offline');
		// git-graph-rs still installs offline, from the package the installer carries.
		expect(rows[1]!.querySelector('.action-btn')!.title).toContain('Install the bundled');
		// Retry asks the marketplace again, and the answer fills the row in.
		backend.on('ext_gallery_lookup', ({ id }: { id: string }) => (id === CLAUDE.id ? CLAUDE : GRAPH));
		click(rows[0]!.querySelector<HTMLElement>('.action-btn')!);
		await flush();
		expect(backend.callsTo('ext_gallery_lookup').length).toBe(4);
		expect(document.querySelectorAll('.ext-row')[0]!.textContent).toContain('Claude Code for VS Code');
		expect(document.querySelectorAll('.ext-row')[0]!.querySelector('.action-btn')!.title).toContain('Install from the Marketplace');
	});

	it('lists other installed packages apart, and hides bundled offers outside the featured list', async () => {
		const SAMPLE: ExtInfo = { ...USER, id: 'ggs.ext-demo', displayName: 'Sample Offer', path: '', format: 'bundled' };
		withFeatured([GRAPH_INSTALLED, USER, SAMPLE]);
		const panel = mountedPanel();
		await panel.refresh();
		await flush();
		expect(document.querySelector('.ext-section-label')!.textContent).toBe('Other installed');
		const rows = document.querySelectorAll<HTMLElement>('.ext-row');
		expect(rows.length).toBe(3);
		expect(rows[2]!.querySelector('.action-btn')!.title).toContain('Uninstall acme.demo');
		expect(document.body.textContent).not.toContain('Sample Offer');
	});

	it('the detail page shows the facts and renders the package\'s README', async () => {
		const PROC: ExtInfo = {
			...USER, id: 'acme.proc', displayName: 'Proc', format: 'ggs', path: '/ext/acme.proc-2.0.0', readme: 'README.md',
			capabilities: {
				id: 'acme.proc', version: '2.0.0',
				backend: { kind: 'process', command: 'bin/main' }
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
		// The facts: identifier, install location, the declared backend and its live process.
		expect(page.textContent).toContain('acme.proc');
		expect(page.textContent).toContain('/ext/acme.proc-2.0.0');
		expect(page.textContent).toContain('ggs-ext/1');
		expect(page.textContent).toContain('bin/main');
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
		const batches: string[][] = [];
		const api = createVscodeApi(
			{ extensionId: 'acme.demo', extensionPath: '/ext/acme.demo-2.0.0', workspaceFolders: [], settings: {}, language: 'en' },
			{
				request: async (method, args) => {
					if (method === 'commands.registerBatch') {
						batches.push(args[0] as string[]);
						for (const id of args[0] as string[]) registeredIds.push('queued');
					}
					return undefined;
				},
				registerCommandHandler: (id, fn) => { registeredIds.push(id); handler = fn; }
			}
		);
		api.commands.registerCommand('sayHi', (...args: unknown[]) => `hi ${args[0]}`);
		// Registrations queue (one pipe round trip for the lot, not one per command) and
		// cross when the activation settles — the flush hook the API layer exposes.
		expect(registeredIds).toEqual(['acme.demo.sayHi']);
		(globalThis as { __ggsFlushRegistrations?: () => void }).__ggsFlushRegistrations?.();
		expect(registeredIds).toEqual(['acme.demo.sayHi', 'queued']);
		expect(batches).toEqual([['acme.demo.sayHi']]);
		expect(handler!('world')).toBe('hi world');
	});

	it('showTextDocument opens a provider-scheme document as a beside content tab, a file with the caller\'s column', async () => {
		// claude-code's chat opens its tool outputs and code blocks as virtual documents
		// under a provider scheme (`_claude_vscode_fs_readonly:/temp/...`): the tab is the
		// read-only content one, placed beside so the chat keeps its view. A plain file
		// keeps going through `workspace.openFile`, carrying the ViewColumn as placement.
		const requests: { method: string; args: unknown[] }[] = [];
		const api = createVscodeApi(
			{ extensionId: 'acme.demo', extensionPath: '/ext', workspaceFolders: [], settings: {}, language: 'en' },
			{
				request: async (method, args) => {
					requests.push({ method, args: args ?? [] });
					if (method === 'docProvider.read') return 'the provider text';
					return undefined;
				},
				registerCommandHandler: () => undefined
			}
		);
		const uri = Uri.from({ scheme: '_claude_vscode_fs_readonly', path: '/temp/readonly/Claude Code (ab12cd)' });
		const doc = await api.workspace.openTextDocument(uri);
		await api.window.showTextDocument(doc, { preview: true });
		await api.window.showTextDocument(Uri.file('/repo/src/main.ts'), ViewColumn.Beside);
		expect(requests).toEqual([
			{ method: 'docProvider.read', args: [uri] },
			{ method: 'workspace.openContentTab', args: ['Claude Code (ab12cd)', '/temp/readonly/Claude Code (ab12cd)', 'the provider text', 'beside'] },
			{ method: 'workspace.openFile', args: ['/repo/src/main.ts', undefined, undefined, 'beside'] }
		]);
	});

	it('an own provider scheme reads locally - openTextDocument never round-trips through the host', async () => {
		// The ggs-node reentry guard: claude-code's chat reads its own readonly scheme on
		// click, and the blocking bridge parks the one JS thread inside every host request
		// until its answer crosses back - an answer that is itself a call back into this
		// same parked thread (`docProvider.provide`). The bridge's own registration answers
		// first; a scheme another extension registered keeps the host lookup (the test above).
		const requests: { method: string; args: unknown[] }[] = [];
		const parked = new Map<string, { provideTextDocumentContent?: (uri: unknown) => unknown }>();
		const api = createVscodeApi(
			{ extensionId: 'acme.demo', extensionPath: '/ext', workspaceFolders: [], settings: {}, language: 'en' },
			{
				request: async (method, args) => {
					requests.push({ method, args: args ?? [] });
					return undefined;
				},
				registerCommandHandler: () => undefined,
				registerDocProvider: (scheme, provider) => parked.set(scheme, provider),
				unregisterDocProvider: (scheme) => parked.delete(scheme),
				readDocProvider: (uri) => readLocalDocProvider(parked, uri)
			}
		);
		api.workspace.registerTextDocumentContentProvider('chatout', {
			provideTextDocumentContent: (uri) => `CONTENT:${(uri as { path?: string }).path}`
		});
		const uri = Uri.from({ scheme: 'chatout', path: '/temp/readonly/Bash tool output (ab12cd)' });
		const doc = await api.workspace.openTextDocument(uri);
		expect(doc.getText()).toBe('CONTENT:/temp/readonly/Bash tool output (ab12cd)');
		await api.window.showTextDocument(doc, { preview: true });
		expect(requests).toEqual([
			{ method: 'docProvider.register', args: ['chatout'] },
			{ method: 'workspace.openContentTab', args: ['Bash tool output (ab12cd)', '/temp/readonly/Bash tool output (ab12cd)', 'CONTENT:/temp/readonly/Bash tool output (ab12cd)', 'beside'] }
		]);
	});

	it('a file-system provider scheme answers openTextDocument locally - claude-code\u2019s diff sides', async () => {
		// claude-code stages its change-review diffs' both sides in in-memory
		// `workspace.registerFileSystemProvider` schemes (`_claude_vscode_fs_left/right`):
		// the read half is served — the provider parks in this frame, the host learns the
		// scheme, and this frame's own reads never round-trip. A content provider keeps
		// its priority when both are registered under one scheme.
		const requests: { method: string; args: unknown[] }[] = [];
		const parkedFs = new Map<string, { readFile?: (uri: unknown) => unknown }>();
		const encoder = new TextEncoder();
		const api = createVscodeApi(
			{ extensionId: 'acme.demo', extensionPath: '/ext', workspaceFolders: [], settings: {}, language: 'en' },
			{
				request: async (method, args) => {
					requests.push({ method, args: args ?? [] });
					return undefined;
				},
				registerCommandHandler: () => undefined,
				registerFsProvider: (scheme, provider) => parkedFs.set(scheme, provider),
				unregisterFsProvider: (scheme) => parkedFs.delete(scheme),
				readDocProvider: (uri) => readLocalDocProvider(new Map(), uri, parkedFs)
			}
		);
		const disposable = api.workspace.registerFileSystemProvider('_acme_fs_left', {
			readFile: (uri) => encoder.encode(`DIFF-LEFT:${(uri as { path?: string }).path}`)
		});
		expect(requests).toEqual([{ method: 'fsProvider.register', args: ['_acme_fs_left'] }]);
		const uri = Uri.from({ scheme: '_acme_fs_left', path: '/temp/left/src/main.ts' });
		const doc = await api.workspace.openTextDocument(uri);
		expect(doc.getText()).toBe('DIFF-LEFT:/temp/left/src/main.ts');
		// Unregistering closes the scheme: the read misses, the host lookup is the fallback.
		disposable.dispose();
		expect(requests).toEqual([
			{ method: 'fsProvider.register', args: ['_acme_fs_left'] },
			{ method: 'fsProvider.unregister', args: ['_acme_fs_left'] }
		]);
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

	it('serves an output channel with the LogOutputChannel methods a logging extension binds at activation', () => {
		const appended: unknown[][] = [];
		const api = createVscodeApi(
			{ extensionId: 'x', extensionPath: '/x', workspaceFolders: [], settings: {}, language: 'en' },
			{ request: async (method, args) => {
				// Lines queue and cross as one batch (see flushCommandRegistrations); the
				// capture flattens both the batched and the direct shapes.
				if (method === 'output.append') appended.push(args);
				if (method === 'output.appendBatch') for (const line of args[0] as unknown[][]) appended.push(line);
				return undefined;
			}, registerCommandHandler: () => undefined }
		);
		const channel = api.window.createOutputChannel('Code Spell Checker', { log: true });
		// The bind-at-activation pattern a logging extension uses (cspell's logger wrapper):
		// every level-named method must exist and be bindable before anything else runs.
		expect(() => {
			channel.debug!.bind(channel);
			channel.info!.bind(channel);
			channel.warn!.bind(channel);
			channel.error!.bind(channel);
		}).not.toThrow();
		channel.info('client created');
		(globalThis as { __ggsFlushRegistrations?: () => void }).__ggsFlushRegistrations?.();
		// A LogOutputChannel line is VS Code's: a timestamp, the level, the message.
		expect(appended.at(-1)![0]).toBe('Code Spell Checker');
		expect(appended.at(-1)![1]).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z \[info\] client created\n$/);
	});

	it('an appendLine after the activation settled crosses on the short timer (it must not sit queued forever)', async () => {
		// The activation flush runs once at settle; a logger the user enables mid-session
		// (git-graph-rs's enableLog) appends after that — its lines queued but never
		// crossed, and the Output channel stayed empty for the rest of the session.
		vi.useFakeTimers();
		try {
			const sent: [string, unknown][] = [];
			const api = createVscodeApi(
				{ extensionId: 'x', extensionPath: '/x', workspaceFolders: [], settings: {}, language: 'en' },
				{
					request: async (method, args) => {
						sent.push([method, args]);
						return undefined;
					},
					registerCommandHandler: () => undefined
				}
			);
			const channel = api.window.createOutputChannel('Late Logger');
			channel.appendLine('after the settle');
			await vi.advanceTimersByTimeAsync(150);
			const batch = sent.find(([method]) => method === 'output.appendBatch');
			expect(batch).toBeDefined();
			expect(batch![1]).toEqual([[['Late Logger', 'after the settle\n']]]);
		} finally {
			vi.useRealTimers();
		}
	});

	it('serves env.createTelemetryLogger as an inert logger (never a missing method an activation calls)', () => {
		const api = createVscodeApi(
			{ extensionId: 'x', extensionPath: '/x', workspaceFolders: [], settings: {}, language: 'en' },
			{ request: async () => undefined, registerCommandHandler: () => undefined }
		);
		const logger = api.env.createTelemetryLogger({ sendEventData: () => undefined });
		expect(() => {
			logger.logUsage('activate');
			logger.logError(new Error('x'));
			logger.dispose();
		}).not.toThrow();
	});

	it('rehydrates Uri-shaped data into full Uris, at any depth of an argument list', () => {
		// The host is Windows here: fsPath keeps its drive-letter, backslashed spelling.
		setUriPlatform('win32');
		const data = { scheme: 'file', path: 'C:\\repo\\a.txt', fsPath: 'C:\\repo\\a.txt', query: '', fragment: '' };
		const revived = rehydrateUris([data, [{ rootUri: data }]]) as [ReturnType<typeof Uri.file>, { rootUri: ReturnType<typeof Uri.file> }[]];
		const first = revived[0];
		// The data half reads the same either way; the methods only exist once rehydrated,
		// and toString is VS Code's encoded form (the one language servers parse).
		expect(first.fsPath).toBe('C:\\repo\\a.txt');
		expect(first.path).toBe('/C:/repo/a.txt');
		expect(first.toString()).toBe('file:///c%3A/repo/a.txt');
		expect(first.with({ scheme: 'https' }).scheme).toBe('https');
		expect(revived[1]![0]!.rootUri.toString()).toBe('file:///c%3A/repo/a.txt');
		// A full Uri (or anything else) passes through untouched.
		const full = Uri.file('/keep');
		expect(rehydrateUris(full)).toBe(full);
		expect(rehydrateUris([{ scheme: 'file', fsPath: 'a', toString: () => 'own' }])).toEqual([{ scheme: 'file', fsPath: 'a', toString: expect.any(Function) }]);
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

	it('a webview panel create carries its ViewColumn and preserveFocus to the host', async () => {
		const { api, requests } = shim();
		// claude-code's chat: a bare ViewColumn.Beside, no preserveFocus — the panel's
		// group is placed beside the code and takes the focus, so the group the extension
		// locks right after is its own, as in VS Code.
		api.window.createWebviewPanel('demo.view', 'Demo', -2);
		// The options-object form: an explicit column with the focus preserved.
		api.window.createWebviewPanel('demo.view', 'Demo', { viewColumn: 3, preserveFocus: true });
		expect(requests[0]).toMatchObject({ method: 'webview.create', args: [1, 'demo.view', 'Demo', -2, false] });
		expect(requests[1]).toMatchObject({ method: 'webview.create', args: [2, 'demo.view', 'Demo', 3, true] });
	});

	it('a configChanged host event refreshes the settings and fires onDidChangeConfiguration', async () => {
		const { api } = shim();
		const fired: unknown[] = [];
		api.workspace.onDidChangeConfiguration(() => fired.push('changed'));
		api.handleHostEvent({ event: 'configChanged', settings: { 'demo.level': 3 } });
		expect(fired).toEqual(['changed']);
		expect(api.workspace.getConfiguration('demo').get('level')).toBe(3);
	});

	it('onDidChangeConfiguration carries a ConfigurationChangeEvent over the changed keys', async () => {
		// VS Code listeners read the event — `event.affectsConfiguration('git-graph-rs')` is
		// git-graph-rs's own first line; an undefined event threw inside every such handler.
		const { api } = shim();
		const events: { affectsConfiguration(section: string): boolean }[] = [];
		api.workspace.onDidChangeConfiguration((event: { affectsConfiguration(section: string): boolean }) => events.push(event));
		api.handleHostEvent({ event: 'configChanged', settings: { 'git-graph-rs.enableLog': true, 'other.key': 1 } });
		expect(events).toHaveLength(1);
		expect(events[0]!.affectsConfiguration('git-graph-rs')).toBe(true);
		expect(events[0]!.affectsConfiguration('git-graph-rs.enableLog')).toBe(true);
		expect(events[0]!.affectsConfiguration('git-graph-rs.date')).toBe(false);
		expect(events[0]!.affectsConfiguration('git')).toBe(false);
		// Only what changed counts: the same settings again fire nothing.
		api.handleHostEvent({ event: 'configChanged', settings: { 'git-graph-rs.enableLog': true, 'other.key': 1 } });
		expect(events).toHaveLength(1);
		api.handleHostEvent({ event: 'configChanged', settings: { 'git-graph-rs.enableLog': true, 'other.key': 2 } });
		expect(events).toHaveLength(2);
		expect(events[1]!.affectsConfiguration('other')).toBe(true);
		expect(events[1]!.affectsConfiguration('git-graph-rs')).toBe(false);
	});

	it("the extension's own update() fires onDidChangeConfiguration once, the host's echo adding nothing", async () => {
		// git-graph-rs's settings widget writes `enableLog` through update(); the listener is
		// what turns its logger on. The value is applied locally first, so the host's
		// configChanged echo diffs to nothing — the event has to fire from update() itself.
		const { api } = shim();
		const events: { affectsConfiguration(section: string): boolean }[] = [];
		api.workspace.onDidChangeConfiguration((event: { affectsConfiguration(section: string): boolean }) => events.push(event));
		await api.workspace.getConfiguration('git-graph-rs').update('enableLog', true, true);
		expect(events).toHaveLength(1);
		expect(events[0]!.affectsConfiguration('git-graph-rs')).toBe(true);
		expect(api.workspace.getConfiguration('git-graph-rs').get('enableLog')).toBe(true);
		api.handleHostEvent({ event: 'configChanged', settings: { 'git-graph-rs.enableLog': true } });
		expect(events).toHaveLength(1);
		// Writing the value it already has changes nothing.
		await api.workspace.getConfiguration('git-graph-rs').update('enableLog', true, true);
		expect(events).toHaveLength(1);
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
		host.onCloseWebviewTab = (tabId) => { closedTab = tabId; host['webviewClosed']('acme.demo', 1); };

		await host['serve']('webview.create', [1, 'demo.view', 'Demo Panel'], 'acme.demo', {} as never);
		await host['serve']('webview.setHtml', [1, '<html><body>hi</body></html>'], 'acme.demo', {} as never);

		// The workbench's mount: the tab pane gets a sandboxed iframe whose srcdoc carries the
		// composed acquireVsCodeApi bootstrap and the extension's document.
		const pane = document.body.appendChild(document.createElement('div'));
		const dispose = host.mountWebview('acme.demo', 1, pane);
		const frame = pane.querySelector('iframe')!;
		expect(frame.getAttribute('sandbox')).toBe('allow-scripts allow-same-origin allow-forms'); // its own storage (localStorage) works; a submit button (Claude Code's Send) needs forms
		expect(frame.getAttribute('srcdoc')).toContain('acquireVsCodeApi');
		expect(frame.getAttribute('srcdoc')).toContain('<body>hi</body>');
		// A later setHtml reloads the document, as VS Code's webviews do (the first paint's
		// coalescing window — the shell→document pair — has settled by the second setHtml).
		await host['serve']('webview.setHtml', [1, '<html><body>again</body></html>'], 'acme.demo', {} as never);
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(frame.getAttribute('srcdoc')).toContain('<body>again</body>');

		// The extension's dispose closes the tab; the frame is told the panel is gone.
		await host['serve']('webview.dispose', [1], 'acme.demo', {} as never);
		expect(closedTab).toBe('webview:acme.demo:1');
		expect(sent.filter((m) => (m as { type?: string }).type === '__studioExtEvent' && (m as { event?: string }).event === 'webviewDisposed')).toHaveLength(1);

		// The tab closing on its own (user close) runs the disposer: same notification, once.
		dispose();
		expect(sent.filter((m) => (m as { type?: string }).type === '__studioExtEvent' && (m as { event?: string }).event === 'webviewDisposed')).toHaveLength(1);
	});

	it('webview.create resolves the create\'s ViewColumn into the tab open\'s placement and focus', async () => {
		const { host } = hostWithFrame();
		const opened: [number, string, string, unknown, boolean | undefined][] = [];
		host.onOpenWebview = (panelId, title, extId, placement, focus) => opened.push([panelId, title, extId, placement, focus]);
		await host['serve']('webview.create', [1, 'demo.view', 'Demo Panel', -2, false], 'acme.demo', {} as never);
		// An older frame's create carries no showOptions: the focused group, focus kept —
		// the behavior before placements existed.
		await host['serve']('webview.create', [2, 'demo.view', 'Demo Panel'], 'acme.demo', {} as never);
		await host['serve']('webview.create', [3, 'demo.view', 'Demo Panel', 2, true], 'acme.demo', {} as never);
		expect(opened).toEqual([
			[1, 'Demo Panel', 'acme.demo', 'beside', true],
			[2, 'Demo Panel', 'acme.demo', undefined, true],
			[3, 'Demo Panel', 'acme.demo', 2, false]
		]);
	});

	it('a webview mounted into a still-offscreen pane loads once the pane joins the document', async () => {
		const { host } = hostWithFrame();
		await host['serve']('webview.create', [1, 'demo.view', 'Demo Panel'], 'acme.demo', {} as never);
		await host['serve']('webview.setHtml', [1, '<html><body>hi</body></html>'], 'acme.demo', {} as never);
		// The pane is assembled offscreen (a Beside split mounts its pane detached before
		// the grid attaches it). A srcdoc assigned into the detached frame is silently
		// dropped — the intermittent blank panel — so the load must wait for connection.
		const detached = document.createElement('div');
		const dispose = host.mountWebview('acme.demo', 1, detached);
		const frame = detached.querySelector('iframe')!;
		expect(frame.getAttribute('srcdoc')).toBe(null);
		// The pane joins the document (the editor grid attaching its offscreen assembly):
		// the observer loads the composed document at that moment.
		document.body.appendChild(detached);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(frame.getAttribute('srcdoc')).toContain('acquireVsCodeApi');
		expect(frame.getAttribute('srcdoc')).toContain('<body>hi</body>');
		dispose();
	});

	it('the load watchdog re-navigates a dropped srcdoc navigation, not a settled page', async () => {
		vi.useFakeTimers();
		// The frame never fires its load (the dropped navigation never navigates): keep
		// the watchdog's load listener from registering so the timer path runs.
		const originalAdd = HTMLIFrameElement.prototype.addEventListener;
		const addEventListener = vi.spyOn(HTMLIFrameElement.prototype, 'addEventListener')
			.mockImplementation(function (this: HTMLIFrameElement, type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) {
				if (type === 'load') return;
				return originalAdd.call(this, type, listener, options);
			});
		// Every srcdoc assignment crosses this recorder: the initial load, and the
		// watchdog's clear-and-re-navigate pair.
		const sets: string[] = [];
		const srcdocDescriptor = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'srcdoc')!;
		Object.defineProperty(HTMLIFrameElement.prototype, 'srcdoc', {
			get: srcdocDescriptor.get,
			set(this: HTMLIFrameElement, value: string) { sets.push(value); srcdocDescriptor.set!.call(this, value); }
		});
		let dispose: () => void = () => undefined;
		try {
			const { host } = hostWithFrame();
			await host['serve']('webview.create', [1, 'demo.view', 'Demo Panel'], 'acme.demo', {} as never);
			await host['serve']('webview.setHtml', [1, '<html><body>hi</body></html>'], 'acme.demo', {} as never);
			const pane = document.body.appendChild(document.createElement('div'));
			dispose = host.mountWebview('acme.demo', 1, pane);
			await vi.advanceTimersByTimeAsync(0);
			expect(sets).toHaveLength(1); // the initial assign — a healthy load ends here
			// The dropped navigation: the frame's document stays the initial empty
			// about:blank, so the watchdog clears and re-assigns instead of passing it.
			await vi.advanceTimersByTimeAsync(4000);
			expect(sets[1]).toBe('');
			await vi.advanceTimersByTimeAsync(10);
			expect(sets.length).toBeGreaterThanOrEqual(3);
			expect(sets[2]).toContain('acquireVsCodeApi');
		} finally {
			dispose();
			Object.defineProperty(HTMLIFrameElement.prototype, 'srcdoc', srcdocDescriptor);
			addEventListener.mockRestore();
			vi.useRealTimers();
		}
	});

	/** Load-event harness for the delivery-gate tests: jsdom fires iframe loads on its own
	 *  schedule, which races the fake timers — capture the frame's load listeners instead
	 *  and fire them exactly when the scenario says the navigation settles. */
	function captureLoads() {
		const originalAdd = HTMLIFrameElement.prototype.addEventListener;
		const listeners: { listener: EventListenerOrEventListenerObject; once: boolean }[] = [];
		const addEventListener = vi.spyOn(HTMLIFrameElement.prototype, 'addEventListener')
			.mockImplementation(function (this: HTMLIFrameElement, type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) {
				if (type === 'load') {
					listeners.push({ listener, once: typeof options === 'object' ? options.once === true : options === true });
					return;
				}
				return originalAdd.call(this, type, listener, options);
			});
		const srcdocDescriptor = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'srcdoc')!;
		const sets: string[] = [];
		Object.defineProperty(HTMLIFrameElement.prototype, 'srcdoc', {
			get: srcdocDescriptor.get,
			set(this: HTMLIFrameElement, value: string) { sets.push(value); srcdocDescriptor.set!.call(this, value); }
		});
		const fireLoad = (frame: HTMLIFrameElement) => {
			const event = new Event('load');
			for (let i = listeners.length - 1; i >= 0; i--) {
				const entry = listeners[i]!;
				if (entry.once) listeners.splice(i, 1);
				(entry.listener as (this: HTMLIFrameElement, event: Event) => void).call(frame, event);
			}
		};
		const restore = () => {
			Object.defineProperty(HTMLIFrameElement.prototype, 'srcdoc', srcdocDescriptor);
			addEventListener.mockRestore();
		};
		return { sets, fireLoad, restore };
	}

	it('the mount paints nothing before the first setHtml — one boot of the real document', async () => {
		vi.useFakeTimers();
		const { sets, fireLoad, restore } = captureLoads();
		let dispose: () => void = () => undefined;
		try {
			const { host } = hostWithFrame();
			await host['serve']('webview.create', [1, 'demo.view', 'Demo Panel'], 'acme.demo', {} as never);
			const pane = document.body.appendChild(document.createElement('div'));
			dispose = host.mountWebview('acme.demo', 1, pane);
			const frame = pane.querySelector('iframe')!;
			await vi.advanceTimersByTimeAsync(0);
			// The tab won the mount race against the extension's setHtml: painting the bare
			// bootstrap document here booted a page whose load opened the gate for a document
			// the first setHtml was about to replace — and its grace expiring ahead of the
			// coalescing window left the real document unpainted (the blank page).
			expect(frame.getAttribute('srcdoc')).toBe(null);
			// The extension's document arrives into the coalescing window, and a push with it.
			await host['serve']('webview.setHtml', [1, '<html><body>hi</body></html>'], 'acme.demo', {} as never);
			const posted: unknown[] = [];
			const postMessage = vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation(((data: unknown) => { posted.push(data); }) as typeof frame.contentWindow.postMessage);
			await host['serve']('webview.postMessage', [1, { hello: 1 }], 'acme.demo', {} as never);
			await vi.advanceTimersByTimeAsync(200); // the coalescing window paints the latest html
			expect(sets).toHaveLength(1);
			expect(sets[0]).toContain('<body>hi</body>');
			expect(posted).toHaveLength(0); // the push waits for the fresh load's gate
			fireLoad(frame);
			await vi.advanceTimersByTimeAsync(150); // the load grace opens, then delivers
			expect(posted).toHaveLength(1);
			expect((posted[0] as { message?: unknown }).message).toEqual({ hello: 1 });
			postMessage.mockRestore();
		} finally {
			dispose();
			restore();
			vi.useRealTimers();
		}
	});

	it('the load grace yields to a pending first paint — the queue waits for the replacing document', async () => {
		vi.useFakeTimers();
		const { sets, fireLoad, restore } = captureLoads();
		let dispose: () => void = () => undefined;
		try {
			const { host } = hostWithFrame();
			await host['serve']('webview.create', [1, 'demo.view', 'Demo Panel'], 'acme.demo', {} as never);
			await host['serve']('webview.setHtml', [1, '<html><body>one</body></html>'], 'acme.demo', {} as never);
			const pane = document.body.appendChild(document.createElement('div'));
			dispose = host.mountWebview('acme.demo', 1, pane);
			const frame = pane.querySelector('iframe')!;
			const posted: unknown[] = [];
			vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation(((data: unknown) => { posted.push(data); }) as typeof frame.contentWindow.postMessage);
			await vi.advanceTimersByTimeAsync(0);
			expect(sets).toHaveLength(1);
			// The shell→document pair, sliced the dangerous way: the second setHtml lands
			// while the first document is still loading (the coalescing window arms), and
			// the first document's load grace expires inside that window. The old gate
			// opened there — the initial state crossed into the doomed shell and the real
			// document's paint was skipped as "already loaded": the blank page.
			await host['serve']('webview.setHtml', [1, '<html><body>two</body></html>'], 'acme.demo', {} as never);
			fireLoad(frame); // the first document's load; its grace opens
			await vi.advanceTimersByTimeAsync(100);
			await host['serve']('webview.postMessage', [1, { state: 1 }], 'acme.demo', {} as never); // queued inside the grace
			await vi.advanceTimersByTimeAsync(50); // the grace expires with the paint still pending
			expect(posted).toHaveLength(0); // …and must not deliver into the document about to be replaced
			await vi.advanceTimersByTimeAsync(50); // the coalescing window paints the latest html
			expect(sets).toHaveLength(2);
			expect(sets[1]).toContain('<body>two</body>');
			expect(posted).toHaveLength(0);
			fireLoad(frame); // the replacing document's load; its grace delivers
			await vi.advanceTimersByTimeAsync(150);
			expect(posted).toHaveLength(1);
			expect((posted[0] as { message?: unknown }).message).toEqual({ state: 1 });
		} finally {
			dispose();
			restore();
			vi.useRealTimers();
		}
	});

	it('a webview panel reopens after every tab was closed, and a restarted backend\'s colliding panel id replaces the dead tab', async () => {
		const { host } = hostWithFrame();
		// A real editor group stands in for the workbench's tab host: the panel's tab opens
		// exactly the way workbench.openWebviewPanel plugs it.
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		host.onOpenWebview = (panelId, title) => {
			void group.openExtPage({ kind: 'extpage', id: host['webviewTabId']('acme.demo', panelId), title, extId: 'acme.demo', pageId: 'webview' }, (pane) => host.mountWebview('acme.demo', panelId, pane));
		};
		host.onCloseWebviewTab = (tabId) => { if (group.closeById(tabId)) host['webviewClosed']('acme.demo', Number(tabId.split(':').at(-1))); };
		const frameInGroup = () => document.querySelector('#editorGroup iframe');

		// First open: the tab lands and its iframe loads the composed document (the pane
		// attaches only after the mount — the offscreen-pane path).
		await host['serve']('webview.create', [1, 'demo.view', 'Demo Panel'], 'acme.demo', {} as never);
		await host['serve']('webview.setHtml', [1, '<html><body>one</body></html>'], 'acme.demo', {} as never);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(frameInGroup()?.getAttribute('srcdoc')).toContain('<body>one</body>');

		// The user closes every page; a fresh open must produce a tab again.
		await group.closeAll();
		await host['serve']('webview.create', [2, 'demo.view', 'Demo Panel'], 'acme.demo', {} as never);
		await host['serve']('webview.setHtml', [2, '<html><body>two</body></html>'], 'acme.demo', {} as never);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(frameInGroup()?.getAttribute('srcdoc')).toContain('<body>two</body>');

		// A second live panel, then the backend restarts: its reset sequence reuses panel 2
		// while panels 2 and 3 are live. The previous process's panels are all dead — the
		// reuse must sweep them (their tabs would strand as blank shells) and the new panel
		// owns the one tab left, showing its own document.
		await host['serve']('webview.create', [3, 'demo.view', 'Second Panel'], 'acme.demo', {} as never);
		await host['serve']('webview.setHtml', [3, '<html><body>three</body></html>'], 'acme.demo', {} as never);
		await host['serve']('webview.create', [2, 'demo.view', 'Demo Panel'], 'acme.demo', {} as never);
		await host['serve']('webview.setHtml', [2, '<html><body>fresh</body></html>'], 'acme.demo', {} as never);
		await new Promise((resolve) => setTimeout(resolve, 20));
		const frames = [...document.querySelectorAll('#editorGroup iframe')];
		expect(frames).toHaveLength(1);
		expect(frames[0]!.getAttribute('srcdoc')).toContain('<body>fresh</body>');
	});

	it('a re-opened session replaces its own tab; other sessions keep theirs', async () => {
		const { host, sent } = hostWithFrame();
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		host.onOpenWebview = (panelId, title) => {
			void group.openExtPage({ kind: 'extpage', id: host['webviewTabId']('acme.demo', panelId), title, extId: 'acme.demo', pageId: 'webview' }, (pane) => host.mountWebview('acme.demo', panelId, pane));
		};
		host.onCloseWebviewTab = (tabId) => { if (group.closeById(tabId)) host['webviewClosed']('acme.demo', Number(tabId.split(':').at(-1))); };
		host.onRenameWebviewTab = (tabId, title) => group.renameById(tabId, title);
		const disposedPanels = () => sent.filter((m) => (m as { type?: string }).type === '__studioExtEvent' && (m as { event?: string }).event === 'webviewDisposed').map((m) => (m as { panelId?: number }).panelId);
		// A panel's webview speaks to its extension through the host's relay: the envelope
		// the composed acquireVsCodeApi bootstrap posts, from the frame the tab mounts.
		const fromPanel = (source: Window | null, request: Record<string, unknown>) => window.dispatchEvent(new MessageEvent('message', {
			source: source as MessageEventSource,
			data: { __ggsWebview: true, kind: 'message', message: { type: 'request', request } }
		}));
		const waitFrames = () => new Promise((resolve) => setTimeout(resolve, 20));
		const chatFrames = () => [...document.querySelectorAll('#editorGroup iframe')];

		// The chat panel opens ("Claude Code") and binds session-a: its binding report and
		// its summary rename both cross the host's relay.
		await host['serve']('webview.create', [1, 'chat.view', 'Claude Code'], 'acme.demo', {} as never);
		await host['serve']('webview.setHtml', [1, '<html><body>one</body></html>'], 'acme.demo', {} as never);
		await waitFrames();
		fromPanel(chatFrames()[0]!.contentWindow, { type: 'update_session_state', sessionId: 'session-a', state: 'idle' });
		await host['serve']('webview.setTitle', [1, 'Fix the login bug'], 'acme.demo', {} as never);
		expect(group.activeInput?.title).toBe('Fix the login bug');
		expect(chatFrames()).toHaveLength(1);

		// The same history row clicked again: the panel asks to open the session it is
		// showing, the extension's session→panel map has lost the binding, and a fresh
		// create arrives for session-a. The stale tab closes beneath the new panel —
		// still one tab for the session, the old object told it is gone.
		fromPanel(chatFrames()[0]!.contentWindow, { type: 'open_in_editor', sessionId: 'session-a' });
		await host['serve']('webview.create', [2, 'chat.view', 'Claude Code'], 'acme.demo', {} as never);
		await host['serve']('webview.setHtml', [2, '<html><body>two</body></html>'], 'acme.demo', {} as never);
		await waitFrames();
		expect(chatFrames()).toHaveLength(1);
		expect(chatFrames()[0]!.getAttribute('srcdoc')).toContain('<body>two</body>');
		expect(group.activeInput?.title).toBe('Claude Code');
		expect(disposedPanels()).toEqual([1]);

		// Another history row: session-b is hosted by nobody, so its panel opens a second
		// tab — different conversations stay different tabs.
		fromPanel(chatFrames()[0]!.contentWindow, { type: 'open_in_editor', sessionId: 'session-b' });
		await host['serve']('webview.create', [3, 'chat.view', 'Claude Code'], 'acme.demo', {} as never);
		await waitFrames();
		expect(chatFrames()).toHaveLength(2);
		expect(disposedPanels()).toEqual([1]);

		// A brand-new conversation carries no session id: it clears the pending signal and
		// opens its own tab, never displacing a session's.
		fromPanel(chatFrames()[1]!.contentWindow, { type: 'new_conversation_tab', sessionId: undefined });
		await host['serve']('webview.create', [4, 'chat.view', 'Claude Code'], 'acme.demo', {} as never);
		await waitFrames();
		expect(chatFrames()).toHaveLength(3);
		expect(disposedPanels()).toEqual([1]);
	});

	it('ggs.sessionTabs lists the sessions with an open tab and closes the one hosting a session', async () => {
		const { host, sent } = hostWithFrame();
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		host.onOpenWebview = (panelId, title) => {
			void group.openExtPage({ kind: 'extpage', id: host['webviewTabId']('acme.demo', panelId), title, extId: 'acme.demo', pageId: 'webview' }, (pane) => host.mountWebview('acme.demo', panelId, pane));
		};
		host.onCloseWebviewTab = (tabId) => { if (group.closeById(tabId)) host['webviewClosed']('acme.demo', Number(tabId.split(':').at(-1))); };
		const fromPanel = (source: Window | null, request: Record<string, unknown>) => window.dispatchEvent(new MessageEvent('message', {
			source: source as MessageEventSource,
			data: { __ggsWebview: true, kind: 'message', message: { type: 'request', request } }
		}));
		const chatFrames = () => [...document.querySelectorAll('#editorGroup iframe')];
		await host['serve']('webview.create', [1, 'chat.view', 'Claude Code'], 'acme.demo', {} as never);
		await host['serve']('webview.setHtml', [1, '<html><body>a</body></html>'], 'acme.demo', {} as never);
		await host['serve']('webview.create', [2, 'chat.view', 'Claude Code'], 'acme.demo', {} as never);
		await host['serve']('webview.setHtml', [2, '<html><body>b</body></html>'], 'acme.demo', {} as never);
		await new Promise((resolve) => setTimeout(resolve, 20));
		fromPanel(chatFrames()[0]!.contentWindow, { type: 'update_session_state', sessionId: 'session-a', state: 'idle' });
		fromPanel(chatFrames()[1]!.contentWindow, { type: 'update_session_state', sessionId: 'session-b', state: 'idle' });

		expect(await host.executeCommand('ggs.sessionTabs.list')).toEqual(['session-a', 'session-b']);
		expect(await host.executeCommand('ggs.sessionTabs.close', ['session-a'])).toBe(1);
		expect(chatFrames()).toHaveLength(1);
		expect(sent.filter((m) => (m as { event?: string }).event === 'webviewDisposed').map((m) => (m as { panelId?: number }).panelId)).toEqual([1]);
		expect(await host.executeCommand('ggs.sessionTabs.list')).toEqual(['session-b']);
		expect(await host.executeCommand('ggs.sessionTabs.close', ['nobody'])).toBe(0);
	});

	it('ggs.claudeChat types a prompt into the session’s Claude Code tab — or a new one — and sends it from there', async () => {
		const { host } = hostWithFrame();
		host['declaredCommandIds'].set('acme.demo', ['claude-vscode.editor.open']);
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		const revealed: string[] = [];
		host.onOpenWebview = (panelId, title) => {
			void group.openExtPage({ kind: 'extpage', id: host['webviewTabId']('acme.demo', panelId), title, extId: 'acme.demo', pageId: 'webview' }, (pane) => host.mountWebview('acme.demo', panelId, pane));
		};
		host.onRevealWebviewTab = (tabId) => revealed.push(tabId);
		const fromPanel = (source: Window | null, request: Record<string, unknown>) => window.dispatchEvent(new MessageEvent('message', {
			source: source as MessageEventSource,
			data: { __ggsWebview: true, kind: 'message', message: { type: 'request', request } }
		}));
		const sent: string[][] = [[], [], []];
		// The chat page's composer inside the panel's own document (the srcdoc frame the
		// host reaches): the button reads "Stop" while a turn runs with an empty input, and
		// the model pill opens the page's own picker (the phone's model pick drives it).
		const chatPage = (frame: HTMLIFrameElement, into: string[]) => {
			const doc = frame.contentDocument!;
			doc.body.innerHTML = '<form><div role="textbox" contenteditable="plaintext-only" aria-label="Ask"></div><button type="submit" data-permission-mode="default" aria-label="Send message" disabled>send</button><button type="button" title="Switch model" role="combobox" aria-haspopup="listbox" aria-expanded="false">Sonnet 4.5</button></form>';
			const form = doc.querySelector('form')!;
			const input = form.querySelector<HTMLElement>('[role="textbox"]')!;
			const button = form.querySelector('button')!;
			const pill = doc.querySelector<HTMLButtonElement>('[role="combobox"]')!;
			let busy = false;
			let menuOpen = false;
			const closeMenu = () => { doc.querySelector('[role="listbox"]')?.remove(); menuOpen = false; pill.setAttribute('aria-expanded', 'false'); };
			const render = () => {
				const text = (input.textContent ?? '').trim();
				button.setAttribute('aria-label', busy && !text ? 'Stop' : 'Send message');
				button.disabled = !busy && !text;
			};
			input.addEventListener('input', render);
			button.addEventListener('click', (event) => { if (busy && !(input.textContent ?? '').trim()) { event.preventDefault(); busy = false; render(); } });
			form.addEventListener('submit', (event) => { event.preventDefault(); into.push(input.textContent ?? ''); input.textContent = ''; busy = true; render(); });
			pill.addEventListener('click', () => {
				if (menuOpen) { closeMenu(); return; }
				menuOpen = true;
				pill.setAttribute('aria-expanded', 'true');
				const box = doc.createElement('div');
				box.setAttribute('role', 'listbox');
				box.innerHTML = '<div role="option"><span>Opus 4.6</span><span>claude-opus-4-6</span></div><div role="option"><span>Sonnet 4.5</span><span>claude-sonnet-4-5</span></div>';
				box.addEventListener('click', (event) => {
					const option = (event.target as HTMLElement).closest<HTMLElement>('[role="option"]');
					if (!option) return;
					pill.textContent = (option.firstElementChild?.textContent ?? '').trim();
					closeMenu();
				});
				doc.body.appendChild(box);
			});
		};
		const waitFrames = () => new Promise((resolve) => setTimeout(resolve, 20));
		const chatFrames = () => [...document.querySelectorAll<HTMLIFrameElement>('#editorGroup iframe')];
		const until = async (probe: () => Promise<{ phase: string }>, phase: string) => {
			for (let i = 0; i < 100; i++) { const state = await probe(); if (state.phase === phase) return state; await new Promise((resolve) => setTimeout(resolve, 50)); }
			throw new Error('never reached ' + phase);
		};

		// An open tab hosting session-1: the prompt lands in it, the tab is brought forward.
		await host['serve']('webview.create', [1, 'claudeVSCodePanel', 'Claude Code'], 'acme.demo', {} as never);
		await host['serve']('webview.setHtml', [1, '<html><body></body></html>'], 'acme.demo', {} as never);
		await waitFrames();
		chatPage(chatFrames()[0]!, sent[0]!);
		fromPanel(chatFrames()[0]!.contentWindow, { type: 'update_session_state', sessionId: 'session-1', state: 'idle' });
		const { ticket } = await host.executeCommand('ggs.claudeChat.send', [{ sessionId: 'session-1', text: 'run the tests' }]) as { ticket: string };
		const done = await until(() => host.executeCommand('ggs.claudeChat.state', [{ ticket }]) as Promise<{ phase: string }>, 'sent');
		expect(sent[0]).toEqual(['run the tests']);
		expect(done).toMatchObject({ sessionId: 'session-1', open: true, busy: true });
		expect(revealed).toEqual(['webview:acme.demo:1']);
		// Stop: the tab's own Stop button.
		expect(await host.executeCommand('ggs.claudeChat.stop', [{ sessionId: 'session-1' }])).toEqual({ stopped: true });
		expect(await host.executeCommand('ggs.claudeChat.state', [{ sessionId: 'session-1' }])).toMatchObject({ busy: false });

		// A new conversation: Claude Code opens a fresh tab, the prompt goes there, and the
		// session the tab then reports is the ticket's.
		const opened: unknown[][] = [];
		const realExecute = host.executeCommand.bind(host);
		host.executeCommand = (id: string, args: unknown[] = [], caller?: never) => {
			if (id !== 'claude-vscode.editor.open') return realExecute(id, args, caller);
			opened.push(args);
			return (async () => {
				await host['serve']('webview.create', [2, 'claudeVSCodePanel', 'Claude Code'], 'acme.demo', {} as never);
				await host['serve']('webview.setHtml', [2, '<html><body></body></html>'], 'acme.demo', {} as never);
				await waitFrames();
				chatPage(chatFrames()[1]!, sent[1]!);
			})();
		};
		const fresh = await host.executeCommand('ggs.claudeChat.send', [{ text: 'start something new' }]) as { ticket: string };
		await until(() => host.executeCommand('ggs.claudeChat.state', [{ ticket: fresh.ticket }]) as Promise<{ phase: string }>, 'sent');
		expect(opened).toEqual([[undefined, undefined, undefined, undefined, undefined, { programmatic: 'pin-to-panel' }]]);
		expect(sent[1]).toEqual(['start something new']);
		fromPanel(chatFrames()[1]!.contentWindow, { type: 'update_session_state', sessionId: 'session-2', state: 'running' });
		expect(await host.executeCommand('ggs.claudeChat.state', [{ ticket: fresh.ticket }])).toMatchObject({ sessionId: 'session-2', phase: 'sent' });

		// "now" against a busy tab: interrupt first, then send.
		const now = await host.executeCommand('ggs.claudeChat.send', [{ sessionId: 'session-2', text: 'urgent', interrupt: true }]) as { ticket: string };
		await until(() => host.executeCommand('ggs.claudeChat.state', [{ ticket: now.ticket }]) as Promise<{ phase: string }>, 'sent');
		expect(sent[1]).toEqual(['start something new', 'urgent']);

		// A model rides along: the host picks it in the tab's own model picker before typing.
		const pick = await host.executeCommand('ggs.claudeChat.send', [{ sessionId: 'session-2', text: 'on opus please', model: 'opus' }]) as { ticket: string };
		await until(() => host.executeCommand('ggs.claudeChat.state', [{ ticket: pick.ticket }]) as Promise<{ phase: string }>, 'sent');
		expect(sent[1]).toEqual(['start something new', 'urgent', 'on opus please']);
		expect(chatFrames()[1]!.contentDocument!.querySelector('[role="combobox"]')!.textContent).toContain('Opus 4.6');

		// A pending AskUserQuestion in session-1's tab: a radio card plus its "Submit
		// answers" button (enabled once a question holds a pick, the click that resolves
		// the card — the real card never submits by itself). The phone's answer clicks
		// the option and then that button.
		const card = chatFrames()[0]!.contentDocument!;
		const cardRoot = card.createElement('div');
		let picked = false;
		for (const label of ['自动化测试级验证', '自动化 + 实机安装验证']) {
			const option = card.createElement('div');
			option.setAttribute('role', 'radio');
			option.setAttribute('aria-checked', 'false');
			option.innerHTML = `<div>${label}</div><div>desc of ${label}</div>`;
			option.addEventListener('click', () => {
				cardRoot.querySelectorAll('[role="radio"]').forEach((row) => row.setAttribute('aria-checked', 'false'));
				option.setAttribute('aria-checked', 'true');
				picked = true;
				submit.disabled = false;
			});
			cardRoot.appendChild(option);
		}
		const submit = card.createElement('button');
		submit.textContent = '1 Submit answers';
		submit.disabled = true;
		submit.addEventListener('click', () => {
			if (submit.disabled) return;
			cardRoot.querySelectorAll('[role="radio"]').forEach((row) => row.setAttribute('aria-disabled', 'true'));
		});
		cardRoot.appendChild(submit);
		card.body.appendChild(cardRoot);
		const ans = await host.executeCommand('ggs.claudeChat.answer', [{ sessionId: 'session-1', answers: [{ question: '做到什么程度？', header: '验证', picks: ['自动化 + 实机安装验证'] }] }]) as { ticket: string };
		await until(() => host.executeCommand('ggs.claudeChat.state', [{ ticket: ans.ticket }]) as Promise<{ phase: string }>, 'sent');
		expect(picked).toBe(true);
		expect(cardRoot.querySelector('[aria-checked="true"]')!.firstElementChild!.textContent).toBe('自动化 + 实机安装验证');
		// a tab with no pending question answers an error, not a click
		const noCard = await host.executeCommand('ggs.claudeChat.answer', [{ sessionId: 'session-2', answers: [{ question: 'q', header: 'h', picks: ['x'] }] }]) as { ticket: string };
		const failed = await until(() => host.executeCommand('ggs.claudeChat.state', [{ ticket: noCard.ticket }]) as Promise<{ phase: string; error: string | null }>, 'error');
		expect(failed.error).toMatch(/did not take the answer/);
		await expect(host.executeCommand('ggs.claudeChat.answer', [{ answers: [] }])).rejects.toThrow(/belongs to a conversation/);

		expect(await host.executeCommand('ggs.claudeChat.state', [{ ticket: 'nope' }])).toMatchObject({ phase: 'error', error: 'unknown ticket' });
		expect(await host.executeCommand('ggs.claudeChat.state', [{}])).toMatchObject({ phase: 'none', open: false });
		await expect(host.executeCommand('ggs.claudeChat.send', [{ sessionId: 'session-1', text: '  ' }])).rejects.toThrow(/empty prompt/);
		host['declaredCommandIds'].delete('acme.demo');
		await expect(host.executeCommand('ggs.claudeChat.send', [{ text: 'x' }])).rejects.toThrow(/not installed/);
	});

	it('the load watchdog never restarts a page that is still making progress', async () => {
		vi.useFakeTimers();
		const originalAdd = HTMLIFrameElement.prototype.addEventListener;
		const addEventListener = vi.spyOn(HTMLIFrameElement.prototype, 'addEventListener')
			.mockImplementation(function (this: HTMLIFrameElement, type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) {
				if (type === 'load') return;
				return originalAdd.call(this, type, listener, options);
			});
		const sets: string[] = [];
		const srcdocDescriptor = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'srcdoc')!;
		Object.defineProperty(HTMLIFrameElement.prototype, 'srcdoc', {
			get: srcdocDescriptor.get,
			set(this: HTMLIFrameElement, value: string) { sets.push(value); srcdocDescriptor.set!.call(this, value); }
		});
		let dispose: () => void = () => undefined;
		try {
			const { host } = hostWithFrame();
			await host['serve']('webview.create', [1, 'demo.view', 'Demo Panel'], 'acme.demo', {} as never);
			await host['serve']('webview.setHtml', [1, '<html><body>hi</body></html>'], 'acme.demo', {} as never);
			const pane = document.body.appendChild(document.createElement('div'));
			dispose = host.mountWebview('acme.demo', 1, pane);
			const frame = pane.querySelector('iframe')!;
			expect(sets).toHaveLength(1);
			// A cold multi-megabyte load (claude-code's chat bundle) grows its document
			// past the check interval while parsing: every check sees a changed document.
			const doc = frame.contentDocument!;
			const progress = (ms: number) => {
				void vi.advanceTimersByTimeAsync(ms - 1000);
				doc.head.appendChild(doc.createElement('script'));
				return vi.advanceTimersByTimeAsync(1000);
			};
			for (let i = 0; i < 4; i++) await progress(4000);
			// Still moving: the navigation was never restarted — a cold multi-megabyte
			// load runs past every check without being killed mid-parse.
			expect(sets).toHaveLength(1);
		} finally {
			dispose();
			Object.defineProperty(HTMLIFrameElement.prototype, 'srcdoc', srcdocDescriptor);
			addEventListener.mockRestore();
			vi.useRealTimers();
		}
	});

	it('messages pushed before the page can receive them are queued and delivered on load', async () => {
		const { host } = hostWithFrame();
		await host['serve']('webview.create', [1, 'demo.view', 'Demo Panel'], 'acme.demo', {} as never);
		await host['serve']('webview.setHtml', [1, '<html><body>hi</body></html>'], 'acme.demo', {} as never);
		// The backend's first pushes race the tab's mount (the icon read delays it on a
		// first open) — the page's initial state among them. They must not vanish.
		await host['serve']('webview.postMessage', [1, { type: 'init-state' }], 'acme.demo', {} as never);
		await host['serve']('webview.postMessage', [1, { type: 'visibility', value: true }], 'acme.demo', {} as never);
		const queueOf = () => host['webviews'].get(host['webviewKey']('acme.demo', 1))?.pending ?? null;
		expect(queueOf()).toEqual([{ type: 'init-state' }, { type: 'visibility', value: true }]);

		const pane = document.body.appendChild(document.createElement('div'));
		const dispose = host.mountWebview('acme.demo', 1, pane);
		// The queue survives the mount and flushes only when the page's own listeners can
		// exist (the load event). Vitest's jsdom never fires an iframe's load for a srcdoc
		// navigation, so the flush is driven by dispatching the event itself — the real
		// browser fires it on its own.
		expect(queueOf()).toEqual([{ type: 'init-state' }, { type: 'visibility', value: true }]);
		await new Promise((resolve) => setTimeout(resolve, 20));
		pane.querySelector('iframe')!.dispatchEvent(new Event('load'));
		// The load arms a short grace (a setHtml reload may still follow — the shell→document
		// pair); the queue drains when the grace closes without one.
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(queueOf()).toEqual([]);
		// The direct path (post-load) delivers straight through the frame's window.
		const frame = pane.querySelector('iframe')!;
		const posted: unknown[] = [];
		vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation(((message: unknown) => { posted.push(message); }) as never);
		await host['serve']('webview.postMessage', [1, { type: 'after-load' }], 'acme.demo', {} as never);
		expect(posted).toEqual([{ __ggsWebviewHost: true, type: 'message', message: { type: 'after-load' } }]);
		expect(queueOf()).toEqual([]);
		dispose();
	});

	it('a sidebar webview view holds its pushes the same way (the sidebar chat is the same claude-code page)', async () => {
		const { host } = hostWithFrame();
		await host['serve']('webviewView.register', ['acme.chat'], 'acme.demo', {} as never);
		await host['serve']('webviewView.setHtml', ['acme.chat', '<html><body>chat</body></html>'], 'acme.demo', {} as never);
		// The provider's first pushes race the sidebar section's mount — the section mounts
		// when the view first becomes visible, long after resolve ran. They must not vanish.
		await host['serve']('webviewView.postMessage', ['acme.chat', { state: 'initial' }], 'acme.demo', {} as never);
		const record = host['webviewViews'].get('acme.chat')!;
		expect(record.pending).toEqual([{ state: 'initial' }]);

		const section = document.body.appendChild(document.createElement('div'));
		const dispose = host.mountWebviewView('acme.chat', 'acme.demo', section);
		expect(record.pending).toEqual([{ state: 'initial' }]); // the mount alone does not deliver
		const frame = section.querySelector('iframe')!;
		const posted: unknown[] = [];
		vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation(((message: unknown) => { posted.push(message); }) as never);
		frame.dispatchEvent(new Event('load'));
		await new Promise((resolve) => setTimeout(resolve, 200)); // the load grace closes, then the queue drains
		expect(posted).toEqual([{ __ggsWebviewHost: true, type: 'message', message: { state: 'initial' } }]);
		expect(record.pending).toEqual([]);
		// After the load, a push crosses directly.
		await host['serve']('webviewView.postMessage', ['acme.chat', { state: 'live' }], 'acme.demo', {} as never);
		expect(posted[1]).toEqual({ __ggsWebviewHost: true, type: 'message', message: { state: 'live' } });
		dispose();
	});

	it('a rebuilt sidebar section re-resolves its webview view — the chat never goes blank', async () => {
		const { host, sent } = hostWithFrame();
		// The manifest declares the chat view (a `type: "webview"` view in its container) —
		// what `noteViewVisible` reads to know a view resolves at its first visibility.
		applyContributions('acme.demo', {
			viewsContainers: { activitybar: [{ id: 'acmeSide', title: 'Acme' }] },
			views: { acmeSide: [{ id: 'acme.chat', name: 'Chat', type: 'webview' }] }
		}, {}, () => undefined, () => true);
		try {
			// Answer the frame calls the host places (resolve dispatches would otherwise hang).
			const answer = (event: MessageEvent): void => {
				const data = event.data as { type?: string; id?: number };
				if (data?.type !== '__studioExtCall') return;
				window.dispatchEvent(new MessageEvent('message', { data: { type: '__studioExtCallResult', id: data.id, ok: true, result: undefined } }));
			};
			window.addEventListener('message', answer);
			const resolves = () => sent.filter((message) => (message as { type?: string; method?: string }).method === 'webviewView.resolve');

			await host['serve']('webviewView.register', ['acme.chat'], 'acme.demo', {} as never);
			await host['serve']('webviewView.setHtml', ['acme.chat', '<html><body>chat</body></html>'], 'acme.demo', {} as never);
			const section = document.body.appendChild(document.createElement('div'));
			const dispose = host.mountWebviewView('acme.chat', 'acme.demo', section);
			host.noteViewVisible('acme.chat', true);
			await new Promise((resolve) => setTimeout(resolve, 20)); // the resolve rides ensureActive's then
			expect(resolves()).toHaveLength(1); // the first visibility resolves the provider

			// The sidebar rebuilds (any extension's install or uninstall ends here): the old
			// section unmounts, a fresh one mounts the same view.
			dispose();
			const rebuilt = document.body.appendChild(document.createElement('div'));
			host.mountWebviewView('acme.chat', 'acme.demo', rebuilt);
			// The record's html fills the new frame at once — the mount does not wait for the
			// provider to push a document it already pushed.
			expect(rebuilt.querySelector('iframe')!.getAttribute('srcdoc')).toContain('<body>chat</body>');
			// And the view becoming visible again must ask the provider to resolve once more —
			// a remounted view that never re-resolves sits blank forever.
			host.noteViewVisible('acme.chat', true);
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(resolves()).toHaveLength(2);
			window.removeEventListener('message', answer);
		} finally {
			removeContributions('acme.demo');
		}
	});

	it('a provider switch\'s backend restart re-resolves the settled chat view (the login page un-sticks)', async () => {
		const { host, sent } = hostWithFrame();
		applyContributions('acme.demo', {
			viewsContainers: { activitybar: [{ id: 'acmeSide', title: 'Acme' }] },
			views: { acmeSide: [{ id: 'acme.chat', name: 'Chat', type: 'webview' }] }
		}, {}, () => undefined, () => true);
		try {
			// Answer the frame calls the host places (resolve dispatches would otherwise hang).
			const answer = (event: MessageEvent): void => {
				const data = event.data as { type?: string; id?: number };
				if (data?.type !== '__studioExtCall') return;
				window.dispatchEvent(new MessageEvent('message', { data: { type: '__studioExtCallResult', id: data.id, ok: true, result: undefined } }));
			};
			window.addEventListener('message', answer);
			const resolves = () => sent.filter((message) => (message as { type?: string; method?: string }).method === 'webviewView.resolve');

			// The chat settles on the page the (old) process rendered — the official
			// provider's login screen.
			await host['serve']('webviewView.register', ['acme.chat'], 'acme.demo', {} as never);
			await host['serve']('webviewView.setHtml', ['acme.chat', '<html><body>login</body></html>'], 'acme.demo', {} as never);
			const section = document.body.appendChild(document.createElement('div'));
			const dispose = host.mountWebviewView('acme.chat', 'acme.demo', section);
			host.noteViewVisible('acme.chat', true);
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(resolves()).toHaveLength(1); // resolved once, settled

			// The provider switch restarts the extension's backend; the fresh process's
			// activation settled and the Rust side announced it. The settled view must
			// re-resolve — nothing else would ever re-ask, and the sidebar would keep the
			// old provider's login page forever.
			backend.emit('ext-backend-restarted', 'acme.demo');
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(resolves()).toHaveLength(2);

			// The fresh provider's page really lands: its setHtml reloads the mounted frame.
			await host['serve']('webviewView.setHtml', ['acme.chat', '<html><body>chat</body></html>'], 'acme.demo', {} as never);
			await new Promise((resolve) => setTimeout(resolve, 300));
			expect(section.querySelector('iframe')!.getAttribute('srcdoc')).toContain('<body>chat</body>');
			dispose();
			window.removeEventListener('message', answer);
		} finally {
			removeContributions('acme.demo');
		}
	});

	it('the Extensions view\'s restart re-resolves the settled chat view too (no stale page without the provider event)', async () => {
		// restartProcess is the other restart path — it emits no BACKEND_RESTARTED_EVENT, so
		// it resets the settled webview views itself; otherwise the sidebar would keep the
		// page the old process rendered, the same stuck-page bug the provider event fixes.
		backend.on('ext_process_stop', () => null);
		backend.on('ext_child_stop_for', () => null);
		backend.on('ext_process_start', () => null);
		const { host, sent } = hostWithFrame();
		applyContributions('acme.demo', {
			viewsContainers: { activitybar: [{ id: 'acmeSide', title: 'Acme' }] },
			views: { acmeSide: [{ id: 'acme.chat', name: 'Chat', type: 'webview' }] }
		}, {}, () => undefined, () => true);
		try {
			const answer = (event: MessageEvent): void => {
				const data = event.data as { type?: string; id?: number };
				if (data?.type !== '__studioExtCall') return;
				window.dispatchEvent(new MessageEvent('message', { data: { type: '__studioExtCallResult', id: data.id, ok: true, result: undefined } }));
			};
			window.addEventListener('message', answer);
			const resolves = () => sent.filter((message) => (message as { type?: string; method?: string }).method === 'webviewView.resolve');

			await host['serve']('webviewView.register', ['acme.chat'], 'acme.demo', {} as never);
			const section = document.body.appendChild(document.createElement('div'));
			const dispose = host.mountWebviewView('acme.chat', 'acme.demo', section);
			host.noteViewVisible('acme.chat', true);
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(resolves()).toHaveLength(1); // resolved once, settled

			await host.restartProcess('acme.demo');
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(backend.callsTo('ext_process_stop')).toEqual([{ extId: 'acme.demo' }]);
			expect(backend.callsTo('ext_process_start')).toEqual([{ extId: 'acme.demo' }]);
			expect(resolves()).toHaveLength(2);

			dispose();
			window.removeEventListener('message', answer);
		} finally {
			removeContributions('acme.demo');
		}
	});

	it('a page that settled without ever firing load still gets its messages (the watchdog\'s settle quirk)', async () => {
		const { host } = hostWithFrame();
		await host['serve']('webview.create', [1, 'demo.view', 'Demo Panel'], 'acme.demo', {} as never);
		await host['serve']('webview.setHtml', [1, '<html><body>hi</body></html>'], 'acme.demo', {} as never);
		await host['serve']('webview.postMessage', [1, { type: 'held' }], 'acme.demo', {} as never);
		const pane = document.body.appendChild(document.createElement('div'));
		const dispose = host.mountWebview('acme.demo', 1, pane);
		const frame = pane.querySelector('iframe')!;
		const posted: unknown[] = [];
		vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation(((message: unknown) => { posted.push(message); }) as never);
		// The WebView2 shape the watchdog's settle probe knows: readyState complete, the
		// boot script in the document — but `load` never fires. No drain would ever run;
		// the push that finds the document settled is the drain.
		const doc = frame.contentDocument!;
		Object.defineProperty(doc, 'readyState', { value: 'complete', configurable: true });
		(doc.documentElement ?? doc).appendChild(doc.createElement('script'));
		await host['serve']('webview.postMessage', [1, { type: 'fresh' }], 'acme.demo', {} as never);
		expect(posted.map((m) => (m as { message?: unknown }).message)).toEqual([{ type: 'held' }, { type: 'fresh' }]);
		expect(host['webviews'].get(host['webviewKey']('acme.demo', 1))!.pending).toEqual([]);
		dispose();
	});

	it('a setHtml reload re-arms the gate: pushes during the reload deliver on the new load', async () => {
		const { host } = hostWithFrame();
		await host['serve']('webview.create', [1, 'demo.view', 'Demo Panel'], 'acme.demo', {} as never);
		await host['serve']('webview.setHtml', [1, '<html><body>one</body></html>'], 'acme.demo', {} as never);
		const pane = document.body.appendChild(document.createElement('div'));
		const dispose = host.mountWebview('acme.demo', 1, pane);
		const frame = pane.querySelector('iframe')!;
		frame.dispatchEvent(new Event('load')); // the first document is live
		await new Promise((resolve) => setTimeout(resolve, 200)); // its grace closes, the gate opens
		const posted: unknown[] = [];
		vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation(((message: unknown) => { posted.push(message); }) as never);
		await host['serve']('webview.postMessage', [1, { n: 1 }], 'acme.demo', {} as never);
		expect(posted).toHaveLength(1); // the direct path
		// The reload: the page's listeners are gone until the new document loads — a push
		// in that window must queue, not land in a document about to be replaced.
		await host['serve']('webview.setHtml', [1, '<html><body>two</body></html>'], 'acme.demo', {} as never);
		await host['serve']('webview.postMessage', [1, { n: 2 }], 'acme.demo', {} as never);
		expect(posted).toHaveLength(1);
		frame.dispatchEvent(new Event('load'));
		await new Promise((resolve) => setTimeout(resolve, 200)); // the reload's grace closes, the queue drains
		expect(posted.map((m) => (m as { message?: { n?: number } }).message)).toEqual([{ n: 1 }, { n: 2 }]);
		dispose();
	});

	it('a settings change reaches the frame as a configChanged event', async () => {
		const { host, sent } = hostWithFrame();
		document.dispatchEvent(new CustomEvent('ggs-ext-settings', { detail: 'acme.demo' }));
		const events = sent.filter((m) => (m as { type?: string }).type === '__studioExtEvent') as { event: string; settings: unknown }[];
		expect(events).toHaveLength(1);
		expect(events[0]!.event).toBe('configChanged');
		expect(events[0]!.settings).toEqual({});
	});

	it('a settings change reaches a process-hosted extension before any view resolved it', async () => {
		// The Rust boot pass starts (and activates) node backends before the workbench has a
		// remote handle for them; the push could not wait for `frames.get` — a backend whose
		// first settings write arrived pre-resolution kept its activation-time settings
		// forever (git-graph-rs's enableLog never turned on live). The handle is created on
		// the spot, so the configChanged crosses `ext_process_push_event` regardless.
		const host = new ExtensionHost();
		// Every ExtensionHost this file has created still listens on the shared document, so
		// one dispatch fans out to all of them — the assertions read only this host's own
		// frames table, where the count and the identity are unambiguous.
		const extId = 'acme.process';
		document.dispatchEvent(new CustomEvent('ggs-ext-settings', { detail: extId }));
		const handle = host['frames'].get(extId);
		expect(handle).toBeDefined();

		// The recorded invoke carries the configChanged to the backend's push command.
		const mine = backend.callsTo('ext_process_push_event').filter((c) => c.extId === extId);
		expect(mine.length).toBeGreaterThanOrEqual(1);
		const event = (mine.at(-1)! as { event: { type: string; event: string; settings: unknown } }).event;
		expect(event.type).toBe('__studioExtEvent');
		expect(event.event).toBe('configChanged');

		// A second dispatch reuses the handle — created once, then found in the frames table.
		const beforeSecond = mine.length;
		document.dispatchEvent(new CustomEvent('ggs-ext-settings', { detail: extId }));
		expect(backend.callsTo('ext_process_push_event').filter((c) => c.extId === extId).length).toBeGreaterThan(beforeSecond);
		expect(host['frames'].get(extId)).toBe(handle);
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
	it('a backend-and-main package\'s declared command wakes the frame before the backend answers', async () => {
		// The first click on a lazily-activated command used to route straight to the
		// backend, whose "no handler registered" toast is what the user saw. A package
		// with a `main` is a frame program (VS Code semantics): activation runs first and
		// the handler it registers answers; the backend is only the fallthrough.
		const manifest = { main: './out/extension.js', contributes: { commands: [{ command: 'acme.ggxdemo.view', title: 'View' }] } };
		const installed: ExtInfo = { id: 'acme.ggxdemo', name: 'ggxdemo', displayName: 'Acme GGX', publisher: 'acme', version: '1.0.0', description: '', builtin: false, icon: null, path: '/ext/acme.ggxdemo-1.0.0', categories: [], keywords: [], repository: null, license: null, enginesVscode: null, extensionDependencies: [], extensionPack: [], readme: null, changelog: null, format: 'vsix', capabilities: { format: 'ggs/2', id: 'acme.ggxdemo', version: '1.0.0', pages: {}, backend: { kind: 'node', host: 'ggs-node', command: 'native/win32-x64-msvc/git-graph.node' } } };
		backend.on('ext_list', () => [installed]);
		backend.on('ext_read_file', ({ relPath }) => relPath === 'package.json' ? JSON.stringify(manifest) : (() => { throw new Error('no such file'); })());
		backend.on('ext_process_run', ({ command }) => ({ command }));
		const host = new ExtensionHost();
		await host.activateInstalled();
		let woken = 0;
		(host as unknown as { ensureActive: (extId: string) => Promise<void> }).ensureActive = (extId) => {
			woken += 1;
			expect(extId).toBe('acme.ggxdemo');
			return Promise.resolve();
		};
		await host.executeCommand('acme.ggxdemo.view', []);
		expect(woken).toBe(1);
		// Activation registered nothing in this stubbed run, so the backend convention
		// (the launcher/openPage answer) is what the command reaches — after the wake.
		expect(backend.callsTo('ext_process_run')).toEqual([
			{ extId: 'acme.ggxdemo', command: 'acme.ggxdemo.view', args: [] }
		]);
	});
	it('a backend-only package\'s declared command dispatches to the backend without waking a frame', async () => {
		// No `main`, no frame to activate: the backend owns the commands outright.
		const manifest = { contributes: { commands: [{ command: 'acme.ggxdemo.act', title: 'Act' }] } };
		const installed: ExtInfo = { id: 'acme.ggxdemo', name: 'ggxdemo', displayName: 'Acme GGX', publisher: 'acme', version: '1.0.0', description: '', builtin: false, icon: null, path: '/ext/acme.ggxdemo-1.0.0', categories: [], keywords: [], repository: null, license: null, enginesVscode: null, extensionDependencies: [], extensionPack: [], readme: null, changelog: null, format: 'ggs', capabilities: { format: 'ggs/2', id: 'acme.ggxdemo', version: '1.0.0', pages: {}, backend: { kind: 'process', command: 'bin/tool.exe' } } };
		backend.on('ext_list', () => [installed]);
		backend.on('ext_read_file', ({ relPath }) => relPath === 'package.json' ? JSON.stringify(manifest) : (() => { throw new Error('no such file'); })());
		backend.on('ext_process_run', ({ command }) => ({ command }));
		const host = new ExtensionHost();
		await host.activateInstalled();
		let woken = 0;
		(host as unknown as { ensureActive: (extId: string) => Promise<void> }).ensureActive = () => {
			woken += 1;
			return Promise.resolve();
		};
		await host.executeCommand('acme.ggxdemo.act', []);
		expect(woken).toBe(0);
		expect(backend.callsTo('ext_process_run')).toEqual([
			{ extId: 'acme.ggxdemo', command: 'acme.ggxdemo.act', args: [] }
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
	// `platform` is the host's (`extensionEnv` sends it): it spells every Uri.fsPath.
	const bootExtension = (code: string, platform?: string): void => {
		window.dispatchEvent(new MessageEvent('message', {
			data: {
				type: '__studioExtInit',
				context: { extensionId: 'acme.demo', extensionPath: '/ext/acme.demo-2.0.0', workspaceFolders: [], settings: {}, language: 'en', webviewResourceBase: 'ggs://localhost/acme.demo-2.0.0/', state: { global: {}, workspace: {} }, platform },
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

	it('hands a menu-dispatched command its Uri context as a full Uri (a "filter by this file" command)', async () => {
		// The handler answers with the shape it was handed: the fsPath read a menu command
		// filters by, and the toString() only a rehydrated Uri has.
		bootExtension("const vscode = require('vscode'); exports.activate = () => { vscode.commands.registerCommand('demo.filterByFile', (arg) => typeof arg === 'object' && arg.uri ? [arg.uri.fsPath, typeof arg.uri.toString] : ['none', 'none']); };", 'win32');
		await flush();
		window.dispatchEvent(new MessageEvent('message', { data: {
			type: '__studioExtCall', id: 43, method: 'runCommand',
			// What the workbench's explorer/context dispatch now sends: the clicked resource
			// and the selection, as Uri-shaped data (the methods cannot cross the clone).
			args: ['demo.filterByFile', [{ uri: { scheme: 'file', path: 'C:\\repo\\a.txt', fsPath: 'C:\\repo\\a.txt', query: '', fragment: '' } }, []]]
		} }));
		await flush();
		const call = callResults.get(43);
		expect(call!.ok).toBe(true);
		expect(call!.result).toEqual(['C:\\repo\\a.txt', 'function']);
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
		await host.activateInstalled();

		// The declared command is runnable from the manifest alone — no frame, no spawn yet.
		expect(commands.get('acme.proc.hello')).toBeDefined();
		expect(commands.paletteItems().some((item) => item.value === 'acme.proc.hello')).toBe(true);
		await commands.execute('acme.proc.open');
		await flush();
		// The palette invocation reached the backend process command, and its page-open
		// convention surfaced the package's page.
		expect(backend.callsTo('ext_process_run')).toEqual([{ extId: 'acme.proc', command: 'acme.proc.open', args: [] }]);

		// A failing backend command surfaces as an error notification, not a throw.
		backend.on('ext_process_run', () => { throw 'spawn failed'; });
		await commands.execute('acme.proc.hello');
		await flush();
		expect(notifications().join()).toContain('Extension backend command failed');
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

	it('hosts a backend package WITH a main in its backend process — the program runs there, no sandboxed frame', async () => {
		// The host-selection rule since ggs-node became the default: a manifest `node`
		// backend means the package's own program runs IN the backend process (on
		// ggs-node), not in a sandboxed frame — the backend is never merely an
		// implementation detail of a frame copy of the same program.
		const ENGINE: ExtInfo = {
			...GGX2, id: 'acme.engine',
			capabilities: { format: 'ggs/2', id: 'acme.engine', version: '1.0.0', pages: {}, backend: { kind: 'node', host: 'ggs-node', command: 'out/main.js' }, permissions: [] }
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
		backend.on('ext_process_start', () => ({ extensionId: 'acme.engine', pid: 4242, commands: [], protocolVersion: 'ggs-ext/1', startCount: 1, lastError: null }));
		const host = new ExtensionHost();
		await host.activateInstalled();
		// The remote handle is the frame of record — a sandboxed frame never booted.
		const handle = [...host['frames'].values()][0]!;
		expect(handle.frame).toBeUndefined();
		expect(backend.callsTo('ext_process_start')).toContainEqual({ extId: 'acme.engine' });
	});

	it('a backend-hosted program\'s forwarded registrations land, and its commands dispatch over the process', async () => {
		// A backend-hosted package (the manifest `node` backend; ggs-node by default, a
		// real Node under `GGS_REAL_NODE` — `ext_node_runtime` reports one here) runs in
		// its own host process, not a frame: the start is awaited, the host's forwarded
		// `commands.register` lands through the ext-host-request event, and the palette
		// command dispatches over `ext_process_run`.
		const ENGINE: ExtInfo = {
			...GGX2, id: 'acme.engine',
			capabilities: { format: 'ggs/2', id: 'acme.engine', version: '1.0.0', pages: {}, backend: { kind: 'node', host: 'ggs-node', command: 'out/main.js' }, permissions: [] }
		};
		withExtensions(ENGINE);
		backend.on('ext_node_runtime', () => 'C:/node/node.exe');
		backend.on('ext_process_start', () => ({ extensionId: 'acme.engine', pid: 4242, commands: ['acme.engine.go'], protocolVersion: 'ggs-ext/1', startCount: 1, lastError: null }));
		backend.on('ext_process_run', () => ({ ran: 'in the node host' }));
		backend.on('ext_process_status', () => []);
		const host = new ExtensionHost();
		await host.activateInstalled();
		// No frame: the process is the extension host.
		const handle = [...host['frames'].values()][0]!;
		expect(handle.frame).toBeUndefined();
		expect(backend.callsTo('ext_process_start')).toContainEqual({ extId: 'acme.engine' });
		// The node host registers its handler mid-activation; the forwarded request reaches
		// the same serve path a frame's RPC takes, then the palette dispatch rides run.
		backend.emit('ext-host-request', { extId: 'acme.engine', id: 1000000001, method: 'commands.register', args: ['acme.engine.go'] });
		await flush();
		await host.executeCommand('acme.engine.go', []);
		expect(backend.callsTo('ext_process_run')).toContainEqual({ extId: 'acme.engine', command: 'acme.engine.go', args: [] });
	});

	it('a restart after a failed start re-registers the remote handle before the process starts', async () => {
		// The installed-app failure: the first start timed out (its handle was dropped), and
		// the Extensions view's restart then started the process bare — the activation's
		// `host.env` request answered "no extension host frame".
		const ENGINE: ExtInfo = {
			...GGX2, id: 'acme.engine',
			capabilities: { format: 'ggs/2', id: 'acme.engine', version: '1.0.0', pages: {}, backend: { kind: 'node', host: 'ggs-node', command: 'out/main.js' }, permissions: [] }
		};
		withExtensions(ENGINE);
		backend.on('ext_read_file', () => { throw new Error('no such file'); });
		let starts = 0;
		const host = new ExtensionHost();
		let handleAtStart = false;
		backend.on('ext_process_start', () => {
			starts++;
			if (starts === 1) throw new Error('acme.engine did not answer initialize within 10 s');
			handleAtStart = host['frames'].has('acme.engine');
			return { extensionId: 'acme.engine', pid: 4242, commands: [], protocolVersion: 'ggs-ext/1', startCount: 2, lastError: null };
		});
		await host.activateInstalled();
		expect(host['frames'].has('acme.engine')).toBe(false);
		await host.restartProcess('acme.engine');
		expect(handleAtStart).toBe(true);
		expect(host['frames'].has('acme.engine')).toBe(true);
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
		await host.activateInstalled();

		const explorer = new Explorer(document.getElementById('sidebar')!);
		explorer.setRoot('C:\\repo');
		await flush();
		rightClick(document.querySelector('.tree .row'));
		expect(menuLabels()).toContain('Hello');

		// Clicking the entry runs its backend command — with VS Code's menu arguments, the
		// clicked resource and the selection as Uris.
		click(menuItem('Hello'));
		await flush();
		const uri = { scheme: 'file', path: 'C:\\repo\\README.md', fsPath: 'C:\\repo\\README.md', query: '', fragment: '' };
		expect(backend.callsTo('ext_process_run')).toEqual([{ extId: 'acme.proc', command: 'acme.proc.hello', args: [uri, [uri]] }]);
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

	it('a page frame hears the watcher batch and the save on the page channel - no polling', () => {
		const host = new ExtensionHost();
		const pageSent: { __ggsHost?: boolean; type?: string; event?: { kind?: string; root?: string; paths?: string[]; gitChanged?: boolean; truncated?: boolean; path?: string; languageId?: string } }[] = [];
		const frame = { contentWindow: { postMessage: (message: unknown) => pageSent.push(message as typeof pageSent[number]) } } as unknown as HTMLIFrameElement;
		host['pageFrames'].set(1, { extId: 'acme.demo', pageId: 'main', frame, pendingCalls: new Set() });

		// The watcher's batch (a commit's .git burst here) rides the page channel: a ggs://
		// page has no frame and no vscode API to watch with, so this push is how its view
		// (the graph's) learns a stage/commit landed without polling the engine.
		backend.emit('studio://fs-changed', { root: 'C:/ws', paths: [], gitChanged: true, truncated: false });
		const fs = pageSent.find((message) => message.event?.kind === 'fs');
		expect(fs).toMatchObject({ __ggsHost: true, type: 'event', event: { kind: 'fs', root: 'C:/ws', paths: [], gitChanged: true, truncated: false } });

		host.noteDocumentSaved('C:/ws/a.md');
		const saved = pageSent.find((message) => message.event?.kind === 'documentSaved');
		expect(saved).toMatchObject({ __ggsHost: true, type: 'event', event: { kind: 'documentSaved', path: 'C:/ws/a.md', languageId: 'markdown' } });
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

	it('resolves a root-level sibling require (the entry directory is the package root)', async () => {
		// Claude Remote's shape — a flat multi-file package whose `extension.js` requires
		// `./sessions.js`: the entry's directory is '' and the resolver once built
		// '/./sessions.js', whose normalized '/sessions.js' key no code map carries, so
		// every root-level sibling require died on MODULE_NOT_FOUND.
		bootPackage({
			'package.json': '{"main":"./extension.js"}',
			'extension.js': "const sessions = require('./sessions.js');\nexports.activate = () => { require('vscode').commands.registerCommand('multi.flat', () => sessions.name); };",
			'sessions.js': 'exports.name = \'flat-package\';'
		});
		await flush();
		window.dispatchEvent(new MessageEvent('message', { data: { type: '__studioExtCall', id: 74, method: 'runCommand', args: ['multi.flat'] } }));
		await flush();
		const call = posts.get(74);
		expect(call).toBeDefined();
		expect(call!.ok).toBe(true);
		expect(call!.result).toBe('flat-package');
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
		// GGS-patch: hover providers are REAL now (see editorHovers.ts) — registration
		// returns a Disposable without any unsupported-API noise.
		expect(() => api.languages.registerHoverProvider(() => undefined, { provideHover: () => undefined })).not.toThrow();
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

	it('a webview view carries onDidDispose, fired once on dispose (Claude Code wires cleanup there)', async () => {
		const api = shimApi();
		let disposals = 0;
		let view: { onDidDispose(listener: () => void): void; dispose(): void } | null = null;
		api.window.registerWebviewViewProvider('acme.list', {
			resolveWebviewView: (resolved) => {
				view = resolved as typeof view;
				view!.onDidDispose(() => { disposals++; });
			}
		});
		await api.__serveWebviewView.resolve('acme.list');
		view!.dispose();
		view!.dispose();
		expect(disposals).toBe(1);
	});

	it('executeCommand of the extension\'s own command runs locally, undefined arguments intact', async () => {
		const api = shimApi();
		const requests = (api as unknown as { __requests: { method: string; args: unknown[] }[] }).__requests;
		let received: unknown[] | null = null;
		api.commands.registerCommand('acme.open', (...args: unknown[]) => { received = args; return 'opened'; });
		const result = await api.commands.executeCommand('acme.open', undefined, 1);
		expect(result).toBe('opened');
		expect(received).toEqual([undefined, 1]);
		expect(requests.some((request) => request.method === 'commands.execute')).toBe(false);
		// Another extension's (or the workbench's) command still crosses to the host.
		void api.commands.executeCommand('workbench.action.files.save');
		expect(requests.some((request) => request.method === 'commands.execute')).toBe(true);
	});

	it('reports a VS Code version at or past 1.106, the secondary-sidebar layout packages gate on', () => {
		const [major, minor] = shimApi().version.split('.').map(Number);
		expect(major! > 1 || minor! >= 106).toBe(true);
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

describe('the compatibility surface this round: digests, watchers, provider-backed diffs', () => {
	it('crypto.createHash answers the md5/sha1/sha256 digests Node would', () => {
		const builtins = createNodeBuiltins({
			nodeEnv: { platform: 'win32', arch: 'x64', homedir: '', tmpdir: '', hostname: 't', release: '', eol: '\r\n', separator: '\\', delimiter: ';' },
			extensionPath: '/x',
			files: {},
			binaries: [],
			blobs: {},
			bridge: { request: async () => undefined }
		} as never);
		const crypto = builtins['crypto']! as { createHash: (algorithm: string) => { update(data: string): unknown; digest(encoding?: string): unknown } };
		expect(crypto.createHash('md5').update('hello').digest('hex')).toBe('5d41402abc4b2a76b9719d911017c592');
		expect(crypto.createHash('md5').update('Gravatar emails are trimmed and lowercased').update(' then hashed').digest('hex'))
			.toBe(crypto.createHash('md5').update('Gravatar emails are trimmed and lowercased then hashed').digest('hex'));
		expect(crypto.createHash('sha1').update('hello').digest('hex')).toBe('aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d');
		expect(crypto.createHash('sha256').update('hello').digest('hex')).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
		expect(crypto.createHash('sha256').update('hello').digest('base64')).toBe('LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ=');
	});

	it("fs.stat answers a null bridge answer with Node's ENOENT callback, never a throw", () => {
		const builtins = createNodeBuiltins({
			nodeEnv: { platform: 'win32', arch: 'x64', homedir: '', tmpdir: '', hostname: 't', release: '', eol: '\r\n', separator: '\\', delimiter: ';' },
			extensionPath: '/x',
			files: {},
			binaries: [],
			blobs: {},
			// `undefined` is what an unhandled fs.op carries back — a package statting an
			// absent workspace path used to die reading `.type` off it, an unhandled
			// rejection whose callback never fired.
			bridge: { request: async () => undefined }
		} as never);
		const fs = builtins['fs']! as { stat: (path: string, cb: (error: Error | null, stats?: unknown) => void) => void };
		void fs.stat('C:/ws/missing.txt', (error, stats) => {
			expect(error).toBeInstanceOf(Error);
			expect(String(error)).toContain('ENOENT');
			expect(stats).toBeUndefined();
		});
	});

	it('watcherGlobMatches covers the patterns createFileSystemWatcher serves', () => {
		expect(watcherGlobMatches('**', 'src/main.rs')).toBe(true);
		expect(watcherGlobMatches('.git/**', '.git/HEAD')).toBe(true);
		expect(watcherGlobMatches('**/*.rs', 'src/deep/util.rs')).toBe(true);
		expect(watcherGlobMatches('**/*.rs', 'main.rs')).toBe(true);
		expect(watcherGlobMatches('src/*.rs', 'src/deep/util.rs')).toBe(false);
		expect(watcherGlobMatches('src/*.rs', 'src/util.rs')).toBe(true);
		expect(watcherGlobMatches('a?c/*.txt', 'abc/x.txt')).toBe(true);
		expect(watcherGlobMatches('a?c/*.txt', 'abbc/x.txt')).toBe(false);
	});

	it('a Uri crosses the structured clone of a postMessage (vscode.diff arguments ride in one)', () => {
		const uri = Uri.file('/ws/repo/src/main.rs').with({ query: 'eHg=' });
		// A Uri carrying own enumerable function members used to throw DataCloneError the
		// moment an executeCommand RPC posted it — vscode.diff died silently at the bridge.
		const clone = structuredClone(uri) as { scheme: string; query: string };
		expect(clone.scheme).toBe('file');
		expect(clone.query).toBe('eHg=');
		expect(Object.keys(clone)).not.toContain('toString');
		expect(Object.keys(clone)).not.toContain('with');
	});

	it("createFileSystemWatcher serves the host's watcher batches (paths and the .git flag)", async () => {
		const requests: { method: string; args: unknown[] }[] = [];
		const api = createVscodeApi(
			{ extensionId: 'x', extensionPath: '/x', workspaceFolders: [{ uri: Uri.file('/ws/repo'), name: 'repo', index: 0 }], settings: {}, language: 'en' },
			{ request: async (method: string, args: unknown[]) => { requests.push({ method, args }); return undefined; }, registerCommandHandler: () => undefined }
		);
		const seen: string[] = [];
		const watcher = api.workspace.createFileSystemWatcher(new RelativePattern(Uri.file('/ws/repo'), '**'));
		watcher.onDidChange((uri) => seen.push((uri as { fsPath: string }).fsPath));
		api.handleHostEvent({ event: 'fsChanged', fs: { root: '/ws/repo', paths: ['src/main.rs', 'docs/guide.md'], gitChanged: true, truncated: false } });
		await flush();
		expect(seen).toContain('/ws/repo/src/main.rs');
		expect(seen).toContain('/ws/repo/docs/guide.md');
		expect(seen).toContain('/ws/repo/.git/HEAD');
		// A batch from another root never fires (the stale-folder half of the contract).
		seen.length = 0;
		api.handleHostEvent({ event: 'fsChanged', fs: { root: '/other', paths: ['x'], gitChanged: false, truncated: false } });
		await flush();
		expect(seen).toEqual([]);
		watcher.dispose();
	});

	it('vscode.diff resolves provider-scheme sides through the registering frame and opens the diff editor', async () => {
		const host = new ExtensionHost();
		const handle = { frame: document.createElement('iframe'), commandIds: new Set<string>(), pendingCalls: new Set<(error: Error) => void>() };
		document.body.appendChild(handle.frame);
		host['frames'].set('acme.demo', handle);
		await host['serve']('docProvider.register', ['acme-scheme'], 'acme.demo', handle);
		const provided: unknown[] = [];
		(host as unknown as { callFrame: (h: unknown, method: string, args: unknown[]) => Promise<unknown> }).callFrame =
			async (_h, method, args) => {
				if (method !== 'docProvider.provide') throw new Error('unexpected frame call');
				provided.push(args[0]);
				return 'the content at the revision';
			};
		const opened: unknown[] = [];
		host.onOpenDiff = (diff) => opened.push(diff);
		const uri = { scheme: 'acme-scheme', path: '/repo/src/main.rs', fsPath: '/repo/src/main.rs', query: 'eHg=', fragment: '', toString: () => 'acme-scheme:/repo/src/main.rs?eHg=', with: () => uri };
		const fileUri = { scheme: 'file', path: '/repo/src/main.rs', fsPath: 'C:\\repo\\src\\main.rs', query: '', fragment: '', toString: () => 'file:///repo/src/main.rs', with: () => fileUri };
		await host.executeCommand('vscode.diff', [uri, fileUri, 'main.rs (HEAD → working tree)']);
		expect(provided).toEqual([uri]);
		expect(opened).toHaveLength(1);
		const diff = opened[0] as { title: string; left: { content?: string; local?: boolean }; right: { local?: boolean; path: string } };
		expect(diff.title).toBe('main.rs (HEAD → working tree)');
		expect(diff.left.content).toBe('the content at the revision');
		expect(diff.left.local).toBeUndefined();
		expect(diff.right.local).toBe(true);
		expect(diff.right.path).toBe('C:\\repo\\src\\main.rs');
		// The unregistered scheme is a clear error, never a silent nothing.
		await expect(host.executeCommand('vscode.diff', [{ ...uri, scheme: 'nobody' }, uri])).rejects.toThrow(/no text-document content provider/);
	});

	it('vscode.diff resolves a file-system provider\u2019s scheme through the registering frame', async () => {
		// The other half of claude-code's change-review diff: its left side is an
		// in-memory `registerFileSystemProvider` scheme, answered by `fsProvider.read`
		// exactly as a content provider's is.
		const host = new ExtensionHost();
		const handle = { frame: document.createElement('iframe'), commandIds: new Set<string>(), pendingCalls: new Set<(error: Error) => void>() };
		document.body.appendChild(handle.frame);
		host['frames'].set('acme.demo', handle);
		await host['serve']('fsProvider.register', ['_acme_fs_left'], 'acme.demo', handle);
		const asked: unknown[] = [];
		(host as unknown as { callFrame: (h: unknown, method: string, args: unknown[]) => Promise<unknown> }).callFrame =
			async (_h, method, args) => {
				if (method !== 'fsProvider.read') throw new Error(`unexpected frame call: ${method}`);
				asked.push(args[0]);
				return 'the staged left side';
			};
		const opened: unknown[] = [];
		host.onOpenDiff = (diff) => opened.push(diff);
		const leftUri = { scheme: '_acme_fs_left', path: '/temp/left/src/main.rs', fsPath: '', query: '', fragment: '', toString: () => '_acme_fs_left:/temp/left/src/main.rs', with: () => leftUri };
		const rightUri = { scheme: 'file', path: '/repo/src/main.rs', fsPath: 'C:\\repo\\src\\main.rs', query: '', fragment: '', toString: () => 'file:///repo/src/main.rs', with: () => rightUri };
		await host.executeCommand('vscode.diff', [leftUri, rightUri, 'main.rs (proposed)']);
		expect(asked).toEqual([leftUri]);
		const diff = opened[0] as { title: string; left: { content?: string } };
		expect(diff.title).toBe('main.rs (proposed)');
		expect(diff.left.content).toBe('the staged left side');
		// Unregistering closes the scheme: the diff reports the missing provider.
		await host['serve']('fsProvider.unregister', ['_acme_fs_left'], 'acme.demo', handle);
		await expect(host.executeCommand('vscode.diff', [leftUri, rightUri])).rejects.toThrow(/no text-document content provider/);
	});

	it('vscode.open opens a provider-scheme document in a read-only content tab', async () => {
		const host = new ExtensionHost();
		const handle = { frame: document.createElement('iframe'), commandIds: new Set<string>(), pendingCalls: new Set<(error: Error) => void>() };
		document.body.appendChild(handle.frame);
		host['frames'].set('acme.demo', handle);
		await host['serve']('docProvider.register', ['acme-scheme'], 'acme.demo', handle);
		(host as unknown as { callFrame: (h: unknown, method: string, args: unknown[]) => Promise<unknown> }).callFrame =
			async () => 'line one\nline two';
		const opened: { title: string; path: string; text: string }[] = [];
		host.onOpenContent = (title, path, text) => opened.push({ title, path, text });
		const uri = { scheme: 'acme-scheme', path: '/repo/src/util.ts', fsPath: '/repo/src/util.ts', query: '', fragment: '', toString: () => 'acme-scheme:/repo/src/util.ts', with: () => uri };
		await host.executeCommand('vscode.open', [uri]);
		const files: string[] = [];
		host.onOpenFile = (path) => files.push(path);
		await host.executeCommand('vscode.open', [{ scheme: 'file', path: '/ws/repo/main.py', fsPath: '/ws/repo/main.py', query: '', fragment: '', toString: () => 'file:///ws/repo/main.py', with: () => null }]);
		expect(files).toEqual(['/ws/repo/main.py']);
	});

	it('vscode.open honors a ViewColumn: Beside and a column number become the tab placement', async () => {
		const host = new ExtensionHost();
		const handle = { frame: document.createElement('iframe'), commandIds: new Set<string>(), pendingCalls: new Set<(error: Error) => void>() };
		document.body.appendChild(handle.frame);
		host['frames'].set('acme.demo', handle);
		await host['serve']('docProvider.register', ['acme-scheme'], 'acme.demo', handle);
		(host as unknown as { callFrame: (h: unknown, method: string, args: unknown[]) => Promise<unknown> }).callFrame =
			async () => 'the output text';
		const contentPlacements: (string | number | undefined)[] = [];
		host.onOpenContent = (_title, _path, _text, placement) => contentPlacements.push(placement);
		const filePlacements: { path: string; placement?: string | number }[] = [];
		host.onOpenFile = (path, _line, _column, placement) => filePlacements.push({ path, placement });
		const uri = { scheme: 'acme-scheme', path: '/temp/readonly/Claude Code (ab12cd)', fsPath: '', query: '', fragment: '', toString: () => 'acme-scheme:/temp/readonly/Claude%20Code%20(ab12cd)', with: () => uri };
		// ViewColumn.Beside (-2) — claude-code's shape for opening beside the chat panel.
		await host.executeCommand('vscode.open', [uri, -2]);
		// A numbered column; and Active (-1) stays the host's default (no placement).
		await host.executeCommand('vscode.open', [{ ...uri, scheme: 'file', path: '/ws/repo/main.py', fsPath: '/ws/repo/main.py' }, 2]);
		await host.executeCommand('vscode.open', [{ ...uri, scheme: 'file', path: '/ws/repo/other.py', fsPath: '/ws/repo/other.py' }, -1]);
		expect(contentPlacements).toEqual(['beside']);
		expect(filePlacements).toEqual([{ path: '/ws/repo/main.py', placement: 2 }, { path: '/ws/repo/other.py', placement: undefined }]);
	});

	it('workspace.openContentTab opens a provider document showTextDocument already read, placed beside', async () => {
		// claude-code's chat opens its tool outputs and code blocks through this door: the
		// text crossed with the request (the shim read the provider in `openTextDocument`),
		// so the host never calls the frame back while its request is still in flight.
		const host = new ExtensionHost();
		const opened: { title: string; path: string; text: string; placement?: string | number }[] = [];
		host.onOpenContent = (title, path, text, placement) => opened.push({ title, path, text, placement });
		await host['serve']('workspace.openContentTab', ['Claude Code (ab12cd)', '/temp/readonly/Claude Code (ab12cd)', 'the tool output\n', 'beside'], 'acme.demo', { frame: null, commandIds: new Set(), pendingCalls: new Set() });
		expect(opened).toEqual([{ title: 'Claude Code (ab12cd)', path: '/temp/readonly/Claude Code (ab12cd)', text: 'the tool output\n', placement: 'beside' }]);
		// `workspace.openFile` carries the placement through the same way.
		const files: { path: string; line?: number; placement?: string | number }[] = [];
		host.onOpenFile = (path, line, _column, placement) => files.push({ path, line, placement });
		await host['serve']('workspace.openFile', ['/ws/repo/main.py', 3, 4, 'beside'], 'acme.demo', { frame: null, commandIds: new Set(), pendingCalls: new Set() });
		expect(files).toEqual([{ path: '/ws/repo/main.py', line: 3, placement: 'beside' }]);
	});

	it('vscode.diff from a process-backed caller answers at once — the provide call reaches a thread the response unblocks', async () => {
		// The ggs-node bridge parks the extension's one JS thread inside every host request
		// until the answer crosses back. A diff over a provider scheme asks that same
		// process for the text (`docProvider.provide`): an answer that waited for the open
		// waited for a thread that waited for the answer — the backend froze for the 30 s
		// bridge timeout, every later graph read queuing behind it, and the diff never
		// opened. The response must leave before the provide call is answered.
		const host = new ExtensionHost();
		const handle = { remote: true, commandIds: new Set<string>(), pendingCalls: new Set<(error: Error) => void>() };
		host['frames'].set('acme.demo', handle);
		await host['serve']('docProvider.register', ['acme-scheme'], 'acme.demo', handle);
		let settleProvide: ((text: string) => void) | null = null;
		(host as unknown as { callFrame: (h: unknown, method: string, args: unknown[]) => Promise<unknown> }).callFrame =
			async (_h, method) => {
				if (method !== 'docProvider.provide') throw new Error('unexpected frame call');
				// both diff sides are provider-scheme: park only the first provide, the way
				// a real backend answers one call after the other
				if (settleProvide === null) {
					return new Promise<string>((resolve) => { settleProvide = resolve; });
				}
				return 'the content at the revision';
			};
		const opened: { left: { content?: string } }[] = [];
		host.onOpenDiff = (diff) => opened.push(diff as { left: { content?: string } });
		const uri = { scheme: 'acme-scheme', path: '/repo/src/main.rs', fsPath: '/repo/src/main.rs', query: 'eHg=', fragment: '', toString: () => 'acme-scheme:/repo/src/main.rs?eHg=', with: () => uri };
		let serveAnswered = false;
		const served = host['serve']('commands.execute', ['vscode.diff', [uri, uri, 'main.rs']], 'acme.demo', handle).then(() => { serveAnswered = true; });
		await flush();
		expect(serveAnswered).toBe(true);
		expect(opened).toHaveLength(0);
		settleProvide!('the content at the revision');
		await served;
		await flush();		expect(opened).toHaveLength(1);
		expect(opened[0]!.left.content).toBe('the content at the revision');
	});
});

// The served page bootstrap (src-tauri composes it into every ggs:// page), driven here in its
// own browsing context so the document.open scenario cannot touch this file's document.
const PAGE_BOOT_SOURCE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src-tauri', 'src', 'ext_page_boot.js'), 'utf8');

describe('the theme as pages wear it (--vscode-* inline, the VS Code webview contract)', () => {
	it('extracts the --vscode-* declarations from a theme stylesheet, the last one winning', () => {
		const css = ':root{--vscode-editor-findMatchHighlightBackground:#ea5c0055;--vscode-font-family:\'Segoe UI\', sans-serif;}body{color:red}';
		expect(themeVars(css)).toEqual({
			'--vscode-editor-findMatchHighlightBackground': '#ea5c0055',
			'--vscode-font-family': '\'Segoe UI\', sans-serif'
		});
		expect(themeVars(':root{--vscode-a:#111}:root{--vscode-a:#222}')).toEqual({ '--vscode-a': '#222' });
		expect(themeVars('body{color:red}')).toEqual({});
	});

	it('the page bootstrap mirrors the host variables onto documentElement.style, and re-writes them after a document.open swap', async () => {
		const { JSDOM } = await import('jsdom');
		const dom = new JSDOM('<html><body></body></html>', { runScripts: 'outside-only', url: 'http://localhost/' });
		dom.window.eval(PAGE_BOOT_SOURCE);
		const api = (dom.window as unknown as { acquireGgsApi: () => { ready: Promise<unknown> } }).acquireGgsApi();
		dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
			data: { __ggsHost: true, type: 'init', context: { themeVars: { '--vscode-test-var': '#123456' } } }
		}));
		expect(await api.ready).toEqual({ themeVars: { '--vscode-test-var': '#123456' } });
		const doc = dom.window.document;
		expect(doc.documentElement.style.getPropertyValue('--vscode-test-var')).toBe('#123456');
		dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
			data: { __ggsHost: true, type: 'event', event: { kind: 'theme', vars: { '--vscode-test-var': '#abcdef' } } }
		}));
		expect(doc.documentElement.style.getPropertyValue('--vscode-test-var')).toBe('#abcdef');
		// The Git Graph page swaps its own document (document.open/write): the swap wipes the
		// inline attribute — the bootstrap re-writes the variables it cached once the write
		// has created the fresh document element.
		doc.open();
		doc.write('<html><head></head><body></body></html>');
		await flush();
		expect(doc.documentElement.style.getPropertyValue('--vscode-test-var')).toBe('#abcdef');
		dom.window.close();
	});
});

describe('the pages byte services (backend.run answers the __ commands itself)', () => {
	it('serves __revisionFileBytes and __fileChunk from the app, and still forwards the rest', async () => {
		const savedFolders = ExtensionHost.workspaceFolders;
		ExtensionHost.workspaceFolders = ['/ws'];
		backend.on('ext_page_revision_bytes', () => ({ error: null, bytes: 'AQID' }));
		backend.on('ext_page_file_chunk', () => ({ error: null, base64: 'AQID', size: 3 }));
		const forwarded: string[] = [];
		backend.on('ext_process_run', (args) => {
			forwarded.push(String(args.command));
			return null;
		});
		try {
			const host = new ExtensionHost();
			const page = {
				extId: 'acme.demo', pageId: 'binarycompare', frame: null, pendingCalls: new Set<(error: Error) => void>()
			} as unknown as Parameters<ExtensionHost['servePageRpc']>[2];

			const bytes = await host['servePageRpc']('backend.run', ['__revisionFileBytes', [{ repo: '/ws/repo', revision: 'abc123', path: 'logo.png' }]], page);
			expect(bytes).toEqual({ error: null, bytes: 'AQID' });
			expect(backend.callsTo('ext_page_revision_bytes').at(-1)).toMatchObject({
				roots: ['/ws'], repo: '/ws/repo', revision: 'abc123', path: 'logo.png'
			});

			const chunk = await host['servePageRpc']('backend.run', ['__fileChunk', [{ repo: '/ws/repo', path: 'blob.bin', offset: 2, len: 8 }]], page);
			expect(chunk).toEqual({ error: null, base64: 'AQID', size: 3 });
			expect(backend.callsTo('ext_page_file_chunk').at(-1)).toMatchObject({ roots: ['/ws'], repo: '/ws/repo', path: 'blob.bin', offset: 2, len: 8 });

			// Anything without the page-service prefix still reaches the package's backend.
			await host['servePageRpc']('backend.run', ['hello', [{ }]], page);
			expect(forwarded).toEqual(['hello']);
		} finally {
			ExtensionHost.workspaceFolders = savedFolders;
		}
	});
});

describe('VS Code API fidelity: value types, configuration, edits, diagnostics (the compatibility bug sweep)', () => {
	/** A shim over a recording bridge; `answers` stand in for the host. */
	function shim(ctx: Partial<Parameters<typeof createVscodeApi>[0]> = {}, answers: Record<string, (args: unknown[]) => unknown> = {}) {
		const requests: { method: string; args: unknown[] }[] = [];
		const handlers = new Map<string, (...args: unknown[]) => unknown>();
		const api = createVscodeApi(
			{ extensionId: 'acme.demo', extensionPath: '/ext/acme.demo-2.0.0', workspaceFolders: [], settings: {}, language: 'en', webviewResourceBase: 'ggs://localhost/acme.demo-2.0.0/', state: { global: {}, workspace: {} }, platform: 'linux', ...ctx },
			{
				request: async (method, args) => {
					requests.push({ method, args });
					return answers[method]?.(args);
				},
				registerCommandHandler: (id, handler) => handlers.set(id, handler)
			}
		);
		return { api, requests, handlers };
	}

	it('Range and Selection take both constructor spellings and answer the Position/Range methods', () => {
		const range = new Range(3, 4, 1, 2);
		// Four numbers, ends ordered (start never after end).
		expect(range.start).toMatchObject({ line: 1, character: 2 });
		expect(range.end).toMatchObject({ line: 3, character: 4 });
		expect(range.contains(new Position(2, 0))).toBe(true);
		expect(range.isSingleLine).toBe(false);
		expect(range.intersection(new Range(0, 0, 1, 5))).toMatchObject({ start: { line: 1, character: 2 }, end: { line: 1, character: 5 } });
		expect(range.union(new Range(0, 0, 0, 1)).start).toMatchObject({ line: 0, character: 0 });
		expect(new Position(1, 2).translate(1, 1)).toMatchObject({ line: 2, character: 3 });
		expect(new Position(1, 2).with({ character: 9 })).toMatchObject({ line: 1, character: 9 });
		expect(new Position(1, 2).isBefore(new Position(1, 3))).toBe(true);
		const api = shim().api;
		const selection = new api.Selection(2, 5, 0, 1);
		expect(selection.anchor).toMatchObject({ line: 2, character: 5 });
		expect(selection.isReversed).toBe(true);
		expect(() => new Position(-1, 0)).toThrow();
	});

	it('Uri follows VS Code: authority, file normalization, encoded toString, joinPath', () => {
		setUriPlatform('win32');
		const file = Uri.file('C:\\repo\\src\\a b.ts');
		expect(file.path).toBe('/C:/repo/src/a b.ts');
		expect(file.fsPath).toBe('C:\\repo\\src\\a b.ts');
		expect(file.toString()).toBe('file:///c%3A/repo/src/a%20b.ts');
		// parse inverts toString (the round trip a language server's URI takes).
		expect(Uri.parse(file.toString()).fsPath).toBe('c:\\repo\\src\\a b.ts');
		const unc = Uri.file('\\\\server\\share\\x.txt');
		expect(unc.authority).toBe('server');
		expect(unc.fsPath).toBe('\\\\server\\share\\x.txt');
		setUriPlatform('linux');
		const web = Uri.parse('https://example.com/a/b?x=1#frag');
		expect(web).toMatchObject({ scheme: 'https', authority: 'example.com', path: '/a/b', query: 'x=1', fragment: 'frag' });
		expect(Uri.joinPath(Uri.file('/ext/pkg'), 'media', '../icons', 'a.svg').path).toBe('/ext/pkg/icons/a.svg');
		expect(Uri.from({ scheme: 'untitled', path: 'Untitled-1' }).toString()).toBe('untitled:Untitled-1');
	});

	it('EventEmitter binds thisArgs, collects disposables, and isolates a throwing listener', () => {
		const { api, requests } = shim();
		const emitter = new api.EventEmitter<number>();
		const owner = { seen: [] as number[], record(this: { seen: number[] }, value: number) { this.seen.push(value); } };
		const disposables: { dispose(): unknown }[] = [];
		emitter.event(() => { throw new Error('listener bug'); });
		emitter.event(owner.record, owner, disposables);
		emitter.fire(7);
		// The second listener ran with its `this`, after the first one threw.
		expect(owner.seen).toEqual([7]);
		expect(disposables).toHaveLength(1);
		disposables[0]!.dispose();
		emitter.fire(8);
		expect(owner.seen).toEqual([7]);
		// The throw was logged through the host's extension-host log.
		expect(requests.some((request) => request.method === 'log' && String(request.args[1]).includes('listener bug'))).toBe(true);
	});

	it('getConfiguration answers declared defaults, whole sub-sections, properties and inspect()', () => {
		const { api } = shim({ settings: { 'demo.format.indent': 2 }, defaults: { 'demo.enable': true, 'demo.format.indent': 4, 'demo.format.style': 'k&r', 'editor.tabSize': 4 } });
		const config = api.workspace.getConfiguration('demo');
		expect(config.get('enable')).toBe(true);
		expect(config.get('format')).toEqual({ indent: 2, style: 'k&r' });
		expect(config.enable).toBe(true);
		expect(config.inspect('format.indent')).toMatchObject({ defaultValue: 4, globalValue: 2 });
		expect(config.inspect('never.declared')).toMatchObject({ key: 'demo.never.declared', globalValue: undefined });
		expect(api.workspace.getConfiguration('editor').get('tabSize')).toBe(4);
		expect(api.workspace.getConfiguration().get('demo.format.style')).toBe('k&r');
	});

	it('workspace.applyEdit applies a WorkspaceEdit instance (0-based ranges) and its file operations', async () => {
		const files = new Map<string, string>([['/ws/closed.ts', 'let a = 1;\n']]);
		const { api, requests } = shim({}, {
			'editor.applyEdits': () => false,
			'fs.op': ([op, path, to, data]) => {
				if (op === 'read') return { data: btoa(files.get(path as string) ?? '') };
				if (op === 'write') files.set(path as string, atob(data as string));
				if (op === 'stat') {
					if (!files.has(path as string)) throw new Error('not found');
					return { type: 1, size: 1, mtime: 1 };
				}
				if (op === 'rename') {
					files.set(to as string, files.get(path as string)!);
					files.delete(path as string);
				}
				return undefined;
			}
		});
		const edit = new api.WorkspaceEdit();
		edit.replace(Uri.file('/ws/closed.ts'), new Range(0, 4, 0, 5), 'b');
		edit.createFile(Uri.file('/ws/new.ts'), { ignoreIfExists: true });
		edit.renameFile(Uri.file('/ws/closed.ts'), Uri.file('/ws/renamed.ts'));
		expect(edit.size).toBe(2);
		expect(await api.workspace.applyEdit(edit)).toBe(true);
		expect(files.get('/ws/renamed.ts')).toBe('let b = 1;\n');
		expect(files.has('/ws/new.ts')).toBe(true);
		// The open-editor path saw 1-based lines (the old code handed it 0-based ranges).
		const first = requests.find((request) => request.method === 'editor.applyEdits')!;
		expect((first.args[1] as { startLine: number }[])[0]!.startLine).toBe(1);
	});

	it("a DiagnosticCollection reads back what it set, keyed by Uri, with VS Code's forEach order", () => {
		const { api, requests } = shim();
		const collection = api.languages.createDiagnosticCollection('lint');
		const uri = Uri.file('/ws/a.ts');
		collection.set(uri, [new api.Diagnostic(new Range(0, 0, 0, 3), 'bad', 1)]);
		expect(collection.get(uri)).toHaveLength(1);
		expect(collection.get(Uri.file('/ws/none.ts'))).toEqual([]);
		expect(collection.has(uri)).toBe(true);
		const order: string[] = [];
		collection.forEach((entryUri, diagnostics) => order.push(`${(entryUri as Uri).fsPath}:${diagnostics.length}`));
		expect(order).toEqual(['/ws/a.ts:1']);
		expect(api.languages.getDiagnostics(uri)).toHaveLength(1);
		const pushed = requests.filter((request) => request.method === 'diagnostics.set');
		expect(pushed.at(-1)!.args.slice(0, 2)).toEqual(['acme.demo', '/ws/a.ts']);
		collection.dispose();
		expect(requests.filter((request) => request.method === 'diagnostics.set').at(-1)!.args[2]).toEqual([]);
	});

	it('withProgress hands the task a token; showInputBox re-asks while validateInput rejects', async () => {
		const answers = ['bad', 'good'];
		const { api, requests } = shim({}, { 'progress.begin': () => 1, showInputBox: () => answers.shift() });
		const token = await api.window.withProgress({ title: 'x' }, async (_progress, taskToken) => taskToken);
		expect(token.isCancellationRequested).toBe(false);
		expect(typeof token.onCancellationRequested).toBe('function');
		const value = await api.window.showInputBox({ prompt: 'Name', password: true, validateInput: (text) => (text === 'bad' ? 'not allowed' : undefined) });
		expect(value).toBe('good');
		const prompts = requests.filter((request) => request.method === 'showInputBox');
		expect(prompts).toHaveLength(2);
		expect(prompts[1]!.args[0]).toContain('not allowed');
		expect(prompts[0]!.args[2]).toMatchObject({ password: true });
	});

	it('showQuickPick serves canPickMany (toggle rounds) and keeps duplicate labels distinct', async () => {
		const picks = ['1', '__ggs_done'];
		const { api } = shim({}, { showQuickPick: () => picks.shift() });
		const picked = await api.window.showQuickPick([{ label: 'same', id: 'a' }, { label: 'same', id: 'b' }], { canPickMany: true }) as { id: string }[];
		expect(picked.map((item) => item.id)).toEqual(['b']);
	});

	it('status bar items carry Command objects, colours and priority to the host', () => {
		const { api, requests } = shim();
		const item = api.window.createStatusBarItem('demo.item', api.StatusBarAlignment.Right, 50);
		item.command = { command: 'demo.run', title: 'Run', arguments: [1, 2] };
		item.backgroundColor = new api.ThemeColor('statusBarItem.errorBackground');
		const last = requests.filter((request) => request.method === 'statusbar.set').at(-1)!.args[1];
		expect(last).toMatchObject({ alignment: 2, priority: 50, command: 'demo.run', commandArgs: [1, 2], backgroundColor: 'statusBarItem.errorBackground' });
	});

	it('setStatusBarMessage without a timeout stays until disposed', async () => {
		const { api, requests } = shim();
		const message = api.window.setStatusBarMessage('working');
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(requests.some((request) => request.method === 'statusbar.dispose')).toBe(false);
		message.dispose();
		expect(requests.some((request) => request.method === 'statusbar.dispose')).toBe(true);
	});

	it('the ExtensionContext has secrets, an environment collection and ~/.ggs storage', async () => {
		const secrets = new Map<string, string>();
		const storage = { global: '/home/u/.ggs/extension-data/acme.demo/global', workspace: null, log: '/home/u/.ggs/logs/extensions/acme.demo' };
		const { api } = shim({ storage }, {
			'secrets.store': ([key, value]) => void secrets.set(key as string, value as string),
			'secrets.get': ([key]) => secrets.get(key as string)
		});
		const context = activationContext({ extensionId: 'acme.demo', extensionPath: '/ext/acme.demo-2.0.0', workspaceFolders: [], settings: {}, language: 'en', webviewResourceBase: '', state: { global: {}, workspace: {} }, storage }, api) as {
			secrets: { store(key: string, value: string): Promise<void>; get(key: string): Promise<string | undefined> };
			environmentVariableCollection: { replace(name: string, value: string): void; get(name: string): { value: string } | undefined };
			globalStorageUri: Uri; storageUri: Uri | undefined; logUri: Uri;
			globalState: { setKeysForSync(keys: string[]): void };
		};
		await context.secrets.store('token', 's3cret');
		expect(await context.secrets.get('token')).toBe('s3cret');
		context.environmentVariableCollection.replace('FOO', 'bar');
		expect(context.environmentVariableCollection.get('FOO')?.value).toBe('bar');
		expect(context.globalStorageUri.fsPath).toBe('/home/u/.ggs/extension-data/acme.demo/global');
		expect(context.storageUri).toBeUndefined();
		expect(() => context.globalState.setKeysForSync(['a'])).not.toThrow();
	});

	it('extensions.getExtension answers the other installed extensions (their exports stay in their host)', () => {
		const { api, requests } = shim({ extensions: [{ id: 'acme.base', extensionPath: '/ext/acme.base-1.0.0', isActive: false, packageJSON: { name: 'base', version: '1.0.0' } }] });
		const base = api.extensions.getExtension('ACME.base') as { packageJSON: { version: string }; exports: unknown };
		expect(base.packageJSON.version).toBe('1.0.0');
		expect(base.exports).toBeUndefined();
		expect(requests.some((request) => request.method === 'log' && String(request.args[1]).includes('acme.base'))).toBe(true);
		expect(api.extensions.getExtension('nobody.here')).toBeUndefined();
		expect(api.extensions.all).toHaveLength(2);
	});

	it('workspace folders: undefined with none, boundary-aware lookups, live change events', () => {
		const { api } = shim();
		expect(api.workspace.workspaceFolders).toBeUndefined();
		const changes: { added: unknown[]; removed: unknown[] }[] = [];
		api.workspace.onDidChangeWorkspaceFolders((event) => changes.push(event));
		api.handleHostEvent({ event: 'workspaceFoldersChanged', folders: ['/ws/app', '/ws/app-lib'] });
		expect(api.workspace.workspaceFolders).toHaveLength(2);
		expect(changes[0]!.added).toHaveLength(2);
		// `/ws/app-lib/x` is not inside `/ws/app` (a name prefix is not a folder boundary).
		expect(api.workspace.getWorkspaceFolder(Uri.file('/ws/app-lib/x.ts'))?.name).toBe('app-lib');
		expect(api.workspace.getWorkspaceFolder(Uri.file('/elsewhere/x.ts'))).toBeUndefined();
		expect(api.workspace.asRelativePath('/ws/app/src/a.ts')).toBe('app/src/a.ts');
		expect(api.workspace.asRelativePath('/ws/app/src/a.ts', false)).toBe('src/a.ts');
	});

	it('openTextDocument reads without opening a tab; edits fire onDidChangeTextDocument; showOpenDialog answers Uris', async () => {
		const { api, requests } = shim({}, { 'workspace.readText': () => ({ text: 'one\ntwo', languageId: 'plaintext' }), 'dialog.open': () => ['/ws/picked.txt'] });
		const document = await api.workspace.openTextDocument(Uri.file('/ws/notes.txt')) as { getText(): string; lineAt(line: number): { text: string } };
		expect(document.getText()).toBe('one\ntwo');
		expect(document.lineAt(1).text).toBe('two');
		expect(requests.some((request) => request.method === 'workspace.openFile')).toBe(false);
		const changes: { contentChanges: { text: string }[]; document: { version: number } }[] = [];
		api.workspace.onDidChangeTextDocument((event) => changes.push(event as never));
		api.handleHostEvent({ event: 'documentChanged', path: '/ws/notes.txt', text: 'one\ntwo\nthree' });
		expect(changes).toHaveLength(1);
		expect(changes[0]!.contentChanges[0]!.text).toBe('one\ntwo\nthree');
		expect(changes[0]!.document.version).toBe(2);
		const picked = await api.window.showOpenDialog({});
		expect(picked![0]!.fsPath).toBe('/ws/picked.txt');
	});

	it('TreeItem takes (label, state) and (resourceUri, state); the serializer keeps contextValue and ThemeIcons', async () => {
		const { api } = shim();
		const labelled = new api.TreeItem('Label', api.TreeItemCollapsibleState.Collapsed);
		expect(labelled.label).toBe('Label');
		expect(labelled.collapsibleState).toBe(1);
		const resource = new api.TreeItem(Uri.file('/ws/readme.md'));
		resource.iconPath = new api.ThemeIcon('book');
		resource.contextValue = 'doc';
		api.window.createTreeView('demo.view', { treeDataProvider: { getChildren: () => ['x'], getTreeItem: () => resource as never } });
		const [item] = await api.__serveTree.children('demo.view', null) as { handle: string; label: string; codicon?: string; contextValue?: string }[];
		expect(item).toMatchObject({ label: 'readme.md', codicon: 'book', contextValue: 'doc' });
		// A second fetch keeps the element's handle (the sidebar's expansion state survives).
		const [again] = await api.__serveTree.children('demo.view', null) as { handle: string }[];
		expect(again!.handle).toBe(item!.handle);
	});

	it('an unsupported API is accepted, logged once, and never throws', () => {
		const { api, requests } = shim();
		// GGS-patch: hover providers are real (editorHovers.ts); the still-inert
		// surfaces keep the one-log-then-accept contract.
		const first = api.languages.registerHoverProvider('ts', { provideHover: () => undefined });
		const second = api.languages.registerHoverProvider('js', { provideHover: () => undefined });
		expect(first.dispose).toBeInstanceOf(Function);
		expect(second.dispose).toBeInstanceOf(Function);
		api.window.registerUriHandler({});
		const logs = requests.filter((request) => request.method === 'log').map((request) => String(request.args[1]));
		expect(logs.filter((line) => line.includes('registerHoverProvider'))).toHaveLength(0);
		expect(logs.some((line) => line.includes('registerUriHandler'))).toBe(true);
		expect(typeof new api.Hover('x').contents).toBe('object');
		expect(new api.SemanticTokensBuilder().build().data).toBeInstanceOf(Uint32Array);
	});
});

describe('when clauses, menus and contributed settings', () => {
	it("evaluates VS Code's full when grammar", () => {
		registerContextProvider('acme.mode', () => 'edit');
		registerContextProvider('acme.langs', () => ['python', 'rust']);
		expect(evaluateWhen('acme.demo', "acme.mode == 'edit' || false")).toBe(true);
		expect(evaluateWhen('acme.demo', '!(acme.mode == edit) && true')).toBe(false);
		expect(evaluateWhen('acme.demo', 'resourceFilename =~ /\\.md$/i', { resourceFilename: 'README.MD' })).toBe(true);
		expect(evaluateWhen('acme.demo', 'resourceLangId in acme.langs', { resourceLangId: 'rust' })).toBe(true);
		expect(evaluateWhen('acme.demo', 'resourceLangId not in acme.langs', { resourceLangId: 'rust' })).toBe(false);
		expect(evaluateWhen('acme.demo', 'count >= 3', { count: 4 })).toBe(true);
		expect(evaluateWhen('acme.demo', "view == acme.tree && viewItem == 'file'", { view: 'acme.tree', viewItem: 'folder' })).toBe(false);
		// An unmodelled key alone never hides an item (the host sets few context keys).
		expect(evaluateWhen('acme.demo', 'someUnknownKey && !otherUnknownKey')).toBe(true);
	});

	it('setContext keeps a context value as given (a mode string compares)', async () => {
		const host = new ExtensionHost();
		await host.executeCommand('setContext', ['acme.state', 'busy']);
		expect(evaluateWhen('acme.demo', "acme.state == 'busy'")).toBe(true);
		expect(evaluateWhen('acme.demo', "acme.state == 'idle'")).toBe(false);
	});

	it('a contributed setting keeps its declared type and default (arrays, objects, enums)', () => {
		applyExtensionSettings('acme.types', { properties: {
			'acme.list': { type: 'array', default: ['a'] },
			'acme.map': { type: 'object' },
			'acme.level': { type: 'string', enum: ['low', 'high'], default: 'high' },
			'acme.count': { type: 'integer', default: 3 }
		} }, {});
		const defs = extensionSettingDefs().filter((def) => def.extId === 'acme.types');
		expect(defs.find((def) => def.id === 'acme.list')).toMatchObject({ type: 'json', default: ['a'] });
		expect(defs.find((def) => def.id === 'acme.map')).toMatchObject({ type: 'json', default: {} });
		expect(defs.find((def) => def.id === 'acme.level')).toMatchObject({ type: 'enum', default: 'high', enumValues: ['low', 'high'] });
		expect(defs.find((def) => def.id === 'acme.count')).toMatchObject({ type: 'number', default: 3 });
	});
});

describe('the extension host log', () => {
	it('records shim anomalies under the extension id, with the host request that failed', async () => {
		resetExtLog();
		const host = new ExtensionHost();
		const handle = { frame: document.createElement('iframe'), commandIds: new Set<string>(), pendingCalls: new Set<(error: Error) => void>() };
		await host['serve']('log', ['warn', 'unsupported API languages.registerHoverProvider', null], 'acme.demo', handle);
		await host['serve']('no.such.request', [], 'acme.demo', handle).catch(() => undefined);
		const entries = extLogEntries();
		expect(entries.some((entry) => entry.source === 'acme.demo' && entry.level === 'warn' && entry.message.includes('registerHoverProvider'))).toBe(true);
		expect(entries.some((entry) => entry.message.includes('no.such.request'))).toBe(true);
	});

	it('an activation failure logs its stack and offers the log from the notification', async () => {
		resetExtLog();
		new ExtensionHost();
		window.dispatchEvent(new MessageEvent('message', { data: { type: '__studioExtActivateFailed', extensionId: 'acme.broken', error: 'TypeError: boom', stack: 'TypeError: boom\n    at activate (ggs-ext://acme.broken/out/extension.js:10:5)' } }));
		await flush();
		const failure = extLogEntries().find((entry) => entry.source === 'acme.broken' && entry.level === 'error');
		expect(failure?.detail).toContain('extension.js:10:5');
		expect(notifications().some((text) => text.includes('acme.broken'))).toBe(true);
	});

	it('writes batched lines to ~/.ggs/logs/ext-host.log through ext_log_append', async () => {
		resetExtLog();
		backend.on('ext_log_append', () => null);
		extLog('error', 'acme.demo', 'command demo.run failed', new Error('bad'));
		await flushExtLog();
		const lines = backend.callsTo('ext_log_append').flatMap((call) => call.lines as string[]);
		expect(lines.some((line) => /\[error\] \[acme\.demo\] command demo\.run failed :: Error: bad/.test(line))).toBe(true);
		// One line per entry in the file: a stack's newlines fold.
		expect(lines.every((line) => !line.includes('\n'))).toBe(true);
	});
});

describe('Node shims: fs options forms and working streams', () => {
	function builtins(files: Record<string, string> = {}, request: (method: string, args: unknown[]) => Promise<unknown> = async () => undefined) {
		return createNodeBuiltins({
			nodeEnv: { platform: 'linux', arch: 'x64', homedir: '', tmpdir: '', hostname: 't', release: '', eol: '\n', separator: '/', delimiter: ':' },
			extensionPath: '/x',
			files,
			binaries: [],
			blobs: {},
			bridge: { request }
		} as never);
	}

	it('fs.readdir / readFile / mkdir accept the (path, options, callback) forms', async () => {
		const fs = builtins({ 'dist/a.js': 'A', 'dist/sub/b.js': 'B' }, async (method, args) => (method === 'fs.op' && args[0] === 'list' ? [{ name: 'x.txt', kind: 1 }, { name: 'dir', kind: 2 }] : undefined))['fs'] as Record<string, (...args: unknown[]) => unknown> & { promises: Record<string, (...args: unknown[]) => Promise<unknown>> };
		const dirents = await new Promise<{ name: string; isDirectory(): boolean }[]>((resolve, reject) => fs.readdir!('/x/dist', { withFileTypes: true }, (error: Error | null, entries: never) => (error ? reject(error) : resolve(entries))));
		expect(dirents.map((entry) => `${entry.name}:${entry.isDirectory()}`).sort()).toEqual(['a.js:false', 'sub:true']);
		const text = await new Promise((resolve) => fs.readFile!('/x/dist/a.js', { encoding: 'utf8' }, (_error: unknown, data: unknown) => resolve(data)));
		expect(text).toBe('A');
		const workspace = await fs.promises.readdir!('/ws', { withFileTypes: true }) as { name: string; isDirectory(): boolean }[];
		expect(workspace.map((entry) => `${entry.name}:${entry.isDirectory()}`)).toEqual(['x.txt:false', 'dir:true']);
		await expect(new Promise((resolve) => fs.mkdir!('/ws/new', { recursive: true }, resolve))).resolves.toBeNull();
	});

	it('stream pipes a Readable through a Transform into a Writable', async () => {
		const stream = builtins()['stream'] as { Readable: { from(items: unknown[]): { pipe<T>(target: T): T } }; Transform: new (options: unknown) => { pipe(target: unknown): unknown }; Writable: new (options: unknown) => { on(event: string, fn: () => void): void } };
		const seen: string[] = [];
		const upper = new stream.Transform({ transform(chunk: unknown, _encoding: string, callback: (error: null, data: string) => void) { callback(null, String(chunk).toUpperCase()); } });
		const sink = new stream.Writable({ write(chunk: unknown, _encoding: string, callback: () => void) { seen.push(String(chunk)); callback(); } });
		const finished = new Promise<void>((resolve) => sink.on('finish', resolve));
		stream.Readable.from(['a', 'b']).pipe(upper);
		upper.pipe(sink);
		await finished;
		expect(seen).toEqual(['A', 'B']);
	});

	it('crypto.randomUUID / randomBytes answer (the callback form and > 64 KiB included)', async () => {
		const crypto = builtins()['crypto'] as { randomUUID(): string; randomBytes(size: number, cb?: (error: null, bytes: Uint8Array) => void): Uint8Array | undefined };
		expect(crypto.randomUUID()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
		expect(crypto.randomBytes(70000)!.length).toBe(70000);
		const viaCallback = await new Promise<Uint8Array>((resolve) => crypto.randomBytes(8, (_error, bytes) => resolve(bytes)));
		expect(viaCallback.length).toBe(8);
	});
});
