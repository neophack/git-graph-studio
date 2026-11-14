// Peek Definition (CLion's quick definition lookup, VS Code's peek): the definition of
// the word under the cursor, shown in a popup anchored over the editor — the file and
// the scroll never move. The body slices the declaring file around the definition (a
// C-style body through its column-0 closing brace, a `\`-continued `#define` through its
// end line), several definitions of one name pick from a list, and a definition opens in
// a tab through the same jump the Go-to-Definition family rides. The popup closes on
// Escape or a click outside it and follows the editor's scroll while it lives.

import type { EditorView } from '@codemirror/view';
import type { WsSymbol } from '../../platform/ipc/search';
import { t } from '../../platform/i18n';
import { el, icon } from '../../platform/ui/index';
import { SYMBOL_ICONS } from './breadcrumbs';

/** How far around a definition the body shows, and what it is capped at. */
const PEEK_WINDOW_LINES = 60;
const PEEK_WINDOW_CHARS = 2000;

/** The source window `definition` names: two lines of context above, then either the
 *  definition's own end line (a directive's continuations) or the run down to the
 *  column-0 `}` that closes a C-style body — capped and trimmed. */
export function definitionWindow(contents: string, line: number, endLine?: number): string {
	const lines = contents.split('\n');
	const from = Math.min(Math.max(0, line - 2), lines.length - 1);
	let to: number;
	if (endLine !== undefined && endLine >= line) {
		to = Math.min(endLine, from + PEEK_WINDOW_LINES - 1, lines.length - 1);
	} else {
		to = Math.min(line + PEEK_WINDOW_LINES - 3, lines.length - 1);
		for (let i = line; i <= to; i++) {
			if (lines[i] === '}') {
				to = i;
				break;
			}
		}
	}
	return lines.slice(from, to + 1).join('\n').replace(/\s+$/, '').slice(0, PEEK_WINDOW_CHARS);
}

/** What the popup is wired to: the group's root (for reads), its cached file read, the
 *  definition jump a chosen entry or the Open button rides, and the dismissal the
 *  mount calls on its own closures (Escape, the close button). Paths are repo-relative
 *  and lines 0-based — the group resolves both against its own root. */
export interface PeekHandlers {
	root(): string | null;
	read(path: string): Promise<string | null>;
	open(path: string, line: number): void;
	close(): void;
}

/** The popup's DOM: the head (kind, name, Open, close), the definitions' chooser when
 *  the name declares more than one, and the selected definition's body. The body loads
 *  through `handlers.read`, so it fills in after the promise settles. */
export function buildPeekDom(name: string, defs: WsSymbol[], handlers: PeekHandlers): HTMLElement {
	const root = el('div', 'ggs-peek');
	const first = defs[0]!;
	const head = el('div', 'ggs-peek-head', [
		icon(SYMBOL_ICONS[first.kind] ?? 'symbol-method'),
		el('span', 'ggs-peek-name', [name]),
		el('span', 'ggs-peek-kind', [first.kind])
	]);
	const openButton = el('button', 'ggs-peek-open', [t('symbols.hover.openDefinition')]);
	const closeButton = el('button', 'ggs-peek-close', [icon('close')]);
	closeButton.title = 'Escape';
	head.append(el('span', 'ggs-peek-spring'), openButton, closeButton);
	root.appendChild(head);

	let selected = 0;
	const rows: HTMLElement[] = [];
	const chooser = defs.length > 1 ? el('div', 'ggs-peek-defs') : null;
	const body = el('pre', 'ggs-peek-body');

	const show = (index: number): void => {
		selected = index;
		for (let i = 0; i < rows.length; i++) rows[i]!.classList.toggle('active', i === index);
		body.textContent = '…';
		const def = defs[index]!;
		void handlers
			.read(def.path)
			.then((contents) => {
				body.textContent = contents === null ? '' : definitionWindow(contents, def.line, def.endLine);
			})
			.catch(() => {
				body.textContent = '';
			});
	};

	if (chooser) {
		for (let i = 0; i < defs.length; i++) {
			const def = defs[i]!;
			const row = el('button', 'ggs-peek-def', [`${def.path}:${def.line + 1}`, el('span', 'ggs-peek-def-kind', [def.kind])]);
			row.addEventListener('click', () => show(i));
			rows.push(row);
			chooser.appendChild(row);
		}
		root.appendChild(chooser);
	}
	root.appendChild(body);

	openButton.addEventListener('click', () => {
		const def = defs[selected]!;
		handlers.open(def.path, def.line);
		// The jump dismisses the popup — a mount's open closes it through the handle's own
		// teardown, and a bare build's closes through this.
		handlers.close();
	});
	closeButton.addEventListener('click', () => handlers.close());
	show(0);
	return root;
}

/** What the mount hands back: the dismissal, idempotent. */
export interface PeekHandle {
	close(): void;
}

/** Anchor the popup over `view` at `pos` (the hovered word's start): below the caret
 *  line, clamped into the window, re-anchored on every scroll of the editor, and
 *  dismissed by Escape or a mousedown outside it. */
export function mountPeek(view: EditorView, pos: number, name: string, defs: WsSymbol[], handlers: PeekHandlers): PeekHandle {
	const dom = buildPeekDom(name, defs, handlers);
	document.body.appendChild(dom);

	const reposition = (): void => {
		let coords: ReturnType<EditorView['coordsAtPos']> | null = null;
		try {
			coords = view.coordsAtPos(pos);
		} catch {
			coords = null; // a view jsdom cannot lay out, or a hidden one — the popup stays where it is
		}
		if (!coords) return;
		const width = dom.offsetWidth || 640;
		const height = dom.offsetHeight || 320;
		const x = Math.min(Math.max(8, coords.left), Math.max(8, window.innerWidth - width - 8));
		let y = coords.bottom + 6;
		if (y + height > window.innerHeight - 8) y = Math.max(8, coords.top - height - 6);
		dom.style.left = `${Math.round(x)}px`;
		dom.style.top = `${Math.round(y)}px`;
	};
	reposition();

	const onScroll = (): void => reposition();
	const onKey = (event: KeyboardEvent): void => {
		if (event.key !== 'Escape') return;
		event.preventDefault();
		event.stopPropagation();
		handle.close();
	};
	const onDown = (event: MouseEvent): void => {
		if (!dom.contains(event.target as Node)) handle.close();
	};
	view.scrollDOM.addEventListener('scroll', onScroll);
	document.addEventListener('keydown', onKey, true);
	document.addEventListener('mousedown', onDown, true);
	// A view the workbench destroyed (its tab closed, a diff layout switch rebuilt the
	// panes) leaves no listener to clean: the sweep closes the popup instead.
	const sweep = window.setInterval(() => {
		if (!view.dom.isConnected) handle.close();
	}, 500);

	let closed = false;
	const handle: PeekHandle = {
		close(): void {
			if (closed) return;
			closed = true;
			window.clearInterval(sweep);
			view.scrollDOM.removeEventListener('scroll', onScroll);
			document.removeEventListener('keydown', onKey, true);
			document.removeEventListener('mousedown', onDown, true);
			dom.remove();
			handlers.close();
		}
	};
	return handle;
}
