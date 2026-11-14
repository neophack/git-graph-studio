// The typed IPC seam of the Device Tree domain (module 22): the one open command that
// reads the magic and parses either a `.dtb` blob or `.dts`/`.dtsi` source into the
// same node tree — the ggs-dts crate behind the app's cmd_dts adapter. The shapes the
// view renders live here once.
import { invoke } from './core';

/** One property value as the backend read it: a string chunk, a hex cell, a hex byte
 *  run, or a `&label` reference — `kind` says which, `text` spells it. */
export interface DevTreeValue {
	kind: 'str' | 'cell' | 'bytes' | 'ref';
	text: string;
}

export interface DevTreeProperty {
	name: string;
	values: DevTreeValue[];
}

export interface DevTreeNode {
	name: string;
	label: string | null;
	unitAddress: string | null;
	properties: DevTreeProperty[];
	children: DevTreeNode[];
}

export interface DevTreeMemReserve {
	address: number;
	size: number;
}

export interface DevTreeOpenResult {
	/** `"dtb"` the binary read the magic of, `"dts"` the text parse. */
	format: 'dtb' | 'dts';
	bootCpuid: number | null;
	memReserve: DevTreeMemReserve[];
	nodes: number;
	properties: number;
	totalBytes: number;
	root: DevTreeNode;
}

export const devtreeOpen = (path: string) => invoke<DevTreeOpenResult>('devtree_open', { path });
