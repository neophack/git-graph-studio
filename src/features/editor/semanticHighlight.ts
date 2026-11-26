// Source-Insight-grade editor visual aids (Areas 3 & 4):
// 1. Semantic syntax coloring over the live SymbolStore (`symbol_semantic_kinds`, zero disk I/O)
// 2. Multi-color persistent word highlights (6 color slots shared across all open editors)
// 3. C/C++ conditional compilation dead-branch dimming (`symbol_inactive_ranges`)

import { RangeSetBuilder, StateEffect, StateField, type Extension } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import {
	symbolInactiveRanges,
	symbolSemanticKinds,
	type InactiveRange
} from '../../platform/ipc/symbols';
import {
	hasWordHighlights,
	subscribeWordHighlights,
	wordHighlightSlot
} from './wordHighlightState';

/* ---------- Effects & Decoration StateFields ---------- */

const setSemanticKindsEffect = StateEffect.define<Record<string, string>>();
const setInactiveRangesEffect = StateEffect.define<InactiveRange[]>();
const refreshHighlightsEffect = StateEffect.define<void>();

const SEMANTIC_CLASS: Record<string, string> = {
	macro: 'cm-sem-macro',
	class: 'cm-sem-type',
	struct: 'cm-sem-type',
	interface: 'cm-sem-type',
	enum: 'cm-sem-type',
	type: 'cm-sem-type',
	module: 'cm-sem-type',
	constant: 'cm-sem-const',
	function: 'cm-sem-fn',
	method: 'cm-sem-fn',
	field: 'cm-sem-field',
	variable: 'cm-sem-var'
};

const semanticKindsField = StateField.define<Record<string, string>>({
	create: () => ({}),
	update(value, tr) {
		for (const e of tr.effects) {
			if (e.is(setSemanticKindsEffect)) return e.value;
		}
		return value;
	}
});

const inactiveRangesField = StateField.define<InactiveRange[]>({
	create: () => [],
	update(value, tr) {
		for (const e of tr.effects) {
			if (e.is(setInactiveRangesEffect)) return e.value;
		}
		return value;
	}
});

const CPP_EXTS = new Set(['c', 'h', 'cpp', 'hpp', 'cc', 'hh', 'cxx', 'hxx', 'ipp', 'inc']);

function isCppFile(fileName: string): boolean {
	const dot = fileName.lastIndexOf('.');
	if (dot === -1) return false;
	return CPP_EXTS.has(fileName.slice(dot + 1).toLowerCase());
}

function collectViewportIdentifiers(view: EditorView): string[] {
	const seen = new Set<string>();
	for (const { from, to } of view.visibleRanges) {
		const slice = view.state.sliceDoc(from, Math.min(to, from + 32_000));
		for (const m of slice.matchAll(/\b[A-Za-z_][A-Za-z0-9_]{1,63}\b/g)) {
			seen.add(m[0]);
			if (seen.size >= 400) return [...seen];
		}
	}
	return [...seen];
}

function buildDecorations(view: EditorView): DecorationSet {
	const kinds = view.state.field(semanticKindsField);
	const inactive = view.state.field(inactiveRangesField);
	const hasSemantics = Object.keys(kinds).length > 0;
	const hasPinned = hasWordHighlights();

	const decos: { from: number; to: number; deco: Decoration }[] = [];

	// 1. Inactive preprocessor lines
	for (const range of inactive) {
		const firstLine = Math.max(1, range.startLine + 1);
		const lastLine = Math.min(view.state.doc.lines, range.endLine + 1);
		for (let ln = firstLine; ln <= lastLine; ln++) {
			const line = view.state.doc.line(ln);
			decos.push({ from: line.from, to: line.from, deco: Decoration.line({ class: 'cm-inactive-branch' }) });
		}
	}

	// 2. Visible-range identifier decorations (semantic coloring + multi-color highlights)
	if (hasSemantics || hasPinned) {
		for (const { from, to } of view.visibleRanges) {
			const slice = view.state.sliceDoc(from, Math.min(to, from + 48_000));
			const re = /\b[A-Za-z_][A-Za-z0-9_]{1,63}\b/g;
			let m: RegExpExecArray | null;
			while ((m = re.exec(slice)) !== null) {
				const word = m[0];
				const start = from + m.index;
				const end = start + word.length;
				const slot = wordHighlightSlot(word);
				if (slot !== undefined) {
					decos.push({ from: start, to: end, deco: Decoration.mark({ class: `cm-hl-slot cm-hl-slot-${slot}` }) });
				}
				const kind = kinds[word];
				const cls = kind ? SEMANTIC_CLASS[kind] : undefined;
				if (cls) {
					decos.push({ from: start, to: end, deco: Decoration.mark({ class: cls }) });
				}
			}
		}
	}

	decos.sort((a, b) => a.from - b.from || a.to - b.to);
	const builder = new RangeSetBuilder<Decoration>();
	for (const item of decos) {
		builder.add(item.from, item.to, item.deco);
	}
	return builder.finish();
}

