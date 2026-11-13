// Notifications — VS Code's toasts — and the notification centre they join (the status
// bar's bell). A modal confirmation rides the same toast shape.

import { el } from './dom';
import { actionButton, icon } from './codicon';

export type NotificationKind = 'info' | 'warning' | 'error';

export interface NotificationAction {
	label: string;
	run: () => void;
}

/** One entry of the notification centre: what was shown, when, and whether it still has its
 *  toast on screen (an auto-dismissed info toast lives on in the centre). */
export interface CentreEntry {
	id: number;
	kind: NotificationKind;
	message: string;
	at: number;
}

const centre: CentreEntry[] = [];
let centreSeq = 1;
const centreListeners = new Set<(count: number) => void>();

/** React to the centre's size changing (the status bar's bell badge). */
export function onNotificationsChange(listener: (count: number) => void): () => void {
	centreListeners.add(listener);
	return () => centreListeners.delete(listener);
}

export function notificationEntries(): CentreEntry[] {
	return [...centre].reverse(); // newest first
}

export function clearNotification(id: number): void {
	const at = centre.findIndex((entry) => entry.id === id);
	if (at !== -1) centre.splice(at, 1);
	for (const listener of centreListeners) listener(centre.length);
}

export function clearAllNotifications(): void {
	centre.length = 0;
	for (const listener of centreListeners) listener(centre.length);
}

/** How long an unimportant (info, no buttons) toast stays before the countdown closes it.
 *  Warning and error toasts — and any toast with buttons — are important: they keep until
 *  the user closes them. */
export const INFO_TOAST_MS = 8000;
/** The countdown's redraw cadence; the bar is what makes the closing visible. */
const COUNTDOWN_TICK_MS = 100;

/** Post a toast. Unimportant ones (info, no buttons) show a countdown bar and close
 *  themselves when it runs out — paused while the pointer is over the toast or the user
 *  holds a selection inside it, so reading and copying are never interrupted. Important
 *  ones (warning, error, any toast with buttons) keep until the user closes them.
 *  `onDismiss` runs whenever the toast goes away - the close button, an action button, or
 *  the countdown - so callers can treat "dismissed without choosing" as cancel. The
 *  notification also joins the centre, where it stays until cleared. */
export function notify(kind: NotificationKind, message: string, actions: NotificationAction[] = [], onDismiss?: () => void): void {
	centre.push({ id: centreSeq++, kind, message, at: Date.now() });
	if (centre.length > 100) centre.shift(); // bounded, like the session log
	for (const listener of centreListeners) listener(centre.length);
	const container = document.getElementById('notifications')!;
	const body = el('div', 'message', [message]);
	const toast = el('div', 'notification', [icon(kind), el('div', 'body', [body])]);
	const close = actionButton('close', 'Clear Notification', () => dismiss());
	toast.appendChild(close);
	if (actions.length > 0) {
		const buttons = el('div', 'buttons');
		for (const action of actions) {
			const button = el('button', 'button', [action.label]);
			button.addEventListener('click', () => {
				action.run();
				dismiss();
			});
			buttons.appendChild(button);
		}
		toast.querySelector('.body')!.appendChild(buttons);
	}
	toast.querySelector<HTMLElement>('.body')!.style.flex = '1';
	toast.querySelector<HTMLElement>('.body')!.style.minWidth = '0';
	// The unimportant toast's countdown: a draining bar at the bottom edge. The tick holds
	// the clock (no time counted) while the pointer is over the toast or the user holds a
	// selection inside it — a toast the user is copying from must not close under them —
	// or while the page is hidden, and resumes by itself once they let go.
	const countsDown = kind === 'info' && actions.length === 0;
	let bar: HTMLElement | null = null;
	let remaining = INFO_TOAST_MS;
	let lastTick = 0;
	let ticking: number | null = null;
	let hovered = false;
	const selectionHeld = (): boolean => {
		const selection = document.getSelection();
		if (!selection || selection.isCollapsed) return false;
		const node = selection.anchorNode;
		return node !== null && toast.contains(node);
	};
	const tick = (): void => {
		const now = Date.now();
		if (hovered || selectionHeld() || document.hidden) {
			lastTick = now;
			return;
		}
		remaining -= now - lastTick;
		lastTick = now;
		if (remaining <= 0) {
			dismiss();
			return;
		}
		if (bar) bar.style.width = `${Math.max(0, (remaining / INFO_TOAST_MS) * 100)}%`;
	};
	function dismiss(): void {
		if (ticking !== null) window.clearInterval(ticking);
		document.removeEventListener('visibilitychange', onVisibility);
		toast.remove();
		onDismiss?.();
	}
	function onVisibility(): void {
		lastTick = Date.now();
	}
	if (countsDown) {
		bar = el('div', 'countdown');
		bar.style.width = '100%';
		toast.appendChild(bar);
		toast.addEventListener('mouseenter', () => {
			hovered = true;
		});
		toast.addEventListener('mouseleave', () => {
			hovered = false;
		});
		document.addEventListener('visibilitychange', onVisibility);
		lastTick = Date.now();
		ticking = window.setInterval(tick, COUNTDOWN_TICK_MS);
	}
	container.appendChild(toast);
}

/** A modal confirmation, drawn as a notification with buttons; resolves with the chosen label. */
export function confirmDialog(message: string, primary: string, kind: NotificationKind = 'warning'): Promise<boolean> {
	return new Promise((resolve) => {
		let settled = false;
		const settle = (value: boolean) => {
			if (!settled) {
				settled = true;
				resolve(value);
			}
		};
		// The toast's own close button (or any other dismissal) also cancels.
		notify(kind, message, [
			{ label: primary, run: () => settle(true) },
			{ label: 'Cancel', run: () => settle(false) }
		], () => settle(false));
	});
}
