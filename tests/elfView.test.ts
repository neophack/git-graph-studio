// The ELF Inspector: an .elf opens straight into the summary, sections and symbols
// (never the hex viewer), the summary card names the class, machine, entry and the
// rough ROM/RAM split, the mode chips switch the body between the section table and
// the virtual-scroll symbol table, and the search box drives the backend's symbol
// filter — with dispose releasing the backend document.

import { afterEach, describe, expect, it } from 'vitest';

import { isElfImage } from '../src/platform/fileIcons';
import { ElfView } from '../src/features/elf';
import type { ElfOpenResult, ElfSymbolLine, ElfSymbolWindow } from '../src/platform/ipc/elf';
import { backend } from './tauriMock';
import { texts } from './helpers';

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

const DOC: ElfOpenResult = {
	docId: 9,
	classBits: 32,
	littleEndian: true,
	fileType: 'EXEC',
	machineName: 'AArch64',
	entry: 0x8000,
	segments: [
		{ kind: 'LOAD', flags: 'RX', offset: 0x8000, vaddr: 0x8000, fileBytes: 0x1200, memBytes: 0x1200 },
		{ kind: 'LOAD', flags: 'RW', offset: 0x9200, vaddr: 0x20000000, fileBytes: 0x40, memBytes: 0x400 }
	],
	sections: [
		{ name: '.text', kind: 'PROGBITS', addr: 0x8000, offset: 0x8000, size: 0x1000, alloc: true, write: false, exec: true },
		{ name: '.rodata', kind: 'PROGBITS', addr: 0x9000, offset: 0x9000, size: 0x200, alloc: true, write: false, exec: false },
		{ name: '.data', kind: 'PROGBITS', addr: 0x20000000, offset: 0x9200, size: 0x40, alloc: true, write: true, exec: false },
		{ name: '.bss', kind: 'NOBITS', addr: 0x20000040, offset: 0x9240, size: 0x3c0, alloc: true, write: true, exec: false }
	],
	symbolsTotal: 120,
	needed: [],
	romBytes: 0x1200,
	ramBytes: 0x400,
	totalBytes: 0x9500
};

const SYMBOLS: ElfSymbolLine[] = Array.from({ length: 30 }, (_, i) => ({
	name: `func_${String(i).padStart(2, '0')}`,
	value: 0x8000 + i * 0x10,
	size: 30 - i,
	kind: i === 5 ? 'object' : 'func',
	bind: i % 2 === 0 ? 'global' : 'local'
}));

function mockDoc(): ElfSymbolWindow[] {
	const seen: ElfSymbolWindow[] = [];
	backend.on('elf_open', () => DOC);
	backend.on('elf_symbols', ({ start, end, filter }) => {
		const matched = filter
			? SYMBOLS.filter((s) => s.name.toLowerCase().includes(String(filter).toLowerCase()))
			: SYMBOLS;
		const window: ElfSymbolWindow = {
			total: matched.length,
			lines: matched.slice(Number(start), Number(end))
		};
		seen.push(window);
		return window;
	});
	backend.on('elf_close', () => undefined);
	return seen;
}

describe('the ELF routing', () => {
	it('only .elf and .axf route to the inspector', () => {
		expect(isElfImage('fw.elf')).toBe(true);
		expect(isElfImage('app.axf')).toBe(true);
		expect(isElfImage('a.bin')).toBe(false);
		expect(isElfImage('elf')).toBe(false);
	});
});

describe('the ELF Inspector', () => {
	it('opens with the summary card: class, machine, entry, footprints', async () => {
		mockDoc();
		const view = new ElfView('C:\\fw\\app.elf');
		document.getElementById('editorGroup')!.appendChild(view.root);
		await waitForReady(() => view.root.querySelectorAll('.elf-sum-row').length >= 6);
		const values = texts('.elf-view .elf-sum-value');
		expect(values.some((v) => v.includes('32-bit LE'))).toBe(true);
		expect(values.some((v) => v === 'AArch64')).toBe(true);
		expect(values.some((v) => v === '0x8000')).toBe(true);
		expect(view.root.querySelector('.cm-editor')).toBeNull();
		await waitForReady(() => view.root.querySelector('.can-live-text')!.textContent!.includes('4 sections'));
		view.dispose();
		await waitForReady(() => backend.callsTo('elf_close').length > 0);
		expect(backend.callsTo('elf_close')[0]!.docId).toBe(9);
	});

	it('the sections table lists every section with its flags', async () => {
		mockDoc();
		const view = new ElfView('C:\\fw\\app.elf');
		document.getElementById('editorGroup')!.appendChild(view.root);
		await waitForReady(() => view.root.querySelectorAll('.elf-sec-row').length === 4);
		expect(texts('.elf-sec-row .elf-a-name')).toEqual(['.text', '.rodata', '.data', '.bss']);
		const bss = texts('.elf-sec-row .elf-a-flags')[3];
		expect(bss).toContain('W');
		expect(bss).not.toContain('X');
		expect(texts('.elf-sec-row .elf-a-kind')[3]).toBe('NOBITS');
		view.dispose();
	});

	it('the Symbols chip swaps the body and windows the backend table', async () => {
		mockDoc();
		const view = new ElfView('C:\\fw\\app.elf');
		document.getElementById('editorGroup')!.appendChild(view.root);
		await waitForReady(() => view.root.querySelectorAll('.elf-sec-row').length === 4);
		expect(view.root.querySelectorAll('.elf-sym-row').length).toBe(0);
		click(view.root.querySelector('.elf-mode-chip:nth-of-type(2)')!);
		await waitForReady(() => view.scroll.rowCount === 30);
		await waitForReady(() => view.root.querySelectorAll('.elf-sym-row').length > 0);
		// The sections pane hides while the symbols show.
		expect((view.root.querySelector('.elf-sections') as HTMLElement).hidden).toBe(true);
		// The fetch asked for a window, unfiltered.
		const call = backend.callsTo('elf_symbols').at(-1)!;
		expect(call.filter).toBeNull();
		view.dispose();
	});

	it('the search box re-fetches with the filter and the backend total', async () => {
		mockDoc();
		const view = new ElfView('C:\\fw\\app.elf');
		document.getElementById('editorGroup')!.appendChild(view.root);
		await waitForReady(() => view.root.querySelectorAll('.elf-sec-row').length === 4);
		click(view.root.querySelector('.elf-mode-chip:nth-of-type(2)')!);
		await waitForReady(() => view.scroll.rowCount === 30);
		const search = view.root.querySelector('.elf-search') as HTMLInputElement;
		search.value = 'func_2';
		search.dispatchEvent(new Event('input', { bubbles: true }));
		// func_2 itself plus func_20…func_29 — eleven by substring.
		await waitForReady(() => view.scroll.rowCount === 10); // func_20…func_29
		const call = backend.callsTo('elf_symbols').at(-1)!;
		expect(call.filter).toBe('func_2');
		view.dispose();
	});

	it('a parse failure lands on the summary and the chip', async () => {
		backend.on('elf_open', () => {
			throw new Error('not an ELF image');
		});
		backend.on('elf_close', () => undefined);
		const view = new ElfView('C:\\fw\\junk.elf');
		document.getElementById('editorGroup')!.appendChild(view.root);
		await waitForReady(() => view.root.querySelector('.dbc-banner') !== null);
		expect(view.root.querySelector('.dbc-banner')!.textContent).toContain('not an ELF image');
		view.dispose();
	});
});

function click(element: Element): void {
	element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
	element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
	element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}
