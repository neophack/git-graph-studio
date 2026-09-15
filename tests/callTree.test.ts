// The call tree's pure logic: which function a line belongs to, who calls whom, and which
// known functions a body calls - the reasoning behind the Callers / Callees panes.

import { beforeEach, describe, expect, it } from 'vitest';

import { CallTreeView, computeCallers, computeCallees, enclosingSymbol, symbolRanges, type RefFile, type WsSymbol } from '../src/callTree';
import { backend } from './tauriMock';
import { click, texts } from './helpers';

const SYMBOLS: WsSymbol[] = [
	{ kind: 'function', name: 'alpha', path: 'a.rs', line: 0 },
	{ kind: 'function', name: 'beta', path: 'a.rs', line: 10 },
	{ kind: 'function', name: 'gamma', path: 'b.rs', line: 4 }
];

describe('call tree logic', () => {
	beforeEach(() => {
		localStorage.clear();
	});

	it('finds the function enclosing a line', () => {
		expect(enclosingSymbol(SYMBOLS, 'a.rs', 5)?.name).toBe('alpha');
		expect(enclosingSymbol(SYMBOLS, 'a.rs', 12)?.name).toBe('beta');
		expect(enclosingSymbol(SYMBOLS, 'a.rs', 100)?.name).toBe('beta');
		expect(enclosingSymbol(SYMBOLS, 'c.rs', 1)).toBeNull();
	});

	it('builds per-file symbol extents', () => {
		const ranges = symbolRanges(SYMBOLS);
		expect(ranges.get('a.rs:0')).toEqual({ from: 0, to: 10 });
		expect(ranges.get('a.rs:10')).toEqual({ from: 10, to: Number.MAX_SAFE_INTEGER });
	});

	it('computes callers from references, skipping the declaration itself', () => {
		const references: RefFile[] = [
			{ path: 'a.rs', matches: [
				{ line: 1, column: 1, length: 5, text: 'alpha();' }, // inside alpha - recursion, not a caller
				{ line: 11, column: 1, length: 5, text: 'alpha();' } // inside beta - a caller
			] },
			{ path: 'b.rs', matches: [
				{ line: 6, column: 1, length: 5, text: 'alpha();' } // inside gamma - a caller
			] }
		];
		const callers = computeCallers(SYMBOLS[0]!, SYMBOLS, references);
		expect(callers.map((c) => c.name).sort()).toEqual(['beta', 'gamma']);
	});

	it('computes callees from a body, matching calls (name followed by a paren)', () => {
		const body = ['pub fn beta() {', '    alpha();', '    let x = gamma(1);', '    let alpharet = alphax;', '}'].join('\n');
		const callees = computeCallees(SYMBOLS[1]!, SYMBOLS, body, 10);
		expect(callees.map((c) => c.name).sort()).toEqual(['alpha', 'gamma']);
	});
});

