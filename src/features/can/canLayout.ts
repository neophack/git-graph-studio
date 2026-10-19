// The CAN pages' responsive layer: the width watch that decides the wide dashboard from
// the narrow (phone) form, the coarse-pointer fact the touch row heights key on, the
// touch-drag scroller the raw trace browses with on a phone, and the bottom action sheet
// the narrow toolbar's ⋯ opens (2026-10-19, the owner's direction: 重写 can 页面，要适配
// 不同屏幕尺寸，要支持手机端显示，手机端风格沿用 git-graph-rs 的 mobile.css 设计语言).
//
// The width is the VIEW's own, read off its root — not the window's: an editor group's
// pane is the space the page actually gets, and a split desktop column answers narrow
// exactly like the phone's editor page does. The cut is 600px, the same line the remote
// shell draws between phone and tablet (responsive.ts's classifier), so the two vocabularies
// agree about what "narrow" is. jsdom lays nothing out (width 0): it stays wide there,
// which is the layout every existing suite asserts.
//
// The mobile visual language is mobile.css's, restated over the VS Code theme variables
// the editor already carries: flat fills and hairlines instead of borders, capsule
// controls, a 52px app bar, 44px touch targets, bottom sheets, pressed states replacing
// hover, and 16px text inputs (iOS zooms smaller ones on focus). The tokens and the sheet
// chrome live in shell.css; this file owns the behaviour.

import type { ScrollModel } from '../../scroll/model';
import type { Disposable } from '../../scroll/input';
import { el, icon } from '../../platform/ui/index';
import { t } from '../../platform/i18n';

/** The width under which a CAN page renders its narrow (phone) form. */
export const CAN_COMPACT_CUT = 600;

/** A coarse-pointer override, the replica-viewer hook responsive.ts carries for the PC
 *  window a phone drives; tests use it to choose the touch row heights. */
let pointerOverride: 'coarse' | 'fine' | null = null;

export function setCanPointerOverride(kind: 'coarse' | 'fine' | null): void {
	pointerOverride = kind;
}

/** Whether the pointer driving this page is a finger — the row heights and the pressed
 *  states key on it (a narrow desktop window keeps its precise rows). */
export function canCoarsePointer(): boolean {
	if (pointerOverride !== null) return pointerOverride === 'coarse';
	return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
}

/** The wide/narrow watch over one view root: `data-compact` (the CSS block's one key) and
 *  `data-pointer` (the touch row heights') are spelled on the root, and the change is
 *  published to the view so it can re-render what CSS cannot move (the chart viewBoxes,
 *  the toolbar's sheet membership). A real layout is required — width 0 (jsdom, a hidden
 *  pane mid-swap) is wide, never a flash of the narrow form. */
export class CanLayout {
	private compact = false;
	private readonly listeners = new Set<(compact: boolean) => void>();
	private readonly observer: ResizeObserver | null;

	constructor(private readonly root: HTMLElement, private readonly cut = CAN_COMPACT_CUT) {
		this.observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => this.check());
		this.observer?.observe(root);
		this.check();
	}

	get isCompact(): boolean {
		return this.compact;
	}

	/** Re-read the root's width and settle the form. Public because a scripted layout
	 *  (tests, an explicit relayout) has no resize event to ride. */
	check(): void {
		const width = this.root.getBoundingClientRect().width;
		const compact = width > 0 && width < this.cut;
		this.root.setAttribute('data-pointer', canCoarsePointer() ? 'coarse' : 'fine');
		if (compact === this.compact) return;
		this.compact = compact;
		this.root.toggleAttribute('data-compact', compact);
		for (const listener of this.listeners) listener(compact);
	}

	/** The form-factor change: the view re-renders its mode-shaped content. */
	onChange(listener: (compact: boolean) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	dispose(): void {
		this.observer?.disconnect();
		this.listeners.clear();
	}
}

/** A finger over the raw trace's viewport scrolls it: one pointer's vertical drag feeds
 *  the row model pixel-for-pixel (the wheel's trackpad path), and the lift's velocity
 *  coasts out in a decay loop — the momentum a natively scrolling list has and a
 *  model-positioned one must supply itself. Horizontal is the browser's (`touch-action:
 *  pan-x`, the data column's own overflow); mouse and wheel are untouched. */
