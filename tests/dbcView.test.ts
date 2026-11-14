// The CAN database view: a .dbc opens straight into the message browser (never the
// text editor), the header names the database's shape, a click shows the picked
// frame's signals, the search box narrows the list through the backend's answer, and
// the decode panel sends the id and payload hex to the backend and reads the physical
// values back — with the Text button asking the caller for the text swap.

import { afterEach, describe, expect, it } from 'vitest';

import { EditorGroup } from '../src/features/editor';
import { isDbcFile } from '../src/platform/fileIcons';
import { DbcView } from '../src/features/dbc';
import type { DbcMessage, DbcOpenResult } from '../src/platform/ipc/dbc';
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

const MESSAGES: DbcMessage[] = [
	{
		id: 0x100,
		name: 'EngineData',
		dlc: 8,
		transmitter: 'Engine',
		extended: false,
		comment: 'The engine frame',
		signals: [
			{
				name: 'VehicleSpeed',
				startBit: 24,
				length: 16,
				littleEndian: true,
				signed: false,
				scale: 0.01,
				offset: 0,
				min: 0,
				max: 655.35,
				unit: 'km/h',
				receivers: ['Gateway'],
				multiplex: null,
				comment: null,
				values: [{ value: 0, label: 'Stopped' }]
			},
			{
				name: 'Temperature',
				startBit: 40,
				length: 8,
				littleEndian: true,
				signed: true,
				scale: 1,
				offset: -40,
				min: -40,
				max: 215,
				unit: 'degC',
				receivers: ['Gateway', 'Diag'],
				multiplex: null,
				comment: null,
				values: []
			}
		]
	},
	{ id: 0x1f4, name: 'DiagRequest', dlc: 3, transmitter: 'Diag', extended: false, comment: null, signals: [] },
	{ id: 0x18ff0100, name: 'Status', dlc: 8, transmitter: 'Engine', extended: true, comment: null, signals: [] }
];

const DOC: DbcOpenResult = { docId: 7, version: 'Sample', nodes: ['Engine', 'Gateway', 'Diag'], messages: MESSAGES };

/** The plain backend: the doc opens, the decode answers the two signals. */
function mockDoc(): void {
	backend.on('dbc_open', () => DOC);
	backend.on('dbc_decode', ({ id }) =>
		id === 0x100
			? [
					{ name: 'VehicleSpeed', raw: 12345, value: 123.45, unit: 'km/h', label: null },
					{ name: 'Temperature', raw: -56, value: -96, unit: 'degC', label: null }
				]
			: []
	);
	backend.on('dbc_close', () => undefined);
}

describe('the CAN database routing', () => {
	it('a .dbc opens in the database view, not the text editor or the hex viewer', async () => {
		mockDoc();
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		await group.openFile('C:\\can\\powertrain.dbc');
		expect(document.querySelector('.dbc-view')).not.toBeNull();
		expect(document.querySelector('.cm-editor')).toBeNull();
		expect(document.querySelector('.hex-view')).toBeNull();
		expect(backend.callsTo('dbc_open')[0]!.path).toBe('C:\\can\\powertrain.dbc');
	});

	it('only .dbc routes this way', () => {
		expect(isDbcFile('a.dbc')).toBe(true);
		expect(isDbcFile('a.DBC')).toBe(true);
		expect(isDbcFile('a.asc')).toBe(false);
		expect(isDbcFile('dbc')).toBe(false);
	});
});

