// The CAN log views: a .blf or .asc opens straight into the raw frame view (never the hex
// viewer) and browses frames while the backend parses, its Statistics button opens the
// statistics analysis as its own tab, where the backend's `can_log_stats` result renders
// asynchronously, the bus load follows the toolbar's bitrate, the filter bar narrows the
// tables, an identifier click opens the cycle analysis with its charts, and the convert
// button writes the log out in the other format.

import { afterEach, describe, expect, it } from 'vitest';

import { EditorGroup, isCanLog } from '../src/editor';
import { busLoad, formatCycle, idHex, parseIdFilter, progressText, type CanFrameLine, type CanIntervals, type CanLogStats, type CanProgress } from '../src/canLogView';
import { MAX_SCROLL_PX } from '../src/ui';
import { backend, Channel, dialog } from './tauriMock';
import { click, texts } from './helpers';

// Each test opens its own view; without this they pile up in the shared #editorGroup and
// every query would see the previous test's tables too.
afterEach(() => {
	document.getElementById('editorGroup')!.replaceChildren();
	backend.reset();
});

/** Resolve once `ready` holds (polled), failing the test after `ms`. */
async function waitForReady(ready: () => boolean, ms = 10000): Promise<void> {
	await Promise.race([
		(async (): Promise<void> => {
			while (!ready()) await new Promise((resolve) => setTimeout(resolve, 20));
		})(),
		new Promise((_, reject) => setTimeout(() => reject(new Error('condition not met in time')), ms))
	]);
}

/** The statistics view's root, distinct from the raw view's (both carry `.can-view`). */
const STATS_VIEW = '.can-view:not(.can-raw-view)';

const STATS: CanLogStats = {
	format: 'BLF',
	startTimestampS: 1_760_000_000,
	durationS: 10,
	totalFrames: 3500,
	errorFrames: 2,
	channels: [
		{ channel: 1, frames: 3000, errorFrames: 2, payloadBytes: 24000, busBits: 93600, firstS: 0, lastS: 10 },
		{ channel: 2, frames: 500, errorFrames: 0, payloadBytes: 6000, busBits: 18720, firstS: 0, lastS: 10 }
	],
	messages: [
		{ channel: 1, id: 0x100, extended: false, fd: false, count: 1000, tx: 0, rx: 1000, payloadBytes: 8000, firstS: 0, lastS: 9.99, minCycleS: 0.01, maxCycleS: 0.01, avgCycleS: 0.01 },
		{ channel: 1, id: 0x18ff0001, extended: true, fd: true, count: 500, tx: 100, rx: 400, payloadBytes: 6000, firstS: 0, lastS: 10, minCycleS: 0.02, maxCycleS: 0.02, avgCycleS: 0.02 },
		{ channel: 2, id: 0x200, extended: false, fd: false, count: 500, tx: 0, rx: 500, payloadBytes: 4000, firstS: 0, lastS: 10, minCycleS: 0.02, maxCycleS: 0.02, avgCycleS: 0.02 }
	],
	skippedObjects: 7,
	messagesTruncated: 0
};

const INTERVALS: CanIntervals = {
	channel: 1, id: 0x100, extended: false, fd: false, count: 1000,
	firstS: 0, lastS: 9.99,
	medianCycleS: 0.01, avgCycleS: 0.0101, minCycleS: 0.0095, maxCycleS: 0.0106, stdS: 0.0002,
	missedGaps: 1, missedFrames: 1,
	points: [
		{ tS: 0.01, cycleS: 0.01, missed: false },
		{ tS: 0.02, cycleS: 0.01, missed: false },
		{ tS: 0.04, cycleS: 0.03, missed: true },
		{ tS: 0.05, cycleS: 0.01, missed: false }
	],
	histogram: [
		{ fromS: 0.0095, toS: 0.01, count: 800 },
		{ fromS: 0.01, toS: 0.0105, count: 150 },
		{ fromS: 0.03, toS: 0.0305, count: 1 }
	]
};

