// The IPC contract check of docs/architecture-restructure-plan.md §5.6 / D.2: the command
// names the frontend invokes must be exactly the names the backend registers — until now
// nothing compared the two sides, and a rename only failed at runtime. The check reads
// the Rust registration (src-tauri/src/commands/mod.rs once it exists, lib.rs before
// P4), every invoke('…') literal under src/ (platform/ipc/** only, after P5-4), the
// remote path gate's name lists, and the tests' scripted handlers.
//
//   failure: a name the TS side (or pathGate) uses that Rust never registered;
//   warning: a registered command no side ever names (dead-command candidate — reviewed,
//            not fatal: commands reached through variable names are legitimate);
//   failure: an event-name constant present on one side of the Rust/TS event tables and
//            missing on the other (checked once both tables exist).
//
// Run standalone (`node scripts/check-ipc.mjs`) or through scripts/check-seams.mjs.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');

function listFiles(dir, exts, out = []) {
	if (!existsSync(dir)) return out;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) listFiles(path, exts, out);
		else if (exts.some((e) => entry.name.endsWith(e))) out.push(path);
	}
	return out;
}

const rel = (abs) => relative(appDir, abs).split(sep).join('/');

/** The Rust registration list: every entry of the generate_handler! macro, last segment
 *  of the path (cmd_fs::list_dir registers `list_dir` on the wire). */
export function rustCommandNames() {
	const candidates = ['src-tauri/src/commands/mod.rs', 'src-tauri/src/lib.rs'];
	const file = candidates.find((c) => existsSync(join(appDir, c)));
	if (!file) throw new Error('check-ipc: no generate_handler! source found (lib.rs or commands/mod.rs)');
	const content = readFileSync(join(appDir, file), 'utf8');
	const start = content.indexOf('generate_handler![');
	if (start === -1) throw new Error(`check-ipc: generate_handler![ not found in ${file}`);
	const end = content.indexOf('])', start);
	const body = content.slice(start, end);
	const names = new Set();
	for (const entry of body.split(/[\s,]+/)) {
		const id = entry.trim().split('::').pop();
		if (/^[a-z][a-z0-9_]*$/.test(id)) names.add(id);
	}
	return { source: file, names };
}

/** Every invoke('name' literal under src/ — platform/ipc/** plus anything else until
 *  P5-4 moves the calls. Variable-command invokes are invisible to this scan by nature. */
export function tsCommandNames() {
	const names = new Set();
	for (const file of listFiles(join(appDir, 'src'), ['.ts'])) {
		for (const name of extractInvokeLiterals(readFileSync(file, 'utf8'))) names.add(name);
	}
	return names;
}

/** invoke('x' / invoke<T>('x' with any nesting in <T> (Record<string, string> breaks a
 *  naive regex), skipping member calls and longer identifiers around the word. */
function extractInvokeLiterals(content) {
	const names = [];
	let idx = 0;
	while ((idx = content.indexOf('invoke', idx)) !== -1) {
		idx += 'invoke'.length;
		const before = content[idx - 'invoke'.length - 1] ?? '';
		if (/[\w$.]/.test(before)) continue;
		let i = idx;
		while (i < content.length && /\s/.test(content[i])) i++;
		if (content[i] === '<') {
			let depth = 0;
			let j = i;
			for (; j < content.length; j++) {
				if (content[j] === '<') depth += 1;
				else if (content[j] === '>') {
					depth -= 1;
					if (depth === 0) break;
				}
			}
			i = j + 1;
			while (i < content.length && /\s/.test(content[i])) i++;
		}
		if (content[i] !== '(') continue;
		i += 1;
		while (i < content.length && /\s/.test(content[i])) i++;
		const quote = content[i];
		if (quote !== "'" && quote !== '"' && quote !== '`') continue;
		const end = content.indexOf(quote, i + 1);
		if (end === -1) continue;
		const name = content.slice(i + 1, end);
		if (/^[a-z0-9_]+$/.test(name)) names.push(name);
	}
	return names;
}

/** remote/pathGate.ts: every command name its lists mention (REFUSED_COMMANDS literals
 *  and the PATH_GATED keys). */
