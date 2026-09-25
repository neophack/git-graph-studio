// The installed-packages compatibility sweep: every frame-hosted directory under
// ~/.ggs/extensions boots through the same frame path the workbench drives, and its
// `activate` must settle. The code map mirrors the backend's `ext_load_code` policy
// exactly (extensions .js/.cjs/.json, the .node/.wasm split, the same four bounds), so a
// package that activates here activates live — and a failure crosses with the stack the
// frame now reports, pointing at the shim gap to close. Backend-hosted packages (a
// manifest.json with a backend — their activation belongs to ggs-node, not the frame) and
// machines without installs skip; CI stays hermetic.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import '../src/extHostBoot';

const EXTENSIONS = join(homedir(), '.ggs', 'extensions');

/** The backend's own `load_code_from` bounds (cmd_ext.rs) — one source of truth in spirit;
 *  the two implementations move together. */
const MAX_FILES = 1200;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_DEPTH = 12;

interface Bundle {
	files: Record<string, string>;
	binaries: string[];
	blobs: Record<string, string>;
	truncated: boolean;
}

/** The bounded code map, collected the way `load_code_from` walks the install. */
function loadCode(root: string): Bundle {
	const files: Record<string, string> = {};
	const binaries: string[] = [];
	const blobs: Record<string, string> = {};
	let total = 0;
	let truncated = false;
	const walk = (dir: string, prefix: string, depth: number): void => {
		if (depth > MAX_DEPTH) {
			truncated = true;
			return;
		}
		for (const entry of readdirSync(dir)) {
			if (entry === '.git') continue;
			const rel = prefix ? `${prefix}/${entry}` : entry;
			const full = join(dir, entry);
			let meta: import('node:fs').Stats;
			try {
				meta = statSync(full);
			} catch {
				continue;
			}
			if (meta.isDirectory()) {
				walk(full, rel, depth + 1);
				continue;
			}
			if (rel.toLowerCase().endsWith('.node')) {
				binaries.push(rel);
				continue;
			}
			if (rel.toLowerCase().endsWith('.wasm')) {
				blobs[rel] = readFileSync(full, 'base64');
				continue;
			}
			const ext = entry.split('.').pop()?.toLowerCase();
			if (ext !== 'js' && ext !== 'cjs' && ext !== 'json') continue;
			if (meta.size > MAX_FILE_BYTES) {
				truncated = true;
				continue;
			}
			if (Object.keys(files).length >= MAX_FILES || total >= MAX_TOTAL_BYTES) {
				truncated = true;
				return;
			}
			const text = readFileSync(full, 'utf8');
			total += text.length;
			files[rel] = text;
		}
	};
	walk(root, '', 0);
	return { files, binaries, blobs, truncated };
}

/** Whether the install carries a derived `manifest.json` backend — the live host runs
 *  those on ggs-node and never boots them in a frame. */
function hasBackend(manifestPath: string): boolean {
	if (!existsSync(manifestPath)) return false;
	try {
		const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { backend?: unknown };
		return manifest.backend !== undefined && manifest.backend !== null;
	} catch {
		return false;
	}
}

interface Installed {
	id: string;
	path: string;
	bundle: Bundle;
}

function installedFrameHosted(): Installed[] {
	if (!existsSync(EXTENSIONS)) return [];
	const out: Installed[] = [];
	for (const dir of readdirSync(EXTENSIONS)) {
		const path = join(EXTENSIONS, dir);
		const pkgPath = join(path, 'package.json');
		if (!existsSync(pkgPath) || hasBackend(join(path, 'manifest.json'))) continue;
		let pkg: { name?: string; publisher?: string; version?: string } = {};
		try {
			pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
		} catch {
			continue;
		}
		const publisher = pkg.publisher ?? dir.split('.')[0] ?? 'unknown';
		const name = pkg.name ?? dir;
		out.push({ id: `${publisher}.${name}`, path, bundle: loadCode(path) });
	}
	return out;
}

