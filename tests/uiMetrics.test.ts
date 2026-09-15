// The UI metrics module (the dev harness's measurement pass) - a smoke test here: jsdom has
// no layout, so the real pass runs in the browser against dev-harness.html?metrics=1 (the
// report lands in window.__uiMetrics). What CI pins: the module runs against any DOM, every
// result is well-formed, and the headline checks are always present.

import { describe, expect, it } from 'vitest';

import { runUiMetrics } from '../src/uiMetrics';

describe('the UI metrics pass', () => {
	it('runs against any DOM and returns well-formed results', () => {
		const results = runUiMetrics();
		expect(results.length).toBeGreaterThan(5);
		for (const result of results) {
			expect(['pass', 'fail', 'skipped']).toContain(result.status);
			expect(result.name.length).toBeGreaterThan(0);
			expect(result.detail.length).toBeGreaterThan(0);
		}
		// The headline invariants are always reported, whatever is on screen.
		const names = results.map((result) => result.name);
		expect(names).toContain('window: no horizontal overflow');
		expect(names).toContain('status bar: full-width strip at the bottom');
		expect(names.some((name) => name.startsWith('find widget'))).toBe(true);
	});
});
