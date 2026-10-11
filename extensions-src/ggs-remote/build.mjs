// Packs GGS Remote into a platform VSIX (docs/ggs-remote-plan.md §15.1–§15.2):
//   node build.mjs [--target <vsix-platform>] [--out <file|dir>] [--debug] [--skip-cargo]
// Builds the daemon (cargo, release profile; target dir target/studio/ggs-remote), stages
// it as bin/<platform>/ggs-remote(.exe) beside the extension's JS and page, and writes
// ggs-remote-<platform>-<version>.vsix — a store-format package (extension/…, the
// [Content_Types].xml and extension.vsixmanifest vsce writes, with TargetPlatform set).
// Default target: this machine's platform. The icon is drawn here, so no binary sits in
// the source tree.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { deflateRawSync } from 'node:zlib';
import { validatePackage } from '../../scripts/fetch-marketplace-extensions.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const appDir = resolve(here, '..', '..');
const pkg = JSON.parse(readFileSync(resolve(here, 'package.json'), 'utf8'));
const daemonToml = readFileSync(resolve(here, 'daemon', 'Cargo.toml'), 'utf8');
const daemonVersion = /^version\s*=\s*"([^"]+)"/m.exec(daemonToml)?.[1] ?? pkg.version;

const arg = (name) => {
	const at = process.argv.indexOf(name);
	return at >= 0 ? process.argv[at + 1] : undefined;
};

/** VSIX platform → Rust target triple (§15.1). */
export const TARGETS = {
	'win32-x64': 'x86_64-pc-windows-msvc',
	'win32-arm64': 'aarch64-pc-windows-msvc',
	'darwin-arm64': 'aarch64-apple-darwin',
	'darwin-x64': 'x86_64-apple-darwin',
	'linux-x64': 'x86_64-unknown-linux-gnu',
	'linux-arm64': 'aarch64-unknown-linux-gnu'
};

export function hostPlatform() {
	const os = process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux';
	return `${os}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`;
}

const platform = arg('--target') ?? hostPlatform();
if (!TARGETS[platform]) {
	console.error(`unknown target ${platform}; one of ${Object.keys(TARGETS).join(', ')}`);
	process.exit(2);
}
const triple = TARGETS[platform];
const debug = process.argv.includes('--debug');
const exeName = platform.startsWith('win32') ? 'ggs-remote.exe' : 'ggs-remote';
const targetDir = resolve(appDir, 'target', 'studio', 'ggs-remote');

// 1. The daemon.
const crossBuild = platform !== hostPlatform();
const binary = resolve(targetDir, ...(crossBuild ? [triple] : []), debug ? 'debug' : 'release', exeName);
if (!process.argv.includes('--skip-cargo')) {
	const args = ['build', '--manifest-path', resolve(here, 'daemon', 'Cargo.toml'), '--target-dir', targetDir];
	if (!debug) args.push('--release');
	if (crossBuild) args.push('--target', triple);
	console.log(`cargo ${args.join(' ')}`);
	execFileSync('cargo', args, { stdio: 'inherit' });
}
if (!existsSync(binary)) {
	console.error(`the daemon binary is missing: ${binary}`);
	process.exit(1);
}

// 2. The icon: a 128 px rounded square in the accent colour with the commit-graph mark,
// encoded as an RGBA PNG by hand (zlib from Node, the CRC below).
function crc32(buf) {
	let c = 0xffffffff;
	for (const byte of buf) {
		c ^= byte;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	}
	return (c ^ 0xffffffff) >>> 0;
}

