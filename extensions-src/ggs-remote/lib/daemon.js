// The daemon binary this package carries (docs/ggs-remote-plan.md §14.2): bin/<platform>/
// ggs-remote(.exe), one per VSIX platform target. Everything that touches ~/.ggs/remote —
// installing the copy that runs, starting it detached, the admin API — is the binary's own
// CLI; this module only finds it and runs it, so the extension needs no file system access
// (it runs in GGS's sandboxed extension frame as well as in a Node host).
'use strict';

const path = require('path');
const childProcess = require('child_process');

function platformDir() {
	const platform = process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux';
	const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
	return `${platform}-${arch}`;
}

function binaryPath(extensionPath) {
	const exe = process.platform === 'win32' ? 'ggs-remote.exe' : 'ggs-remote';
	return path.join(extensionPath, 'bin', platformDir(), exe);
}

/** Run the CLI; resolves with stdout, rejects with the CLI's own error line. */
function run(extensionPath, args, input) {
	return new Promise((resolve, reject) => {
		const child = childProcess.spawn(binaryPath(extensionPath), args, { windowsHide: true });
		let stdout = '';
		let stderr = '';
		child.stdout.on('data', (chunk) => {
			stdout += String(chunk);
		});
		child.stderr.on('data', (chunk) => {
			stderr += String(chunk);
		});
		child.on('error', (error) => reject(error));
		child.on('close', (code) => {
			if (code === 0) resolve(stdout);
			else reject(new Error((stderr || stdout).replace(/^ggs-remote:\s*/, '').trim() || `ggs-remote exited with ${code}`));
		});
		if (input !== undefined) child.stdin.write(input);
		child.stdin.end();
	});
}

/** Install (forward-only) and start the daemon; tells it the GGS executable and this
 *  package's directory. Resolves with `{ outcome, version }`. */
async function ensureRunning(extensionPath) {
	const args = ['install', '--extension-dir', extensionPath];
	const ggsExe = process.env.GGS_APP_EXE;
	if (ggsExe) args.push('--ggs-exe', ggsExe);
	const out = await run(extensionPath, args);
	try {
		return JSON.parse(out.trim().split('\n').pop());
	} catch {
		return { outcome: 'unknown', version: '' };
	}
}

module.exports = { binaryPath, platformDir, run, ensureRunning };
