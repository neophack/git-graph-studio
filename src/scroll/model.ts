// The scroll position of a row-based surface, owned here and not by the browser: a floating
// row index for the viewport's top, clamped to the document, and the operations every
// viewer performs on it. The surfaces render `visibleRange()` and place each row at
// `rowTop(row)`; nothing scrolls natively, so no document is too tall for the layout engine
// and no scroll event ever moves the view but the ones this model publishes.
//
// Zed: `ScrollManager` and `Editor::{set_scroll_position, scroll_screen,
// autoscroll_vertically}` (crates/editor/src/scroll.rs, scroll/autoscroll.rs). The scroll
// anchor's buffer position is not carried — a row index is the anchor on a surface whose
// rows only change under the editable window, which maps the offset itself.

import { type ScrollAmount, scrollAmountLines } from './amount';
import { deltaToPixels, type ScrollDelta } from './wheel';

/** Why the position changed: a listener may fetch rows on every reason but only follows
 *  the caret on its own moves. */
export type ScrollReason =
	/** The wheel, the scrollbar, a page key: the user moved the viewport. */
	| 'user'
	/** The viewport moved to keep a caret, a match or a reveal target in view. */
	| 'autoscroll'
	/** The document or the viewport changed size and the position was clamped. */
	| 'layout';

/** How a row is brought into view (Zed's `AutoscrollStrategy`). */
export type AutoscrollStrategy =
	/** The minimal move that fits the row with the margin above and below; nothing when it
	 *  already fits. The caret's every move uses this. */
	| 'fit'
	/** `fit`, but for the newest of several selections — identical here, one row at a time. */
	| 'newest'
	/** The row at the viewport's middle: go-to-line, a find match. */
	| 'center'
	/** The row near the top, the margin above it. */
	| 'focused'
	/** The row on the viewport's first line. */
	| 'top'
	/** The row on the viewport's last line. */
	| 'bottom';

/** Whether the last row may scroll up to the viewport's top (`onePage`, Zed's default) or
 *  the document ends flush with the viewport's bottom (`off`). */
export type ScrollBeyondLastLine = 'onePage' | 'off';

/** The rows the viewport shows, inclusive, plus the fraction of a row the top one is cut by. */
export interface VisibleRange {
	first: number;
	last: number;
}

export type ScrollListener = (top: number, reason: ScrollReason) => void;

/** Zed's `vertical_scroll_margin`: the rows kept between the caret and the viewport's edge. */
export const VERTICAL_SCROLL_MARGIN = 3;

export class ScrollModel {
	/** The row at the viewport's top — fractional while a trackpad or a drag sits between rows. */
	private topRow = 0;
	private rows = 0;
	private height = 0;
	private rowPx: number;
	private readonly listeners = new Set<ScrollListener>();
	/** An autoscroll asked for before the viewport had a height (a reveal on open, the
	 *  pane not yet laid out): applied by the first layout, the way Zed's autoscroll
	 *  request waits for the prepaint that knows the bounds. */
	private pendingAutoscroll: { row: number; strategy: AutoscrollStrategy; reason: ScrollReason } | null = null;
	/** The margin `fit` keeps above and below the target row. */
	verticalScrollMargin = VERTICAL_SCROLL_MARGIN;
	beyondLastLine: ScrollBeyondLastLine = 'onePage';

	constructor(rowHeight: number, rowCount = 0) {
		this.rowPx = Math.max(1, rowHeight);
		this.rows = Math.max(0, rowCount);
	}

	get top(): number {
		return this.topRow;
	}

	get rowCount(): number {
		return this.rows;
	}

	get rowHeight(): number {
		return this.rowPx;
	}

	/** The viewport's height in pixels, as last laid out (0 before the first layout). */
	get viewportHeight(): number {
		return this.height;
	}

	/** The viewport in rows, fractional (Zed's `visible_line_count`). */
	get visibleLines(): number {
		return this.height / this.rowPx;
	}

	/** The whole rows a caret can page by: one fewer than fit (`visible_row_count`), never
	 *  below one. */
	get visibleRows(): number {
		return Math.max(1, Math.floor(this.visibleLines) - 1);
	}

	/** The last position the top may take: the last row itself with `onePage`, else the
	 *  position that puts the last row on the viewport's bottom line. */
	maxScrollTop(): number {
		if (this.rows === 0) return 0;
		if (this.beyondLastLine === 'onePage' || this.height === 0) return this.rows - 1;
		return Math.max(0, this.rows - this.visibleLines);
	}

	/** A position within the document's range. */
	clamp(top: number): number {
		if (!Number.isFinite(top)) return this.topRow;
		return Math.max(0, Math.min(this.maxScrollTop(), top));
	}

	/** Move the viewport's top; true when it moved (Zed's `WasScrolled`). */
	setTop(top: number, reason: ScrollReason = 'user'): boolean {
		// A move of any kind supersedes a reveal still waiting for a layout (Zed's
		// `set_anchor` takes the autoscroll request).
		if (reason !== 'layout') this.pendingAutoscroll = null;
		const next = this.clamp(top);
		if (next === this.topRow) return false;
		this.topRow = next;
		this.emit(reason);
		return true;
	}

