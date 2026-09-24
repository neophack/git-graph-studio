// @vitest-environment node
// The standard VSIX's contract with the app: the `ggs` key the extension's own package.json
// carries (which VS Code ignores and `cmd_ext.rs` reads on install) must stay the shape the
// installer generates a runtime manifest from — this suite pins it from the app's side, so a
// submodule change that breaks the install contract fails this repository's CI.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const submodule = join(dirname(fileURLToPath(import.meta.url)), '..', 'vscode-git-graph-rs');

interface Pkg {
	name: string;
	publisher: string;
	main?: string;
	ggs?: {
		format: string;
		pages?: unknown;
		activitybar?: unknown;
		permissions?: string[];
		backend?: { kind: string; host: string; command: string; binaries: Record<string, string> };
	};
}

describe('vsix packaging', () => {
	it('carries the ggs declaration the install reads, and no page registry', () => {
		const pkg = JSON.parse(readFileSync(join(submodule, 'package.json'), 'utf8')) as Pkg;
		expect(pkg.ggs?.format).toBe('ggs/2');
		// A frame-host package: no pages and no activity-bar launcher — the extension's own
		// code runs in the frame host (its `main`) and opens its views as webview panels;
		// only the engine backend is declared, served by the app-bundled host.
		expect('pages' in (pkg.ggs ?? {})).toBe(false);
		expect('activitybar' in (pkg.ggs ?? {})).toBe(false);
		expect(pkg.main).toBe('./out/extension.js');
	});

	it('declares the engine .node per platform — the one binary the app-bundled host loads', () => {
		const pkg = JSON.parse(readFileSync(join(submodule, 'package.json'), 'utf8')) as Pkg;
		const backend = pkg.ggs?.backend;
		expect(backend?.kind).toBe('node');
		expect(backend?.host).toBe('git-graph-backend');
		// Every platform the engine is built for has its entry; this host's platform among
		// them, and the fallback `command` is one of the map's values.
		const platform = `${process.platform}-${process.arch}`;
		expect(typeof backend?.binaries[platform]).toBe('string');
		expect(Object.values(backend?.binaries ?? {})).toContain(backend?.command);
		// The paths sit under native/ — the subtree .vscodeignore keeps inside the VSIX.
		for (const command of Object.values(backend?.binaries ?? {})) {
			expect(command.startsWith('native/')).toBe(true);
			expect(command.endsWith('git-graph.node')).toBe(true);
		}
	});
});