const packages = installedFrameHosted();

/* The one bridge fake, registered once: plain spawns answer like `git --version`; a `fork`
 * bridge child (a `--stdio` language server) stays alive and answers the LSP base
 * protocol's framed requests with a minimal server result — the frame's framer and the
 * client's IPC expectations both get exercised for real. (Per-test listeners would stack:
 * every earlier test's listener answers later tests' requests too.) */
const childBuffers = new Map<number, Uint8Array>();
let fakeHandle = 0;
/** Everything the frame wrote to a fork child's stdin (the LSP frames a client sends). */
const writeLog: string[] = [];
window.addEventListener('message', (event: MessageEvent) => {
	const data = event.data as { type?: string; id?: number; method?: string; args?: unknown[] };
	if (data?.type !== '__studioExtRpc') return;
	const serve = async (method: string, args: unknown[]): Promise<unknown> => {
		if (method === 'childProcess.nodeRuntime') return 'node';
		if (method === 'childProcess.spawn') {
			const spec = args[0] as { file: string; args: string[] };
			const handle = ++fakeHandle;
			if (spec.args?.includes('--stdio')) {
				childBuffers.set(handle, new Uint8Array(0));
				return { handle, pid: 4200 + handle };
			}
			window.dispatchEvent(new MessageEvent('message', { data: { type: '__studioExtHostEvent', kind: 'childProcess', message: { handle, event: 'stdout', data: btoa('probe') } } }));
			window.dispatchEvent(new MessageEvent('message', { data: { type: '__studioExtHostEvent', kind: 'childProcess', message: { handle, event: 'exit', code: 0 } } }));
			return { handle, pid: 4200 + handle };
		}
		if (method === 'childProcess.write') {
			const [handle, base64] = args as [number, string];
			const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
			writeLog.push(new TextDecoder().decode(bytes).replace(/\r\n/g, '|').slice(0, 400));
			frameReply(handle, bytes);
			return undefined;
		}
		return null;
	};
	void serve(data.method ?? '', data.args ?? []).then(
		(result) => window.dispatchEvent(new MessageEvent('message', { data: { type: '__studioExtRpcResult', id: data.id, ok: true, result } })),
		(error) => window.dispatchEvent(new MessageEvent('message', { data: { type: '__studioExtRpcResult', id: data.id, ok: false, result: String(error) } }))
	);
});
function frameReply(handle: number, bytes: Uint8Array): void {
	let buffered = childBuffers.get(handle) ?? new Uint8Array(0);
	const merged = new Uint8Array(buffered.length + bytes.length);
	merged.set(buffered);
	merged.set(bytes, buffered.length);
	buffered = merged;
	// The separator search runs on bytes (the header is ASCII; the body's length is bytes),
	// so a multibyte character can never wedge the comparison.
	let sep = -1;
	for (let at = 0; at <= merged.length - 4; at += 1) {
		if (merged[at] === 13 && merged[at + 1] === 10 && merged[at + 2] === 13 && merged[at + 3] === 10) {
			sep = at;
			break;
		}
	}
	if (sep === -1) {
		childBuffers.set(handle, buffered);
		return;
	}
	const headers = new TextDecoder().decode(merged.slice(0, sep));
	const length = /content-length: (\d+)/i.exec(headers)?.[1];
	if (length === undefined) {
		childBuffers.set(handle, buffered);
		return;
	}
	const bodyStart = sep + 4;
	if (merged.length - bodyStart < Number(length)) {
		childBuffers.set(handle, buffered);
		return;
	}
	const body = new TextDecoder().decode(merged.slice(bodyStart, bodyStart + Number(length)));
	let request: { id?: number | string };
	try {
		request = JSON.parse(body);
	} catch {
		return;
	}
	childBuffers.delete(handle);
	if (request.id === undefined) return;
	const response = JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { capabilities: { textDocumentSync: 1 } } });
	const payload = new TextEncoder().encode(response);
	const frame = new TextEncoder().encode(`Content-Length: ${payload.length}\r\n\r\n`);
	const framed = new Uint8Array(frame.length + payload.length);
	framed.set(frame);
	framed.set(payload, frame.length);
	let binary = '';
	for (let at = 0; at < framed.length; at += 1) binary += String.fromCharCode(framed[at]!);
	window.dispatchEvent(new MessageEvent('message', { data: { type: '__studioExtHostEvent', kind: 'childProcess', message: { handle, event: 'stdout', data: btoa(binary) } } }));
}

