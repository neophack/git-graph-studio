// Opening a text file goes straight to the editable CodeMirror editor: read_file supplies the
// contents, no backend rope document is created, and saving writes through write_file.

import { describe, expect, it } from 'vitest';

import { EditorGroup } from '../src/editor';
import { EditableDocView } from '../src/docEditView';
import { FastView } from '../src/fastView';
import { backend } from './tauriMock';
import { flush, notifications } from './helpers';

const SAMPLE = 'fn main() {\n    println!("hi");\n}\n';

function fileBackend(): void {
	backend.on('read_file', ({ path }) => ({ contents: SAMPLE, binary: false, size: SAMPLE.length, path }));
	backend.on('write_file', () => null);
}

async function openSample(): Promise<EditorGroup> {
	const group = new EditorGroup(document.getElementById('editorGroup')!);
	group.setRoot('C:\\repo');
	await group.openFile('C:\\repo\\src\\main.rs');
	await flush();
	return group;
}

describe('text file editing', () => {
	it('opens text files directly in the editable editor (no fast viewer, no Edit button)', async () => {
		fileBackend();
		backend.on('file_probe', () => ({ size: SAMPLE.length, binary: false }));
		const group = await openSample();
		expect(backend.callsTo('viewer_open')).toHaveLength(0);
		expect(document.querySelector('.fast-view')).toBeNull();
		const view = group.activeView;
		expect(view).not.toBeNull();
		expect(view!.state.readOnly).toBeFalsy();
		expect(view!.state.doc.toString()).toBe(SAMPLE);
		await group.closeAll();
	});

	it('opens a large file in the windowed editable editor — no read-only detour', async () => {
		fileBackend();
		// 100 MB: past the windowed threshold, so the document lives in the backend rope and
		// the webview holds a window of lines — editable all the same.
		const LINES = Array.from({ length: 3_000 }, (_, i) => `line ${i}`);
		backend.on('file_probe', () => ({ size: 100 * 1024 * 1024, binary: false, longLines: false }));
		backend.on('viewer_open', () => ({ docId: 7, lineCount: LINES.length, language: 'log', syntaxName: 'Plain Text', symbols: [] }));
		backend.on('viewer_text', ({ start, end }: { start: number; end: number }) => ({
			startLine: start,
			lineCount: LINES.length,
			lines: LINES.slice(start, Math.min(end + 1, LINES.length))
		}));
		backend.on('viewer_edit', () => ({ lineCount: LINES.length, rehighlightFrom: 0 }));
		backend.on('viewer_close', () => null);
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		group.setRoot('C:\\repo');
		await group.openFile('C:\\repo\\big.log');
		await flush();
		// The editable path never reads the file whole.
		expect(backend.callsTo('read_file')).toHaveLength(0);
		expect(backend.callsTo('viewer_open')).toHaveLength(1);
		expect(document.querySelector('.fast-view')).toBeNull();
		const editor = document.querySelector('.doc-edit');
		expect(editor).not.toBeNull();
		// The window asked for a bounded range of lines, not the document.
		const window = backend.callsTo('viewer_text').at(-1)!;
		expect((window['end'] as number) - (window['start'] as number)).toBeLessThan(500);
		await group.closeAll();
	});

	it('edits a document past the engines\' scroll ceiling — the range scales, no read-only detour', { timeout: 10_000 }, async () => {
		fileBackend();
		// 2,000,000 lines ≈ 38M px: past what the layout engines can natively scroll, where
		// a document-space spacer would strand the tail. The windowed editor's spacer clamps
		// at the ceiling and the scroll range scales instead — the file stays editable end
		// to end.
		const LINES = 2_000_000;
		backend.on('file_probe', () => ({ size: 100 * 1024 * 1024, binary: false, longLines: false }));
		backend.on('viewer_open', () => ({ docId: 7, lineCount: LINES, language: 'log', syntaxName: 'Plain Text', symbols: [] }));
		backend.on('viewer_text', ({ start, end }: { start: number; end: number }) => ({
			startLine: start,
			lineCount: LINES,
			lines: Array.from({ length: Math.max(0, Math.min(end, LINES - 1) - start + 1) }, (_, i) => `line ${start + i}`)
		}));
		backend.on('viewer_edit', () => ({ lineCount: LINES, rehighlightFrom: 0 }));
		backend.on('viewer_close', () => null);
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		group.setRoot('C:\\repo');
		await group.openFile('C:\\repo\\giant.log');
		await flush();
		// The windowed editor took the file — no read-only fast-view fallback.
		expect(document.querySelector('.doc-edit')).not.toBeNull();
		expect(document.querySelector('.fast-view')).toBeNull();
		await new Promise((resolve) => setTimeout(resolve, 150)); // the opening swap settles

		// Drag the scrollbar to its very bottom: the mapped position is the file's end and
		// the window slides there — the last lines are editable, not stranded.
		const scroller = document.querySelector<HTMLElement>('.doc-edit-scroll')!;
		scroller.scrollTop = 32_000_000;
		scroller.dispatchEvent(new Event('scroll'));
		await new Promise((resolve) => setTimeout(resolve, 500));
		const asked = backend.callsTo('viewer_text').at(-1)!['start'] as number;
		expect(asked).toBeGreaterThanOrEqual(LINES - 1200);
		await group.closeAll();
	});

	it('opens an enormous file in the windowed editable editor — the read-only wall is gone', async () => {
		fileBackend();
		// 300 MB: past the 256 MB threshold that once routed the file to the read-only
		// indexed viewer. Size no longer decides: the rope builds in parallel chunks and
		// the windowed editor serves the file editable, end to end.
		const LINES = Array.from({ length: 3_000 }, (_, i) => `line ${i}`);
		backend.on('file_probe', () => ({ size: 300 * 1024 * 1024, binary: false, longLines: false }));
		backend.on('viewer_open', () => ({ docId: 9, lineCount: LINES.length, language: 'log', syntaxName: 'Plain Text', symbols: [] }));
		backend.on('viewer_text', ({ start, end }: { start: number; end: number }) => ({
			startLine: start,
			lineCount: LINES.length,
			lines: LINES.slice(start, Math.min(end + 1, LINES.length))
		}));
		backend.on('viewer_edit', () => ({ lineCount: LINES.length, rehighlightFrom: 0 }));
		backend.on('viewer_close', () => null);
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		group.setRoot('C:\\repo');
		await group.openFile('C:\\repo\\enormous.log');
		await flush();
		expect(backend.callsTo('viewer_open')).toHaveLength(1);
		expect(backend.callsTo('indexed_open')).toHaveLength(0);
		expect(document.querySelector('.doc-edit')).not.toBeNull();
		expect(document.querySelector('.fast-view')).toBeNull();
		await group.closeAll();
	});

	it('routes a minified single-line monster to the indexed viewer, editable through its Edit button', async () => {
		fileBackend();
		// The few enormous lines defeat the line-windowed editor, so the file opens in the
		// indexed view — but the Edit button pays the whole-file cost on demand: the file
		// crosses the IPC once and the full editor takes the tab over.
		const MINIFIED = 'var f=function(){/* one enormous line */};';
		backend.on('read_file', ({ path }) => ({ contents: MINIFIED, binary: false, size: MINIFIED.length, path }));
		backend.on('file_probe', () => ({ size: 40 * 1024 * 1024, binary: false, longLines: true }));
		backend.on('indexed_open', () => ({ docId: 4, lineCount: 12, language: 'txt', syntaxName: 'Plain Text', encoding: 'utf8', eol: 'lf' }));
		backend.on('indexed_lines', ({ start }) => ({ startLine: start as number, lineCount: 12, tokensPending: false, lines: [['minified', []]] }));
		backend.on('indexed_close', () => undefined);
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		group.setRoot('C:\\repo');
		await group.openFile('C:\\repo\\bundle.txt');
		await flush();
		expect(backend.callsTo('indexed_open')).toHaveLength(1);
		expect(document.querySelector('.fast-view')).not.toBeNull();
		const edit = document.querySelector<HTMLButtonElement>('.fast-edit-btn')!;
		expect(edit).not.toBeNull();
		edit.click();
		await flush();
		expect(backend.callsTo('read_file')).toHaveLength(1);
		expect(backend.callsTo('indexed_close')).toHaveLength(1);
		expect(document.querySelector('.fast-view')).toBeNull();
		const view = group.activeView;
		expect(view).not.toBeNull();
		expect(view!.state.doc.toString()).toBe(MINIFIED);
		await group.closeAll();
	});

	it('refuses the Edit swap past what a JavaScript string can hold', async () => {
		fileBackend();
		// 600 MB exceeds V8's 2²⁹-character string ceiling: the swap would throw at the
		// decode, so the button refuses with a notification and the read-only view stays.
		backend.on('file_probe', () => ({ size: 600 * 1024 * 1024, binary: false, longLines: true }));
		backend.on('indexed_open', () => ({ docId: 4, lineCount: 12, language: 'txt', syntaxName: 'Plain Text', encoding: 'utf8', eol: 'lf' }));
		backend.on('indexed_lines', ({ start }) => ({ startLine: start as number, lineCount: 12, tokensPending: false, lines: [['minified', []]] }));
		backend.on('indexed_close', () => undefined);
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		group.setRoot('C:\\repo');
		await group.openFile('C:\\repo\\huge-bundle.txt');
		await flush();
		document.querySelector<HTMLButtonElement>('.fast-edit-btn')!.click();
		await flush();
		expect(backend.callsTo('read_file')).toHaveLength(0);
		expect(document.querySelector('.fast-view')).not.toBeNull();
		expect(notifications().some((n) => n.includes('Too large for the whole-file editor'))).toBe(true);
		await group.closeAll();
	});

	it('adopts the staged open\'s exact line count when the tail lands', async () => {
		fileBackend();
		// The windowed editor opens a huge file on its estimated count; the landing event
		// replaces it and the scroller re-ranges in place.
		const LINES = Array.from({ length: 200 }, (_, i) => `line ${i}`);
		backend.on('file_probe', () => ({ size: 100 * 1024 * 1024, binary: false, longLines: false }));
		backend.on('viewer_open', () => ({ docId: 7, lineCount: 200, language: 'log', syntaxName: 'Plain Text', symbols: [] }));
		backend.on('viewer_text', ({ start, end }: { start: number; end: number }) => ({
			startLine: start,
			lineCount: 200,
			lines: LINES.slice(start, Math.min(end + 1, LINES.length))
		}));
		backend.on('viewer_close', () => null);
		const view = new EditableDocView(document.getElementById('editorGroup')!);
		await view.openFile('C:\\repo\\staged.log');
		await new Promise((resolve) => setTimeout(resolve, 200)); // the opening swap settles
		const spacer = view.root.querySelector<HTMLElement>('.doc-edit-spacer')!;
		const before = Number.parseInt(spacer.style.height, 10);
		backend.emit('studio://viewer-lines', { docId: 7, lineCount: 4_000 });
		await new Promise((resolve) => setTimeout(resolve, 250)); // the relayout's measure lands
		const after = Number.parseInt(spacer.style.height, 10);
		expect(after).toBeGreaterThan(before + 30_000); // 3,800 more lines of height
		view.dispose();
	});

	it('refills the window a fast scrollbar drag ends on, even inside the slide cooldown', { timeout: 10_000 }, async () => {
		fileBackend();
		const LINES = Array.from({ length: 20_000 }, (_, i) => `line ${i}`);
		backend.on('file_probe', () => ({ size: 100 * 1024 * 1024, binary: false, longLines: false }));
		backend.on('viewer_open', () => ({ docId: 5, lineCount: LINES.length, language: 'log', syntaxName: 'Plain Text', symbols: [] }));
		backend.on('viewer_text', ({ start, end }: { start: number; end: number }) => ({
			startLine: start,
			lineCount: LINES.length,
			lines: LINES.slice(start, end + 1)
		}));
		backend.on('viewer_close', () => null);
		const view = new EditableDocView(document.getElementById('editorGroup')!);
		await view.openFile('C:\\repo\\huge.log');
		// Let the opening swap's measure/timeout machinery settle so `swapping` clears.
		await new Promise((resolve) => setTimeout(resolve, 150));

		const scroller = view.root.querySelector<HTMLElement>('.doc-edit-scroll')!;
		// A fast drag: the first scroll event slides the window under the thumb…
		scroller.scrollTop = 1500 * 19;
		scroller.dispatchEvent(new Event('scroll'));
		await flush();
		const slidTo = backend.callsTo('viewer_text').at(-1)!['start'] as number;
		expect(slidTo).toBeGreaterThan(0);
		// …the second lands while the slide cooldown is still running and is rate-limited.
		scroller.scrollTop = 8000 * 19;
		scroller.dispatchEvent(new Event('scroll'));
		// The thumb is released here: no further scroll events ever fire. The deferred
		// check must still slide the window toward where the drag ended — without it the
		// viewport stays parked on the spacer below the old window, blank.
		await new Promise((resolve) => setTimeout(resolve, 450));
		const endedOn = backend.callsTo('viewer_text').at(-1)!['start'] as number;
		expect(endedOn).toBeGreaterThan(slidTo + 1000);
		view.dispose();
	});

	it('undoes windowed edits step by step, rapid presses included', { timeout: 20_000 }, async () => {
		fileBackend();
		// A faithful little backend: lines live in an array, edits splice them, and undo
		// pops the recorded edits and splices the old lines back.
		const LINES = Array.from({ length: 600 }, (_, i) => `line ${i}`);
		let docLines = [...LINES];
		const undoStack: { startLine: number; count: number; lines: string[] }[] = [];
		backend.on('file_probe', () => ({ size: 100 * 1024 * 1024, binary: false, longLines: false }));
		backend.on('viewer_open', () => ({ docId: 1, lineCount: docLines.length, language: 'log', syntaxName: 'Plain Text', symbols: [] }));
		backend.on('viewer_text', ({ start, end }: { start: number; end: number }) => ({
			startLine: start,
			lineCount: docLines.length,
			lines: docLines.slice(start, end + 1)
		}));
		backend.on('viewer_edit', ({ startLine, endLine, text }: { startLine: number; endLine: number; text: string }) => {
			const lines = text === '' ? [] : text.replace(/\n$/, '').split('\n');
			undoStack.push({ startLine, count: endLine - startLine, lines: docLines.slice(startLine, endLine) });
			docLines.splice(startLine, endLine - startLine, ...lines);
			return { lineCount: docLines.length, rehighlightFrom: startLine };
		});
		backend.on('viewer_undo', () => {
			const last = undoStack.pop();
			if (!last) return null;
			docLines.splice(last.startLine, last.lines.length, ...last.lines);
			return { firstLine: last.startLine, lineCount: docLines.length };
		});
		backend.on('viewer_save', () => null);
		backend.on('viewer_close', () => null);
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		group.setRoot('C:\\repo');
		await group.openFile('C:\\repo\\big.log');
		await flush();
		const doc = group.open[0]!.doc!;
		const view = doc.editorView;
		expect(view).not.toBeNull();
		// Wait out the 150ms edit-sync debounce with real time.
		const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 250));
		const editLine = async (line: number, text: string): Promise<void> => {
			const target = view!.state.doc.line(line + 1);
			view!.dispatch({ changes: { from: target.from, to: target.to, insert: text } });
			await settle();
			await flush();
		};
		await editLine(10, 'line 10 EDIT ONE');
		expect(undoStack).toHaveLength(1);
		await editLine(20, 'line 20 EDIT TWO');
		expect(undoStack).toHaveLength(2);

		// Two rapid Ctrl+Z presses without awaiting the first: both steps must land.
		void doc.undo();
		await doc.undo();
		await settle();
		await flush();
		expect(backend.callsTo('viewer_undo')).toHaveLength(2);
		expect(docLines[10]).toBe('line 10');
		expect(docLines[20]).toBe('line 20');
		// The cursor sits on the line the last undo restored (0-based 10 — the stack pops
		// newest first, so the second press restores the first edit), not wherever the
		// double window swap happened to leave it.
		const head = doc.editorView!.state.selection.main.head;
		expect(doc.editorView!.state.doc.lineAt(head).number).toBe(11);
		// A third press finds an empty stack and changes nothing.
		await doc.undo();
		await flush();
		expect(backend.callsTo('viewer_undo')).toHaveLength(3);
		expect(docLines[10]).toBe('line 10');
		// Save the (still dirty) editor so closeAll does not park on a confirmation.
		await group.save(group.open[0]!);
		await group.closeAll();
	});

	it('opens a giant file in the windowed editable editor too — no size wall', async () => {
		fileBackend();
		const LINES = Array.from({ length: 10_000 }, (_, i) => `line ${i}`);
		backend.on('file_probe', () => ({ size: 500 * 1024 * 1024, binary: false, longLines: false }));
		backend.on('viewer_open', () => ({ docId: 1, lineCount: LINES.length, language: '', syntaxName: 'Plain Text', symbols: [] }));
		backend.on('viewer_text', ({ start, end }: { start: number; end: number }) => ({
			startLine: start,
			lineCount: LINES.length,
			lines: LINES.slice(start, end + 1)
		}));
		backend.on('viewer_edit', () => ({ lineCount: LINES.length, rehighlightFrom: 0 }));
		backend.on('viewer_close', () => null);
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		group.setRoot('C:\\repo');
		await group.openFile('C:\\repo\\huge.log');
		await flush();
		expect(backend.callsTo('read_file')).toHaveLength(0);
		expect(backend.callsTo('viewer_open')).toHaveLength(1);
		expect(document.querySelector('.doc-edit')).not.toBeNull();
		// The window asks for a bounded range of lines, never the whole document.
		const windows = backend.callsTo('viewer_text');
		expect(windows.length).toBeGreaterThan(0);
		for (const w of windows) expect((w['end'] as number) - (w['start'] as number)).toBeLessThan(500);
		await group.closeAll();
		expect(backend.callsTo('viewer_close')).toHaveLength(1);
	});

	it('routes a binary file to the hex viewer from the probe alone, without reading it', async () => {
		fileBackend();
		backend.on('file_probe', () => ({ size: 64 * 1024 * 1024, binary: true }));
		backend.on('read_file_chunk', ({ offset }) => ({ size: 64 * 1024 * 1024, base64: offset === 0 ? btoa('\u0000\u0001\u0002') : '' }));
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		group.setRoot('C:\\repo');
		await group.openFile('C:\\repo\\big.bin');
		await flush();
		expect(document.querySelector('.binary-hex')).not.toBeNull();
		// Neither the whole file nor a viewer document was ever requested.
		expect(backend.callsTo('read_file')).toHaveLength(0);
		expect(backend.callsTo('viewer_open')).toHaveLength(0);
		await group.closeAll();
	});

	it('materialises only a window of a huge outline (the read-only fast view)', async () => {
		fileBackend();
		const symbols = Array.from({ length: 20_000 }, (_, i) => ({ kind: 'function', name: `fn_${i}`, line: i }));
		backend.on('viewer_open', () => ({ docId: 1, lineCount: 20_000, language: 'rs', syntaxName: 'Rust' }));
		backend.on('viewer_symbols', () => symbols);
		backend.on('viewer_lines', ({ start, end }: { start: number; end: number }) => ({ startLine: start, lineCount: 20_000, tokensPending: false, lines: Array.from({ length: end - start + 1 }, () => ['fn', []]) }));
		backend.on('viewer_close', () => null);
		// The fast view is the read-only fallback behind the open path; its own virtual
		// outline is exercised directly.
		const view = new FastView(document.getElementById('editorGroup')!);
		await view.openFile('C:\\repo\\huge.rs');
		await flush();
		const items = document.querySelectorAll('.fast-outline-item');
		expect(items.length).toBeGreaterThan(0);
		expect(items.length).toBeLessThan(100);
		// The list keeps the full height so the scrollbar spans every symbol.
		expect(document.querySelector<HTMLElement>('.fast-outline-list')!.style.height).toBe(`${20_000 * 22}px`);
		view.dispose();
	});

	it('marks the tab dirty on edit and saves through write_file', async () => {
		fileBackend();
		const group = await openSample();
		const view = group.activeView!;
		view.dispatch({ changes: { from: 0, to: 0, insert: '// x\n' } });
		expect(group.hasDirtyEditors()).toBe(true);
		await group.save();
		expect(backend.callsTo('write_file')[0]).toMatchObject({ path: 'C:\\repo\\src\\main.rs', contents: '// x\n' + SAMPLE });
		expect(group.hasDirtyEditors()).toBe(false);
		await group.closeAll();
	});
});
