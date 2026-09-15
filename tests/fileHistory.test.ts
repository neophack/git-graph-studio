// File history and blame: the history tab lists a file's commits from the graph engine's log
// (a path-filtered loadCommits through the graph host) and opens the diff of a commit's version
// against its parent; the blame gutter toggles onto the active editor with "author, when" per
// line.

import { describe, expect, it } from 'vitest';

import { EditorGroup } from '../src/editor';
import { blameLabel, loadFileHistory, relativeDate } from '../src/fileHistory';
import { backend } from './tauriMock';
import { click, flush } from './helpers';

const REPO = 'C:\\repo';
const NOW = 1_700_000_000_000;

/** Wait for an asynchronous open (the diff view's chunks load on first use) to land. */
async function until(condition: () => boolean, timeoutMs = 3000): Promise<void> {
	const started = Date.now();
	while (!condition() && Date.now() - started < timeoutMs) await flush(2);
}

describe('file history', () => {
	it('formats relative dates and blame labels', () => {
		expect(relativeDate(NOW / 1000 - 30, NOW)).toBe('just now');
		expect(relativeDate(NOW / 1000 - 90, NOW)).toBe('1 min ago');
		expect(relativeDate(NOW / 1000 - 7200, NOW)).toBe('2 hours ago');
		expect(relativeDate(NOW / 1000 - 3 * 86400, NOW)).toBe('3 days ago');
		expect(blameLabel({ hash: '0'.repeat(40), author: 'Not Committed Yet', time: 0, summary: '' })).toBe('You, uncommitted');
		expect(blameLabel({ hash: 'abc', author: 'Ada', time: NOW / 1000 - 86400, summary: 's' }, NOW)).toBe('Ada, 1 day ago');
	});

	it('loads a path-filtered log through the graph channel, dropping the uncommitted row', async () => {
		backend.on('graph_request', ({ message }) => {
			const request = message as Record<string, unknown>;
			expect(request['command']).toBe('loadCommits');
			expect(request['filterPath']).toBe('src/a.ts');
			return { command: 'loadCommits', error: null, commits: [
				{ hash: '*', parents: [], author: '', date: 0, message: 'Uncommitted Changes' },
				{ hash: 'b'.repeat(40), parents: ['a'.repeat(40)], author: 'Bob', date: NOW / 1000 - 60, message: 'second' },
				{ hash: 'a'.repeat(40), parents: [], author: 'Ada', date: NOW / 1000 - 86400, message: 'first' }
			] };
		});
		const entries = await loadFileHistory(REPO, 'src/a.ts');
		expect(entries.map((e) => e.message)).toEqual(['second', 'first']);
	});

	it('opens the history tab and diffs a commit against its parent on click', async () => {
		backend.on('graph_request', () => ({ command: 'loadCommits', error: null, commits: [
			{ hash: 'b'.repeat(40), parents: ['a'.repeat(40)], author: 'Bob', date: NOW / 1000, message: 'second' },
			{ hash: 'a'.repeat(40), parents: [], author: 'Ada', date: NOW / 1000, message: 'first' }
		] }));
		backend.on('read_file_at', () => ({ contents: 'x\n', binary: false, size: 2, encoding: 'utf8', eol: 'lf' }));
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		group.setRoot(REPO);
		group.openFileHistory(`${REPO}\\src\\a.ts`);
		await flush(10);
		expect(group.activeInput).toEqual({ kind: 'history', path: `${REPO}\\src\\a.ts` });
		const rows = document.querySelectorAll('.file-history-row');
		expect(rows).toHaveLength(2);
		expect(rows[0]!.querySelector('.file-history-message')!.textContent).toBe('second');
		expect(rows[0]!.querySelector('.file-history-hash')!.textContent).toBe('bbbbbbbb');

		click(rows[0]);
		await until(() => group.activeInput?.kind === 'diff');
		expect(group.activeInput).toMatchObject({ kind: 'diff', id: `history:${'b'.repeat(40)}:src/a.ts` });
		const reads = backend.callsTo('read_file_at');
		expect(reads).toEqual([{ revision: 'a'.repeat(40), path: 'src/a.ts' }, { revision: 'b'.repeat(40), path: 'src/a.ts' }]);

		// A root commit diffs against nothing on the left.
		group.openFileHistory(`${REPO}\\src\\a.ts`);
		click(document.querySelectorAll('.file-history-row')[1]);
		await until(() => group.activeInput?.kind === 'diff' && group.activeInput.id.startsWith('history:aaaa'));
		expect(group.activeInput).toMatchObject({ kind: 'diff', left: { exists: false } });
	});

	it('toggles the blame gutter on the active file editor', async () => {
		backend.on('read_file', () => ({ contents: 'one\ntwo\n', binary: false, size: 8, encoding: 'utf8', eol: 'lf' }));
		backend.on('file_fingerprint', () => '8:1');
		backend.on('scm_blame', ({ path }) => {
			expect(path).toBe('src/a.ts');
			return [
				{ hash: 'a'.repeat(40), author: 'Ada', time: NOW / 1000 - 86400, summary: 'first' },
				{ hash: '0'.repeat(40), author: 'Not Committed Yet', time: 0, summary: '' }
			];
		});
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		group.setRoot(REPO);
		await group.openFile(`${REPO}\\src\\a.ts`);
		await group.toggleBlame();
		await flush();
		const labels = [...document.querySelectorAll('.cm-blame-line')].map((e) => e.textContent);
		expect(labels[0]).toMatch(/^Ada, /);
		expect(labels[1]).toBe('You, uncommitted');
		expect(document.querySelector('.cm-blame-line')!.getAttribute('title')).toBe('aaaaaaaa first');
		await group.toggleBlame();
		expect(document.querySelector('.cm-blame-gutter')).toBeNull();
	});
});
