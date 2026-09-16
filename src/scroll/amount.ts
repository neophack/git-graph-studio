// A scroll distance in the units a keyboard command speaks: lines or pages. Zed's
// `ScrollAmount` (crates/editor/src/scroll/scroll_amount.rs): a full page is one line short
// of the viewport, so the last line of the old screen is the first of the new — the anchor
// line the eye follows across the jump.

export type ScrollAmount =
	/** N lines, positive towards the document's end. */
	| { kind: 'line'; count: number }
	/** N pages, positive towards the document's end. */
	| { kind: 'page'; count: number };

/** A full page: exactly ±1 page (a half page keeps its exact fraction of the viewport). */
export function isFullPage(amount: ScrollAmount): boolean {
	return amount.kind === 'page' && Math.abs(amount.count) === 1;
}

/** How many lines the amount moves at a viewport of `visibleLines` (fractional) lines: a
 *  full page leaves one anchor line, and pages truncate to whole lines so repeated pages
 *  never drift by a fraction. */
export function scrollAmountLines(amount: ScrollAmount, visibleLines: number): number {
	if (amount.kind === 'line') return amount.count;
	const lines = isFullPage(amount) ? visibleLines - 1 : visibleLines;
	return Math.trunc(lines * amount.count);
}
