// The Relation Graph (module 5): the Symbol Window's lower half, drawn on the view's own
// SVG board in the worktile/plait mind-map manner — the ring rendered as cards whose
// groups, links and branch expanders the assertions read (the ×N label, the +/− drill
// markers, the root's accent, the dashed use arrows, the bezier `C` in every link's
// path), the layout re-planned on every draw (children stacked without overlap, a parent
// centered on its outermost children, a branch's expansion gliding the siblings aside —
// the owner's ask: curved mind-map links + nodes that move by themselves), the lazy rings behind the right-click
// menu (cached, depth-capped), the three-way direction switch, the cross edge a repeated
// symbol draws, the pointer's vocabulary (one click on a
// ringed card drills, a plain click shows the jump in the Definition page, the double
// click opens the editor and never expands on its way), the declaration card reading
// through the joined path — and the Symbol Window feeding the graph from the covering
// symbol over the repo-relative path, with the pin freeze and the collapsed section's gate.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RelationGraphView, SymbolWindowView } from '../src/features/search';
import { updateSetting } from '../src/platform/settings';
import { backend } from './tauriMock';
import { click, flush, menuLabels, menuItem, until } from './helpers';
import type { RelationAnswer, RelationNode } from '../src/platform/ipc/symbols';

const ROOT = { kind: 'function', name: 'alpha', path: 'src/a.c', line: 0 };

const RING: RelationNode[] = [
	{ kind: 'function', name: 'beta', container: null, path: 'src/b.c', line: 2, edgePath: 'src/main.c', edgeLine: 4, edgeKind: 'call', edgeCount: 1, edgeLines: [4], hasChildren: false },
	// gamma's edge aggregates two sites (main.c lines 5 and 6, 0-based) — the numbered
	// rows hang under its card; Config's two sites share one line, so its edge speaks
	// the count as the ×N label instead.
	{ kind: 'function', name: 'gamma', container: null, path: 'src/c.c', line: 1, edgePath: 'src/main.c', edgeLine: 4, edgeKind: 'call', edgeCount: 2, edgeLines: [4, 5], hasChildren: true },
	{ kind: 'struct', name: 'Config', container: null, path: 'src/d.c', line: 0, edgePath: 'src/main.c', edgeLine: 6, edgeKind: 'use', edgeCount: 2, edgeLines: [6], hasChildren: false }
];

const GAMMA_RING: RelationNode[] = [
	{ kind: 'function', name: 'beta', container: null, path: 'src/b.c', line: 2, edgePath: 'src/c.c', edgeLine: 3, edgeKind: 'call', edgeCount: 1, edgeLines: [3], hasChildren: false }
];

const answer = (nodes: RelationNode[], truncated = false): RelationAnswer => ({ nodes, truncated });

/** The graph's scripted backend: alpha's ring (cut short), gamma's ring re-naming beta —
 *  the cross edge's fixture; everything else answers empty. The fixture answers every
 *  direction: a function root's own default type is named by the rules, so the asks no
 *  longer spell one fixed direction. */
function scriptEngine(): void {
	backend.on('symbol_relation_children', ({ name }) => {
		if (name === 'alpha') return answer(RING, true);
		if (name === 'gamma') return answer(GAMMA_RING);
		return answer([]);
	});
}

/** The views mounted so far — the helpers read the last one, the test's own. */
const mounted: RelationGraphView[] = [];

/** The board the current test is driving. */
function live(): RelationGraphView {
	const view = mounted.at(-1);
	if (!view) throw new Error('no relation graph is mounted');
	return view;
}

function mountView(): RelationGraphView {
	const view = new RelationGraphView();
	document.body.appendChild(view.element);
	mounted.push(view);
	return view;
}

/** The card group of one symbol, told apart by the label the board holds. */
function cards(): SVGGElement[] {
	return [...live().element.querySelectorAll<SVGGElement>('.rg-card')];
}

function cardOf(name: string): SVGGElement {
	const card = cards().find((card) => card.textContent?.includes(name));
	if (!card) throw new Error(`no rendered card names ${name}`);
	return card;
}

function expanders(): SVGGElement[] {
	return [...live().element.querySelectorAll<SVGGElement>('.rg-expander')];
}

function expanderOf(name: string): SVGGElement {
	const box = expanders().find((box) => box.dataset.for === cardOf(name).dataset.id);
	if (!box) throw new Error(`no branch expander under ${name}`);
	return box;
}

/** The arrows in the board, as `from → to` pairs (the groups carry the keys). */
function edgePairs(): string[] {
	return [...live().element.querySelectorAll<SVGGElement>('.rg-edge')].map((g) => `${g.dataset.from} → ${g.dataset.to}`);
}

/** A card's world spot off its transform — the layout's own output. */
function spot(g: SVGGElement): { x: number; y: number } {
	const match = /translate\((-?[\d.]+) (-?[\d.]+)\)/.exec(g.getAttribute('transform') ?? '');
	if (!match) throw new Error(`no spot on ${g.getAttribute('transform')}`);
	return { x: Number(match[1]), y: Number(match[2]) };
}

