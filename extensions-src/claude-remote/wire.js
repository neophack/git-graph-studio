"use strict";
/* The frame body codec — the one place a payload turns into the relay's `ct` string and
 * back. Today it is the PLAIN codec: `ct = "p." + base64url(utf8(JSON))`. The relay only
 * checks that `ct` is base64url-with-dots, so this shape crosses the server unchanged; the
 * phone page (claude-remote-server/web/app.js) speaks the same two functions.
 *
 * Encryption is deliberately off while the remote flows (history, new conversations, the
 * live SDK stream) are brought up and tested end to end. crypto.js keeps the sealed
 * codec (AES-256-GCM under HKDF(K, "crr1/e2e"), the envelope as AAD); switching back is
 * this module answering sealed bodies again — nothing else on either end encodes. */

const PLAIN_PREFIX = "p.";

function b64url(buffer) {
	return Buffer.from(buffer).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(text) {
	const normal = String(text).replace(/-/g, "+").replace(/_/g, "/");
	return Buffer.from(normal + "=".repeat((4 - (normal.length % 4)) % 4), "base64");
}

/** One payload as the wire's `ct`. */
function encode(plain) {
	return PLAIN_PREFIX + b64url(Buffer.from(JSON.stringify(plain === undefined ? null : plain), "utf8"));
}

/** A wire `ct` back to its payload; throws on anything that is not a plain body (a sealed
 *  body from an encrypting peer, or garbage). */
function decode(ct) {
	const text = String(ct ?? "");
	if (!text.startsWith(PLAIN_PREFIX)) throw new Error("not a plain frame body (is the peer encrypting?)");
	return JSON.parse(fromB64url(text.slice(PLAIN_PREFIX.length)).toString("utf8"));
}

module.exports = { encode, decode, b64url, fromB64url, PLAIN_PREFIX, encrypted: false };
