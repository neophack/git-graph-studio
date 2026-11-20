// The Relation Graph (module 5): the Symbol Window's lower half, drawn on the Code
// Analysis module's own mermaid drawing (moduleDiagram's DiagramView, stubbed here the
// same way its own suite stubs it) — the root ring rendered as a mermaid flowchart whose
// source the assertions read (the ×N label, the drill markers, the root's class, the
// dashed use arrows), the lazy rings behind the right-click menu (cached, depth-capped),
// the three-way direction switch, the cross edge a repeated symbol draws, the pointer's
// vocabulary in jsdom terms (one click opens the definition, the double-click re-root,
// the hover declaration card reading through the joined path) — and the Symbol Window
// feeding the graph from the covering symbol over the repo-relative path, with the pin
// freeze and the collapsed section's gate.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RelationGraphView, SymbolWindowView } from '../src/features/search';
import { updateSetting } from '../src/platform/settings';
import { backend } from './tauriMock';
import { click, flush, menuItem, until } from './helpers';
import type { RelationAnswer, RelationNode } from '../src/platform/ipc/symbols';

vi.mock('mermaid', () => import('./mermaidStub'));
vi.mock('@mermaid-js/layout-elk', () => ({ default: {} }));
// eslint-disable-next-line import/order
import { rendered } from './mermaidStub';

const ROOT = { kind: 'function', name: 'alpha', path: 'src/a.c', line: 0 };

const RING: RelationNode[] = [
	{ kind: 'function', name: 'beta', container: null, path: 'src/b.c', line: 2, edgePath: 'src/main.c', edgeLine: 4, edgeKind: 'call', edgeCount: 1, hasChildren: false },
	{ kind: 'function', name: 'gamma', container: null, path: 'src/c.c', line: 1, edgePath: 'src/main.c', edgeLine: 5, edgeKind: 'call', edgeCount: 2, hasChildren: true },
	{ kind: 'struct', name: 'Config', container: null, path: 'src/d.c', line: 0, edgePath: 'src/main.c', edgeLine: 6, edgeKind: 'use', edgeCount: 1, hasChildren: false }
];

const GAMMA_RING: RelationNode[] = [
	{ kind: 'function', name: 'beta', container: null, path: 'src/b.c', line: 2, edgePath: 'src/c.c', edgeLine: 3, edgeKind: 'call', edgeCount: 1, hasChildren: false }
];

const answer = (nodes: RelationNode[], truncated = false): RelationAnswer => ({ nodes, truncated });

/** The graph's scripted engine: alpha's ring (cut short), gamma's ring re-naming beta —
 *  the cross edge's fixture; everything else answers empty. */
function scriptEngine(): void {
	backend.on('symbol_relation_children', ({ name, direction }) => {
		if (direction === 'refsTo' && name === 'alpha') return answer(RING, true);
		if (direction === 'refsTo' && name === 'gamma') return answer(GAMMA_RING);
		return answer([]);
	});
}

function mountView(): RelationGraphView {
	const view = new RelationGraphView();
	document.body.appendChild(view.element);
	return view;
}

/** The rendered card for one symbol: mermaid's `g.node` carrying the symbol's payload
 *  as its `data-path`, told apart by the label text the stub drew. */
function nodeEl(host: HTMLElement, name: string): HTMLElement {
	const node = Array.from(host.querySelectorAll<HTMLElement>('.an-mermaid g.node')).find(
		(candidate) => candidate.textContent?.includes(name) ?? false
	);
	if (!node) throw new Error(`no rendered card names ${name}`);
	return node;
}

/** The drawing lands asynchronously (the stubbed mermaid render included) and every
 *  render clears the tree before its repaint: wait for the marked count to hold across
 *  a quiet gap, so a tree caught between two renders never satisfies the wait. */
async function untilDrawn(host: HTMLElement, count: number): Promise<void> {
	await vi.waitFor(async () => {
		if (host.querySelectorAll('[data-path]').length !== count) throw new Error(`the drawing does not hold ${count} cards yet`);
		const paints = rendered.length;
		await new Promise((resolve) => setTimeout(resolve, 30));
		if (rendered.length !== paints || host.querySelectorAll('[data-path]').length !== count) {
			throw new Error('the drawing is still repainting');
		}
	}, { timeout: 3000 });
}

/** The newest flowchart source the stubbed renderer received. */
function source(): string {
	return rendered.at(-1)!.text;
}

/** The arrows in the newest source, in declaration order. */
function edgeLines(): string[] {
	return source()
		.split('\n')
		.filter((line) => /^\s*N\d+ (-\.->|-->)/.test(line));
}

