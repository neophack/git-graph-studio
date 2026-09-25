// The real-VSIX compatibility test: boots the actual installed `git-graph-rs 1.0.25`
// extension code (a marketplace-shaped package: no ggs key, a NAPI-only engine with its own
// git-CLI fallback) through the frame boot path under jsdom. It pins the three steps that
// make such a package viable here: the bundle evaluates against the shims, its native
// engine is honestly absent (the pretend-runtime rule hides `.node` files so the
// package's own fallback logic engages), and its CLI backend's `git` probe crosses the
// child_process bridge. Skips on machines without the install, so CI stays hermetic.
//
// Known limitation (documented, not asserted): the extension's `activate` promise still
// never settles — its CLI backend handshake outruns the shim's event delivery somewhere
// past the first `execFile`. The probe scripts/probes/vsix-live-check.mjs tracks the live
// behaviour.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { backend } from './tauriMock';
import type { ExtInfo } from '../src/extHost';
import '../src/extHostBoot';

const INSTALL = join(homedir(), '.ggs', 'extensions', 'neophack.git-graph-rs-1.0.25');
const hasInstall = existsSync(join(INSTALL, 'out', 'extension.js'));

describe('the real git-graph-rs 1.0.25 VSIX under the frame host', () => {
	it('evaluates and reaches its git CLI through the child_process bridge', { timeout: 30_000 }, async () => {
		if (!hasInstall) {
			console.info('skipping: no git-graph-rs 1.0.25 install under ~/.ggs/extensions');
			return;
		}
		const files: Record<string, string> = { 'package.json': readFileSync(join(INSTALL, 'package.json'), 'utf8') };
		const walk = (dir: string, prefix: string): void => {
			for (const entry of readdirSync(dir)) {
				const full = join(dir, entry);
				const rel = prefix ? `${prefix}/${entry}` : entry;
				if (statSync(full).isDirectory()) walk(full, rel);
				else if (entry.endsWith('.js')) files[rel] = readFileSync(full, 'utf8');
			}
		};
		walk(join(INSTALL, 'out'), 'out');

		const INFO: ExtInfo = {
			id: 'neophack.git-graph-rs', name: 'git-graph-rs', displayName: 'Git Graph (Rust)', publisher: 'neophack', version: '1.0.25',
			description: 'Git Graph', builtin: false, icon: null, path: INSTALL, categories: [], keywords: [], repository: null,
			license: null, enginesVscode: null, extensionDependencies: [], extensionPack: [], readme: null, changelog: null,
			format: 'vsix',
			capabilities: { format: 'ggs/2', id: 'neophack.git-graph-rs', version: '1.0.25', pages: {}, backend: { kind: 'node', host: 'ggs-node', command: './out/extension.js' }, permissions: [] }
		};
		backend.on('ext_list', () => [INFO]);

		const childSpawns: { file: string; args: string[] }[] = [];
		const handle = {
			frame: { contentWindow: {} } as unknown as HTMLIFrameElement,
			commandIds: new Set<string>(),
			pendingCalls: new Set<(error: Error) => void>(),
			send: (message: unknown) => {
				const data = message as { type?: string; kind?: string; handle?: number; event?: string; data?: string; code?: number | null };
				// The streamed answer to the CLI backend's probe: git says hello, then exits 0.
				if (data.type === '__studioExtHostEvent' && data.kind === 'childProcess') {
					if (data.event === 'stdout') {
						window.dispatchEvent(new MessageEvent('message', { data: { type: '__studioExtHostEvent', kind: 'childProcess', message: { handle: data.handle, event: 'stdout', data: btoa('git version 2.47.0') } } }));
					}
					if (data.event === 'exit') {
						window.dispatchEvent(new MessageEvent('message', { data: { type: '__studioExtHostEvent', kind: 'childProcess', message: { handle: data.handle, event: 'exit', code: 0 } } }));
					}
				}
			}
		};
		window.addEventListener('message', (event: MessageEvent) => {
			const data = event.data as { type?: string; id?: number; method?: string; args?: unknown[] };
			if (data?.type !== '__studioExtRpc') return;
			console.info(`[compat-rpc] ${data.method} ${JSON.stringify(data.args ?? []).slice(0, 120)}`);
			const serve = async (method: string, args: unknown[]): Promise<unknown> => {
				if (method === 'childProcess.spawn') {
					const spec = args[0] as { file: string; args: string[] };
					childSpawns.push({ file: spec.file, args: spec.args });
					handle.send({ type: '__studioExtHostEvent', kind: 'childProcess', handle: 1, event: 'stdout', data: btoa('git version 2.47.0') });
					handle.send({ type: '__studioExtHostEvent', kind: 'childProcess', handle: 1, event: 'exit', code: 0 });
					return { handle: 1, pid: 4242 };
				}
				return null;
			};
			void serve(data.method ?? '', data.args ?? []).then(
				(result) => window.dispatchEvent(new MessageEvent('message', { data: { type: '__studioExtRpcResult', id: data.id, ok: true, result } })),
				(error) => window.dispatchEvent(new MessageEvent('message', { data: { type: '__studioExtRpcResult', id: data.id, ok: false, result: String(error) } }))
			);
		});

		window.dispatchEvent(new MessageEvent('message', {
			data: {
				type: '__studioExtInit',
				context: { extensionId: INFO.id, extensionPath: INSTALL, workspaceFolders: [], settings: {}, language: 'en', webviewResourceBase: `ggs://localhost/${INFO.id}-1.0.25/`, state: { global: {}, workspace: {} } },
				files,
				binaries: []
			}
		}));
		// Does the extension's own `activate` settle now that the early-event race is fixed?
		const settled = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
			const timeout = setTimeout(() => resolve({ ok: false, error: 'never settled in 20s' }), 20_000);
			window.addEventListener('message', function listener(event: MessageEvent) {
				const data = event.data as { type?: string; extensionId?: string; error?: string };
				if (data?.type === '__studioExtActivated' && data.extensionId === INFO.id) {
					clearTimeout(timeout);
					window.removeEventListener('message', listener);
					resolve({ ok: true });
				}
				if (data?.type === '__studioExtActivateFailed' && data.extensionId === INFO.id) {
					clearTimeout(timeout);
					window.removeEventListener('message', listener);
					resolve({ ok: false, error: data.error });
				}
			});
		});
		await new Promise((resolve) => setTimeout(resolve, 1000));
		expect(childSpawns.length, JSON.stringify(childSpawns)).toBeGreaterThan(0);
		console.info('[compat] activation settled:', JSON.stringify(settled));
		expect(childSpawns[0]!.file, 'the fallback runs the real git, not the engine binary').toContain('git');
	});
});
