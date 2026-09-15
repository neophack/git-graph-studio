// The windowed editable editor (src/docEditView.ts) against a faithful backend document
// (tests/ropeDocMock.ts): after every edit the text the backend holds must equal what the
// editor shows, at the file's end included — the place where a lost or doubled newline
// silently shifts every later edit onto the wrong line.

import { describe, expect, it } from 'vitest';

import { EditorGroup } from '../src/editor';
import type { EditableDocView } from '../src/docEditView';
import { backend } from './tauriMock';
import { flush, notifications } from './helpers';
import { RopeDocMock } from './ropeDocMock';

/** Wait out the 150 ms edit-sync debounce with real time, then let the queue drain. */
async function settle(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 250));
	await flush();
}

async function openWindowed(text: string): Promise<{ group: EditorGroup; doc: EditableDocView; rope: RopeDocMock }> {
	const rope = new RopeDocMock(text);
	rope.install();
	const group = new EditorGroup(document.getElementById('editorGroup')!);
	group.setRoot('C:\\repo');
	await group.openFile('C:\\repo\\big.log');
	await flush();
	const doc = group.open[0]!.doc!;
	expect(doc, 'the file opened in the windowed editor').toBeDefined();
	return { group, doc, rope };
}

/** Apply a CodeMirror change to the window and let it sync to the backend. */
async function edit(doc: EditableDocView, from: number, to: number, insert: string): Promise<void> {
	doc.editorView!.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length } });
	await settle();
}

/** The whole-window text as the editor shows it. */
function shown(doc: EditableDocView): string {
	return doc.editorView!.state.doc.toString();
}

