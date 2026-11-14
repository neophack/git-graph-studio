// The Device Tree view: a .dts/.dtsi/.dtb opens straight into the node tree (never the
// text editor), the nodes render with their labels, unit addresses and spelled-out
// property values, the memory reservations ride on top, the search box prunes the tree
// to the matching nodes (ancestors kept), a chevron collapses a subtree, and the Text
// button (source files only) asks the caller for the text swap.

import { afterEach, describe, expect, it } from 'vitest';

import { EditorGroup } from '../src/features/editor';
import { isDevTreeFile } from '../src/platform/fileIcons';
import { DevTreeView } from '../src/features/devtree';
import type { DevTreeNode, DevTreeOpenResult } from '../src/platform/ipc/devtree';
import { backend } from './tauriMock';
import { click, texts } from './helpers';

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

const SOC: DevTreeNode = {
	name: 'soc',
	label: null,
	unitAddress: null,
	properties: [{ name: 'compatible', values: [{ kind: 'str', text: 'acme,soc' }] }],
	children: [
		{
			name: 'serial@101000',
			label: 'uart0',
			unitAddress: '101000',
			properties: [
				{ name: 'compatible', values: [{ kind: 'str', text: 'vendor,ns16550' }] },
				{ name: 'reg', values: [{ kind: 'cell', text: '0x10100000' }, { kind: 'cell', text: '0x00000064' }] },
				{ name: 'clocks', values: [{ kind: 'ref', text: '&clks' }] }
			],
			children: []
		}
	]
};

const DOC: DevTreeOpenResult = {
	format: 'dts',
	bootCpuid: null,
	memReserve: [{ address: 0x80000000, size: 0x1000 }],
	nodes: 4,
	properties: 5,
	totalBytes: 900,
	root: {
		name: '/',
		label: null,
		unitAddress: null,
		properties: [
			{ name: 'model', values: [{ kind: 'str', text: 'Acme Board' }] },
			{ name: '#address-cells', values: [{ kind: 'cell', text: '0x00000002' }] }
		],
		children: [
			{ name: 'chosen', label: null, unitAddress: null, properties: [{ name: 'bootargs', values: [{ kind: 'str', text: 'console=ttyS0' }] }], children: [] },
			SOC
		]
	}
};

function mockDoc(): void {
	backend.on('devtree_open', () => DOC);
}

describe('the device tree routing', () => {
	it('a .dts opens in the tree view, not the text editor', async () => {
		mockDoc();
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		await group.openFile('C:\\fw\\board.dts');
		expect(document.querySelector('.dt-view')).not.toBeNull();
		expect(document.querySelector('.cm-editor')).toBeNull();
		expect(backend.callsTo('devtree_open')[0]!.path).toBe('C:\\fw\\board.dts');
	});

	it('only the device tree extensions route this way', () => {
		expect(isDevTreeFile('a.dts')).toBe(true);
		expect(isDevTreeFile('a.dtsi')).toBe(true);
		expect(isDevTreeFile('a.dtb')).toBe(true);
		expect(isDevTreeFile('a.dts.txt')).toBe(false);
		expect(isDevTreeFile('dts')).toBe(false);
	});
});

