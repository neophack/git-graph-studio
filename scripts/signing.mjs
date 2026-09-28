// Module 15 — Build & Release Pipeline.
//
// Decides this build's code signing from the environment — never from the sources. The
// certificates themselves live in GitHub Secrets (or a developer's own shell); everything
// this script writes is the `tauri build --config` merge file target/studio/signing.json
// plus, in CI, the credential exports in $GITHUB_ENV. No secret material passes through
// the repository.
//
//   macOS: with APPLE_CERTIFICATE (base64 P12) + APPLE_CERTIFICATE_PASSWORD +
//   APPLE_SIGNING_IDENTITY present, the bundler imports the Developer ID certificate,
//   signs the whole bundle and — when the App Store Connect key is there too
//   (APPLE_API_KEY_ID + APPLE_API_ISSUER + APPLE_API_KEY carrying the .p8's content) —
//   notarizes and staples the ticket. Without them the build falls back to the ad-hoc
//   bundle seal (signingIdentity "-"). The seal matters: a macOS bundle with no signature
//   of its own — the linker-only state tauri-bundler leaves behind when no identity is
//   configured, which is what the 0.1.5 dmg shipped — is assessed by Gatekeeper as
//   DAMAGED (the un-bypassable "move it to the Trash" dialog), while a sealed ad-hoc
//   bundle is merely unverified (right-click → Open).
//
//   The exports go through this script because of the empty-string trap: an env var set
//   to "" reads as PRESENT to the bundler's credential detection and fails the build, so
//   the APPLE_* variables reach `tauri build` only when their secrets are non-empty.
//
// Usage: node scripts/signing.mjs macos
// Locally (no $GITHUB_ENV) it prints the exports to make yourself instead; when you
// export none of them the ad-hoc seal is what you get.

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';

const mergePath = 'target/studio/signing.json';
const env = process.env;

const mode = process.argv[2];
if (mode !== 'macos') {
	console.error(`[error] signing.mjs: unknown mode "${mode ?? ''}" (expected: macos)`);
	process.exit(1);
}

const identity = (env.APPLE_SIGNING_IDENTITY || '').trim();
const fullSigning = Boolean(env.APPLE_CERTIFICATE && env.APPLE_CERTIFICATE_PASSWORD && identity);
const merge = { bundle: { macOS: { signingIdentity: fullSigning ? identity : '-' } } };
mkdirSync('target/studio', { recursive: true });
writeFileSync(mergePath, `${JSON.stringify(merge, null, 2)}\n`);

// The credentials `tauri build` itself reads — exported only when really present (see the
// empty-string trap above). The .p8 crosses as the APPLE_API_KEY secret's CONTENT and
// must live on disk under notarytool's own name scheme.
const exports = [];
if (fullSigning) {
	exports.push(
		['APPLE_CERTIFICATE', env.APPLE_CERTIFICATE],
		['APPLE_CERTIFICATE_PASSWORD', env.APPLE_CERTIFICATE_PASSWORD],
		['APPLE_SIGNING_IDENTITY', identity],
	);
	const keyId = (env.APPLE_API_KEY_ID || '').trim();
	const issuer = (env.APPLE_API_ISSUER || '').trim();
	const p8 = env.APPLE_API_KEY;
	if (keyId && issuer && p8) {
		const p8Path = `target/studio/AuthKey_${keyId}.p8`;
		writeFileSync(p8Path, p8.endsWith('\n') ? p8 : `${p8}\n`);
		exports.push(['APPLE_API_KEY', keyId], ['APPLE_API_KEY_PATH', p8Path], ['APPLE_API_ISSUER', issuer]);
	}
}

if (exports.length === 0) {
	console.log(`[signing] no signing secrets — ad-hoc bundle seal (${mergePath})`);
} else if (env.GITHUB_ENV) {
	appendFileSync(env.GITHUB_ENV, exports.map(([key, value]) => `${key}=${value}\n`).join(''));
	console.log(`[signing] Developer ID signing wired (${mergePath}; ${exports.length} credentials exported to $GITHUB_ENV)`);
} else {
	console.log('[signing] Developer ID signing wired — export these before `tauri build` (or unset them for the ad-hoc seal):');
	for (const [key, value] of exports) console.log(`  export ${key}=${JSON.stringify(value)}`);
}