async function untilCards(count: number): Promise<void> {
	await vi.waitFor(() => {
		if (cards().length !== count)
			throw new Error(`the board does not hold ${count} cards yet: ${JSON.stringify(cards().map((card) => card.textContent))}`);
	}, { timeout: 3000 });
}

async function drill(name: string, label: string): Promise<void> {
	const card = cardOf(name);
	card.dispatchEvent(new MouseEvent('contextmenu', { clientX: 10, clientY: 10, bubbles: true }));
	const item = menuItem(label);
	if (!item) throw new Error(`no ${label} menu entry`);
	click(item);
}

beforeEach(() => {
	backend.reset();
	updateSetting('locale', 'en');
	scriptEngine();
});

describe('drawing the ring', () => {
	it('draws the root and its ring as cards, the root marked, the ×N labelled', async () => {
		const view = mountView();
		view.setRoot({ ...ROOT });
		await untilCards(4);
		await view.whenSettled();
		// The fixture's ring came back cut short — the ⋯ rides the root's label, and the
		// drillable cards carry their branch expanders with the +/− glyph while the leaves
		// stand bare.
		expect(cardOf('alpha').querySelector('text')?.textContent).toBe('alpha ⋯');
		expect(cardOf('gamma').querySelector('text')?.textContent).toBe('gamma');
		expect(cardOf('beta').querySelector('text')?.textContent).toBe('beta');
		// The branch expanders: the root's flipped to − (its ring drew), gamma's stands +.
		expect(expanders()).toHaveLength(2);
		expect(expanderOf('alpha').querySelector('text')?.textContent).toBe('−');
		expect(expanderOf('gamma').querySelector('text')?.textContent).toBe('+');
		// The links: three tree edges plus the ×N on Config's edge (its two sites share
		// one line — the count is the label's own), routed as smooth module-style cubic
		// Bezier curves with distributed ports, and gamma's two-site edge speaking its
		// count in numbered rows instead.
		expect(edgePairs()).toHaveLength(3);
		const curves = [...view.element.querySelectorAll<SVGPathElement>('.rg-edge path')].map((path) => path.getAttribute('d') ?? '');
		expect(curves.every((d) => d.includes(' C '))).toBe(true);
		const countLabels = [...view.element.querySelectorAll<SVGTextElement>('.rg-edge text')].map((text) => text.textContent);
		expect(countLabels).toContain('×2');
		expect(countLabels.filter((text) => text?.startsWith('×'))).toEqual(['×2']);
		expect([...view.element.querySelectorAll<SVGPathElement>('.rg-edge path')].every((path) => path.getAttribute('marker-end') === 'url(#rg-arr)')).toBe(true);
		// gamma's numbered rows: a row per site, 1-based, and the
		// card grew to hold them.
		expect([...cardOf('gamma').querySelectorAll('.rg-detail-row')].map((row) => row.textContent)).toEqual(['1. line 5', '2. line 6']);
		expect(Number(cardOf('gamma').querySelector('rect')!.getAttribute('height'))).toBe(44 + 2 * 15);
		// The single-site edges keep their clean cards.
		expect(cardOf('beta').querySelector('.rg-detail-row')).toBeNull();
		// The root carries the accent stroke.
		expect(cardOf('alpha').querySelector('rect')?.getAttribute('stroke-width')).toBe('1.5');
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
		cardOf('beta').dispatchEvent(new MouseEvent('pointerenter', { clientX: 10, clientY: 10, bubbles: true }));
		await until(() => document.querySelector('.rg-decl') !== null);
		expect(reads).toContain('C:\\repo\\src\\b.c');
		expect(document.querySelector('.rg-decl')?.textContent).toContain('int beta(void)');
		view.dispose();
	});
});

