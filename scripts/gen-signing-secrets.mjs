// Module 15 — Build & Release Pipeline.
//
// Generates, in one step, the exact content GitHub's "Actions secrets and variables"
// page (https://github.com/<owner>/<repo>/settings/secrets/actions) expects for the
// installer signing (see scripts/signing.mjs and README → Code signing). The raw
// material stays on this machine: certificates are read, transformed (base64, the
// signing identity derived from the P12's CN, the GPG secret key exported) and either
// printed for pasting or pushed straight into the repository with `gh secret set`.
//
//   node scripts/gen-signing-secrets.mjs \
//     --p12 ~/certs/DeveloperID.p12 [--p12-password …] \
//     [--p8 ~/certs/AuthKey_XYZ.p8 --issuer <uuid>] \
//     [--pfx ~/certs/codesign.pfx [--pfx-password …]] \
//     [--gpg <key-id|email> [--gpg-passphrase …]] \
//     [--identity "Developer ID Application: …"] \
//     [--out-dir target/studio/secrets] [--apply]
//
// Every secret listed in README → Code signing is derived from what you pass:
//   --p12  → APPLE_CERTIFICATE (base64) + APPLE_CERTIFICATE_PASSWORD +
//            APPLE_SIGNING_IDENTITY (the certificate's CN, unless --identity says
//            otherwise — openssl must be able to read the P12 to derive it)
//   --p8   → APPLE_API_KEY (the file's content) + APPLE_API_KEY_ID (from --key-id or
//            the AuthKey_<id>.p8 file name) + APPLE_API_ISSUER
//   --pfx  → WINDOWS_CERTIFICATE (base64) + WINDOWS_CERTIFICATE_PASSWORD
//   --gpg  → GPG_PRIVATE_KEY (armored export) + GPG_PASSPHRASE (with --gpg-passphrase)
//
// --apply pushes each secret with `gh secret set` (repo taken from the origin remote,
// or --repo owner/repo). Without it the values are printed and written one file per
// secret under --out-dir (target/studio is gitignored). The printed values ARE the
// live secrets — clear the terminal when you are done.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { basename, isAbsolute, join, resolve } from 'node:path';

// --- arguments ------------------------------------------------------------------

function usage() {
	console.log(`Usage: node scripts/gen-signing-secrets.mjs
  --p12 <file>              Developer ID certificate (.p12) -> APPLE_CERTIFICATE*
  --p12-password <value>    its password (empty-password certificates need no flag)
  --identity <value>        APPLE_SIGNING_IDENTITY (derived from the P12's CN by default)
  --p8 <file>               App Store Connect API key (.p8) -> APPLE_API_KEY*
  --key-id <value>          the key's id (default: from the AuthKey_<id>.p8 file name)
  --issuer <value>          the key's issuer (uuid) -> APPLE_API_ISSUER
  --pfx <file>              Windows code-signing certificate (.pfx) -> WINDOWS_CERTIFICATE*
  --pfx-password <value>    its password
  --gpg <key-id|email>      GPG identity -> GPG_PRIVATE_KEY (armored secret-key export)
  --gpg-passphrase <value>  GPG_PASSPHRASE (only when the key has one)
  --out-dir <dir>           where the per-secret files land (default target/studio/secrets)
  --repo <owner/repo>       with --apply: the repository (default: from the origin remote)
  --apply                   push the secrets with \`gh secret set\` instead of only printing`);
}

const args = {};
for (let i = 2; i < process.argv.length; i++) {
	const flag = process.argv[i];
	if (flag === '--help' || flag === '-h') {
		usage();
		process.exit(0);
	}
	if (!flag.startsWith('--')) {
		console.error(`[error] unexpected argument "${flag}"`);
		usage();
		process.exit(1);
	}
	const value = process.argv[i + 1];
	if (value === undefined || value.startsWith('--')) {
		args[flag] = true;
	} else {
		args[flag] = value;
		i++;
	}
}

const fileOf = (flag) => {
	const value = args[flag];
	if (!value) return undefined;
	const path = isAbsolute(value) ? value : resolve(value);
	if (!existsSync(path)) {
		console.error(`[error] ${flag}: no such file: ${path}`);
		process.exit(1);
	}
	return path;
};

// --- derivations ----------------------------------------------------------------

// The bundler validates that APPLE_SIGNING_IDENTITY appears inside the imported
// certificate's identity; the Developer ID certificate's CN IS that string
// ("Developer ID Application: Name (TeamID)").
function identityFromP12(p12, password) {
	const out = spawnSync(
		'openssl',
		['pkcs12', '-in', p12, '-passin', `pass:${password ?? ''}`, '-nokeys'],
		{ encoding: 'utf8' },
	);
	if (out.status !== 0) {
		console.error(`[error] openssl could not read the P12 (${
			(out.stderr || '').trim().split('\n')[0] || `exit ${out.status}`
		}) — wrong password? pass --p12-password (certificates with an empty password cannot be stored as a GitHub secret; re-export one with a password)`);
		process.exit(1);
	}
	// The subject block of the leaf certificate: a Keychain-exported P12 carries the
	// intermediates too, and their issuer lines also spell "CN" — the identity wanted
	// is the leaf's, the CN that starts with "Developer ID Application".
	const lines = (out.stdout || '').split('\n');
	const start = lines.findIndex((l) => l.startsWith('subject'));
	if (start === -1) return undefined;
	const endLine = lines.findIndex((l, i) => i > start && (l.startsWith('-----BEGIN') || l.startsWith('Bag Attributes')));
	const block = lines.slice(start, endLine === -1 ? undefined : endLine).join('\n');
	const devId = block.match(/CN\s*=\s*(Developer ID Application[^,/\n+]+)/);
	if (devId) return devId[1].trim();
	const any = block.match(/CN\s*=\s*([^,/\n+]+)/);
	return any ? any[1].trim() : undefined;
}

