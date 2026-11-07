// The terminal's Unicode width vocabulary (module 11, the link layer's leaf): what the
// cell grid makes of one character. The link provider's ranges name CELL columns while
// `detectLinks` reports JavaScript string indices, and the two only agree while every
// character is one cell wide — a CJK ideograph, a fullwidth form or most emoji paint two
// cells for one (or two) code units, a combining mark paints none, so everything after
// the first wide character on a line pointed at the wrong cells (wrong click targets,
// wrong hover boxes). This file is the pure conversion — `toCellColumn` walks a string
// up to a code-unit index counting each character's cells — and nothing else imports
// xterm or the DOM. Terminal output is its whole audience: the practical ranges below
// (the common CJK, Hangul, kana, emoji-pictograph, combining and format blocks) cover
// what shells and tools actually print, not exhaustive Unicode conformance.

/** One inclusive code-point range `[first, last]`, ranges listed ascending. */
type WidthRange = readonly [number, number];

/** Zero-width: combining marks (a diacritic lives over the previous cell), the format
 *  characters that steer text (ZWSP/ZWNJ/ZWJ, the bidi controls, variation selectors)
 *  and Hangul Jamo's medial-vowel and final-consonant block the precomposed syllables
 *  decompose into. The C0/C1 controls are handled beside these, not here. */
const ZERO_WIDTH: readonly WidthRange[] = [
	[0x0300, 0x036f], [0x0483, 0x0489], // combining diacriticals, Cyrillic
	[0x0591, 0x05bd], [0x05bf, 0x05bf], [0x05c1, 0x05c2], [0x05c4, 0x05c5], [0x05c7, 0x05c7], // Hebrew points
	[0x0610, 0x061a], [0x061c, 0x061c], [0x064b, 0x065f], [0x0670, 0x0670], // Arabic marks, letter mark
	[0x06d6, 0x06dc], [0x06df, 0x06e4], [0x06e7, 0x06e8], [0x06ea, 0x06ed],
	[0x0711, 0x0711], [0x0730, 0x074a], [0x07a6, 0x07b0], [0x07eb, 0x07f3],
	[0x0816, 0x0819], [0x081b, 0x0823], [0x0825, 0x0827], [0x0829, 0x082d], [0x0859, 0x085b],
	[0x08e3, 0x0902], [0x093a, 0x093a], [0x093c, 0x093c], [0x0941, 0x0948], [0x094d, 0x094d], // Devanagari
	[0x0e31, 0x0e31], [0x0e34, 0x0e3a], [0x0e47, 0x0e4e], // Thai
	[0x1160, 0x11ff], // Hangul Jamo medial vowels, final consonants
	[0x135d, 0x135f], [0x1712, 0x1714], [0x17b4, 0x17b5], [0x17b7, 0x17bd], [0x17c6, 0x17c6], [0x17c9, 0x17d3],
	[0x180b, 0x180f], [0x1ab0, 0x1aff], [0x1dc0, 0x1dff], // Mongolian, combining extended
	[0x200b, 0x200f], [0x202a, 0x202e], [0x2060, 0x2064], [0x206a, 0x206f], // zero-width and bidi format characters
	[0x20d0, 0x20f0], [0xfe00, 0xfe0f], [0xfe20, 0xfe2f], // marks for symbols, variation selectors, half marks
	[0x3099, 0x309a], // kana voicing marks
	[0xfeff, 0xfeff], [0xfff9, 0xfffb], [0xe0100, 0xe01ef] // BOM, interlinear annotation, selector supplement
];

/** Two cells: East Asian Wide and Fullwidth — the ideographs, kana and Hangul
 *  syllables, the fullwidth Latin block, and the emoji pictographs most terminals
 *  render double. */
const WIDE: readonly WidthRange[] = [
	[0x1100, 0x115f], // Hangul Jamo initial consonants
	[0x2e80, 0x303e], [0x3041, 0x33ff], // CJK radicals through symbols, kana through compatibility
	[0x3400, 0x4dbf], [0x4e00, 0x9fff], // CJK Extension A, the unified ideographs
	[0xa000, 0xa4cf], [0xa960, 0xa97f], // Yi, Jamo Extension A
	[0xac00, 0xd7a3], // Hangul syllables
	[0xf900, 0xfaff], // CJK compatibility ideographs
	[0xfe10, 0xfe19], [0xfe30, 0xfe6f], // vertical forms, compatibility forms
	[0xff00, 0xff60], [0xffe0, 0xffe6], // fullwidth Latin and signs
	[0x16fe0, 0x16fe4], [0x17000, 0x187f7], // Tangut
	[0x1b000, 0x1b2ff], // kana and CJK extensions beyond the BMP
	[0x1f004, 0x1f004], [0x1f0cf, 0x1f0cf], [0x1f18e, 0x1f18e], [0x1f191, 0x1f19a], // the single-code-point wide emoji
	[0x1f300, 0x1f5ff], [0x1f600, 0x1f64f], [0x1f680, 0x1f6ff], // pictographs, emoticons, transport
	[0x1f900, 0x1f9ff], [0x1fa70, 0x1faff], // supplemental and extended pictographs
	[0x20000, 0x2fffd], [0x30000, 0x3fffd] // CJK Extensions B and beyond
];

/** Whether `cp` lands in `ranges` (ascending, non-overlapping): scan stops at the first
 *  range past it. A line's link ranges call this once per character — dozens of
 *  comparisons over a few dozen entries, never a hot loop. */
function inRanges(cp: number, ranges: readonly WidthRange[]): boolean {
	for (const [first, last] of ranges) {
		if (cp < first) return false;
		if (cp <= last) return true;
	}
	return false;
}

/** How many cells one code point paints: zero (a control or a non-printing mark), two
 *  (wide or fullwidth), or one (everything else — the default a terminal gives an
 *  unknown code point, so the walk errs toward the common case). */
export function codePointCellWidth(cp: number): 0 | 1 | 2 {
	if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0; // C0/C1 controls paint no cell
	if (inRanges(cp, ZERO_WIDTH)) return 0;
	if (inRanges(cp, WIDE)) return 2;
	return 1;
}

/** How many cells the first `index` code units of `text` occupy — the string-index →
 *  cell-column conversion the link provider needs for its ranges. A surrogate pair is
 *  two code units but one character, walked whole; an `index` landing mid-pair counts
 *  the half-pair as nothing (a regex match's offsets never land there). */
export function toCellColumn(text: string, index: number): number {
	const bound = Math.min(index, text.length);
	let cells = 0;
	let at = 0;
	while (at < bound) {
		const cp = text.codePointAt(at)!;
		const size = cp > 0xffff ? 2 : 1;
		if (at + size > bound) break;
		cells += codePointCellWidth(cp);
		at += size;
	}
	return cells;
}
