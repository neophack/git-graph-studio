// Packs the Claude Remote extension into a store-format VSIX:
//   node build.mjs [--out <file>]
// Output (default): target/studio/claude-remote-<version>.vsix (a zip with extension/… and the
// [Content_Types].xml vsce writes — installable by VS Code and by Git Graph Studio).
// prepare.mjs packs the product build with --out straight into the installer's bundled
// extensions directory (claude-remote.vsix rides in every build; scripts/prepare.mjs step 4).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The store's own package gate (module 15's marketplace validator) — the same
// central-directory check every downloaded VSIX passes before it is packed into an
// installer, pure Node so the packer runs on every build host.
import { validatePackage } from '../../scripts/fetch-marketplace-extensions.mjs';

// fileURLToPath, never URL.pathname: on Windows the pathname keeps its leading /C:/,
// which resolve() widens into C:\C:\… — the packer must run on the Windows build host.
const here = fileURLToPath(new URL('.', import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(here, 'package.json'), 'utf8'));
const appDir = resolve(here, '..', '..');
const outFlag = process.argv.indexOf('--out');
const out = outFlag >= 0
	? resolve(process.cwd(), process.argv[outFlag + 1])
	: resolve(appDir, 'target/studio', `claude-remote-${pkg.version}.vsix`);
mkdirSync(dirname(out), { recursive: true });

// [Content_Types].xml — the fixed vsce default.
const contentTypes = `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
	<Default Extension=".json" ContentType="application/json"/>
	<Default Extension=".js" ContentType="application/javascript"/>
	<Default Extension=".md" ContentType="text/markdown"/>
	<Default Extension=".html" ContentType="text/html"/>
	<Default Extension=".css" ContentType="text/css"/>
	<Default Extension=".svg" ContentType="image/svg+xml"/>
	<Default Extension=".webmanifest" ContentType="application/manifest+json"/>
	<Default Extension=".vsixmanifest" ContentType="text/xml"/>
</Types>`;
const vsixManifest = `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
	<Metadata>
		<Identity Language="en-US" Id="${pkg.name}" Version="${pkg.version}" Publisher="${pkg.publisher}"/>
		<DisplayName>${pkg.displayName}</DisplayName>
		<Description xml:space="preserve">${pkg.description}</Description>
		<Categories>Other</Categories>
	</Metadata>
	<Installation>
		<InstallationTarget Id="Microsoft.VisualStudio.Code"/>
	</Installation>
	<Dependencies/>
</PackageManifest>`;

const files = [
	['[Content_Types].xml', contentTypes],
	['extension.vsixmanifest', vsixManifest],
	['extension/package.json', readFileSync(resolve(here, 'package.json'))],
	...[
		'extension.js', 'sessions.js', 'runner.js', 'server.js', 'panel.js', 'desktop.js', 'qrcode.js', 'sjcl.js', 'README.md',
		'web/index.html', 'web/app.js', 'web/app.css', 'web/icon.svg', 'web/manifest.webmanifest'
	].map((file) => [`extension/${file}`, readFileSync(resolve(here, file))])
];

// CRC32 (zip store, no deps).
const table = (() => {
	const t = new Int32Array(256);
	for (let i = 0; i < 256; i++) {
		let c = i;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[i] = c;
	}
	return t;
})();
const crc32 = (buf) => {
	let c = 0xffffffff;
	for (const byte of buf) c = table[(c ^ byte) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
};

const chunks = [];
const central = [];
let offset = 0;
for (const [name, contents] of files) {
	const data = Buffer.isBuffer(contents) ? contents : Buffer.from(contents, 'utf8');
	const nameBuf = Buffer.from(name, 'utf8');
	const crc = crc32(data);
	const local = Buffer.alloc(30);
	local.writeUInt32LE(0x04034b50, 0);
	local.writeUInt16LE(20, 4); // version needed
	local.writeUInt16LE(0x0800, 6); // UTF-8 names
	local.writeUInt16LE(0, 8); // store
	local.writeUInt16LE(0, 10); // time
	local.writeUInt16LE(0x21, 12); // date (1996-01-01, fixed)
	local.writeUInt32LE(crc, 14);
	local.writeUInt32LE(data.length, 18);
	local.writeUInt32LE(data.length, 22);
	local.writeUInt16LE(nameBuf.length, 26);
	chunks.push(local, nameBuf, data);
	const centralEntry = Buffer.alloc(46);
	centralEntry.writeUInt32LE(0x02014b50, 0);
	centralEntry.writeUInt16LE(20, 4);
	centralEntry.writeUInt16LE(20, 6);
	centralEntry.writeUInt16LE(0x0800, 8);
	centralEntry.writeUInt16LE(0, 10);
	centralEntry.writeUInt16LE(0, 12);
	centralEntry.writeUInt16LE(0x21, 14);
	centralEntry.writeUInt32LE(crc, 16);
	centralEntry.writeUInt32LE(data.length, 20);
	centralEntry.writeUInt32LE(data.length, 24);
	centralEntry.writeUInt16LE(nameBuf.length, 28);
	centralEntry.writeUInt32LE(offset, 42);
	central.push(Buffer.concat([centralEntry, nameBuf]));
	offset += local.length + nameBuf.length + data.length;
}
const centralBuf = Buffer.concat(central);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(centralBuf.length, 12);
end.writeUInt32LE(offset, 16);
writeFileSync(out, Buffer.concat([...chunks, centralBuf, end]));
console.log(`packed ${out} (${files.length} files)`);

// Sanity: the store's package validator must accept it (the central-directory shape
// every marketplace VSIX is gated on before it is bundled into an installer).
try {
	validatePackage(out, { slug: 'claude-remote', engineRequired: false });
} catch (reason) {
	console.error(`zip self-check failed: ${reason instanceof Error ? reason.message : reason}`);
	process.exit(1);
}
console.log('zip self-check OK: the central directory reads and extension/package.json is there');
