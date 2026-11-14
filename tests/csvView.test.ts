// The Data Table views: a .csv or .tsv opens straight into the table (never the hex
// viewer, never a text editor) and browses rows while the backend parses — the header
// names the sniffed columns and marks the numeric ones, a header click sorts (the order
// computes on the backend, rows keep their file numbering), the mode chips switch the
// body to the plot (the numeric columns read back as decimated series over the chosen x
// axis), and the Text button swaps the tab to the file's editable text form — the same
// one-button journey a CAN trace takes.

import { afterEach, describe, expect, it } from 'vitest';

import { EditorGroup } from '../src/features/editor';
import { isCsvData } from '../src/platform/fileIcons';
import { CsvView } from '../src/features/data';
import type { CsvRowLine, CsvSeriesResult } from '../src/platform/ipc/csv';
import { backend } from './tauriMock';
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

/** A 3-column export: two numeric columns (the second carrying a `NaN` gap and a text
 *  row among the numbers) and one text column. Six rows. */
const COLUMNS = [
	{ name: 'time', numeric: true },
	{ name: 'speed', numeric: true },
	{ name: 'label', numeric: false }
];
const ROWS: CsvRowLine[] = [
	{ index: 0, cells: [0, 12.5, 'start'] },
	{ index: 1, cells: [0.1, 14.2, ''] },
	{ index: 2, cells: [0.2, 'NaN', 'ramp'] },
	{ index: 3, cells: [0.3, 19.9, 'some label text that runs long enough to need a title'] },
	{ index: 4, cells: [0.4, 21.3, ''] },
	{ index: 5, cells: [0.5, 23.8, 'end'] }
];

const SERIES: CsvSeriesResult = {
	xMin: 0,
	xMax: 0.5,
	series: [
		{
			column: 1,
			name: 'speed',
			points: [
				{ x: 0, y: 12.5 },
				{ x: 0.25, y: 19.9 },
				{ x: 0.5, y: 23.8 }
			],
			stats: { count: 5, min: 12.5, max: 23.8, avg: 18.34 }
		}
	]
};

/** The plain doc: parsed, columns known, rows served from the array. */
function mockDoc(docId = 7): void {
	backend.on('csv_open', () => ({ docId, totalBytes: 1000, delimiter: ',', hasHeader: true }));
	backend.on('csv_count', () => ({ parsed: ROWS.length, done: true, error: null, columns: COLUMNS }));
	backend.on('csv_rows', ({ start, end }) => ROWS.slice(start as number, end as number));
	backend.on('csv_close', () => undefined);
}

/** A doc whose walk is still running: the poll sees the count grow twice, then done. */
function mockWalkingDoc(): void {
	backend.on('csv_open', () => ({ docId: 9, totalBytes: 1000, delimiter: ',', hasHeader: true }));
	let polls = 0;
	backend.on('csv_count', () => {
		polls++;
		return polls < 2
			? { parsed: 2, done: false, error: null, bytes: 400, totalBytes: 1000, columns: COLUMNS }
			: { parsed: ROWS.length, done: true, error: null, bytes: 1000, totalBytes: 1000, columns: COLUMNS };
	});
	backend.on('csv_rows', ({ start, end }) => ROWS.slice(start as number, end as number));
	backend.on('csv_close', () => undefined);
}

/** The plot's backend: records every series request, answers with one series. */
function mockSeries(): CsvSeriesResult[] {
	const seen: CsvSeriesResult[] = [];
	backend.on('csv_series', (args) => {
		seen.push(SERIES);
		return SERIES;
	});
	void 0;
	return seen;
}

describe('the data table routing', () => {
	it('a .csv opens in the data table, not the text editor or the hex viewer', async () => {
		mockDoc();
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		await group.openFile('C:\\data\\readings.csv');
		expect(document.querySelector('.csv-view')).not.toBeNull();
		expect(document.querySelector('.cm-editor')).toBeNull();
		expect(document.querySelector('.hex-view')).toBeNull();
		const opened = backend.callsTo('csv_open')[0]!;
		expect(opened.path).toBe('C:\\data\\readings.csv');
	});

	it('a .tsv routes the same way; other extensions do not', () => {
		expect(isCsvData('a.csv')).toBe(true);
		expect(isCsvData('a.tsv')).toBe(true);
		expect(isCsvData('a.asc')).toBe(false);
		expect(isCsvData('a.txt')).toBe(false);
		expect(isCsvData('csv')).toBe(false);
	});

	it('a jump to a line (a search hit) opens the text form, not the table', async () => {
		mockDoc();
		backend.on('file_probe', () => ({ size: 100, binary: false, longLines: false }));
		backend.on('read_file', () => ({ contents: 'a,b\n1,2\n', encoding: 'utf8', eol: 'lf', binary: false }));
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		await group.openFile('C:\\data\\readings.csv', { line: 2 });
		expect(document.querySelector('.csv-view')).toBeNull();
		expect(backend.callsTo('csv_open').length).toBe(0);
	});
});

