import { beforeEach, describe, expect, it } from 'vitest';

import { pathOptions, snippetCompletionSource, wordCompletion, fileNameFacet } from '../src/autocomplete';
import { BUILTIN_LANGUAGE_COUNT, languageOf, loadWorkspaceSnippets, parseCodeSnippets, resolveVariables, snippetsFor } from '../src/snippetRegistry';
import { EditorState } from '@codemirror/state';
import { CompletionContext } from '@codemirror/autocomplete';
import { backend } from './tauriMock';

describe('the snippet registry (M3 3.3)', () => {
	it('parses a VS Code *.code-snippets file (JSONC: comments, trailing commas)', () => {
		const text = `{
			// a log helper
			"Log": {
				"prefix": "log",
				"body": ["console.log($1);", "$0"],
				"description": "Log to the console",
			},
			/* scoped to rust only */
			"Test mod": {
				"prefix": "tmod",
				"body": "#[cfg(test)]\\nmod tests {\\n\\t$0\\n}",
				"scope": "rust"
			}
		}`;
		const parsed = parseCodeSnippets(text);
		expect(parsed).toHaveLength(2);
		expect(parsed[0]).toMatchObject({ label: 'Log', prefix: 'log', body: 'console.log($1);\n$0', description: 'Log to the console' });
		expect(parsed[1]).toMatchObject({ label: 'Test mod', scope: 'rust' });
		expect(parseCodeSnippets('not json')).toEqual([]);
	});

	it('resolves VS Code variables but leaves tabstops alone', () => {
		const out = resolveVariables('a $TM_FILENAME_BASE b ${1:name} $0 $2 ${3:default} $TM_SELECTED_TEXT ${TM_SELECTED_TEXT:fallback}', 'src/main.rs');
		expect(out).toBe('a main b ${1:name} $0 $2 ${3:default}  fallback');
	});

	it('resolves $TM_DIRECTORY from the full file path, whatever the separator', () => {
		// The completion facet carries the open file's full path (see editor.ts), spelled the
		// platform's way: both separators must yield the file's directory.
		expect(resolveVariables('[$TM_DIRECTORY]', 'C:\\repo\\src\\main.rs')).toBe('[C:\\repo\\src]');
		expect(resolveVariables('[$TM_DIRECTORY]', '/home/dev/repo/src/main.rs')).toBe('[/home/dev/repo/src]');
		expect(resolveVariables('[$TM_DIRECTORY]', 'main.rs')).toBe('[]'); // no directory part
	});

	it('carries built-in snippets for 20 languages, matched by extension', () => {
		expect(BUILTIN_LANGUAGE_COUNT).toBeGreaterThanOrEqual(20);
		expect(languageOf('main.rs')).toBe('rust');
		expect(languageOf('App.tsx')).toBe('typescript');
		expect(languageOf('notes.txt')).toBe('');
		expect(snippetsFor('main.rs').some((s) => s.prefix === 'fn')).toBe(true);
		expect(snippetsFor('App.tsx').some((s) => s.prefix === 'cls')).toBe(true);
		expect(snippetsFor('notes.txt')).toEqual([]);
	});

	it('loads workspace snippets from .vscode and applies their scope', async () => {
		backend.on('list_dir', ({ path }) => (String(path).endsWith('.vscode')
			? [{ name: 'shared.code-snippets', isDir: false, size: 1 }, { name: 'other.json', isDir: false, size: 1 }]
			: Promise.reject(new Error('no such dir'))));
		backend.on('read_file', ({ path }) => (String(path).endsWith('shared.code-snippets')
			? { contents: '{"Hi": {"prefix": "hi", "body": "hello $1"}, "Rs only": {"prefix": "rsonly", "body": "x", "scope": "rust"}}', binary: false, size: 1 }
			: Promise.reject(new Error('no such file'))));
		await loadWorkspaceSnippets('C:\\repo');
		const forTs = snippetsFor('app.ts');
		expect(forTs.some((s) => s.prefix === 'hi' && s.source === 'workspace')).toBe(true);
		expect(forTs.some((s) => s.prefix === 'rsonly')).toBe(false);
		expect(snippetsFor('main.rs').some((s) => s.prefix === 'rsonly')).toBe(true);
	});

	it('clears the workspace set when the root goes away', async () => {
		await loadWorkspaceSnippets(null);
		expect(snippetsFor('app.ts').every((s) => s.source === 'builtin')).toBe(true);
	});
});

describe('the completion sources', () => {
	// A real CompletionContext (state + position, explicit) as the extension would build it.
	const contextAt = (doc: string, file: string, at: number): Parameters<typeof wordCompletion>[0] =>
		new CompletionContext(EditorState.create({ doc, extensions: [fileNameFacet.of(file)] }), at, true);

	beforeEach(async () => {
		await loadWorkspaceSnippets(null);
	});

	it('offers snippets with tabstop bodies for the typed prefix', () => {
		const result = snippetCompletionSource(contextAt('fn', 'main.rs', 2));
		expect(result).not.toBeNull();
		const fn = result!.options.find((o) => o.label === 'fn')!;
		expect(fn.type).toBe('keyword');
		expect(fn.apply).toBeTypeOf('function'); // CodeMirror's snippet expander
		expect(result!.options.some((o) => o.label === 'pfn')).toBe(false);
	});

	it('word completion offers the document identifiers that share the prefix', () => {
		const doc = 'const total = 1; const toSum = tot';
		const result = wordCompletion(contextAt(doc, 'a.ts', doc.length));
		expect(result!.options.map((o) => o.label)).toEqual(['total']); // toSum does not share the 'tot' prefix
	});

	it('path completion lists the workspace entries continuing the fragment', () => {
		const files = ['src/main.rs', 'src/lib/mod.rs', 'src/lib/util.rs', 'README.md'];
		expect(pathOptions(files, './sr')).toEqual([{ label: 'src/', type: 'folder' }]);
		expect(pathOptions(files, 'src/lib/')).toEqual([
			{ label: 'mod.rs', type: 'text' },
			{ label: 'util.rs', type: 'text' }
		]);
		expect(pathOptions(files, 'src/m')).toEqual([{ label: 'main.rs', type: 'text' }]);
		// Not a path fragment (no slash): no options, the word source takes over instead.
		expect(pathOptions(files, 'src')).toEqual([]);
	});
});
