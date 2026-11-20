// The Relation Graph (module 5): the Symbol Window's lower half over the same relation
// engine — the root ring drawn as boxes and edges, the lazy + rings (cached, depth-capped),
// the three-way direction switch, the ×N edge and its cut-short note, the cross edge a
// repeated symbol draws instead of a second box, the pointer's vocabulary in jsdom terms
// (one click opens the definition, a drag kills its own click, the wheel zooms), the
// double-click re-root — and the Symbol Window feeding the graph from the covering symbol
// over the repo-relative path, with the pin freeze and the collapsed section's gate.

import { beforeEach, describe, expect, it } from 'vitest';

import { RelationGraphView, SymbolWindowView } from '../src/features/search';
import { updateSetting } from '../src/platform/settings';
import { backend } from './tauriMock';
import { click, flush } from './helpers';
import type { RelationAnswer, RelationNode } from '../src/platform/ipc/symbols';

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

function nodeOf(host: ParentNode, name: string): HTMLElement {
	return Array.from(host.querySelectorAll<HTMLElement>('.rg-node')).find((node) => node.querySelector('.rg-label')?.textContent === name)!;
}

beforeEach(() => {
	backend.reset();
	updateSetting('locale', 'en');
	scriptEngine();
});

describe('drawing the ring', () => {
	it('draws the root and its ring as boxes with edges, the root marked', async () => {
		const view = mountView();
		view.setRoot({ ...ROOT });
		await flush();
		expect(view.element.querySelectorAll('.rg-node')).toHaveLength(4);
		expect(nodeOf(view.element, 'alpha').classList.contains('rg-root-node')).toBe(true);
		// The root is the only box with the root mark; the edges exist with their kinds.
		expect(view.element.querySelectorAll('.rg-node.rg-root-node')).toHaveLength(1);
		expect(view.element.querySelectorAll('.rg-edge.rg-call')).toHaveLength(2);
		expect(view.element.querySelectorAll('.rg-edge.rg-use')).toHaveLength(1);
		view.dispose();
	});

	it('carries the ×N count on the aggregating edge, not on a node', async () => {
		const view = mountView();
		view.setRoot({ ...ROOT });
		await flush();
		expect(view.element.querySelector('.rg-edge[data-count="2"]')).not.toBeNull();
		expect(view.element.querySelectorAll('.rg-edge[data-count="2"] title')).toHaveLength(1);
		view.dispose();
	});

	it('closes a cut-short ring with the faint note', async () => {
		const view = mountView();
		view.setRoot({ ...ROOT });
		await flush();
		expect(view.element.querySelectorAll('.rg-cut')).toHaveLength(1);
		view.dispose();
	});

	it('shows the resting hint with no root', () => {
		const view = mountView();
		expect(view.element.textContent).toContain('Rest the cursor');
		view.dispose();
	});
});

describe('drilling rings', () => {
	it("the + drills a node's ring, and a re-expand never re-asks", async () => {
		const view = mountView();
		view.setRoot({ ...ROOT });
		await flush();
		const asked = backend.callsTo('symbol_relation_children').length;
		click(nodeOf(view.element, 'gamma').querySelector('.rg-badge'));
		await flush();
		expect(nodeOf(view.element, 'beta')).toBeTruthy(); // gamma's ring (beta) drew
		const after = backend.callsTo('symbol_relation_children').length;
		expect(after).toBe(asked + 1);
		// Collapse and re-expand: the cached ring answers without a second ask.
		click(nodeOf(view.element, 'gamma').querySelector('.rg-badge'));
		await flush();
		expect(view.element.querySelectorAll('.rg-node')).toHaveLength(4);
		click(nodeOf(view.element, 'gamma').querySelector('.rg-badge'));
		await flush();
		expect(backend.callsTo('symbol_relation_children').length).toBe(after);
		view.dispose();
	});

	it('a symbol already drawn gains a cross edge instead of a second box', async () => {
		const view = mountView();
		view.setRoot({ ...ROOT });
		await flush();
		const boxes = view.element.querySelectorAll('.rg-node').length;
		const edges = view.element.querySelectorAll('.rg-edge').length;
		click(nodeOf(view.element, 'gamma').querySelector('.rg-badge'));
		await flush();
		expect(view.element.querySelectorAll('.rg-node')).toHaveLength(boxes); // no second beta
		expect(view.element.querySelectorAll('.rg-edge')).toHaveLength(edges + 1);
		view.dispose();
	});

	it('the depth cap answers with the cut note instead of a request', async () => {
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
		await flush();
		let at = 'child-of-alpha';
		for (let i = 0; i < 2; i++) {
			const asked = backend.callsTo('symbol_relation_children').length;
			click(nodeOf(view.element, at).querySelector('.rg-badge'));
			await flush();
			expect(backend.callsTo('symbol_relation_children').length).toBe(asked + 1);
			at = `child-of-${at}`;
		}
		// The box now sits at the cap: its + asks nothing and the note answers.
		const asked = backend.callsTo('symbol_relation_children').length;
		click(nodeOf(view.element, at).querySelector('.rg-badge'));
		await flush();
		expect(backend.callsTo('symbol_relation_children').length).toBe(asked);
		const box = nodeOf(view.element, at);
		expect(box.parentElement!.querySelector('.rg-cut')).not.toBeNull();
		view.dispose();
	});
});

