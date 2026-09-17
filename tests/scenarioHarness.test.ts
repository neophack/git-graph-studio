// The scenario harness: the real workbench booted against each scripted repository state (and
// the non-git folders) from scenarioFixtures.ts, driven the way a user would, asserting what
// becomes visible - the SCM groups, the status bar, the graph tab, the conflict toolbar, a
// file open. After the run, a markdown report lands in target/studio/scenario-report.md.

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { Workbench } from '../src/workbench';
import { commands } from '../src/commands';
import { SCENARIOS, handlersFor, type Scenario } from './scenarioFixtures';
import { backend } from './tauriMock';
import { click, flush, texts } from './helpers';

const REPO = 'C:\\repo';

function shell(): void {
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
}

/** What the harness observed in one scenario (the report's columns). */
interface Observation {
	scenario: Scenario;
	/** Facts the per-scenario expectation asserted (kept for the report on success). */
	notes: string[];
	error: string | null;
}

const observations: Observation[] = [];

beforeAll(async () => {
	await import('../src/textEditor'); // pay the editor chunk's transform once
});

/** Boot the workbench against a scenario and gather the shared observations. */
async function bootScenario(scenario: Scenario): Promise<Workbench> {
	localStorage.clear();
	shell();
	backend.reset();
	backend.handlers = handlersFor(scenario);
	const workbench = new Workbench();
	await workbench.boot();
	await flush(12);
	return workbench;
}

/** The SCM view is the third sidebar view (explorer, search, scm, extensions). */
function scmView(): HTMLElement {
	return document.querySelectorAll<HTMLElement>('.view')[2]!;
}

/** The SCM group headers with their counts: 'Staged Changes 1', 'Changes 2', ... */
function scmGroups(): string[] {
	const KNOWN = ['Merge Changes', 'Staged Changes', 'Changes'];
	return Array.from(scmView().querySelectorAll('.pane-header'))
		.filter((header) => KNOWN.includes(header.querySelector('.label')?.textContent ?? ''))
		.map((header) => `${header.querySelector('.label')!.textContent} ${header.querySelector('.badge')!.textContent}`);
}

function statusItems(): string[] {
	return texts('.status-item:not([hidden])');
}

