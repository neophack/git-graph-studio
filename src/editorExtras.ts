// The VS Code editor extras of M3 3.2: bracket pair colouring, sticky scroll, the minimap,
// and the smooth wheel glide. All live as CodeMirror extensions here (so they stay in the
// text editor's async chunk), read the settings live, and degrade to no-ops in environments
// without layout or canvas (jsdom) rather than throwing.

import { RangeSetBuilder, StateEffect, StateField, type Extension } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';

import { SETTINGS_EVENT, THEME_EVENT, settings } from './settings';
import { attachSmoothWheel, type SmoothWheelHandle } from './ui';

/** A coalesced redraw around a callback: the returned trigger runs the callback once per
 *  animation frame however often it is asked for (a plain timeout where frames do not exist,
 *  as in jsdom). */
function scheduled(run: () => void): () => void {
	let pending: number | null = null;
	const fire = (): void => {
		pending = null;
		run();
	};
	return () => {
		if (pending !== null) return;
		const raf = window.requestAnimationFrame?.bind(window);
		pending = raf ? raf(fire) : window.setTimeout(fire, 0);
	};
}

/* ---------- Bracket pair colouring ---------- */

/** VS Code's depth colours: gold, then purple, then blue, repeating. */
const BRACKET_COLORS = 3;

const isOpener = (ch: string) => ch === '(' || ch === '[' || ch === '{';
const isCloser = (ch: string) => ch === ')' || ch === ']' || ch === '}';

/** The bracket depth at the start of each line, filled lazily (an edit above invalidates the
 *  lines after it, and they are re-counted on demand). */
class DepthIndex {
	private readonly depths: number[] = [];
	private computedUpto = 0;

	/** Forget everything from 0-based line index `line` on. */
	invalidate(line: number): void {
		this.computedUpto = Math.min(this.computedUpto, line);
	}

	/** The depth before 1-based line `n`, computing (and caching) the lines up to it. */
	depthAt(view: EditorView, n: number): number {
		const doc = view.state.doc;
		for (let line = this.computedUpto + 1; line < n; line++) {
			const text = doc.line(line).text;
			let depth = this.depths[line - 1] ?? 0;
			for (const ch of text) {
				if (isOpener(ch)) depth++;
				else if (isCloser(ch)) depth = Math.max(0, depth - 1);
			}
			this.depths[line] = depth;
		}
		this.computedUpto = Math.max(this.computedUpto, n - 1);
		if (this.depths.length > doc.lines + 1) this.depths.length = doc.lines + 1;
		return this.depths[n - 1] ?? 0;
	}
}

/** The marks the plugin computes flow into the state through this field, so CodeMirror maps
 *  them over edits between redraws. */
const setBracketDecorations = StateEffect.define<DecorationSet>();
const bracketField = StateField.define<DecorationSet>({
	create: () => Decoration.none,
	update(value, tr) {
		const effect = tr.effects.find((e) => e.is(setBracketDecorations));
		return effect ? effect.value : value.map(tr.changes);
	},
	provide: (field) => EditorView.decorations.from(field)
});

/** Colour every bracket of the visible lines by nesting depth. Brackets inside strings and
 *  comments are skipped when a syntax tree covers the line; a plain-text file (no tree yet)
 *  counts every bracket, which is what most editors did before parsers anyway. */
export function bracketColorsExtension(): Extension {
	const plugin = ViewPlugin.fromClass(class {
		readonly index = new DepthIndex();
		readonly listener = () => this.redraw();

		constructor(readonly view: EditorView) {
			document.addEventListener(SETTINGS_EVENT, this.listener);
			this.redraw();
		}

		update(update: ViewUpdate): void {
			if (update.docChanged) {
				let first = update.startState.doc.lines;
				update.changes.iterChangedRanges((from) => {
					first = Math.min(first, update.startState.doc.lineAt(from).number - 1);
				});
				this.index.invalidate(first);
			}
			if (update.docChanged || update.viewportChanged || update.geometryChanged) this.redraw();
		}

		destroy(): void {
			document.removeEventListener(SETTINGS_EVENT, this.listener);
		}

		private readonly redraw = scheduled(() => {
			const decorations = settings.bracketColors ? buildBracketDecorations(this.view, this.index) : Decoration.none;
			this.view.dispatch({ effects: setBracketDecorations.of(decorations) });
		});
	});
	return [bracketField, plugin];
}