describe('the mind layout (draw, glide, no overlap)', () => {
	it('the layout stacks children without overlap and centers the parent on them', async () => {
		const view = mountView();
		view.setRoot({ ...ROOT });
		await untilCards(4);
		await view.whenSettled();
		// Every card owns a rectangle no other card crosses — the tidy tree's promise (a
		// card's height is its own: gamma's numbered rows made it taller than the label
		// row).
		const boxes = cards().map((card) => {
			const at = spot(card);
			return { x: at.x, y: at.y, w: Number(card.querySelector('rect')!.getAttribute('width')), h: Number(card.querySelector('rect')!.getAttribute('height')) };
		});
		for (let i = 0; i < boxes.length; i++) {
			for (let j = i + 1; j < boxes.length; j++) {
				const apart =
					boxes[i]!.x + boxes[i]!.w <= boxes[j]!.x || boxes[j]!.x + boxes[j]!.w <= boxes[i]!.x || boxes[i]!.y + boxes[i]!.h <= boxes[j]!.y || boxes[j]!.y + boxes[j]!.h <= boxes[i]!.y;
				expect(apart, `cards ${i} and ${j} overlap`).toBe(true);
			}
		}
		// alpha sits centered over the layer-1 band.
		const alpha = spot(cardOf('alpha')).x + Number(cardOf('alpha').querySelector('rect')!.getAttribute('width')) / 2;
		const l1Cards = [cardOf('beta'), cardOf('gamma'), cardOf('Config')];
		const minX = Math.min(...l1Cards.map((c) => spot(c).x));
		const maxX = Math.max(...l1Cards.map((c) => spot(c).x + Number(c.querySelector('rect')!.getAttribute('width'))));
		expect(Math.abs(alpha - (minX + maxX) / 2)).toBeLessThan(1);
		// The tree grows downward: gamma one layer below alpha.
		expect(spot(cardOf('gamma')).y).toBeGreaterThan(spot(cardOf('alpha')).y);
		view.dispose();
	});

	it("an expansion glides the siblings aside, and a collapse removes only the subtree", async () => {
		backend.on('symbol_relation_children', ({ name }) => {
			if (name === 'alpha') return answer(RING, true);
			if (name === 'gamma') {
				return answer([
					...GAMMA_RING,
					{ kind: 'function', name: 'epsilon', container: null, path: 'src/e.c', line: 0, edgePath: 'src/c.c', edgeLine: 4, edgeKind: 'call', edgeCount: 1, edgeLines: [4], hasChildren: false },
					{ kind: 'function', name: 'zeta', container: null, path: 'src/z.c', line: 0, edgePath: 'src/c.c', edgeLine: 5, edgeKind: 'call', edgeCount: 1, edgeLines: [5], hasChildren: false }
				]);
			}
			return answer([]);
		});
		const view = mountView();
		view.setRoot({ ...ROOT });
		await untilCards(4);
		await view.whenSettled();
		const configBefore = spot(cardOf('Config'));
		await drill('gamma', 'Expand this ring');
		await untilCards(6);
		await view.whenSettled();
		const configAfter = spot(cardOf('Config'));
		expect(spot(cardOf('epsilon')).y).toBeGreaterThan(spot(cardOf('gamma')).y);
		const boxes = cards().map((card) => {
			const at = spot(card);
			return { x: at.x, y: at.y, w: Number(card.querySelector('rect')!.getAttribute('width')), h: Number(card.querySelector('rect')!.getAttribute('height')) };
		});
		for (let i = 0; i < boxes.length; i++) {
			for (let j = i + 1; j < boxes.length; j++) {
				const apart =
					boxes[i]!.x + boxes[i]!.w <= boxes[j]!.x || boxes[j]!.x + boxes[j]!.w <= boxes[i]!.x || boxes[i]!.y + boxes[i]!.h <= boxes[j]!.y || boxes[j]!.y + boxes[j]!.h <= boxes[i]!.y;
				expect(apart, `cards ${i} and ${j} overlap`).toBe(true);
			}
		}
		const asked = backend.callsTo('symbol_relation_children').length;
		await drill('gamma', 'Collapse this ring');
		await untilCards(4);
		await view.whenSettled();
		expect(edgePairs()).toHaveLength(4);
		await drill('gamma', 'Expand this ring');
		await untilCards(6);
		await view.whenSettled();
		expect(backend.callsTo('symbol_relation_children').length).toBe(asked);
		expect(edgePairs()).toHaveLength(6);
		expect(spot(cardOf('Config'))).toEqual(configAfter);
		await drill('gamma', 'Collapse this ring');
		await untilCards(4);
		await view.whenSettled();
		expect(spot(cardOf('Config'))).toEqual(configBefore);
		view.dispose();
	});

	it('the re-plan re-anchors the links on the moved cards', async () => {
		backend.on('symbol_relation_children', ({ name }) => {
			if (name === 'alpha') return answer(RING, true);
			if (name === 'gamma') {
				return answer([
					...GAMMA_RING,
					{ kind: 'function', name: 'epsilon', container: null, path: 'src/e.c', line: 0, edgePath: 'src/c.c', edgeLine: 4, edgeKind: 'call', edgeCount: 1, edgeLines: [4], hasChildren: false },
					{ kind: 'function', name: 'zeta', container: null, path: 'src/z.c', line: 0, edgePath: 'src/c.c', edgeLine: 5, edgeKind: 'call', edgeCount: 1, edgeLines: [5], hasChildren: false }
				]);
			}
			return answer([]);
		});
		const view = mountView();
		view.setRoot({ ...ROOT });
		await untilCards(4);
		await view.whenSettled();
		const configId = cardOf('Config').dataset.id!;
		const linkOfConfig = [...view.element.querySelectorAll<SVGGElement>('.rg-edge')].find((g) => g.dataset.from === configId)!;
		await drill('gamma', 'Expand this ring');
		await untilCards(6);
		await view.whenSettled();
		const at = spot(cardOf('Config'));
		const dAfter = linkOfConfig.querySelector('path')!.getAttribute('d')!;
		expect(dAfter).toContain(` ${at.y} C `);
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
					{ kind: 'function', name: 'epsilon', container: null, path: 'src/e.c', line: 0, edgePath: 'src/c.c', edgeLine: 4, edgeKind: 'call', edgeCount: 1, edgeLines: [4], hasChildren: false }
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
		view.dispose();
	});

	it('a symbol already drawn gains a cross edge instead of a second card', async () => {
		const view = mountView();
		view.setRoot({ ...ROOT });
		await untilCards(4);
		await drill('gamma', 'Expand this ring');
		await untilCards(4);
		expect(cards()).toHaveLength(4); // no second beta
		expect(edgePairs()).toHaveLength(4); // the cross edge joined
		view.dispose();
	});

	it('a fold hides a whole subtree’s arrows, not just its cards', async () => {
		// gamma's ring: the drawn beta (the cross edge) plus two fresh children. Expanding
		// gamma leaves it `expanded` in the cache — so when the ROOT then folds, gamma is
		// hidden while still expanded, and neither its tree arrows nor the cross edge may
		// linger over the emptied board (the residual-line report).
		backend.on('symbol_relation_children', ({ name }) => {
			if (name === 'alpha') return answer(RING, true);
			if (name === 'gamma') {
				return answer([
					...GAMMA_RING,
					{ kind: 'function', name: 'epsilon', container: null, path: 'src/e.c', line: 0, edgePath: 'src/c.c', edgeLine: 4, edgeKind: 'call', edgeCount: 1, edgeLines: [4], hasChildren: false },
					{ kind: 'function', name: 'zeta', container: null, path: 'src/z.c', line: 0, edgePath: 'src/c.c', edgeLine: 5, edgeKind: 'call', edgeCount: 1, edgeLines: [5], hasChildren: false }
				]);
			}
			return answer([]);
		});
		const view = mountView();
		view.setRoot({ ...ROOT });
		await untilCards(4);
		await drill('gamma', 'Expand this ring');
		await untilCards(6);
		expect(edgePairs()).toHaveLength(6); // 3 tree + 2 under gamma + the cross edge
		await drill('alpha', 'Collapse this ring');
		await untilCards(1);
		await view.whenSettled();
		expect(edgePairs()).toHaveLength(0); // no stray curve over the empty board
		view.dispose();
	});

	it('the depth cap answers with the ⋯ marker instead of a request', async () => {
		// A ring chain naming the next symbol each time: alpha → child-of-alpha → … — the
		// root's ring opens itself, so the chain starts one level down. The depth guard shows
		// five levels of cards (depths 0..4); a card at depth 4 is the leaf.
		backend.on('symbol_relation_children', ({ name }) => {
			if (name === 'alpha' || name.startsWith('child-of-')) {
				const ring: RelationNode[] = [
					{ kind: 'function', name: `child-of-${name}`, container: null, path: `src/${name}.c`, line: 1, edgePath: 'src/x.c', edgeLine: 0, edgeKind: 'call', edgeCount: 1, edgeLines: [0], hasChildren: true }
				];
				return answer(ring);
			}
			return answer([]);
		});
		const view = mountView();
		view.setRoot({ ...ROOT });
		await untilCards(2);
		let at = 'child-of-alpha';
		for (let i = 0; i < 3; i++) {
			const asked = backend.callsTo('symbol_relation_children').length;
			await drill(at, 'Expand this ring');
			await flush();
			at = `child-of-${at}`;
			expect(backend.callsTo('symbol_relation_children').length).toBe(asked + 1);
			await untilCards(i + 3);
		}
		// The card now sits at the cap (depth 4): its menu entry asks nothing and the ⋯ answers.
		const asked = backend.callsTo('symbol_relation_children').length;
		await drill(at, 'Expand this ring');
		await flush();
		expect(backend.callsTo('symbol_relation_children').length).toBe(asked);
		expect(cardOf(at).querySelector('text')?.textContent).toContain('⋯');
		view.dispose();
	});

	it('the right-click menu opens the definition and re-roots too', async () => {
		const view = mountView();
		const opens: string[] = [];
		view.onOpen = (path, line) => opens.push(`${path}:${line}`);
		view.setRoot({ ...ROOT });
		await untilCards(4);
		const betaId = cardOf('beta').dataset.id!;
		cardOf('beta').dispatchEvent(new MouseEvent('contextmenu', { clientX: 10, clientY: 10, bubbles: true }));
		click(menuItem('Open the definition')!);
		expect(opens).toEqual(['src/b.c:3']);
		cardOf('beta').dispatchEvent(new MouseEvent('contextmenu', { clientX: 10, clientY: 10, bubbles: true }));
		click(menuItem('Re-root the graph here')!);
		await untilCards(1);
		const last = backend.callsTo('symbol_relation_children').at(-1)!;
		expect(last['name']).toBe('beta');
		expect(last['path']).toBe('src/b.c');
		view.dispose();
	});
});

