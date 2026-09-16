// The DOM listeners that drive a ScrollModel: the wheel and the page keys. The surfaces
// that mount them scroll nothing natively (`overflow-y: hidden`), so every wheel event is
// taken over and lands as a model move — at once, the way Zed's editor scrolls: no easing,
// one notch is the system's lines per notch. Chromium already delivers wheel events aligned
// to the frame, so a move per event is a move per frame.

import { settings } from '../settings';
import type { ScrollModel } from './model';
import { OngoingScroll, wheelToDelta } from './wheel';

export interface Disposable {
	dispose(): void;
}

export interface WheelOptions {
	/** The multiplier on the wheel's distance (Zed's `scroll_sensitivity`). Read live, so a
	 *  settings change applies to the next notch. Absent: the app setting. */
	sensitivity?: () => number;
	/** The multiplier Alt holds (Zed's `fast_scroll_sensitivity`). Absent: the app setting. */
	fastSensitivity?: () => number;
	/** Where the horizontal distance goes (pixels, sensitivity applied). Absent: the element's
	 *  own `scrollLeft` — the surfaces keep native horizontal overflow, whose width no
	 *  document reaches the engines' layout limit with. */
	horizontal?: (px: number) => void;
}

/** Take the wheel over `element` into the model. Ctrl/Meta chords pass through (the
 *  workbench's zoom keys); Shift turns a vertical notch horizontal where the browser did
 *  not already (Chromium swaps the axes itself, Firefox does not). */
export function attachWheel(element: HTMLElement, model: ScrollModel, options: WheelOptions = {}): Disposable {
	const sensitivity = options.sensitivity ?? (() => settings.mouseWheelScrollSensitivity);
	const fastSensitivity = options.fastSensitivity ?? (() => settings.fastScrollSensitivity);
	const horizontal = options.horizontal ?? ((px: number) => { element.scrollLeft += px; });
	const gesture = new OngoingScroll();
	function onWheel(event: WheelEvent): void {
		if (event.defaultPrevented || event.ctrlKey || event.metaKey) return;
		let delta = wheelToDelta(event);
		if (event.shiftKey && delta.x === 0 && delta.y !== 0) delta = { kind: delta.kind, x: delta.y, y: 0 };
		// A trackpad gesture keeps to the axis it started on.
		if (delta.kind === 'pixels') delta = { kind: 'pixels', ...gesture.filter({ x: delta.x, y: delta.y }) };
		event.preventDefault();
		const speed = Math.max(0.01, event.altKey ? fastSensitivity() : sensitivity());
		if (delta.y !== 0) model.applyWheel({ kind: delta.kind, x: 0, y: delta.y }, speed);
		if (delta.x !== 0) horizontal((delta.kind === 'lines' ? delta.x * model.rowHeight : delta.x) * speed);
	}
	element.addEventListener('wheel', onWheel, { passive: false });
	return {
		dispose(): void {
			element.removeEventListener('wheel', onWheel);
		}
	};
}

/** PageUp / PageDown on a caret-less surface: one page each (a viewport less the anchor
 *  line — Zed's `scroll_screen(Page(±1))`). Ctrl/Meta/Alt chords pass through (Ctrl+PageUp/
 *  Down are the workbench's editor-tab keys); Shift pages too, there being no selection to
 *  extend. The element is made focusable if it is not, or the keys would never reach it. */
export function attachPageKeys(element: HTMLElement, model: ScrollModel): Disposable {
	if (!element.hasAttribute('tabindex')) element.tabIndex = 0;
	function onKeydown(event: KeyboardEvent): void {
		if (event.key !== 'PageUp' && event.key !== 'PageDown') return;
		if (event.ctrlKey || event.metaKey || event.altKey) return;
		if (model.viewportHeight <= 0) return;
		event.preventDefault();
		model.scrollScreen({ kind: 'page', count: event.key === 'PageDown' ? 1 : -1 });
	}
	element.addEventListener('keydown', onKeydown);
	return {
		dispose(): void {
			element.removeEventListener('keydown', onKeydown);
		}
	};
}