	scrollBy(lines: number, reason: ScrollReason = 'user'): boolean {
		return this.setTop(this.topRow + lines, reason);
	}

	/** A keyboard scroll (Zed's `scroll_screen`): N lines or N pages, a full page one row
	 *  short of the viewport. */
	scrollScreen(amount: ScrollAmount): boolean {
		return this.scrollBy(scrollAmountLines(amount, this.visibleLines), 'user');
	}

	/** Apply a wheel delta (Zed's `paint_scroll_wheel_listener`): lines multiply by the row
	 *  height, pixels pass through, the sensitivity scales the pixels, and the new top is the
	 *  old one plus that distance in rows — direct, no easing. True when the view moved, so
	 *  a caller can tell a notch that hit the edge from one that scrolled. */
	applyWheel(delta: ScrollDelta, sensitivity = 1): boolean {
		const speed = Math.max(0.01, sensitivity);
		const px = deltaToPixels(delta, this.rowPx);
		if (px.y === 0) return false;
		return this.setTop(this.topRow + (px.y * speed) / this.rowPx, 'user');
	}

	/** The document's row count changed (a resync, a parse growing, an edit): the position
	 *  is clamped to the new range and the listeners hear of it only when it moved. */
	setRowCount(count: number): void {
		this.rows = Math.max(0, Math.floor(count));
		this.reclamp();
	}

	/** The viewport was laid out `heightPx` tall. A zero height is no layout at all (a
	 *  hidden pane, a test DOM) and leaves the last known height standing. */
	setViewport(heightPx: number): void {
		const height = Math.max(0, heightPx);
		if (height === 0 || height === this.height) return;
		this.height = height;
		this.reclamp();
		const pending = this.pendingAutoscroll;
		if (pending) {
			this.pendingAutoscroll = null;
			this.autoscroll(pending.row, pending.strategy, pending.reason);
		}
	}

	setRowHeight(px: number): void {
		const height = Math.max(1, px);
		if (height === this.rowPx) return;
		this.rowPx = height;
		this.reclamp();
	}

	private reclamp(): void {
		const next = this.clamp(this.topRow);
		if (next !== this.topRow) {
			this.topRow = next;
			this.emit('layout');
		}
	}

	/** Scroll so `row` sits where the strategy says (Zed's `autoscroll_vertically` for one
	 *  target row): `fit` moves only when the row and its margin are outside the viewport,
	 *  and then by the least amount; the others place it. */
	autoscroll(row: number, strategy: AutoscrollStrategy = 'fit', reason: ScrollReason = 'autoscroll'): boolean {
		const visible = this.visibleLines;
		if (visible <= 0) {
			this.pendingAutoscroll = { row, strategy, reason };
			return false;
		}
		const target = Math.max(0, Math.min(this.rows > 0 ? this.rows - 1 : 0, Math.floor(row)));
		const targetBottom = target + 1;
		// Half the viewport less the row: the margin a centred row has on either side.
		const margin = Math.floor((visible - 1) / 2);
		switch (strategy) {
			case 'fit':
			case 'newest': {
				const keep = Math.min(margin, this.verticalScrollMargin);
				const top = Math.max(0, target - keep);
				const bottom = targetBottom + keep;
				const start = this.topRow;
				const end = start + visible;
				const needsUp = top < start;
				const needsDown = bottom >= end;
				if (needsUp && !needsDown) return this.setTop(top, reason);
				if (!needsUp && needsDown) return this.setTop(bottom - visible, reason);
				return false;
			}
			case 'center':
				return this.setTop(Math.max(0, target - margin), reason);
			case 'focused':
				return this.setTop(Math.max(0, target - Math.min(margin, this.verticalScrollMargin)), reason);
			case 'top':
				return this.setTop(target, reason);
			case 'bottom':
				return this.setTop(Math.max(0, targetBottom - visible), reason);
		}
	}

	/** Whether `row` is wholly inside the viewport. */
	isRowVisible(row: number): boolean {
		return row >= this.topRow && row + 1 <= this.topRow + this.visibleLines;
	}

	/** The rows a render pass must place: from the row the top cuts through to the one the
	 *  bottom cuts through, `overscan` more on each side, inside the document. Empty
	 *  (`last < first`) for an empty document. */
	visibleRange(overscan = 0): VisibleRange {
		if (this.rows === 0) return { first: 0, last: -1 };
		const first = Math.max(0, Math.floor(this.topRow) - overscan);
		const last = Math.min(this.rows - 1, Math.ceil(this.topRow + this.visibleLines) + overscan);
		return { first, last: Math.max(first - 1, last) };
	}

	/** The pixel offset of `row`'s top edge from the viewport's top: negative above it. The
	 *  position is snapped to whole pixels the way Zed snaps `scroll_position.y` to the
	 *  device grid, so text never lands on a half pixel and blurs. */
	rowTop(row: number): number {
		return row * this.rowPx - Math.round(this.topRow * this.rowPx);
	}

	/** The row under a pixel offset from the viewport's top. */
	rowAt(offsetPx: number): number {
		return Math.floor(this.topRow + offsetPx / this.rowPx);
	}

	onChange(listener: ScrollListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private emit(reason: ScrollReason): void {
		for (const listener of this.listeners) listener(this.topRow, reason);
	}
}
