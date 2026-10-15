// The editor's extension-decoration surface, CodeMirror half (loaded with the editor
// suite — see editorDecorations.ts for the store half this renders from): every
// registered view for a file re-renders on a push, ranges convert from VS Code's
// zero-based line/character pairs to CodeMirror offsets against the live document, and
// each type's options become one Decoration.mark class whose CSS lands in a single
// injected style sheet (option values come from the extension; they apply through a
// namespaced class, never onto the editor's own chrome).

import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { RangeSetBuilder, StateEffect, StateField, type Extension } from '@codemirror/state';
import {
	decorationEntriesFor,
	normalizePathKey,
	setDecorationsRenderer,
	type SerializableDecorationOptions
} from './editorDecorations';

/** The marks live in a state field rebuilt per push — the counts are small (a highlight
 *  set, an indent rainbow), and a whole-set rebuild is what the diagnostics surface does. */
const decorationsEffect = StateEffect.define<DecorationSet>();

const decorationsField = StateField.define<DecorationSet>({
	create: () => Decoration.none,
	update(value, transaction) {
		let next = value;
		for (const effect of transaction.effects) {
			if (effect.is(decorationsEffect)) next = effect.value;
		}
		if (transaction.docChanged && next.size > 0) return next.map(transaction.changes);
		return next;
	},
	provide: (field) => EditorView.decorations.from(field)
});

/** One registered editor view plus the file it renders. */
interface ViewEntry {
	path: string;
	view: EditorView;
}

const views = new Set<ViewEntry>();

/** The CodeMirror extension one file editor includes: it registers the view for pushes
 *  and re-draws the store's ranges whenever they (or the document) change. */
function decorationsPlugin(path: string): Extension {
	const key = normalizePathKey(path);
	const entry: ViewEntry = {
		path: key,
		view: null as unknown as EditorView
	};
	return ViewPlugin.fromClass(class {
		constructor(view: EditorView) {
			entry.view = view;
			views.add(entry);
			queuePush(view, key);
		}
		update(update: ViewUpdate): void {
			entry.view = update.view;
			if (update.docChanged || update.geometryChanged) queuePush(update.view, key);
		}
		destroy(): void {
			views.delete(entry);
		}
	});
}

/** The extension a file editor mounts: the marks field and the redraw plugin. */
export function extensionDecorationsExtension(path: string): Extension {
	return [decorationsField, decorationsPlugin(path)];
}

function pushTo(view: EditorView, path: string): void {
	const builder = new RangeSetBuilder<Decoration>();
	const doc = view.state.doc;
	const entries = decorationEntriesFor(path);
	// Ranges arrive per type; collect them all, sort by position (RangeSetBuilder needs
	// order), and clip to the document the way diagnostics do.
	const marks: { from: number; to: number; decoration: Decoration }[] = [];
	for (const entry of entries) {
		const decoration = Decoration.mark({ class: decorationClass(entry.key, entry.options) });
		for (const range of entry.ranges) {
			const from = offsetOf(doc, range.startLine, range.startCharacter);
			const to = Math.max(from, offsetOf(doc, range.endLine, range.endCharacter));
			if (to > from) marks.push({ from, to, decoration });
		}
	}
	marks.sort((a, b) => a.from - b.from || a.to - b.to);
	for (const mark of marks) builder.add(mark.from, mark.to, mark.decoration);
	view.dispatch({
		effects: decorationsEffect.of(builder.finish())
	});
}

/** Pushes scheduled past the current update: `view.dispatch` inside an update is forbidden. */
function queuePush(view: EditorView, path: string): void {
	setTimeout(() => pushTo(view, path), 0);
}

/** Refresh every open view of one file — the store's pushes land here. */
function refreshPath(key: string): void {
	for (const entry of views) {
		if (entry.path === key) queuePush(entry.view, entry.path);
	}
}

/** The store (in the static closure) hands pushes here, so a decoration RPC reaches the
 *  open views without dragging CodeMirror into the first-paint bundle. */
setDecorationsRenderer(refreshPath);

/** One style class per type key, its rule written once into a module style sheet: the
 *  extension's own CSS values apply through the class, never inline onto the editor's
 *  DOM (an extension cannot restyle the workbench chrome through this). */
function decorationClass(key: string, options: SerializableDecorationOptions): string {
	const existing = classFor.get(key);
	if (existing) return existing;
	const className = `ggs-deco-${key.replace(/[^A-Za-z0-9-]/g, '-')}`;
	const declarations: string[] = [];
	if (options.backgroundColor) declarations.push(`background-color:${options.backgroundColor}`);
	if (options.border) declarations.push(`border:${options.border}`);
	else if (options.borderColor) declarations.push(`border:1px solid ${options.borderColor}`);
	if (options.borderRadius) declarations.push(`border-radius:${options.borderRadius}`);
	if (options.color) declarations.push(`color:${options.color}`);
	if (options.fontWeight) declarations.push(`font-weight:${options.fontWeight}`);
	if (options.fontStyle) declarations.push(`font-style:${options.fontStyle}`);
	if (options.textDecoration) declarations.push(`text-decoration:${options.textDecoration}`);
	if (options.cursor) declarations.push(`cursor:${options.cursor}`);
	styleSheet().textContent += `\n.cm-editor .${className} { ${declarations.join(';')} }`;
	classFor.set(key, className);
	return className;
}

const classFor = new Map<string, string>();

function styleSheet(): HTMLStyleElement {
	let sheet = document.querySelector<HTMLStyleElement>('style[data-ggs-decorations]');
	if (!sheet) {
		sheet = document.createElement('style');
		sheet.dataset.ggsDecorations = 'true';
		document.head.appendChild(sheet);
	}
	return sheet;
}

function offsetOf(doc: { lines: number; lineAt(n: number): { from: number; to: number }; length: number }, line: number, character: number): number {
	const lineNumber = Math.max(1, Math.min((line ?? 0) + 1, doc.lines));
	const docLine = doc.lineAt(lineNumber);
	return Math.min(docLine.from + Math.max(0, character ?? 0), docLine.to);
}