const RAW_LINES: CanFrameLine[] = [
	{ tS: 0, channel: 1, id: 0x100, extended: false, fd: false, brs: false, esi: false, remote: false, error: false, tx: false, dlc: 8, dataHex: '17 03 22 01 F1 26 08 08' },
	{ tS: 0.01, channel: 1, id: 0x100, extended: false, fd: false, brs: false, esi: false, remote: false, error: false, tx: false, dlc: 8, dataHex: '17 03 22 01 F1 26 08 08' },
	{ tS: 0.02, channel: 1, id: 0x18ff0001, extended: true, fd: true, brs: true, esi: false, remote: false, error: false, tx: true, dlc: 9, dataHex: 'AA BB CC' },
	{ tS: 0.03, channel: 1, id: 0, extended: false, fd: false, brs: false, esi: false, remote: false, error: true, tx: false, dlc: 0, dataHex: '' }
];

/** Scripts the raw view's commands: an already-complete walk of `RAW_LINES`. */
function mockRawDoc(): void {
	backend.on('can_log_open', () => ({ docId: 7, totalBytes: 1000 }));
	backend.on('can_log_count', () => ({ parsed: RAW_LINES.length, done: true, error: null }));
	backend.on('can_log_frames', ({ start, end }) => RAW_LINES.slice(start as number, end as number));
	backend.on('can_log_close', () => undefined);
}

/** Scripts the statistics commands. */
function mockStats(): void {
	backend.on('can_log_stats', () => STATS);
	backend.on('can_intervals', () => INTERVALS);
	backend.on('convert_can_log', ({ format }) => (format === 'blf' ? 1234 : 5678));
}

/** Opens the stats fixture as its own analysis tab; resolves when the summary has painted. */
async function openStats(file = 'C:\\logs\\drive.blf'): Promise<void> {
	mockStats();
	const group = new EditorGroup(document.getElementById('editorGroup')!);
	group.openCanStats(file);
	await waitForReady(() => document.querySelector(`${STATS_VIEW} .can-summary`) !== null);
}

