// The Traffic page (module 19, docs/ggs-remote-plan.md §10.5): the Transport's accounting
// (traffic.ts) rendered live — the totals and the compression saving, the wire by frame
// type, the subjects behind it — with the reset zeroing the Transport's own fields in
// place, and the desktop (no remote env) answering the local note instead.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { T } from '../src/remote/frame';
import { newTrafficStats, type TrafficStats } from '../src/remote/traffic';
import { closeTrafficPage, openTrafficPage, trafficPageOpen } from '../src/remote/trafficPage';
import { setRemoteEnv, type RemoteEnv } from '../src/remote/session';

function envWith(stats: TrafficStats): RemoteEnv {
	return {
		transport: { stats } as unknown as RemoteEnv['transport'],
		attached: { instance: 'ggs-1', version: '0.1.20', assetBase: '/', ggsBase: '/w/ggs-1/ggs/t/', frontendId: 'remote/1' },
		basePath: '/'
	};
}

function statsWithTraffic(): TrafficStats {
	const stats = newTrafficStats();
	stats.up = 4_000;
	stats.down = 120_000;
	stats.upPlain = 12_000;
	stats.downPlain = 400_000;
	stats.upByType.set(T.INVOKE, { bytes: 3_000, frames: 10 });
	stats.upByType.set(T.LISTEN, { bytes: 1_000, frames: 3 });
	stats.downByType.set(T.RESULT, { bytes: 100_000, frames: 9 });
	stats.downByType.set(T.EVENT, { bytes: 20_000, frames: 40 });
	stats.byName.set('invoke list_dir', { bytes: 30_000, frames: 12 });
	stats.byName.set('event studio://fs-changed', { bytes: 15_000, frames: 30 });
	stats.byName.set('channel', { bytes: 75_000, frames: 5 });
	return stats;
}

function text(): string {
	return document.body.textContent ?? '';
}

beforeEach(() => {
	document.body.replaceChildren();
});
afterEach(() => {
	closeTrafficPage();
	document.body.replaceChildren();
});

describe('the Traffic page (§10.5)', () => {
	it('renders the session totals, the saving, the frame types and the subjects', () => {
		setRemoteEnv(envWith(statsWithTraffic()));
		openTrafficPage();
		expect(trafficPageOpen()).toBe(true);
		const shown = text();
		expect(shown).toContain('3.9 KB'); // ↑ wire
		expect(shown).toContain('117.2 KB'); // ↓ wire
		expect(shown).toContain('70%'); // the compression's saving
		expect(shown).toContain('Invokes'); // the frame-type table
		expect(shown).toContain('Subscriptions');
		// The subject table: the invoke bucket pairs the call and its answer.
		expect(shown).toContain('invoke list_dir');
		expect(shown).toContain('event studio://fs-changed');
		expect(shown).toContain('channel');
		closeTrafficPage();
		expect(trafficPageOpen()).toBe(false);
	});

	it('folds beyond the top subjects into Other', () => {
		const stats = newTrafficStats();
		stats.downByType.set(T.RESULT, { bytes: 1, frames: 1 });
		for (let i = 0; i < 20; i++) stats.byName.set(`invoke cmd_${i}`, { bytes: 100 - i, frames: 1 });
		setRemoteEnv(envWith(stats));
		openTrafficPage();
		const shown = text();
		expect(shown).toContain('invoke cmd_0'); // the biggest subject named
		expect(shown).toContain('invoke cmd_13'); // the fourteenth is the top's last row
		// The six below fold into one row carrying their summed bytes (86+85+84+83+82+81).
		expect(shown).toContain('Other');
		expect(shown).toContain('501 B');
	});

	it('reset zeroes the Transport stats object in place', () => {
		const stats = statsWithTraffic();
		setRemoteEnv(envWith(stats));
		openTrafficPage();
		const reset = document.querySelector<HTMLButtonElement>('button[aria-label="Reset counters"]')!;
		reset.click();
		expect(stats.up).toBe(0);
		expect(stats.down).toBe(0);
		expect(stats.byName.size).toBe(0);
		expect(stats.upByType.size).toBe(0);
		expect(text()).toContain('No traffic yet this session.');
	});

	it('answers the local note on the desktop, where no transport exists', () => {
		setRemoteEnv(undefined);
		openTrafficPage();
		expect(text()).toContain('Not connected to a PC');
	});
});