describe('windowed editor keeps the backend document in step', () => {
	const SMALL = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n') + '\n';

	it('appends lines after the end of the file', async () => {
		const { group, doc, rope } = await openWindowed(SMALL);
		expect(shown(doc)).toBe(SMALL);
		// Enter on the trailing empty line, then type on the new line — two syncs.
		await edit(doc, SMALL.length, SMALL.length, '\n');
		expect(rope.text).toBe(SMALL + '\n');
		await edit(doc, SMALL.length + 1, SMALL.length + 1, 'appended');
		expect(rope.text).toBe(SMALL + '\nappended');
		expect(rope.text).toBe(shown(doc));
		await group.save(group.open[0]!);
		expect(rope.saved).toBe(SMALL + '\nappended');
		await group.closeAll();
	});

	it('deletes the last lines of the file, trailing newline included', async () => {
		const { group, doc, rope } = await openWindowed(SMALL);
		// Backspace on the final empty line: the file loses its trailing newline.
		await edit(doc, SMALL.length - 1, SMALL.length, '');
		expect(rope.text).toBe(SMALL.slice(0, -1));
		expect(rope.text).toBe(shown(doc));
		// Then cut the last three lines away entirely.
		const cut = shown(doc).lastIndexOf('line 17') - 1;
		await edit(doc, cut, shown(doc).length, '');
		expect(rope.text).toBe(shown(doc));
		expect(rope.lines().at(-1)).toBe('line 16');
		await group.save(group.open[0]!);
		await group.closeAll();
	});

	it('retypes the last line of a file with no trailing newline', async () => {
		const text = 'alpha\nbeta\ngamma';
		const { group, doc, rope } = await openWindowed(text);
		const last = shown(doc).lastIndexOf('gamma');
		await edit(doc, last, last + 'gamma'.length, 'GAMMA');
		expect(rope.text).toBe('alpha\nbeta\nGAMMA');
		// And the very first line, the other boundary.
		await edit(doc, 0, 'alpha'.length, 'ALPHA');
		expect(rope.text).toBe('ALPHA\nbeta\nGAMMA');
		// Replace everything at once (Select All, type).
		await edit(doc, 0, shown(doc).length, 'one\ntwo\n');
		expect(rope.text).toBe('one\ntwo\n');
		expect(rope.text).toBe(shown(doc));
		await group.save(group.open[0]!);
		await group.closeAll();
	});

	it('lands edits in a slid window on the right absolute lines', async () => {
		const LINES = Array.from({ length: 3_000 }, (_, i) => `line ${i}`);
		const text = LINES.join('\n') + '\n';
		const { group, doc, rope } = await openWindowed(text);
		// Jump deep into the file: the window slides so the line is inside it.
		await doc.revealLine(2_500);
		await flush();
		const window = backend.callsTo('viewer_text').at(-1)!;
		const first = window['start'] as number;
		expect(first).toBeLessThanOrEqual(2_500);
		expect(window['end']).toBeGreaterThanOrEqual(2_500);
		expect(doc.status().line).toBe(2_501);
		// Edit a line in the middle of the window and the window's very last line: the
		// line below the window must survive both (the trailing newline is re-joined).
		const view = doc.editorView!;
		const mid = view.state.doc.line(2_500 - first + 1);
		await edit(doc, mid.from, mid.to, 'line 2500 EDITED');
		expect(rope.lines()[2_500]).toBe('line 2500 EDITED');
		const lastInWindow = view.state.doc.line(view.state.doc.lines);
		const absolute = first + view.state.doc.lines - 1;
		await edit(doc, lastInWindow.from, lastInWindow.to, 'WINDOW END');
		expect(rope.lines()[absolute]).toBe('WINDOW END');
		expect(rope.lines()[absolute + 1]).toBe(`line ${absolute + 1}`);
		expect(rope.lineCount()).toBe(LINES.length + 1);
		// Now the file's end: Enter after the last line and type — through a slid window.
		await doc.revealLine(LINES.length);
		await flush();
		const end = doc.editorView!.state.doc.length;
		await edit(doc, end, end, '\ntail');
		expect(rope.text.endsWith('line 2999\n\ntail')).toBe(true);
		expect(rope.lineCount()).toBe(LINES.length + 2);
		await group.save(group.open[0]!);
		await group.closeAll();
	});

	it('opens a large file at a line beyond the first window', async () => {
		const LINES = Array.from({ length: 3_000 }, (_, i) => `line ${i}`);
		const rope = new RopeDocMock(LINES.join('\n') + '\n');
		rope.install();
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		group.setRoot('C:\\repo');
		// A search hit, a go-to-line: the open's own window swap must not swallow the reveal.
		await group.openFile('C:\\repo\\big.log', { line: 2_000, column: 3 });
		await flush();
		await settle();
		const doc = group.open[0]!.doc!;
		expect(doc.status()).toMatchObject({ line: 2_000, column: 3 });
		const window = backend.callsTo('viewer_text').at(-1)!;
		expect(window['start']).toBeLessThanOrEqual(1_999);
		expect(window['end']).toBeGreaterThanOrEqual(1_999);
		// The open did not dirty the document nor claim it was touched.
		expect(group.open[0]!.dirty).toBe(false);
		expect(backend.callsTo('viewer_edit')).toHaveLength(0);
		await group.closeAll();
	});

	it('resends the whole window after a failed edit without merging lines', async () => {
		const LINES = Array.from({ length: 1_200 }, (_, i) => `line ${i}`);
		const { group, doc, rope } = await openWindowed(LINES.join('\n') + '\n');
		rope.failNextEdit = true;
		const view = doc.editorView!;
		// Line 4 sits at the first window's top edge: the follow-the-cursor slide has nowhere
		// to go, and must not refetch the window over the text the backend just refused.
		const target = view.state.doc.line(5);
		await edit(doc, target.from, target.to, 'line 4 RETRIED');
		// The failure is reported and the rescheduled resync then lands the edit intact.
		expect(notifications().some((n) => n.includes('edit failed'))).toBe(true);
		await settle();
		await settle();
		expect(rope.lines()[4]).toBe('line 4 RETRIED');
		// The window's last line and the first line beyond it are still separate lines.
		expect(rope.lines()[499]).toBe('line 499');
		expect(rope.lines()[500]).toBe('line 500');
		expect(rope.lineCount()).toBe(LINES.length + 1);
		await group.save(group.open[0]!);
		await group.closeAll();
	});

	it('undoes and redoes through the backend history and re-windows on the change', async () => {
		const { group, doc, rope } = await openWindowed(SMALL);
		const view = doc.editorView!;
		const line = view.state.doc.line(8);
		await edit(doc, line.from, line.to, 'line 7 CHANGED');
		expect(rope.lines()[7]).toBe('line 7 CHANGED');
		await doc.undo();
		await flush();
		expect(rope.text).toBe(SMALL);
		expect(shown(doc)).toBe(SMALL);
		expect(doc.status().line).toBe(8);
		await doc.redo();
		await flush();
		expect(rope.lines()[7]).toBe('line 7 CHANGED');
		expect(shown(doc)).toBe(rope.text);
		// Nothing left to redo: the window is untouched.
		const before = backend.callsTo('viewer_text').length;
		await doc.redo();
		await flush();
		expect(backend.callsTo('viewer_text')).toHaveLength(before);
		await group.save(group.open[0]!);
		await group.closeAll();
	});

	it('keeps the tab dirty when the save fails', async () => {
		const { group, doc, rope } = await openWindowed(SMALL);
		const saved: string[] = [];
		group.onFileSaved = (path) => saved.push(path);
		await edit(doc, 0, 0, '// ');
		const editor = group.open[0]!;
		expect(editor.dirty).toBe(true);
		backend.on('viewer_save', () => {
			throw new Error('disk full');
		});
		await group.save(editor);
		await flush();
		expect(editor.dirty).toBe(true);
		expect(document.querySelector('.tab.dirty, .tab .dirty')).not.toBeNull();
		expect(saved).toHaveLength(0);
		expect(backend.callsTo('backup_clear')).toHaveLength(0);
		expect(notifications().some((n) => n.includes('disk full'))).toBe(true);
		// The disk recovers: the same buffer saves, cleanly.
		rope.install();
		await group.save(editor);
		await flush();
		expect(editor.dirty).toBe(false);
		expect(rope.saved).toBe('// ' + SMALL);
		expect(saved).toEqual(['C:\\repo\\big.log']);
		await group.closeAll();
	});

	it('reloads a clean editor only when the disk really changed, keeping the cursor', async () => {
		const { group, doc, rope } = await openWindowed(SMALL);
		// A reveal inside the window moves the cursor (line and column) without a slide.
		const fetches = backend.callsTo('viewer_text').length;
		await doc.revealLine(5, 3);
		await flush();
		expect(backend.callsTo('viewer_text')).toHaveLength(fetches);
		expect(doc.status()).toMatchObject({ line: 6, column: 4 });
		// A watcher echo with an unchanged stamp: no refetch, no cursor move.
		await group.reloadIfClean('C:\\repo\\big.log');
		await flush();
		expect(backend.callsTo('viewer_reload')).toHaveLength(1);
		expect(backend.callsTo('viewer_text')).toHaveLength(fetches);
		expect(doc.status()).toMatchObject({ line: 6, column: 4 });
		// A real external change: the window is refetched and shows the new text.
		rope.text = SMALL.replace('line 5', 'line 5 FROM DISK');
		rope.diskChanged = true;
		await group.reloadIfClean('C:\\repo\\big.log');
		await flush();
		expect(shown(doc)).toBe(rope.text);
		expect(doc.status().line).toBe(6);
		// An edit typed but not yet saved shields the document from a reload.
		await edit(doc, 0, 0, 'x');
		rope.diskChanged = true;
		await doc.reload();
		await flush();
		expect(backend.callsTo('viewer_reload')).toHaveLength(2);
		expect(shown(doc).startsWith('xline 0')).toBe(true);
		await group.save(group.open[0]!);
		await group.closeAll();
	});
});