describe('the scenario harness', () => {

	for (const scenario of SCENARIOS) {
		it(`covers ${scenario.name} (${scenario.situation})`, { timeout: 30_000 }, async () => {
			const workbench = await bootScenario(scenario);
			const notes: string[] = [];
			try {
				if (scenario.kind === 'git') {
					// Shared expectations: the shell is up, the graph tab is there, nothing errored.
					expect(texts('.tab .label')).toContain('Git Graph');
					// The repository chrome is up (the branch settles asynchronously).
					expect(statusItems().length).toBeGreaterThan(1);
					notes.push(`status: ${statusItems().join(' | ')}`);
					notes.push(`scm: ${scmGroups().join(', ') || '(no changes)'}`);
				} else {
					// A plain folder: the graph tab shows its "initialise a repository" placeholder,
					// but the status bar carries no repository item and no branch.
					expect(statusItems().some((item) => item.includes('Git Graph'))).toBe(false);
					expect(statusItems()).not.toContain('main');
					notes.push(`status: ${statusItems().join(' | ')}`);
				}

				// The per-scenario expectations.
				switch (scenario.name) {
					case 'empty-repository':
						// No branch name to show; the Changes group is there, empty (its 'always' group).
						expect(statusItems().some((item) => item === 'main')).toBe(false);
						expect(scmGroups()).toEqual(['Changes 0']);
						break;
					case 'clean-repository':
						expect(statusItems()).toContain('main');
						expect(scmGroups()).toEqual(['Changes 0']);
						break;
					case 'mixed-changes': {
						const groups = scmGroups();
						expect(groups).toContain('Staged Changes 1');
						expect(groups).toContain('Changes 3'); // unstaged edit, untracked, deletion
						break;
					}
					case 'merge-conflict': {
						expect(scmGroups()).toContain('Merge Changes 1');
						expect(statusItems().some((item) => item.includes('1 conflict'))).toBe(true);
						// Opening the conflicted file shows the conflict toolbar.
						const row = Array.from(scmView().querySelectorAll<HTMLElement>('.row')).find((r) => r.textContent!.includes('conflicted.txt'));
						click(row!);
						await flush(10);
						expect(document.querySelector('.merge-bar')).not.toBeNull();
						notes.push('conflict toolbar: shown');
						break;
					}
					case 'detached-head':
						expect(statusItems()).toContain('0123456');
						break;
				case 'ahead-and-behind': {
					// The repo name, the branch and the sync counts are separate items; both
					// counts ride the sync item, none on the branch.
					expect(statusItems()).toContain('repo');
					expect(statusItems()).toContain('main');
					const sync = statusItems().find((item) => item.trim().startsWith('2'));
					expect(sync).toContain('3');
					break;
				}
					case 'branches-and-tags':
						// The current branch settles in the status bar; the listing rides the graph's
						// repository info (inside the iframe - not observable from jsdom).
						expect(statusItems()).toContain('main');
						break;
					case 'stash-present':
						// The stash is the graph view's to expose (its iframe does not run in jsdom);
						// here the repository stays healthy around it.
						expect(statusItems()).toContain('main');
						break;
					case 'plain-folder': {
						// The explorer lists the folder; a file opens; the SCM view is idle.
						expect(texts('.tree .row .label')).toContain('notes.txt');
						const fileRow = Array.from(document.querySelectorAll<HTMLElement>('.tree .row')).find((r) => r.textContent!.includes('notes.txt'));
						click(fileRow!);
						await flush(10);
						expect(texts('.tab .label')).toContain('notes.txt');
						notes.push('file open works without a repository');
						break;
					}
					case 'empty-folder':
						expect(texts('.tree .row .label')).toEqual([]);
						break;
				}
				observations.push({ scenario, notes, error: null });
			} catch (error) {
				observations.push({ scenario, notes, error: String(error) });
				throw error;
			} finally {
				workbench.dispose();
			}
		});
	}

	// The report: written after the last scenario ran, green or red - the file is the point.
	it('writes the scenario report', () => {
		expect(observations.length).toBe(SCENARIOS.length);
		const rows = observations.map(({ scenario, notes, error }) =>
			`| ${scenario.name} | ${scenario.kind} | ${scenario.situation} | ${error === null ? 'PASS' : 'FAIL'} | ${notes.join(' · ') || '-'}${error ? ` · \`${error.slice(0, 140)}\`` : ''} |`);
		const markdown = [
			'# Scenario harness report', '',
			`Generated ${new Date().toISOString()} by \`tests/scenarioHarness.test.ts\` - the real workbench against each scripted state (\`tests/scenarioFixtures.ts\`).`, '',
			'| Scenario | Kind | Situation | Result | Observed |',
			'|---|---|---|---|---|',
			...rows, ''
		].join('\n');
		const target = resolve(process.cwd(), 'target', 'studio', 'scenario-report.md');
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, markdown, 'utf8');
	});
});

describe('the search command seeds from the active editor', () => {
	it('the word at the caret - or a single-line selection - opens as the query (Zed\'s query_suggestion)', async () => {
		const clean = SCENARIOS.find((scenario) => scenario.name === 'clean-repository')!;
		const workbench = await bootScenario(clean);
		await workbench.editors.openFile(`${REPO}\\notes.txt`);
		await flush(8);
		const view = workbench.editors.activeView!;
		expect(view.state.doc.toString()).toBe('one two one\n');
		// The caret inside "two": Ctrl+Shift+F opens the Search view with that word as its
		// query, selected, ready to be typed over.
		view.dispatch({ selection: { anchor: 5 } });
		await commands.execute('workbench.showSearch');
		const input = document.querySelector('#sidebar .search-row.query-row input') as HTMLInputElement;
		expect(input.value).toBe('two');
		expect(input.selectionStart).toBe(0);
		expect(input.selectionEnd).toBe(3);
		// A single-line selection wins over the word at the caret.
		view.dispatch({ selection: { anchor: 0, head: 3 } });
		await commands.execute('workbench.showSearch');
		expect(input.value).toBe('one');
	});
});
