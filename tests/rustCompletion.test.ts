// The Rust-backed completion paths (cmd_fuzzy.rs): Quick Open's file source and the editor's
// path completion ask the backend first and fall back to their TS implementations when the
// backend does not answer (no folder open, or a stubbed backend that returns null).

import { beforeEach, describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { CompletionContext } from '@codemirror/autocomplete';

import { FilePickSource } from '../src/filePicker';
import { fileNameFacet, pathCompletion } from '../src/autocomplete';
import { backend } from './tauriMock';

describe('the Rust-backed completion paths', () => {
	beforeEach(() => {
		backend.on('fuzzy_files', () => null); // the defaulting stub: not an array
		backend.on('path_completions', () => null);
	});

	it('Quick Open uses the backend rows when they come back', async () => {
		backend.on('fuzzy_files', ({ query, limit }) => [
			{ path: `src/${query}.rs`, label: `${query}.rs`, ranges: [[0, query.length]] }
		].slice(0, Number(limit)));
		const source = new FilePickSource(() => Promise.resolve([]));
		const items = await source.query('main', () => undefined, () => false);
		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({ label: 'main.rs', description: 'src/main.rs', value: 'file:src/main.rs', highlights: [[0, 4]] });
		// A cancelled query (a newer keystroke won) drops the rows that land late.
		expect(await source.query('main', () => undefined, () => true)).toEqual([]);
	});

	it('Quick Open falls back to the TS scan when the backend answers null', async () => {
		const source = new FilePickSource(() => Promise.resolve(['src/alpha.rs', 'src/beta.rs']));
		const items = await source.query('alp', () => undefined, () => false);
		expect(items.map((item) => item.label)).toEqual(['alpha.rs']);
	});

	it('path completion uses the backend entries, folders marked', async () => {
		backend.on('path_completions', ({ prefix }) => [
			{ label: 'src/', isDir: true },
			{ label: 'src-main.ts', isDir: false }
		].filter(() => String(prefix).includes('/')));
		const doc = 'src/';
		const result = await pathCompletion(new CompletionContext(
			EditorState.create({ doc, extensions: [fileNameFacet.of('a.ts')] }),
			doc.length,
			true
		));
		expect(result!.options).toEqual([
			{ label: 'src/', type: 'folder' },
			{ label: 'src-main.ts', type: 'text' }
		]);
	});

	it('path completion falls back to the TS filter over list_files', async () => {
		backend.on('list_files', () => ['src/main.rs', 'src/lib/mod.rs', 'README.md']);
		const doc = 'src/lib/';
		const result = await pathCompletion(new CompletionContext(
			EditorState.create({ doc, extensions: [fileNameFacet.of('a.ts')] }),
			doc.length,
			true
		));
		expect(result!.options.map((o) => o.label)).toEqual(['mod.rs']);
	});
});
