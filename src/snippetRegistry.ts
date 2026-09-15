// The snippet registry (M3 3.3): VS Code's `*.code-snippets` JSONC format (from the
// workspace's `.vscode/` folder) plus a built-in base set per language. The registry is
// queried live by the completion source, so a loaded file needs no reload round-trip.

import { invoke } from '@tauri-apps/api/core';

/** One snippet, as VS Code spells it: a prefix, a body with tabstops, optional description
 *  and a scope of language ids (empty = every language). */
export interface VSSnippet {
	label: string;
	prefix: string;
	body: string;
	description?: string;
	scope?: string;
	source: 'builtin' | 'workspace';
}

/** The built-in base set: two or three high-traffic snippets per language, keyed by VS Code's
 *  language ids. Tabstops are VS Code's (`$1`, `${2:default}`, `$0` = the final stop). */
const BUILTINS: Record<string, { prefix: string; body: string; description?: string }[]> = {
	rust: [
		{ prefix: 'fn', body: 'fn ${1:name}() {\n\t$0\n}' },
		{ prefix: 'pfn', body: 'pub fn ${1:name}() {\n\t$0\n}' },
		{ prefix: 'tfn', body: '#[test]\nfn ${1:name}() {\n\t$0\n}' },
		{ prefix: 'impl', body: 'impl ${1:Trait} for ${2:Type} {\n\t$0\n}' }
	],
	typescript: [
		{ prefix: 'fn', body: 'function ${1:name}() {\n\t$0\n}' },
		{ prefix: 'afn', body: 'async function ${1:name}() {\n\t$0\n}' },
		{ prefix: 'cls', body: 'class ${1:Name} {\n\t$0\n}' },
		{ prefix: 'int', body: 'interface ${1:Name} {\n\t$0\n}' }
	],
	javascript: [
		{ prefix: 'fn', body: 'function ${1:name}() {\n\t$0\n}' },
		{ prefix: 'afn', body: 'async function ${1:name}() {\n\t$0\n}' },
		{ prefix: 'cls', body: 'class ${1:Name} {\n\t$0\n}' }
	],
	python: [
		{ prefix: 'def', body: 'def ${1:name}():\n\t$0' },
		{ prefix: 'cls', body: 'class ${1:Name}:\n\tdef __init__(self):\n\t\t$0' },
		{ prefix: 'ifmain', body: 'if __name__ == "__main__":\n\t$0' }
	],
	go: [
		{ prefix: 'fn', body: 'func ${1:name}() {\n\t$0\n}' },
		{ prefix: 'err', body: 'if err != nil {\n\t$0\n\treturn err\n}' }
	],
	java: [
		{ prefix: 'cls', body: 'public class ${1:Name} {\n\t$0\n}' },
		{ prefix: 'main', body: 'public static void main(String[] args) {\n\t$0\n}' }
	],
	c: [
		{ prefix: 'inc', body: '#include <${1:header}.h>' },
		{ prefix: 'main', body: 'int main(int argc, char **argv) {\n\t$0\n\treturn 0;\n}' }
	],
	cpp: [
		{ prefix: 'inc', body: '#include <${1:header}>' },
		{ prefix: 'cls', body: 'class ${1:Name} {\npublic:\n\t$0\n};' }
	],
	csharp: [
		{ prefix: 'cls', body: 'public class ${1:Name}\n{\n\t$0\n}' },
		{ prefix: 'cw', body: 'Console.WriteLine($0);' }
	],
	ruby: [
		{ prefix: 'def', body: 'def ${1:name}\n\t$0\nend' },
		{ prefix: 'cls', body: 'class ${1:Name}\n\t$0\nend' }
	],
	php: [
		{ prefix: 'fn', body: 'function ${1:name}()\n{\n\t$0\n}' },
		{ prefix: 'cls', body: 'class ${1:Name}\n{\n\t$0\n}' }
	],
	shellscript: [
		{ prefix: 'shebang', body: '#!/usr/bin/env bash\nset -euo pipefail\n$0' },
		{ prefix: 'if', body: 'if [ ${1:condition} ]; then\n\t$0\nfi' }
	],
	powershell: [
		{ prefix: 'fn', body: 'function ${1:Name} {\n\t$0\n}' },
		{ prefix: 'param', body: 'param(\n\t${1:Name}\n)' }
	],
	html: [
		{ prefix: 'html5', body: '<!DOCTYPE html>\n<html lang="en">\n<head>\n\t<meta charset="UTF-8">\n\t<title>${1:Title}</title>\n</head>\n<body>\n\t$0\n</body>\n</html>' },
		{ prefix: 'a', body: '<a href="${1:url}">$0</a>' }
	],
	css: [
		{ prefix: 'flex', body: 'display: flex;\njustify-content: ${1:center};\nalign-items: ${2:center};' },
		{ prefix: 'grid', body: 'display: grid;\ngrid-template-columns: ${1:1fr 1fr};' }
	],
	markdown: [
		{ prefix: 'table', body: '| ${1:Header} | ${2:Header} |\n| --- | --- |\n| $0 |  |' },
		{ prefix: 'link', body: '[${1:text}](${2:url})' }
	],
	sql: [
		{ prefix: 'sel', body: 'SELECT ${1:columns}\nFROM ${2:table}\nWHERE $0;' },
		{ prefix: 'join', body: 'INNER JOIN ${1:table} ON ${2:condition}' }
	],
	kotlin: [
		{ prefix: 'fn', body: 'fun ${1:name}() {\n\t$0\n}' },
		{ prefix: 'cls', body: 'class ${1:Name} {\n\t$0\n}' }
	],
	swift: [
		{ prefix: 'fn', body: 'func ${1:name}() {\n\t$0\n}' },
		{ prefix: 'guard', body: 'guard ${1:condition} else { return }' }
	],
	lua: [
		{ prefix: 'fn', body: 'function ${1:name}()\n\t$0\nend' },
		{ prefix: 'local', body: 'local ${1:name} = $0' }
	],
	dart: [
		{ prefix: 'fn', body: '${1:Type} ${2:name}() {\n\t$0\n}' },
		{ prefix: 'cls', body: 'class ${1:Name} {\n\t$0\n}' }
	]
};