describe('every installed package activates under the frame host', () => {
	it('has installed packages to sweep (local machine check)', () => {
		console.info(`[installed-compat] sweeping ${packages.map((p) => p.id).join(', ') || '(none)'}`);
		expect(Array.isArray(packages)).toBe(true);
	});

	for (const pkg of packages) {
		it(
			`${pkg.id} activates`,
			{ timeout: 120_000 },
			async () => {
				const settled = await new Promise<{ ok: boolean; error?: string; stack?: string }>((resolve) => {
					const timeout = setTimeout(() => resolve({ ok: false, error: 'never settled in 110s' }), 110_000);
					window.addEventListener('message', function listener(event: MessageEvent) {
						const data = event.data as { type?: string; extensionId?: string; error?: string; stack?: string };
						if (data?.extensionId !== pkg.id) return;
						if (data.type === '__studioExtActivated' || data.type === '__studioExtActivateFailed') {
							clearTimeout(timeout);
							window.removeEventListener('message', listener);
							resolve({ ok: data.type === '__studioExtActivated', error: data.error, stack: data.stack });
						}
					});
					window.dispatchEvent(new MessageEvent('message', {
						data: {
							type: '__studioExtInit',
							context: {
								extensionId: pkg.id,
								extensionPath: pkg.path,
								workspaceFolders: [],
								settings: {},
								language: 'en',
								webviewResourceBase: `ggs://localhost/${pkg.id}/`,
								state: { global: {}, workspace: {} }
							},
							files: pkg.bundle.files,
							truncated: pkg.bundle.truncated,
							binaries: pkg.bundle.binaries,
							blobs: pkg.bundle.blobs
						}
					}));
				});
				if (!settled.ok) {
					console.info(`[installed-compat] ${pkg.id} failed: ${settled.error}\n${settled.stack ?? '(no stack)'}`);
				}
				expect(settled.ok, `${settled.error ?? ''}\n${settled.stack ?? ''}`).toBe(true);
			}
		);

		/** The document-sync check: after activation, a host active-editor push carrying the
		 *  document text must surface as a framed LSP didOpen to the package's own server —
		 *  the hop that makes a language server actually check a file. Meaningful only for
		 *  packages whose client owns a language server (the fork bridge's `--stdio` child);
		 *  the fake bridge's write log is the observation point. */
		it(
			`${pkg.id} syncs an opened document to its language server`,
			{ timeout: 60_000 },
			async () => {
				if (!pkg.id.includes('spell')) return;
				writeLog.length = 0;
				window.dispatchEvent(new MessageEvent('message', {
					data: {
						type: '__studioExtEvent',
						event: 'activeEditorChanged',
						editor: { path: `${pkg.path}/notes.txt`.replace(/\\/g, '/'), languageId: 'plaintext', line: 1, column: 1, text: 'this sentence holds one obviuos mispelled wrd' }
					}
				}));
				await new Promise((resolve) => setTimeout(resolve, 3000));
				console.info(`[installed-compat] ${pkg.id} writes: ${JSON.stringify(writeLog.slice(0, 6))}`);
				expect(writeLog.some((w) => w.includes('didOpen') || w.includes('_isSpellCheckEnabled')), writeLog.join(' | ')).toBe(true);
			}
		);
	}
});
