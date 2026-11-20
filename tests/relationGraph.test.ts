// The Relation Graph (module 5): the Symbol Window's lower half, drawn on the @antv/G6
// engine (stubbed here the same way module 17's mermaid is stubbed in its own suite) —
// the ring rendered as cards and arrows whose records the assertions read (the ×N label,
// the +/− drill markers, the root's accent, the dashed use arrows), the lazy rings behind
// the right-click menu (cached, depth-capped), the three-way direction switch, the cross
// edge a repeated symbol draws, the stable tree (an expansion adds cards without moving
// any placed one — the owner's ask), the pointer's vocabulary in Source Insight's terms
// (one click on a ringed card drills, a card without a ring opens, the double click opens
// and never expands on its way), the declaration card reading through the joined path —
// and the Symbol Window feeding the graph from the covering symbol over the repo-relative
// path, with the pin freeze and the collapsed section's gate.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RelationGraphView, SymbolWindowView } from '../src/features/search';
import { updateSetting } from '../src/platform/settings';
import { backend } from './tauriMock';
import { click, flush, menuItem, until } from './helpers';
import type { RelationAnswer, RelationNode } from '../src/platform/ipc/symbols';

vi.mock('@antv/g6', () => import('./g6Stub'));
// eslint-disable-next-line import/order
import { Graph, reset as resetG6 } from './g6Stub';

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

/** The engine the view built for the current root. */
function engine(): Graph {
	const instance = Graph.instances.at(-1);
	if (!instance) throw new Error('the engine has not been built yet');
	return instance;
}

/** The card record for one symbol, told apart by the label the engine holds. */
function cardOf(name: string): { id: string; style?: Record<string, unknown> } {
	const card = engine().getNodeData().find((card) => String(card.style?.['labelText'] ?? '').includes(name));
	if (!card) throw new Error(`no rendered card names ${name}`);
	return card;
}

async function untilCards(count: number): Promise<void> {
	await vi.waitFor(() => {
		if (engine().getNodeData().length !== count)
			throw new Error(`the drawing does not hold ${count} cards yet: ${JSON.stringify(engine().getNodeData().map((card) => card.style?.['labelText']))}`);
	}, { timeout: 3000 });
}

/** The arrows in the engine, as `from → to` pairs. */
function edgePairs(): string[] {
	return engine().getEdgeData().map((edge) => `${edge.source} → ${edge.target}`);
}

async function drill(name: string, label: string): Promise<void> {
	const card = cardOf(name);
	engine().emit('node:contextmenu', { target: { id: card.id }, client: { x: 10, y: 10 }, originalEvent: new MouseEvent('contextmenu') });
	const item = menuItem(label);
	if (!item) throw new Error(`no ${label} menu entry`);
	click(item);
}

beforeEach(() => {
	backend.reset();
	resetG6();
	updateSetting('locale', 'en');
	scriptEngine();
});

