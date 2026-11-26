import { describe, expect, it } from 'vitest';
import { resolveLatestGitDiffPath } from '../src/workbench/workbench';
import type { EditorInput } from '../src/features/editor/inputs';

type DiffInput = Extract<EditorInput, { kind: 'diff' }>;

const HEAD_HASH = '1d9e2450123456789abcdef0123456789abcdef0';
const OLD_HASH = 'a523d5b0123456789abcdef0123456789abcdef0';

function makeDiff(partial: Partial<DiffInput> & { left: DiffInput['left']; right: DiffInput['right'] }): DiffInput {
	return {
		kind: 'diff',
		id: partial.id ?? 'test-diff',
		title: partial.title ?? 'test.ts',
		repo: partial.repo,
		binaryNotice: partial.binaryNotice,
		left: partial.left,
		right: partial.right
	};
}

describe('resolveLatestGitDiffPath', () => {
	it('enables symbol windows when git diff right side is Working Tree (*)', () => {
		const input = makeDiff({
			left: { revision: 'HEAD', path: 'src/app.ts', label: 'HEAD', exists: true },
			right: { revision: '*', path: 'src/app.ts', label: 'Working Tree', exists: true }
		});
		expect(resolveLatestGitDiffPath(input, '/repo', HEAD_HASH)).toBe('/repo/src/app.ts');
	});

	it('enables symbol windows when git diff right side is Staged (:index)', () => {
		const input = makeDiff({
			left: { revision: 'HEAD', path: 'src/app.ts', label: 'HEAD', exists: true },
			right: { revision: ':index', path: 'src/app.ts', label: 'Staged', exists: true }
		});
		expect(resolveLatestGitDiffPath(input, '/repo', HEAD_HASH)).toBe('/repo/src/app.ts');
	});

	it('enables symbol windows when git diff right side is HEAD or matches current HEAD hash', () => {
		const symbolic = makeDiff({
			left: { revision: OLD_HASH, path: 'src/app.ts', label: 'a523d5b', exists: true },
			right: { revision: 'HEAD', path: 'src/app.ts', label: 'HEAD', exists: true }
		});
		expect(resolveLatestGitDiffPath(symbolic, '/repo', HEAD_HASH)).toBe('/repo/src/app.ts');

		const fullHash = makeDiff({
			left: { revision: OLD_HASH, path: 'src/app.ts', label: 'a523d5b', exists: true },
			right: { revision: HEAD_HASH, path: 'src/app.ts', label: '1d9e245', exists: true }
		});
		expect(resolveLatestGitDiffPath(fullHash, '/repo', HEAD_HASH)).toBe('/repo/src/app.ts');

		const shortHash = makeDiff({
			left: { revision: OLD_HASH, path: 'src/app.ts', label: 'a523d5b', exists: true },
			right: { revision: '1d9e245', path: 'src/app.ts', label: '1d9e245', exists: true }
		});
		expect(resolveLatestGitDiffPath(shortHash, '/repo', HEAD_HASH)).toBe('/repo/src/app.ts');
	});

	it('resolves submodule paths against input.repo', () => {
		const subDiff = makeDiff({
			repo: '/repo/submod',
			left: { revision: 'HEAD', path: 'lib.rs', label: 'HEAD', exists: true },
			right: { revision: '*', path: 'lib.rs', label: 'Working Tree', exists: true }
		});
		expect(resolveLatestGitDiffPath(subDiff, '/repo', HEAD_HASH)).toBe('/repo/submod/lib.rs');
	});

	it('disables symbol windows when git diff right side is an older commit', () => {
		const historical = makeDiff({
			left: { revision: 'b0e31930123456789abcdef0123456789abcdef0', path: 'src/app.ts', label: 'b0e3193', exists: true },
			right: { revision: OLD_HASH, path: 'src/app.ts', label: 'a523d5b', exists: true }
		});
		expect(resolveLatestGitDiffPath(historical, '/repo', HEAD_HASH)).toBeNull();

		const parentRef = makeDiff({
			left: { revision: 'HEAD~2', path: 'src/app.ts', label: 'HEAD~2', exists: true },
			right: { revision: 'HEAD~1', path: 'src/app.ts', label: 'HEAD~1', exists: true }
		});
		expect(resolveLatestGitDiffPath(parentRef, '/repo', HEAD_HASH)).toBeNull();
	});

	it('disables symbol windows for file-to-file local compares and in-memory content compares', () => {
		const localCompare = makeDiff({
			id: 'paths:/repo/a.ts::/repo/b.ts',
			left: { revision: '*', path: '/repo/a.ts', label: '/repo/a.ts', exists: true, local: true },
			right: { revision: '*', path: '/repo/b.ts', label: '/repo/b.ts', exists: true, local: true }
		});
		expect(resolveLatestGitDiffPath(localCompare, '/repo', HEAD_HASH)).toBeNull();

		const clipboardCompare = makeDiff({
			id: 'clipboard:1',
			left: { revision: '*', path: '/repo/a.ts', label: 'Clipboard', exists: true, content: 'old' },
			right: { revision: '*', path: '/repo/a.ts', label: '/repo/a.ts', exists: true, content: 'new' }
		});
		expect(resolveLatestGitDiffPath(clipboardCompare, '/repo', HEAD_HASH)).toBeNull();
	});

	it('disables symbol windows when right side is deleted or binary notice', () => {
		const deleted = makeDiff({
			left: { revision: 'HEAD', path: 'src/app.ts', label: 'HEAD', exists: true },
			right: { revision: '*', path: 'src/app.ts', label: 'Working Tree', exists: false }
		});
		expect(resolveLatestGitDiffPath(deleted, '/repo', HEAD_HASH)).toBeNull();

		const binary = makeDiff({
			binaryNotice: true,
			left: { revision: 'HEAD', path: 'logo.png', label: 'HEAD', exists: true },
			right: { revision: '*', path: 'logo.png', label: 'Working Tree', exists: true }
		});
		expect(resolveLatestGitDiffPath(binary, '/repo', HEAD_HASH)).toBeNull();
	});
});
