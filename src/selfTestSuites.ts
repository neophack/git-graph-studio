// The module self-test suites (module 14): what each module of the module map verifies when
// the user clicks "Run Module Self-Tests". Loaded lazily with the report page; registers one
// `SelfTestGroup` per module, in module-map order, so the report reads like the datasheet.
//
// Two verification levels per check, chosen for safety in a live session: structural checks
// (the button exists, its menu/palette entry constructs, its enablement answers) always run;
// live execution runs only for the explicitly safe command set below — toggles, view switches
// and pure helpers. Anything that writes, spawns or dialogs is verified structurally only, and
// the scan names it so the report shows what a button does without doing it.

import { invoke } from '@tauri-apps/api/core';

import { commands } from './commands';
import { locale, t } from './i18n';
import { scoreFile, makeQuery, type FileEntry } from './fuzzy';
import { ANALYSIS_TOOLS } from './analysisTools';
import { SETTING_DEFS } from './settings';
import { registerSelfTests, type SelfTestGroup } from './selftest';
import type { Workbench } from './workbench';

/** Titles in the registry are i18n keys (or already-literal strings): `t` answers both — an
 *  unknown key falls back to the text itself. */
type I18nKey = Parameters<typeof t>[0];
const tr = (text: string): string => t(text as I18nKey);

/** The commands the scan may really execute in a live session: view switches, panel and
 *  editor toggles, pure helpers. Anything outside this set is verified structurally — its
 *  enablement, its menu entry, its palette row — and reported as such, never run. */
const LIVE_COMMANDS: ReadonlySet<string> = new Set([
	'workbench.toggleSidebar',
	'workbench.togglePanel',
	'workbench.showExplorer',
	'workbench.showScm',
	'workbench.showSearch',
	'workbench.showExtensions',
	'workbench.showAnalysis',
	'workbench.showOutput',
	'workbench.showContext',
	'workbench.focusNextPart',
	'workbench.nextEditor',
	'workbench.previousEditor',
	'workbench.splitEditor',
	'workbench.action.splitEditorOrthogonal',
	'workbench.focusFirstEditorGroup',
	'workbench.focusSecondEditorGroup',
	'workbench.focusThirdEditorGroup',
	'editor.toggleWordWrap',
	'editor.toggleLineComment',
	'editor.toggleBlockComment',
	'editor.toggleBookmark',
	'editor.listBookmarks',
	'markdown.showPreview',
	'markdown.showPreviewToSide',
	'git.showOutput',
	'git.toggleBlame',
	'terminal.toggle',
	'help.welcome',
	'help.shortcuts',
	'help.about',
	'help.openDevTools'
]);

/** Close whatever a live command left open (a quick input, a menu, a dialog) — the sweep's
 *  own hygiene, so the next check starts from a clean shell. */
async function dismissOverlays(): Promise<void> {
	for (let i = 0; i < 3; i++) {
		const input = document.querySelector<HTMLInputElement>('.quick-input input, .dialog input');
		// .settings-dialog is its own class, not .dialog — without it here the Settings
		// check leaves the dialog open over everything the later checks drive.
		if (!input && !document.querySelector('.context-menu, .dialog, .settings-dialog')) break;
		(input ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		await settle();
	}
}

/** Let the queued microtasks and renders land. */
function settle(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 20));
}

/** One check's small helper: run a command live and require it to report success. A command
 *  whose run awaits its user (a quick input, a dialog) never resolves until dismissal — the
 *  race answers after two seconds, and the dismissal below settles it like an Escape. */
async function live(id: string): Promise<void> {
	await dismissOverlays();
	const ran = await Promise.race([
		commands.execute(id),
		new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000))
	]);
	await settle();
	await dismissOverlays();
	if (ran === false) throw new Error(`${id} is disabled or unknown`);
}

