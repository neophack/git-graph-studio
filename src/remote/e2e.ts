// End-to-end encryption's browser half (docs/ggs-remote-plan.md §20.11, M10): the twin of
// the tray service's e2e core, held to it byte-for-byte by the committed cross-implementation
// vectors (asserted through tests/remote.test.ts).
//
// tweetnacl supplies X25519 (`scalarMult`), SHA-512 (`hash`) and Ed25519 verification
// (`sign.detached.verify`); the AEAD is WebCrypto's AES-256-GCM — no WASM, no crypto
// dependency beyond the 10 KB tweetnacl.
import nacl from 'tweetnacl';

export const INFO = new TextEncoder().encode('ggs-remote-e2e/1');
/** The flag an encrypted frame's header carries (§6.1's flags byte has room). */
export const FLAG_ENCRYPTED = 0x40;
export const NONCE_LEN = 12;
export const KEY_LEN = 32;

const INFO_ID = new TextEncoder().encode('ggs-remote-uuid/1');

/** `uuid_for` (the tray service's identity module): UUIDv8 over
 *  SHA-256("ggs-remote-uuid/1" ‖ key)[..16]. SHA-256 rides WebCrypto (tweetnacl only has
 *  SHA-512, which the HKDF below uses); injectable for the jsdom tests. */
