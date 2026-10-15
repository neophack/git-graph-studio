// The editor's extension-decoration store: the values behind
// `vscode.window.createTextEditorDecorationType` + `TextEditor.setDecorations` (see
// editorDecorationsView.ts for the CodeMirror half this renders from). The store half
// carries no CodeMirror — like editorDiagnostics.ts, it renders through a renderer
// callback the view half registers, so the first-paint bundle stays free of the editor.
//
// Semantics are VS Code's: a type is created once with its rendering options; a
// `setDecorations` call REPLACES that type's ranges on one document (an empty array
// clears it); disposing the type clears it everywhere.

/** The rendering subset of VS Code's DecorationRenderOptions that CodeMirror can draw.
 *  Everything else (overview ruler, gutters) is accepted and ignored, exactly as the
 *  API shape promises — no extension path throws on an option this host lacks. */
export interface SerializableDecorationOptions {
	backgroundColor?: string;
	border?: string;
	borderColor?: string;
	borderRadius?: string;
	color?: string;
	fontWeight?: string;
	fontStyle?: string;
	textDecoration?: string;
	cursor?: string;
	isWholeLine?: boolean;
}

/** One decoration range, VS Code's zero-based line/character pairs. */
export interface SerializableDecorationRange {
	startLine: number;
	startCharacter: number;
	endLine: number;
	endCharacter: number;
}

interface DecorationEntry {
	options: SerializableDecorationOptions;
	/** Per path key (a type's ranges are per document). */
	ranges: Map<string, SerializableDecorationRange[]>;
}

const types = new Map<string, DecorationEntry>();

let renderer: ((pathKey: string) => void) | null = null;

/** The view half registers its push callback here (see editorDiagnostics.ts). */
export function setDecorationsRenderer(push: (pathKey: string) => void): void {
	renderer = push;
}

function refresh(pathKey: string): void {
	renderer?.(pathKey);
}

export function normalizePathKey(path: string): string {
	return path.replaceAll('\\', '/').toLowerCase();
}

/** A type was created (`decoration.type` from the frame host). */
export function registerDecorationType(key: string, options: SerializableDecorationOptions): void {
	types.set(key, { options, ranges: new Map() });
}

/** A type was disposed: its marks leave every document. */
export function disposeDecorationType(key: string): void {
	const entry = types.get(key);
	if (!entry) return;
	for (const pathKey of entry.ranges.keys()) refresh(pathKey);
	types.delete(key);
}

/** `TextEditor.setDecorations`: REPLACE the type's ranges on one document (empty clears).
 *  A `null` path addresses the active file editor's document key — the caller (the
 *  frame host's serve path) resolves that the same way `editor.applyEdits` does. */
export function setDecorationRanges(pathKey: string, key: string, ranges: SerializableDecorationRange[]): void {
	const entry = types.get(key);
	if (!entry) return;
	entry.ranges.set(pathKey, ranges);
	refresh(pathKey);
}

/** The type's options and ranges on one document (the view half reads this per render). */
export function decorationEntriesFor(pathKey: string): { key: string; options: SerializableDecorationOptions; ranges: SerializableDecorationRange[] }[] {
	const out: { key: string; options: SerializableDecorationOptions; ranges: SerializableDecorationRange[] }[] = [];
	for (const [key, entry] of types) {
		const ranges = entry.ranges.get(pathKey);
		if (ranges && ranges.length > 0) out.push({ key, options: entry.options, ranges });
	}
	return out;
}

/** Every document key a type carries marks on (the dispose path refreshes those). */
export function decorationPathsOf(key: string): string[] {
	return [...(types.get(key)?.ranges.keys() ?? [])];
}