describe('drawing the ring', () => {
	it('draws the root and its ring as cards, the root marked, the ×N labelled', async () => {
		const view = mountView();
		view.setRoot({ ...ROOT });
		await untilCards(4);
		// The fixture's ring came back cut short — the ⋯ rides the root's label, and the
		// drillable card carries the + while the leaves stand bare.
		expect(String(cardOf('alpha').style?.['labelText'])).toBe('− alpha ⋯');
		expect(String(cardOf('gamma').style?.['labelText'])).toBe('+ gamma');
		expect(String(cardOf('beta').style?.['labelText'])).toBe('beta');
		// The arrows: three tree edges (dashed for the use) plus the ×N on gamma's edge.
		expect(edgePairs()).toHaveLength(3);
		expect(engine().getEdgeData().some((edge) => edge.style?.['labelText'] === '×2')).toBe(true);
		expect(engine().getEdgeData().some((edge) => Array.isArray(edge.style?.['lineDash']))).toBe(true);
		// The root carries the accent.
		expect(cardOf('alpha').style?.['lineWidth']).toBe(1.5);
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
		await untilCards(4);
		engine().emit('node:pointerenter', { target: { id: cardOf('beta').id }, client: { x: 10, y: 10 } });
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
		await untilCards(4);
		const asked = backend.callsTo('symbol_relation_children').length;
		await drill('gamma', 'Expand this ring');
		await untilCards(5); // epsilon drew; beta stayed the cross edge
		const after = backend.callsTo('symbol_relation_children').length;
		expect(after).toBe(asked + 1);
		expect(edgePairs()).toHaveLength(5);
		// Collapse and re-expand: the cached ring answers without a second ask. The cross
		// edge stays — its two ends are both still drawn.
		await drill('gamma', 'Collapse this ring');
		await untilCards(4);
		expect(edgePairs()).toHaveLength(4);
		await drill('gamma', 'Expand this ring');
		await untilCards(5);
		expect(backend.callsTo('symbol_relation_children').length).toBe(after);
		view.dispose();
	});

	it('a symbol already drawn gains a cross edge instead of a second card', async () => {
		const view = mountView();
		view.setRoot({ ...ROOT });
		await untilCards(4);
		await drill('gamma', 'Expand this ring');
		await untilCards(4);
		expect(engine().getNodeData()).toHaveLength(4); // no second beta
		expect(edgePairs()).toHaveLength(4); // the cross edge joined
		view.dispose();
	});

	it('an expansion never moves a placed card, and a collapse removes only the subtree', async () => {
		// gamma's ring names a new symbol and the already-drawn beta — a child plus the
		// cross edge — so the drill has a real card to add and later to remove.
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
		await untilCards(4);
		// Expand gamma: epsilon's card joins and NOTHING else changes slots.
		await drill('gamma', 'Expand this ring');
		await untilCards(5);
		const before = Object.fromEntries(engine().getNodeData().filter((card) => !String(card.id).startsWith('epsilon')).map((card) => [card.id, { x: card.style?.['x'], y: card.style?.['y'] }]));
		await drill('gamma', 'Collapse this ring');
		await untilCards(4);
		const after = Object.fromEntries(engine().getNodeData().map((card) => [card.id, { x: card.style?.['x'], y: card.style?.['y'] }]));
		expect(after).toEqual(before); // the collapse only removed epsilon; every kept card keeps its exact slot
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
		await untilCards(2);
		let at = 'child-of-alpha';
		for (let i = 0; i < 2; i++) {
			const asked = backend.callsTo('symbol_relation_children').length;
			await drill(at, 'Expand this ring');
			await flush();
			at = `child-of-${at}`;
			expect(backend.callsTo('symbol_relation_children').length).toBe(asked + 1);
			await untilCards(i + 3);
		}
		// The card now sits at the cap: its menu entry asks nothing and the ⋯ answers.
		const asked = backend.callsTo('symbol_relation_children').length;
		await drill(at, 'Expand this ring');
		await flush();
		expect(backend.callsTo('symbol_relation_children').length).toBe(asked);
		expect(String(cardOf(at).style?.['labelText'])).toContain('⋯');
		view.dispose();
	});

	it('the right-click menu opens the definition and re-roots too', async () => {
		const view = mountView();
		const opens: string[] = [];
		view.onOpen = (path, line) => opens.push(`${path}:${line}`);
		view.setRoot({ ...ROOT });
		await untilCards(4);
		const betaId = cardOf('beta').id;
		engine().emit('node:contextmenu', { target: { id: betaId }, client: { x: 10, y: 10 }, originalEvent: new MouseEvent('contextmenu') });
		click(menuItem('Open the definition')!);
		expect(opens).toEqual(['src/b.c:3']);
		engine().emit('node:contextmenu', { target: { id: betaId }, client: { x: 10, y: 10 }, originalEvent: new MouseEvent('contextmenu') });
		click(menuItem('Re-root the graph here')!);
		await untilCards(1);
		const last = backend.callsTo('symbol_relation_children').at(-1)!;
		expect(last['name']).toBe('beta');
		expect(last['path']).toBe('src/b.c');
		view.dispose();
	});
});

describe("the pointer (Source Insight's vocabulary)", () => {
	it('the direction switch re-asks a different graph', async () => {
		const view = mountView();
		view.setRoot({ ...ROOT });
		await untilCards(4);
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

	it("a drillable card's click drills its ring", async () => {
		const view = mountView();
		view.setRoot({ ...ROOT });
		await untilCards(4);
		const asked = backend.callsTo('symbol_relation_children').length;
		// gamma carries the + — the click is the expander (deferred past a double click's
		// first press); its ring re-names beta, so the cross edge draws and no card grows.
		engine().emit('node:click', { target: { id: cardOf('gamma').id } });
		await until(() => backend.callsTo('symbol_relation_children').length === asked + 1);
		await flush();
		await untilCards(4);
		expect(edgePairs()).toHaveLength(4);
		view.dispose();
	});

	it("a leaf card's click opens the definition", async () => {
		const view = mountView();
		const opens: string[] = [];
		view.onOpen = (path, line) => opens.push(`${path}:${line}`);
		view.setRoot({ ...ROOT });
		await untilCards(4);
		// beta carries no ring — its click has nothing to drill and opens at once.
		engine().emit('node:click', { target: { id: cardOf('beta').id } });
		await flush();
		expect(opens).toEqual(['src/b.c:3']);
		view.dispose();
	});

	it('the double click opens the definition, and never expands on its way', async () => {
		const view = mountView();
		const opens: string[] = [];
		view.onOpen = (path, line) => opens.push(`${path}:${line}`);
		view.setRoot({ ...ROOT });
		await untilCards(4);
		const asked = backend.callsTo('symbol_relation_children').length;
		// The first press schedules gamma's drill; the double click cancels it and jumps.
		const gammaId = cardOf('gamma').id;
		engine().emit('node:click', { target: { id: gammaId } });
		engine().emit('node:dblclick', { target: { id: gammaId } });
		await flush();
		expect(opens).toEqual(['src/c.c:2']);
		expect(backend.callsTo('symbol_relation_children').length).toBe(asked);
		await new Promise((resolve) => setTimeout(resolve, 300)); // past the deferred drill's window
		expect(backend.callsTo('symbol_relation_children').length).toBe(asked);
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