describe('the device tree view', () => {
	it('renders the tree: labels, unit addresses, property values, reservations', async () => {
		mockDoc();
		const view = new DevTreeView('C:\\fw\\board.dts');
		document.getElementById('editorGroup')!.appendChild(view.root);
		// Four rows: the root, chosen, soc — and soc's serial, whose subtree is built
		// collapsed (hidden children stay in the DOM).
		await waitForReady(() => view.root.querySelectorAll('.dt-node-row').length === 4);
		// The root row spells `/`; children carry their names.
		const names = texts('.dt-node-row .dt-name');
		expect(names[0]).toBe('/');
		expect(names).toContain('chosen');
		expect(names).toContain('soc');
		// soc's children start collapsed: the serial row is inside a hidden wrapper.
		const hidden = Array.from(view.root.querySelectorAll('.dt-children')).filter((el) => (el as HTMLElement).hidden);
		expect(hidden.length).toBeGreaterThan(0);
		// The reservation pair sits on top.
		expect(view.root.querySelector('.dt-reserve')!.textContent).toContain('0x80000000');
		// The settled chip names the format and the counts.
		await waitForReady(() => view.root.querySelector('.can-live-text')!.textContent!.includes('DTS'));
		view.dispose();
	});

	it('a toggle expands a collapsed subtree and re-collapses it', async () => {
		mockDoc();
		const view = new DevTreeView('C:\\fw\\board.dts');
		document.getElementById('editorGroup')!.appendChild(view.root);
		await waitForReady(() => view.root.querySelectorAll('.dt-node-row').length === 4);
		const toggles = view.root.querySelectorAll('.dt-toggle');
		expect(toggles.length).toBe(2); // chosen has no children
		// The soc toggle is the last one; its hidden wrapper comes unhid.
		const serialWrap = () => {
			const name = Array.from(view.root.querySelectorAll('.dt-node-row .dt-name')).find((n) => n.textContent === 'serial@101000');
			return name?.closest('.dt-children') as HTMLElement;
		};
		expect(serialWrap().hidden).toBe(true);
		click(toggles[toggles.length - 1]!);
		await waitForReady(() => !serialWrap().hidden);
		// The uart row shows its label.
		expect(view.root.querySelector('.dt-label')!.textContent).toContain('uart0');
		// Its properties render with the DTS spellings.
		const props = texts('.dt-prop-name');
		expect(props).toContain('reg');
		expect(view.root.textContent).toContain('"vendor,ns16550"');
		expect(view.root.textContent).toContain('&clks');
		// And it collapses again (the row stays in the DOM, hidden).
		click(view.root.querySelectorAll('.dt-toggle')[view.root.querySelectorAll('.dt-toggle').length - 1]!);
		await waitForReady(() => serialWrap().hidden);
		view.dispose();
	});

	it('the search box prunes the tree to matching nodes and their ancestors', async () => {
		mockDoc();
		const view = new DevTreeView('C:\\fw\\board.dts');
		document.getElementById('editorGroup')!.appendChild(view.root);
		await waitForReady(() => view.root.querySelectorAll('.dt-node-row').length === 4);
		const search = view.root.querySelector('.dbc-search') as HTMLInputElement;
		search.value = 'bootargs';
		search.dispatchEvent(new Event('input', { bubbles: true }));
		await waitForReady(() => texts('.dt-prop-name').every((n) => n === 'bootargs'));
		// The chosen node survived (it owns the match) beside its root ancestor;
		// soc's subtree dropped whole.
		expect(texts('.dt-node-row .dt-name')).toEqual(['/', 'chosen']);
		expect(view.root.querySelectorAll('.dt-node-row').length).toBe(2);
		expect(texts('.dt-prop-value')[0]).toContain('console=ttyS0');
		// A filter matching nothing says so.
		search.value = 'zzz';
		search.dispatchEvent(new Event('input', { bubbles: true }));
		await waitForReady(() => view.root.querySelector('.dbc-capped') !== null);
		view.dispose();
	});

	it('a parse failure lands on the tree and the chip; the Text button swaps', async () => {
		backend.on('devtree_open', () => {
			throw new Error('not a .dtb blob, and not UTF-8 source text');
		});
		let swapped = false;
		const view = new DevTreeView('C:\\fw\\broken.dts', { onEditText: () => (swapped = true) });
		document.getElementById('editorGroup')!.appendChild(view.root);
		await waitForReady(() => view.root.querySelector('.dbc-banner') !== null);
		expect(view.root.querySelector('.dbc-banner')!.textContent).toContain('not UTF-8');
		click(view.root.querySelector('.can-text')!);
		expect(swapped).toBe(true);
		view.dispose();
	});
});
