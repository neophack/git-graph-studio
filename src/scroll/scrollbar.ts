// A drawn vertical scrollbar over a ScrollModel — the surfaces it sits on scroll nothing
// natively, so the browser draws none. Zed's `ScrollbarLayout` (crates/editor/src/element.rs):
// the thumb is the viewport's share of the track, never shorter than a grab, and one row
// is the track left over divided by the rows that can scroll; a drag maps the pointer's
// pixels back through that unit.

import { el } from '../ui';
import type { ScrollModel } from './model';

/** The shortest thumb (Zed's `MIN_THUMB_SIZE`): a million-row document still shows a grab. */
export const MIN_THUMB_PX = 25;

export interface ScrollbarGeometry {
	/** The track's length in pixels. */
	track: number;
	/** The thumb's length in pixels. */
	thumb: number;
	/** The thumb's offset from the track's start. */
	offset: number;
	/** Track pixels per row (Zed's `text_unit_size`); 0 when nothing scrolls. */
	pxPerRow: number;
}

/** The thumb for a model on a track of `track` pixels. `null` when the document fits. */
export function scrollbarGeometry(model: ScrollModel, track: number): ScrollbarGeometry | null {
	const max = model.maxScrollTop();
	if (track <= 0 || max <= 0 || model.visibleLines <= 0) return null;
	// The thumb's share of the track is the viewport's share of the scrollable whole (the
	// rows the top may pass, plus the viewport itself).
	const share = model.visibleLines / (max + model.visibleLines);
	const thumb = Math.min(track, Math.max(MIN_THUMB_PX, track * share));
	const pxPerRow = (track - thumb) / max;
	return { track, thumb, offset: model.top * pxPerRow, pxPerRow };
}

export class Scrollbar {
	readonly root: HTMLElement;
	private readonly thumb: HTMLElement;
	private readonly unlisten: () => void;
	private readonly sizer: ResizeObserver | null;
	/** While dragging: the pointer's offset inside the thumb at the grab. */
	private grab: number | null = null;
	private trackLengthOverride: number | null = null;

	constructor(host: HTMLElement, private readonly model: ScrollModel) {
		this.thumb = el('div', 'scrollbar-thumb');
		this.root = el('div', 'scrollbar vertical', [this.thumb]);
		host.appendChild(this.root);
		this.unlisten = model.onChange(() => this.layout());
		this.sizer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => this.layout());
		this.sizer?.observe(this.root);
		this.thumb.addEventListener('pointerdown', (event) => this.onThumbDown(event));
		this.root.addEventListener('pointerdown', (event) => this.onTrackDown(event));
		this.root.addEventListener('pointermove', (event) => this.onMove(event));
		this.root.addEventListener('pointerup', (event) => this.onUp(event));
		this.root.addEventListener('pointercancel', (event) => this.onUp(event));
		this.layout();
	}

	/** The track length, for a test DOM that lays nothing out. */
	setTrackLength(px: number | null): void {
		this.trackLengthOverride = px;
		this.layout();
	}

	get trackLength(): number {
		return this.trackLengthOverride ?? this.root.clientHeight;
	}

	geometry(): ScrollbarGeometry | null {
		return scrollbarGeometry(this.model, this.trackLength);
	}

	layout(): void {
		const geometry = this.geometry();
		if (!geometry) {
			this.root.classList.add('idle');
			this.thumb.style.height = '0px';
			return;
		}
		this.root.classList.remove('idle');
		this.thumb.style.height = `${geometry.thumb}px`;
		this.thumb.style.transform = `translateY(${Math.round(geometry.offset)}px)`;
	}

	private onThumbDown(event: PointerEvent): void {
		if (event.button !== 0) return;
		const geometry = this.geometry();
		if (!geometry) return;
		event.preventDefault();
		event.stopPropagation();
		this.grab = event.clientY - this.root.getBoundingClientRect().top - geometry.offset;
		this.root.classList.add('dragging');
		// A test DOM has no pointer capture; a browser keeps the drag past the track's edge.
		if (typeof this.root.setPointerCapture === 'function') this.root.setPointerCapture(event.pointerId);
	}

	/** A press on the track outside the thumb pages towards the pointer. */
	private onTrackDown(event: PointerEvent): void {
		if (event.button !== 0 || this.grab !== null) return;
		const geometry = this.geometry();
		if (!geometry) return;
		event.preventDefault();
		const y = event.clientY - this.root.getBoundingClientRect().top;
		this.model.scrollScreen({ kind: 'page', count: y < geometry.offset ? -1 : 1 });
	}

	private onMove(event: PointerEvent): void {
		if (this.grab === null) return;
		const geometry = this.geometry();
		if (!geometry || geometry.pxPerRow <= 0) return;
		const y = event.clientY - this.root.getBoundingClientRect().top - this.grab;
		this.model.setTop(y / geometry.pxPerRow, 'user');
	}

	private onUp(event: PointerEvent): void {
		if (this.grab === null) return;
		this.grab = null;
		this.root.classList.remove('dragging');
		if (typeof this.root.hasPointerCapture === 'function' && this.root.hasPointerCapture(event.pointerId)) this.root.releasePointerCapture(event.pointerId);
	}

	dispose(): void {
		this.unlisten();
		this.sizer?.disconnect();
		this.root.remove();
	}
}