function buildBracketDecorations(view: EditorView, index: DepthIndex): DecorationSet {
	const { state } = view;
	const builder = new RangeSetBuilder<Decoration>();
	for (const { from, to } of view.visibleRanges) {
		const first = state.doc.lineAt(from).number;
		const last = state.doc.lineAt(to).number;
		for (let n = first; n <= last; n++) {
			const line = state.doc.line(n);
			let depth = index.depthAt(view, n);
			// `from` is the token's own document position: the tree's leaves do not cover the
			// whitespace between tokens, so a running cursor would drift and paint marks on
			// neighbouring letters and spaces.
			const scan = (text: string, isCode: boolean, from: number) => {
				for (const ch of text) {
					const bracket = isOpener(ch) || isCloser(ch);
					// Brackets inside strings and comments are neither coloured nor counted -
					// counting them would shift the depth of the real code after them.
					if (bracket && isCode) {
						if (isCloser(ch)) depth = Math.max(0, depth - 1);
						builder.add(from, from + ch.length, Decoration.mark({ class: `cm-bracket-${depth % BRACKET_COLORS}` }));
						if (isOpener(ch)) depth++;
					}
					from += ch.length;
				}
			};
			if (syntaxTree(state).length < line.to) {
				scan(line.text, true, line.from);
			} else {
				syntaxTree(state).iterate({
					from: line.from,
					to: line.to,
					enter: (node) => {
						if (node.to - node.from > 0 && node.node.firstChild) return; // only leaves
						const name = node.name.toLowerCase();
						scan(state.sliceDoc(node.from, node.to), !name.includes('string') && !name.includes('comment'), node.from);
					}
				});
			}
		}
	}
	return builder.finish();
}

/* ---------- Sticky scroll ---------- */

function leadingSpaces(text: string): number {
	let n = 0;
	while (n < text.length && (text[n] === ' ' || text[n] === '\t')) n++;
	return n;
}

function isBlank(text: string): boolean {
	return text.trim() === '';
}

/** The enclosing block headers of a line: walking up, every line with a smaller indentation
 *  than the smallest seen so far, provided its block still spans the viewport top (no
 *  equally-indented line between it and the top). Outermost first. */
function stickyLines(view: EditorView, topLine: number): number[] {
	const doc = view.state.doc;
	const picked: number[] = [];
	let smallest = Infinity;
	for (let n = topLine - 1; n >= 1 && picked.length < 5; n--) {
		const text = doc.line(n).text;
		if (isBlank(text)) continue;
		const indent = leadingSpaces(text);
		if (indent >= smallest) continue;
		// The block must reach the viewport: nothing at or below its indentation between the
		// header and the top line (beyond 4,000 lines, take the heuristic's word for it).
		let spans = true;
		for (let m = n + 1; m < topLine && m - n <= 4000; m++) {
			const inner = doc.line(m).text;
			if (!isBlank(inner) && leadingSpaces(inner) <= indent) {
				spans = false;
				break;
			}
		}
		smallest = indent;
		if (spans) picked.push(n);
		if (indent === 0) break;
	}
	return picked.reverse();
}

/** Pin the enclosing blocks over the code while their body is scrolled through. The lines are
 *  plain DOM rows (not editor decorations): they are an overlay of the scroller, not of the
 *  document. A click scrolls the line to the top. */
