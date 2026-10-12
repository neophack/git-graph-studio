// Module 15 — Build & Release Pipeline.
//
// The marketplace fetcher behind prepare.mjs (scripts/fetch-marketplace-extensions.mjs):
// the cache contract that decides whether an installer's bundled extensions are the
// registry's latest. A dev iteration rides the cache TTL and never phones home; a build
// pass (prepare.mjs --build, tauri.conf.json's beforeBuildCommand) re-checks open-vsx.org
// even when the cache is fresh (2026-09-30, the owner's direction), downloads only a
// genuinely newer build, and keeps the stale-cache fallback when the registry is
// unreachable.
/**
 * @vitest-environment node
 */
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { fetchMarketplacePackages, MARKETPLACE_PACKAGES, validatePackage } from '../scripts/fetch-marketplace-extensions.mjs';

const REGISTRY = 'https://open-vsx.test';
const PLATFORM = 'linux-x64';
const gitGraphSpec = MARKETPLACE_PACKAGES.find((spec) => spec.slug === 'git-graph-rs')!;
const selectGitGraph = { 'git-graph-rs': true, 'claude-code': false };

/** A stored (uncompressed) zip: proper local headers, a central directory, an EOCD — the
 * shape validatePackage's central-directory pass reads, with a padded engine entry so the
 * download-size floor holds. */
function makeVsix(): Buffer {
	const entries: [string, Buffer][] = [
		['extension/package.json', Buffer.from(JSON.stringify({ name: 'git-graph-rs', version: '0.0.0' }))],
		['extension/engine.node', Buffer.alloc(150 * 1024, 7)]
	];
	const parts: Buffer[] = [];
	const central: Buffer[] = [];
	let offset = 0;
	for (const [name, data] of entries) {
		const nameBytes = Buffer.from(name, 'utf8');
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(0, 8); // method 0 — stored
		local.writeUInt32LE(data.length, 18);
		local.writeUInt32LE(data.length, 22);
		local.writeUInt16LE(nameBytes.length, 26);
		parts.push(local, nameBytes, data);
		const entry = Buffer.alloc(46);
		entry.writeUInt32LE(0x02014b50, 0);
		entry.writeUInt16LE(20, 4);
		entry.writeUInt16LE(20, 6);
		entry.writeUInt32LE(data.length, 20);
		entry.writeUInt32LE(data.length, 24);
		entry.writeUInt16LE(nameBytes.length, 28);
		entry.writeUInt32LE(offset, 42);
		central.push(entry, nameBytes);
		offset += 30 + nameBytes.length + data.length;
	}
	const directory = Buffer.concat(central);
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0);
	eocd.writeUInt16LE(central.length / 2, 10);
	eocd.writeUInt32LE(directory.length, 12);
	eocd.writeUInt32LE(offset, 16);
	return Buffer.concat([...parts, directory, eocd]);
}

/** A cache directory holding one fresh, complete git-graph-rs download. */
function primeCache(version = '1.0.0'): string {
	const dir = mkdtempSync(join(tmpdir(), 'ggs-marketplace-'));
	onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
	const pkgDir = join(dir, 'git-graph-rs');
	mkdirSync(pkgDir, { recursive: true });
	const file = `git-graph-rs-${version}@${PLATFORM}.vsix`;
	const bytes = makeVsix();
	writeFileSync(join(pkgDir, file), bytes);
	writeFileSync(join(pkgDir, 'meta.json'), JSON.stringify({
		id: 'neophack.git-graph-rs',
		version,
		targetPlatform: PLATFORM,
		url: `${REGISTRY}/file/old`,
		file,
		bytes: bytes.length,
		sha256: '0'.repeat(64),
		fetchedAt: Date.now()
	}));
	return dir;
}

const registryEntry = (version: string, url: string) => ({
	ok: true,
	status: 200,
	json: async () => ({ downloadable: true, version, downloads: { [PLATFORM]: url } })
});

