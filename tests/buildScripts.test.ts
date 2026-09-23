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
import { configEntry, ggxManifest } from '../plugins/git-graph-rs/build.mjs';

describe('.ggx packaging', () => {
	it('aims the config bundle entry\'s require at the compiled config, not its comment', () => {
		const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'git-graph-rs', 'config-stdin.js'), 'utf8');
		const entry = configEntry(source, 'C:\\ext\\out\\config.js');
		// The call is rewritten; no bare placeholder survives in the code the page runs.
		expect(entry).toContain(`require(${JSON.stringify('C:\\ext\\out\\config.js')})`);
		expect(entry).not.toContain('require(CONFIG_PATH)');
		expect(() => configEntry('module.exports = 1;', 'x')).toThrow(/require\(CONFIG_PATH\)/);
	});

	it('writes a ggx/2 header with the page registry — the shape cmd_ext.rs installs', () => {
		const pkg = { name: 'git-graph-rs', publisher: 'neophack', version: '1.0.23', displayName: 'Git Graph' };
		const manifest = ggxManifest(pkg);
		expect(manifest.format).toBe('ggx/2');
		expect(manifest.id).toBe('neophack.git-graph-rs');
		expect(manifest.version).toBe('1.0.23');
		// The named page registry: the view page is a singleton (a second open reveals it,
		// params as an event), and the two comparison pages are the graph's own diff surfaces.
		expect(manifest.pages).toEqual({
			view: { page: 'web/view.html', title: 'Git Graph', singleton: true, icon: 'resources/git-graph-rs-webview-icon.svg' },
			compare: { page: 'web/compare.html', icon: 'resources/git-graph-rs-webview-icon.svg' },
			binarycompare: { page: 'web/binarycompare.html', icon: 'resources/git-graph-rs-webview-icon.svg' }
		});
		expect(manifest.permissions).toContain('git:write');
		// The activity-bar entry is the package's own declaration (the grey icon; the page tabs
		// wear the colour one): its click runs the view command — the app hardcodes no icon of
		// any plugin.
		expect(manifest.activitybar).toEqual({ command: 'git-graph-rs.view', title: 'Git Graph', icon: 'resources/git-graph-rs-webview-icon-dark.svg' });
		// Without a compiled backend the header stays frontend-only (the packer allows it);
		// the app then reports the engine as "not installed" — it never links it itself.
		expect('backend' in manifest).toBe(false);
		// With one, the header declares the ggx-rpc/1 process backend the app spawns from the
		// installed package — the only way the app reaches the engine.
		const platform = `${process.platform}-${process.arch}`;
		const exe = process.platform === 'win32' ? 'git-graph-backend.exe' : 'git-graph-backend';
		const command = `backend/${platform}/${exe}`;
		expect(ggxManifest(pkg, { backendPath: `target/studio/cargo/release/${exe}` }).backend).toEqual({
			kind: 'process',
			protocol: 'ggx-rpc/1',
			command,
			binaries: { [platform]: command }
		});
	});
});
