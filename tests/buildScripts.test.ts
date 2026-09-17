// @vitest-environment node
// The build scripts' pure parts: the .ggx package header, the baked-in contributions and the
// Commit Comparison page bundle (esbuild itself runs here - its TextEncoder/Uint8Array invariant
// does not hold in the mixed jsdom realm).

import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// @ts-expect-error - plain ESM scripts without type declarations
import { ggxManifest } from '../scripts/build-ggx.mjs';
// @ts-expect-error - plain ESM scripts without type declarations
import { buildBuiltinContributions, buildBuiltinSettings } from '../scripts/builtin-contributions.mjs';
// @ts-expect-error - plain ESM scripts without type declarations
import { buildCompareBundle } from '../scripts/compare-bundle.mjs';

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

describe('the Commit Comparison page bundle', () => {
	it('bundles the extension\'s compiled CommonJS output so it runs as a plain browser script', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'compare-bundle-'));
		try {
			// The layout the app really builds in: the patched copies land under the app's own
			// package.json, which is "type": "module" - without the CommonJS marker the bundle
			// step writes, esbuild would read the extension's compiled .js as ECMAScript modules
			// and their `exports.X` assignments would throw at script load.
			writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
			mkdirSync(join(dir, 'out', 'utils'), { recursive: true });
			writeFileSync(join(dir, 'out', 'utils', 'disposable.js'), [
				'"use strict";',
				'Object.defineProperty(exports, "__esModule", { value: true });',
				'exports.Disposable = void 0;',
				'exports.Disposable = class Disposable { dispose() {} };',
				''
			].join('\n'));
			// The compiled shape the patch step expects: the Electron original-fs fallback
			// wrapper its scripts/package-src.js weaves into every file that requires fs.
			writeFileSync(join(dir, 'out', 'comparisonView.js'), [
				'"use strict";',
				'function requireWithFallback(electronModule, nodeModule) { try { return require(electronModule); } catch (err) {} return require(nodeModule); }',
				'Object.defineProperty(exports, "__esModule", { value: true });',
				'exports.CommitComparisonView = void 0;',
				'const fs = requireWithFallback("original-fs", "fs");',
				'const disposable_1 = require("./utils/disposable");',
				'class CommitComparisonView extends disposable_1.Disposable {',
				'	getHtml() { return "<!DOCTYPE html><html><body>fixture comparison page</body></html>"; }',
				'}',
				'exports.CommitComparisonView = CommitComparisonView;',
				''
			].join('\n'));

			const outfile = join(dir, 'gitgraph', 'compare.js');
			await buildCompareBundle({ root: dir, patchedOut: join(dir, 'compare-src'), outfile });

			// The patch step folded the original-fs fallback back to the plain require.
			const patched = readFileSync(join(dir, 'compare-src', 'comparisonView.js'), 'utf8');
			expect(patched).toContain('require("fs")');
			expect(patched).not.toContain('requireWithFallback("original-fs", "fs")');
			expect(readFileSync(join(dir, 'compare-src', 'package.json'), 'utf8')).toContain('"commonjs"');
			// The bundle must load as the plain <script> graphHost.ts injects: if esbuild had
			// read the files as ECMAScript modules, `exports` would be a free reference and this
			// evaluation would throw ReferenceError before the generator was registered.
			expect(existsSync(outfile)).toBe(true);
			new Function(readFileSync(outfile, 'utf8'))();
			const generator = (globalThis as { GitGraphCompare?: { buildComparePage(options: Record<string, unknown>): string } }).GitGraphCompare;
			expect(generator).toBeDefined();
			expect(generator!.buildComparePage({ fromHash: 'aaaa', toHash: 'bbbb', singleCommit: false, loading: true }))
				.toBe('<!DOCTYPE html><html><body>fixture comparison page</body></html>');
		} finally {
			delete (globalThis as { GitGraphCompare?: unknown }).GitGraphCompare;
			rmSync(dir, { recursive: true, force: true });
		}
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
		expect(Object.keys(baked.contributes!.menus!)).toContain('scm/title');
	});

	it('keeps the first-paint slice free of the settings schema and its descriptions', () => {
		// The baked module rides the first-paint bundle (plan §4: first-paint JS ≤ 300 KB), so
		// it carries commands, menus and the `when`-referenced settings' defaults - never the
		// whole configuration schema or the localised descriptions, which dwarf the commands.
		const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'vscode-git-graph-rs');
		const [baked] = buildBuiltinContributions(root);
		const full = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
		const declared = Object.keys(full.contributes.configuration.properties);
		const kept = Object.keys(baked.contributes!.configuration?.properties ?? {});
		expect(kept).toEqual(['git-graph-rs.sourceCodeProviderIntegrationLocation']);
		expect(kept.length).toBeLessThan(declared.length);
		for (const key of Object.keys(baked.nls)) expect(key.startsWith('config.')).toBe(false);
		expect(Object.keys(baked.nlsTranslations['zh-cn'])).toEqual(Object.keys(baked.nls));

		// The async settings chunk carries the whole schema, with its descriptions resolved by
		// the default NLS table once the Settings dialog loads it.
		const [settings] = buildBuiltinSettings(root);
		expect(settings.extId).toBe('neophack.git-graph-rs');
		expect(Object.keys(settings.configuration!.properties!)).toEqual(expect.arrayContaining(declared));
		expect(Object.keys(settings.nls).length).toBeGreaterThan(Object.keys(baked.nls).length);
	});
});
