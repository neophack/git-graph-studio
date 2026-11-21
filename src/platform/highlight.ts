// The panels' shared line highlighter — the references page's site rows and context
// slices and the relation graph's declaration card color their code with it (2026-11-20,
// the owner's direction: the referenced code and the hover code must be colored). A pure
// single-line tokenizer: comments, strings, numbers, keywords and capitalized type names
// over the language families the symbol index covers, everything else plain. No state
// crosses lines — a panel colors one line at a time, and an unterminated string or block
// comment degrades to the end of the line.

import './highlight.css';

/** One colored run of a line: the text and its token class. */
export interface CodeSegment {
	text: string;
	/** `comment` | `string` | `number` | `keyword` | `type` | `emphasis` | `''` (plain). */
	cls: string;
}

/** The keyword sets per language family — control flow, declarations and literals only;
 *  anything else the tokenizer leaves plain. */
const KEYWORDS: Record<string, string[]> = {
	c: [
		'auto', 'bool', 'break', 'case', 'char', 'const', 'continue', 'default', 'do',
		'double', 'else', 'enum', 'extern', 'float', 'for', 'goto', 'if', 'inline', 'int',
		'long', 'register', 'restrict', 'return', 'short', 'signed', 'sizeof', 'static',
		'struct', 'switch', 'typedef', 'union', 'unsigned', 'void', 'volatile', 'while'
	],
	cpp: [
		'alignas', 'auto', 'break', 'case', 'catch', 'class', 'const', 'consteval', 'constexpr',
		'continue', 'decltype', 'default', 'delete', 'do', 'else', 'enum', 'explicit', 'export',
		'extern', 'for', 'friend', 'goto', 'if', 'inline', 'namespace', 'new', 'noexcept',
		'nullptr', 'operator', 'private', 'protected', 'public', 'return', 'sizeof', 'static',
		'struct', 'switch', 'template', 'this', 'throw', 'try', 'typedef', 'typename', 'using',
		'virtual', 'volatile', 'while'
	],
	rust: [
		'as', 'async', 'await', 'break', 'const', 'continue', 'crate', 'dyn', 'else', 'enum',
		'extern', 'false', 'fn', 'for', 'if', 'impl', 'in', 'let', 'loop', 'match', 'mod',
		'move', 'mut', 'pub', 'ref', 'return', 'self', 'Self', 'static', 'struct', 'super',
		'trait', 'true', 'type', 'unsafe', 'use', 'where', 'while'
	],
	python: [
		'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del',
		'elif', 'else', 'except', 'False', 'finally', 'for', 'from', 'global', 'if', 'import',
		'in', 'is', 'lambda', 'None', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return',
		'True', 'try', 'while', 'with', 'yield'
	],
	go: [
		'break', 'case', 'chan', 'const', 'continue', 'default', 'defer', 'else',
		'fallthrough', 'false', 'for', 'func', 'go', 'goto', 'if', 'import', 'interface',
		'map', 'nil', 'package', 'range', 'return', 'select', 'struct', 'switch', 'true',
		'type', 'var'
	],
	js: [
		'abstract', 'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const',
		'continue', 'debugger', 'default', 'delete', 'do', 'else', 'enum', 'export', 'extends',
		'false', 'finally', 'for', 'from', 'function', 'get', 'if', 'implements', 'import',
		'in', 'instanceof', 'interface', 'let', 'new', 'null', 'of', 'private', 'protected',
		'public', 'readonly', 'return', 'set', 'static', 'super', 'switch', 'this', 'throw',
		'true', 'try', 'typeof', 'undefined', 'var', 'void', 'while', 'yield'
	],
	java: [
		'abstract', 'assert', 'boolean', 'break', 'byte', 'case', 'catch', 'char', 'class',
		'continue', 'default', 'do', 'double', 'else', 'enum', 'extends', 'false', 'final',
		'finally', 'float', 'for', 'if', 'implements', 'import', 'instanceof', 'int',
		'interface', 'long', 'native', 'new', 'null', 'package', 'private', 'protected',
		'public', 'return', 'short', 'static', 'super', 'switch', 'synchronized', 'this',
		'throw', 'throws', 'transient', 'true', 'try', 'void', 'volatile', 'while'
	],
	csharp: [
		'abstract', 'as', 'async', 'await', 'base', 'bool', 'break', 'byte', 'case', 'catch',
		'char', 'checked', 'class', 'const', 'continue', 'decimal', 'default', 'delegate',
		'do', 'double', 'else', 'enum', 'event', 'explicit', 'extern', 'false', 'finally',
		'fixed', 'float', 'for', 'foreach', 'goto', 'if', 'implicit', 'in', 'int', 'interface',
		'internal', 'is', 'lock', 'long', 'namespace', 'new', 'null', 'object', 'operator',
		'out', 'override', 'params', 'private', 'protected', 'public', 'readonly', 'ref',
		'return', 'sbyte', 'sealed', 'short', 'sizeof', 'stackalloc', 'static', 'string',
		'struct', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'uint', 'ulong',
		'unchecked', 'unsafe', 'ushort', 'using', 'var', 'virtual', 'void', 'volatile',
		'when', 'while', 'yield'
	]
};