/** File extensions mapped to VS Code's language ids, for the scope check. */
const LANGUAGE_BY_EXTENSION: Record<string, string> = {
	rs: 'rust', ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
	mjs: 'javascript', cjs: 'javascript', py: 'python', go: 'go', java: 'java', c: 'c',
	h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', cs: 'csharp', rb: 'ruby',
	php: 'php', sh: 'shellscript', bash: 'shellscript', zsh: 'shellscript', ps1: 'powershell',
	html: 'html', htm: 'html', css: 'css', scss: 'css', less: 'css', md: 'markdown',
	markdown: 'markdown', sql: 'sql', kt: 'kotlin', swift: 'swift', lua: 'lua', dart: 'dart'
};

/** The language id a file name is written in ('' when unknown). */
export function languageOf(fileName: string): string {
	const ext = fileName.includes('.') ? fileName.split('.').pop()!.toLowerCase() : fileName.toLowerCase();
	return LANGUAGE_BY_EXTENSION[ext] ?? '';
}

/** The workspace snippets the latest `loadWorkspaceSnippets` found (empty until it lands). */
let workspaceSnippets: VSSnippet[] = [];

/** Read every `.vscode/*.code-snippets` of the workspace into the registry. A file that fails
 *  to parse is skipped silently (VS Code reports it in a log we do not have). */
export async function loadWorkspaceSnippets(root: string | null): Promise<void> {
	workspaceSnippets = [];
	if (!root) return;
	const separator = root.includes('\\') ? '\\' : '/';
	const folder = root.replace(/[\\/]+$/, '') + separator + '.vscode';
	let entries: { name: string }[];
	try {
		entries = await invoke<{ name: string }[]>('list_dir', { path: folder });
	} catch {
		return; // no .vscode folder - the common case
	}
	for (const { name } of entries ?? []) {
		if (!name.endsWith('.code-snippets')) continue;
		try {
			const file = await invoke<{ contents: string | null }>('read_file', { path: folder + separator + name });
			if (typeof file.contents === 'string') workspaceSnippets.push(...parseCodeSnippets(file.contents));
		} catch {
			// Unreadable or unparseable: skip the file, keep the rest.
		}
	}
}

