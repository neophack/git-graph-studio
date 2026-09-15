// Encodings and line endings in the editor group: a file opens with the encoding and EOL the
// backend detected, saves go back out in them, "Reopen with Encoding" re-reads the bytes,
// "Save with Encoding" switches the encoding for good, and the EOL switch marks the file
// dirty so the next save converts it.

import { describe, expect, it } from 'vitest';

import { EditorGroup } from '../src/editor';
import { backend } from './tauriMock';
import { flush } from './helpers';

const REPO = 'C:\\repo';
const FILE = `${REPO}\\readme.txt`;

function setup() {
	const writes: Record<string, unknown>[] = [];
	backend.on('read_file', ({ encoding }) => ({
		contents: encoding === 'windows-1252' ? 'ÖÐÎÄ\n' : '中文\n',
		binary: false,
		size: 6,
		encoding: encoding ?? 'gb18030',
		eol: 'crlf'
	}));
	backend.on('write_file', (args) => { writes.push(args); return null; });
	backend.on('file_fingerprint', () => '6:1');
	backend.on('backup_write', () => null);
	backend.on('backup_clear', () => null);
	const group = new EditorGroup(document.getElementById('editorGroup')!);
	group.setRoot(REPO);
	return { group, writes };
}

describe('encodings in the editor', () => {
	it('opens with the detected encoding and EOL and saves them back', async () => {
		const { group, writes } = setup();
		const seen: { encoding?: string; eol?: string }[] = [];
		group.onActiveChange = (editor) => { if (editor) seen.push({ encoding: editor.encoding, eol: editor.eol }); };
		await group.openFile(FILE);
		expect(seen.at(-1)).toEqual({ encoding: 'gb18030', eol: 'crlf' });
		expect(group.activeView!.state.doc.toString()).toBe('中文\n');

		group.activeView!.dispatch({ changes: { from: 0, insert: '# ' } });
		await group.save();
		expect(writes).toEqual([{ path: FILE, contents: '# 中文\n', encoding: 'gb18030', eol: 'crlf' }]);
	});

	it('reopens the bytes with a chosen encoding and can save with another', async () => {
		const { group, writes } = setup();
		await group.openFile(FILE);
		await group.reopenWithEncoding('windows-1252');
		expect(backend.callsTo('read_file').at(-1)).toEqual({ path: FILE, encoding: 'windows-1252' });
		expect(group.activeView!.state.doc.toString()).toBe('ÖÐÎÄ\n');
		expect(group.hasDirtyEditors()).toBe(false);

		await group.saveWithEncoding('utf8bom');
		expect(writes.at(-1)).toMatchObject({ path: FILE, encoding: 'utf8bom', eol: 'crlf' });
		expect(group.hasDirtyEditors()).toBe(false);
	});

	it('switching the line endings dirties the file and the next save converts it', async () => {
		const { group, writes } = setup();
		await group.openFile(FILE);
		group.setEol('lf');
		expect(group.hasDirtyEditors()).toBe(true);
		await group.save();
		await flush();
		expect(writes.at(-1)).toMatchObject({ eol: 'lf', encoding: 'gb18030' });
		expect(group.hasDirtyEditors()).toBe(false);
	});
});
