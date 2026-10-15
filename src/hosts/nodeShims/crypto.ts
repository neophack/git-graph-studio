// The Node `crypto` subset the frame serves: the digests (md5/sha1/sha256) the
// gravatar-class callers need, random fill and Hash — pure TypeScript.

import type { NodeEnv } from '../extModuleLoader';
import { makeChildProcess } from './processSurfaces';
import { makeHttpLike, makeReadline, makeReadlinePromises } from './processSurfaces';
import { Buffer, encodeString, isWindows, encoder, type ShimHost } from './shared';
import { callThrowsFn, unavailableModule } from './shared';
import { makeStreamModule } from './stream';

export function bufferToBase64(data: unknown): string {
	if (typeof data === 'string') {
		let binary = '';
		const bytes = encoder.encode(data);
		for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
		return btoa(binary);
	}
	const bytes = data as Uint8Array;
	let binary = '';
	for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
	return btoa(binary);
}

export function decodeBase64ToBuffer(base64: string, encoding?: string): unknown {
	let binary = '';
	try {
		binary = atob(base64);
	} catch {
		binary = base64;
	}
	const bytes = new Uint8Array(binary.length);
	for (let at = 0; at < binary.length; at++) bytes[at] = binary.charCodeAt(at);
	if (encoding === undefined) return new Buffer(bytes);
	return new TextDecoder(encoding === 'utf-8' ? 'utf-8' : encoding).decode(bytes);
}

/* ---------- crypto: what can be real (random bytes), and honest failures elsewhere ---------- */

/** Fill a byte view from Web Crypto in 64 KiB slices (its per-call ceiling). */
function fillRandom(bytes: Uint8Array): Uint8Array {
	for (let at = 0; at < bytes.length; at += 65536) crypto.getRandomValues(bytes.subarray(at, Math.min(bytes.length, at + 65536)));
	return bytes;
}

export const cryptoShim = {
	getRandomValues: (array: Uint8Array) => crypto.getRandomValues(array),
	// Node's randomBytes: sync or with a callback, any size (Web Crypto caps one draw at
	// 64 KiB, so larger requests fill in slices).
	randomBytes: (size: number, callback?: (error: Error | null, bytes: Buffer) => void): Buffer | undefined => {
		const bytes = fillRandom(new Uint8Array(Math.max(0, Number(size) || 0)));
		if (typeof callback === 'function') {
			queueMicrotask(() => callback(null, new Buffer(bytes)));
			return undefined;
		}
		return new Buffer(bytes);
	},
	randomFillSync: (buffer: Uint8Array): Uint8Array => fillRandom(new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)) && buffer,
	randomInt: (min: number, max?: number): number => {
		const [low, high] = max === undefined ? [0, min] : [min, max];
		const word = new Uint32Array(1);
		crypto.getRandomValues(word);
		return low + (word[0]! % Math.max(1, high - low));
	},
	/** RFC 4122 v4 — built here: an opaque-origin sandboxed frame is not a secure context,
	 *  where the browser's own `crypto.randomUUID` is absent. */
	randomUUID: (): string => {
		const b = fillRandom(new Uint8Array(16));
		b[6] = (b[6]! & 0x0f) | 0x40;
		b[8] = (b[8]! & 0x3f) | 0x80;
		const hex = [...b].map((byte) => byte.toString(16).padStart(2, '0')).join('');
		return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
	},
	timingSafeEqual: (a: Uint8Array, b: Uint8Array): boolean => {
		if (a.length !== b.length) throw new RangeError('Buffers must be the same length');
		let diff = 0;
		for (let at = 0; at < a.length; at++) diff |= a[at]! ^ b[at]!;
		return diff === 0;
	},
	webcrypto: crypto as unknown,
	subtle: crypto.subtle,
	/** The digest hashes a package's own URLs and signatures need (gravatar's md5 et al) —
	 *  synchronous, like Node's, so they are implemented here rather than bridged. */
	createHash: (algorithm: string) => new Hash(algorithm),
	createHmac: callThrowsFn('crypto.createHmac'),
	createCipheriv: callThrowsFn('crypto.createCipheriv'),
	createDecipheriv: callThrowsFn('crypto.createDecipheriv'),
	createSign: callThrowsFn('crypto.createSign'),
	createVerify: callThrowsFn('crypto.createVerify')
};

