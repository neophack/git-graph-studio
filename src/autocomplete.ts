// Editor completion (M3 3.3): words of the open document, VS Code snippets (built-in per
// language plus the workspace's `*.code-snippets`), and workspace path completion - the three
// completions that pay off without a language server. Snippets expand with real tabstops
// ($1, ${2:default}, $0) through CodeMirror's snippet engine; Tab / Shift-Tab walk the fields.

import { autocompletion, closeBrackets, snippetCompletion, type Completion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { Facet, type Extension } from '@codemirror/state';
import { invoke } from '@tauri-apps/api/core';

import { languageOf, resolveVariables, snippetsFor } from './snippetRegistry';
import { settings } from './settings';

/** The open file's name, so the snippet set and the path root can follow the language. */
export const fileNameFacet = Facet.define<string, string>({ combine: (values) => values[values.length - 1] ?? '' });

/* ---------- Snippets ---------- */

/** The snippet completions for the typed prefix, each expanding with real tabstops. */
export function snippetCompletionSource(context: CompletionContext): CompletionResult | null {
	if (!settings.snippetSuggestions) return null;
	const word = context.matchBefore(/[\w$]+/);
	if (!word || (word.from === word.to && !context.explicit)) return null;
	const fileName = context.state.facet(fileNameFacet);
	const query = word.text.toLowerCase();
	const options: Completion[] = [];
	for (const snippet of snippetsFor(fileName)) {
		if (!snippet.prefix.toLowerCase().startsWith(query)) continue;
		const detail = [snippet.description, snippet.source === 'workspace' ? 'workspace snippet' : undefined].filter(Boolean).join(' — ');
		options.push(snippetCompletion(resolveVariables(snippet.body, fileName), {
			label: snippet.prefix,
			detail: detail || undefined,
			type: 'keyword',
			boost: 20 // snippets sit above plain word matches
		}));
	}
	return options.length > 0 ? { from: word.from, options, validFor: /^[\w$]*$/ } : null;
}

/* ---------- Word completion ---------- */

/** How far (in characters) either side of the cursor the word scan reaches in a large document. */
const WORD_SCAN_HALF_WINDOW = 250_000;

/** Word completion: the identifiers of the open document that share the typed prefix. */
export function wordCompletion(context: CompletionContext): CompletionResult | null {
	const word = context.matchBefore(/[\w$]+/);
	if (!word || (word.from === word.to && !context.explicit)) return null;
	// The scan runs on every keystroke: over a multi-megabyte document it is bounded to the
	// text around the cursor (the words nearest the edit are the likeliest anyway), so
	// typing in a large file never waits on a whole-document regex walk.
	const length = context.state.doc.length;
	const from = Math.max(0, Math.min(word.from - WORD_SCAN_HALF_WINDOW, length - 2 * WORD_SCAN_HALF_WINDOW));
	const doc = length <= 2 * WORD_SCAN_HALF_WINDOW ? context.state.doc.toString() : context.state.sliceDoc(from, from + 2 * WORD_SCAN_HALF_WINDOW);
	const seen = new Set<string>();
	const query = word.text.toLowerCase();
	for (const match of doc.matchAll(/[\w$]{3,}/g)) {
		const candidate = match[0];
		if (candidate !== word.text && candidate.toLowerCase().startsWith(query)) seen.add(candidate);
		if (seen.size >= 200) break;
	}
	const options: Completion[] = [...seen].map((label) => ({ label, type: 'text' }));
	return options.length > 0 ? { from: word.from, options, validFor: /^[\w$]*$/ } : null;
}

/* ---------- Path completion ---------- */

/** The path options for a typed path fragment: the entries of its folder that share the last
 *  segment's prefix, directories marked with a trailing slash. Pure, so the tests can run it
 *  without an editor. */
export function pathOptions(files: string[], token: string): { label: string; type: string }[] {
	const raw = token.replaceAll('\\', '/');
	if (!raw.includes('/')) return [];
	const typed = raw.replace(/^\.\//, '');
	const folder = typed.slice(0, typed.lastIndexOf('/') + 1); // '' = the workspace root
	const partial = typed.slice(folder.length).toLowerCase();
	const out = new Map<string, 'folder' | 'file'>();
	for (const file of files) {
		const name = file.replaceAll('\\', '/');
		if (folder !== '' && !name.startsWith(folder)) continue;
		const rest = name.slice(folder.length);
		const slash = rest.indexOf('/');
		const entry = slash === -1 ? rest : rest.slice(0, slash + 1);
		if (entry === '') continue;
		if (!entry.slice(0, entry.endsWith('/') ? -1 : undefined).toLowerCase().startsWith(partial)) continue;
		out.set(entry, slash === -1 ? 'file' : 'folder');
	}
	return [...out].slice(0, 200).map(([label, kind]) => ({ label, type: kind === 'folder' ? 'folder' : 'text' }));
}

/** The workspace file list path completion reads, cached for a short while (it is typed
 *  against, so the backend must not be asked on every keystroke). */
let fileList: { files: string[]; at: number } | null = null;
const FILE_LIST_TTL = 5000;

async function workspaceFiles(): Promise<string[]> {
	if (fileList && performance.now() - fileList.at < FILE_LIST_TTL) return fileList.files;
	const files = await invoke<string[]>('list_files').catch(() => [] as string[]);
	fileList = { files, at: performance.now() };
	return files;
}

/** Path completion: inside a path-looking fragment (contains a slash), the workspace's files
 *  and folders that continue it. The filtering runs in the backend over its cached file list
 *  (`path_completions`, `cmd_fuzzy.rs`) - the TS `pathOptions` over a locally cached list is
 *  the fallback. */
export async function pathCompletion(context: CompletionContext): Promise<CompletionResult | null> {
	if (!settings.pathCompletion) return null;
	const token = context.matchBefore(/[\w$./\\-]+/);
	if (!token || !token.text.includes('/') || token.from === token.to) return null;
	try {
		const entries = await invoke<{ label: string; isDir: boolean }[]>('path_completions', { prefix: token.text });
		if (Array.isArray(entries)) {
			if (entries.length === 0) return null;
			return {
				from: token.from,
				options: entries.map((entry) => ({ label: entry.label, type: entry.isDir ? 'folder' : 'text' })),
				validFor: /^[\w$./\\-]*$/
			};
		}
	} catch {
		// No backend answer: filter the locally cached list instead.
	}
	const options = pathOptions(await workspaceFiles(), token.text);
	if (options.length === 0) return null;
	return { from: token.from, options, validFor: /^[\w$./\\-]*$/ };
}

/* ---------- The bundle ---------- */

/** The completion bundle every editable editor gets. The completion keymaps (Ctrl+Space among
 *  them) join the editor's base keymap (see editor.ts). */
export function completionExtension(fileName: string): Extension[] {
	return [
		fileNameFacet.of(fileName),
		closeBrackets(),
		// Tab / Shift-Tab walk an active snippet's fields (the autocompletion bundle wires
		// the snippet keymap; it defers to the base keymap when no snippet is active).
		autocompletion({ override: [snippetCompletionSource, wordCompletion, pathCompletion] })
	];
}