const fileResponse = (bytes: Buffer) => ({
	ok: true,
	status: 200,
	arrayBuffer: async () => bytes
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('the marketplace fetch cache (module 15)', () => {
	it('a fresh cache serves a dev iteration with no network round trip', async () => {
		const cacheDir = primeCache();
		const fetchMock = vi.fn(async () => {
			throw new Error('a dev iteration must not phone home');
		});
		vi.stubGlobal('fetch', fetchMock);

		const result = await fetchMarketplacePackages({
			base: REGISTRY, cacheDir, targetPlatform: PLATFORM,
			ttlHours: 12, require: false, skip: false, select: selectGitGraph
		});

		expect(fetchMock).not.toHaveBeenCalled();
		expect(result['git-graph-rs']).toMatchObject({ selected: true, version: '1.0.0', fromCache: true });
	});

	it('a build pass (ttlHours 0) re-checks the registry and reuses a same-version cache', async () => {
		const cacheDir = primeCache();
		const fetchMock = vi.fn(async (url: string) => {
			if (url === `${REGISTRY}/api/neophack/git-graph-rs`) {
				return registryEntry('1.0.0', `${REGISTRY}/file/git-graph-rs-1.0.0.vsix`);
			}
			throw new Error('a same-version answer must not re-download the package');
		});
		vi.stubGlobal('fetch', fetchMock);

		const result = await fetchMarketplacePackages({
			base: REGISTRY, cacheDir, targetPlatform: PLATFORM,
			ttlHours: 0, require: false, skip: false, select: selectGitGraph
		});

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(result['git-graph-rs']).toMatchObject({ selected: true, version: '1.0.0', fromCache: true });
	});

	it('a build pass downloads the registry’s newer build and replaces the cache', async () => {
		const cacheDir = primeCache();
		const newer = makeVsix();
		const fetchMock = vi.fn(async (url: string) => {
			if (url === `${REGISTRY}/api/neophack/git-graph-rs`) {
				return registryEntry('1.1.0', `${REGISTRY}/file/git-graph-rs-1.1.0.vsix`);
			}
			return fileResponse(newer);
		});
		vi.stubGlobal('fetch', fetchMock);

		const result = await fetchMarketplacePackages({
			base: REGISTRY, cacheDir, targetPlatform: PLATFORM,
			ttlHours: 0, require: false, skip: false, select: selectGitGraph
		});

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(result['git-graph-rs']).toMatchObject({ selected: true, version: '1.1.0', fromCache: false });
		expect(existsSync(result['git-graph-rs']!.path!)).toBe(true);
		validatePackage(result['git-graph-rs']!.path!, gitGraphSpec);
		const meta = JSON.parse(readFileSync(join(cacheDir, 'git-graph-rs', 'meta.json'), 'utf8'));
		expect(meta.version).toBe('1.1.0');
	});

	it('a build pass that cannot reach the registry serves the stale cache, never silently', async () => {
		const cacheDir = primeCache();
		vi.stubGlobal('fetch', vi.fn(async () => {
			throw new Error('registry unreachable');
		}));
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

		const result = await fetchMarketplacePackages({
			base: REGISTRY, cacheDir, targetPlatform: PLATFORM,
			ttlHours: 0, require: false, skip: false, select: selectGitGraph
		});

		expect(result['git-graph-rs']).toMatchObject({ selected: true, version: '1.0.0', fromCache: true, stale: true });
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('stale cache'));
	});
});

describe('the build wiring (module 15)', () => {
	it('tauri’s beforeBuildCommand runs the build pass; the dev command keeps the cache TTL', () => {
		const conf = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src-tauri', 'tauri.conf.json'), 'utf8'));
		expect(conf.build.beforeBuildCommand).toContain('prepare.mjs --build');
		expect(conf.build.beforeDevCommand).not.toContain('--build');
	});
});

// The Windows uninstaller's cleanup outside the install directory (src-tauri/nsis-hooks.nsh,
// 2026-10-12): the rules that make it safe are pinned here, since the NSIS itself only
// runs on a real uninstall.
describe('the uninstaller cleanup (module 15)', () => {
	const hooks = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src-tauri', 'nsis-hooks.nsh'), 'utf8');
	const post = hooks.slice(hooks.indexOf('!macro NSIS_HOOK_POSTUNINSTALL'));
	const body = post.slice(0, post.indexOf('!macroend'));

	it('is wired as the post-uninstall hook and skips updates', () => {
		const conf = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src-tauri', 'tauri.conf.json'), 'utf8'));
		expect(conf.bundle.windows.nsis.installerHooks).toBe('nsis-hooks.nsh');
		expect(body).toMatch(/^\s*\$\{If\} \$UpdateMode <> 1/m);
	});

	it('ends the remote daemon — its logon task before the process — and removes its program and cache', () => {
		const task = body.indexOf('schtasks /Delete /TN "GGS Remote"');
		const kill = body.indexOf('taskkill /F /T /FI "IMAGENAME eq ggs-remote.exe"');
		expect(task).toBeGreaterThan(-1);
		expect(kill).toBeGreaterThan(task);
		expect(body).toContain('/FI "USERNAME eq $R7"');
		for (const dir of ['remote\\bin', 'remote\\cache', 'cache', 'index']) expect(body).toContain(`RMDir /r "$R5\\${dir}"`);
	});

	it('deletes the user data only with the uninstaller\'s own checkbox, and only the profile\'s ~/.ggs', () => {
		expect(body).toContain('StrCpy $R5 "$PROFILE\\.ggs"');
		// No path an environment variable chose is ever deleted (comments may name one).
		expect(body.replace(/;.*$/gm, '')).not.toMatch(/ReadEnvStr \$R5|GGS_HOME/);
		const whole = body.indexOf('RMDir /r "$R5"');
		const box = body.indexOf('${If} $DeleteAppDataCheckboxState = 1');
		expect(box).toBeGreaterThan(-1);
		expect(whole).toBeGreaterThan(box);
		expect(body.indexOf('RMDir /r "$R5"', whole + 1)).toBe(-1);
	});
});