export async function uuidFor(publicKey: Uint8Array, subtle?: SubtleCrypto): Promise<string> {
	const digest = new Uint8Array(await sha256(new Uint8Array([...INFO_ID, ...publicKey]), subtle));
	digest[6] = (digest[6] & 0x0f) | 0x80;
	digest[8] = (digest[8] & 0x3f) | 0x80;
	const hex = Array.from(digest.subarray(0, 16), (b) => b.toString(16).padStart(2, '0')).join('');
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function sha256(message: Uint8Array, subtle: SubtleCrypto = globalThis.crypto?.subtle): Promise<ArrayBuffer> {
	if (!subtle) throw new Error('WebCrypto is unavailable');
	return subtle.digest('SHA-256', message as Bytes);
}

export function decodeBase64(text: string): Uint8Array {
	const raw = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
	return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

/** The tray service's token alphabet: URL-safe base64 without padding. */
export function encodeBase64(bytes: Uint8Array): string {
	let raw = '';
	for (const byte of bytes) raw += String.fromCharCode(byte);
	return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A browser's conversation keypair: a random X25519 seed (tests inject a fixed one). */
export function ephemeral(seed?: Uint8Array): { secret: Uint8Array; public: Uint8Array } {
	const secret = seed ?? nacl.randomBytes(32);
	return { secret, public: nacl.scalarMult.base(secret) };
}

/** RFC 5869 HKDF-SHA512 — the same sixteen lines the daemon's `e2e.rs` runs. */
export function hkdfSha512(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, out: number): Uint8Array {
	const block = 64;
	const hmac = (key: Uint8Array, message: Uint8Array): Uint8Array => {
		const ipad = new Uint8Array(block).fill(0x36);
		const opad = new Uint8Array(block).fill(0x5c);
		for (let at = 0; at < key.length && at < block; at++) {
			ipad[at] ^= key[at];
			opad[at] ^= key[at];
		}
		const inner = new Uint8Array(nacl.hash(new Uint8Array([...ipad, ...message])));
		return new Uint8Array(nacl.hash(new Uint8Array([...opad, ...inner])));
	};
	const prk = hmac(salt, ikm);
	const bytes: number[] = [];
	let previous: number[] = [];
	for (let counter = 1; bytes.length < out; counter++) {
		const blockBytes = Array.from(hmac(prk, new Uint8Array([...previous, ...info, counter])));
		const take = Math.min(blockBytes.length, out - bytes.length);
		bytes.push(...blockBytes.slice(0, take));
		previous = blockBytes;
	}
	return Uint8Array.from(bytes);
}

/** The conversation key: HKDF over the shared secret, salted by the dialogue so far. */
export function conversationKey(shared: Uint8Array, browserPub: Uint8Array, pcPub: Uint8Array): Uint8Array {
	return hkdfSha512(new Uint8Array([...browserPub, ...pcPub]), shared, INFO, KEY_LEN);
}

/** The shared secret of one conversation: the ephemeral secret meets the PC's static key. */
export function sharedWith(secret: Uint8Array, pcPub: Uint8Array): Uint8Array {
	return nacl.scalarMult(secret, pcPub);
}

/** Verify the PC's key-agreement parameters: the Ed25519 half must hash to the uuid the
 *  link spells (when there is one), and the signature must bind the X25519 half to it. */
export async function verifyParams(params: { edPub: string; xPub: string; sig: string }, expectedUuid?: string, subtle?: SubtleCrypto): Promise<Uint8Array | null> {
	const edPub = decodeBase64(params.edPub);
	const xPub = decodeBase64(params.xPub);
	const sig = decodeBase64(params.sig);
	if (edPub.length !== 32 || xPub.length !== KEY_LEN) return null;
	if (expectedUuid !== undefined && (await uuidFor(edPub, subtle)) !== expectedUuid) return null;
	if (!nacl.sign.detached.verify(new Uint8Array([...INFO, ...xPub]), sig, edPub)) return null;
	return xPub;
}

type Bytes = Uint8Array<ArrayBuffer>;
type Aes = { encrypt(plaintext: Bytes, iv: Bytes): Promise<Uint8Array>; decrypt(sealed: Bytes, iv: Bytes): Promise<Uint8Array> };

/** AES-256-GCM through WebCrypto (injectable for the jsdom tests). */
async function aes(key: Uint8Array, subtle: SubtleCrypto = globalThis.crypto?.subtle): Promise<Aes> {
	if (!subtle) throw new Error('WebCrypto is unavailable');
	const raw = new Uint8Array(key);
	const keyHandle = await subtle.importKey('raw', raw as Bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
	return {
		async encrypt(plaintext: Uint8Array, iv: Uint8Array): Promise<Uint8Array> {
			const buf = await subtle.encrypt({ name: 'AES-GCM', iv: iv as Bytes }, keyHandle, plaintext as Bytes);
			return new Uint8Array(buf);
		},
		async decrypt(sealed: Uint8Array, iv: Uint8Array): Promise<Uint8Array> {
			const buf = await subtle.decrypt({ name: 'AES-GCM', iv: iv as Bytes }, keyHandle, sealed as Bytes);
			return new Uint8Array(buf);
		}
	};
}

/** A copy over a plain ArrayBuffer — the shape WebCrypto's BufferSource wants. */
function toBytes(view: Uint8Array): Bytes {
	return new Uint8Array(view);
}

/** `ciphertext‖tag` — the exact bytes the tray service's core seals and opens. */
export async function seal(key: Uint8Array, plaintext: Uint8Array, nonce: Uint8Array, subtle?: SubtleCrypto): Promise<Uint8Array> {
	const box = await aes(key, subtle);
	return box.encrypt(toBytes(plaintext), toBytes(nonce));
}

export async function open(key: Uint8Array, sealed: Uint8Array, nonce: Uint8Array, subtle?: SubtleCrypto): Promise<Uint8Array | null> {
	if (sealed.length < 16) return null;
	const box = await aes(key, subtle);
	try {
		return await box.decrypt(toBytes(sealed), toBytes(nonce));
	} catch {
		return null;
	}
}

/** Wrap one frame for the wire: the outer header (with `FLAG_ENCRYPTED`) around the nonce
 *  and the box of the whole original frame. */
export async function wrapFrame(frame: Uint8Array, key: Uint8Array, nonce: Uint8Array, subtle?: SubtleCrypto): Promise<Uint8Array> {
	const sealed = await aes(key, subtle).then((box) => box.encrypt(toBytes(frame), toBytes(nonce)));
	const out = new Uint8Array(20 + NONCE_LEN + sealed.length);
	out.set(frame.subarray(0, 20), 0);
	out[1] |= FLAG_ENCRYPTED;
	new DataView(out.buffer).setUint32(16, NONCE_LEN + sealed.length, true);
	out.set(nonce, 20);
	out.set(sealed, 20 + NONCE_LEN);
	return out;
}

/** Unwrap one (its header carried `FLAG_ENCRYPTED`); answers the original frame. */
export async function unwrapFrame(envelope: Uint8Array, key: Uint8Array, subtle?: SubtleCrypto): Promise<Uint8Array | null> {
	if (envelope.length < 20 + NONCE_LEN + 16) return null;
	return open(key, envelope.subarray(20 + NONCE_LEN), envelope.subarray(20, 20 + NONCE_LEN), subtle);
}
