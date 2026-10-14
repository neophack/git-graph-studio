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

/** Post a toast. `onDismiss` runs whenever the toast goes away - the close button, an action
 *  button, or the auto-timeout - so callers can treat "dismissed without choosing" as cancel.
 *  The notification also joins the centre, where it stays until cleared. */
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
	container.appendChild(toast);
	let timer: number | null = kind === 'info' && actions.length === 0 ? window.setTimeout(() => dismiss(), 8000) : null;
	function dismiss(): void {
		if (timer !== null) window.clearTimeout(timer);
		timer = null;
		toast.remove();
		onDismiss?.();
	}
	// Keep an info toast while the pointer is over it, then resume the auto-dismiss countdown.
	toast.addEventListener('mouseenter', () => {
		if (timer !== null) window.clearTimeout(timer);
		timer = null;
	});
	toast.addEventListener('mouseleave', () => {
		if (timer === null && kind === 'info' && actions.length === 0) {
			timer = window.setTimeout(() => dismiss(), 8000);
		}
	});
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