function gpgSecretKey(identity) {
	const out = spawnSync('gpg', ['--armor', '--export-secret-keys', identity], {
		encoding: 'utf8',
		maxBuffer: 64 * 1024 * 1024,
	});
	if (out.status !== 0 || !(out.stdout || '').includes('BEGIN PGP PRIVATE KEY BLOCK')) {
		console.error(`[error] gpg: no exportable secret key for "${identity}" (${
			out.error?.message ?? (out.stderr || '').trim().split('\n')[0] ?? `exit ${out.status}`
		})`);
		process.exit(1);
	}
	return out.stdout.trim();
}

function originRepo() {
	try {
		const url = execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim();
		const match = url.match(/[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
		return match ? match[1] : undefined;
	} catch {
		return undefined;
	}
}

// --- the secrets ----------------------------------------------------------------

const secrets = [];
const add = (name, value, source) => {
	if (value !== undefined && value !== '') secrets.push([name, String(value), source]);
};

const p12 = fileOf('--p12');
if (p12) {
	if (!args['--p12-password']) {
		console.log('[note] no --p12-password: GitHub rejects empty secret values, so a password-less certificate cannot be stored — re-export it with a password (openssl pkcs12 -export) for full signing');
	}
	add('APPLE_CERTIFICATE', readFileSync(p12).toString('base64'), 'base64 of the .p12');
	add('APPLE_CERTIFICATE_PASSWORD', args['--p12-password'] ?? '', 'the certificate\'s password');
	const derived = identityFromP12(p12, args['--p12-password']);
	const identity = args['--identity'] ?? derived;
	if (!identity) {
		console.error('[error] could not derive APPLE_SIGNING_IDENTITY from the P12 (openssl missing?); pass --identity');
		process.exit(1);
	}
	add('APPLE_SIGNING_IDENTITY', identity, derived && !args['--identity'] ? `derived: CN of ${basename(p12)}` : 'as given');
}

const p8 = fileOf('--p8');
if (p8) {
	const keyId = args['--key-id'] ?? (basename(p8).match(/^AuthKey_(.+)\.p8$/) || [])[1];
	if (!keyId) {
		console.error('[error] --p8: cannot derive the key id from the file name; pass --key-id');
		process.exit(1);
	}
	if (!args['--issuer']) {
		console.error('[error] --p8 needs --issuer <uuid>');
		process.exit(1);
	}
	add('APPLE_API_KEY', readFileSync(p8, 'utf8'), `content of ${basename(p8)}`);
	add('APPLE_API_KEY_ID', keyId, 'the key id');
	add('APPLE_API_ISSUER', args['--issuer'], 'the issuer uuid');
}

const pfx = fileOf('--pfx');
if (pfx) {
	add('WINDOWS_CERTIFICATE', readFileSync(pfx).toString('base64'), 'base64 of the .pfx');
	add('WINDOWS_CERTIFICATE_PASSWORD', args['--pfx-password'] ?? '', 'the certificate\'s password');
}

if (args['--gpg']) {
	add('GPG_PRIVATE_KEY', gpgSecretKey(args['--gpg']), `armored secret key of ${args['--gpg']}`);
	add('GPG_PASSPHRASE', args['--gpg-passphrase'], 'the key\'s passphrase');
}

if (secrets.length === 0) {
	console.error('[error] nothing to generate — pass at least one of --p12, --p8, --pfx, --gpg');
	usage();
	process.exit(1);
}

// --- output ---------------------------------------------------------------------

const outDir = args['--out-dir'] ?? 'target/studio/secrets';
const repo = args['--repo'] ?? originRepo();
const settingsUrl = repo ? `https://github.com/${repo}/settings/secrets/actions` : 'https://github.com/<owner>/<repo>/settings/secrets/actions';

console.log(`Generated ${secrets.length} secret(s) — fill them in at\n  ${settingsUrl}\n`);

mkdirSync(outDir, { recursive: true });
for (const [name, value, note] of secrets) {
	const line = `─── ${name} (${note}) `;
	console.log(line + '─'.repeat(Math.max(4, 70 - line.length)));
	console.log(value);
	console.log();
	writeFileSync(join(outDir, name), `${value}\n`);
}

console.log(`One file per secret: ${outDir}/<SECRET_NAME>  (target/ is gitignored; delete when done)`);

if (args['--apply']) {
	const gh = spawnSync('gh', ['--version'], { encoding: 'utf8' });
	if (gh.status !== 0) {
		console.error('[error] --apply: gh is not installed (https://cli.github.com) — the files are in ' + outDir);
		process.exit(1);
	}
	if (!repo) {
		console.error('[error] --apply: no origin remote; pass --repo owner/repo');
		process.exit(1);
	}
	for (const [name, value] of secrets) {
		const set = spawnSync('gh', ['secret', 'set', name, '--repo', repo], { input: value, encoding: 'utf8' });
		if (set.status !== 0) {
			console.error(`[error] gh secret set ${name}: ${(set.stderr || '').trim().split('\n')[0]}`);
			process.exit(1);
		}
		console.log(`[apply] ${repo} ← ${name}`);
	}
	console.log('Done. Re-run the Studio (or Release) workflow to build with the new signatures.');
}
