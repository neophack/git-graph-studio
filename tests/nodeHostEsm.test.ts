// The real-Node host's ESM seam (src/nodeHostEsm.ts): the generated loader hooks that let
// an ES module graph `import 'vscode'` the same shim the require patch serves — the CJS
// interception never sees a static import, and before the hook a `"type": "module"`
// package (kimi-code's 8.8 MB entry is one) died with ERR_MODULE_NOT_FOUND. The
// integration half runs the real hook through a real `node` child, because registering
// loader hooks inside the vitest worker would rewire the worker's own module resolution.

import { afterAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Buffer } from 'node:buffer';
import { VSCODE_ESM_GLOBAL, vscodeEsmHookUrl, vscodeEsmModuleSource } from '../src/nodeHostEsm';

const exec = promisify(execFile);

describe('the ESM vscode loader hook source', () => {
	it('exports the shim keys and the well-known fallbacks over the global instance', () => {
		const source = vscodeEsmModuleSource({ commands: { register() {} }, Uri: class {}, 'not-an-identifier': 1 });
		// Everything the shim serves exports by name...
		expect(source).toContain('export const commands = api["commands"];');
		expect(source).toContain('export const Uri = api["Uri"];');
		// ...the well-known names this host may lack export undefined instead of failing
		// the link (the require path's tolerance)...
		expect(source).toContain('export const LogLevel = api["LogLevel"];');
		// ...and a key that is not an identifier cannot poison the generated source.
		expect(source).not.toContain('not-an-identifier');
		// The instance is read off the global at evaluation time — the hooks thread that
		// fetches source cannot see host state, the evaluation happens on the main thread.
		expect(source).toContain(`Symbol.for(${JSON.stringify(VSCODE_ESM_GLOBAL)})`);
		expect(source).toContain('export default api;');
	});

	it('builds a data-URL hook module that resolves only the vscode specifier', () => {
		const url = vscodeEsmHookUrl({ commands: {} });
		expect(url).toMatch(/^data:text\/javascript;base64,/);
		const source = Buffer.from(url.slice('data:text/javascript;base64,'.length), 'base64').toString('utf8');
		expect(source).toContain("if (specifier === 'vscode') return { url: SHIM_URL, shortCircuit: true };");
		expect(source).toContain('return next(specifier, context);');
	});
});

describe('an ES module entry importing vscode under a real Node', () => {
	const dir = mkdtempSync(join(tmpdir(), 'ggs-nodehost-esm-'));
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	it('links the named imports to the host instance and answers the fallbacks undefined', async () => {
		expect(typeof (await import('node:module')).register).toBe('function');
		// The fixture: a `"type": "module"` package whose entry named-imports a served
		// namespace, a served class and a name the shim lacks — the shape that failed with
		// ERR_MODULE_NOT_FOUND before the hook existed.
		writeFileSync(
			join(dir, 'entry.mjs'),
			[
				"import { commands, Uri, LogLevel } from 'vscode';",
				'export function activate() {',
				'  globalThis.__probe = commands;',
				"  return { commandsOk: typeof commands.register === 'function', uriOk: new Uri() instanceof Uri, logLevel: LogLevel };",
				'}',
				''
			].join('\n')
		);
		// The driver stands in for nodeHost.ts's activation: stash the instance, register
		// the hooks, import the entry, run activate, print the verdict as one JSON line.
		const driver = [
			"const { register } = require('node:module');",
			"const { pathToFileURL } = require('node:url');",
			"const api = { commands: { register() {} }, Uri: class Uri {} };",
			`globalThis[Symbol.for(${JSON.stringify(VSCODE_ESM_GLOBAL)})] = api;`,
			'register(process.argv[2], pathToFileURL(__filename).href);',
			'import(pathToFileURL(process.argv[3]).href)',
			'  .then((m) => m.activate())',
			'  .then((r) => { process.stdout.write(JSON.stringify({ ...r, sameInstance: globalThis.__probe === api.commands }) + "\\n"); })',
			'  .catch((error) => { process.stderr.write(String(error)); process.exit(1); });',
			''
		].join('\n');
		writeFileSync(join(dir, 'driver.cjs'), driver);
		const { stdout } = await exec(process.execPath, [join(dir, 'driver.cjs'), vscodeEsmHookUrl({ commands: { register() {} }, Uri: class Uri {} }), join(dir, 'entry.mjs')]);
		const verdict = JSON.parse(stdout.trim()) as { commandsOk: boolean; uriOk: boolean; logLevel: unknown; sameInstance: boolean };
		expect(verdict.commandsOk).toBe(true);
		expect(verdict.uriOk).toBe(true);
		// The name the shim lacks links (undefined), exactly like the require path.
		expect(verdict.logLevel).toBeUndefined();
		// The named import IS the host's own object, not a copy.
		expect(verdict.sameInstance).toBe(true);
	}, 30_000);
});