export function stickyScrollExtension(): Extension {
	return ViewPlugin.fromClass(class {
		readonly overlay = document.createElement('div');
		readonly listener = () => this.draw();

		/** The find widget's bar (a CodeMirror panel) pushes the sticky stack down when open. */
		readonly panelsObserver: ResizeObserver | null = typeof ResizeObserver === 'function'
			? new ResizeObserver(() => this.draw())
			: null;

		constructor(readonly view: EditorView) {
			this.overlay.className = 'cm-sticky';
			this.overlay.style.display = 'none';
			view.dom.appendChild(this.overlay);
			view.scrollDOM.addEventListener('scroll', this.listener);
			document.addEventListener(SETTINGS_EVENT, this.listener);
			this.panelsObserver?.observe(view.dom.querySelector('.cm-panels-top') ?? view.dom);
			this.draw();
		}

		update(update: ViewUpdate): void {
			if (update.docChanged || update.viewportChanged || update.geometryChanged) this.draw();
		}

		destroy(): void {
			this.view.scrollDOM.removeEventListener('scroll', this.listener);
			document.removeEventListener(SETTINGS_EVENT, this.listener);
			this.panelsObserver?.disconnect();
			this.overlay.remove();
		}

		private readonly draw = scheduled(() => {
			const view = this.view;
			this.overlay.textContent = '';
			if (!settings.stickyScroll) {
				this.overlay.style.display = 'none';
				return;
			}
			// Without a layout (jsdom, a hidden pane) there is no viewport to stick over.
			let topLine: number;
			try {
				// posAtCoords takes viewport (client) coordinates, and the editor sits below
				// the titlebar and tabs: anchor the probe at the scroller's own top edge.
				const rect = view.scrollDOM.getBoundingClientRect();
				const at = view.posAtCoords({ x: rect.left + rect.width / 2, y: rect.top + 2 });
				if (at === null) throw new Error('no layout');
				topLine = view.state.doc.lineAt(at).number;
			} catch {
				this.overlay.style.display = 'none';
				return;
			}
			const lines = stickyLines(view, topLine);
			if (lines.length === 0) {
				this.overlay.style.display = 'none';
				return;
			}
			this.overlay.style.display = '';
			// Below an open panel (the find widget) - never under it.
			const panels = view.dom.querySelector<HTMLElement>('.cm-panels-top');
			this.overlay.style.top = panels ? `${panels.offsetHeight}px` : '0px';
			// Cap the stack at a quarter of the editor's height, the outermost lines first.
			const maxRows = Math.max(1, Math.floor(view.scrollDOM.clientHeight / 4 / 22));
			for (const n of lines.slice(0, maxRows)) {
				const row = document.createElement('div');
				row.className = 'cm-sticky-line';
				row.textContent = view.state.doc.line(n).text;
				row.title = `Line ${n}`;
				row.addEventListener('mousedown', (event) => {
					event.preventDefault();
					const target = view.state.doc.line(n);
					view.dispatch({ effects: EditorView.scrollIntoView(target.from, { y: 'start', yMargin: 0 }) });
				});
				this.overlay.appendChild(row);
			}
		});
	});
}

/* ---------- Minimap ---------- */

/** The scaled file overview beside the scroller: one 2 px row per sampled line (the stride
 *  keeps a million-line file within the editor's height), word bars in the foreground colour,
 *  and a draggable viewport slider. */
