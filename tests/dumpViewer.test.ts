// The Memory Dump Viewer: a .dmp / .mdmp opens straight into the dump view (never the
// hex viewer), the carve scan streams its entries into the list over the channel, the
// toolbar's filters narrow client-side, a row click previews (image bytes for a PNG, a
// hex head otherwise), the selection extracts through `dump_extract` with the scan's
// own coordinates, the Modules tab lists the dump's loaded images as rebuild requests,
// and a tab closed mid-scan cancels the backend walk.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Channel } from '@tauri-apps/api/core';

import { EditorGroup } from '../src/features/editor';
import { isDumpFile } from '../src/platform/fileIcons';
import { DumpView, carvedName, filterCarved, formatBytes, hexDump, imageMime } from '../src/features/dump';
import type { CarvedEntry, DumpEvent, DumpExtractRequest, DumpOverview } from '../src/platform/ipc/dump';
import { backend } from './tauriMock';
import { click } from './helpers';

afterEach(() => {
	document.getElementById('editorGroup')!.replaceChildren();
	backend.reset();
});

async function waitForReady(ready: () => boolean, ms = 10000): Promise<void> {
	await Promise.race([
		(async (): Promise<void> => {
			while (!ready()) await new Promise((resolve) => setTimeout(resolve, 20));
		})(),
		new Promise((_, reject) => setTimeout(() => reject(new Error('condition not met in time')), ms))
	]);
}

const OVERVIEW: DumpOverview = {
	path: 'C:\\dumps\\app.dmp',
	size: 477_865_602,
	timeDateStamp: 1_700_000_000,
	flags: 2,
	flagNames: ['WithFullMemory'],
	os: { arch: 'x64', version: '10.0.26200', build: 26200, processors: 24, productType: 1 },
	pid: 484088,
	threads: 13,
	hasException: false,
	modules: [
		{ base: 0x7ff0_0000, size: 4096, timestamp: 1_700_000_000, name: 'C:\\bin\\app.exe', fileName: 'app.exe' },
		{ base: 0x7ff1_0000, size: 8192, timestamp: 1_700_000_000, name: 'C:\\Windows\\System32\\a.dll', fileName: 'a.dll' }
	],
	moduleTotalBytes: 12_288,
	memoryRegions: 691,
	memoryTotalBytes: 477_000_000,
	streams: [{ kind: 4, name: 'ModuleList', size: 2272 }]
};

/** Four carved entries: one PNG (in a module), one ZIP on the heap, one tiny JPEG the
 *  min-size filter hides, and one TTF whose structural check failed (a false positive
 *  the verification filter hides by default). */
const ENTRIES: CarvedEntry[] = [
	{ id: 0, format: 'png', tag: 'image', offset: 100, size: 2048, va: 0x7ff0_0064, inModule: 'app.exe', verified: true },
	{ id: 1, format: 'zip', tag: 'archive', offset: 4096, size: 65536, va: 0x1000_1000, inModule: null, verified: true },
	{ id: 2, format: 'jpg', tag: 'image', offset: 8192, size: 64, va: 0x1002_0000, inModule: null, verified: true },
	{ id: 3, format: 'ttf', tag: 'font', offset: 12288, size: 4096, va: 0x1003_0000, inModule: null, verified: false }
];

/** A tiny valid PNG's bytes, as the preview's base64 answer. */
const PNG_BASE64 =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function mockDump(): { extracts: DumpExtractRequest[][] } {
	backend.on('dump_open', () => OVERVIEW);
	backend.on('dump_scan', ({ onEvent }) => {
		const channel = onEvent as Channel<DumpEvent>;
		channel.send({ kind: 'progress', scanned: 200_000_000, total: 477_000_000, entries: 1 });
		channel.send({ kind: 'batch', entries: ENTRIES });
		channel.send({ kind: 'done', entries: ENTRIES.length, elapsedMs: 3200, cancelled: false });
		return { modules: OVERVIEW.modules, scanBytes: 477_000_000 };
	});
	backend.on('dump_preview', ({ size }) => ({ data: PNG_BASE64, truncated: false, totalSize: size }));
	const extracts: DumpExtractRequest[][] = [];
	backend.on('dump_extract', ({ entries }) => {
		const list = entries as DumpExtractRequest[];
		extracts.push(list);
		return {
			items: list.map((r) => ({ name: r.name, path: `C:\\out\\${r.name}`, bytes: r.size ?? 0, error: null })),
			outDir: 'C:\\out',
			totalBytes: list.reduce((n, r) => n + (r.size ?? 0), 0)
		};
	});
	backend.on('dump_cancel', () => undefined);
	return { extracts };
}