describe('call tree view', () => {
	beforeEach(() => {
		// The repo root is a static: each test scripts its own workspace.
		CallTreeView.repoRoot = null;
	});

	async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
		const deadline = Date.now() + ms;
		while (!cond()) {
			if (Date.now() > deadline) throw new Error('condition not met in time');
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	}

	function rowNamed(container: HTMLElement, name: string): HTMLElement | undefined {
		return Array.from(container.querySelectorAll<HTMLElement>('.ct-row')).find((r) => r.querySelector('.label')!.textContent === name);
	}

	it('re-renders once the reload lands after toggling between Callers and Callees', async () => {
		backend.on('workspace_symbols', () => [
			{ kind: 'function', name: 'root', path: 'a.rs', line: 0 },
			{ kind: 'function', name: 'callerFn', path: 'a.rs', line: 10 },
			{ kind: 'function', name: 'helper', path: 'a.rs', line: 20 }
		]);
		backend.on('find_references', ({ name }) => name === 'root'
			? [{ path: 'a.rs', matches: [{ line: 11, column: 1, length: 4, text: 'root();' }] }]
			: []);
		const body = ['fn root() {', '    helper();', '}', ...Array.from({ length: 17 }, () => '//'), 'fn helper() {}'].join('\n');
		backend.on('read_file', () => ({ contents: body, binary: false, size: body.length }));

		const container = document.createElement('div');
		document.body.appendChild(container);
		new CallTreeView(container, { kind: 'function', name: 'root', path: 'a.rs', line: 0 });
		await waitFor(() => texts('.ct-row .label', container).includes('callerFn'));

		const callees = Array.from(container.querySelectorAll<HTMLElement>('.ct-header button')).find((b) => b.textContent === 'Callees')!;
		click(callees);
		await waitFor(() => texts('.ct-row .label', container).includes('helper'));
		expect(container.querySelector('.ct-empty')?.textContent ?? '').not.toBe('Loading…');

		const callers = Array.from(container.querySelectorAll<HTMLElement>('.ct-header button')).find((b) => b.textContent === 'Callers')!;
		click(callers);
		await waitFor(() => texts('.ct-row .label', container).includes('callerFn'));
	});

	it('does not expand a row at the depth cap', async () => {
		backend.on('workspace_symbols', () => [0, 10, 20, 30, 40].map((line, i) => ({ kind: 'function', name: i === 0 ? 'root' : `c${i}`, path: 'a.rs', line })));
		// Each function is called from the next one's body: root ← c1 ← c2 ← c3 ← c4.
		backend.on('find_references', ({ name }) => {
			const chain: Record<string, number> = { root: 11, c1: 21, c2: 31, c3: 41 };
			const line = chain[String(name)];
			return line === undefined ? [] : [{ path: 'a.rs', matches: [{ line, column: 1, length: 2, text: `${String(name)}();` }] }];
		});

		const container = document.createElement('div');
		document.body.appendChild(container);
		new CallTreeView(container, { kind: 'function', name: 'root', path: 'a.rs', line: 0 });
		await waitFor(() => rowNamed(container, 'c1') !== undefined);
		click(rowNamed(container, 'c1')!.querySelector('.twistie')!);
		await waitFor(() => rowNamed(container, 'c2') !== undefined);
		click(rowNamed(container, 'c2')!.querySelector('.twistie')!);
		await waitFor(() => rowNamed(container, 'c3') !== undefined);
		click(rowNamed(container, 'c3')!.querySelector('.twistie')!);
		await waitFor(() => rowNamed(container, 'c4') !== undefined);

		// Depth 3 is the cap: the row shows the non-expandable affordance and its twistie is inert.
		const capped = rowNamed(container, 'c4')!;
		expect(capped.querySelector('.twistie')!.className).toContain('circle-filled');
		const rowsBefore = container.querySelectorAll('.ct-row').length;
		click(capped.querySelector('.twistie')!);
		await waitFor(() => false, 200).catch(() => undefined);
		expect(backend.callsTo('find_references').some((args) => args['name'] === 'c4')).toBe(false);
		expect(container.querySelectorAll('.ct-row').length).toBe(rowsBefore);
		expect(container.querySelector('.ct-children .ct-empty')).toBeNull();
	});
});

describe('call tree callees over a large index', () => {
	it('scans each body line once, whatever the symbol count, and keeps whole-word semantics', () => {
		const many: WsSymbol[] = Array.from({ length: 20000 }, (_, i) => ({ kind: 'function', name: `fn_${i}`, path: `f${i % 100}.rs`, line: i }));
		const symbols = [...SYMBOLS, ...many];
		const body = ['pub fn beta() {', '    alpha();', '    fn_777 (1);', '    xalpha(); alphax();', '    fn_99999();', '    beta();', '}'].join('\n');
		const started = performance.now();
		const callees = computeCallees(SYMBOLS[1]!, symbols, body, 10);
		expect(performance.now() - started).toBeLessThan(500);
		// alpha and fn_777 are calls; xalpha / alphax / fn_99999 are other identifiers; the
		// recursive beta() call counts, the declaration header does not make beta its own callee twice.
		expect(callees.map((c) => c.name)).toEqual(['alpha', 'fn_777']);
	});
});

describe('call tree symbol cache', () => {
	it('is read afresh by every tree, so a folder switch never resolves the old index', async () => {
		let workspace = 'old';
		backend.on('workspace_symbols', () => workspace === 'old'
			? [{ kind: 'function', name: 'root', path: 'a.rs', line: 0 }, { kind: 'function', name: 'oldCaller', path: 'a.rs', line: 10 }]
			: [{ kind: 'function', name: 'root', path: 'a.rs', line: 0 }, { kind: 'function', name: 'newCaller', path: 'a.rs', line: 10 }]);
		backend.on('find_references', () => [{ path: 'a.rs', matches: [{ line: 11, column: 1, length: 4, text: 'root();' }] }]);
		const first = document.createElement('div');
		document.body.appendChild(first);
		new CallTreeView(first, { kind: 'function', name: 'root', path: 'a.rs', line: 0 });
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(texts('.ct-row .label', first)).toEqual(['oldCaller']);

		// Another folder (or an edit that moved the functions): a new tree sees the new index.
		workspace = 'new';
		const second = document.createElement('div');
		document.body.appendChild(second);
		new CallTreeView(second, { kind: 'function', name: 'root', path: 'a.rs', line: 0 });
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(texts('.ct-row .label', second)).toEqual(['newCaller']);
		expect(backend.callsTo('workspace_symbols')).toHaveLength(2);
	});
});
