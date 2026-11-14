// The typed IPC seam of the CAN Database domain (module 13): the whole-database open,
// the frame decode the view's Decode panel runs, and the document release — the
// ggs-dbc crate behind the app's cmd_dbc adapters. The shapes the view renders live
// here once.
import { invoke } from './core';

/** One signal as the database declares it. */
export interface DbcSignal {
	name: string;
	/** The start bit in the DBC's own numbering (LSB for Intel, MSB for Motorola). */
	startBit: number;
	length: number;
	/** `@0` in the file: Intel byte order. */
	littleEndian: boolean;
	signed: boolean;
	scale: number;
	offset: number;
	min: number | null;
	max: number | null;
	unit: string;
	receivers: string[];
	/** `"M"` the multiplexer switch, `"m3"` a member of group 3, null otherwise. */
	multiplex: string | null;
	comment: string | null;
	/** The `VAL_` table: raw value → label, in file order. */
	values: { value: number; label: string }[];
}

/** One frame as the database declares it. */
export interface DbcMessage {
	/** The canonical 11- or 29-bit identifier (any 0x80000000 flag cleared). */
	id: number;
	name: string;
	dlc: number;
	transmitter: string;
	extended: boolean;
	comment: string | null;
	signals: DbcSignal[];
}

export interface DbcOpenResult {
	docId: number;
	version: string;
	nodes: string[];
	messages: DbcMessage[];
}

/** One decoded signal as the Decode panel shows it. */
export interface DbcDecodedSignal {
	name: string;
	/** The unscaled bit pattern, as the wire carries it. */
	raw: number;
	value: number;
	unit: string;
	label: string | null;
}

export const dbcOpen = (path: string) => invoke<DbcOpenResult>('dbc_open', { path });
export const dbcDecode = (docId: number, id: number, dataHex: string) =>
	invoke<DbcDecodedSignal[]>('dbc_decode', { docId, id, dataHex });
export const dbcClose = (docId: number) => invoke<void>('dbc_close', { docId });
