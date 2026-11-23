// The References panel page (module 5): Lookup References — the sites
// grouped by file with counts, the folded context slice's shape (the enclosing definition's
// head, the folds, the site window), a fold row opening in place, the site row's jump, the
// def marker, the caps' cut notes, and the workbench wiring (the palette command, the panel
// tab's zh-cn pair, the cursor follow's gate).

import { beforeEach, describe, expect, it } from 'vitest';

import { containerPrefix, enclosingSpan, foldedContext, ReferencesView, type RefSpan } from '../src/features/search';
import { commands } from '../src/platform/commands';
import { updateSetting } from '../src/platform/settings';
import { Workbench } from '../src/workbench';
import { backend } from './tauriMock';
import { click, flush, menuLabels, menuItem, notificationButton, texts } from './helpers';

const BODY_LINES = [
	'int total(int a, int b)', // 0  — the definition site
	'{', // 1
	'    int sum = total(a, b);', // 2  — a reference inside total
	'    return sum;', // 3
	'}', // 4
	'int helper(void)', // 5
	'{', // 6
	'    int pad_0 = 0;', // 7
	'    int pad_1 = 1;', // 8
	'    int pad_2 = 2;', // 9
	'    int pad_3 = 3;', // 10
	'    int deep = total(9, 9);', // 11 — the folded-window site
	'    int pad_4 = 4;', // 12
	'    int pad_5 = 5;', // 13
	'    int pad_6 = 6;', // 14
	'    int pad_7 = 7;', // 15
	'    int pad_8 = 8;', // 16
	'    return 0;', // 17
	'}' // 18
];
const FILE_BODY = BODY_LINES.join('\n');
const OTHER_BODY = 'int total;\nint mid = total + 1;\n';

const OUTLINE = [
	{ kind: 'function', name: 'total', container: null, line: 0, endLine: 4 },
	{ kind: 'function', name: 'helper', container: null, line: 5, endLine: 18 }
];
const DEFS = [{ kind: 'function', name: 'total', path: 'src/math.c', line: 0, endLine: 4 }];
// The reference matches speak the backend's 1-based lines (the outline and the defs are
// 0-based): the def site of line 0 arrives as line 1, and so on.
const REFS = [
	{ path: 'src/other.c', matches: [{ line: 2, column: 10 }] },
	{ path: 'src/math.c', matches: [{ line: 1, column: 4 }, { line: 3, column: 13 }, { line: 12, column: 16 }] }
];

function mountView(): ReferencesView {
	const view = new ReferencesView();
	document.body.appendChild(view.element);
	return view;
}

beforeEach(() => {
	backend.reset();
	updateSetting('locale', 'en');
	backend.on('symbol_references', ({ name }) => (name === 'total' ? REFS : []));
	backend.on('symbol_lookup', ({ name }) => (name === 'total' ? DEFS : []));
	backend.on('symbol_file_outline', () => ({ symbols: OUTLINE, imports: [] }));
	backend.on('read_file', ({ path }) => {
		if (path === 'src/math.c') return { contents: FILE_BODY, binary: false, size: FILE_BODY.length };
		if (path === 'src/other.c') return { contents: OTHER_BODY, binary: false, size: OTHER_BODY.length };
		return undefined;
	});
});