describe("the pointer (the graph's own vocabulary)", () => {
	it('the type picker lists the thirteen view names and swaps the kind', async () => {
		const view = mountView();
		view.setRoot({ ...ROOT });
		await untilCards(4);
		// The picker is the head's first button; its click opens the thirteen entries,
		// the thirteen views in their own order, the active one checked.
		click(view.controls.children[0] as HTMLElement);
		await flush();
		expect(menuLabels()).toEqual([
			'Calls',
			'Callers',
			'Calls and Callers',
			'Referenced by Functions',
			'Referenced by Files',
			'Referenced by Modules',
			'Contains',
			'Container',
			'Base Classes',
			'Derived Classes',
			'Member Types',
			'Member Classes',
			'Types Used'
		]);
		// The swap: picking Calls and Callers re-asks the same root under the new kind.
		click(menuItem('Calls and Callers')!);
		await flush();
		const last = backend.callsTo('symbol_relation_children').at(-1)!;
		expect(last['direction']).toBe('callsAndCallers');
		// The picker's label answers the new kind's name.
		await until(() => (view.controls.children[0] as HTMLElement).textContent?.includes('Calls and Callers'));
		view.dispose();
	});

	it('an empty root ring answers the verdict the relation window prints', async () => {
		backend.on('symbol_relation_children', ({ name, direction }) => (name === 'alpha' && direction === 'refsTo' ? answer([]) : answer([])));
		const view = mountView();
		view.setRoot({ ...ROOT });
		await untilCards(1);
		await until(() => view.element.textContent!.includes('No referencing functions.'));
		view.dispose();
	});

	it("the combined view's caller branches drill as Callers and its callee branches as Calls", async () => {
		// alpha's combined ring: beta a caller (its edge site in its own file), hook a
		// callee (its edge site in alpha's file).
		backend.on('symbol_relation_children', ({ name, direction }) => {
			if (name !== 'alpha') return answer([]);
			if (direction === 'callsAndCallers') {
				return answer([
					{ kind: 'function', name: 'beta', container: null, path: 'src/b.c', line: 2, edgePath: 'src/b.c', edgeLine: 3, edgeKind: 'call', edgeCount: 1, edgeLines: [3], hasChildren: true },
					{ kind: 'function', name: 'hook', container: null, path: 'src/a.c', line: 8, edgePath: 'src/a.c', edgeLine: 5, edgeKind: 'call', edgeCount: 2, edgeLines: [5, 6], hasChildren: true }
				]);
			}
			return answer([]);
		});
		const view = mountView();
		view.setRoot({ ...ROOT });
		// The combined view rides the picker: open it, pick Calls and Callers.
		click(view.controls.children[0] as HTMLElement);
		await flush();
		click(menuItem('Calls and Callers')!);
		await untilCards(3);
		// The arrows: beta (a caller) points at alpha; alpha points at hook (a callee).
		const betaKey = 'beta\u0000src/b.c\u00002';
		const hookKey = 'hook\u0000src/a.c\u00008';
		const rootKey = 'alpha\u0000src/a.c\u00000';
		expect(edgePairs()).toContain(`${betaKey} → ${rootKey}`);
		expect(edgePairs()).toContain(`${rootKey} → ${hookKey}`);
		// The branches drill by their own side: beta as Callers, hook as Calls.
		await drill('beta', 'Expand this ring');
		await flush();
		expect(backend.callsTo('symbol_relation_children').at(-1)!['direction']).toBe('callers');
		await drill('hook', 'Expand this ring');
		await flush();
		expect(backend.callsTo('symbol_relation_children').at(-1)!['direction']).toBe('calls');
		view.dispose();
	});

	it("a branch expander drills its ring, and never jumps", async () => {
		// gamma's ring names a new symbol and the already-drawn beta — a child plus the
		// cross edge — so the box keeps its drill after the ring lands.
		backend.on('symbol_relation_children', ({ name }) => {
			if (name === 'alpha') return answer(RING, true);
			if (name === 'gamma') {
				return answer([
					...GAMMA_RING,
					{ kind: 'function', name: 'epsilon', container: null, path: 'src/e.c', line: 0, edgePath: 'src/c.c', edgeLine: 4, edgeKind: 'call', edgeCount: 1, edgeLines: [4], hasChildren: false }
				]);
			}
			return answer([]);
		});
		const view = mountView();
		const opens: string[] = [];
		const shows: unknown[] = [];
		view.onOpen = (path, line) => opens.push(`${path}:${line}`);
		view.onShowDefinition = (subject) => shows.push(subject);
		view.setRoot({ ...ROOT });
		await untilCards(4);
		// The press on the circle must not start a board pan: the pointerdown a real
		// click delivers targets the circle's own glyph, and a pan start here would
		// capture the pointer to the board — the click then composes on the board and
		// the circle never sees it (the dead +/− the owner reported).
		const board = view.element.querySelector('svg')!;
		expanderOf('gamma').dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
		expect(board.classList.contains('rg-panning')).toBe(false);
		const asked = backend.callsTo('symbol_relation_children').length;
		// gamma's box carries the + — its click alone drills, and it never jumps.
		expanderOf('gamma').dispatchEvent(new MouseEvent('click', { bubbles: true }));
		await until(() => backend.callsTo('symbol_relation_children').length === asked + 1);
		await untilCards(5);
		expect(edgePairs()).toHaveLength(5);
		expect(opens).toEqual([]);
		expect(shows).toEqual([]);
		// The box flipped to −; the second click collapses (the cached ring, no re-ask).
		expect(expanderOf('gamma').querySelector('text')?.textContent).toBe('−');
		const after = backend.callsTo('symbol_relation_children').length;
		expanderOf('gamma').dispatchEvent(new MouseEvent('click', { bubbles: true }));
		await untilCards(4); // epsilon's card left, beta stayed the cross edge
		expect(backend.callsTo('symbol_relation_children').length).toBe(after);
		expect(opens).toEqual([]);
		view.dispose();
	});

	it("a card's plain click shows the jump in the Definition page, never the editor", async () => {
		const view = mountView();
		const opens: string[] = [];
		const shows: { path: string; line: number }[] = [];
		view.onOpen = (path, line) => opens.push(`${path}:${line}`);
		view.onShowDefinition = (subject) => shows.push({ path: subject.path, line: subject.line });
		view.setRoot({ ...ROOT });
		await untilCards(4);
		const asked = backend.callsTo('symbol_relation_children').length;
		// The drillable card itself shows its definition on the plain click — the box
		// owns the drilling, the code page never moves (2026-11-23, the owner's
		// direction: the line rides 0-based, the Definition page's own vocabulary).
		cardOf('gamma').dispatchEvent(new MouseEvent('click', { bubbles: true }));
		await flush();
		expect(shows).toEqual([{ path: 'src/c.c', line: 1 }]);
		expect(opens).toEqual([]);
		expect(backend.callsTo('symbol_relation_children').length).toBe(asked);
		// The double click is the editor's open, and it alone.
		cardOf('gamma').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
		await flush();
		expect(opens).toEqual(['src/c.c:2']);
		expect(shows).toHaveLength(1);
		view.dispose();
	});

	it("a multi-site edge draws its numbered rows, and a row click shows that site in the Definition page", async () => {
		// gamma's edge aggregates two sites in main.c (0-based lines 4 and 5): the card
		// hangs the numbered rows beneath a separator, each row
		// its own show — the card's definition click never sees it.
		const view = mountView();
		const opens: string[] = [];
		const shows: { path: string; line: number }[] = [];
		view.onOpen = (path, line) => opens.push(`${path}:${line}`);
		view.onShowDefinition = (subject) => shows.push({ path: subject.path, line: subject.line });
		view.setRoot({ ...ROOT });
		await untilCards(4);
		const gamma = cardOf('gamma');
		const rows = [...gamma.querySelectorAll('.rg-detail-row')];
		expect(rows.map((row) => row.textContent)).toEqual(['1. line 5', '2. line 6']);
		expect(Number(gamma.querySelector('rect')!.getAttribute('height'))).toBe(44 + 2 * 15);
		// The separator sits under the card body, the rows below it.
		const sep = gamma.querySelector('.rg-details line')!;
		expect(Number(sep.getAttribute('y1'))).toBe(44);
		click(rows[1]!);
		expect(shows).toEqual([{ path: 'src/main.c', line: 5 }]);
		// The row's click never doubled as the card's definition show; the card's own
		// click still is one — the row rides the edge's own site file (main.c), the
		// card's the definition's (c.c). The editor never opened for either.
		gamma.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		await flush();
		expect(shows).toEqual([
			{ path: 'src/main.c', line: 5 },
			{ path: 'src/c.c', line: 1 }
		]);
		expect(opens).toEqual([]);
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

/** The window's backend: the outline answers, the graph's asks record; the locals never
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

	it('a graph card click forwards the subject to the Definition page feed', async () => {
		scriptWindow();
		const { host, view } = mountWindow();
		const shows: { name: string; path: string; line: number }[] = [];
		view.onShowDefinition = (subject) => shows.push({ name: subject.name, path: subject.path, line: subject.line });
		view.setFile(FILE, 8); // the cursor inside main — the root card
		await until(() => host.querySelector('.rg-card'));
		const card = host.querySelector<SVGGElement>('.rg-card')!;
		card.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		await flush();
		// The window's own hook answers in the Definition page's vocabulary (0-based).
		expect(shows).toEqual([{ name: 'main', path: 'src/main.c', line: 6 }]);
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
		const pin = host.querySelector('.sw-graph-head .rg-controls .rg-pin')!;
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

/* ---------- The three views, history and rules (2026-11-23) ---------- */

describe("the three views, history and rules", () => {
	beforeEach(() => {
		localStorage.clear();
		backend.reset();
		updateSetting('locale', 'en');
		scriptEngine();
	});

	it('the view key cycles Outline → Graph Horizontal → Graph Vertical, the Outline speaking its four columns', async () => {
		const view = mountView();
		view.setRoot({ ...ROOT });
		await untilCards(4);
		const viewButton = view.controls.querySelector('.rg-view')!;
		// The button names the view it shows; the click walks the cycle.
		expect(viewButton.textContent).toContain('Graph Vertical');
		click(viewButton);
		await flush();
		// The first step is the Outline: the board hides, the list shows.
		expect(view.controls.querySelector('.rg-view')!.textContent).toContain('Outline');
		expect((view.element.querySelector('.rg-stage') as HTMLElement).style.display).toBe('none');
		const head = [...view.element.querySelectorAll<HTMLElement>('.rg-ol-head > span')]
			.map((span) => span.textContent)
			.filter((text) => text !== '');
		expect(head).toEqual(['Referenced by Functions', 'Count', 'File', 'Line']);
		// The rows: the root with its suffix, then the ring — name, count, file, 1-based line.
		const rows = [...view.element.querySelectorAll<HTMLElement>('.rg-ol-row')];
		// The cut-short root keeps its ⋯ in the list too, and every row of a
		// referenced-by view reads as a caller — the caller suffix on each.
		expect(rows.map((row) => row.querySelector('.rg-ol-name')?.textContent)).toEqual([
			'alpha ⋯ Callers',
			'beta Callers',
			'gamma Callers',
			'Config Callers'
		]);
		expect(rows[2]!.querySelector('.rg-ol-count')?.textContent).toBe('2');
		expect(rows[1]!.querySelector('.rg-ol-file')?.textContent).toBe('b.c');
		expect(rows[1]!.querySelector('.rg-ol-line')?.textContent).toBe('3');
		// The second step is the horizontal board — its cards carry the same rings.
		click(viewButton);
		await flush();
		expect(view.controls.querySelector('.rg-view')!.textContent).toContain('Graph Horizontal');
		expect((view.element.querySelector('.rg-stage') as HTMLElement).style.display).toBe('');
		// The third step is back on the vertical board, the rings' state carried across.
		click(viewButton);
		await flush();
		expect(view.controls.querySelector('.rg-view')!.textContent).toContain('Graph Vertical');
		expect(cards().length).toBe(4);
		// The cycle's title is the command itself.
		expect(viewButton.title).toBe('Next Relation Window View');
		view.dispose();
	});

	it('the Outline rows show their jump in the Definition page, the twistie folds', async () => {
		const view = mountView();
		const opens: string[] = [];
		const shows: { path: string; line: number }[] = [];
		view.onOpen = (path, line) => opens.push(`${path}:${line}`);
		view.onShowDefinition = (subject) => shows.push({ path: subject.path, line: subject.line });
		view.setRoot({ ...ROOT });
		await untilCards(4);
		click(view.controls.querySelector('.rg-view')!);
		await flush();
		const rows = [...view.element.querySelectorAll<HTMLElement>('.rg-ol-row')];
		click(rows[1]!); // beta's row — the show, not the editor's open
		expect(shows).toEqual([{ path: 'src/b.c', line: 2 }]);
		expect(opens).toEqual([]);
		// gamma's twistie drills its ring right in the list: its beta is already drawn,
		// so the list grows no second beta row — the fold shows as the extra arrow.
		const gammaTwist = rows[2]!.querySelector('.rg-ol-toggle')!;
		click(gammaTwist);
		await flush();
		const after = [...view.element.querySelectorAll<HTMLElement>('.rg-ol-row')];
		expect(after.map((row) => row.querySelector('.rg-ol-name')?.textContent)).toContain('gamma Callers');
		expect(after.length).toBe(4); // root, beta, gamma, Config — gamma's beta is the cross edge
		// Back on a graph view the drill's cross edge is there.
		click(view.controls.querySelector('.rg-view')!);
		await flush();
		click(view.controls.querySelector('.rg-view')!);
		await flush();
		expect(edgePairs().length).toBe(4);
		view.dispose();
	});

	it('the horizontal layout advances a column per depth and stacks the siblings along Y', async () => {
		const view = mountView();
		view.setRoot({ ...ROOT });
		await untilCards(4);
		view.setViewMode('graphHorizontal');
		await flush();
		const rootSpot = spot(cardOf('alpha'));
		const rootW = Number(cardOf('alpha').querySelector('rect')!.getAttribute('width'));
		const betaSpot = spot(cardOf('beta'));
		const gammaSpot = spot(cardOf('gamma'));
		// The children sit one column right of the root, stacked without overlap.
		expect(betaSpot.x).toBeGreaterThan(rootSpot.x + rootW);
		expect(betaSpot.y).not.toBe(gammaSpot.y);
		// The root sits centered over the layer-1 column band.
		const rootCy = rootSpot.y + Number(cardOf('alpha').querySelector('rect')!.getAttribute('height')) / 2;
		const l1Cards = [cardOf('beta'), cardOf('gamma'), cardOf('Config')];
		const minY = Math.min(...l1Cards.map((c) => spot(c).y));
		const maxY = Math.max(...l1Cards.map((c) => spot(c).y + Number(c.querySelector('rect')!.getAttribute('height'))));
		expect(Math.abs(rootCy - (minY + maxY) / 2)).toBeLessThan(1);
		// The expander stands on the card's right face now.
		const exp = expanders().find((box) => box.dataset.for === cardOf('alpha').dataset.id)!;
		const expSpot = spot(exp);
		expect(expSpot.x).toBeGreaterThan(rootSpot.x + rootW);
		// The view persists — a fresh view comes back horizontal.
		const again = mountView();
		expect(again.element.querySelector('.rg-outline')!.getAttribute('style')).toContain('none');
		again.dispose();
		view.dispose();
	});

	it('the view choice persists across a fresh view', () => {
		localStorage.clear();
		const view = mountView();
		view.setViewMode('outline');
		view.dispose();
		const again = new RelationGraphView();
		expect((again.element.querySelector('.rg-stage') as HTMLElement).style.display).toBe('none');
		again.dispose();
	});
});

describe("the visited roots' history and the category rules", () => {
	beforeEach(() => {
		localStorage.clear();
		backend.reset();
		updateSetting('locale', 'en');
		scriptEngine();
	});

	it('Back and Forward replay the visited roots', async () => {
		const view = mountView();
		view.setRoot({ ...ROOT });
		await untilCards(4);
		expect((view.controls.querySelector('.rg-back') as HTMLButtonElement).disabled).toBe(true);
		// A re-root joins the history; the back button wakes.
		view.setRoot({ kind: 'function', name: 'beta', path: 'src/b.c', line: 2 });
		await flush();
		expect((view.controls.querySelector('.rg-back') as HTMLButtonElement).disabled).toBe(false);
		click(view.controls.querySelector('.rg-back')!);
		await flush();
		expect(backend.callsTo('symbol_relation_children').at(-1)!['name']).toBe('alpha');
		click(view.controls.querySelector('.rg-forward')!);
		await flush();
		expect(backend.callsTo('symbol_relation_children').at(-1)!['name']).toBe('beta');
		view.dispose();
	});

	it('the root category names the opening type, and a manual pick rides within the category', async () => {
		const view = mountView();
		// A function root opens under the rules' own default, References.
		view.setRoot({ ...ROOT });
		await flush();
		expect(backend.callsTo('symbol_relation_children').at(-1)!['direction']).toBe('referencedByFunctions');
		// Crossing to a struct re-opens under Contains.
		view.setRoot({ kind: 'struct', name: 'Config', path: 'src/d.c', line: 0 });
		await flush();
		expect(backend.callsTo('symbol_relation_children').at(-1)!['direction']).toBe('contains');
		// A sibling struct keeps the type — no reset within the category.
		view.setRoot({ kind: 'struct', name: 'Other', path: 'src/o.c', line: 0 });
		await flush();
		expect(backend.callsTo('symbol_relation_children').at(-1)!['direction']).toBe('contains');
		// And back to a function restores its own.
		view.setRoot({ kind: 'function', name: 'beta', path: 'src/b.c', line: 2 });
		await flush();
		expect(backend.callsTo('symbol_relation_children').at(-1)!['direction']).toBe('referencedByFunctions');
		view.dispose();
	});

	it('Expand Special expands the subtree an asked number of levels, and the menu names it', async () => {
		const view = mountView();
		view.setRoot({ ...ROOT });
		await untilCards(4);
		// The card menu carries the Expand Special entry.
		cardOf('alpha').dispatchEvent(new MouseEvent('contextmenu', { clientX: 10, clientY: 10, bubbles: true }));
		expect(menuLabels()).toContain('Expand Special…');
		document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
		// "to 2 levels": the root's children expand their rings too — gamma asks once.
		const asked = backend.callsTo('symbol_relation_children').length;
		await view.expandLevels(cardOf('alpha').dataset.id!, 2);
		const gammaAsk = backend.callsTo('symbol_relation_children').slice(asked).find((call) => call['name'] === 'gamma');
		expect(gammaAsk).toBeTruthy();
		// gamma's ring re-names the drawn beta — the cards stay four, the arrows grow.
		expect(cards().length).toBe(4);
		expect(edgePairs().length).toBeGreaterThan(3);
		view.dispose();
	});
});