describe('the CAN database view', () => {
	it('renders every frame as a row with its hex id, dlc and sender', async () => {
		mockDoc();
		const view = new DbcView('C:\\can\\powertrain.dbc');
		document.getElementById('editorGroup')!.appendChild(view.root);
		await waitForReady(() => texts('.dbc-row .dbc-c-name').length === MESSAGES.length);
		expect(texts('.dbc-row .dbc-name-text')).toEqual(['EngineData', 'DiagRequest', 'Status']);
		expect(texts('.dbc-row .dbc-c-id')).toEqual(['0x100', '0x1F4', '0x18FF0100']);
		expect(texts('.dbc-row .dbc-c-dlc')).toEqual(['8', '3', '8']);
		// The extended frame carries its mark; the standard ones do not.
		expect(view.root.querySelectorAll('.dbc-row .dbc-ext').length).toBe(1);
		// The settled live chip names the frames and the nodes.
		await waitForReady(() => view.root.querySelector('.can-live-text')!.textContent!.includes('3 frames'));
		view.dispose();
		await waitForReady(() => backend.callsTo('dbc_close').length > 0);
		expect(backend.callsTo('dbc_close')[0]!.docId).toBe(7);
	});

	it('a frame click opens the detail pane: signals, comments and the value table label', async () => {
		mockDoc();
		const view = new DbcView('C:\\can\\powertrain.dbc');
		document.getElementById('editorGroup')!.appendChild(view.root);
		await waitForReady(() => texts('.dbc-row .dbc-c-name').length === MESSAGES.length);
		expect(document.querySelector('.dbc-detail-empty')).not.toBeNull();
		click(view.root.querySelectorAll('.dbc-row')[0]!);
		await waitForReady(() => view.root.querySelectorAll('.dbc-sig-row').length === 2);
		expect(texts('.dbc-sig-row .dbc-s-name')).toEqual(['VehicleSpeed', 'Temperature']);
		expect(texts('.dbc-sig-row .dbc-s-order')).toEqual(['Intel', 'Intel']);
		// The scale column spells the offset (`×1 − 40`), the value-table label rides
		// only in the decode output.
		expect(texts('.dbc-sig-row .dbc-s-scale')[1]).toContain('− 40');
		expect(document.querySelector('.dbc-detail .dbc-comment')!.textContent).toContain('engine frame');
		// The decode panel pre-fills the picked frame's id.
		const idInput = view.root.querySelector('.dbc-decode-id') as HTMLInputElement;
		expect(idInput.value).toBe('0x100');
		view.dispose();
	});

	it('the search box narrows the list by name and by hex id', async () => {
		mockDoc();
		const view = new DbcView('C:\\can\\powertrain.dbc');
		document.getElementById('editorGroup')!.appendChild(view.root);
		await waitForReady(() => texts('.dbc-row .dbc-c-name').length === MESSAGES.length);
		const search = view.root.querySelector('.dbc-search') as HTMLInputElement;
		search.value = 'diag';
		search.dispatchEvent(new Event('input', { bubbles: true }));
		await waitForReady(() => texts('.dbc-row .dbc-c-name').length === 1);
		expect(texts('.dbc-row .dbc-name-text')).toEqual(['DiagRequest']);
		// By hex id — with or without the 0x.
		search.value = '18ff';
		search.dispatchEvent(new Event('input', { bubbles: true }));
		await waitForReady(() => texts('.dbc-row .dbc-name-text')[0] === 'Status');
		// A filter that matches nothing says so, and the detail pane resets.
		search.value = 'zzz';
		search.dispatchEvent(new Event('input', { bubbles: true }));
		await waitForReady(() => view.root.querySelector('.dbc-capped') !== null);
		expect(document.querySelector('.dbc-detail-empty')).not.toBeNull();
		view.dispose();
	});

	it('the decode panel sends the id and payload and renders the physical values', async () => {
		mockDoc();
		const view = new DbcView('C:\\can\\powertrain.dbc');
		document.getElementById('editorGroup')!.appendChild(view.root);
		await waitForReady(() => texts('.dbc-row .dbc-c-name').length === MESSAGES.length);
		click(view.root.querySelectorAll('.dbc-row')[0]!);
		await waitForReady(() => view.root.querySelector('.dbc-decode-run') !== null);
		const dataInput = view.root.querySelector('.dbc-decode-data') as HTMLInputElement;
		dataInput.value = '00 01 00 39 30 c8 00 00';
		click(view.root.querySelector('.dbc-decode-run')!);
		await waitForReady(() => view.root.querySelectorAll('.dbc-decode-row').length === 2);
		const sent = backend.callsTo('dbc_decode').at(-1)!;
		expect(sent.id).toBe(0x100);
		expect(sent.dataHex).toBe('00 01 00 39 30 c8 00 00');
		const rows = texts('.dbc-decode-row');
		expect(rows[0]).toContain('VehicleSpeed');
		expect(rows[0]).toContain('123.45');
		expect(rows[0]).toContain('km/h');
		expect(rows[1]).toContain('raw -56');
		// A backend refusal lands on the error line.
		const bad = view.root.querySelectorAll('.dbc-row')[1]!;
		click(bad);
		await waitForReady(() => (view.root.querySelector('.dbc-decode-id') as HTMLInputElement).value === '0x1f4');
		backend.on('dbc_decode', () => {
			throw new Error('no frame with id');
		});
		click(view.root.querySelector('.dbc-decode-run')!);
		await waitForReady(() => view.root.querySelector('.dbc-decode-error') !== null);
		view.dispose();
	});

	it('a parse failure lands on the list and the chip', async () => {
		backend.on('dbc_open', () => {
			throw new Error('no BO_ frames found');
		});
		backend.on('dbc_close', () => undefined);
		const view = new DbcView('C:\\can\\broken.dbc');
		document.getElementById('editorGroup')!.appendChild(view.root);
		await waitForReady(() => view.root.querySelector('.dbc-banner') !== null);
		expect(view.root.querySelector('.dbc-banner')!.textContent).toContain('no BO_ frames found');
		expect(view.root.querySelector('.can-live-text')!.textContent).toContain('failed');
		view.dispose();
	});

	it('the Text button asks the caller for the text swap', async () => {
		mockDoc();
		let swapped = false;
		const view = new DbcView('C:\\can\\powertrain.dbc', { onEditText: () => (swapped = true) });
		document.getElementById('editorGroup')!.appendChild(view.root);
		await waitForReady(() => texts('.dbc-row .dbc-c-name').length === MESSAGES.length);
		click(view.root.querySelector('.can-text')!);
		expect(swapped).toBe(true);
		// Without the option there is no button (a caller with no text form).
		const bare = new DbcView('C:\\can\\powertrain.dbc');
		document.getElementById('editorGroup')!.appendChild(bare.root);
		await waitForReady(() => texts('.dbc-row .dbc-name-text').length === MESSAGES.length);
		expect(bare.root.querySelector('.can-text')).toBeNull();
		bare.dispose();
		view.dispose();
	});
});
