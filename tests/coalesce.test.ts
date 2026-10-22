// The single-flight coalescer behind the SCM and Explorer refreshes: one run in flight, one
// queued behind it, and every caller settled only by a run that started after its call.

import { describe, expect, it } from 'vitest';
import { coalesced } from '../src/platform/coalesce';

function gate(): { promise: Promise<void>; open: () => void } {
	let open = () => {};
	const promise = new Promise<void>((resolve) => (open = resolve));
	return { promise, open };
}

describe('coalesced', () => {
	it('folds a burst of calls during a run into one trailing run', async () => {
		const gates: ReturnType<typeof gate>[] = [];
		let starts = 0;
		const refresh = coalesced(() => {
			starts++;
			const g = gate();
			gates.push(g);
			return g.promise;
		});
		const first = refresh();
		const burst = [refresh(), refresh(), refresh()];
		expect(starts).toBe(1);
		expect(burst[0]).toBe(burst[1]);
		gates[0]!.open();
		await first;
		await Promise.resolve();
		expect(starts).toBe(2);
		let settled = false;
		void Promise.all(burst).then(() => (settled = true));
		await Promise.resolve();
		expect(settled).toBe(false); // the trailing run is still going
		gates[1]!.open();
		await Promise.all(burst);
		expect(starts).toBe(2);
	});

	it('runs again after a failed run, and an idle call starts at once', async () => {
		let starts = 0;
		const refresh = coalesced(async () => {
			starts++;
			if (starts === 1) throw new Error('boom');
		});
		const failing = refresh();
		const queued = refresh();
		await expect(failing).rejects.toThrow('boom');
		await queued;
		expect(starts).toBe(2);
		await refresh();
		expect(starts).toBe(3);
	});
});
