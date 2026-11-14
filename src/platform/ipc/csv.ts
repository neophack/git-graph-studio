// The typed IPC seam of the Data Table domain (module 20): the sniff-and-stream CSV open,
// the polled count, the windowed rows, the memoized sort, the decimated plot series and
// the document release — the ggs-csv crate behind the app's csv_commands adapters. The
// result shapes the table and the plot share live here once.
import { invoke } from './core';

/** `csv_open`: the table view's session handle over the parsed file, with the shape the
 *  sniff decided from the first kilobytes. */
export interface CsvOpenResult {
	docId: number;
	totalBytes: number;
	/** The sniffed field delimiter, as the one-character string. */
	delimiter: string;
	hasHeader: boolean;
}

/** One column as the walk knows it: its header name (when the file has one and the cell
 *  is not empty — the frontend labels the rest) and whether it is predominantly numeric
 *  (the plot picker's candidates and the header's type mark). */
export interface CsvColumn {
	name: string | null;
	numeric: boolean;
}

export interface CsvCount {
	/** The rows published so far — the scroll range's length while the walk runs. */
	parsed: number;
	done: boolean;
	error: string | null;
	/** The walk's file position and the file's size — the live percentage. */
	bytes?: number;
	totalBytes?: number;
	columns: CsvColumn[];
}

/** One cell as the backend serves it: a parsed number, or the original text. */
export type CsvCellValue = number | string;

/** One row as the table renders it: the row's own place in the file (the "No." column,
 *  whatever sort ordered the view) and its cells. */
export interface CsvRowLine {
	index: number;
	cells: CsvCellValue[];
}

/** The table's sort (a header click). `descending: false` is ascending. */
export interface CsvSort {
	column: number;
	descending: boolean;
}

/** One plotted sample. */
export interface CsvSeriesPoint {
	x: number;
	y: number;
}

/** The numbers a legend chip names for its column, over the plotted range. */
export interface CsvColumnStats {
	count: number;
	min: number;
	max: number;
	avg: number;
}

/** One plotted column: its decimated points and the range's stats. */
export interface CsvSeries {
	column: number;
	name: string | null;
	points: CsvSeriesPoint[];
	stats: CsvColumnStats;
}

export interface CsvSeriesResult {
	xMin: number;
	xMax: number;
	series: CsvSeries[];
}

export const csvOpen = (path: string) => invoke<CsvOpenResult>('csv_open', { path });
export const csvCount = (docId: number) => invoke<CsvCount>('csv_count', { docId });
export const csvRows = (docId: number, start: number, end: number, sort: CsvSort | null) =>
	invoke<CsvRowLine[]>('csv_rows', { docId, start, end, sort });
export const csvSeries = (docId: number, x: number | null, ys: number[], xFrom: number | null, xTo: number | null) =>
	invoke<CsvSeriesResult>('csv_series', { docId, x, ys, xFrom, xTo });
export const csvClose = (docId: number) => invoke<void>('csv_close', { docId });
