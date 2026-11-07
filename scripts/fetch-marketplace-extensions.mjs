// Module 15 — Build & Release Pipeline.
//
// Downloads the marketplace builds of the extension packages the installer
// carries (Open VSX — the same registry the in-app marketplace reads), picked
// per architecture exactly as the app's own gallery lookup does
// (src-tauri/src/ext_gallery.rs): the registry's `downloads` map names one
// platform-specific `.vsix` per target, so a Windows build packs the win32-x64
// packages and a Linux build the linux-x64 ones. prepare.mjs drops whatever is
// selected into extensions/ beside the app; the first-launch pass installs
// exactly the packages that sit there (cmd_ext::install_missing_bundled).
//
// WHICH packages are packed is a build-time choice — the release form's
// checkboxes (release.yml / studio.yml forward them as env):
//
//   GGS_BUNDLE_GIT_GRAPH      default 1 — pack git-graph-rs
//   GGS_BUNDLE_CLAUDE_CODE    default 1 — claude-code rides in every installer
//                             (2026-11-07, the owner's direction; it was out
//                             by default from 2026-09-28, the Extensions view's
//                             marketplace row then serving the 100+ MB package
//                             on demand); GGS_BUNDLE_CLAUDE_CODE=0 — or CI's
//                             release form unchecking its box — leaves it out
//   ... =1/true to pack, =0/false to leave the package out of the installer
//
// Caching: downloads land under <target>/studio/marketplace-cache/ keyed by
// version + target platform, and a cache younger than the TTL serves without
// any network round trip (a `tauri dev` iteration must not phone home; the
// lookup alone would). A BUILD pass re-checks the registry regardless of the
// cache's age (2026-09-30, the owner's direction: an installer must carry
// open-vsx.org's latest extension builds) — prepare.mjs --build, which
// tauri.conf.json's beforeBuildCommand passes, sets ttlHours 0; the re-check
// is a lookup, and a same-version answer reuses the cached file without
// paying for the download twice. A stale cache is a fallback of last resort
// when the registry is unreachable. Other environment:
//
//   GGS_MARKETPLACE_URL        override the registry origin (tests, mirrors)
//   GGS_MARKETPLACE_CACHE_HOURS  TTL of the cache in hours (default 12; 0 = always re-check)
//   GGS_MARKETPLACE_DOWNLOAD_STALL_MS  abort a download that receives no bytes
//                              for this long (default 120000 = 2 min) — the
//                              only download deadline that matters; a slow
//                              but flowing download runs to completion
//   GGS_REQUIRE_MARKETPLACE=1  a SELECTED package that cannot be fetched fails
//                              the build (CI sets this implicitly through CI=true)
//   GGS_SKIP_MARKETPLACE_FETCH=1  no network at all: only fresh cache is used
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_GALLERY = process.env.GGS_MARKETPLACE_URL || 'https://open-vsx.org';

// The packages the installer can carry, by slug (the stable file name prepare
// gives the packed copy). `engineRequired` gates the package on the native
// binary a complete package carries — an engine-less git-graph-rs VSIX would
// ship a flagship view that cannot run. No package has a local source (each
// lives in its own repository, outside this tree), so in require mode a failed
// fetch of a SELECTED package IS a failed build; without require it is a warn
// and the package rides out of the installer (the Extensions view's marketplace
// row installs it on demand).
export const MARKETPLACE_PACKAGES = [
	{ slug: 'git-graph-rs', env: 'GGS_BUNDLE_GIT_GRAPH', namespace: 'neophack', name: 'git-graph-rs', engineRequired: true, defaultSelected: true },
	{ slug: 'claude-code', env: 'GGS_BUNDLE_CLAUDE_CODE', namespace: 'Anthropic', name: 'claude-code', engineRequired: false, defaultSelected: true }
];

