// The real thing the browser pass measures, checked straight against the shipped theme
// files: every theme's CSS variables are parsed out of static/theme/*.css and each surface
// pair evaluated with the same contrast maths (themeMetrics.ts). A token edit that dims a
// surface below its threshold fails here, in CI, before the harness ever runs.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { SURFACES, evaluateSurface } from '../src/themeMetrics';
import { THEMES } from '../src/settings';

const staticDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'static');

/** A theme's `:root` variables as a name → value map (values as written, unexpanded). */
function themeVars(cssFile: string): Map<string, string> {
	const css = readFileSync(join(staticDir, cssFile.replace(/^\//, '')), 'utf8');
	const vars = new Map<string, string>();
	for (const match of css.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
		vars.set(match[1]!, match[2]!.trim());
	}
	return vars;
}

describe('every shipped theme keeps its text readable', () => {
	for (const theme of THEMES) {
		it(`${theme.label}: all surfaces meet their contrast thresholds`, () => {
			const vars = themeVars(theme.css);
			expect(vars.size, 'the theme file parsed').toBeGreaterThan(50);
			const failures: string[] = [];
			for (const surface of SURFACES) {
				// Resolve one level of var() indirection so a token defined as another token works.
				const resolve = (name: string): string => {
					const value = vars.get(name) ?? '';
					const reference = /^var\((--[\w-]+)\)$/.exec(value);
					return reference ? vars.get(reference[1]!) ?? '' : value;
				};
				const verdict = evaluateSurface(theme.label, surface, resolve(surface.foreground), resolve(surface.background));
				if (verdict.status === 'fail') failures.push(verdict.detail);
			}
			expect(failures, failures.join('\n')).toEqual([]);
		});
	}
});
