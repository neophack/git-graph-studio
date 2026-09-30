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