async function drill(host: HTMLElement, name: string, label: string): Promise<void> {
	nodeEl(host, name).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
	const item = menuItem(label);
	if (!item) throw new Error(`no ${label} menu entry`);
	click(item);
}

beforeEach(() => {
	backend.reset();
	rendered.length = 0;
	updateSetting('locale', 'en');
	scriptEngine();
});

describe('drawing the ring', () => {
	it('draws the root and its ring as one flowchart, the root marked', async () => {
		const view = mountView();
		view.setRoot({ ...ROOT });
		await untilDrawn(view.element, 4);
		// The root is the source's first node; the fixture's ring came back cut short —
		// the ⋯ rides its label, and the ring the cards carry the drill markers.
		expect(source()).toContain('N0["− alpha ⋯"]');
		expect(source()).toContain('"+ gamma"');
		expect(edgeLines()).toHaveLength(3);
		// The kinds ride the arrows: call solid, use dashed; the root gets its class.
		expect(source()).toContain('N1 --> N0');
		expect(source()).toContain('N2 -->|"×2"| N0');
		expect(source()).toContain('N3 -.-> N0');
		expect(source()).toContain('class N0 rgRoot');
		// The payload's paths are the graph's own keys — the click resolution reads them.
		expect(nodeEl(view.element, 'alpha').getAttribute('data-path')).toContain('alpha');
		view.dispose();
	});

	it('the ×N count rides the aggregating edge\'s label', async () => {
		const view = mountView();
		view.setRoot({ ...ROOT });
		await untilDrawn(view.element, 4);
		expect(edgeLines().some((line) => line.includes('"×2"'))).toBe(true);
		view.dispose();
	});

	it('a cut-short ring appends the ⋯ to the label', async () => {
		const view = mountView();
		view.setRoot({ ...ROOT });
		await untilDrawn(view.element, 4);
		expect(source()).toContain('− alpha ⋯');
		view.dispose();
	});

	it('shows the resting hint with no root', () => {
		const view = mountView();
		expect(view.element.textContent).toContain('Rest the cursor');
		view.dispose();
	});

	it("the declaration card's read resolves through the joined path", async () => {
		backend.on('symbol_lookup', ({ name }) =>
			name === 'beta' ? [{ kind: 'function', name: 'beta', path: 'src/b.c', line: 2, endLine: 5 }] : []
		);
		const reads: string[] = [];
		backend.on('read_file', ({ path }) => {
			reads.push(String(path));
			return String(path) === 'C:\\repo\\src\\b.c'
				? { contents: 'int other;\nint more;\nint beta(void)\n{\n    return 2;\n}', binary: false, size: 45 }
				: undefined;
		});
		const view = mountView();
		view.resolvePath = (path) => `C:\\repo\\${path.replaceAll('/', '\\')}`;
		view.setRoot({ ...ROOT });
		await untilDrawn(view.element, 4);
		// The hover delegation rides mouseover (mouseenter does not bubble through the SVG).
		nodeEl(view.element, 'beta').dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: 10, clientY: 10 }));
		await until(() => document.querySelector('.rg-decl') !== null);
		expect(reads).toContain('C:\\repo\\src\\b.c');
		expect(document.querySelector('.rg-decl')?.textContent).toContain('int beta(void)');
		view.dispose();
	});
});

