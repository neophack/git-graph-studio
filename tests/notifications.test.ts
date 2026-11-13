// The notification centre (M3 3.12): every toast joins the centre, the status bar's bell
// counts it, the panel lists the entries newest-first, and each row (or Clear All) clears.
// Unimportant toasts (info, no buttons) show a countdown bar and close themselves when it
// runs out — paused on hover and while the user holds a selection inside; important ones
// (warning / error / buttons) keep until the user closes them.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StatusBar } from '../src/workbench/statusbar';
import { clearAllNotifications, INFO_TOAST_MS, notify, notificationEntries } from '../src/platform/ui';
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

describe('the toasts' + ' countdown', () => {
	beforeEach(() => {
		clearAllNotifications();
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('an info toast carries a countdown bar and closes itself when it runs out', () => {
		notify('info', 'Build finished');
		const toast = document.querySelector('.notification')!;
		const bar = toast.querySelector('.countdown') as HTMLElement;
		expect(bar).not.toBeNull();
		// The bar drains as the countdown runs.
		vi.advanceTimersByTime(2000);
		const drained = Number.parseFloat(bar.style.width);
		expect(drained).toBeGreaterThan(60);
		expect(drained).toBeLessThan(90);
		vi.advanceTimersByTime(INFO_TOAST_MS + 500);
		expect(document.querySelector('.notification')).toBeNull();
		// It joined the centre before closing, so the message is not lost.
		expect(notificationEntries().map((entry) => entry.message)).toEqual(['Build finished']);
	});

	it('warning and button toasts are important: no bar, no auto-dismiss', () => {
		notify('warning', 'Disk almost full');
		notify('info', 'Pick one', [{ label: 'OK', run: () => undefined }]);
		const toasts = [...document.querySelectorAll('.notification')];
		expect(toasts).toHaveLength(2);
		for (const toast of toasts) expect(toast.querySelector('.countdown')).toBeNull();
		vi.advanceTimersByTime(INFO_TOAST_MS * 3);
		expect(document.querySelectorAll('.notification')).toHaveLength(2);
	});

	it('the countdown pauses while the pointer is over the toast', () => {
		notify('info', 'Hover keeps me');
		const toast = document.querySelector('.notification')!;
		toast.dispatchEvent(new MouseEvent('mouseenter'));
		vi.advanceTimersByTime(INFO_TOAST_MS * 2);
		expect(document.querySelector('.notification')).not.toBeNull();
		toast.dispatchEvent(new MouseEvent('mouseleave'));
		vi.advanceTimersByTime(INFO_TOAST_MS + 500);
		expect(document.querySelector('.notification')).toBeNull();
	});

	it('the countdown pauses while the user holds a selection inside the toast (copying)', () => {
		notify('info', 'Select and copy this message.');
		const toast = document.querySelector('.notification')!;
		const body = toast.querySelector('.message')!;
		const range = document.createRange();
		range.selectNodeContents(body);
		document.getSelection()?.removeAllRanges();
		document.getSelection()?.addRange(range);
		vi.advanceTimersByTime(INFO_TOAST_MS * 2);
		expect(document.querySelector('.notification')).not.toBeNull();
		document.getSelection()?.removeAllRanges();
		vi.advanceTimersByTime(INFO_TOAST_MS + 500);
		expect(document.querySelector('.notification')).toBeNull();
	});
});
