// Module 15 — Build & Release Pipeline.
//
// The macOS DMG recovery: clean up Tauri's DMG scratch volumes, and when
// `tauri build` died in its bundle_dmg.sh step, produce the DMG ourselves.
//
// Why this exists: tauri-bundler's bundle_dmg.sh (the create-dmg fork) runs a
// Finder AppleScript to lay out the DMG window, then detaches the scratch
// volume with three short retries. Finder — and Spotlight racing on the
// freshly mounted copy of the app — sometimes still holds the volume past
// that window, every retry answers `资源忙` (EBUSY, exit 16), and the build
// fails with `error running bundle_dmg.sh` while leaking the mounted scratch
// volume and a Finder window (the pile-up makes the next race likelier).
// tauri rewrites bundle_dmg.sh on every build, so the retry patience cannot
// be patched in place; what can be done is run the same script again — and,
// if the race repeats, without the Finder step at all (`--skip-jenkins`,
// tauri-bundler's own answer for Finder-less environments: the DMG loses
// only icon positioning, never content).
//
// Usage:
//   node scripts/recover-dmg.mjs --clean-only      detach stale scratch volumes, remove their rw.* images
//   node scripts/recover-dmg.mjs [--since <epoch>] re-bundle the DMG (guard: script fresh since <epoch>)
//
// --clean-only runs before every macOS build (scripts/build-studio.sh);
// the recover form runs only after `tauri build` failed, and exits non-zero
// unless it ends up holding a current DMG — a build that failed before the
// DMG step must keep failing.

import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, existsSync, statSync, unlinkSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';

const repo = process.cwd();
const bundleRoot = 'target/studio/cargo/release/bundle';
const tauriConf = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'));
const product = tauriConf.productName;
const mainBinary = tauriConf.mainBinaryName;
const dmgSettings = tauriConf.bundle?.macOS?.dmg ?? {};

function run(cmd, args, opts = {}) {
	const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 300_000, ...opts });
	return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

// The arch tauri put in the DMG name comes from the binary it just built.
function archOfBinary() {
	const exe = `${bundleRoot}/macos/${product}.app/Contents/MacOS/${mainBinary}`;
	if (!existsSync(exe)) return null;
	const { stdout } = run('/usr/bin/file', ['-b', exe]);
	if (stdout.includes('universal')) return 'universal';
	if (stdout.includes('arm64')) return 'aarch64';
	if (stdout.includes('x86_64')) return 'x64';
	return null;
}

// Scratch volumes tauri's DMG step mounts: /Volumes/dmg.XXXXXX backed by an
// rw.*.dmg image under this build's bundle/macos. Nothing else is ever
// touched — the user's own mounted volumes are not ours to detach.
function staleScratchVolumes() {
	const info = run('/usr/bin/hdiutil', ['info']).stdout;
	const stale = [];
	let imagePath = null;
	for (const line of info.split('\n')) {
		const pathMatch = line.match(/^image-path\s*:\s*(.*)$/);
		if (pathMatch) {
			imagePath = pathMatch[1].trim();
			continue;
		}
		const devMatch = line.match(/^(\/dev\/disk\d+s?\d*)\s+\S+\s+(\/Volumes\/dmg\.\S+)/);
		if (devMatch && imagePath && imagePath.startsWith(`${repo}/${bundleRoot}/macos/rw.`)) {
			stale.push({ imagePath, mountPoint: devMatch[2] });
		}
	}
	return stale;
}

function detachStaleVolumes() {
	const stale = staleScratchVolumes();
	for (const { imagePath, mountPoint } of stale) {
		// Best effort: close the Finder window holding the volume, then detach
		// politely before forcing (a forced detach of scratch is safe — the rw
		// image is regenerable build output).
		// Short timeout: a Sequoia automation prompt must not hang the pass.
		run('/usr/bin/osascript', [
			'-e', 'tell application "Finder" to close every window whose name starts with "dmg."',
		], { timeout: 5_000 });
		let ejected = false;
		for (let attempt = 0; attempt < 3 && !ejected; attempt++) {
			ejected = run('/usr/bin/hdiutil', ['detach', mountPoint]).status === 0;
			if (!ejected) run('/bin/sleep', ['2']);
		}
		if (!ejected) run('/usr/bin/hdiutil', ['detach', '-force', mountPoint]);
		console.log(`[recover-dmg] detached stale scratch volume ${mountPoint}`);
	}
	// The rw.* image files failed runs leave behind (65 MB each) — gone once
	// detached, whether this run or an earlier one mounted them. Every rw.*
	// under the staging dir is leaked scratch: a live build's scratch is
	// mounted (never present while this script runs), a finished one deletes
	// its own.
	for (const name of readdirSync(`${bundleRoot}/macos`)) {
		if (/^rw\..*\.dmg$/.test(name)) {
			try {
				unlinkSync(`${bundleRoot}/macos/${name}`);
				console.log(`[recover-dmg] removed leaked scratch image ${name}`);
			} catch {
				/* still attached — handled (or force-detached) above */
			}
		}
	}
	return stale.length;
}

