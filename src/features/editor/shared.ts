// Shared helpers of the editor suite's split files: the raw-IPC file read, the saved-tab
// notice chip, and the diff sides' scroll coupling. A leaf, so open/dirty/navigate can
// share them without importing each other (R5).

import type { EditorView } from '@codemirror/view';
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

/** The diff sides' vertical scroll coupling (VS Code's): one pane's wheel moves both, to
 *  the same viewport offset. The merge view pads the shorter side with spacers, so
 *  corresponding content sits at equal pixel offsets on the two sides and both panes
 *  scroll over the same range — equal offsets keep the panes aligned and the two
 *  scrollbars level. The fraction-of-own-range form this used to ship sent the far pane
 *  elsewhere whenever the sides' ranges momentarily differed (an edit rebuilding the
 *  spacers, a collapsed range opening), and its 50 ms time lock swallowed the tail of
 *  every drag: a gesture's last events always fell inside the window, so the mirror pane
 *  froze one gesture behind the thumb — with nothing left to correct it. Suppression is
 *  positional instead: a scroll event carrying the value this sync itself wrote is that
 *  write's echo and stops there; every other event — the user's — mirrors, tail included.
 *  The scroll listeners die with the panes; the detach exists so a layout rebuild never
 *  leaves a mirror onto destroyed views. */
export function attachScrollSync(a: EditorView, b: EditorView): () => void {
	const written = new Map<EditorView, number>();
	const mirror = (from: EditorView, to: EditorView) => () => {
		const top = from.scrollDOM.scrollTop;
		const expected = written.get(from);
		if (expected !== undefined && Math.abs(expected - top) < 1) {
			written.delete(from);
			return;
		}
		// The far pane clamps to its own range (a transient rebuild can shrink it mid
		// gesture): the write lands inside, its echo reads back the written value, and
		// the pane the user is driving is never yanked in return.
		const clamp = (view: EditorView): number =>
			Math.max(0, Math.min(top, Math.max(0, view.scrollDOM.scrollHeight - view.scrollDOM.clientHeight)));
		const target = clamp(to);
		written.set(to, target);
		to.scrollDOM.scrollTop = target;
	};
	const aToB = mirror(a, b);
	const bToA = mirror(b, a);
	a.scrollDOM.addEventListener('scroll', aToB);
	b.scrollDOM.addEventListener('scroll', bToA);
	return () => {
		a.scrollDOM.removeEventListener('scroll', aToB);
		b.scrollDOM.removeEventListener('scroll', bToA);
	};
}
