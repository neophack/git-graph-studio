// Measures the ggs-node sidecar's cold-vs-warm backend start for the installed
// git-graph-rs 1.1.0: spawn → initialize → first command answer, with GGS_TRACE_BOOT on
// (the sidecar's own phase timings cross on stderr).
//
//   node scripts/probes/ggs-node-start-bench.mjs [--cold]
//
// --cold deletes the module bytecode blobs under ~/.ggs/cache/bytecode first (the prelude
// and vscode-shim blobs stay: they cache through evaluate_cached_script).

import { spawn } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { performance } from 'node:perf_hooks';

const args = process.argv.slice(2);
const cold = args.includes('--cold');
const sidecar = join(process.cwd(), 'target', 'studio', 'cargo', 'debug', 'ggs-node.exe');
const extDir = join(homedir(), '.ggs', 'extensions', 'neophack.git-graph-rs-1.1.0');
const entry = join(extDir, 'dist', 'extension.js');
if (!existsSync(sidecar) || !existsSync(entry)) {
	console.error('no sidecar or extension — build the sidecar first (cargo build -p ggs-node)');
	process.exit(2);
}

if (cold) {
	const root = join(homedir(), '.ggs', 'cache', 'bytecode');
	for (const name of readdirSync(root)) {
		if (name.startsWith('v4-') && !name.startsWith('v4-prelude') && !name.startsWith('v4-vscode-shim')) {
			rmSync(join(root, name));
		}
	}
	console.log('[bench] module bytecode blobs deleted (cold start)');
}

const child = spawn(sidecar, [entry], {
	cwd: extDir,
	env: { ...process.env, GGS_TRACE_BOOT: '1' },
	stdio: ['pipe', 'pipe', 'pipe']
});
child.stderr.on('data', (chunk) => process.stderr.write(`[sidecar] ${chunk}`));

let buffer = '';
const started = performance.now();
const answer = new Promise((resolve, reject) => {
	const timer = setTimeout(() => reject(new Error('timeout')), 120000);
	child.stdout.on('data', (chunk) => {
		buffer += chunk;
		let at;
		while ((at = buffer.indexOf('\n')) !== -1) {
			const line = buffer.slice(0, at);
			buffer = buffer.slice(at + 1);
			if (!line.trim()) continue;
			let wire;
			try {
				wire = JSON.parse(line);
			} catch {
				continue;
			}
			if (wire.method === 'ggs.hostRequest') {
				// The shim's activation asks host.env; null answers it (the integration
				// tests' convention).
				child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: wire.id, result: null })}\n`);
			} else if (wire.id === 1) {
				// initialize answered — the activation is queued; the first command rides it out.
				const now = performance.now();
				console.log(`[bench] initialize answered at ${(now - started).toFixed(0)} ms`);
				child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'runCommand', params: { command: 'git-graph-rs.version', args: [] } })}\n`);
			} else if (wire.id === 2) {
				clearTimeout(timer);
				resolve(wire);
			}
		}
	});
	child.on('exit', (code) => reject(new Error(`sidecar exited: ${code}`)));
	child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 'ggs-ext/1', extensionId: 'neophack.git-graph-rs', extensionPath: extDir, workspaceFolders: [] } })}\n`);
});

const result = await answer;
const total = performance.now() - started;
console.log(`[bench] first command answered at ${total.toFixed(0)} ms from spawn — ${JSON.stringify(result.result ?? result.error)}`);
child.kill();
process.exit(0);