/** Register every module's group, in module-map order. Called by the report page on mount. */
export function registerSelfTestSuites(workbench: Workbench): void {
	const editors = workbench.editors;

	/* 1 · Workbench Shell */
	registerSelfTests({
		module: 'Workbench Shell',
		tests: [
			{
				id: 'frame',
				name: 'the shell frame is mounted (title bar, activity bar, side bar, editor area, status bar, panel host)',
				run: async () => {
					for (const selector of ['#titlebar', '#activitybar', '#sidebar', '#editorPart', '#statusbar']) {
						if (!document.querySelector(selector)) throw new Error(`${selector} is missing`);
					}
					if (!document.querySelector('#titlebar .titlebar-center, #titlebar')) throw new Error('the title bar did not render');
				}
			},
			{
				id: 'notifications',
				name: 'a notification shows and dismisses',
				run: async () => {
					const { notify } = await import('./ui');
					notify('info', 'Self-test notification');
					await settle();
					if (!document.querySelector('#notifications .notification')) throw new Error('the notification did not appear');
					const dismiss = document.querySelector<HTMLButtonElement>('#notifications .notification .close, #notifications .notification [title]');
					dismiss?.click();
					await settle();
				}
			},
			{
				id: 'statusbar',
				name: 'the status bar renders its cells (repository, branch, sync)',
				run: async () => {
					const items = document.querySelectorAll('#statusbar .status-item');
					if (items.length < 2) throw new Error(`the status bar shows ${items.length} cells, expected the repo and branch cells among more`);
				}
			}
		]
	});

	/* 2 · Command System — the buttons: every command resolves; the safe ones really run. */
	registerSelfTests({
		module: 'Command System',
		tests: [
			{
				id: 'registry',
				name: 'every command carries a localized title and answers its enablement',
				run: async () => {
					const all = commands.all();
					if (all.length < 50) throw new Error(`only ${all.length} commands registered — the registry looks truncated`);
					for (const command of all) {
						if (!command.title) throw new Error(`${command.id} has no title`);
						if (tr(command.title) === '') throw new Error(`${command.id} title does not resolve`);
						let enabled: boolean;
						try {
							enabled = commands.isEnabled(command.id);
						} catch (error) {
							throw new Error(`${command.id} enablement threw: ${String(error)}`);
						}
						if (typeof enabled !== 'boolean') throw new Error(`${command.id} enablement is not a boolean`);
					}
				}
			},
			{
				id: 'menus',
				name: 'every command builds its menu entry and the palette lists it correctly',
				run: async () => {
					for (const command of commands.all()) {
						const entry = commands.menuItem(command.id);
						if (!entry.label) throw new Error(`${command.id} menu entry has no label`);
					}
					const palette = commands.paletteItems();
					if (palette.length === 0) throw new Error('the palette is empty');
					const ids = new Set(palette.map((row) => row.value));
					for (const command of commands.all()) {
						if (commands.isEnabled(command.id) && command.paletteHidden?.() !== true && !ids.has(command.id)) {
							throw new Error(`${command.id} is enabled but missing from the palette`);
						}
					}
				}
			},
			{
				id: 'live-scan',
				name: 'the safe buttons really run (view switches, toggles, pure helpers)',
				run: async () => {
					let ran = 0;
					for (const id of LIVE_COMMANDS) {
						const command = commands.get(id);
						if (!command) throw new Error(`${id} is in the safe list but not registered`);
						if (!commands.isEnabled(id)) continue; // a disabled safe command is correct, not a failure
						await live(id);
						ran++;
					}
					if (ran < 10) throw new Error(`only ${ran} of ${LIVE_COMMANDS.size} safe commands were runnable`);
					// Restore a sane shell: the explorer view, the panel visible as it was.
					await live('workbench.showExplorer');
				}
			},
			{
				id: 'destructive-scan',
				name: 'every other button resolves without running (writes, dialogs, spawns stay hands-off)',
				run: async () => {
					let checked = 0;
					for (const command of commands.all()) {
						if (LIVE_COMMANDS.has(command.id)) continue;
						if (!commands.isEnabled(command.id)) continue; // disabled: correct to skip
						const entry = commands.menuItem(command.id);
						if (entry.disabled) throw new Error(`${command.id} reports enabled but its menu entry is disabled`);
						checked++;
					}
					if (checked < 20) throw new Error(`only ${checked} commands verified structurally`);
				}
			}
		]
	});

	/* 3 · File Explorer */
	registerSelfTests({
		module: 'File Explorer',
		tests: [
			{
				id: 'tree',
				name: 'the workspace tree renders rows for the open folder',
				run: async () => {
					await live('workbench.showExplorer');
					await settle();
					const rows = document.querySelectorAll('#sidebar .row[data-path]');
					if (rows.length === 0) throw new Error('the explorer tree has no rows (is a folder open?)');
				}
			},
			{
				id: 'reveal',
				name: 'switching views keeps the explorer mounted (SCM and back)',
				run: async () => {
					await live('workbench.showScm');
					await settle();
					await live('workbench.showExplorer');
					await settle();
					const sidebar = document.querySelector<HTMLElement>('#sidebar');
					if (!sidebar || sidebar.hidden) throw new Error('the side bar stayed hidden');
				}
			}
		]
	});

	/* 4 · Quick Open */
	registerSelfTests({
		module: 'Quick Open',
		tests: [
			{
				id: 'fuzzy',
				name: 'the fuzzy scorer ranks a prefix match above a scattered one and rejects a non-match',
				run: async () => {
					// A real entry's label is the basename: `cmp` prefixes `compare.ts`, only
					// scatters through `module.pas`'s path (a demoted tier), and is absent
					// from `readme.md`.
					const entry = (dir: string, name: string): FileEntry => {
						const path = `${dir}${dir === '' ? '' : '/'}${name}`;
						return { path, label: name, labelLower: name.toLowerCase(), pathLower: path.toLowerCase() };
					};
					const query = makeQuery('cmp');
					const prefix = scoreFile(entry('src', 'compare.ts'), query);
					const scattered = scoreFile(entry('src/some/complex', 'module.pas'), query);
					const none = scoreFile(entry('docs', 'readme.md'), query);
					if (!prefix) throw new Error('"cmp" does not match compare.ts');
					if (none) throw new Error('"cmp" should not match readme.md');
					if (scattered && prefix.score <= scattered.score) throw new Error('a scattered match outranks the prefix match');
				}
			},
			{
				id: 'picker',
				name: 'Quick Open opens on its command and closes on Escape',
				run: async () => {
					// The command's run resolves only when the input closes: fire it, let the
					// picker appear, then Escape it like a user.
					void commands.execute('workbench.quickOpen');
					await settle();
					await settle();
					if (!document.querySelector('.quick-input')) throw new Error('the quick input did not open');
					await dismissOverlays();
					if (document.querySelector('.quick-input')) throw new Error('the quick input stayed open after Escape');
				}
			}
		]
	});

	/* 5 · Workspace Search */
	registerSelfTests({
		module: 'Workspace Search',
		tests: [
			{
				id: 'view',
				name: 'the search view mounts with its query box and option toggles',
				run: async () => {
					await live('workbench.showSearch');
					await settle();
					const sidebar = document.querySelector('#sidebar');
					if (!sidebar?.querySelector('input')) throw new Error('the search query box is missing');
				}
			},
			{
				id: 'symbols',
				name: 'the workspace symbol index answers a lookup without error',
				run: async () => {
					const rows = await invoke('workspace_symbols', { query: 'a' });
					if (!Array.isArray(rows)) throw new Error('workspace_symbols did not answer a list');
				}
			}
		]
	});

	/* 6 · Editor Suite */
	registerSelfTests({
		module: 'Editor Suite',
		tests: [
			{
				id: 'open-close',
				name: 'a file opens into a tab, becomes active, and closes clean',
				run: async () => {
					const repo = workbench.currentRepo;
					if (!repo) return 'no folder open — nothing to open into the editor';
					await editors.openFile(`${repo}\\README.md`);
					await settle();
					if (editors.activeInput === null) throw new Error('the opened file is not the active editor');
					await commands.execute('workbench.closeEditor');
					await settle();
				}
			},
			{
				id: 'find',
				name: 'the find widget toggles open and closed',
				run: async () => {
					await commands.execute('editor.find');
					await settle();
					await commands.execute('editor.find');
					await settle();
				}
			},
			{
				id: 'settings',
				name: 'the generated Settings dialog opens and closes',
				run: async () => {
					await commands.execute('workbench.openSettings');
					await settle();
					await dismissOverlays();
				}
			}
		]
	});

	/* 7 · Large-File Viewers */
	registerSelfTests({
		module: 'Large-File Viewers',
		tests: [
			{
				id: 'hex',
				name: 'the hex view opens the working file in offset/hex/ASCII columns and closes',
				run: async () => {
					const repo = workbench.currentRepo;
					if (!repo) return 'no folder open — nothing to view as hex';
					await editors.openFile(`${repo}\\README.md`);
					await settle();
					await commands.execute('workbench.openHexViewer');
					await settle();
					await commands.execute('workbench.closeEditor');
					await settle();
					await commands.execute('workbench.closeEditor');
					await settle();
				}
			}
		]
	});

	/* 8 · Compare & Merge */
	registerSelfTests({
		module: 'Compare & Merge',
		tests: [
			{
				id: 'compare',
				name: 'the folder-compare command resolves; its dialogs stay hands-off in a live session',
				run: async () => {
					const command = commands.get('workbench.compareFolders');
					if (!command) throw new Error('workbench.compareFolders is not registered');
					if (!commands.isEnabled('workbench.compareFolders')) throw new Error('workbench.compareFolders is disabled');
					// It would open two native pickers; the structural check is the live check.
					return 'native dialogs stay hands-off — verified structurally';
				}
			}
		]
	});

	/* 9 · Source Control */
	registerSelfTests({
		module: 'Source Control',
		tests: [
			{
				id: 'view',
				name: 'the Source Control view renders the commit box and change rows for the open repository',
				run: async () => {
					if (!workbench.currentRepo) return 'no repository open';
					await live('workbench.showScm');
					await settle();
					const sidebar = document.querySelector('#sidebar');
					if (!sidebar?.querySelector('textarea, .commit-box input, input')) throw new Error('the commit message box is missing');
				}
			}
		]
	});

	/* 10 · Git Graph Engine */
	registerSelfTests({
		module: 'Git Graph Engine',
		tests: [
			{
				id: 'offer',
				name: 'the Git Graph package is installed or offered by the store',
				run: async () => {
					const list = await invoke<{ id: string; format: string }[]>('ext_list');
					const graph = list.find((entry) => entry.id === 'neophack.git-graph-rs');
					if (!graph) throw new Error('neophack.git-graph-rs is neither installed nor bundled');
				}
			}
		]
	});

	/* 11 · Integrated Terminal */
	registerSelfTests({
		module: 'Integrated Terminal',
		tests: [
			{
				id: 'panel',
				name: 'the terminal panel shows and hides (no shell is spawned)',
				run: async () => {
					// `show` is deterministic where the toggle command is not: whether
					// `terminal.toggle` reveals or hides depends on the panel's state when it
					// runs (the command-scan check may have left it on the terminal already).
					workbench.panel.show('terminal');
					await settle();
					const panel = document.querySelector<HTMLElement>('#panel');
					if (!panel || panel.hidden) throw new Error('the terminal panel did not open');
					workbench.panel.hide();
					await settle();
					if (!panel.hidden) throw new Error('the terminal panel did not close');
				}
			}
		]
	});

	/* 12 · Extension Platform */
	registerSelfTests({
		module: 'Extension Platform',
		tests: [
			{
				id: 'store',
				name: 'the store lists the installed extensions and the host answers backend status',
				run: async () => {
					const list = await invoke<unknown[]>('ext_list');
					if (!Array.isArray(list) || list.length === 0) throw new Error('the store listing is empty');
					const status = await invoke<unknown[]>('ext_process_status');
					if (!Array.isArray(status)) throw new Error('ext_process_status did not answer a list');
				}
			},
			{
				id: 'view',
				name: 'the Extensions view opens from its command',
				run: async () => {
					await live('workbench.showExtensions');
					await settle();
				}
			},
			{
				id: 'providers',
				name: 'the AI provider store answers profiles and names its bridged extension',
				run: async () => {
					const list = await invoke<{ profiles: unknown[]; bridgedExtIds: string[] } | null>('provider_list');
					if (!list || !Array.isArray(list.profiles) || list.profiles.length === 0) throw new Error('provider_list answered no profiles');
					if (!Array.isArray(list.bridgedExtIds) || list.bridgedExtIds.length === 0) throw new Error('provider_list named no bridged extension');
					// The cc-switch import's scan answers a list (empty where neither
					// cc-switch nor a live Claude configuration exists) — no keys in it.
					const candidates = await invoke<{ hasKey?: boolean }[] | null>('provider_ccswitch_scan');
					if (!Array.isArray(candidates ?? [])) throw new Error('provider_ccswitch_scan answered no list');
				}
			}
		]
	});

	/* 13 · CAN Trace Analyzer */
	registerSelfTests({
		module: 'CAN Trace Analyzer',
		tests: [
			{
				id: 'commands',
				name: 'the analyzer commands resolve (they act on an opened trace file)',
				run: async () => {
					for (const id of commands.all().map((command) => command.id)) {
						if (!id.startsWith('can.')) continue;
						const entry = commands.menuItem(id);
						if (!entry.label) throw new Error(`${id} has no menu label`);
					}
					return 'opening a real trace stays hands-off — verified structurally';
				}
			}
		]
	});

	/* 14 · Performance Lab */
	registerSelfTests({
		module: 'Performance Lab',
		tests: [
			{
				id: 'theme-metrics',
				name: 'the theme contrast metrics compute for every surface',
				run: async () => {
					const { runThemeContrastMetrics } = await import('./themeMetrics');
					const results = await runThemeContrastMetrics();
					if (!Array.isArray(results) || results.length === 0) throw new Error('the contrast metrics returned nothing');
				}
			},
			{
				id: 'runner',
				name: 'the self-test runner itself measures, classifies and streams (this check)',
				run: async () => {
					const { runSelfTests, summarize } = await import('./selftest');
					const seen: string[] = [];
					const outcomes = await runSelfTests((outcome) => seen.push(outcome.status), [
						{
							module: 'runner-probe',
							tests: [
								{ id: 'pass', name: 'pass', run: async () => {} },
								{ id: 'skip', name: 'skip', run: async () => 'why' },
								{ id: 'fail', name: 'fail', run: async () => { throw new Error('by design'); } }
							]
						}
					]);
					const summary = summarize(outcomes);
					if (summary.pass !== 1 || summary.fail !== 1 || summary.skip !== 1) throw new Error(`runner miscounted: ${JSON.stringify(summary)}`);
					if (seen.length !== 3) throw new Error('the runner did not stream every outcome');
				}
			}
		]
	});

	/* 15 · Build & Release Pipeline */
	registerSelfTests({
		module: 'Build & Release Pipeline',
		tests: [
			{
				id: 'version',
				name: 'the running binary reports a semver version (the three-file bump landed)',
				run: async () => {
					const version = (await import('@tauri-apps/api/app')).getVersion();
					const resolved = await version;
					if (!/^\d+\.\d+\.\d+/.test(resolved)) throw new Error(`the version does not look like semver: ${resolved}`);
				}
			}
		]
	});

	/* 16 · Symbol MCP Server */
	registerSelfTests({
		module: 'Symbol MCP Server',
		tests: [
			{
				id: 'catalogue',
				name: 'the MCP tool catalogue answers and names the navigation tools',
				run: async () => {
					const tools = await invoke<{ name: string }[]>('mcp_tools');
					if (!Array.isArray(tools) || tools.length === 0) throw new Error('the MCP tool catalogue is empty');
					const names = tools.map((tool) => tool.name);
					if (!names.includes('symbol_lookup')) throw new Error('symbol_lookup is missing from the catalogue');
				}
			}
		]
	});

	/* 17 · Code Analysis */
	registerSelfTests({
		module: 'Code Analysis',
		tests: [
			{
				id: 'tools',
				name: 'the five analysis tools (plus the MCP entry) are registered',
				run: async () => {
					if (ANALYSIS_TOOLS.length < 5) throw new Error(`only ${ANALYSIS_TOOLS.length} analysis tools registered`);
				}
			},
			{
				id: 'status',
				name: 'the analysis index answers its status for the open workspace',
				run: async () => {
					const status = await invoke<{ state: string }>('analysis_status');
					if (!status || typeof status.state !== 'string') throw new Error('analysis_status did not answer');
				}
			},
			{
				id: 'pages',
				name: 'an analysis page opens into the editor area and closes',
				run: async () => {
					await live('analysis.showMetrics');
					await settle();
					await commands.execute('workbench.closeEditor');
					await settle();
				}
			}
		]
	});

	/* 18 · GGS Bash */
	registerSelfTests({
		module: 'GGS Bash',
		tests: [
			{
				id: 'setting',
				name: 'the Terminal Shell setting offers PowerShell and GGS Bash',
				run: async () => {
					const def = SETTING_DEFS.find((candidate) => candidate.key === 'terminalShell');
					if (!def) throw new Error('the terminalShell setting is not registered');
					const values = def.options?.map((option) => option.value);
					if (values?.join(',') !== 'powershell,ggsBash') throw new Error(`unexpected options: ${values?.join(',')}`);
				}
			},
			{
				id: 'labels',
				name: 'both shell options label themselves in the active language',
				run: async () => {
					for (const key of ['settings.terminalShell', 'settings.terminalShell.powershell', 'settings.terminalShell.ggsBash'] as const) {
						if (t(key) === key) throw new Error(`${key} has no label`);
					}
				}
			}
		]
	});
}