const KEYWORD_SETS: Record<string, Set<string>> = Object.fromEntries(
	Object.entries(KEYWORDS).map((family, ) => [family[0], new Set(family[1])])
);

/** The language family an extension speaks; anything unknown falls to the c-like
 *  comment/string rules with no keywords — every language keeps its strings, numbers
 *  and comments colored. */
function familyOf(ext: string): string {
	const family = ext.toLowerCase();
	if (family === 'rs') return 'rust';
	if (family === 'py') return 'python';
	if (family === 'go') return 'go';
	if (family === 'java') return 'java';
	if (family === 'cs') return 'csharp';
	if (['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs'].includes(family)) return 'js';
	if (['cpp', 'hpp', 'cc', 'hh', 'cxx', 'hxx', 'ipp'].includes(family)) return 'cpp';
	if (['c', 'h'].includes(family)) return 'c';
	return KEYWORD_SETS[family] ? family : 'plain';
}

const isWordChar = (c: string): boolean => c === '_' || /[A-Za-z0-9]/.test(c);

/** One line's colored runs, left to right, covering the whole line. `emphasis` — the
 *  searched symbol's name — paints its own class over matching word tokens. */
export function highlightLine(text: string, ext: string, emphasis?: string): CodeSegment[] {
	const family = familyOf(ext);
	const keywords = KEYWORD_SETS[family];
	const lineComment = family === 'python' ? '#' : '//';
	const segments: CodeSegment[] = [];
	let plain = 0;
	let at = 0;
	const push = (end: number, cls: string): void => {
		if (at > plain) segments.push({ text: text.slice(plain, at), cls: '' });
		segments.push({ text: text.slice(at, end), cls });
		plain = end;
	};
	while (at < text.length) {
		const c = text[at];
		// Line comment: the rest of the line.
		if (lineComment && text.startsWith(lineComment, at)) {
			push(text.length, 'hl-comment');
			break;
		}
		// Block comment: to its close or the end of the line (per-line state only).
		if (c === '/' && text[at + 1] === '*') {
			const close = text.indexOf('*/', at + 2);
			push(close === -1 ? text.length : close + 2, 'hl-comment');
			at = close === -1 ? text.length : close + 2;
			continue;
		}
		// String or char literal: to the unescaped close or the end of the line.
		if (c === '"' || c === "'" || c === '`') {
			let end = at + 1;
			while (end < text.length && text[end] !== c) {
				if (text[end] === '\\') end++;
				end++;
			}
			end = Math.min(end + 1, text.length);
			push(end, 'hl-string');
			at = end;
			continue;
		}
		// Word: keyword, capitalized type name, or the emphasized symbol.
		if (isWordChar(c) && !/[0-9]/.test(c)) {
			let end = at + 1;
			while (end < text.length && isWordChar(text[end])) end++;
			const word = text.slice(at, end);
			const cls =
				word === emphasis
					? 'hl-emphasis'
					: keywords?.has(word)
						? 'hl-keyword'
						: /[A-Z]/.test(word[0])
							? 'hl-type'
							: '';
			if (cls) push(end, cls);
			at = end;
			continue;
		}
		// Number.
		if (/[0-9]/.test(c)) {
			let end = at + 1;
			while (end < text.length && /[0-9a-fA-FxXoObB._]/.test(text[end])) end++;
			push(end, 'hl-number');
			at = end;
			continue;
		}
		at++;
	}
	if (plain < text.length) segments.push({ text: text.slice(plain), cls: '' });
	return segments;
}

/** The extension a path speaks — the last dot segment. */
export function extOf(path: string): string {
	return path.split('.').pop() ?? '';
}