describe('CAN log views', () => {
	it('recognises the CAN trace extensions', () => {
		expect(isCanLog('log.blf')).toBe(true);
		expect(isCanLog('trace.ASC')).toBe(true);
		expect(isCanLog('readme.asciidoc')).toBe(false);
		expect(isCanLog('run.bat')).toBe(false);
	});

	it('bus load divides the wire bits by the bitrate-time product', () => {
		// 93600 bits over 10 s at 500 kbit/s = 1.872 %.
		expect(busLoad(93600, 10, 500_000)).toBeCloseTo(1.872, 9);
		expect(busLoad(500_000, 1, 500_000)).toBeCloseTo(100, 9);
		expect(busLoad(100, 0, 500_000)).toBe(0);
	});

	it('formats ids and cycles', () => {
		expect(idHex(0x123, false)).toBe('0x123');
		expect(idHex(0x18ff0001, true)).toBe('0x18FF0001');
		expect(formatCycle(0.01)).toContain('ms');
		expect(formatCycle(0)).toBe('—');
	});

	it('parses identifier filters: single ids, 0x prefixes and ranges', () => {
		const one = parseIdFilter('0x100')!;
		expect(one(0x100)).toBe(true);
		expect(one(0x101)).toBe(false);
		const mixed = parseIdFilter('100, 1A0-1FF 300')!;
		expect(mixed(0x100)).toBe(true);
		expect(mixed(0x1a5)).toBe(true);
		expect(mixed(0x1ff)).toBe(true);
		expect(mixed(0x200)).toBe(false);
		expect(mixed(0x300)).toBe(true);
		expect(parseIdFilter('')).toBeNull();
		expect(parseIdFilter('no-hex!')).toBeNull();
	});

	it('progress reports land on the status line while the backend walks the file', () => {
		expect(progressText({ frames: 1_500_000, bytes: 500, totalBytes: 1000 }, 'Parsing')).toBe('Parsing… 50%  ·  1,500,000 frames');
		expect(progressText({ frames: 3, bytes: 0, totalBytes: 0 }, 'Parsing')).toBe('Parsing… 0%  ·  3 frames');
	});

	it('a .blf opens in the raw frame view at once; Statistics opens the analysis in its own tab', async () => {
		let wholeReads = 0;
		backend.on('read_file', () => {
			wholeReads++;
			return { contents: null, binary: true, size: 1000 };
		});
		mockRawDoc();
		mockStats();
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		await group.openFile('C:\\logs\\drive.blf');
		// The raw view paints immediately — the tab is the frames, not a parse placeholder.
		expect(document.querySelector('.can-raw-view')).not.toBeNull();
		expect(document.querySelector('.hex-view')).toBeNull();
		expect(wholeReads).toBe(0);
		const opened = backend.callsTo('can_log_open')[0]!;
		expect(opened.path).toBe('C:\\logs\\drive.blf');
		await waitForReady(() => document.querySelectorAll('.can-raw-rows .can-raw-row').length > 0);
		// The rows are the frames in log order: id, direction, payload.
		const cells = texts('.can-raw-rows .can-raw-row .can-raw-id');
		expect(cells[0]).toBe('0x100');
		expect(texts('.can-raw-rows .can-raw-data')[0]).toBe('17 03 22 01 F1 26 08 08');
		// An extended FD frame and an error frame carry their markers.
		expect(cells[2]).toBe('0x18FF0001x');
		expect(texts('.can-raw-rows .can-raw-type')[2]).toBe('CAN FD BRS');
		expect(texts('.can-raw-rows .can-raw-type')[3]).toBe('Error');
		// The finished walk's count lands on the live chip.
		await waitForReady(() => document.querySelector('.can-raw-view .can-live-text')!.textContent!.includes('4 frames'));
		// The analysis is only started by the Statistics button, and in its own tab.
		expect(backend.callsTo('can_log_stats').length).toBe(0);
		click(document.querySelector('.can-analyze')!);
		await waitForReady(() => document.querySelector(`${STATS_VIEW} .can-summary`) !== null);
		const statsArgs = backend.callsTo('can_log_stats')[0]!;
		expect(statsArgs.path).toBe('C:\\logs\\drive.blf');
		// The parse went over a progress channel wired to the status line: a report sent
		// through it lands there, even after the tables have painted.
		expect(statsArgs.onProgress).toBeInstanceOf(Channel);
		(statsArgs.onProgress as Channel<CanProgress>).send({ frames: 1_234_567, bytes: 250, totalBytes: 1000 });
		expect(document.querySelector(`${STATS_VIEW} .hex-status`)!.textContent).toContain('25%');
		expect(document.querySelector(`${STATS_VIEW} .hex-status`)!.textContent).toContain('1,234,567');
		// The summary carries the headline numbers; the channel row carries the load.
		expect(texts(`${STATS_VIEW} .can-summary .can-summary-value`)).toContain('3,500');
		expect(document.querySelector(`${STATS_VIEW} .can-channels .can-load`)!.textContent).toBe('1.87 %');
		// The identifier table: busiest first, cycle times in CANoe's ms units.
		const ids = texts(`${STATS_VIEW} .can-messages .can-table-row .can-left`);
		expect(ids[0]).toBe('0x100');
		const firstRow = document.querySelectorAll(`${STATS_VIEW} .can-messages .can-table-row`)[0]!;
		expect(firstRow.querySelectorAll('.can-num')[1]!.textContent).toBe('1,000');

		// Switching the bitrate recomputes the load: 93600 bits over 10 s at 1 Mbit/s.
		const select = document.querySelector<HTMLSelectElement>(`${STATS_VIEW} .can-bitrate`)!;
		select.value = '1000000';
		select.dispatchEvent(new Event('change'));
		expect(document.querySelector(`${STATS_VIEW} .can-channels .can-load`)!.textContent).toBe('0.94 %');
	});

	it('a multi-million-frame log scrolls to its last frames, past the engines\' height clamp', async () => {
		// 2,000,000 frames at 20 px a row is 40M px of document; the layout engines clamp
		// element height near 33.5M px, which used to strand every frame past ~1.6M behind a
		// spacer the scrollbar could not move past. The spacer now clamps at the ceiling and
		// the scroll range scales: the scrollbar's bottom is the log's end.
		const FRAMES = 2_000_000;
		const frameAt = (index: number): CanFrameLine => ({
			tS: index * 0.001, channel: 1, id: 0x100, extended: false, fd: false, brs: false, esi: false, remote: false, error: false, tx: false, dlc: 8, dataHex: '17'
		});
		backend.on('can_log_open', () => ({ docId: 9, totalBytes: 1000 }));
		backend.on('can_log_count', () => ({ parsed: FRAMES, done: true, error: null }));
		backend.on('can_log_frames', ({ start, end }) => Array.from({ length: (end as number) - (start as number) }, (_, i) => frameAt((start as number) + i)));
		backend.on('can_log_close', () => undefined);
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		await group.openFile('C:\\logs\\huge.asc');
		await waitForReady(() => document.querySelector('.can-raw-spacer') !== null);
		expect(Number.parseInt(document.querySelector<HTMLElement>('.can-raw-spacer')!.style.height, 10)).toBe(MAX_SCROLL_PX);
		// Drag the scrollbar to its very bottom: the mapped position is the log's end, and
		// the tail frames render — the ones the clamped old spacer kept out of reach.
		const scroller = document.querySelector<HTMLElement>('.can-raw-scroll')!;
		scroller.scrollTop = MAX_SCROLL_PX;
		scroller.dispatchEvent(new Event('scroll'));
		await waitForReady(() => {
			const rows = document.querySelectorAll('.can-raw-rows .can-raw-row');
			return rows.length > 0 && Number((rows[rows.length - 1] as HTMLElement).dataset.frame) >= FRAMES - 50;
		});
		// And they render *in the viewport*, not merely fetched: each row's content offset
		// sits within a viewport-and-overscan band of the scroll position. (A row placed at
		// its bare document offset — the bug this guards against — lands `scrollTop` pixels
		// above the viewport and the pane shows blank.)
		for (const row of Array.from(document.querySelectorAll<HTMLElement>('.can-raw-rows .can-raw-row'))) {
			const top = Number.parseInt(row.style.top, 10);
			expect(top).toBeGreaterThan(MAX_SCROLL_PX - 1000);
			expect(top).toBeLessThan(MAX_SCROLL_PX + 1000);
		}
		await group.closeAll();
	});

	it('keeps a scaled scroll position anchored while the parse keeps growing under it', async () => {
		// Past the engines' height clamp, one scrollbar pixel stands for many document
		// pixels, and that scale is documentHeight / (the scrollbar's own pixel range,
		// pinned at the ceiling). While the walk is still running, `parsed` - and so the
		// estimated documentHeight - keeps growing every poll tick; rebuilding the range
		// from it without re-anchoring used to slide the same scrollTop onto an
		// ever-further-forward document offset, so a drag left mid-parse kept jumping
		// forward on its own. It must stay put until the user actually scrolls again.
		const frameAt = (index: number): CanFrameLine => ({
			tS: index * 0.001, channel: 1, id: 0x100, extended: false, fd: false, brs: false, esi: false, remote: false, error: false, tx: false, dlc: 8, dataHex: '17'
		});
		let parsed = 2_000_000;
		backend.on('can_log_open', () => ({ docId: 11, totalBytes: 1000 }));
		backend.on('can_log_count', () => ({ parsed, done: false, error: null }));
		backend.on('can_log_frames', ({ start, end }) => Array.from({ length: (end as number) - (start as number) }, (_, i) => frameAt((start as number) + i)));
		backend.on('can_log_close', () => undefined);
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		await group.openFile('C:\\logs\\growing.asc');
		await waitForReady(() => Number.parseInt(document.querySelector<HTMLElement>('.can-raw-spacer')?.style.height ?? '', 10) === MAX_SCROLL_PX);

		// Drag to a mid-file position - "page 10" of a log that is still being parsed.
		const scroller = document.querySelector<HTMLElement>('.can-raw-scroll')!;
		scroller.scrollTop = 10_000_000;
		scroller.dispatchEvent(new Event('scroll'));
		const frameOf = (): number | null => {
			const row = document.querySelector<HTMLElement>('.can-raw-rows .can-raw-row');
			return row ? Number(row.dataset.frame) : null;
		};
		await waitForReady(() => (frameOf() ?? 0) > 500_000);
		const before = frameOf();

		// The parse keeps going in the background: the backend now counts twice as many
		// frames, still not done. The scrollbar itself was never touched.
		const pollsBefore = backend.callsTo('can_log_count').length;
		parsed = 4_000_000;
		await waitForReady(() => backend.callsTo('can_log_count').length > pollsBefore, 3000);

		// The visible frame stayed exactly where it was - the range's rescale re-anchored
		// the scrollTop instead of leaving the user's drag to drift under it.
		expect(frameOf()).toBe(before);
		await group.closeAll();
	}, 10000);

	it('Text swaps the frame view for the editable plain text form and closes the log document', async () => {
		const TEXT = 'date 09/14/2026 08:30:00.250\nbase hex timestamps absolute\n';
		backend.on('read_file', () => ({ contents: TEXT, binary: false, size: TEXT.length, encoding: 'utf8', eol: 'lf' }));
		backend.on('file_probe', () => ({ size: TEXT.length, binary: false }));
		mockRawDoc();
		mockStats();
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		await group.openFile('C:\\logs\\trace.asc');
		await waitForReady(() => document.querySelectorAll('.can-raw-rows .can-raw-row').length > 0);
		click(document.querySelector('.can-text')!);
		// The frame view is replaced by the CodeMirror editor holding the raw text; the
		// background walk's document is released with the view.
		await waitForReady(() => document.querySelector('.can-text-wrap .cm-editor') !== null);
		expect(backend.callsTo('can_log_close').length).toBe(1);
		const view = group.activeView;
		expect(view).not.toBeNull();
		expect(view!.state.readOnly).toBeFalsy();
		expect(view!.state.doc.toString()).toBe(TEXT);
		// Frames switches the tab back to the raw frame view, re-opening the document.
		const opensBefore = backend.callsTo('can_log_open').length;
		click(document.querySelector('.can-frames')!);
		await waitForReady(() => document.querySelector('.can-raw-view') !== null);
		expect(backend.callsTo('can_log_open').length).toBe(opensBefore + 1);
		expect(document.querySelector('.cm-editor')).toBeNull();
	});

	it('a search hit opens the log directly in its text form at the line', async () => {
		const TEXT = 'date 09/14/2026 08:30:00.250\nbase hex timestamps absolute\n// the needle\n';
		backend.on('read_file', () => ({ contents: TEXT, binary: false, size: TEXT.length, encoding: 'utf8', eol: 'lf' }));
		backend.on('file_probe', () => ({ size: TEXT.length, binary: false }));
		mockRawDoc();
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		await group.openFile('C:\\logs\\trace.asc', { line: 3 });
		// The text form is where the hit's line exists: no raw frame view, no background walk.
		await waitForReady(() => document.querySelector('.can-text-wrap .cm-editor') !== null);
		expect(document.querySelector('.can-raw-view')).toBeNull();
		expect(backend.callsTo('can_log_open')).toHaveLength(0);
		const view = group.activeView!;
		expect(view.state.readOnly).toBeFalsy();
		expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(3);
		// Frames switches back to the raw frame view, exactly like the Text button's form.
		click(document.querySelector('.can-frames')!);
		await waitForReady(() => document.querySelector('.can-raw-view') !== null);
	});

	it('a search hit on an open raw tab swaps it to the text form and reveals the line', async () => {
		const TEXT = 'date 09/14/2026\nbase hex\n// the needle\n';
		backend.on('read_file', () => ({ contents: TEXT, binary: false, size: TEXT.length, encoding: 'utf8', eol: 'lf' }));
		backend.on('file_probe', () => ({ size: TEXT.length, binary: false }));
		mockRawDoc();
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		await group.openFile('C:\\logs\\trace.asc');
		await waitForReady(() => document.querySelectorAll('.can-raw-rows .can-raw-row').length > 0);
		await group.openFile('C:\\logs\\trace.asc', { line: 3 });
		await waitForReady(() => document.querySelector('.can-text-wrap .cm-editor') !== null);
		const view = group.activeView!;
		expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(3);
	});

	it('Text on a large log opens the editable editor, not the read-only viewer', async () => {
		const TEXT = 'date 09/14/2026\n' + '   0.000001 1  100  Rx   d 1 00\n'.repeat(200);
		backend.on('read_file', () => ({ contents: TEXT, binary: false, size: 100 * 1024 * 1024, encoding: 'utf8', eol: 'lf' }));
		backend.on('file_probe', () => ({ size: 100 * 1024 * 1024, binary: false, longLines: false }));
		backend.on('viewer_open', () => ({ docId: 9, lineCount: 201, language: '', syntaxName: 'Plain Text', symbols: [] }));
		backend.on('viewer_text', ({ start, end }: { start: number; end: number }) => ({
			startLine: start,
			lineCount: 201,
			lines: TEXT.split('\n').slice(start, end + 1)
		}));
		backend.on('viewer_edit', () => ({ lineCount: 201, rehighlightFrom: 0 }));
		backend.on('viewer_close', () => null);
		mockRawDoc();
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		await group.openFile('C:\\logs\\big.asc');
		await waitForReady(() => document.querySelectorAll('.can-raw-rows .can-raw-row').length > 0);
		click(document.querySelector('.can-text')!);
		// 100 MB is large but editable by default — the windowed editor, no read-only detour.
		await waitForReady(() => document.querySelector('.can-text-wrap .doc-edit') !== null);
		expect(document.querySelector('.fast-view')).toBeNull();
		expect(backend.callsTo('viewer_open').length).toBeGreaterThan(0);
	});

	it('Text on a giant log keeps the Frames bar above the windowed editable editor', async () => {
		backend.on('file_probe', () => ({ size: 500 * 1024 * 1024, binary: false, longLines: false }));
		const LINES = Array.from({ length: 100 }, (_, i) => `   0.00000${i % 10} 1  100  Rx   d 1 0${i % 10}`);
		backend.on('viewer_open', () => ({ docId: 3, lineCount: LINES.length, language: '', syntaxName: 'Plain Text', symbols: [] }));
		backend.on('viewer_text', ({ start, end }: { start: number; end: number }) => ({
			startLine: start,
			lineCount: LINES.length,
			lines: LINES.slice(start, end + 1)
		}));
		backend.on('viewer_edit', () => ({ lineCount: LINES.length, rehighlightFrom: 0 }));
		backend.on('viewer_close', () => null);
		mockRawDoc();
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		await group.openFile('C:\\logs\\huge.asc');
		await waitForReady(() => document.querySelectorAll('.can-raw-rows .can-raw-row').length > 0);
		click(document.querySelector('.can-text')!);
		// The windowed editor and the Frames bar share one wrapper — the editor positions
		// itself absolutely and would otherwise cover the bar (the 13 GB case).
		await waitForReady(() => document.querySelector('.can-text-wrap .doc-edit') !== null);
		const wrap = document.querySelector('.can-text-wrap')!;
		expect(wrap.querySelector('.can-text-bar .can-frames')).not.toBeNull();
		expect(backend.callsTo('read_file')).toHaveLength(0);
		// Frames returns to the raw frame view and releases the viewer's document.
		const closesBefore = backend.callsTo('viewer_close').length;
		click(wrap.querySelector('.can-frames')!);
		await waitForReady(() => document.querySelector('.can-raw-view') !== null);
		expect(backend.callsTo('viewer_close').length).toBeGreaterThan(closesBefore);
	});

	it('the filter bar narrows the tables to the chosen ids and channel', async () => {
		await openStats('C:\\logs\\filter.blf');
		// The identifier column of each row (the first .can-left; the type column is one too).
		const idsOf = (): string[] => Array.from(document.querySelectorAll(`${STATS_VIEW} .can-messages .can-table-row`)).map((r) => r.querySelector('.can-left')!.textContent!);
		// All three identifiers before any filter.
		expect(document.querySelectorAll(`${STATS_VIEW} .can-messages .can-table-row`).length).toBe(3);
		expect(texts(`${STATS_VIEW} .can-summary .can-summary-value`)).toContain('3,500');

		// Only ids in 0x100-0x2FF: 0x100 and 0x200 remain, 0x18FF0001 is gone.
		const filter = document.querySelector<HTMLInputElement>(`${STATS_VIEW} .can-filter`)!;
		filter.value = '100-2FF';
		filter.dispatchEvent(new Event('input'));
		expect(document.querySelectorAll(`${STATS_VIEW} .can-messages .can-table-row`).length).toBe(2);
		expect(idsOf()).toEqual(['0x100', '0x200']);
		// The summary follows the filtered channels, not the whole log.
		expect(texts(`${STATS_VIEW} .can-summary .can-summary-value`)).toContain('3,500');

		// The channel select narrows to channel 2: only 0x200 remains.
		const channel = document.querySelector<HTMLSelectElement>(`${STATS_VIEW} .can-channel`)!;
		channel.value = '2';
		channel.dispatchEvent(new Event('change'));
		expect(idsOf()).toEqual(['0x200']);
		expect(texts(`${STATS_VIEW} .can-summary .can-summary-value`)).toContain('500');

		// A filter nothing matches says so instead of an empty table.
		filter.value = 'fff';
		filter.dispatchEvent(new Event('input'));
		expect(document.querySelector(`${STATS_VIEW} .can-messages .can-empty`)!.textContent).toContain('No identifiers match');
	});

	it('clicking an identifier opens the cycle analysis with its charts and lost frames', async () => {
		await openStats('C:\\logs\\analysis.blf');
		click(document.querySelector(`${STATS_VIEW} .can-messages .can-table-row`));
		await waitForReady(() => document.querySelector('.can-analysis .can-chart') !== null);
		const asked = backend.callsTo('can_intervals')[0]!;
		expect(asked.path).toBe('C:\\logs\\analysis.blf');
		expect(asked.channel).toBe(1);
		expect(asked.id).toBe(256);
		expect(asked.extended).toBe(false);
		// The panel reports the cycle and the frame loss.
		expect(document.querySelector('.can-analysis-title')!.textContent).toContain('0x100');
		expect(document.querySelector('.can-analysis-missed')!.textContent).toContain('1 frame lost in 1 gap');
		const values = texts('.can-analysis .can-summary-value');
		expect(values.some((v) => v.includes('ms'))).toBe(true);
		// Two charts: the cycle series (with the missed point marked) and the histogram.
		const charts = document.querySelectorAll('.can-analysis svg.can-chart');
		expect(charts.length).toBe(2);
		expect(charts[0]!.querySelectorAll('circle.can-chart-missed').length).toBe(1);
		expect(charts[0]!.querySelector('path.can-chart-line')).not.toBeNull();
		expect(charts[1]!.querySelectorAll('rect.can-chart-bar').length).toBeGreaterThan(0);

		// Close dismisses the panel.
		click(document.querySelector('.can-analysis-close'));
		expect(document.querySelector('.can-analysis')).toBeNull();
	});

	it('the convert button writes the log out in the chosen format', async () => {
		await openStats('C:\\logs\\drive.blf');
		dialog.save.mockImplementation(async () => {
			backend.dialog.saveResult = 'C:\\logs\\drive.asc';
			return backend.dialog.saveResult;
		});
		click(document.querySelector(`${STATS_VIEW} .can-convert`));
		// The format quick input: pick the first choice (the other format, ASC for a BLF).
		await waitForReady(() => document.querySelector('.quick-input .row') !== null);
		click(document.querySelector('.quick-input .row'));
		await waitForReady(() => backend.callsTo('convert_can_log').length === 1);
		const converted = backend.callsTo('convert_can_log')[0]!;
		expect(converted.from).toBe('C:\\logs\\drive.blf');
		expect(converted.to).toBe('C:\\logs\\drive.asc');
		expect(converted.format).toBe('asc');
		await waitForReady(() => document.querySelector(`${STATS_VIEW} .hex-status`)!.textContent!.includes('Exported 5,678 frames'));
	});

	it('a log with more identifiers than the response cap notes it instead of flooding the table', async () => {
		backend.on('can_log_stats', () => ({ ...STATS, messages: STATS.messages.slice(0, 1), messagesTruncated: 12_345 }));
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		group.openCanStats('C:\\logs\\huge.blf');
		await waitForReady(() => document.querySelector(`${STATS_VIEW} .can-summary`) !== null);
		expect(document.querySelectorAll(`${STATS_VIEW} .can-messages .can-table-row`).length).toBe(1);
		expect(document.querySelector(`${STATS_VIEW} .hex-status`)!.textContent).toContain('top 1 of 12,346 identifiers shown');
	});

	it('an .asc opens the same analysis', async () => {
		await openStats('C:\\logs\\trace.asc');
		expect(backend.callsTo('can_log_stats').at(-1)!.path).toBe('C:\\logs\\trace.asc');
	});

	it('a parse failure shows the error instead of an empty table', async () => {
		backend.on('can_log_stats', () => {
			throw new Error('not a BLF file (missing LOGG signature)');
		});
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		group.openCanStats('C:\\logs\\broken.blf');
		await waitForReady(() => document.querySelector(`${STATS_VIEW} .can-error`) !== null);
		expect(document.querySelector(`${STATS_VIEW} .can-error`)!.textContent).toContain('missing LOGG signature');
	});

	it('drops the "Parsing the log…" placeholder once the statistics land', async () => {
		await openStats('C:\\logs\\drive.blf');
		expect(document.querySelector(`${STATS_VIEW} .can-loading`)).toBeNull();
	});

	it('a re-render while the analysis loads cancels it: panel and row selection go together', async () => {
		await openStats('C:\\logs\\analysis.blf');
		let release!: (intervals: CanIntervals) => void;
		backend.on('can_intervals', () => new Promise<CanIntervals>((resolve) => { release = resolve; }));
		click(document.querySelector(`${STATS_VIEW} .can-messages .can-table-row`));
		await waitForReady(() => document.querySelector('.can-analysis .can-loading') !== null);

		// Typing in the filter box re-renders the tables underneath the in-flight analysis.
		const filter = document.querySelector<HTMLInputElement>(`${STATS_VIEW} .can-filter`)!;
		filter.value = '100';
		filter.dispatchEvent(new Event('input'));
		expect(document.querySelector('.can-analysis')).toBeNull();
		expect(document.querySelector('.can-selected')).toBeNull();

		// The late answer is dropped, not painted into the detached panel.
		release(INTERVALS);
		await waitForReady(() => backend.callsTo('can_intervals').length === 1);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(document.querySelector('.can-analysis')).toBeNull();
	});

	it('the analysis charts label their axes in the units the data carries', async () => {
		await openStats('C:\\logs\\axis.blf');
		backend.on('can_intervals', () => ({
			...INTERVALS,
			points: [{ tS: 0.01, cycleS: 0.01, missed: false }, { tS: 0.02, cycleS: 0.01, missed: false }],
			histogram: [{ fromS: 0.0095, toS: 0.01, count: 800 }, { fromS: 0.01, toS: 0.0105, count: 150 }]
		}));
		click(document.querySelector(`${STATS_VIEW} .can-messages .can-table-row`));
		await waitForReady(() => document.querySelectorAll('.can-analysis svg.can-chart').length === 2);
		const [series, histogram] = Array.from(document.querySelectorAll('.can-analysis svg.can-chart'));
		const tickTexts = (svg: Element): (string | null)[] => Array.from(svg.querySelectorAll('text')).map((t) => t.textContent);
		// The series' y is cycle time: a 0.01 s cycle shows as a 10 ms tick, the unit named.
		expect(tickTexts(series!)).toContain('10');
		expect(tickTexts(series!)).toContain('ms');
		// The histogram's y is a frame count (ticks, no unit); its x is the cycle in ms.
		expect(tickTexts(histogram!)).toContain('500');
		expect(Array.from(histogram!.querySelectorAll('text')).every((t) => t.getAttribute('x') !== '4')).toBe(true);
		expect(tickTexts(histogram!).some((t) => t !== null && t.endsWith('ms'))).toBe(true);
	});
});
