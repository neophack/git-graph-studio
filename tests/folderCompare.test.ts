// The Folder Compare view: the status list, the selected file's diff detail - including the
// race between the async detail load and a re-render - and the sync actions' file I/O.

import { describe, expect, it, vi } from 'vitest';

import { MergeView } from '@codemirror/merge';

import { FolderCompareView } from '../src/folderCompare';
import { backend } from './tauriMock';
import { click, flush, menuItem, rightClick, texts, type } from './helpers';

const LEFT = 'C:\\left';
const RIGHT = 'C:\\right';

/** Resolve once `ready` holds (polled), failing the test after `ms`. */
async function waitFor(ready: () => boolean, ms = 10000): Promise<void> {
	const step = async (): Promise<void> => {
		if (ready()) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
		return step();
	};
	await Promise.race([step(), new Promise((_, reject) => setTimeout(() => reject(new Error('condition not met in time')), ms))]);
}

function textFile(contents: string, encoding = 'utf8', eol = 'lf') {
	return { contents, binary: false, size: contents.length, encoding, eol };
}

describe('folder compare', () => {
	it('lists the compared entries and shows the selected file’s diff', async () => {
		backend.on('compare_dirs', () => [
			{ path: 'a.txt', status: 'different', leftSize: 3, rightSize: 3 },
			{ path: 'gone.txt', status: 'leftOnly', leftSize: 5, rightSize: 0 }
		]);
		backend.on('file_probe', () => ({ size: 3, binary: false }));
		backend.on('read_file', ({ path }) => textFile(`text of ${path}\n`));
		const host = document.createElement('div');
		document.body.appendChild(host);
		const view = new FolderCompareView(host, { left: LEFT, right: RIGHT });
		await flush();
		expect(texts('.fc-row .label', host)).toEqual(['a.txt', 'gone.txt']);

		click(host.querySelector('.fc-row')!);
		await waitFor(() => host.querySelectorAll('.cm-mergeView').length === 1);
		expect(host.querySelector('.fc-detail-header span:not(.codicon)')!.textContent).toBe('a.txt');
		view.dispose();
	});

	it('a detail load superseded by a re-render never attaches nor claims the diff slot', async () => {
		backend.on('compare_dirs', () => [{ path: 'a.txt', status: 'different', leftSize: 3, rightSize: 3 }]);
		backend.on('file_probe', () => ({ size: 3, binary: false }));
		// The reads are gates: each detail load parks on its two read_file calls until the
		// test releases them, so the two loads' finish order is under the test's control.
		const gates: (() => void)[] = [];
		backend.on('read_file', ({ path }) => new Promise((resolve) => {
			gates.push(() => resolve(textFile(`text of ${path}\n`)));
		}));
		const destroySpy = vi.spyOn(MergeView.prototype, 'destroy');
		const host = document.createElement('div');
		document.body.appendChild(host);
		const view = new FolderCompareView(host, { left: LEFT, right: RIGHT });
		await flush();
		click(host.querySelector('.fc-row')!);
		await flush();
		expect(gates).toHaveLength(2); // the first load is parked on its two reads

		// A filter keystroke re-renders the pane (the selection is unchanged): the first
		// load's detail element is detached and a second load starts.
		type(host.querySelector<HTMLInputElement>('.fc-header input')!, 'a');
		await flush();
		expect(gates).toHaveLength(4);

		// The second load finishes first and shows its diff in the live pane…
		gates[2]!();
		gates[3]!();
		await waitFor(() => host.querySelectorAll('.cm-mergeView').length === 1);
		// …then the stale first load finishes: it must not overwrite the live diff.
		gates[0]!();
		gates[1]!();
		await flush(10);

		expect(host.querySelectorAll('.cm-mergeView')).toHaveLength(1);
		const fileDiff = (view as unknown as { fileDiff: { host: HTMLElement } | null }).fileDiff;
		expect(fileDiff).not.toBeNull();
		expect(fileDiff!.host.isConnected).toBe(true);

		// Disposing destroys the live diff, not the superseded one (which was never created).
		const liveDom = host.querySelector('.cm-mergeView')!;
		view.dispose();
		expect(destroySpy.mock.instances.map((view) => (view as MergeView).dom)).toContain(liveDom);
		destroySpy.mockRestore();
	});

	it('copies a file to the other side in its own encoding and line endings', async () => {
		backend.on('compare_dirs', () => [{ path: 'gbk.txt', status: 'different', leftSize: 10, rightSize: 6 }]);
		backend.on('file_probe', () => ({ size: 10, binary: false }));
		backend.on('read_file', () => textFile('中文注释\r\n', 'gb18030', 'crlf'));
		backend.on('write_file', () => null);
		const host = document.createElement('div');
		document.body.appendChild(host);
		new FolderCompareView(host, { left: LEFT, right: RIGHT });
		await flush();

		rightClick(host.querySelector('.fc-row')!);
		click(menuItem('Copy Left → Right'));
		await flush();

		// A GBK file must land as GBK with its CRLF endings - not transcoded to UTF-8.
		expect(backend.callsTo('write_file')).toEqual([
			{ path: `${RIGHT}\\gbk.txt`, contents: '中文注释\r\n', encoding: 'gb18030', eol: 'crlf' }
		]);
	});
});