export function attachTouchScroll(element: HTMLElement, model: ScrollModel): Disposable {
	let dragging = false;
	let lastY = 0;
	let lastT = 0;
	let velocity = 0; // px/ms, finger-positive down
	let coasting = 0;
	const stopCoast = (): void => {
		if (coasting) cancelAnimationFrame(coasting);
		coasting = 0;
	};
	const coast = (): void => {
		coasting = requestAnimationFrame(() => {
			coasting = 0;
			if (Math.abs(velocity) < 0.02) return;
			model.applyWheel({ kind: 'pixels', x: 0, y: -velocity * 16 }, 1);
			velocity *= 0.95;
			coast();
		});
	};
	const down = (event: PointerEvent): void => {
		if (event.pointerType === 'mouse') return;
		stopCoast();
		dragging = true;
		lastY = event.clientY;
		lastT = event.timeStamp;
		velocity = 0;
	};
	const move = (event: PointerEvent): void => {
		if (!dragging) return;
		const dt = event.timeStamp - lastT;
		const dy = event.clientY - lastY;
		model.applyWheel({ kind: 'pixels', x: 0, y: -dy }, 1);
		// The trailing speed, smoothed — one noisy sample must not fling the list. A
		// zero-delta sample (same stamp) still scrolls; it just carries no velocity.
		if (dt > 0) velocity = velocity * 0.7 + (dy / dt) * 0.3;
		lastY = event.clientY;
		lastT = event.timeStamp;
	};
	const up = (event: PointerEvent): void => {
		if (!dragging) return;
		dragging = false;
		// A finger that rested before lifting (the velocity window went stale) does not coast.
		if (event.timeStamp - lastT > 90) velocity = 0;
		if (Math.abs(velocity) > 0.05) coast();
	};
	element.addEventListener('pointerdown', down);
	element.addEventListener('pointermove', move);
	element.addEventListener('pointerup', up);
	element.addEventListener('pointercancel', up);
	return {
		dispose(): void {
			stopCoast();
			element.removeEventListener('pointerdown', down);
			element.removeEventListener('pointermove', move);
			element.removeEventListener('pointerup', up);
			element.removeEventListener('pointercancel', up);
		}
	};
}

/** One row of the bottom action sheet: a labelled control kept alive across opens (the
 *  toolbar's own select, moved in and out with the form), or a tap action with its icon
 *  and a check mark, or a divider between the groups. */
export type CanSheetItem =
	| { control: HTMLElement; label: string }
	| { action: () => void; label: string; iconName?: string; checked?: boolean }
	| { divider: true };

/** The bottom action sheet the narrow toolbar's ⋯ opens — mobile.css's context-menu
 *  pattern: a full scrim, a rounded sheet sliding up from the bottom edge (inset 8px,
 *  the safe area honoured), 50px rows with hairlines between them. Built into the view's
 *  own root, so it never escapes the editor pane it lives in; tapping the scrim closes. */
export class CanActionSheet {
	private readonly scrim: HTMLElement;
	private readonly panel: HTMLElement;
	private readonly title: HTMLElement;
	private readonly body: HTMLElement;
	private open_ = false;

	constructor(owner: HTMLElement) {
		this.title = el('div', 'can-sheet-title');
		this.body = el('div', 'can-sheet-body');
		this.panel = el('div', 'can-sheet', [el('div', 'can-sheet-grabber'), this.title, this.body]);
		this.scrim = el('div', 'can-sheet-scrim', [this.panel]);
		this.scrim.addEventListener('pointerdown', (event) => {
			if (event.target === this.scrim) this.close();
		});
		this.scrim.addEventListener('keydown', (event) => {
			if (event.key === 'Escape') {
				event.stopPropagation();
				this.close();
			}
		});
		this.scrim.hidden = true;
		owner.append(this.scrim);
	}

	get isOpen(): boolean {
		return this.open_;
	}

	/** Rebuild the sheet's rows and show it. A control row adopts the caller's node — the
	 *  node keeps its listeners and its state, wherever it currently lives. */
	open(title: string, items: CanSheetItem[]): void {
		this.title.textContent = title;
		const rows: HTMLElement[] = [];
		for (const item of items) {
			if ('divider' in item) {
				rows.push(el('div', 'can-sheet-divider'));
				continue;
			}
			if ('control' in item) {
				rows.push(el('div', 'can-sheet-row can-sheet-control', [el('span', 'can-sheet-label', [item.label]), item.control]));
				continue;
			}
			const row = el('div', 'can-sheet-row can-sheet-action', [
				item.iconName ? icon(item.iconName, 'can-sheet-icon') : el('span', 'can-sheet-icon'),
				el('span', 'can-sheet-label', [item.label]),
				item.checked ? icon('check', 'can-sheet-check') : el('span', 'can-sheet-check')
			]);
			row.setAttribute('role', 'button');
			row.setAttribute('tabindex', '0');
			row.addEventListener('click', () => {
				this.close();
				item.action();
			});
			rows.push(row);
		}
		this.body.replaceChildren(...rows);
		this.scrim.hidden = false;
		this.open_ = true;
	}

	close(): void {
		if (!this.open_) return;
		this.open_ = false;
		this.scrim.hidden = true;
	}

	dispose(): void {
		this.close();
		this.scrim.remove();
	}
}

/** The ⋯ the narrow toolbar carries in place of its wide actions (mobile.css's app-bar
 *  overflow): a 44px round target; what it opens is the caller's sheet, so the view owns
 *  which controls and actions the narrow form offers. Hidden by the CSS while wide. */
export function canMoreButton(onOpen: () => void): HTMLButtonElement {
	const button = el('button', 'button secondary can-more', [icon('ellipsis')]) as HTMLButtonElement;
	button.title = t('can.more');
	button.setAttribute('aria-label', t('can.more'));
	button.addEventListener('click', onOpen);
	return button;
}
