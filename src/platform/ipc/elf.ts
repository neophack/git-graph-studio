// The typed IPC seam of the ELF Inspector domain (module 21): the whole-image open
// (header, segments, sections, footprint sums), the windowed symbol table with its
// filter, and the image release — the ggs-elf crate behind the app's cmd_elf adapters.
// The shapes the view renders live here once.
import { invoke } from './core';

export interface ElfSegment {
	/** `LOAD`, `DYNAMIC`, `INTERP`, `GNU_STACK` … */
	kind: string;
	/** `RWX`-style marks. */
	flags: string;
	offset: number;
	vaddr: number;
	fileBytes: number;
	memBytes: number;
}

export interface ElfSection {
	name: string;
	/** `PROGBITS`, `NOBITS`, `SYMTAB` … */
	kind: string;
	addr: number;
	offset: number;
	size: number;
	alloc: boolean;
	write: boolean;
	exec: boolean;
}

export interface ElfSymbolLine {
	name: string;
	value: number;
	size: number;
	/** `func`, `object`. */
	kind: string;
	/** `local`, `global`, `weak`. */
	bind: string;
}

export interface ElfOpenResult {
	docId: number;
	/** 32 or 64 — the ELF class. */
	classBits: number;
	littleEndian: boolean;
	/** `EXEC`, `DYN`, `REL`, `CORE`. */
	fileType: string;
	machineName: string;
	entry: number;
	segments: ElfSegment[];
	sections: ElfSection[];
	/** Every symbol the tables listed — the honest total beside the kept ones. */
	symbolsTotal: number;
	needed: string[];
	/** Allocated, non-writable sections' bytes (the flash-ish footprint). */
	romBytes: number;
	/** Allocated, writable sections' bytes (the RAM footprint). */
	ramBytes: number;
	totalBytes: number;
}

/** One symbol window's answer: the filtered total is the scroll range's length. */
export interface ElfSymbolWindow {
	total: number;
	lines: ElfSymbolLine[];
}

export const elfOpen = (path: string) => invoke<ElfOpenResult>('elf_open', { path });
export const elfSymbols = (docId: number, start: number, end: number, filter: string | null) =>
	invoke<ElfSymbolWindow>('elf_symbols', { docId, start, end, filter });
export const elfClose = (docId: number) => invoke<void>('elf_close', { docId });