describe('the direction and the re-root', () => {
	it('the direction switch re-asks a different graph', async () => {
		const view = mountView();
		view.setRoot({ ...ROOT });
		await flush();
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
		await flush();
		const box = nodeOf(view.element, 'beta');
		box.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
		await flush();
		const last = backend.callsTo('symbol_relation_children').at(-1)!;
		expect(last['name']).toBe('beta');
		expect(last['path']).toBe('src/b.c');
		expect(last['line']).toBe(2);
		expect(nodeOf(view.element, 'beta').classList.contains('rg-root-node')).toBe(true);
		expect(nodeOf(view.element, 'alpha')).toBeUndefined(); // the old root is gone
		view.dispose();
	});
});

describe('the pointer', () => {
	it('one click opens the definition, a drag kills its own click', async () => {
		const view = mountView();
		const opens: string[] = [];
		view.onOpen = (path, line) => opens.push(`${path}:${line}`);
		view.setRoot({ ...ROOT });
		await flush();
		const box = nodeOf(view.element, 'beta');
		click(box);
		await flush();
		expect(opens).toEqual(['src/b.c:3']);
		// A drag (down, past the threshold, up) suppresses the click that follows.
		box.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 10, clientY: 10, pointerId: 1 }));
		window.dispatchEvent(new PointerEvent('pointermove', { clientX: 60, clientY: 12, pointerId: 1 }));
		window.dispatchEvent(new PointerEvent('pointerup', { clientX: 60, clientY: 12, pointerId: 1 }));
		click(box);
		await flush();
		expect(opens).toEqual(['src/b.c:3']);
		view.dispose();
	});

	it('a plain click does not suppress the next one, and dragging moves the box', async () => {
		const view = mountView();
		const opens: string[] = [];
		view.onOpen = (path, line) => opens.push(`${path}:${line}`);
		view.setRoot({ ...ROOT });
		await flush();
		const box = nodeOf(view.element, 'beta');
		box.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 10, clientY: 10, pointerId: 1 }));
		window.dispatchEvent(new PointerEvent('pointermove', { clientX: 40, clientY: 10, pointerId: 1 }));
		window.dispatchEvent(new PointerEvent('pointerup', { clientX: 40, clientY: 10, pointerId: 1 }));
		// The drag's own click dies; the next click lands.
		click(box);
		await flush();
		expect(opens).toEqual([]);
		click(box);
		await flush();
		expect(opens).toEqual(['src/b.c:3']);
		// The drag offset moved the box (30px at scale 1).
		expect(parseFloat(box.style.left)).toBeGreaterThan(20);
		view.dispose();
	});

	it('the background drag pans and the wheel zooms', async () => {
		const view = mountView();
		view.setRoot({ ...ROOT });
		await flush();
		const world = view.element.querySelector<HTMLElement>('.rg-world')!;
		const before = world.style.transform;
		view.element.querySelector<HTMLElement>('.rg-view')!.dispatchEvent(
			new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 10, clientY: 10, pointerId: 1 })
		);
		window.dispatchEvent(new PointerEvent('pointermove', { clientX: 40, clientY: 30, pointerId: 1 }));
		window.dispatchEvent(new PointerEvent('pointerup', { clientX: 40, clientY: 30, pointerId: 1 }));
		expect(world.style.transform).not.toBe(before);
		const panned = world.style.transform;
		view.element.querySelector<HTMLElement>('.rg-view')!.dispatchEvent(
			new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -100, clientX: 20, clientY: 20 })
		);
		expect(world.style.transform).not.toBe(panned);
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
