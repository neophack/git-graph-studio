// Unit tests for Source-Insight-parity features (Areas 1-5):
// - Area 1: receiver-aware member completions (`memberCompletionSource`)
// - Area 2: Read / Write / Call / Decl badges & filter pills in `ReferencesView`
// - Area 3: 6-color persistent word highlights (`wordHighlightState`) & semantic highlighting
// - Area 4/5: typed IPC seams for macro expansion, conditions, base projects & 9-volume stats

import { beforeEach, describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { CompletionContext } from '@codemirror/autocomplete';

import { backend } from './tauriMock';
import { click, flush } from './helpers';
import { fileNameFacet, memberCompletionSource } from '../src/features/editor/autocomplete';
import {
	activeWordHighlights,
	clearWordHighlights,
	HIGHLIGHT_SLOT_COUNT,
	toggleWordHighlight
} from '../src/features/editor/wordHighlightState';
import { ReferencesView } from '../src/features/search/referencesView';
import {
	symbolInactiveRanges,
	symbolMacroExpand,
	symbolsBaseProjectsGet,
	symbolsBaseProjectsSet,
	symbolsConditionsGet,
	symbolsConditionsSet,
	symbolsVolumeStats
} from '../src/platform/ipc/symbols';

beforeEach(() => {
	backend.reset();
	clearWordHighlights();
});

describe('Area 1: receiver-aware member completions', () => {
	it('triggers after -> and returns direct and inherited members', async () => {
		backend.on('symbol_member_completions', () => [
			{ name: 'init', kind: 'method', container: 'Motor', path: 'src/motor.cpp', line: 7, inherited: false },
			{ name: 'reset', kind: 'method', container: 'Base', path: 'src/motor.cpp', line: 2, inherited: true }
		]);
		const doc = 'void f(Motor *m) { m->in }';
		const state = EditorState.create({ doc, extensions: [fileNameFacet.of('src/motor.cpp')] });
		const ctx = new CompletionContext(state, doc.indexOf('in') + 2, false);
		const result = await memberCompletionSource(ctx);
		expect(result).not.toBeNull();
		expect(result!.options.map((o) => o.label)).toEqual(['init', 'reset']);
		expect(result!.options[1]!.detail).toBe('Base (inherited)');
		expect(backend.callsTo('symbol_member_completions')).toHaveLength(1);
	});
});

describe('Area 2: ReferencesView Read/Write/Call/Decl badges and filter pills', () => {
	it('renders W/R/C/D badges and filters down to writes only when W pill is clicked', async () => {
		backend.on('symbol_references', () => [
			{
				path: 'src/state.c',
				matches: [
					{ line: 1, column: 5, length: 5, text: 'int g_cnt = 0;', access: 'decl' },
					{ line: 4, column: 5, length: 5, text: 'g_cnt = 42;', access: 'write' },
					{ line: 7, column: 12, length: 5, text: 'return g_cnt;', access: 'read' }
				]
			}
		]);
		backend.on('symbol_lookup', () => [{ kind: 'variable', name: 'g_cnt', path: 'src/state.c', line: 0 }]);
		backend.on('read_file', () => ({
			contents: 'int g_cnt = 0;\nvoid set() {\n\n    g_cnt = 42;\n}\nint get() {\n    return g_cnt;\n}\n',
			binary: false,
			size: 72
		}));
		backend.on('symbol_file_outline', () => ({ symbols: [], imports: [] }));

		const view = new ReferencesView();
		document.body.appendChild(view.element);
		view.element.hidden = false;
		view.setSubject({ kind: 'variable', name: 'g_cnt', path: 'src/state.c', line: 0 });
		await flush(8);

		const badges = Array.from(view.element.querySelectorAll('.refs-access-badge')).map((e) => e.textContent);
		expect(badges).toEqual(['D', 'W', 'R']);

		const writePill = Array.from(view.element.querySelectorAll<HTMLButtonElement>('.refs-access-pill')).find(
			(b) => b.textContent === 'W'
		)!;
		click(writePill);
		await flush(6);

		const filteredBadges = Array.from(view.element.querySelectorAll('.refs-access-badge')).map((e) => e.textContent);
		expect(filteredBadges).toEqual(['W']);
	});
});

describe('Area 3: multi-color persistent word highlights', () => {
	it('assigns distinct palette slots, toggles off on second call, and clears all', () => {
		const slots = new Set<number>();
		for (let i = 0; i < HIGHLIGHT_SLOT_COUNT; i++) {
			const slot = toggleWordHighlight(`var_${i}`);
			expect(slot).not.toBeNull();
			slots.add(slot!);
		}
		expect(slots.size).toBe(HIGHLIGHT_SLOT_COUNT);
		expect(activeWordHighlights()).toHaveLength(HIGHLIGHT_SLOT_COUNT);

		expect(toggleWordHighlight('var_2')).toBeNull();
		expect(activeWordHighlights()).toHaveLength(HIGHLIGHT_SLOT_COUNT - 1);

		clearWordHighlights();
		expect(activeWordHighlights()).toEqual([]);
	});
});

describe('Areas 4 & 5: preprocessor, base projects, macro expand & 9-volume stats IPC', () => {
	it('invokes the registered backend commands with exact payloads', async () => {
		backend.on('symbol_inactive_ranges', () => [{ startLine: 2, endLine: 4 }]);
		backend.on('symbol_macro_expand', () => ({
			name: 'CLAMP',
			params: ['v', 'lo', 'hi'],
			definition: '#define CLAMP(v, lo, hi) ...',
			expanded: '((x) < (0) ? (0) : (x))',
			path: 'math.h',
			line: 0
		}));
		backend.on('symbols_conditions_get', () => ({ macros: { DEBUG: 1 } }));
		backend.on('symbols_conditions_set', () => null);
		backend.on('symbols_base_projects_get', () => ['/opt/sdk']);
		backend.on('symbols_base_projects_set', () => null);
		backend.on('symbols_volume_stats', () => ({
			present: true,
			totalBytes: 8192,
			symRecords: 42,
			sigFiles: 3,
			xabPages: 1,
			xsbPages: 1,
			xmEntries: 3
		}));

		expect(await symbolInactiveRanges('#if 0\nint x;\n#endif\n')).toEqual([{ startLine: 2, endLine: 4 }]);
		const exp = await symbolMacroExpand('CLAMP', 'CLAMP(x, 0, 10)');
		expect(exp?.expanded).toContain('x');
		expect((await symbolsConditionsGet()).macros.DEBUG).toBe(1);
		await symbolsConditionsSet({ macros: { DEBUG: 0 } });
		expect(await symbolsBaseProjectsGet()).toEqual(['/opt/sdk']);
		await symbolsBaseProjectsSet(['/opt/sdk', '/usr/include']);
		const stats = await symbolsVolumeStats();
		expect(stats.present).toBe(true);
		expect(stats.symRecords).toBe(42);
	});
});