describe('the dump viewer routing', () => {
	it('a .dmp opens in the dump view, not the hex viewer or the text editor', async () => {
		mockDump();
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		await group.openFile('C:\\dumps\\app.dmp');
		expect(document.querySelector('.dump-view')).not.toBeNull();
		expect(document.querySelector('.hex-view')).toBeNull();
		expect(document.querySelector('.cm-editor')).toBeNull();
		expect(backend.callsTo('dump_open')[0]!.path).toBe('C:\\dumps\\app.dmp');
	});

	it('.mdmp routes the same; other extensions do not', () => {
		expect(isDumpFile('a.dmp')).toBe(true);
		expect(isDumpFile('a.DMP')).toBe(true);
		expect(isDumpFile('a.mdmp')).toBe(true);
		expect(isDumpFile('a.txt')).toBe(false);
		expect(isDumpFile('a.blf')).toBe(false);
		expect(isDumpFile('dmp')).toBe(false);
	});
});

describe('the dump view', () => {
	async function openView(onOpenPath?: (p: string) => void): Promise<DumpView> {
		mockDump();
		const host = document.getElementById('editorGroup')!;
		const view = new DumpView('C:\\dumps\\app.dmp', { onOpenPath });
		host.appendChild(view.root);
		await waitForReady(() => view.root.querySelectorAll('.dump-row').length > 0);
		return view;
	}

	it('the scan streams its entries into the list with names, sizes and offsets', async () => {
		await openView();
		expect(backend.callsTo('dump_scan').length).toBe(1);
		const rows = document.querySelectorAll('.dump-row');
		// the verification gate hides the failed TTF by default
		expect(rows.length).toBe(ENTRIES.length - 1);
		expect(rows[0]!.textContent).toContain('carved_000000.png');
		expect(rows[0]!.textContent).toContain('2.0 KB');
		expect(rows[1]!.textContent).toContain('64.0 KB');
		// the overview strip names the process facts
		expect(document.querySelector('.dump-overview')!.textContent).toContain('x64');
		expect(document.querySelector('.dump-overview')!.textContent).toContain('PID 484088');
		expect(document.querySelector('.dump-overview')!.textContent).toContain('691 memory regions');
	});

	it('the family chips, the format chips, the query and the min size narrow the list', async () => {
		await openView();
		const tag = document.querySelector('.dump-tag-select') as HTMLSelectElement;
		tag.value = 'image';
		tag.dispatchEvent(new Event('change'));
		let names = [...document.querySelectorAll('.dump-name')].map((n) => n.textContent);
		expect(names).toEqual([carvedName(ENTRIES[0]!), carvedName(ENTRIES[2]!)]);
		// the format select narrows within (or instead of) the family
		const format = document.querySelector('.dump-format-select') as HTMLSelectElement;
		expect([...format.options].some((o) => o.value === 'png')).toBe(true);
		format.value = 'jpg';
		format.dispatchEvent(new Event('change'));
		names = [...document.querySelectorAll('.dump-name')].map((n) => n.textContent);
		expect(names).toEqual([carvedName(ENTRIES[2]!)]);
		format.value = '';
		format.dispatchEvent(new Event('change'));
		const min = document.querySelector('.dump-min') as HTMLInputElement;
		min.value = '1000';
		min.dispatchEvent(new Event('input'));
		names = [...document.querySelectorAll('.dump-name')].map((n) => n.textContent);
		expect(names).toEqual([carvedName(ENTRIES[0]!)]);
		min.value = '';
		min.dispatchEvent(new Event('input'));
		tag.value = '';
		tag.dispatchEvent(new Event('change'));
		const query = document.querySelector('.dump-query') as HTMLInputElement;
		query.value = 'app.exe';
		query.dispatchEvent(new Event('input'));
		names = [...document.querySelectorAll('.dump-name')].map((n) => n.textContent);
		expect(names).toEqual([carvedName(ENTRIES[0]!)]);
		query.value = '';
		query.dispatchEvent(new Event('input'));
		// every row carries its own checkbox, and the header carries the select-all
		expect(document.querySelectorAll('.dump-row .dump-check').length).toBe(ENTRIES.length - 1);
		expect(document.querySelector('.dump-check-all')).not.toBeNull();
	});

	it('a row click previews: a PNG renders as an image over a hex head', async () => {
		await openView();
		click(document.querySelectorAll('.dump-row')[0]!);
		await waitForReady(() => document.querySelector('.dump-preview-img') !== null);
		expect(backend.callsTo('dump_preview')[0]).toMatchObject({ offset: 100, size: 2048 });
		expect(document.querySelector('.dump-preview-img')).not.toBeNull();
		expect(document.querySelector('.dump-preview-hex')!.textContent).toContain('89 50 4e 47');
	});

	it('the preview revokes its object URL on replace and dispose', async () => {
		const created: string[] = [];
		const revoked: string[] = [];
		const create = URL.createObjectURL.bind(URL);
		const revoke = URL.revokeObjectURL.bind(URL);
		vi.spyOn(URL, 'createObjectURL').mockImplementation((blob: Blob) => {
			const url = create(blob);
			created.push(url);
			return url;
		});
		vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url: string) => {
			revoked.push(url);
			revoke(url);
		});
		const view = await openView();
		click(document.querySelectorAll('.dump-row')[0]!); // the png
		await waitForReady(() => document.querySelector('.dump-preview-img') !== null);
		expect(created.length).toBe(1);
		click(document.querySelectorAll('.dump-row')[2]!); // the jpg (the zip row is no image)
		await waitForReady(() => (document.querySelector('.dump-preview-title')?.textContent ?? '').includes('.jpg'));
		expect(created.length).toBe(2);
		expect(revoked).toEqual([created[0]]);
		view.dispose();
		expect(revoked).toEqual([created[0], created[1]]);
		vi.restoreAllMocks();
	});

	it('the selection extracts through the scan coordinates into the output folder', async () => {
		const { extracts } = mockDump();
		const host = document.getElementById('editorGroup')!;
		const view = new DumpView('C:\\dumps\\app.dmp');
		host.appendChild(view.root);
		await waitForReady(() => view.root.querySelectorAll('.dump-row').length > 0);
		click(document.querySelectorAll('.dump-row')[0]!);
		await waitForReady(() => document.querySelector('.dump-extract-row .button:not([disabled])') !== null);
		const extract = document.querySelector('.dump-extract-sel') as HTMLButtonElement;
		expect(extract.textContent).toContain('1');
		click(extract);
		await waitForReady(() => extracts.length > 0);
		expect(extracts[0]).toHaveLength(1);
		expect(extracts[0]![0]).toMatchObject({ kind: 'file', format: 'png', name: 'carved_000000.png', offset: 100, size: 2048 });
		const outDir = backend.callsTo('dump_extract')[0]!.outDir;
		expect(String(outDir)).toMatch(/app_extracted$/);
		// Extract All sends every listed entry
		const all = document.querySelector('.dump-extract-all') as HTMLButtonElement;
		click(all);
		await waitForReady(() => extracts.length > 1);
		// Extract All works on the filtered set: the failed TTF stays behind the gate
		expect(extracts[1]!.length).toBe(ENTRIES.length - 1);
	});

	it('checkbox clicks and ctrl+click multi-select without clearing', async () => {
		const { extracts } = mockDump();
		const host = document.getElementById('editorGroup')!;
		const view = new DumpView('C:\\dumps\\app.dmp');
		host.appendChild(view.root);
		await waitForReady(() => view.root.querySelectorAll('.dump-row').length > 0);
		const rows = [...document.querySelectorAll('.dump-row')] as HTMLElement[];
		// a plain click is a single select
		click(rows[0]!);
		await waitForReady(() => view.root.querySelectorAll('.dump-row.dump-row-on').length === 1);
		// a checkbox click adds a second entry without clearing the first
		const box2 = rows[1]!.querySelector('.dump-check') as HTMLInputElement;
		box2.click();
		await waitForReady(() => view.root.querySelectorAll('.dump-row.dump-row-on').length === 2);
		expect(view.root.querySelector('.dump-selected')!.textContent).toContain('2 selected');
		// a plain click resets to one; ctrl+click toggles back to two
		click(rows[2]!);
		await waitForReady(() => view.root.querySelectorAll('.dump-row.dump-row-on').length === 1);
		rows[1]!.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
		await waitForReady(() => view.root.querySelectorAll('.dump-row.dump-row-on').length === 2);
		// the header checkbox selects the whole filtered set
		(document.querySelector('.dump-check-all') as HTMLInputElement).click();
		await waitForReady(() => view.root.querySelectorAll('.dump-row.dump-row-on').length === ENTRIES.length - 1);
		const extract = document.querySelector('.dump-extract-sel') as HTMLButtonElement;
		expect(extract.textContent).toContain(String(ENTRIES.length - 1));
		click(extract);
		await waitForReady(() => extracts.length > 0);
		expect(extracts[0]!.length).toBe(ENTRIES.length - 1);
		// clear empties the selection again
		const clear = document.querySelectorAll('.dump-extract-row .dump-mini')[1] as HTMLButtonElement;
		click(clear);
		await waitForReady(() => view.root.querySelectorAll('.dump-row.dump-row-on').length === 0);
	});

	it('shift+click selects the range from the anchor', async () => {
		mockDump();
		const host = document.getElementById('editorGroup')!;
		const view = new DumpView('C:\\dumps\\app.dmp');
		host.appendChild(view.root);
		await waitForReady(() => view.root.querySelectorAll('.dump-row').length > 0);
		const rows = [...document.querySelectorAll('.dump-row')] as HTMLElement[];
		click(rows[0]!);
		rows[2]!.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
		await waitForReady(() => view.root.querySelectorAll('.dump-row.dump-row-on').length === ENTRIES.length - 1);
	});

	it('Ctrl+A selects every filtered row', async () => {
		mockDump();
		const host = document.getElementById('editorGroup')!;
		const view = new DumpView('C:\\dumps\\app.dmp');
		host.appendChild(view.root);
		await waitForReady(() => view.root.querySelectorAll('.dump-row').length > 0);
		view.root.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true, cancelable: true }));
		await waitForReady(() => view.root.querySelectorAll('.dump-row.dump-row-on').length === ENTRIES.length - 1);
	});

	it('the preview opens an extracted file in the app and in the system app', async () => {
		const opened: string[] = [];
		const view = await openView((p) => opened.push(p));
		click(document.querySelectorAll('.dump-row')[0]!);
		await waitForReady(() => document.querySelector('.dump-preview-img') !== null);
		expect(document.querySelector('.dump-preview-actions')!.hidden).toBe(false);
		const inApp = document.querySelector('.dump-open-app') as HTMLButtonElement;
		click(inApp);
		await waitForReady(() => opened.length > 0);
		expect(opened[0]!).toMatch(/carved_000000\.png$/);
		const external = document.querySelector('.dump-open-ext') as HTMLButtonElement;
		click(external);
		await waitForReady(() => backend.openedPaths.length > 0);
		expect(backend.openedPaths[0]!).toMatch(/carved_000000\.png$/);
	});

	it('the verification filter hides the structurally-failed false positives', async () => {
		const { extracts } = mockDump();
		const host = document.getElementById('editorGroup')!;
		const view = new DumpView('C:\dumps\app.dmp');
		host.appendChild(view.root);
		// the default gate hides the failed TTF: three rows, no failed one among them
		await waitForReady(() => view.root.querySelectorAll('.dump-row').length === ENTRIES.length - 1);
		expect([...document.querySelectorAll('.dump-name')].map((n) => n.textContent)).not.toContain('carved_000003.ttf');
		// switching to all reveals it, dimmed and titled
		const check = document.querySelector('.dump-check-select') as HTMLSelectElement;
		check.value = 'all';
		check.dispatchEvent(new Event('change'));
		await waitForReady(() => view.root.querySelectorAll('.dump-row').length === ENTRIES.length);
		const bad = document.querySelectorAll('.dump-row.dump-row-bad');
		expect(bad.length).toBe(1);
		expect(bad[0]!.textContent).toContain('carved_000003.ttf');
		// failed-only narrows to it
		check.value = 'fail';
		check.dispatchEvent(new Event('change'));
		await waitForReady(() => view.root.querySelectorAll('.dump-row').length === 1);
		expect(document.querySelector('.dump-name')!.textContent).toBe('carved_000003.ttf');
		// and extraction respects the gate: filtered-scope sends only verified entries
		check.value = 'pass';
		check.dispatchEvent(new Event('change'));
		await waitForReady(() => view.root.querySelectorAll('.dump-row').length === ENTRIES.length - 1);
		const all = document.querySelector('.dump-extract-all') as HTMLButtonElement;
		click(all);
		await waitForReady(() => extracts.length > 0);
		expect(extracts[0]!.every((r) => r.format !== 'ttf')).toBe(true);
	});

	it('the Modules tab lists the loaded modules and extracts them as rebuilds', async () => {
		const { extracts } = mockDump();
		const host = document.getElementById('editorGroup')!;
		const view = new DumpView('C:\\dumps\\app.dmp');
		host.appendChild(view.root);
		await waitForReady(() => view.root.querySelectorAll('.dump-row').length > 0);
		click(view.root.querySelector('.dump-toolbar .csv-mode-chip:nth-of-type(2)')!);
		const rows = document.querySelectorAll('.dump-row');
		expect(rows.length).toBe(OVERVIEW.modules.length);
		expect(rows[0]!.textContent).toContain('app.exe');
		expect(rows[0]!.textContent).toContain('module');
		// a module click previews the rebuild card, not an image
		click(rows[1]!);
		await waitForReady(() => document.querySelector('.dump-preview-card') !== null);
		expect(document.querySelector('.dump-preview-card')!.textContent).toContain('a.dll');
		click(document.querySelector('.dump-extract-all')!);
		await waitForReady(() => extracts.length > 0);
		expect(extracts[0]!.every((r) => r.kind === 'module')).toBe(true);
		expect(extracts[0]![0]).toMatchObject({ kind: 'module', name: 'app.exe', base: OVERVIEW.modules[0]!.base });
	});

	it('a failed open shows the banner, not a dead view', async () => {
		backend.on('dump_open', () => {
			throw new Error('not a Windows minidump');
		});
		const host = document.getElementById('editorGroup')!;
		const view = new DumpView('C:\\dumps\\junk.dmp');
		host.appendChild(view.root);
		await waitForReady(() => !view.root.querySelector('.dump-banner')!.hidden);
		expect(document.querySelector('.dump-banner')!.textContent).toContain('not a Windows minidump');
	});

	it('closing the tab mid-scan cancels the backend walk', async () => {
		backend.on('dump_open', () => OVERVIEW);
		backend.on('dump_scan', () => new Promise(() => undefined)); // never resolves
		backend.on('dump_cancel', () => undefined);
		const host = document.getElementById('editorGroup')!;
		const view = new DumpView('C:\\dumps\\app.dmp');
		host.appendChild(view.root);
		await waitForReady(() => backend.callsTo('dump_scan').length === 1);
		view.dispose();
		expect(backend.callsTo('dump_cancel').length).toBe(1);
	});
});

describe('the dump list model', () => {
	it('the pure helpers: names, byte formatting, the filter and the hex head', () => {
		expect(carvedName({ id: 7, format: 'png' })).toBe('carved_000007.png');
		expect(formatBytes(0)).toBe('0 B');
		expect(formatBytes(2048)).toBe('2.0 KB');
		expect(formatBytes(65536)).toBe('64.0 KB');
		expect(formatBytes(3_500_000)).toBe('3.3 MB');
		expect(imageMime('png')).toBe('image/png');
		expect(imageMime('zip')).toBeNull();
		const filtered = filterCarved(ENTRIES, { tag: 'image', format: '', query: '', minSize: 1000, check: 'pass' });
		expect(filtered.map((e) => e.id)).toEqual([0]);
		const searched = filterCarved(ENTRIES, { tag: '', format: '', query: 'APP.EXE', minSize: 0, check: 'pass' });
		expect(searched.map((e) => e.id)).toEqual([0]);
		const head = hexDump(new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]));
		expect(head.split('\n')[0]).toContain('4d 5a 90 00');
		expect(head.split('\n')[0]).toContain('|MZ');
	});
});