/** `crypto.createHash(algorithm)` — md5, sha1 and sha256 over the accumulated data,
 *  digested as hex, base64, latin1 (Node's `binary`) or a Buffer. The one-shot helpers
 *  (`hash.update(...).update(...).digest(...)`) chain exactly as Node's do. */
class Hash {
	private blocks: Uint8Array[] = [];
	private size = 0;
	constructor(private readonly algorithm: string) {}

	update(data: string | Uint8Array | Buffer, inputEncoding?: string): this {
		const bytes = typeof data === 'string' ? encodeString(data, inputEncoding ?? 'utf8') : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
		if (bytes.length > 0) {
			this.blocks.push(new Uint8Array(bytes));
			this.size += bytes.length;
		}
		return this;
	}

	digest(encoding: string = 'buffer'): string | Uint8Array {
		const all = new Uint8Array(this.size);
		let at = 0;
		for (const block of this.blocks) {
			all.set(block, at);
			at += block.length;
		}
		const name = this.algorithm.toLowerCase().replace(/-/g, '');
		const digest = name === 'md5' ? md5(all) : name === 'sha1' ? sha1(all) : name === 'sha256' || name === 'sha224' ? sha256(all, name === 'sha224') : null;
		if (digest === null) throw new Error(`digest method '${this.algorithm}' is not supported by the Git Graph Studio extension host (md5, sha1 and sha256 are)`);
		if (encoding === 'hex') return toHex(digest);
		if (encoding === 'base64') return base64Bytes(digest);
		if (encoding === 'buffer') return digest;
		// latin1 / binary — one byte per char
		let out = '';
		for (const byte of digest) out += String.fromCharCode(byte);
		return out;
	}
}

function toHex(bytes: Uint8Array): string {
	let out = '';
	for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
	return out;
}

function base64Bytes(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

/** MD5 (RFC 1321) — gravatar and friends. */
function md5(message: Uint8Array): Uint8Array {
	const s = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
		5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
		4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
		6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
	const K = new Int32Array(64);
	for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);
	const padded = new Uint8Array((((message.length + 8) >> 6) + 1) * 64);
	padded.set(message);
	padded[message.length] = 0x80;
	const bitLength = message.length * 8;
	const view = new DataView(padded.buffer);
	view.setUint32(padded.length - 8, bitLength >>> 0, true);
	view.setUint32(padded.length - 4, Math.floor(bitLength / 4294967296), true);
	let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
	const rotl = (x: number, c: number) => (x << c) | (x >>> (32 - c));
	for (let chunk = 0; chunk < padded.length; chunk += 64) {
		const M = new Int32Array(16);
		for (let i = 0; i < 16; i++) M[i] = view.getInt32(chunk + i * 4, true);
		let A = a0, B = b0, C = c0, D = d0;
		for (let i = 0; i < 64; i++) {
			let F: number, g: number;
			if (i < 16) { F = (B & C) | (~B & D); g = i; }
			else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
			else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
			else { F = C ^ (B | ~D); g = (7 * i) % 16; }
			F = (F + A + K[i]! + M[g]!) | 0;
			A = D;
			D = C;
			C = B;
			B = (B + rotl(F, s[i]!)) | 0;
		}
		a0 = (a0 + A) | 0;
		b0 = (b0 + B) | 0;
		c0 = (c0 + C) | 0;
		d0 = (d0 + D) | 0;
	}
	const out = new Uint8Array(16);
	const outView = new DataView(out.buffer);
	outView.setInt32(0, a0, true);
	outView.setInt32(4, b0, true);
	outView.setInt32(8, c0, true);
	outView.setInt32(12, d0, true);
	return out;
}