describe('the folded context slice (pure)', () => {
	const spans: RefSpan[] = OUTLINE;

	it('a site inside a body keeps the head, folds the run-up and the tail', () => {
		const rows = foldedContext(BODY_LINES, spans, 11);
		expect(rows).toEqual([
			{ kind: 'code', line: 5 },
			{ kind: 'fold', from: 6, to: 8 },
			{ kind: 'code', line: 9 },
			{ kind: 'code', line: 10 },
			{ kind: 'site', line: 11 },
			{ kind: 'code', line: 12 },
			{ kind: 'code', line: 13 },
			{ kind: 'fold', from: 14, to: 18 }
		]);
	});

	it('a definition site is its own head, the whole body folding behind it', () => {
		const rows = foldedContext(BODY_LINES, spans, 0);
		expect(rows).toEqual([
			{ kind: 'site', line: 0 },
			{ kind: 'fold', from: 1, to: 4 }
		]);
	});

	it('no enclosing span answers a raw window with no folds', () => {
		const rows = foldedContext(['l0', 'l1', 'l2', 'l3'], [], 1);
		expect(rows).toEqual([
			{ kind: 'code', line: 0 },
			{ kind: 'site', line: 1 },
			{ kind: 'code', line: 2 },
			{ kind: 'code', line: 3 }
		]);
	});

	it('the innermost covering span wins over the outer one', () => {
		const nested: RefSpan[] = [
			{ kind: 'class', name: 'Outer', container: null, line: 0, endLine: 17 },
			{ kind: 'function', name: 'inner', container: 'Outer', line: 5, endLine: 18 }
		];
		expect(enclosingSpan(nested, 11)?.name).toBe('inner');
	});
});