/// The package's `env` switch as a boolean, on its spec's default. Both packages
/// ride in every installer unless a build tells them not to (a `=0` env, or CI's
/// release form unchecking the box); the Extensions view's marketplace row still
/// installs a left-out package on demand.
export function bundleSelected(spec, env = process.env) {
	const value = env[spec.env];
	if (value === undefined || value === '') return spec.defaultSelected ?? true;
	return value !== '0' && value !== 'false' && value !== 'no';
}

// The registry's target-platform names for a build machine, mirroring
// ext_gallery.rs (a musl build host is not one the installer ever ships from).
export function targetPlatformOf(platform = process.platform, arch = process.arch) {
	const map = {
		'win32-x64': 'win32-x64',
		'win32-arm64': 'win32-arm64',
		'linux-x64': 'linux-x64',
		'linux-arm64': 'linux-arm64',
		'darwin-x64': 'darwin-x64',
		'darwin-arm64': 'darwin-arm64'
	};
	return map[`${platform}-${arch}`] ?? null;
}

/// One slot of the answer per slug:
///   { selected: false }                     not packed this build (no fetch)
///   { selected: true, ...meta, path }       fetched (or served from cache)
///   null                                    selected but unavailable — a warn,
///                                           or a thrown error in require mode
export async function fetchMarketplacePackages({
	base = DEFAULT_GALLERY,
	cacheDir,
	targetPlatform = targetPlatformOf(),
	ttlHours = Number(process.env.GGS_MARKETPLACE_CACHE_HOURS ?? 12),
	require = process.env.CI === 'true' || process.env.GGS_REQUIRE_MARKETPLACE === '1',
	skip = process.env.GGS_SKIP_MARKETPLACE_FETCH === '1',
	select
} = {}) {
	const chosen = select ?? Object.fromEntries(MARKETPLACE_PACKAGES.map((spec) => [spec.slug, bundleSelected(spec)]));
	const results = {};
	for (const spec of MARKETPLACE_PACKAGES) {
		if (chosen[spec.slug] === false) {
			results[spec.slug] = { selected: false };
			continue;
		}
		results[spec.slug] = await fetchOne(spec, { base, cacheDir, targetPlatform, ttlHours, require, skip });
	}
	return results;
}

async function fetchOne(spec, { base, cacheDir, targetPlatform, ttlHours, require, skip }) {
	if (!targetPlatform) {
		return outcome(`unknown target platform for ${spec.slug} on this build host`, { require, slug: spec.slug });
	}
	const dir = join(cacheDir, spec.slug);
	mkdirSync(dir, { recursive: true });
	const metaPath = join(dir, 'meta.json');
	const cached = readMeta(metaPath);

	// A fresh cache serves as-is — no network on the dev-iteration path.
	if (cached && cached.targetPlatform === targetPlatform && cacheIsFresh(cached, ttlHours)) {
		const file = join(dir, cached.file);
		if (existsSync(file)) {
			return { selected: true, ...cached, path: file, fromCache: true };
		}
	}

	if (skip) {
		// The explicit opt-out still prefers whatever cache exists, and outranks
		// require — a deliberate offline build is never a failed one.
		if (cached && existsSync(join(dir, cached.file))) {
			return { selected: true, ...cached, path: join(dir, cached.file), fromCache: true };
		}
		return outcome(`marketplace fetch skipped for ${spec.slug} (GGS_SKIP_MARKETPLACE_FETCH)`, { require: false, slug: spec.slug });
	}

	let latest;
	try {
		latest = await lookup(base, spec, targetPlatform);
	} catch (reason) {
		return staleOrFailure(cached, dir, spec, String(reason), { require });
	}

	// Same version + platform already on disk: refresh the timestamp and serve.
	if (cached && cached.version === latest.version && cached.targetPlatform === targetPlatform) {
		const file = join(dir, cached.file);
		if (existsSync(file)) {
			const refreshed = { ...cached, fetchedAt: Date.now() };
			writeMeta(metaPath, refreshed);
			return { selected: true, ...refreshed, path: file, fromCache: true };
		}
	}

	try {
		const file = await download(latest.url, join(dir, `download-${spec.slug}.tmp`));
		validatePackage(file, spec);
		const final = join(dir, `${spec.slug}-${latest.version}@${targetPlatform}.vsix`);
		renameSync(file, final);
		const meta = {
			id: latest.id,
			version: latest.version,
			targetPlatform,
			url: latest.url,
			file: final.split(/[\\/]/).pop(),
			bytes: statSync(final).size,
			sha256: sha256Of(final),
			fetchedAt: Date.now()
		};
		writeMeta(metaPath, meta);
		return { selected: true, ...meta, path: final, fromCache: false };
	} catch (reason) {
		return staleOrFailure(cached, dir, spec, String(reason), { require });
	}
}

