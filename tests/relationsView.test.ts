// The Relations panel (module 5): the cursor symbol's expandable reference tree over the
// bottom panel — the root chip's definition jump, the per-node `+` drill-down with its
// cached rings, the empty-ring and depth-cap notes, the direction switch, the cut-short
// ring's closing line, the reference-site count badge, the hover's declaration card, and
// the workbench wiring (the palette command, the panel page, the zh-cn pairs).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RelationsView } from '../src/features/search';
import { commands } from '../src/platform/commands';
import { trText } from '../src/platform/i18n';
import { updateSetting } from '../src/platform/settings';
import { Workbench } from '../src/workbench';
import { backend } from './tauriMock';
import { click, flush, hover, key, texts } from './helpers';
import type { RelationAnswer, RelationNode } from '../src/platform/ipc/symbols';

const ROOT = { kind: 'function', name: 'alpha', path: 'src/a.ts', line: 0 };

const CHILDREN: RelationNode[] = [
	{ kind: 'function', name: 'beta', container: null, path: 'src/b.ts', line: 2, edgePath: 'main.ts', edgeLine: 1, edgeKind: 'call', edgeCount: 1, hasChildren: false },
	{ kind: 'method', name: 'load', container: 'Config', path: 'src/c.ts', line: 4, edgePath: 'src/b.ts', edgeLine: 5, edgeKind: 'use', edgeCount: 1, hasChildren: true },
	{ kind: 'variable', name: 'cap', container: null, path: 'src/d.ts', line: 0, edgePath: 'src/c.ts', edgeLine: 6, edgeKind: 'use', edgeCount: 1, hasChildren: false }
];

const FROM_CHILDREN: RelationNode[] = [
	{ kind: 'function', name: 'callee', container: null, path: 'src/e.ts', line: 1, edgePath: 'src/a.ts', edgeLine: 2, edgeKind: 'call', edgeCount: 1, hasChildren: false }
];

const DEEP: RelationNode = { kind: 'function', name: 'deep', container: null, path: 'src/e.ts', line: 8, edgePath: 'src/c.ts', edgeLine: 7, edgeKind: 'call', edgeCount: 1, hasChildren: false };

/** The `symbol_relation_children` answer's shape: the ring and whether it was cut short. */
const answer = (nodes: RelationNode[], truncated = false): RelationAnswer => ({ nodes, truncated });

beforeEach(() => {
	backend.reset();
	updateSetting('locale', 'en');
});

afterEach(() => {
	// A hover test that died mid-card must not leave fake timers holding the suite's
	// flush()es hostage.
	vi.useRealTimers();
});

function mountView(): RelationsView {
	const view = new RelationsView();
	document.body.appendChild(view.element);
	return view;
}

function rowOf(host: ParentNode, name: string): HTMLElement {
	return Array.from(host.querySelectorAll<HTMLElement>('.rel-row')).find((row) => row.querySelector('.rel-name')?.textContent === name)!;
}

/** Let the fetch microtasks settle while the fake clock runs — flush()'s real setTimeout
 *  would hang underneath it, so the fake advance yields instead. */
async function settleFake(): Promise<void> {
	for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(0);
}

/** The declaration lookup and file read the hover's card rides, for `beta` at src/b.ts:2
 *  whose definition body spans lines 2..4. */
function scriptDecl(): void {
	backend.on('symbol_lookup', ({ name }) => {
		expect(name).toBe('beta');
		return [
			{ kind: 'variable', name: 'beta', path: 'other/elsewhere.ts', line: 9, endLine: 9 },
			{ kind: 'function', name: 'beta', path: 'src/b.ts', line: 2, endLine: 4 }
		];
	});
	backend.on('read_file', ({ path }) => {
		if (String(path).replaceAll('\\', '/') !== 'src/b.ts') throw new Error(`${path}: not found`);
		return { contents: 'const pre = 0;\nconst also = 1;\nfunction beta() {\n  alpha();\n}\nconst after = 5;\n', binary: false, size: 66, encoding: 'utf8', eol: 'lf' };
	});
}