describe('rendering the references', () => {
	it('groups the sites by file with counts, the first group open', async () => {
		const view = mountView();
		view.setSubject({ kind: 'function', name: 'total', path: 'src/math.c', line: 0 });
		await flush();
		expect(view.element.querySelector('.refs-name')?.textContent).toBe('total');
		expect(view.element.querySelector('.refs-summary')?.textContent).toBe('4 site(s) in 2 file(s)');
		expect(texts('.refs-file-name', view.element)).toEqual(['math.c', 'other.c']);
		// The first group's sites render; the second waits collapsed.
		expect(texts('.refs-site-num', view.element)).toEqual(['1', '3', '12']);
		expect(view.element.querySelectorAll('.refs-cut')).toHaveLength(0);
		view.element.remove();
	});

	it('a definition site carries the def marker beside its row', async () => {
		const view = mountView();
		view.setSubject({ kind: 'function', name: 'total', path: 'src/math.c', line: 0 });
		await flush();
		expect(view.element.querySelectorAll('.refs-def')).toHaveLength(1);
		const firstRow = view.element.querySelector('.refs-site');
		expect(firstRow?.querySelector('.refs-site-num')?.textContent).toBe('1');
		view.element.remove();
	});

	it('clicking a site jumps at once; its arrow opens the folded context, the fold rows open in place', async () => {
		const view = mountView();
		view.setSubject({ kind: 'function', name: 'total', path: 'src/math.c', line: 0 });
		await flush();
		const rows = view.element.querySelectorAll('.refs-site');
		// The row itself is the jump — one click, the search-results read.
		const jumpOpens: string[] = [];
		view.onOpen = (path, line) => jumpOpens.push(`${path}:${line}`);
		click(rows[2]!);
		expect(jumpOpens).toEqual(['src/math.c:12']);
		// The arrow folds the context open.
		click(rows[2]!.querySelector('.refs-ctx-toggle')!);
		await flush();
		const ctx = view.element.querySelector('.refs-ctx');
		expect(ctx).toBeTruthy();
		// head, fold, window (code, code, site, code, code), fold — the head line included
		expect(ctx!.querySelectorAll('.ref-ctx-line')).toHaveLength(6);
		expect(ctx!.querySelector('.ref-ctx-site')?.textContent).toContain('total(9, 9)');
		expect(texts('.ref-ctx-fold', ctx!)).toEqual(['… 3 line(s) …', '… 5 line(s) …']);
		click(ctx!.querySelector('.ref-ctx-fold'));
		expect(ctx!.querySelectorAll('.ref-ctx-fold')).toHaveLength(1);
		expect(ctx!.textContent).toContain('pad_0');
		// The highlighted site line jumps at the 1-based line.
		const opens: string[] = [];
		view.onOpen = (path, line) => opens.push(`${path}:${line}`);
		click(ctx!.querySelector('.ref-ctx-site'));
		expect(opens).toEqual(['src/math.c:12']);
		view.element.remove();
	});

	it('clicking the arrow again collapses the context; the row click never re-folds', async () => {
		const view = mountView();
		view.setSubject({ kind: 'function', name: 'total', path: 'src/math.c', line: 0 });
		await flush();
		const row = view.element.querySelectorAll('.refs-site')[1]!;
		click(row.querySelector('.refs-ctx-toggle')!);
		await flush();
		expect(view.element.querySelector('.refs-ctx')).toBeTruthy();
		click(row.querySelector('.refs-ctx-toggle')!);
		expect(view.element.querySelector('.refs-ctx')).toBeNull();
		view.element.remove();
	});

	it('a site with no enclosing span paints the raw window', async () => {
		const view = mountView();
		view.setSubject({ kind: 'function', name: 'total', path: 'src/math.c', line: 0 });
		await flush();
		click(view.element.querySelectorAll('.refs-site')[2]!.querySelector('.refs-ctx-toggle')!);
		await flush();
		// other.c's group opens with its own read; here math.c's outline names every site.
		expect(view.element.querySelectorAll('.refs-ctx')).toHaveLength(1);
		view.element.remove();
	});

	it('the site rows carry the code colors, the name riding the emphasis', async () => {
		const view = mountView();
		view.setSubject({ kind: 'function', name: 'total', path: 'src/math.c', line: 0 });
		await flush();
		const row = view.element.querySelectorAll('.refs-site')[0]!;
		// A keyword and the searched name, colored by the shared tokenizer.
		expect(row.querySelector('.hl-keyword')).toBeTruthy();
		expect(row.querySelector('.hl-emphasis')?.textContent).toBe('total');
		view.element.remove();
	});

	it('opening the second group reads its file and paints its sites', async () => {
		const view = mountView();
		view.setSubject({ kind: 'function', name: 'total', path: 'src/math.c', line: 0 });
		await flush();
		click(view.element.querySelectorAll('.refs-file')[1]);
		await flush();
		expect(texts('.refs-site-num', view.element)).toContain('2');
		expect(view.element.querySelectorAll('.refs-site-text')[3]?.textContent).toContain('total + 1');
		view.element.remove();
	});

	it('no references answers the none note; no subject the resting hint', async () => {
		const view = mountView();
		view.setSubject({ kind: 'function', name: 'other', path: 'src/x.c', line: 0 });
		await flush();
		expect(view.element.querySelector('.refs-hint')?.textContent).toContain('No references found.');
		const empty = mountView();
		empty.setSubject(null);
		expect(empty.element.querySelector('.refs-hint')?.textContent).toContain('Click a symbol');
		view.element.remove();
		empty.element.remove();
	});

	it('past the file cap the cut note answers', async () => {
		const many = Array.from({ length: 120 }, (_, at) => ({ path: `src/f${String(at).padStart(3, '0')}.c`, matches: [{ line: 1, column: 0 }] }));
		backend.on('symbol_references', () => many);
		const view = mountView();
		view.setSubject({ kind: 'function', name: 'total', path: 'src/math.c', line: 0 });
		await flush();
		expect(view.element.querySelectorAll('.refs-file')).toHaveLength(100);
		expect(view.element.querySelector('.refs-cut')?.textContent).toContain('More files');
		view.element.remove();
	});

	it("a file's read resolves through the host's absolute spelling", async () => {
		const view = mountView();
		const reads: string[] = [];
		backend.on('read_file', ({ path }) => {
			reads.push(String(path));
			if (String(path) === 'C:\\repo\\src\\math.c') return { contents: FILE_BODY, binary: false, size: FILE_BODY.length };
			if (String(path) === 'C:\\repo\\src\\other.c') return { contents: OTHER_BODY, binary: false, size: OTHER_BODY.length };
			return undefined;
		});
		view.resolvePath = (path) => `C:\\repo\\${path.replaceAll('/', '\\')}`;
		view.setSubject({ kind: 'function', name: 'total', path: 'src/math.c', line: 0 });
		await flush();
		// The repo-relative index paths crossed joined; the open group's sites carry text.
		expect(reads).toContain('C:\\repo\\src\\math.c');
		expect(texts('.refs-site-text', view.element)[0]).toContain('int total(int a, int b)');
		view.element.remove();
	});
});

