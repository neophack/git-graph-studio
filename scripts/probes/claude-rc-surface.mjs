// claude-rc-surface — re-check the claude-code Remote Control surface on every new
// version (plan §1.3/§8): the markers that keep the CLI's RC pinned to Anthropic's own
// bridge, and the webview message shapes Claude Remote 2.0's tap and remote-control
// bridge rely on. One line per marker; --strict fails on any shape the plan's
// conclusions depend on having changed.
//
//   node scripts/probes/claude-rc-surface.mjs [--strict] [--dir <extension dir>]
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const strict = args.includes('--strict');
const dirFlag = args.indexOf('--dir');
const roots = dirFlag >= 0
	? [args[dirFlag + 1]]
	: ['.ggs/extensions', '.vscode/extensions', '.vscode-insiders/extensions'].map((d) => join(homedir(), d));

function findExtension() {
	for (const root of roots) {
		let entries = [];
		try { entries = readdirSync(root); } catch { continue; }
		const found = entries.filter((e) => /^anthropic\.claude-code-/i.test(e)).sort().reverse();
		for (const entry of found) {
			for (const candidate of ['extension.js', 'dist/extension.js', 'out/extension.js']) {
				const file = join(root, entry, candidate);
				if (existsSync(file)) return { file, version: entry };
			}
			// Any large .js at the package root is the bundle.
			for (const name of readdirSync(join(root, entry))) {
				if (name.endsWith('.js') && !name.includes('.map')) {
					const file = join(root, entry, name);
					if (readFileSync(file, 'utf8').length > 100_000) return { file, version: entry };
				}
			}
		}
	}
	return null;
}

const found = findExtension();
if (!found) {
	console.log('no anthropic.claude-code installation found under:', roots.join(', '));
	process.exit(strict ? 1 : 0);
}
const bundle = readFileSync(found.file, 'utf8');
console.log(`scanning ${found.version} (${found.file}, ${(bundle.length / 1e6).toFixed(1)} MB)`);

const at = (needle) => bundle.indexOf(needle);

/** The markers of plan §1.3 — each one a reason the CLI's RC cannot point elsewhere. */
const pinned = [
	['CLAUDE_BRIDGE_BASE_URL named', at('CLAUDE_BRIDGE_BASE_URL') >= 0],
	['CLAUDE_BRIDGE_OAUTH_TOKEN named', at('CLAUDE_BRIDGE_OAUTH_TOKEN') >= 0],
	['CLAUDE_CODE_CUSTOM_OAUTH_URL whitelist ("not an approved endpoint")', at('CLAUDE_CODE_CUSTOM_OAUTH_URL') >= 0 && at('approved endpoint') >= 0],
	['CLAUDE_CODE_REMOTE_SDK_URL named', at('CLAUDE_CODE_REMOTE_SDK_URL') >= 0],
	['channels gated on third-party providers', at('channels are not available') >= 0 || at('channelsEnabled') >= 0]
];

// Informational: heuristics whose shape moves between bundler versions — read by hand
// when a strict marker moves, never a failure on their own.
const informational = [
	['bridge override possibly compiled empty (a bare `function x(){return}` near the marker)', (() => {
		const at0 = at('CLAUDE_BRIDGE_BASE_URL');
		if (at0 < 0) return 'n/a';
		const window = bundle.slice(Math.max(0, at0 - 3000), at0 + 3000);
		return /function\s+\w+\(\)\s*\{\s*return\s*\}/.test(window) ? 'yes' : 'not visible in this bundle shape';
	})()],
	['--sdk-url / "not_allowlisted" allowlist', at('not_allowlisted') >= 0 || at('--sdk-url') >= 0 ? 'yes' : 'not in extension.js (check the native binary)']
];

/** The shapes of plan §1.4 — what the tap mirrors and the bridge synthesizes. */
const shapes = [
	['toggle_remote_control request type', at('toggle_remote_control') >= 0],
	['remote-control state pushes (either spelling)', at('channelRemoteControlState') >= 0 || at('remoteControlState') >= 0],
	['channelRemoteControlAvailable pushes', at('channelRemoteControlAvailable') >= 0],
	['io_message envelope', at('io_message') >= 0],
	['tool_permission_request envelope', at('tool_permission_request') >= 0],
	['control_request / control_response vocabulary', at('control_request') >= 0 && at('control_response') >= 0],
	['remoteControlAtStartup setting', at('remoteControlAtStartup') >= 0],
	['update_session_state (the panel↔session map)', at('update_session_state') >= 0]
];

for (const [label, value] of informational) {
	console.log(`INFO   ${label}: ${value}`);
}

let failures = 0;
for (const [label, ok] of [...pinned.map(([l, o]) => [`pinned  ${l}`, o]), ...shapes.map(([l, o]) => [`shape   ${l}`, o])]) {
	console.log(`${ok ? 'OK ' : 'GONE'}  ${label}`);
	if (!ok) failures++;
}

console.log(failures === 0
	? 'the Remote Control surface matches the plan\'s analysis (self-hosting stays on the SDK-message seam)'
	: `${failures} marker(s) moved — re-read §1.3/§1.4 of docs/claude-remote-rc-plan.md against this version`);
process.exit(strict && failures ? 1 : 0);
