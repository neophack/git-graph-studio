// Zero-dependency shared state for Source-Insight-style multi-color persistent word
// highlights (6 palette slots shared across all open editors). Kept separate from
// CodeMirror so the workbench boot closure never pulls in @codemirror/*.

export const HIGHLIGHT_SLOT_COUNT = 6;

const pinnedWords = new Map<string, number>();
let nextSlot = 0;
const listeners = new Set<() => void>();

export function activeWordHighlights(): { word: string; slot: number }[] {
	return [...pinnedWords.entries()].map(([word, slot]) => ({ word, slot }));
}

export function wordHighlightSlot(word: string): number | undefined {
	return pinnedWords.get(word);
}

export function hasWordHighlights(): boolean {
	return pinnedWords.size > 0;
}

/** Toggle a word in the shared multi-color highlight palette. Returns its assigned slot
 *  (0..5) when added, or `null` when removed. */
export function toggleWordHighlight(word: string): number | null {
	const trimmed = word.trim();
	if (!trimmed) return null;
	if (pinnedWords.has(trimmed)) {
		pinnedWords.delete(trimmed);
		notify();
		return null;
	}
	const used = new Set(pinnedWords.values());
	let slot = nextSlot % HIGHLIGHT_SLOT_COUNT;
	for (let i = 0; i < HIGHLIGHT_SLOT_COUNT; i++) {
		const cand = (nextSlot + i) % HIGHLIGHT_SLOT_COUNT;
		if (!used.has(cand)) {
			slot = cand;
			break;
		}
	}
	nextSlot = (slot + 1) % HIGHLIGHT_SLOT_COUNT;
	pinnedWords.set(trimmed, slot);
	notify();
	return slot;
}

export function clearWordHighlights(): void {
	if (pinnedWords.size === 0) return;
	pinnedWords.clear();
	nextSlot = 0;
	notify();
}

export function subscribeWordHighlights(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

function notify(): void {
	for (const fn of listeners) {
		try {
			fn();
		} catch {
			// ignore detached editor listeners
		}
	}
}