async function lookup(base, spec, targetPlatform) {
	const response = await fetch(`${base}/api/${spec.namespace}/${spec.name}`, {
		signal: AbortSignal.timeout(30_000)
	});
	if (!response.ok) throw new Error(`registry answered ${response.status}`);
	const entry = await response.json();
	if (entry.downloadable === false) throw new Error('the registry entry is not downloadable');
	const downloads = entry.downloads ?? {};
	const url = downloads[targetPlatform] ?? downloads.universal;
	if (!url) {
		throw new Error(
			`no ${targetPlatform}${downloads.universal ? '' : ' or universal'} build of ${spec.namespace}.${spec.name}`
		);
	}
	return { id: `${spec.namespace}.${spec.name}`, version: entry.version, url };
}

/* The download's budget is the connection's liveliness, not a total wall clock:
 * claude-code's 165 MB on a slow link needs whatever time it needs as long as
 * bytes keep arriving (the first version's flat 10-minute cap aborted exactly
 * such a download and failed the build), while a dead connection must fail —
 * two minutes of silence does it (GGS_MARKETPLACE_DOWNLOAD_STALL_MS). The
 * ceiling behind the stall guard is the drip-feed backstop: a server sending
 * one byte a minute would otherwise hold the build forever. */
const STALLED = Symbol('stalled');
const DOWNLOAD_STALL_MS = 120_000;

async function download(url, tmpPath) {
	const response = await fetch(url, { signal: AbortSignal.timeout(30 * 60_000) });
	if (!response.ok) throw new Error(`download answered ${response.status}`);
	const stallMs = Number(process.env.GGS_MARKETPLACE_DOWNLOAD_STALL_MS ?? DOWNLOAD_STALL_MS);
	const reader = response.body.getReader();
	const chunks = [];
	let bytes = 0;
	try {
		for (;;) {
			let timer;
			const step = await Promise.race([
				reader.read(),
				new Promise((resolve) => {
					timer = setTimeout(() => resolve(STALLED), stallMs);
				})
			]);
			clearTimeout(timer);
			if (step === STALLED) {
				throw new Error(`download stalled — no bytes for ${stallMs / 1000}s after ${bytes} bytes`);
			}
			if (step.done) break;
			chunks.push(step.value);
			bytes += step.value.length;
		}
	} catch (reason) {
		await reader.cancel().catch(() => {});
		throw reason;
	}
	if (bytes < 100 * 1024) {
		throw new Error(`download is only ${bytes} bytes — not a package`);
	}
	rmSync(tmpPath, { force: true });
	writeFileSync(tmpPath, Buffer.concat(chunks));
	return tmpPath;
}

function staleOrFailure(cached, dir, spec, reason, { require }) {
	if (cached && existsSync(join(dir, cached.file))) {
		// The registry is unreachable but yesterday's download is still a
		// complete, validated package — better than nothing, and never a
		// silent one: the downgrade says so.
		console.warn(`[marketplace] ${spec.slug}: fetch failed (${reason}); serving the stale cache`);
		return { selected: true, ...cached, path: join(dir, cached.file), fromCache: true, stale: true };
	}
	return outcome(reason, { require, slug: spec.slug });
}

