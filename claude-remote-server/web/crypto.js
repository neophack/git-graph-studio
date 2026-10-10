/* The phone's half of the end-to-end layer (plan §3.3/§3.5), one implementation on every
 * origin the relay serves: WebCrypto where the context is secure (HTTPS), the vendored
 * sjcl where it is not (plain-HTTP LAN deployments) — the same wire the extension's
 * crypto.js produces, verified against the same vectors. */
"use strict";
(function (root) {
	const enc = new TextEncoder();
	const dec = new TextDecoder();
	const subtle = root.crypto && root.crypto.subtle ? root.crypto.subtle : null;
	// A plain-HTTP origin has getRandomValues but no subtle — the vendored sjcl (loaded
	// by index.html before this file) carries those origins. Same vectors either way:
	// this is the same fallback the extension's cryptojs.js runs.
	const sjcl = !subtle && root.sjcl ? root.sjcl : null;
	if (!subtle && !sjcl) throw new Error("no crypto surface on this origin (load sjcl.js before crypto.js)");

	const toBits = (bytes) => sjcl.codec.hex.toBits(Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(""));
	const fromBits = (bits) => {
		const hex = sjcl.codec.hex.fromBits(bits);
		const out = [];
		for (let at = 0; at + 1 < hex.length; at += 2) out.push(parseInt(hex.slice(at, at + 2), 16));
		return Uint8Array.from(out);
	};
	const utf8Bits = (text) => toBits(enc.encode(text));

	const b64url = {
		fromBytes(bytes) {
			if (typeof Buffer !== "undefined" && !root.btoa) return Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
			let text = "";
			for (const byte of bytes) text += String.fromCharCode(byte);
			return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
		},
		toBytes(text) {
			const padded = String(text).replace(/-/g, "+").replace(/_/g, "/");
			const base64 = padded + "=".repeat((4 - (padded.length % 4)) % 4);
			if (typeof Buffer !== "undefined" && !root.atob) return new Uint8Array(Buffer.from(base64, "base64"));
			const raw = atob(base64);
			return Uint8Array.from(raw, (ch) => ch.charCodeAt(0));
		}
	};

	async function hmacSha256(keyBytes, data) {
		if (!subtle) {
			const mac = new sjcl.misc.hmac(toBits(keyBytes));
			mac.update(toBits(data));
			return fromBits(mac.digest());
		}
		const key = await subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
		return new Uint8Array(await subtle.sign("HMAC", key, data));
	}

	const hexOf = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

	/** HKDF-SHA256 (RFC 5869) — extract-and-expand, `length` bytes. */
	async function hkdf(ikm, salt, info, length) {
		if (!subtle) {
			const prk = await hmacSha256(salt.length ? salt : new Uint8Array(32), ikm);
			const out = [];
			let previous = new Uint8Array(0);
			for (let counter = 1; out.reduce((n, part) => n + part.length, 0) < length && counter <= 255; counter++) {
				const material = new Uint8Array(previous.length + info.length + 1);
				material.set(previous);
				material.set(info, previous.length);
				material[material.length - 1] = counter;
				previous = await hmacSha256(prk, material);
				out.push(previous);
			}
			const joined = new Uint8Array(out.reduce((n, part) => n + part.length, 0));
			let at = 0;
			for (const part of out) { joined.set(part, at); at += part.length; }
			return joined.slice(0, length);
		}
		const key = await subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
		const bits = await subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8);
		return new Uint8Array(bits);
	}

	async function deriveKeys(K) {
		return {
			kAuth: await hkdf(K, new Uint8Array(0), enc.encode("crr1/auth"), 32),
			kE2E: await hkdf(K, new Uint8Array(0), enc.encode("crr1/e2e"), 32)
		};
	}

	/** The pairing proof: HMAC-SHA256(k_auth, "crr1/pair|nonce|user|epoch"), hex. */
	async function pairProof(kAuth, nonce, userId, epoch) {
		const mac = await hmacSha256(kAuth, enc.encode(`crr1/pair|${nonce}|${userId}|${epoch}`));
		return hexOf(mac);
	}

	const randomBytes = (count) => {
		const bytes = new Uint8Array(count);
		if (root.crypto && root.crypto.getRandomValues) root.crypto.getRandomValues(bytes);
		else if (sjcl) for (let at = 0; at < count; at += 4) {
			const word = sjcl.random.randomWords(1, 0)[0] >>> 0;
			for (let b = 0; b < 4 && at + b < count; b++) bytes[at + b] = (word >>> (24 - 8 * b)) & 255;
		}
		return bytes;
	};

	/** Seal one frame body: `{n, c}` — nonce and ciphertext+tag, both base64url. */
	async function sealFrame(kE2E, { userId, epoch, from, to, seq }, plain) {
		const nonce = randomBytes(12);
		const aad = enc.encode(`crr1|${userId}|${epoch}|${from}|${to}|${seq}`);
		if (!subtle) {
			const sealed = fromBits(sjcl.mode.gcm.encrypt(new sjcl.cipher.aes(toBits(kE2E)), utf8Bits(JSON.stringify(plain)), toBits(nonce), toBits(aad), 128));
			return { n: b64url.fromBytes(nonce), c: b64url.fromBytes(sealed) };
		}
		const key = await subtle.importKey("raw", kE2E, "AES-GCM", false, ["encrypt"]);
		const sealed = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: aad, tagLength: 128 }, key, enc.encode(JSON.stringify(plain))));
		return { n: b64url.fromBytes(nonce), c: b64url.fromBytes(sealed) };
	}

	/** Open one frame body; throws on any authentication failure. */
	async function openFrame(kE2E, { userId, epoch, from, to, seq }, body) {
		const nonce = b64url.toBytes(body.n);
		const sealed = b64url.toBytes(body.c);
		if (nonce.length !== 12 || sealed.length < 16) throw new Error("malformed frame");
		const aad = enc.encode(`crr1|${userId}|${epoch}|${from}|${to}|${seq}`);
		if (!subtle) {
			const opened = sjcl.mode.gcm.decrypt(new sjcl.cipher.aes(toBits(kE2E)), toBits(sealed), toBits(nonce), toBits(aad), 128);
			return JSON.parse(sjcl.codec.utf8String.fromBits(opened));
		}
		const key = await subtle.importKey("raw", kE2E, "AES-GCM", false, ["decrypt"]);
		const plain = await subtle.decrypt({ name: "AES-GCM", iv: nonce, additionalData: aad, tagLength: 128 }, key, sealed);
		return JSON.parse(dec.decode(plain));
	}

	const api = { b64url, hkdf, hmacSha256, hexOf, deriveKeys, pairProof, sealFrame, openFrame, randomBytes };
	if (typeof module !== "undefined" && module.exports) module.exports = api;
	root.crrCrypto = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
