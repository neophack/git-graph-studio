// The toast countdown can outlive its DOM: a test file ends with a toast still armed, the
// jsdom environment teardown deletes the global document, and the interval's next tick
// must stop instead of throwing out of the worker — an unhandled error fails the whole
// run even with every test green (the 2026-11-16 Release run's only failure). The guard
// only has a surface in this pool: the threads pool's document is a configurable global
// the teardown deletes (the vm pool's is a getter-only binding the tests cannot remove),
// so this file runs beside extensions/editor/perf in vitest.config.ts's threads project.

import { describe, expect, it } from 'vitest';

import { clearAllNotifications, notify, notificationEntries } from '../src/platform/ui';

describe('the toast countdown against a torn-down DOM', () => {
	it('stops instead of throwing when the DOM is gone while a toast is still armed', async () => {
		clearAllNotifications();
		notify('info', 'Survives the teardown');
		const holder = globalThis as unknown as Record<string, unknown>;
		const doc = holder.document;
		const originalClear = holder.clearInterval as (id: unknown) => void;
		const cleared: unknown[] = [];
		holder.clearInterval = (id: unknown) => {
			cleared.push(id);
			originalClear(id);
		};
		delete holder.document;
		try {
			await new Promise((resolve) => setTimeout(resolve, 300)); // the tick interval is 100 ms
		} finally {
			holder.document = doc;
			holder.clearInterval = originalClear;
		}
		// The tick cleared its interval instead of dereferencing the missing document...
		expect(cleared.length).toBeGreaterThan(0);
		// ...and reaching here is the point: no unhandled ReferenceError crossed the run.
		expect(notificationEntries().map((entry) => entry.message)).toEqual(['Survives the teardown']);
	});

	it('stops when the whole environment is gone — window and clearInterval went with the document', async () => {
		// The 2026-11-18 Studio run's only failure: the guard against a deleted document
		// cleared through `window`, and the teardown deletes that beside the document —
		// the guard itself threw `window is not defined`, an unhandled error for the
		// worker. The tick must stop through its armed binding instead.
		clearAllNotifications();
		notify('info', 'Survives the whole teardown');
		const holder = globalThis as unknown as Record<string, unknown>;
		const doc = holder.document;
		const win = holder.window;
		const originalClear = holder.clearInterval as (id: unknown) => void;
		delete holder.document;
		delete holder.window;
		delete holder.clearInterval;
		try {
			await new Promise((resolve) => setTimeout(resolve, 300)); // the tick interval is 100 ms
		} finally {
			holder.document = doc;
			holder.window = win;
			holder.clearInterval = originalClear;
		}
		// Reaching here is the point: the tick cleared through the binding it kept at
		// arm time and threw nothing into the run.
		expect(notificationEntries().map((entry) => entry.message)).toEqual(['Survives the whole teardown']);
	});
});