function pathGateNames() {
	const path = join(appDir, 'src', 'remote', 'pathGate.ts');
	if (!existsSync(path)) return new Set();
	const content = readFileSync(path, 'utf8');
	const names = new Set();
	const gateStart = content.indexOf('PATH_GATED');
	const gateEnd = content.indexOf('\n};', gateStart);
	const gateBody = gateStart !== -1 ? content.slice(gateStart, gateEnd) : '';
	for (const m of gateBody.matchAll(/^\t([a-z0-9_]+):/gm)) names.add(m[1]);
	const refused = content.match(/REFUSED_COMMANDS[^=]*=\s*new Set<string>\(\[([^\]]*)\]/s);
	if (refused) {
		for (const lit of refused[1].matchAll(/['"]([a-z0-9_]+)['"]/g)) names.add(lit[1]);
	}
	return names;
}

/** The scripted backend's command names in tests (dead-command judgement only). */
function testScriptedNames() {
	const names = new Set();
	for (const file of listFiles(join(appDir, 'tests'), ['.ts'])) {
		const content = readFileSync(file, 'utf8');
		for (const m of content.matchAll(/(?:backend\.on|handlers\.set)\(\s*['"]([a-z0-9_]+)['"]/g)) names.add(m[1]);
	}
	return names;
}

/** Event-name constants: ggs-base's events module (Rust) vs platform/ipc/events.ts (TS).
 *  Both are introduced by P3; until then the comparison is skipped. */
function eventTableComparison() {
	const rustPath = join(appDir, 'src-tauri', 'crates', 'ggs-base', 'src', 'events.rs');
	const tsPath = join(appDir, 'src', 'platform', 'ipc', 'events.ts');
	if (!existsSync(rustPath) || !existsSync(tsPath)) return { skipped: true };
	const extractRust = new Set([...readFileSync(rustPath, 'utf8').matchAll(/pub const ([A-Z0-9_]+)\s*:\s*&str\s*=\s*"([^"]+)"/g)].map((m) => m[2]));
	const extractTs = new Set([...readFileSync(tsPath, 'utf8').matchAll(/=\s*'([^']+)'/g)].map((m) => m[1]));
	const missingTs = [...extractRust].filter((e) => !extractTs.has(e));
	const missingRust = [...extractTs].filter((e) => !extractRust.has(e));
	return { skipped: false, missingTs, missingRust };
}

export function checkIpc() {
	const rust = rustCommandNames();
	const ts = tsCommandNames();
	const gate = pathGateNames();
	const scripted = testScriptedNames();

	const errors = [];
	for (const name of [...ts].sort()) {
		if (!rust.names.has(name)) errors.push(`  TS invokes '${name}' but the backend never registers it (${rust.source})`);
	}
	for (const name of [...gate].sort()) {
		if (!rust.names.has(name)) errors.push(`  remote/pathGate.ts names '${name}' but the backend never registers it`);
	}
	const events = eventTableComparison();
	if (!events.skipped) {
		for (const e of events.missingTs) errors.push(`  event '${e}' is a Rust constant but absent from src/platform/ipc/events.ts`);
		for (const e of events.missingRust) errors.push(`  event '${e}' is in src/platform/ipc/events.ts but no Rust constant carries it`);
	}
	if (errors.length > 0) throw new Error(`IPC contract violations (docs/architecture-restructure-plan.md §5.6):\n${errors.join('\n')}`);

	const dead = [...rust.names].filter((n) => !ts.has(n) && !gate.has(n) && !scripted.has(n)).sort();
	if (dead.length > 0) {
		console.error(`check-ipc: ${dead.length} registered commands no side names (dead-command candidates, reviewed not fatal): ${dead.join(', ')}`);
	}
	return { registered: rust.names.size, invoked: ts.size, gated: gate.size, scripted: scripted.size, dead: dead.length };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	const summary = checkIpc();
	console.log(`check-ipc: ${summary.registered} registered, ${summary.invoked} invoked, ${summary.gated} path-gated, ${summary.scripted} scripted, ${summary.dead} dead candidates.`);
}