export function minimapExtension(): Extension {
	class Minimap {
		readonly root = document.createElement('div');
		readonly canvas = document.createElement('canvas');
		readonly slider = document.createElement('div');
		readonly listener = () => this.draw();
		/** Scrolling only moves the viewport: the map itself is untouched, so the scroll
		 *  path redraws nothing but the slider (a style write, not a canvas repaint). */
		readonly scrollListener = () => this.scheduleSlider();
		readonly schedule = scheduled(() => this.draw());
		readonly scheduleSlider = scheduled(() => this.updateSlider());

		constructor(readonly view: EditorView) {
			this.root.className = 'cm-minimap';
			this.canvas.className = 'cm-minimap-canvas';
			this.slider.className = 'cm-minimap-slider';
			this.root.append(this.canvas, this.slider);
			view.dom.appendChild(this.root);
			view.scrollDOM.addEventListener('scroll', this.scrollListener);
			document.addEventListener(SETTINGS_EVENT, this.listener);
			document.addEventListener(THEME_EVENT, this.listener);
			this.bindDrag();
			this.draw();
			// The theme's initialization rewrites the editor's className wholesale, wiping the
			// `has-minimap` class the draw above set - so one more draw is scheduled to land
			// after construction finished.
			this.schedule();
		}

		update(update: ViewUpdate): void {
			// A viewport change alone (scrolling) moves the slider; only content or layout
			// changes repaint the map. A window resize repaints at most once per frame.
			if (update.docChanged || update.geometryChanged) this.schedule();
			else this.scheduleSlider();
		}

		destroy(): void {
			this.view.scrollDOM.removeEventListener('scroll', this.scrollListener);
			document.removeEventListener(SETTINGS_EVENT, this.listener);
			document.removeEventListener(THEME_EVENT, this.listener);
			this.view.dom.classList.remove('has-minimap');
			this.root.remove();
		}

		/** Click and drag on the map scroll the editor: the point under the pointer becomes the
		 *  centre of the viewport, as VS Code's minimap does. */
		private bindDrag(): void {
			this.root.addEventListener('mousedown', (event) => {
				event.preventDefault();
				const scroll = this.view.scrollDOM;
				const to = (clientY: number): void => {
					const bounds = this.root.getBoundingClientRect();
					const at = Math.max(0, Math.min(1, (clientY - bounds.top) / Math.max(1, bounds.height)));
					scroll.scrollTop = at * (scroll.scrollHeight || 0) - scroll.clientHeight / 2;
				};
				to(event.clientY);
				const move = (e: MouseEvent): void => to(e.clientY);
				const up = (): void => {
					document.removeEventListener('mousemove', move);
					document.removeEventListener('mouseup', up);
				};
				document.addEventListener('mousemove', move);
				document.addEventListener('mouseup', up);
			});
		}

		private draw(): void {
			const view = this.view;
			const on = settings.minimap;
			view.dom.classList.toggle('has-minimap', on);
			this.root.style.display = on ? '' : 'none';
			if (!on) return;
			const context = this.canvas.getContext('2d');
			if (!context) return; // jsdom without the canvas package
			const width = 84;
			const row = 2;
			const height = Math.max(40, view.scrollDOM.clientHeight || 200);
			const lines = view.state.doc.lines;
			// The stride is what keeps the draw cheap: never more rows than fit the height.
			const stride = Math.max(1, Math.ceil((lines * row) / height));
			const drawn = Math.ceil(lines / stride);
			this.canvas.width = width;
			this.canvas.height = drawn * row;
			this.canvas.style.width = `${width}px`;
			this.canvas.style.height = `${drawn * row}px`;
			const foreground = getComputedStyle(view.dom).getPropertyValue('--vscode-editor-foreground').trim() || '#cccccc';
			for (let i = 0; i < drawn; i++) {
				const text = view.state.doc.line(1 + i * stride).text;
				if (isBlank(text)) continue;
				const trimmed = text.trimStart();
				const indent = text.length - trimmed.length;
				const comment = /^(\/\/|#|\*|\/\*|<!--)/.test(trimmed);
				context.fillStyle = foreground;
				context.globalAlpha = comment ? 0.22 : 0.45;
				// Words become bars, blanks become gaps: the classic minimap silhouette.
				let x = Math.min(60, indent * 1.2);
				for (const word of trimmed.split(/(\s+)/)) {
					if (!word) continue;
					if (/\s/.test(word)) {
						x += word.length * 1.1;
						if (x > width - 6) break;
						continue;
					}
					const w = Math.min(width - 6 - x, word.length * 1.1);
					if (w <= 0) break;
					context.fillRect(x, i * row + 0.5, w, 1);
					x += w + 1.5;
				}
			}
			context.globalAlpha = 1;
			this.updateSlider();
		}

		/** Place the viewport slider over the painted map (the cheap path scrolling takes). */
		private updateSlider(): void {
			const scroll = this.view.scrollDOM;
			const total = scroll.scrollHeight || 1;
			const mapHeight = this.canvas.height || 1;
			const scale = mapHeight / total;
			this.slider.style.top = `${scroll.scrollTop * scale}px`;
			this.slider.style.height = `${Math.max(12, scroll.clientHeight * scale)}px`;
		}
	}
	return ViewPlugin.fromClass(Minimap);
}

/* ---------- Smooth wheel scrolling ---------- */

/** VS Code's `editor.smoothScrolling` for every CodeMirror surface: the shared wheel glide
 *  (ui.ts) attached to the view's scroll DOM, alive exactly as long as the view. A plugin —
 *  not a `domEventHandlers` entry — so the listener covers the gutters too and CodeMirror's
 *  own destroy unmounts it with the editor. */
export function smoothWheelExtension(): Extension {
	return ViewPlugin.fromClass(class {
		private readonly handle: SmoothWheelHandle;

		constructor(view: EditorView) {
			this.handle = attachSmoothWheel(view.scrollDOM, {
				enabled: () => settings.smoothScrolling,
				sensitivity: () => settings.mouseWheelScrollSensitivity,
				fastSensitivity: () => settings.fastScrollSensitivity
			});
		}

		destroy(): void {
			this.handle.dispose();
		}
	});
}
