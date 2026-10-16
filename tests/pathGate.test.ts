// The remote trust boundary's own tests (src/remote/pathGate.ts): the rule table is the
// extraction of every backend command with path-like parameters — these tests pin the
// load-bearing entries (the ones whose miss would re-open the boundary) and the path
// algebra's edge cases.
import { describe, expect, it } from 'vitest';
import { absoluteForm, canonicalForm, gateInvoke, gateInvokeCanonical, withinRoots } from '../src/remote/pathGate';

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
		for (const command of ['open_workspace', 'open_single_file', 'scm_clone', 'ext_install_from_vsix']) {
			// The idempotent same-root call passes; anything new is refused.
			expect(() => gateInvoke(command, { path: ROOT }, roots), command).not.toThrow();
			const arg = command === 'scm_clone' ? 'parent' : 'path';
			expect(() => gateInvoke(command, { [arg]: OUTSIDE }, roots), command).toThrow(
				/cannot open new folders/
			);
		}
	});

	it('refuses the desktop-only commands outright (R0, docs/remote-client-plan.md §3.3)', () => {
		const roots = [ROOT];
		// open_folder is refused even for a root the window already holds: a session's
		// roots arrive with ATTACH and boot_context, never through its own invoke.
		// app_new_instance spawns a sibling process; settings_write/assoc_apply/
		// context_menu_apply/providers_shell_refresh are the PC's own machine-level
		// integrations (user_path_apply is no command at all — boot-time, unreachable).
		// Workspace-rooted arguments change nothing: the refusal is the command's, not
		// the path's.
		for (const command of [
			'open_folder',
			'app_new_instance',
			'settings_write',
			'assoc_apply',
			'context_menu_apply',
			'providers_shell_refresh'
		]) {
			expect(() => gateInvoke(command, { path: ROOT, contents: '{}', extensions: [], on: true, label: 'x' }, roots), command).toThrow(
				/the desktop's own/
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

	it("lets ext_fs reach the extension platform's own areas, and nothing else there", () => {
		const roots = [ROOT];
		const extRoots = [
			isWindows ? 'C:\\Users\\me\\.ggs\\extensions' : '/home/me/.ggs/extensions',
			isWindows ? 'C:\\Users\\me\\.ggs\\extension-data' : '/home/me/.ggs/extension-data'
		];
		// An activation reading its own bundled files (Python copying pythonrc.py out of its
		// install) and its stored state is ordinary traffic — the backend's ext_fs contract
		// allows exactly these roots.
		const ownInstall = isWindows
			? 'C:\\Users\\me\\.ggs\\extensions\\ms-python.python-2026.4.0\\python_files\\pythonrc.py'
			: '/home/me/.ggs/extensions/ms-python.python-2026.4.0/python_files/pythonrc.py';
		const ownStorage = isWindows
			? 'C:\\Users\\me\\.ggs\\extension-data\\ms-python.python\\global\\settings.json'
			: '/home/me/.ggs/extension-data/ms-python.python/global/settings.json';
		expect(() => gateInvoke('ext_fs', { op: 'read', path: ownInstall, to: ownStorage }, roots, extRoots)).not.toThrow();
		expect(() => gateInvoke('ext_fs', { op: 'read', path: INSIDE }, roots, extRoots)).not.toThrow();
		// The rest of ~/.ggs stays outside the boundary — settings, keys, Claude state.
		expect(() => gateInvoke('ext_fs', { op: 'read', path: OUTSIDE }, roots, extRoots)).toThrow(/outside the folders/);
		// The extension areas widen ext_fs ONLY: every other command keeps the open folders.
		expect(() => gateInvoke('read_file', { path: ownInstall }, roots, extRoots)).toThrow(/outside the folders/);
		// And without the areas served (an older backend's answer), the strict rule holds.
		expect(() => gateInvoke('ext_fs', { op: 'read', path: ownInstall }, roots)).toThrow(/outside the folders/);
	});
});

describe('the canonical re-check', () => {
	it('canonicalForm reads the backend answer: prefixes stripped, drive lower-cased', () => {
		// fs::canonicalize's Windows extended-length spellings.
		expect(canonicalForm('x', () => '\\\\?\\C:\\Repo\\a.ts')).toBe(isWindows ? 'c:/Repo/a.ts' : 'c:/Repo/a.ts');
		expect(canonicalForm('x', () => '\\\\?\\UNC\\server\\share\\a.ts')).toBe('//server/share/a.ts');
		// Plain answers pass through, POSIX or Windows.
		expect(canonicalForm('x', () => '/real/a.ts')).toBe('/real/a.ts');
		expect(canonicalForm('x', () => 'D:\\Real\\A.ts')).toBe('d:/Real/A.ts');
		// No answer (the path does not exist) and no absolute form both stay null.
		expect(canonicalForm('x', () => null)).toBeNull();
		expect(canonicalForm('x', () => 'not/absolute')).toBeNull();
	});

	it('refuses a lexical-inside path whose canonical form is outside', async () => {
		const link = isWindows ? 'C:\\repo\\sneak.key' : '/work/repo/sneak.key';
		const canonicalizer = async (paths: string[]) => paths.map((p) => (p === link ? OUTSIDE : p));
		// The lexical gate passes it — that is the hole the re-check closes.
		expect(() => gateInvoke('read_file', { path: link }, [ROOT])).not.toThrow();
		await expect(gateInvokeCanonical('read_file', { path: link }, { roots: [ROOT] }, canonicalizer)).rejects.toThrow(
			/resolves to .*outside the folders/
		);
		// Every gated argument re-checks: the repo anchor too.
		await expect(gateInvokeCanonical('scm_status', { repo: link }, { roots: [ROOT] }, canonicalizer)).rejects.toThrow(
			/resolves to/
		);
		// ext_fs keeps its wider allowance on the canonical side as well.
		const ownInstall = isWindows
			? 'C:\\Users\\me\\.ggs\\extensions\\pkg\\pythonrc.py'
			: '/home/me/.ggs/extensions/pkg/pythonrc.py';
		await expect(
			gateInvokeCanonical('ext_fs', { op: 'read', path: ownInstall }, { roots: [ROOT], extRoots: [isWindows ? 'C:\\Users\\me\\.ggs\\extensions' : '/home/me/.ggs/extensions'] }, async (paths) => paths)
		).resolves.toBeUndefined();
		await expect(
			gateInvokeCanonical('read_file', { path: ownInstall }, { roots: [ROOT], extRoots: [isWindows ? 'C:\\Users\\me\\.ggs\\extensions' : '/home/me/.ggs/extensions'] }, async (paths) => paths)
		).rejects.toThrow(/outside the folders/);
	});

	it('keeps the lexical answer when nothing resolves, and canonicalizes the roots too', async () => {
		const root = ROOT;
		// A path that does not exist yet (a write's target): null form, lexical stands.
		await expect(
			gateInvokeCanonical('write_file', { path: `${root}${isWindows ? '\\new.txt' : '/new.txt'}` }, { roots: [root] }, async () => [null, null])
		).resolves.toBeUndefined();
		// The same call with a canonicalizer that cannot answer at all: refused (closed).
		await expect(
			gateInvokeCanonical('write_file', { path: `${root}${isWindows ? '\\new.txt' : '/new.txt'}` }, { roots: [root] }, async () => {
				throw new Error('backend gone');
			})
		).rejects.toThrow(/could not resolve/);
		// A workspace opened through a junction: the root's canonical form contains its
		// members' canonical forms — the ordinary case must keep passing.
		const realRoot = isWindows ? 'C:\\real\\repo' : '/real/repo';
		const throughJunction = isWindows ? 'C:\\junction\\repo\\src\\a.ts' : '/junction/repo/src/a.ts';
		await expect(
			gateInvokeCanonical('read_file', { path: throughJunction }, { roots: [isWindows ? 'C:\\junction\\repo' : '/junction/repo'] }, async (paths) =>
				paths.map((p) => p.replace('junction', 'real'))
			)
		).resolves.toBeUndefined();
		// ...while the same link aimed outside still refuses.
		await expect(
			gateInvokeCanonical('read_file', { path: throughJunction }, { roots: [root] }, async (paths) =>
				paths.map((p) => (p === root ? realRoot : OUTSIDE))
			)
		).rejects.toThrow(/resolves to/);
	});
});