/** Parse a `*.code-snippets` file (JSONC: comments and trailing commas allowed) into snippets. */
export function parseCodeSnippets(text: string): VSSnippet[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stripJsonc(text));
	} catch {
		return [];
	}
	const snippets: VSSnippet[] = [];
	if (parsed === null || typeof parsed !== 'object') return snippets;
	for (const [label, entry] of Object.entries(parsed as Record<string, unknown>)) {
		if (entry === null || typeof entry !== 'object') continue;
		const { prefix, body, description, scope } = entry as Record<string, unknown>;
		if (typeof prefix !== 'string' || prefix === '') continue;
		const template = Array.isArray(body) ? body.filter((line) => typeof line === 'string').join('\n') : typeof body === 'string' ? body : '';
		if (template === '') continue;
		snippets.push({
			label,
			prefix,
			body: template,
			description: typeof description === 'string' ? description : undefined,
			scope: typeof scope === 'string' ? scope : undefined,
			source: 'workspace'
		});
	}
	return snippets;
}

/** Strip // and /* *​/ comments and trailing commas, so JSON.parse accepts a JSONC document. */
function stripJsonc(text: string): string {
	let out = '';
	let i = 0;
	let inString = false;
	while (i < text.length) {
		const ch = text[i]!;
		const next = text[i + 1];
		if (inString) {
			out += ch;
			if (ch === '\\' && next !== undefined) {
				out += next;
				i += 2;
				continue;
			}
			if (ch === '"') inString = false;
			i++;
			continue;
		}
		if (ch === '"') {
			inString = true;
			out += ch;
			i++;
		} else if ((ch === '/' && next === '/') || (ch === '/' && next === '*')) {
			// A comment before the closing brace can hide the trailing comma after it.
			if (ch === '/' && next === '/') {
				while (i < text.length && text[i] !== '\n') i++;
			} else {
				i += 2;
				while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
				i += 2;
			}
			if (out.trimEnd().endsWith(',') && /^\s*[}\]]/.test(text.slice(i))) out = out.trimEnd().slice(0, -1);
		} else if (ch === ',' && /^\s*[}\]]/.test(text.slice(i + 1))) {
			i++; // the trailing comma JSON.parse rejects
		} else {
			out += ch;
			i++;
		}
	}
	return out;
}

/** The snippets that apply to a file: the built-ins of its language plus workspace snippets
 *  whose scope matches (or that carry no scope at all). */
export function snippetsFor(fileName: string): VSSnippet[] {
	const language = languageOf(fileName);
	const builtin: VSSnippet[] = (BUILTINS[language] ?? []).map((s) => ({
		label: s.prefix, prefix: s.prefix, body: s.body, description: s.description, source: 'builtin'
	}));
	const scoped = workspaceSnippets.filter((s) => {
		if (!s.scope) return true;
		return s.scope.split(',').map((id) => id.trim()).includes(language);
	});
	return [...scoped, ...builtin];
}

/** Resolve VS Code's snippet variables (`$TM_FILENAME`, …) in a body. Tabstops are left
 *  alone: the editor's snippet engine already speaks `$1`, `${2:default}` and `$0`. */
export function resolveVariables(body: string, fileName: string): string {
	const name = fileName.split(/[/\\]/).pop() ?? fileName;
	// The facet carries the full path; both separators spell a directory boundary.
	const sep = Math.max(fileName.lastIndexOf('/'), fileName.lastIndexOf('\\'));
	const variables: Record<string, string> = {
		TM_FILENAME: name,
		TM_FILENAME_BASE: name.replace(/\.[^.]+$/, ''),
		TM_DIRECTORY: sep === -1 ? '' : fileName.slice(0, sep),
		TM_LINE_INDEX: '0',
		TM_LINE_NUMBER: '1',
		TM_SELECTED_TEXT: '',
		CURRENT_YEAR: String(new Date().getFullYear()),
		CURRENT_MONTH: String(new Date().getMonth() + 1).padStart(2, '0'),
		CURRENT_DATE: String(new Date().getDate()).padStart(2, '0')
	};
	return body.replace(/\$\{(\w+)(?::([^}]*))?\}|\$(\w+)/g, (whole, braced?: string, bracedDefault?: string, bare?: string) => {
		const name2 = braced ?? bare;
		if (name2 !== undefined && variables[name2] !== undefined) {
			const value = variables[name2]!;
			return value !== '' ? value : (bracedDefault ?? '');
		}
		return whole; // tabstops ($1, ${2:placeholder}) and unknown variables pass through
	});
}

/** The number of languages the built-in set covers (the plan's "20 languages" line). */
export const BUILTIN_LANGUAGE_COUNT = Object.keys(BUILTINS).length;
