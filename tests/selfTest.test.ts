// The module self-tests' own tests: the runner's classification and report, the group
// registry's replace-on-re-register, and — the point of the whole feature — every suite
// check passing against the scripted backend on a full boot, the same assertion the
// in-app "Run Module Self-Tests" click makes against the real one.

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { Workbench } from '../src/workbench';
import * as selftest from '../src/selftest';
import { registerSelfTestSuites } from '../src/selfTestSuites';
import { backend } from './tauriMock';
import { flush } from './helpers';

// The version probe has no Tauri runtime; the suites script its answers.
vi.mock('mermaid', () => import('./mermaidStub'));
vi.mock('@mermaid-js/layout-elk', () => ({ default: {} }));
vi.mock('@tauri-apps/api/app', () => ({ getVersion: async () => '0.1.5' }));

const REPO = 'C:\\repo';
const NOTES = `${REPO}\\notes.txt`;
const README = `${REPO}\\README.md`;

class DefaultingHandlers extends Map<string, (args: Record<string, unknown>) => unknown> {
	override get(command: string) {
		return super.get(command) ?? (() => null);
	}
}

let workbench: Workbench;

beforeAll(async () => {
	await import('../src/textEditor');
});

beforeEach(async () => {
	localStorage.clear();
	document.body.innerHTML = `
		<div id="titlebar"></div>
		<div id="workbench">
			<div id="activitybar"></div>
			<div id="sidebar"></div>
			<div id="sidebarSash"></div>
			<div id="editorPart"><div id="editorGroup"></div><div id="panelSash" hidden></div><div id="panel" hidden></div></div>
		</div>
		<div id="statusbar"></div>
		<div id="notifications"></div>
		<div id="overlays"></div>`;
	workbench?.dispose();
	backend.reset();
	backend.handlers = new DefaultingHandlers([
		['boot_context', () => ({ file: null, actions: [], repo: REPO })],
		['open_folder', ({ path }) => ({ root: path, isRepo: true })],
		['boot_stage', () => null],
		['list_dir', () => [{ name: 'notes.txt', path: NOTES, isDir: false, size: 12 }, { name: 'README.md', path: README, isDir: false, size: 4 }]],
		['list_files', () => ['notes.txt', 'README.md']],
		['read_file', () => ({ contents: 'one two one\nthree\n', binary: false, size: 12, encoding: 'utf8', eol: 'lf' })],
		['read_file_at', () => ({ contents: 'one\n', binary: false, size: 3 })],
		['repo_head', () => ({ branch: 'main', shortHash: 'abc1234', ahead: 0, behind: 0, upstream: 'origin/main' })],
		['scm_status', () => [{ path: 'notes.txt', oldPath: null, staged: 'modified', unstaged: null, untracked: false, conflicted: false }]],
		['scm_branches', () => [{ name: 'main', remote: false, current: true, upstream: 'origin/main' }]],
		['scm_remotes', () => [{ name: 'origin', url: 'https://example.com/r.git' }]],
		['scm_tags', () => ['v1']],
		['scm_stashes', () => []],
		['workspace_symbols', () => [{ kind: 'function', name: 'two', path: 'notes.txt', line: 1 }]],
		['analysis_status', () => ({ state: 'ready', done: 2, total: 2, files: 2, symbols: 3, calls: 2 })],
		['mcp_tools', () => [{ name: 'symbol_lookup', description: 'look up a symbol' }]],
		['mcp_log', () => []],
		['ext_list', () => [{ id: 'neophack.git-graph-rs', format: 'vsix' }]],
		['ext_process_status', () => [{ extensionId: 'neophack.git-graph-rs', pid: 4321, commands: [], protocolVersion: 'ggs-ext/1', startCount: 1, lastError: null }]],
		['provider_list', () => ({ activeId: 'official', profiles: [{ id: 'official', preset: 'official', label: 'Official Claude', baseUrl: null, model: null, smallModel: null, hasKey: false, keyHint: null }], presets: [], bridgedExtIds: ['Anthropic.claude-code'] })],
		['provider_ccswitch_scan', () => []],
		['settings_read', () => null],
		['keybindings_read', () => null],
		['backup_list', () => []],
		['git_output_log', () => ['> git status']]
	] as [string, (args: Record<string, unknown>) => unknown][]);
	(window as unknown as { markdownIt: unknown }).markdownIt = { render: (text: string) => `<p>${text}</p>` };
	workbench = new Workbench();
	await workbench.boot();
	await flush(10);
});