describe('drilling rings', () => {
	it('the right-click menu drills a ring, and a re-expand never re-asks', async () => {
		// gamma's ring names a new symbol and the already-drawn beta — a child plus the
		// cross edge — so the card keeps its drill marker across the whole round trip.
		backend.on('symbol_relation_children', ({ name }) => {
			if (name === 'alpha') return answer(RING, true);
			if (name === 'gamma') {
				return answer([
					...GAMMA_RING,
					{ kind: 'function', name: 'epsilon', container: null, path: 'src/e.c', line: 0, edgePath: 'src/c.c', edgeLine: 4, edgeKind: 'call', edgeCount: 1, hasChildren: false }
				]);
			}
			return answer([]);
		});
		const view = mountView();
		view.setRoot({ ...ROOT });
		await untilDrawn(view.element, 4);
		const asked = backend.callsTo('symbol_relation_children').length;
		await drill(view.element, 'gamma', 'Expand this ring');
		await untilDrawn(view.element, 5); // epsilon drew; beta stayed the cross edge
		const after = backend.callsTo('symbol_relation_children').length;
		expect(after).toBe(asked + 1);
		expect(edgeLines()).toHaveLength(5);
		// Collapse and re-expand: the cached ring answers without a second ask. The cross
		// edge stays — its two ends are both still drawn.
		await drill(view.element, 'gamma', 'Collapse this ring');
		await untilDrawn(view.element, 4);
		expect(edgeLines()).toHaveLength(4);
		await drill(view.element, 'gamma', 'Expand this ring');
		await untilDrawn(view.element, 5);
		expect(backend.callsTo('symbol_relation_children').length).toBe(after);
		view.dispose();
	});

	it('a symbol already drawn gains a cross edge instead of a second card', async () => {
		const view = mountView();
		view.setRoot({ ...ROOT });
		await untilDrawn(view.element, 4);
		await drill(view.element, 'gamma', 'Expand this ring');
		await untilDrawn(view.element, 4);
		expect(view.element.querySelectorAll('[data-path]')).toHaveLength(4); // no second beta
		// The cross edge runs between the two drawn cards.
		expect(edgeLines()).toHaveLength(4);
		view.dispose();
	});

	it('the depth cap answers with the ⋯ marker instead of a request', async () => {
		// A ring chain naming the next symbol each time: alpha → child-of-alpha → … — the
		// root's ring opens itself, so the chain starts one level down.
		backend.on('symbol_relation_children', ({ name, direction }) => {
			if (direction !== 'refsTo') return answer([]);
			const ring: RelationNode[] = [
				{ kind: 'function', name: `child-of-${name}`, container: null, path: `src/${name}.c`, line: 1, edgePath: 'src/x.c', edgeLine: 0, edgeKind: 'call', edgeCount: 1, hasChildren: true }
			];
			return answer(ring);
		});
		const view = mountView();
		view.setRoot({ ...ROOT });
		await untilDrawn(view.element, 2);
		let at = 'child-of-alpha';
		for (let i = 0; i < 2; i++) {
			const asked = backend.callsTo('symbol_relation_children').length;
			await drill(view.element, at, 'Expand this ring');
			await flush();
			at = `child-of-${at}`;
			expect(backend.callsTo('symbol_relation_children').length).toBe(asked + 1);
			await untilDrawn(view.element, i + 3);
		}
		// The box now sits at the cap: its menu entry asks nothing and the ⋯ answers.
		const asked = backend.callsTo('symbol_relation_children').length;
		await drill(view.element, at, 'Expand this ring');
		await flush();
		expect(backend.callsTo('symbol_relation_children').length).toBe(asked);
		expect(source()).toContain('⋯');
		view.dispose();
	});

	it('the right-click menu opens the definition and re-roots too', async () => {
		const view = mountView();
		const opens: string[] = [];
		view.onOpen = (path, line) => opens.push(`${path}:${line}`);
		view.setRoot({ ...ROOT });
		await untilDrawn(view.element, 4);
		nodeEl(view.element, 'beta').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
		click(menuItem('Open the definition')!);
		expect(opens).toEqual(['src/b.c:3']);
		nodeEl(view.element, 'beta').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
		click(menuItem('Re-root the graph here')!);
		await untilDrawn(view.element, 1);
		const last = backend.callsTo('symbol_relation_children').at(-1)!;
		expect(last['name']).toBe('beta');
		expect(last['path']).toBe('src/b.c');
		view.dispose();
	});
});

describe('the direction and the re-root', () => {
	it('the direction switch re-asks a different graph', async () => {
		const view = mountView();
		view.setRoot({ ...ROOT });
		await untilDrawn(view.element, 4);
		const toAsks = backend.callsTo('symbol_relation_children').filter((call) => call['direction'] === 'refsTo').length;
		// The controls are the host's to mount; standalone they live on the view itself.
		// The first button is the active refs-to — the switch goes to the second.
		const dirFrom = view.controls.children[1] as HTMLElement;
		click(dirFrom);
		await flush();
		const fromAsks = backend.callsTo('symbol_relation_children').filter((call) => call['direction'] === 'refsFrom').length;
		expect(fromAsks).toBe(toAsks);
		expect((view.controls.children[0] as HTMLElement).classList.contains('active')).toBe(false);
		expect(dirFrom.classList.contains('active')).toBe(true);
		view.dispose();
	});

	it('a double click re-roots the graph on that symbol', async () => {
		const view = mountView();
		view.setRoot({ ...ROOT });
		await untilDrawn(view.element, 4);
		nodeEl(view.element, 'beta').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
		await untilDrawn(view.element, 1);
		const last = backend.callsTo('symbol_relation_children').at(-1)!;
		expect(last['name']).toBe('beta');
		expect(last['path']).toBe('src/b.c');
		expect(last['line']).toBe(2);
		// The scripted engine answers beta's own ring empty — the markerless root card.
		expect(source()).toContain('N0["beta"]');
		expect(source()).toContain('class N0 rgRoot');
		view.dispose();
	});

	it('one click opens the definition', async () => {
		const view = mountView();
		const opens: string[] = [];
		view.onOpen = (path, line) => opens.push(`${path}:${line}`);
		view.setRoot({ ...ROOT });
		await untilDrawn(view.element, 4);
		click(nodeEl(view.element, 'beta'));
		await flush();
		expect(opens).toEqual(['src/b.c:3']);
		view.dispose();
	});
});