function png(size, pixel) {
	const raw = Buffer.alloc(size * (size * 4 + 1));
	for (let y = 0; y < size; y++) {
		raw[y * (size * 4 + 1)] = 0;
		for (let x = 0; x < size; x++) raw.set(pixel(x + 0.5, y + 0.5, size), y * (size * 4 + 1) + 1 + x * 4);
	}
	const chunk = (type, data) => {
		const len = Buffer.alloc(4);
		len.writeUInt32BE(data.length);
		const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
		const crc = Buffer.alloc(4);
		crc.writeUInt32BE(crc32(body));
		return Buffer.concat([len, body, crc]);
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(size, 0);
	ihdr.writeUInt32BE(size, 4);
	ihdr.set([8, 6, 0, 0, 0], 8);
	return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlibWrap(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function zlibWrap(raw) {
	// PNG wants a zlib stream: header, deflate data, Adler-32.
	let a = 1;
	let b = 0;
	for (const byte of raw) {
		a = (a + byte) % 65521;
		b = (b + a) % 65521;
	}
	const adler = Buffer.alloc(4);
	adler.writeUInt32BE(((b << 16) | a) >>> 0);
	return Buffer.concat([Buffer.from([0x78, 0x9c]), deflateRawSync(raw), adler]);
}

function iconPixel(x, y, s) {
	const corner = s * 0.22;
	const dx = Math.abs(x - s / 2) - (s / 2 - corner);
	const dy = Math.abs(y - s / 2) - (s / 2 - corner);
	const inside = dx <= 0 || dy <= 0 || Math.hypot(dx, dy) <= corner;
	if (!inside) return [0, 0, 0, 0];
	const dot = (cx, cy) => Math.hypot(x - cx * s, y - cy * s) <= s * 0.1;
	const mark =
		dot(0.32, 0.28) ||
		dot(0.32, 0.72) ||
		dot(0.68, 0.46) ||
		(Math.abs(x - s * 0.32) <= s * 0.045 && y >= s * 0.28 && y <= s * 0.72) ||
		(Math.abs(y - (s * 0.6 - (x - s * 0.32) * 0.4)) <= s * 0.045 && x >= s * 0.32 && x <= s * 0.68);
	return mark ? [255, 255, 255, 255] : [10, 102, 216, 255];
}

// 3. The package.
const contentTypes = `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
	<Default Extension=".json" ContentType="application/json"/>
	<Default Extension=".js" ContentType="application/javascript"/>
	<Default Extension=".md" ContentType="text/markdown"/>
	<Default Extension=".html" ContentType="text/html"/>
	<Default Extension=".css" ContentType="text/css"/>
	<Default Extension=".png" ContentType="image/png"/>
	<Default Extension=".exe" ContentType="application/octet-stream"/>
	<Default Extension=".vsixmanifest" ContentType="text/xml"/>
	__OVERRIDES__
</Types>`;
const escapeXml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const vsixManifest = `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
	<Metadata>
		<Identity Language="en-US" Id="${pkg.name}" Version="${pkg.version}" Publisher="${pkg.publisher}" TargetPlatform="${platform}"/>
		<DisplayName>${escapeXml(pkg.displayName)}</DisplayName>
		<Description xml:space="preserve">${escapeXml(pkg.description)}</Description>
		<Categories>Other</Categories>
	</Metadata>
	<Installation>
		<InstallationTarget Id="Microsoft.VisualStudio.Code"/>
	</Installation>
	<Dependencies/>
	<Assets>
		<Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/>
	</Assets>
</PackageManifest>`;

const source = (rel) => readFileSync(resolve(here, rel));
const files = [
	['[Content_Types].xml', Buffer.from(contentTypes)],
	['extension.vsixmanifest', Buffer.from(vsixManifest)],
	['extension/package.json', source('package.json')],
	['extension/extension.js', source('extension.js')],
	['extension/lib/daemon.js', source('lib/daemon.js')],
	['extension/lib/admin.js', source('lib/admin.js')],
	['extension/media/page/page.js', source('media/page/page.js')],
	['extension/media/page/page.css', source('media/page/page.css')],
	['extension/media/icon.png', png(128, iconPixel)],
	['extension/README.md', source('README.md')],
	[`extension/bin/${platform}/${exeName}`, readFileSync(binary), 0o755]
];
// OPC has no default for extensionless parts (the Unix daemon binary): one override each.
const overrides = files
	.map(([name]) => name)
	.filter((name) => !/\.[^/]+$/.test(name))
	.map((name) => `<Override PartName="/${name}" ContentType="application/octet-stream"/>`)
	.join('');
files[0][1] = Buffer.from(contentTypes.replace('__OVERRIDES__', overrides));

function zip(entries) {
	const chunks = [];
	const central = [];
	let offset = 0;
	for (const [name, data, mode] of entries) {
		const nameBuf = Buffer.from(name, 'utf8');
		const packed = deflateRawSync(data, { level: 9 });
		const store = packed.length >= data.length;
		const body = store ? data : packed;
		const crc = crc32(data);
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(0x0800, 6);
		local.writeUInt16LE(store ? 0 : 8, 8);
		local.writeUInt16LE(0, 10);
		local.writeUInt16LE(0x21, 12);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(body.length, 18);
		local.writeUInt32LE(data.length, 22);
		local.writeUInt16LE(nameBuf.length, 26);
		chunks.push(local, nameBuf, body);
		const entry = Buffer.alloc(46);
		entry.writeUInt32LE(0x02014b50, 0);
		entry.writeUInt16LE(mode ? 0x0314 : 20, 4); // made by: Unix (3) when a mode rides along
		entry.writeUInt16LE(20, 6);
		entry.writeUInt16LE(0x0800, 8);
		entry.writeUInt16LE(store ? 0 : 8, 10);
		entry.writeUInt16LE(0, 12);
		entry.writeUInt16LE(0x21, 14);
		entry.writeUInt32LE(crc, 16);
		entry.writeUInt32LE(body.length, 20);
		entry.writeUInt32LE(data.length, 24);
		entry.writeUInt16LE(nameBuf.length, 28);
		entry.writeUInt32LE(mode ? ((0o100000 | mode) << 16) >>> 0 : 0, 38);
		entry.writeUInt32LE(offset, 42);
		central.push(Buffer.concat([entry, nameBuf]));
		offset += local.length + nameBuf.length + body.length;
	}
	const centralBuf = Buffer.concat(central);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(centralBuf.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...chunks, centralBuf, end]);
}

const outArg = arg('--out');
const fileName = `${pkg.name}-${platform}-${pkg.version}.vsix`;
let out = outArg ? resolve(process.cwd(), outArg) : resolve(appDir, 'target', 'studio', fileName);
if (outArg && existsSync(out) && statSync(out).isDirectory()) out = resolve(out, fileName);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, zip(files));
validatePackage(out, { slug: pkg.name, engineRequired: false });
console.log(`packed ${out} (${files.length} files, daemon ${daemonVersion}, ${platform})`);