const cleanOnly = process.argv.includes('--clean-only');
const sinceFlag = process.argv.indexOf('--since');
const since = sinceFlag !== -1 ? Number(process.argv[sinceFlag + 1]) : null;

const detached = detachStaleVolumes();
if (cleanOnly) {
	console.log(`[recover-dmg] clean pass complete (${detached} stale scratch volume${detached === 1 ? '' : 's'})`);
	process.exit(0);
}

// --- recover mode: produce the DMG tauri's step could not -------------------

const dmgDir = `${bundleRoot}/dmg`;
const macosDir = `${bundleRoot}/macos`;
const script = `${dmgDir}/bundle_dmg.sh`;
const arch = archOfBinary();
const dmgName = arch ? `${product}_${tauriConf.version}_${arch}.dmg` : null;
const dmgPath = dmgName ? `${dmgDir}/${dmgName}` : null;

const fail = (message) => {
	console.error(`[recover-dmg] ${message}`);
	process.exit(1);
};

if (!existsSync(script)) fail('no bundle_dmg.sh on disk — the build never reached the DMG step');
if (!dmgPath || !existsSync(`${macosDir}/${product}.app`)) {
	fail(`no bundled ${product}.app to pack (arch ${arch})`);
}
if (since !== null && statSync(script).mtimeMs < since * 1000) {
	fail('bundle_dmg.sh predates this build — the failure was not in the DMG step');
}
if (existsSync(dmgPath)) {
	console.log(`[recover-dmg] ${dmgName} already bundled`);
	process.exit(0);
}

// The exact argv tauri-bundler passes (dmg.rs 2.9.4): the layout constants are
// its defaults, overridable through bundle.macOS.dmg in tauri.conf.json — kept
// in sync by reading them back out of the config here.
const appPosition = dmgSettings.appPosition ?? { x: 180, y: 170 };
const folderPosition = dmgSettings.applicationFolderPosition ?? { x: 480, y: 170 };
const windowSize = dmgSettings.windowSize ?? { width: 660, height: 400 };
const baseArgs = [
	'--volname', product,
	'--icon', `${product}.app`, String(appPosition.x), String(appPosition.y),
	'--app-drop-link', String(folderPosition.x), String(folderPosition.y),
	'--window-size', String(windowSize.width), String(windowSize.height),
	'--hide-extension', `${product}.app`,
];
const volicon = resolve(`${dmgDir}/icon.icns`);
if (existsSync(volicon)) baseArgs.push('--volicon', volicon);
// A real signing identity signs the DMG too (ad-hoc "-" does not, matching
// tauri-bundler, which skips DMG signing for the ad-hoc seal).
const signingIdentity = (() => {
	try {
		const identity = JSON.parse(readFileSync('target/studio/signing.json', 'utf8'))
			.bundle?.macOS?.signingIdentity;
		return identity && identity !== '-' ? identity : null;
	} catch {
		return null;
	}
})();

// Attempt 1 keeps the Finder layout (the pretty DMG); attempt 2 drops it —
// the deterministic path, since no AppleScript means nothing holds the volume.
for (const [label, extraArgs] of [['full layout', []], ['skip-jenkins (no Finder layout)', ['--skip-jenkins']]]) {
	detachStaleVolumes();
	console.log(`[recover-dmg] running bundle_dmg.sh — attempt: ${label}`);
	// The script and volicon must be absolute — the child runs in macosDir.
	const r = run('/bin/bash', [resolve(script), ...baseArgs, ...extraArgs, dmgName, `${product}.app`], {
		cwd: macosDir,
	});
	process.stdout.write(r.stdout);
	process.stderr.write(r.stderr);
	if (r.status === 0) {
		renameSync(`${macosDir}/${dmgName}`, dmgPath);
		if (signingIdentity) {
			const sign = run('/usr/bin/codesign', ['--sign', signingIdentity, dmgPath]);
			if (sign.status !== 0) fail(`DMG produced but signing failed: ${sign.stderr.trim()}`);
		}
		console.log(`[recover-dmg] recovered ${dmgPath}`);
		process.exit(0);
	}
	console.error(`[recover-dmg] attempt "${label}" failed (exit ${r.status})`);
}
fail('bundle_dmg.sh failed in both forms — see output above');