/* ---------- The Symbol Window feeds the graph ---------- */

const FILE = 'C:\\repo\\src\\main.c';
const REPO = 'C:\\repo';

const OUTLINE = {
	symbols: [
		{ kind: 'struct', name: 'Config', container: null, line: 0, endLine: 3 },
		{ kind: 'function', name: 'main', container: null, line: 6, endLine: 20 }
	],
	imports: [] as { name: string; line: number }[]
};

/** The window's engine: the outline answers, the graph's asks record; the locals never
 *  ride (no provideText), so the covering symbol alone decides the graph's root. */
function scriptWindow(): void {
	backend.on('symbol_file_outline', () => OUTLINE);
	scriptEngine();
}

function mountWindow(): { host: HTMLElement; view: SymbolWindowView } {
	const host = document.createElement('div');
	document.body.appendChild(host);
	const view = new SymbolWindowView(host);
	view.provideRepo = () => REPO;
	return { host, view };
}

describe('the symbol window feed', () => {
	it('roots the graph on the covering symbol over the repo-relative path', async () => {
		scriptWindow();
		const { host, view } = mountWindow();
		view.setFile(FILE, 8); // the cursor inside main (spans 6..20, 0-based)
		await flush();
		const asks = backend.callsTo('symbol_relation_children');
		expect(asks.length).toBeGreaterThan(0);
		expect(asks[0]!['name']).toBe('main');
		expect(asks[0]!['path']).toBe('src/main.c'); // the index's own vocabulary
		expect(asks[0]!['line']).toBe(6);
		host.remove();
	});

	it('the cursor roaming inside the same function never re-roots', async () => {
		scriptWindow();
		const { host, view } = mountWindow();
		view.setFile(FILE, 8);
		await flush();
		const asked = backend.callsTo('symbol_relation_children').length;
		view.setFile(FILE, 12);
		await flush();
		expect(backend.callsTo('symbol_relation_children').length).toBe(asked);
		host.remove();
	});

	it('the pin freezes the feed, and unpinning re-syncs at once', async () => {
		scriptWindow();
		const { host, view } = mountWindow();
		view.setFile(FILE, 8);
		await flush();
		const asked = backend.callsTo('symbol_relation_children').length;
		const pin = host.querySelector('.sw-graph-head .rg-controls button:nth-child(4)')!;
		click(pin);
		await flush();
		view.setFile(FILE, 1); // the cursor into Config — pinned, so nothing asks
		await flush();
		expect(backend.callsTo('symbol_relation_children').length).toBe(asked);
		// Unpinning re-syncs: the covering symbol now is Config.
		click(pin);
		await flush();
		const last = backend.callsTo('symbol_relation_children').at(-1)!;
		expect(last['name']).toBe('Config');
		host.remove();
	});

	it('a collapsed section asks nothing; re-showing feeds what stands', async () => {
		scriptWindow();
		const { host, view } = mountWindow();
		view.setFile(FILE, 8);
		await flush();
		click(host.querySelector('.sw-graph-head')!); // collapse
		await flush();
		const asked = backend.callsTo('symbol_relation_children').length;
		view.setFile(FILE, 1);
		await flush();
		expect(backend.callsTo('symbol_relation_children').length).toBe(asked);
		click(host.querySelector('.sw-graph-head')!); // re-open
		await flush();
		const last = backend.callsTo('symbol_relation_children').at(-1)!;
		expect(last['name']).toBe('Config');
		host.remove();
	});

	it('no folder, no root: the graph empties when the editor closes', async () => {
		scriptWindow();
		const { host, view } = mountWindow();
		view.setFile(FILE, 8);
		await flush();
		view.setFile(null);
		await flush();
		expect(host.querySelector('.rg-hint')?.textContent).toContain('Rest the cursor');
		host.remove();
	});

	it('the section label speaks zh-cn', () => {
		updateSetting('locale', 'zh-cn');
		const { host } = mountWindow();
		expect(host.querySelector('.sw-graph-label')?.textContent).toBe('关系');
		host.remove();
	});
});
