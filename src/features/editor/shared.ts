// Shared helpers of the editor suite's split files: the raw-IPC file read and the
// saved-tab notice chip. A leaf, so open/dirty/navigate can share them without
// importing each other (R5).

import { type FileContents, readFileRaw as fetchFileRaw } from '../../platform/ipc/fs';
import { el, icon } from '../../platform/ui/index';

/** Read a file's text over the raw IPC channel (`read_file_raw`). The JSON path re-escapes
 *  and re-copies the whole document on both sides of the bridge, which stalled the webview
 *  for seconds on large files; the raw payload is an 8-byte little-endian header length,
 *  the JSON metadata, then the UTF-8 text itself. */
export async function readFileRaw(path: string, encoding?: string): Promise<FileContents> {
	const raw = await fetchFileRaw(path, encoding);
	const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
	const headerLen = Number(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(0, true));
	const meta = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + headerLen))) as Omit<FileContents, 'contents'>;
	const contents = meta.binary ? null : new TextDecoder().decode(bytes.subarray(8 + headerLen));
	return { ...meta, contents };
}

export function notice(iconName: string, text: string): HTMLElement {
	return el('div', 'editor-notice', [icon(iconName), el('span', '', [text])]);
}
