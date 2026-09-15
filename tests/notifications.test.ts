// The notification centre (M3 3.12): every toast joins the centre, the status bar's bell
// counts it, the panel lists the entries newest-first, and each row (or Clear All) clears.

import { beforeEach, describe, expect, it } from 'vitest';

import { StatusBar } from '../src/statusbar';
import { clearAllNotifications, notify, notificationEntries } from '../src/ui';
import { click, flush, texts } from './helpers';

describe('the notification centre', () => {
	beforeEach(() => {
		clearAllNotifications();
	});

	it('records toasts, counts them on the bell, and lists them newest first', () => {
		const host = document.createElement('div');
		document.body.appendChild(host);
		const bar = new StatusBar(host);
		notify('info', 'Saved main.rs');
		notify('error', 'Failed to save other.rs');
		expect(notificationEntries().map((entry) => entry.message)).toEqual(['Failed to save other.rs', 'Saved main.rs']);

		// The bell shows the count and opens the panel.
		const bell = document.querySelector('.status-right .status-item:last-child') as HTMLElement;
		expect(bell.querySelector('.bell-badge')!.textContent).toBe('2');
		click(bell);
		expect(texts('.notification-centre-row .message')).toEqual(['Failed to save other.rs', 'Saved main.rs']);
		expect(texts('.notification-centre-header .button')).toEqual(['Clear All']);

		// Clearing one row removes it; Clear All empties the centre and the panel.
		click(document.querySelector('.notification-centre-row .icon-button')!);
		expect(notificationEntries()).toHaveLength(1);
		click(document.querySelector('.notification-centre-header .button')!);
		expect(notificationEntries()).toHaveLength(0);
		expect(texts('.notification-centre-empty')).toEqual(['No notifications']);
	});

	it('an auto-dismissed info toast stays in the centre', async () => {
		const host = document.createElement('div');
		document.body.appendChild(host);
		new StatusBar(host);
		notify('info', 'Recovered 1 unsaved file');
		await flush(12); // the 8 s auto-dismiss is far away; the toast is still on screen
		expect(notificationEntries()).toHaveLength(1);
		clearAllNotifications();
		expect(notificationEntries()).toHaveLength(0);
	});
});