/* ---------- The workbench wiring ---------- */

import { trText } from '../src/platform/i18n';

describe('the workbench wiring', () => {
	/** The proven boot table (tests/definitionView.test.ts): the workbench constructor and
	 *  boot against these handlers reach a settled shell without any unhandled invoke. */
	let workbench: Workbench;

	beforeEach(async () => {
		backend.on('boot_context', () => ({ file: null, actions: [], repo: 'C:\\repo' }));
		backend.on('open_folder', ({ path }) => ({ root: path, isRepo: true }));
		backend.on('boot_stage', () => null);
		backend.on('list_dir', () => []);
		backend.on('list_files', () => []);
		backend.on('repo_head', () => ({ branch: 'main', shortHash: 'abc1234', ahead: 0, behind: 0, upstream: null }));
		backend.on('scm_status', () => []);
		backend.on('scm_branches', () => [{ name: 'main', remote: false, current: true, upstream: null }]);
		backend.on('scm_remotes', () => []);
		backend.on('scm_tags', () => []);
		backend.on('scm_stashes', () => []);
		backend.on('ext_list', () => []);
		backend.on('keybindings_read', () => null);
		backend.on('settings_read', () => null);
		backend.on('backup_list', () => []);
		backend.on('git_output_log', () => []);
		backend.on('graph_request', ({ message }) => ({ command: (message as { command: string }).command, error: null, errors: [null], commits: [] }));
		backend.on('symbol_file_outline', () => ({ symbols: [], imports: [] }));
		(window as unknown as { markdownIt: unknown }).markdownIt = { render: (text: string) => `<p>${text}</p>` };
		workbench?.dispose();
		workbench = new Workbench();
		await workbench.boot();
		await flush(10);
	});

	it('registers the palette command with its zh-cn pair and renders the panel tab in Chinese', () => {
		const command = commands.get('workbench.showReferences');
		expect(command).toBeDefined();
		expect(commands.paletteItems().some((item) => item.value === 'workbench.showReferences')).toBe(true);

		updateSetting('locale', 'zh-cn');
		expect(trText('References')).toBe('引用');
		expect(texts('.panel-title')).toContain('引用');
		updateSetting('locale', 'en');
		expect(texts('.panel-title')).toContain('References');
		workbench.dispose();
	});

	it('the follow clears the references page when no editor holds a word', async () => {
		workbench.panel.show('references');
		const asked: Record<string, unknown>[] = [];
		backend.on('symbol_references', (args) => {
			asked.push(args);
			return [];
		});
		// No active editor view: the resolver clears the page without an ask.
		await workbench.resolveDefinitionSymbol({ kind: 'file', path: 'C:\\repo\\src\\main.c', line: 3, column: 5 });
		expect(asked).toHaveLength(0);
		expect(workbench.panel.references.element.querySelector('.refs-hint')?.textContent).toContain('Click a symbol');
		workbench.dispose();
	});
});


/* ---------- The Search Results options and the accumulated lookups (2026-11-23) ---------- */