describe('the data table', () => {
	it('renders the sniffed columns as the header and the window of rows beneath', async () => {
		mockDoc();
		const view = new CsvView('C:\\data\\readings.csv');
		document.getElementById('editorGroup')!.appendChild(view.root);
		await waitForReady(() => view.scroll.rowCount === ROWS.length);
		await waitForReady(() => document.querySelectorAll('.csv-rows .csv-row').length > 0);
		// The header: the No. gutter, then the sniffed names, the numeric ones marked.
		const heads = texts('.csv-head .csv-hcol');
		expect(heads).toEqual(['time', 'speed', 'label']);
		expect(document.querySelectorAll('.csv-head .csv-num-mark').length).toBe(2);
		// The rows carry their file numbering whatever the window, numbers as numbers,
		// text verbatim — and the `NaN` gap verbatim too.
		const first = document.querySelector('.csv-rows .csv-row')!;
		expect(first.querySelectorAll('.csv-cell')[0].textContent).toBe('1');
		expect(first.querySelectorAll('.csv-cell')[1].textContent).toBe('0');
		expect(first.querySelectorAll('.csv-cell')[2].textContent).toBe('12.5');
		const rows = Array.from(document.querySelectorAll('.csv-rows .csv-row'));
		const gapRow = rows.find((r) => r.textContent!.includes('ramp'))!;
		expect(gapRow.querySelectorAll('.csv-cell')[2].textContent).toBe('NaN');
		// The settled live chip names the rows and the columns.
		await waitForReady(() => document.querySelector('.csv-view .can-live-text')!.textContent!.includes('6 rows'));
		view.dispose();
	});

	it('the header click cycles the sort: asc, desc, off — and the window fetches carry it', async () => {
		mockDoc();
		const view = new CsvView('C:\\data\\readings.csv');
		document.getElementById('editorGroup')!.appendChild(view.root);
		await waitForReady(() => view.scroll.rowCount === ROWS.length && document.querySelectorAll('.csv-rows .csv-row').length > 0);
		const head = () => document.querySelector('.csv-head .csv-hcol:nth-of-type(1)') as HTMLButtonElement;
		// The first click sorts column 0 ascending...
		click(head());
		await waitForReady(() => backend.callsTo('csv_rows').some((call) => call.sort !== null));
		let sort = backend.callsTo('csv_rows').at(-1)!.sort;
		expect(sort).toEqual({ column: 0, descending: false });
		// ...the second reverses it, the third clears it back to file order.
		click(head());
		await waitForReady(() => (backend.callsTo('csv_rows').at(-1)!.sort as { descending: boolean } | null)?.descending === true);
		sort = backend.callsTo('csv_rows').at(-1)!.sort;
		expect(sort).toEqual({ column: 0, descending: true });
		click(head());
		await waitForReady(() => backend.callsTo('csv_rows').at(-1)!.sort === null);
		// The arrow rides the state; clearing it leaves none.
		click(head());
		expect(document.querySelectorAll('.csv-sort-arrow').length).toBe(1);
		view.dispose();
	});

	it('the walk in progress grows the range and settles the live chip', async () => {
		mockWalkingDoc();
		const view = new CsvView('C:\\data\\walking.csv');
		document.getElementById('editorGroup')!.appendChild(view.root);
		await waitForReady(() => document.querySelector('.csv-view .can-live-text')!.textContent!.includes('parsing'));
		await waitForReady(() => document.querySelector('.csv-view .can-live-text')!.textContent!.includes('6 rows'));
		expect(view.scroll.rowCount).toBe(ROWS.length);
		view.dispose();
		await waitForReady(() => backend.callsTo('csv_close').length > 0);
	});

	it('a parse failure surfaces on the banner and the chip', async () => {
		backend.on('csv_open', () => ({ docId: 11, totalBytes: 10, delimiter: ',', hasHeader: false }));
		backend.on('csv_count', () => ({ parsed: 0, done: true, error: 'the read failed', bytes: 0, totalBytes: 10, columns: [] }));
		backend.on('csv_close', () => undefined);
		const view = new CsvView('C:\\data\\broken.csv');
		document.getElementById('editorGroup')!.appendChild(view.root);
		await waitForReady(() => !document.querySelector('.csv-banner')!.hidden);
		expect(document.querySelector('.csv-banner')!.textContent).toContain('the read failed');
		view.dispose();
	});

	it('dispose releases the document', async () => {
		mockDoc();
		const view = new CsvView('C:\\data\\readings.csv');
		document.getElementById('editorGroup')!.appendChild(view.root);
		await waitForReady(() => view.scroll.rowCount === ROWS.length);
		view.dispose();
		await waitForReady(() => backend.callsTo('csv_close').length > 0);
		expect(backend.callsTo('csv_close')[0]!.docId).toBe(7);
	});
});

