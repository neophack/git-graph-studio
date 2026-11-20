// The hover card's rendering, in isolation: every test builds a SymbolQuickInfo literal
// and asserts the DOM quickInfoDom answers — the kind tags, the members block, the
// reference-count footer (over the registered relations opener or static without one),
// the definitions-overflow line, and the plain comment/body/location fields. No backend:
// the data assembly lives in editorProviderViews and degrades to absent fields here.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	quickInfoDom,
	type HoverCardActions,
	type HoverMember,
	type SymbolQuickInfo,
	type SymbolQuickInfoEntry
} from '../src/features/editor/hoverCard';
import { setHoverRelationsOpener } from '../src/features/editor/hoverRelations';

beforeEach(() => {
	document.body.innerHTML = '';
});

afterEach(() => {
	// The opener is module state — a test that registered one must not leak it into the
	// later static-footer cases.
	setHoverRelationsOpener(null);
});

/** A full entry from a few fields: the optional ones default to the degraded shapes. */
function entry(partial: Partial<SymbolQuickInfoEntry> & { path: string; kind?: string }): SymbolQuickInfoEntry {
	return {
		kind: partial.kind ?? '',
		path: partial.path,
		line: partial.line ?? 0,
		text: partial.text ?? '',
		comment: partial.comment ?? '',
		body: partial.body ?? '',
		...(partial.members !== undefined ? { members: partial.members } : {})
	};
}

function info(partial: Partial<SymbolQuickInfo> & { name?: string }): SymbolQuickInfo {
	return {
		name: partial.name ?? 'add',
		entries: partial.entries ?? [],
		...(partial.total !== undefined ? { total: partial.total } : {}),
		...(partial.refFiles !== undefined ? { refFiles: partial.refFiles } : {})
	};
}

const FUNCTION_ENTRY = entry({
	kind: 'function',
	path: 'src/main.c',
	line: 1,
	text: 'int add(int a, int b)',
	comment: '/** Adds its arguments. */',
	body: 'int add(int a, int b)\n{\n\treturn a + b;\n}'
});

describe('hoverCard — the kind tag', () => {
	it('renders one tag per entry, the kind word capitalised', () => {
		const dom = quickInfoDom(
			info({
				entries: [FUNCTION_ENTRY, entry({ kind: 'struct', path: 'src/point.h', line: 0, text: 'struct Point {' })]
			})
		);
		const tags = dom.querySelectorAll('.ggs-symbol-hover-kind');
		expect(tags).toHaveLength(2);
		expect(tags[0]!.textContent).toBe('Function');
		expect(tags[1]!.textContent).toBe('Struct');
		// The tag sits at the entry's top, before the comment and the code.
		const first = dom.querySelector('.ggs-symbol-hover-entry')!;
		expect(first.firstElementChild!.className).toBe('ggs-symbol-hover-kind');
	});

	it('skips the tag when an entry carries no kind', () => {
		const dom = quickInfoDom(info({ entries: [entry({ path: 'inc/conf.h', line: 2, text: '#define MAX_LEN 256' })] }));
		expect(dom.querySelector('.ggs-symbol-hover-kind')).toBeNull();
		expect(dom.querySelector('.ggs-symbol-hover-code')!.textContent).toBe('#define MAX_LEN 256');
	});
});

describe('hoverCard — the members block', () => {
	const MEMBERS: HoverMember[] = [
		{ kind: 'method', name: 'run', line: 9 },
		{ kind: 'field', name: 'x', line: 2 }
	];
	const STRUCT_ENTRY = entry({ kind: 'struct', path: 'src/point.h', line: 0, text: 'typedef struct {', members: MEMBERS });

	it('renders the section header and one row per member with 1-based lines', () => {
		const dom = quickInfoDom(info({ entries: [STRUCT_ENTRY] }));
		expect(dom.querySelector('.ggs-symbol-hover-members-head')!.textContent).toBe('Members');
		const rows = dom.querySelectorAll('.ggs-symbol-hover-member');
		expect(rows).toHaveLength(2);
		expect(rows[0]!.querySelector('.ggs-symbol-hover-member-name')!.textContent).toBe('run');
		expect(rows[0]!.querySelector('.ggs-symbol-hover-member-line')!.textContent).toBe('10');
		expect(rows[1]!.querySelector('.ggs-symbol-hover-member-name')!.textContent).toBe('x');
		expect(rows[1]!.querySelector('.ggs-symbol-hover-member-line')!.textContent).toBe('3');
	});

	it('wired rows jump to the member declaration inside the declaring file', () => {
		const opened: { path: string; line: number }[] = [];
		const open: HoverCardActions['open'] = (path, line) => opened.push({ path, line });
		const dom = quickInfoDom(info({ entries: [STRUCT_ENTRY] }), { open });
		const rows = dom.querySelectorAll('button.ggs-symbol-hover-member');
		expect(rows).toHaveLength(2);
		rows[0]!.click();
		expect(opened).toEqual([{ path: 'src/point.h', line: 10 }]);
	});

	it('unwired rows render static and never fire', () => {
		const dom = quickInfoDom(info({ entries: [STRUCT_ENTRY] }));
		expect(dom.querySelectorAll('button.ggs-symbol-hover-member')).toHaveLength(0);
		const rows = dom.querySelectorAll('.ggs-symbol-hover-member');
		expect(rows[0]!.tagName).toBe('DIV');
		expect(() => rows[0]!.click()).not.toThrow();
	});

	it('renders nothing when the data half answers no members', () => {
		const absent = quickInfoDom(info({ entries: [FUNCTION_ENTRY] }));
		expect(absent.querySelector('.ggs-symbol-hover-members')).toBeNull();
		const empty = quickInfoDom(info({ entries: [entry({ kind: 'struct', path: 'p.h', line: 0, text: 'struct S {', members: [] })] }));
		expect(empty.querySelector('.ggs-symbol-hover-members')).toBeNull();
	});
});