/** SHA-1 (FIPS 180-4) — the short signatures. */
function sha1(message: Uint8Array): Uint8Array {
	const padded = new Uint8Array((((message.length + 8) >> 6) + 1) * 64);
	padded.set(message);
	padded[message.length] = 0x80;
	const bitLength = message.length * 8;
	const view = new DataView(padded.buffer);
	view.setUint32(padded.length - 8, Math.floor(bitLength / 4294967296));
	view.setUint32(padded.length - 4, bitLength >>> 0);
	let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
	const rotl = (x: number, c: number) => (x << c) | (x >>> (32 - c));
	const w = new Int32Array(80);
	for (let chunk = 0; chunk < padded.length; chunk += 64) {
		for (let i = 0; i < 16; i++) w[i] = view.getInt32(chunk + i * 4);
		for (let i = 16; i < 80; i++) w[i] = rotl(w[i - 3]! ^ w[i - 8]! ^ w[i - 14]! ^ w[i - 16]!, 1);
		let a = h0, b = h1, c = h2, d = h3, e = h4;
		for (let i = 0; i < 80; i++) {
			let f: number, k: number;
			if (i < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
			else if (i < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
			else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
			else { f = b ^ c ^ d; k = 0xca62c1d6; }
			const temp = (rotl(a, 5) + f + e + k + w[i]!) | 0;
			e = d;
			d = c;
			c = rotl(b, 30);
			b = a;
			a = temp;
		}
		h0 = (h0 + a) | 0;
		h1 = (h1 + b) | 0;
		h2 = (h2 + c) | 0;
		h3 = (h3 + d) | 0;
		h4 = (h4 + e) | 0;
	}
	const out = new Uint8Array(20);
	const outView = new DataView(out.buffer);
	outView.setInt32(0, h0);
	outView.setInt32(4, h1);
	outView.setInt32(8, h2);
	outView.setInt32(12, h3);
	outView.setInt32(16, h4);
	return out;
}

/** SHA-256 (FIPS 180-4); sha224 shares the schedule with a shorter cut. */
function sha256(message: Uint8Array, sha224 = false): Uint8Array {
	const K = [
		0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
		0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
		0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
		0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
		0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
		0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
		0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
		0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
	const H = sha224
		? [0xc1059ed8, 0x367cd507, 0x3070dd17, 0xf70e5939, 0xffc00b31, 0x68581511, 0x64f98fa7, 0xbefa4fa4]
		: [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
	const padded = new Uint8Array((((message.length + 8) >> 6) + 1) * 64);
	padded.set(message);
	padded[message.length] = 0x80;
	const bitLength = message.length * 8;
	const view = new DataView(padded.buffer);
	view.setUint32(padded.length - 8, Math.floor(bitLength / 4294967296));
	view.setUint32(padded.length - 4, bitLength >>> 0);
	const rotr = (x: number, c: number) => (x >>> c) | (x << (32 - c));
	const w = new Int32Array(64);
	for (let chunk = 0; chunk < padded.length; chunk += 64) {
		for (let i = 0; i < 16; i++) w[i] = view.getInt32(chunk + i * 4);
		for (let i = 16; i < 64; i++) {
			const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3);
			const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10);
			w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) | 0;
		}
		const v = [...H];
		for (let i = 0; i < 64; i++) {
			const S1 = rotr(v[4]!, 6) ^ rotr(v[4]!, 11) ^ rotr(v[4]!, 25);
			const ch = (v[4]! & v[5]!) ^ (~v[4]! & v[6]!);
			const temp1 = (v[7]! + S1 + ch + K[i]! + w[i]!) | 0;
			const S0 = rotr(v[0]!, 2) ^ rotr(v[0]!, 13) ^ rotr(v[0]!, 22);
			const maj = (v[0]! & v[1]!) ^ (v[0]! & v[2]!) ^ (v[1]! & v[2]!);
			const temp2 = (S0 + maj) | 0;
			v[7] = v[6]!;
			v[6] = v[5]!;
			v[5] = v[4]!;
			v[4] = (v[3]! + temp1) | 0;
			v[3] = v[2]!;
			v[2] = v[1]!;
			v[1] = v[0]!;
			v[0] = (temp1 + temp2) | 0;
		}
		for (let i = 0; i < 8; i++) H[i] = (H[i]! + v[i]!) | 0;
	}
	const out = new Uint8Array(sha224 ? 28 : 32);
	const outView = new DataView(out.buffer);
	for (let i = 0; i < (sha224 ? 7 : 8); i++) outView.setInt32(i * 4, H[i]!);
	return out;
}

/* ---------- os and the process global ---------- */