describe('the root chip and the first ring', () => {
	it('rests empty with the cursor hint', () => {
		const view = mountView();
		expect(view.element.querySelector('.rel-empty')!.textContent).toContain('cursor on a symbol');
		expect(view.element.querySelector('.rel-row')).toBeNull();
	});

	it('shows the resolution note beside the hint', () => {
		const view = mountView();
		view.setRoot(null, '3 symbols share this name');
		expect(view.element.querySelector('.rel-empty')!.textContent).toBe('3 symbols share this name');
	});

	it('renders the root chip and the children with kind icons, containers and 1-based lines', async () => {
		backend.on('symbol_relation_children', ({ name, path, line, direction }) => {
			expect(name).toBe('alpha');
			expect(path).toBe('src/a.ts');
			expect(line).toBe(0);
			expect(direction).toBe('refsTo');
			return answer(CHILDREN);
		});
		const view = mountView();
		view.setRoot(ROOT);
		// The fetch is in flight: the loading state answers before the ring arrives.
		expect(view.element.querySelector('.rel-tree')!.textContent).toContain('Loading');
		await flush(4);

		expect(view.element.querySelector('.rel-root-name')!.textContent).toBe('alpha');
		expect(view.element.querySelector('.rel-root-loc')!.textContent).toBe('src/a.ts:1');
		expect(texts('.rel-row .rel-name', view.element)).toEqual(['beta', 'load', 'cap']);
		// The edge column is 1-based and shortened to the file's basename; the row's title
		// carries the node definition's full path.
		expect(texts('.rel-row .rel-edge', view.element)).toEqual(['main.ts:2', 'b.ts:6', 'c.ts:7']);
		expect(rowOf(view.element, 'beta').title).toBe('src/b.ts:3');
		expect(rowOf(view.element, 'beta').querySelector('.rel-edge')!.getAttribute('title')).toBe('main.ts:2');
		// The method's container rides as the faint prefix, with the kind's icon beside it.
		expect(rowOf(view.element, 'load').querySelector('.rel-container')!.textContent).toBe('Config·');
		expect(rowOf(view.element, 'load').querySelector('.codicon')!.className).toContain('symbol-method');
		// A hasChildren=false node carries the leaf placeholder, never an expand button.
		expect(rowOf(view.element, 'beta').querySelector('button.rel-twistie')).toBeNull();
		expect(rowOf(view.element, 'beta').querySelector('.rel-twistie')).not.toBeNull();
	});

	it('answers an empty ring with the wording of its direction', async () => {
		backend.on('symbol_relation_children', () => answer([]));
		const view = mountView();
		view.setRoot(ROOT);
		await flush(4);
		expect(view.element.querySelector('.rel-tree .rel-empty')!.textContent).toContain('Nothing references this symbol');

		// The other direction's empty ring has its own wording (the flip re-asks with refsFrom).
		backend.on('symbol_relation_children', ({ direction }) => {
			expect(direction).toBe('refsFrom');
			return answer([]);
		});
		click(view.element.querySelectorAll('.rel-dir')[1]);
		await flush(4);
		expect(view.element.querySelector('.rel-tree .rel-empty')!.textContent).toContain('references nothing the index holds');
	});

	it('notes a failed fetch instead of rows', async () => {
		backend.on('symbol_relation_children', () => {
			throw new Error('index gone');
		});
		const view = mountView();
		view.setRoot(ROOT);
		await flush(4);
		expect(view.element.querySelector('.rel-tree .rel-empty')!.textContent).toContain('did not answer');
	});
});

