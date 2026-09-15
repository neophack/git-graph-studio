// The quick-open fuzzy scorer: VS Code's tiered scoring (basename prefix > basename fuzzy >
// path match) with its per-character boosts, and the ordering it induces over a file list.

import { describe, expect, it } from 'vitest';

import { compareFileMatches, makeQuery, scoreFile, scoreSequence, type FileEntry } from '../src/fuzzy';

function entry(path: string): FileEntry {
	const label = path.slice(path.lastIndexOf('/') + 1);
	return { path, label, labelLower: label.toLowerCase(), pathLower: path.toLowerCase() };
}

function score(path: string, query: string): number | null {
	const match = scoreFile(entry(path), makeQuery(query));
	return match?.score ?? null;
}

describe('scoreSequence', () => {
	it('requires the query to be a subsequence of the target', () => {
		expect(scoreSequence('main.ts', 'main.ts'.toLowerCase(), 'mts', 'mts')).not.toBeNull();
		expect(scoreSequence('main.ts', 'main.ts'.toLowerCase(), 'smn', 'smn')).toBeNull();
		expect(scoreSequence('main.ts', 'main.ts'.toLowerCase(), '', '')).toEqual({ score: 0, ranges: [] });
	});

	it('rewards consecutive runs over scattered matches', () => {
		const tight = scoreSequence('main.tsx', 'main.tsx', 'main', 'main')!;
		const scattered = scoreSequence('mxaixan.tsx', 'mxaixan.tsx', 'main', 'main')!;
		expect(tight.score).toBeGreaterThan(scattered.score);
	});

	it('rewards word starts and separators over mid-word hits', () => {
		const hump = scoreSequence('MyFile.ts', 'myfile.ts', 'f', 'f')!;
		const midWord = scoreSequence('MyfXle.ts', 'myfxle.ts', 'f', 'f')!;
		expect(hump.score).toBeGreaterThan(midWord.score);

		const afterSlash = scoreSequence('src/util.ts', 'src/util.ts', 'u', 'u')!;
		const midName = scoreSequence('src/auxl.ts', 'src/auxl.ts', 'u', 'u')!;
		expect(afterSlash.score).toBeGreaterThan(midName.score);
	});

	it('merges adjacent positions into ranges', () => {
		const match = scoreSequence('main.ts', 'main.ts'.toLowerCase(), 'mts', 'mts')!;
		expect(match.ranges).toEqual([[0, 1], [5, 7]]);
	});
});

describe('scoreFile tiers', () => {
	it('ranks a basename prefix above a scattered basename match', () => {
		const prefix = score('src/window.ts', 'win')!;
		const scattered = score('src/wizard-index.ts', 'win')!;
		expect(prefix).toBeGreaterThan(scattered);
	});

	it('ranks any basename match above a path-only match', () => {
		const basename = score('src/transport.rs', 'tans')!; // scattered inside the basename
		const pathOnly = score('transport/mod.rs', 'tans'); // only reachable through the path
		expect(pathOnly).not.toBeNull();
		expect(basename).toBeGreaterThan(pathOnly!);
	});

	it('matches a query with separators against the path', () => {
		expect(score('src/main.ts', 'src/ma')).not.toBeNull();
		expect(score('lib/main.ts', 'src/ma')).toBeNull();
	});

	it('prefers the shorter file when both prefix the basename equally', () => {
		const short = score('src/win.ts', 'win')!;
		const long = score('src/window.ts', 'win')!;
		expect(short).toBeGreaterThan(long);
	});
});

describe('compareFileMatches ordering', () => {
	it('sorts by score, then shorter path, then lexicographic', () => {
		const query = makeQuery('a');
		const ranked = ['a/x.ts', 'b/aa.ts', 'c/a.ts', 'a/a.ts']
			.map((path) => scoreFile(entry(path), query)!)
			.sort(compareFileMatches);
		// The basename-prefix hits lead (the shorter basename first); the path-only hit trails.
		expect(ranked.map((m) => m.entry.path)).toEqual(['a/a.ts', 'c/a.ts', 'b/aa.ts', 'a/x.ts']);
	});
});
