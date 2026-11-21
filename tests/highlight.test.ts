// The panels' shared line highlighter (module 1's platform leaf): the tokens' classes
// per language family, the emphasized symbol riding its own class, and the graceful
// degradation — unterminated strings and block comments end at the line's end, unknown
// extensions keep their strings, numbers and comments colored.

import { describe, expect, it } from 'vitest';

import { extOf, highlightLine } from '../src/platform/highlight';

const text = (line: string, ext: string, emphasis?: string): string =>
	highlightLine(line, ext, emphasis)
		.map((segment) => (segment.cls ? `[${segment.cls}]${segment.text}` : segment.text))
		.join('');

describe('highlightLine', () => {
	it('colors the C tokens: keywords, the capitalized type, strings, numbers, comments', () => {
		expect(text('int total(Shape a);', 'c', 'total')).toBe(
			'[hl-keyword]int [hl-emphasis]total([hl-type]Shape a);'
		);
		expect(text('x = 0xff + 1.5;', 'c')).toBe('x = [hl-number]0xff + [hl-number]1.5;');
		expect(text('return s; // tail', 'c')).toBe('[hl-keyword]return s; [hl-comment]// tail');
		expect(text('/* head */ y++;', 'c')).toBe('[hl-comment]/* head */ y++;');
	});

	it('follows the language: python hashes, rust and go keywords, js strings', () => {
		expect(text('# a note', 'py')).toBe('[hl-comment]# a note');
		expect(text('fn main() { let x = Self; }', 'rs')).toContain('[hl-keyword]fn');
		expect(text('go func() { var y int }', 'go')).toContain('[hl-keyword]go');
		expect(text('const s = "hi";', 'ts')).toContain('[hl-string]"hi"');
	});

	it('keeps the emphasis on every word token of the name, and only the name', () => {
		// The whole-word token carries the class; the same letters inside a longer
		// identifier (totalize) do not.
		expect(text('total + totalize;', 'c', 'total')).toBe('[hl-emphasis]total + totalize;');
	});

	it('degrades gracefully: unterminated literals end at the line, unknown extensions stay colored', () => {
		expect(text('s = "open', 'c')).toBe('s = [hl-string]"open');
		expect(text('/* open', 'c')).toBe('[hl-comment]/* open');
		// A plain extension keeps the strings, the numbers and the line comments.
		expect(text('x = 7; // note', 'xyz')).toBe('x = [hl-number]7; [hl-comment]// note');
	});

	it('the segments cover the line exactly, in order', () => {
		const line = 'int x = read(f);';
		let at = 0;
		for (const segment of highlightLine(line, 'c')) {
			expect(line.slice(at, at + segment.text.length)).toBe(segment.text);
			at += segment.text.length;
		}
		expect(at).toBe(line.length);
	});

	it('extOf reads the last dot segment', () => {
		expect(extOf('src/a.b/c.cpp')).toBe('cpp');
		expect(extOf('noext')).toBe('noext');
	});
});