describe('the drill-down', () => {
	function scriptRings(): void {
		backend.on('symbol_relation_children', ({ name, path, line, direction }) => {
			expect(direction).toBe('refsTo');
			if (name === 'alpha') return answer(CHILDREN);
			if (name === 'load') {
				expect(path).toBe('src/c.ts');
				expect(line).toBe(4);
				return answer([DEEP]);
			}
			return answer([]);
		});
	}

	it('expands a node lazily at its own coordinates and collapses without re-asking', async () => {
		scriptRings();
		const view = mountView();
		view.setRoot(ROOT);
		await flush(4);
		expect(backend.callsTo('symbol_relation_children')).toHaveLength(1);

		const twistie = rowOf(view.element, 'load').querySelector('button.rel-twistie')!;
		expect(twistie.textContent).toBe('+');
		click(twistie);
		await flush(6);
		// The expansion asked the node's own coordinates, and the child nested beneath it.
		expect(backend.callsTo('symbol_relation_children')).toHaveLength(2);
		expect(backend.callsTo('symbol_relation_children')[1]).toMatchObject({ name: 'load', path: 'src/c.ts', line: 4, direction: 'refsTo' });
		const loadRow = rowOf(view.element, 'load');
		const host = loadRow.nextElementSibling!;
		expect(host.classList.contains('rel-children')).toBe(true);
		expect(host.hidden).toBe(false);
		expect(texts('.rel-name', host)).toEqual(['deep']);
		expect(twistie.textContent).toBe('−');

		// The collapse keeps the ring: no request, the child host hides.
		click(twistie);
		expect(host.hidden).toBe(true);
		expect(twistie.textContent).toBe('+');
		expect(backend.callsTo('symbol_relation_children')).toHaveLength(2);

		// The re-expansion serves the cached ring, never a second ask.
		click(twistie);
		expect(host.hidden).toBe(false);
		expect(texts('.rel-name', host)).toEqual(['deep']);
		expect(backend.callsTo('symbol_relation_children')).toHaveLength(2);
	});

	it('remembers an optimistically empty ring instead of asking it again', async () => {
		backend.on('symbol_relation_children', ({ name }) => (name === 'alpha' ? answer(CHILDREN) : answer([])));
		const view = mountView();
		view.setRoot(ROOT);
		await flush(4);
		const twistie = rowOf(view.element, 'load').querySelector('button.rel-twistie')!;
		click(twistie);
		await flush(6);
		expect(backend.callsTo('symbol_relation_children')).toHaveLength(2);
		const host = rowOf(view.element, 'load').nextElementSibling!;
		expect(host.querySelector('.rel-note')!.textContent).toContain('No further references');

		// Collapse and re-expand: the empty answer is remembered, the note persists.
		click(twistie);
		click(twistie);
		expect(backend.callsTo('symbol_relation_children')).toHaveLength(2);
		expect(host.querySelector('.rel-note')!.textContent).toContain('No further references');
	});

	it('collapses every expansion and refetches when the direction flips', async () => {
		backend.on('symbol_relation_children', ({ name, direction }) => {
			if (name !== 'alpha') {
				// The load ring carries one child, so the collapse check below has something
				// that was actually expanded.
				expect(name).toBe('load');
				return answer([DEEP]);
			}
			expect(direction === 'refsTo' || direction === 'refsFrom').toBe(true);
			return direction === 'refsFrom' ? answer(FROM_CHILDREN) : answer(CHILDREN);
		});
		const view = mountView();
		view.setRoot(ROOT);
		await flush(4);
		click(rowOf(view.element, 'load').querySelector('button.rel-twistie')!);
		await flush(6);
		expect(texts('.rel-row .rel-name', view.element)).toContain('deep');

		const directions = view.element.querySelectorAll('.rel-dir');
		expect(texts('.rel-dir', view.element)).toEqual(['References to', 'References from']);
		click(directions[1]);
		await flush(6);
		// The root's ring was re-asked with the flipped direction, and the old expansion
		// did not survive the rebuild.
		const calls = backend.callsTo('symbol_relation_children');
		expect(calls[calls.length - 1]).toMatchObject({ name: 'alpha', direction: 'refsFrom' });
		expect(texts('.rel-row .rel-name', view.element)).toEqual(['callee']);
		expect(view.element.querySelector('.rel-children:not([hidden])')).toBeNull();
	});

	it('answers the depth cap with a faint note instead of a request', async () => {
		let serial = 0;
		backend.on('symbol_relation_children', () => answer([
			{ kind: 'function', name: `d${++serial}`, container: null, path: `src/${serial}.ts`, line: 0, edgePath: 'main.ts', edgeLine: 0, edgeKind: 'call', edgeCount: 1, hasChildren: true }
		]));
		const view = mountView();
		view.setRoot(ROOT);
		await flush(4);
		expect(backend.callsTo('symbol_relation_children')).toHaveLength(1);

		// Drill seven rings deep: every expansion yields exactly one child.
		for (let depth = 1; depth < 8; depth++) {
			const rows = view.element.querySelectorAll<HTMLElement>('.rel-row');
			click(rows[rows.length - 1]!.querySelector('button.rel-twistie')!);
			await flush(4);
		}
		expect(backend.callsTo('symbol_relation_children')).toHaveLength(8, 'the root plus seven rings');
		const deepest = view.element.querySelectorAll<HTMLElement>('.rel-row');
		const last = deepest[deepest.length - 1]!;
		click(last.querySelector('button.rel-twistie')!);
		await flush(4);
		// The eighth ring never asked: the faint line answers, the ask count stands.
		expect(backend.callsTo('symbol_relation_children')).toHaveLength(8);
		expect(last.nextElementSibling!.textContent).toContain('Maximum tree depth reached');
	});
});

