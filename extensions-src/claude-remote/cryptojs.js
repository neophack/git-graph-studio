"use strict";
/* The byte-level wrappers over the vendored sjcl (BSD-2-Clause, github.com/bitwiseshiftleft/sjcl):
 * the pure-JS crypto path for hosts that serve no native HMAC/AES-GCM — a frame host's
 * shim — and the same file the server-hosted phone page loads on plain-HTTP origins,
 * where WebCrypto (crypto.subtle) does not exist. One crypto path on every origin,
 * audited code either way. */

let sjcl = require("./sjcl.js");
if (sjcl && sjcl.default) sjcl = sjcl.default;

/* ---------- bytes ⇄ sjcl bit arrays ---------- */

function bytesToBits(bytes) {
	// Through sjcl's own hex codec: the library's internal byte order inside a word is
	// its own convention, and the codec is the one conversion that always agrees with it.
	let hex = "";
	for (const byte of bytes) hex += (byte & 0xff).toString(16).padStart(2, "0");
	return sjcl.codec.hex.toBits(hex);
}

function bitsToBytes(bits) {
	const hex = sjcl.codec.hex.fromBits(bits);
	const out = [];
	for (let at = 0; at + 1 < hex.length; at += 2) out.push(parseInt(hex.slice(at, at + 2), 16));
	return Uint8Array.from(out);
}

/* ---------- the digests ---------- */

/** SHA-256 over the concatenated byte parts, as bytes. */
function sha256Bytes(parts) {
	const hash = new sjcl.hash.sha256();
	for (const part of parts) hash.update(bytesToBits(part));
	return bitsToBytes(hash.finalize());
}

/* ---------- the AES-256-GCM frame codec ---------- */

function keyBits(key) {
	return bytesToBits(key);
}

/** AES-256-GCM seal → `{n, c}` base64url, the frame body (crypto.js's contract). */
function gcmSealJs(key, nonce, aad, plain) {
	const prp = new sjcl.cipher.aes(keyBits(key));
	const plaintext = bytesToBits(Buffer.from(JSON.stringify(plain), "utf8"));
	const sealed = sjcl.mode.gcm.encrypt(prp, plaintext, bytesToBits(nonce), bytesToBits(aad), 128);
	const bytes = bitsToBytes(sealed);
	return { n: Buffer.from(nonce).toString("base64url"), c: Buffer.from(bytes).toString("base64url") };
}

/** AES-256-GCM open: throws sjcl's own corrupt exception on any authentication failure. */
function gcmOpenJs(key, nonce, aad, sealed) {
	const prp = new sjcl.cipher.aes(keyBits(key));
	const opened = sjcl.mode.gcm.decrypt(prp, bytesToBits(sealed), bytesToBits(nonce), bytesToBits(aad), 128);
	return Buffer.from(bitsToBytes(opened));
}

/* ---------- random ---------- */

let seeded = false;
function ensureSeeded() {
	if (seeded) return;
	seeded = true;
	try {
		// Browsers and the frame hosts seed from the platform generator; sjcl's own
		// loader did this at require time when `window` exists.
		if (typeof globalThis.crypto?.getRandomValues === "function") {
			const words = new Uint32Array(32);
			globalThis.crypto.getRandomValues(words);
			sjcl.random.addEntropy(Array.from(words), 1024, "crypto.getRandomValues");
		}
	} catch { /* the prng's own paranoia floor still answers */ }
}

function randomJs(count) {
	ensureSeeded();
	const words = sjcl.random.randomWords(Math.ceil(count / 4), 0);
	return bitsToBytes(words).subarray(0, count);
}

module.exports = {
	bytesToBits,
	bitsToBytes,
	sha256Bytes,
	sha256Words: sha256Bytes, // the name crypto.js reached for before the split
	gcmSealJs,
	gcmOpenJs,
	randomJs,
	sjcl
};