describe('the self-test runner', () => {
	it('classifies pass, skip and fail, streams every outcome, and counts the summary', async () => {
		const streamed: string[] = [];
		const outcomes = await selftest.runSelfTests((outcome) => streamed.push(`${outcome.id}:${outcome.status}`), [
			{
				module: 'probe',
				tests: [
					{ id: 'good', name: 'good', run: async () => {} },
					{ id: 'skipped', name: 'skipped', run: async () => 'why not' },
					{ id: 'broken', name: 'broken', run: async () => { throw new Error('by design'); } }
				]
			}
		]);
		expect(streamed).toEqual(['good:pass', 'skipped:skip', 'broken:fail']);
		expect(outcomes.map((outcome) => outcome.status)).toEqual(['pass', 'skip', 'fail']);
		expect(outcomes[2].message).toBe('by design');
		expect(outcomes.every((outcome) => outcome.ms >= 1)).toBe(true);
		const summary = selftest.summarize(outcomes);
		expect(summary).toMatchObject({ pass: 1, fail: 1, skip: 1 });
	});

	it('a stop request ends the sweep after the check in flight', async () => {
		// The Stop button used to only filter the display — the runner kept executing
		// every remaining check. The runner now takes the page's stop flag.
		const group = {
			module: 'stop-probe',
			tests: [
				{ id: 'first', name: 'first', run: async () => {} },
				{ id: 'second', name: 'second', run: async () => {} },
				{ id: 'third', name: 'third', run: async () => {} }
			]
		};
		const streamed: string[] = [];
		let seen = 0;
		const outcomes = await selftest.runSelfTests(
			(outcome) => {
				streamed.push(outcome.id);
				seen += 1;
			},
			[group],
			() => seen >= 1 // stop once the first check landed
		);
		expect(streamed).toEqual(['first']);
		expect(outcomes).toHaveLength(1);
	});

	it('re-registering a module replaces its group instead of duplicating it', () => {
		const before = selftest.selfTestGroups().length;
		selftest.registerSelfTests({ module: 're-register-probe', tests: [{ id: 'a', name: 'a', run: async () => {} }] });
		selftest.registerSelfTests({ module: 're-register-probe', tests: [{ id: 'b', name: 'b', run: async () => {} }] });
		const groups = selftest.selfTestGroups().filter((group) => group.module === 're-register-probe');
		expect(groups.length).toBe(1);
		expect(groups[0].tests.map((test) => test.id)).toEqual(['b']);
		selftest.registerSelfTests({ module: 're-register-probe', tests: [] });
		expect(selftest.selfTestGroups().length).toBe(before);
	});

	it('the markdown report opens with the summary and names only the non-passes', async () => {
		const outcomes = await selftest.runSelfTests(() => undefined, [
			{
				module: 'report-probe',
				tests: [
					{ id: 'good', name: 'the good one', run: async () => {} },
					{ id: 'bad', name: 'the bad one', run: async () => { throw new Error('it broke'); } }
				]
			}
		]);
		const report = selftest.reportMarkdown(outcomes);
		expect(report).toContain('report-probe — 1/2 passed');
		expect(report).toContain('FAIL: the bad one — it broke');
		expect(report).not.toContain('the good one');
	});
});

describe('the module suites', () => {
	it('every module of the module map has a self-test group, in order', () => {
		registerSelfTestSuites(workbench);
		const modules = selftest.selfTestGroups().map((group) => group.module);
		expect(modules).toEqual([
			'Workbench Shell', 'Command System', 'File Explorer', 'Quick Open', 'Workspace Search',
			'Editor Suite', 'Large-File Viewers', 'Compare & Merge', 'Source Control',
			'Git Graph Engine', 'Integrated Terminal', 'Extension Platform', 'CAN Trace Analyzer',
			'Performance Lab', 'Build & Release Pipeline', 'Symbol MCP Server', 'Code Analysis'
		]);
	});

	it('every check passes against the scripted backend', { timeout: 120_000 }, async () => {
		registerSelfTestSuites(workbench);
		const failures: string[] = [];
		const outcomes = await selftest.runSelfTests((outcome) => {
			if (outcome.status === 'fail') failures.push(`${outcome.module}/${outcome.id}: ${outcome.message}`);
		});
		expect(failures).toEqual([]);
		expect(outcomes.length).toBeGreaterThanOrEqual(25);
	});
});