function outcome(reason, { require, slug = 'the package' }) {
	if (require) {
		throw new Error(`[marketplace] ${reason} — refusing to build an installer without ${slug}`);
	}
	console.warn(`[marketplace] ${reason}`);
	return null;
}

/* The VSIX is an OPC zip; the central directory alone (no extraction, no
 * dependencies) is enough to assert the package's shape: an extension manifest
 * under extension/, and — when the spec requires an engine — at least one
 * native `.node` binary for the graph view to run on. */
export function validatePackage(file, spec) {
	const bytes = readFileSync(file);
	const eocd = findEocd(bytes);
	if (eocd < 0) throw new Error('the downloaded package is not a zip (no end-of-central-directory)');
	const count = bytes.readUInt16LE(eocd + 10);
	const cdSize = bytes.readUInt32LE(eocd + 12);
	const cdOffset = bytes.readUInt32LE(eocd + 16);
	if (cdOffset + cdSize > bytes.length) throw new Error('the zip central directory is truncated');
	const names = [];
	let at = cdOffset;
	for (let i = 0; i < count; i++) {
		if (bytes.readUInt32LE(at) !== 0x02014b50) throw new Error('the zip central directory is corrupt');
		const nameLen = bytes.readUInt16LE(at + 28);
		names.push(bytes.subarray(at + 46, at + 46 + nameLen).toString('utf8'));
		at += 46 + nameLen + bytes.readUInt16LE(at + 30) + bytes.readUInt16LE(at + 32);
	}
	if (!names.some((n) => n === 'extension/package.json')) {
		throw new Error('the package carries no extension/package.json');
	}
	if (spec.engineRequired && !names.some((n) => n.endsWith('.node'))) {
		throw new Error('the package carries no engine .node — refusing to bundle a view that cannot run');
	}
}

function findEocd(bytes) {
	// The EOCD is at the tail; the comment that may follow it is at most 64 KiB.
	const from = Math.max(0, bytes.length - 66_000 - 22);
	for (let at = bytes.length - 22; at >= from; at--) {
		if (bytes.readUInt32LE(at) === 0x06054b50) return at;
	}
	return -1;
}

function readMeta(metaPath) {
	if (!existsSync(metaPath)) return null;
	try {
		return JSON.parse(readFileSync(metaPath, 'utf8'));
	} catch {
		return null;
	}
}

function writeMeta(metaPath, meta) {
	mkdirSync(metaPath.split(/[\\/]/).slice(0, -1).join('/'), { recursive: true });
	writeFileSync(metaPath, JSON.stringify(meta, null, '\t') + '\n');
}

function cacheIsFresh(meta, ttlHours) {
	return ttlHours > 0 && Date.now() - meta.fetchedAt < ttlHours * 3600_000;
}

function sha256Of(file) {
	return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/* CLI: fetch into a directory and print what landed, for probing and manual
 * seeding of the cache.   node scripts/fetch-marketplace-extensions.mjs [--out <dir>] [--only slug[,slug]] */
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('scripts/fetch-marketplace-extensions.mjs')) {
	const flag = process.argv.indexOf('--out');
	const outDir = flag >= 0 ? process.argv[flag + 1] : join('target', 'studio', 'marketplace-cache');
	mkdirSync(outDir, { recursive: true });
	const only = process.argv.indexOf('--only');
	const select = only >= 0
		? Object.fromEntries(MARKETPLACE_PACKAGES.map((spec) => [spec.slug, process.argv[only + 1].split(',').includes(spec.slug)]))
		: undefined;
	const results = await fetchMarketplacePackages({ cacheDir: outDir, select });
	for (const [slug, result] of Object.entries(results)) {
		console.log(result?.path
			? `${slug}: ${result.id} ${result.version} @${result.targetPlatform} -> ${result.path}`
			: `${slug}: ${result?.selected === false ? 'not selected' : 'unavailable'}`);
	}
}