describe('the cut-short ring and the count badge', () => {
	it('closes a truncated ring with the faint note, at the root and inside an expansion', async () => {
		backend.on('symbol_relation_children', ({ name }) => (name === 'alpha' ? answer(CHILDREN, true) : answer([], true)));
		const view = mountView();
		view.setRoot(ROOT);
		await flush(4);
		// The root's own ring ends with the note.
		expect(texts('.rel-tree .rel-note', view.element)).toEqual(['More references exist — the list was cut short.']);

		// The expansion's ring ends with its own note (its empty answer also says why).
		click(rowOf(view.element, 'load').querySelector('button.rel-twistie')!);
		await flush(6);
		const host = rowOf(view.element, 'load').nextElementSibling!;
		const notes = texts('.rel-note', host);
		expect(notes.some((note) => note.includes('cut short'))).toBe(true);
		expect(backend.callsTo('symbol_relation_children')).toHaveLength(2);
	});

	it('keeps a complete ring free of the note', async () => {
		backend.on('symbol_relation_children', ({ name }) => (name === 'alpha' ? answer(CHILDREN) : answer([])));
		const view = mountView();
		view.setRoot(ROOT);
		await flush(4);
		expect(view.element.querySelector('.rel-truncated')).toBeNull();
		expect(texts('.rel-note', view.element)).toEqual([]);
	});

	it('badges an aggregated edge with ×N and its reference-site title, never a single site', async () => {
		const counted: RelationNode[] = [
			{ ...CHILDREN[0]!, edgeCount: 3 },
			{ ...CHILDREN[1]!, edgeCount: 1 },
			{ ...CHILDREN[2]!, edgeCount: 2 }
		];
		backend.on('symbol_relation_children', () => answer(counted));
		const view = mountView();
		view.setRoot(ROOT);
		await flush(4);
		const beta = rowOf(view.element, 'beta').querySelector('.rel-edge-count')!;
		expect(beta.textContent).toBe('×3');
		expect(beta.getAttribute('title')).toBe('3 reference sites');
		expect(rowOf(view.element, 'cap').querySelector('.rel-edge-count')!.textContent).toBe('×2');
		// A single reference site carries no badge at all.
		expect(rowOf(view.element, 'load').querySelector('.rel-edge-count')).toBeNull();
	});
});

