// The remote trust boundary's own tests (src/remote/pathGate.ts): the rule table is the
// extraction of every backend command with path-like parameters — these tests pin the
// load-bearing entries (the ones whose miss would re-open the boundary) and the path
// algebra's edge cases.
import { describe, expect, it } from 'vitest';
import { absoluteForm, gateInvoke, withinRoots } from '../src/remote/pathGate';

const isWindows = navigator.platform.toLowerCase().includes('win');
const ROOT = isWindows ? 'C:\\repo' : '/work/repo';
const INSIDE = isWindows ? 'C:\\repo\\src\\a.ts' : '/work/repo/src/a.ts';
const OUTSIDE = isWindows ? 'C:\\Users\\me\\.ggs\\keys\\ai-providers.key' : '/home/me/.ggs/keys/ai-providers.key';

describe('the path algebra', () => {
	it('normalizes separators, dot-dots and drive case', () => {
		expect(absoluteForm(ROOT)).toBe(isWindows ? 'c:/repo' : '/work/repo');
		expect(absoluteForm(INSIDE)).toBe(isWindows ? 'c:/repo/src/a.ts' : '/work/repo/src/a.ts');
		if (isWindows) {
			expect(absoluteForm('C:\\repo\\a\\..\\b')).toBe('c:/repo/b');
			expect(absoluteForm('C:')).toBeNull();
		} else {
			expect(absoluteForm('/work/repo/a/../b')).toBe('/work/repo/b');
		}
		expect(absoluteForm('relative/x.ts')).toBeNull();
		// A root's own spelling (with or without its trailing separator) contains itself.
		expect(withinRoots(ROOT, [ROOT])).toBe(true);
		expect(withinRoots(INSIDE, [isWindows ? 'C:\\repo\\' : '/work/repo/'])).toBe(true);
		expect(withinRoots(OUTSIDE, [ROOT])).toBe(false);
		// `..` never climbs out of a root into a match.
		expect(withinRoots(isWindows ? 'C:\\repo\\..\\secret' : '/work/repo/../secret', [ROOT])).toBe(false);
	});
});

describe('the gate table', () => {
	it('confines the commands whose parameters were easy to miss', () => {
		const roots = [ROOT];
		// search_workspace/list_files anchor on `repo` — an earlier spelling missed it.
		expect(() => gateInvoke('search_workspace', { query: 'x', repo: ROOT }, roots)).not.toThrow();
		expect(() => gateInvoke('search_workspace', { query: 'x', repo: OUTSIDE }, roots)).toThrow(/outside the folders/);
		expect(() => gateInvoke('list_files', { repo: OUTSIDE }, roots)).toThrow(/outside the folders/);
		// The git/scm/analysis/symbol family: `repo` is the anchor.
		expect(() => gateInvoke('scm_status', { repo: ROOT }, roots)).not.toThrow();
		expect(() => gateInvoke('scm_status', { repo: OUTSIDE }, roots)).toThrow(/outside the folders/);
		expect(() => gateInvoke('analysis_metrics', { repo: OUTSIDE }, roots)).toThrow(/outside the folders/);
		expect(() => gateInvoke('symbol_tree', { repo: OUTSIDE }, roots)).toThrow(/outside the folders/);
		// A relative path is refused where the backend would resolve it against a
		// working directory, allowed where it resolves against the gated repo.
		expect(() => gateInvoke('read_file', { path: 'a.ts' }, roots)).toThrow(/absolute path/);
		expect(() => gateInvoke('file_log', { path: 'a.ts', repo: ROOT }, roots)).not.toThrow();
		expect(() => gateInvoke('file_log', { path: 'a.ts', repo: OUTSIDE }, roots)).toThrow(/outside the folders/);
	});

	it('refuses the commands that would widen the boundary', () => {
		const roots = [ROOT];
		for (const command of ['open_folder', 'open_workspace', 'open_single_file', 'scm_clone', 'ext_install_from_vsix']) {
			// The idempotent same-root call passes; anything new is refused.
			expect(() => gateInvoke(command, { path: ROOT }, roots), command).not.toThrow();
			const arg = command === 'scm_clone' ? 'parent' : 'path';
			expect(() => gateInvoke(command, { [arg]: OUTSIDE }, roots), command).toThrow(
				/cannot open new folders/
			);
		}
	});

	it('lets a completion type its way toward a root, and nowhere else', () => {
		const roots = [ROOT];
		const toward = isWindows ? 'C:\\r' : '/work/r';
		const elsewhere = isWindows ? 'C:\\Wi' : '/etc';
		expect(() => gateInvoke('path_completions', { prefix: toward }, roots)).not.toThrow();
		expect(() => gateInvoke('path_completions', { prefix: INSIDE }, roots)).not.toThrow();
		expect(() => gateInvoke('path_completions', { prefix: elsewhere }, roots)).toThrow(
			/cannot open new folders/
		);
	});
});