describe('hoverCard — the reference footer', () => {
	it('renders the count and a wired relations button over the registered opener', () => {
		let got: { kind: string; name: string; path: string; line: number } | null = null;
		setHoverRelationsOpener((sym) => {
			got = sym;
		});
		const dom = quickInfoDom(
			info({ entries: [FUNCTION_ENTRY, entry({ kind: 'function', path: 'src/other.c', line: 0, text: 'int add(int a, int b);' })], refFiles: 3 })
		);
		expect(dom.querySelector('.ggs-symbol-hover-refs')!.textContent).toBe('Referenced in 3 file(s)');
		const relations = dom.querySelector('button.ggs-symbol-hover-relations');
		expect(relations).not.toBeNull();
		expect(relations!.textContent).toBe('Show the relation graph');
		relations!.click();
		// The opener receives the first candidate.
		expect(got).toEqual({ kind: 'function', name: 'add', path: 'src/main.c', line: 1 });
	});

	it('degrades the relations row to a static div when no opener is registered', () => {
		const dom = quickInfoDom(info({ entries: [FUNCTION_ENTRY], refFiles: 1 }));
		expect(dom.querySelector('.ggs-symbol-hover-refs')!.textContent).toBe('Referenced in 1 file(s)');
		const relations = dom.querySelector('.ggs-symbol-hover-relations')!;
		expect(relations.tagName).toBe('DIV');
		expect(dom.querySelector('button.ggs-symbol-hover-relations')).toBeNull();
		expect(() => relations.click()).not.toThrow();
	});

	it('renders no footer without a reference count, and no relations row without a candidate', () => {
		const absent = quickInfoDom(info({ entries: [FUNCTION_ENTRY] }));
		expect(absent.querySelector('.ggs-symbol-hover-footer')).toBeNull();
		// A count without any entry still answers the stat, minus the opener row — there
		// is nothing to hand it.
		const bare = quickInfoDom(info({ entries: [], refFiles: 4 }));
		expect(bare.querySelector('.ggs-symbol-hover-refs')!.textContent).toBe('Referenced in 4 file(s)');
		expect(bare.querySelector('.ggs-symbol-hover-relations')).toBeNull();
	});
});

describe('hoverCard — the definitions overflow line', () => {
	it('names the definitions past the rendered entries', () => {
		const dom = quickInfoDom(
			info({
				entries: [FUNCTION_ENTRY, entry({ kind: 'function', path: 'src/other.c', line: 0, text: 'int add(int a, int b);' }), entry({ kind: 'function', path: 'src/third.c', line: 4, text: 'int add(int a, int b);' })],
				total: 5
			})
		);
		const more = dom.querySelector('.ggs-symbol-hover-more');
		expect(more).not.toBeNull();
		expect(more!.textContent).toBe('+2 more definitions');
	});

	it('renders no overflow line without a total, or when the total fits the entries', () => {
		const noTotal = quickInfoDom(info({ entries: [FUNCTION_ENTRY] }));
		expect(noTotal.querySelector('.ggs-symbol-hover-more')).toBeNull();
		const fitting = quickInfoDom(info({ entries: [FUNCTION_ENTRY], total: 1 }));
		expect(fitting.querySelector('.ggs-symbol-hover-more')).toBeNull();
	});
});

describe('hoverCard — the plain fields keep rendering', () => {
	it('shows the head, the comment, the body whole and the clickable location', () => {
		const opened: string[] = [];
		const dom = quickInfoDom(info({ name: 'add', entries: [FUNCTION_ENTRY] }), {
			open: (path) => opened.push(path)
		});
		expect(dom.querySelector('.ggs-symbol-hover-head')!.textContent).toBe('add');
		expect(dom.querySelector('.ggs-symbol-hover-comment')!.textContent).toBe('/** Adds its arguments. */');
		expect(dom.querySelector('.ggs-symbol-hover-body')!.textContent).toBe('int add(int a, int b)\n{\n\treturn a + b;\n}');
		expect(dom.querySelectorAll('.ggs-symbol-hover-code')).toHaveLength(1, 'the signature rides inside the body, not beside it');
		const loc = dom.querySelector('button.ggs-symbol-hover-loc')!;
		expect(loc.textContent).toBe('src/main.c:2');
		loc.click();
		expect(opened).toEqual(['src/main.c']);
	});

	it('a scalar kind shows its declaration line only, and no optional block renders', () => {
		const dom = quickInfoDom(info({ name: 'z', entries: [entry({ kind: 'variable', path: 'src/point.h', line: 9, text: 'int z;' })] }));
		expect(dom.querySelector('.ggs-symbol-hover-body')).toBeNull();
		expect(dom.querySelector('.ggs-symbol-hover-code')!.textContent).toBe('int z;');
		expect(dom.querySelector('.ggs-symbol-hover-members')).toBeNull();
		expect(dom.querySelector('.ggs-symbol-hover-footer')).toBeNull();
		expect(dom.querySelector('.ggs-symbol-hover-more')).toBeNull();
	});

	it('an unread file shows its location only', () => {
		const dom = quickInfoDom(info({ name: 'gone', entries: [entry({ kind: 'variable', path: 'src/gone.c', line: 0 })] }));
		expect(dom.querySelector('.ggs-symbol-hover-code')).toBeNull();
		expect(dom.querySelector('.ggs-symbol-hover-comment')).toBeNull();
		expect(dom.querySelector('.ggs-symbol-hover-loc')!.textContent).toBe('src/gone.c:1');
	});
});