describe('the hover declaration card', () => {
	it('floats the sliced declaration after a 300ms rest, with the in-file-at-line caption', async () => {
		vi.useFakeTimers();
		scriptDecl();
		backend.on('symbol_relation_children', () => answer(CHILDREN));
		const view = mountView();
		view.setRoot(ROOT);
		await settleFake();

		// A quick pass across the row shows nothing: the rest timer died with the leave.
		const row = rowOf(view.element, 'beta');
		hover(row);
		row.dispatchEvent(new MouseEvent('mouseleave'));
		await vi.advanceTimersByTimeAsync(400);
		expect(document.querySelector('.rel-decl')).toBeNull();

		// A real rest floats the card: the definition's first lines (the same-path def was
		// picked over the elsewhere one) and the caption with the 1-based line.
		hover(row);
		await vi.advanceTimersByTimeAsync(300);
		await settleFake();
		const card = document.querySelector<HTMLElement>('.rel-decl')!;
		expect(card.querySelector('pre')!.textContent).toBe('function beta() {\n  alpha();\n}');
		expect(card.querySelector('.rel-decl-meta')!.textContent).toBe('function in b.ts at line 3');
		expect(backend.callsTo('symbol_lookup')).toHaveLength(1);

		// Sliding to another row retires the card; a symbol the index does not know floats
		// nothing (the empty fetch is silent).
		row.dispatchEvent(new MouseEvent('mouseleave'));
		expect(document.querySelector('.rel-decl')).toBeNull();
		hover(rowOf(view.element, 'cap'));
		await vi.advanceTimersByTimeAsync(300);
		await settleFake();
		expect(document.querySelector('.rel-decl')).toBeNull();
		expect(backend.callsTo('symbol_lookup')).toHaveLength(2);

		// Resting on beta again serves the cached fragment: no third lookup.
		hover(row);
		await vi.advanceTimersByTimeAsync(300);
		await settleFake();
		expect(document.querySelector('.rel-decl')!.querySelector('pre')!.textContent).toBe('function beta() {\n  alpha();\n}');
		expect(backend.callsTo('symbol_lookup')).toHaveLength(2);
		vi.useRealTimers();
	});

	it('keeps the card while the pointer enters it, and dismisses on leave, scroll, Escape and an outside press', async () => {
		vi.useFakeTimers();
		scriptDecl();
		backend.on('symbol_relation_children', () => answer(CHILDREN));
		const view = mountView();
		view.setRoot(ROOT);
		await settleFake();

		const row = rowOf(view.element, 'beta');
		hover(row);
		await vi.advanceTimersByTimeAsync(300);
		await settleFake();
		const card = document.querySelector<HTMLElement>('.rel-decl')!;
		expect(card).not.toBeNull();

		// Sliding off the row INTO the card keeps it (the card is reachable); leaving the
		// card itself dismisses it.
		row.dispatchEvent(new MouseEvent('mouseleave', { relatedTarget: card }));
		expect(document.querySelector('.rel-decl')).toBe(card);
		card.dispatchEvent(new MouseEvent('mouseleave'));
		expect(document.querySelector('.rel-decl')).toBeNull();

		// Again, for the other dismissals.
		hover(row);
		await vi.advanceTimersByTimeAsync(300);
		await settleFake();
		// A scroll of the tree retires it.
		view.element.querySelector('.rel-body')!.dispatchEvent(new Event('scroll'));
		expect(document.querySelector('.rel-decl')).toBeNull();

		hover(row);
		await vi.advanceTimersByTimeAsync(300);
		await settleFake();
		// Escape dismisses it.
		key(document, 'Escape');
		expect(document.querySelector('.rel-decl')).toBeNull();

		hover(row);
		await vi.advanceTimersByTimeAsync(300);
		await settleFake();
		// Any press outside the card dismisses it.
		document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
		expect(document.querySelector('.rel-decl')).toBeNull();
		vi.useRealTimers();
	});

	it('leaves no card behind a root switch', async () => {
		vi.useFakeTimers();
		backend.on('symbol_relation_children', ({ name }) => answer(name === 'alpha' ? CHILDREN : []));
		backend.on('symbol_lookup', () => [{ kind: 'function', name: 'alpha', path: 'src/a.ts', line: 0, endLine: 0 }]);
		backend.on('read_file', ({ path }) => {
			if (String(path).replaceAll('\\', '/') !== 'src/a.ts') throw new Error(`${path}: not found`);
			return { contents: 'function alpha() {}\n', binary: false, size: 18, encoding: 'utf8', eol: 'lf' };
		});
		const view = mountView();
		view.setRoot(ROOT);
		await settleFake();

		// The root chip floats its own declaration after the rest.
		hover(view.element.querySelector('.rel-root')!);
		await vi.advanceTimersByTimeAsync(300);
		await settleFake();
		const card = document.querySelector<HTMLElement>('.rel-decl')!;
		expect(card.querySelector('pre')!.textContent).toBe('function alpha() {}');
		expect(card.querySelector('.rel-decl-meta')!.textContent).toBe('function in a.ts at line 1');

		// A root switch retires the card at once, and it never floats back.
		view.setRoot({ kind: 'function', name: 'gamma', path: 'src/g.ts', line: 0 });
		expect(document.querySelector('.rel-decl')).toBeNull();
		await settleFake();
		expect(document.querySelector('.rel-decl')).toBeNull();
		vi.useRealTimers();
	});
});

