// The build scripts' pure parts: the .ggx package header, the baked-in contributions, and
// which size budgets a measurement violates.

import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// @ts-expect-error - plain ESM scripts without type declarations
import { ggxManifest } from '../scripts/build-ggx.mjs';
// @ts-expect-error - plain ESM scripts without type declarations
import { buildBuiltinContributions } from '../scripts/builtin-contributions.mjs';
// @ts-expect-error - plain ESM scripts without type declarations
import { BUDGETS, GATED, violations } from '../scripts/measure.mjs';

describe('.ggx packaging', () => {
	it('writes a ggx/1 header with the frontend page — the shape cmd_ext.rs installs', () => {
		const pkg = { name: 'git-graph-rs', publisher: 'neophack', version: '1.0.23', displayName: 'Git Graph' };
		const manifest = ggxManifest(pkg);
		expect(manifest.format).toBe('ggx/1');
		expect(manifest.id).toBe('neophack.git-graph-rs');
		expect(manifest.version).toBe('1.0.23');
		expect(manifest.frontend).toEqual({ kind: 'webview', page: 'web/view.html', config: 'web/config.js', compare: 'web/compare.js' });
		expect(manifest.permissions).toContain('git:write');
		// The header carries no process backend: the engine is linked into the app.
		expect('backend' in manifest).toBe(false);
	});
});

describe('the baked-in contributions', () => {
	it('extracts the shipped extension manifest contributes and its NLS table', () => {
		const dir = mkdtempSync(join(tmpdir(), 'builtin-contrib-'));
		try {
			writeFileSync(join(dir, 'package.json'), JSON.stringify({
				name: 'git-graph-rs', publisher: 'acme',
				contributes: {
					commands: [{ command: 'git-graph-rs.view', title: '%cmd.view%' }],
					menus: { 'scm/title': [{ command: 'git-graph-rs.view', group: 'navigation' }] }
				}
			}));
			writeFileSync(join(dir, 'package.nls.json'), JSON.stringify({ 'cmd.view': 'Open Git Graph' }));
			writeFileSync(join(dir, 'package.nls.zh-cn.json'), JSON.stringify({ 'cmd.view': '打开 Git Graph' }));
			const [baked] = buildBuiltinContributions(dir);
			expect(baked.extId).toBe('acme.git-graph-rs');
			expect(baked.contributes.commands[0].command).toBe('git-graph-rs.view');
			expect(baked.contributes.menus['scm/title'][0].group).toBe('navigation');
			expect(baked.nls['cmd.view']).toBe('Open Git Graph');
			expect(baked.nlsTranslations['zh-cn']['cmd.view']).toBe('打开 Git Graph');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('reads the real vscode-git-graph-rs manifest the app ships', () => {
		const [baked] = buildBuiltinContributions(join(dirname(fileURLToPath(import.meta.url)), '..', 'vscode-git-graph-rs'));
		expect(baked.extId).toBe('neophack.git-graph-rs');
		// The menu locations the workbench surfaces are all declared there.
		expect(Object.keys(baked.contributes.menus)).toContain('scm/title');
	});
});

describe('size budgets', () => {
	it('reports every exceeded budget and nothing else', () => {
		const within = { exe: 9 * 1024 * 1024, installer: 7 * 1024 * 1024, dist: 1_500_000, firstPaintJs: { size: 250_000 } };
		expect(violations(within)).toEqual([]);
		const over = { exe: 23 * 1024 * 1024, installer: null, dist: null, firstPaintJs: { size: 820_000 } };
		expect(violations(over).map(([name]: [string]) => name)).toEqual(['exe', 'firstPaintJs']);
		expect(BUDGETS.exe).toBe(10 * 1024 * 1024);
		// The whole-dist budget is informational until the font subsetting lands.
		expect(GATED).toEqual(['exe', 'installer', 'firstPaintJs']);
	});
});