function createSemanticPlugin(fileName: string): Extension {
	const cpp = isCppFile(fileName);
	return ViewPlugin.fromClass(
		class {
			decorations: DecorationSet;
			private semTimer: ReturnType<typeof setTimeout> | null = null;
			private preprocTimer: ReturnType<typeof setTimeout> | null = null;
			private destroyed = false;
			private readonly unsubscribe: () => void;

			constructor(private readonly view: EditorView) {
				this.decorations = buildDecorations(view);
				this.unsubscribe = subscribeWordHighlights(() => {
					if (this.destroyed) return;
					this.view.dispatch({ effects: refreshHighlightsEffect.of(undefined) });
				});
				this.scheduleSemantics();
				if (cpp) this.schedulePreprocessor();
			}

			update(update: ViewUpdate): void {
				const effectsChanged = update.transactions.some((tr) =>
					tr.effects.some(
						(e) =>
							e.is(setSemanticKindsEffect) ||
							e.is(setInactiveRangesEffect) ||
							e.is(refreshHighlightsEffect)
					)
				);
				if (update.docChanged || update.viewportChanged || effectsChanged) {
					this.decorations = buildDecorations(update.view);
				}
				if (update.docChanged || update.viewportChanged) {
					this.scheduleSemantics();
				}
				if (cpp && update.docChanged) {
					this.schedulePreprocessor();
				}
			}

			private scheduleSemantics(): void {
				if (this.semTimer) clearTimeout(this.semTimer);
				this.semTimer = setTimeout(() => {
					if (this.destroyed) return;
					const names = collectViewportIdentifiers(this.view);
					if (names.length === 0) return;
					void symbolSemanticKinds(names)
						.then((kinds) => {
							if (this.destroyed || !kinds || typeof kinds !== 'object') return;
							this.view.dispatch({ effects: setSemanticKindsEffect.of(kinds) });
						})
						.catch(() => undefined);
				}, 180);
			}

			private schedulePreprocessor(): void {
				if (this.preprocTimer) clearTimeout(this.preprocTimer);
				this.preprocTimer = setTimeout(() => {
					if (this.destroyed) return;
					if (this.view.state.doc.length > 512_000) return;
					void symbolInactiveRanges(this.view.state.doc.toString())
						.then((ranges) => {
							if (this.destroyed || !Array.isArray(ranges)) return;
							this.view.dispatch({ effects: setInactiveRangesEffect.of(ranges) });
						})
						.catch(() => undefined);
				}, 240);
			}

			destroy(): void {
				this.destroyed = true;
				this.unsubscribe();
				if (this.semTimer) clearTimeout(this.semTimer);
				if (this.preprocTimer) clearTimeout(this.preprocTimer);
			}
		},
		{ decorations: (v) => v.decorations }
	);
}

/** CodeMirror 6 extension bundle for semantic syntax coloring, multi-color persistent
 *  word highlights, and C/C++ conditional compilation dead-branch dimming. */
export function semanticHighlightExtension(fileName: string): Extension[] {
	return [semanticKindsField, inactiveRangesField, createSemanticPlugin(fileName)];
}