describe('the jumps and the pin', () => {
	it('opens the definition on the name and the reference site on the edge and the double click', async () => {
		backend.on('symbol_relation_children', () => answer(CHILDREN));
		const view = mountView();
		const opened: { path: string; line: number }[] = [];
		view.onOpen = (path, line) => opened.push({ path, line });
		view.setRoot(ROOT);
		await flush(4);

		click(rowOf(view.element, 'beta').querySelector('.rel-name'));
		expect(opened.at(-1)).toEqual({ path: 'src/b.ts', line: 3 });
		click(rowOf(view.element, 'beta').querySelector('.rel-edge'));
		expect(opened.at(-1)).toEqual({ path: 'main.ts', line: 2 });
		// The row's double click lands on the reference site.
		rowOf(view.element, 'beta').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
		expect(opened.at(-1)).toEqual({ path: 'main.ts', line: 2 });
		// A double click on the name must not ALSO drag the editor to the reference site.
		rowOf(view.element, 'beta').querySelector('.rel-name')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
		expect(opened.at(-1)).toEqual({ path: 'main.ts', line: 2 });
		// The root chip jumps to the root's definition.
		click(view.element.querySelector('.rel-root'));
		expect(opened.at(-1)).toEqual({ path: 'src/a.ts', line: 1 });
	});

	it('pins against the auto-follow and asks the workbench for a root on shown()', () => {
		const view = mountView();
		expect(view.isPinned()).toBe(false);
		click(view.actions.querySelector<HTMLButtonElement>('.action-btn'));
		expect(view.isPinned()).toBe(true);
		expect(view.element.classList.contains('pinned')).toBe(true);
		expect(view.actions.querySelector('.action-btn')!.getAttribute('title')).toContain('Unpin');
		click(view.actions.querySelector<HTMLButtonElement>('.action-btn'));
		expect(view.isPinned()).toBe(false);

		let asked = 0;
		view.onNeedRoot = () => asked++;
		view.shown();
		expect(asked).toBe(1);
	});
});

describe('the workbench wiring', () => {
	/** The proven boot table (tests/symbolWindow.test.ts): the workbench constructor and
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
		const command = commands.get('workbench.showRelations');
		expect(command).toBeDefined();
		expect(commands.paletteItems().some((item) => item.value === 'workbench.showRelations')).toBe(true);

		updateSetting('locale', 'zh-cn');
		expect(trText('Relations')).toBe('关系');
		expect(texts('.panel-title')).toContain('关系');
		updateSetting('locale', 'en');
		expect(texts('.panel-title')).toContain('Relations');
	});

	it('shows the panel page, re-resolves the cursor symbol through shown(), and renders the ring', async () => {
		backend.on('read_file', ({ path }) => {
			const windows = String(path).replaceAll('/', '\\');
			if (windows.endsWith('main.ts')) return { contents: 'alpha();\n', binary: false, size: 8, encoding: 'utf8', eol: 'lf' };
			if (windows.endsWith('a.ts')) return { contents: 'function alpha() {}\n', binary: false, size: 18, encoding: 'utf8', eol: 'lf' };
			throw new Error(`${path}: not found`);
		});
		backend.on('symbol_lookup', () => [{ kind: 'function', name: 'alpha', path: 'src/a.ts', line: 0 }]);
		backend.on('symbol_relation_children', ({ name, direction }) => {
			expect(name).toBe('alpha');
			expect(direction).toBe('refsTo');
			return answer(CHILDREN);
		});

		// The cursor symbol's follow only rides the page being looked at: the editor
		// activated while the relations page was dark asked for nothing.
		await workbench.editors.openFile('C:\\repo\\main.ts');
		await flush(4);
		expect(backend.callsTo('symbol_relation_children')).toHaveLength(0);

		workbench.panel.show('relations');
		expect(workbench.panel.activeView()).toBe('relations');
		expect(workbench.panel.relations.element.hidden).toBe(false);
		// The page's shown() asked for the root; the debounced resolution runs the lookup
		// and then the ring (the real 150 ms timer, waited out).
		await new Promise((resolve) => setTimeout(resolve, 220));
		await flush(6);
		expect(backend.callsTo('symbol_relation_children')).toHaveLength(1);
		expect(backend.callsTo('symbol_relation_children')[0]).toMatchObject({ name: 'alpha', direction: 'refsTo' });
		expect(texts('.rel-row .rel-name', workbench.panel.relations.element)).toEqual(['beta', 'load', 'cap']);

		// A definition jump joins the workspace root (the index speaks repo-relative paths):
		// the root chip's click lands in a.ts at its 1-based definition line.
		click(workbench.panel.relations.element.querySelector('.rel-root'));
		await flush(6);
		expect(document.querySelector('.tab.active .label')!.textContent).toBe('a.ts');
	});
});