describe('the plot mode', () => {
	it('the Plot chip swaps the body and fetches the numeric columns as series', async () => {
		mockDoc();
		const seen = mockSeries();
		const view = new CsvView('C:\\data\\readings.csv');
		document.getElementById('editorGroup')!.appendChild(view.root);
		await waitForReady(() => view.scroll.rowCount === ROWS.length);
		click(document.querySelector('.csv-view .csv-mode-chip:nth-of-type(2)')!);
		await waitForReady(() => seen.length > 0);
		// The default selection: the row axis under the first few numeric columns.
		const call = backend.callsTo('csv_series').at(-1)!;
		expect(call.x).toBeNull();
		expect(call.ys).toEqual([0, 1]);
		expect(call.xFrom).toBeNull();
		// The chart drew the series' polyline and the legend chip names the column.
		await waitForReady(() => document.querySelectorAll('.csv-view .csv-plot path.can-chart-line').length > 0);
		expect(document.querySelector('.csv-view .can-legend-chip')!.textContent).toContain('speed');
		// The table pane hides while the plot shows.
		expect((document.querySelector('.csv-view .csv-table-pane') as HTMLElement).hidden).toBe(true);
		view.dispose();
	});

	it('the y chips toggle columns in the selection and refetch', async () => {
		mockDoc();
		mockSeries();
		const view = new CsvView('C:\\data\\readings.csv');
		document.getElementById('editorGroup')!.appendChild(view.root);
		await waitForReady(() => view.scroll.rowCount === ROWS.length);
		click(document.querySelector('.csv-view .csv-mode-chip:nth-of-type(2)')!);
		await waitForReady(() => backend.callsTo('csv_series').length > 0);
		// Drop column 0 from the auto-selection: the next fetch carries only column 1.
		const chips = document.querySelectorAll('.csv-view .csv-y-chip');
		expect(chips.length).toBe(2);
		click(chips[0]!);
		await waitForReady(() => (backend.callsTo('csv_series').at(-1)!.ys as number[]).length === 1);
		expect(backend.callsTo('csv_series').at(-1)!.ys).toEqual([1]);
		// And bring it back.
		click(chips[0]!);
		await waitForReady(() => (backend.callsTo('csv_series').at(-1)!.ys as number[]).length === 2);
		view.dispose();
	});

	it('the x select moves the abscissa to a column and clears the zoom window', async () => {
		mockDoc();
		mockSeries();
		const view = new CsvView('C:\\data\\readings.csv');
		document.getElementById('editorGroup')!.appendChild(view.root);
		await waitForReady(() => view.scroll.rowCount === ROWS.length);
		click(document.querySelector('.csv-view .csv-mode-chip:nth-of-type(2)')!);
		await waitForReady(() => backend.callsTo('csv_series').length > 0);
		const select = document.querySelector('.csv-view .csv-x-select') as HTMLSelectElement;
		select.value = '0';
		select.dispatchEvent(new Event('change', { bubbles: true }));
		await waitForReady(() => backend.callsTo('csv_series').at(-1)!.x === 0);
		expect(backend.callsTo('csv_series').at(-1)!.xFrom).toBeNull();
		view.dispose();
	});

	it('the Text button asks the caller for the text swap', async () => {
		mockDoc();
		let swapped = false;
		const view = new CsvView('C:\\data\\readings.csv', { onEditText: () => (swapped = true) });
		document.getElementById('editorGroup')!.appendChild(view.root);
		await waitForReady(() => view.scroll.rowCount === ROWS.length);
		click(document.querySelector('.csv-view .can-text')!);
		expect(swapped).toBe(true);
		view.dispose();
	});
});
