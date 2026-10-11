// Regenerates tests/vectors/hub-identity.json — device seed → link UUID (docs/ggs-remote-plan.md
// §20.1) — with Node's own Ed25519 and SHA-256, independent of the Rust crates both the daemon
// and the Hub are tested against. Run from daemon/: node tests/vectors/generate-identity.mjs
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import { writeFileSync } from 'node:fs';

// PKCS#8 DER prefix of an Ed25519 private key: the 32-byte seed follows.
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function publicKeyOf(seed) {
	const key = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' });
	const spki = createPublicKey(key).export({ format: 'der', type: 'spki' });
	return spki.subarray(spki.length - 32);
}

function uuidFor(publicKey) {
	const digest = createHash('sha256').update('ggs-remote-uuid/1').update(publicKey).digest().subarray(0, 16);
	const b = Buffer.from(digest);
	b[6] = (b[6] & 0x0f) | 0x80; // version 8
	b[8] = (b[8] & 0x3f) | 0x80; // RFC 9562 variant
	const hex = b.toString('hex');
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const vectors = [0x00, 0x07, 0x42, 0xff].map((fill, i) => {
	const seed = Buffer.alloc(32, fill);
	seed[0] = i;
	const publicKey = publicKeyOf(seed);
	return { seed: seed.toString('hex'), publicKey: publicKey.toString('hex'), uuid: uuidFor(publicKey) };
});
writeFileSync(new URL('./hub-identity.json', import.meta.url), JSON.stringify(vectors, null, '\t') + '\n');
console.log(vectors.map((v) => v.uuid).join('\n'));
