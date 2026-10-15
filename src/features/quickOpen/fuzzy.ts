// The quick-open matcher, ported from VS Code's vs/base/common/fuzzyScorer.ts: a tiered item
// score (label prefix > label fuzzy match > path match) built on a left-to-right subsequence
// alignment whose per-character boosts reward consecutive runs, word starts, separators and
// camelCase humps. The tier gaps are wide on purpose — any basename hit outranks any path-only
// hit, and any prefix hit outranks any basename hit, exactly as in VS Code's picker.

/** A [start, end) range of matched characters, for bolding in the pick list. */
export type MatchRange = [number, number];

export interface FuzzyMatch {
	score: number;
	/** Matched-character ranges in the string that was scored. */
	ranges: MatchRange[];
}

/** The tiers of vs/base/common/fuzzyScorer.ts: a label-prefix match always outranks a plain
 *  label match, which always outranks a match found in the path around the label. */
const LABEL_PREFIX_SCORE = 1 << 17;
const LABEL_SCORE = 1 << 16;
const PATH_SCORE = 1 << 15;

/** Characters VS Code's computeCharScore treats as separators before a match. */
function isSeparator(code: number): boolean {
	return code === 0x2f /* / */ || code === 0x5c /* \ */;
}

function isOtherSeparator(code: number): boolean {
	return (
		code === 0x5f /* _ */ || code === 0x2d /* - */ || code === 0x2e /* . */ ||
		code === 0x20 /* space */ || code === 0x27 /* ' */ || code === 0x22 /* " */ || code === 0x3a /* : */
	);
}

function isUpper(code: number): boolean {
	return code >= 65 /* A */ && code <= 90 /* Z */;
}

/** Merge adjacent match positions into ranges, as VS Code's createMatches does. */
function toRanges(positions: number[]): MatchRange[] {
	const ranges: MatchRange[] = [];
	for (const position of positions) {
		const last = ranges[ranges.length - 1];
		if (last && last[1] === position) last[1] = position + 1;
		else ranges.push([position, position + 1]);
	}
	return ranges;
}

/**
 * Score `query` against `target` as a subsequence, VS Code's computeCharScore: +1 per matched
 * character, +1 for an exact-case match, a steepening bonus for consecutive runs, +8 at a word
 * start, +5 after a path separator, +4 after `_`/`-`/`.`/space, +2 for a camelCase hump.
 * `targetLower`/`queryLower` are pre-lowered by the caller — never allocated per keystroke.
 * Returns null when the query is not a subsequence of the target.
 */
export function scoreSequence(target: string, targetLower: string, query: string, queryLower: string): FuzzyMatch | null {
	const positions: number[] = [];
	let score = 0;
	let run = 0;
	let at = 0;
	for (let qi = 0; qi < queryLower.length; qi++) {
		const wanted = queryLower.charCodeAt(qi);
		let found = -1;
		for (let ti = at; ti < targetLower.length; ti++) {
			if (targetLower.charCodeAt(ti) === wanted) {
				found = ti;
				break;
			}
		}
		if (found === -1) return null;
		if (found > at) run = 0; // a gap before this match breaks the consecutive run
		score += 1;
		if (query.charCodeAt(qi) === target.charCodeAt(found)) score += 1;
		if (run > 0) score += Math.min(run, 3) * 6 + Math.max(0, run - 3) * 3;
		if (found === 0) {
			score += 8;
		} else {
			const before = targetLower.charCodeAt(found - 1);
			if (isSeparator(before)) score += 5;
			else if (isOtherSeparator(before)) score += 4;
			else if (isUpper(target.charCodeAt(found)) && run === 0) score += 2;
		}
		positions.push(found);
		run += 1;
		at = found + 1;
	}
	return { score, ranges: toRanges(positions) };
}

export interface FuzzyQuery {
	/** The query as typed — exact-case matches score higher. */
	text: string;
	/** The query pre-lowered once per keystroke. */
	lower: string;
}

export function makeQuery(text: string): FuzzyQuery {
	return { text, lower: text.toLowerCase() };
}

/** A file scored for the pick list. `labelRanges` index into the basename. */
export interface FileMatch {
	entry: FileEntry;
	score: number;
	labelRanges: MatchRange[];
}

/** One Quick Open candidate: everything precomputed at index-build time, so the per-keystroke
 *  scan only reads — no lowercase allocations, no basename re-splitting. */
export interface FileEntry {
	/** Repo-relative, forward slashes. */
	path: string;
	label: string;
	labelLower: string;
	pathLower: string;
}

/**
 * Score one file the way VS Code scores a picker item: prefix-on-basename first, then a fuzzy
 * match on the basename, then a fuzzy match over the whole path (demoted a tier, with only the
 * ranges that land inside the basename highlighted).
 */
export function scoreFile(entry: FileEntry, query: FuzzyQuery): FileMatch | null {
	if (query.lower === '') return null;
	const labelMatch = scoreSequence(entry.label, entry.labelLower, query.text, query.lower);
	if (labelMatch) {
		// A query that prefixes the basename tops the label tier; the closer to the full name,
		// the better, so typing most of a filename prefers the shorter file.
		if (entry.labelLower.startsWith(query.lower)) {
			const boost = Math.round((query.lower.length / entry.labelLower.length) * 100);
			return { entry, score: LABEL_PREFIX_SCORE + boost + labelMatch.score, labelRanges: labelMatch.ranges };
		}
		return { entry, score: LABEL_SCORE + labelMatch.score, labelRanges: labelMatch.ranges };
	}
	// A query with separators (src/ma) is meant for the path; so is any query whose characters
	// only appear around the basename. The match is demoted below every basename hit.
	const pathMatch = scoreSequence(entry.path, entry.pathLower, query.text, query.lower);
	if (!pathMatch) return null;
	const offset = entry.path.length - entry.label.length;
	const labelRanges = pathMatch.ranges
		.filter(([start, end]) => start >= offset)
		.map(([start, end]) => [start - offset, end - offset] as MatchRange);
	return { entry, score: PATH_SCORE + pathMatch.score, labelRanges };
}

/** VS Code's compareItemsByFuzzyScore, reduced to the file case: score, then the shorter path,
 *  then the lexicographically smaller one. */
export function compareFileMatches(a: FileMatch, b: FileMatch): number {
	if (a.score !== b.score) return b.score - a.score;
	if (a.entry.path.length !== b.entry.path.length) return a.entry.path.length - b.entry.path.length;
	return a.entry.path < b.entry.path ? -1 : a.entry.path > b.entry.path ? 1 : 0;
}