describe('folder compare header', () => {
	it('keeps the filter box focused (and its text) while typing', async () => {
		backend.on('compare_dirs', () => [
			{ path: 'alpha.txt', status: 'different', leftSize: 3, rightSize: 3 },
			{ path: 'beta.txt', status: 'leftOnly', leftSize: 5, rightSize: 0 },
			{ path: 'same.txt', status: 'same', leftSize: 5, rightSize: 5 }
		]);
		const host = document.createElement('div');
		document.body.appendChild(host);
		new FolderCompareView(host, { left: LEFT, right: RIGHT });
		await flush();
		const filter = host.querySelector<HTMLInputElement>('.fc-header input')!;
		filter.focus();
		// Each keystroke narrows the list; the input the user types into is the same element
		// throughout, still focused, still holding what was typed.
		type(filter, 'b');
		type(filter, 'be');
		expect(document.activeElement).toBe(filter);
		expect(host.querySelector('.fc-header input')).toBe(filter);
		expect(filter.value).toBe('be');
		expect(texts('.fc-row .label', host)).toEqual(['beta.txt']);

		// The hide-same toggle keeps reflecting its state on the surviving header.
		const toggle = host.querySelector<HTMLElement>('.fc-controls .toggle')!;
		expect(toggle.classList.contains('active')).toBe(true);
		type(filter, '');
		click(toggle);
		expect(toggle.classList.contains('active')).toBe(false);
		expect(texts('.fc-row .label', host)).toEqual(['alpha.txt', 'beta.txt', 'same.txt']);
	});

	it('copying a file into a folder the other side lacks creates that folder first', async () => {
		backend.on('compare_dirs', () => [{ path: 'src/new/x.txt', status: 'leftOnly', leftSize: 2, rightSize: 0 }]);
		backend.on('read_file', () => textFile('x\n'));
		const created: string[] = [];
		backend.on('create_folder', ({ path }) => { created.push(String(path)); return null; });
		backend.on('write_file', ({ path }) => {
			if (!created.includes(`${RIGHT}\\src/new`)) throw new Error(`${path}: the containing folder no longer exists`);
			return null;
		});
		const host = document.createElement('div');
		document.body.appendChild(host);
		new FolderCompareView(host, { left: LEFT, right: RIGHT });
		await flush();
		rightClick(host.querySelector('.fc-row')!);
		click(menuItem('Copy Left → Right'));
		await flush();
		expect(created).toEqual([`${RIGHT}\\src/new`]);
		expect(backend.callsTo('write_file')).toEqual([{ path: `${RIGHT}\\src/new/x.txt`, contents: 'x\n', encoding: 'utf8', eol: 'lf' }]);
		expect(document.querySelectorAll('#notifications .notification')).toHaveLength(0);
	});
});
