// The shim's document table entry and the TextDocument view over a text
// snapshot — line / offset / word arithmetic, VS Code's zero-based lines.

import { Position, Range } from './types/position';
import { Uri } from './types/uri';
import { EndOfLine } from './types/enums';

/** A document the shim knows the text of: the active editor's (pushed by the host),
 *  one `openTextDocument` read, or an in-memory `{ content }` document. */
export interface DocumentState {
	path: string;
	uri: Uri;
	text: string;
	languageId: string;
	version: number;
}

/** The key the shim's document table uses: slashes unified, the drive letter lowercased
 *  (Windows paths are case-insensitive there, and the host's and the extension's
 *  spellings of one file must meet). */
export function documentKey(path: string): string {
	return path.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_all, drive: string) => `${drive.toLowerCase()}:`);
}

/** Is `path` the folder itself or inside it (a separator boundary, not a name prefix)? */
export function isInsideFolder(path: string, folder: string): boolean {
	const child = documentKey(path).toLowerCase().replace(/\/+$/, '');
	const parent = documentKey(folder).toLowerCase().replace(/\/+$/, '');
	return child === parent || child.startsWith(`${parent}/`);
}

/** A `vscode.TextDocument` over a text snapshot — line / offset / word arithmetic on the
 *  held text, VS Code's zero-based lines and characters, `\r\n` counted as one break. */
export function documentView(state: DocumentState, save: () => Promise<boolean>): Record<string, unknown> {
	const text = state.text;
	const lines = text.split('\n');
	const lineText = (index: number) => lines[index]!.replace(/\r$/, '');
	const clampPosition = (position?: { line: number; character: number }): Position => {
		const line = Math.max(0, Math.min(Number(position?.line) || 0, lines.length - 1));
		const character = Math.max(0, Math.min(Number(position?.character) || 0, lineText(line).length));
		return new Position(line, character);
	};
	const offsetAt = (position: { line: number; character: number }): number => {
		const clamped = clampPosition(position);
		let offset = 0;
		for (let index = 0; index < clamped.line; index += 1) offset += lines[index]!.length + 1;
		return offset + clamped.character;
	};
	const positionAt = (offset: number): Position => {
		let remaining = Math.max(0, Math.min(Number(offset) || 0, text.length));
		for (let index = 0; index < lines.length; index += 1) {
			const length = lines[index]!.length;
			if (remaining <= length) return new Position(index, Math.min(remaining, lineText(index).length));
			remaining -= length + 1;
		}
		return new Position(lines.length - 1, lineText(lines.length - 1).length);
	};
	const lineAt = (lineOrPosition: number | { line: number }) => {
		const requested = typeof lineOrPosition === 'number' ? lineOrPosition : lineOrPosition.line;
		const index = Math.max(0, Math.min(Number(requested) || 0, lines.length - 1));
		const content = lineText(index);
		return {
			lineNumber: index,
			text: content,
			range: new Range(index, 0, index, content.length),
			rangeIncludingLineBreak: index < lines.length - 1 ? new Range(index, 0, index + 1, 0) : new Range(index, 0, index, content.length),
			firstNonWhitespaceCharacterIndex: content.search(/\S|$/),
			isEmptyOrWhitespace: content.trim().length === 0
		};
	};
	return {
		uri: state.uri,
		fileName: state.uri.scheme === 'file' ? state.uri.fsPath : state.path,
		languageId: state.languageId,
		version: state.version,
		isDirty: false,
		isUntitled: state.uri.scheme === 'untitled',
		isClosed: false,
		eol: text.includes('\r\n') ? EndOfLine.CRLF : EndOfLine.LF,
		encoding: 'utf8',
		lineCount: lines.length,
		getText: (range?: { start: { line: number; character: number }; end: { line: number; character: number } }) =>
			range ? text.slice(offsetAt(range.start), offsetAt(range.end)) : text,
		positionAt,
		offsetAt,
		lineAt,
		validatePosition: clampPosition,
		validateRange: (range?: { start?: { line: number; character: number }; end?: { line: number; character: number } }) =>
			new Range(clampPosition(range?.start), clampPosition(range?.end)),
		getWordRangeAtPosition: (position: { line: number; character: number }, regex?: RegExp) => {
			const at = clampPosition(position);
			const content = lineText(at.line);
			const pattern = new RegExp((regex ?? /(-?\d*\.\d\w*)|([^`~!@#$%^&*()\-=+[{\]}\\|;:'",.<>/?\s]+)/g).source, 'g');
			for (let match = pattern.exec(content); match !== null; match = pattern.exec(content)) {
				if (match[0].length === 0) {
					pattern.lastIndex += 1;
					continue;
				}
				if (match.index <= at.character && match.index + match[0].length >= at.character) return new Range(at.line, match.index, at.line, match.index + match[0].length);
			}
			return undefined;
		},
		save
	};
}
