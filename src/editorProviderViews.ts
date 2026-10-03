// The editor-side surfaces for the extensions' hover and definition providers (the
// frame half is editorHovers.ts's bridge): a CodeMirror hover tooltip that asks the
// providers, and Go-to-Definition (F12 / Ctrl+Click) that opens the first location.
// Markdown from a provider renders as TEXT — an extension's hover must not be able to
// inject markup into the workbench's DOM.

import { hoverTooltip, EditorView, keymap, type TooltipView } from '@codemirror/view';
import { Facet, type Extension } from '@codemirror/state';
import { extensionDefinitionFor, extensionDefinitionOpener, extensionHoverFor, hasExtensionDefinitions, hasExtensionHovers } from './editorHovers';

/** The open file's path, so the provider call names the right document. */
const pathSlot = Facet.define<string, string>({ combine: (values) => values[values.length - 1] ?? '' });

function docInfo(view: EditorView): { path: string; languageId: string; text: string; line: number; character: number } | null {
	const path = view.state.facet(pathSlot);
	if (!path) return null;
	const line = view.state.doc.lineAt(view.state.selection.main.head);
	return {
		path,
		languageId: (view.state as unknown as { language?: { name?: string } }).language?.name ?? '',
		text: view.state.doc.toString(),
		line: line.number - 1,
		character: view.state.selection.main.head - line.from
	};
}

/** The hover tooltip: the providers' first non-empty answer, its contents as text lines. */
const extensionHover = hoverTooltip(async (view, pos) => {
	if (!hasExtensionHovers()) return null;
	const info = docInfo(view);
	if (!info) return null;
	const hover = await extensionHoverFor(info.path, info.languageId, info.text, pos >= 0 ? view.state.doc.lineAt(pos).number - 1 : 0, pos - view.state.doc.lineAt(pos).from);
	if (!hover || hover.contents.length === 0) return null;
	return {
		pos: Math.max(0, Math.min(pos, view.state.doc.length)),
		create: (): TooltipView => {
			const dom = document.createElement('div');
			dom.className = 'ggs-ext-hover';
			for (const text of hover.contents) {
				const block = document.createElement('pre');
				block.className = 'ggs-ext-hover-content';
				block.textContent = text;
				dom.appendChild(block);
			}
			return { dom };
		}
	};
}, { hoverTime: 350 });

/** Go-to-Definition: the providers' first location opens in a tab (F12 or Ctrl/Cmd+Click). */
function goToDefinition(view: EditorView): boolean {
	const opener = extensionDefinitionOpener();
	if (!hasExtensionDefinitions() || !opener) return false;
	const info = docInfo(view);
	if (!info) return false;
	void extensionDefinitionFor(info.path, info.languageId, info.text, info.line, info.character).then((locations) => {
		const first = locations[0];
		if (first) opener.open(first.path, first.startLine, first.startCharacter);
	});
	return true;
}

/** The extension-provider extensions a file editor mounts (hover + definition). */
export function extensionProviderExtensions(path: string): Extension[] {
	return [
		pathSlot.of(path),
		extensionHover,
		keymap.of([{ key: 'F12', run: (view) => goToDefinition(view) }]),
		EditorView.domEventHandlers({
			mousedown: (event, view) => {
				if (!(event.ctrlKey || event.metaKey)) return false;
				if (!hasExtensionDefinitions()) return false;
				const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
				if (pos === null) return false;
				const info = docInfo(view);
				if (!info) return false;
				void extensionDefinitionFor(info.path, info.languageId, info.text, view.state.doc.lineAt(pos).number - 1, pos - view.state.doc.lineAt(pos).from).then((locations) => {
					const first = locations[0];
					if (first) extensionDefinitionOpener()?.open(first.path, first.startLine, first.startCharacter);
				});
				return true;
			}
		})
	];
}
