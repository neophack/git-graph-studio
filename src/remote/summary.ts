// The content summary a frontend reports to its instance (docs/ggs-remote-plan.md §8.1,
// R21): open files with their dirty / active state and the pending SCM changes, which the
// Remote Access window picker shows per window. Polled cheaply and sent only on change; an
// instance without the command (or no daemon at all) costs one failed call, then silence.
import { invoke } from '../platform/ipc/core';
import { frontendId } from './session';

export interface SummarySource {
	tabs(): { path: string; dirty: boolean; active: boolean }[];
	scmChanges(): number;
}

const EVERY_MS = 1500;

export function startSummaryReporter(source: SummarySource): () => void {
	let last = '';
	let failed = false;
	const tick = () => {
		if (failed) return;
		const tabs = source.tabs();
		const summary = { tabs, terminals: 0, dirty: tabs.filter((t) => t.dirty).length, scmChanges: source.scmChanges() };
		const key = JSON.stringify(summary);
		if (key === last) return;
		last = key;
		invoke('remote_host_set_summary', { frontend: frontendId(), summary }).catch(() => {
			failed = true;
		});
	};
	const timer = setInterval(tick, EVERY_MS);
	tick();
	return () => clearInterval(timer);
}