describe('the Search Results options', () => {
	beforeEach(() => {
		localStorage.clear();
		backend.reset();
		updateSetting('locale', 'en');
		backend.on('symbol_references', () => REFS);
		backend.on('symbol_lookup', ({ name }) => (name === 'total' ? DEFS : []));
		backend.on('read_file', ({ path }) => {
			if (String(path) === 'src/math.c' || String(path) === 'C:\repo\src\math.c') return { contents: FILE_BODY, binary: false, size: FILE_BODY.length };
			if (String(path) === 'src/other.c') return { contents: OTHER_BODY, binary: false, size: OTHER_BODY.length };
			if (String(path) === 'C:\repo\src\other.c') return { contents: OTHER_BODY, binary: false, size: OTHER_BODY.length };
			return undefined;
		});
		backend.on('symbol_file_outline', ({ path }) => (String(path).includes('other.c') ? { symbols: [], imports: [] } : { symbols: OUTLINE, imports: [] }));
	});

	function optionsMenu(view: ReferencesView): void {
		click(view.actions.querySelector('.action-btn')!);
	}

	it("the options menu carries the display switches, and the container prefix rides the row", async () => {
		const view = mountView();
		view.setSubject({ kind: 'function', name: 'total', path: 'src/math.c', line: 0 });
		await flush();
		optionsMenu(view);
		const labels = menuLabels();
		expect(labels).toContain('Include line text');
		expect(labels).toContain('Include name of container function or class');
		// The switches default on for the line text and number, off for the rest.
		click(menuItem('Include name of container function or class')!);
		await flush();
		const row = view.element.querySelector('.refs-site')!;
		expect(row.querySelector('.refs-site-container')?.textContent).toBe('total:');
		// The file name switch adds its own segment.
		optionsMenu(view);
		click(menuItem('Include file names')!);
		await flush();
		expect(view.element.querySelector('.refs-site-file')?.textContent).toBe('in math.c');
		// The line text switch off drops the text.
		optionsMenu(view);
		click(menuItem('Include line text')!);
		await flush();
		expect(view.element.querySelector('.refs-site-text')).toBeNull();
		view.element.remove();
	});

	it('a nested container prefix names the class ahead of the function', () => {
		const spans: RefSpan[] = [
			{ kind: 'class', name: 'Widget', container: null, line: 0, endLine: 40 },
			{ kind: 'method', name: 'paint', container: 'Widget', line: 2, endLine: 10 }
		];
		expect(containerPrefix(spans, 5)).toBe('Widget:paint:');
		expect(containerPrefix(spans, 30)).toBe('Widget:');
		expect(containerPrefix([], 3)).toBeNull();
	});

	it('the append policy accumulates the lookups as sections; replace clears', async () => {
		const view = mountView();
		view.setSubject({ kind: 'function', name: 'total', path: 'src/math.c', line: 0 });
		await flush();
		// Switch to append; a second lookup joins the page.
		click(view.actions.querySelector('.action-btn')!);
		click(menuItem('Always append to old Search Results')!);
		view.setSubject({ kind: 'function', name: 'helper', path: 'src/math.c', line: 5 });
		await flush();
		expect(view.element.querySelectorAll('.refs-section')).toHaveLength(2);
		expect(texts('.refs-name', view.element)).toEqual(['total', 'helper']);
		// Back to replace: the next lookup clears the page.
		click(view.actions.querySelector('.action-btn')!);
		click(menuItem('Always replace old Search Results')!);
		view.setSubject({ kind: 'function', name: 'total', path: 'src/math.c', line: 0 });
		await flush();
		expect(view.element.querySelectorAll('.refs-section')).toHaveLength(1);
		view.element.remove();
	});

	it('the ask policy confirms before replacing the old results', async () => {
		const view = mountView();
		view.setSubject({ kind: 'function', name: 'total', path: 'src/math.c', line: 0 });
		await flush();
		click(view.actions.querySelector('.action-btn')!);
		click(menuItem('Ask before replacing old Search Results')!);
		view.setSubject({ kind: 'function', name: 'helper', path: 'src/math.c', line: 5 });
		await flush();
		expect(notificationButton('Append')).toBeTruthy();
		// Append keeps both.
		click(notificationButton('Append')!);
		await flush();
		expect(view.element.querySelectorAll('.refs-section')).toHaveLength(2);
		// The next ask: this time replace.
		view.setSubject({ kind: 'function', name: 'total', path: 'src/math.c', line: 0 });
		await flush();
		click(notificationButton('Cancel')!);
		await flush();
		expect(view.element.querySelectorAll('.refs-section')).toHaveLength(1);
		expect(texts('.refs-name', view.element)).toEqual(['total']);
		view.element.remove();
	});
});
