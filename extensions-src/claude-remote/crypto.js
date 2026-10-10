"use strict";
/* The E2E layer every frame crosses (plan §3.3/§3.5), one implementation on every host
 * this package runs in: real Node (VS Code), ggs-node (Git Graph Studio) and — through
 * the pure-JS fallbacks — any frame host that only serves createHash.
 *
 *   K       32 random bytes, the PC's pairing key — QR link fragment, PC secrets, phone
 *           storage are the only places it ever appears
 *   k_auth  = HKDF-SHA256(K, "crr1/auth")  — what a phone proves the QR with (HMAC)
 *   k_e2e   = HKDF-SHA256(K, "crr1/e2e")   — the frames' AES-256-GCM key
 *
 * A frame's plaintext is JSON; the envelope's AAD binds the user, the epoch, both
 * endpoints and the sender's sequence number, so a frame is worth exactly one delivery
 * to exactly one recipient (replay and re-addressing both fail authentication). */

const HKDF_INFO_AUTH = "crr1/auth";
const HKDF_INFO_E2E = "crr1/e2e";
const AAD_PREFIX = "crr1";

let nodeCrypto = null;
try {
	nodeCrypto = require("crypto");
} catch {
	/* a frame host: the pure-JS paths below carry it */ }

/* ---------- the shared primitives ---------- */

/** SHA-256 over the concatenation, hex — over the host's native when there is one. */
function sha256Hex(parts) {
	if (nodeCrypto && typeof nodeCrypto.createHash === "function") {
		const hash = nodeCrypto.createHash("sha256");
		for (const part of parts) hash.update(part);
		return hash.digest("hex");
	}
	// The pure-JS fallback: the frame shim and ggs-node both serve createHash("sha256")
	// natively, so this path is the belt under a host that serves neither.
	const { sha256js } = require("./cryptojs.js");
	return sha256js(parts);
}

function hmacSha256(key, parts) {
	if (nodeCrypto && typeof nodeCrypto.createHmac === "function") {
		const mac = nodeCrypto.createHmac("sha256", key);
		for (const part of parts) mac.update(part);
		return mac.digest();
	}
	// The fallback rides sjcl's own HMAC (verified against RFC 4231).
	const { sjcl, bytesToBits, bitsToBytes } = require("./cryptojs.js");
	const mac = new sjcl.misc.hmac(bytesToBits(key));
	for (const part of parts) mac.update(bytesToBits(part));
	return Buffer.from(bitsToBytes(mac.digest()));
}

/** HKDF-SHA256 (RFC 5869): extract-and-expand, the `length` answer bytes. */
function hkdf(ikm, salt, info, length) {
	if (nodeCrypto && typeof nodeCrypto.hkdfSync === "function") {
		// Node's hkdfSync answers an ArrayBuffer of exactly `length` bytes.
		return Buffer.from(nodeCrypto.hkdfSync("sha256", ikm, salt, info, length));
	}
	const prk = hmacSha256(salt.length ? salt : Buffer.alloc(32), [ikm]);
	const out = [];
	let previous = Buffer.alloc(0);
	for (let counter = 1; out.reduce((n, part) => n + part.length, 0) < length && counter <= 255; counter++) {
		previous = hmacSha256(prk, [previous, info, Buffer.from([counter])]);
		out.push(previous);
	}
	return Buffer.concat(out).subarray(0, length);
}

/* ---------- the key schedule ---------- */

/** The pairing key as bytes, whichever spelling the caller holds (a Buffer, or the
 *  43-char base64url string the identity stores — JSON never keeps a Buffer honest). */
function keyMaterial(K) {
	return Buffer.isBuffer(K) ? K : unb64url(K);
}

function deriveAuth(K) {
	return hkdf(keyMaterial(K), Buffer.alloc(0), Buffer.from(HKDF_INFO_AUTH), 32);
}

function deriveE2E(K) {
	return hkdf(keyMaterial(K), Buffer.alloc(0), Buffer.from(HKDF_INFO_E2E), 32);
}

/* ---------- the frames ---------- */

function randomBytes(n) {
	if (nodeCrypto && typeof nodeCrypto.randomBytes === "function") return nodeCrypto.randomBytes(n);
	const { randomJs } = require("./cryptojs.js");
	return randomJs(n);
}

function b64url(buf) {
	return Buffer.from(buf).toString("base64url");
}

function unb64url(text) {
	return Buffer.from(String(text), "base64url");
}

/** Seal one frame body: `{n, c}` — the 12-byte GCM nonce and the ciphertext+tag, both
 *  base64url. `seq` and the endpoints ride the AAD, never the plaintext. */
function sealFrame(kE2E, { userId, epoch, from, to, seq }, plain) {
	const nonce = randomBytes(12);
	const aad = Buffer.from(`${AAD_PREFIX}|${userId}|${epoch}|${from}|${to}|${seq}`, "utf8");
	if (nodeCrypto && typeof nodeCrypto.createCipheriv === "function") {
		const cipher = nodeCrypto.createCipheriv("aes-256-gcm", kE2E, nonce);
		cipher.setAAD(aad);
		const ct = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(plain), "utf8")), cipher.final(), cipher.getAuthTag()]);
		return { n: b64url(nonce), c: b64url(ct) };
	}
	const { gcmSealJs } = require("./cryptojs.js");
	return gcmSealJs(kE2E, nonce, aad, plain);
}

/** Open one frame body. Throws on any authentication failure — a tampered or replayed
 *  frame is worthless by construction. */
function openFrame(kE2E, { userId, epoch, from, to, seq }, body) {
	const nonce = unb64url(body.n);
	const sealed = unb64url(body.c);
	if (nonce.length !== 12 || sealed.length < 16) throw new Error("malformed frame");
	const aad = Buffer.from(`${AAD_PREFIX}|${userId}|${epoch}|${from}|${to}|${seq}`, "utf8");
	let plain;
	if (nodeCrypto && typeof nodeCrypto.createDecipheriv === "function") {
		const decipher = nodeCrypto.createDecipheriv("aes-256-gcm", kE2E, nonce);
		decipher.setAAD(aad);
		decipher.setAuthTag(sealed.subarray(sealed.length - 16));
		plain = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]);
	} else {
		plain = require("./cryptojs.js").gcmOpenJs(kE2E, nonce, aad, sealed);
	}
	return JSON.parse(plain.toString("utf8"));
}

/** The pairing proof a phone sends: HMAC-SHA256(k_auth, "crr1/pair|nonce|user|epoch"). */
function pairProof(kAuth, nonce, userId, epoch) {
	return hmacSha256(kAuth, [Buffer.from(`crr1/pair|${nonce}|${userId}|${epoch}`, "utf8")]).toString("hex");
}

module.exports = {
	keyMaterial,
	deriveAuth,
	deriveE2E,
	hkdf,
	hmacSha256,
	sha256Hex,
	pairProof,
	sealFrame,
	openFrame,
	randomBytes,
	b64url,
	unb64url,
	HKDF_INFO_AUTH,
	HKDF_INFO_E2E
};
