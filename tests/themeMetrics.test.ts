// The theme contrast pass's maths and shape: the WCAG ratio itself, the surface verdicts
// (pass/fail thresholds, alpha compositing), and the module's behaviour in a DOM without
// stylesheets (every theme skipped, never a false failure). The real multi-theme pass runs
// in the browser against /dev/dev-harness.html?metrics=1.

import { describe, expect, it } from 'vitest';

import { contrastRatio, evaluateSurface, runThemeContrastMetrics } from '../src/themeMetrics';
import type { MetricResult } from '../src/uiMetrics';

describe('contrast ratio maths', () => {
	it('black on white is 21, identical colours are 1', () => {
		expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1);
		expect(contrastRatio('#d4d4d4', '#1e1e1e')).toBeCloseTo(11.25, 1);
		expect(contrastRatio('#d8dee9', '#d8dee9')).toBeCloseTo(1, 5);
	});

	it('composites translucent foregrounds over the background before measuring', () => {
		// 50% grey text at half alpha over black is darker than opaque grey on black.
		const opaque = contrastRatio('#808080', '#000000')!;
		const translucent = contrastRatio('#80808080', '#000000')!;
		expect(translucent).toBeLessThan(opaque);
		expect(translucent).toBeGreaterThan(1);
	});

	it('returns null for colours it cannot parse', () => {
		expect(contrastRatio('nope', '#000000')).toBeNull();
		expect(contrastRatio('#d4d4d4', 'var(--x)')).toBeNull();
	});

	it('parses the forms the themes use: #rgb, #rrggbb, #rrggbbaa, rgb(), rgba()', () => {
		expect(contrastRatio('#fff', '#000000')).toBeCloseTo(21, 1);
		expect(contrastRatio('rgb(255, 255, 255)', '#000')).toBeCloseTo(21, 1);
		expect(contrastRatio('rgba(255,255,255,1)', '#000')).toBeCloseTo(21, 1);
	});
});

describe('surface verdicts', () => {
	const surface = { label: 'editor text', foreground: '--fg', background: '--bg', min: 4.5 };

	it('passes a readable pair with the measured ratio in the detail', () => {
		const result = evaluateSurface('Nord', surface, '#d8dee9', '#2e3440');
		expect(result.status).toBe('pass');
		expect(result.name).toBe('Nord: editor text readable');
		expect(result.detail).toMatch(/contrast \d+\.\d+ \(min 4\.5\)/);
	});

	it('fails a dim pair naming the tokens and their colours', () => {
		const result = evaluateSurface('Nord', surface, '#4c566a', '#2e3440');
		expect(result.status).toBe('fail');
		expect(result.detail).toContain('under 4.5');
		expect(result.detail).toContain('--fg');
	});

	it('fails loudly when a colour cannot be parsed', () => {
		const result = evaluateSurface('Nord', surface, '', '#2e3440');
		expect(result.status).toBe('fail');
		expect(result.detail).toContain('cannot parse');
	});
});

describe('the multi-theme pass without stylesheets', () => {
	it('skips every theme rather than failing when no theme stylesheet is loaded', async () => {
		const results: MetricResult[] = await runThemeContrastMetrics();
		expect(results.length).toBeGreaterThan(0);
		for (const result of results) expect(result.status).toBe('skipped');
	});
});
