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
import { click, flush, key, notificationButton, notifications, type } from './helpers';

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
		// Built-ins have no uninstall button; user extensions do.
		expect(document.querySelectorAll('.ext-row')[0]!.querySelector('.action-btn')).toBeNull();
		expect(document.querySelectorAll('.ext-row')[1]!.querySelector('.action-btn')).not.toBeNull();
	});

	it('installs from a picked VSIX and refreshes', async () => {
		backend.dialog.openResult = 'C:\\downloads\\acme.demo-2.1.0.vsix';
		const installed: ExtInfo = { ...USER, version: '2.1.0' };
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

	it('installs a .ggx package through its own command', async () => {
		backend.dialog.openResult = 'C:\downloadscme.demo-2.1.0.ggx';
		const installed: ExtInfo = { ...USER, version: '2.1.0', format: 'ggx' };
		backend.on('ext_install_from_ggx', () => installed);
		const panel = mountedPanel();
		await panel.refresh();
		await panel.installFromVsixCommand();
		expect(backend.callsTo('ext_install_from_ggx')).toEqual([{ path: 'C:\downloadscme.demo-2.1.0.ggx' }]);
		expect(backend.callsTo('ext_install_from_vsix')).toEqual([]);
		expect(notifications().join()).toContain('acme.demo v2.1.0');
	});

	it('surfaces the refusal when a package of the integrated extension is installed', async () => {
		backend.dialog.openResult = 'C:\downloads\git-graph-rs-1.0.24.ggx';
		backend.on('ext_install_from_ggx', () => { throw 'neophack.git-graph-rs is built into Git Graph Studio; its version follows the application'; });
		const panel = mountedPanel();
		await panel.refresh();
		await panel.installFromVsixCommand();
		expect(notifications().join()).toContain('built into Git Graph Studio');
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

	it('throws a clear error for unsupported APIs', () => {
		const api = createVscodeApi(
			{ extensionId: 'x', extensionPath: '/x', workspaceFolders: [], settings: {}, language: 'en' },
			{ request: async () => undefined, registerCommandHandler: () => undefined }
		);
		expect(() => api.window.createWebviewPanel('viewType', 'title', { enableScripts: false })).toThrow('not supported');
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
				context: { extensionId: 'acme.demo', extensionPath: '/ext/acme.demo-2.0.0', workspaceFolders: [], settings: {}, language: 'en' },
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
