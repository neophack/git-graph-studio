// The typed IPC seam of the Memory Dump Viewer domain (module 21): the minidump open
// (header, streams, modules, memory map), the streamed carve scan, the byte preview and
// the extract — the ggs-dmp crate behind the app's dump_commands adapters. The result
// shapes the view shares live here once.
import { invoke, type Channel } from './core';

/** The system row of the open answer (the dump's SystemInfo stream). */
export interface DumpOs {
	arch: string;
	version: string;
	build: number;
	processors: number;
	productType: number;
}

/** One loaded module as the dump's ModuleList records it — a rebuild-PE candidate. */
export interface DumpModule {
	base: number;
	size: number;
	/** The PE header's build stamp. */
	timestamp: number;
	name: string;
	fileName: string;
}

/** One stream in the dump's table of contents. */
export interface DumpStream {
	kind: number;
	name: string;
	size: number;
}

/** `dump_open`: everything the header strip shows, read in one pass. */
export interface DumpOverview {
	path: string;
	size: number;
	/** Unix seconds — the dump's wall-clock stamp. */
	timeDateStamp: number;
	flags: number;
	/** The well-known MiniDump flag bits resolved to names. */
	flagNames: string[];
	os: DumpOs;
	pid: number;
	threads: number;
	/** Whether an Exception stream exists — a crash dump rather than a live capture. */
	hasException: boolean;
	modules: DumpModule[];
	moduleTotalBytes: number;
	memoryRegions: number;
	memoryTotalBytes: number;
	streams: DumpStream[];
}

/** One carved file the scan reported. `offset`/`size` are dump-file coordinates; `va`
 *  is where the bytes lived in the process, and `inModule` names the module image they
 *  sat inside — heap cluster versus a module's static data is the first triage signal. */
export interface CarvedEntry {
	id: number;
	/** The format's extension ("png"). */
	format: string;
	/** The family the list filters by: image, media, archive, doc, db. */
	tag: string;
	offset: number;
	size: number;
	va: number | null;
	inModule: string | null;
}

/** The scan's knobs. `formats` empty scans every supported format. */
export interface DumpScanOptions {
	formats: string[];
	minSize: number;
	maxSize: number;
}

/** The scan's synchronous answer: the module list and how many bytes the carve walks. */
export interface DumpScanStart {
	modules: DumpModule[];
	scanBytes: number;
}

/** The scan's channel events: periodic progress, entries in batches, and one done. */
export type DumpEvent =
	| { kind: 'progress'; scanned: number; total: number; entries: number }
	| { kind: 'batch'; entries: CarvedEntry[] }
	| { kind: 'done'; entries: number; elapsedMs: number; cancelled: boolean };

/** `dump_preview`: up to `maxBytes` of an entry as base64, with its full size. */
export interface DumpPreview {
	data: string;
	truncated: boolean;
	totalSize: number;
}

/** One extract request: a carved file (its dump-file range) or a module (its image
 *  base and size). The frontend sends back what the scan delivered. */
export interface DumpExtractRequest {
	kind: 'file' | 'module';
	format: string;
	name: string;
	offset?: number;
	size?: number;
	base?: number;
	moduleSize?: number;
}

/** One extract item's progress step. */
export interface DumpExtractProgress {
	done: number;
	total: number;
	bytes: number;
	name: string;
}

/** One extract item's answer: where the file landed, or why it failed. */
export interface DumpExtractItem {
	name: string;
	path: string;
	bytes: number;
	error: string | null;
}

/** The extract's final answer: every item, and the directory they landed in. */
export interface DumpExtractResult {
	items: DumpExtractItem[];
	outDir: string;
	totalBytes: number;
}

export const dumpOpen = (path: string) => invoke<DumpOverview>('dump_open', { path });
export const dumpScan = (path: string, options: DumpScanOptions | null, onEvent: Channel<DumpEvent>) =>
	invoke<DumpScanStart>('dump_scan', { path, options, onEvent });
export const dumpPreview = (path: string, offset: number, size: number, maxBytes?: number) =>
	invoke<DumpPreview>('dump_preview', { path, offset, size, maxBytes });
export const dumpExtract = (
	path: string,
	entries: DumpExtractRequest[],
	outDir: string,
	onProgress: Channel<DumpExtractProgress>
) => invoke<DumpExtractResult>('dump_extract', { path, entries, outDir, onProgress });
export const dumpCancel = () => invoke<void>('dump_cancel', {});
